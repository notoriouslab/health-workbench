// Apple 每日彙總（change apple-daily-aggregates T1/T2）。
// 涵蓋：型別分配對帳、兩端 SQL 逐字同步、聚合正確性（n 對帳、正規化判準、
// 睡眠識別字、增量日重算、縮水防線雙向）。合成 XML 的形狀照真實匯出
// （Record 元素與屬性），數字為圓整數（公開 repo 紀律）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { appleHealthAdapter, WANTED } from "../../src/adapters/apple_health.js";
import { PER_ROW_TYPES, AGGREGATE_TYPES, importAggregateStatements,
  backfillStatements } from "../../src/engine/aggregate.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nodeFileSource } from "../helpers/node_source.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;

test("型別分配：逐筆∪彙總 恰等於 WANTED，無重複無遺漏", () => {
  const alloc = [...PER_ROW_TYPES, ...AGGREGATE_TYPES];
  const wanted = Object.values(WANTED);
  assert.equal(alloc.length, new Set(alloc).size, "分配表內不得重複");
  assert.deepEqual([...alloc].sort(), [...wanted].sort(),
    "聯集必須恰等於 WANTED（漏接的型別不會有任何錯誤訊息）");
});

test("聚合 SQL 兩端逐字同步（Python 鏡像不得漂移）", () => {
  const py = JSON.parse(execFileSync("python3", ["-c", [
    "import json, sys",
    "sys.path.insert(0, '.')",
    "from src.store.schema import (IMPORT_AGGREGATE_STATEMENTS,",
    "    BACKFILL_STATEMENTS, PER_ROW_TYPES, AGGREGATE_TYPES)",
    "print(json.dumps({'imports': IMPORT_AGGREGATE_STATEMENTS,",
    "    'backfill': BACKFILL_STATEMENTS, 'per_row': PER_ROW_TYPES,",
    "    'agg': AGGREGATE_TYPES}, ensure_ascii=False))",
  ].join("\n")], { cwd: REPO, encoding: "utf-8" }).trim().split("\n").at(-1));
  assert.deepEqual(py.imports, importAggregateStatements());
  assert.deepEqual(py.backfill, backfillStatements());
  assert.deepEqual(py.per_row, PER_ROW_TYPES);
  assert.deepEqual(py.agg, AGGREGATE_TYPES);
});

// 合成 XML（形狀照真實匯出；步數為彙總型別、體重為逐筆型別、睡眠為 category）
function xmlOf(records) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="zh_TW">\n'
    + records.map((r) => `  <Record type="${r.type}" sourceName="${r.src}"`
      + ` unit="${r.unit ?? "count"}" startDate="${r.start} +0800"`
      + ` endDate="${r.end ?? r.start} +0800" value="${r.value}"/>`).join("\n")
    + "\n</HealthData>\n";
}

function writeXml(name, records) {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-agg-"));
  const p = path.join(dir, name);
  writeFileSync(p, xmlOf(records));
  return p;
}

async function freshDriver() {
  const d = new NodeDriver();
  await initSchema(d);
  d.pid = await createProfile(d, "本人");
  return d;
}

const STEP = "HKQuantityTypeIdentifierStepCount";
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";

test("匯入後彙總就緒：n 對帳、逐筆型別不進彙總、統計值正確", async () => {
  const d = await freshDriver();
  const xml = writeXml("a.xml", [
    { type: STEP, src: "iPhone", start: "2026-01-01 08:00:00", value: 100 },
    { type: STEP, src: "iPhone", start: "2026-01-01 09:00:00", value: 300 },
    { type: STEP, src: "Watch", start: "2026-01-01 09:00:00", value: 500 },
    { type: STEP, src: "iPhone", start: "2026-01-02 08:00:00", value: 200 },
    { type: "HKQuantityTypeIdentifierBodyMass", src: "秤", unit: "kg",
      start: "2026-01-01 07:00:00", value: 70 },
  ]);
  const r = await appleHealthAdapter.importSource(
    await nodeFileSource(xml), d, null, { profileId: d.pid });
  assert.equal(r.status, "ok");

  const rows = await d.select(
    "SELECT type_zh, day, source_name, n, sum_v, min_v, max_v, avg_v"
    + " FROM apple_daily ORDER BY day, source_name");
  // 排序為 binary collation：大寫 W 在小寫 i 之前
  assert.deepEqual(rows.map(x => ({ ...x })), [
    { type_zh: "步數", day: "2026-01-01", source_name: "Watch",
      n: 1, sum_v: 500, min_v: 500, max_v: 500, avg_v: 500 },
    { type_zh: "步數", day: "2026-01-01", source_name: "iPhone",
      n: 2, sum_v: 400, min_v: 100, max_v: 300, avg_v: 200 },
    { type_zh: "步數", day: "2026-01-02", source_name: "iPhone",
      n: 1, sum_v: 200, min_v: 200, max_v: 200, avg_v: 200 },
  ], "體重（逐筆型別）不得進彙總；統計值逐欄正確");

  // n 對帳：彙總 n 總和 == 彙總型別的 raw 列數（health-database scenario）
  const [{ nSum }] = await d.select("SELECT SUM(n) nSum FROM apple_daily");
  const [{ rawC }] = await d.select(
    "SELECT COUNT(*) rawC FROM apple_records WHERE type_zh='步數'");
  assert.equal(nSum, rawC);
  await d.close();
});

