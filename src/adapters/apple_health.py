"""Apple Health 匯出 adapter（apple-health-import capability）。

- 串流解析（iterparse），以內容判型不看檔名；支援資料夾、zip、單一 XML
- 來源別單位正規化規則表（value_normalized，原值保留）
- epoch 佔位日期與離群值品質旗標（被標記者不進趨勢統計）
- 檔內重複去除（UNIQUE 自然鍵 + INSERT OR IGNORE）
"""
import hashlib
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from src.quality.quality_report import build_incremental, render_text
from src.store.db import Store

from . import register

ADAPTER_VERSION = "1.0.0"


def _fix_zip_name(name):
    """zip 未標 UTF-8 旗標時，zipfile 以 cp437 解碼中文檔名會亂碼；嘗試還原。"""
    try:
        return name.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


class _ZipMember:
    """zip 成員串流的 context manager：關閉時連同 ZipFile 一併關閉。"""

    def __init__(self, zip_path, member):
        self._zf = zipfile.ZipFile(zip_path)
        self._stream = self._zf.open(member)

    def __enter__(self):
        return self._stream

    def __exit__(self, *exc):
        self._stream.close()
        self._zf.close()
        return False

    def read(self, n=-1):
        return self._stream.read(n)

    def close(self):
        self._stream.close()
        self._zf.close()

WANTED = {
    "HKQuantityTypeIdentifierBodyMass": "體重",
    "HKQuantityTypeIdentifierBodyMassIndex": "BMI",
    "HKQuantityTypeIdentifierHeight": "身高",
    "HKQuantityTypeIdentifierBodyFatPercentage": "體脂率",
    "HKQuantityTypeIdentifierLeanBodyMass": "除脂體重",
    "HKQuantityTypeIdentifierBloodPressureSystolic": "收縮壓",
    "HKQuantityTypeIdentifierBloodPressureDiastolic": "舒張壓",
    "HKQuantityTypeIdentifierHeartRate": "心率",
    "HKQuantityTypeIdentifierRestingHeartRate": "安靜心率",
    "HKQuantityTypeIdentifierOxygenSaturation": "血氧",
    "HKQuantityTypeIdentifierRespiratoryRate": "呼吸速率",
    "HKCategoryTypeIdentifierSleepAnalysis": "睡眠",
    "HKQuantityTypeIdentifierStepCount": "步數",
    "HKQuantityTypeIdentifierDistanceWalkingRunning": "步行跑步距離",
    "HKQuantityTypeIdentifierDistanceCycling": "騎車距離",
    "HKQuantityTypeIdentifierFlightsClimbed": "爬樓層數",
    "HKQuantityTypeIdentifierActiveEnergyBurned": "活動能量",
    "HKQuantityTypeIdentifierBasalEnergyBurned": "基礎能量",
    "HKQuantityTypeIdentifierWalkingSpeed": "步行速度",
    "HKQuantityTypeIdentifierWalkingStepLength": "步幅",
    "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage": "雙腳支撐比例",
    "HKQuantityTypeIdentifierWalkingAsymmetryPercentage": "步態不對稱比例",
    "HKQuantityTypeIdentifierAppleWalkingSteadiness": "行走穩定度",
    "HKQuantityTypeIdentifierHeadphoneAudioExposure": "耳機音量暴露",
    "HKQuantityTypeIdentifierDietaryWater": "飲水量",
    "HKQuantityTypeIdentifierDietaryEnergyConsumed": "攝取熱量",
    "HKQuantityTypeIdentifierDietaryFatTotal": "攝取脂肪",
    "HKQuantityTypeIdentifierDietaryCarbohydrates": "攝取碳水",
    "HKQuantityTypeIdentifierDietaryProtein": "攝取蛋白質",
}

# 來源別正規化規則：{(type_zh)} → callable(value, unit, source) -> normalized 或 None
def _bodyfat_rule(v, unit, source):
    # 部分來源（實測：好轻）以 0-1 小數儲存體脂率卻標 %
    if v is not None and 0 < v <= 1:
        return round(v * 100, 2)
    return None

UNIT_RULES = {"體脂率": _bodyfat_rule}

# 合理範圍表（作用於 normalized 或原值）；超出者標 out_of_range 不進趨勢
RANGE_TABLE = {
    "體重": (30, 200), "身高": (100, 250), "BMI": (10, 60), "體脂率": (3, 60),
    "收縮壓": (60, 250), "舒張壓": (30, 150), "心率": (25, 250),
}
EPOCH_CUTOFF = "2000-01-01"


