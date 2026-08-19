"""knowledge-annotations：條目結構、別名映射、eGFR 不合併、禁用詞、藥品 join、過時提醒。"""
import csv
import sqlite3
from datetime import date
from pathlib import Path

import pytest

from src.adapters.nhi_json import NhiJsonAdapter
from src.knowledge.drugs import DrugLookup, cache_path, update_cache
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


# ---- 藥品快取：品項檔（23715）＋許可證檔（9122）雙鍵 join（drug-info T1）----
#
# 合成 CSV 的欄名與形狀取自 2026-08-19 實際下載檔（品項檔 20 欄、許可證檔 28 欄）；
# 通關簽審文件編號形狀 "DHY0" + licId(8) + 檢碼(2)（實例 DHY01400001203）。

ITEM_HEADER = ("異動,藥品代號,藥品英文名稱,藥品中文名稱,成分,規格量,規格單位,單複方,支付價,"
               "有效起日,有效迄日,藥商,製造廠名稱,劑型,藥品分類,分類分組名稱,ATC代碼,"
               "給付規定章節,藥品代碼超連結,給付規定章節連結")

LICENSE_HEADER = ["許可證字號", "註銷狀態", "註銷日期", "註銷理由", "有效日期", "發證日期",
                  "許可證種類", "舊證字號", "通關簽審文件編號", "中文品名", "英文品名",
                  "適應症", "劑型", "包裝", "藥品類別", "管制藥品分類級別", "主成分略述",
                  "申請商名稱", "申請商地址", "申請商統一編號", "製造商名稱", "製造廠廠址",
                  "製造廠公司地址", "製造廠國別", "製程", "異動日期", "用法用量",
                  "包裝與國際條碼"]

LEAFLET = "https://lmspiq.fda.gov.tw/web/DRPIQ/DRPIQ1000Result?licId={}"


def _item_line(code, name_zh, valid_until, leaflet_url, name_en="Test Drug"):
    return (f",{code},{name_en},{name_zh},TESTOSTATIN 10 MG,,,單方,1.00,1120101,"
            f"{valid_until},測試藥商,測試廠,錠劑,學名藥,分組,A00AA00,,{leaflet_url},")


def _write_items(path, lines, drop=None):
    header = ITEM_HEADER
    if drop:
        cols = header.split(",")
        idx = cols.index(drop)
        header = ",".join(c for c in cols if c != drop)
        lines = [",".join(v for i, v in enumerate(ln.split(",")) if i != idx) for ln in lines]
    path.write_text(header + "\n" + "\n".join(lines) + "\n", encoding="utf-8")
    return path


def _license_row(license_no, doc_no="", indication="", usage="", status=""):
    row = {k: "" for k in LICENSE_HEADER}
    row.update({"許可證字號": license_no, "通關簽審文件編號": doc_no,
                "適應症": indication, "用法用量": usage, "註銷狀態": status})
    return row


def _doc_no(lic_id):
    return f"DHY0{lic_id}01"


def _write_licenses(path, rows, drop=None):
    fields = [f for f in LICENSE_HEADER if f != drop]
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return path


def test_drug_join(tmp_path):
    """以縮小版 CSV 建快取，驗證醫囑代碼 join 與版本標示。"""
    csv_path = _write_items(tmp_path / "mini.csv", [
        _item_line("XX00000001", "測試藥品Ａ錠", "1130101", "https://example.com/a",
                   name_en="Test Drug A"),
        _item_line("XX00000001", "測試藥品Ａ錠v2", "9991231", "https://example.com/a2",
                   name_en="Test Drug A v2"),
    ])
    lic_path = _write_licenses(tmp_path / "lic.csv", [
        _license_row("衛署藥製字第049322號", _doc_no("01049322"), "測試適應症"),
    ])
    db = tmp_path / "d.sqlite"
    stats = update_cache(db, source_items=csv_path, source_licenses=lic_path)
    assert stats["distinct_codes"] == 1
    lk = DrugLookup(db)
    hit = lk.lookup("XX00000001")   # 同代號兩列 → 取有效迄日最大
    assert hit["name_zh"] == "測試藥品Ａ錠v2"
    assert hit["leaflet_url"] == "https://example.com/a2"
    assert lk.meta()["updated_at"] == date.today().isoformat()
    assert lk.lookup("ZZ99999999") is None
    lk.close()


