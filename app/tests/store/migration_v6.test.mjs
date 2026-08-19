// schema 5→6 遷移護欄（change apple-daily-aggregates T1）。
// 照 v4/v5 模式三件事＋本版特有的回填：v5 舊庫升級後 apple_daily 由既有
// raw 回填、raw 逐位元組不變；中斷完整回滾；全新庫直建。
import test from "node:test";
import assert from "node:assert/strict";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema, SCHEMA_VERSION, MIGRATIONS } from "../../src/store/schema.js";

async function downgradeToV5(d) {
  await d.execute("DROP TABLE apple_daily");
  await d.execute("DELETE FROM schema_version");
  await d.execute("INSERT INTO schema_version(version) VALUES (5)");
}

async function seed(d) {
  await d.execute(
    "INSERT INTO profiles(id, display_name) VALUES (1,'甲')");
  await d.execute(
    "INSERT INTO source_documents(id, profile_id, filename, sha256, adapter,"
    + " adapter_version) VALUES (1,1,'a.xml','h1','apple_health','t')");
  // 彙總型別（步數）兩列同日＋逐筆型別（體重）一列
  await d.execute(
    "INSERT INTO apple_records(profile_id, doc_id, type, type_zh, start_ts,"
    + " end_ts, value_numeric) VALUES"
    + " (1,1,'HKQuantityTypeIdentifierStepCount','步數',"
    + "  '2026-01-01 08:00:00','2026-01-01 08:00:00',100),"
    + " (1,1,'HKQuantityTypeIdentifierStepCount','步數',"
    + "  '2026-01-01 09:00:00','2026-01-01 09:00:00',300),"
    + " (1,1,'HKQuantityTypeIdentifierBodyMass','體重',"
    + "  '2026-01-01 07:00:00','2026-01-01 07:00:00',70)");
}

async function dumpRaw(d) {
  return JSON.stringify(await d.select(
    "SELECT * FROM apple_records ORDER BY rowid"));
}

test("v5 升 v6：apple_daily 回填、raw 逐位元組不變", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  await downgradeToV5(d);
  await seed(d);
  const before = await dumpRaw(d);

  const ver = await initSchema(d);
  assert.equal(ver, SCHEMA_VERSION);
  const rows = await d.select(
    "SELECT type_zh, day, n, sum_v FROM apple_daily");
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { type_zh: "步數", day: "2026-01-01", n: 2, sum_v: 400 },
  ], "回填只涵蓋彙總型別，統計正確");
  assert.equal(await dumpRaw(d), before, "raw 必須逐位元組不變");
  await d.close();
});

test("遷移中斷：回滾至 v5，表不存在，raw 不變", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  await downgradeToV5(d);
  await seed(d);
  const before = await dumpRaw(d);

  let n = 0;
  const failing = {
    select: (...a) => d.select(...a),
    execute: (...a) => {
      n += 1;
      if (n === 2) throw new Error("模擬遷移中斷"); // 建表後、回填途中
      return d.execute(...a);
    },
    transaction: (fn) => d.transaction(() => fn(failing)),
  };
  await assert.rejects(initSchema(failing), /模擬遷移中斷/);
  const tables = await d.select(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='apple_daily'");
  assert.deepEqual(tables, [], "回滾後不得留下 apple_daily");
  const [{ v }] = await d.select("SELECT MAX(version) v FROM schema_version");
  assert.equal(v, 5);
  assert.equal(await dumpRaw(d), before);
  await d.close();
});

test("全新庫：直接建到 v6，版本紀錄單筆", async () => {
  const d = new NodeDriver();
  const ver = await initSchema(d);
  assert.equal(ver, SCHEMA_VERSION);
  const cols = await d.select("PRAGMA table_info(apple_daily)");
  assert.ok(cols.some(c => c.name === "extra_json"));
  const rows = await d.select("SELECT version FROM schema_version");
  assert.deepEqual(rows.map(r => r.version), [SCHEMA_VERSION]);
  await d.close();
});

test("MIGRATIONS[5] 每個元素為單一語句（Python 端逐句 execute）", () => {
  for (const stmt of MIGRATIONS[5]) {
    assert.ok(!stmt.includes(";"), `不得含分號：${stmt.slice(0, 60)}`);
  }
});
