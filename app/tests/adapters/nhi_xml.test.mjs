import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiXmlAdapter, xmlToBdata } from "../../src/adapters/nhi_xml.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { createRegistry } from "../../src/adapters/registry.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const JSON_FIXTURE = `${REPO}/tests/fixtures/nhi_sample.json`;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

// 把 JSON fixture 轉成官方 XML 形狀（同批資料的 XML 版）：
// r9-r14 移除（XML 格式事實）、r8.10 中點插入換行（官方「JSON 移除換行」語意的反向建構）
function jsonToXml(data) {
  const bdata = data.myhealthbank.bdata;
  const parts = ["﻿<?xml version=\"1.0\" encoding=\"utf-8\"?>", "<myhealthbank>", " <bdata>"];
  const leaf = (tag, v) => `  <${tag}>${esc(v)}</${tag}>`;
  for (const [sec, rows] of Object.entries(bdata)) {
    if (/^r(9|1[0-4])$/i.test(sec)) continue; // XML 格式事實：無 r9-r14（官方 R12-R14 大寫）
    if (!Array.isArray(rows)) { parts.push(leaf(sec, rows)); continue; }
    const keys = Object.keys(rows[0] ?? {});
    if (rows.length === 1 && keys.length === 1 && (keys[0] === sec)) {
      parts.push(leaf(sec, rows[0][keys[0]])); // 無資料 / r0 聲明
      continue;
    }
    for (const rec of rows) {
      parts.push(`  <${sec}>`);
      for (const [k, v] of Object.entries(rec)) {
        if (Array.isArray(v)) {
          for (const sub of v) {
            parts.push(`   <${k}>`);
            for (const [sk, sv] of Object.entries(sub)) parts.push(`    ${leaf(sk, sv)}`);
            parts.push(`   </${k}>`);
          }
        } else if (sec === "r8" && k === "r8.10") {
          // 官方語意（2026-08-09 真檔實測）：JSON＝XML 移除換行字元。
          // 反向建構：XML 版在中點插入換行 → JSON 版即「移除後」的原字串。
          const mid = Math.floor(String(v).length / 2);
          parts.push(`   <${k}>${esc(String(v).slice(0, mid) + "\n" + String(v).slice(mid))}</${k}>`);
        } else {
          parts.push(`   ${leaf(k, v)}`);
        }
      }
      parts.push(`  </${sec}>`);
    }
  }
  parts.push(" </bdata>", "</myhealthbank>");
  return parts.join("\n");
}

async function freshDriver() {
  const d = new NodeDriver();
  await initSchema(d);
  d.pid = await createProfile(d, "本人"); // opts.profileId 必填（歸屬指定）
  return d;
}

// 只比 JSON/XML 共同節區（r1-r8）；r9-r14 為 XML 格式缺漏，不在對帳範圍
const COMMON_SECTION = /^(r[1-8])(>|$)/;
async function dumpTables(d) {
  const out = {};
  for (const t of ["encounters", "medications", "lab_results", "reports",
    "immunizations"]) {
    const rows = await d.select(`SELECT * FROM ${t} ORDER BY section, source_index`);
    out[t] = rows.filter(r => COMMON_SECTION.test(r.section)).map(r => {
      const { id, doc_id, encounter_id, imported_at, ...rest } = { ...r };
      return rest;
    });
  }
  return out;
}

test("xmlToBdata：無資料葉節點、巢狀醫囑、實體解碼、BOM", () => {
  const xml = "﻿<?xml version=\"1.0\"?><myhealthbank><bdata>"
    + "<b1.1>A12345****</b1.1><r2>無資料</r2>"
    + "<r1><r1.4>診所 &amp; 藥局</r1.4><r1.5>20260101</r1.5>"
    + "<r1_1><r1_1.1>A01</r1_1.1><r1_1.2>藥名</r1_1.2></r1_1>"
    + "<r1_1><r1_1.1>A02</r1_1.1><r1_1.2>藥名二</r1_1.2></r1_1></r1>"
    + "</bdata></myhealthbank>";
  const b = xmlToBdata(xml);
  assert.equal(b["b1.1"], "A12345****");
  assert.deepEqual(b.r2, [{ r2: "無資料" }]);
  assert.equal(b.r1.length, 1);
  assert.equal(b.r1[0]["r1.4"], "診所 & 藥局");
  assert.equal(b.r1[0].r1_1.length, 2);
  assert.equal(b.r1[0].r1_1[1]["r1_1.1"], "A02");
});

