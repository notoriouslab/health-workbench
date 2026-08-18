// schema 3→4 遷移護欄（change cpap-sleep-therapy task 1.5）。
// 這是 v0.3 以來第一次讓既有生產庫真正跑遷移，失敗代價是資料庫打不開，
// 因此驗證三件事：既有資料逐位元組不變、中斷可完整回滾、全新庫不受影響。
import test from "node:test";
import assert from "node:assert/strict";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema, SCHEMA_VERSION, MIGRATIONS, NoMigrationPath }
  from "../../src/store/schema.js";
import { readSchemaVersion, needsPreMigrationSnapshot, preMigrationSnapshotName }
  from "../../src/store/location.js";
import { dropContainerSha256, stripContainerSha256 }
  from "../helpers/schema_downgrade.mjs";

const CPAP_TABLES = ["cpap_daily", "cpap_events", "cpap_oximetry"];

// 把庫降回 v3 現場：移除 v4 產物與版本紀錄（版本紀錄全清，不依賴特定版本號）
async function downgradeToV3(d) {
  await dropContainerSha256(d); // v3 現場也沒有 v5 欄位
  for (const t of CPAP_TABLES) await d.execute(`DROP TABLE ${t}`);
  await d.execute("DELETE FROM schema_version");
  await d.execute("INSERT INTO schema_version(version) VALUES (3)");
}

// 塞入跨表的代表性資料（依 FK 順序；NodeDriver 開了 foreign_keys）
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
  await d.execute(
    "INSERT INTO body_measurements(id, profile_id, doc_id, section, source_index,"
    + " record_fp, canonical, check_date, weight_kg)"
    + " VALUES (1,1,1,'r5',0,'fp2','{}','2026-01-04',70.5)");
  await d.execute(
    "INSERT INTO apple_records(id, profile_id, doc_id, type, type_zh, start_ts, end_ts,"
    + " value_numeric) VALUES (1,1,1,'HKQuantityTypeIdentifierBodyMass','體重',"
    + "'2026-01-05T08:00:00','2026-01-05T08:00:00',70.5)");
}

// 全庫排序 dump（不含 schema_version，它本來就會變）
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

test("v3 升至最新：既有資料逐位元組不變、三表建立、版本為最新", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  await downgradeToV3(d);
  await seed(d);
  const before = await dumpAll(d);

  const ver = await initSchema(d);
  assert.equal(ver, SCHEMA_VERSION);

  const tables = (await d.select(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cpap_%'"
    + " ORDER BY name")).map(r => r.name);
  assert.deepEqual(tables, CPAP_TABLES);
  const idx = (await d.select(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_cpap_%'"
    + " ORDER BY name")).map(r => r.name);
  assert.deepEqual(idx,
    ["idx_cpap_daily_profile", "idx_cpap_events_profile", "idx_cpap_oximetry_profile"]);

  // 新表為空，既有表逐位元組不變（新表本身也進 dump，故單獨比既有表）
  for (const t of CPAP_TABLES) {
    const [{ c }] = await d.select(`SELECT COUNT(*) c FROM ${t}`);
    assert.equal(c, 0);
  }
  const afterExisting = JSON.parse(stripContainerSha256(await dumpAll(d)));
  for (const t of CPAP_TABLES) delete afterExisting[t];
  assert.equal(JSON.stringify(afterExisting), before);

  const [{ v }] = await d.select("SELECT MAX(version) v FROM schema_version");
  assert.equal(v, SCHEMA_VERSION);
  await d.close();
});

test("遷移中途中斷：整段回滾至 v3，三表不存在，既有資料不變", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  await downgradeToV3(d);
  await seed(d);
  const before = await dumpAll(d);

  // 代理 driver：第 3 次 execute 拋錯（第二張表建立途中）。
  // BEGIN/COMMIT/ROLLBACK 由 NodeDriver.transaction 以 db.exec 直接下達，
  // 不經過本代理，因此計數只涵蓋遷移語句本身。
  let n = 0;
  const failing = {
    select: (...a) => d.select(...a),
    execute: (...a) => {
      n += 1;
      if (n === 3) throw new Error("模擬遷移中斷");
      return d.execute(...a);
    },
    transaction: (fn) => d.transaction(() => fn(failing)),
  };

  await assert.rejects(initSchema(failing), /模擬遷移中斷/);

  const tables = await d.select(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cpap_%'");
  assert.deepEqual(tables, [], "回滾後不得留下任何 CPAP 表");
  const [{ v }] = await d.select("SELECT MAX(version) v FROM schema_version");
  assert.equal(v, 3, "版本必須留在 v3");
  assert.equal(await dumpAll(d), before, "既有資料必須逐位元組不變");
  await d.close();
});

