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
