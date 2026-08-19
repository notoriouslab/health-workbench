"""身體數值參考標準（血壓、BMI 的參考線／帶）載入與驗證。

沿 labs.yaml 慣例：版本化 YAML、欄位缺失即建置失敗、非結論式用語
約束、過時提醒（hwb quality 經 stale_entries 一體適用）。標準值
MUST 放條目、NEVER 寫死在圖表程式（app-viewer「身體數值的參考線」）。
"""
from pathlib import Path

import yaml

from .forbidden import check_text

BODY_REFS_YAML = Path(__file__).parent / "body_refs.yaml"
REQUIRED_FIELDS = ["normalized_name", "type_zh", "kind", "label",
                   "source_name", "source_url", "cited_date"]


class BodyRefsError(ValueError):
    """參考標準條目不合規（缺欄位或含禁用詞）→ 建置失敗。"""


def load_body_refs(path=BODY_REFS_YAML):
    """載入並驗證條目。缺欄位、kind 與數值不符、或含禁用詞 → BodyRefsError。"""
    entries = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    for e in entries:
        missing = [f for f in REQUIRED_FIELDS if not e.get(f)]
        kind = e.get("kind")
        if kind == "line":
            if e.get("value") is None:
                missing.append("value")
        elif kind == "band":
            if e.get("lo") is None or e.get("hi") is None:
                missing.append("lo/hi")
        else:
            missing.append("kind(line|band)")
        if missing:
            raise BodyRefsError(
                f"參考標準條目 {e.get('normalized_name', '(未命名)')} 缺欄位：{missing}")
        hits = check_text(e["label"]) + check_text(e["source_name"])
        if hits:
            raise BodyRefsError(
                f"參考標準條目 {e['normalized_name']} 含禁用詞：{hits}")
    return entries
