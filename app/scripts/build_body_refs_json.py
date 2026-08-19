"""建置期產物：src/knowledge/body_refs.yaml → app/src/knowledge/body_refs.json。

經 Python 版 load_body_refs()（schema 驗證＋禁用詞檢查）後轉出，
確保 App 端條目與 CLI 端同源。--check 模式比對現存檔是否過期（CI 守衛）。
"""
import json
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from src.knowledge.body_refs import load_body_refs  # noqa: E402

OUT = REPO / "app/src/knowledge/body_refs.json"


def render():
    entries = load_body_refs()
    def ser(o):
        if isinstance(o, date):
            return str(o)
        raise TypeError(type(o))
    return json.dumps(entries, ensure_ascii=False, indent=1, default=ser)


def main():
    text = render()
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print("body_refs.json 過期：body_refs.yaml 已變更，"
                  "請重跑 app/scripts/build_body_refs_json.py", file=sys.stderr)
            sys.exit(1)
        print("body_refs.json 與 body_refs.yaml 同步")
        return
    OUT.write_text(text, encoding="utf-8")
    print(f"body_refs.json 已更新（{len(json.loads(text))} 條）")


if __name__ == "__main__":
    main()
