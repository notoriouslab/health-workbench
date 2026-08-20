// 檢驗參考值解析與呈現（change drug-info-and-lab-refband，T5／design D5）。
// 向量來源：`SELECT DISTINCT ref_range FROM lab_results`（本機生產庫，
// 2026-08-19 實查，共 45 個格式，形狀逐字照抄、不改寫）＋ TG 樣式
// （`<150`、`150 以下`）與合成邊界向量。形狀取自真實產出、數值可合成，
// 不自己編形狀（feedback_test_vector_real_shape）。
//
// parseRef 定義在 app.js 的 IIFE 內、不對外 export：取其來源切片在本 realm
// 求值取用；切片錨點若失效，下方 anchor 斷言先失敗，不會靜默測到空函式。
// 另有真渲染測試（沿 trend_axis／med_print 的 vm sandbox 手法）斷言使用者
// 看到什麼：灰帶／參考線／說明文字三形態。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { buildPayload } from "../../src/provider/payload.js";
import { makeDocument, findAll } from "../helpers/mini_dom.mjs";

const ASSETS = new URL("../../src/viewer/assets/", import.meta.url);
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));
const TODAY = "2026-08-19";
const CH = { H: 240, PB: 28, PT: 10 };          // 與 app.js 的 CH 同值（繪圖區上下界）

/* ---------- parseRef 取用：來源切片 ---------- */
const SRC = readFileSync(new URL("app.js", ASSETS), "utf-8");
const SLICE_FROM = "const REF_PAIR", SLICE_TO = "/* 趨勢序列集合";
const from = SRC.indexOf(SLICE_FROM), to = SRC.indexOf(SLICE_TO);
assert.ok(from > 0 && to > from,
  `app.js 的 parseRef 區段錨點失效（from=${from} to=${to}），請更新切片錨點`);
const PARSE_SRC = SRC.slice(from, to);
for (const anchor of ["function refSide", "function parseRef", "REF_NUM", "kind"]) {
  assert.ok(PARSE_SRC.includes(anchor), `切片缺 ${anchor}，取到的不是完整 parseRef`);
}
// 在本 realm 內求值（非 vm 沙箱）：跨 realm 的回傳物件原型不同，
// deepStrictEqual 會對「內容相同」的物件失敗
const parseRef = new Function(`${PARSE_SRC};return parseRef;`)();
assert.equal(typeof parseRef, "function", "切片求值後未取得 parseRef 函式");

