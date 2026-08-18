// 構造舊版遷移現場用：把 source_documents 退回 v5 之前（無 container_sha256）。
// SQLite 的 DROP COLUMN 支援度不一，走建表搬資料。任何「降回 vN 現場」的測試
// 若 N < 5 都必須先呼叫本函式，否則 MIGRATIONS[4] 的 ALTER 會撞已存在欄位。
export async function dropContainerSha256(d) {
  await d.execute("PRAGMA foreign_keys = OFF");
  await d.execute(`CREATE TABLE sd_pre_v5(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    adapter TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    import_stats TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await d.execute("INSERT INTO sd_pre_v5 SELECT id, profile_id, filename, sha256,"
    + " adapter, adapter_version, import_stats, imported_at FROM source_documents");
  await d.execute("DROP TABLE source_documents");
  await d.execute("ALTER TABLE sd_pre_v5 RENAME TO source_documents");
  await d.execute("PRAGMA foreign_keys = ON");
}

// 比對「既有資料逐位元組不變」時剝掉 v5 新欄位（遷移後必然多出、值為 NULL）
export function stripContainerSha256(dumpJson) {
  const dump = JSON.parse(dumpJson);
  if (dump.source_documents) {
    dump.source_documents = dump.source_documents.map(
      ({ container_sha256, ...rest }) => rest);
  }
  return JSON.stringify(dump);
}
