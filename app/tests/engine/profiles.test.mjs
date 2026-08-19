// profile-management spec：成員清單/新增/改名/刪除（連帶資料、交易原子）。
// 刪除順序照 FK 反向（medications→各資料表→source_documents→profiles），
// NodeDriver 開啟 PRAGMA foreign_keys，順序錯誤會直接炸。
import test from "node:test";
import assert from "node:assert/strict";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { EngineStore } from "../../src/engine/store.js";
import {
  listProfiles, createProfile, renameProfile, deleteProfile, profileCounts,
  PROFILE_DATA_TABLES,
} from "../../src/engine/profiles.js";

async function freshDb() {
  const d = new NodeDriver();
  await initSchema(d);
  return d;
}

// 為指定成員在全部 10 個資料表各種一筆最小合法資料
async function seedMember(driver, pid, tag) {
  const doc = await driver.execute(
    "INSERT INTO source_documents(profile_id,filename,sha256,adapter,adapter_version)"
    + " VALUES(?,?,?,?,?)", [pid, `${tag}.json`, `sha-${tag}`, "nhi_json", "t"]);
  const docId = doc.lastInsertRowid;
  const enc = await driver.execute(
    "INSERT INTO encounters(profile_id,doc_id,section,source_index,record_fp,canonical,type)"
    + " VALUES(?,?,?,?,?,?,?)", [pid, docId, "r1", 0, `fp-e-${tag}`, "{}", "門診"]);
  await driver.execute(
    "INSERT INTO medications(profile_id,doc_id,encounter_id,section,source_index)"
    + " VALUES(?,?,?,?,?)", [pid, docId, enc.lastInsertRowid, "r2", 0]);
  for (const t of ["lab_results", "reports", "immunizations",
    "body_measurements", "cancer_screenings"]) {
    await driver.execute(
      `INSERT INTO ${t}(profile_id,doc_id,section,source_index,record_fp,canonical)`
      + " VALUES(?,?,?,?,?,?)", [pid, docId, "rx", 0, `fp-${t}-${tag}`, "{}"]);
  }
  await driver.execute(
    "INSERT INTO apple_records(profile_id,doc_id,type,type_zh,start_ts,end_ts)"
    + " VALUES(?,?,?,?,?,?)", [pid, docId, "HKQuantityTypeIdentifierStepCount",
      "步數", `2026-01-01T00:00:0${pid}`, "2026-01-01T01:00:00"]);
  await driver.execute(
    "INSERT INTO apple_workouts(profile_id,doc_id,activity,start_ts,end_ts)"
    + " VALUES(?,?,?,?,?)", [pid, docId, "跑步", `2026-01-01T00:00:0${pid}`,
      "2026-01-01T01:00:00"]);
  await driver.execute(
    "INSERT INTO apple_daily(profile_id,doc_id,type_zh,day,source_name,n)"
    + " VALUES(?,?,?,?,?,?)", [pid, docId, "步數", "2026-01-01", "", 1]);
  // CPAP 三表：doc_id 有 REFERENCES source_documents，若清單漏了它們，
  // 刪除成員會在 DELETE source_documents 那步 FK 失敗（2026-08-13 實測）
  await driver.execute(
    "INSERT INTO cpap_daily(profile_id,doc_id,device,summary_date,ahi)"
    + " VALUES(?,?,?,?,?)", [pid, docId, `Dev-${tag}`, "2023-06-12", 2.4]);
  await driver.execute(
    "INSERT INTO cpap_events(profile_id,doc_id,device,session_date,start_ts,event_type)"
    + " VALUES(?,?,?,?,?,?)", [pid, docId, `Dev-${tag}`, "2023-06-12",
      "2023-06-12T20:00:00", "Apnea"]);
  await driver.execute(
    "INSERT INTO cpap_oximetry(profile_id,doc_id,device,session_date,minute_ts,"
    + "spo2_min,sample_count) VALUES(?,?,?,?,?,?,?)",
    [pid, docId, `Dev-${tag}`, "2023-06-12", "2023-06-12T20:00:00", 95, 60]);
  return docId;
}

async function allCounts(driver) {
  const out = {};
  for (const t of [...PROFILE_DATA_TABLES, "profiles"]) {
    const [{ c }] = await driver.select(`SELECT count(*) c FROM ${t}`);
    out[t] = c;
  }
  return out;
}

test("createProfile/listProfiles：新增後依 id 排序列出，名稱去空白", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "  媽媽  ");
  assert.ok(a < b);
  const rows = await listProfiles(d);
  assert.deepEqual(rows.map(r => [r.id, r.display_name]), [[a, "本人"], [b, "媽媽"]]);
  await d.close();
});

test("createProfile：空白名與重名（含空白變體）拒絕", async () => {
  const d = await freshDb();
  await createProfile(d, "媽媽");
  await assert.rejects(() => createProfile(d, "   "), /名稱/);
  await assert.rejects(() => createProfile(d, " 媽媽 "), /重複|已存在/);
  assert.equal((await listProfiles(d)).length, 1);
  await d.close();
});

