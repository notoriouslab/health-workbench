// 診間視角區塊（change clinic-visit-view，T3／T4；design D3／D4／D5）。
//
// 純函式部分沿 parse_ref.test.mjs 的來源切片手法取用（app.js 的 IIFE 內不
// 對外 export）；真渲染部分在同檔後段，沿 med_print.test.mjs 的 vm sandbox
// 手法。兩者都要：規則對了但區塊沒渲染、或渲染時把篩選狀態灌進去，純函式
// 測不到。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { buildPayload } from "../../src/provider/payload.js";
import { makeDocument, findAll } from "../helpers/mini_dom.mjs";

const ASSETS = new URL("../../src/viewer/assets/", import.meta.url);

/* ---------- 純函式取用：三段來源切片拼接 ----------
   診間視角的函式依賴 tsOf／DAY（時間軸工具段）與 parseRef（參考值解析段），
   三段一起切進來求值。任一錨點失效時下方斷言先失敗，不會靜默測到空函式。 */
const SRC = readFileSync(new URL("app.js", ASSETS), "utf-8");
function slice(fromMark, toMark) {
  const a = SRC.indexOf(fromMark), b = SRC.indexOf(toMark);
  assert.ok(a > 0 && b > a,
    `app.js 切片錨點失效：${fromMark} → ${toMark}（a=${a} b=${b}）`);
  return SRC.slice(a, b);
}
const PURE_SRC = [
  slice("const DAY = 864e5", "  /* 剔除日期無法解析的點"),
  slice("const REF_PAIR", "  /* 趨勢序列集合"),
  slice("/* ---------- 診間視角的純函式", "  function Timeline("),
].join("\n");
for (const anchor of ["function tsOf", "function parseRef", "function windowStat",
  "function refStreakItems", "function stalestItems", "function dataFreshness"]) {
  assert.ok(PURE_SRC.includes(anchor), `切片缺 ${anchor}`);
}
const F = new Function(`${PURE_SRC};
  return { windowStat, refPosition, refStreakItems, stalestItems, dataFreshness,
           parseRef };`)();
for (const [k, v] of Object.entries(F)) {
  assert.equal(typeof v, "function", `切片求值後未取得 ${k}`);
}

const TODAY = Date.parse("2026-08-21T00:00:00Z");
const daysAgo = (n) => new Date(TODAY - n * 864e5).toISOString().slice(0, 10);

/* lab 列形狀取自真實查詢（provider/payload.js 的 labs SELECT）：
   數值可合成、形狀不編。 */
const lab = (name, n, value, ref) => ({
  id: 1, name, test_name_raw: name, unmapped: 0, test_date: daysAgo(n),
  value_text: String(value), value_numeric: value, ref_range: ref,
  facility_name: "測試院所", order_name: name, quality_flags: null,
});

// 年齡分段複合形參考值：逐字照抄 parse_ref.test.mjs 既有的不解析向量
// （本機生產庫實查形狀），不自己編形狀。
const AGE_BANDED = "[[0-14d]144-450 [15-30d]248-586 [31d-0.5y]229-597 [0.5y-6y]189-459 [6y-18y]175-369 [≧18y]M 148-339 F 150-361, (2019/7/1起 ≧18years 變更為 150-378)][[0-14d]144-450 [15-30d]248-586 [31d-0.5y]229-597 [0.5y-6y]189-459 [6y-18y]175-369 [≧18y]M 148-339 F 150-361, (2019/7/1起 ≧18years 變更為 150-378)]";

test("前提：年齡分段複合形參考值確實解析不出（本檔多則測試的前提）", () => {
  assert.equal(F.parseRef(AGE_BANDED), null,
    "AGE_BANDED 若被解析出來，下面「保守不報」的測試就測不到本意");
  assert.deepEqual(F.parseRef("[4.0-6.0]"), { band: [4, 6] });
});

/* ---------- 規則 A：連續三次超出參考值 ---------- */

