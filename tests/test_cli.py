"""CLI：--help 四子命令、status、quality、判型錯誤、knowledge normalize。"""
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest


def run_cli(*argv):
    return subprocess.run([sys.executable, "-m", "src.hwb_cli", *argv],
                          capture_output=True, text=True)


def test_help():
    r = run_cli("--help")
    assert r.returncode == 0
    for cmd in ["import", "rebuild", "status", "quality"]:
        assert cmd in r.stdout
    assert "健康資料" in r.stdout  # 繁中說明


def test_status_empty_db(tmp_path):
    r = run_cli("--db", str(tmp_path / "s.sqlite"), "status")
    assert r.returncode == 0
    from src.store.schema import SCHEMA_VERSION
    assert f"schema 版本：{SCHEMA_VERSION}" in r.stdout
    assert "encounters: 0" in r.stdout


def test_quality_empty_db(tmp_path):
    r = run_cli("--db", str(tmp_path / "s.sqlite"), "quality")
    assert r.returncode == 0
    assert "品質報告" in r.stdout


def test_unknown_format_error(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("hello")
    r = run_cli("--db", str(tmp_path / "s.sqlite"), "import", str(f))
    assert r.returncode != 0
    assert "支援" in (r.stderr + r.stdout)  # 明確列出支援格式


def test_corrupt_db_friendly_error(tmp_path):
    bad = tmp_path / "bad.sqlite"
    bad.write_text("not a database")
    r = run_cli("--db", str(bad), "status")
    assert r.returncode == 4
    assert "重建" in r.stderr and "Traceback" not in r.stderr


def test_zip_import(tmp_path):
    import shutil, zipfile
    from pathlib import Path as P
    src = P(__file__).parent / "fixtures" / "apple_sample.xml"
    exp = tmp_path / "apple_health_export"
    exp.mkdir(); shutil.copy(src, exp / "輸出.xml")
    zpath = tmp_path / "export.zip"
    with zipfile.ZipFile(zpath, "w") as z:
        z.write(exp / "輸出.xml", "apple_health_export/輸出.xml")
    r = run_cli("--db", str(tmp_path / "z.sqlite"), "import", str(zpath),
                "--no-rebuild", "--yes")
    assert r.returncode == 0
    assert "輸出.xml" in r.stdout  # 中文檔名無 mojibake


def test_knowledge_normalize(tmp_path):
    """hwb knowledge normalize：印出四個計數、exit 0，第二次 updated=0。"""
    db = tmp_path / "n.sqlite"
    fixture = Path(__file__).parent / "fixtures" / "nhi_labnorm.json"
    imp = run_cli("--db", str(db), "import", str(fixture), "--no-rebuild", "--yes")
    assert imp.returncode == 0, imp.stderr

    first = run_cli("--db", str(db), "knowledge", "normalize")
    assert first.returncode == 0, first.stderr
    line = first.stdout.strip().splitlines()[-1]
    assert re.match(r"^mapped=\d+ unmapped=\d+ mapped_by_code=\d+ updated=\d+$", line), line
    # 匯入尾端已重算過，故此處本來就該零變動；形狀與數值一併釘住
    assert line == "mapped=7 unmapped=2 mapped_by_code=2 updated=0"

    second = run_cli("--db", str(db), "knowledge", "normalize")
    assert second.returncode == 0
    assert second.stdout.strip().splitlines()[-1].endswith("updated=0")


def test_knowledge_normalize_recovers_stale_rows(tmp_path):
    """舊庫殘留的 unmapped 列：normalize 一次補上正規名，再跑就零變動。"""
    db = tmp_path / "stale.sqlite"
    fixture = Path(__file__).parent / "fixtures" / "nhi_labnorm.json"
    assert run_cli("--db", str(db), "import", str(fixture),
                   "--no-rebuild", "--yes").returncode == 0
    # 模擬 0.9.0 舊程式留下的狀態：正規名全清、全部標 unmapped
    con = sqlite3.connect(db)
    con.execute("UPDATE lab_results SET test_name_normalized=NULL, quality_flags='unmapped'")
    con.commit()
    con.close()

    r = run_cli("--db", str(db), "knowledge", "normalize")
    assert r.returncode == 0, r.stderr
    # updated=7 而非 9：兩筆本來就對不到的列，清洗後的狀態（NULL＋unmapped）
    # 恰好等於重算目標，只寫變動列的規則讓它們不被 UPDATE
    assert r.stdout.strip().splitlines()[-1] == \
        "mapped=7 unmapped=2 mapped_by_code=2 updated=7"
    again = run_cli("--db", str(db), "knowledge", "normalize")
    assert again.stdout.strip().splitlines()[-1].endswith("updated=0")
