"""health-database schema：全表 profile_id、來源追溯、quality_flags、版本化。"""

SCHEMA_VERSION = 5

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
""" + CPAP_DDL

# 前向遷移：{來源版本: [SQL, ...]}，逐版執行至 SCHEMA_VERSION。
# 每個元素 MUST 為單一語句（db.py 逐句 cur.execute，不走 executescript）。
MIGRATIONS = {
    1: ["ALTER TABLE source_documents ADD COLUMN import_stats TEXT"],
    2: ["CREATE INDEX IF NOT EXISTS idx_medications_profile"
        " ON medications(profile_id, encounter_id)"],
    3: [s.strip() for s in CPAP_DDL.split(";") if s.strip()],
    # v5：zip 容器指紋快篩欄位（App 端專用，Python CLI 不填；排除於差分對帳）
    4: ["ALTER TABLE source_documents ADD COLUMN container_sha256 TEXT"],
}

# 帶指紋合併語意的健保紀錄表（碰撞防禦與 superseded 偵測作用對象）
FP_TABLES = ["encounters", "lab_results", "reports", "immunizations",
             "body_measurements", "cancer_screenings"]
ALL_TABLES = ["profiles", "source_documents", "medications",
              "apple_records", "apple_workouts",
              "cpap_daily", "cpap_events", "cpap_oximetry"] + FP_TABLES

# 帶 quality_flags 欄位的全部資料表（品質報告逐表掃描）。順序 MUST 與 JS 的
# QUALITY_FLAG_TABLES 一致：品質報告在兩端要逐位元組同構。漏表的後果是該表
# 的旗標永遠不出現在報告上，而畫面照樣顯示「品質旗標：無」。
QUALITY_FLAG_TABLES = FP_TABLES + ["medications", "apple_records",
                                   "apple_workouts", "cpap_daily",
                                   "cpap_events", "cpap_oximetry"]