test("規則 A：最近連續三次超出參考值上限即命中", () => {
  const labs = [
    lab("糖化血色素", 200, 5.4, "[4.0-6.0]"),   // 較早那次在範圍內，不參與判定
    lab("糖化血色素", 120, 6.9, "[4.0-6.0]"),
    lab("糖化血色素", 60, 7.2, "[4.0-6.0]"),
    lab("糖化血色素", 10, 7.5, "[4.0-6.0]"),
  ];
  const hit = F.refStreakItems(labs);
  assert.equal(hit.length, 1, `應命中一項：${JSON.stringify(hit)}`);
  assert.equal(hit[0].name, "糖化血色素");
  assert.deepEqual(hit[0].rows.map((r) => r.side), ["high", "high", "high"]);
  assert.deepEqual(hit[0].rows.map((r) => r.value), [6.9, 7.2, 7.5]);
});

test("規則 A：三次中僅兩次超出即不命中", () => {
  const labs = [
    lab("糖化血色素", 60, 7.2, "[4.0-6.0]"),
    lab("糖化血色素", 30, 5.8, "[4.0-6.0]"),   // 中間這次在範圍內
    lab("糖化血色素", 10, 7.5, "[4.0-6.0]"),
  ];
  assert.deepEqual(F.refStreakItems(labs), []);
});

test("規則 A：只驗過兩次的項目不命中（不足三次）", () => {
  const labs = [
    lab("糖化血色素", 30, 7.2, "[4.0-6.0]"),
    lab("糖化血色素", 10, 7.5, "[4.0-6.0]"),
  ];
  assert.deepEqual(F.refStreakItems(labs), []);
});

test("規則 A：參考值無法解析時保守不報，即使數值明顯偏離", () => {
  const labs = [60, 30, 10].map((n) => lab("血小板", n, 999, AGE_BANDED));
  assert.deepEqual(F.refStreakItems(labs), [],
    "年齡分段複合形參考值不得納入判定");
  // 正向對照：同樣數值換成可解析的參考值就命中，證明不是整條路都不通
  const ok = [60, 30, 10].map((n) => lab("血小板", n, 999, "[150-400]"));
  assert.equal(F.refStreakItems(ok).length, 1);
});

test("規則 A：低於下限同樣算超出（一側性參考值）", () => {
  const labs = [60, 30, 10].map((n) => lab("血紅素", n, 9.5, "[12-]"));
  const hit = F.refStreakItems(labs);
  assert.equal(hit.length, 1, `一側性下限應命中：${JSON.stringify(hit)}`);
  assert.deepEqual(hit[0].rows.map((r) => r.side), ["low", "low", "low"]);
});

test("規則 A：無數值列（定性結果）不參與判定", () => {
  const labs = [
    lab("糖化血色素", 60, 7.2, "[4.0-6.0]"),
    { ...lab("糖化血色素", 30, 0, "[4.0-6.0]"), value_numeric: null, value_text: "陰性" },
    lab("糖化血色素", 10, 7.5, "[4.0-6.0]"),
  ];
  // 有數值的只有兩次 → 不足三次。釘住「不得把定性那筆當 0 判成超出下限」
  assert.deepEqual(F.refStreakItems(labs), []);
});

/* ---------- 規則 B：距上次檢驗最久 ---------- */

test("規則 B：相對排序取前三，不用任何絕對天數門檻", () => {
  // 刻意讓所有項目最近一次都在三個月內：任何絕對門檻的實作都會回空陣列
  const labs = [];
  for (const [name, n] of [["甲項", 80], ["乙項", 60], ["丙項", 40],
    ["丁項", 20], ["戊項", 5]]) {
    labs.push(lab(name, n + 300, 1, "[0-10]"));   // 每項都有更早的第二次
    labs.push(lab(name, n, 1, "[0-10]"));
  }
  const stale = F.stalestItems(labs);
  assert.deepEqual(stale.map((s) => s.name), ["甲項", "乙項", "丙項"],
    `應取距上次最久的前三項：${JSON.stringify(stale)}`);
  assert.equal(stale[0].last, daysAgo(80));
});