test("全新庫：直接建到 v4，不需經過遷移路徑", async () => {
  const d = new NodeDriver();
  const ver = await initSchema(d);
  assert.equal(ver, SCHEMA_VERSION);
  const tables = (await d.select(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cpap_%'"
    + " ORDER BY name")).map(r => r.name);
  assert.deepEqual(tables, CPAP_TABLES);
  const rows = await d.select("SELECT version FROM schema_version ORDER BY version");
  assert.deepEqual(rows.map(r => r.version), [SCHEMA_VERSION],
    "全新庫只該有一筆版本紀錄，不該留下逐版升級的痕跡");
  await d.close();
});

test("版本紀錄被清空：明確報錯，不得靜默通過", async () => {
  // MAX(version) 為 null 時，null 與數字的所有比較都是 false，若不明確攔下
  // 會靜默回傳 null 並讓後續操作跑在缺表的庫上
  const d = new NodeDriver();
  await initSchema(d);
  await d.execute("DELETE FROM schema_version");
  await assert.rejects(initSchema(d), NoMigrationPath);
  await d.close();
});

test("遷移前快照判定：全新庫不做、落後版本才做", async () => {
  assert.equal(needsPreMigrationSnapshot(null, 4), false, "全新庫不需快照");
  assert.equal(needsPreMigrationSnapshot(3, 4), true);
  assert.equal(needsPreMigrationSnapshot(1, 4), true);
  assert.equal(needsPreMigrationSnapshot(4, 4), false, "已是最新不需快照");
  assert.equal(needsPreMigrationSnapshot(5, 4), false, "版本較新交由 SchemaTooNew 處理");

  // readSchemaVersion：schema_version 表不存在時回 null（全新庫）
  const fresh = new NodeDriver();
  assert.equal(await readSchemaVersion(fresh), null);
  await initSchema(fresh);
  assert.equal(await readSchemaVersion(fresh), SCHEMA_VERSION);
  await downgradeToV3(fresh);
  assert.equal(await readSchemaVersion(fresh), 3);
  await fresh.close();
});

test("遷移前快照檔名：帶來源版本與日期，同名附序號", () => {
  assert.equal(preMigrationSnapshotName(3, "2026-08-12"),
    "hwb-premigrate-v3-20260812.sqlite");
  assert.equal(preMigrationSnapshotName(3, "2026-08-12", 0),
    "hwb-premigrate-v3-20260812.sqlite");
  assert.equal(preMigrationSnapshotName(3, "2026-08-12", 2),
    "hwb-premigrate-v3-20260812-2.sqlite");
  assert.equal(preMigrationSnapshotName(1, "2026-01-05"),
    "hwb-premigrate-v1-20260105.sqlite");
});

test("遷移前快照檔名：拒絕會污染路徑的輸入", () => {
  // version 來自資料庫欄位，SQLite 型別親和性允許 INTEGER 欄位實際存字串，
  // 而此值會組進檔案路徑，故非數字一律拒絕而非照字串拼接
  assert.throws(() => preMigrationSnapshotName("3/../../evil", "2026-08-12"),
    /來源版本非有效整數/);
  assert.throws(() => preMigrationSnapshotName(-1, "2026-08-12"),
    /來源版本非有效整數/);
  assert.throws(() => preMigrationSnapshotName(3, "2026-08-12", "../x"),
    /序號非有效整數/);
  assert.throws(() => preMigrationSnapshotName(3, "../../etc/passwd"),
    /日期需為 YYYY-MM-DD/);
  // 數字字串（來自 driver 的正常回傳型別差異）仍應可用
  assert.equal(preMigrationSnapshotName("3", "2026-08-12"),
    "hwb-premigrate-v3-20260812.sqlite");
});

test("MIGRATIONS[3] 每個元素為單一語句（Python 端逐句 execute）", () => {
  const steps = MIGRATIONS[3];
  assert.ok(steps.length > 0);
  for (const sql of steps) {
    assert.ok(!sql.includes(";"), `語句不得含分號：${sql.slice(0, 40)}`);
    assert.match(sql, /^CREATE (TABLE|INDEX)/);
  }
});
