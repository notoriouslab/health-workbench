"""品質報告產生模組：固定結構 JSON（八個頂層欄位有序）＋人讀摘要。

`hwb import` 印當次增量；`hwb quality` 印全庫彙整。兩者共用本模組。
結構依 design.md Implementation Contract。
"""
import json

TOP_KEYS = ["source", "sections", "date_ranges", "quality_flags",
            "unmapped_lab_names", "superseded_candidates", "stale_knowledge", "dedup"]


def build_report(*, source, sections, date_ranges, quality_flags,
                 unmapped_lab_names, superseded_candidates, stale_knowledge, dedup):
    """組出固定結構報告。所有欄位必填（可為空 dict/list/0），順序固定。"""
    report = {
        "source": source,
        "sections": sections,
        "date_ranges": date_ranges,
        "quality_flags": quality_flags,
        "unmapped_lab_names": unmapped_lab_names,
        "superseded_candidates": superseded_candidates,
        "stale_knowledge": stale_knowledge,
        "dedup": dedup,
    }
    assert list(report) == TOP_KEYS
    return report


def build_incremental(store, *, source_info, sections):
    """匯入後的增量報告：以 store.stats 與本次節區統計組裝。"""
    return build_report(
        source=source_info,
        sections=sections,
        date_ranges=_date_ranges(store),
        quality_flags=store.quality_flag_counts(),
        unmapped_lab_names=_unmapped_labs(store),
        superseded_candidates=_superseded_count(store),
        stale_knowledge=[],
        dedup={"skipped_dup": store.stats["skipped_dup"],
               "collisions": store.stats["collisions"]},
    )


def build_full(store, stale_knowledge=None):
    """全庫彙整報告（hwb quality）：唯讀，不重新解析任何來源檔。"""
    docs = store.con.execute(
        "SELECT filename, adapter, adapter_version, imported_at FROM source_documents"
        " ORDER BY imported_at").fetchall()
    return build_report(
        source={"documents": [dict(d) for d in docs]},
        sections=_section_counts(store),
        date_ranges=_date_ranges(store),
        quality_flags=store.quality_flag_counts(),
        unmapped_lab_names=_unmapped_labs(store),
        superseded_candidates=_superseded_count(store),
        stale_knowledge=stale_knowledge or [],
        dedup={},
    )


# 各資料表的代表性日期欄位。欄位名各表不同、也不是每張有日期的表都值得報告
# （apple_workouts 與 apple_records 期間重疊），所以無法用 DDL 自動對帳，
# 新增有日期的資料表時 MUST 手動評估。順序 MUST 與 JS 的 DATE_RANGE_COLUMNS
# 一致：品質報告在兩端要逐位元組同構。
DATE_RANGE_COLUMNS = [
    ("encounters", "date"), ("lab_results", "test_date"),
    ("immunizations", "date"), ("body_measurements", "check_date"),
    ("apple_records", "start_ts"),
    # apple_daily：raw 清理後 apple_records 範圍縮水，完整期間由彙總表扛
    ("apple_daily", "day"),
    ("cpap_daily", "summary_date"), ("cpap_events", "session_date"),
    ("cpap_oximetry", "session_date"),
]


def _date_ranges(store):
    out = {}
    for table, col in DATE_RANGE_COLUMNS:
        lo, hi = store.con.execute(
            f"SELECT MIN({col}), MAX({col}) FROM {table}"
            f" WHERE quality_flags NOT LIKE '%epoch_placeholder_date%'"
            f" AND quality_flags NOT LIKE '%out_of_range%'").fetchone()
        out[table] = [lo, hi]
    return out


def _section_counts(store):
    out = {}
    for t in ["encounters", "lab_results", "reports", "immunizations",
              "body_measurements", "cancer_screenings"]:
        for r in store.con.execute(
                f"SELECT section, COUNT(*) n FROM {t} GROUP BY section"):
            out[r["section"]] = {"table": t, "records": r["n"]}
    for t in ["medications", "apple_records", "apple_workouts"]:
        n = store.con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        out[t] = {"table": t, "records": n}
    return out


def _unmapped_labs(store):
    rows = store.con.execute(
        "SELECT DISTINCT test_name_raw FROM lab_results"
        " WHERE test_name_normalized IS NULL AND test_name_raw IS NOT NULL"
        " ORDER BY test_name_raw").fetchall()
    return [r[0] for r in rows]


def _superseded_count(store):
    """疑似改版對照組：弱組合鍵（機構＋日期＋節區＋就醫序號）相同、指紋不同、
    且來自不同批次（doc_id 不同）。同批次內的弱鍵重複是同次就醫多筆申報的
    常態（實測：診察費與檢查費分列、復健針灸系列申報），不列入。"""
    row = store.con.execute("""
        SELECT COUNT(*) FROM (
          SELECT facility_code, date, section, visit_seq FROM encounters
          WHERE facility_code IS NOT NULL AND date IS NOT NULL
          GROUP BY facility_code, date, section, visit_seq
          HAVING COUNT(DISTINCT record_fp) > 1
             AND COUNT(DISTINCT doc_id) > 1)""").fetchone()
    return row[0]


def render_text(report):
    """人讀摘要（繁中）。"""
    lines = ["── 品質報告 ──"]
    src = report["source"]
    if "documents" in src:
        lines.append(f"來源檔：{len(src['documents'])} 份")
    else:
        lines.append(f"來源檔：{src.get('filename', '?')}（{src.get('adapter', '?')}）")
    for sec, info in report["sections"].items():
        lines.append(f"  {sec}: {info['records'] if isinstance(info, dict) else info} 筆")
    for t, (lo, hi) in report["date_ranges"].items():
        if lo:
            lines.append(f"  {t} 期間：{lo} ～ {hi}")
    perr = src.get("parse_errors") if isinstance(src, dict) else None
    if perr:
        n = perr if isinstance(perr, int) else len(perr)
        lines.append(f"解析錯誤（已續行，該筆未入庫）：{n} 筆")
        if isinstance(perr, list):
            lines.extend(f"  ! {e}" for e in perr[:5])
    if report["quality_flags"]:
        lines.append("品質旗標：" + "、".join(
            f"{k}×{v}" for k, v in sorted(report["quality_flags"].items())))
    if report["unmapped_lab_names"]:
        lines.append(f"未對照檢驗名：{len(report['unmapped_lab_names'])} 項")
    if report["superseded_candidates"]:
        lines.append(f"疑似改版對照組：{report['superseded_candidates']} 組")
    if report["stale_knowledge"]:
        lines.append(f"過時 knowledge 條目：{len(report['stale_knowledge'])} 條")
    if report["dedup"]:
        lines.append(f"去重統計：{json.dumps(report['dedup'], ensure_ascii=False)}")
    return "\n".join(lines)
