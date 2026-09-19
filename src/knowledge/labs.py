"""labs.yaml 載入、schema 驗證、別名正規化寫入（D5）。

比對規則（change lab-order-code-normalization design D1/D2）：名稱鬆比對
優先、單一分析物醫令代碼後備。JS 端 app/src/knowledge/labs.js 為同形實作，
兩端由 app/tests/parity/ 逐位元組對帳。
"""
import re
import unicodedata
from datetime import date, datetime
from pathlib import Path

import yaml

from .forbidden import check_entries

LABS_YAML = Path(__file__).parent / "labs.yaml"
REQUIRED_FIELDS = ["normalized_name", "aliases", "description",
                   "source_name", "source_url", "cited_date"]
STALE_DAYS = 365

# 鬆化移除的字元：空白（NFKC 已把全形空白轉半形）與常見分隔標點。
# 字母、數字、`+`、`%` 全保留——「eGFR Male」與「eGFR (CKD-EPI)」鬆化後
# 仍不同鍵（design D2 保留字元說明）。
_LOOSE_STRIP = re.compile(r"[\s\-_./,、()]")
_WS = re.compile(r"\s+")
_ORDER_CODE_RE = re.compile(r"^\d{5}[A-Z]$")
ORDER_CODE_LEN = 6


class KnowledgeError(ValueError):
    """knowledge 條目不合規（缺欄位、含禁用詞、鬆化碰撞、代碼違規）→ 建置失敗。"""


MIN_LOOSE_LEN = 3
UPDATE_CHUNK = 500


def exact_key(s):
    """名稱精確層鍵：NFKC → 去頭尾空白 → 大寫（任何長度別名皆適用）。"""
    return unicodedata.normalize("NFKC", s or "").strip().upper()


def loose_key(s):
    """名稱鬆化層鍵：NFKC → 大寫 → 移除空白與 `- _ . / , 、 ( )`。

    只對鬆化後長度 ≥ MIN_LOOSE_LEN 的鍵生效（match_name）：短鍵鬆化會把
    N/A、U/A 這類非項目字串誤合成 Na、UA（QA 實測），短別名只走精確層。
    """
    return _LOOSE_STRIP.sub("", unicodedata.normalize("NFKC", s or "").upper())


def match_name(raw, exact, loose):
    """名稱兩層短路：精確層命中 → 鬆化層（僅長鍵）→ None。"""
    ek = exact_key(raw)
    hit = exact.get(ek) if ek else None
    if hit:
        return hit
    lk = loose_key(raw)
    return loose.get(lk) if len(lk) >= MIN_LOOSE_LEN else None


def load_entries(path=LABS_YAML):
    """載入並驗證條目。缺欄位、禁用詞、鬆化碰撞、代碼違規 → KnowledgeError。"""
    entries = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    for e in entries:
        # aliases 允許空清單（正規化名本身即匹配鍵），其餘欄位必須非空
        missing = [f for f in REQUIRED_FIELDS
                   if f not in e or (f != "aliases" and not e.get(f))]
        if missing or not isinstance(e.get("aliases"), list):
            raise KnowledgeError(
                f"條目 {e.get('normalized_name', '(未命名)')} 缺欄位或型別錯誤：{missing or 'aliases'}")
    violations = check_entries(entries)
    if violations:
        raise KnowledgeError(f"條目含禁用詞：{violations}")
    # 建置期守衛：鬆化碰撞與醫令代碼違規在這裡就讓建置失敗（唯一入口）
    alias_map(entries)
    code_map(entries)
    return entries


def alias_map(entries):
    """鬆化鍵（正規名與別名）→ normalized_name。跨條目同鍵 → 建置失敗。"""
    m = {}
    for e in entries:
        for alias in [e["normalized_name"], *e["aliases"]]:
            key = loose_key(alias)
            if not key:
                continue    # 空鍵 MUST NOT 進別名表（design D1）
            if key in m and m[key] != e["normalized_name"]:
                raise KnowledgeError(f"別名衝突：{key} 同時指向 {m[key]} 與 {e['normalized_name']}")
            m[key] = e["normalized_name"]
    return m


def exact_map(entries):
    """精確鍵（正規名與別名）→ normalized_name。碰撞檢查由 alias_map 負責（鬆化同鍵為超集）。"""
    m = {}
    for e in entries:
        for alias in [e["normalized_name"], *e["aliases"]]:
            key = exact_key(alias)
            if key:
                m[key] = e["normalized_name"]
    return m


