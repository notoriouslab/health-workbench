"""嵌入資料產生器（D2 三層）：醫療類全量、活動類日聚合、明細留庫。

- 跨來源重複計數防護：計數型活動資料每日各來源加總取最大（incremental-merge spec）
- 品質旗標排除：epoch_placeholder_date / out_of_range 不進趨勢序列
- 輸出各層體積明細供 size gate 使用
- JSON 內嵌採 \\u003c 跳脫，防止 </script> 逃逸與 HTML 誤解析
"""
import json
from datetime import date

from src.knowledge.drugs import DrugLookup
from src.knowledge.labs import load_entries

TREND_EXCLUDE = "quality_flags NOT LIKE '%epoch_placeholder_date%' AND quality_flags NOT LIKE '%out_of_range%'"

# 計數型（日加總取最大）vs 量測型（日中位數）
COUNTING_TYPES = ["步數", "步行跑步距離", "騎車距離", "爬樓層數", "活動能量", "基礎能量"]
MEASURE_TYPES = ["體重", "BMI", "體脂率", "收縮壓", "舒張壓", "心率", "血氧"]


def daily_counting_series(store, type_zh):
    """計數型：讀每日彙總表取單日最大值（防 iPhone/Watch 雙計）。

    與舊的 raw 查詢「(日,來源) SUM → 跨來源 MAX」代數等價（apple_daily 的
    sum_v 即 (日,來源) SUM）；epoch 排除由聚合時寫入的同名旗標承接。
    """
    rows = store.con.execute(f"""
        SELECT day d, MAX(sum_v) FROM apple_daily
        WHERE type_zh=? AND {TREND_EXCLUDE}
        GROUP BY day ORDER BY day""", (type_zh,)).fetchall()
    return [[r[0], round(r[1], 1)] for r in rows if r[1] is not None]


