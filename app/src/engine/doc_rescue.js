// 誤歸屬救援：單筆 source_document 的預覽／刪除／改歸屬
// （misattribution-rescue design D1-D4；profile-management spec）。
// 全部 DML 單一交易，執行函式不信任預覽數字（前置檢查與合併判定
// 在交易內重算，design Risks）。
import { FP_TABLES } from "./store.js";

// 一筆來源檔案的全部關聯資料表。profile-management spec 的「匯入紀錄刪除」
// 要求刪除「該檔全部關聯資料列」，所以新增資料表 MUST 同步加進這裡：
// cpap_* 的 doc_id 有 REFERENCES source_documents(id)，漏加會讓刪除在
// DELETE source_documents 那步 FOREIGN KEY constraint failed（2026-08-13
// 實測，CPAP change 引入時漏接）。tests/engine/table_coverage.test.mjs 以
// DDL 對帳釘住。
// 順序：medications 先於其母表 encounters；cpap 三表彼此無 FK 依賴。
export const DOC_DATA_TABLES = [
  "medications", ...FP_TABLES, "apple_records", "apple_workouts",
  "apple_daily", "cpap_daily", "cpap_events", "cpap_oximetry",
];

// 健保家族判定：LIKE 'nhi_%' 的底線是萬用字元，改用前綴比對
const isNhiAdapter = (adapter) => String(adapter).startsWith("nhi_");
// 來源家族：nhi_json/nhi_xml 一族，其餘（apple_health）各自成族
const familyOf = (adapter) => (isNhiAdapter(adapter) ? "nhi" : String(adapter));

// 自然去重鍵表的比對條件（鏡像各表 schema 的 UNIQUE 定義）。
// apple_records 的 UNIQUE INDEX 用 COALESCE，apple_workouts 用一般欄位
// （NULL 彼此相異），MUST 分別鏡像，不得互換。
const KEY_MATCH = {
  apple_records: "x.type=s.type AND x.start_ts=s.start_ts AND x.end_ts=s.end_ts"
    + " AND COALESCE(x.source_name,'')=COALESCE(s.source_name,'')"
    + " AND COALESCE(x.value_numeric,-999999.25)=COALESCE(s.value_numeric,-999999.25)"
    + " AND COALESCE(x.value_text,'')=COALESCE(s.value_text,'')",
  apple_workouts: "x.activity=s.activity AND x.start_ts=s.start_ts"
    + " AND x.end_ts=s.end_ts AND x.source_name=s.source_name",
  // CPAP 三表：鏡像 schema 的 UNIQUE(profile_id, device, …)。**只比對鍵、
  // 不比對數值**，與上面兩個 apple 表刻意不同：Apple 同時刻可能有多來源不同
  // 值（所以要比對數值才算重複），而同一台機器同一晚的 CPAP 摘要只會有一份，
  // 比對鍵即是匯入時的去重語意（匯入就是 UNIQUE 衝突即略過），也才符合
  // profile-management spec 要求的「鏡像匯入去重規則」。
  // apple_daily：鏡像 UNIQUE(profile_id, type_zh, day, source_name)。
  // 只比對鍵不比對數值（同 CPAP 理由：同鍵的彙總只會有一份）。
  apple_daily: "x.type_zh=s.type_zh AND x.day=s.day AND x.source_name=s.source_name",
  cpap_daily: "x.device=s.device AND x.summary_date=s.summary_date",
  cpap_events: "x.device=s.device AND x.start_ts=s.start_ts"
    + " AND x.event_type=s.event_type",
  cpap_oximetry: "x.device=s.device AND x.minute_ts=s.minute_ts",
};

// 以自然去重鍵搬移的表（非指紋表）：apple 兩表與 CPAP 三表共用同一段邏輯，
// 同去重鍵的來源列刪除、其餘改掛目標成員。
const KEY_DUP_TABLES = ["apple_records", "apple_workouts", "apple_daily",
  "cpap_daily", "cpap_events", "cpap_oximetry"];