test("createProfile/renameProfile：超過 30 字拒絕（防匯出檔名外溢）", async () => {
  const d = await freshDb();
  const long = "啊".repeat(31);
  await assert.rejects(() => createProfile(d, long), /30 字/);
  const id = await createProfile(d, "本人");
  await assert.rejects(() => renameProfile(d, id, long), /30 字/);
  await createProfile(d, "啊".repeat(30)); // 恰好 30 字合法
  assert.equal((await listProfiles(d)).length, 2);
  await d.close();
});

test("renameProfile：改名成功、資料歸屬不變；重名拒絕；改成自己原名允許", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  await seedMember(d, a, "a");
  await renameProfile(d, a, "爸爸");
  const rows = await listProfiles(d);
  assert.equal(rows.find(r => r.id === a).display_name, "爸爸");
  const [{ c }] = await d.select(
    "SELECT count(*) c FROM encounters WHERE profile_id=?", [a]);
  assert.equal(c, 1);
  await assert.rejects(() => renameProfile(d, a, " 媽媽"), /重複|已存在/);
  await renameProfile(d, b, "媽媽"); // 自己原名＝no-op，不得誤判重名
  await assert.rejects(() => renameProfile(d, a, ""), /名稱/);
  await d.close();
});

test("deleteProfile：連帶清除全部資料表、他成員逐位元組不變", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  await seedMember(d, a, "a");
  await seedMember(d, b, "b");
  const beforeB = [];
  for (const t of PROFILE_DATA_TABLES) {
    beforeB.push([t, JSON.stringify(
      await d.select(`SELECT * FROM ${t} WHERE profile_id=? ORDER BY id`, [b]))]);
  }
  const deleted = await deleteProfile(d, a);
  for (const t of PROFILE_DATA_TABLES) {
    const [{ c }] = await d.select(
      `SELECT count(*) c FROM ${t} WHERE profile_id=?`, [a]);
    assert.equal(c, 0, `${t} 應清空`);
    assert.equal(deleted[t], 1, `${t} 回報刪除數`);
  }
  assert.equal((await listProfiles(d)).length, 1);
  for (const [t, snap] of beforeB) {
    assert.equal(JSON.stringify(
      await d.select(`SELECT * FROM ${t} WHERE profile_id=? ORDER BY id`, [b])),
      snap, `${t} 他成員資料不變`);
  }
  await d.close();
});

test("deleteProfile：中斷即整批回滾（無半刪狀態）", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  await seedMember(d, a, "a");
  const before = await allCounts(d);
  // 包裝 driver：profiles 的 DELETE（最後一步）丟錯，模擬中途失敗
  const sabotaged = Object.create(d);
  sabotaged.execute = (sql, params) => {
    if (/DELETE FROM profiles/.test(sql)) throw new Error("模擬中斷");
    return d.execute(sql, params);
  };
  sabotaged.transaction = (fn) => NodeDriver.prototype.transaction.call(d, () => fn(sabotaged));
  await assert.rejects(() => deleteProfile(sabotaged, a), /模擬中斷/);
  assert.deepEqual(await allCounts(d), before, "回滾後各表筆數不變");
  await d.close();
});

test("deleteProfile 後 sha256 釋放：同檔可為其他成員重新登記", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  await seedMember(d, a, "dup");
  await deleteProfile(d, a);
  const store = new EngineStore(d);
  const r = await store.registerSource(b, "dup.json", "sha-dup", "nhi_json", "t");
  assert.equal(r.importedAt, null, "不再被視為重複檔");
  const [{ c }] = await d.select(
    "SELECT count(*) c FROM source_documents WHERE profile_id=?", [b]);
  assert.equal(c, 1);
  await d.close();
});

test("profileCounts：回報各類筆數（刪除確認面板用）", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  await seedMember(d, a, "a");
  const counts = await profileCounts(d, a);
  for (const t of PROFILE_DATA_TABLES) assert.equal(counts[t], 1, t);
  await d.close();
});

// 成員刪除必須連帶清除 CPAP 三表（change viewer-and-history-refinement）。
// 2026-08-13 實測：PROFILE_DATA_TABLES 漏了三表時，DELETE source_documents
// 會 FOREIGN KEY constraint failed，含 CPAP 資料的成員完全刪不掉。
test("deleteProfile：含 CPAP 資料的成員可刪除，三表一併清空", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  await seedMember(d, a, "a");
  const before = await profileCounts(d, a);
  for (const t of ["cpap_daily", "cpap_events", "cpap_oximetry"]) {
    assert.equal(before[t], 1, `刪除前確認 ${t} 有資料，否則此測試恆真`);
  }
  await deleteProfile(d, a);
  for (const t of ["cpap_daily", "cpap_events", "cpap_oximetry",
    "source_documents", "profiles"]) {
    const [{ c }] = await d.select(`SELECT count(*) c FROM ${t}`);
    assert.equal(c, 0, `${t} 應已清空`);
  }
  await d.close();
});
