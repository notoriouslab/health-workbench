// 誤歸屬救援引擎測試（misattribution-rescue change；profile-management spec
// 「匯入紀錄刪除」「匯入紀錄改歸屬」「健保身分綁定守恆」）。
// 快照比對沿 D7 模式：以 id 為鍵全列 JSON，非預期差異一律紅。
import test from "node:test";
import assert from "node:assert/strict";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { EngineStore } from "../../src/engine/store.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import {
  previewDocRescue, deleteSourceDocument, reattributeSourceDocument,
  previewBatchRescue, deleteSourceBatch, reattributeSourceBatch,
  DOC_DATA_TABLES,
} from "../../src/engine/doc_rescue.js";
import { seedCpapDoc, cpapCounts } from "../helpers/cpap_seed.mjs";

const ALL_TABLES = ["profiles", "source_documents", "encounters", "medications",
  "lab_results", "reports", "immunizations", "body_measurements",
  "cancer_screenings", "apple_records", "apple_workouts", "apple_daily",
  "cpap_daily", "cpap_events", "cpap_oximetry"];

async function snapshot(d) {
  const out = {};
  for (const t of ALL_TABLES) {
    out[t] = new Map((await d.select(`SELECT * FROM ${t}`))
      .map(r => [r.id, JSON.stringify(r)]));
  }
  return out;
}

function assertSnapshotEqual(before, after, label = "") {
  for (const t of ALL_TABLES) {
    assert.equal(after[t].size, before[t].size, `${label}${t} 筆數應不變`);
    for (const [id, rowJson] of before[t]) {
      assert.equal(after[t].get(id), rowJson, `${label}${t}#${id} 應逐位元組不變`);
    }
  }
}

// 斷言指定成員的全部列逐位元組不變（未受影響成員防線）
function assertProfileUntouched(before, after, pid, label) {
  for (const t of ALL_TABLES) {
    for (const [id, rowJson] of before[t]) {
      const row = JSON.parse(rowJson);
      const owner = t === "profiles" ? row.id : row.profile_id;
      if (owner !== pid) continue;
      assert.equal(after[t].get(id), rowJson, `${label}：${t}#${id} 不應變動`);
    }
  }
}

// ---------- 來源建構（沿 nondestructive harness） ----------

const nhiBytes = (maskedId, r1rows) => new TextEncoder().encode(
  JSON.stringify({ myhealthbank: { bdata: { "b1.1": maskedId, r1: r1rows } } }));

// 就醫紀錄；meds 陣列會展開為 r1_1 用藥子表（order_code/name/qty/days）
const rec = (date, meds = []) => ({
  "r1.3": "9900000009", "r1.4": "測試院所", "r1.5": date,
  r1_1: meds.map((m, i) => ({
    "r1_1.1": `MED-${m}`, "r1_1.2": `藥品${m}`, "r1_1.3": String(i + 1),
    "r1_1.4": "7",
  })),
});

const nhiSource = (name, maskedId, r1rows) => (
  { bytes: nhiBytes(maskedId, r1rows), name });

const appleXml = (records) => `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_TW">
${records.map(([start, value]) => ` <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count"
  startDate="${start} +0800" endDate="${start.slice(0, 14)}59:00 +0800" value="${value}"/>`).join("\n")}
</HealthData>`;

function appleSource(name, records) {
  const bytes = new TextEncoder().encode(appleXml(records));
  return {
    name, size: bytes.length,
    readAt: async (off, len) => bytes.subarray(off, off + len),
    stream: async function* () { yield bytes; },
  };
}

const OPTS = (pid) => ({ labEntries: [], profileId: pid });

async function freshDb() {
  const d = new NodeDriver();
  await initSchema(d);
  return d;
}

async function docIdByFilename(d, filename) {
  const [row] = await d.select(
    "SELECT id FROM source_documents WHERE filename=?", [filename]);
  return row.id;
}

