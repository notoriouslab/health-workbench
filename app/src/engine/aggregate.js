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

// 觸及鍵選擇器：本次 doc 的 (profile, type, day, source) 組合。聚合來源
// MUST 是「觸及鍵的全部 raw 列」而非「本次 doc 的列」：增量日（同一天
// 舊檔已有列、新檔再添列）只聚合本次列會把該日統計縮小或使其過期。
const TOUCHED_KEYS =
  "(profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')) IN"
  + " (SELECT profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')"
  + " FROM apple_records WHERE doc_id = ?)";

const VAL = "COALESCE(value_normalized, value_numeric)";

// 語句一：數值統計 UPSERT。縮水防線方向：excluded.n >= 既有 n 才覆蓋
// （寫反會讓部分來源的重新匯出蓋掉完整資料）。raw 尚在時全量重算使
// excluded.n 必然 >= 既有 n，防線不誤觸發；它守的是 raw 已被清理、
// 之後又以部分來源重新匯出的情境。epoch 佔位日期的列 day 落在 19xx
// 自成獨立鍵，旗標照 raw 語意寫入、趨勢讀取據此排除。
const statsSql = (filter) => `INSERT INTO apple_daily(profile_id, doc_id, type_zh, day, source_name,
  n, sum_v, min_v, max_v, avg_v, quality_flags)
SELECT profile_id, MAX(doc_id), type_zh, substr(start_ts,1,10),
  COALESCE(source_name,''),
  COUNT(*), SUM(${VAL}), MIN(${VAL}), MAX(${VAL}), AVG(${VAL}),
  CASE WHEN substr(start_ts,1,10) < '2000-01-01'
    THEN 'epoch_placeholder_date' ELSE '' END
FROM apple_records
WHERE type_zh IN (${TYPE_LIST})${filter}
GROUP BY profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')
ON CONFLICT(profile_id, type_zh, day, source_name) DO UPDATE SET
  n=excluded.n, sum_v=excluded.sum_v, min_v=excluded.min_v,
  max_v=excluded.max_v, avg_v=excluded.avg_v, doc_id=excluded.doc_id,
  quality_flags=excluded.quality_flags
  WHERE excluded.n >= apple_daily.n`;

// 語句二：睡眠的每日各識別字分鐘數（category 型別，數值欄為 NULL）。
// 識別字不寫死（無 Watch 的匯出只有 InBed 類識別字）；ORDER BY 讓
// json_group_object 的鍵序在不同 SQLite build 間決定性一致（parity
// dump 逐位元組比對）。分鐘取整數避免兩端浮點序列化差異。
const sleepSql = (filter) => `UPDATE apple_daily SET extra_json = (
  SELECT json_group_object(ident, mins) FROM (
    SELECT COALESCE(r.value_text,'') AS ident,
      CAST(ROUND(SUM((julianday(r.end_ts) - julianday(r.start_ts)) * 1440))
        AS INTEGER) AS mins
    FROM apple_records r
    WHERE r.profile_id = apple_daily.profile_id AND r.type_zh = '睡眠'
      AND substr(r.start_ts,1,10) = apple_daily.day
      AND COALESCE(r.source_name,'') = apple_daily.source_name
    GROUP BY COALESCE(r.value_text,'')
    ORDER BY COALESCE(r.value_text,'')))
WHERE type_zh = '睡眠'${filter}`;

// 語句三（僅匯入路徑）：縮水鍵標旗標。觸及鍵中「既有 n 大於全量重算 n」
// 的列＝語句一被防線擋下的列，追加 partial_reimport_skipped（不重複追加）。
const shrinkFlagSql = () => `UPDATE apple_daily
SET quality_flags = CASE
  WHEN quality_flags = '' THEN 'partial_reimport_skipped'
  WHEN instr(quality_flags, 'partial_reimport_skipped') > 0 THEN quality_flags
  ELSE quality_flags || ',partial_reimport_skipped' END
WHERE rowid IN (
  SELECT a.rowid FROM apple_daily a JOIN (
    SELECT profile_id p, type_zh t, substr(start_ts,1,10) d,
      COALESCE(source_name,'') s, COUNT(*) c
    FROM apple_records
    WHERE type_zh IN (${TYPE_LIST}) AND ${TOUCHED_KEYS}
    GROUP BY profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')
  ) g ON a.profile_id = g.p AND a.type_zh = g.t AND a.day = g.d
    AND a.source_name = g.s
  WHERE a.n > g.c)`;

// apple_daily 外層的觸及鍵選擇器（睡眠 UPDATE 的過濾用；欄名須帶表名）
const TOUCHED_DAILY_KEYS =
  "(apple_daily.profile_id, apple_daily.type_zh, apple_daily.day,"
  + " apple_daily.source_name) IN"
  + " (SELECT profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')"
  + " FROM apple_records WHERE doc_id = ?)";

// 匯入路徑：三句，params 為各句的 doc_id 參數個數（呼叫端同一交易內逐句
// execute，參數為 Array(params).fill(docId)）
export function importAggregateStatements() {
  return [
    { sql: statsSql(` AND ${TOUCHED_KEYS}`), params: 1 },
    { sql: sleepSql(` AND ${TOUCHED_DAILY_KEYS}`), params: 1 },
    { sql: shrinkFlagSql(), params: 1 },
  ];
}

// v5→v6 遷移回填：兩句、零參數（MIGRATIONS 逐句 execute 不帶參數）
export function backfillStatements() {
  return [statsSql(""), sleepSql("")];
}
