"""hwb — 個人健康資料工作台 CLI。

子命令：
  import   匯入健保存摺 JSON 或 Apple Health 匯出（自動判型），並重建 dashboard
  rebuild  重新產出單檔 dashboard
  status   顯示 schema 版本與各表筆數
  quality  輸出全庫品質報告（唯讀，不重新解析來源檔）
"""
import argparse
import json
import sys
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "hwb.sqlite"


def cmd_status(args):
    from src.store.db import Store
    store = Store(args.db)
    print(f"schema 版本：{store.schema_version()}")
    for t, n in store.table_counts().items():
        print(f"  {t}: {n}")
    store.close()
    return 0


def cmd_quality(args):
    from src.knowledge.drugs import DrugLookup
    from src.knowledge.body_refs import load_body_refs
    from src.knowledge.labs import stale_entries
    from src.quality.quality_report import build_full, render_text
    from src.store.db import Store
    store = Store(args.db)
    # 過時提醒對兩類 knowledge 一體適用：檢驗條目＋身體數值參考標準
    stale = stale_entries() + stale_entries(load_body_refs())
    lookup = DrugLookup(args.db)
    meta = lookup.meta()
    lookup.close()
    if meta:
        from datetime import date, datetime
        updated = datetime.strptime(meta["updated_at"], "%Y-%m-%d").date()
        if (date.today() - updated).days > 365:
            stale.append({"normalized_name": "(藥品品項快取)",
                          "cited_date": meta["updated_at"]})
    report = build_full(store, stale_knowledge=stale)
    print(render_text(report))
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    store.close()
    return 0


def cmd_knowledge(args):
    from src.knowledge.drugs import update_cache
    update_cache(args.db, source_items=args.source_items,
                 source_licenses=args.source_licenses)
    return 0


def cmd_import(args):
    from src.adapters import detect_and_import
    return detect_and_import(args.path, db_path=args.db, rebuild=not args.no_rebuild,
                             assume_profile=args.yes)


def cmd_rebuild(args):
    from src.dashboard.generate import rebuild
    return rebuild(db_path=args.db, out_dir=args.out)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="hwb", description="個人健康資料工作台：匯入、累積、檢視自己的健康資料")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite 資料庫路徑")
    sub = parser.add_subparsers(dest="command", required=True)

    p_import = sub.add_parser("import", help="匯入健保存摺 JSON 或 Apple Health 匯出（自動判型）")
    p_import.add_argument("path", type=Path, help="下載檔、zip 或資料夾路徑")
    p_import.add_argument("--no-rebuild", action="store_true", help="匯入後不重建 dashboard")
    p_import.add_argument("--yes", action="store_true", help="首次匯入時不互動確認建立 profile")
    p_import.set_defaults(func=cmd_import)

    p_rebuild = sub.add_parser("rebuild", help="重新產出單檔 dashboard")
    p_rebuild.add_argument("--out", type=Path, default=None, help="輸出目錄（預設 data/）")
    p_rebuild.set_defaults(func=cmd_rebuild)

    p_status = sub.add_parser("status", help="顯示 schema 版本與各表筆數")
    p_status.set_defaults(func=cmd_status)

    p_knowledge = sub.add_parser("knowledge", help="knowledge 對照維護")
    p_knowledge.add_argument("action", choices=["update"],
                             help="update：下載藥品品項與許可證快取")
    p_knowledge.add_argument("--source-items", type=Path, default=None,
                             help="改用本地品項檔 CSV（離線/測試用）")
    p_knowledge.add_argument("--source-licenses", type=Path, default=None,
                             help="改用本地許可證檔 CSV 或 ZIP（離線/測試用）")
    p_knowledge.set_defaults(func=cmd_knowledge)

    p_quality = sub.add_parser("quality", help="輸出全庫品質報告（唯讀）")
    p_quality.add_argument("--json", action="store_true", help="同時輸出 JSON 結構")
    p_quality.set_defaults(func=cmd_quality)

    args = parser.parse_args(argv)
    args.db.parent.mkdir(parents=True, exist_ok=True)
    import sqlite3
    try:
        return args.func(args)
    except sqlite3.DatabaseError as e:
        print(f"資料庫無法開啟（{args.db}）：{e}\n"
              f"若檔案損壞：原始下載檔都在，可將其移走後以 hwb import 重建；"
              f"或還原你的備份副本。", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