async function maskedIdOf(d, pid) {
  const [row] = await d.select("SELECT masked_id FROM profiles WHERE id=?", [pid]);
  return row.masked_id;
}

function sabotage(d, pattern) {
  const s = Object.create(d);
  s.execute = (sql, params) => {
    if (pattern.test(sql)) throw new Error("模擬中斷");
    return d.execute(sql, params);
  };
  s.transaction = (fn) => NodeDriver.prototype.transaction.call(d, () => fn(s));
  return s;
}

// 基線：A（本人）健保 a1（含用藥）＋Apple；B（媽媽）健保 b1
async function baseline() {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  await nhiJsonAdapter.importSource(
    nhiSource("a1.json", "A12345****", [rec("20260101", ["X", "Y"]), rec("20260102")]),
    d, null, OPTS(a));
  await appleHealthAdapter.importSource(
    appleSource("a-apple.xml", [["2026-01-01 08:00:00", "100"]]), d, null, { profileId: a });
  await nhiJsonAdapter.importSource(
    nhiSource("b1.json", "B98765****", [rec("20260103", ["Z"])]), d, null, OPTS(b));
  return { d, a, b };
}

// ---------- 預覽 ----------

test("preview：各表筆數與 SQL 直查一致，doc 基本資料齊全", async () => {
  const { d, a } = await baseline();
  const docId = await docIdByFilename(d, "a1.json");
  const p = await previewDocRescue(d, docId);
  assert.equal(p.doc.filename, "a1.json");
  assert.equal(p.doc.profileId, a);
  assert.equal(p.doc.displayName, "本人");
  assert.equal(p.doc.adapter, "nhi_json");
  assert.ok(p.doc.importedAt);
  for (const t of DOC_DATA_TABLES) {
    const [{ c }] = await d.select(
      `SELECT count(*) c FROM ${t} WHERE doc_id=?`, [docId]);
    assert.equal(p.counts[t], c, `${t} 筆數`);
  }
  assert.equal(p.counts.encounters, 2);
  assert.equal(p.counts.medications, 2);
  assert.equal(p.merge, null, "未指定目標時無合併資訊");
  assert.equal(p.nhiGuard, null, "未指定目標時無護欄判定");
  await d.close();
});

test("preview：doc 不存在丟明確錯誤", async () => {
  const d = await freshDb();
  await assert.rejects(() => previewDocRescue(d, 999), /來源檔案不存在/);
  await d.close();
});

test("preview overlapWarning：同家族他 doc 有 skipped_dup 才觸發", async () => {
  const { d, a } = await baseline();
  const a1 = await docIdByFilename(d, "a1.json");
  // 基線：A 名下唯一健保 doc，Apple doc 無 skipped_dup → 不觸發
  assert.equal((await previewDocRescue(d, a1)).overlapWarning, false,
    "無同家族他 doc 時不警告");
  // 匯入與 a1 部分重疊的 a2（20260102 重複）→ a2 有 skipped_dup
  await nhiJsonAdapter.importSource(
    nhiSource("a2.json", "A12345****", [rec("20260102"), rec("20260301")]),
    d, null, OPTS(a));
  assert.equal((await previewDocRescue(d, a1)).overlapWarning, true,
    "同家族他 doc 有 skipped_dup → 警告");
  const a2 = await docIdByFilename(d, "a2.json");
  assert.equal((await previewDocRescue(d, a2)).overlapWarning, false,
    "a1 自身無 skipped_dup，預覽 a2 不警告");
  // Apple doc 不受健保家族 skipped_dup 影響
  const ap = await docIdByFilename(d, "a-apple.xml");
  assert.equal((await previewDocRescue(d, ap)).overlapWarning, false,
    "不同家族不互相觸發");
  await d.close();
});