test("規則 B：只驗過一次的項目不納入", () => {
  const labs = [
    lab("只驗一次", 500, 1, "[0-10]"),           // 最久，但只有一次
    lab("驗兩次甲", 400, 1, "[0-10]"), lab("驗兩次甲", 100, 1, "[0-10]"),
    lab("驗兩次乙", 300, 1, "[0-10]"), lab("驗兩次乙", 50, 1, "[0-10]"),
  ];
  const names = F.stalestItems(labs).map((s) => s.name);
  assert.ok(!names.includes("只驗一次"), `只驗過一次不該納入：${names}`);
  assert.deepEqual(names, ["驗兩次甲", "驗兩次乙"]);
});

test("規則 B：取該項目最近一次的日期，不是第一次", () => {
  const labs = [
    lab("甲項", 900, 1, "[0-10]"), lab("甲項", 30, 1, "[0-10]"),
    lab("乙項", 200, 1, "[0-10]"), lab("乙項", 100, 1, "[0-10]"),
  ];
  // 甲項最早那筆更久，但最近一次比乙項新 → 乙項排前面
  assert.deepEqual(F.stalestItems(labs).map((s) => s.name), ["乙項", "甲項"]);
});

/* ---------- 窗格聚合 ---------- */

test("窗格聚合：回中位數與有量測的天數（不是次數）", () => {
  const series = [
    [daysAgo(40), 100],                                   // 兩窗格都不含
    [daysAgo(20), 70], [daysAgo(15), 72], [daysAgo(9), 74],
    [daysAgo(5), 60], [daysAgo(3), 64], [daysAgo(1), 62],
  ];
  assert.deepEqual(F.windowStat(series, 7, TODAY), { median: 62, days: 3 });
  assert.deepEqual(F.windowStat(series, 30, TODAY), { median: 67, days: 6 });
  assert.equal(F.windowStat([], 7, TODAY), null);
  assert.equal(F.windowStat(null, 7, TODAY), null);
});

test("窗格聚合：中位數抗離群（不是平均）", () => {
  const series = [[daysAgo(3), 60], [daysAgo(2), 62], [daysAgo(1), 300]];
  assert.equal(F.windowStat(series, 7, TODAY).median, 62,
    "取平均會被 300 拉走（平均 140.7），此斷言釘住中位數");
});

/* ---------- 資料截止日 ---------- */

test("資料截止日：距今三個月內不提示，超過才提示", () => {
  assert.deepEqual(F.dataFreshness(daysAgo(30), TODAY),
    { date: daysAgo(30), stale: false });
  assert.deepEqual(F.dataFreshness(daysAgo(100), TODAY),
    { date: daysAgo(100), stale: true });
  assert.deepEqual(F.dataFreshness(null, TODAY), { date: null, stale: false });
  assert.deepEqual(F.dataFreshness("不是日期", TODAY), { date: null, stale: false });
});

/* ================= 真渲染（vm sandbox，沿 med_print.test.mjs 手法） =================
   斷言使用者實際看到什麼：區塊在篩選器之上、篩選不影響它、空小節整段不輸出、
   四節全空整區不渲染、資料截止日與過期提示。日期一律相對於**真實今天**生成，
   因為區塊內部取 Date.now()（匯出的單檔 HTML 隔幾天打開時要算那天的事實）。 */
