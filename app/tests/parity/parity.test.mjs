import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runParity, REPO } from "./harness.mjs";

const NHI = `${REPO}/tests/fixtures/nhi_sample.json`;
const APPLE = `${REPO}/tests/fixtures/apple_sample.xml`;
const NHI_CTRL = `${REPO}/tests/fixtures/nhi_ctrlchar.json`;
const NHI_LABNORM = `${REPO}/tests/fixtures/nhi_labnorm.json`;

test("parity：nhi fixture 單檔全表全等＋報告全等", async () => {
  const { dbDiffs, reportDiffs } = await runParity(
    [NHI], mkdtempSync(path.join(tmpdir(), "hwb-par1-")));
  assert.deepEqual(dbDiffs, []);
  assert.deepEqual(reportDiffs, []);
});

test("parity：apple fixture 單檔全表全等＋報告全等", async () => {
  const { dbDiffs, reportDiffs } = await runParity(
    [APPLE], mkdtempSync(path.join(tmpdir(), "hwb-par2-")));
  assert.deepEqual(dbDiffs, []);
  assert.deepEqual(reportDiffs, []);
});

test("parity：nhi＋apple 依序匯入同一庫（每月例行形態）全等", async () => {
  const { dbDiffs, reportDiffs } = await runParity(
    [NHI, APPLE], mkdtempSync(path.join(tmpdir(), "hwb-par3-")));
  assert.deepEqual(dbDiffs, []);
  assert.deepEqual(reportDiffs, []);
});

test("parity：同檔重複匯入（冪等跳過）後仍全等", async () => {
  // 第二次匯入同檔：兩實作皆以 SHA-256 跳過且不產報告，庫零變化
  const { dbDiffs, reportDiffs } = await runParity(
    [NHI, NHI, APPLE, APPLE], mkdtempSync(path.join(tmpdir(), "hwb-par4-")));
  assert.deepEqual(dbDiffs, []);
  assert.deepEqual(reportDiffs, []);
});

// issue #2：Python 用 json.loads(strict=False)，JS 沒有對應開關而自行跳脫字串內
// 的原始控制字元。兩者是不對稱的實作，語意是否真的相同不能靠人工對帳宣稱，
// 由這則差分測試釘住（全表 dump ＋ 品質報告全等）。
test("parity：報告欄位含未跳脫原始控制字元的檔案，兩實作全等（issue #2）", async () => {
  const { dbDiffs, reportDiffs } = await runParity(
    [NHI_CTRL], mkdtempSync(path.join(tmpdir(), "hwb-par-ctrl-")));
  assert.deepEqual(dbDiffs, []);
  assert.deepEqual(reportDiffs, []);
});

// 名稱鬆比對與醫令代碼後備是兩份各自寫的實作（NFKC、大寫、字元集、取前
// 6 碼皆各寫一次），逐位元組對帳才擋得住「其中一端對全形或標點的處理不同」。
// 向量 9（ＬＤＬ－Ｃ）與向量 6（8 碼取前 6）是這條線的主要壓力點。
test("parity：檢驗名稱三級短路 fixture（含全形與代碼後備）兩實作全等", async () => {
  const { dbDiffs, reportDiffs } = await runParity(
    [NHI_LABNORM], mkdtempSync(path.join(tmpdir(), "hwb-par-labnorm-")));
  assert.deepEqual(dbDiffs, []);
  assert.deepEqual(reportDiffs, []);
});