test("增量日重算：同日新檔加列後，統計等於兩檔合計（不縮小不過期）", async () => {
  const d = await freshDriver();
  const a = writeXml("a.xml", [
    { type: STEP, src: "iPhone", start: "2026-01-01 08:00:00", value: 100 },
    { type: STEP, src: "iPhone", start: "2026-01-01 09:00:00", value: 300 },
  ]);
  const b = writeXml("b.xml", [
    { type: STEP, src: "iPhone", start: "2026-01-01 10:00:00", value: 50 },
  ]);
  await appleHealthAdapter.importSource(await nodeFileSource(a), d, null, { profileId: d.pid });
  await appleHealthAdapter.importSource(await nodeFileSource(b), d, null, { profileId: d.pid });
  const [row] = await d.select("SELECT n, sum_v, quality_flags FROM apple_daily");
  assert.equal(row.n, 3, "n 必須是兩檔合計");
  assert.equal(row.sum_v, 450, "sum 必須含新檔的列");
  assert.equal(row.quality_flags, "", "全量重算不得誤觸縮水旗標");
  await d.close();
});

test("縮水防線雙向：raw 清理後的部分重新匯出不得蓋掉完整彙總", async () => {
  const d = await freshDriver();
  const full = writeXml("full.xml", [
    { type: STEP, src: "iPhone", start: "2026-01-01 08:00:00", value: 100 },
    { type: STEP, src: "iPhone", start: "2026-01-01 09:00:00", value: 300 },
    { type: STEP, src: "iPhone", start: "2026-01-01 10:00:00", value: 600 },
  ]);
  await appleHealthAdapter.importSource(await nodeFileSource(full), d, null, { profileId: d.pid });
  // 模擬包 3 的釋放空間：清掉彙總型別的 raw
  await d.execute("DELETE FROM apple_records WHERE type_zh='步數'");
  // 部分重新匯出（同日只剩 1 筆）
  const partial = writeXml("partial.xml", [
    { type: STEP, src: "iPhone", start: "2026-01-01 08:00:00", value: 100 },
  ]);
  const r = await appleHealthAdapter.importSource(
    await nodeFileSource(partial), d, null, { profileId: d.pid });
  assert.equal(r.status, "ok");
  const [row] = await d.select("SELECT n, sum_v, quality_flags FROM apple_daily");
  assert.equal(row.n, 3, "完整彙總的 n 不得被縮小");
  assert.equal(row.sum_v, 1000, "完整彙總的統計不得被部分匯出覆蓋");
  assert.match(row.quality_flags, /partial_reimport_skipped/,
    "縮水必須留下旗標，不得無聲跳過");
  await d.close();
});

test("睡眠：按原始識別字聚合每日分鐘數，識別字不寫死", async () => {
  const d = await freshDriver();
  const xml = writeXml("sleep.xml", [
    { type: SLEEP, src: "iPhone", unit: "",
      start: "2026-01-01 23:00:00", end: "2026-01-01 23:30:00",
      value: "HKCategoryValueSleepAnalysisInBed" },
    { type: SLEEP, src: "iPhone", unit: "",
      start: "2026-01-01 23:30:00", end: "2026-01-01 23:50:00",
      value: "HKCategoryValueSleepAnalysisInBed" },
    { type: SLEEP, src: "iPhone", unit: "",
      start: "2026-01-01 22:00:00", end: "2026-01-01 22:10:00",
      value: "HKCategoryValueSleepAnalysisAsleepUnspecified" },
  ]);
  await appleHealthAdapter.importSource(await nodeFileSource(xml), d, null, { profileId: d.pid });
  const [row] = await d.select(
    "SELECT extra_json FROM apple_daily WHERE type_zh='睡眠'");
  assert.deepEqual(JSON.parse(row.extra_json), {
    HKCategoryValueSleepAnalysisAsleepUnspecified: 10,
    HKCategoryValueSleepAnalysisInBed: 50,
  }, "每日各識別字分鐘數（原識別字、整數分鐘、鍵序決定性）");
  await d.close();
});

test("正規化判準：聚合取 value_normalized 優先（COALESCE 與趨勢同判準）", async () => {
  // UNIT_RULES 目前只作用於逐筆型別，聚合型別無真實正規化案例；
  // 直接以 schema 形狀構造 raw 列驗 SQL 判準本身
  const d = await freshDriver();
  await d.execute("INSERT INTO source_documents(id, profile_id, filename, sha256,"
    + " adapter, adapter_version) VALUES (1, ?, 'x.xml', 'h', 'apple_health', 't')",
    [d.pid]);
  await d.execute("INSERT INTO apple_records(profile_id, doc_id, type, type_zh,"
    + " start_ts, end_ts, value_numeric, value_normalized)"
    + " VALUES (?, 1, 'HKQuantityTypeIdentifierHeartRate', '心率',"
    + " '2026-01-01 08:00:00', '2026-01-01 08:00:00', 999, 60)", [d.pid]);
  for (const { sql, params } of importAggregateStatements()) {
    await d.execute(sql, Array(params).fill(1));
  }
  const [row] = await d.select("SELECT sum_v FROM apple_daily WHERE type_zh='心率'");
  assert.equal(row.sum_v, 60, "有 value_normalized 時 MUST 用它，不用原始值");
  await d.close();
});
