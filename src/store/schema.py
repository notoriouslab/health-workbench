"""health-database schema：全表 profile_id、來源追溯、quality_flags、版本化。"""

SCHEMA_VERSION = 6

# Apple 每日彙總表（v6 新增）：同時作為初始 DDL 與 5→6 遷移的單一來源，
# 與 app/src/store/schema.js 的 APPLE_DAILY_DDL 逐字同步。
APPLE_DAILY_DDL = """
CREATE TABLE IF NOT EXISTS apple_daily(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    type_zh TEXT NOT NULL,
    day TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    n INTEGER NOT NULL,
    sum_v REAL,
    min_v REAL,
    max_v REAL,
    avg_v REAL,
    extra_json TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, type_zh, day, source_name));
"""

# CPAP 三表（v4 新增）：同時作為初始 DDL 與 3→4 遷移的單一來源，兩處手寫
# 會漂移。與 app/src/store/schema.js 的 CPAP_DDL 逐字同步（schema parity
# 測試比對兩邊空庫的 sqlite_master dump）。
# 註：CPAP 匯入只在 App 端實作（Python CLI 功能凍結），但 DDL 同步不豁免。
CPAP_DDL = """
CREATE TABLE IF NOT EXISTS cpap_daily(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    device TEXT NOT NULL,
    summary_date TEXT NOT NULL,
    session_start_min REAL,
    session_end_min REAL,
    session_count INTEGER,
    usage_min REAL,
    ahi REAL,
    ai REAL,
    hi REAL,
    oai REAL,
    cai REAL,
    uai REAL,
    leak_median REAL,
    leak_95 REAL,
    leak_max REAL,
    pressure_median REAL,
    pressure_95 REAL,
    pressure_max REAL,
    pressure_set REAL,
    pressure_min_setting REAL,
    pressure_max_setting REAL,
    mode_raw REAL,
    mask_events INTEGER,
    extra_json TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, device, summary_date));
CREATE INDEX IF NOT EXISTS idx_cpap_daily_profile ON cpap_daily(profile_id, summary_date);

CREATE TABLE IF NOT EXISTS cpap_events(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    device TEXT NOT NULL,
    session_date TEXT NOT NULL,
    start_ts TEXT NOT NULL,
    duration_sec REAL,
    event_type TEXT NOT NULL,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, device, start_ts, event_type));
CREATE INDEX IF NOT EXISTS idx_cpap_events_profile ON cpap_events(profile_id, session_date);

CREATE TABLE IF NOT EXISTS cpap_oximetry(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    device TEXT NOT NULL,
    session_date TEXT NOT NULL,
    minute_ts TEXT NOT NULL,
    spo2_min REAL,
    spo2_mean REAL,
    pulse_mean REAL,
    pulse_max REAL,
    sample_count INTEGER NOT NULL,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, device, minute_ts));
CREATE INDEX IF NOT EXISTS idx_cpap_oximetry_profile ON cpap_oximetry(profile_id, session_date);
"""

