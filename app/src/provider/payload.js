// DataProvider（design D4）：以 SQL 組裝與 src/dashboard/embed.py 同構的
// payload。聚合規則沿用 dashboard-generator spec（計數型日加總取最大、
// 量測型日中位數、品質旗標排除）。差分驗收：tests/provider/ 對同一庫
// 比對 Python build_payload 輸出數值全等（generated_at 除外）。
import { attachDrugs } from "../knowledge/drugs.js";
import { requireProfile } from "../engine/profiles.js";
import { PER_ROW_TYPES } from "../engine/aggregate.js";

const TREND_EXCLUDE = "quality_flags NOT LIKE '%epoch_placeholder_date%'"
  + " AND quality_flags NOT LIKE '%out_of_range%'";

const COUNTING_TYPES = ["步數", "步行跑步距離", "騎車距離", "爬樓層數", "活動能量", "基礎能量"];
// 中位數組＝逐筆保留清單全等（app-viewer「DataProvider 契約」：帶狀型別
// 誤入這組的話，釋放空間刪 raw 後圖會破且無錯誤訊息）；帶狀組讀 apple_daily。
// 與 src/dashboard/embed.py 的同名常數必須同值（band_types.test.mjs 釘住）。
export const MEDIAN_TYPES = PER_ROW_TYPES;
export const BAND_TYPES = ["心率", "血氧", "呼吸速率"];

const TABLES = ["profiles", "source_documents", "encounters", "medications",
  "lab_results", "reports", "immunizations", "body_measurements",
  "cancer_screenings", "apple_records", "apple_workouts", "apple_daily",
  "cpap_daily", "cpap_events", "cpap_oximetry"];

// CPAP 逐筆事件的 payload 上限，以**晚**為單位而非筆數（change
// viewer-and-history-refinement D3）。按筆數切會落在某一晚的中間，那晚只剩
// 一半事件而畫面上看不出被截斷；按晚切則任一晚要嘛完整、要嘛不在 payload。
// 晚數取 365（一年）。原本是 90，理由是「畫面上的晚標頭不能無限長」；檢視層
// 改成年 → 晚 → 逐筆三層摺疊後那個顧慮消失（常駐 DOM 只有年份那幾行），
// 於是放寬到一年，讓「回頭看去年同期」做得到。筆數硬上限仍留著，防的是每晚
// 上百筆的極端使用者。超過筆數上限時**從最舊的晚整晚剔除**，不切半晚。
// 實測依據（2026-08-13）：每筆 110 bytes；本機密度 十餘筆/晚 → 365 晚約
// 674 KB，佔 assemble 的 10 MB 上限 6.6%；密度再高就由 8,000 筆上限接手
// （880 KB 為上界）。
// UI MUST 依 events_truncated 揭露保留範圍，不可靜默截斷。
// 與 src/dashboard/embed.py 的同名常數必須同值（tests/provider/
// cpap_event_limit_parity.test.mjs 釘住）。
export const CPAP_EVENT_NIGHTS = 365;
export const CPAP_EVENT_ROWS_CAP = 8000;