/* ---------- 向量表 ---------- */
// 本機生產庫 45 個 DISTINCT ref_range 格式全清單（照抄）。
// 期望值形態：null（不畫）／{band:[lo,hi]}（灰帶）／{limit,kind}（單條參考線）。
const REAL = [
  ["[.][.]", null],
  ["[0.20][1.20]", { band: [0.2, 1.2] }],
  ["[0.2][1.8]", { band: [0.2, 1.8] }],
  ["[0.2][8.4]", { band: [0.2, 8.4] }],
  ["[0.6~1.3][0.6~1.3]", { band: [0.6, 1.3] }],
  ["[0.70][1.20]", { band: [0.7, 1.2] }],
  ["[0~41][0~41]", { band: [0, 41] }],
  ["[10][39]", { band: [10, 39] }],
  ["[11.9][14.5]", { band: [11.9, 14.5] }],
  ["[11][82]", { band: [11, 82] }],
  ["[13.2][17.2]", { band: [13.2, 17.2] }],
  ["[148][339]", { band: [148, 339] }],
  ["[21.2][51.0]", { band: [21.2, 51] }],
  ["[26.0][34.0]", { band: [26, 34] }],
  ["[3.1][8.0]", { band: [3.1, 8] }],
  ["[3.54][9.06]", { band: [3.54, 9.06] }],
  ["[31-37, (2019/7/1起 ≧18years 變更為31.0-34.9)][31-37, (2019/7/1起 ≧18years 變更為31.0-34.9)]", { band: [31, 37] }],
  ["[31.0][37.0]", { band: [31, 37] }],
  ["[38.0][47.5]", { band: [38, 47.5] }],
  ["[4.00][5.52]", { band: [4, 5.52] }],
  ["[40.4][51.1]", { band: [40.4, 51.1] }],
  ["[41.2][74.7]", { band: [41.2, 74.7] }],
  ["[5.0][24.0]", { band: [5, 24] }],
  ["[7][42]", { band: [7, 42] }],
  ["[7~25][7~25]", { band: [7, 25] }],
  ["[80.0][100.0]", { band: [80, 100] }],
  ["[8~31][8~31]", { band: [8, 31] }],
  // 以下 13 筆為年齡分段複合字串（規則 2：含 `[` 但非恰雙欄形 → 一律不畫）
  ["[[0-14d]0.1-0.8 [15-30d]0-0.6 [31d-0.5y]0-0.6 [0.5y-6y]0-0.6 [6y-18y]0-0.7 [≧18y]M 0.2-1.8 F 0.2-2.0, (2019/7/1起 ≧18years 變更為 0.2-1.6)][[0-14d]0.1-0.8 [15-30d]0-0.6 [31d-0.5y]0-0.6 [0.5y-6y]0-0.6 [6y-18y]0-0.7 [≧18y]M 0.2-1.8 F 0.2-2.0, (2019/7/1起 ≧18years 變更為 0.2-1.6)]", null],
  ["[[0-14d]0.3-5.2 [15-30d]0-5.4 [31d-0.5y]0-4.5 [0.5y-6y]0-4.1 [6y-18y]0-4.7 [≧18y]M 0.2-8.4 F 0.2-7.3, (2019/7/1起 ≧18years 變更為 0.3-7.9)][[0-14d]0.3-5.2 [15-30d]0-5.4 [31d-0.5y]0-4.5 [0.5y-6y]0-4.1 [6y-18y]0-4.7 [≧18y]M 0.2-8.4 F 0.2-7.3, (2019/7/1起 ≧18years 變更為 0.3-7.9)]", null],
  ["[[0-14d]12.0-20.0 [15-30d]10.0-15.3 [31d-0.5y]8.9-12.7 [0.5y-6y]10.1-12.7 [6y-18y]10.6-14.5 [≧18y]M 13.2-17.2 F 10.8-14.9, (2019/7/1起 ≧18years 變更為M 13.1-17.2  F 11.0-15.2)][[0-14d]12.0-20.0 [15-30d]10.0-15.3 [31d-0.5y]8.9-12.7 [0.5y-6y]10.1-12.7 [6y-18y]10.6-14.5 [≧18y]M 13.2-17.2 F 10.8-14.9, (2019/7/1起 ≧18years 變更為M 13.1-17.2  F 11.0-15.2)]", null],
  ["[[0-14d]14.6-17.3 [15-30d]14.3-16.8 [31d-0.5y]12.2-16.1 [0.5y-6y]12.4-15.6 [6y-18y]12.2-14.6 [≧18y] M 11.9-14.5 F 11.9-14.5, (2019/7/1起 ≧18years 變更為 11.6-15.0)][[0-14d]14.6-17.3 [15-30d]14.3-16.8 [31d-0.5y]12.2-16.1 [0.5y-6y]12.4-15.6 [6y-18y]12.2-14.6 [≧18y] M 11.9-14.5 F 11.9-14.5, (2019/7/1起 ≧18years 變更為 11.6-15.0)]", null],
  ["[[0-14d]144-450 [15-30d]248-586 [31d-0.5y]229-597 [0.5y-6y]189-459 [6y-18y]175-369 [≧18y]M 148-339 F 150-361, (2019/7/1起 ≧18years 變更為 150-378)][[0-14d]144-450 [15-30d]248-586 [31d-0.5y]229-597 [0.5y-6y]189-459 [6y-18y]175-369 [≧18y]M 148-339 F 150-361, (2019/7/1起 ≧18years 變更為 150-378)]", null],
  ["[[0-14d]15.2-66.1 [15-30d]10.6-57.3 [31d-0.5y]8.9-76.0 [0.5y-6y]16.9-74.0 [6y-18y]28.6-74.7 [≧18y]M 41.2-74.7 F 38.3-71.1, (2019/7/1起 ≧18years 變更為 41.6-74.4)][[0-14d]15.2-66.1 [15-30d]10.6-57.3 [31d-0.5y]8.9-76.0 [0.5y-6y]16.9-74.0 [6y-18y]28.6-74.7 [≧18y]M 41.2-74.7 F 38.3-71.1, (2019/7/1起 ≧18years 變更為 41.6-74.4)]", null],
  ["[[0-14d]24.9-68.5 [15-30d]31.9-82.7 [31d-0.5y]30.4-86.7 [0.5y-6y]18.1-79.9 [6y-18y]15.5-57.8 [≧18y]M 21.5-51.0 F 21.3-50.2, (2019/7/1起 ≧18years 變更為 18.0-48.8)][[0-14d]24.9-68.5 [15-30d]31.9-82.7 [31d-0.5y]30.4-86.7 [0.5y-6y]18.1-79.9 [6y-18y]15.5-57.8 [≧18y]M 21.5-51.0 F 21.3-50.2, (2019/7/1起 ≧18years 變更為 18.0-48.8)]", null],
  ["[[0-14d]31.1-35.9 [15-30d]29.9-35.3 [31d-0.5y]24.4-32.5 [0.5y-6y]22.7-28.6 [6y-18y]24.8-30.2 [≧18y]M 26-34 F 26-34, (2019/7/1起 ≧18years 變更為25.5-33.2)][[0-14d]31.1-35.9 [15-30d]29.9-35.3 [31d-0.5y]24.4-32.5 [0.5y-6y]22.7-28.6 [6y-18y]24.8-30.2 [≧18y]M 26-34 F 26-34, (2019/7/1起 ≧18years 變更為25.5-33.2)]", null],
  ["[[0-14d]36.0-60.0 [15-30d]30.5-45.0 [31d-0.5y]26.8-37.5 [0.5y-6y]30.8-37.9 [6y-18y]32.2-43.5 [≧18y]M 40.4-51.1 F 35.6-45.4, (2019/7/1起 ≧18years 變更為M 39.6-51.5  F 34.8-46.3)][[0-14d]36.0-60.0 [15-30d]30.5-45.0 [31d-0.5y]26.8-37.5 [0.5y-6y]30.8-37.9 [6y-18y]32.2-43.5 [≧18y]M 40.4-51.1 F 35.6-45.4, (2019/7/1起 ≧18years 變更為M 39.6-51.5  F 34.8-46.3)]", null],
  ["[[0-14d]4.1-5.74 [15-30d]3.16-4.8 [31d-0.5y]2.93-4.8 [0.5y-6y]3.84-5.07 [6y-18y]3.9-5.29 [≧18y]M 4-5.52 F 3.78-4.99, (2019/7/1起 ≧18years 變更為M 4.21-5.9  F 3.78-5.25)][[0-14d]4.1-5.74 [15-30d]3.16-4.8 [31d-0.5y]2.93-4.8 [0.5y-6y]3.84-5.07 [6y-18y]3.9-5.29 [≧18y]M 4-5.52 F 3.78-4.99, (2019/7/1起 ≧18years 變更為M 4.21-5.9  F 3.78-5.25)]", null],
  ["[[0-14d]4.94-27.48 [15-30d]7.8-15.91 [31d-0.5y]6.0-14.99 [0.5y-6y]4.86-13.51 [6y-18y]3.84-11.4 [≧18y]M 3.54-9.06 F 3.54-9.06, (2019/7/1起 ≧18years 變更為 3.25-9.16)][[0-14d]4.94-27.48 [15-30d]7.8-15.91 [31d-0.5y]6.0-14.99 [0.5y-6y]4.86-13.51 [6y-18y]3.84-11.4 [≧18y]M 3.54-9.06 F 3.54-9.06, (2019/7/1起 ≧18years 變更為 3.25-9.16)]", null],
  ["[[0-14d]5.2-20.6 [15-30d]4.3-18.3 [31d-0.5y]3.8-15.5 [0.5y-6y]3.8-13.4 [6y-18y]4.1-12.3 [≧18y]M 3.1-8.0 F 2.7-7.6, (2019/7/1起 ≧18years 變更為 3.3-8.9)][[0-14d]5.2-20.6 [15-30d]4.3-18.3 [31d-0.5y]3.8-15.5 [0.5y-6y]3.8-13.4 [6y-18y]4.1-12.3 [≧18y]M 3.1-8.0 F 2.7-7.6, (2019/7/1起 ≧18years 變更為 3.3-8.9)]", null],
  ["[[0-14d]91.3-120.0 [15-30d]89.4-103.0 [31d-0.5y]74.1-96.4 [0.5y-6y]69.5-85.0 [6y-18y]74.4-90.6 [≧18y]M 80.0-100.0 F 80.0-100.0, (2019/7/1起 ≧18years 變更為80.9-99.3)][[0-14d]91.3-120.0 [15-30d]89.4-103.0 [31d-0.5y]74.1-96.4 [0.5y-6y]69.5-85.0 [6y-18y]74.4-90.6 [≧18y]M 80.0-100.0 F 80.0-100.0, (2019/7/1起 ≧18years 變更為80.9-99.3)]", null],
  ["[無][10.0]", { limit: 10, kind: "upper" }],
  ["[無][27.0]", { limit: 27, kind: "upper" }],
  ["[無][= 5.0]", { limit: 5, kind: "upper" }],
  ["[無][= 7.0]", { limit: 7, kind: "upper" }],
  ["[無][無]", null],
];