def code_map(entries):
    """order_codes（6 碼醫令）→ normalized_name。型別/格式/重複 → 建置失敗。"""
    m = {}
    for e in entries:
        codes = e.get("order_codes")
        if codes is None:
            continue        # 無此欄位＝不參與代碼後備
        name = e.get("normalized_name", "(未命名)")
        if not isinstance(codes, list) or not all(isinstance(c, str) for c in codes):
            raise KnowledgeError(f"條目 {name} 的 order_codes 必須為字串清單，實得 {codes!r}")
        for c in codes:
            if not _ORDER_CODE_RE.match(c):
                raise KnowledgeError(
                    f"條目 {name} 的醫令代碼格式錯誤：{c}（需 5 位數字加 1 位大寫英文字母）")
            if c in m and m[c] != e["normalized_name"]:
                raise KnowledgeError(f"醫令代碼重複宣告：{c} 同時宣告於 {m[c]} 與 {name}")
            m[c] = e["normalized_name"]
    return m


def normalized_order_code(raw):
    """order_code 去空白（`\\s+`）、大寫、取前 6 碼；不足 6 碼回 None（無代碼）。"""
    code = _WS.sub("", raw or "").upper()[:ORDER_CODE_LEN]
    return code if len(code) == ORDER_CODE_LEN else None


def apply_normalization(store, entries=None):
    """三級短路重算 test_name_normalized 與旗標（design D1，JS 端同形）。

    (1) 名稱命中（精確層或長鍵鬆化層）→ 該正規名，無新旗標；(2) 名稱不中且
    醫令代碼前 6 碼恰為某條目宣告 → 該正規名並標 `mapped_by_code`；(3) 皆不中
    → NULL 並標 `unmapped`。兩旗標互斥、重算時先移除再依結果加回，其他旗標
    原樣保留。

    冪等：只 UPDATE 結果有變動的列；寫入依（normalized, flags）目標值分組、
    每組一句 `WHERE id IN (...)`（與 JS 端同形，App 端藉此把 IPC 次數從列數
    降到組數）。回傳 `mapped`（含代碼後備）、`unmapped`、`mapped_by_code`
    （前者的子集）、`updated`（實際寫入列數）。
    """
    entries = entries if entries is not None else load_entries()
    exact = exact_map(entries)
    loose = alias_map(entries)
    codes = code_map(entries)
    cur = store.con.cursor()
    rows = cur.execute("SELECT id, test_name_raw, order_code, test_name_normalized, "
                       "quality_flags FROM lab_results").fetchall()
    mapped = unmapped = mapped_by_code = updated = 0
    groups = {}     # (normalized, flag_text) → [ids]
    for r in rows:
        normalized = match_name(r["test_name_raw"], exact, loose)
        by_code = False
        if not normalized:
            code = normalized_order_code(r["order_code"])
            if code:
                normalized = codes.get(code)
                by_code = normalized is not None
        flags = [f for f in (r["quality_flags"] or "").split(",")
                 if f and f not in ("unmapped", "mapped_by_code")]
        if normalized:
            mapped += 1
            if by_code:
                mapped_by_code += 1
                flags.append("mapped_by_code")
        else:
            unmapped += 1
            flags.append("unmapped")
        flag_text = ",".join(flags)
        if normalized == r["test_name_normalized"] and flag_text == (r["quality_flags"] or ""):
            continue        # 結果與現值相同 → 不寫（冪等，第二次 updated=0）
        groups.setdefault((normalized, flag_text), []).append(r["id"])
    for (normalized, flag_text), ids in groups.items():
        for i in range(0, len(ids), UPDATE_CHUNK):
            chunk = ids[i:i + UPDATE_CHUNK]
            cur.execute("UPDATE lab_results SET test_name_normalized=?, quality_flags=? "
                        "WHERE id IN (" + ",".join("?" * len(chunk)) + ")",
                        (normalized, flag_text, *chunk))
            updated += len(chunk)
    store.con.commit()
    return {"mapped": mapped, "unmapped": unmapped,
            "mapped_by_code": mapped_by_code, "updated": updated}


def stale_entries(entries=None, today=None):
    """cited_date 超過一年的條目清單（過時提醒，不自動更新）。"""
    entries = entries if entries is not None else load_entries()
    today = today or date.today()
    out = []
    for e in entries:
        cited = e["cited_date"]
        if isinstance(cited, str):
            cited = datetime.strptime(cited, "%Y-%m-%d").date()
        if (today - cited).days > STALE_DAYS:
            out.append({"normalized_name": e["normalized_name"],
                        "cited_date": str(cited)})
    return out