@register
class AppleHealthAdapter:
    FORMAT_DESC = "Apple Health 匯出（zip、apple_health_export 資料夾或匯出 XML）"

    @staticmethod
    def _xml_source(path):
        """回傳 (open_fn, 名稱) 或 None。以內容判型：根元素為 HealthData。"""
        def check(opener):
            # 真實匯出檔開頭有數 KB 的 DTD 宣告，根元素可能在 4KB 之外
            try:
                with opener() as f:
                    head = f.read(65536)
                return b"<HealthData" in head or b"<!DOCTYPE HealthData" in head
            except (OSError, zipfile.BadZipFile):
                return False

        if path.is_file() and path.suffix.lower() == ".xml":
            opener = lambda: open(path, "rb")
            if check(opener):
                return opener, path.name
        if path.is_file() and path.suffix.lower() == ".zip":
            try:
                with zipfile.ZipFile(path) as zf:
                    names = [n for n in zf.namelist()
                             if n.lower().endswith(".xml") and "cda" not in n.lower()]
            except zipfile.BadZipFile:
                return None
            for name in names:
                opener = lambda n=name: _ZipMember(path, n)
                if check(opener):
                    return opener, f"{path.name}:{_fix_zip_name(name)}"
        if path.is_dir():
            for child in sorted(path.glob("*.xml")):
                if "cda" in child.name.lower():
                    continue
                opener = lambda c=child: open(c, "rb")
                if check(opener):
                    return opener, child.name
        return None

    @classmethod
    def detect(cls, path):
        return cls._xml_source(path) is not None

    def import_file(self, path, *, db_path, assume_profile=False):
        src = self._xml_source(path)
        if src is None:
            print(f"非 Apple Health 匯出：{path}", file=sys.stderr)
            return 2
        opener, display_name = src

        # 檔案指紋：串流計算避免大檔佔記憶體
        h = hashlib.sha256()
        with opener() as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        sha256 = h.hexdigest()

        store = Store(db_path)
        try:
            pid, _ = store.get_or_create_profile("本人")
            doc_id, imported_at = store.register_source(
                pid, display_name, sha256, "apple_health", ADAPTER_VERSION)
            if imported_at:
                print(f"此檔案已於 {imported_at} 匯入過（SHA-256 相同），跳過。")
                return 0
            stats = self._parse(store, opener, pid, doc_id)
            # 每日彙總（apple-health-import spec）：與 JS 端同一份 SQL
            from src.store.schema import IMPORT_AGGREGATE_STATEMENTS
            for stmt in IMPORT_AGGREGATE_STATEMENTS:
                store.con.execute(stmt["sql"], [doc_id] * stmt["params"])
            store.finalize_import(doc_id)
            store.commit()
            report = build_incremental(
                store, sections={"apple_records": {"status": "parsed", **stats}},
                source_info={"filename": display_name, "sha256": sha256,
                             "adapter": "apple_health",
                             "adapter_version": ADAPTER_VERSION})
            print(render_text(report))
            return 0
        finally:
            store.close()

    def _parse(self, store, opener, pid, doc_id):
        scanned = workouts = errors = 0
        with opener() as f:
            for ev, el in ET.iterparse(f, events=("end",)):
                if el.tag == "Record":
                    t = el.get("type")
                    if t in WANTED:
                        scanned += 1
                        try:
                            self._insert_record(store, pid, doc_id, t, el)
                        except Exception:  # noqa: BLE001 — 逐筆防線
                            errors += 1
                elif el.tag == "Workout":
                    workouts += 1
                    store.insert_apple_workout(
                        profile_id=pid, doc_id=doc_id,
                        activity=(el.get("workoutActivityType") or "").replace(
                            "HKWorkoutActivityType", ""),
                        start_ts=(el.get("startDate") or "")[:19],
                        end_ts=(el.get("endDate") or "")[:19],
                        duration_min=_to_float(el.get("duration")),
                        source_name=el.get("sourceName"))
                el.clear()
        return {"records": scanned, "workouts": workouts, "parse_errors": errors}

    def _insert_record(self, store, pid, doc_id, t, el):
        type_zh = WANTED[t]
        start = (el.get("startDate") or "")[:19]
        end = (el.get("endDate") or "")[:19]
        vnum = _to_float(el.get("value"))
        vtext = None if vnum is not None else el.get("value")
        unit = el.get("unit")
        source = el.get("sourceName")

        flags = []
        vnorm = None
        rule = UNIT_RULES.get(type_zh)
        if rule and vnum is not None:
            vnorm = rule(vnum, unit, source)
            if vnorm is not None:
                flags.append("unit_normalized")
        effective = vnorm if vnorm is not None else vnum
        if start < EPOCH_CUTOFF:
            flags.append("epoch_placeholder_date")
        rng = RANGE_TABLE.get(type_zh)
        if rng and effective is not None and not (rng[0] <= effective <= rng[1]):
            flags.append("out_of_range")

        store.insert_apple_record(
            profile_id=pid, doc_id=doc_id, type=t, type_zh=type_zh,
            start_ts=start, end_ts=end, value_numeric=vnum,
            value_normalized=vnorm, value_text=vtext, unit=unit,
            source_name=source, quality_flags=",".join(flags))


def _to_float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None