def test_drug_license_join_primary_key(tmp_path):
    """主鍵命中：licId 來自品項超連結，9122 側取通關簽審文件編號第 5-12 碼。"""
    items = _write_items(tmp_path / "i.csv", [
        _item_line("AA00000001", "測試藥Ｂ", "9991231", LEAFLET.format("01049322")),
    ])
    lic = _write_licenses(tmp_path / "l.csv", [
        _license_row("衛署藥製字第049322號", _doc_no("01049322"),
                     indication="測試適應症原文", usage="每日一次", status="已註銷"),
    ])
    db = tmp_path / "d.sqlite"
    stats = update_cache(db, source_items=items, source_licenses=lic)
    assert stats["join_rate"] == 1.0 and stats["indication_count"] == 1
    lk = DrugLookup(db)
    hit = lk.lookup("AA00000001")
    assert hit["license_id"] == "01049322"
    assert hit["indication"] == "測試適應症原文"
    assert hit["usage_text"] == "每日一次"
    assert hit["license_status"] == "已註銷"
    assert lk.meta()["license_dataset_url"] == "https://data.gov.tw/dataset/9122"
    assert lk.meta()["license_updated_at"] == date.today().isoformat()
    lk.close()


def test_drug_license_join_fallback_key(tmp_path):
    """通關簽審文件編號缺的列：以許可證字號證別中文＋號碼 zfill(6) 組回 licId。"""
    items = _write_items(tmp_path / "i.csv", [
        _item_line("AA00000001", "主鍵藥", "9991231", LEAFLET.format("01049322")),
        _item_line("AA00000002", "備援藥", "9991231", LEAFLET.format("01001234")),
    ])
    lic = _write_licenses(tmp_path / "l.csv", [
        _license_row("衛署藥製字第049322號", _doc_no("01049322"), indication="主鍵適應症"),
        _license_row("衛署藥製字第001234號", "", indication="備援適應症"),
    ])
    db = tmp_path / "d.sqlite"
    stats = update_cache(db, source_items=items, source_licenses=lic)
    assert stats["join_rate"] == 1.0
    lk = DrugLookup(db)
    assert lk.lookup("AA00000002")["license_id"] == "01001234"
    assert lk.lookup("AA00000002")["indication"] == "備援適應症"
    lk.close()


def test_drug_license_kind_map_learned(tmp_path):
    """證別代碼映射自雙欄俱在的列學出（非寫死）：兩種證別各走自己的前綴。"""
    items = _write_items(tmp_path / "i.csv", [
        _item_line("AA00000001", "甲類備援", "9991231", LEAFLET.format("01001234")),
        _item_line("AA00000002", "乙類備援", "9991231", LEAFLET.format("14000038")),
    ])
    lic = _write_licenses(tmp_path / "l.csv", [
        # 學習列（雙欄俱在）：衛署藥製字→01、內衛成製字→14
        _license_row("衛署藥製字第049322號", _doc_no("01049322"), indication="學習列甲"),
        _license_row("內衛成製字第000012號", _doc_no("14000012"), indication="學習列乙"),
        # 待補列（通關簽審缺）：各自用學到的前綴
        _license_row("衛署藥製字第001234號", "", indication="甲類適應症"),
        _license_row("內衛成製字第000038號", "", indication="乙類適應症"),
    ])
    db = tmp_path / "d.sqlite"
    stats = update_cache(db, source_items=items, source_licenses=lic)
    assert stats["join_rate"] == 1.0
    lk = DrugLookup(db)
    assert lk.lookup("AA00000001")["indication"] == "甲類適應症"
    assert lk.lookup("AA00000002")["indication"] == "乙類適應症"
    lk.close()


def test_drug_license_unkeyable_rows_skipped(tmp_path):
    """兩鍵皆組不出的許可證列跳過：品項新欄全 NULL，既有欄不受影響。"""
    items = _write_items(tmp_path / "i.csv", [
        _item_line("AA00000001", "未命中藥", "9991231", LEAFLET.format("01123456")),
        _item_line("AA00000002", "無連結藥", "9991231", ""),
    ])
    lic = _write_licenses(tmp_path / "l.csv", [
        # 證別 衛署藥製字 沒有任何雙欄俱在的學習列 → fallback 組不出
        _license_row("衛署藥製字第123456號", "", indication="組不出的適應症"),
        # 許可證字號不符 ^(\D+)第(\d+)號$ 且通關簽審缺 → 兩鍵皆無
        _license_row("無證字號", "", indication="也組不出"),
    ])
    db = tmp_path / "d.sqlite"
    stats = update_cache(db, source_items=items, source_licenses=lic)
    assert stats["join_rate"] == 0.0 and stats["indication_count"] == 0
    lk = DrugLookup(db)
    for code in ("AA00000001", "AA00000002"):
        hit = lk.lookup(code)
        assert hit["name_zh"] and hit["valid_until"] == "9991231"
        assert hit["license_id"] is None and hit["indication"] is None
        assert hit["usage_text"] is None and hit["license_status"] is None
    lk.close()


