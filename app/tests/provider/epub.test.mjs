// EPUB 匯出的結構驗證。判定刻意交給 Python 標準庫（zipfile／xml.etree）而不是
// 自家的 zip 讀取器：自產自銷的驗證只能證明「我寫的跟我讀的一致」，證不了
// 別人的解析器打得開，而 Books 用的正是別人的解析器。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { nodeFileSource } from "../helpers/node_source.mjs";
import { buildPayload } from "../../src/provider/payload.js";
import { assembleEpub, epubIdentifier, xmlEscape } from "../../src/provider/epub.js";
import { assemble } from "../../src/provider/assemble.js";
import { seedCpapDoc } from "../helpers/cpap_seed.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

function readAssets() {
  const base = new URL("../../src/viewer/assets/", import.meta.url);
  const get = (p) => readFileSync(new URL(p, base), "utf-8");
  return {
    appJs: get("app.js"),
    css: get("style.css"),
    vendor: [get("vendor/preact.min.js"), get("vendor/hooks.umd.js"), get("vendor/htm.umd.js")],
  };
}

// 真實路徑產 payload（形狀取自真實產出，不手寫假 payload）
// withCpap：第三類來源進 payload 後 EPUB 仍須合法（spec 對單檔 HTML 有
// 同款要求「匯出 MUST 涵蓋 CPAP 區塊」，EPUB 這條先前沒有對應驗證）
async function realPayload({ withCpap = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-epub-"));
  const d = new NodeDriver(path.join(dir, "t.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
      name: "nhi_sample.json" },
    d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_sample.xml`), d, null,
    { profileId: pid });
  if (withCpap) await seedCpapDoc(d, pid);
  const payload = await buildPayload(d, {
    profileId: pid, knowledgeEntries: LAB_ENTRIES, drugCachePath: null,
    today: "2026-08-17",
  });
  d.close?.();
  return payload;
}

// Python 端結構稽核：回傳 JSON 供斷言
function inspect(epubPath) {
  const out = execFileSync("python3", ["-c", [
    "import json, sys, zipfile",
    "import xml.etree.ElementTree as ET",
    `z = zipfile.ZipFile(${JSON.stringify(epubPath)})`,
    "bad = z.testzip()",
    "infos = z.infolist()",
    "res = {'bad_member': bad, 'names': [i.filename for i in infos],",
    " 'first': infos[0].filename, 'first_method': infos[0].compress_type,",
    " 'mimetype': z.read('mimetype').decode(),",
    " 'methods': {i.filename: i.compress_type for i in infos}}",
    "xml_ok = {}",
    "for n in res['names']:",
    "    if n.endswith(('.xml', '.opf', '.xhtml')):",
    "        try:",
    "            ET.fromstring(z.read(n)); xml_ok[n] = True",
    "        except Exception as e:",
    "            xml_ok[n] = str(e)",
    "res['xml_ok'] = xml_ok",
    "opf = z.read('OEBPS/content.opf').decode()",
    "res['opf'] = opf",
    "res['dashboard'] = z.read('OEBPS/dashboard.xhtml').decode()",
    "print(json.dumps(res))",
  ].join("\n")], { cwd: REPO, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

function writeEpub(bytes, name = "out.epub") {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-epub-out-"));
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

test("產出的 EPUB 通過 Python zipfile 與 XML 解析（跨實作驗證）", async () => {
  const bytes = await assembleEpub(await realPayload(), readAssets());
  const r = inspect(writeEpub(bytes));

  assert.equal(r.bad_member, null, "zip 有損毀成員（CRC 對不上）");
  // 硬性要求 1：mimetype 第一且不壓縮（0 = ZIP_STORED）
  assert.equal(r.first, "mimetype");
  assert.equal(r.first_method, 0);
  assert.equal(r.mimetype, "application/epub+zip");
  assert.deepEqual(r.names, ["mimetype", "META-INF/container.xml",
    "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/dashboard.xhtml"]);
  // 硬性要求 3：每個 XML／XHTML 都是合法 XML
  for (const [n, ok] of Object.entries(r.xml_ok)) assert.equal(ok, true, `${n}: ${ok}`);
  // 硬性要求 2：內容文件宣告 scripted（沒宣告的話閱讀器可合法地不執行 JS）
  assert.match(r.opf, /href="dashboard\.xhtml"[^>]*properties="scripted svg"/);
  // 檢視層與資料都在
  assert.ok(r.dashboard.includes('id="hwb-data"'));
  assert.ok(r.dashboard.includes("<![CDATA["));
});

test("payload 讀得回來且僅含當前成員", async () => {
  const payload = await realPayload();
  const bytes = await assembleEpub(payload, readAssets());
  const r = inspect(writeEpub(bytes));
  const m = r.dashboard.match(/<script type="application\/json" id="hwb-data">([\s\S]*?)<\/script>/);
  assert.ok(m, "找不到嵌入資料節點");
  const back = JSON.parse(m[1].replaceAll("\\u003c", "<")
    .replaceAll("\\u003e", ">").replaceAll("\\u0026", "&"));
  assert.equal(back.meta.profile, "測試成員");
  assert.equal(back.meta.generated_at, "2026-08-17");
  assert.deepEqual(Object.keys(back).sort(), Object.keys(payload).sort());
});

test("同輸入產生相同位元組（可重現）", async () => {
  const payload = await realPayload();
  const assets = readAssets();
  const a = await assembleEpub(payload, assets);
  const b = await assembleEpub(payload, assets);
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

test("CompressionStream 不可用時退回 store，產物仍合法", async (t) => {
  const orig = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  t.after(() => { globalThis.CompressionStream = orig; });
  const bytes = await assembleEpub(await realPayload(), readAssets());
  const r = inspect(writeEpub(bytes, "stored.epub"));
  assert.equal(r.bad_member, null);
  assert.ok(Object.values(r.methods).every(m => m === 0), "應全部為 STORED");
  for (const [n, ok] of Object.entries(r.xml_ok)) assert.equal(ok, true, `${n}: ${ok}`);
});

test("資產含 ]]> 時拒絕產出（CDATA 提前終止會讓 XML 非法）", async () => {
  const assets = readAssets();
  assets.appJs += '\nvar s = "]]>";';
  const payload = await realPayload();
  await assert.rejects(() => assembleEpub(payload, assets), /\]\]>/);
});

test("成員名的 XML 特殊字元被跳脫（OPF 不會變成非法 XML）", async () => {
  const payload = await realPayload();
  payload.meta.profile = 'A<B>&"C\'';
  const bytes = await assembleEpub(payload, readAssets());
  const r = inspect(writeEpub(bytes, "escaped.epub"));
  for (const [n, ok] of Object.entries(r.xml_ok)) assert.equal(ok, true, `${n}: ${ok}`);
  assert.ok(r.opf.includes("A&lt;B&gt;&amp;&quot;C&apos;"));
});

test("JS 未執行時看得到說明（多數閱讀器不執行，這是唯一看得到的內容）", async () => {
  const bytes = await assembleEpub(await realPayload(), readAssets());
  const r = inspect(writeEpub(bytes, "fallback.epub"));
  const m = r.dashboard.match(/<div id="app">([\s\S]*?)<\/div>/);
  assert.ok(m, "找不到 fallback 區塊");
  const text = m[1];
  assert.ok(text.includes("不會執行網頁程式"), "要說明原因");
  assert.ok(text.includes("Apple Books"), "要指出可用的閱讀器");
  assert.ok(text.includes("HTML"), "要給電腦上的替代路徑");
});

test("書櫃上的書名與作者（Books 用 dc:title 命名檔案）", async () => {
  const payload = await realPayload();
  const bytes = await assembleEpub(payload, readAssets());
  const r = inspect(writeEpub(bytes, "meta.epub"));
  assert.ok(r.opf.includes("<dc:title>測試成員的個人健康資料（2026-08-17）</dc:title>"),
    `dc:title 不符：${r.opf}`);
  assert.ok(r.opf.includes("<dc:creator>HealthWorkbench：個人健康資料工作台</dc:creator>"),
    `dc:creator 不符：${r.opf}`);
});

test("EPUB 與單檔 HTML 用的是同一份檢視程式與樣式（spec：兩條路徑共用）", async () => {
  const payload = await realPayload();
  const assets = readAssets();
  const html = assemble(payload, assets);
  const r = inspect(writeEpub(await assembleEpub(payload, assets), "shared.epub"));
  // 兩份產物都必須原封不動含有同一份資產。有人替 EPUB 另外接一份資產、
  // 或對其中一條做了字串加工，這裡就會紅。
  for (const [name, text] of [["app.js", assets.appJs], ["style.css", assets.css]]) {
    assert.ok(html.includes(text), `單檔 HTML 未原樣含 ${name}`);
    assert.ok(r.dashboard.includes(text), `EPUB 未原樣含 ${name}`);
  }
});

test("含 CPAP 資料的成員：EPUB 仍合法且睡眠呼吸資料真的在裡面", async () => {
  const payload = await realPayload({ withCpap: true });
  assert.ok(payload.cpap.daily.length > 0, "前置條件：payload 要真的有 CPAP 資料");
  const r = inspect(writeEpub(await assembleEpub(payload, readAssets()), "cpap.epub"));
  assert.equal(r.bad_member, null);
  for (const [n, ok] of Object.entries(r.xml_ok)) assert.equal(ok, true, `${n}: ${ok}`);
  const m = r.dashboard.match(/<script type="application\/json" id="hwb-data">([\s\S]*?)<\/script>/);
  const back = JSON.parse(m[1].replaceAll("\\u003c", "<")
    .replaceAll("\\u003e", ">").replaceAll("\\u0026", "&"));
  assert.equal(back.cpap.daily.length, payload.cpap.daily.length);
});

// change drug-info-and-lab-refband T4/design D4：閱讀器的 window.print 語意
// 不受控，EPUB 骨架用旗標讓檢視層不渲染列印鈕。旗標晚於 app.js 就等於沒設
// （app.js 一載入就渲染），所以位置也要釘住；單檔 HTML 反過來 MUST NOT 有。
test("EPUB 注入 HWB_EPUB 旗標且位置先於 app.js（單檔 HTML 不注入）", async () => {
  const payload = await realPayload();
  const assets = readAssets();
  const r = inspect(writeEpub(await assembleEpub(payload, assets), "epubflag.epub"));
  const flagAt = r.dashboard.indexOf("window.HWB_EPUB=true");
  assert.notEqual(flagAt, -1, "EPUB 內容文件缺 window.HWB_EPUB=true");
  const appAt = r.dashboard.indexOf(assets.appJs);
  assert.notEqual(appAt, -1, "EPUB 內容文件缺 app.js 資產");
  assert.ok(flagAt < appAt, `旗標位置（${flagAt}）必須先於 app.js（${appAt}）`);
  assert.ok(!assemble(payload, assets).includes("window.HWB_EPUB=true"),
    "單檔 HTML 不該設 EPUB 旗標（瀏覽器要能列印）");
});

test("epubIdentifier 穩定且隨成員與日期變動", () => {
  assert.equal(epubIdentifier("阿明", "2026-08-17"), epubIdentifier("阿明", "2026-08-17"));
  assert.notEqual(epubIdentifier("阿明", "2026-08-17"), epubIdentifier("阿華", "2026-08-17"));
  assert.notEqual(epubIdentifier("阿明", "2026-08-17"), epubIdentifier("阿明", "2026-08-18"));
  assert.equal(xmlEscape("<&>"), "&lt;&amp;&gt;");
});

// change update-check-optin T7：更新檢查只存在於殼層，匯出產物必須零殘留。
// 這是驗收項而非假設（殼層與檢視層共用 assets 的話就會夾帶進去），
// 且 EPUB 是壓縮檔，字串掃描 MUST 解壓後逐 entry 做，掃 bytes 掃不到。
test("匯出產物不含更新檢查（單檔 HTML 與 EPUB 皆零殘留）", async () => {
  const NEEDLES = ["api.github.com", "update_check", "update-toggle", "releases/latest"];
  const payload = await realPayload();
  const assets = readAssets();

  const html = assemble(payload, assets);
  for (const n of NEEDLES) {
    assert.ok(!html.includes(n), `單檔 HTML 夾帶更新檢查痕跡：${n}`);
  }

  const epubPath = writeEpub(await assembleEpub(payload, assets), "nonet.epub");
  const hits = JSON.parse(execFileSync("python3", ["-c", [
    "import json, zipfile",
    `z = zipfile.ZipFile(${JSON.stringify(epubPath)})`,
    `needles = json.loads(${JSON.stringify(JSON.stringify(NEEDLES))})`,
    "hits = {}",
    "for name in z.namelist():",
    "    text = z.read(name).decode('utf-8', 'ignore')",
    "    for n in needles:",
    "        if n in text: hits.setdefault(n, []).append(name)",
    "print(json.dumps(hits))",
  ].join("\n")], { cwd: REPO, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }));
  assert.deepEqual(hits, {}, `EPUB 夾帶更新檢查痕跡：${JSON.stringify(hits)}`);

  // 負向對照：掃描器真的看得見 EPUB 內容（否則上面的零可能只是掃不到）
  const seen = JSON.parse(execFileSync("python3", ["-c", [
    "import json, zipfile",
    `z = zipfile.ZipFile(${JSON.stringify(epubPath)})`,
    "print(json.dumps([n for n in z.namelist()",
    "  if 'hwb-data' in z.read(n).decode('utf-8', 'ignore')]))",
  ].join("\n")], { cwd: REPO, encoding: "utf-8" }));
  assert.ok(seen.length >= 1, "掃描器讀不到 EPUB 內容，上面的零不成立");
});
