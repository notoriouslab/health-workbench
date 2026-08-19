// 產生示範資料庫與示範匯出 HTML（README 截圖與試用用）。
//
// 全部合成：成員名、院所、診斷、日期與量測值皆為虛構，不含任何真實個人
// 健康資料。唯一取自真實來源的是藥品代碼與成分，來自健保用藥品項開放
// 資料（app/src-tauri/resources/drug_items.sqlite），讓成分與官方仿單
// 連結在示範畫面上真的能顯示。
//
// 決定性亂數（固定種子）：同一份程式碼永遠產出同一份資料，截圖可重現。
//
// 用法：node scripts/gen_demo_data.mjs [輸出目錄]
//   產出 <輸出目錄>/demo.sqlite 與 <輸出目錄>/demo.html
//   預設輸出目錄為系統暫存目錄下的 hwb-demo（不落在版本控制內）
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../app/src/store/node_driver.js";
import { initSchema } from "../app/src/store/schema.js";
import { createProfile } from "../app/src/engine/profiles.js";
import { importAggregateStatements } from "../app/src/engine/aggregate.js";
import { buildPayload } from "../app/src/provider/payload.js";
import { assemble } from "../app/src/provider/assemble.js";

const REPO = new URL("..", import.meta.url).pathname;
const OUT_DIR = process.argv[2] || path.join(tmpdir(), "hwb-demo");
const DRUG_CACHE = path.join(REPO, "app/src-tauri/resources/drug_items.sqlite");
const LAB_ENTRIES = JSON.parse(
  readFileSync(path.join(REPO, "app/src/knowledge/labs.json"), "utf-8"));
// 固定「今天」，讓產出可重現（畫面上的「資料截至」也跟著固定）
const TODAY = "2026-08-12";

let seed = 20260812;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const iso = (dt) => dt.toISOString().slice(0, 10);
const addDays = (dt, n) => new Date(dt.getTime() + n * 864e5);
const r1 = (v) => Math.round(v * 10) / 10;

mkdirSync(OUT_DIR, { recursive: true });
const dbPath = path.join(OUT_DIR, "demo.sqlite");
const htmlPath = path.join(OUT_DIR, "demo.html");
try { rmSync(dbPath); } catch { /* 首次執行沒有舊檔 */ }

const d = new NodeDriver(dbPath);
await initSchema(d);
const pid = await createProfile(d, "示範");

// ---------- 來源檔（模擬一次健保匯入＋一次 Apple 匯入）----------
const docs = {};
for (const [key, filename, adapter, stats, at] of [
  ["nhi", "健康存摺醫療類_20260810.json", "nhi_json",
    { inserted: { encounters: 46, medications: 118, lab_results: 60 },
      skipped_dup: { encounters: 31 } }, "2026-08-10 21:14"],
  ["apple", "apple_health_export.zip", "apple_health",
    { inserted: { apple_records: 2946, body_measurements: 3 },
      skipped_dup: { apple_records: 812 } }, "2026-08-10 21:22"],
]) {
  const r = await d.execute(
    `INSERT INTO source_documents(profile_id, filename, sha256, adapter,
      adapter_version, import_stats, imported_at) VALUES (?,?,?,?,?,?,?)`,
    [pid, filename, `demo-${key}-sha`, adapter, "1", JSON.stringify(stats), at]);
  docs[key] = r.lastInsertRowid;
}

// ---------- 藥品代碼取自品項檔（開放資料）----------
const drugDb = new NodeDriver(DRUG_CACHE);
const drugRows = await drugDb.select(`
  SELECT code, name_zh, ingredient FROM drug_items
  WHERE ingredient IN ('AMLODIPINE (BESYLATE) 5 MG', 'ATORVASTATIN (CALCIUM) 10 MG',
    'METFORMIN HCL 500 MG', 'ACETAMINOPHEN (=PARACETAMOL) 500 MG', 'FAMOTIDINE 20 MG')
    AND leaflet_url IS NOT NULL
  GROUP BY ingredient LIMIT 5`);
