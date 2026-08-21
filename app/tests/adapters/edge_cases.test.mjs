import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter, stripBom, escapeRawCtrlInStrings }
  from "../../src/adapters/nhi_json.js";
import { createRegistry } from "../../src/adapters/registry.js";
import { nhiXmlAdapter } from "../../src/adapters/nhi_xml.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { friendlyError, readFailureMessage } from "../../src/ui/import_flow.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const CTRL_FIXTURE = `${REPO}/tests/fixtures/nhi_ctrlchar.json`;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

// 邊界容錯（Karen 收尾檢核 2026-08-10 補）：壞檔不得炸出技術訊息、
// 資料庫必須零寫入

test("0-byte 檔：判型不命中（走「無法識別」路徑，不炸）", () => {
  const reg = createRegistry();
  reg.register(nhiJsonAdapter);
  reg.register(nhiXmlAdapter);
  reg.register(appleHealthAdapter);
  assert.equal(reg.detect(new Uint8Array(0), "空.json"), null);
});

test("截斷的健保 JSON：引擎丟錯且零寫入；GUI 轉譯為友善訊息", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  const truncated = readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)
    .subarray(0, 500); // 判型會過（含 "myhealthbank"），JSON.parse 會炸
  let thrown = null;
  try {
    await nhiJsonAdapter.importSource(
      { bytes: new Uint8Array(truncated), name: "截斷.json" }, d, null,
      { labEntries: [], profileId: await createProfile(d, "本人") });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "截斷檔應丟錯");
  const [{ c }] = await d.select("SELECT count(*) c FROM source_documents");
  assert.equal(c, 0, "零寫入");
  const [friendly, detail] = friendlyError(thrown);
  assert.ok(!/Unexpected|parse|undefined/i.test(friendly), `友善訊息不得含技術詞：${friendly}`);
  assert.ok(detail.length > 0, "技術細節保留於折疊區");
  await d.close();
});

test("垃圾內容偽裝 myhealthbank：友善訊息不外洩內部結構詞", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  const junk = new TextEncoder().encode('{"myhealthbank": 123}');
  let thrown = null;
  try {
    await nhiJsonAdapter.importSource(
      { bytes: junk, name: "junk.json" }, d, null,
      { labEntries: [], profileId: await createProfile(d, "本人") });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown);
  const [friendly] = friendlyError(thrown);
  assert.ok(!/Unexpected|reading|undefined|null/i.test(friendly), friendly);
  const [{ c }] = await d.select("SELECT count(*) c FROM source_documents");
  assert.equal(c, 0);
  await d.close();
});

// fs scope 拒絕的引導訊息（2026-08-17，配合讀取 scope 由 ** 收斂為白名單）。
// 錯誤原文取自 2026-08-13 實機走查紀錄（docs/verification/
// cpap_dotfile_scope_fix.md），非人造字串。

const SCOPE_ERR_STAT = "forbidden path: /Users/x/Pictures/卡/.DS_Store, "
  + "maybe it is not allowed on the scope for `allow-stat` permission "
  + "in your capability file";

test("scope 拒絕：訊息要指出可行的替代路徑，不能只說失敗", () => {
  const m = readFailureMessage(SCOPE_ERR_STAT);
  assert.match(m, /選擇檔案/, "MUST 指出 dialog 選檔可繞過（它走動態授權、不吃靜態 scope）");
  assert.match(m, /未寫入任何資料/, "MUST 說明資料庫狀態，使用者才知道不必擔心半套資料");
  assert.ok(!/forbidden|scope|permission/i.test(m), `友善訊息不得含技術詞：${m}`);
  // 讀取 scope 是 **，沒有位置白名單；叫使用者搬資料夾是錯的引導
  assert.ok(!/移到|搬到|下載／桌面|放到下載/.test(m),
    `MUST NOT 叫使用者搬移資料夾（讀取 scope 為 ** 無位置白名單）：${m}`);
});

test("scope 拒絕：權限名不同也要命中（allow-stat 以外）", () => {
  for (const perm of ["allow-read-dir", "allow-read-file", "allow-open"]) {
    const raw = `forbidden path: /Users/x/a, maybe it is not allowed on the `
      + `scope for \`${perm}\` permission in your capability file`;
    assert.match(readFailureMessage(raw), /選擇檔案/,
      `${perm} 也必須命中：權限名隨呼叫點不同，判別式不得綁定特定權限名`);
  }
});