def test_drug_license_empty_usage_text_is_null(tmp_path):
    """用法用量空字串存 NULL（9122 實測僅 28% 有值）。"""
    items = _write_items(tmp_path / "i.csv", [
        _item_line("AA00000001", "有用法", "9991231", LEAFLET.format("01049322")),
        _item_line("AA00000002", "無用法", "9991231", LEAFLET.format("01049345")),
    ])
    lic = _write_licenses(tmp_path / "l.csv", [
        _license_row("衛署藥製字第049322號", _doc_no("01049322"),
                     indication="適應症甲", usage="每日一次"),
        _license_row("衛署藥製字第049345號", _doc_no("01049345"),
                     indication="適應症乙", usage=""),
    ])
    db = tmp_path / "d.sqlite"
    update_cache(db, source_items=items, source_licenses=lic)
    con = sqlite3.connect(cache_path(db))
    rows = dict(con.execute("SELECT code, usage_text FROM drug_items").fetchall())
    con.close()
    assert rows["AA00000001"] == "每日一次"
    assert rows["AA00000002"] is None


def test_drug_cache_missing_column_keeps_old_cache(tmp_path):
    """缺必要欄位 → 拋錯指名缺欄；舊快取位元組不動、無 .tmp 殘檔（原子替換）。"""
    db = tmp_path / "d.sqlite"
    good_items = _write_items(tmp_path / "i.csv", [
        _item_line("AA00000001", "既有藥", "9991231", LEAFLET.format("01049322")),
    ])
    good_lic = _write_licenses(tmp_path / "l.csv", [
        _license_row("衛署藥製字第049322號", _doc_no("01049322"), indication="既有適應症"),
    ])
    update_cache(db, source_items=good_items, source_licenses=good_lic)
    path = cache_path(db)
    tmp = Path(str(path) + ".tmp")
    before = path.read_bytes()

    bad_items = _write_items(tmp_path / "bad_i.csv", [
        _item_line("AA00000002", "新藥", "9991231", LEAFLET.format("01049322")),
    ], drop="有效迄日")
    tmp.write_bytes(b"stale")   # 前次失敗殘檔：失敗路徑 MUST 清掉、不得留給下輪
    with pytest.raises(ValueError, match="有效迄日"):
        update_cache(db, source_items=bad_items, source_licenses=good_lic)
    assert path.read_bytes() == before and not tmp.exists()

    bad_lic = _write_licenses(tmp_path / "bad_l.csv", [
        _license_row("衛署藥製字第049322號", _doc_no("01049322")),
    ], drop="適應症")
    with pytest.raises(ValueError, match="適應症"):
        update_cache(db, source_items=good_items, source_licenses=bad_lic)
    assert path.read_bytes() == before and not tmp.exists()

    lk = DrugLookup(db)   # 舊快取仍可查
    assert lk.lookup("AA00000001")["indication"] == "既有適應症"
    assert lk.lookup("AA00000002") is None
    lk.close()


def test_drug_lookup_old_cache_without_new_columns(tmp_path):
    """舊快取（無新欄）：lookup 不炸，新欄 .get() 回 None。"""
    db = tmp_path / "d.sqlite"
    path = cache_path(db)
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE drug_items(
            code TEXT PRIMARY KEY, name_en TEXT, name_zh TEXT, ingredient TEXT,
            dosage_form TEXT, atc TEXT, leaflet_url TEXT, valid_until TEXT);
        CREATE TABLE cache_meta(key TEXT PRIMARY KEY, value TEXT);
    """)
    con.execute("INSERT INTO drug_items VALUES('AA00000001','Old','舊藥','X','錠劑',"
                "'A00AA00','https://example.com/old','9991231')")
    con.execute("INSERT INTO cache_meta VALUES('updated_at','2026-08-10')")
    con.commit()
    con.close()
    lk = DrugLookup(db)
    hit = lk.lookup("AA00000001")
    assert hit["name_zh"] == "舊藥"
    for col in ("license_id", "indication", "usage_text", "license_status"):
        assert hit.get(col) is None
    assert lk.meta().get("license_updated_at") is None
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


def test_drug_source_path_missing_raises(tmp_path):
    """指定本地來源但路徑不存在 MUST 拋錯，不得靜默改走下載。"""
    db = tmp_path / "d.sqlite"
    with pytest.raises(FileNotFoundError, match="品項檔"):
        update_cache(db, source_items=tmp_path / "no_such.csv",
                     source_licenses=tmp_path / "also_missing.csv")
    assert not (tmp_path / "drug_items.sqlite").exists()
    assert not (tmp_path / "drug_items.sqlite.tmp").exists()
