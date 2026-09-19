// 檢驗名稱三級短路（design D1/D2）JS 端單元測試：鬆化鍵形狀、建置期
// 碰撞與重複宣告守衛、九列向量逐列比對、第二次重算零寫入。
// Python 端同形斷言在 tests/test_knowledge.py，兩端向量取自 design D5 表。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { looseKey, exactKey, matchName, aliasMap, exactMap, codeMap, normalizeLabResults }
  from "../../src/knowledge/labs.js";

const ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

// (order_code, test_name_raw, 起始 quality_flags, 預期 normalized, 預期 flags)
const VECTORS = [
  ["09044C", "LDL-C", "", "LDL-C", ""],                       // 1 精確命中
  ["09044C", "LDL-Cholesterol", "", "LDL-C", ""],             // 2 別名命中
  ["09044C", "l.d.l. cholesterol ", "", "LDL-C", ""],         // 3 鬆化命中
  ["09044C", "LDL Chol", "", "LDL-C", "mapped_by_code"],      // 4 代碼後備
  ["09044C", "HDL-C", "unmapped", "HDL-C", ""],               // 5 名稱優先於代碼
  ["09006C00", "A1C-X", "", "HbA1c", "mapped_by_code"],       // 6 8 碼取前 6
  ["08011C", "XYZ", "value_unparsed,mapped_by_code",
    null, "value_unparsed,unmapped"],                         // 7 多項醫令不後備
  [null, "Unknown Thing", "", null, "unmapped"],              // 8 無代碼
  ["09044C", "ＬＤＬ－Ｃ", "", "LDL-C", ""],                     // 9 全形經 NFKC
  [null, "N/A", "", null, "unmapped"],                        // 10 短鍵不鬆化（≠ Na）
  [null, "U/A", "", null, "unmapped"],                        // 11 短鍵不鬆化（≠ UA）
  [null, "n.a.", "", null, "unmapped"],                       // 12 短鍵不鬆化
  ["09021C", "N/A", "", "Sodium", "mapped_by_code"],          // 13 短鍵不中→代碼後備可稽核
];

function entry(name, { aliases = [], order_codes } = {}) {
  const e = { normalized_name: name, aliases };
  if (order_codes) e.order_codes = order_codes;
  return e;
}

async function seed() {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-labmatch-"));
  const driver = new NodeDriver(path.join(dir, "db.sqlite"));
  await initSchema(driver);
  await driver.execute(
    "INSERT INTO profiles(id, display_name) VALUES (1, '測試成員')");
  await driver.execute(
    "INSERT INTO source_documents(id, profile_id, filename, sha256, adapter, "
    + "adapter_version) VALUES (1, 1, 'f.json', 'x', 'test', '1')");
  for (const [i, [code, raw, flags]] of VECTORS.entries()) {
    await driver.execute(
      "INSERT INTO lab_results(profile_id, doc_id, section, source_index, record_fp, "
      + "canonical, order_code, test_name_raw, quality_flags) "
      + "VALUES (1, 1, 'r7', ?, ?, '{}', ?, ?, ?)",
      [i, `fp${i}`, code, raw, flags]);
  }
  return driver;
}

test("looseKey：NFKC → 大寫 → 移除空白與 - _ . / , 、 ( )", () => {
  assert.equal(looseKey("  l.d.l. Cholesterol"), "LDLCHOLESTEROL");
  assert.equal(looseKey("ＬＤＬ－Ｃ"), "LDLC");         // 全形經 NFKC
  assert.equal(looseKey("CA 19-9"), "CA199");
  assert.equal(looseKey(""), "");
  assert.equal(looseKey(null), "");
});

test("matchName：短別名只走精確層，N/A、U/A 不得誤合成 Na、UA", () => {
  const exact = exactMap(ENTRIES), loose = aliasMap(ENTRIES);
  assert.equal(matchName("Na", exact, loose), "Sodium");
  assert.equal(matchName(" na ", exact, loose), "Sodium");     // 精確層不分大小寫、去頭尾空白
  assert.equal(matchName("K", exact, loose), "Potassium");
  assert.equal(matchName("N/A", exact, loose), null);
  assert.equal(matchName("n.a.", exact, loose), null);
  assert.equal(matchName("U/A", exact, loose), null);
  assert.equal(matchName("l.d.l. cholesterol ", exact, loose), "LDL-C");  // 長鍵仍鬆化
  assert.equal(exactKey("  ＬＤＬ－Ｃ "), "LDL-C");
});

test("aliasMap：repo 條目零碰撞，且經鬆化鍵查得到各院常見寫法", () => {
  const m = aliasMap(ENTRIES);
  assert.equal(m.get(looseKey("HGB")), "Hemoglobin");
  assert.equal(m.get(looseKey("LDL-Cholesterol")), "LDL-C");
  assert.equal(m.get(looseKey("l.d.l. cholesterol ")), "LDL-C");
  // eGFR 三條鬆化後仍相異，MUST NOT 併成同一鍵
  const egfr = new Set(["eGFR (CKD-EPI)", "eGFR (MDRD)", "eGFR Male"].map(looseKey));
  assert.equal(egfr.size, 3);
});

test("aliasMap：跨條目鬆化後同鍵 → 拋錯且訊息含兩個條目名", () => {
  assert.throws(
    () => aliasMap([entry("CA-199"), entry("Tumor X", { aliases: ["CA 199"] })]),
    (err) => err.message.includes("CA-199") && err.message.includes("Tumor X"));
});

test("codeMap：同一代碼宣告於兩個條目 → 拋錯且訊息含兩名與代碼", () => {
  assert.throws(
    () => codeMap([entry("LDL-C", { order_codes: ["09044C"] }),
      entry("HDL-C", { order_codes: ["09044C"] })]),
    (err) => err.message.includes("LDL-C") && err.message.includes("HDL-C")
      && err.message.includes("09044C"));
});

test("codeMap：repo 條目建得起來，且搭車醫令不在表內", () => {
  const cm = codeMap(ENTRIES);
  assert.equal(cm.get("09044C"), "LDL-C");
  assert.equal(cm.get("09043C"), "HDL-C");
  assert.equal(cm.get("09015C"), undefined);   // 血清指數搭車，不宣告
  assert.equal(cm.get("09026C"), undefined);
});

test("normalizeLabResults：九列向量逐列相符，其他既有旗標原樣保留", async () => {
  const driver = await seed();
  const counts = await normalizeLabResults(driver, ENTRIES);
  const rows = await driver.select(
    "SELECT test_name_raw, test_name_normalized, quality_flags FROM lab_results "
    + "ORDER BY source_index");
  assert.deepEqual(
    rows.map(r => [r.test_name_raw, r.test_name_normalized, r.quality_flags]),
    VECTORS.map(v => [v[1], v[3], v[4]]));
  assert.deepEqual(counts,
    { mapped: 8, unmapped: 5, mappedByCode: 3, updated: 13 });
});

test("normalizeLabResults：第二次重算零列變動（冪等只寫變動列）", async () => {
  const driver = await seed();
  const first = await normalizeLabResults(driver, ENTRIES);
  assert.equal(first.updated, 13);
  const second = await normalizeLabResults(driver, ENTRIES);
  assert.equal(second.updated, 0);
  assert.deepEqual({ ...second, updated: null }, { ...first, updated: null });
});
