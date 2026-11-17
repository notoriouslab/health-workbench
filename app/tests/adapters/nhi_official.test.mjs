// All data in this suite is synthetic; the PDFs supply field definitions only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter, codeKeys } from "../../src/adapters/nhi_json.js";
import { nhiXmlAdapter } from "../../src/adapters/nhi_xml.js";
import * as fm from "../../src/adapters/nhi_fieldmap.js";
import { runParity, REPO } from "../parity/harness.mjs";

const FIXTURE = fileURLToPath(new URL("../../../tests/fixtures/nhi_official_20230515.json", import.meta.url));
const data = JSON.parse(readFileSync(FIXTURE, "utf8"));
const source = (name, text) => ({ name, bytes: new TextEncoder().encode(text) });
const escapeXml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function xmlNode(key, value) {
  if (Array.isArray(value)) return value.map(v => xmlNode(key, v)).join("");
  const content = value && typeof value === "object"
    ? Object.entries(value).map(([k, v]) => xmlNode(k, v)).join("") : escapeXml(value);
  return `<${key}>${content}</${key}>`;
}
async function fresh() {
  const driver = new NodeDriver();
  await initSchema(driver);
  return { driver, profileId: await createProfile(driver, "合成測試成員") };
}

test("2023 official synthetic fixture: Python/JS complete database and report parity", async () => {
  const result = await runParity([FIXTURE, FIXTURE], mkdtempSync(path.join(tmpdir(), "nhi-official-")));
  assert.deepEqual(result.dbDiffs, []);
  assert.deepEqual(result.reportDiffs, []);
});

test("field maps agree across runtimes, including r14 ambiguity", () => {
  const script = "import json; from src.adapters import nhi_fieldmap as f; print(json.dumps({k:v for k,v in vars(f).items() if k.isupper()}))";
  const python = JSON.parse(execFileSync(process.env.PYTHON || "python3", ["-c", script], { cwd: REPO, encoding: "utf8" }));
  assert.deepEqual({ ...fm }, python);
  assert.equal(fm.R10["r10.14"], "血脂肪_總膽固醇");
  assert.equal(fm.R10["r10.15"], "血脂肪_三酸甘油酯");
  assert.match(fm.R14_1["r14_1.9"], /不一致/);
});

test("XML imports all fourteen sections and preserves ambiguous follow-up values", async () => {
  const { driver, profileId } = await fresh();
  try {
    const xml = '<?xml version="1.0"?>' + xmlNode("myhealthbank", data.myhealthbank);
    const result = await nhiXmlAdapter.importSource(source("synthetic.xml", xml), driver, null, { profileId });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.report.source.parse_errors, []);
    for (const sec of ["r1", "r2", "r3", "r6", "r7", "r8", "r9", "r10", "r11"]) {
      assert.equal(result.report.sections[sec].status, "parsed", sec);
      assert.equal(result.report.sections[sec].records, 1, sec);
    }
    const [med] = await driver.select("SELECT * FROM medications WHERE section='r2>r2_1'");
    assert.equal(med.order_code, "SYN002");
    assert.equal(med.total_qty, 2.5);
    assert.equal(med.days_supply, null);
    const [tcm] = await driver.select("SELECT * FROM medications WHERE section='r9>r9_1'");
    assert.equal(tcm.order_code, "SYN009");
    const [body] = await driver.select("SELECT extra_json FROM body_measurements");
    assert.equal(JSON.parse(body.extra_json)["血脂肪_總膽固醇"], "180");
    assert.equal(JSON.parse(body.extra_json)["血脂肪_三酸甘油酯"], "90");
    const [report] = await driver.select("SELECT report_text FROM reports");
    assert.equal(report.report_text, data.myhealthbank.bdata.r8[0]["r8.10"]);
    const [doc] = await driver.select("SELECT import_stats FROM source_documents");
    const retained = JSON.parse(doc.import_stats).nhi_retained;
    assert.equal(retained.r14[0].r14_1[1]["r14_1.9"], "ambiguous-9");
    for (const sec of ["r4", "r5", "r12", "r13", "r14"]) {
      assert.equal(result.report.sections[sec].status, "UNPARSED_HAS_DATA");
      assert.ok(retained[sec]);
    }
  } finally { await driver.close(); }
});

