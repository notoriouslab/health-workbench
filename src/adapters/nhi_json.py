"""健保存摺醫療類 JSON adapter（nhi-import capability）。

- 14 節區完整解析、節區代碼小寫正規化、「無資料」佔位、未知欄位保留
- 藥局交付調劑日期回退（r1.5 空 → r1.6）
- 巢狀醫囑（r1_1/r3_1/r9_1）完整入庫＋對帳
- 遮罩身分證歸戶防護、檔案 SHA-256 防重複匯入
"""
import hashlib
import json
import re
import sys

from src.quality.quality_report import build_incremental, render_text
from src.store.db import Store

from . import register
from . import nhi_fieldmap as fm

ADAPTER_VERSION = "1.0.0"
NO_DATA = "無資料"

# (事件型別, 日期鍵, 院所名, 院所代碼, 診斷碼, 診斷名, 部分負擔, 支付點數, 就醫序號, 欄位表)
ENCOUNTER_SECTIONS = {
    "r1": ("western_outpatient", "r1.5", "r1.4", "r1.3", "r1.8", "r1.9", "r1.12", "r1.13", "r1.7", fm.R1),
    "r3": ("dental", "r3.5", "r3.4", "r3.3", "r3.7", "r3.8", "r3.11", "r3.12", "r3.6", fm.R3),
    "r9": ("tcm", "r9.5", "r9.4", "r9.3", "r9.7", "r9.8", "r9.11", "r9.12", "r9.6", fm.R9),
}
KNOWN_FIELDS = {"r1": {**fm.R1, "r1_1": None}, "r3": {**fm.R3, "r3_1": None},
                "r9": {**fm.R9, "r9_1": None}, "r6": fm.R6, "r7": fm.R7,
                "r8": fm.R8, "r10": fm.R10, "r11": {**fm.R11, "r11_1": None}}


def norm_date(s):
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    if re.fullmatch(r"\d{8}", s):
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    if re.fullmatch(r"\d{6}", s):
        return f"{s[:4]}-{s[4:6]}"
    return None


def to_num(s):
    if s is None or isinstance(s, (int, float)):
        return s
    try:
        s = str(s).strip()
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


def is_no_data(rows, sec):
    return (isinstance(rows, list) and len(rows) == 1
            and list(rows[0].keys()) in ([sec], [sec.upper()])
            and list(rows[0].values())[0] == NO_DATA)