// CPAP 區塊（design D10）。逐分鐘血氧不進 payload：Phase 1 沒有資料，
// Phase 2 帶進數年逐分鐘會是數十萬列。改帶每晚彙總，趨勢圖要的正是這個。
async function cpapBlock(driver, profileId) {
  const daily = await driver.select(`
    SELECT summary_date AS date, device, ahi, ai, hi, oai, cai, uai,
           usage_min, leak_95, pressure_95,
           session_start_min, session_end_min, session_count, quality_flags
    FROM cpap_daily WHERE profile_id=? ORDER BY summary_date`, [profileId]);
  const eventDaily = await driver.select(`
    SELECT session_date AS date, event_type, COUNT(*) AS n
    FROM cpap_events WHERE profile_id=?
    GROUP BY session_date, event_type ORDER BY session_date, event_type`, [profileId]);
  const [{ total }] = await driver.select(
    "SELECT COUNT(*) AS total FROM cpap_events WHERE profile_id=?", [profileId]);
  const [{ nights_total: nightsTotal }] = await driver.select(
    "SELECT COUNT(DISTINCT session_date) AS nights_total FROM cpap_events"
    + " WHERE profile_id=?", [profileId]);
  // 先取最近 N 個**有事件的**晚（不是日曆晚：本機 數百晚只有 17 晚有事件），
  // 再取這些晚的全部事件，最後在 JS 端依筆數硬上限從最舊的晚整晚剔除。
  const nightRows = await driver.select(`
    SELECT session_date FROM cpap_events WHERE profile_id=?
    GROUP BY session_date ORDER BY session_date DESC LIMIT ?`,
    [profileId, CPAP_EVENT_NIGHTS]);
  const nights = nightRows.map(r => r.session_date).sort();
  let events = [];
  if (nights.length) {
    const ph = nights.map(() => "?").join(",");
    events = await driver.select(`
      SELECT session_date, start_ts, duration_sec, event_type
      FROM cpap_events WHERE profile_id=? AND session_date IN (${ph})
      ORDER BY start_ts`, [profileId, ...nights]);
  }
  // 筆數硬上限：從最舊的晚整晚移除，直到不超過上限。剔到只剩一晚仍超過時
  // 保留那一晚（寧可帶一晚完整資料，也不切成半晚）。
  const keptNights = [...nights];
  while (events.length > CPAP_EVENT_ROWS_CAP && keptNights.length > 1) {
    const drop = keptNights.shift();
    events = events.filter(e => e.session_date !== drop);
  }
  // 每晚彙總：整晚最低血氧與平均，供跨日趨勢。以 SQL 的 ROUND 計算而非
  // 在兩種語言各自實作四捨五入（provider_parity 是全等比對）。
  const oximetry = await driver.select(`
    SELECT session_date AS date,
           MIN(spo2_min) AS spo2_min, ROUND(AVG(spo2_mean), 1) AS spo2_mean,
           ROUND(AVG(pulse_mean), 1) AS pulse_mean, MAX(pulse_max) AS pulse_max,
           SUM(sample_count) AS samples
    FROM cpap_oximetry WHERE profile_id=?
    GROUP BY session_date ORDER BY session_date`, [profileId]);
  return {
    daily: daily.map(r => ({ ...r })),
    event_daily: eventDaily.map(r => ({ ...r })),
    events: events.map(r => ({ ...r })),
    events_total: total,
    events_nights: keptNights.length,
    events_nights_total: nightsTotal,
    events_truncated: keptNights.length < nightsTotal,
    oximetry: oximetry.map(r => ({ ...r })),
  };
}

// Python round() 等價：round-half-even（銀行家捨入）
export function pyRound(v, digits) {
  const f = 10 ** digits;
  const x = v * f;
  const r = Math.round(x);
  // JS Math.round 對 .5 恆向上；Python 對「剛好 .5」取偶數
  if (Math.abs(x - Math.trunc(x)) === 0.5) {
    const down = Math.trunc(x);
    return (down % 2 === 0 ? down : down + (x > 0 ? 1 : -1)) / f;
  }
  return r / f;
}

// 活動類改讀彙總表（change apple-daily-aggregates）：MAX(sum_v) GROUP BY day
// 與舊查詢「(日,來源) SUM → 跨來源 MAX」代數等價（tests/provider/
// activity_switch.test.mjs 以雙查詢逐日全等實證，並以 EXPLAIN 斷言不再
// 全表掃描 apple_records）。epoch 排除語意由聚合時寫入的同名旗標承接。
async function dailyCountingSeries(driver, typeZh, profileId) {
  const rows = await driver.select(`
    SELECT day d, MAX(sum_v) v FROM apple_daily
    WHERE profile_id=? AND type_zh=? AND ${TREND_EXCLUDE}
    GROUP BY day ORDER BY day`, [profileId, typeZh]);
  return rows.filter(r => r.v !== null).map(r => [r.d, pyRound(r.v, 1)]);
}

// 帶狀組：每日 [day, avg, min, max]（change display-revamp-bands-cleanup
// D1）。讀彙總表而非 raw——釋放空間刪 raw 後仍須可繪。epoch 旗標排除、
// partial_reimport_skipped 保留（該列數值仍是既有最完整值），TREND_EXCLUDE
// 恰好是這個語意（out_of_range 不會出現在 apple_daily）。
// 同日多來源合併為單點：avg = SUM(sum_v)/SUM(n) 與全體 raw 直算精確全等
// （不是加權近似），min/max 取跨來源極值。捨入以 SQL ROUND 取 2 位
// （「新增彙總 MUST 以 SQL 計算捨入」條文；血氧值域 0-1，1 位會砍光解析度）。
async function dailyBandSeries(driver, typeZh, profileId) {
  const rows = await driver.select(`
    SELECT day d, ROUND(SUM(sum_v)/SUM(n), 2) a, MIN(min_v) lo, MAX(max_v) hi
    FROM apple_daily
    WHERE profile_id=? AND type_zh=? AND ${TREND_EXCLUDE}
    GROUP BY day ORDER BY day`, [profileId, typeZh]);
  return rows.filter(r => r.a !== null).map(r => [r.d, r.a, r.lo, r.hi]);
}

