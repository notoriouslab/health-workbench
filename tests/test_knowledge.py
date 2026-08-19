"""knowledge-annotations：條目結構、別名映射、eGFR 不合併、禁用詞、藥品 join、過時提醒。"""
import sqlite3
from datetime import date
from pathlib import Path

import pytest

from src.adapters.nhi_json import NhiJsonAdapter
from src.knowledge.drugs import DrugLookup, update_cache
from src.knowledge.labs import (KnowledgeError, alias_map, apply_normalization,
                                load_entries, stale_entries)
from src.store.db import Store

FIXTURE = Path(__file__).parent / "fixtures" / "nhi_sample.json"


def test_entry_schema():
    entries = load_entries()
    assert len(entries) >= 30
    for e in entries:
        assert e["source_url"].startswith("https://")
        assert str(e["cited_date"])


def test_entry_schema_missing_field(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("- normalized_name: X\n  aliases: []\n  description: 說明\n"
                   "  source_name: 來源\n  cited_date: '2026-01-01'\n", encoding="utf-8")
    with pytest.raises(KnowledgeError, match="缺欄位"):
        load_entries(bad)


def test_alias_mapping():
    m = alias_map(load_entries())
    assert m["Hb"] == m["HB"] == "Hemoglobin"
    assert m["Lym"] == m["Lym."] == "Lymphocyte"
    assert m["BUN"] == m["UN"] == "Blood Urea Nitrogen"


def test_egfr_not_merged():
    m = alias_map(load_entries())
    targets = {m.get("eGFR (CKD-EPI)"), m.get("eGFR (MDRD)"), m.get("eGFR Male")}
    assert len(targets) == 3  # 三個公式/變體各自獨立


def test_normalized_write(tmp_path):
    db = tmp_path / "k.sqlite"
    NhiJsonAdapter().import_file(FIXTURE, db_path=db, assume_profile=True)
    s = Store(db)
    # fixture 的 HGB 不在別名表 → unmapped；驗證欄位與旗標行為
    rows = s.con.execute(
        "SELECT test_name_raw, test_name_normalized, quality_flags FROM lab_results").fetchall()
    for r in rows:
        if r["test_name_normalized"] is None:
            assert "unmapped" in r["quality_flags"]
    # 冪等：重跑不重複累加 unmapped
    apply_normalization(s)
    flags = s.con.execute(
        "SELECT quality_flags FROM lab_results WHERE test_name_normalized IS NULL").fetchone()[0]
    assert flags.split(",").count("unmapped") == 1
    s.close()


def test_forbidden_words_fail(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text(
        "- normalized_name: X\n  aliases: []\n"
        "  description: 數值過高代表你可能罹患糖尿病\n"
        "  source_name: 來源\n  source_url: https://example.com\n"
        "  cited_date: '2026-01-01'\n", encoding="utf-8")
    with pytest.raises(KnowledgeError, match="禁用詞"):
        load_entries(bad)


def test_stale_reminder():
    entries = [{"normalized_name": "Old", "cited_date": "2024-01-01"},
               {"normalized_name": "New", "cited_date": "2026-08-01"}]
    stale = stale_entries(entries, today=date(2026, 8, 8))
    assert [s["normalized_name"] for s in stale] == ["Old"]


def test_drug_join(tmp_path):
    """以縮小版 CSV 建快取，驗證醫囑代碼 join 與版本標示。"""
    csv_path = tmp_path / "mini.csv"
    csv_path.write_text(
        "異動,藥品代號,藥品英文名稱,藥品中文名稱,成分,規格量,規格單位,單複方,支付價,"
        "有效起日,有效迄日,藥商,製造廠名稱,劑型,藥品分類,分類分組名稱,ATC代碼,"
        "給付規定章節,藥品代碼超連結,給付規定章節連結\n"
        ",XX00000001,Test Drug A,測試藥品Ａ錠,TESTOSTATIN 10 MG,,,單方,1.00,"
        "1120101,1130101,測試藥商,測試廠,錠劑,學名藥,分組,A00AA00,,https://example.com/a,\n"
        ",XX00000001,Test Drug A v2,測試藥品Ａ錠v2,TESTOSTATIN 10 MG,,,單方,1.00,"
        "1130102,9991231,測試藥商,測試廠,錠劑,學名藥,分組,A00AA00,,https://example.com/a2,\n",
        encoding="utf-8")
    db = tmp_path / "d.sqlite"
    stats = update_cache(db, source=csv_path)
    assert stats["distinct_codes"] == 1
    lk = DrugLookup(db)
    hit = lk.lookup("XX00000001")   # 同代號兩列 → 取有效迄日最大
    assert hit["name_zh"] == "測試藥品Ａ錠v2"
    assert hit["leaflet_url"] == "https://example.com/a2"
    assert lk.meta()["updated_at"] == date.today().isoformat()
    assert lk.lookup("ZZ99999999") is None
    lk.close()


def test_drug_lookup_offline_no_cache(tmp_path):
    """無快取時離線不外連、全部回 None。"""
    lk = DrugLookup(tmp_path / "none.sqlite")
    assert lk.lookup("XX00000001") is None and lk.meta() is None
    lk.close()


# ---- 身體數值參考標準（display-revamp-bands-cleanup T5）----

def test_body_refs_load_ok():
    from src.knowledge.body_refs import load_body_refs
    entries = load_body_refs()
    # 第一版範圍寫死：血壓兩條線＋BMI 一條帶（範圍回潮在這裡轉紅）
    kinds = sorted((e["type_zh"], e["kind"]) for e in entries)
    assert kinds == [("BMI", "band"), ("收縮壓", "line"), ("舒張壓", "line")]
    for e in entries:
        assert e["source_url"].startswith("https://")
        assert e["cited_date"]


def test_body_refs_missing_field_fails(tmp_path):
    from src.knowledge.body_refs import BodyRefsError, load_body_refs
    bad = tmp_path / "refs.yaml"
    bad.write_text(
        "- normalized_name: 'X'\n  type_zh: '收縮壓'\n  kind: 'line'\n"
        "  value: 130\n  label: '參考 130'\n  source_name: '來源'\n"
        "  source_url: 'https://example.gov.tw'\n",  # 缺 cited_date
        encoding="utf-8")
    import pytest
    with pytest.raises(BodyRefsError):
        load_body_refs(bad)


def test_body_refs_band_needs_bounds(tmp_path):
    from src.knowledge.body_refs import BodyRefsError, load_body_refs
    bad = tmp_path / "refs.yaml"
    bad.write_text(
        "- normalized_name: 'X'\n  type_zh: 'BMI'\n  kind: 'band'\n"
        "  lo: 18.5\n  label: 'x'\n  source_name: '來源'\n"
        "  source_url: 'https://example.gov.tw'\n  cited_date: '2026-08-19'\n",
        encoding="utf-8")
    import pytest
    with pytest.raises(BodyRefsError):
        load_body_refs(bad)


def test_body_refs_forbidden_words(tmp_path):
    from src.knowledge.body_refs import BodyRefsError, load_body_refs
    bad = tmp_path / "refs.yaml"
    bad.write_text(
        "- normalized_name: 'X'\n  type_zh: '收縮壓'\n  kind: 'line'\n"
        "  value: 130\n  label: '數值正常'\n  source_name: '來源'\n"
        "  source_url: 'https://example.gov.tw'\n  cited_date: '2026-08-19'\n",
        encoding="utf-8")
    import pytest
    with pytest.raises(BodyRefsError):
        load_body_refs(bad)
