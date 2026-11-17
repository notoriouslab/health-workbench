// 多成員隔離 marker 掃描（design D3；app-viewer spec「成員隔離 marker
// 掃描」scenario）：成員 B 全部紀錄含唯一 marker 字串，成員 A 的
// payload 序列化結果必須零出現——任一 provider 查詢漏加 profile 過濾，
// 此測試即轉紅。負向自檢（2026-08-10 實測記錄）：暫時將 payload.js
// labs 查詢的 WHERE profile_id=? 註解掉後本檔轉紅（marker 洩漏斷言
// 失敗），確認護欄有效後復原。
import test from "node:test";
import assert from "node:assert/strict";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { createProfile } from "../../src/engine/profiles.js";
import { buildPayload } from "../../src/provider/payload.js";
import { assemble } from "../../src/provider/assemble.js";
import { readFileSync } from "node:fs";

const MARKER_B = "ISOLATION_MARKER_B";
const MARKER_A = "ISOLATION_MARKER_A";

// 健保檔：facility 名稱帶 marker，覆蓋 r1（就醫+用藥）、r6 疫苗、
// r7 檢驗、r8 報告、r10 身體數值、r11 癌篩
const nhiFile = (masked, marker, name) => ({
  name,
  bytes: new TextEncoder().encode(JSON.stringify({ myhealthbank: { bdata: {
    "b1.1": masked,
    r1: [{ "r1.3": "9900000009", "r1.4": `${marker}醫院`, "r1.5": "20260101",
      "r1_1": [{ "r1_1.1": "ORD1", "r1_1.2": `${marker}藥品` }] }],
    r6: [{ "r6.2": "20260102", "r6.3": `${marker}疫苗`, "r6.4": `${marker}醫院` }],
    r7: [{ "r7.2": "20260103", "r7.4": `${marker}醫院`, "r7.9": `${marker}檢驗`,
      "r7.10": "5.5" }],
    r8: [{ "r8.2": "20260104", "r8.4": `${marker}醫院`, "r8.9": `${marker}報告`,
      "r8.10": `${marker}內容` }],
    r10: [{ "r10.2": "20260105", "r10.3": "170", "r10.4": "70" }],
    r11: [{ "r11.2": "20260106", "r11.3": `${marker}癌篩` }],
  } } })),
});

const appleXml = (marker) => `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_TW">
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="${marker}Phone" unit="count"
  startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:10:00 +0800" value="100"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="${marker}Watch"
  duration="30" durationUnit="min"
  startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800"/>
</HealthData>`;

function appleSource(marker, name) {
  const bytes = new TextEncoder().encode(appleXml(marker));
  return {
    name, size: bytes.length,
    readAt: async (off, len) => bytes.subarray(off, off + len),
    stream: async function* () { yield bytes; },
  };
}

async function twoMemberDb() {
  const d = new NodeDriver();
  await initSchema(d);
  const a = await createProfile(d, "成員A");
  const b = await createProfile(d, "成員B");
  for (const [pid, marker, tag] of [[a, MARKER_A, "a"], [b, MARKER_B, "b"]]) {
    const masked = pid === a ? "A11111****" : "B22222****";
    const rn = await nhiJsonAdapter.importSource(
      nhiFile(masked, marker, `${marker}_檔案_${tag}.json`), d, null,
      { labEntries: [], profileId: pid });
    assert.equal(rn.status, "ok");
    const ra = await appleHealthAdapter.importSource(
      appleSource(marker, `${marker}_export_${tag}.xml`), d, null,
      { profileId: pid });
    assert.equal(ra.status, "ok");
  }
  return { d, a, b };
}

test("成員隔離：A 的 payload 零出現 B 的 marker（雙向）", async () => {
  const { d, a, b } = await twoMemberDb();
  const opts = { knowledgeEntries: [], drugCachePath: null, today: "2026-08-10" };
  const payloadA = JSON.stringify(
    await buildPayload(d, { profileId: a, ...opts }));
  const payloadB = JSON.stringify(
    await buildPayload(d, { profileId: b, ...opts }));

  assert.ok(!payloadA.includes(MARKER_B),
    `A 的 payload 洩漏 B 的資料：${(payloadA.match(new RegExp(MARKER_B, "g")) || []).length} 處`);
  assert.ok(!payloadB.includes(MARKER_A),
    `B 的 payload 洩漏 A 的資料`);
  // 正向對照：各自的 marker 必須存在（防「兩邊都空」的假隔離）
  assert.ok(payloadA.includes(MARKER_A), "A 自己的資料應存在");
  assert.ok(payloadB.includes(MARKER_B), "B 自己的資料應存在");
  await d.close();
});