// 睡眠每日識別字分鐘（extra_json 原樣帶出，識別字不轉譯）。同日多來源取
// 分鐘合計最大的單一來源（防雙計，語意同活動類跨來源 MAX；同分以
// source_name 排序取首，兩端決定性一致）。
async function sleepDaily(driver, profileId) {
  const rows = await driver.select(`
    SELECT day d, extra_json e FROM apple_daily x
    WHERE x.profile_id=? AND x.type_zh='睡眠' AND x.extra_json IS NOT NULL
      AND x.quality_flags NOT LIKE '%epoch_placeholder_date%'
      AND x.source_name = (
        SELECT y.source_name FROM apple_daily y
        WHERE y.profile_id = x.profile_id AND y.type_zh = '睡眠'
          AND y.day = x.day AND y.extra_json IS NOT NULL
        ORDER BY (SELECT SUM(value) FROM json_each(y.extra_json)) DESC,
          y.source_name
        LIMIT 1)
    ORDER BY d`, [profileId]);
  return rows.map(r => [r.d, JSON.parse(r.e)]);
}

async function dailyMeasureSeries(driver, typeZh, profileId) {
  const rows = await driver.select(`
    SELECT substr(start_ts,1,10) d, COALESCE(value_normalized, value_numeric) v
    FROM apple_records WHERE profile_id=? AND type_zh=? AND ${TREND_EXCLUDE} AND
    COALESCE(value_normalized, value_numeric) IS NOT NULL
    ORDER BY d`, [profileId, typeZh]);
  const buckets = new Map();
  for (const { d, v } of rows) {
    if (!buckets.has(d)) buckets.set(d, []);
    buckets.get(d).push(v);
  }
  return [...buckets.keys()].sort().map(d => {
    const vs = buckets.get(d).slice().sort((a, b) => a - b);
    return [d, pyRound(vs[Math.floor(vs.length / 2)], 2)];
  });
}

