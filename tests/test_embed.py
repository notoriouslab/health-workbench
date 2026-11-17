"""dashboard-generator：嵌入分層、跳脫、體積閘門、不覆蓋、聲明、防雙計。"""
from pathlib import Path

import pytest

import src.dashboard.generate as gen
from src.adapters.apple_health import AppleHealthAdapter
from src.adapters.nhi_json import NhiJsonAdapter
from src.dashboard.embed import build_payload, daily_counting_series, to_embedded_json
from src.store.db import Store

NHI_FX = Path(__file__).parent / "fixtures" / "nhi_sample.json"
APPLE_FX = Path(__file__).parent / "fixtures" / "apple_sample.xml"


@pytest.fixture
def db(tmp_path):
    db = tmp_path / "e.sqlite"
    assert NhiJsonAdapter().import_file(NHI_FX, db_path=db, assume_profile=True) == 0
    assert AppleHealthAdapter().import_file(APPLE_FX, db_path=db, assume_profile=True) == 0
    return db


def test_layering(db):
    s = Store(db)
    payload, sizes = build_payload(s, db)
    s.close()
    # 醫療類全量
    assert len(payload["encounters"]) == 5
    assert len(payload["labs"]) == 2
    # 活動類僅日聚合（[日期, 值] 對），無原始逐筆
    steps = payload["activity"]["步數"]
    assert steps and all(len(p) == 2 and len(p[0]) == 10 for p in steps)
    assert set(sizes) == {"medical", "activity", "meta"}


def test_step_dedup_in_embed(db):
    """防雙計在 embed 層（非測試自製 SQL）：同日 iPhone 6000 + Watch 7500 → 7500。"""
    s = Store(db)
    series = daily_counting_series(s, "步數")
    s.close()
    assert ["2024-01-01", 7500.0] in [[d, v] for d, v in series]


def test_escaping(db):
    """含 <1cm 的報告文字：嵌入 JSON 無裸 < 、頁面組裝後不破版。"""
    s = Store(db)
    payload, _ = build_payload(s, db)
    s.close()
    emb = to_embedded_json(payload)
    assert "<" not in emb and ">" not in emb and "&" not in emb
    assert "\\u003c1cm" in emb  # 原文保留、安全跳脫
    html = gen.assemble(emb, {})
    assert "</script><script>alert" not in html


def test_size_gate(db, monkeypatch, capsys):
    monkeypatch.setattr(gen, "SIZE_LIMIT", 1000)
    rc = gen.rebuild(db_path=db)
    assert rc == 1
    err = capsys.readouterr().err
    assert "10MB" in err or "超過" in err
    assert "medical=" in err  # 列出各層體積明細


def test_no_overwrite(db, tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    assert gen.rebuild(db_path=db, out_dir=out) == 0
    assert gen.rebuild(db_path=db, out_dir=out) == 0
    files = sorted(out.glob("dashboard_*-private*.html"))
    assert len(files) == 2  # 第二次產生 -2 尾碼，不覆蓋


def test_disclaimer_present(db, tmp_path):
    out = tmp_path / "d"
    out.mkdir()
    gen.rebuild(db_path=db, out_dir=out)
    html = next(out.glob("*.html")).read_text(encoding="utf-8")
    assert "不提供診斷" in html and "請勿外傳" in html
    assert "（私人）" in html  # 標題標示


def test_forbidden_words_gate(db, monkeypatch):
    """介面文案含禁用詞 → 建置失敗並指出位置。"""
    orig = gen.assemble

    def bad_assemble(payload_json, sizes):
        real_read = Path.read_text

        def fake_read(self, *a, **k):
            t = real_read(self, *a, **k)
            return t + "/* 建議停藥 */" if self.name == "app.js" else t
        monkeypatch.setattr(Path, "read_text", fake_read)
        try:
            return orig(payload_json, sizes)
        finally:
            monkeypatch.setattr(Path, "read_text", real_read)

    with pytest.raises(gen.BuildError, match="app.js"):
        bad_assemble("{}", {})


def test_script_tag_escaping(db):
    """資料含 </script> 字面值：組裝後無法逃逸出 script 區塊。"""
    s = Store(db)
    s.con.execute("UPDATE reports SET report_text = 'x</script><script>alert(1)//' ")
    s.con.commit()
    payload, _ = build_payload(s, db)
    s.close()
    emb = to_embedded_json(payload)
    html = gen.assemble(emb, {})
    assert "</script><script>alert" not in html
    # 資料仍可還原
    import json
    assert "</script>" in json.loads(emb.replace("\\u003c", "<")
                                     .replace("\\u003e", ">")
                                     .replace("\\u0026", "&"))["reports"][0]["report_text"]


def test_sources_import_stats_whitelist(db):
    """匯出只帶 inserted／skipped_dup：健保 nhi_retained（含遮罩身分證）不得進 payload。"""
    import json
    s = Store(db)
    raw = [r[0] for r in s.con.execute("SELECT import_stats FROM source_documents")]
    payload, _ = build_payload(s, db)
    s.close()
    # 前提：資料庫裡確實存了保留資料，否則本測試是空測
    assert any("nhi_retained" in (r or "") and "Z99999****" in (r or "") for r in raw)
    text = json.dumps(payload, ensure_ascii=False)
    assert "Z99999****" not in text
    assert "nhi_retained" not in text and "nhi_failed_records" not in text
    for src in payload["meta"]["sources"]:
        st = json.loads(src["import_stats"])
        assert set(st) <= {"inserted", "skipped_dup"} and "inserted" in st
