// 睡眠呼吸分頁的真渲染守衛（change cpap-sleep-therapy 第 5 組）。
// 沿用 viewer_render 的 vm sandbox 手法：跑 vendored preact + app.js 真渲染。
// 重點有二：(1) 有 CPAP 資料時各區塊確實出現；(2) 沒有 CPAP 資料時
// 不留下任何空分頁或空卡片（proposal 的相容性要求）。
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
import { resmedEdfAdapter } from "../../src/adapters/resmed_edf.js";
import { buildPayload } from "../../src/provider/payload.js";
import { makeDocument, findAll } from "../helpers/mini_dom.mjs";
import { BATCH_SOURCES } from "../helpers/batch_vector.mjs";
import { makeEdf, annotationRecord, STR_SIGNALS, SAD_SIGNALS, EVE_SIGNALS }
  from "../helpers/make_edf.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;
const ASSETS = new URL("../../src/viewer/assets/", import.meta.url);
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

const memSource = (bytes, name) => ({
  name, size: bytes.length,
  async readAt(o, l) { return bytes.subarray(o, o + l); },
  async *stream() { yield bytes; },
});
const textSource = (t, n) => memSource(new TextEncoder().encode(t), n);

function day({ ahi = 24, ai = 24, hi = 0, dur = 170 } = {}) {
  const map = {
    "Mask On": [600], "Mask Off": [780], "Mask Dur": [dur],
    "Therapy Pres Me": [372], "Leak 95": [5], AHI: [ahi], AI: [ai], HI: [hi],
  };
  return STR_SIGNALS.map(s => map[s.label] ?? []);
}

// today 取在資料之後，讓預設區間邏輯走「全部」（資料已停數年）
const TODAY = "2026-08-13";

async function cpapPayload({ withOximetry = false } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-sleep-"));
  const d = new NodeDriver(path.join(tmp, "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  // 併一份健保資料，確保 CPAP 區塊與既有分頁並存時都正常
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
      name: "nhi_sample.json" },
    d, null, { labEntries: LAB_ENTRIES, profileId: pid });

  const entries = [
    { relPath: "Identification.tgt",
      source: textSource("#PNA     S9_AutoSet\n", "Identification.tgt") },
    { relPath: "STR.edf", source: memSource(
      makeEdf(STR_SIGNALS, [day(), day({ ahi: 51 }), day({ ahi: 6 })],
        { startDate: "27.03.22" }), "STR.edf") },
    { relPath: "DATALOG/20220327_203533_EVE.edf", source: memSource((() => {
      const byteLen = EVE_SIGNALS[0].nsamp * 2;
      const evs = [
        { onset: 115, duration: 11, label: "Obstructive Apnea" },
        { onset: 900, duration: 14, label: "Central Apnea" },
      ];
      const recs = evs.map(e => annotationRecord(byteLen, 0, [e]));
      return makeEdf(EVE_SIGNALS, recs.map(() => [[]]),
        { reserved: "EDF+D", recordDuration: 0, annotationBytes: { 0: recs },
          startDate: "27.03.22", startTime: "20.35.33" });
    })(), "e.edf") },
  ];
  if (withOximetry) {
    entries.push({ relPath: "DATALOG/20220327_203536_SAD.edf", source: memSource(
      makeEdf(SAD_SIGNALS, [[new Array(60).fill(70), new Array(60).fill(93)]],
        { recordDuration: 60, startDate: "27.03.22", startTime: "20.35.36" }), "s.edf") });
  }
  await resmedEdfAdapter.importSourceSet({ rootName: "resmed", entries }, d, null,
    { profileId: pid });

  const p = await buildPayload(d, { profileId: pid,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: null, today: TODAY });
  await d.close();
  return p;
}

async function nhiOnlyPayload() {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-sleep0-"));
  const d = new NodeDriver(path.join(tmp, "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
      name: "nhi_sample.json" },
    d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  const p = await buildPayload(d, { profileId: pid,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: null, today: TODAY });
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
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["vendor/preact.min.js", "vendor/hooks.umd.js",
    "vendor/htm.umd.js", "app.js"]) {
    vm.runInContext(readFileSync(new URL(f, ASSETS), "utf-8"), sandbox, { filename: f });
  }
  const flush = () => new Promise((r) => setTimeout(r, 5));
  return { root, flush };
}

