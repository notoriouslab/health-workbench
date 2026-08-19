import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { nodeFileSource } from "../helpers/node_source.mjs";
import { buildPayload } from "../../src/provider/payload.js";
import { assemble, validateShape, toEmbeddedJson } from "../../src/provider/assemble.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));
// Python 端 build_payload 讀 body_refs.yaml，JS 端傳建置產物 json：
// 兩者同源（body_refs_json_fresh 守衛），parity 全等即證兩端一致
const BODY_REFS = JSON.parse(
  readFileSync(new URL("../../src/knowledge/body_refs.json", import.meta.url), "utf-8"));

// 建一個含兩來源的庫（檔案落地，Python 端要讀同一顆）
async function buildDb(dbPath) {
  const d = new NodeDriver(dbPath);
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  d.pid = pid;
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
      name: "nhi_sample.json" },
    d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_sample.xml`), d, null,
    { profileId: pid });
  // Watch 樣態素材（心率多筆／日、睡眠多識別字含雙來源同日、呼吸速率、
  // 血氧）：讓 measure_bands 與 sleep_daily 在兩端 parity 中有非空內容
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_watch_sample.xml`), d, null,
    { profileId: pid });
  return d;
}

// 迷你 drug 快取 fixture（design D6 五列固定樣態）：schema 與
// src/knowledge/drugs.py 的 _write_cache 同形（drug_items 12 欄＋cache_meta
// 四鍵），日期寫固定字串保證兩端可重現。建在 db 同目錄、檔名 drug_items.sqlite
// ——Python 端 DrugLookup 由 db 路徑推同目錄同名檔（drugs.py cache_path），
// JS 端由 buildPayload 的 drugCachePath 指過來，兩端讀同一顆。
// 醫囑代碼取自 tests/fixtures/nhi_sample.json 的用藥列：XX00000001／
// XX00000002／XX00000003（r1 西醫）、A000000000（r9 中藥）；89001C00
// （r3 牙科醫令）故意不入快取＝樣態 (e) lookup miss。
async function buildDrugCache(dbPath) {
  const cachePath = path.join(path.dirname(dbPath), "drug_items.sqlite");
  const d = new NodeDriver(cachePath);
  await d.execute(`CREATE TABLE drug_items(
    code TEXT PRIMARY KEY, name_en TEXT, name_zh TEXT, ingredient TEXT,
    dosage_form TEXT, atc TEXT, leaflet_url TEXT, valid_until TEXT,
    license_id TEXT, indication TEXT, usage_text TEXT, license_status TEXT)`);
  await d.execute("CREATE TABLE cache_meta(key TEXT PRIMARY KEY, value TEXT)");
  for (const row of [
    // (a) 有適應症＋license_status 空字串（有效）＋有用法用量
    ["XX00000001", "TESTDRUG A", "測試藥品甲", "testium", "錠", "N02BE01",
      "https://example.invalid/leaflet?licId=01049322", "1150101",
      "01049322", "測試適應症原文甲", "測試用法用量甲", ""],
    // (b) 有適應症＋有效＋用法用量 NULL（28% 才有值）
    ["XX00000002", "TESTDRUG B", "測試藥品乙", "testium b", "膠囊", "N02BE02",
      "https://example.invalid/leaflet?licId=01049323", "1150201",
      "01049323", "測試適應症原文乙", null, ""],
    // (c) 有適應症＋已註銷（非有效狀態是常態）＋用法用量 NULL
    ["XX00000003", "TESTDRUG C", "測試藥品丙", "testium c", "軟膏", "D02AB00",
      "https://example.invalid/leaflet?licId=01049324", "1150301",
      "01049324", "測試適應症原文丙", null, "已註銷"],
    // (d) 許可證 join 未命中：新欄全 NULL、既有欄有值
    ["A000000000", "TESTHERB", "測試科學中藥", "testherbium", "散劑", null,
      "https://example.invalid/leaflet?licId=99999999", "1150401",
      null, null, null, null],
  ]) {
    await d.execute("INSERT INTO drug_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", row);
  }
  for (const kv of [["updated_at", "2026-08-19"],
    ["dataset_url", "https://data.gov.tw/dataset/23715"],
    ["license_dataset_url", "https://data.gov.tw/dataset/9122"],
    ["license_updated_at", "2026-08-19"]]) {
    await d.execute("INSERT INTO cache_meta VALUES(?,?)", kv);
  }
  await d.close();
  return cachePath;
}

function pyPayload(dbPath) {
  const out = execFileSync("python3", ["-c", [
    "import json, sys",
    "sys.path.insert(0, '.')",
    "from src.store.db import Store",
    "from src.dashboard.embed import build_payload",
    `db = ${JSON.stringify(dbPath)}`,
    "s = Store(db)",
    "p, _ = build_payload(s, db)",
    "s.close()",
    "print(json.dumps(p, ensure_ascii=False, default=str))",
  ].join("\n")], { cwd: REPO, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim().split("\n").at(-1));
}

const stripTs = (p) => { const c = JSON.parse(JSON.stringify(p)); delete c.meta.generated_at; return c; };

test("provider 同構：JS payload 與 Python build_payload 數值全等", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-prov-"));
  const dbPath = path.join(tmp, "db.sqlite");
  const d = await buildDb(dbPath);
  const drugCachePath = await buildDrugCache(dbPath);
  const js = await buildPayload(d, { profileId: d.pid, bodyRefs: BODY_REFS,
    knowledgeEntries: LAB_ENTRIES, drugCachePath, today: "2026-08-09" });
  await d.close();
  assert.deepEqual(validateShape(js), []);

  // fixture 真的讓 drug 欄位有內容（防「兩端都沒帶新欄也全等」的空對帳）
  const byCode = {};
  for (const m of js.medications) byCode[m.order_code] = m;
  assert.equal(byCode["XX00000001"].indication, "測試適應症原文甲");
  assert.equal(byCode["XX00000001"].usage_text, "測試用法用量甲");
  assert.equal(byCode["XX00000001"].license_status, "");
  assert.equal(byCode["XX00000002"].usage_text, null);
  assert.equal(byCode["XX00000003"].license_status, "已註銷");
  assert.equal(byCode["A000000000"].indication, null);
  assert.equal("indication" in byCode["89001C00"], false); // 樣態 (e) lookup miss

  const py = pyPayload(dbPath);
  // 版本日期傳遞鏈（design D3）：cache_meta 新鍵經 meta() 進 payload
  assert.equal(js.meta.drug_cache.license_updated_at, "2026-08-19");
  assert.equal(py.meta.drug_cache.license_updated_at,
    js.meta.drug_cache.license_updated_at);
  assert.deepEqual(stripTs(JSON.parse(JSON.stringify(js))), stripTs(py));
});

