// 匯入非破壞性紅隊 harness（design D7；app-import-engine spec
// 「匯入不破壞既有資料」）。同庫 before/after 以 id 為鍵全列快照比對，
// 比 parity 跨庫 dump 更嚴：既有列連時間戳都不得變，僅白名單例外
// （目標成員 masked_id 首次綁定、既有列 quality_flags 追加
// fingerprint_collision）。新增列僅允許歸屬目標成員。
// 負向自檢以常駐測試實作（見檔尾）：對既有列注入 UPDATE，斷言
// 白名單檢查器必然抓到（護欄的護欄，永久進 CI）。
import test from "node:test";
import assert from "node:assert/strict";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { createProfile } from "../../src/engine/profiles.js";
import { deleteSourceDocument, reattributeSourceDocument }
  from "../../src/engine/doc_rescue.js";
import { seedCpapDoc } from "../helpers/cpap_seed.mjs";

// 清單漏表不會有任何錯誤訊息：該表從此不在「既有列逐位元組不變」的斷言
// 宇宙裡，破壞它的改動照樣全綠。且光補清單不夠——baseline 沒有該表的資料
// 時，快照是空 Map 比空 Map，恆真（2026-08-17 實測：只補 CPAP 三表到清單，
// 12 條測試零轉紅）。新增資料表 MUST 同時接上這裡與 baseline 的 seed。
const ALL_TABLES = ["profiles", "source_documents", "encounters", "medications",
  "lab_results", "reports", "immunizations", "body_measurements",
  "cancer_screenings", "apple_records", "apple_workouts", "apple_daily",
  "cpap_daily", "cpap_events", "cpap_oximetry"];

// ---------- 快照與白名單斷言 ----------

async function snapshot(d) {
  const out = {};
  for (const t of ALL_TABLES) {
    out[t] = new Map((await d.select(`SELECT * FROM ${t}`))
      .map(r => [r.id, JSON.stringify(r)]));
  }
  return out;
}

// 白名單比對（D7 不變量）。opts:
//   allowNewFor: 允許新增列的 profile_id（null＝不允許任何新增）
//   allowBindProfile: 允許 masked_id null→值 的 profiles.id（null＝不允許）
function assertOnlyWhitelisted(before, after, { allowNewFor = null,
  allowBindProfile = null } = {}) {
  for (const t of ALL_TABLES) {
    for (const [id, rowJson] of before[t]) {
      const now = after[t].get(id);
      assert.ok(now !== undefined, `${t}#${id} 既有列被刪除`);
      if (now === rowJson) continue;
      const a = JSON.parse(rowJson), b = JSON.parse(now);
      const diffKeys = Object.keys(a).filter(k => a[k] !== b[k]);
      const isBind = t === "profiles" && id === allowBindProfile
        && diffKeys.length === 1 && diffKeys[0] === "masked_id"
        && a.masked_id === null;
      const isCollisionFlag = diffKeys.length === 1
        && diffKeys[0] === "quality_flags"
        && String(b.quality_flags).includes("fingerprint_collision")
        && String(b.quality_flags).startsWith(String(a.quality_flags));
      assert.ok(isBind || isCollisionFlag,
        `${t}#${id} 既有列被非白名單修改：${diffKeys.join(",")}`
        + `（${rowJson} → ${now}）`);
    }
    for (const [id, rowJson] of after[t]) {
      if (before[t].has(id)) continue;
      assert.ok(allowNewFor !== null, `${t}#${id} 不允許新增卻出現新列`);
      if (t === "profiles") continue; // 本 harness 不在匯入中建成員
      const row = JSON.parse(rowJson);
      assert.equal(row.profile_id, allowNewFor,
        `${t}#${id} 新增列歸屬錯誤（${row.profile_id}≠${allowNewFor}）`);
    }
  }
}

function assertUnchanged(before, after) {
  assertOnlyWhitelisted(before, after, {});
  for (const t of ALL_TABLES) {
    assert.equal(after[t].size, before[t].size, `${t} 筆數應不變`);
  }
}

// ---------- 來源建構 ----------

const nhiBytes = (maskedId, r1rows) => new TextEncoder().encode(
  JSON.stringify({ myhealthbank: { bdata: { "b1.1": maskedId, r1: r1rows } } }));

const rec = (date, extra = {}) => ({
  "r1.3": "9900000009", "r1.4": "測試院所", "r1.5": date, ...extra });

const nhiSource = (name, maskedId, r1rows) => (
  { bytes: nhiBytes(maskedId, r1rows), name });

const APPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_TW">
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count"
  startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:10:00 +0800" value="100"/>