// 規則 3（無括號範圍）／規則 4（一側性符號）／空值／合成邊界。數值合成。
const SYNTH = [
  ["35-160", { band: [35, 160] }],
  ["70~99", { band: [70, 99] }],
  ["3.5-5.3", { band: [3.5, 5.3] }],
  ["<150", { limit: 150, kind: "upper" }],
  ["150 以下", { limit: 150, kind: "upper" }],
  ["≦3.4", { limit: 3.4, kind: "upper" }],
  ["≤200", { limit: 200, kind: "upper" }],
  [">40", { limit: 40, kind: "lower" }],
  ["≧60", { limit: 60, kind: "lower" }],
  ["≥1.03", { limit: 1.03, kind: "lower" }],
  ["40 以上", { limit: 40, kind: "lower" }],
  ["", null],
  [null, null],
  [undefined, null],
  ["陰性", null],                         // 文字型結果：無數可取
  ["以下", null],                         // 有符號無數 → 不畫
  [">40 或 <60", null],                   // 上下限符號並存＝語意不明 → 不畫
  ["[24.0][5.0]", null],                  // 合成：組合後 lo > hi → 不畫
  ["[5.0][5.0]", null],                   // 合成：組合後 lo = hi（零高度帶）→ 不畫
  ["[1.3~0.6][1.3~0.6]", null],           // 合成：側內範圍反向 → 組合後 lo > hi → 不畫
  ["160-35", null],                       // 合成：無括號反向範圍 → 不畫（規則 3 同護欄）
];