DDL = """
CREATE TABLE IF NOT EXISTS schema_version(
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS profiles(
    id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL,
    masked_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS source_documents(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    adapter TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    import_stats TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    container_sha256 TEXT);

CREATE TABLE IF NOT EXISTS encounters(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    section TEXT NOT NULL,
    source_index INTEGER NOT NULL,
    record_fp TEXT NOT NULL,
    canonical TEXT NOT NULL,
    type TEXT NOT NULL,
    date TEXT,
    visit_seq TEXT,
    facility_name TEXT,
    facility_code TEXT,
    dx_code TEXT,
    dx_name TEXT,
    copay INTEGER,
    nhi_points INTEGER,
    extra_json TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, section, record_fp));

CREATE TABLE IF NOT EXISTS medications(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    encounter_id INTEGER NOT NULL REFERENCES encounters(id),
    order_code TEXT,
    order_name TEXT,
    total_qty REAL,
    days_supply INTEGER,
    tooth_code TEXT,
    tooth_name TEXT,
    section TEXT NOT NULL,
    source_index INTEGER NOT NULL,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(encounter_id, section, source_index));
CREATE INDEX IF NOT EXISTS idx_medications_profile ON medications(profile_id, encounter_id);

CREATE TABLE IF NOT EXISTS lab_results(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    section TEXT NOT NULL,
    source_index INTEGER NOT NULL,
    record_fp TEXT NOT NULL,
    canonical TEXT NOT NULL,
    visit_date TEXT,
    test_date TEXT,
    facility_name TEXT,
    order_code TEXT,
    order_name TEXT,
    test_name_raw TEXT,
    test_name_normalized TEXT,
    value_text TEXT,
    value_numeric REAL,
    ref_range TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, section, record_fp));

CREATE TABLE IF NOT EXISTS reports(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    section TEXT NOT NULL,
    source_index INTEGER NOT NULL,
    record_fp TEXT NOT NULL,
    canonical TEXT NOT NULL,
    visit_date TEXT,
    test_date TEXT,
    facility_name TEXT,
    order_code TEXT,
    order_name TEXT,
    report_text TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, section, record_fp));

CREATE TABLE IF NOT EXISTS immunizations(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    section TEXT NOT NULL,
    source_index INTEGER NOT NULL,
    record_fp TEXT NOT NULL,
    canonical TEXT NOT NULL,
    date TEXT,
    vaccine_name TEXT,
    facility_name TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, section, record_fp));

CREATE TABLE IF NOT EXISTS body_measurements(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    section TEXT NOT NULL,
    source_index INTEGER NOT NULL,
    record_fp TEXT NOT NULL,
    canonical TEXT NOT NULL,
    check_date TEXT,
    height_cm REAL,
    weight_kg REAL,
    bmi REAL,
    waist REAL,
    systolic INTEGER,
    diastolic INTEGER,
    extra_json TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, section, record_fp));

CREATE TABLE IF NOT EXISTS cancer_screenings(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    section TEXT NOT NULL,
    source_index INTEGER NOT NULL,
    record_fp TEXT NOT NULL,
    canonical TEXT NOT NULL,
    category TEXT,
    item_name TEXT,
    detail_json TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, section, record_fp));

CREATE TABLE IF NOT EXISTS apple_records(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    type TEXT NOT NULL,
    type_zh TEXT NOT NULL,
    start_ts TEXT NOT NULL,
    end_ts TEXT NOT NULL,
    value_numeric REAL,
    value_normalized REAL,
    value_text TEXT,
    unit TEXT,
    source_name TEXT,
    quality_flags TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS uq_apple ON apple_records(
    profile_id, type, start_ts, end_ts, COALESCE(source_name,''),
    COALESCE(value_numeric, -999999.25), COALESCE(value_text, ''));

CREATE TABLE IF NOT EXISTS apple_workouts(
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    doc_id INTEGER NOT NULL REFERENCES source_documents(id),
    activity TEXT NOT NULL,
    start_ts TEXT NOT NULL,
    end_ts TEXT NOT NULL,
    duration_min REAL,
    source_name TEXT,
    quality_flags TEXT NOT NULL DEFAULT '',
    UNIQUE(profile_id, activity, start_ts, end_ts, source_name));
""" + CPAP_DDL + APPLE_DAILY_DDL

# Apple 型別分配（F6 裁定）：逐筆保留 9＋只存彙總 20，聯集恰等於 adapter
# 的 WANTED（tests/test_type_allocation.py 對帳）。與 JS 端
# app/src/engine/aggregate.js 鏡像；聚合 SQL 逐字同步（aggregate parity
# 測試以字串全等釘住）。imports＝匯入路徑三句（各帶 doc_id 參數
# params 個）、backfill＝v5→v6 回填兩句（零參數）。
PER_ROW_TYPES = ["體重", "BMI", "體脂率", "除脂體重", "身高", "收縮壓", "舒張壓", "安靜心率", "行走穩定度"]
AGGREGATE_TYPES = ["心率", "血氧", "呼吸速率", "睡眠", "步數", "步行跑步距離", "騎車距離", "爬樓層數", "活動能量", "基礎能量", "步行速度", "步幅", "雙腳支撐比例", "步態不對稱比例", "耳機音量暴露", "飲水量", "攝取熱量", "攝取脂肪", "攝取碳水", "攝取蛋白質"]