test("preview merge/nhiGuard：合併筆數精確、健保目標已綁定即阻擋", async () => {
  const { d, a, b } = await baseline();
  const b1 = await docIdByFilename(d, "b1.json");
  // 目標 A 已綁定 → 阻擋
  const blocked = await previewDocRescue(d, b1, { targetProfileId: a });
  assert.equal(blocked.nhiGuard.blocked, true);
  assert.match(blocked.nhiGuard.reason, /不符|已綁定/);
  // 未綁定目標 C：全搬零合併
  const c = await createProfile(d, "爸爸");
  const p = await previewDocRescue(d, b1, { targetProfileId: c });
  assert.equal(p.nhiGuard.blocked, false);
  assert.equal(p.nhiGuard.willUnbindSource, true, "b1 是 B 唯一健保 doc");
  assert.equal(p.nhiGuard.willBindTarget, true);
  assert.equal(p.merge.total, 0);
  assert.equal(p.merge.perTable.encounters, 0);
  await d.close();
});

// ---------- 刪除 ----------

test("delete：連帶清除該 doc 各表、其他列逐位元組不變、回報筆數", async () => {
  const { d, a, b } = await baseline();
  const a1 = await docIdByFilename(d, "a1.json");
  const before = await snapshot(d);
  const r = await deleteSourceDocument(d, a1);
  assert.equal(r.deleted.encounters, 2);
  assert.equal(r.deleted.medications, 2);
  const after = await snapshot(d);
  for (const t of DOC_DATA_TABLES) {
    const [{ c }] = await d.select(
      `SELECT count(*) c FROM ${t} WHERE doc_id=?`, [a1]);
    assert.equal(c, 0, `${t} 應清空`);
  }
  assert.equal(after.source_documents.has(a1), false, "來源紀錄應刪除");
  assertProfileUntouched(before, after, b, "他成員");
  // A 的 Apple doc 與 profiles 列不變（a1 為健保、A 仍有 apple；
  // 但 A 名下健保 doc 歸零 → masked_id 解綁屬預期差異，另測）
  const ap = await docIdByFilename(d, "a-apple.xml");
  assert.equal(after.source_documents.get(ap), before.source_documents.get(ap));
  await d.close();
});

test("delete 解綁矩陣：最後一份健保 doc 刪除→解綁；尚有他份／Apple→不動", async () => {
  const { d, a } = await baseline();
  await nhiJsonAdapter.importSource(
    nhiSource("a2.json", "A12345****", [rec("20260301")]), d, null, OPTS(a));
  // 刪 Apple doc → 綁定不動
  const ap = await docIdByFilename(d, "a-apple.xml");
  let r = await deleteSourceDocument(d, ap);
  assert.equal(r.unbound, false);
  assert.equal(await maskedIdOf(d, a), "A12345****");
  // 刪兩份健保之一 → 綁定不動
  const a1 = await docIdByFilename(d, "a1.json");
  r = await deleteSourceDocument(d, a1);
  assert.equal(r.unbound, false);
  assert.equal(await maskedIdOf(d, a), "A12345****");
  // 刪最後一份 → 解綁
  const a2 = await docIdByFilename(d, "a2.json");
  r = await deleteSourceDocument(d, a2);
  assert.equal(r.unbound, true);
  assert.equal(await maskedIdOf(d, a), null);
  await d.close();
});

test("delete 後 sha256 釋放：同檔可為其他成員重新登記", async () => {
  const { d, b } = await baseline();
  const a1 = await docIdByFilename(d, "a1.json");
  const [{ sha256 }] = await d.select(
    "SELECT sha256 FROM source_documents WHERE id=?", [a1]);
  await deleteSourceDocument(d, a1);
  const store = new EngineStore(d);
  const r = await store.registerSource(b, "a1.json", sha256, "nhi_json", "t");
  assert.equal(r.importedAt, null, "不再被視為重複檔");
  await d.close();
});

