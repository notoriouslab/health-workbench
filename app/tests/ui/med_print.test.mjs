// 列印用藥清單的真渲染守衛（change drug-info-and-lab-refband，T4/design D4）。
// 沿用 med_indication 的 vm sandbox 手法跑 vendored preact + app.js，以健保
// payload 為底、把 medications 換成三類俱全的 fixture（西藥／中藥／診療項目）。
// 斷言使用者印得到什麼（清單文字、頁首來源標示、頁尾）與按鈕行為
// （呼叫 window.print、EPUB 旗標下不渲染），不碰實作細節。
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

const REPO = new URL("../../..", import.meta.url).pathname;
const ASSETS = new URL("../../src/viewer/assets/", import.meta.url);
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

async function basePayload() {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-medprint-"));
  const d = new NodeDriver(path.join(tmp, "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
      name: "nhi_sample.json" },
    d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  const p = await buildPayload(d, { profileId: pid,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: null, today: "2026-08-19" });
  await d.close();
  return p;
}

/* 一筆處方列（欄位名與 provider 的 medications 列同形）。
   medCategory：drug_zh 有值＝西藥；section_hint r9＝中藥；其餘＝診療項目 */
function med(i, extra) {
  return { id: 900 + i, encounter_id: 1, order_code: `XX0000000${i}`,
    order_name: `原始醫囑${i}`, total_qty: 30, days_supply: 30, tooth_name: null,
    section_hint: "r5", date: "2026-05-01", facility_name: "測試院所",
    drug_zh: null, ingredient: null, leaflet_url: null, ...extra };
}

const WESTERN = med(1, { drug_zh: "西藥甲錠", ingredient: "成分甲",
  date: "2026-05-11" });
const TCM = med(2, { section_hint: "r9", order_name: "中藥乙湯",
  date: "2026-04-22" });
const ORDER = med(3, { order_name: "診療項目丙", date: "2026-03-03" });

function payloadWithMeds(base, meds) {
  const p = JSON.parse(JSON.stringify(base));
  p.medications = meds;
  p.meds_by_enc = {};
  p.meta.drug_cache = { updated_at: "2026-08-18", count: meds.length };
  return p;
}

/* epub：模擬 EPUB 骨架注入的 window.HWB_EPUB 旗標；
   inApp：模擬 App 檢視頁的 iframe（window.frameElement 非 null） */
function renderViewer(payload, { epub = false, inApp = false } = {}) {
  const doc = makeDocument();
  const dataEl = doc.createElement("script");
  dataEl.textContent = JSON.stringify(payload);
  doc.registerId("hwb-data", dataEl);
  const root = doc.createElement("div");
  doc.registerId("app", root);
  const printCalls = [];
  // 記錄 print 當下帶 active 的列印視圖 id：spec「只印被觸發的那一份」的
  // 判準就在這個時刻，print 之後 active 會被清掉，事後查 DOM 一律是空的。
  const activeSheets = () => findAll(root, (el) => {
    const c = String(el.getAttribute?.("class") || "");
    return c.includes("print-sheet") && c.includes("active");
  }).map((el) => el.getAttribute("id"));
  const sandbox = {
    document: doc, console,
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    print: () => printCalls.push(activeSheets()),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  if (epub) sandbox.HWB_EPUB = true;
  if (inApp) sandbox.frameElement = {};
  vm.createContext(sandbox);
  for (const f of ["vendor/preact.min.js", "vendor/hooks.umd.js",
    "vendor/htm.umd.js", "app.js"]) {
    vm.runInContext(readFileSync(new URL(f, ASSETS), "utf-8"), sandbox, { filename: f });
  }
  const flush = () => new Promise((r) => setTimeout(r, 5));
  return { root, flush, printCalls };
}

const buttonByText = (root, label) => findAll(root,
  (el) => el.localName === "button" && el.textContent === label
    && (el.listeners.click || []).length)[0];

const sheetOf = (root) => findAll(root, (el) => String(
  el.getAttribute?.("class") || "").includes("print-sheet"))[0];

/* 開到指定分頁，回傳 { root, flush, printCalls } */
async function openTab(payload, label, opts) {
  const ctx = renderViewer(payload, opts);
  await ctx.flush();
  const tab = buttonByText(ctx.root, label);
  assert.ok(tab, `找不到${label}分頁按鈕`);
  tab.dispatch("click");
  await ctx.flush();
  assert.ok(!ctx.root.textContent.includes("分頁載入失敗"),
    `${label}分頁落入錯誤邊界：${ctx.root.textContent.slice(0, 300)}`);
  return ctx;
}

const openMeds = (payload, opts) => openTab(payload, "用藥", opts);

test("列印清單：藥品與中醫用藥兩節，每列名稱＋成分＋最近處方日期", async () => {
  const base = await basePayload();
  const { root } = await openMeds(payloadWithMeds(base, [WESTERN, TCM, ORDER]));
  const sheet = sheetOf(root);
  assert.ok(sheet, "缺列印清單區（.print-sheet）");
  const text = sheet.textContent;
  assert.ok(text.includes("藥品（1）"), "缺藥品節");
  assert.ok(text.includes("中醫用藥（1）"), "缺中醫用藥節");
  assert.ok(text.includes("西藥甲錠") && text.includes("成分甲")
    && text.includes("2026-05-11"), `西藥列不全：${text}`);
  assert.ok(text.includes("中藥乙湯") && text.includes("2026-04-22"),
    `中藥列不全：${text}`);
});

test("列印清單：診療項目類不進清單", async () => {
  const base = await basePayload();
  const { root } = await openMeds(payloadWithMeds(base, [WESTERN, TCM, ORDER]));
  const text = sheetOf(root).textContent;
  assert.ok(!text.includes("診療項目丙"), "診療項目不該進清單");
  assert.ok(!text.includes("診療項目與其他"), "清單不該有診療項目節");
  // 分頁本身仍有三個分類鈕（清單縮範圍不影響瀏覽介面）
  assert.ok(buttonByText(root, "診療項目與其他（1）"), "分類鈕列不該被改動");
});

test("列印清單：頁首成員名＋產生日期＋品項檔版本，頁尾免責", async () => {
  const base = await basePayload();
  const { root } = await openMeds(payloadWithMeds(base, [WESTERN, TCM]));
  const text = sheetOf(root).textContent;
  assert.ok(text.includes("用藥清單"), "缺清單標題");
  assert.ok(text.includes("成員：測試成員"), `缺成員名：${text}`);
  assert.ok(text.includes("產生日期：2026-08-19"), `缺產生日期：${text}`);
  assert.ok(text.includes("藥品資訊來自健保用藥品項檔（版本 2026-08-18）"),
    `缺品項檔版本來源標示：${text}`);
  assert.ok(text.includes("本清單僅為就醫溝通輔助，不含醫療判斷"), "缺頁尾");
});

test("未建品項檔快取：頁首版本標為未建快取", async () => {
  const base = await basePayload();
  const p = payloadWithMeds(base, [WESTERN]);
  delete p.meta.drug_cache;
  const { root } = await openMeds(p);
  assert.ok(sheetOf(root).textContent
    .includes("藥品資訊來自健保用藥品項檔（版本 未建快取）"), "缺未建快取標示");
});

test("列印按鈕呼叫 window.print（不開新視窗、不產檔）", async () => {
  const base = await basePayload();
  const { root, flush, printCalls } = await openMeds(payloadWithMeds(base, [WESTERN]));
  const btn = buttonByText(root, "列印用藥清單");
  assert.ok(btn, "缺「列印用藥清單」按鈕");
  assert.equal(printCalls.length, 0, "渲染階段不該呼叫 print");
  btn.dispatch("click");
  // print 呼叫在 useEffect 內（DOM 要先套上 active class 才送印），故需 flush
  await flush();
  assert.equal(printCalls.length, 1, "按鈕未呼叫 window.print");
  assert.deepEqual(printCalls[0], ["print-meds"],
    "列印當下只有用藥清單那一份該是作用中");
});

test("EPUB（window.HWB_EPUB=true）：不渲染列印按鈕", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [WESTERN, TCM]);
  const plain = await openMeds(payload);
  assert.ok(buttonByText(plain.root, "列印用藥清單"),
    "無旗標時應有按鈕（負向對照的正向端）");

  const { root } = await openMeds(payload, { epub: true });
  // 斷言寫成布林：MiniElement 是循環結構，直接丟進 assert.equal 的差異
  // 訊息會讓 node 花數十秒序列化整棵 DOM（實測 39s），失敗訊息還讀不到。
  assert.ok(!buttonByText(root, "列印用藥清單"),
    "EPUB 旗標下不該渲染列印按鈕");
  assert.ok(buttonByText(root, "藥品（1）"), "其餘互動不該受影響");
});