async function getDoc(driver, docId) {
  const rows = await driver.select(
    "SELECT d.id, d.profile_id, d.filename, d.sha256, d.adapter,"
    + " d.imported_at, p.display_name, p.masked_id"
    + " FROM source_documents d JOIN profiles p ON d.profile_id=p.id"
    + " WHERE d.id=?", [docId]);
  if (!rows.length) throw new Error(`來源檔案不存在（id=${docId}）。`);
  return rows[0];
}

async function docCounts(driver, docId) {
  const counts = {};
  for (const t of DOC_DATA_TABLES) {
    const [{ c }] = await driver.select(
      `SELECT count(*) c FROM ${t} WHERE doc_id=?`, [docId]);
    counts[t] = c;
  }
  return counts;
}

// 同成員其他健保 doc 數（解綁判定用）；excludeDocId＝本次操作的 doc
async function otherNhiDocCount(driver, profileId, excludeDocId) {
  const [{ c }] = await driver.select(
    "SELECT count(*) c FROM source_documents"
    + " WHERE profile_id=? AND id!=? AND substr(adapter,1,4)='nhi_'",
    [profileId, excludeDocId]);
  return c;
}

// D2 重疊警告啟發式：同成員、同來源家族的其他 doc，任一 import_stats
// 的 skipped_dup 任表 >0（doc 級近似，可能過度警告，文案用「可能」）
async function hasOverlapRisk(driver, doc) {
  const others = await driver.select(
    "SELECT adapter, import_stats FROM source_documents"
    + " WHERE profile_id=? AND id!=?", [doc.profile_id, doc.id]);
  const family = familyOf(doc.adapter);
  for (const o of others) {
    if (familyOf(o.adapter) !== family || !o.import_stats) continue;
    let stats;
    try { stats = JSON.parse(o.import_stats); } catch { continue; }
    const skipped = stats?.skipped_dup ?? {};
    if (Object.values(skipped).some(n => n > 0)) return true;
  }
  return false;
}

// 指紋表：來源 doc 中與目標成員同 (section, record_fp) 的列
const fpDupSelect = (t) =>
  `SELECT s.id, s.section, s.record_fp, s.canonical FROM ${t} s`
  + ` WHERE s.doc_id=? AND EXISTS(SELECT 1 FROM ${t} x`
  + " WHERE x.profile_id=? AND x.section=s.section AND x.record_fp=s.record_fp)";

// 自然去重鍵的表（apple 兩表與 CPAP 三表）：來源 doc 中與目標成員同鍵的列
const keyDupSelect = (t) =>
  `SELECT s.id FROM ${t} s WHERE s.doc_id=? AND EXISTS(SELECT 1 FROM ${t} x`
  + ` WHERE x.profile_id=? AND ${KEY_MATCH[t]})`;

// 來源重複 encounters 名下的用藥數（合併時連帶刪除）
async function dupEncounterMedCount(driver, docId, targetProfileId) {
  const [{ c }] = await driver.select(
    "SELECT count(*) c FROM medications m WHERE m.encounter_id IN"
    + ` (${fpDupSelect("encounters").replace("s.id, s.section, s.record_fp, s.canonical", "s.id")})`,
    [docId, targetProfileId]);
  return c;
}

async function mergeCounts(driver, docId, targetProfileId) {
  const perTable = {};
  for (const t of FP_TABLES) {
    const [{ c }] = await driver.select(
      `SELECT count(*) c FROM (${fpDupSelect(t)})`, [docId, targetProfileId]);
    perTable[t] = c;
  }
  for (const t of KEY_DUP_TABLES) {
    const [{ c }] = await driver.select(
      `SELECT count(*) c FROM (${keyDupSelect(t)})`, [docId, targetProfileId]);
    perTable[t] = c;
  }
  perTable.medications = await dupEncounterMedCount(driver, docId, targetProfileId);
  const total = Object.values(perTable).reduce((s, n) => s + n, 0);
  return { perTable, total };
}

