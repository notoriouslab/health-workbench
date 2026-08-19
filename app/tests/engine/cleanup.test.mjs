// 釋放空間（health-database「釋放空間」／change display-revamp-bands-cleanup
// T6）。核心不變式：清理只刪彙總型別的 raw、逐筆保留 9 型別一筆不少、
// 清理前後 payload 的趨勢序列逐位元組相同；對帳防線不過則零刪除。
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
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { nodeFileSource } from "../helpers/node_source.mjs";
import { buildPayload } from "../../src/provider/payload.js";
import { cleanupPreview, cleanupGuardBadKeys, releaseSpace }
  from "../../src/engine/cleanup.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));
const AGG_LIST = AGGREGATE_TYPES.map((t) => `'${t}'`).join(",");
const ROW_LIST = PER_ROW_TYPES.map((t) => `'${t}'`).join(",");

async function buildDb() {
  const d = new NodeDriver(
    path.join(mkdtempSync(path.join(tmpdir(), "hwb-clean-")), "db.sqlite"));
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  d.pid = pid;
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
      name: "nhi_sample.json" },
    d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_sample.xml`), d, null,
    { profileId: pid });
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_watch_sample.xml`), d, null,
    { profileId: pid });
  return d;
}

// 常駐守衛：清理的刪除清單（AGGREGATE_TYPES）與逐筆保留清單零交集。
// 這是「塞錯型別」突變的常駐防線（分配對帳在 aggregate.test 另有聯集
// 斷言；2026-08-19 突變實測：塞入「體重」時本檔「9 型別一筆不少」與
// aggregate.test 共 4 個斷言轉紅）。
test("刪除清單與逐筆保留清單零交集（塞錯型別即紅）", () => {
  const overlap = AGGREGATE_TYPES.filter((t) => PER_ROW_TYPES.includes(t));
  assert.deepEqual(overlap, [],
    "逐筆保留型別混入刪除清單的話，釋放空間會把不可重建的明細刪掉");
});

const aggRaw = async (d) => (await d.select(
  `SELECT COUNT(*) c FROM apple_records WHERE type_zh IN (${AGG_LIST})`))[0].c;
const perRowRaw = async (d) => (await d.select(
  `SELECT COUNT(*) c FROM apple_records WHERE type_zh IN (${ROW_LIST})`))[0].c;
const trendKeys = async (d) => {
  const p = await buildPayload(d, { profileId: d.pid, knowledgeEntries: [],
    drugCachePath: null, today: "2026-08-19" });
  return JSON.stringify({ activity: p.activity, measures: p.measures,
    measure_bands: p.measure_bands, sleep_daily: p.sleep_daily });
};

test("正常清理：彙總型別 raw 歸零、逐筆保留一筆不少、趨勢序列逐位元組不變", async () => {
  const d = await buildDb();
  const aggBefore = await aggRaw(d);
  const rowBefore = await perRowRaw(d);
  assert.ok(aggBefore > 0 && rowBefore > 0, "前提：兩組型別都要有資料");
  const [{ c: dailyBefore }] = await d.select("SELECT COUNT(*) c FROM apple_daily");
  const before = await trendKeys(d);

  const preview = await cleanupPreview(d);
  assert.equal(preview.deletableRows, aggBefore, "預覽筆數＝將刪的彙總型別列數");
  assert.ok(preview.sizeBytes > 0 && preview.estAfterBytes < preview.sizeBytes,
    "預估清理後必須小於現大小");

  const r = await releaseSpace(d);
  assert.equal(r.deletedRows, aggBefore);
  assert.equal(r.vacuumError, null, "VACUUM 應成功");
  assert.equal(await aggRaw(d), 0, "彙總型別 raw 應歸零");
  assert.equal(await perRowRaw(d), rowBefore, "逐筆保留型別一筆不得少");
  const [{ c: dailyAfter }] = await d.select("SELECT COUNT(*) c FROM apple_daily");
  assert.equal(dailyAfter, dailyBefore, "apple_daily 不得被動到");
  assert.equal(await trendKeys(d), before,
    "清理前後 activity／measures／measure_bands／sleep_daily 必須逐位元組相同");
  assert.ok(r.afterBytes <= r.beforeBytes, "清理後大小不得變大");
  await d.close();
});

test("對帳防線：彙總缺列 → 中止且零刪除", async () => {
  const d = await buildDb();
  const before = await aggRaw(d);
  // 人為刪一列彙總，模擬「彙總尚未涵蓋就要刪 raw」的未知路徑
  await d.execute(
    "DELETE FROM apple_daily WHERE type_zh='心率' AND day='2024-02-01'");
  await assert.rejects(() => releaseSpace(d), /彙總缺列|筆數不足/);
  assert.equal(await aggRaw(d), before, "防線攔截時 raw 零刪除");
  await d.close();
});

test("對帳防線：彙總 n 小於 raw 列數（殘缺彙總）→ 中止且零刪除", async () => {
  const d = await buildDb();
  const before = await aggRaw(d);
  await d.execute(
    "UPDATE apple_daily SET n = n - 1 WHERE type_zh='心率' AND day='2024-02-01'"
    + " AND source_name='測試手錶'");
  assert.ok(await cleanupGuardBadKeys(d) > 0, "防線要抓到殘缺彙總");
  await assert.rejects(() => releaseSpace(d), /筆數不足|彙總缺列/);
  assert.equal(await aggRaw(d), before, "防線攔截時 raw 零刪除");
  await d.close();
});

test("VACUUM 失敗：資料仍一致、訊息可重試，不呈現為整體失敗", async () => {
  const d = await buildDb();
  // 攔截 VACUUM 模擬暫存磁碟不足（node:sqlite 難以真實觸發）
  const proxy = Object.create(d);
  proxy.execute = (sql, params) => sql === "VACUUM"
    ? Promise.reject(new Error("disk full（模擬）"))
    : d.execute(sql, params);
  const r = await releaseSpace(proxy);
  assert.match(r.vacuumError, /disk full/, "vacuumError 要帶原因");
  assert.equal(await aggRaw(d), 0, "刪除已 commit（資料一致，只是空間未回收）");
  const again = await releaseSpace(d);   // 冪等：可稍後重試
  assert.equal(again.vacuumError, null);
  assert.equal(again.deletedRows, 0, "重試時已無可刪列");
  await d.close();
});
