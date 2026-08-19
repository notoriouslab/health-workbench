// 趨勢圖時間軸與區間選擇（change trend-time-axis）。
// 走與 viewer_render.test.mjs 相同的 vm sandbox 手法：不新增資產模組，
// 對真渲染出來的 SVG 座標與文字斷言（design D7／D9）。
// 資料形狀刻意複製生產庫實測到的病灶：體重密集且新鮮、血壓停在 數百天前、
// 檢驗僅 3 筆且含一筆 null 日期、步數逐日。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { importAggregateStatements } from "../../src/engine/aggregate.js";
import { createProfile } from "../../src/engine/profiles.js";
import { buildPayload } from "../../src/provider/payload.js";
import { makeDocument, findAll } from "../helpers/mini_dom.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;
const ASSETS = new URL("../../src/viewer/assets/", import.meta.url);
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));
const TODAY = "2026-08-12";
const W = 860, PL = 48, PR = 100, PW = W - PL - PR;
const day = (n) => n * 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

/* 建一顆形狀貼近生產庫實測形狀的庫 */
async function shapePayload({ nullLabDate = false, staleAll = false,
  latestAfterGenerated = false, weightEveryOtherDay = false, ancientDate = false } = {}) {
  const d = new NodeDriver(path.join(mkdtempSync(path.join(tmpdir(), "hwb-ta-")), "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "示範");
  const doc = {};
  for (const [k, ad] of [["nhi", "nhi_json"], ["apple", "apple_health"]]) {
    const r = await d.execute(
      `INSERT INTO source_documents(profile_id, filename, sha256, adapter,
        adapter_version, imported_at) VALUES (?,?,?,?,?,?)`,
      [pid, `${k}.dat`, `sha-${k}`, ad, "1", "2026-08-10 21:00"]);
    doc[k] = r.lastInsertRowid;
  }
  // 就醫一筆（讓 meta.date_min/max 有值）
  await d.execute(
    `INSERT INTO encounters(profile_id, doc_id, section, source_index, record_fp,
      canonical, type, date, facility_name) VALUES (?,?,?,?,?,?,?,?,?)`,
    [pid, doc.nhi, "r1", 1, "fp-e1", "{}", "western_outpatient", "2025-03-04", "示範診所"]);

  const T = Date.parse(TODAY);
  const appleRows = [];
  // 體重：起點依情境；每日一點（密集）
  const wStart = staleAll ? T - day(2000) : T - day(2766);
  const wEnd = staleAll ? T - day(1600) : T - day(4);
  for (let t = wStart; t <= wEnd; t += day(weightEveryOtherDay ? 2 : 1)) {
    appleRows.push([pid, doc.apple, "HKQuantityTypeIdentifierBodyMass", "體重",
      `${iso(t)} 07:10:00`, `${iso(t)} 07:10:00`,
      // 隨時間自 78 緩降至 70：不同區間的 y 上下界才會不同
      Math.round((70 + 8 * (wEnd - t) / Math.max(wEnd - wStart, 1)) * 10) / 10,
      null, null, "kg", "示範體重計", ""]);
  }
  if (latestAfterGenerated) {   // 一筆晚於 generated_at 的量測
    const t = T + day(1);
    appleRows.push([pid, doc.apple, "HKQuantityTypeIdentifierBodyMass", "體重",
      `${iso(t)} 07:10:00`, `${iso(t)} 07:10:00`, 71.9, null, null, "kg", "示範體重計", ""]);
  }
  // 血壓：32 天，末筆距 TODAY 數百天
  for (let i = 0; i < 32; i++) {
    const t = T - day(621) - day((31 - i) * 27);
    for (const [type, zh, v] of [["Systolic", "收縮壓", 138], ["Diastolic", "舒張壓", 88]]) {
      appleRows.push([pid, doc.apple, `HKQuantityTypeIdentifierBloodPressure${type}`, zh,
        `${iso(t)} 07:30:00`, `${iso(t)} 07:30:00`, v, null, null, "mmHg", "示範血壓計", ""]);
    }
  }
  // 步數：逐日 400 天（staleAll 時整段往前推，否則集合最新仍是新鮮的）
  const stepEnd = staleAll ? T - day(1500) : T;
  for (let i = 0; i < 400; i++) {
    const t = stepEnd - day(400 - i);
    appleRows.push([pid, doc.apple, "HKQuantityTypeIdentifierStepCount", "步數",
      `${iso(t)} 00:00:00`, `${iso(t)} 23:59:00`, 7000, null, null, "count", "示範手機", ""]);
  }
  await d.batchInsert("apple_records",
    ["profile_id", "doc_id", "type", "type_zh", "start_ts", "end_ts", "value_numeric",
      "value_normalized", "value_text", "unit", "source_name", "quality_flags"], appleRows);
  // 直插 raw 不走 adapter，彙總表要照匯入的真實路徑補跑同一份聚合語句
  // （payload 的活動序列讀 apple_daily，change apple-daily-aggregates）
  for (const { sql, params } of importAggregateStatements()) {
    await d.execute(sql, Array(params).fill(doc.apple));
  }
  // 檢驗：3 筆（可選一筆 null 日期）
  const labDates0 = staleAll
    ? [iso(T - day(2400)), iso(T - day(2000)), iso(T - day(1600))]
    : ["2024-10-23", "2025-08-14", "2026-07-03"];
  const labDates = [...(ancientDate ? ["1985-06-01"] : []), ...labDates0,
    ...(nullLabDate ? [null] : [])];
  await d.batchInsert("lab_results",
    ["profile_id", "doc_id", "section", "source_index", "record_fp", "canonical",
      "test_date", "facility_name", "order_name", "test_name_raw",
      "test_name_normalized", "value_text", "value_numeric", "ref_range", "quality_flags"],
    labDates.map((dt, i) => [pid, doc.nhi, "r4", i + 1, `fp-l-${i}`, "{}", dt,
      "示範綜合醫院", "生化檢驗", "CREATININE", "Creatinine", "1.0 mg/dL", 1.0 + i * 0.05,
      "[0.7-1.3]", ""]));
  // 第二個檢驗項目（日期落在第一項的範圍內）：供「切換項目不位移 x 軸」
  // 測試用（單一項目切不了）
  await d.batchInsert("lab_results",
    ["profile_id", "doc_id", "section", "source_index", "record_fp", "canonical",
      "test_date", "facility_name", "order_name", "test_name_raw",
      "test_name_normalized", "value_text", "value_numeric", "ref_range", "quality_flags"],
    labDates0.slice(0, 2).map((dt, i) => [pid, doc.nhi, "r4", 90 + i, `fp-g-${i}`, "{}",
      dt, "示範綜合醫院", "生化檢驗", "GLUCOSE", "Glucose", "95 mg/dL", 95 + i,
      "[70-100]", ""]));
  // 成健三點（體重圖第二條序列，顯式 marker）
  await d.batchInsert("body_measurements",
    ["profile_id", "doc_id", "section", "source_index", "record_fp", "canonical",
      "check_date", "weight_kg"],
    [[pid, doc.nhi, "r7", 1, "fp-b1", "{}", iso(T - day(2200)), 74.2],
     [pid, doc.nhi, "r7", 2, "fp-b2", "{}", iso(T - day(1100)), 72.4],
     [pid, doc.nhi, "r7", 3, "fp-b3", "{}",
      iso(T - day(staleAll ? 1500 : 120)), 70.9]]);

  const p = await buildPayload(d, { profileId: pid, knowledgeEntries: LAB_ENTRIES,
    drugCachePath: null, today: TODAY });
  await d.close();
  return p;
}

function render(payload) {
  const doc = makeDocument();
  const dataEl = doc.createElement("script");
  dataEl.textContent = JSON.stringify(payload);
  doc.registerId("hwb-data", dataEl);
  const root = doc.createElement("div");
  doc.registerId("app", root);
  const sandbox = { document: doc, console, setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id) };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["vendor/preact.min.js", "vendor/hooks.umd.js", "vendor/htm.umd.js", "app.js"]) {
    vm.runInContext(readFileSync(new URL(f, ASSETS), "utf-8"), sandbox, { filename: f });
  }
  const flush = () => new Promise((r) => setTimeout(r, 5));
  return { root, flush };
}

