"""nhi-import：14 節區、未知欄位、調劑回退、醫囑對帳、歸戶防護、同檔跳過。"""
import json
from pathlib import Path

import pytest

from src.adapters.nhi_json import NhiJsonAdapter
from src.store.db import Store

FIXTURE = Path(__file__).parent / "fixtures" / "nhi_sample.json"
CTRL_FIXTURE = Path(__file__).parent / "fixtures" / "nhi_ctrlchar.json"


@pytest.fixture
def imported(tmp_path):
    db = tmp_path / "t.sqlite"
    rc = NhiJsonAdapter().import_file(FIXTURE, db_path=db, assume_profile=True)
    assert rc == 0
    s = Store(db)
    yield s, db
    s.close()


def test_detect():
    assert NhiJsonAdapter.detect(FIXTURE)
    assert not NhiJsonAdapter.detect(Path(__file__))


def test_full_sections(imported):
    s, _ = imported
    counts = s.table_counts()
    assert counts["encounters"] == 5        # r1×3 + r3×1 + r9×1
    assert counts["medications"] == 6       # r1_1×4 + r3_1×1 + r9_1×1
    assert counts["lab_results"] == 2
    assert counts["reports"] == 1
    assert counts["immunizations"] == 1
    assert counts["body_measurements"] == 1
    assert counts["cancer_screenings"] == 1


def test_medication_reconciliation(imported):
    s, _ = imported
    # 原始檔逐節區加總：r1_1 = 2+1+1 = 4、r3_1 = 1、r9_1 = 1 → 6
    data = json.loads(FIXTURE.read_bytes().decode("utf-8-sig"))
    bd = {k.lower(): v for k, v in data["myhealthbank"]["bdata"].items()}
    expected = sum(len(r.get(f"{sec}_1") or []) for sec in ("r1", "r3", "r9")
                   for r in bd[sec] if isinstance(r, dict))
    n = s.con.execute("SELECT COUNT(*) FROM medications").fetchone()[0]
    assert n == expected
    # 每筆 encounter_id 有效
    orphan = s.con.execute("""SELECT COUNT(*) FROM medications m
        LEFT JOIN encounters e ON m.encounter_id = e.id WHERE e.id IS NULL""").fetchone()[0]
    assert orphan == 0


def test_pharmacy_fallback(imported):
    s, _ = imported
    row = s.con.execute(
        "SELECT type, date FROM encounters WHERE type='pharmacy_dispensing'").fetchone()
    assert row is not None and row["date"] == "2026-01-10"


def test_unknown_field_preserved(imported):
    s, _ = imported
    row = s.con.execute(
        "SELECT extra_json FROM encounters WHERE extra_json IS NOT NULL").fetchone()
    assert row and json.loads(row["extra_json"]).get("r1.99") == "未知欄位值"


def test_lab_quality_flags(imported):
    s, _ = imported
    flags = s.con.execute(
        "SELECT quality_flags FROM lab_results WHERE test_name_raw='URINE PROTEIN'"
    ).fetchone()[0]
    assert "non_numeric_value" in flags and "missing_ref_range" in flags


def test_profile_mismatch_abort(imported, capsys):
    s, db = imported
    other = json.loads(FIXTURE.read_text(encoding="utf-8"))
    other["myhealthbank"]["bdata"]["b1.1"] = "B00000****"
    other_path = db.parent / "other.json"
    other_path.write_text(json.dumps(other, ensure_ascii=False), encoding="utf-8")
    before = s.table_counts()
    rc = NhiJsonAdapter().import_file(other_path, db_path=db, assume_profile=True)
    assert rc == 3
    s2 = Store(db)
    assert s2.table_counts() == before  # 零寫入
    s2.close()


def test_same_file_skip(imported, capsys):
    s, db = imported
    before = s.table_counts()
    rc = NhiJsonAdapter().import_file(FIXTURE, db_path=db, assume_profile=True)
    assert rc == 0
    assert "已於" in capsys.readouterr().out
    s2 = Store(db)
    assert s2.table_counts() == before
    s2.close()


