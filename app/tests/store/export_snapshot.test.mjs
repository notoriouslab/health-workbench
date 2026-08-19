// 匯出資料庫檔（app-shell spec「匯出資料庫檔」scenario）：
// VACUUM INTO 一致性快照＝schema 版本與各表筆數與主庫全等、可被重新
// 開啟（等價於「匯入既有資料庫檔」的可讀回性）、匯出後主庫可續寫、
// 目標已存在時拒絕且既有檔案不變。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema, SCHEMA_VERSION } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { backupFileName, exportDbSnapshot } from "../../src/store/location.js";

const TABLES = ["profiles", "source_documents", "encounters", "medications",
  "lab_results", "reports", "immunizations", "body_measurements",
  "cancer_screenings", "apple_records", "apple_workouts", "apple_daily",
  "cpap_daily", "cpap_events", "cpap_oximetry"];

async function seed(d) {
  const p = await createProfile(d, "本人");
  const doc = await d.execute(
    "INSERT INTO source_documents(profile_id,filename,sha256,adapter,adapter_version)"
    + " VALUES(?,?,?,?,?)", [p, "a.json", "sha-a", "nhi_json", "t"]);
  await d.execute(
    "INSERT INTO encounters(profile_id,doc_id,section,source_index,record_fp,canonical,type)"
    + " VALUES(?,?,?,?,?,?,?)", [p, doc.lastInsertRowid, "r1", 0, "fp-1", "{}", "門診"]);
  return p;
}

async function counts(d) {
  const out = {};
  for (const t of TABLES) {
    const [{ c }] = await d.select(`SELECT count(*) c FROM ${t}`);
    out[t] = c;
  }
  return out;
}

test("backupFileName：日期戳檔名", () => {
  assert.equal(backupFileName("2026-08-11"), "hwb-backup-20260811.sqlite");
});

test("VACUUM INTO 快照：版本與筆數全等、可重開、主庫可續寫", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hwb-export-"));
  const dest = join(dir, "hwb-backup-test.sqlite");
  const d = new NodeDriver();
  await initSchema(d);
  const p = await seed(d);
  const before = await counts(d);
  await exportDbSnapshot(d, dest);
  // 快照可重開且內容全等
  const copy = new NodeDriver(dest);
  const [{ ver }] = await copy.select("SELECT MAX(version) ver FROM schema_version");
  assert.equal(ver, SCHEMA_VERSION);
  assert.deepEqual(await counts(copy), before);
  const [row] = await copy.select("SELECT display_name FROM profiles WHERE id=?", [p]);
  assert.equal(row.display_name, "本人");
  await copy.close();
  // 主庫未被中斷、可續寫；快照不隨主庫後續寫入變動
  await createProfile(d, "媽媽");
  const copy2 = new NodeDriver(dest);
  assert.equal((await copy2.select("SELECT count(*) c FROM profiles"))[0].c, 1,
    "快照不含匯出後的新寫入");
  await copy2.close();
  await d.close();
});

test("目標已存在：SQLite 拒絕且既有檔案逐位元組不變", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hwb-export-"));
  const dest = join(dir, "existing.sqlite");
  writeFileSync(dest, "既有內容不可動");
  const d = new NodeDriver();
  await initSchema(d);
  await assert.rejects(() => exportDbSnapshot(d, dest));
  assert.equal(readFileSync(dest, "utf-8"), "既有內容不可動");
  await d.close();
});