const btn = (root, label) => findAll(root, (e) => e.localName === "button"
  && e.textContent === label && (e.listeners.click || []).length)[0];
const svgs = (root) => findAll(root, (e) => e.localName === "svg");
const inSvg = (s, name) => findAll(s, (e) => e.localName === name);
const num = (el, a) => Number(el.getAttribute(a));
// x 軸刻度＝固定畫在 y = H - 8 = 232 的 text；y 軸數值標籤最低在 216，
// 用 > 200 會把它一起撈進來（第一版測試的錯）
const X_TICK_Y = 232;
const xTicks = (s) => inSvg(s, "text").filter((t) => num(t, "y") === X_TICK_Y)
  .map((t) => t.textContent);
const legend = (s) => inSvg(s, "text").filter((t) => num(t, "x") >= W - PR);

/* 分頁改版（display-revamp-bands-cleanup）後：體重／血壓／步數在測量
   分頁，檢驗在檢驗分頁，各自有整頁區間與時間域 */
async function trends(payload) {
  const { root, flush } = render(payload);
  await flush();
  btn(root, "測量").dispatch("click");
  await flush();
  return { root, flush };
}

async function labsPage(payload) {
  const { root, flush } = render(payload);
  await flush();
  btn(root, "檢驗").dispatch("click");
  await flush();
  return { root, flush };
}