test("delete 中斷：整批回滾，全庫與操作前全等", async () => {
  const { d } = await baseline();
  const a1 = await docIdByFilename(d, "a1.json");
  const before = await snapshot(d);
  // 故障點＝最後的 source_documents DELETE：此時關聯列已全刪＝最大部分狀態
  const s = sabotage(d, /DELETE FROM source_documents/);
  await assert.rejects(() => deleteSourceDocument(s, a1), /模擬中斷/);
  assertSnapshotEqual(before, await snapshot(d), "刪除回滾：");
  await d.close();
});

test("delete：doc 不存在丟明確錯誤且零寫入", async () => {
  const { d } = await baseline();
  const before = await snapshot(d);
  await assert.rejects(() => deleteSourceDocument(d, 999), /來源檔案不存在/);
  assertSnapshotEqual(before, await snapshot(d));
  await d.close();
});

// ---------- 改歸屬 ----------

test("reattribute 全搬：目標無衝突時筆數對帳、來源清空、doc 改掛", async () => {
  const { d, a, b } = await baseline();
  const before = await snapshot(d);
  // Apple doc 誤匯情境：A 的 Apple 檔實為 C 的資料
  const c = await createProfile(d, "爸爸");
  const ap = await docIdByFilename(d, "a-apple.xml");
  const r = await reattributeSourceDocument(d, ap, c);
  assert.equal(r.moved.apple_records, 1);
  assert.equal(r.merged.apple_records, 0);
  // apple_daily（KEY_DUP 手動接線項）：漏接的症狀是「搬移 0 筆看似成功」
  assert.equal(r.moved.apple_daily, 1, "彙總列必須跟著改歸屬");
  const [{ dc }] = await d.select(
    "SELECT count(*) dc FROM apple_daily WHERE profile_id=?", [c]);
  assert.equal(dc, 1, "彙總列 profile_id 必須改掛到目標成員");
  assert.deepEqual(r.binding, { sourceUnbound: false, targetBound: false },
    "Apple doc 不動綁定");
  const [doc] = await d.select(
    "SELECT profile_id FROM source_documents WHERE id=?", [ap]);
  assert.equal(doc.profile_id, c);
  const [{ ca }] = await d.select(
    "SELECT count(*) ca FROM apple_records WHERE profile_id=?", [a]);
  assert.equal(ca, 0, "來源成員 Apple 資料清空");
  const [{ cc }] = await d.select(
    "SELECT count(*) cc FROM apple_records WHERE profile_id=?", [c]);
  assert.equal(cc, 1);
  const after = await snapshot(d);
  assertProfileUntouched(before, after, b, "未受影響成員");
  await d.close();
});