</HealthData>`;

function appleSource(name = "export.xml") {
  const bytes = new TextEncoder().encode(APPLE_XML);
  return {
    name, size: bytes.length,
    readAt: async (off, len) => bytes.subarray(off, off + len),
    stream: async function* () { yield bytes; },
  };
}

const IMPORT_OPTS = (pid) => ({ labEntries: [], profileId: pid });

// 兩成員基線庫：A（本人，A12345****）健保＋Apple＋CPAP；B（媽媽，
// B98765****）健保。A 的 CPAP 使三表在快照中非空——空表比空表恆真，
// 只把表名加進 ALL_TABLES 而不 seed，等於沒有覆蓋。
async function baseline() {
  const d = new NodeDriver();
  await initSchema(d);
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  await nhiJsonAdapter.importSource(
    nhiSource("a1.json", "A12345****", [rec("20260101"), rec("20260102")]),
    d, null, IMPORT_OPTS(a));
  await appleHealthAdapter.importSource(appleSource(), d, null, { profileId: a });
  await nhiJsonAdapter.importSource(
    nhiSource("b1.json", "B98765****", [rec("20260103")]), d, null, IMPORT_OPTS(b));
  const cpapDocId = await seedCpapDoc(d, a);
  return { d, a, b, cpapDocId };
}

// ---------- 對抗矩陣（D7 七情境） ----------

test("D7-1 中途例外：交易回滾，全庫與匯入前全等", async () => {
  const { d, a } = await baseline();
  const before = await snapshot(d);
  // 故障點＝finalizeImport 的 import_stats UPDATE：匯入的最後一筆寫入，
  // 此時新資料已全數寫入交易＝最大部分狀態；且不在「部分失敗續行」的
  // 逐筆 try/catch 範圍內（單筆 INSERT 故障會被續行機制吸收，非本情境標的）
  const sabotaged = Object.create(d);
  sabotaged.execute = (sql, params) => {
    if (/UPDATE source_documents SET import_stats/.test(sql)) {
      throw new Error("模擬中途故障");
    }
    return d.execute(sql, params);
  };
  sabotaged.transaction = (fn) =>
    NodeDriver.prototype.transaction.call(d, () => fn(sabotaged));
  await assert.rejects(
    () => nhiJsonAdapter.importSource(
      nhiSource("a2.json", "A12345****", [rec("20260201")]),
      sabotaged, null, IMPORT_OPTS(a)),
    /模擬中途故障/);
  assertUnchanged(before, await snapshot(d));
  await d.close();
});

test("D7-2 歸戶不符中止：全庫全等", async () => {
  const { d, a } = await baseline();
  const before = await snapshot(d);
  const r = await nhiJsonAdapter.importSource(
    nhiSource("wrong.json", "Z99999****", [rec("20260201")]), d, null, IMPORT_OPTS(a));
  assert.equal(r.status, "aborted");
  assertUnchanged(before, await snapshot(d));
  await d.close();
});

test("D7-3 跨成員重複檔：跳過且全庫全等", async () => {
  const { d, b } = await baseline();
  const before = await snapshot(d);
  const r = await nhiJsonAdapter.importSource(
    nhiSource("a1-again.json", "A12345****", [rec("20260101"), rec("20260102")]),
    d, null, IMPORT_OPTS(b));
  // 同位元組內容 → 同 SHA-256 → 重複檔判定先於歸戶護欄（spec：不論
  // 本次歸屬選誰，一律跳過並附原歸屬與時間）
  assert.equal(r.status, "skipped_duplicate");
  assert.equal(r.originDisplayName, "本人");
  assert.ok(r.importedAt);
  assertUnchanged(before, await snapshot(d));
  await d.close();
});

test("D7-3b 跨成員重複檔（Apple，無護欄攔截）：跳過且全庫全等", async () => {
  const { d, b } = await baseline();
  const before = await snapshot(d);
  const r = await appleHealthAdapter.importSource(
    appleSource("export-copy.xml"), d, null, { profileId: b });
  assert.equal(r.status, "skipped_duplicate");
  assert.equal(r.originDisplayName, "本人");
  assertUnchanged(before, await snapshot(d));
  await d.close();
});

test("D7-4 部分失敗續行：既有列不變，新列僅歸目標成員", async () => {
  const { d, a } = await baseline();
  const before = await snapshot(d);
  const r = await nhiJsonAdapter.importSource(
    nhiSource("a2.json", "A12345****", [rec("20260201"), null, rec("20260202")]),
    d, null, IMPORT_OPTS(a));
  assert.equal(r.status, "ok");
  assert.equal(r.report.source.parse_errors.length, 1);
  assertOnlyWhitelisted(before, await snapshot(d), { allowNewFor: a });
  await d.close();
});

test("D7-5 畸形/截斷檔：丟錯且全庫全等", async () => {
  const { d, a } = await baseline();
  const before = await snapshot(d);
  const truncated = nhiBytes("A12345****", [rec("20260201")]).subarray(0, 60);
  await assert.rejects(() => nhiJsonAdapter.importSource(
    { bytes: truncated, name: "壞檔.json" }, d, null, IMPORT_OPTS(a)));
  assertUnchanged(before, await snapshot(d));
  await d.close();
});

test("D7-6 同內容紀錄分屬兩成員：各自入庫互不干擾", async () => {
  const { d, a, b } = await baseline();
  // B 匯入與 A 既有紀錄同內容的 r1（b1.1 不同故檔案位元組不同）
  const before = await snapshot(d);
  const r = await nhiJsonAdapter.importSource(
    nhiSource("b2.json", "B98765****", [rec("20260101"), rec("20260102")]),
    d, null, IMPORT_OPTS(b));
  assert.equal(r.status, "ok");
  assert.equal(r.report.sections.r1.inserted, 2, "不被跨成員去重");
  assertOnlyWhitelisted(before, await snapshot(d), { allowNewFor: b });
  const [{ c: ca }] = await d.select(
    "SELECT count(*) c FROM encounters WHERE profile_id=?", [a]);
  assert.equal(ca, 2, "A 筆數不變");
  await d.close();
});

test("D7-7 既有成員追加匯入：重疊冪等跳過、舊列不變、新列純新增", async () => {
  const { d, a } = await baseline();
  const before = await snapshot(d);
  const r = await nhiJsonAdapter.importSource(
    nhiSource("a2.json", "A12345****", [rec("20260102"), rec("20260301")]),
    d, null, IMPORT_OPTS(a));
  assert.equal(r.status, "ok");
  assert.equal(r.report.dedup.skipped_dup.encounters, 1, "重疊冪等跳過");
  assert.equal(r.report.sections.r1.inserted, 1);
  assertOnlyWhitelisted(before, await snapshot(d), { allowNewFor: a });
  await d.close();
});

test("首次綁定屬白名單：masked_id null→值 通過、其他欄位變更不通過", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  const p = await createProfile(d, "新成員");
  const before = await snapshot(d);
  const r = await nhiJsonAdapter.importSource(
    nhiSource("n1.json", "C55555****", [rec("20260101")]), d, null, IMPORT_OPTS(p));
  assert.equal(r.status, "ok");
  assertOnlyWhitelisted(before, await snapshot(d),
    { allowNewFor: p, allowBindProfile: p });
  await d.close();
});

// ---------- 誤歸屬救援中斷情境（misattribution-rescue design D6） ----------
// 負向自檢紀錄（2026-08-10）：暫時將 sabotage 的 execute 改為靜默吞掉
// 目標語句（不丟錯、不執行），兩情境均如預期轉紅（D7-8 抓到
// source_documents 列殘留、D7-9 抓到 profile_id 遭非白名單修改），
// 確認斷言有效後移除。

test("D7-8 刪除匯入中途失敗：交易回滾，全庫與操作前全等", async () => {
  const { d } = await baseline();
  const [{ id: docId }] = await d.select(
    "SELECT id FROM source_documents WHERE filename='a1.json'");
  const before = await snapshot(d);
  // 故障點＝最後的 source_documents DELETE：關聯列已全刪＝最大部分狀態
  const sabotaged = Object.create(d);
  sabotaged.execute = (sql, params) => {
    if (/DELETE FROM source_documents/.test(sql)) throw new Error("模擬中途故障");
    return d.execute(sql, params);
  };
  sabotaged.transaction = (fn) =>
    NodeDriver.prototype.transaction.call(d, () => fn(sabotaged));
  await assert.rejects(() => deleteSourceDocument(sabotaged, docId), /模擬中途故障/);
  assertUnchanged(before, await snapshot(d));
  await d.close();
});

test("D7-9 改歸屬中途失敗：交易回滾，全庫與操作前全等", async () => {
  const { d, b } = await baseline();
  const c = await createProfile(d, "爸爸");
  const [{ id: docId }] = await d.select(
    "SELECT id FROM source_documents WHERE filename='b1.json'");
  const before = await snapshot(d);
  // 故障點＝doc 改掛（各資料表已搬完＝最大部分狀態；此後還有綁定轉移）
  const sabotaged = Object.create(d);
  sabotaged.execute = (sql, params) => {
    if (/UPDATE source_documents SET profile_id/.test(sql)) {
      throw new Error("模擬中途故障");
    }
    return d.execute(sql, params);
  };
  sabotaged.transaction = (fn) =>
    NodeDriver.prototype.transaction.call(d, () => fn(sabotaged));
  await assert.rejects(
    () => reattributeSourceDocument(sabotaged, docId, c), /模擬中途故障/);
  assertUnchanged(before, await snapshot(d));
  const [{ masked_id }] = await d.select(
    "SELECT masked_id FROM profiles WHERE id=?", [b]);
  assert.equal(masked_id, "B98765****", "來源綁定不得因失敗操作被解除");
  await d.close();
});

// D7-8／D7-9 的操作目標是健保檔，CPAP 三表只被動驗證「未被波及」。以下兩條
// 讓操作目標本身是 CPAP 來源檔：三表的列會真的被刪／被搬，回滾必須把它們
// 逐位元組還原。
//
// 這兩條守的是**回滾失效**，不是清單漏接——2026-08-17 實測：把 CPAP 三表從
// DOC_DATA_TABLES 與 KEY_DUP_TABLES 一起拿掉，本檔 14 條零轉紅（doc_rescue
// .test.mjs 轉紅 6 條）。清單漏接由 table_coverage.test.mjs 與 doc_rescue
// .test.mjs 守，本檔不重複。
// 效力證據（同日三步式突變）：拿掉交易包裝 → D7-8/8b/9/9b 四條轉紅；
// baseline 少 seed 一張 CPAP 表 → 只有 D7-8b/D7-9b 轉紅；改註解文字 → 不轉紅。

test("D7-8b 刪除 CPAP 來源檔中途失敗：三表連同來源紀錄全數回滾", async () => {
  const { d, cpapDocId } = await baseline();
  const before = await snapshot(d);
  // 故障點＝最後的 source_documents DELETE：CPAP 三表已刪＝最大部分狀態
  const sabotaged = Object.create(d);
  sabotaged.execute = (sql, params) => {
    if (/DELETE FROM source_documents/.test(sql)) throw new Error("模擬中途故障");
    return d.execute(sql, params);
  };
  sabotaged.transaction = (fn) =>
    NodeDriver.prototype.transaction.call(d, () => fn(sabotaged));
  await assert.rejects(
    () => deleteSourceDocument(sabotaged, cpapDocId), /模擬中途故障/);
  assertUnchanged(before, await snapshot(d));
  for (const t of ["cpap_daily", "cpap_events", "cpap_oximetry"]) {
    const [{ c }] = await d.select(`SELECT count(*) c FROM ${t}`);
    assert.equal(c, 1, `${t} 的列必須在回滾後仍在（部分刪除殘留＝資料遺失）`);
  }
  await d.close();
});

test("D7-9b 改歸屬 CPAP 來源檔中途失敗：三表的歸屬全數回滾", async () => {
  const { d, a, b, cpapDocId } = await baseline();
  const before = await snapshot(d);
  // 故障點＝doc 改掛（CPAP 三表已搬完＝最大部分狀態）
  const sabotaged = Object.create(d);
  sabotaged.execute = (sql, params) => {
    if (/UPDATE source_documents SET profile_id/.test(sql)) {
      throw new Error("模擬中途故障");
    }
    return d.execute(sql, params);
  };
  sabotaged.transaction = (fn) =>
    NodeDriver.prototype.transaction.call(d, () => fn(sabotaged));
  await assert.rejects(
    () => reattributeSourceDocument(sabotaged, cpapDocId, b), /模擬中途故障/);
  assertUnchanged(before, await snapshot(d));
  for (const t of ["cpap_daily", "cpap_events", "cpap_oximetry"]) {
    const rows = await d.select(`SELECT profile_id FROM ${t}`);
    assert.deepEqual(rows.map(x => x.profile_id), [a],
      `${t} 必須回到原成員；留在目標成員＝資料被半途搬走且無錯誤訊息`);
  }
  await d.close();
});

// ---------- 負向自檢（護欄的護欄，常駐）：檢查器必須抓得到破壞 ----------

test("負向自檢：既有列被 UPDATE／被 DELETE／新列歸屬錯誤，檢查器必轉紅", async () => {
  const { d, a, b } = await baseline();
  const before = await snapshot(d);

  await d.execute("UPDATE encounters SET facility_name='被竄改' WHERE profile_id=?", [b]);
  assert.throws(() => assertOnlyWhitelisted(before, undefined),
    TypeError, "快照缺失也必須炸");
  let after = await snapshot(d);
  assert.throws(() => assertOnlyWhitelisted(before, after, { allowNewFor: a }),
    /非白名單修改/);
  await d.execute("UPDATE encounters SET facility_name='測試院所' WHERE profile_id=?", [b]);

  await d.execute("DELETE FROM apple_workouts WHERE profile_id=?", [a]).catch(() => {});
  const [{ c }] = await d.select("SELECT count(*) c FROM apple_records WHERE profile_id=?", [a]);
  if (c > 0) {
    await d.execute("DELETE FROM apple_records WHERE profile_id=?", [a]);
    after = await snapshot(d);
    assert.throws(() => assertOnlyWhitelisted(before, after, { allowNewFor: a }),
      /被刪除/);
  }
  await d.close();
});