test("停止記錄的序列末點不落在右緣，且時間間隔成正比", async () => {
  const { root } = await trends(await shapePayload());
  btn(root, "全部").dispatch("click");
  await new Promise((r) => setTimeout(r, 10));
  const bp = svgs(root).find((s) => inSvg(s, "circle").length === 64);
  assert.ok(bp, "找不到血壓圖（64 個標記）");
  const maxCx = Math.max(...inSvg(bp, "circle").map((c) => num(c, "cx")));
  assert.ok(maxCx < PL + 0.85 * PW,
    `血壓末點 cx=${maxCx.toFixed(0)} 應明顯小於右緣 ${PL + PW}`);
});

test("測量頁各圖共用時間域：x 軸刻度一致", async () => {
  const { root, flush } = await trends(await shapePayload());
  btn(root, "全部").dispatch("click");
  await flush();
  const tickSets = svgs(root).map(xTicks).filter((t) => t.length);
  assert.ok(tickSets.length >= 2, "至少兩張圖要有刻度");
  for (const t of tickSets) assert.deepEqual(t, tickSets[0], "各圖刻度應一致");
});

test("檢驗頁：切換檢驗項目不位移 x 軸（集合含全部項目）", async () => {
  const { root, flush } = await labsPage(await shapePayload());
  btn(root, "全部").dispatch("click");
  await flush();
  const before = svgs(root).map(xTicks).filter((t) => t.length);
  assert.ok(before.length >= 1, "檢驗頁要有刻度");
  const sel = findAll(root, (e) => e.localName === "select")[0];
  assert.ok(sel, "檢驗頁應保留項目下拉（既有互動不退化）");
  sel.value = "Glucose";
  sel.dispatch("change");
  await flush();
  const after = svgs(root).map(xTicks).filter((t) => t.length);
  assert.ok(after.length >= 1, "切換後圖要還在");
  assert.deepEqual(after[0], before[0], "切換檢驗項目不得位移 x 軸刻度");
});

test("刻度依時間挑選：跨度大用年、近三月降到不超過上限且格式為 MM-DD", async () => {
  const { root, flush } = await trends(await shapePayload());
  btn(root, "全部").dispatch("click");
  await flush();
  const yearTicks = svgs(root).map(xTicks).find((t) => t.length);
  assert.ok(yearTicks.length >= 4 && yearTicks.length <= 8,
    `7 年以上跨度刻度數 ${yearTicks.length} 應在 4 到 8 之間`);
  for (const t of yearTicks) assert.match(t, /^\d{4}$/, "應為年格式");
  btn(root, "近三月").dispatch("click");
  await flush();
  const shortTicks = svgs(root).map(xTicks).find((t) => t.length);
  assert.ok(shortTicks.length <= 8, `近三月刻度數 ${shortTicks.length} 應 ≤ 8（週需降級）`);
  for (const t of shortTicks) assert.match(t, /^\d{2}-\d{2}$/, "近三月應為 MM-DD");
  assert.equal(new Set(shortTicks).size, shortTicks.length, "刻度文字不得重複");
});

