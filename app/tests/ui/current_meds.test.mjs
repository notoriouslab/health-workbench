// 「目前在吃」判定（change clinic-visit-view，T2／design D2；
// spec app-viewer「目前在吃的藥的判定」）。
//
// medStatus 定義在 app.js 的 IIFE 內、不對外 export：沿 parse_ref.test.mjs
// 的作法取其來源切片在本 realm 求值取用；切片錨點若失效，下方 anchor
// 斷言先失敗，不會靜默測到空函式。
//
// 日期一律相對於注入的 todayMs 計算，不寫死絕對日期：寫死的話這些向量
// 會隨時間漂移（今天寫的「10 日前」明年跑就變成 375 日前）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ASSETS = new URL("../../src/viewer/assets/", import.meta.url);
const SRC = readFileSync(new URL("app.js", ASSETS), "utf-8");
const SLICE_FROM = "function medStatus", SLICE_TO = "/* ---------- 共用元件";
const from = SRC.indexOf(SLICE_FROM), to = SRC.indexOf(SLICE_TO);
assert.ok(from > 0 && to > from,
  `app.js 的 medStatus 區段錨點失效（from=${from} to=${to}），請更新切片錨點`);
const MED_SRC = SRC.slice(from, to);
for (const anchor of ["days_supply", "no_days_supply", "remainingDays", "todayMs"]) {
  assert.ok(MED_SRC.includes(anchor), `切片缺 ${anchor}，取到的不是完整 medStatus`);
}
const medStatus = new Function(`${MED_SRC};return medStatus;`)();
assert.equal(typeof medStatus, "function", "切片求值後未取得 medStatus 函式");

const TODAY = Date.parse("2026-08-21T00:00:00Z");
const daysAgo = (n) => new Date(TODAY - n * 864e5).toISOString().slice(0, 10);
const rx = (n, days) => [{ date: daysAgo(n), days_supply: days }];

test("給藥期間內：判為目前在吃並算出剩餘天數", () => {
  // 28 日份、10 日前開立 → 還剩 18 天
  assert.deepEqual(medStatus(rx(10, 28), TODAY),
    { active: true, remainingDays: 18, reason: null });
});

test("給藥期間已過：不判為目前在吃", () => {
  // 28 日份、30 日前開立 → 2 天前就吃完了
  assert.deepEqual(medStatus(rx(30, 28), TODAY),
    { active: false, remainingDays: null, reason: null });
});

test("短期藥不誤判：三日份、60 日前開立", () => {
  // 釘住判定式本身：任何「最近 N 個月開過就算現用」的實作都會讓這則轉紅
  assert.deepEqual(medStatus(rx(60, 3), TODAY),
    { active: false, remainingDays: null, reason: null });
});

test("給藥日數缺值：歸過往並標註原因，MUST NOT 補預設天數", () => {
  assert.deepEqual(medStatus(rx(1, null), TODAY),
    { active: false, remainingDays: null, reason: "no_days_supply" });
  // 0 日與非數值同樣不得判為現用（0 不是「今天吃完」而是沒有這項事實）
  assert.deepEqual(medStatus(rx(1, 0), TODAY),
    { active: false, remainingDays: null, reason: "no_days_supply" });
  assert.deepEqual(medStatus(rx(1, ""), TODAY),
    { active: false, remainingDays: null, reason: "no_days_supply" });
});

test("邊界：最後一天仍在吃，隔天就不在", () => {
  // 7 日份、6 日前 → 今天是第 7 天，剩 1 天
  assert.equal(medStatus(rx(6, 7), TODAY).remainingDays, 1);
  // 7 日份、7 日前 → 已吃完
  assert.equal(medStatus(rx(7, 7), TODAY).active, false);
});

test("取日期最大的一筆判定，不倚賴呼叫端排序", () => {
  const items = [
    { date: daysAgo(400), days_supply: 90 },   // 舊處方（早已過期）
    { date: daysAgo(5), days_supply: 30 },     // 最近處方（仍在期間內）
    { date: daysAgo(200), days_supply: 14 },
  ];
  assert.deepEqual(medStatus(items, TODAY),
    { active: true, remainingDays: 25, reason: null });
  // 順序顛倒結果不變（釘住「不倚賴排序」）
  assert.deepEqual(medStatus([...items].reverse(), TODAY),
    { active: true, remainingDays: 25, reason: null });
});

test("空集合與壞日期：靜默歸過往，不拋出", () => {
  assert.deepEqual(medStatus([], TODAY),
    { active: false, remainingDays: null, reason: null });
  assert.deepEqual(medStatus(null, TODAY),
    { active: false, remainingDays: null, reason: null });
  assert.deepEqual(medStatus([{ date: "不是日期", days_supply: 30 }], TODAY),
    { active: false, remainingDays: null, reason: null });
});
