// 用藥卡適應症區塊的真渲染守衛（change drug-info-and-lab-refband，T3/design D3）。
// 沿用 viewer_render／sleep_render 的 vm sandbox 手法跑 vendored preact + app.js，
// 以健保 payload 為底、把 medications 換成涵蓋各樣態的 fixture：
//   (a) 長適應症（>120 字）＋用法用量＋有效許可證
//   (b) 短適應症（≤120 字）、無用法用量
//   (c) 已註銷許可證
//   (d) 舊快取（無 indication 鍵）
// 斷言的是使用者看得到的文字與可點的切換元素，不是實作細節。
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

// 12 字 × 10 = 120 字，正好等於截斷門檻；尾段另給可辨識標記
const LONG_HEAD = "本品登記適應症原文前段".padEnd(12, "＿").repeat(10);
const LONG_TAIL = "尾段辨識標記";
const LONG_INDICATION = LONG_HEAD + LONG_TAIL;
const SHORT_INDICATION = "短適應症原文，未達截斷門檻。";

async function basePayload() {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-medind-"));
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

/* 一筆處方列（欄位名與 provider 的 medications 列同形） */
function med(i, extra) {
  return { id: 900 + i, encounter_id: 1, order_code: `XX0000000${i}`,
    order_name: `原始醫囑${i}`, total_qty: 30, days_supply: 30, tooth_name: null,
    section_hint: "r5", date: "2026-05-01", facility_name: "測試院所",
    drug_zh: `測試藥${i}`, ingredient: `成分${i}`, leaflet_url: null, ...extra };
}

/* base payload 換上指定的 medications，並帶許可證資料集版本日期 */
function payloadWithMeds(base, meds, { licenseUpdatedAt = "2026-08-19" } = {}) {
  const p = JSON.parse(JSON.stringify(base));
  p.medications = meds;
  p.meds_by_enc = {};
  p.meta.drug_cache = { updated_at: "2026-08-19", count: meds.length };
  if (licenseUpdatedAt) p.meta.drug_cache.license_updated_at = licenseUpdatedAt;
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

const buttonByText = (root, label) => findAll(root,
  (el) => el.localName === "button" && el.textContent === label
    && (el.listeners.click || []).length)[0];

const medHead = (root, name) => findAll(root, (el) => el.localName === "div"
  && String(el.getAttribute?.("class") || "").includes("evhead")
  && el.textContent.includes(name))[0];

/* 開到用藥分頁並展開指定藥品的卡片，回傳 { root, flush } */
async function openMedCard(payload, name) {
  const { root, flush } = renderViewer(payload);
  await flush();
  const tab = buttonByText(root, "用藥");
  assert.ok(tab, "找不到用藥分頁按鈕");
  tab.dispatch("click");
  await flush();
  const head = medHead(root, name);
  assert.ok(head, `找不到用藥卡標頭：${name}`);
  head.dispatch("click");
  await flush();
  assert.ok(!root.textContent.includes("分頁載入失敗"),
    `用藥分頁落入錯誤邊界：${root.textContent.slice(0, 300)}`);
  return { root, flush };
}

test("長適應症：先顯示前 120 字＋顯示全部，可展開全文再收合", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [med(1,
    { indication: LONG_INDICATION, usage_text: "測試用法用量甲", license_status: "" })]);
  assert.ok(LONG_HEAD.length === 120 && LONG_INDICATION.length > 120,
    `fixture 長度不符：head=${LONG_HEAD.length} full=${LONG_INDICATION.length}`);
  const { root, flush } = await openMedCard(payload, "測試藥1");

  let text = root.textContent;
  assert.ok(text.includes("官方登記適應症原文（2026-08-19）"),
    "缺標題與許可證資料集版本日期");
  assert.ok(text.includes(`${LONG_HEAD}…`), "缺截斷版（前 120 字＋刪節號）");
  assert.ok(!text.includes(LONG_TAIL), "摺疊狀態不該渲染全文尾段");
  const more = buttonByText(root, "顯示全部");
  assert.ok(more, "缺「顯示全部」切換元素");

  more.dispatch("click");
  await flush();
  text = root.textContent;
  assert.ok(text.includes(LONG_INDICATION), "展開後應見全文");
  assert.ok(!text.includes(`${LONG_HEAD}…`), "展開後不該留著刪節號");
  const less = buttonByText(root, "收合");
  assert.ok(less, "展開後缺收合切換");

  less.dispatch("click");
  await flush();
  assert.ok(!root.textContent.includes(LONG_TAIL), "收合後應回到截斷版");
});

test("短適應症（≤120 字）：直接全文、無顯示全部切換", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [med(2,
    { indication: SHORT_INDICATION, license_status: "" })]);
  const { root } = await openMedCard(payload, "測試藥2");
  assert.ok(root.textContent.includes(SHORT_INDICATION), "短適應症應直接全文");
  assert.equal(buttonByText(root, "顯示全部"), undefined,
    "未達門檻不該出現「顯示全部」");
});

test("許可證已註銷：適應症照常顯示並附中性註記", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [med(3,
    { indication: SHORT_INDICATION, license_status: "已註銷" })]);
  const { root } = await openMedCard(payload, "測試藥3");
  const text = root.textContent;
  assert.ok(text.includes(SHORT_INDICATION), "已註銷仍應顯示適應症原文");
  assert.ok(text.includes("此藥品許可證已註銷"), "缺許可證狀態註記");
  assert.ok(text.includes("歷史處方仍可對照品項資訊"), "缺中性語氣補述");
});

test("許可證有效（空字串）：不出現狀態註記", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [med(4,
    { indication: SHORT_INDICATION, license_status: "" })]);
  const { root } = await openMedCard(payload, "測試藥4");
  assert.ok(!root.textContent.includes("此藥品許可證"),
    "空字串＝有效，不該註記狀態");
});

test("舊快取無適應症欄位：卡片正常，無適應症區塊", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [med(5, {})], { licenseUpdatedAt: null });
  assert.equal("indication" in payload.medications[0], false, "fixture 應無 indication 鍵");
  const { root } = await openMedCard(payload, "測試藥5");
  const text = root.textContent;
  assert.ok(text.includes("測試藥5") && text.includes("成分5"),
    "商品名與成分應照常顯示");
  assert.ok(!text.includes("官方登記適應症原文"), "無適應症時不該留區塊");
});

test("用法用量：有值才出現原文段", async () => {
  const base = await basePayload();
  const withUsage = payloadWithMeds(base, [med(6,
    { indication: SHORT_INDICATION, usage_text: "測試用法用量乙", license_status: "" })]);
  const a = await openMedCard(withUsage, "測試藥6");
  assert.ok(a.root.textContent.includes("用法用量（原文）：測試用法用量乙"),
    "有值時缺用法用量段");

  const noUsage = payloadWithMeds(base, [med(7,
    { indication: SHORT_INDICATION, usage_text: null, license_status: "" })]);
  const b = await openMedCard(noUsage, "測試藥7");
  assert.ok(!b.root.textContent.includes("用法用量（原文）"),
    "無值不該留空段");
});

test("許可證資料集版本日期缺：標題不帶括號", async () => {
  const base = await basePayload();
  const payload = payloadWithMeds(base, [med(8,
    { indication: SHORT_INDICATION, license_status: "" })], { licenseUpdatedAt: null });
  const { root } = await openMedCard(payload, "測試藥8");
  const text = root.textContent;
  assert.ok(text.includes("官方登記適應症原文"), "缺標題");
  assert.ok(!text.includes("官方登記適應症原文（"), "無日期時不該有括號");
});