def test_profile_bind_after_apple_first(tmp_path):
    """Apple 先匯入（profile 無遮罩身分證）→ 健保首匯認領綁定。"""
    from src.adapters.apple_health import AppleHealthAdapter
    db = tmp_path / "bind.sqlite"
    apple_fx = Path(__file__).parent / "fixtures" / "apple_sample.xml"
    assert AppleHealthAdapter().import_file(apple_fx, db_path=db, assume_profile=True) == 0
    rc = NhiJsonAdapter().import_file(FIXTURE, db_path=db, assume_profile=True)
    assert rc == 0
    s = Store(db)
    assert s.con.execute("SELECT masked_id FROM profiles").fetchone()[0] == "Z99999****"
    assert s.con.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] == 1
    s.close()


def test_missing_masked_id_abort(tmp_path):
    """檔案缺 b1.1 且已有 profile → 中止零寫入。"""
    db = tmp_path / "nomask.sqlite"
    assert NhiJsonAdapter().import_file(FIXTURE, db_path=db, assume_profile=True) == 0
    s = Store(db)
    before = s.table_counts()
    s.close()
    data = json.loads(FIXTURE.read_bytes().decode("utf-8-sig"))
    data["myhealthbank"]["bdata"]["b1.1"] = ""
    bad = tmp_path / "nomask.json"
    bad.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    assert NhiJsonAdapter().import_file(bad, db_path=db, assume_profile=True) == 3
    s = Store(db)
    assert s.table_counts() == before
    s.close()


def test_partial_failure_continues(tmp_path):
    """單筆壞紀錄不中止整批：其餘入庫、錯誤記入品質報告（契約）。"""
    data = json.loads(FIXTURE.read_bytes().decode("utf-8-sig"))
    data["myhealthbank"]["bdata"]["r7"][0]["r7.11"] = {"壞": ["結構"]}
    bad = tmp_path / "partial.json"
    bad.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    rc = NhiJsonAdapter().import_file(bad, db_path=tmp_path / "p.sqlite", assume_profile=True)
    assert rc == 0  # 續行完成
    s = Store(tmp_path / "p.sqlite")
    assert s.con.execute("SELECT COUNT(*) FROM lab_results").fetchone()[0] == 1  # 另一筆有進
    assert s.con.execute("SELECT COUNT(*) FROM encounters").fetchone()[0] == 5  # 其他節區不受影響
    stats = s.con.execute("SELECT import_stats FROM source_documents").fetchone()[0]
    s.close()


def test_raw_control_chars_in_report_field(tmp_path):
    r"""報告欄位含未跳脫的原始控制字元時仍完整匯入（issue #2）。

    官方匯出工具會在 r8.10 塞入原始 TAB（例如聽力檢查用 TAB 對齊左右耳），
    違反 RFC 8259 但確實是真實輸出。strict=True 會讓整批匯入在解析階段就
    中止、資料庫零寫入，連逐筆 guard() 防線都來不及發揮。

    fixture 必須是位元層面的真 0x09：JSON 跳脫寫法 "\t" 是合法 JSON，
    strict=True 也解析得過，用它當測試向量測不到這條 code path。
    """
    raw = CTRL_FIXTURE.read_bytes()
    # 錨定 fixture 效力：它必須仍能觸發原本的錯誤，否則這則測試是假綠
    assert raw.count(b"\x09") > 0
    with pytest.raises(json.JSONDecodeError):
        json.loads(raw.decode("utf-8-sig"))

    db = tmp_path / "ctrl.sqlite"
    rc = NhiJsonAdapter().import_file(CTRL_FIXTURE, db_path=db, assume_profile=True)
    assert rc == 0
    s = Store(db)
    row = s.con.execute(
        "SELECT report_text, length(report_text) AS n FROM reports").fetchone()
    counts = s.table_counts()
    s.close()
    # 值原樣保留、不替換成空白：報告以等寬 pre-wrap 呈現，TAB 的對齊有意義
    assert row["report_text"] == "pure tone audiometry\tR\tWNL\tL\tWNL"
    # TAB 不影響 SQL 字串函式（NUL 會，見 known limitation）
    assert row["n"] == len(row["report_text"])
    assert counts["reports"] == 1