await drugDb.close();
if (drugRows.length < 3) {
  throw new Error(`品項檔取樣不足（${drugRows.length} 筆）：`
    + "請確認 app/src-tauri/resources/drug_items.sqlite 存在且完整");
}

// ---------- 就醫紀錄與醫令 ----------
const GROUPS = {
  western: { type: "western_outpatient", section: "r1",
    facs: ["示範聯合診所", "示範綜合醫院", "示範家醫科診所"],
    dxs: [["I10", "原發性高血壓"], ["E119", "第2型糖尿病無併發症"],
          ["J069", "急性上呼吸道感染"], ["K21", "胃食道逆流"], ["E785", "高血脂症"]] },
  tcm: { type: "tcm", section: "r9", facs: ["示範中醫診所"],
    dxs: [["M542", "頸部疼痛"], ["M79604", "肩部疼痛"]] },
  dental: { type: "dental", section: "r6", facs: ["示範牙醫診所"],
    dxs: [["K053", "慢性牙周炎"], ["K021", "齒質齒齦炎"]] },
  pharmacy: { type: "pharmacy_dispensing", section: "r3", facs: ["示範藥局"],
    dxs: [["I10", "原發性高血壓"]] },
};

const START = new Date("2023-08-15T00:00:00Z");
const END = new Date("2026-08-10T00:00:00Z");
const encounters = [];
let encIdx = 0;
for (let m = 0; m < 36; m++) {
  const times = rnd() < 0.35 ? 2 : 1;
  for (let k = 0; k < times; k++) {
    const day = addDays(START, m * 30 + Math.floor(rnd() * 26));
    if (day > END) continue;
    const grp = rnd() < 0.6 ? GROUPS.western
      : rnd() < 0.55 ? GROUPS.tcm
      : rnd() < 0.6 ? GROUPS.pharmacy : GROUPS.dental;
    const [dxCode, dxName] = pick(grp.dxs);
    encounters.push({ idx: ++encIdx, grp, date: iso(day), facility: pick(grp.facs),
      dxCode, dxName,
      copay: grp.type === "pharmacy_dispensing" ? 0 : pick([50, 50, 80, 150, 320]),
      points: 200 + Math.floor(rnd() * 700) });
  }
}