const tabButton = (root, label) => findAll(root,
  (el) => el.localName === "button" && el.textContent === label
    && (el.listeners.click || []).length)[0];

test("有 CPAP 資料：分頁出現，各區塊渲染成功且不落入錯誤邊界", async () => {
  const payload = await cpapPayload({ withOximetry: true });
  assert.equal(payload.cpap.daily.length, 3, "payload 帶有每日摘要");
  const { root, flush } = renderViewer(payload);
  await flush();

  const btn = tabButton(root, "睡眠呼吸");
  assert.ok(btn, "有 CPAP 資料時必須出現睡眠呼吸分頁");
  btn.dispatch("click");
  await flush();
  const text = root.textContent;
  assert.ok(!text.includes("分頁載入失敗"), `落入錯誤邊界：${text.slice(0, 200)}`);
  for (const marker of ["每晚 AHI", "使用時數", "漏氣（95 百分位）",
    "送氣壓力（95 百分位）", "睡眠期血氧", "每晚事件數", "逐筆事件紀錄"]) {
    assert.ok(text.includes(marker), `缺區塊「${marker}」`);
  }
  assert.ok(text.includes("S9_AutoSet"), "顯示機型");
  assert.ok(text.includes("日期為入睡當晚"), "標注日期語意（正午邊界）");
  // 逐筆按晚定位（D4）＋**展開才建 DOM**：摺疊起來也全部渲染的話，上限情境
  // 會有 8,000 個 <tr> 掛在頁面上。此處釘住「預設零逐筆列、展開後才出現」。
  const timeCell = () => findAll(root, (el) => el.localName === "td"
    && /^\d{2}:\d{2}:\d{2}$/.test(el.textContent));
  // mini_dom 走 setAttribute，class 要用 getAttribute 取（沒有 className）
  const heads = (re) => findAll(root, (el) => el.localName === "div"
    && String(el.getAttribute?.("class") || "").includes("evhead")
    && re.test(el.textContent));
  // 預設全收：只有年份那幾行，沒有晚的標頭也沒有任何逐筆列。少了這層，
  // 光是晚的標頭就會隨年數線性增長（十年約 3,650 行）。
  const yearHeads = heads(/^\s*\d{4} 年/);
  assert.ok(yearHeads.length > 0, "逐筆事件必須先以年分層");
  assert.ok(yearHeads.every((h) => /\d+ 晚/.test(h.textContent)
    && /\d+ 筆/.test(h.textContent)), "年份標頭要顯示晚數與筆數");
  assert.equal(heads(/\d{4}-\d{2}-\d{2}/).length, 0, "未展開年份時不得列出每晚標頭");
  assert.equal(timeCell().length, 0, "未展開時不得渲染任何逐筆列");

  yearHeads[0].dispatch("click");
  await flush();
  const nightHeads = heads(/\d{4}-\d{2}-\d{2}/);
  assert.ok(nightHeads.length > 0, "展開年份後要列出該年的每一晚");
  assert.equal(timeCell().length, 0, "展開年份還不該渲染逐筆列");

  nightHeads[0].dispatch("click");
  await flush();
  assert.ok(timeCell().length > 0, "展開某一晚後該晚的逐筆列才出現");
  assert.ok(root.textContent.includes("Obstructive Apnea"), "逐筆明細列出事件類型");
  // 折線有實際座標（不是空圖）
  const circles = findAll(root, (el) => el.localName === "circle");
  const polylines = findAll(root, (el) => el.localName === "polyline");
  assert.ok(polylines.length > 0 || circles.length > 0, "AHI 圖沒有畫出任何內容");
});

test("有 CPAP 資料：總覽卡與測量頁 AHI 圖出現", async () => {
  const payload = await cpapPayload();
  const { root, flush } = renderViewer(payload);
  await flush();
  assert.ok(root.textContent.includes("睡眠呼吸（最近一晚）"), "總覽缺 CPAP 卡");
  assert.ok(root.textContent.includes("睡眠呼吸 3 晚"), "匯入紀錄摘要缺 CPAP 晚數");

  // 「趨勢頁的睡眠呼吸對照」requirement：分頁改版後由測量分頁承載
  tabButton(root, "測量").dispatch("click");
  await flush();
  const text = root.textContent;
  assert.ok(!text.includes("分頁載入失敗"), "測量頁落入錯誤邊界");
  assert.ok(text.includes("每晚 AHI（睡眠呼吸）"), "測量頁缺 AHI 對照圖");
  assert.ok(text.includes("可直接同期對照"), "缺同期對照說明");
});

