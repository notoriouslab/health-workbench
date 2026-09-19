import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { createRegistry } from "../../src/adapters/registry.js";
import { EngineStore } from "../../src/engine/store.js";
import { createProfile } from "../../src/engine/profiles.js";
import { TOP_KEYS } from "../../src/engine/quality_report.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const FIXTURE = `${REPO}/tests/fixtures/nhi_sample.json`;
const LABNORM_FIXTURE = `${REPO}/tests/fixtures/nhi_labnorm.json`;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

async function freshDriver() {
  const d = new NodeDriver();
  await initSchema(d);
  return d;
}

const fixtureSource = () => ({
  bytes: new Uint8Array(readFileSync(FIXTURE)), name: "nhi_sample.json" });

// 歸屬成員（opts.profileId 必填）：既有「本人」則沿用，否則建立
async function ensureProfile(driver, name = "本人") {
  const rows = await driver.select(
    "SELECT id FROM profiles WHERE display_name=?", [name]);
  return rows.length ? rows[0].id : createProfile(driver, name);
}

async function importFixture(driver, opts = {}) {
  const profileId = opts.profileId ?? await ensureProfile(driver);
  return nhiJsonAdapter.importSource(fixtureSource(), driver, null,
    { labEntries: LAB_ENTRIES, profileId, ...opts });
}

test("匯入 fixture：與 Python CLI 同檔逐表筆數一致", async () => {
  const d = await freshDriver();
  const r = await importFixture(d);
  assert.equal(r.status, "ok");
  const js = await new EngineStore(d).tableCounts();
  await d.close();

  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-parity-"));
  const pyDb = path.join(tmp, "py.sqlite");
  execFileSync("python3", ["-m", "src.hwb_cli", "--db", pyDb, "import",
    FIXTURE, "--yes", "--no-rebuild"], { cwd: REPO, encoding: "utf-8" });
  const py = JSON.parse(execFileSync("python3", ["-c", [
    "import json, sys",
    "sys.path.insert(0, '.')",
    "from src.store.db import Store",
    `s = Store(${JSON.stringify(pyDb)})`,
    "print(json.dumps(s.table_counts()))",
  ].join("\n")], { cwd: REPO, encoding: "utf-8" }));

  assert.deepEqual(js, py, `JS=${JSON.stringify(js)} Python=${JSON.stringify(py)}`);
});

test("藥局調劑日期回退：r1.5 空→r1.6，type=pharmacy_dispensing", async () => {
  const d = await freshDriver();
  const src = {
    name: "t.json",
    bytes: new TextEncoder().encode(JSON.stringify({ myhealthbank: { bdata: {
      "b1.1": "A12345****",
      r1: [{ "r1.3": "9900000009", "r1.4": "測試藥局", "r1.5": "",
        "r1.6": "20260715", "r1.7": "XXXX" }],
    } } })),
  };
  const r = await nhiJsonAdapter.importSource(src, d, null,
    { labEntries: LAB_ENTRIES, profileId: await ensureProfile(d) });
  assert.equal(r.status, "ok");
  const rows = (await d.select("SELECT type, date FROM encounters")).map(r => ({ ...r }));
  assert.deepEqual(rows, [{ type: "pharmacy_dispensing", date: "2026-07-15" }]);
  await d.close();
});

test("重複檔案：SHA-256 相同即跳過且零新增", async () => {
  const d = await freshDriver();
  await importFixture(d);
  const before = await new EngineStore(d).tableCounts();
  const r2 = await importFixture(d);
  assert.equal(r2.status, "skipped_duplicate");
  assert.ok(r2.importedAt);
  assert.deepEqual(await new EngineStore(d).tableCounts(), before);
  await d.close();
});

test("歸戶防護：遮罩身分證不符即中止且零寫入", async () => {
  const d = await freshDriver();
  await d.execute(
    "INSERT INTO profiles(display_name, masked_id) VALUES ('本人','B98765****')");
  const r = await importFixture(d);
  assert.equal(r.status, "aborted");
  assert.match(r.messages.at(-1), /不符/);
  const counts = await new EngineStore(d).tableCounts();
  assert.equal(counts.encounters + counts.medications + counts.lab_results
    + counts.source_documents, 0);
  await d.close();
});

test("未知欄位保留：r1.99 進 extra_json 並列入報告統計", async () => {
  const d = await freshDriver();
  const src = {
    name: "t.json",
    bytes: new TextEncoder().encode(JSON.stringify({ myhealthbank: { bdata: {
      "b1.1": "A12345****",
      r1: [{ "r1.3": "9900000009", "r1.5": "20260101", "r1.99": "神祕值" }],
    } } })),
  };
  const r = await nhiJsonAdapter.importSource(src, d, null,
    { labEntries: LAB_ENTRIES, profileId: await ensureProfile(d) });
  const [{ extra_json }] = await d.select("SELECT extra_json FROM encounters");
  assert.ok(extra_json.includes("神祕值"));
  assert.deepEqual(r.report.source.unknown_fields, { r1: { "r1.99": 1 } });
  await d.close();
});

