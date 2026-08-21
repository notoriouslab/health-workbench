import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { FORBIDDEN_WORDS, checkText } from "../../src/knowledge/forbidden.js";
import { checkComparative } from "../../src/knowledge/comparative.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const APP_SRC = path.join(REPO, "app/src");

test("禁用詞清單與 SSOT（src/knowledge/forbidden.py）同步", () => {
  const py = readFileSync(path.join(REPO, "src/knowledge/forbidden.py"), "utf-8");
  const block = py.match(/FORBIDDEN_WORDS = \[([\s\S]*?)\]/)[1];
  const pyWords = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(FORBIDDEN_WORDS, pyWords);
});

test("app/ 前端文案無禁用詞（引擎/知識模組全掃）", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|html|json)$/.test(name)) files.push(p);
    }
  };
  walk(APP_SRC);
  assert.ok(files.length >= 15, `掃描檔數 ${files.length} 異常偏少`);
  const violations = [];
  for (const f of files) {
    // forbidden.js 本身定義清單，跳過
    if (f.endsWith("knowledge/forbidden.js")) continue;
    const hits = checkText(readFileSync(f, "utf-8"));
    if (hits.length) violations.push([path.relative(REPO, f), hits]);
  }
  assert.deepEqual(violations, []);
});

test("出貨文案無禁用詞（DMG 與 Windows 使用說明）", () => {
  const violations = [];
  for (const rel of ["packaging/dmg-readme.txt", "packaging/windows-readme.txt"]) {
    const text = readFileSync(path.join(REPO, rel), "utf-8");
    assert.ok(text.length > 500, `${rel} 內容異常偏少`);
    const hits = checkText(text);
    if (hits.length) violations.push([rel, hits]);
  }
  assert.deepEqual(violations, []);
});

// 雙份 app.js 同步守衛：App 內檢視與 Python rebuild 產出的單檔 HTML 各用
// 一份，改了一份忘了另一份不會有任何錯誤，只會讓兩條路徑靜默分歧。
test("兩份 app.js 逐位元組相同（App 檢視層與匯出層）", () => {
  const a = readFileSync(path.join(REPO, "app/src/viewer/assets/app.js"), "utf-8");
  const b = readFileSync(path.join(REPO, "src/dashboard/app.js"), "utf-8");
  assert.equal(a, b,
    "app/src/viewer/assets/app.js 與 src/dashboard/app.js 不一致，請同步");
});

test("出貨文案與檢視層文案：CPAP 指標只顯示不解讀", () => {
  // 禁用詞清單擋的是既有的判定性措辭。這裡另外確認 CPAP 相關文案沒有
  // 引入新的解讀性用語（嚴重度、是否達標、要不要就醫等）。
  const app = readFileSync(path.join(REPO, "app/src/viewer/assets/app.js"), "utf-8");
  const INTERPRETIVE = ["偏高", "偏低", "過高", "過低", "嚴重", "輕微", "達標",
    "未達標", "需就醫", "建議就醫", "控制良好", "控制不佳", "正常範圍"];
  const hits = INTERPRETIVE.filter(w => app.includes(w));
  assert.deepEqual(hits, [], `檢視層出現解讀性用語：${hits.join("、")}`);
});

/* ===== 比較性措辭守衛（change clinic-visit-view T7／design D8） =====
   spec app-viewer「使用者可見文案的比較性措辭約束」：檢視層文案 MUST NOT
   述及其他系統的資料涵蓋範圍、MUST NOT 暗示醫療人員取不到某些資料、
   MUST NOT 出現其他系統的收載區間數字。 */
test("檢視層文案無比較性措辭（兩份 app.js）", () => {
  const violations = [];
  for (const rel of ["app/src/viewer/assets/app.js", "src/dashboard/app.js"]) {
    const hits = checkComparative(readFileSync(path.join(REPO, rel), "utf-8"));
    if (hits.length) violations.push([rel, hits]);
  }
  assert.deepEqual(violations, []);
});

test("比較性措辭守衛自身有效（負向對照：故意違規要被抓到）", () => {
  // 三類各構造一句：只證明現況是綠的，證不了守衛會 fire（gate-proof 紀律）
  const roleDenial = checkComparative("這些長期資料醫師查不到，帶去給他看比較好。");
  assert.equal(roleDenial.length, 1, `未抓到共現：${JSON.stringify(roleDenial)}`);
  assert.equal(roleDenial[0].kind, "role_denial");

  const other = checkComparative("這裡的資料比雲端藥歷完整。");
  assert.ok(other.some((h) => h.kind === "other_system"),
    `未抓到其他系統指名：${JSON.stringify(other)}`);

  const window6 = checkComparative("對方只能查到近 6 個月的用藥。");
  assert.ok(window6.some((h) => h.kind === "coverage_window"),
    `未抓到收載區間數字：${JSON.stringify(window6)}`);
  assert.ok(checkComparative("只能查到近6個月的用藥").some(
    (h) => h.kind === "coverage_window"), "無空格的變體也要抓");

  // 放行對照：單獨出現都合法，共現才違規；D5 的「三個月」刻意不擋
  assert.deepEqual(checkComparative("如有醫療問題請諮詢合格醫事人員。"), [],
    "免責語不得被誤擋");
  assert.deepEqual(checkComparative("沒有資料的小節不會出現。"), [],
    "空狀態說法不得被誤擋");
  assert.deepEqual(
    checkComparative("資料截止日距今超過三個月時會提示。"), [],
    "design D5 自選的三個月門檻是合法文案，MUST NOT 誤擋");
  // 跨句不算共現（切句規則的釘子）
  assert.deepEqual(
    checkComparative("請諮詢合格醫事人員。這個小節沒有資料時不會出現。"), [],
    "分屬兩句不構成比較性敘述");
});
