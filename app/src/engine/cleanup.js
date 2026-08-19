// 釋放空間（health-database「釋放空間」／change display-revamp-bands-cleanup
// D4）：刪除 AGGREGATE_TYPES 20 個彙總型別的 apple_records 逐筆列（全庫、
// 所有成員）並 VACUUM。逐筆保留 9 型別一筆不刪；不可逆，MUST 由使用者
// 主動觸發（UI 層負責確認流程）。
import { AGGREGATE_TYPES } from "./aggregate.js";

const TYPE_LIST = AGGREGATE_TYPES.map((t) => `'${t}'`).join(",");

async function dbSizeBytes(driver) {
  const [{ sz }] = await driver.select(
    "SELECT page_count * page_size AS sz FROM pragma_page_count(), pragma_page_size()");
  return sz;
}

// 全庫總列數：動態掃使用者表（語意是「全庫」，動態列舉不會漏新表）
async function totalRows(driver) {
  const tables = await driver.select(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  let total = 0;
  for (const { name } of tables) {
    const [{ c }] = await driver.select(`SELECT COUNT(*) c FROM "${name}"`);
    total += c;
  }
  return total;
}

// 確認文案的實算數字（spec：NEVER 寫死任何容量）。預估用平均列佔用法：
// 現大小 ÷ 全庫總列數 × 將刪列數，一律以「約」呈現，完成後回報實測。
export async function cleanupPreview(driver) {
  const [{ n: deletableRows }] = await driver.select(
    `SELECT COUNT(*) n FROM apple_records WHERE type_zh IN (${TYPE_LIST})`);
  const sizeBytes = await dbSizeBytes(driver);
  const total = await totalRows(driver);
  const estAfterBytes = total > 0
    ? Math.max(sizeBytes - Math.round((sizeBytes / total) * deletableRows), 0)
    : sizeBytes;
  return { deletableRows, sizeBytes, estAfterBytes };
}

// 對帳防線（刪除前，不過則零刪除）：將刪 raw 列的每個
// (profile_id, type_zh, day, source_name) 鍵 MUST 有對應 apple_daily 列
// 且該列 n ≥ 該鍵 raw 列數。判準用 n 而非數值欄非 NULL：睡眠等 category
// 型別的數值欄天生 NULL、資料在 extra_json。
export async function cleanupGuardBadKeys(driver) {
  const [{ bad }] = await driver.select(`
    SELECT COUNT(*) bad FROM (
      SELECT r.profile_id AS pid, r.type_zh AS tz,
             substr(r.start_ts,1,10) AS day,
             COALESCE(r.source_name,'') AS src, COUNT(*) AS raw_n
      FROM apple_records r WHERE r.type_zh IN (${TYPE_LIST})
      GROUP BY pid, tz, day, src) k
    LEFT JOIN apple_daily d
      ON d.profile_id = k.pid AND d.type_zh = k.tz
     AND d.day = k.day AND d.source_name = k.src
    WHERE d.profile_id IS NULL OR d.n < k.raw_n`);
  return bad;
}

// 執行清理。回傳 { deletedRows, beforeBytes, afterBytes, vacuumError }。
// DELETE 在單一交易內；VACUUM 在交易外（SQLite 不允許交易內 VACUUM，
// 且需約等於清理後庫大小的暫存磁碟）。VACUUM 失敗時資料仍一致（刪除已
// commit、僅空間未回收），以 vacuumError 回報、可稍後重試，MUST NOT
// 呈現為整體失敗回滾。
export async function releaseSpace(driver) {
  const bad = await cleanupGuardBadKeys(driver);
  if (bad > 0) {
    throw new Error(`有 ${bad} 個每日鍵的彙總缺列或筆數不足，已中止、`
      + "未刪除任何資料。請先重新匯入原始匯出檔讓彙總補齊。");
  }
  const beforeBytes = await dbSizeBytes(driver);
  let deletedRows = 0;
  await driver.transaction(async (tx) => {
    const r = await tx.execute(
      `DELETE FROM apple_records WHERE type_zh IN (${TYPE_LIST})`);
    deletedRows = r.changes ?? 0;
  });
  let vacuumError = null;
  try {
    await driver.execute("VACUUM");
  } catch (err) {
    vacuumError = String(err?.message || err);
  }
  const afterBytes = await dbSizeBytes(driver);
  return { deletedRows, beforeBytes, afterBytes, vacuumError };
}