test("無用藥資料：不渲染清單區（不留空清單）", async () => {
  const base = await basePayload();
  const { root } = await openMeds(payloadWithMeds(base, []));
  assert.ok(!sheetOf(root), "無用藥資料不該渲染清單區");
  assert.ok(!root.textContent.includes("本清單僅為就醫溝通輔助"), "不該留頁尾");
});

test("只有診療項目：清單無可印內容，整區不渲染", async () => {
  const base = await basePayload();
  const { root } = await openMeds(payloadWithMeds(base, [ORDER]));
  assert.ok(!sheetOf(root), "只有診療項目時不該渲染清單區");
});

test("樣式表：清單平時隱藏，列印時只留清單", () => {
  const css = readFileSync(new URL("style.css", ASSETS), "utf-8");
  assert.match(css, /\.print-sheet\s*\{\s*display:\s*none;/,
    "缺 .print-sheet 平時隱藏規則");
  const print = css.slice(css.indexOf("@media print"));
  assert.ok(print.includes("@media print"), "缺 @media print 區塊");
  // 選擇器 MUST 帶 .active：檢視頁有兩份列印視圖，只認 .print-sheet 的話
  // 兩份會同時進入列印輸出（change clinic-visit-view D6）
  assert.match(print,
    /body:has\(\.print-sheet\.active\)\s+header\s*\{\s*display:\s*none\s*!important/,
    "列印時未隱藏標頭（導覽與搜尋）");
  assert.match(print,
    /body:has\(\.print-sheet\.active\)\s+section\s*>\s*\*:not\(\.print-sheet\.active\)\s*\{\s*display:\s*none\s*!important/,
    "列印時未隱藏分頁內非作用中清單的內容");
  assert.match(print, /\.print-sheet\.active\s*\{\s*display:\s*block/, "列印時未顯示清單");
});

test("列印清單表格有 thead（跨頁重印表頭）＋列印樣式規則", async () => {
  const base = await basePayload();
  const { root } = await openMeds(payloadWithMeds(base, [WESTERN, TCM]));
  const sheet = sheetOf(root);
  const theads = findAll(sheet, (el) => el.localName === "thead");
  assert.equal(theads.length, 2, "藥品與中醫用藥兩節的表格都該有 thead");
  const css = readFileSync(new URL("style.css", ASSETS), "utf-8");
  const print = css.slice(css.indexOf("@media print"));
  assert.match(print, /\.print-sheet\.active thead \{ display: table-header-group/,
    "缺 thead 跨頁重印規則（第二頁起會變無標題裸表）");
  assert.match(print, /\.print-sheet\.active h3 \{ page-break-after: avoid/,
    "缺節標題防孤兒規則");
});

test("App 內（iframe）：不渲染列印按鈕、顯示匯出導流說明（2026-08-20 實機 fallback）", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [WESTERN, TCM]);
  const { root, printCalls } = await openMeds(payload, { inApp: true });
  assert.ok(!buttonByText(root, "列印用藥清單"),
    "App 內 window.print 不作用，不得擺一顆沒反應的按鈕");
  assert.ok(root.textContent.includes("先按上方「匯出單檔 HTML」"),
    "App 內應顯示導流說明");
  assert.equal(printCalls.length, 0);
  // 對照：瀏覽器頂層（無 frameElement）有按鈕、無導流說明
  const plain = await openMeds(payload);
  assert.ok(buttonByText(plain.root, "列印用藥清單"));
  assert.ok(!plain.root.textContent.includes("先按上方「匯出單檔 HTML」"));
});

/* ===== 現用與過往分區、看診摘要卡（change clinic-visit-view T5／T6） =====
   日期相對於真實今天生成：判定內部取 Date.now()（匯出的單檔 HTML 隔幾天
   打開時要算那天的事實），寫死絕對日期的向量會隨時間漂移。 */
const isoAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const CURRENT = med(4, { drug_zh: "現用藥丁錠", ingredient: "成分丁",
  date: isoAgo(5), days_supply: 30 });
const OLD = med(5, { drug_zh: "舊藥戊錠", ingredient: "成分戊",
  date: isoAgo(730), days_supply: 28 });
const NO_DAYS = med(6, { drug_zh: "無日數藥己錠", ingredient: "成分己",
  date: isoAgo(3), days_supply: null });

test("列印清單：分「目前在吃」與「過往」，現用區有剩餘天數", async () => {
  const base = await basePayload();
  const { root } = await openMeds(payloadWithMeds(base, [CURRENT, OLD]));
  const text = sheetOf(root).textContent;
  assert.ok(text.includes("目前在吃（1）"), `缺現用區：${text.slice(0, 400)}`);
  assert.ok(text.includes("過往（1）"), `缺過往區：${text.slice(0, 400)}`);
  assert.ok(text.includes("現用藥丁錠") && text.includes("25 天"),
    `現用藥應列在現用區並顯示剩餘天數：${text}`);
  assert.ok(text.includes("舊藥戊錠"), "兩年前的藥應列在過往區");
  assert.ok(text.indexOf("現用藥丁錠") < text.indexOf("舊藥戊錠"),
    "現用區必須排在過往區之前（診間先看的是現在在吃什麼）");
});

test("列印清單：缺給藥日數者歸過往並標註", async () => {
  const base = await basePayload();
  const { root } = await openMeds(payloadWithMeds(base, [CURRENT, NO_DAYS]));
  const text = sheetOf(root).textContent;
  assert.ok(text.includes("無日數藥己錠"), "缺項");
  assert.ok(text.includes("無給藥日數"), `缺無給藥日數標註：${text}`);
  assert.ok(text.includes("目前在吃（1）") && text.includes("過往（1）"),
    "缺給藥日數者 MUST NOT 進現用區");
});

test("列印清單：頁首含資料截止日", async () => {
  const base = await basePayload();
  const p = payloadWithMeds(base, [CURRENT]);
  p.meta.date_max = isoAgo(12);
  const { root } = await openMeds(p);
  assert.ok(sheetOf(root).textContent.includes(`資料截止 ${isoAgo(12)}`),
    "頁首缺資料截止日");
});

test("摘要卡：按鈕在就醫分頁，列印時只有摘要卡是作用中", async () => {
  const base = await basePayload();
  const { root, flush, printCalls } = await openTab(
    payloadWithMeds(base, [CURRENT]), "就醫");
  const btn = buttonByText(root, "列印看診摘要卡");
  assert.ok(btn, "缺「列印看診摘要卡」按鈕");
  btn.dispatch("click");
  await flush();
  assert.deepEqual(printCalls, [["print-clinic"]],
    "列印當下只有摘要卡該是作用中（用藥清單不得同時進入列印輸出）");
});

test("摘要卡：內容為診間視角的精簡版", async () => {
  const base = await basePayload();
  const { root } = await openTab(payloadWithMeds(base, [CURRENT, OLD]), "就醫");
  const sheet = findAll(root, (el) => el.getAttribute?.("id") === "print-clinic")[0];
  assert.ok(sheet, "缺摘要卡 DOM");
  const text = sheet.textContent;
  assert.ok(text.includes("看診摘要卡"), "缺標題");
  assert.ok(text.includes("成員：測試成員"), "缺成員名");
  assert.ok(text.includes("現用藥丁錠") && text.includes("25 天"),
    `摘要卡缺現用藥：${text.slice(0, 400)}`);
  assert.ok(!text.includes("舊藥戊錠"), "摘要卡不該列已停用的藥");
  assert.ok(text.includes("本清單僅為就醫溝通輔助，不含醫療判斷"), "缺免責語");
});

test("摘要卡：EPUB 不顯示按鈕，App 內顯示導流說明", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [CURRENT]);
  const epub = await openTab(payload, "就醫", { epub: true });
  assert.ok(!buttonByText(epub.root, "列印看診摘要卡"),
    "EPUB 旗標下不該渲染列印按鈕");
  assert.ok(!epub.root.textContent.includes("要列印看診摘要卡"),
    "EPUB 也不該顯示導流說明");

  const inApp = await openTab(payload, "就醫", { inApp: true });
  assert.ok(!buttonByText(inApp.root, "列印看診摘要卡"),
    "App 內 window.print 不作用，不得擺一顆沒反應的按鈕");
  assert.ok(inApp.root.textContent.includes("要列印看診摘要卡"),
    "App 內應顯示導流說明");
});
