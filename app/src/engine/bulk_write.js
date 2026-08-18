// 匯入期 WAL 窗口（app-import-engine「匯入期間的日誌模式窗口」）。
// 實測 -26%（100 萬筆 35.2s → 26.0s）；平時維持 DELETE 單檔，備份語意不變。
//
// 兩條硬規則：
// 1. 切換與 checkpoint MUST 走查詢介面（driver.select）：rusqlite 的
//    execute 對回傳列的語句回 Err(ExecuteReturnedResults)，而 journal_mode
//    與 wal_checkpoint 都回傳一列（synchronous 賦值不回列）。Node 的
//    DatabaseSync.run 容忍回傳列，測試層測不出這個差異，實機才會炸。
// 2. 切換 MUST 於交易外執行（fn 內才開交易），交易中切 journal_mode 是
//    SQLite 錯誤。

export async function withWalWindow(driver, fn) {
  await driver.select("PRAGMA journal_mode=WAL");
  await driver.execute("PRAGMA synchronous=NORMAL");
  try {
    return await fn();
  } finally {
    // 成功或失敗都收斂回單檔。收斂本身失敗不往上拋：匯入若已成功，
    // 不能被清理步驟改判成失敗；殘留的 -wal 由下次開啟的自癒接手。
    try {
      await healWalResidue(driver);
    } catch { /* 留給開啟自癒 */ }
  }
}

// 把 WAL 狀態收斂回 DELETE 單檔：checkpoint 將 -wal 併回主檔並截斷，
// 切回後 -wal／-shm 消失（實測）。開啟資料庫時也呼叫（WAL 模式寫在
// 檔案裡跨連線持久，匯入中強制結束會殘留，實測重開仍為 wal）。
export async function healWalResidue(driver) {
  const [{ journal_mode: mode }] = await driver.select("PRAGMA journal_mode");
  if (mode === "wal") {
    await driver.select("PRAGMA wal_checkpoint(TRUNCATE)");
    await driver.select("PRAGMA journal_mode=DELETE");
  }
  await driver.execute("PRAGMA synchronous=FULL");
}