IMPORT_AGGREGATE_STATEMENTS = [
  {
    "sql": "CREATE TEMP TABLE touched_keys AS SELECT DISTINCT profile_id, type_zh, substr(start_ts,1,10) AS day, COALESCE(source_name,'') AS source_name FROM apple_records WHERE doc_id = ?",
    "params": 1
  },
  {
    "sql": "CREATE TEMP TABLE touched_agg AS\nSELECT profile_id, type_zh, substr(start_ts,1,10) AS day,\n  COALESCE(source_name,'') AS source_name, MAX(doc_id) AS doc_id,\n  COUNT(*) AS n, SUM(COALESCE(value_normalized, value_numeric)) AS sum_v, MIN(COALESCE(value_normalized, value_numeric)) AS min_v,\n  MAX(COALESCE(value_normalized, value_numeric)) AS max_v, AVG(COALESCE(value_normalized, value_numeric)) AS avg_v\nFROM apple_records\nWHERE type_zh IN ('心率','血氧','呼吸速率','睡眠','步數','步行跑步距離','騎車距離','爬樓層數','活動能量','基礎能量','步行速度','步幅','雙腳支撐比例','步態不對稱比例','耳機音量暴露','飲水量','攝取熱量','攝取脂肪','攝取碳水','攝取蛋白質') AND (profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')) IN (SELECT profile_id, type_zh, day, source_name FROM touched_keys)\nGROUP BY profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')",
    "params": 0
  },
  {
    "sql": "CREATE TEMP TABLE sleep_mins AS\nSELECT profile_id, substr(start_ts,1,10) AS day,\n  COALESCE(source_name,'') AS source_name,\n  COALESCE(value_text,'') AS ident,\n  CAST(ROUND(SUM((julianday(end_ts) - julianday(start_ts)) * 1440))\n    AS INTEGER) AS mins\nFROM apple_records\nWHERE type_zh = '睡眠' AND (profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')) IN (SELECT profile_id, type_zh, day, source_name FROM touched_keys)\nGROUP BY profile_id, substr(start_ts,1,10), COALESCE(source_name,''),\n  COALESCE(value_text,'')",
    "params": 0
  },
  {
    "sql": "INSERT INTO apple_daily(profile_id, doc_id, type_zh, day, source_name,\n  n, sum_v, min_v, max_v, avg_v, quality_flags)\nSELECT profile_id, doc_id, type_zh, day, source_name,\n  n, sum_v, min_v, max_v, avg_v,\n  CASE WHEN day < '2000-01-01'\n    THEN 'epoch_placeholder_date' ELSE '' END\nFROM touched_agg\nWHERE true -- 消除 parser 歧義：無此句時 ON 會被解析成 JOIN 條件（SQLite upsert 文件明載）\nON CONFLICT(profile_id, type_zh, day, source_name) DO UPDATE SET\n  n=excluded.n, sum_v=excluded.sum_v, min_v=excluded.min_v,\n  max_v=excluded.max_v, avg_v=excluded.avg_v, doc_id=excluded.doc_id,\n  quality_flags=excluded.quality_flags\n  WHERE excluded.n >= apple_daily.n",
    "params": 0
  },
  {
    "sql": "UPDATE apple_daily SET extra_json = (\n  SELECT json_group_object(ident, mins) FROM (\n    SELECT m.ident AS ident, m.mins AS mins FROM sleep_mins m\n    WHERE m.profile_id = apple_daily.profile_id\n      AND m.day = apple_daily.day\n      AND m.source_name = apple_daily.source_name\n    ORDER BY m.ident))\nWHERE type_zh = '睡眠' AND (apple_daily.profile_id, apple_daily.type_zh, apple_daily.day, apple_daily.source_name) IN (SELECT profile_id, type_zh, day, source_name FROM touched_keys)",
    "params": 0
  },
  {
    "sql": "UPDATE apple_daily\nSET quality_flags = CASE\n  WHEN quality_flags = '' THEN 'partial_reimport_skipped'\n  WHEN instr(quality_flags, 'partial_reimport_skipped') > 0 THEN quality_flags\n  ELSE quality_flags || ',partial_reimport_skipped' END\nWHERE rowid IN (\n  SELECT a.rowid FROM apple_daily a JOIN touched_agg g\n    ON a.profile_id = g.profile_id AND a.type_zh = g.type_zh\n   AND a.day = g.day AND a.source_name = g.source_name\n  WHERE a.n > g.n)",
    "params": 0
  },
  {
    "sql": "DROP TABLE touched_keys",
    "params": 0
  },
  {
    "sql": "DROP TABLE touched_agg",
    "params": 0
  },
  {
    "sql": "DROP TABLE sleep_mins",
    "params": 0
  }
]