test("reattribute 合併（指紋表）：來源重複列與其用藥刪除、目標列保留、與預覽對帳", async () => {
  const { d, b } = await baseline();
  const c = await createProfile(d, "爸爸");
  const b1 = await docIdByFilename(d, "b1.json");
  // 讓目標 C 已有與 B 同指紋的 encounter（含自己的用藥）：
  // 直插 C 自己的 doc 與同 fp/canonical 列（模擬 C 曾自行匯入同內容）
  const [bEnc] = await d.select(
    "SELECT section, record_fp, canonical FROM encounters WHERE doc_id=?", [b1]);
  const cdoc = await d.execute(
    "INSERT INTO source_documents(profile_id,filename,sha256,adapter,adapter_version)"
    + " VALUES(?,?,?,?,?)", [c, "c-own.json", "sha-c-own", "nhi_json", "t"]);
  const cEnc = await d.execute(
    "INSERT INTO encounters(profile_id,doc_id,section,source_index,record_fp,canonical,type)"
    + " VALUES(?,?,?,?,?,?,?)",
    [c, cdoc.lastInsertRowid, bEnc.section, 0, bEnc.record_fp, bEnc.canonical, "門診"]);
  await d.execute(
    "INSERT INTO medications(profile_id,doc_id,encounter_id,section,source_index,order_name)"
    + " VALUES(?,?,?,?,?,?)",
    [c, cdoc.lastInsertRowid, cEnc.lastInsertRowid, "r1>r1_1", 0, "C自己的藥"]);
  // 目標已有健保 doc 但未綁定（轉綁過渡態），nhiGuard 應放行
  const p = await previewDocRescue(d, b1, { targetProfileId: c });
  assert.equal(p.nhiGuard.blocked, false);
  assert.equal(p.merge.perTable.encounters, 1);
  assert.equal(p.merge.perTable.medications, 1, "來源重複 encounter 名下用藥隨之合併");
  const r = await reattributeSourceDocument(d, b1, c);
  assert.deepEqual(
    { encounters: r.merged.encounters, medications: r.merged.medications },
    { encounters: p.merge.perTable.encounters, medications: p.merge.perTable.medications },
    "預覽與執行對帳");
  assert.equal(r.moved.encounters, 0, "唯一 encounter 已合併，無搬移列");
  // 目標列與其用藥保留
  const [tgt] = await d.select("SELECT * FROM encounters WHERE id=?", [cEnc.lastInsertRowid]);
  assert.equal(tgt.profile_id, c);
  const meds = await d.select(
    "SELECT order_name FROM medications WHERE encounter_id=?", [cEnc.lastInsertRowid]);
  assert.deepEqual(meds.map(m => m.order_name), ["C自己的藥"]);
  // 來源重複列與其用藥消失
  const [{ cb }] = await d.select(
    "SELECT count(*) cb FROM encounters WHERE profile_id=?", [b]);
  assert.equal(cb, 0);
  const [{ cm }] = await d.select(
    "SELECT count(*) cm FROM medications WHERE profile_id=?", [b]);
  assert.equal(cm, 0);
  // doc 本身改掛目標
  const [doc] = await d.select(
    "SELECT profile_id FROM source_documents WHERE id=?", [b1]);
  assert.equal(doc.profile_id, c);
  await d.close();
});

test("reattribute 碰撞旗標：同 fp 異 canonical 目標列補旗標且不重複追加", async () => {
  const { d, b } = await baseline();
  const c = await createProfile(d, "爸爸");
  const b1 = await docIdByFilename(d, "b1.json");
  const [bEnc] = await d.select(
    "SELECT section, record_fp FROM encounters WHERE doc_id=?", [b1]);
  // B 另有一份健保 doc（空殼）：搬走 b1 不觸發綁定轉移，C 維持未綁定
  await d.execute(
    "INSERT INTO source_documents(profile_id,filename,sha256,adapter,adapter_version)"
    + " VALUES(?,?,?,?,?)", [b, "b-extra.json", "sha-b-extra", "nhi_json", "t"]);
  const cdoc = await d.execute(
    "INSERT INTO source_documents(profile_id,filename,sha256,adapter,adapter_version)"
    + " VALUES(?,?,?,?,?)", [c, "c-own.json", "sha-c-own", "nhi_json", "t"]);
  const cEnc = await d.execute(
    "INSERT INTO encounters(profile_id,doc_id,section,source_index,record_fp,canonical,type,quality_flags)"
    + " VALUES(?,?,?,?,?,?,?,?)",
    [c, cdoc.lastInsertRowid, bEnc.section, 0, bEnc.record_fp, '{"不同":1}', "門診", "missing_date"]);
  const r1 = await reattributeSourceDocument(d, b1, c);
  assert.deepEqual(r1.binding, { sourceUnbound: false, targetBound: false });
  const [tgt] = await d.select(
    "SELECT quality_flags FROM encounters WHERE id=?", [cEnc.lastInsertRowid]);
  assert.equal(tgt.quality_flags, "missing_date,fingerprint_collision");
  // 第二次：另一位未綁定成員的同 fp 異 canonical doc 搬入（C 仍未綁定
  // 故護欄放行），旗標已存在不得重複追加
  const e = await createProfile(d, "外人");
  const edoc = await d.execute(
    "INSERT INTO source_documents(profile_id,filename,sha256,adapter,adapter_version)"
    + " VALUES(?,?,?,?,?)", [e, "e.json", "sha-e", "nhi_json", "t"]);
  await d.execute(
    "INSERT INTO encounters(profile_id,doc_id,section,source_index,record_fp,canonical,type)"
    + " VALUES(?,?,?,?,?,?,?)",
    [e, edoc.lastInsertRowid, bEnc.section, 0, bEnc.record_fp, '{"又不同":2}', "門診"]);
  await reattributeSourceDocument(d, edoc.lastInsertRowid, c);
  const [tgt2] = await d.select(
    "SELECT quality_flags FROM encounters WHERE id=?", [cEnc.lastInsertRowid]);
  assert.equal(tgt2.quality_flags, "missing_date,fingerprint_collision", "不重複追加");
  await d.close();
});

