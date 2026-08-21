// 匯出檔名純函式（app-viewer spec：檔名含成員名稱、不安全字元代換）
import test from "node:test";
import assert from "node:assert/strict";
import { exportFileName } from "../../src/ui/viewer.js";

test("正常成員名", () => {
  assert.equal(exportFileName("媽媽", "2026-08-10"),
    "健康紀錄_媽媽_20260810-private.html");
});

test("檔名不安全字元代換為底線", () => {
  assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|j', "2026-08-10"),
    "健康紀錄_a_b_c_d_e_f_g_h_i_j_20260810-private.html");
});

test("空名稱回退「成員」", () => {
  assert.equal(exportFileName("", "2026-08-10"),
    "健康紀錄_成員_20260810-private.html");
  assert.equal(exportFileName(null, "2026-08-10"),
    "健康紀錄_成員_20260810-private.html");
});