test("非 scope 錯誤：沿用通用措辭，不得誤導使用者去換位置", () => {
  for (const raw of ["Unexpected end of JSON input", "No such file or directory",
    "資料庫已鎖定"]) {
    const m = readFailureMessage(raw);
    assert.equal(m, "無法讀取這個來源，資料庫未寫入任何資料。",
      `不該被判成 scope 錯誤：${raw}`);
  }
});

// issue #2：健保署匯出的報告類自由文字欄位（如 r8.10）會塞入未跳脫的原始控制
// 字元，例如聽力檢查用 TAB 對齊左右耳結果。整批匯入原本會在 JSON.parse 中止。

test("報告欄位含未跳脫原始控制字元：完整匯入且值原樣保留（issue #2）", async () => {
  const bytes = new Uint8Array(readFileSync(CTRL_FIXTURE));
  const text = stripBom(new TextDecoder("utf-8").decode(bytes));
  // 錨定 fixture 效力：它必須仍能讓照規格的 JSON.parse 失敗，否則本測試是假綠。
  // fixture 用的是位元層面的真 0x09；JSON 跳脫寫法是合法 JSON，測不到這條路。
  assert.throws(() => JSON.parse(text), SyntaxError);

  const d = new NodeDriver();
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  const r = await nhiJsonAdapter.importSource(
    { bytes, name: "nhi_ctrlchar.json" }, d, null,
    { labEntries: LAB_ENTRIES, profileId: pid });
  assert.equal(r.status, "ok");

  const rows = await d.select(
    "SELECT report_text, length(report_text) AS n FROM reports");
  assert.equal(rows.length, 1);
  // 值原樣保留、不替換成空白：報告以等寬 pre-wrap 呈現，TAB 的對齊有意義
  assert.equal(rows[0].report_text, "pure tone audiometry\tR\tWNL\tL\tWNL");
  // TAB 不影響 SQL 字串函式（NUL 會，見 nhi-import spec 的已知限制）
  assert.equal(rows[0].n, rows[0].report_text.length);
});

test("控制字元跳脫必須限定在字串內：全域替換會破壞結構（負向對照）", () => {
  const text = stripBom(new TextDecoder("utf-8").decode(readFileSync(CTRL_FIXTURE)));
  // fixture 刻意用 TAB 縮排。全域替換會連結構縮排一起跳脫，JSON 從第一個字元
  // 就壞掉。這則測試的存在理由是擋住「把狀態機簡化成一行 replace」的重構。
  const naive = text.replace(/[\u0000-\u001f]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  assert.throws(() => JSON.parse(naive), SyntaxError);
  assert.doesNotThrow(() => JSON.parse(escapeRawCtrlInStrings(text)));
});

test("escapeRawCtrlInStrings 邊界：反斜線跳脫狀態、key 名稱、結構空白", () => {
  const T = String.fromCharCode(9), N = String.fromCharCode(0);
  // [說明, 原始 JSON 文字, 解析後取值, 期望值]
  const cases = [
    ["跳脫的反斜線結尾後接原始 TAB",
      `{"a":"end\\\\${T}x"}`, (o) => o.a, `end\\${T}x`],
    ["跳脫的引號後接原始 TAB",
      `{"a":"say \\"hi\\"${T}ok"}`, (o) => o.a, `say "hi"${T}ok`],
    ["key 名稱含原始 TAB",
      `{"k${T}1":"v"}`, (o) => Object.keys(o)[0], `k${T}1`],
    ["結構縮排的 TAB 必須原樣保留（不進值）",
      `{${T}"a":${T}"v${T}w"}`, (o) => o.a, `v${T}w`],
    ["連續多個不同控制字元",
      `{"a":"x${T}${T}${N}y"}`, (o) => o.a, `x${T}${T}${N}y`],
    ["原始 TAB 緊接在 \\u 跳脫序列之後",
      `{"a":"\\u0041${T}B"}`, (o) => o.a, `A${T}B`],
  ];
  for (const [desc, src, pick, want] of cases) {
    assert.throws(() => JSON.parse(src), SyntaxError, `${desc}：素材應先觸發原始錯誤`);
    assert.equal(pick(JSON.parse(escapeRawCtrlInStrings(src))), want, desc);
  }
});