test("reattribute apple 合併：同去重鍵刪來源列、不同鍵搬移", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  await appleHealthAdapter.importSource(
    appleSource("e1.xml", [["2026-01-01 08:00:00", "100"]]), d, null, { profileId: a });
  // B 誤匯了 A 的新匯出檔（累積全量：含舊紀錄＋新紀錄）
  await appleHealthAdapter.importSource(
    appleSource("e2.xml", [["2026-01-01 08:00:00", "100"], ["2026-02-01 09:00:00", "200"]]),
    d, null, { profileId: b });
  const e2 = await docIdByFilename(d, "e2.xml");
  const p = await previewDocRescue(d, e2, { targetProfileId: a });
  assert.equal(p.merge.perTable.apple_records, 1, "舊紀錄與 A 既有同鍵");
  const r = await reattributeSourceDocument(d, e2, a);
  assert.equal(r.merged.apple_records, 1);
  assert.equal(r.moved.apple_records, 1);
  const rows = await d.select(
    "SELECT value_numeric FROM apple_records WHERE profile_id=? ORDER BY start_ts", [a]);
  assert.deepEqual(rows.map(x => x.value_numeric), [100, 200]);
  const [{ cb }] = await d.select(
    "SELECT count(*) cb FROM apple_records WHERE profile_id=?", [b]);
  assert.equal(cb, 0);
  await d.close();
});

test("reattribute 綁定矩陣：目標已綁→丟錯零寫入；最後一份搬走→解綁＋轉綁；尚有他份→不動", async () => {
  const { d, a, b } = await baseline();
  const b1 = await docIdByFilename(d, "b1.json");
  // 目標已綁 → 丟錯零寫入
  const before = await snapshot(d);
  await assert.rejects(() => reattributeSourceDocument(d, b1, a), /不符|已綁定/);
  assertSnapshotEqual(before, await snapshot(d), "阻擋零寫入：");
  // B 唯一健保 doc 搬到未綁定 C → B 解綁、C 轉綁
  const c = await createProfile(d, "爸爸");
  const r = await reattributeSourceDocument(d, b1, c);
  assert.deepEqual(r.binding, { sourceUnbound: true, targetBound: true });
  assert.equal(await maskedIdOf(d, b), null);
  assert.equal(await maskedIdOf(d, c), "B98765****");
  // A 有兩份健保 doc，搬一份到未綁定 D → 雙方綁定不動
  await nhiJsonAdapter.importSource(
    nhiSource("a2.json", "A12345****", [rec("20260301")]), d, null, OPTS(a));
  const dMember = await createProfile(d, "弟弟");
  const a1 = await docIdByFilename(d, "a1.json");
  const r2 = await reattributeSourceDocument(d, a1, dMember);
  assert.deepEqual(r2.binding, { sourceUnbound: false, targetBound: false });
  assert.equal(await maskedIdOf(d, a), "A12345****");
  assert.equal(await maskedIdOf(d, dMember), null);
  await d.close();
});