test("圖例在右側固定位置、名稱截斷、格線不壓圖例", async () => {
  const { root, flush } = await trends(await shapePayload());
  btn(root, "全部").dispatch("click");
  await flush();
  const weight = svgs(root).find((s) => inSvg(s, "circle").some((c) => num(c, "r") === 6));
  assert.ok(weight, "找不到體重圖（含成健 r=6 標記）");
  const lg = legend(weight);
  assert.ok(lg.length >= 4, "兩條序列各兩行，至少 4 個圖例文字");
  const ys = lg.map((t) => num(t, "y"));
  assert.equal(new Set(ys).size, ys.length, "圖例各行 y 不得重疊");
  for (const t of lg) assert.ok(t.textContent.length <= 8, `圖例文字「${t.textContent}」應 ≤ 8 字`);
  for (const l of inSvg(weight, "line")) {
    assert.ok(num(l, "x2") <= W - PR, "格線右緣不得越過圖例區");
  }
});

test("標記兩段門檻：密集不畫、稀疏逐點、顯式 marker 不被吃掉", async () => {
  const { root, flush } = await trends(await shapePayload());
  btn(root, "全部").dispatch("click");
  await flush();
  const weight = svgs(root).find((s) => inSvg(s, "circle").some((c) => num(c, "r") === 6));
  const marks = inSvg(weight, "circle");
  assert.equal(marks.length, 3, "體重圖只應有成健 3 個標記（Apple 密集序列不畫）");
  for (const m of marks) assert.equal(num(m, "r"), 6, "成健顯式 marker=6 必須保留");
  const bp = svgs(root).find((s) => inSvg(s, "circle").length === 64);
  assert.ok(inSvg(bp, "circle").every((c) => num(c, "r") === 3),
    "血壓 32 點（每序列）應逐點以 r=3 繪製");
});

test("預設區間：整體資料陳舊時預設全部", async () => {
  const { root } = await trends(await shapePayload({ staleAll: true }));
  const on = findAll(root, (e) => e.localName === "button"
    && String(e.attributes.class || "").includes("on")).map((e) => e.textContent);
  assert.ok(on.includes("全部"), `預設應為全部，實際 ${JSON.stringify(on)}`);
});

test("單圖無資料顯示看全部入口，點擊後整頁切為全部", async () => {
  const { root, flush } = await trends(await shapePayload());
  const on = findAll(root, (e) => e.localName === "button"
    && String(e.attributes.class || "").includes("on")).map((e) => e.textContent);
  assert.ok(on.includes("近一年"), "體重新鮮時預設應為近一年");
  const showAll = btn(root, "看全部");
  assert.ok(showAll, "血壓在近一年內無資料，應出現看全部入口");
  showAll.dispatch("click");
  await flush();
  const on2 = findAll(root, (e) => e.localName === "button"
    && String(e.attributes.class || "").includes("on")).map((e) => e.textContent);
  assert.ok(on2.includes("全部"), "點擊後整頁應切為全部");
  const bp = svgs(root).find((s) => inSvg(s, "circle").length === 64);
  assert.ok(bp, "切全部後血壓圖應有資料");
});

test("步數粒度隨區間：近三月逐日、全部月平均", async () => {
  const { root, flush } = await trends(await shapePayload());
  btn(root, "近三月").dispatch("click");
  await flush();
  assert.ok(root.textContent.includes("逐日"), "近三月圖說應標明逐日");
  btn(root, "全部").dispatch("click");
  await flush();
  assert.ok(root.textContent.includes("月平均"), "全部區間圖說應標明月平均");
});

test("null 日期被剔除且不污染時間域", async () => {
  const { root, flush } = await labsPage(await shapePayload({ nullLabDate: true }));
  btn(root, "全部").dispatch("click");
  await flush();
  const ticks = svgs(root).map(xTicks).find((t) => t.length);
  assert.ok(!ticks.some((t) => t.startsWith("197")),
    `時間域下界不應被拉到 1970，實際刻度 ${JSON.stringify(ticks)}`);
  assert.match(root.textContent, /已略過 1 筆日期無法識別/);
});

test("晚於 generated_at 的最新量測不被靜默隱藏", async () => {
  const { root, flush } = await trends(await shapePayload({ latestAfterGenerated: true }));
  btn(root, "全部").dispatch("click");
  await flush();
  const weight = svgs(root).find((s) => inSvg(s, "circle").some((c) => num(c, "r") === 6));
  const poly = inSvg(weight, "polyline")[0];
  const xs = (poly.getAttribute("points") || "").split(" ")
    .map((p) => Number(p.split(",")[0])).filter((n) => !Number.isNaN(n));
  assert.ok(Math.max(...xs) <= PL + PW + 0.5,
    "最新點不得畫出繪圖區右緣（上界須含它）");
  assert.ok(Math.max(...xs) > PL + PW - 2, "最新點應貼齊右緣（它就是上界）");
});

