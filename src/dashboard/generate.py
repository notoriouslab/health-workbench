"""單檔 dashboard 產生器：組裝、跳脫、禁用詞檢查、體積閘門、不覆蓋輸出。"""
import sys
from datetime import date
from pathlib import Path

from src.knowledge.forbidden import check_text
from src.store.db import Store

from .embed import build_payload, to_embedded_json

HERE = Path(__file__).parent
SIZE_LIMIT = 10 * 1024 * 1024  # 10MB（design Implementation Contract）


class BuildError(RuntimeError):
    pass


def assemble(payload_json, sizes):
    app_js = (HERE / "app.js").read_text(encoding="utf-8")
    css = (HERE / "style.css").read_text(encoding="utf-8")
    vendor = "\n".join((HERE / "vendor" / f).read_text(encoding="utf-8")
                       for f in ["preact.min.js", "hooks.umd.js", "htm.umd.js"])
    # 介面文案禁用詞檢查（建置失敗含位置）；報告原文不在此列（僅檢查 app 代碼字串）
    for name, text in [("app.js", app_js), ("style.css", css)]:
        hits = check_text(text)
        if hits:
            raise BuildError(f"介面文案含禁用詞 {hits}（{name}）")
    html = f"""<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>個人健康資料工作台（私人）</title>
<style>{css}</style>
</head>
<body>
<div id="app"><p>載入中…若一直停在這行，表示目前的開啟方式不會執行網頁程式
（例如 iOS「檔案」App 的預覽視窗）。電腦上請用瀏覽器開啟本檔；iPhone、
iPad 請改用「HTML &amp; Markdown 檢視器」這類會執行網頁程式的 App。<br>
更省事的辦法：請傳這個檔案給你的人改寄 EPUB 版，用 iPhone、iPad 的
「書籍」（Apple Books）打開就能直接看。</p></div>
<script type="application/json" id="hwb-data">{payload_json}</script>
<script>{vendor}</script>
<script>{app_js}</script>
</body>
</html>"""
    return html


def rebuild(*, db_path, out_dir=None):
    """產出 dashboard_YYYYMMDD-private.html。回傳 0=成功、1=失敗。"""
    db_path = Path(db_path)
    out_dir = Path(out_dir) if out_dir else db_path.parent
    store = Store(db_path)
    try:
        payload, sizes = build_payload(store, db_path)
    finally:
        store.close()
    html = assemble(to_embedded_json(payload), sizes)
    blob = html.encode("utf-8")
    sizes["total_html"] = len(blob)
    detail = "、".join(f"{k}={v/1024:.0f}KB" for k, v in sizes.items())
    if len(blob) > SIZE_LIMIT:
        print(f"建置失敗：檔案 {len(blob)/1048576:.1f}MB 超過 10MB 上限。"
              f"各層體積：{detail}", file=sys.stderr)
        return 1

    base = f"dashboard_{date.today().strftime('%Y%m%d')}-private"
    out = out_dir / f"{base}.html"
    n = 1
    while out.exists():  # 不覆蓋既有檔
        n += 1
        out = out_dir / f"{base}-{n}.html"
    out.write_bytes(blob)
    print(f"dashboard 已產出：{out}（{len(blob)/1024:.0f}KB；{detail}）")
    return 0