// 規則 1.5（單一括號組，change prerelease-p0-fixes／design D1）。形狀取自
// demo 產生器實際使用的健保存摺單括號寫法，數值合成。
const ONE_BRACKET = [
  ["[0-40]", { band: [0, 40] }],          // 範圍 → 灰帶
  ["[0.7-1.3]", { band: [0.7, 1.3] }],    // 小數範圍 → 灰帶
  ["[90-]", { limit: 90, kind: "lower" }],  // 數字＋尾隨連字號 → 下限線
  ["[-40]", { limit: 40, kind: "upper" }],  // 前導連字號＋數字 → 上限線
  ["[7.0]", null],                        // 單數無方向：帶或線都是猜 → 不畫
  ["[無]", null],                         // 無數值 → 不畫
  // 稽核 B1 負向：內容 MUST「恰為」範圍，「含」數對不算——未錨定會把
  // 年齡段標記與性別分段的首個數對錯畫成帶
  ["[0-14d]", null],
  ["[男 13-17 女 12-16]", null],
  ["[0-40 U/L]", null],                   // 帶單位形目前不支援（真實 45 格式無此形）
];

test("本機庫 45 個 DISTINCT ref_range 格式全數依 design D5 解析", () => {
  assert.equal(REAL.length, 45, "真實格式清單筆數應為實查的 45");
  assert.equal(new Set(REAL.map(([s]) => s)).size, 45, "真實格式清單不得有重複");
  for (const [input, want] of REAL) {
    assert.deepEqual(parseRef(input), want,
      `ref_range「${String(input).slice(0, 60)}」解析結果不符`);
  }
});