const REPO = new URL("../../..", import.meta.url).pathname;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));
const isoAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function basePayload() {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-clinic-"));
  const d = new NodeDriver(path.join(tmp, "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
      name: "nhi_sample.json" },
    d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  const p = await buildPayload(d, { profileId: pid,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: null, today: isoAgo(0) });
  await d.close();
  return p;
}

function renderViewer(payload) {
  const doc = makeDocument();
  const dataEl = doc.createElement("script");
  dataEl.textContent = JSON.stringify(payload);
  doc.registerId("hwb-data", dataEl);
  const root = doc.createElement("div");
  doc.registerId("app", root);
  const sandbox = {
    document: doc, console,
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    print: () => {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["vendor/preact.min.js", "vendor/hooks.umd.js",
    "vendor/htm.umd.js", "app.js"]) {
    vm.runInContext(readFileSync(new URL(f, ASSETS), "utf-8"), sandbox, { filename: f });
  }
  return { root, flush: () => new Promise((r) => setTimeout(r, 5)) };
}

const buttonByText = (root, label) => findAll(root,
  (el) => el.localName === "button" && el.textContent === label
    && (el.listeners.click || []).length)[0];
const blockOf = (root) => findAll(root, (el) => String(
  el.getAttribute?.("class") || "").includes("clinic-view"))[0];

async function openTimeline(payload) {
  const ctx = renderViewer(payload);
  await ctx.flush();
  const tab = buttonByText(ctx.root, "就醫");
  assert.ok(tab, "找不到就醫分頁按鈕");
  tab.dispatch("click");
  await ctx.flush();
  assert.ok(!ctx.root.textContent.includes("分頁載入失敗"),
    `就醫分頁落入錯誤邊界：${ctx.root.textContent.slice(0, 400)}`);
  return ctx;
}

/* 現用藥一款（給藥期間內）＋停用藥一款；血壓與體重各有近 7／30 天的量測。 */
function withClinicData(base, { measures = true, dateMax = isoAgo(20),
  labs = null } = {}) {
  const p = JSON.parse(JSON.stringify(base));
  p.meta.date_max = dateMax;
  if (labs) p.labs = labs;
  p.medications = [
    { id: 1, encounter_id: 1, order_code: "AC001", order_name: "原始醫囑甲",
      drug_zh: "現用藥甲錠", ingredient: "成分甲", total_qty: 30, days_supply: 30,
      tooth_name: null, section_hint: "r5", date: isoAgo(5),
      facility_name: "測試院所", leaflet_url: null },
    { id: 2, encounter_id: 2, order_code: "AC002", order_name: "原始醫囑乙",
      drug_zh: "停用藥乙錠", ingredient: "成分乙", total_qty: 3, days_supply: 3,
      tooth_name: null, section_hint: "r5", date: isoAgo(400),
      facility_name: "測試院所", leaflet_url: null },
  ];
  p.meds_by_enc = {};
  if (measures) {
    p.measures = {
      ...p.measures,
      "收縮壓": [[isoAgo(20), 130], [isoAgo(5), 128], [isoAgo(3), 126]],
      "舒張壓": [[isoAgo(20), 85], [isoAgo(5), 82], [isoAgo(3), 80]],
      "體重": [[isoAgo(25), 71.2], [isoAgo(2), 70.4]],
    };
  } else {
    p.measures = {};
    p.sleep_daily = [];
    p.cpap = { daily: [] };
  }
  return p;
}

test("渲染：區塊出現在篩選器之上，只渲染有資料的小節", async () => {
  const { root } = await openTimeline(withClinicData(await basePayload()));
  const block = blockOf(root);
  assert.ok(block, "缺診間視角區塊（.clinic-view）");
  const text = block.textContent;
  assert.ok(text.includes("現用藥甲錠"), `現用藥未列出：${text.slice(0, 300)}`);
  assert.ok(!text.includes("停用藥乙錠"), "已過給藥期間的藥不該列在現在在吃");
  assert.ok(text.includes("血壓（收縮）"), "缺居家量測小節");
  assert.ok(text.includes("補上居家量測會更有用"), "缺底部導引");
  assert.ok(text.includes("自費藥與保健食品這裡不會有"), "缺用藥小節附註");
  // 這份 fixture 的 labs 只有一筆，第四小節（與其免責語）不該出現
  assert.ok(!text.includes("資料裡的這些變化"), "無規則命中時第四小節應整段不輸出");
  assert.ok(!text.includes("本清單僅為就醫溝通輔助"),
    "第四小節不存在時不該留下它的免責語");
  // 位置：區塊必須排在 .filters 之前
  const kids = findAll(root, (el) => {
    const c = String(el.getAttribute?.("class") || "");
    return c.includes("clinic-view") || c === "filters";
  });
  assert.ok(String(kids[0].getAttribute("class")).includes("clinic-view"),
    "區塊必須在篩選器之上");
});

test("渲染：可信度指標的措辭是天數而非次數", async () => {
  const { root } = await openTimeline(withClinicData(await basePayload()));
  const text = blockOf(root).textContent;
  assert.ok(text.includes("天有量測"), `缺天數措辭：${text.slice(0, 400)}`);
  assert.ok(!text.includes("次有量測"), "可信度指標不得寫成次數");
  assert.ok(!text.includes("筆有量測"), "可信度指標不得寫成筆數");
});

test("渲染：篩選類型不影響區塊內容", async () => {
  const { root, flush } = await openTimeline(withClinicData(await basePayload()));
  const before = blockOf(root).textContent;
  const select = findAll(root, (el) => el.localName === "select")[0];
  assert.ok(select, "找不到類型篩選器");
  select.value = "dental";
  select.dispatch("change", { target: { value: "dental" } });
  await flush();
  assert.equal(blockOf(root).textContent, before,
    "篩選改變後區塊內容不得變動（篩選狀態不該傳進區塊）");
});

test("渲染：無 Apple 與 CPAP 資料時，居家量測小節整段不出現", async () => {
  const { root } = await openTimeline(
    withClinicData(await basePayload(), { measures: false }));
  const block = blockOf(root);
  assert.ok(block, "其他小節有資料，區塊仍應渲染");
  const text = block.textContent;
  // 用 h3 判定而非整段文字：底部導引「補上居家量測會更有用」也含這四個字
  assert.ok(!findAll(block, (el) => el.localName === "h3"
    && el.textContent === "居家量測").length, "居家量測小節應整段不輸出");
  assert.ok(!text.includes("天有量測"), "不該留下空的窗格欄");
  assert.ok(text.includes("現用藥甲錠"), "用藥小節仍應存在");
});

test("渲染：四小節全空時整個區塊不渲染", async () => {
  const base = await basePayload();
  const p = withClinicData(base, { measures: false });
  p.medications = [];
  p.labs = [];
  const { root } = await openTimeline(p);
  assert.ok(!blockOf(root), "四節全空時不該渲染區塊");
  // 下方歷史清單不受影響（區塊不渲染不等於分頁壞了）
  assert.ok(findAll(root, (el) => el.localName === "select").length >= 1,
    "篩選器仍應存在");
});

test("渲染：資料截止日與過期提示", async () => {
  const fresh = await openTimeline(
    withClinicData(await basePayload(), { dateMax: isoAgo(30) }));
  const freshText = blockOf(fresh.root).textContent;
  assert.ok(freshText.includes(`資料截止 ${isoAgo(30)}`), `缺截止日：${freshText}`);
  assert.ok(!freshText.includes("有一段時間沒更新"), "三十天內不該出現過期提示");

  const stale = await openTimeline(
    withClinicData(await basePayload(), { dateMax: isoAgo(100) }));
  const staleText = blockOf(stale.root).textContent;
  assert.ok(staleText.includes(`資料截止 ${isoAgo(100)}`), "缺截止日");
  assert.ok(staleText.includes("有一段時間沒更新"), "一百天應出現過期提示");
});

test("渲染：第四小節列出規則命中，措辭無建議動詞且附免責語一份", async () => {
  // 規則 A 的渲染層先前只有純函式覆蓋：規則算對了但小節沒渲染出來，
  // 或免責語（走 htm 的布林簡寫 prop）靜默消失，純函式測不到。
  const clinicLabs = [];
  for (const n of [120, 60, 10]) {
    clinicLabs.push({ id: 1, name: "糖化血色素", test_name_raw: "HbA1c",
      unmapped: 0, test_date: new Date(Date.now() - n * 864e5).toISOString().slice(0, 10),
      value_text: "7.5", value_numeric: 7.5, ref_range: "[4.0-6.0]",
      facility_name: "測試院所", order_name: "HbA1c", quality_flags: null });
  }
  const { root } = await openTimeline(
    withClinicData(await basePayload(), { labs: clinicLabs }));
  const text = blockOf(root).textContent;
  assert.ok(text.includes("資料裡的這些變化，供就醫溝通參考"), `缺第四小節：${text}`);
  assert.ok(text.includes("糖化血色素：最近三次高於參考上限"),
    `規則 A 未列出或措辭不符：${text}`);
  assert.equal(text.split("本清單僅為就醫溝通輔助，不含醫療判斷").length - 1, 1,
    "第四小節的免責語應恰好一份");
  // 純事實陳述：MUST NOT 含建議動詞（spec 明文）
  for (const verb of ["應該", "建議", "需要", "請"]) {
    assert.ok(!text.includes(verb), `第四小節出現建議動詞「${verb}」：${text}`);
  }
});

/* 2026-08-21 走查定案的三項呈現決策（spec「診間視角區塊」）：
   區塊無自己的大標題、檢驗小節預設收合、用藥小節標題不宣稱服藥事實。
   這三項都是「少了不會報錯、只會靜默退回舊樣子」的類型，所以要釘住。 */
const labRow = (name, value) => ({ id: 1, name, test_name_raw: name, unmapped: 0,
  test_date: isoAgo(3), value_text: String(value), value_numeric: value,
  ref_range: "[0-10]", facility_name: "測試院所", order_name: name,
  quality_flags: null });

test("渲染：區塊無大標、用藥小節標為近日用藥、摘要卡鈕在標頭行", async () => {
  const { root } = await openTimeline(withClinicData(await basePayload()));
  const block = blockOf(root);
  const text = block.textContent;

  assert.ok(!text.includes("帶去診間：常被問到的幾件事"),
    "區塊不該有自己的大標題（資料截止日那行就是標頭）");
  assert.ok(text.includes("近日用藥"), `用藥小節應標為「近日用藥」：${text}`);
  assert.ok(!text.includes("現在在吃什麼藥"),
    "標題不得宣稱服藥事實（判定依據只是給藥日數推算）");

  const summary = findAll(block, (el) => el.localName === "summary")[0];
  assert.ok(summary, "檢驗小節應是可折疊區（缺 summary）");
  assert.ok(summary.textContent.includes("最近一次抽血"), "缺小節標題");
  assert.match(summary.textContent, /\d+ 項/,
    `摘要行應標示項目數：${summary.textContent}`);

  // 列印鈕在區塊標頭那一行（.clinic-head），不在下方的就醫篩選列
  const head = findAll(block, (el) => String(
    el.getAttribute?.("class") || "").includes("clinic-head"))[0];
  assert.ok(head, "缺區塊標頭列 .clinic-head");
  assert.ok(head.textContent.includes("資料截止"), "標頭列應含資料截止日");
  const btn = findAll(head, (el) => el.localName === "button"
    && el.textContent === "列印看診摘要卡")[0];
  assert.ok(btn, "列印鈕應在標頭列的右端");
});

test("渲染：檢驗小節項目少時展開，超過門檻才預設收合", async () => {
  // 一次抽血常常只有兩三項，一律收合等於多要一次點擊（2026-08-21 走查）
  const few = ["甲項", "乙項", "丙項"].map((n, i) => labRow(n, i + 1));
  const fewCtx = await openTimeline(
    withClinicData(await basePayload(), { labs: few }));
  const fewDetails = findAll(blockOf(fewCtx.root), (el) => el.localName === "details")[0];
  assert.ok(fewDetails, "缺可折疊區");
  assert.ok(fewDetails.getAttribute("open") != null,
    "三項時應預設展開（多一次點擊沒有換到任何東西）");

  const many = ["甲", "乙", "丙", "丁", "戊", "己", "庚"]
    .map((n, i) => labRow(`${n}項`, i + 1));
  const manyCtx = await openTimeline(
    withClinicData(await basePayload(), { labs: many }));
  const manyBlock = blockOf(manyCtx.root);
  const manyDetails = findAll(manyBlock, (el) => el.localName === "details")[0];
  assert.equal(manyDetails.getAttribute("open"), null,
    "七項時應預設收合（否則區塊被一張長表佔滿）");
  // 收合時摘要行仍要說清楚裡面有多少項
  const summary = findAll(manyDetails, (el) => el.localName === "summary")[0];
  assert.ok(summary.textContent.includes("7 項"),
    `摘要行應標示項目數：${summary.textContent}`);
});