test("null, omitted, singleton and malformed records do not discard valid siblings", async () => {
  const { driver, profileId } = await fresh();
  try {
    const bd = { "b1.1": "Z99999****", r0: [{ r0: "合成聲明" }], r1: null,
      r2: { r2: "無資料" }, r6: [null, { "r6.1": "20230515", "r6.3": "合成疫苗" }], r15: null,
      r11: [{ "r11.1": "合成類別", r11_1: { "R11_1.3": "合成結果" } }],
      r12: [{ "r12.1": "20230515", r12_1: "" }] };
    const result = await nhiJsonAdapter.importSource(source("synthetic.json", JSON.stringify({ myhealthbank: { bdata: bd } })), driver, null, { profileId });
    assert.equal(result.status, "ok");
    assert.equal((await driver.select("SELECT * FROM immunizations")).length, 1);
    assert.equal(result.report.sections.r9.note, "來源未提供此節區");
    assert.equal(result.report.sections.r2.status, "no_data");
    const [doc] = await driver.select("SELECT import_stats FROM source_documents");
    const stats = JSON.parse(doc.import_stats);
    assert.equal(stats.nhi_failed_records.r6["0"], null);
    assert.deepEqual(stats.nhi_retained.r0, bd.r0);
    const [cancer] = await driver.select("SELECT detail_json FROM cancer_screenings");
    assert.deepEqual(JSON.parse(cancer.detail_json), [{ "r11_1.3": "合成結果" }]);
    assert.equal(stats.nhi_failed_records.r12, undefined);
  } finally { await driver.close(); }
  assert.throws(() => codeKeys({ r1: [], R1: [] }), /Conflicting/);
});

const EDGE = fileURLToPath(new URL("../../../tests/fixtures/nhi_edge_placeholders.json", import.meta.url));

test("placeholder shapes and bad nested children: Python/JS parity", async () => {
  const result = await runParity([EDGE], mkdtempSync(path.join(tmpdir(), "nhi-edge-")));
  assert.deepEqual(result.dbDiffs, []);
  assert.deepEqual(result.reportDiffs, []);
});

test("placeholder shapes create no fake rows; a bad child fails its whole encounter", async () => {
  const { driver, profileId } = await fresh();
  const r = await nhiJsonAdapter.importSource(source("edge.json", readFileSync(EDGE, "utf8")),
    driver, null, { labEntries: [], profileId });
  assert.equal(r.status, "ok");
  const rows = async sql => driver.select(sql);
  assert.deepEqual((await rows("SELECT date FROM encounters ORDER BY date")).map(x => x.date),
    ["2023-05-01", "2023-05-02", "2023-05-05", "2023-05-06", "2023-05-07"]);
  assert.deepEqual((await rows("SELECT order_code, source_index, total_qty FROM medications ORDER BY order_code"))
    .map(x => [x.order_code, x.source_index, x.total_qty]),
    [["SYN101", 0, null], ["SYN106", 1, null], ["SYN107", 0, null]]);
  assert.equal((await rows("SELECT COUNT(*) c FROM lab_results"))[0].c, 0);
  assert.deepEqual((await rows("SELECT detail_json FROM cancer_screenings")).map(x => JSON.parse(x.detail_json)), [[], []]);
  for (const sec of ["r2", "r3", "r4", "r5", "r7", "r12"]) assert.equal(r.report.sections[sec].status, "no_data", sec);
  const stats = JSON.parse((await rows("SELECT import_stats FROM source_documents"))[0].import_stats);
  assert.deepEqual(Object.keys(stats.nhi_failed_records), ["r1"]);
  assert.deepEqual(Object.keys(stats.nhi_failed_records.r1), ["2", "3"]);
  await driver.close();
});

test("XML leaf placeholders: empty section and nested 無資料 text", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><myhealthbank><bdata><b1.1>Z99999****</b1.1>`
    + `<r2></r2><r11><r11.1>合成篩檢</r11.1><r11.2>合成項目</r11.2><r11_1>無資料</r11_1></r11>`
    + `<r1><r1.5>20230501</r1.5><r1_1>無資料</r1_1><r1_1><r1_1.1>SYN201</r1_1.1></r1_1></r1>`
    + `<r1><r1.5>20230502</r1.5><r1_1><r1_1.1>SYN202</r1_1.1></r1_1><r1_1></r1_1></r1></bdata></myhealthbank>`;
  const { driver, profileId } = await fresh();
  const r = await nhiXmlAdapter.importSource(source("edge.xml", xml), driver, null, { labEntries: [], profileId });
  assert.equal(r.status, "ok");
  // 文字佔位與子項混用：佔位在前不中止匯入、佔位在後不吃掉已收集的醫囑
  assert.deepEqual((await driver.select("SELECT order_code FROM medications ORDER BY order_code")).map(x => x.order_code),
    ["SYN201", "SYN202"]);
  assert.equal((await driver.select("SELECT COUNT(*) c FROM encounters WHERE section='r2'"))[0].c, 0);
  assert.equal((await driver.select("SELECT COUNT(*) c FROM cancer_screenings"))[0].c, 1);
  assert.equal(r.report.sections.r2.status, "no_data");
  await driver.close();
});