test("沒有 CPAP 資料：不出現分頁、總覽卡與對照圖（不留空區塊）", async () => {
  const payload = await nhiOnlyPayload();
  assert.deepEqual(payload.cpap.daily, [], "payload 的 CPAP 區塊為空");
  const { root, flush } = renderViewer(payload);
  await flush();

  assert.equal(tabButton(root, "睡眠呼吸"), undefined,
    "沒有 CPAP（也沒有 Apple 睡眠）資料時不得出現睡眠呼吸分頁");
  assert.ok(!root.textContent.includes("睡眠呼吸（最近一晚）"),
    "沒有 CPAP 資料時不得出現總覽卡");

  tabButton(root, "測量").dispatch("click");
  await flush();
  const text = root.textContent;
  assert.ok(!text.includes("分頁載入失敗"), "測量頁落入錯誤邊界");
  assert.ok(!text.includes("每晚 AHI"), "沒有 CPAP 資料時測量頁不得出現 AHI 圖");
  tabButton(root, "檢驗").dispatch("click");
  await flush();
  assert.ok(root.textContent.includes("全部項目"), "既有檢驗內容仍在");
});

test("沒有血氧資料：說明原因而不是畫一張空圖", async () => {
  // 真實素材的形狀：有每日摘要與事件，但機器未接血氧模組
  const payload = await cpapPayload({ withOximetry: false });
  assert.deepEqual(payload.cpap.oximetry, []);
  const { root, flush } = renderViewer(payload);
  await flush();
  tabButton(root, "睡眠呼吸").dispatch("click");
  await flush();
  const text = root.textContent;
  assert.ok(text.includes("此來源沒有血氧資料"), "缺空狀態說明");
  assert.ok(text.includes("外接血氧模組"), "未說明原因");
});

test("匯入紀錄：多檔來源摺疊成一行，可展開看逐檔", async () => {
  const payload = await cpapPayload({ withOximetry: true });
  // payload 保留逐檔追溯（design D2）
  const cpapDocs = payload.meta.sources.filter(s => s.adapter === "resmed_edf");
  assert.equal(cpapDocs.length, 3, "payload 保留每個被解析的檔");

  const { root, flush } = renderViewer(payload);
  await flush();
  const text = root.textContent;
  assert.ok(text.includes("3 個檔案"), "多檔來源未摺疊成一行");
  assert.ok(text.includes("CPAP（ResMed）"), "來源欄未顯示中文來源名");
  // 摺疊後逐檔仍在 DOM 內（details 展開即見）
  assert.ok(text.includes("STR.edf"), "展開內容缺逐檔檔名");
  // 合計統計：三個檔的新增筆數應被加總後呈現
  assert.ok(text.includes("睡眠每日摘要 +3"), `缺合計統計：${text.slice(0, 300)}`);
});

test("測量頁時間域涵蓋 CPAP 日期（不納入的話新圖會被壓到邊界）", async () => {
  // CPAP 資料（2022-03）早於健保 fixture 的任何日期。若測量頁 useRange 的
  // groups 沒有納入 CPAP 序列，共用時間域就不會涵蓋 2022，x 軸刻度也不會
  // 出現該年份，AHI 圖的點會全部被 clamp 到繪圖區左緣。
  const payload = await cpapPayload();
  const others = [
    ...payload.labs.map(l => l.test_date),
    ...(payload.measures["體重"] || []).map(p => p[0]),
    ...payload.encounters.map(e => e.date),
  ].filter(Boolean);
  const cpapEarliest = payload.cpap.daily[0].date;
  assert.ok(others.every(d => d > cpapEarliest),
    `前提不成立：CPAP 起始 ${cpapEarliest} 必須早於其他所有資料`);

  const ticks = async (p) => {
    const { root, flush } = renderViewer(p);
    await flush();
    tabButton(root, "測量").dispatch("click");
    await flush();
    return findAll(root, (el) => el.localName === "text").map(el => el.textContent);
  };
  // 納入 CPAP 後時間域自 2022 起，會跨過 2023 的年界；只有健保資料時
  // （2025 起）不可能出現 2023 刻度。兩個方向都驗，避免斷言恆真。
  const withCpap = await ticks(payload);
  assert.ok(withCpap.some(t => t === "2023"),
    `時間域未納入 CPAP 日期，x 軸缺 2023 刻度：${[...new Set(withCpap)].join(",")}`);
  const without = await ticks(await nhiOnlyPayload());
  assert.ok(!without.some(t => t === "2023"),
    "前提不成立：沒有 CPAP 時本來就不該出現 2023 刻度");
});