def daily_measure_series(store, type_zh):
    """量測型：每日中位數（抗離群）。"""
    rows = store.con.execute(f"""
        SELECT substr(start_ts,1,10) d, COALESCE(value_normalized, value_numeric) v
        FROM apple_records WHERE type_zh=? AND {TREND_EXCLUDE} AND
        COALESCE(value_normalized, value_numeric) IS NOT NULL
        ORDER BY d""", (type_zh,)).fetchall()
    buckets = {}
    for d, v in rows:
        buckets.setdefault(d, []).append(v)
    return [[d, round(sorted(vs)[len(vs) // 2], 2)] for d, vs in sorted(buckets.items())]


# 與 app/src/provider/payload.js 的同名常數同值（以晚為單位而非筆數，理由與
# 實測依據見那邊的註解）。兩邊不同值時，provider 同構測試只在資料量觸及較小
# 的那個上限時才會顯現差異，所以另有常數比對守衛
# （app/tests/provider/cpap_event_limit_parity.test.mjs）。
CPAP_EVENT_NIGHTS = 365
CPAP_EVENT_ROWS_CAP = 8000


def build_payload(store, db_path):
    """組出 dashboard 嵌入資料。回傳 (payload dict, 各層體積 bytes)。"""
    con = store.con

    # --- 醫療層（全量） ---
    encounters = [dict(r) for r in con.execute("""
        SELECT e.id, e.type, e.date, e.facility_name, e.dx_code, e.dx_name,
               e.copay, e.nhi_points, e.section, e.source_index, e.quality_flags,
               d.filename AS source_file
        FROM encounters e JOIN source_documents d ON e.doc_id = d.id
        ORDER BY e.date DESC, e.id DESC""")]
    meds_by_enc = {}
    lookup = DrugLookup(db_path)
    medications = []
    for r in con.execute("""
        SELECT m.id, m.encounter_id, m.order_code, m.order_name, m.total_qty,
               m.days_supply, m.tooth_name, m.section AS section_hint,
               e.date, e.facility_name
        FROM medications m JOIN encounters e ON m.encounter_id = e.id
        ORDER BY e.date DESC"""):
        m = dict(r)
        drug = lookup.lookup(m["order_code"])
        if drug:
            m["drug_zh"] = drug["name_zh"]
            m["ingredient"] = drug["ingredient"]
            m["leaflet_url"] = drug["leaflet_url"]
        medications.append(m)
        meds_by_enc.setdefault(m["encounter_id"], []).append(m["id"])
    drug_cache_meta = lookup.meta()
    lookup.close()

    labs = [dict(r) for r in con.execute("""
        SELECT id, COALESCE(test_name_normalized, test_name_raw) AS name,
               test_name_raw, test_name_normalized IS NULL AS unmapped,
               test_date, value_text, value_numeric, ref_range, facility_name,
               order_name, quality_flags
        FROM lab_results ORDER BY test_date""")]
    reports = [dict(r) for r in con.execute("""
        SELECT id, visit_date, test_date, facility_name, order_name, report_text
        FROM reports ORDER BY test_date DESC""")]
    immunizations = [dict(r) for r in con.execute(
        "SELECT date, vaccine_name, facility_name FROM immunizations ORDER BY date DESC")]
    nhi_body = [dict(r) for r in con.execute("""
        SELECT check_date, height_cm, weight_kg, bmi, waist, systolic, diastolic
        FROM body_measurements ORDER BY check_date""")]

    # --- knowledge 條目（檢驗說明） ---
    knowledge = {e["normalized_name"]: {
        "description": e["description"], "source_name": e["source_name"],
        "source_url": e["source_url"], "cited_date": str(e["cited_date"])}
        for e in load_entries()}

    # --- 活動層（日聚合） ---
    activity = {t: daily_counting_series(store, t) for t in COUNTING_TYPES}
    measures = {t: daily_measure_series(store, t) for t in MEASURE_TYPES}
    workouts = [dict(r) for r in con.execute("""
        SELECT activity, substr(start_ts,1,10) AS date, duration_min, source_name
        FROM apple_workouts ORDER BY start_ts DESC""")]

    # --- CPAP 層（design D10）---
    # 逐分鐘血氧不進 payload：Phase 2 帶進數年逐分鐘會是數十萬列。改帶每晚
    # 彙總，趨勢圖要的正是這個。與 app/src/provider/payload.js 的 cpapBlock
    # 逐句對應（provider_parity 是全等比對）。
    cpap_daily = [dict(r) for r in con.execute("""
        SELECT summary_date AS date, device, ahi, ai, hi, oai, cai, uai,
               usage_min, leak_95, pressure_95,
               session_start_min, session_end_min, session_count, quality_flags
        FROM cpap_daily ORDER BY summary_date""")]
    cpap_event_daily = [dict(r) for r in con.execute("""
        SELECT session_date AS date, event_type, COUNT(*) AS n
        FROM cpap_events GROUP BY session_date, event_type
        ORDER BY session_date, event_type""")]
    cpap_events_total = con.execute("SELECT COUNT(*) FROM cpap_events").fetchone()[0]
    cpap_nights_total = con.execute(
        "SELECT COUNT(DISTINCT session_date) FROM cpap_events").fetchone()[0]
    # 先取最近 N 個「有事件的」晚（不是日曆晚），再取這些晚的全部事件，
    # 最後依筆數硬上限從最舊的晚整晚剔除。語意與 payload.js 一致。
    cpap_nights = sorted(r[0] for r in con.execute("""
        SELECT session_date FROM cpap_events
        GROUP BY session_date ORDER BY session_date DESC LIMIT ?""",
        (CPAP_EVENT_NIGHTS,)))
    cpap_events = []
    if cpap_nights:
        ph = ",".join("?" * len(cpap_nights))
        cpap_events = [dict(r) for r in con.execute(f"""
            SELECT session_date, start_ts, duration_sec, event_type
            FROM cpap_events WHERE session_date IN ({ph})
            ORDER BY start_ts""", tuple(cpap_nights))]
    kept_nights = list(cpap_nights)
    while len(cpap_events) > CPAP_EVENT_ROWS_CAP and len(kept_nights) > 1:
        drop = kept_nights.pop(0)
        cpap_events = [e for e in cpap_events if e["session_date"] != drop]
    cpap_oximetry = [dict(r) for r in con.execute("""
        SELECT session_date AS date,
               MIN(spo2_min) AS spo2_min, ROUND(AVG(spo2_mean), 1) AS spo2_mean,
               ROUND(AVG(pulse_mean), 1) AS pulse_mean, MAX(pulse_max) AS pulse_max,
               SUM(sample_count) AS samples
        FROM cpap_oximetry GROUP BY session_date ORDER BY session_date""")]
    cpap = {
        "daily": cpap_daily,
        "event_daily": cpap_event_daily,
        "events": cpap_events,
        "events_total": cpap_events_total,
        "events_nights": len(kept_nights),
        "events_nights_total": cpap_nights_total,
        "events_truncated": len(kept_nights) < cpap_nights_total,
        "oximetry": cpap_oximetry,
    }

    date_min, date_max = con.execute(
        "SELECT MIN(date), MAX(date) FROM encounters").fetchone()
    payload = {
        "meta": {
            "generated_at": date.today().isoformat(),
            "date_min": date_min, "date_max": date_max,
            "profile": con.execute("SELECT display_name FROM profiles LIMIT 1").fetchone()[0],
            "counts": store.table_counts(),
            "sources": [dict(r) for r in con.execute(
                "SELECT filename, adapter, imported_at, import_stats"
                " FROM source_documents ORDER BY imported_at")],
            "drug_cache": drug_cache_meta,
        },
        "encounters": encounters,
        "meds_by_enc": meds_by_enc,
        "medications": medications,
        "labs": labs,
        "reports": reports,
        "immunizations": immunizations,
        "nhi_body": nhi_body,
        "knowledge": knowledge,
        "activity": activity,
        "measures": measures,
        "workouts": workouts,
        "cpap": cpap,
    }

    sizes = {}
    medical_keys = ["encounters", "meds_by_enc", "medications", "labs", "reports",
                    "immunizations", "nhi_body", "knowledge"]
    activity_keys = ["activity", "measures", "workouts"]
    for group, keys in [("medical", medical_keys), ("activity", activity_keys),
                        ("meta", ["meta"])]:
        sizes[group] = sum(len(json.dumps(payload[k], ensure_ascii=False).encode())
                           for k in keys)
    return payload, sizes


def to_embedded_json(payload):
    """安全內嵌：\\u003c 跳脫防 </script> 逃逸；> 與 & 一併跳脫。"""
    s = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