test("匯出同構：assemble 輸出的嵌入資料與 hwb rebuild 產出全等", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-exp-"));
  const dbPath = path.join(tmp, "db.sqlite");
  const d = await buildDb(dbPath);
  const drugCachePath = await buildDrugCache(dbPath);
  const js = await buildPayload(d, { profileId: d.pid, bodyRefs: BODY_REFS,
    knowledgeEntries: LAB_ENTRIES, drugCachePath, today: "2026-08-09" });
  await d.close();

  const assets = {
    appJs: readFileSync(`${REPO}/app/src/viewer/assets/app.js`, "utf-8"),
    css: readFileSync(`${REPO}/app/src/viewer/assets/style.css`, "utf-8"),
    vendor: ["preact.min.js", "hooks.umd.js", "htm.umd.js"].map(
      f => readFileSync(`${REPO}/app/src/viewer/assets/vendor/${f}`, "utf-8")),
  };
  const html = assemble(js, assets);

  execFileSync("python3", ["-m", "src.hwb_cli", "--db", dbPath, "rebuild",
    "--out", tmp], { cwd: REPO, encoding: "utf-8" });
  const pyHtml = readFileSync(path.join(tmp,
    readdirSync(tmp).find(f => f.endsWith(".html"))), "utf-8");

  const extract = (h) => JSON.parse(
    h.match(/<script type="application\/json" id="hwb-data">(.*?)<\/script>/s)[1]
      .replaceAll("\\u003c", "<").replaceAll("\\u003e", ">").replaceAll("\\u0026", "&"));
  assert.deepEqual(stripTs(extract(html)), stripTs(extract(pyHtml)));
});

test("跳脫安全：payload 含 </script> 不逃逸", () => {
  const s = toEmbeddedJson({ x: "</script><b>攻擊</b> & more" });
  assert.ok(!s.includes("</script>"));
  assert.ok(!s.includes("<"));
});

test("資產防漂移：viewer/assets 與 src/dashboard 逐位元組相同", () => {
  for (const [a, b] of [
    ["app/src/viewer/assets/app.js", "src/dashboard/app.js"],
    ["app/src/viewer/assets/style.css", "src/dashboard/style.css"],
    ["app/src/viewer/assets/vendor/preact.min.js", "src/dashboard/vendor/preact.min.js"],
    ["app/src/viewer/assets/vendor/hooks.umd.js", "src/dashboard/vendor/hooks.umd.js"],
    ["app/src/viewer/assets/vendor/htm.umd.js", "src/dashboard/vendor/htm.umd.js"],
  ]) {
    assert.equal(readFileSync(`${REPO}/${a}`, "utf-8"),
      readFileSync(`${REPO}/${b}`, "utf-8"), `${a} 與 ${b} 漂移`);
  }
});

// GAP-5（Jenny 稽核）：「舊快取檔容錯」的端到端測——8 欄舊 schema 快取實跑
// buildPayload（先前只各測 lookup 半段與手捏 payload 半段，組合路徑沒人守）。
test("端到端：8 欄舊快取跑 buildPayload——不炸、無新欄鍵、meta 無新日期", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-oldcache-"));
  const dbPath = path.join(tmp, "db.sqlite");
  const d = await buildDb(dbPath);
  const cachePath = path.join(tmp, "old_drug_items.sqlite");
  const c = new NodeDriver(cachePath);
  await c.execute(`CREATE TABLE drug_items(
    code TEXT PRIMARY KEY, name_en TEXT, name_zh TEXT, ingredient TEXT,
    dosage_form TEXT, atc TEXT, leaflet_url TEXT, valid_until TEXT)`);
  await c.execute("CREATE TABLE cache_meta(key TEXT PRIMARY KEY, value TEXT)");
  await c.execute("INSERT INTO drug_items VALUES('XX00000001','OLD','舊藥甲',"
    + "'oldium','錠','N02BE01','https://example.invalid/old','9991231')");
  await c.execute("INSERT INTO cache_meta VALUES('updated_at','2026-08-08')");
  await c.close();
  const js = await buildPayload(d, { profileId: d.pid, bodyRefs: BODY_REFS,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: cachePath, today: "2026-08-09" });
  await d.close();
  const hit = js.medications.find((m) => m.order_code === "XX00000001");
  assert.equal(hit.drug_zh, "舊藥甲", "既有欄照常提供");
  for (const k of ["indication", "usage_text", "license_status"]) {
    assert.equal(k in hit, false, `舊快取不該有 ${k} 鍵`);
  }
  assert.equal("license_updated_at" in js.meta.drug_cache, false,
    "舊快取 meta 不該有 license_updated_at");
  assert.deepEqual(validateShape(js), []);
});