@register
class NhiJsonAdapter:
    FORMAT_DESC = "健保存摺醫療類 JSON（健康存摺醫療類_*.json）"

    @staticmethod
    def detect(path):
        if not path.is_file() or path.suffix.lower() != ".json":
            return False
        try:
            head = path.read_bytes()[:2048].decode("utf-8-sig", errors="ignore")
        except OSError:
            return False
        return '"myhealthbank"' in head

    def import_file(self, path, *, db_path, assume_profile=False):
        raw = path.read_bytes()
        sha256 = hashlib.sha256(raw).hexdigest()
        # 健保署匯出的報告類自由文字欄位（如 r8.10 影像／病理報告）會塞入未跳脫
        # 的原始控制字元，例如聽力檢查用 TAB 對齊左右耳結果。這違反 RFC 8259，
        # 但確實是官方匯出工具的真實輸出；strict=True 會在此整批中止，連逐筆
        # guard() 防線都來不及發揮。值刻意保留原字元不做替換：報告以等寬 pre-wrap
        # 呈現，TAB 的對齊有意義。JS 版 JSON.parse 無對應開關，以 parseJsonTolerant
        # 達成同語意，兩實作等價性由 app/tests/parity/ 釘住。
        data = json.loads(raw.decode("utf-8-sig"), strict=False)
        bdata = {k.lower(): v for k, v in data["myhealthbank"]["bdata"].items()}
        masked_id = (bdata.get("b1.1") or "").strip()

        store = Store(db_path)
        try:
            rc = self._import(store, path, sha256, bdata, masked_id, assume_profile)
            if rc == 0:
                store.commit()
            return rc
        finally:
            store.close()

    def _import(self, store, path, sha256, bdata, masked_id, assume_profile):
        # 遮罩身分證歸戶防護：
        # 既有已綁定 → 必須完全一致；檔案缺 b1.1 → 中止（檔案異常）；
        # 既有未綁定（如 Apple 先匯入所建）→ 首次健保匯入認領綁定。
        row = store.con.execute("SELECT id, masked_id FROM profiles ORDER BY id LIMIT 1").fetchone()
        if row:
            pid, existing_masked = row["id"], row["masked_id"]
            if not masked_id:
                print("匯入中止：檔案缺少遮罩身分證（b1.1），無法確認歸戶。",
                      file=sys.stderr)
                return 3
            if existing_masked:
                if existing_masked != masked_id:
                    print(f"匯入中止：檔案遮罩身分證 {masked_id} 與資料庫既有 profile"
                          f"（{existing_masked}）不符。資料庫未寫入任何資料。", file=sys.stderr)
                    return 3
            else:
                store.con.execute("UPDATE profiles SET masked_id=? WHERE id=?",
                                  (masked_id, pid))
                print(f"已將遮罩身分證 {masked_id} 綁定至既有 profile。")
        else:
            if not assume_profile and not self._confirm_new_profile(masked_id):
                print("匯入中止：使用者未確認建立 profile。", file=sys.stderr)
                return 3
            store.con.execute("INSERT INTO profiles(display_name, masked_id) VALUES(?,?)",
                              ("本人", masked_id))
            pid = store.con.execute("SELECT id FROM profiles ORDER BY id LIMIT 1").fetchone()[0]

        doc_id, imported_at = store.register_source(
            pid, path.name, sha256, "nhi_json", ADAPTER_VERSION)
        if imported_at:
            print(f"此檔案已於 {imported_at} 匯入過（SHA-256 相同），跳過。")
            return 0

        sections = {}
        unknown_fields = {}
        parse_errors = []

        def guard(sec, i, fn):
            """單筆解析失敗：記錄後續行，NEVER 讓整批中止或靜默丟棄。"""
            try:
                fn()
                return True
            except Exception as e:  # noqa: BLE001 — 逐筆防線，錯誤全記入品質報告
                parse_errors.append(f"{sec}[{i}] {type(e).__name__}: {e}")
                return False

        def note_unknown(sec, rec):
            known = KNOWN_FIELDS.get(sec, {})
            extra = {k: v for k, v in rec.items()
                     if k not in known and not k.endswith("_1") and v not in (None, "")}
            for k in extra:
                unknown_fields.setdefault(sec, {})
                unknown_fields[sec][k] = unknown_fields[sec].get(k, 0) + 1
            return extra

        # --- 就醫事件（r1/r3/r9）與巢狀醫囑 ---
        med_expected = 0
        for sec, (etype, dkey, fname_k, fcode_k, dxc_k, dxn_k, copay_k, pts_k, seq_k, fmap) in \
                ENCOUNTER_SECTIONS.items():
            rows = bdata.get(sec, [])
            if is_no_data(rows, sec):
                sections[sec] = {"status": "no_data", "records": 0}
                continue
            n_out = 0
            for i, rec in enumerate(rows):
              def _one(rec=rec, i=i, sec=sec, etype=etype, dkey=dkey, fname_k=fname_k,
                       fcode_k=fcode_k, dxc_k=dxc_k, dxn_k=dxn_k, copay_k=copay_k,
                       pts_k=pts_k, seq_k=seq_k):
                nonlocal n_out, med_expected
                extra = note_unknown(sec, rec)
                d = norm_date(rec.get(dkey))
                rec_type = etype
                flags = []
                if d is None and sec == "r1" and norm_date(rec.get("r1.6")):
                    d = norm_date(rec.get("r1.6"))
                    rec_type = "pharmacy_dispensing"
                if d is None:
                    flags.append("missing_date")
                result = store.insert_fp_record(
                    "encounters", rec, profile_id=pid, doc_id=doc_id, section=sec,
                    source_index=i, quality_flags=",".join(flags),
                    columns={"type": rec_type, "date": d,
                             "visit_seq": rec.get(seq_k),
                             "facility_name": rec.get(fname_k),
                             "facility_code": rec.get(fcode_k),
                             "dx_code": rec.get(dxc_k), "dx_name": rec.get(dxn_k),
                             "copay": to_num(rec.get(copay_k)),
                             "nhi_points": to_num(rec.get(pts_k)),
                             "extra_json": json.dumps(extra, ensure_ascii=False) if extra else None})
                sub_key = f"{sec}_1"
                meds = rec.get(sub_key) or []
                med_expected += len(meds)
                if result == "inserted":
                    n_out += 1
                    enc_id = store._last_insert_id
                    for j, med in enumerate(meds):
                        days_key = f"{sub_key}.6" if sec == "r3" else f"{sub_key}.4"
                        store.insert_medication(
                            profile_id=pid, doc_id=doc_id, encounter_id=enc_id,
                            section=f"{sec}>{sub_key}", source_index=j,
                            order_code=med.get(f"{sub_key}.1"),
                            order_name=med.get(f"{sub_key}.2"),
                            total_qty=to_num(med.get(f"{sub_key}.3")),
                            days_supply=to_num(med.get(days_key)),
                            tooth_code=med.get(f"{sub_key}.4") if sec == "r3" else None,
                            tooth_name=med.get(f"{sub_key}.5") if sec == "r3" else None)
              guard(sec, i, _one)
            sections[sec] = {"status": "parsed", "records": len(rows), "inserted": n_out}

        # --- r7 檢驗 ---
        rows = bdata.get("r7", [])
        if is_no_data(rows, "r7"):
            sections["r7"] = {"status": "no_data", "records": 0}
        else:
            for i, rec in enumerate(rows):
              def _one(rec=rec, i=i):
                note_unknown("r7", rec)
                vt = rec.get("r7.11")
                vnum = to_num(vt)
                flags = []
                if vt in (None, ""):
                    flags.append("missing_value")
                elif vnum is None:
                    flags.append("non_numeric_value")
                if rec.get("r7.12") in (None, ""):
                    flags.append("missing_ref_range")
                store.insert_fp_record(
                    "lab_results", rec, profile_id=pid, doc_id=doc_id, section="r7",
                    source_index=i, quality_flags=",".join(flags),
                    columns={"visit_date": norm_date(rec.get("r7.5")),
                             "test_date": norm_date(rec.get("r7.6")),
                             "facility_name": rec.get("r7.4"),
                             "order_code": rec.get("r7.8"), "order_name": rec.get("r7.9"),
                             "test_name_raw": rec.get("r7.10"),
                             "value_text": vt, "value_numeric": vnum,
                             "ref_range": rec.get("r7.12")})
              guard("r7", i, _one)
            sections["r7"] = {"status": "parsed", "records": len(rows)}

        # --- r8 影像病理 ---
        rows = bdata.get("r8", [])
        if is_no_data(rows, "r8"):
            sections["r8"] = {"status": "no_data", "records": 0}
        else:
            for i, rec in enumerate(rows):
              def _one(rec=rec, i=i):
                note_unknown("r8", rec)
                store.insert_fp_record(
                    "reports", rec, profile_id=pid, doc_id=doc_id, section="r8",
                    source_index=i,
                    columns={"visit_date": norm_date(rec.get("r8.5")),
                             "test_date": norm_date(rec.get("r8.6")),
                             "facility_name": rec.get("r8.4"),
                             "order_code": rec.get("r8.8"), "order_name": rec.get("r8.9"),
                             "report_text": rec.get("r8.10")})
              guard("r8", i, _one)
            sections["r8"] = {"status": "parsed", "records": len(rows)}

        # --- r6 疫苗 ---
        rows = bdata.get("r6", [])
        if is_no_data(rows, "r6"):
            sections["r6"] = {"status": "no_data", "records": 0}
        else:
            for i, rec in enumerate(rows):
              def _one(rec=rec, i=i):
                note_unknown("r6", rec)
                store.insert_fp_record(
                    "immunizations", rec, profile_id=pid, doc_id=doc_id, section="r6",
                    source_index=i,
                    columns={"date": norm_date(rec.get("r6.1")),
                             "vaccine_name": rec.get("r6.3"),
                             "facility_name": rec.get("r6.5")})
              guard("r6", i, _one)
            sections["r6"] = {"status": "parsed", "records": len(rows)}

        # --- r10 成健 ---
        rows = bdata.get("r10", [])
        if is_no_data(rows, "r10"):
            sections["r10"] = {"status": "no_data", "records": 0}
        else:
            for i, rec in enumerate(rows):
              def _one(rec=rec, i=i):
                extra = {fm.R10.get(k, k): v for k, v in rec.items() if v not in (None, "")}
                store.insert_fp_record(
                    "body_measurements", rec, profile_id=pid, doc_id=doc_id,
                    section="r10", source_index=i,
                    columns={"check_date": norm_date(rec.get("r10.5")),
                             "height_cm": to_num(rec.get("r10.6")),
                             "weight_kg": to_num(rec.get("r10.7")),
                             "bmi": to_num(rec.get("r10.8")),
                             "waist": to_num(rec.get("r10.9")),
                             "systolic": to_num(rec.get("r10.10")),
                             "diastolic": to_num(rec.get("r10.11")),
                             "extra_json": json.dumps(extra, ensure_ascii=False)})
              guard("r10", i, _one)
            sections["r10"] = {"status": "parsed", "records": len(rows)}

        # --- r11 癌篩 ---
        rows = bdata.get("r11", [])
        if is_no_data(rows, "r11"):
            sections["r11"] = {"status": "no_data", "records": 0}
        else:
            for i, rec in enumerate(rows):
              def _one(rec=rec, i=i):
                note_unknown("r11", rec)
                store.insert_fp_record(
                    "cancer_screenings", rec, profile_id=pid, doc_id=doc_id,
                    section="r11", source_index=i,
                    columns={"category": rec.get("r11.1"), "item_name": rec.get("r11.2"),
                             "detail_json": json.dumps(rec.get("r11_1", []), ensure_ascii=False)})
              guard("r11", i, _one)
            sections["r11"] = {"status": "parsed", "records": len(rows)}

        # --- 其餘節區與未知節區 ---
        for sec in ["r2", "r4", "r5", "r12", "r13", "r14"]:
            rows = bdata.get(sec, [])
            if is_no_data(rows, sec):
                sections[sec] = {"status": "no_data", "records": 0}
            elif rows:
                sections[sec] = {"status": "UNPARSED_HAS_DATA", "records": len(rows)}
        known_secs = set(ENCOUNTER_SECTIONS) | {"r0", "r2", "r4", "r5", "r6", "r7", "r8",
                                                "r10", "r11", "r12", "r13", "r14",
                                                "b1.1", "b1.2"}
        for sec in bdata:
            if sec not in known_secs:
                sections[sec] = {"status": "UNKNOWN_SECTION", "records": len(bdata[sec])}

        # 醫囑對帳（重複匯入時 inserted 為 0 屬正常，僅首次驗證）
        # 檢驗名稱正規化（D5）：依 labs.yaml 別名表重算全部 lab_results
        from src.knowledge.labs import apply_normalization
        apply_normalization(store)

        med_inserted = store.stats["inserted"].get("medications", 0)
        reconciliation = {"expected_in_file": med_expected, "inserted_new": med_inserted,
                          "note": "重複匯入時 inserted_new < expected_in_file 為正常（紀錄已存在）"}

        store.finalize_import(doc_id)
        report = build_incremental(
            store, sections=sections,
            source_info={"filename": path.name, "sha256": sha256,
                         "adapter": "nhi_json", "adapter_version": ADAPTER_VERSION,
                         "unknown_fields": unknown_fields,
                         "parse_errors": parse_errors,
                         "medication_reconciliation": reconciliation})
        print(render_text(report))
        return 0

    @staticmethod
    def _confirm_new_profile(masked_id):
        ans = input(f"首次匯入：以遮罩身分證 {masked_id} 建立本人 profile？[y/N] ")
        return ans.strip().lower() == "y"
