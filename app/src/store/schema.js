// health-database schema JS 版：DDL 字串自 src/store/schema.py 逐字移植，
// 驗收＝兩邊空庫正規化 schema dump 全等（tests/store/schema_parity.test.mjs）。
// 修改 DDL 時 MUST 同步修改 Python 版並重跑 parity 測試。

export const SCHEMA_VERSION = 5;

// CPAP 三表（v4 新增）：同時作為初始 DDL 與 3→4 遷移的單一來源，兩處
// 手寫會漂移（migration 2 即為重複語句維護的前例）。欄位選取以兩台機器
// 共通的臨床量為準，不含廠牌專有欄位（change cpap-sleep-therapy design D3）。
// UNIQUE 鍵含 device：不同機器的資料期間會重疊，不含裝置會使同一天被當
// 重複而靜默丟棄。
const CPAP_DDL = `
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
`;

export const DDL = `
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
${CPAP_DDL}`;

// 前向遷移：{來源版本: [SQL, ...]}，逐版執行至 SCHEMA_VERSION（同 Python）。
// 每個元素 MUST 為單一語句（Python 端逐句 cur.execute，不走 executescript）。
export const MIGRATIONS = {
  1: ["ALTER TABLE source_documents ADD COLUMN import_stats TEXT"],
  2: ["CREATE INDEX IF NOT EXISTS idx_medications_profile"
      + " ON medications(profile_id, encounter_id)"],
  3: splitStatements(CPAP_DDL),
  // v5：zip 容器指紋快篩欄位（僅 zip 來源填值，非 zip 為 NULL；
  // App 端快篩專用，排除於 Python 差分對帳）
  4: ["ALTER TABLE source_documents ADD COLUMN container_sha256 TEXT"],
};

export class SchemaTooNew extends Error {}
export class NoMigrationPath extends Error {}

// 初始化／前向遷移，語意鏡像 src/store/db.py Store._init_schema
export async function initSchema(driver) {
  const existing = await driver.select(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'");
  if (existing.length === 0) {
    for (const stmt of splitStatements(DDL)) await driver.execute(stmt);
    await driver.execute("INSERT INTO schema_version(version) VALUES (?)", [SCHEMA_VERSION]);
    return SCHEMA_VERSION;
  }
  const [{ ver: current }] = await driver.select(
    "SELECT MAX(version) ver FROM schema_version");
  // schema_version 表存在但沒有任何版本紀錄＝庫被破壞或人為清空。此時
  // MAX(version) 為 null，而 null 與數字的所有比較都是 false，不明確攔下
  // 就會靜默通過並讓後續操作跑在缺表的庫上（錯誤會延後到難以診斷的地方）。
  if (current == null) {
    throw new NoMigrationPath(
      "資料庫的 schema_version 表沒有任何版本紀錄，無法判斷升級路徑；"
      + "請改用「匯入既有資料庫檔」載入可用的備份。");
  }
  if (current > SCHEMA_VERSION) {
    throw new SchemaTooNew(
      `資料庫 schema 版本 ${current} 高於程式支援的 ${SCHEMA_VERSION}，請更新 App`);
  }
  if (current === SCHEMA_VERSION) return current;
  // 遷移整段包在單一交易內：版本註記與 DDL 同進同出。未交易化時若第二張
  // 表建到一半中斷，庫會停在「版本已寫新值但表只建了一部分」的不一致狀態，
  // 而這是第一次讓既有生產庫真正跑遷移（cpap-sleep-therapy design D8）。
  return driver.transaction(async (d) => {
    let ver = current;
    while (ver < SCHEMA_VERSION) {
      const steps = MIGRATIONS[ver];
      if (!steps) {
        throw new NoMigrationPath(
          `資料庫 schema 版本 ${ver} 與程式 ${SCHEMA_VERSION} 不符，且無可用遷移路徑`);
      }
      for (const sql of steps) await d.execute(sql);
      ver += 1;
      await d.execute("INSERT INTO schema_version(version) VALUES (?)", [ver]);
    }
    return ver;
  });
}

// 以分號＋換行切分 DDL（DDL 內無字串常值含分號，安全）
function splitStatements(ddl) {
  return ddl.split(";").map(s => s.trim()).filter(Boolean);
}
