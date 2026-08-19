"""健保用藥品項本機快取（D4）：hwb knowledge update 手動更新，建置不外連。

資料集：
- 健保用藥品項查詢項目檔（data.gov.tw/dataset/23715，政府資料開放授權）
  下載端點：https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001
- 西藥、醫療器材、化粧品許可證查詢（data.gov.tw/dataset/9122，回 ZIP）
  提供適應症、用法用量、註銷狀態；以 licId 雙鍵與品項檔 join。
快取檔：<db 同目錄>/drug_items.sqlite（非個資，體積大不入 git）
建置寫 <快取檔>.tmp，全部成功才 os.replace() 蓋正式檔（失敗不毀舊快取）。
"""
import csv
import io
import os
import re
import sqlite3
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

DATASET_URL = "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-E41001-001"
DATASET_PAGE = "https://data.gov.tw/dataset/23715"
LICENSE_URL = ("https://data.fda.gov.tw/opendata/exportDataList.do"
               "?method=ExportData&InfoId=36&logType=2")
LICENSE_PAGE = "https://data.gov.tw/dataset/9122"

ITEM_LABEL = "品項檔（23715）"
LICENSE_LABEL = "許可證檔（9122）"
ITEM_REQUIRED = ("藥品代號", "有效迄日", "藥品代碼超連結")
LICENSE_REQUIRED = ("許可證字號", "註銷狀態", "通關簽審文件編號", "適應症", "用法用量")

LIC_ID_RE = re.compile(r"licId=(\w+)")
LICENSE_NO_RE = re.compile(r"^(\D+)第(\d+)號$")


def cache_path(db_path):
    return Path(db_path).parent / "drug_items.sqlite"


def _tmp_path(path):
    return Path(str(path) + ".tmp")


def _fetch(url, label):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.read()
    except Exception as exc:
        raise RuntimeError(f"下載失敗（{label}）：{exc}") from exc


def _load_source(local, url, label, page):
    if local:
        p = Path(local)
        if not p.exists():
            raise FileNotFoundError(f"指定的{label}本地來源不存在：{p}")
        return p.read_bytes()
    print(f"下載{label}（{page}）…")
    return _fetch(url, label)


def _license_text(raw):
    """9122 端點回 ZIP；也接受直接給 CSV（測試/離線用）。"""
    if raw[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                members = [n for n in zf.namelist() if n.lower().endswith(".csv")]
                if not members:
                    raise ValueError(f"{LICENSE_LABEL} ZIP 內找不到 CSV 成員")
                raw = zf.read(members[0])
        except zipfile.BadZipFile as exc:
            raise ValueError(f"{LICENSE_LABEL} ZIP 解壓失敗：{exc}") from exc
    return raw.decode("utf-8-sig", errors="replace")


def _require_columns(reader, required, label):
    names = set(reader.fieldnames or [])
    missing = [c for c in required if c not in names]
    if missing:
        raise ValueError(f"{label}缺必要欄位：{'、'.join(missing)}")


def _load_items(text):
    """品項檔 → {藥品代號: 欄位}，同代號保留有效迄日最大的一列。"""
    reader = csv.DictReader(io.StringIO(text))
    _require_columns(reader, ITEM_REQUIRED, ITEM_LABEL)
    best = {}
    for row in reader:
        code = (row.get("藥品代號") or "").strip()
        if not code:
            continue
        end = (row.get("有效迄日") or "").strip()
        if code not in best or end > best[code]["end"]:
            best[code] = {
                "end": end,
                "name_en": row.get("藥品英文名稱"),
                "name_zh": row.get("藥品中文名稱"),
                "ingredient": row.get("成分"),
                "dosage_form": row.get("劑型"),
                "atc": row.get("ATC代碼"),
                "leaflet_url": row.get("藥品代碼超連結"),
            }
    return best


def _load_licenses(text):
    """許可證檔 → {licId: 欄位}。

    licId 8 碼＝證別代碼 2 碼＋號碼 6 碼。主鍵取「通關簽審文件編號」第 5-12 碼；
    該欄缺的列以「許可證字號」的證別中文＋號碼組回，證別代碼映射自雙欄俱在的列
    學出。兩鍵皆組不出的列跳過。
    """
    reader = csv.DictReader(io.StringIO(text))
    _require_columns(reader, LICENSE_REQUIRED, LICENSE_LABEL)
    by_lic_id = {}
    kind_map = {}
    pending = []
    for row in reader:
        doc = (row.get("通關簽審文件編號") or "").strip()
        license_no = (row.get("許可證字號") or "").strip()
        info = (row.get("適應症"), row.get("用法用量"), row.get("註銷狀態"))
        if len(doc) >= 12:
            lic_id = doc[4:12]
            by_lic_id.setdefault(lic_id, info)
            m = LICENSE_NO_RE.match(license_no)
            if m:
                kind_map.setdefault(m.group(1), lic_id[:2])
        else:
            pending.append((license_no, info))
    for license_no, info in pending:
        m = LICENSE_NO_RE.match(license_no)
        if not m:
            continue
        prefix = kind_map.get(m.group(1))
        if not prefix:
            continue
        by_lic_id.setdefault(prefix + m.group(2).zfill(6), info)
    return by_lic_id


def _write_cache(tmp, rows, today):
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    try:
        con.executescript("""
            CREATE TABLE drug_items(
                code TEXT PRIMARY KEY, name_en TEXT, name_zh TEXT, ingredient TEXT,
                dosage_form TEXT, atc TEXT, leaflet_url TEXT, valid_until TEXT,
                license_id TEXT, indication TEXT, usage_text TEXT, license_status TEXT);
            CREATE TABLE cache_meta(key TEXT PRIMARY KEY, value TEXT);
        """)
        con.executemany("INSERT INTO drug_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        con.executemany("INSERT INTO cache_meta VALUES(?,?)", [
            ("updated_at", today),
            ("dataset_url", DATASET_PAGE),
            ("license_dataset_url", LICENSE_PAGE),
            ("license_updated_at", today),
        ])
        con.commit()
    finally:
        con.close()


