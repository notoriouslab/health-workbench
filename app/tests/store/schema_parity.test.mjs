import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema, SCHEMA_VERSION, SchemaTooNew, NoMigrationPath } from "../../src/store/schema.js";
import { dropContainerSha256 } from "../helpers/schema_downgrade.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const norm = (sqls) => sqls.map(s => s.replace(/\s+/g, " ").trim()).sort();

test("schema parity：JS 與 Python 空庫 schema dump 全等", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  const jsRows = (await d.select(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")).map(r => r.sql);
  await d.close();

  const pyOut = execFileSync("python3", ["-c", [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
    "from src.store.db import Store",
    "s = Store(':memory:')",
    "rows = [r[0] for r in s.con.execute(\"SELECT sql FROM sqlite_master WHERE sql IS NOT NULL\")]",
    "print(json.dumps(rows))",
  ].join("\n")], { cwd: REPO_ROOT, encoding: "utf-8" });
  const pyRows = JSON.parse(pyOut);

  assert.deepEqual(norm(jsRows), norm(pyRows));
});

test("前向遷移：v2 庫開啟自動逐版升至最新（補索引與 CPAP 三表）", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  // 構造 v2 現場：移除 migration 2 與 3 的產物，版本紀錄清空後只留 2。
  // 版本紀錄 MUST 全清（DELETE 特定版本號會隨 SCHEMA_VERSION 演進而失效，
  // 導致 MAX(version) 仍是最新值、遷移根本不被觸發而測試假綠）
  // v2 現場也沒有 v5 欄位（不拆的話 MIGRATIONS[4] 的 ALTER 會撞既有欄位）
  await dropContainerSha256(d);
  await d.execute("DROP INDEX idx_medications_profile");
  for (const t of ["cpap_daily", "cpap_events", "cpap_oximetry"]) {
    await d.execute(`DROP TABLE ${t}`);
  }
  await d.execute("DELETE FROM schema_version");
  await d.execute("INSERT INTO schema_version(version) VALUES (2)");

  const ver = await initSchema(d);
  assert.equal(ver, SCHEMA_VERSION);
  const idx = await d.select(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_medications_profile'");
  assert.equal(idx.length, 1);
  const tables = await d.select(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cpap_%' ORDER BY name");
  assert.deepEqual(tables.map(r => r.name),
    ["cpap_daily", "cpap_events", "cpap_oximetry"]);
  const [{ v }] = await d.select("SELECT MAX(version) v FROM schema_version");
  assert.equal(v, SCHEMA_VERSION);
  await d.close();
});

test("版本過新防護：高於支援版本即丟 SchemaTooNew", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  await d.execute("INSERT INTO schema_version(version) VALUES (99)");
  await assert.rejects(initSchema(d), SchemaTooNew);
  await d.close();
});

test("無遷移路徑：未知舊版本即丟 NoMigrationPath", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  await d.execute("DELETE FROM schema_version");
  await d.execute("INSERT INTO schema_version(version) VALUES (0)");
  await assert.rejects(initSchema(d), NoMigrationPath);
  await d.close();
});