BACKFILL_STATEMENTS = [
  "CREATE TEMP TABLE touched_agg AS\nSELECT profile_id, type_zh, substr(start_ts,1,10) AS day,\n  COALESCE(source_name,'') AS source_name, MAX(doc_id) AS doc_id,\n  COUNT(*) AS n, SUM(COALESCE(value_normalized, value_numeric)) AS sum_v, MIN(COALESCE(value_normalized, value_numeric)) AS min_v,\n  MAX(COALESCE(value_normalized, value_numeric)) AS max_v, AVG(COALESCE(value_normalized, value_numeric)) AS avg_v\nFROM apple_records\nWHERE type_zh IN ('心率','血氧','呼吸速率','睡眠','步數','步行跑步距離','騎車距離','爬樓層數','活動能量','基礎能量','步行速度','步幅','雙腳支撐比例','步態不對稱比例','耳機音量暴露','飲水量','攝取熱量','攝取脂肪','攝取碳水','攝取蛋白質')\nGROUP BY profile_id, type_zh, substr(start_ts,1,10), COALESCE(source_name,'')",
  "CREATE TEMP TABLE sleep_mins AS\nSELECT profile_id, substr(start_ts,1,10) AS day,\n  COALESCE(source_name,'') AS source_name,\n  COALESCE(value_text,'') AS ident,\n  CAST(ROUND(SUM((julianday(end_ts) - julianday(start_ts)) * 1440))\n    AS INTEGER) AS mins\nFROM apple_records\nWHERE type_zh = '睡眠'\nGROUP BY profile_id, substr(start_ts,1,10), COALESCE(source_name,''),\n  COALESCE(value_text,'')",
  "INSERT INTO apple_daily(profile_id, doc_id, type_zh, day, source_name,\n  n, sum_v, min_v, max_v, avg_v, quality_flags)\nSELECT profile_id, doc_id, type_zh, day, source_name,\n  n, sum_v, min_v, max_v, avg_v,\n  CASE WHEN day < '2000-01-01'\n    THEN 'epoch_placeholder_date' ELSE '' END\nFROM touched_agg\nWHERE true -- 消除 parser 歧義：無此句時 ON 會被解析成 JOIN 條件（SQLite upsert 文件明載）\nON CONFLICT(profile_id, type_zh, day, source_name) DO UPDATE SET\n  n=excluded.n, sum_v=excluded.sum_v, min_v=excluded.min_v,\n  max_v=excluded.max_v, avg_v=excluded.avg_v, doc_id=excluded.doc_id,\n  quality_flags=excluded.quality_flags\n  WHERE excluded.n >= apple_daily.n",
  "UPDATE apple_daily SET extra_json = (\n  SELECT json_group_object(ident, mins) FROM (\n    SELECT m.ident AS ident, m.mins AS mins FROM sleep_mins m\n    WHERE m.profile_id = apple_daily.profile_id\n      AND m.day = apple_daily.day\n      AND m.source_name = apple_daily.source_name\n    ORDER BY m.ident))\nWHERE type_zh = '睡眠'",
  "DROP TABLE touched_agg",
  "DROP TABLE sleep_mins"
]

# 前向遷移：{來源版本: [SQL, ...]}，逐版執行至 SCHEMA_VERSION。
# 每個元素 MUST 為單一語句（db.py 逐句 cur.execute，不走 executescript）。
MIGRATIONS = {
    1: ["ALTER TABLE source_documents ADD COLUMN import_stats TEXT"],
    2: ["CREATE INDEX IF NOT EXISTS idx_medications_profile"
        " ON medications(profile_id, encounter_id)"],
    3: [s.strip() for s in CPAP_DDL.split(";") if s.strip()],
    # v5：zip 容器指紋快篩欄位（App 端專用，Python CLI 不填；排除於差分對帳）
    4: ["ALTER TABLE source_documents ADD COLUMN container_sha256 TEXT"],
    # v6：Apple 每日彙總表＋以既有 raw 一次性回填（同一份聚合 SQL）
    5: ([s.strip() for s in APPLE_DAILY_DDL.split(";") if s.strip()]
        + BACKFILL_STATEMENTS),
}

# 帶指紋合併語意的健保紀錄表（碰撞防禦與 superseded 偵測作用對象）
FP_TABLES = ["encounters", "lab_results", "reports", "immunizations",
             "body_measurements", "cancer_screenings"]
ALL_TABLES = ["profiles", "source_documents", "medications",
              "apple_records", "apple_workouts", "apple_daily",
              "cpap_daily", "cpap_events", "cpap_oximetry"] + FP_TABLES

# 帶 quality_flags 欄位的全部資料表（品質報告逐表掃描）。順序 MUST 與 JS 的
# QUALITY_FLAG_TABLES 一致：品質報告在兩端要逐位元組同構。漏表的後果是該表
# 的旗標永遠不出現在報告上，而畫面照樣顯示「品質旗標：無」。
QUALITY_FLAG_TABLES = FP_TABLES + ["medications", "apple_records",
                                   "apple_workouts", "apple_daily",
                                   "cpap_daily", "cpap_events",
                                   "cpap_oximetry"]
