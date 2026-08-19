// Apple 每日彙總（health-database「Apple 每日彙總表」／apple-health-import
// 「匯入時每日彙總」）。本檔是聚合語意的單一來源：型別分配表與聚合 SQL
// 都在這裡產生，schema 的 v6 回填與 adapter 的匯入聚合共用同一份；
// Python 端 src/store/schema.py 逐字鏡像（tests/store/aggregate_parity
// 以字串全等釘住，兩端漂移即紅）。
//
// 型別分配（F6 裁定，2026-08-18）：逐筆保留 9＋只存彙總 20，聯集 MUST
// 恰等於 adapter 的 WANTED（tests/engine/type_allocation.test.mjs 對帳）。
export const PER_ROW_TYPES = [
  "體重", "BMI", "體脂率", "除脂體重", "身高",
  "收縮壓", "舒張壓", "安靜心率", "行走穩定度",
];
export const AGGREGATE_TYPES = [
  "心率", "血氧", "呼吸速率", "睡眠",
  "步數", "步行跑步距離", "騎車距離", "爬樓層數", "活動能量", "基礎能量",
  "步行速度", "步幅", "雙腳支撐比例", "步態不對稱比例",
  "耳機音量暴露", "飲水量", "攝取熱量", "攝取脂肪", "攝取碳水", "攝取蛋白質",
];

const TYPE_LIST = AGGREGATE_TYPES.map((t) => `'${t}'`).join(",");

const VAL = "COALESCE(value_normalized, value_numeric)";

// 執行結構（2026-08-19 效能修正）：apple_records 上沒有 type_zh 或日鍵
// 索引，任何按鍵回查 raw 的子查詢都是全表掃。原版三個語句各自重掃全表
// （觸及鍵重算 ×3、縮水計數重算 ×1、睡眠 correlated 子查詢對**每個**
// 睡眠日鍵各掃一次全表——46 萬列庫的聚合段 3.9s、大庫的 v6 回填被同一
// 結構放大）。修正後 raw 全表只掃固定次數（匯入路徑 3 次：觸及鍵、
// 全量聚合、睡眠分鐘；回填路徑 2 次），結果放 TEMP 表，後續語句全部
// 讀小表。TEMP 表的建立與刪除都在交易內：回滾時 SQLite 一併撤銷，
// 同連線的下一次匯入不會撞名。
//
// 觸及鍵語意不變：聚合來源 MUST 是「觸及鍵的全部 raw 列」而非「本次
// doc 的列」——增量日（同一天舊檔已有列、新檔再添列）只聚合本次列會
// 把該日統計縮小或使其過期。
const CREATE_TOUCHED_KEYS =
  "CREATE TEMP TABLE touched_keys AS"
  + " SELECT DISTINCT profile_id, type_zh, substr(start_ts,1,10) AS day,"
  + " COALESCE(source_name,'') AS source_name"
  + " FROM apple_records WHERE doc_id = ?";
const TOUCHED_KEYS =
  "(profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')) IN"
  + " (SELECT profile_id, type_zh, day, source_name FROM touched_keys)";
// apple_daily 外層的觸及鍵選擇器（UPDATE 的過濾用；欄名須帶表名）
const TOUCHED_DAILY_KEYS =
  "(apple_daily.profile_id, apple_daily.type_zh, apple_daily.day,"
  + " apple_daily.source_name) IN"
  + " (SELECT profile_id, type_zh, day, source_name FROM touched_keys)";

// 全量聚合的一次性計算：epoch 佔位日期的列 day 落在 19xx 自成獨立鍵，
// 旗標照 raw 語意寫入、趨勢讀取據此排除。
const touchedAggSql = (filter) => `CREATE TEMP TABLE touched_agg AS
SELECT profile_id, type_zh, substr(start_ts,1,10) AS day,
  COALESCE(source_name,'') AS source_name, MAX(doc_id) AS doc_id,
  COUNT(*) AS n, SUM(${VAL}) AS sum_v, MIN(${VAL}) AS min_v,
  MAX(${VAL}) AS max_v, AVG(${VAL}) AS avg_v
FROM apple_records
WHERE type_zh IN (${TYPE_LIST})${filter}
GROUP BY profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')`;

