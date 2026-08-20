// 總覽「最新檢驗」卡的同日未顯示提示（change prerelease-p0-fixes／design D2）
// ＋ h1 標題無多餘空格（design D5）。
// 症狀：卡片固定 slice(-4)，但同一次抽血（同 test_date）常超過 4 項，被切掉的
// 項目沒有任何提示＝靜默藏資料。此處用真渲染（沿 viewer_render 的 vm sandbox
// 手法）斷言使用者看得到「同日還有 N 項」，且點該列會跳到檢驗分頁。
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
const LATEST_DATE = "2026-08-14";
const PRIOR_DATE = "2026-06-05";
const PROFILE = "測試成員";

/* 最新日 latestCount 項＋前一日 3 項（前一日的存在確保「表內最早一列」
   的同日判定不是拿整表筆數硬減） */
async function labsPayload(latestCount, priorCount = 3) {
  const d = new NodeDriver(
    path.join(mkdtempSync(path.join(tmpdir(), "hwb-orl-")), "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, PROFILE);
  const ins = await d.execute(
    `INSERT INTO source_documents(profile_id, filename, sha256, adapter,
      adapter_version, imported_at) VALUES (?,?,?,?,?,?)`,
    [pid, "nhi.dat", "sha-nhi", "nhi_json", "1", "2026-08-18 09:00"]);
  const doc = ins.lastInsertRowid;
  const names = ["WBC", "RBC", "Hemoglobin", "PLT", "MCV", "MCH", "MCHC"];
  const rows = [];
  const push = (dt, i, name) => rows.push([pid, doc, "r4", rows.length + 1,
    `fp-l-${dt}-${i}`, "{}", dt, "示範綜合醫院", "生化檢驗", name, name,
    `${10 + i} U/L`, 10 + i, "[0-40]", ""]);
  for (let i = 0; i < priorCount; i++) push(PRIOR_DATE, i, names[i]);
  for (let i = 0; i < latestCount; i++) push(LATEST_DATE, i, names[i]);
  await d.batchInsert("lab_results",
    ["profile_id", "doc_id", "section", "source_index", "record_fp", "canonical",
      "test_date", "facility_name", "order_name", "test_name_raw",
      "test_name_normalized", "value_text", "value_numeric", "ref_range",
      "quality_flags"], rows);
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

async function overview(latestCount, priorCount) {
  const { root, flush } = renderViewer(await labsPayload(latestCount, priorCount));
  await flush();
  assert.ok(!root.textContent.includes("分頁載入失敗"),
    `總覽落入錯誤邊界：${root.textContent.slice(0, 300)}`);
  assert.ok(root.textContent.includes("資料庫與匯入紀錄"), "總覽未渲染");
  return { root, flush };
}

const hintRow = (root) => findAll(root, (e) => e.localName === "tr"
  && String(e.getAttribute?.("class") || "").includes("rowlink")
  && e.textContent.includes("同日還有"))[0];

test("總覽最新檢驗：最新日 5 項時提示「同日還有 1 項」", async () => {
  const { root } = await overview(5);
  const text = root.textContent;
  assert.ok(text.includes("08-14 同日還有 1 項"),
    `缺同日提示：${text.slice(text.indexOf("最新檢驗"), text.indexOf("最新檢驗") + 400)}`);
  assert.ok(hintRow(root), "提示列應是可點擊的 rowlink 列");
});

test("總覽最新檢驗：最新日 7 項時提示「同日還有 3 項」（N 隨筆數增長）", async () => {
  const { root } = await overview(7);
  assert.ok(root.textContent.includes("08-14 同日還有 3 項"),
    "N 應等於同日未進表的筆數");
});

// 「不出現」的三種形狀：同日恰好 4 項全進表、全部檢驗少於 4 筆、
// 表滿但被切掉的都是別日（別日被切掉屬正常的時間窗，不是同日靜默）
test("總覽最新檢驗：表內最早一列無同日遺漏時不出現提示", async () => {
  for (const [latest, prior] of [[4, 3], [2, 0], [2, 2]]) {
    const { root } = await overview(latest, prior);
    assert.ok(!root.textContent.includes("同日還有"),
      `最新日 ${latest} 項＋前一日 ${prior} 項不該有同日提示`);
    assert.equal(hintRow(root), undefined,
      `最新日 ${latest} 項＋前一日 ${prior} 項不該有提示列`);
  }
});

test("總覽最新檢驗：點同日提示列跳到檢驗分頁", async () => {
  const { root, flush } = await overview(5);
  hintRow(root).dispatch("click");
  await flush();
  const text = root.textContent;
  assert.ok(!text.includes("分頁載入失敗"), `跳轉後落入錯誤邊界：${text.slice(0, 300)}`);
  assert.ok(text.includes("全部項目"), `未跳到檢驗分頁：${text.slice(0, 300)}`);
  assert.ok(!text.includes("資料庫與匯入紀錄"), "仍停在總覽");
});

test("h1 標題：成員名與「的個人健康資料工作台」之間無多餘空格", async () => {
  const { root } = await overview(3);
  const h1 = findAll(root, (e) => e.localName === "h1")[0];
  assert.ok(h1, "找不到 h1");
  assert.equal(h1.textContent, `${PROFILE}的個人健康資料工作台`);
  assert.ok(!h1.textContent.includes(`${PROFILE} 的`), "成員名後不得留空格");
});
