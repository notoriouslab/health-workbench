"""health-database：schema 初始化、來源追溯強制、品質旗標、指紋合併。"""
import pytest

from src.store.db import SourceRequired, Store
from src.store.schema import ALL_TABLES, SCHEMA_VERSION


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "test.sqlite")
    yield s
    s.close()


@pytest.fixture
def ctx(store):
    """建好 profile 與 source doc 的基本情境。"""
    pid, _ = store.get_or_create_profile("測試", "A12345****")
    doc_id, _ = store.register_source(pid, "f.json", "a" * 64, "nhi_json", "1.0")
    return store, pid, doc_id


def test_schema_init(store):
    names = {r[0] for r in store.con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    for t in ALL_TABLES:
        assert t in names, f"缺表 {t}"
    assert store.schema_version() == SCHEMA_VERSION
    # UNIQUE 約束存在：同 profile+section+fp 二次寫入回報 duplicate
    idx = store.con.execute("PRAGMA index_list(encounters)").fetchall()
    assert any(r["unique"] for r in idx)


def test_schema_version_mismatch(tmp_path):
    s = Store(tmp_path / "v.sqlite")
    s.con.execute("UPDATE schema_version SET version = 999")
    s.con.commit()
    s.close()
    with pytest.raises(RuntimeError, match="schema 版本"):
        Store(tmp_path / "v.sqlite")


def test_source_required(ctx):
    store, pid, doc_id = ctx
    with pytest.raises(SourceRequired):
        store.insert_fp_record("encounters", {"r1.5": "20260101"},
                               profile_id=pid, doc_id=None, section="r1",
                               source_index=0, columns={"type": "western_outpatient"})
    with pytest.raises(SourceRequired):
        store.insert_medication(profile_id=pid, doc_id=None, encounter_id=1,
                                section=None, source_index=0)


def test_fp_insert_and_duplicate(ctx):
    store, pid, doc_id = ctx
    rec = {"r1.5": "20260101", "r1.4": "某院所"}
    r1 = store.insert_fp_record("encounters", rec, profile_id=pid, doc_id=doc_id,
                                section="r1", source_index=0,
                                columns={"type": "western_outpatient", "date": "2026-01-01"})
    r2 = store.insert_fp_record("encounters", rec, profile_id=pid, doc_id=doc_id,
                                section="r1", source_index=0,
                                columns={"type": "western_outpatient", "date": "2026-01-01"})
    assert (r1, r2) == ("inserted", "duplicate")
    n = store.con.execute("SELECT COUNT(*) FROM encounters").fetchone()[0]
    assert n == 1
    assert store.stats["skipped_dup"]["encounters"] == 1


def test_quality_flag_rollup(ctx):
    store, pid, doc_id = ctx
    store.insert_fp_record("lab_results", {"r7.10": "X"}, profile_id=pid, doc_id=doc_id,
                           section="r7", source_index=0,
                           columns={"test_name_raw": "X"},
                           quality_flags="missing_ref_range,unmapped")
    flags = store.quality_flag_counts()
    assert flags == {"missing_ref_range": 1, "unmapped": 1}


def test_fingerprint_collision_flag(ctx, monkeypatch):
    """指紋相同但內容不同 → 標 fingerprint_collision 且不重複累加。"""
    store, pid, doc_id = ctx
    rec_a = {"r1.5": "20260101"}
    store.insert_fp_record("encounters", rec_a, profile_id=pid, doc_id=doc_id,
                           section="r1", source_index=0,
                           columns={"type": "western_outpatient"})
    # 強迫指紋碰撞：讓不同內容算出相同 fp
    import src.store.db as dbmod
    fp_of_a = dbmod.record_fp(rec_a)
    monkeypatch.setattr(dbmod, "record_fp", lambda r: fp_of_a)
    rec_b = {"r1.5": "20991231"}
    r1 = store.insert_fp_record("encounters", rec_b, profile_id=pid, doc_id=doc_id,
                                section="r1", source_index=1,
                                columns={"type": "western_outpatient"})
    r2 = store.insert_fp_record("encounters", rec_b, profile_id=pid, doc_id=doc_id,
                                section="r1", source_index=1,
                                columns={"type": "western_outpatient"})
    assert r1 == "collision" and r2 == "collision"
    flags = store.con.execute(
        "SELECT quality_flags FROM encounters").fetchone()[0]
    assert flags.split(",").count("fingerprint_collision") == 1  # 不重複累加
    assert store.stats["collisions"] == 2


def test_medication_idempotent(ctx):
    store, pid, doc_id = ctx
    store.insert_fp_record("encounters", {"r1.5": "20260101"}, profile_id=pid,
                           doc_id=doc_id, section="r1", source_index=0,
                           columns={"type": "western_outpatient"})
    enc_id = store._last_insert_id
    for _ in range(2):
        store.insert_medication(profile_id=pid, doc_id=doc_id, encounter_id=enc_id,
                                section="r1>r1_1", source_index=0,
                                order_code="XX00000000", order_name="測試藥")
    n = store.con.execute("SELECT COUNT(*) FROM medications").fetchone()[0]
    assert n == 1
    assert store.stats["skipped_dup"]["medications"] == 1


def test_illegal_table_rejected(ctx):
    store, pid, doc_id = ctx
    with pytest.raises(ValueError, match="非法表名"):
        store.insert_fp_record("profiles; DROP TABLE profiles", {"x": 1},
                               profile_id=pid, doc_id=doc_id, section="r1",
                               source_index=0, columns={})


def test_same_file_registered_once(ctx):
    store, pid, doc_id = ctx
    doc2, imported_at = store.register_source(pid, "f.json", "a" * 64, "nhi_json", "1.0")
    assert doc2 == doc_id and imported_at is not None


def test_schema_migration_v1_to_v2(tmp_path):
    """v1 資料庫開啟時自動前向遷移至現行版本。"""
    import sqlite3
    from src.store.schema import DDL, SCHEMA_VERSION
    db = tmp_path / "old.sqlite"
    con = sqlite3.connect(db)
    v1_ddl = DDL.replace(
        "import_stats TEXT,\n    imported_at", "imported_at"  # 模擬 v1 無該欄位
    ).replace(",\n    container_sha256 TEXT);", ");")  # v1 也沒有 v5 欄位
    assert "container_sha256" not in v1_ddl  # DDL 改寫時此替換式要跟著改
    con.executescript(v1_ddl)
    con.execute("INSERT INTO schema_version(version) VALUES (1)")
    con.commit(); con.close()
    s = Store(db)
    assert s.schema_version() == SCHEMA_VERSION
    cols = [r[1] for r in s.con.execute("PRAGMA table_info(source_documents)")]
    assert "import_stats" in cols
    s.close()


def test_finalize_import_stats(ctx):
    store, pid, doc_id = ctx
    store.insert_fp_record("encounters", {"r1.5": "20260101"}, profile_id=pid,
                           doc_id=doc_id, section="r1", source_index=0,
                           columns={"type": "western_outpatient"})
    store.finalize_import(doc_id)
    store.commit()
    import json
    raw = store.con.execute(
        "SELECT import_stats FROM source_documents WHERE id=?", (doc_id,)).fetchone()[0]
    assert json.loads(raw)["inserted"]["encounters"] == 1


def _downgrade_to_v3(store):
    """把庫降回 v3 現場（移除 v4 產物、v5 欄位與版本紀錄）。"""
    cur = store.con.cursor()
    for t in ["cpap_daily", "cpap_events", "cpap_oximetry"]:
        cur.execute(f"DROP TABLE {t}")
    # v3 現場沒有 v5 的 container_sha256；建表搬資料拆掉（同 JS 端
    # tests/helpers/schema_downgrade.mjs 的作法）
    cur.execute("PRAGMA foreign_keys = OFF")
    cur.execute("""CREATE TABLE sd_pre_v5(
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL REFERENCES profiles(id),
        filename TEXT NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        adapter TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        import_stats TEXT,
        imported_at TEXT NOT NULL DEFAULT (datetime('now')))""")
    cur.execute("INSERT INTO sd_pre_v5 SELECT id, profile_id, filename, sha256,"
                " adapter, adapter_version, import_stats, imported_at"
                " FROM source_documents")
    cur.execute("DROP TABLE source_documents")
    cur.execute("ALTER TABLE sd_pre_v5 RENAME TO source_documents")
    cur.execute("PRAGMA foreign_keys = ON")
    cur.execute("DELETE FROM schema_version")
    cur.execute("INSERT INTO schema_version(version) VALUES (3)")
    store.con.commit()


def test_migration_v3_to_v4_atomic(tmp_path):
    """遷移整段單一交易：中斷即回滾，不留半遷移狀態。"""
    import sqlite3
    from src.store.db import Store
    from src.store import db as db_mod

    dbp = str(tmp_path / "m.sqlite")
    s = Store(dbp)
    _downgrade_to_v3(s)
    s.con.execute("INSERT INTO profiles(display_name) VALUES ('甲')")
    s.con.commit()
    s.close()

    # 讓第 3 版遷移的第二句失敗
    orig = db_mod.MIGRATIONS[3]
    db_mod.MIGRATIONS[3] = [orig[0], "CREATE TABLE 不合法語法 ("]
    try:
        with pytest.raises(sqlite3.Error):
            Store(dbp)
    finally:
        db_mod.MIGRATIONS[3] = orig

    con = sqlite3.connect(dbp)
    names = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert not (names & {"cpap_daily", "cpap_events", "cpap_oximetry"}), \
        "回滾後不得留下任何 CPAP 表"
    assert con.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 3
    assert con.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] == 1
    con.close()

    # 復原後正常升級
    s2 = Store(dbp)
    assert s2.schema_version() == SCHEMA_VERSION
    s2.close()


def test_migration_empty_version_row(tmp_path):
    """版本紀錄為空要明確報錯，不得讓 None 比較拋 TypeError。"""
    import sqlite3
    from src.store.db import Store

    dbp = str(tmp_path / "e.sqlite")
    Store(dbp).close()
    con = sqlite3.connect(dbp)
    con.execute("DELETE FROM schema_version")
    con.commit()
    con.close()
    with pytest.raises(RuntimeError, match="沒有任何版本紀錄"):
        Store(dbp)
