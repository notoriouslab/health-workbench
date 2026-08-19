// 匯入引擎的 Store 寫入層（自 src/store/db.py 移植，跑在 StoreDriver 之上）。
// 語意鏡像：來源追溯強制、指紋合併、碰撞防禦、統計。差分驗收見 tests/parity/。
import { canonicalJson, recordFp, pyJsonDumps } from "./fingerprint.js";

export const FP_TABLES = ["encounters", "lab_results", "reports", "immunizations",
  "body_measurements", "cancer_screenings"];

// 帶 quality_flags 欄位的全部資料表。品質報告逐表掃描這份清單，漏掉的表其
// 旗標永遠不會出現在報告上，而匯入卡照樣顯示「品質旗標：無」，看起來像
// 「這批資料很乾淨」（2026-08-14 實測：CPAP 的 multi_session 與
// apple_workouts 的旗標都漏報）。順序 MUST 與 Python 的
// QUALITY_FLAG_TABLES 一致（品質報告要逐位元組同構）。
// tests/engine/table_coverage.test.mjs 以 DDL 的欄位對帳釘住。
export const QUALITY_FLAG_TABLES = [...FP_TABLES, "medications",
  "apple_records", "apple_workouts", "apple_daily",
  "cpap_daily", "cpap_events", "cpap_oximetry"];

export class SourceRequired extends Error {}

export class EngineStore {
  constructor(driver) {
    this.driver = driver;
    this.stats = { inserted: {}, skipped_dup: {}, collisions: 0 };
    this.lastInsertId = null;
  }

  // sha256 為全庫 UNIQUE：命中時 JOIN profiles 一次帶回原歸屬成員
  // （跨成員重複檔訊息用，design D2），未命中時 origin 兩欄為 null。
  //
  // importedAt（選用）：多檔來源要讓整批共用同一個時間戳，否則每列各自取
  // datetime('now')，批次一大或機器一慢就會跨秒，而檢視層是用
  // 「同 adapter ＋同 imported_at」判定批次的（change
  // viewer-and-history-refinement D2）。傳 null 時沿用 schema 原本的
  // datetime('now')，單檔 adapter 因此不需要改：一批一檔，逐列時間即批次時間。
  // 值由資料庫時鐘產生，格式必然與既有資料一致，不必在兩種語言各自格式化。
  //
  // 回傳的 importedAt 語意不變＝「這個檔**先前**已匯入的時間」，新插入必為
  // null。呼叫端以它判定重複檔，NEVER 改成回傳剛寫入的值。
  async registerSource(profileId, filename, sha256, adapter, adapterVersion,
    importedAt = null) {
    const rows = await this.driver.select(
      "SELECT d.id, d.imported_at, d.profile_id, p.display_name"
      + " FROM source_documents d JOIN profiles p ON d.profile_id = p.id"
      + " WHERE d.sha256=?", [sha256]);
    if (rows.length) {
      return { docId: rows[0].id, importedAt: rows[0].imported_at,
        originProfileId: rows[0].profile_id, originDisplayName: rows[0].display_name };
    }
    const r = await this.driver.execute(
      "INSERT INTO source_documents(profile_id,filename,sha256,adapter,adapter_version,"
      + "imported_at) VALUES(?,?,?,?,?,COALESCE(?, datetime('now')))",
      [profileId, filename, sha256, adapter, adapterVersion, importedAt]);
    return { docId: r.lastInsertRowid, importedAt: null,
      originProfileId: null, originDisplayName: null };
  }

  // 單遍匯入用（app-import-engine「單遍匯入與重複檔終點判定」）：內容指紋
  // 要到解析終點才算得出來，先以佔位值建來源列取得 docId。佔位值只活在
  // 交易內：終點由 resolveSource 更新為真值，或隨交易整筆回滾，MUST NOT
  // 被提交。sha256 有 UNIQUE 約束且單連線無並發，佔位不撞鍵。
  async registerPending(profileId, filename, adapter, adapterVersion,
    containerSha256) {
    const r = await this.driver.execute(
      "INSERT INTO source_documents(profile_id,filename,sha256,adapter,"
      + "adapter_version,container_sha256) VALUES(?,?,?,?,?,?)",
      [profileId, filename, "pending", adapter, adapterVersion, containerSha256]);
    return r.lastInsertRowid;
  }