// task 6.3：匯出的單檔 HTML 必須涵蓋新區塊。檢視器與匯出共用同一份
// app.js 與 payload，但仍要驗證組裝後的產物真的帶著它們（契約若被改窄，
// 或組裝時漏掉區塊，只會在使用者打開匯出檔時才發現）。
import { assemble, validateShape, SIZE_LIMIT } from "../../src/provider/assemble.js";

test("匯出單檔 HTML：涵蓋 CPAP 區塊且通過契約與體積門檻", async () => {
  const payload = await cpapPayload({ withOximetry: true });
  assert.deepEqual(validateShape(payload), [], "payload 不符契約");

  const assets = {
    appJs: readFileSync(new URL("app.js", ASSETS), "utf-8"),
    css: readFileSync(new URL("style.css", ASSETS), "utf-8"),
    vendor: ["preact.min.js", "hooks.umd.js", "htm.umd.js"].map(
      f => readFileSync(new URL(`vendor/${f}`, ASSETS), "utf-8")),
  };
  const html = assemble(payload, assets);
  assert.ok(html.length < SIZE_LIMIT, "超出單檔體積門檻");

  // 嵌入資料帶著 CPAP（注意 assemble 會跳脫 < > &，故比對鍵名而非整段）
  const embedded = JSON.parse(
    html.match(/<script type="application\/json" id="hwb-data">(.*?)<\/script>/s)[1]
      .replaceAll("\\u003c", "<").replaceAll("\\u003e", ">").replaceAll("\\u0026", "&"));
  assert.equal(embedded.cpap.daily.length, payload.cpap.daily.length);
  assert.ok(embedded.cpap.events.length > 0, "匯出檔缺呼吸事件");
  // 檢視程式碼帶著睡眠分頁
  assert.ok(html.includes("睡眠呼吸"), "匯出檔的程式碼缺睡眠呼吸分頁");
  assert.ok(html.includes("此來源沒有血氧資料"), "匯出檔缺血氧空狀態文案");
});

test("匯出單檔 HTML：沒有 CPAP 資料時仍是合法產物", async () => {
  const payload = await nhiOnlyPayload();
  assert.deepEqual(validateShape(payload), [],
    "沒有 CPAP 資料時 payload 仍須符合契約（cpap 為空區塊而非缺鍵）");
  const assets = {
    appJs: readFileSync(new URL("app.js", ASSETS), "utf-8"),
    css: readFileSync(new URL("style.css", ASSETS), "utf-8"),
    vendor: ["preact.min.js", "hooks.umd.js", "htm.umd.js"].map(
      f => readFileSync(new URL(`vendor/${f}`, ASSETS), "utf-8")),
  };
  const html = assemble(payload, assets);
  assert.ok(html.length < SIZE_LIMIT);
});