test("reattribute 前置檢查：doc 不存在／目標不存在／目標即現歸屬，全部零寫入", async () => {
  const { d, a } = await baseline();
  const a1 = await docIdByFilename(d, "a1.json");
  const before = await snapshot(d);
  await assert.rejects(() => reattributeSourceDocument(d, 999, a), /來源檔案不存在/);
  await assert.rejects(() => reattributeSourceDocument(d, a1, 999), /目標成員不存在/);
  await assert.rejects(() => reattributeSourceDocument(d, a1, a), /已屬於|即現歸屬/);
  assertSnapshotEqual(before, await snapshot(d), "前置檢查零寫入：");
  await d.close();
});

test("reattribute 中斷：整批回滾，全庫與操作前全等", async () => {
  const { d, b } = await baseline();
  const c = await createProfile(d, "爸爸");
  const b1 = await docIdByFilename(d, "b1.json");
  const before = await snapshot(d);
  // 故障點＝source_documents 改掛（各資料表已搬完＝最大部分狀態）
  const s = sabotage(d, /UPDATE source_documents SET profile_id/);
  await assert.rejects(() => reattributeSourceDocument(s, b1, c), /模擬中斷/);
  assertSnapshotEqual(before, await snapshot(d), "改歸屬回滾：");
  await d.close();
});

// ---------- CPAP 來源檔的救援（change viewer-and-history-refinement）----------
// 三個實測到的缺陷：刪除 FK 失敗、改歸屬把資料留在原成員、成員刪除 FK 失敗
// （後者在 profiles.test.mjs）。CPAP change 新增三張表卻沒接上 doc_rescue。

test("CPAP 來源檔刪除：三表連帶清除（漏接時 FK 會直接失敗）", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const docId = await seedCpapDoc(d, a);
  const preview = await previewDocRescue(d, docId);
  assert.equal(preview.counts.cpap_daily, 1, "預覽必須算到 CPAP 筆數");
  assert.equal(preview.counts.cpap_events, 1);
  assert.equal(preview.counts.cpap_oximetry, 1);

  const r = await deleteSourceDocument(d, docId);
  assert.equal(r.deleted.cpap_daily, 1);
  assert.equal(r.deleted.cpap_events, 1);
  assert.equal(r.deleted.cpap_oximetry, 1);
  assert.deepEqual(await cpapCounts(d), { daily: 0, events: 0, oximetry: 0 });
  assert.equal((await d.select("SELECT COUNT(*) c FROM source_documents"))[0].c, 0);
  await d.close();
});

test("CPAP 來源檔改歸屬：三表跟著搬，不留在原成員", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  const docId = await seedCpapDoc(d, a);

  const r = await reattributeSourceDocument(d, docId, b);
  assert.equal(r.moved.cpap_daily, 1, "回報的搬移筆數必須含 CPAP（原本全是 0）");
  assert.equal(r.moved.cpap_events, 1);
  assert.equal(r.moved.cpap_oximetry, 1);
  for (const t of ["cpap_daily", "cpap_events", "cpap_oximetry"]) {
    const rows = await d.select(`SELECT profile_id FROM ${t}`);
    assert.deepEqual(rows.map(x => x.profile_id), [b],
      `${t} 的 profile_id 必須是目標成員，留在原成員等於資料沒搬`);
  }
  const [{ profile_id: docOwner }] = await d.select(
    "SELECT profile_id FROM source_documents WHERE id=?", [docId]);
  assert.equal(docOwner, b);
  await d.close();
});