async function getTargetProfile(driver, targetProfileId) {
  const rows = await driver.select(
    "SELECT id, display_name, masked_id FROM profiles WHERE id=?",
    [targetProfileId]);
  if (!rows.length) throw new Error(`目標成員不存在（id=${targetProfileId}）。`);
  return rows[0];
}

// D4 綁定守恆判定（純判定不寫入）
function nhiGuardVerdict(doc, target, sourceOtherNhiCount) {
  if (target.masked_id != null) {
    return {
      blocked: true,
      reason: `檔案身分與目標成員不符：「${target.display_name}」已綁定`
        + ` ${target.masked_id}，此健保檔屬於「${doc.display_name}」`
        + `綁定的 ${doc.masked_id ?? "（未綁定）"}。`,
      willUnbindSource: false, willBindTarget: false,
    };
  }
  const willUnbindSource = sourceOtherNhiCount === 0 && doc.masked_id != null;
  return {
    blocked: false, reason: null,
    willUnbindSource, willBindTarget: willUnbindSource,
  };
}

// 預覽：明細筆數、重疊警告、（指定目標時）合併筆數與健保護欄判定
export async function previewDocRescue(driver, docId, { targetProfileId = null } = {}) {
  const doc = await getDoc(driver, docId);
  const counts = await docCounts(driver, docId);
  const overlapWarning = await hasOverlapRisk(driver, doc);
  let merge = null, nhiGuard = null;
  if (targetProfileId != null) {
    merge = await mergeCounts(driver, docId, targetProfileId);
    if (isNhiAdapter(doc.adapter)) {
      const target = await getTargetProfile(driver, targetProfileId);
      const otherNhi = await otherNhiDocCount(driver, doc.profile_id, docId);
      nhiGuard = nhiGuardVerdict(doc, target, otherNhi);
    }
  }
  return {
    doc: {
      id: doc.id, profileId: doc.profile_id, displayName: doc.display_name,
      filename: doc.filename, adapter: doc.adapter, importedAt: doc.imported_at,
    },
    counts, overlapWarning, merge, nhiGuard,
  };
}

// 批次預覽（change viewer-and-history-refinement D5）：各表 counts 與 merge
// 取整批合計，overlapWarning 任一為真即為真。docIds 由檢視層依「同 adapter
// ＋同 imported_at」算出後傳入。
//
// NHI 綁定判定的已知限制：多檔批次目前只可能來自 CPAP（健保與 Apple 都是單檔
// 匯入，它們的「批次」永遠是一檔），所以這裡取批內第一個有判定的即可。若未來
// 出現多檔健保來源，這段要重新檢視——整批解綁的判定需要以「排除整批」計算，
// 而不是逐檔各自判定。
export async function previewBatchRescue(driver, docIds,
  { targetProfileId = null } = {}) {
  if (!docIds?.length) throw new Error("批次為空，沒有可預覽的來源檔案。");
  const previews = [];
  for (const docId of docIds) {
    previews.push(await previewDocRescue(driver, docId, { targetProfileId }));
  }
  const counts = {};
  for (const p of previews) {
    for (const [t, n] of Object.entries(p.counts)) counts[t] = (counts[t] || 0) + n;
  }
  const first = previews[0];
  return {
    docCount: previews.length,
    filenames: previews.map(p => p.doc.filename),
    adapter: first.doc.adapter,
    importedAt: first.doc.importedAt,
    profileId: first.doc.profileId,
    displayName: first.doc.displayName,
    counts,
    overlapWarning: previews.some(p => p.overlapWarning),
    merge: targetProfileId == null ? null
      : { total: previews.reduce((s, p) => s + (p.merge?.total || 0), 0) },
    nhiGuard: previews.find(p => p.nhiGuard)?.nhiGuard ?? null,
  };
}

