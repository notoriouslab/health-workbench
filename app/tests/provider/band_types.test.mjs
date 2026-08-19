// 帶狀量測的型別分配與數值守衛（change display-revamp-bands-cleanup T1）。
//
// 型別分配為什麼要釘：帶狀型別誤入中位數組的話，「釋放空間」刪 raw 後
// 該圖會破且沒有任何錯誤訊息（清單機制漏接無聲，同 add-table-playbook
// 教訓）。數值為什麼要獨立直算：不信任彙總表寫入方自己的測試。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { PER_ROW_TYPES, AGGREGATE_TYPES } from "../../src/engine/aggregate.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { nodeFileSource } from "../helpers/node_source.mjs";
import { buildPayload, MEDIAN_TYPES, BAND_TYPES }
  from "../../src/provider/payload.js";

const REPO = new URL("../../..", import.meta.url).pathname;

test("型別分配：MEDIAN_TYPES 與逐筆保留清單全等、BAND_TYPES 是彙總子集", () => {
  assert.deepEqual(MEDIAN_TYPES, PER_ROW_TYPES,
    "中位數組必須恰為逐筆保留清單（帶狀型別混入的話，清理 raw 後圖會破）");
  for (const t of BAND_TYPES) {
    assert.ok(AGGREGATE_TYPES.includes(t),
      `帶狀型別「${t}」必須屬於彙總清單，否則 apple_daily 沒有它的資料`);
  }
  assert.ok(!BAND_TYPES.some((t) => MEDIAN_TYPES.includes(t)),
    "帶狀組與中位數組不得重疊");
});

test("兩端常數同值：embed.py 的 BAND_TYPES 與 MEDIAN_TYPES 定義", () => {
  const py = readFileSync(path.join(REPO, "src/dashboard/embed.py"), "utf-8");
  const m = py.match(/^BAND_TYPES\s*=\s*(\[[^\]]*\])/m);
  assert.ok(m, "embed.py 找不到 BAND_TYPES 定義（改名會使本守衛失效）");
  assert.deepEqual(JSON.parse(m[1]), BAND_TYPES, "兩端 BAND_TYPES 必須同值");
  assert.match(py, /^MEDIAN_TYPES\s*=\s*PER_ROW_TYPES\s*$/m,
    "embed.py 的 MEDIAN_TYPES 必須直接取 PER_ROW_TYPES（全等由建構保證）");
});

async function buildDb(dbPath) {
  const d = new NodeDriver(dbPath);
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  d.pid = pid;
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_watch_sample.xml`),
    d, null, { profileId: pid });
  return d;
}

test("帶狀數值與 raw 直算全等（不信任彙總表既有測試）", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-band-"));
  const d = await buildDb(path.join(tmp, "db.sqlite"));
  const js = await buildPayload(d, { profileId: d.pid, knowledgeEntries: [],
    drugCachePath: null, today: "2026-08-19" });
  for (const t of BAND_TYPES) {
    const direct = await d.select(`
      SELECT substr(start_ts,1,10) d,
             ROUND(AVG(COALESCE(value_normalized, value_numeric)), 2) a,
             MIN(COALESCE(value_normalized, value_numeric)) lo,
             MAX(COALESCE(value_normalized, value_numeric)) hi
      FROM apple_records
      WHERE profile_id=? AND type_zh=?
        AND quality_flags NOT LIKE '%epoch_placeholder_date%'
        AND quality_flags NOT LIKE '%out_of_range%'
        AND COALESCE(value_normalized, value_numeric) IS NOT NULL
      GROUP BY substr(start_ts,1,10) ORDER BY d`, [d.pid, t]);
    assert.deepEqual(js.measure_bands[t],
      direct.map((r) => [r.d, r.a, r.lo, r.hi]),
      `型別「${t}」的帶狀序列與 raw 直算不一致`);
  }
  // 同日多來源（心率含手錶＋手機）合併為單點：day 不得重複
  const days = js.measure_bands["心率"].map((p) => p[0]);
  assert.equal(new Set(days).size, days.length, "帶狀序列出現重複日");
  await d.close();
});

test("睡眠同日多來源：取分鐘合計最大的單一來源，不跨來源相加", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-sleep-"));
  const d = await buildDb(path.join(tmp, "db.sqlite"));
  const js = await buildPayload(d, { profileId: d.pid, knowledgeEntries: [],
    drugCachePath: null, today: "2026-08-19" });
  const byDay = Object.fromEntries(js.sleep_daily);
  // fixture：2024-02-01 手錶（躺床 480＋核心 300）與手機（躺床 400）雙來源
  const day1 = byDay["2024-02-01"];
  assert.ok(day1, "sleep_daily 缺 2024-02-01");
  assert.equal(day1["HKCategoryValueSleepAnalysisInBed"], 480,
    "應取手錶列（合計 780 > 手機 400）；相加成 880 = 雙計");
  assert.equal(day1["HKCategoryValueSleepAnalysisAsleepCore"], 300);
  const days = js.sleep_daily.map((p) => p[0]);
  assert.equal(new Set(days).size, days.length, "sleep_daily 出現重複日");
  await d.close();
});

test("無帶狀資料時鍵仍存在且為空", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-empty-"));
  const d = new NodeDriver(path.join(tmp, "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  const js = await buildPayload(d, { profileId: pid, knowledgeEntries: [],
    drugCachePath: null, today: "2026-08-19" });
  assert.deepEqual(Object.keys(js.measure_bands).sort(),
    [...BAND_TYPES].sort(), "無資料時 measure_bands 仍須含全部型別鍵");
  for (const t of BAND_TYPES) assert.deepEqual(js.measure_bands[t], []);
  assert.deepEqual(js.sleep_daily, []);
  for (const t of MEDIAN_TYPES) assert.deepEqual(js.measures[t], []);
  await d.close();
});