def update_cache(db_path, source_items=None, source_licenses=None):
    """下載品項檔＋許可證檔重建快取（原子替換）。

    source_items 傳本地品項 CSV 路徑、source_licenses 傳本地許可證 CSV 或 ZIP
    路徑（測試/離線用）。同一藥品代號保留有效迄日最大的一列，再以 licId 與
    許可證檔 join 帶入適應症／用法用量／註銷狀態。回傳統計 dict。
    """
    path = cache_path(db_path)
    tmp = _tmp_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        raw_items = _load_source(source_items, DATASET_URL, ITEM_LABEL, DATASET_PAGE)
        items = _load_items(raw_items.decode("utf-8-sig", errors="replace"))
        raw_licenses = _load_source(source_licenses, LICENSE_URL, LICENSE_LABEL,
                                    LICENSE_PAGE)
        licenses = _load_licenses(_license_text(raw_licenses))

        rows = []
        hits = 0
        indication_count = 0
        for code, v in items.items():
            m = LIC_ID_RE.search(v["leaflet_url"] or "")
            hit = licenses.get(m.group(1)) if m else None
            if hit:
                hits += 1
                indication, usage_text, license_status = hit
                license_id = m.group(1)
                usage_text = usage_text or None
                if indication:
                    indication_count += 1
            else:
                license_id = indication = usage_text = license_status = None
            rows.append((code, v["name_en"], v["name_zh"], v["ingredient"],
                         v["dosage_form"], v["atc"], v["leaflet_url"], v["end"],
                         license_id, indication, usage_text, license_status))

        today = date.today().isoformat()
        try:
            _write_cache(tmp, rows, today)
        except Exception as exc:
            raise RuntimeError(f"寫入快取失敗（{tmp}）：{exc}") from exc
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    total = len(rows)
    stats = {
        "distinct_codes": total,
        "join_rate": (hits / total) if total else 0.0,
        "indication_count": indication_count,
        "cache": str(path),
    }
    print(f"快取完成：{total} 個藥品代號、許可證命中率 {stats['join_rate']:.4f}"
          f"（{hits} 筆）、適應症 {indication_count} 筆 → {path}")
    return stats


class DrugLookup:
    """離線查詢（建置時 join 用）。快取不存在時全部回 None，不外連。"""

    def __init__(self, db_path):
        p = cache_path(db_path)
        self.con = sqlite3.connect(p) if p.exists() else None
        if self.con:
            self.con.row_factory = sqlite3.Row

    def meta(self):
        if not self.con:
            return None
        return dict(self.con.execute("SELECT key, value FROM cache_meta").fetchall())

    def lookup(self, order_code):
        """醫囑代碼前 10 碼 → 品項資訊；查無回 None。"""
        if not self.con or not order_code:
            return None
        row = self.con.execute("SELECT * FROM drug_items WHERE code=?",
                               ((order_code or "")[:10],)).fetchone()
        return dict(row) if row else None

    def close(self):
        if self.con:
            self.con.close()