/* ---- 以下為 QA 稽核（validator 突變測試）指出「宣稱有斷言但實際無效力」
   之處的補強：中段門檻半徑、步數點數粒度、名稱截斷、刻度間距、y 軸重算、
   月桶不出界、總覽卡標記、極大跨度刻度不為空、總覽血壓卡顯示日期。 ---- */

test("標記中段門檻：119 至 237 點用 r=1.5 而非 r=3", async () => {
  // 隔日體重 → 近一年約 183 點，落在中段
  const { root, flush } = await trends(await shapePayload({ weightEveryOtherDay: true }));
  btn(root, "近一年").dispatch("click");
  await flush();
  const weight = svgs(root).find((s) => inSvg(s, "circle").some((c) => num(c, "r") === 6));
  const small = inSvg(weight, "circle").filter((c) => num(c, "r") === 1.5);
  assert.ok(small.length > 118 && small.length <= 237,
    `中段序列應以 r=1.5 繪製，實際 r=1.5 的標記 ${small.length} 個`);
  assert.equal(inSvg(weight, "circle").filter((c) => num(c, "r") === 3).length, 0,
    "中段序列不應出現 r=3");
});

test("步數粒度：點數真的隨區間改變（非只有圖說文字）", async () => {
  const { root, flush } = await trends(await shapePayload());
  const stepPts = () => {
    const s = svgs(root).find((x) => inSvg(x, "text")
      .some((t) => t.textContent.includes("日均步數")));
    const poly = inSvg(s, "polyline")[0];
    return (poly.getAttribute("points") || "").split(" ").filter(Boolean).length;
  };
  btn(root, "近三月").dispatch("click");
  await flush();
  const daily = stepPts();
  btn(root, "全部").dispatch("click");
  await flush();
  const monthly = stepPts();
  assert.ok(daily > 30, `近三月應為逐日（實際 ${daily} 點）`);
  assert.ok(monthly < 30, `全部應為月平均（實際 ${monthly} 點）`);
});

test("圖例名稱確實被截斷（8 字標籤要出現省略號）", async () => {
  const { root, flush } = await trends(await shapePayload());
  btn(root, "全部").dispatch("click");
  await flush();
  const weight = svgs(root).find((s) => inSvg(s, "circle").some((c) => num(c, "r") === 6));
  const names = legend(weight).map((t) => t.textContent);
  const long = names.find((n) => n.startsWith("體重"));
  assert.ok(long, `找不到體重序列圖例，實際 ${JSON.stringify(names)}`);
  assert.ok(long.endsWith("…"), `原標籤「體重（自主量測）」8 字應被截斷，實際「${long}」`);
  for (const n of names) assert.ok(n.length <= 7, `圖例「${n}」應 ≤ 7 字`);
});

test("刻度相鄰間距足夠（不重疊）", async () => {
  const { root, flush } = await trends(await shapePayload());
  for (const r of ["全部", "近一年", "近三月"]) {
    btn(root, r).dispatch("click");
    await flush();
    const s = svgs(root).find((x) => xTicks(x).length);
    const xs = inSvg(s, "text").filter((t) => num(t, "y") === X_TICK_Y)
      .map((t) => num(t, "x")).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      assert.ok(xs[i] - xs[i - 1] >= 40,
        `${r} 相鄰刻度間距 ${(xs[i] - xs[i - 1]).toFixed(0)}px 應 ≥ 40px`);
    }
  }
});

test("切區間後 y 軸重算", async () => {
  const { root, flush } = await trends(await shapePayload());
  const yLabels = () => {
    // 抓體重圖：本測試只驗「上下界隨區間重算」，不牽動檢驗圖的參考值形態
    // （fixture 的 `[0.7-1.3]` 屬未知括號形，parseRef 保守不畫，見 design D5）
    const s = svgs(root).find((x) => legend(x).some((t) => t.textContent.startsWith("體重")));
    assert.ok(s, "找不到體重圖");
    return inSvg(s, "text").filter((t) => num(t, "x") < PL).map((t) => t.textContent).join("|");
  };
  btn(root, "全部").dispatch("click");
  await flush();
  const all = yLabels();
  btn(root, "近三月").dispatch("click");
  await flush();
  assert.notEqual(yLabels(), all, "縱軸上下界應依區間內資料重算");
});