const medRows = [];
let medIdx = 0;
for (const e of encounters) {
  const r = await d.execute(
    `INSERT INTO encounters(profile_id, doc_id, section, source_index, record_fp,
      canonical, type, date, facility_name, facility_code, dx_code, dx_name,
      copay, nhi_points) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [pid, docs.nhi, e.grp.section, e.idx, `fp-${e.grp.section}-${e.idx}`,
      JSON.stringify({ demo: true, i: e.idx }), e.grp.type, e.date, e.facility,
      `DEMO${1000 + e.idx}`, e.dxCode, e.dxName, e.copay, e.points]);
  const encId = r.lastInsertRowid;

  if (e.grp.type === "western_outpatient" || e.grp.type === "pharmacy_dispensing") {
    // 數量先算好再進迴圈：寫在迴圈條件裡會每輪重新抽亂數
    const count = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      const drug = drugRows[Math.floor(rnd() * drugRows.length)];
      const days = pick([14, 28, 28, 30, 7]);
      medRows.push([pid, docs.nhi, encId, drug.code, drug.name_zh, days, days,
        null, null, e.grp.section, ++medIdx, ""]);
    }
  } else if (e.grp.type === "tcm") {
    for (const name of [pick(["科學中藥－葛根湯", "科學中藥－疏經活血湯",
      "科學中藥－獨活寄生湯"]), "一般針灸－未開內服藥"]) {
      medRows.push([pid, docs.nhi, encId, null, name, 1,
        name.startsWith("科學") ? 7 : 0, null, null, "r9", ++medIdx, ""]);
    }
  } else {
    medRows.push([pid, docs.nhi, encId, "91004C", "牙結石清除（半口）", 1, 0,
      "FDI-16", "右上第一大臼齒", e.grp.section, ++medIdx, ""]);
  }
}
await d.batchInsert("medications",
  ["profile_id", "doc_id", "encounter_id", "order_code", "order_name", "total_qty",
    "days_supply", "tooth_code", "tooth_name", "section", "source_index",
    "quality_flags"], medRows);

// ---------- 檢驗（正規化名稱對齊 labs.json，知識說明才會出現）----------
const LABS = [
  ["Creatinine", "CREATININE(血中肌酸酐)", 1.02, 0.14, "[0.7-1.3]", "mg/dL", 0],
  ["Hemoglobin", "HGB", 14.6, 0.6, "[13-17]", "g/dL", 0],
  ["ALT", "GPT(ALT)", 28, 9, "[0-40]", "U/L", 0],
  ["Lymphocyte", "LYMPHOCYTE", 31.5, 4.2, "[20-45]", "%", 0],
  ["eGFR (CKD-EPI)", "eGFR", 79, 6, "[90-]", "mL/min/1.73m2", -0.9],
];
const labDates = Array.from({ length: 10 }, (_, q) => iso(addDays(START, q * 108 + 12)));
const labRows = [];
let labIdx = 0;
for (const [norm, raw, base, amp, ref, unit, drift] of LABS) {
  labDates.forEach((dt, i) => {
    const v = r1(base + drift * i + (rnd() - 0.5) * 2 * amp);
    labRows.push([pid, docs.nhi, "r4", ++labIdx, `fp-lab-${norm}-${i}`,
      JSON.stringify({ demo: true }), dt, dt, "示範綜合醫院", `L${9000 + labIdx}`,
      "生化檢驗", raw, norm, `${v} ${unit}`, v, ref, ""]);
  });
}
await d.batchInsert("lab_results",
  ["profile_id", "doc_id", "section", "source_index", "record_fp", "canonical",
    "visit_date", "test_date", "facility_name", "order_code", "order_name",
    "test_name_raw", "test_name_normalized", "value_text", "value_numeric",
    "ref_range", "quality_flags"], labRows);

// ---------- 成人健檢（體重圖上的另一組來源標記）----------
await d.batchInsert("body_measurements",
  ["profile_id", "doc_id", "section", "source_index", "record_fp", "canonical",
    "check_date", "height_cm", "weight_kg", "bmi", "waist", "systolic", "diastolic"],
  [[pid, docs.nhi, "r7", 1, "fp-bm-1", "{}", "2024-03-06", 170.2, 73.5, 25.4, 88, 138, 88],
   [pid, docs.nhi, "r7", 2, "fp-bm-2", "{}", "2025-04-18", 170.0, 72.1, 24.9, 86, 132, 84],
   [pid, docs.nhi, "r7", 3, "fp-bm-3", "{}", "2026-05-09", 170.1, 71.0, 24.5, 85, 128, 82]]);

// ---------- Apple 健康（體重、血壓、步數）----------
const appleRows = [];
const A_START = new Date("2023-08-01T00:00:00Z");
const A_DAYS = 1105;
let w = 74.8;
for (let i = 0; i < A_DAYS; i++) {
  const day = addDays(A_START, i);
  const ds = iso(day);
  w += (71.2 - w) * 0.0035 + (rnd() - 0.5) * 0.42;
  appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierBodyMass", "體重",
    `${ds} 07:1${i % 10}:00`, `${ds} 07:1${i % 10}:00`,
    Math.round(w * 100) / 100, null, null, "kg", "示範體重計", ""]);
  const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
  appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierStepCount", "步數",
    `${ds} 00:00:00`, `${ds} 23:59:00`,
    Math.round((weekend ? 5200 : 7600) + (rnd() - 0.5) * 3400), null, null,
    "count", "示範手機", ""]);
  if (i % 4 === 0) {
    // 血壓隨體重下降緩步改善（示範「趨勢看得出來」）
    appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierBloodPressureSystolic",
      "收縮壓", `${ds} 07:30:00`, `${ds} 07:30:00`,
      Math.round(146 - (74.8 - w) * 3.2 + (rnd() - 0.5) * 9), null, null, "mmHg",
      "示範血壓計", ""]);
    appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierBloodPressureDiastolic",
      "舒張壓", `${ds} 07:30:00`, `${ds} 07:30:00`,
      Math.round(92 - (74.8 - w) * 1.6 + (rnd() - 0.5) * 6), null, null, "mmHg",
      "示範血壓計", ""]);
  }
}
// ---------- Watch 樣態（display-revamp-bands-cleanup 六分頁示範素材）----------
// 最近 400 天有「示範手錶」：心率帶狀、血氧、呼吸速率、安靜心率、睡眠。
// 血氧與行走穩定度照 HealthKit 官方值域存 0-1 標 %（檢視層換算顯示）。
const W_DAYS = 400;
const pad2 = (n) => String(n).padStart(2, "0");
for (let i = 0; i < W_DAYS; i++) {
  const day = addDays(A_START, A_DAYS - W_DAYS + i);
  const ds = iso(day);
  const rest = Math.round(55 + rnd() * 8);
  for (const [hh, base] of [[8, rest + 12], [12, rest + 25], [18, rest + 45], [21, rest + 8]]) {
    appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierHeartRate", "心率",
      `${ds} ${pad2(hh)}:1${i % 10}:00`, `${ds} ${pad2(hh)}:1${i % 10}:00`,
      Math.round(base + (rnd() - 0.5) * 14), null, null, "count/min", "示範手錶", ""]);
  }
  appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierRestingHeartRate", "安靜心率",
    `${ds} 23:59:00`, `${ds} 23:59:00`, rest, null, null, "count/min", "示範手錶", ""]);
  appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierOxygenSaturation", "血氧",
    `${ds} 03:00:00`, `${ds} 03:00:00`,
    Math.round((0.93 + rnd() * 0.06) * 100) / 100, null, null, "%", "示範手錶", ""]);
  appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierRespiratoryRate", "呼吸速率",
    `${ds} 03:30:00`, `${ds} 03:30:00`,
    r1(13 + rnd() * 4), null, null, "count/min", "示範手錶", ""]);
  if (i % 7 === 0) {
    appleRows.push([pid, docs.apple, "HKQuantityTypeIdentifierAppleWalkingSteadiness",
      "行走穩定度", `${ds} 09:00:00`, `${ds} 09:00:00`,
      Math.round((0.86 + rnd() * 0.1) * 1000) / 1000, null, null, "%", "示範手機", ""]);
  }
  // 睡眠：躺床一段＋核心／深層／快速動眼分段（起始都在同一日曆日）
  const inBedMin = 420 + Math.round(rnd() * 90);
  appleRows.push([pid, docs.apple, "HKCategoryTypeIdentifierSleepAnalysis", "睡眠",
    `${ds} 23:0${i % 10}:00`, `${iso(addDays(day, 1))} 07:0${i % 10}:00`,
    null, null, "HKCategoryValueSleepAnalysisInBed", null, "示範手錶", ""]);
  let t = 23 * 60 + 20;
  for (const [stage, mins] of [["AsleepCore", Math.round(inBedMin * 0.55)],
    ["AsleepDeep", Math.round(inBedMin * 0.18)],
    ["AsleepREM", Math.round(inBedMin * 0.2)]]) {
    const sH = Math.floor(t / 60) % 24, sM = t % 60;
    const eAbs = t + mins;
    const nextDay = eAbs >= 24 * 60;
    const eH = Math.floor(eAbs / 60) % 24, eM = eAbs % 60;
    appleRows.push([pid, docs.apple, "HKCategoryTypeIdentifierSleepAnalysis", "睡眠",
      `${ds} ${pad2(sH)}:${pad2(sM)}:00`,
      `${nextDay ? iso(addDays(day, 1)) : ds} ${pad2(eH)}:${pad2(eM)}:00`,
      null, null, `HKCategoryValueSleepAnalysis${stage}`, null, "示範手錶", ""]);
    t = eAbs;
  }
}
await d.batchInsert("apple_records",
  ["profile_id", "doc_id", "type", "type_zh", "start_ts", "end_ts", "value_numeric",
    "value_normalized", "value_text", "unit", "source_name", "quality_flags"],
  appleRows);

// 運動記錄（測量分頁的列表）：每週 2 次
const workoutRows = [];
for (let i = 0; i < W_DAYS; i += 3 + Math.floor(rnd() * 3)) {
  const day = addDays(A_START, A_DAYS - W_DAYS + i);
  const ds = iso(day);
  const [act, mins] = pick([["Running", 32], ["Walking", 48], ["Cycling", 55], ["Yoga", 40]]);
  workoutRows.push([pid, docs.apple, act, `${ds} 07:00:00`, `${ds} 08:00:00`,
    r1(mins + (rnd() - 0.5) * 10), "示範手錶"]);
}
await d.batchInsert("apple_workouts",
  ["profile_id", "doc_id", "activity", "start_ts", "end_ts", "duration_min", "source_name"],
  workoutRows);

// 疫苗接種（就醫分頁的表格）
await d.batchInsert("immunizations",
  ["profile_id", "doc_id", "section", "source_index", "record_fp", "canonical",
    "date", "vaccine_name", "facility_name"],
  [["流感疫苗（四價）", "2025-10-14"], ["COVID-19 疫苗（JN.1）", "2025-10-14"],
    ["肺炎鏈球菌疫苗（PCV13）", "2024-11-06"], ["帶狀疱疹疫苗（第二劑）", "2024-03-22"]]
    .map(([name, dt], i) => [pid, docs.nhi, "r6", i + 1, `fp-imm-${i}`, "{}",
      dt, name, "示範綜合醫院"]));

// 彙總表回填：payload 的活動與帶狀序列讀 apple_daily（直插 raw 不走
// adapter，必須照匯入的真實路徑補跑同一份聚合語句，否則示範頁趨勢全空）
for (const { sql, params } of importAggregateStatements()) {
  await d.execute(sql, Array(params).fill(docs.apple));
}

// ---------- 組 payload 並產出示範 HTML ----------
const BODY_REFS = JSON.parse(
  readFileSync(path.join(REPO, "app/src/knowledge/body_refs.json"), "utf-8"));
const payload = await buildPayload(d, { profileId: pid, knowledgeEntries: LAB_ENTRIES,
  bodyRefs: BODY_REFS, drugCachePath: DRUG_CACHE, today: TODAY });
await d.close();

const assets = {
  appJs: readFileSync(path.join(REPO, "app/src/viewer/assets/app.js"), "utf-8"),
  css: readFileSync(path.join(REPO, "app/src/viewer/assets/style.css"), "utf-8"),
  vendor: ["preact.min.js", "hooks.umd.js", "htm.umd.js"].map(f =>
    readFileSync(path.join(REPO, "app/src/viewer/assets/vendor", f), "utf-8")),
};
writeFileSync(htmlPath, assemble(payload, assets));

const c = payload.meta.counts;
console.log(`就醫 ${c.encounters}｜用藥 ${c.medications}（品項檔命中 `
  + `${payload.medications.filter(m => m.drug_zh).length}）｜檢驗 ${c.lab_results}`
  + `｜Apple ${c.apple_records}｜成健 ${c.body_measurements}`);
console.log(`資料庫：${dbPath}`);
console.log(`示範頁面：${htmlPath}`);
console.log("（以上皆為合成資料，可直接用瀏覽器開啟示範頁面）");