// 批次摺疊的檢視層側（change viewer-and-history-refinement D7）：與 App 端的
// groupDocsByBatch 餵同一組向量。兩份實作必然分開（此處的 groupSources 在
// IIFE 內、沙箱外取不到，且該檔自包含不能 import），所以用共用向量比對語意。
test("匯入紀錄批次摺疊：同一組向量在檢視層得到相同分組與合計", async () => {
  const payload = await cpapPayload();
  payload.meta.sources = BATCH_SOURCES;
  const { root, flush } = renderViewer(payload);
  await flush();
  const text = root.textContent;

  // 多檔批各自摺疊成一列；單檔批直接顯示檔名（不產生 summary）
  const summaries = findAll(root, (el) => el.localName === "summary")
    .map((el) => el.textContent);
  assert.deepEqual(summaries, ["3 個檔案", "2 個檔案", "3 個檔案"],
    `多檔批必須各摺疊為一列，實際：${JSON.stringify(summaries)}`);
  assert.ok(text.includes("輸出.xml"), "單檔批直接顯示檔名");
  assert.ok(text.includes("健康存摺醫療類_1.json"), "單檔批（缺統計）也要列出");

  // 逐檔仍在 DOM（payload 保留逐檔追溯，摺疊只做在檢視層）
  assert.ok(text.includes("DATALOG/20230612_EVE.edf"));
  assert.ok(text.includes("DATALOG/20230701_EVE.edf"));

  // 合計＝組內加總，與 App 端 EXPECTED_BATCHES 的 inserted／dupTotal 對齊：
  // 批 A 的 cpap_events 是 60+20=80（STR 列不含事件），重複略過 50
  assert.ok(text.includes("呼吸事件 +80"),
    "第一批的事件合計必須是組內加總（60+20）");
  assert.ok(text.includes("重複略過 50"), "重複略過也要合計");
  assert.ok(text.includes("睡眠每日摘要 +120"));
  // 批 D 缺統計：必須看得出來，不能顯示成新增 0 筆
  assert.ok(text.includes("（早期匯入，無統計）"),
    "缺統計的批要標示，不得算成 0");
  // 批 E：組內有一檔缺統計，其餘兩檔的合計 MUST 照常呈現（2026-08-14 紅隊）
  assert.ok(text.includes("睡眠每日摘要 +10") && text.includes("呼吸事件 +5"),
    "一個檔缺統計不得抹掉同批其他檔的筆數");
  assert.ok(text.includes("另有 1 個檔案無統計"),
    "仍要註明有幾個檔案沒有統計");
});

/* ---- Apple 睡眠與呼吸（change display-revamp-bands-cleanup T4） ---- */
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { nodeFileSource } from "../helpers/node_source.mjs";