test("月粒度序列不畫到繪圖區外（區間下界不在月初時）", async () => {
  const { root, flush } = await trends(await shapePayload());
  for (const r of ["近一年", "全部"]) {
    btn(root, r).dispatch("click");
    await flush();
    const s = svgs(root).find((x) => inSvg(x, "text")
      .some((t) => t.textContent.includes("日均步數")));
    const poly = inSvg(s, "polyline")[0];
    const xs = (poly.getAttribute("points") || "").split(" ").filter(Boolean)
      .map((pt) => Number(pt.split(",")[0]));
    assert.ok(Math.min(...xs) >= PL - 0.5,
      `${r} 月桶最左 x=${Math.min(...xs).toFixed(1)} 不得小於繪圖區左緣 ${PL}`);
  }
});

test("總覽體重卡維持標記與逐點提示（該卡無區間可切，不得歸零）", async () => {
  const { root, flush } = render(await shapePayload());
  await flush();   // 停在總覽頁
  const card = svgs(root).find((s) => inSvg(s, "circle").length > 0);
  assert.ok(card, "總覽體重卡應有標記");
  const c = inSvg(card, "circle");
  assert.ok(c.length > 200, `總覽卡點數應為 slice(-365) 量級，實際 ${c.length}`);
  assert.ok(c.every((x) => num(x, "r") > 0), "總覽卡標記半徑不得為 0");
  assert.ok(findAll(card, (e) => e.localName === "title").length > 200,
    "總覽卡應保留逐點數值提示");
});

test("極大跨度仍有 x 軸刻度（不得靜默變成零刻度）", async () => {
  const { root, flush } = await labsPage(await shapePayload({ ancientDate: true }));
  btn(root, "全部").dispatch("click");
  await flush();
  const ticks = svgs(root).map(xTicks).find((t) => t.length !== undefined && t.length >= 0);
  const any = svgs(root).map(xTicks).filter((t) => t.length);
  assert.ok(any.length > 0 && any[0].length >= 2,
    `跨度 40 年以上仍須有刻度，實際 ${JSON.stringify(ticks)}`);
});

test("總覽血壓卡顯示量測日期（避免陳舊數值看似當前）", async () => {
  const { root, flush } = render(await shapePayload());
  await flush();
  assert.match(root.textContent, /mmHg｜\d{4}-\d{2}-\d{2}/,
    "血壓卡應在單位旁顯示最近量測日期");
});

/* ---- 身體數值參考線（display-revamp-bands-cleanup T5）：標準值來自
   knowledge 條目，條目移除時參考線消失（不留寫死預設） ---- */
const BODY_REFS = JSON.parse(readFileSync(
  new URL("../../src/knowledge/body_refs.json", import.meta.url), "utf-8"));

test("血壓參考線來自 knowledge 條目：兩條虛線＋來源與引用日期", async () => {
  const p = await shapePayload();
  p.body_refs = BODY_REFS;
  const { root, flush } = await trends(p);
  btn(root, "全部").dispatch("click");
  await flush();
  const bp = svgs(root).find((s) => inSvg(s, "circle").length === 64);
  assert.ok(bp, "找不到血壓圖");
  const reflines = inSvg(bp, "line")
    .filter((l) => String(l.getAttribute("class") || "") === "refline");
  assert.equal(reflines.length, 2, "血壓圖應有收縮 130 與舒張 80 兩條參考線");
  const text = root.textContent;
  assert.ok(text.includes("參考 130") && text.includes("參考 80"), "缺參考線標籤");
  assert.match(text, /引用日期 \d{4}-\d{2}-\d{2}/, "缺來源引用日期");
  assert.ok(!/超標|正常/.test(text.replace(/屬於正常|數值正常/g, "")),
    "參考線呈現不得帶判定字樣");
});

test("knowledge 條目移除時參考線消失（不留寫死預設）", async () => {
  const p = await shapePayload();
  p.body_refs = [];
  const { root, flush } = await trends(p);
  btn(root, "全部").dispatch("click");
  await flush();
  const reflines = findAll(root, (e) => e.localName === "line"
    && String(e.getAttribute("class") || "") === "refline");
  assert.equal(reflines.length, 0, "條目移除後不得出現任何參考線");
  assert.ok(!root.textContent.includes("參考 130"), "標籤也不得殘留");
});
