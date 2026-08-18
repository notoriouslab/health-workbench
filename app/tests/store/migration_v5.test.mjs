// schema 4→5 遷移護欄（change import-progress-and-single-pass task T2）。
// 照 migration_v4 的三件事：既有資料逐位元組不變、中斷完整回滾、全新庫不受影響。
import test from "node:test";
import assert from "node:assert/strict";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema, SCHEMA_VERSION, MIGRATIONS } from "../../src/store/schema.js";
import { dropContainerSha256, stripContainerSha256 }
  from "../helpers/schema_downgrade.mjs";

// 把庫降回 v4 現場：拆掉 v5 欄位，版本紀錄全清再插 4
async function downgradeToV4(d) {
  await dropContainerSha256(d);
  await d.execute("DELETE FROM schema_version");
  await d.execute("INSERT INTO schema_version(version) VALUES (4)");
}

async function seed(d) {
  await d.execute(
    "INSERT INTO profiles(id, display_name, masked_id, created_at)"
    + " VALUES (1,'甲','A12345****','2026-01-01 00:00:00')");
  await d.execute(
    "INSERT INTO source_documents(id, profile_id, filename, sha256, adapter,"
    + " adapter_version, import_stats, imported_at)"
    + " VALUES (1,1,'a.json','deadbeef','nhi_json','1.0.0','{}','2026-01-02 00:00:00')");
  await d.execute(
    "INSERT INTO encounters(id, profile_id, doc_id, section, source_index, record_fp,"
    + " canonical, type, date) VALUES (1,1,1,'r1',0,'fp1','{}','門診','2026-01-03')");
}

async function dumpAll(d) {
  const tables = (await d.select(
    "SELECT name FROM sqlite_master WHERE type='table' AND name != 'schema_version'"
    + " ORDER BY name")).map(r => r.name);
  const out = {};
  for (const t of tables) {
    out[t] = await d.select(`SELECT * FROM ${t} ORDER BY rowid`);
  }
  return JSON.stringify(out);
}

async function hasColumn(d) {
  const cols = await d.select("PRAGMA table_info(source_documents)");
  return cols.some(c => c.name === "container_sha256");
}

test("v4 升 v5：既有資料不變、container_sha256 出現且既有列為 NULL", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  await downgradeToV4(d);
  await seed(d);
  assert.equal(await hasColumn(d), false, "降版現場不應已有欄位");
  const before = await dumpAll(d);

  const ver = await initSchema(d);
  assert.equal(ver, SCHEMA_VERSION);
  assert.equal(await hasColumn(d), true);
  const rows = await d.select("SELECT container_sha256 FROM source_documents");
  // node:sqlite 回傳 null-prototype 物件，deepEqual 物件層級會比原型；取值比對
  assert.deepEqual(rows.map(r => r.container_sha256), [null],
    "既有列新欄位必須為 NULL");

  // 既有欄位逐位元組不變（dump 會多出新欄位，比對時逐列剝掉）
  assert.equal(stripContainerSha256(await dumpAll(d)), before);
  await d.close();
});

test("遷移中斷：回滾至 v4，欄位不存在，既有資料不變", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  await downgradeToV4(d);
  await seed(d);
  const before = await dumpAll(d);

  let n = 0;
  const failing = {
    select: (...a) => d.select(...a),
    execute: (...a) => {
      n += 1;
      if (n === 1) throw new Error("模擬遷移中斷"); // v4→v5 只有一句 ALTER
      return d.execute(...a);
    },
    transaction: (fn) => d.transaction(() => fn(failing)),
  };
  await assert.rejects(initSchema(failing), /模擬遷移中斷/);

  assert.equal(await hasColumn(d), false, "回滾後不得留下欄位");
  const [{ v }] = await d.select("SELECT MAX(version) v FROM schema_version");
  assert.equal(v, 4, "版本必須留在 v4");
  assert.equal(await dumpAll(d), before);
  await d.close();
});

test("全新庫：直接建到 v5，欄位存在，版本紀錄單筆", async () => {
  const d = new NodeDriver();
  const ver = await initSchema(d);
  assert.equal(ver, SCHEMA_VERSION);
  assert.equal(await hasColumn(d), true);
  const rows = await d.select("SELECT version FROM schema_version ORDER BY version");
  assert.deepEqual(rows.map(r => r.version), [SCHEMA_VERSION]);
  await d.close();
});

test("MIGRATIONS[4] 每個元素為單一語句（Python 端逐句 execute）", () => {
  for (const stmt of MIGRATIONS[4]) {
    assert.ok(!stmt.includes(";"), `不得含分號：${stmt}`);
  }
});