test("無括號範圍／一側性符號／空值／合成邊界", () => {
  for (const [input, want] of SYNTH) {
    assert.deepEqual(parseRef(input), want, `ref_range「${input}」解析結果不符`);
  }
});

/* T5 實測補正的釘子：「兩欄各塞完整範圍字串且左右相同」一族。只取側內首數
   會產出 [lo, lo] 零高度帶（＝錯畫）；此表釘住必須取到真正的上下界。 */
test("雙欄各含完整範圍者取真上下界，不得退化成零高度帶", () => {
  const cases = [["[0~41][0~41]", [0, 41]], ["[8~31][8~31]", [8, 31]],
    ["[7~25][7~25]", [7, 25]], ["[0.6~1.3][0.6~1.3]", [0.6, 1.3]],
    ["[31-37, (2019/7/1起 ≧18years 變更為31.0-34.9)][31-37, (2019/7/1起 ≧18years 變更為31.0-34.9)]",
      [31, 37]]];
  for (const [input, want] of cases) {
    const got = parseRef(input);
    assert.deepEqual(got, { band: want }, `「${input.slice(0, 40)}」應出帶 ${want}`);
    assert.notEqual(got.band[0], got.band[1], "上下界不得相同（零高度帶＝錯畫）");
  }
});

test("單一括號組依內容判向（規則 1.5，design D1）", () => {
  for (const [input, want] of ONE_BRACKET) {
    assert.deepEqual(parseRef(input), want, `ref_range「${input}」解析結果不符`);
  }
});

test("含括號但非恰雙欄形一律不畫（釘住規則 2，防「順手支援」錯配回歸）", () => {
  // 舊版首個配對會把年齡分段標記「0-14d」錯配成參考帶 [0,14]
  let checked = 0;
  for (const [input, want] of REAL) {
    if (!/^\[[^[\]]*\]\[[^[\]]*\]$/.test(String(input)) && String(input).includes("[")) {
      assert.equal(want, null, "複合字串的期望值本身必須是 null");
      assert.equal(parseRef(input), null,
        `複合字串仍被解析：${String(input).slice(0, 50)}`);
      checked++;
    }
  }
  // 沒撈到任何複合字串＝篩選條件寫壞、本測試空轉（本機庫實查為 13 筆）
  assert.equal(checked, 13, `複合字串應檢查 13 筆，實際 ${checked}`);
  // 規則 1.5 只放行「恰一個括號組且內容可判向」者；三組以上的複合形與
  // 內容判不了向的單組仍走規則 2 保守不畫（design D1）
  assert.equal(parseRef("[0-40][50-90][100-]"), null, "三個括號組屬未知括號形，保守不畫");
  assert.equal(parseRef("[7.0]"), null, "單組單數無方向，不畫");
});

/* ---------- 真渲染：三形態在檢驗分頁看得到什麼 ---------- */
async function labPayload(refRange, values) {
  const d = new NodeDriver(
    path.join(mkdtempSync(path.join(tmpdir(), "hwb-pref-")), "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  const ins = await d.execute(
    `INSERT INTO source_documents(profile_id, filename, sha256, adapter,
      adapter_version, imported_at) VALUES (?,?,?,?,?,?)`,
    [pid, "nhi.dat", "sha-nhi", "nhi_json", "1", "2026-08-18 09:00"]);
  const doc = ins.lastInsertRowid;
  await d.execute(
    `INSERT INTO encounters(profile_id, doc_id, section, source_index, record_fp,
      canonical, type, date, facility_name) VALUES (?,?,?,?,?,?,?,?,?)`,
    [pid, doc, "r1", 1, "fp-e1", "{}", "western_outpatient", "2026-07-01", "示範診所"]);
  const dates = ["2026-06-05", "2026-07-10", "2026-08-14"];
  await d.batchInsert("lab_results",
    ["profile_id", "doc_id", "section", "source_index", "record_fp", "canonical",
      "test_date", "facility_name", "order_name", "test_name_raw",
      "test_name_normalized", "value_text", "value_numeric", "ref_range", "quality_flags"],
    dates.map((dt, i) => [pid, doc, "r4", i + 1, `fp-l-${i}`, "{}", dt, "示範綜合醫院",
      "生化檢驗", "TRIGLYCERIDE", "Triglyceride", `${values[i]} mg/dL`, values[i],
      refRange, ""]));
  const p = await buildPayload(d, { profileId: pid, knowledgeEntries: LAB_ENTRIES,
    drugCachePath: null, today: TODAY });
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
  const sandbox = { document: doc, console, setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id) };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["vendor/preact.min.js", "vendor/hooks.umd.js",
    "vendor/htm.umd.js", "app.js"]) {
    vm.runInContext(readFileSync(new URL(f, ASSETS), "utf-8"), sandbox, { filename: f });
  }
  return { root, flush: () => new Promise((r) => setTimeout(r, 5)) };
}