test("同批 JSON/XML 交叉對帳：共同節區全等，差異僅 r8 報告換行白名單", async () => {
  const data = JSON.parse(readFileSync(JSON_FIXTURE, "utf-8"));
  const xmlText = jsonToXml(data);

  const dj = await freshDriver();
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(JSON_FIXTURE)), name: "same.json" },
    dj, null, { labEntries: LAB_ENTRIES, profileId: dj.pid });
  const jsonDump = await dumpTables(dj);
  await dj.close();

  const dx = await freshDriver();
  const rx = await nhiXmlAdapter.importSource(
    { bytes: new TextEncoder().encode(xmlText), name: "same.xml" },
    dx, null, { labEntries: LAB_ENTRIES, profileId: dx.pid });
  assert.equal(rx.status, "ok");
  const xmlDump = await dumpTables(dx);
  await dx.close();

  // 白名單語意（真檔實測定案）：僅 r8 因官方 JSON 移除換行導致指紋不同，
  // 弱鍵對齊後 report_text 去除全部空白 MUST 全等；其餘表逐列全等。
  const stripWs = (s) => String(s).replace(/\s+/g, "");
  let whitelisted = 0;
  for (const t of Object.keys(jsonDump)) {
    assert.equal(jsonDump[t].length, xmlDump[t].length, `${t} 筆數`);
    for (let i = 0; i < jsonDump[t].length; i++) {
      const a = jsonDump[t][i], b = xmlDump[t][i];
      for (const k of Object.keys(a)) {
        if (a[k] === b[k]) continue;
        const isWhitelist = t === "reports"
          && ["report_text", "canonical", "record_fp"].includes(k)
          && stripWs(a.report_text) === stripWs(b.report_text);
        assert.ok(isWhitelist,
          `${t}[${i}].${k} 非白名單差異：${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
        if (k === "report_text") whitelisted++;
      }
    }
  }
  assert.ok(whitelisted >= 1, "白名單案例應至少出現一次（r8.10 換行插入）");
});

test("XML 節區缺漏事實：r9-r14 標記 no_data 並註明格式", async () => {
  const data = JSON.parse(readFileSync(JSON_FIXTURE, "utf-8"));
  const d = await freshDriver();
  const r = await nhiXmlAdapter.importSource(
    { bytes: new TextEncoder().encode(jsonToXml(data)), name: "t.xml" },
    d, null, { labEntries: LAB_ENTRIES, profileId: d.pid });
  for (const sec of ["r9", "r10", "r11", "r12", "r13", "r14"]) {
    assert.equal(r.report.sections[sec].status, "no_data", sec);
    assert.equal(r.report.sections[sec].note, "XML 格式無此節區", sec);
  }
  await d.close();
});

test("內容判型：XML 檔被 nhi_xml 識別，與 JSON/Apple 不混淆", () => {
  const reg = createRegistry();
  reg.register(nhiJsonAdapter);
  reg.register(nhiXmlAdapter);
  const xmlHead = new TextEncoder().encode(
    "﻿<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<myhealthbank>\n  <bdata>");
  assert.equal(reg.detect(xmlHead, "改名.dat"), nhiXmlAdapter);
  const jsonHead = new TextEncoder().encode('{"myhealthbank": {"bdata": {');
  assert.equal(reg.detect(jsonHead, "x.json"), nhiJsonAdapter);
});

// issue #2 的對照面：JSON 版會在解析階段整批中止，XML 版不會。原因是這裡是自寫
// 的迷你解析器（indexOf ＋ regex），不做 XML 合法字元檢查；而 TAB 在 XML 文字
// 節點本來就合法。這則測試釘住現況，因為真正的風險是將來有人把它換成標準
// DOMParser：那時 NUL 這類 XML 1.0 非法字元會開始丟錯，而在此之前沒有任何
// 測試會轉紅。JSON 側的對應測試在 tests/adapters/edge_cases.test.mjs。
test("XML 文字節點含原始控制字元：不中止且值原樣通過（issue #2 對照）", () => {
  const T = String.fromCharCode(9), N = String.fromCharCode(0);
  const dirty = `pure tone audiometry${T}R${T}WNL${T}L${T}WNL${N}end`;
  const xml = "﻿<?xml version=\"1.0\" encoding=\"utf-8\"?>"
    + `<myhealthbank><bdata><r8><r8.10>${dirty}</r8.10></r8></bdata></myhealthbank>`;
  const bdata = xmlToBdata(xml);
  assert.equal(bdata.r8[0]["r8.10"], dirty);
});