// 語句一：數值統計 UPSERT（讀 touched_agg）。縮水防線方向：excluded.n >=
// 既有 n 才覆蓋（寫反會讓部分來源的重新匯出蓋掉完整資料）。raw 尚在時
// 全量重算使 excluded.n 必然 >= 既有 n，防線不誤觸發；它守的是 raw 已被
// 清理、之後又以部分來源重新匯出的情境。
const statsSql = () => `INSERT INTO apple_daily(profile_id, doc_id, type_zh, day, source_name,
  n, sum_v, min_v, max_v, avg_v, quality_flags)
SELECT profile_id, doc_id, type_zh, day, source_name,
  n, sum_v, min_v, max_v, avg_v,
  CASE WHEN day < '2000-01-01'
    THEN 'epoch_placeholder_date' ELSE '' END
FROM touched_agg
WHERE true -- 消除 parser 歧義：無此句時 ON 會被解析成 JOIN 條件（SQLite upsert 文件明載）
ON CONFLICT(profile_id, type_zh, day, source_name) DO UPDATE SET
  n=excluded.n, sum_v=excluded.sum_v, min_v=excluded.min_v,
  max_v=excluded.max_v, avg_v=excluded.avg_v, doc_id=excluded.doc_id,
  quality_flags=excluded.quality_flags
  WHERE excluded.n >= apple_daily.n`;

// 語句二：睡眠的每日各識別字分鐘數（category 型別，數值欄為 NULL）。
// 識別字不寫死（無 Watch 的匯出只有 InBed 類識別字）；分鐘先一次性聚合
// 進 sleep_mins（MUST NOT 用對 raw 的 correlated 子查詢——那是對每個
// 睡眠日鍵各掃一次全表），UPDATE 只 probe 小表。ORDER BY 讓
// json_group_object 的鍵序在不同 SQLite build 間決定性一致（parity
// dump 逐位元組比對）。分鐘取整數避免兩端浮點序列化差異。
const sleepMinsSql = (filter) => `CREATE TEMP TABLE sleep_mins AS
SELECT profile_id, substr(start_ts,1,10) AS day,
  COALESCE(source_name,'') AS source_name,
  COALESCE(value_text,'') AS ident,
  CAST(ROUND(SUM((julianday(end_ts) - julianday(start_ts)) * 1440))
    AS INTEGER) AS mins
FROM apple_records
WHERE type_zh = '睡眠'${filter}
GROUP BY profile_id, substr(start_ts,1,10), COALESCE(source_name,''),
  COALESCE(value_text,'')`;

const sleepSql = (filter) => `UPDATE apple_daily SET extra_json = (
  SELECT json_group_object(ident, mins) FROM (
    SELECT m.ident AS ident, m.mins AS mins FROM sleep_mins m
    WHERE m.profile_id = apple_daily.profile_id
      AND m.day = apple_daily.day
      AND m.source_name = apple_daily.source_name
    ORDER BY m.ident))
WHERE type_zh = '睡眠'${filter}`;

// 語句三（僅匯入路徑）：縮水鍵標旗標。觸及鍵中「既有 n 大於全量重算 n」
// 的列＝語句一被防線擋下的列，追加 partial_reimport_skipped（不重複追加）。
// 全量重算計數直接讀 touched_agg，不重掃 raw。
const shrinkFlagSql = () => `UPDATE apple_daily
SET quality_flags = CASE
  WHEN quality_flags = '' THEN 'partial_reimport_skipped'
  WHEN instr(quality_flags, 'partial_reimport_skipped') > 0 THEN quality_flags
  ELSE quality_flags || ',partial_reimport_skipped' END
WHERE rowid IN (
  SELECT a.rowid FROM apple_daily a JOIN touched_agg g
    ON a.profile_id = g.profile_id AND a.type_zh = g.type_zh
   AND a.day = g.day AND a.source_name = g.source_name
  WHERE a.n > g.n)`;

// 匯入路徑：建三個 TEMP 表 → 三句聚合 → 清 TEMP 表。params 為各句的
// doc_id 參數個數（呼叫端同一交易內逐句 execute，參數為
// Array(params).fill(docId)）
export function importAggregateStatements() {
  return [
    { sql: CREATE_TOUCHED_KEYS, params: 1 },
    { sql: touchedAggSql(` AND ${TOUCHED_KEYS}`), params: 0 },
    { sql: sleepMinsSql(` AND ${TOUCHED_KEYS}`), params: 0 },
    { sql: statsSql(), params: 0 },
    { sql: sleepSql(` AND ${TOUCHED_DAILY_KEYS}`), params: 0 },
    { sql: shrinkFlagSql(), params: 0 },
    { sql: "DROP TABLE touched_keys", params: 0 },
    { sql: "DROP TABLE touched_agg", params: 0 },
    { sql: "DROP TABLE sleep_mins", params: 0 },
  ];
}

// v5→v6 遷移回填：零參數（MIGRATIONS 逐句 execute 不帶參數）、無觸及鍵
// 過濾（全量）。同樣不用 correlated 子查詢：大庫升級的回填耗時被同一
// 結構放大，睡眠列多的庫尤甚。
export function backfillStatements() {
  return [
    touchedAggSql(""),
    sleepMinsSql(""),
    statsSql(),
    sleepSql(""),
    "DROP TABLE touched_agg",
    "DROP TABLE sleep_mins",
  ];
}