async function appleSleepPayload() {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-asleep-"));
  const d = new NodeDriver(path.join(tmp, "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_watch_sample.xml`), d, null,
    { profileId: pid });
  const p = await buildPayload(d, { profileId: pid,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: null, today: TODAY });
  await d.close();
  return p;
}

test("只有 Apple 睡眠沒有 CPAP：分頁存在，只出現 Apple 區塊", async () => {
  const payload = await appleSleepPayload();
  assert.deepEqual(payload.cpap.daily, [], "前提：無 CPAP");
  assert.ok(payload.sleep_daily.length > 0, "前提：有睡眠彙總");
  const { root, flush } = renderViewer(payload);
  await flush();
  const tab = tabButton(root, "睡眠呼吸");
  assert.ok(tab, "有 Apple 睡眠彙總時分頁必須存在");
  tab.dispatch("click");
  await flush();
  const text = root.textContent;
  assert.ok(!text.includes("分頁載入失敗"), "落入錯誤邊界");
  assert.ok(text.includes("睡眠時數"), "缺睡眠時數區塊");
  assert.ok(text.includes("入睡起始的日曆日"), "缺日期語意標示");
  assert.ok(text.includes("呼吸速率（睡眠期間）"), "缺呼吸速率區塊");
  assert.ok(text.includes("血氧低點"), "缺血氧低點區塊");
  assert.ok(!text.includes("每晚 AHI"), "無 CPAP 時不得渲染 AHI");
  assert.ok(!text.includes("使用時數與 CPAP"), "無 CPAP 時不得渲染對照圖");
  assert.ok(!text.includes("漏氣"), "無 CPAP 時不得渲染 CPAP 圖");
});

test("睡眠分項：未知識別字顯示原名且不計入總睡眠", async () => {
  const payload = await appleSleepPayload();
  // 注入一個未知識別字（形狀同真實 extra_json：識別字→分鐘）
  payload.sleep_daily[0][1]["HKCategoryValueSleepAnalysisSomethingNew"] = 100;
  const { root, flush } = renderViewer(payload);
  await flush();
  tabButton(root, "睡眠呼吸").dispatch("click");
  await flush();
  const btn = findAll(root, (el) => el.localName === "button"
    && el.textContent.includes("顯示分項"))[0];
  assert.ok(btn, "缺分項切換");
  btn.dispatch("click");
  await flush();
  const text = root.textContent;
  assert.ok(text.includes("HKCategoryValueSleepAnalysisSomethingNew"),
    "未知識別字要以原名列出，不得丟棄");
  assert.ok(text.includes("躺床"), "已知識別字要轉中文");
  // 總睡眠不含未知識別字：2024-02-01 手錶 AsleepCore 300 分 → 5 小時
  const sleepSvgTitles = findAll(root, (el) => el.localName === "title")
    .map((t) => t.textContent).filter((t) => t.includes("總睡眠"));
  assert.ok(sleepSvgTitles.some((t) => t.includes("2024-02-01：5")),
    `總睡眠應為 5 小時（不含未知識別字的 100 分），實際 ${JSON.stringify(sleepSvgTitles)}`);
});

test("CPAP＋Apple 睡眠但日期無重疊：兩線對照圖在、比值不顯示", async () => {
  const payload = await cpapPayload();
  const apple = await appleSleepPayload();
  payload.sleep_daily = apple.sleep_daily;        // CPAP 2022-03 vs 睡眠 2024-02
  payload.measure_bands = apple.measure_bands;
  const { root, flush } = renderViewer(payload);
  await flush();
  tabButton(root, "睡眠呼吸").dispatch("click");
  await flush();
  const text = root.textContent;
  assert.ok(text.includes("睡眠時數與 CPAP 使用對照"), "缺對照圖");
  assert.ok(!text.includes("使用時數佔睡眠時數比例"),
    "無重疊日期時不得顯示比值（不顯示 0% 或錯誤值）");
});

test("CPAP＋Apple 睡眠重疊：比值與重疊晚數隨區間實算", async () => {
  const payload = await cpapPayload();
  // 睡眠與 CPAP（2022-03-27 起 3 晚）重疊：420／400／380 分鐘
  payload.sleep_daily = [
    ["2022-03-27", { "HKCategoryValueSleepAnalysisAsleepUnspecified": 420 }],
    ["2022-03-28", { "HKCategoryValueSleepAnalysisAsleepUnspecified": 400 }],
    ["2022-03-29", { "HKCategoryValueSleepAnalysisAsleepUnspecified": 380 }],
  ];
  const { root, flush } = renderViewer(payload);
  await flush();
  tabButton(root, "睡眠呼吸").dispatch("click");
  await flush();
  const text = root.textContent;
  const m = text.match(/使用時數佔睡眠時數比例約\s*(\d+)%/);
  assert.ok(m, "重疊時要顯示比值");
  // CPAP 每晚 170 分 × 3 ÷ 睡眠 (420+400+380) 分 ≈ 42%（±1 容捨入）
  assert.ok(Math.abs(Number(m[1]) - 43) <= 2, `比值應約 42-43%，實際 ${m[1]}%`);
  assert.match(text, /CPAP 3 晚、Apple 睡眠 3 天/, "缺重疊晚數標示");
  assert.ok(text.includes("超過 100%"), "缺資料完整性說明");
});

test("帶狀渲染：面、逐點三值提示、y 域涵蓋 min-max", async () => {
  const payload = await appleSleepPayload();
  const { root, flush } = renderViewer(payload);
  await flush();
  tabButton(root, "測量").dispatch("click");
  await flush();
  // 心率圖：帶為 polygon（fixture 2024-02-01 三筆 62/75/118＋手機 70 →
  // 合併後 min62 max118 avg81.25）
  const hrSvg = findAll(root, (el) => el.localName === "svg")
    .find((s) => findAll(s, (e) => e.localName === "text")
      .some((t) => t.textContent === "心率"));
  assert.ok(hrSvg, "找不到心率帶狀圖");
  const polys = findAll(hrSvg, (e) => e.localName === "polygon");
  assert.ok(polys.length >= 1, "帶（min-max 面）沒有畫");
  const titles = findAll(hrSvg, (e) => e.localName === "title")
    .map((t) => t.textContent);
  assert.ok(titles.some((t) => /心率 2024-02-01：81\.25（62-118）/.test(t)),
    `逐點提示要含 avg（min-max）三值，實際 ${JSON.stringify(titles.slice(0, 3))}`);
  // y 域涵蓋 max=118：y 軸最高標籤 ≥ 118
  const yLabels = findAll(hrSvg, (e) => e.localName === "text")
    .filter((t) => Number(t.getAttribute("x")) < 48)
    .map((t) => parseFloat(t.textContent)).filter((v) => !Number.isNaN(v));
  assert.ok(Math.max(...yLabels) >= 118, `y 軸上界 ${Math.max(...yLabels)} 應涵蓋帶的 max 118`);
});
