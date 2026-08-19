import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { attachDrugs } from "../../src/knowledge/drugs.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const REAL_CACHE = path.join(REPO, "data/drug_items.sqlite");

async function fixtureCache() {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "hwb-drug-")), "drug_items.sqlite");
  const d = new NodeDriver(p);
  await d.execute(`CREATE TABLE drug_items(
    code TEXT PRIMARY KEY, name_en TEXT, name_zh TEXT, ingredient TEXT,
    dosage_form TEXT, atc TEXT, leaflet_url TEXT, valid_until TEXT)`);
  await d.execute("CREATE TABLE cache_meta(key TEXT PRIMARY KEY, value TEXT)");
  await d.execute("INSERT INTO drug_items VALUES('A012345678','TESTDRUG','測試藥',"
    + "'testium','錠','N02BE01','https://example.invalid/leaflet','1150101')");
  await d.execute("INSERT INTO cache_meta VALUES('updated_at','2026-08-08')");
  await d.close();
  return p;
}

// 新 schema 快取（src/knowledge/drugs.py 的 _write_cache 同形：drug_items 12 欄
// ＋cache_meta 四鍵）。上面的 fixtureCache 保留為「舊快取」（8 欄、無新欄）
// 樣態，兩者一起釘住 SELECT * 加欄零風險的容錯語意。
async function fixtureCacheWithLicense() {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "hwb-drug2-")), "drug_items.sqlite");
  const d = new NodeDriver(p);
  await d.execute(`CREATE TABLE drug_items(
    code TEXT PRIMARY KEY, name_en TEXT, name_zh TEXT, ingredient TEXT,
    dosage_form TEXT, atc TEXT, leaflet_url TEXT, valid_until TEXT,
    license_id TEXT, indication TEXT, usage_text TEXT, license_status TEXT)`);
  await d.execute("CREATE TABLE cache_meta(key TEXT PRIMARY KEY, value TEXT)");
  await d.execute("INSERT INTO drug_items VALUES('A012345678','TESTDRUG','測試藥',"
    + "'testium','錠','N02BE01','https://example.invalid/leaflet?licId=01049322',"
    + "'1150101','01049322','測試適應症原文','測試用法用量','已註銷')");
  // join 未命中列：既有欄有值、新欄全 NULL
  await d.execute("INSERT INTO drug_items VALUES('C012345678','MISSDRUG','未對照藥',"
    + "'missium','錠',NULL,'https://example.invalid/leaflet?licId=99999999',"
    + "'1150101',NULL,NULL,NULL,NULL)");
  await d.execute("INSERT INTO cache_meta VALUES('updated_at','2026-08-19')");
  await d.execute("INSERT INTO cache_meta VALUES('license_updated_at','2026-08-19')");
  await d.close();
  return p;
}

test("lookup：醫囑代碼前 10 碼命中；查無回 null；meta 可讀", async () => {
  const cache = await fixtureCache();
  const d = new NodeDriver();
  const drugs = await attachDrugs(d, cache);
  assert.equal(drugs.available, true);
  const hit = await drugs.lookup("A012345678ZZZ");
  assert.equal(hit.name_zh, "測試藥");
  assert.equal(await drugs.lookup("B999999999"), null);
  assert.equal(await drugs.lookup(null), null);
  assert.equal((await drugs.meta()).updated_at, "2026-08-08");
  await drugs.detach();
  await d.close();
});

test("lookup：新快取命中帶許可證新欄（適應症／用法用量／註銷狀態）", async () => {
  const cache = await fixtureCacheWithLicense();
  const d = new NodeDriver();
  const drugs = await attachDrugs(d, cache);
  const hit = await drugs.lookup("A012345678ZZZ");
  assert.equal(hit.indication, "測試適應症原文");
  assert.equal(hit.usage_text, "測試用法用量");
  assert.equal(hit.license_status, "已註銷");
  assert.equal(hit.license_id, "01049322");
  // join 未命中列：鍵在、值為 null（payload 兩端據此設 null，非省略鍵）
  const miss = await drugs.lookup("C012345678");
  for (const k of ["license_id", "indication", "usage_text", "license_status"]) {
    assert.equal(k in miss, true, `${k} 應有鍵`);
    assert.equal(miss[k], null);
  }
  assert.equal((await drugs.meta()).license_updated_at, "2026-08-19");
  await drugs.detach();
  await d.close();
});

test("舊快取容錯：無新欄的 8 欄快取 lookup 不炸、回傳物件無新欄鍵", async () => {
  const cache = await fixtureCache();
  const d = new NodeDriver();
  const drugs = await attachDrugs(d, cache);
  const hit = await drugs.lookup("A012345678");
  assert.equal(hit.name_zh, "測試藥");
  for (const k of ["license_id", "indication", "usage_text", "license_status"]) {
    assert.equal(k in hit, false, `舊快取不該有 ${k} 鍵`);
    assert.equal(hit[k], undefined);
  }
  assert.equal((await drugs.meta()).license_updated_at, undefined);
  await drugs.detach();
  await d.close();
});

test("快取不存在：available=false 且全部回 null（不外連）", async () => {
  const d = new NodeDriver();
  const drugs = await attachDrugs(d, "/nonexistent/dir/drug_items.sqlite");
  assert.equal(drugs.available, false);
  assert.equal(await drugs.lookup("A012345678"), null);
  assert.equal(await drugs.meta(), null);
  await d.close();
});

test("真實快取（本機才跑）：既有醫囑代碼可 join", { skip: !existsSync(REAL_CACHE) }, async () => {
  const d = new NodeDriver();
  const drugs = await attachDrugs(d, REAL_CACHE);
  assert.equal(drugs.available, true);
  const meta = await drugs.meta();
  assert.ok(meta.updated_at);
  await drugs.detach();
  await d.close();
});
