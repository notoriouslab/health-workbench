// Viewer 全分頁渲染守衛（2026-08-11 v0.5.0 冒煙發現：只匯健保時
// 趨勢頁 LineChart 對空序列拋錯，整個 preact 樹死掉，所有分頁空白）。
// 用最小 DOM shim 跑 vendored preact 真渲染：對「單一來源」payload
// （健保 only／Apple only）逐分頁點擊，斷言內容渲染成功且不落入
// 錯誤邊界；再驗證「造訪趨勢後回總覽」不全滅。
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
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { buildPayload } from "../../src/provider/payload.js";
import { nodeFileSource } from "../helpers/node_source.mjs";
import { makeDocument, findAll } from "../helpers/mini_dom.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;
const ASSETS = new URL("../../src/viewer/assets/", import.meta.url);
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

async function singleSourcePayload(kind) {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-vr-"));
  const d = new NodeDriver(path.join(tmp, "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  if (kind === "nhi") {
    await nhiJsonAdapter.importSource(
      { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
        name: "nhi_sample.json" },
      d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  } else {
    await appleHealthAdapter.importSource(
      await nodeFileSource(`${REPO}/tests/fixtures/apple_sample.xml`), d, null,
      { profileId: pid });
  }
  const p = await buildPayload(d, { profileId: pid,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: null, today: "2026-08-11" });
  await d.close();
  return p;
}

/* 在 vm sandbox 中載入 vendor + app.js，回傳 { root, flush } */
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
  for (const f of ["vendor/preact.min.js", "vendor/hooks.umd.js", "vendor/htm.umd.js", "app.js"]) {
    vm.runInContext(readFileSync(new URL(f, ASSETS), "utf-8"), sandbox, { filename: f });
  }
  // preact 重渲染排在 microtask、effects 排在 rAF(=setTimeout)；雙重讓步沖乾淨
  const flush = () => new Promise((r) => setTimeout(r, 5));
  return { root, flush };
}

const tabButton = (root, label) => findAll(root,
  (el) => el.localName === "button" && el.textContent === label
    && (el.listeners.click || []).length)[0];

for (const kind of ["nhi", "apple"]) {
  test(`viewer 單一來源（${kind}）：各分頁渲染皆成功，遍歷後回總覽不全滅`, async () => {
    const payload = await singleSourcePayload(kind);
    const { root, flush } = renderViewer(payload);
    await flush();
    assert.ok(root.textContent.includes("個人健康資料工作台"), "初始渲染失敗");

    // 六分頁（change display-revamp-bands-cleanup）：檢驗與測量取代趨勢；
    // 無資料的分頁也要能渲染（顯示「尚無」而非錯誤邊界）
    const EXPECT = { "總覽": "資料庫與匯入紀錄", "就醫": "全部類型",
      "用藥": "藥品",
      "檢驗": kind === "nhi" ? "全部項目" : "尚無檢驗資料",
      // nhi 也有成健體重（nhi_body），故兩種來源的測量頁都有內容
      "測量": "本頁各圖共用同一時間區間" };
    for (const [label, marker] of Object.entries(EXPECT)) {
      const btn = tabButton(root, label);
      assert.ok(btn, `找不到分頁按鈕：${label}`);
      btn.dispatch("click");
      await flush();
      const text = root.textContent;
      assert.ok(!text.includes("分頁載入失敗"),
        `${label} 落入錯誤邊界：${text.slice(0, 200)}`);
      assert.ok(text.includes(marker), `${label} 內容缺關鍵字「${marker}」`);
    }

    // 症狀回歸：遍歷各分頁之後，總覽必須還活著（渲染樹未死）
    tabButton(root, "總覽").dispatch("click");
    await flush();
    assert.ok(root.textContent.includes("資料庫與匯入紀錄"),
      "遍歷分頁後回總覽全滅（渲染樹已死）");
  });
}

test("viewer 錯誤邊界：單頁拋錯只該頁顯示錯誤，其他分頁不陪葬", async () => {
  const payload = await singleSourcePayload("nhi");
  // 蓄意破壞檢驗頁的資料前提（knowledge 設為 null → Labs 讀取即拋錯），
  // 驗證邊界攔截與換頁復原。
  payload.knowledge = null;
  const { root, flush } = renderViewer(payload);
  await flush();
  tabButton(root, "檢驗").dispatch("click");
  await flush();
  assert.ok(root.textContent.includes("分頁載入失敗"), "錯誤邊界未攔截");
  tabButton(root, "總覽").dispatch("click");
  await flush();
  assert.ok(root.textContent.includes("資料庫與匯入紀錄"), "換頁未復原");
});

// 就醫時間軸依年分組（change viewer-and-history-refinement）：就醫筆數隨年份
// 累積，平鋪的話標頭數量線性增長。只展開一年，其餘只留年份那一行。
// 跳轉定位是這裡最脆的一段：從搜尋／用藥頁點進來的那筆若落在收起來的年份，
// 使用者會看到一片沒有目標的清單。
function payloadWithYears(base) {
  const p = JSON.parse(JSON.stringify(base));
  const mk = (id, date) => ({ id, type: "門診", date, facility_name: `院所${id}`,
    dx_code: null, dx_name: `診斷${id}`, copay: null, nhi_points: null,
    section: "r1", source_index: id, quality_flags: "", source_file: "t.json" });
  // 新→舊，與 provider 的 ORDER BY date DESC 一致
  p.encounters = [mk(901, "2026-05-01"), mk(902, "2026-04-01"),
    mk(903, "2024-03-01")];
  p.meds_by_enc = {};
  p.medications = [];
  return p;
}

const yearHeadsOf = (root) => findAll(root, (el) => el.localName === "div"
  && String(el.getAttribute?.("class") || "").includes("evhead")
  && /^\s*\d{4} 年/.test(el.textContent));

test("就醫時間軸：依年分組，預設只展開最近一年", async () => {
  const base = await singleSourcePayload("nhi");
  const { root, flush } = renderViewer(payloadWithYears(base));
  await flush();
  tabButton(root, "就醫").dispatch("click");
  await flush();

  const years = yearHeadsOf(root).map((el) => el.textContent.trim());
  assert.equal(years.length, 2, `應有 2026 與 2024 兩個年份層：${JSON.stringify(years)}`);
  assert.match(years[0], /2026 年/, "最近一年排在最前");
  assert.match(years[0], /2 筆/);
  assert.match(years[1], /2024 年/);
  const text = root.textContent;
  assert.ok(text.includes("診斷901"), "最近一年預設展開，其就醫列要出現");
  assert.ok(!text.includes("診斷903"), "其他年份預設收起，不得渲染其就醫列");
});

// 註：openYear 初值取自 focus.enc 所在年份，但 focus 是由 App 的 go() 設定的
// 內部狀態，從外部渲染無法直接注入，因此那條路徑只能實機驗（從搜尋或用藥頁
// 點一筆舊年份的就醫，時間軸應開在該年並捲到該筆）。此處驗的是同一層保護的
// 另一半：任一時刻只展開一年，且手動切換能看到其他年的內容。
test("就醫時間軸：同時只展開一年，切換年份可看到該年就醫列", async () => {
  const base = await singleSourcePayload("nhi");
  const { root, flush } = renderViewer(payloadWithYears(base));
  await flush();
  tabButton(root, "就醫").dispatch("click");
  await flush();
  const y2024 = yearHeadsOf(root).find((el) => el.textContent.includes("2024"));
  y2024.dispatch("click");
  await flush();
  assert.ok(root.textContent.includes("診斷903"), "展開 2024 後該年的就醫列要出現");
  assert.ok(!root.textContent.includes("診斷901"),
    "同時只展開一年，2026 應收起");
});