test("CPAP 改歸屬：與目標既有同去重鍵者合併，其餘搬移", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  // 目標成員已有同一台機器、同一天的資料（同去重鍵）
  await seedCpapDoc(d, b, { sha: "cpap-b", device: "Dev", date: "2023-06-12" });
  // 來源：同鍵一組（會合併）＋不同日一組（會搬移）
  const docId = await seedCpapDoc(d, a, { sha: "cpap-a", device: "Dev",
    date: "2023-06-12" });
  await d.execute(
    "INSERT INTO cpap_daily(profile_id,doc_id,device,summary_date,ahi)"
    + " VALUES(?,?,?,?,?)", [a, docId, "Dev", "2023-06-20", 3.1]);

  const preview = await previewDocRescue(d, docId, { targetProfileId: b });
  assert.equal(preview.merge.perTable.cpap_daily, 1,
    "同 device＋同 summary_date 的那一列要算成合併");

  const r = await reattributeSourceDocument(d, docId, b);
  assert.equal(r.merged.cpap_daily, 1, "同鍵者合併（來源列刪除、目標列保留）");
  assert.equal(r.moved.cpap_daily, 1, "不同日的那列搬移");
  const daily = (await d.select(
    "SELECT profile_id, summary_date FROM cpap_daily ORDER BY summary_date"))
    .map(r => ({ ...r }));
  assert.deepEqual(daily, [
    { profile_id: b, summary_date: "2023-06-12" },
    { profile_id: b, summary_date: "2023-06-20" },
  ], "目標成員各日期只剩一列，且全部歸屬目標");
  await d.close();
});

test("批次刪除：三個 CPAP 檔一次清除，各表合計正確", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await seedCpapDoc(d, a, { sha: `cpap-${i}`,
      date: `2023-06-1${i + 2}`, tsSuffix: `2${i}:00:00` }));
  }
  const preview = await previewBatchRescue(d, ids);
  assert.equal(preview.docCount, 3);
  assert.equal(preview.counts.cpap_daily, 3, "預覽為整批合計");
  assert.equal(preview.counts.cpap_events, 3);

  const r = await deleteSourceBatch(d, ids);
  assert.equal(r.docCount, 3);
  assert.equal(r.deleted.cpap_daily, 3);
  assert.deepEqual(await cpapCounts(d), { daily: 0, events: 0, oximetry: 0 });
  assert.equal((await d.select("SELECT COUNT(*) c FROM source_documents"))[0].c, 0);
  await d.close();
});

test("批次刪除中途失敗：整批回滾，全庫逐位元組不變", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await seedCpapDoc(d, a, { sha: `cpap-${i}`,
      date: `2023-06-1${i + 2}`, tsSuffix: `2${i}:00:00` }));
  }
  const before = await snapshot(d);

  // 第 3 次刪 source_documents 時拋錯（手法同 nondestructive.test.mjs）
  let hits = 0;
  const sabotaged = Object.create(d);
  sabotaged.execute = (sql, params) => {
    if (/DELETE FROM source_documents/.test(sql)) {
      hits += 1;
      if (hits === 3) throw new Error("模擬中途故障");
    }
    return d.execute(sql, params);
  };
  sabotaged.transaction = (fn) =>
    NodeDriver.prototype.transaction.call(d, () => fn(sabotaged));

  await assert.rejects(() => deleteSourceBatch(sabotaged, ids), /模擬中途故障/);
  assertSnapshotEqual(before, await snapshot(d), "批次刪除失敗後：");
  await d.close();
});

test("批次改歸屬：三個檔的資料一起搬到目標成員", async () => {
  const d = await freshDb();
  const a = await createProfile(d, "本人");
  const b = await createProfile(d, "媽媽");
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await seedCpapDoc(d, a, { sha: `cpap-${i}`,
      date: `2023-06-1${i + 2}`, tsSuffix: `2${i}:00:00` }));
  }
  const r = await reattributeSourceBatch(d, ids, b);
  assert.equal(r.docCount, 3);
  assert.equal(r.moved.cpap_daily, 3);
  for (const t of ["cpap_daily", "cpap_events", "cpap_oximetry",
    "source_documents"]) {
    const rows = await d.select(`SELECT DISTINCT profile_id FROM ${t}`);
    assert.deepEqual(rows.map(x => x.profile_id), [b], `${t} 全部歸屬目標成員`);
  }
  await d.close();
});