// 刪除單筆的核心。呼叫端負責 transaction，因為批次版要把整批放進**同一個**
// transaction（SQLite 不支援嵌套 transaction，批次版不能改成呼叫單檔版 N 次）。
// 逐個套用同一段邏輯在 NHI 語意上是自然正確的：解綁判定會隨著批內前面幾筆
// 已被刪除而變化，也就是刪到最後一份健保檔時才解綁。
async function deleteDocIn(tx, docId) {
  const doc = await getDoc(tx, docId);
  const deleted = {};
  for (const t of DOC_DATA_TABLES) {
    const r = await tx.execute(`DELETE FROM ${t} WHERE doc_id=?`, [docId]);
    deleted[t] = r.changes;
  }
  await tx.execute("DELETE FROM source_documents WHERE id=?", [docId]);
  let unbound = false;
  if (isNhiAdapter(doc.adapter) && doc.masked_id != null
    && await otherNhiDocCount(tx, doc.profile_id, docId) === 0) {
    await tx.execute(
      "UPDATE profiles SET masked_id=NULL WHERE id=?", [doc.profile_id]);
    unbound = true;
  }
  return { deleted, unbound };
}

// 刪除單筆匯入：單一交易連帶清除，回傳各表刪除筆數與是否解綁
export async function deleteSourceDocument(driver, docId) {
  return driver.transaction(async (tx) => deleteDocIn(tx, docId));
}

// 刪除整批：單一交易，全成功或全回復。docIds 由檢視層依「同 adapter ＋同
// imported_at」算出後傳入；引擎層不重新推導批次（不該知道 UI 的分組規則）。
export async function deleteSourceBatch(driver, docIds) {
  if (!docIds?.length) throw new Error("批次為空，沒有可刪除的來源檔案。");
  return driver.transaction(async (tx) => {
    const deleted = {};
    let unbound = false;
    for (const docId of docIds) {
      const r = await deleteDocIn(tx, docId);
      for (const [t, n] of Object.entries(r.deleted)) {
        deleted[t] = (deleted[t] || 0) + n;
      }
      unbound = unbound || r.unbound;
    }
    return { deleted, unbound, docCount: docIds.length };
  });
}