test("meta 邊界：profile=當前成員名、counts.profiles=全庫、sources 僅自己", async () => {
  const { d, a } = await twoMemberDb();
  const p = await buildPayload(d,
    { profileId: a, knowledgeEntries: [], drugCachePath: null, today: "2026-08-10" });
  assert.equal(p.meta.profile, "成員A");
  assert.equal(p.meta.counts.profiles, 2, "profiles 一欄維持全庫成員數");
  assert.ok(p.meta.sources.length >= 2);
  for (const s of p.meta.sources) {
    assert.ok(!s.filename.includes(MARKER_B), `sources 夾帶他人檔名：${s.filename}`);
  }
  assert.ok(p.meta.counts.encounters >= 1);
  await d.close();
});

test("匯出檔層級隔離：assemble(A) 的完整單檔 HTML 零出現 B 的 marker", async () => {
  // exportHtml 寫出的就是 assemble(payload) 字串（app-viewer spec
  // 「匯出僅當前成員」scenario 的自動化面；Jenny 稽核補：payload 層
  // 掃描不能替代匯出檔層掃描的聲明）
  const { d, a } = await twoMemberDb();
  const payload = await buildPayload(d,
    { profileId: a, knowledgeEntries: [], drugCachePath: null, today: "2026-08-10" });
  const A = new URL("../../src/viewer/assets/", import.meta.url);
  const assets = {
    appJs: readFileSync(new URL("app.js", A), "utf-8"),
    css: readFileSync(new URL("style.css", A), "utf-8"),
    vendor: ["preact.min.js", "hooks.umd.js", "htm.umd.js"].map(
      f => readFileSync(new URL(`vendor/${f}`, A), "utf-8")),
  };
  const html = assemble(payload, assets);
  assert.ok(!html.includes(MARKER_B), "匯出 HTML 洩漏他成員資料");
  assert.ok(html.includes(MARKER_A), "匯出 HTML 應含自己的資料");
  await d.close();
});

test("payload 各鍵覆蓋：A 視角下每個資料鍵都經過過濾查詢（結構抽查）", async () => {
  const { d, a } = await twoMemberDb();
  const p = await buildPayload(d,
    { profileId: a, knowledgeEntries: [], drugCachePath: null, today: "2026-08-10" });
  // 每個含 B marker 風險的鍵逐一斷言非空且乾淨（防「空集合掩蓋漏過濾」）
  assert.equal(p.encounters.length, 1);
  assert.equal(p.medications.length, 1);
  assert.equal(p.labs.length, 1);
  assert.equal(p.reports.length, 1);
  assert.equal(p.immunizations.length, 1);
  assert.equal(p.nhi_body.length, 1);
  assert.equal(p.workouts.length, 1);
  const steps = p.activity["步數"] ?? [];
  assert.ok(steps.length >= 1, "活動聚合應含 A 的步數");
  await d.close();
});

test("匯出 sources 的 import_stats 只帶白名單：遮罩身分證與 nhi_retained 不外流", async () => {
  const { d, a } = await twoMemberDb();
  const raw = (await d.select("SELECT import_stats FROM source_documents")).map(r => r.import_stats || "");
  // 前提：資料庫裡確實存了保留資料，否則本測試是空測
  assert.ok(raw.some(s => s.includes("nhi_retained") && s.includes("A11111****")));
  const p = await buildPayload(d,
    { profileId: a, knowledgeEntries: [], drugCachePath: null, today: "2026-08-10" });
  const text = JSON.stringify(p);
  assert.ok(!text.includes("A11111****"), "payload 夾帶遮罩身分證");
  assert.ok(!text.includes("nhi_retained") && !text.includes("nhi_failed_records"));
  for (const s of p.meta.sources) {
    const st = JSON.parse(s.import_stats);
    assert.ok(Object.keys(st).every(k => k === "inserted" || k === "skipped_dup"));
    assert.ok(st.inserted, "白名單鍵仍須保留");
  }
  await d.close();
});