test("部分失敗續行：單筆炸掉記入 parse_errors，其餘正常入庫", async () => {
  const d = await freshDriver();
  const src = {
    name: "t.json",
    bytes: new TextEncoder().encode(JSON.stringify({ myhealthbank: { bdata: {
      "b1.1": "A12345****",
      r1: [
        { "r1.3": "9900000009", "r1.5": "20260101" },
        null,
        { "r1.3": "9900000009", "r1.5": "20260102" },
      ],
    } } })),
  };
  const r = await nhiJsonAdapter.importSource(src, d, null,
    { labEntries: LAB_ENTRIES, profileId: await ensureProfile(d) });
  assert.equal(r.status, "ok");
  assert.equal(r.report.source.parse_errors.length, 1);
  assert.match(r.report.source.parse_errors[0], /^r1\[1\]/);
  const [{ c }] = await d.select("SELECT count(*) c FROM encounters");
  assert.equal(c, 2);
  assert.equal(r.report.sections.r1.inserted, 2);
  await d.close();
});

test("醫囑對帳：expected_in_file 與 inserted_new 一致（首次匯入）", async () => {
  const d = await freshDriver();
  const r = await importFixture(d);
  const rec = r.report.source.medication_reconciliation;
  assert.equal(rec.expected_in_file, rec.inserted_new);
  const [{ c }] = await d.select("SELECT count(*) c FROM medications");
  assert.equal(c, rec.inserted_new);
  await d.close();
});

test("內容判型：改名 .txt 的健保 JSON 仍被識別；照片不被識別", () => {
  const reg = createRegistry();
  reg.register(nhiJsonAdapter);
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  assert.equal(reg.detect(bytes, "改名.txt"), nhiJsonAdapter);
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
  assert.equal(reg.detect(jpeg, "photo.jpg"), null);
});

test("擴充點：假 adapter 註冊即被判型路由，格式清單自動含名稱", () => {
  const reg = createRegistry();
  reg.register(nhiJsonAdapter);
  const fake = reg.register({
    id: "fake_excel", formatDesc: "假 Excel 格式（測試）",
    detect: (h) => h[0] === 0x50 && h[1] === 0x4B && h[2] === 0x99,
    importSource: async () => ({ status: "ok" }),
  });
  assert.equal(reg.detect(new Uint8Array([0x50, 0x4B, 0x99]), "x.bin"), fake);
  assert.ok(reg.formats().includes("假 Excel 格式（測試）"));
});

// ---- 檢驗名稱三級短路端到端（design D5 向量；T4.1／T6.1）----
//
// Python 端同一斷言在 tests/test_nhi.py::test_lab_name_normalization_levels。

async function importLabnorm(driver) {
  const profileId = await ensureProfile(driver);
  return nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(LABNORM_FIXTURE)), name: "nhi_labnorm.json" },
    driver, null, { labEntries: LAB_ENTRIES, profileId });
}

test("匯入 labnorm fixture：九列 normalized 與旗標逐列符合 D5 表", async () => {
  const d = await freshDriver();
  const r = await importLabnorm(d);
  assert.equal(r.status, "ok");
  const rows = await d.select(
    "SELECT test_name_raw, test_name_normalized, quality_flags FROM lab_results"
    + " ORDER BY source_index");
  assert.deepEqual(
    rows.map(x => [x.test_name_raw, x.test_name_normalized, x.quality_flags]), [
      ["LDL-C", "LDL-C", ""],                             // 精確命中
      ["LDL-Cholesterol", "LDL-C", ""],                   // 別名命中
      ["l.d.l. cholesterol ", "LDL-C", ""],               // 鬆化命中
      ["LDL Chol", "LDL-C", "mapped_by_code"],            // 名稱不中、代碼後備
      ["HDL-C", "HDL-C", ""],                             // 名稱優先於代碼
      ["A1C-X", "HbA1c", "mapped_by_code"],               // 8 碼取前 6
      ["XYZ", null, "missing_ref_range,unmapped"],        // 多項醫令不後備
      ["Unknown Thing", null, "unmapped"],                // 無代碼
      ["ＬＤＬ－Ｃ", "LDL-C", ""],                          // 全形經 NFKC
    ]);
  await d.close();
});

test("品質報告：mapped_by_code 進旗標統計，未對照清單只列 unmapped", async () => {
  const d = await freshDriver();
  const r = await importLabnorm(d);
  // 代碼後備每一筆都可稽核（旗標統計是既有的 qualityFlagCounts 自動彙總）
  assert.equal(r.report.quality_flags.mapped_by_code, 2);
  // 匯入結果頁的「未對照檢驗名」只該列真正沒對到的兩筆
  assert.deepEqual(r.report.unmapped_lab_names, ["Unknown Thing", "XYZ"]);
  // 契約未被觸動：頂層鍵仍是原本八個、順序不變
  assert.deepEqual(Object.keys(r.report), TOP_KEYS);
  await d.close();
});