  // 交易終點的重複判定＋真值回填。命中回原歸屬（跨成員重複檔訊息用），
  // 未命中才 UPDATE（sha256 UNIQUE 是最後防線：先查再更新，不靠撞鍵）。
  async resolveSource(docId, sha256) {
    const rows = await this.driver.select(
      "SELECT d.imported_at, p.display_name"
      + " FROM source_documents d JOIN profiles p ON d.profile_id = p.id"
      + " WHERE d.sha256=? AND d.id != ?", [sha256, docId]);
    if (rows.length) {
      return { duplicate: true, importedAt: rows[0].imported_at,
        originDisplayName: rows[0].display_name };
    }
    await this.driver.execute(
      "UPDATE source_documents SET sha256=? WHERE id=?", [sha256, docId]);
    return { duplicate: false };
  }

  async finalizeImport(docId) {
    await this.driver.execute(
      "UPDATE source_documents SET import_stats=? WHERE id=?",
      [pyJsonDumps(this.stats, { sortKeys: false }), docId]);
  }

  // 指紋合併寫入（健保側）：回傳 "inserted" / "duplicate" / "collision"
  async insertFpRecord(table, record, { profileId, docId, section, sourceIndex,
    columns, qualityFlags = "" }) {
    if (!FP_TABLES.includes(table)) throw new Error(`非法表名：${table}`);
    if (docId == null || section == null || sourceIndex == null) {
      throw new SourceRequired(`${table} 寫入缺來源追溯（doc_id/section/source_index）`);
    }
    const fp = await recordFp(record);
    const canon = canonicalJson(record);
    const existing = await this.driver.select(
      `SELECT id, canonical FROM ${table} WHERE profile_id=? AND section=? AND record_fp=?`,
      [profileId, section, fp]);
    if (existing.length) {
      if (existing[0].canonical !== canon) {
        this.stats.collisions += 1;
        const [{ quality_flags }] = await this.driver.select(
          `SELECT quality_flags FROM ${table} WHERE id=?`, [existing[0].id]);
        if (!quality_flags.split(",").includes("fingerprint_collision")) {
          await this.driver.execute(
            `UPDATE ${table} SET quality_flags =`
            + " CASE WHEN quality_flags='' THEN 'fingerprint_collision'"
            + " ELSE quality_flags || ',fingerprint_collision' END WHERE id=?",
            [existing[0].id]);
        }
        return "collision";
      }
      this.stats.skipped_dup[table] = (this.stats.skipped_dup[table] || 0) + 1;
      return "duplicate";
    }
    const cols = { profile_id: profileId, doc_id: docId, section,
      source_index: sourceIndex, record_fp: fp, canonical: canon,
      quality_flags: qualityFlags, ...columns };
    const names = Object.keys(cols).join(",");
    const marks = Object.keys(cols).map(() => "?").join(",");
    const r = await this.driver.execute(
      `INSERT INTO ${table}(${names}) VALUES(${marks})`,
      Object.values(cols).map(v => v === undefined ? null : v));
    this.stats.inserted[table] = (this.stats.inserted[table] || 0) + 1;
    this.lastInsertId = r.lastInsertRowid;
    return "inserted";
  }

  async insertMedication({ profileId, docId, encounterId, section, sourceIndex, ...columns }) {
    if (docId == null || section == null || sourceIndex == null) {
      throw new SourceRequired("medications 寫入缺來源追溯");
    }
    const cols = { profile_id: profileId, doc_id: docId, encounter_id: encounterId,
      section, source_index: sourceIndex, ...columns };
    const names = Object.keys(cols).join(",");
    const marks = Object.keys(cols).map(() => "?").join(",");
    const r = await this.driver.execute(
      `INSERT OR IGNORE INTO medications(${names}) VALUES(${marks})`,
      Object.values(cols).map(v => v === undefined ? null : v));
    const key = "medications";
    if (r.changes > 0) this.stats.inserted[key] = (this.stats.inserted[key] || 0) + 1;
    else this.stats.skipped_dup[key] = (this.stats.skipped_dup[key] || 0) + 1;
  }

  async qualityFlagCounts() {
    const out = {};
    for (const t of QUALITY_FLAG_TABLES) {
      const rows = await this.driver.select(
        `SELECT quality_flags FROM ${t} WHERE quality_flags != ''`);
      for (const r of rows) {
        for (const f of r.quality_flags.split(",").filter(Boolean)) {
          out[f] = (out[f] || 0) + 1;
        }
      }
    }
    return out;
  }

  async tableCounts() {
    const out = {};
    for (const t of ["profiles", "source_documents", "encounters", "medications",
      "lab_results", "reports", "immunizations", "body_measurements",
      "cancer_screenings", "apple_records", "apple_workouts", "apple_daily",
      "cpap_daily", "cpap_events", "cpap_oximetry"]) {
      const [{ c }] = await this.driver.select(`SELECT COUNT(*) c FROM ${t}`);
      out[t] = c;
    }
    return out;
  }
}