const byClass = (root, name, cls) => findAll(root, (e) => e.localName === name
  && String(e.getAttribute?.("class") || "") === cls);

async function labsPage(refRange, values) {
  const { root, flush } = renderViewer(await labPayload(refRange, values));
  await flush();
  const tab = findAll(root, (e) => e.localName === "button" && e.textContent === "檢驗"
    && (e.listeners.click || []).length)[0];
  assert.ok(tab, "找不到檢驗分頁按鈕");
  tab.dispatch("click");
  await flush();
  assert.ok(!root.textContent.includes("分頁載入失敗"),
    `檢驗分頁落入錯誤邊界：${root.textContent.slice(0, 300)}`);
  return root;
}

test("一側性參考值：單條參考線＋虛線說明，無灰帶", async () => {
  for (const raw of ["<150", "[無][10.0]"]) {
    const root = await labsPage(raw, [120, 130, 140]);
    const lines = byClass(root, "line", "refline");
    assert.equal(lines.length, 1, `「${raw}」應只有一條參考線，實際 ${lines.length}`);
    const limit = raw === "<150" ? 150 : 10;
    const text = root.textContent;
    assert.ok(text.includes(`參考上限 ${limit}`), `缺參考線標籤：${text.slice(0, 300)}`);
    assert.ok(text.includes(`虛線為最近一次報告之參考上限 ${raw}`),
      `說明文字未隨形態切換：${text.slice(0, 300)}`);
    assert.ok(!text.includes("灰帶為"), "一側性不得出現灰帶說明");
    assert.equal(byClass(root, "rect", "refband").length, 0, "一側性不得畫帶");
    // refLines 參與 y 域：域外的上限（140 之上、10 之下）仍須落在繪圖區內
    const y = Number(lines[0].getAttribute("y1"));
    assert.ok(y >= CH.PT && y <= CH.H - CH.PB,
      `參考線 y=${y} 落在繪圖區（${CH.PT}~${CH.H - CH.PB}）外＝看不見`);
  }
});

test("雙欄格式參考值：灰帶＋灰帶說明，無參考線", async () => {
  const root = await labsPage("[5.0][24.0]", [10, 15, 20]);
  assert.equal(byClass(root, "rect", "refband").length, 1, "應有一個參考值灰帶");
  const text = root.textContent;
  assert.ok(text.includes("灰帶為最近一次報告之參考值區間 [5.0][24.0]"),
    `缺灰帶說明：${text.slice(0, 300)}`);
  assert.ok(!text.includes("虛線為"), "帶形態不得出現虛線說明");
  assert.equal(byClass(root, "line", "refline").length, 0, "帶形態不得畫參考線");
});

test("年齡分段複合字串：不畫帶、不畫線、無任何參考值說明", async () => {
  const compound = REAL.find(([s]) => s.startsWith("[[0-14d]144-450"))[0];
  const root = await labsPage(compound, [200, 250, 300]);
  assert.equal(byClass(root, "rect", "refband").length, 0, "複合字串不得畫帶");
  assert.equal(byClass(root, "line", "refline").length, 0, "複合字串不得畫線");
  const text = root.textContent;
  assert.ok(!text.includes("灰帶為") && !text.includes("虛線為"),
    "複合字串不得出現任何參考值說明");
  // 趨勢圖其餘照常（spec Scenario：複合字串保守不畫，圖不受影響）
  assert.ok(findAll(root, (e) => e.localName === "polyline").length >= 1,
    "折線本身仍須繪出");
});