// 改歸屬單筆的核心。呼叫端負責 transaction，理由同 deleteDocIn。
async function reattributeDocIn(tx, docId, targetProfileId) {
  const doc = await getDoc(tx, docId);
  const target = await getTargetProfile(tx, targetProfileId);
  if (target.id === doc.profile_id) {
    throw new Error(`此檔案已屬於「${target.display_name}」（目標即現歸屬）。`);
  }
  const nhi = isNhiAdapter(doc.adapter);
  const otherNhi = nhi ? await otherNhiDocCount(tx, doc.profile_id, docId) : 0;
  const guard = nhi ? nhiGuardVerdict(doc, target, otherNhi) : null;
  if (guard?.blocked) throw new Error(guard.reason);

  const moved = {}, merged = {};
  // 指紋表：先處理與目標重複的來源列（encounters 最先，其用藥連帶）
  for (const t of FP_TABLES) {
    const dups = await tx.select(fpDupSelect(t), [docId, target.id]);
    for (const dup of dups) {
      const [tgt] = await tx.select(
        `SELECT id, canonical, quality_flags FROM ${t}`
        + " WHERE profile_id=? AND section=? AND record_fp=?",
        [target.id, dup.section, dup.record_fp]);
      if (tgt.canonical !== dup.canonical
        && !String(tgt.quality_flags).split(",").includes("fingerprint_collision")) {
        await tx.execute(
          `UPDATE ${t} SET quality_flags = CASE WHEN quality_flags=''`
          + " THEN 'fingerprint_collision'"
          + " ELSE quality_flags || ',fingerprint_collision' END WHERE id=?",
          [tgt.id]);
      }
    }
    if (t === "encounters") {
      merged.medications = 0;
      if (dups.length) {
        const marks = dups.map(() => "?").join(",");
        const rm = await tx.execute(
          `DELETE FROM medications WHERE encounter_id IN (${marks})`,
          dups.map(x => x.id));
        merged.medications = rm.changes;
      }
    }
    if (dups.length) {
      const marks = dups.map(() => "?").join(",");
      await tx.execute(
        `DELETE FROM ${t} WHERE id IN (${marks})`, dups.map(x => x.id));
    }
    merged[t] = dups.length;
    const mv = await tx.execute(
      `UPDATE ${t} SET profile_id=? WHERE doc_id=?`, [target.id, docId]);
    moved[t] = mv.changes;
  }
  // 剩餘用藥隨母 encounter 改掛
  const mvMed = await tx.execute(
    "UPDATE medications SET profile_id=? WHERE doc_id=?", [target.id, docId]);
  moved.medications = mvMed.changes;
  // 自然去重鍵的表（apple 兩表與 CPAP 三表）：同去重鍵刪來源列、其餘改掛。
  // CPAP 三表漏在這裡會讓改歸屬「看似成功」：source_documents 改掛了，
  // cpap_* 的 profile_id 卻留在原成員，回報的 moved 全是 0（2026-08-13 實測）。
  for (const t of KEY_DUP_TABLES) {
    const dups = await tx.select(keyDupSelect(t), [docId, target.id]);
    if (dups.length) {
      const marks = dups.map(() => "?").join(",");
      await tx.execute(
        `DELETE FROM ${t} WHERE id IN (${marks})`, dups.map(x => x.id));
    }
    merged[t] = dups.length;
    const mv = await tx.execute(
      `UPDATE ${t} SET profile_id=? WHERE doc_id=?`, [target.id, docId]);
    moved[t] = mv.changes;
  }
  // doc 本身改掛
  await tx.execute(
    "UPDATE source_documents SET profile_id=? WHERE id=?", [target.id, docId]);
  // 綁定守恆：來源失去最後一份健保 doc → 解綁並轉綁目標（必未綁）
  const binding = { sourceUnbound: false, targetBound: false };
  if (nhi && guard.willUnbindSource) {
    await tx.execute(
      "UPDATE profiles SET masked_id=NULL WHERE id=?", [doc.profile_id]);
    await tx.execute(
      "UPDATE profiles SET masked_id=? WHERE id=?", [doc.masked_id, target.id]);
    binding.sourceUnbound = true;
    binding.targetBound = true;
  }
  return { moved, merged, binding };
}

// 改歸屬：單一交易，合併語意鏡像匯入去重（design D3），綁定守恆（D4）
export async function reattributeSourceDocument(driver, docId, targetProfileId) {
  return driver.transaction(async (tx) => reattributeDocIn(tx, docId, targetProfileId));
}

// 改歸屬整批：單一交易，全成功或全回復。合計各表搬移與合併筆數。
export async function reattributeSourceBatch(driver, docIds, targetProfileId) {
  if (!docIds?.length) throw new Error("批次為空，沒有可改歸屬的來源檔案。");
  return driver.transaction(async (tx) => {
    const moved = {}, merged = {};
    const binding = { sourceUnbound: false, targetBound: false };
    for (const docId of docIds) {
      const r = await reattributeDocIn(tx, docId, targetProfileId);
      for (const [t, n] of Object.entries(r.moved)) moved[t] = (moved[t] || 0) + n;
      for (const [t, n] of Object.entries(r.merged)) merged[t] = (merged[t] || 0) + n;
      binding.sourceUnbound = binding.sourceUnbound || r.binding.sourceUnbound;
      binding.targetBound = binding.targetBound || r.binding.targetBound;
    }
    return { moved, merged, binding, docCount: docIds.length };
  });
}
