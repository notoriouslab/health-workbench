"""Store 寫入層：來源追溯強制、指紋合併、碰撞防禦、品質旗標。"""
import json
import sqlite3
from pathlib import Path

from .fingerprint import canonical_json, record_fp
from .schema import (DDL, FP_TABLES, MIGRATIONS, QUALITY_FLAG_TABLES,
                     SCHEMA_VERSION)


class SourceRequired(ValueError):
    """寫入未帶來源追溯資訊。"""


class Store:
    def __init__(self, db_path):
        self.path = Path(db_path)
        self.con = sqlite3.connect(self.path)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA foreign_keys = ON")
        self._init_schema()
        # 匯入統計（品質報告增量來源）
        self.stats = {"inserted": {}, "skipped_dup": {}, "collisions": 0}

    def _init_schema(self):
        cur = self.con.cursor()
        row = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
        ).fetchone()
        if not row:
            cur.executescript(DDL)
            cur.execute("INSERT INTO schema_version(version) VALUES (?)", (SCHEMA_VERSION,))
            self.con.commit()
            return
        ver = cur.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
        # 版本紀錄存在但為空：None 與數字比較在 Python 會拋 TypeError，
        # 訊息對使用者無意義。明確攔下（health-database spec）。
        if ver is None:
            raise RuntimeError(
                "資料庫的 schema_version 表沒有任何版本紀錄，無法判斷升級路徑；"
                "請改用備份還原。")
        if ver > SCHEMA_VERSION:
            raise RuntimeError(
                f"資料庫 schema 版本 {ver} 高於程式支援的 {SCHEMA_VERSION}，"
                f"請更新程式後再開啟。")
        if ver == SCHEMA_VERSION:
            return
        # 遷移整段包在單一交易內：版本註記與 DDL 同進同出。逐版 commit 時，
        # 若第二版執行到一半中斷，資料庫會停在「版本已寫新值但結構只完成
        # 一部分」的狀態，之後每次開啟都會略過遷移（health-database spec）。
        try:
            cur.execute("BEGIN")
            while ver < SCHEMA_VERSION:
                steps = MIGRATIONS.get(ver)
                if steps is None:
                    raise RuntimeError(
                        f"資料庫 schema 版本 {ver} 與程式 {SCHEMA_VERSION} 不符，"
                        f"且無可用遷移路徑；請備份後以 hwb import 重建。")
                for sql in steps:
                    cur.execute(sql)
                ver += 1
                cur.execute("INSERT INTO schema_version(version) VALUES (?)", (ver,))
            self.con.commit()
        except Exception:
            self.con.rollback()
            raise

    # ---- profile ----
    def get_or_create_profile(self, display_name, masked_id=None):
        cur = self.con.cursor()
        row = cur.execute("SELECT * FROM profiles ORDER BY id LIMIT 1").fetchone()
        if row:
            return row["id"], row["masked_id"]
        cur.execute("INSERT INTO profiles(display_name, masked_id) VALUES(?,?)",
                    (display_name, masked_id))
        self.con.commit()
        return cur.lastrowid, masked_id

    # ---- source documents ----
    def register_source(self, profile_id, filename, sha256, adapter, adapter_version,
                        imported_at=None):
        """回傳 (doc_id, already_imported)。同 sha256 視為已匯入。

        imported_at（選用）語意與 app/src/engine/store.js 的 registerSource 一致：
        多檔來源要讓整批共用同一個時間戳，否則每列各自取 datetime('now')，跨秒
        時同一批會被檢視層（同 adapter ＋同 imported_at）切成數批。傳 None 沿用
        schema 原本的 datetime('now')。回傳值仍是「先前已匯入的時間」，新插入
        必為 None。
        """
        cur = self.con.cursor()
        row = cur.execute("SELECT id, imported_at FROM source_documents WHERE sha256=?",
                          (sha256,)).fetchone()
        if row:
            return row["id"], row["imported_at"]
        cur.execute(
            "INSERT INTO source_documents(profile_id,filename,sha256,adapter,"
            "adapter_version,imported_at)"
            " VALUES(?,?,?,?,?,COALESCE(?, datetime('now')))",
            (profile_id, filename, sha256, adapter, adapter_version, imported_at))
        return cur.lastrowid, None

    def finalize_import(self, doc_id):
        """把本次匯入統計寫回 source_documents.import_stats（JSON）。"""
        self.con.execute(
            "UPDATE source_documents SET import_stats=? WHERE id=?",
            (json.dumps(self.stats, ensure_ascii=False), doc_id))

    # ---- 指紋合併寫入（健保側） ----
    def insert_fp_record(self, table, record, *, profile_id, doc_id, section,
                         source_index, columns, quality_flags=""):
        """寫入帶指紋表。record 為原始 dict（指紋來源），columns 為正規化欄位值。

        回傳 "inserted" / "duplicate" / "collision"。
        碰撞防禦：指紋相同時比對完整正規化內容，不同則標 fingerprint_collision。
        """
        if table not in FP_TABLES:
            raise ValueError(f"非法表名：{table}")
        if doc_id is None or section is None or source_index is None:
            raise SourceRequired(f"{table} 寫入缺來源追溯（doc_id/section/source_index）")
        fp = record_fp(record)
        canon = canonical_json(record)
        cur = self.con.cursor()
        existing = cur.execute(
            f"SELECT id, canonical FROM {table} WHERE profile_id=? AND section=? AND record_fp=?",
            (profile_id, section, fp)).fetchone()
        if existing:
            if existing["canonical"] != canon:
                self.stats["collisions"] += 1
                flags = cur.execute(f"SELECT quality_flags FROM {table} WHERE id=?",
                                    (existing["id"],)).fetchone()[0]
                if "fingerprint_collision" not in flags.split(","):
                    cur.execute(
                        f"UPDATE {table} SET quality_flags ="
                        " CASE WHEN quality_flags='' THEN 'fingerprint_collision'"
                        " ELSE quality_flags || ',fingerprint_collision' END WHERE id=?",
                        (existing["id"],))
                return "collision"
            self.stats["skipped_dup"][table] = self.stats["skipped_dup"].get(table, 0) + 1
            return "duplicate"
        cols = {"profile_id": profile_id, "doc_id": doc_id, "section": section,
                "source_index": source_index, "record_fp": fp, "canonical": canon,
                "quality_flags": quality_flags, **columns}
        names = ",".join(cols)
        marks = ",".join("?" * len(cols))
        cur.execute(f"INSERT INTO {table}({names}) VALUES({marks})", tuple(cols.values()))
        self.stats["inserted"][table] = self.stats["inserted"].get(table, 0) + 1
        self._last_insert_id = cur.lastrowid
        return "inserted"

    # ---- 一般寫入（medications 依附 encounter） ----
    def insert_medication(self, *, profile_id, doc_id, encounter_id, section,
                          source_index, **columns):
        if doc_id is None or section is None or source_index is None:
            raise SourceRequired("medications 寫入缺來源追溯")
        cols = {"profile_id": profile_id, "doc_id": doc_id, "encounter_id": encounter_id,
                "section": section, "source_index": source_index, **columns}
        names = ",".join(cols)
        marks = ",".join("?" * len(cols))
        before = self.con.total_changes
        self.con.execute(f"INSERT OR IGNORE INTO medications({names}) VALUES({marks})",
                         tuple(cols.values()))
        key = "medications"
        if self.con.total_changes > before:
            self.stats["inserted"][key] = self.stats["inserted"].get(key, 0) + 1
        else:
            self.stats["skipped_dup"][key] = self.stats["skipped_dup"].get(key, 0) + 1

    # ---- Apple 寫入（自然鍵冪等） ----
    def insert_apple_record(self, *, profile_id, doc_id, **columns):
        if doc_id is None:
            raise SourceRequired("apple_records 寫入缺來源追溯（doc_id）")
        cols = {"profile_id": profile_id, "doc_id": doc_id, **columns}
        names = ",".join(cols)
        marks = ",".join("?" * len(cols))
        before = self.con.total_changes
        self.con.execute(
            f"INSERT OR IGNORE INTO apple_records({names}) VALUES({marks})",
            tuple(cols.values()))
        key = "apple_records"
        if self.con.total_changes > before:
            self.stats["inserted"][key] = self.stats["inserted"].get(key, 0) + 1
            return "inserted"
        self.stats["skipped_dup"][key] = self.stats["skipped_dup"].get(key, 0) + 1
        return "duplicate"

    def insert_apple_workout(self, *, profile_id, doc_id, **columns):
        if doc_id is None:
            raise SourceRequired("apple_workouts 寫入缺來源追溯（doc_id）")
        cols = {"profile_id": profile_id, "doc_id": doc_id, **columns}
        names = ",".join(cols)
        marks = ",".join("?" * len(cols))
        self.con.execute(
            f"INSERT OR IGNORE INTO apple_workouts({names}) VALUES({marks})",
            tuple(cols.values()))

    # ---- 查詢輔助 ----
    def table_counts(self):
        cur = self.con.cursor()
        out = {}
        for t in ["profiles", "source_documents", "encounters", "medications",
                  "lab_results", "reports", "immunizations", "body_measurements",
                  "cancer_screenings", "apple_records", "apple_workouts",
                  "apple_daily", "cpap_daily", "cpap_events", "cpap_oximetry"]:
            out[t] = cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        return out

    def schema_version(self):
        return self.con.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]

    def quality_flag_counts(self):
        out = {}
        for t in QUALITY_FLAG_TABLES:
            rows = self.con.execute(
                f"SELECT quality_flags FROM {t} WHERE quality_flags != ''").fetchall()
            for r in rows:
                for f in filter(None, r["quality_flags"].split(",")):
                    out[f] = out.get(f, 0) + 1
        return out

    def commit(self):
        self.con.commit()

    def close(self):
        self.con.close()