// knowledgeEntries: labs.json 條目；bodyRefs: body_refs.json 條目（身體數值
// 參考線，缺省為空＝不畫參考線）；drugCachePath: drug_items.sqlite 路徑（可 null）
// profileId 必填（app-viewer spec：provider 僅回傳該成員資料）
export async function buildPayload(driver, { profileId, knowledgeEntries,
  bodyRefs = [], drugCachePath, today }) {
  const profileRow = await requireProfile(driver, profileId);
  const encounters = (await driver.select(`
    SELECT e.id, e.type, e.date, e.facility_name, e.dx_code, e.dx_name,
           e.copay, e.nhi_points, e.section, e.source_index, e.quality_flags,
           d.filename AS source_file
    FROM encounters e JOIN source_documents d ON e.doc_id = d.id
    WHERE e.profile_id=?
    ORDER BY e.date DESC, e.id DESC`, [profileId])).map(r => ({ ...r }));

  const medsByEnc = {};
  const medications = [];
  const drugs = drugCachePath ? await attachDrugs(driver, drugCachePath) : null;
  for (const row of await driver.select(`
    SELECT m.id, m.encounter_id, m.order_code, m.order_name, m.total_qty,
           m.days_supply, m.tooth_name, m.section AS section_hint,
           e.date, e.facility_name
    FROM medications m JOIN encounters e ON m.encounter_id = e.id
    WHERE m.profile_id=?
    ORDER BY e.date DESC`, [profileId])) {
    const m = { ...row };
    const drug = drugs ? await drugs.lookup(m.order_code) : null;
    if (drug) {
      m.drug_zh = drug.name_zh;
      m.ingredient = drug.ingredient;
      m.leaflet_url = drug.leaflet_url;
      // 許可證欄位（design D3）：舊快取無這些欄 → 不設鍵；有欄值為 NULL →
      // 設 null。鍵集合與值 MUST 與 embed.py 逐字同形（parity 全等對帳）。
      // license_id 不進 payload（顯示層用不到）。
      if ("indication" in drug) m.indication = drug.indication;
      if ("usage_text" in drug) m.usage_text = drug.usage_text;
      if ("license_status" in drug) m.license_status = drug.license_status;
    }
    medications.push(m);
    (medsByEnc[m.encounter_id] = medsByEnc[m.encounter_id] || []).push(m.id);
  }
  const drugCacheMeta = drugs ? await drugs.meta() : null;
  if (drugs) await drugs.detach();

  const labs = (await driver.select(`
    SELECT id, COALESCE(test_name_normalized, test_name_raw) AS name,
           test_name_raw, test_name_normalized IS NULL AS unmapped,
           test_date, value_text, value_numeric, ref_range, facility_name,
           order_name, quality_flags
    FROM lab_results WHERE profile_id=? ORDER BY test_date`, [profileId]))
    .map(r => ({ ...r }));
  const reports = (await driver.select(`
    SELECT id, visit_date, test_date, facility_name, order_name, report_text
    FROM reports WHERE profile_id=? ORDER BY test_date DESC`, [profileId]))
    .map(r => ({ ...r }));
  const immunizations = (await driver.select(
    "SELECT date, vaccine_name, facility_name FROM immunizations"
    + " WHERE profile_id=? ORDER BY date DESC", [profileId]))
    .map(r => ({ ...r }));
  const nhiBody = (await driver.select(`
    SELECT check_date, height_cm, weight_kg, bmi, waist, systolic, diastolic
    FROM body_measurements WHERE profile_id=? ORDER BY check_date`, [profileId]))
    .map(r => ({ ...r }));

  const knowledge = {};
  for (const e of knowledgeEntries) {
    knowledge[e.normalized_name] = {
      description: e.description, source_name: e.source_name,
      source_url: e.source_url, cited_date: String(e.cited_date),
    };
  }

  const activity = {};
  for (const t of COUNTING_TYPES) {
    activity[t] = await dailyCountingSeries(driver, t, profileId);
  }
  const measures = {};
  for (const t of MEDIAN_TYPES) {
    measures[t] = await dailyMeasureSeries(driver, t, profileId);
  }
  const measureBands = {};
  for (const t of BAND_TYPES) {
    measureBands[t] = await dailyBandSeries(driver, t, profileId);
  }
  const sleepDailySeries = await sleepDaily(driver, profileId);
  const workouts = (await driver.select(`
    SELECT activity, substr(start_ts,1,10) AS date, duration_min, source_name
    FROM apple_workouts WHERE profile_id=? ORDER BY start_ts DESC`, [profileId]))
    .map(r => ({ ...r }));

  const [range] = await driver.select(
    "SELECT MIN(date) lo, MAX(date) hi FROM encounters WHERE profile_id=?",
    [profileId]);
  // counts 各表過濾至當前成員；唯 profiles 一欄維持全庫成員數（design D3）
  const counts = {};
  for (const t of TABLES) {
    const [{ c }] = t === "profiles"
      ? await driver.select("SELECT COUNT(*) c FROM profiles")
      : await driver.select(
        `SELECT COUNT(*) c FROM ${t} WHERE profile_id=?`, [profileId]);
    counts[t] = c;
  }
  // sources 僅當前成員的來源檔案（HTML 匯出不得夾帶他人檔名）
  const sources = (await driver.select(
    "SELECT filename, adapter, imported_at, import_stats"
    + " FROM source_documents WHERE profile_id=? ORDER BY imported_at",
    [profileId])).map(r => ({ ...r }));

  const cpap = await cpapBlock(driver, profileId);

  return {
    meta: {
      generated_at: today,
      date_min: range.lo, date_max: range.hi,
      profile: profileRow.display_name,
      counts,
      sources,
      drug_cache: drugCacheMeta,
    },
    encounters,
    meds_by_enc: medsByEnc,
    medications,
    labs,
    reports,
    immunizations,
    nhi_body: nhiBody,
    knowledge,
    activity,
    measures,
    measure_bands: measureBands,
    sleep_daily: sleepDailySeries,
    body_refs: bodyRefs,
    workouts,
    cpap,
  };
}
