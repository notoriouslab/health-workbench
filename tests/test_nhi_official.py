"""2023-05-15 format regressions; every fixture value is synthetic."""
import json
from pathlib import Path

import pytest

from src.adapters import nhi_fieldmap as fm
from src.adapters.nhi_json import NhiJsonAdapter, code_keys
from src.store.db import Store

FIXTURE = Path(__file__).parent / 'fixtures/nhi_official_20230515.json'


def test_official_fields_and_lossless_retention(tmp_path):
    db = tmp_path / 'official.sqlite'
    assert NhiJsonAdapter().import_file(FIXTURE, db_path=db, assume_profile=True) == 0
    s = Store(db)
    inpatient = s.con.execute("SELECT * FROM encounters WHERE section='r2'").fetchone()
    assert (inpatient['type'], inpatient['date'], inpatient['visit_seq']) == ('inpatient', '2023-04', '0001')
    assert (inpatient['copay'], inpatient['nhi_points']) == (0, 300)
    assert json.loads(inpatient['canonical'])['r2.91'] == '合成次處置19'
    med = s.con.execute("SELECT * FROM medications WHERE section='r2>r2_1'").fetchone()
    assert (med['order_code'], med['order_name'], med['total_qty'], med['days_supply']) == ('SYN002', '合成住院醫囑', 2.5, None)
    assert med['encounter_id'] == inpatient['id']
    assert s.con.execute("SELECT order_code FROM medications WHERE section='r9>r9_1'").fetchone()[0] == 'SYN009'
    body = json.loads(s.con.execute('SELECT extra_json FROM body_measurements').fetchone()[0])
    assert body['血脂肪_總膽固醇'] == 180
    assert body['血脂肪_三酸甘油酯'] == 90
    assert body['B肝表面抗原'] == '合成抗原結果'
    assert body['B肝檢查結果說明'] == '合成B肝檢查結果'
    stats = json.loads(s.con.execute('SELECT import_stats FROM source_documents').fetchone()[0])
    original = json.loads(FIXTURE.read_text(encoding='utf-8'))['myhealthbank']['bdata']
    for sec in ['r4', 'r5', 'R12', 'R13', 'R14', 'r15', 'b1.2', 'b2.1']:
        assert stats['nhi_retained'][sec.lower()] == original[sec]
    assert stats['nhi_failed_records'] == {}
    before = s.table_counts()
    s.close()
    assert NhiJsonAdapter().import_file(FIXTURE, db_path=db, assume_profile=True) == 0
    s = Store(db)
    assert s.table_counts() == before
    s.close()


def test_fieldmap_coverage_and_ambiguity():
    assert set(fm.R2) == {f'r2.{n}' for n in range(1, 92)}
    assert set(fm.R4) == {f'r4.{n}' for n in range(1, 13)}
    assert set(fm.R9) == {f'r9.{n}' for n in range(1, 27)}
    assert len(fm.R12_1) == 13 and len(fm.R13_1) == 10
    for n in range(6, 10):
        assert '不一致' in fm.R14_1[f'r14_1.{n}']
    assert all('待確認' not in v for v in fm.R10.values())


def test_case_collision_rejected():
    with pytest.raises(ValueError, match='Conflicting'):
        code_keys({'r1': [], 'R1': []})


def test_null_missing_placeholder_singleton_and_bad_record(tmp_path, monkeypatch):
    reports = []
    monkeypatch.setattr('src.adapters.nhi_json.render_text', lambda r: reports.append(r) or '')
    bd = {'b1.1': 'Z99999****', 'r0': [{'r0': '合成聲明'}], 'r1': None,
          'r2': {'r2': '無資料'}, 'r3': [], 'r6': [None, {'r6.1': '20230515', 'r6.3': '合成疫苗'}],
          'r15': None, 'r11': [{'r11.1': '合成類別', 'r11_1': {'R11_1.3': '合成結果'}}],
          'r12': [{'r12.1': '20230515', 'r12_1': ''}]}
    p = tmp_path / 'input.json'
    p.write_text(json.dumps({'myhealthbank': {'bdata': bd}}), encoding='utf-8')
    db = tmp_path / 'test.sqlite'
    assert NhiJsonAdapter().import_file(p, db_path=db, assume_profile=True) == 0
    s = Store(db)
    assert s.table_counts()['immunizations'] == 1
    stats = json.loads(s.con.execute('SELECT import_stats FROM source_documents').fetchone()[0])
    assert stats['nhi_failed_records']['r6']['0'] is None
    assert stats['nhi_retained']['r0'] == bd['r0']
    detail = json.loads(s.con.execute('SELECT detail_json FROM cancer_screenings').fetchone()[0])
    assert detail == [{'r11_1.3': '合成結果'}]
    assert 'r12' not in stats['nhi_failed_records']
    assert reports[0]['sections']['r2']['status'] == 'no_data'
    assert reports[0]['sections']['r9']['note'] == '來源未提供此節區'
    s.close()


def test_empty_database_still_requires_identity(tmp_path):
    p = tmp_path / 'missing.json'
    p.write_text('{"myhealthbank":{"bdata":{}}}', encoding='utf-8')
    db = tmp_path / 'missing.sqlite'
    assert NhiJsonAdapter().import_file(p, db_path=db, assume_profile=True) == 3
    s = Store(db)
    assert s.table_counts()['profiles'] == s.table_counts()['source_documents'] == 0
    s.close()


EDGE = Path(__file__).parent / 'fixtures/nhi_edge_placeholders.json'


def test_placeholders_and_bad_children(tmp_path, monkeypatch):
    """無資料佔位的各種形狀不產生假紀錄；壞子項讓整筆失敗而非寫一半。"""
    reports = []
    monkeypatch.setattr('src.adapters.nhi_json.render_text', lambda r: reports.append(r) or '')
    db = tmp_path / 'edge.sqlite'
    assert NhiJsonAdapter().import_file(EDGE, db_path=db, assume_profile=True) == 0
    s = Store(db)
    q = lambda sql: s.con.execute(sql).fetchall()
    # null 子項略過、字串「無資料」明細為零筆；壞子項（數字）的事件整筆不入庫
    # 子項欄位為陣列（05-03 數字子項、05-04 陣列值）整筆不入庫；空物件明細不產生假用藥
    assert [r[0] for r in q("SELECT date FROM encounters ORDER BY date")] == [
        '2023-05-01', '2023-05-02', '2023-05-05', '2023-05-06', '2023-05-07']
    # source_index 保留原始位置（null 之後的子項仍是 1）；布林數量視為非數值
    assert [tuple(r) for r in q("SELECT order_code, source_index, total_qty FROM medications ORDER BY order_code")] == [
        ('SYN101', 0, None), ('SYN106', 1, None), ('SYN107', 0, None)]
    assert q("SELECT COUNT(*) FROM encounters WHERE section='r2'")[0][0] == 0
    assert q("SELECT COUNT(*) FROM lab_results")[0][0] == 0
    assert [json.loads(r[0]) for r in q("SELECT detail_json FROM cancer_screenings ORDER BY category")] == [[], []]
    stats = json.loads(q('SELECT import_stats FROM source_documents')[0][0])
    s.close()
    assert set(stats['nhi_failed_records']) == {'r1'} and set(stats['nhi_failed_records']['r1']) == {'2', '3'}
    assert 'r4' not in stats['nhi_retained'] and 'r12' not in stats['nhi_retained']
    status = {k: v['status'] for k, v in reports[0]['sections'].items()}
    assert [status[k] for k in ('r2', 'r3', 'r4', 'r5', 'r7', 'r12')] == ['no_data'] * 6


def test_top_level_case_conflict_aborts_cleanly(tmp_path, capsys):
    """頂層 r1 與 R1 並存：中止並給訊息，不噴 traceback、不寫入任何資料。"""
    p = tmp_path / 'conflict.json'
    p.write_text(json.dumps({'myhealthbank': {'bdata': {'b1.1': 'Z99999****', 'r1': [], 'R1': []}}}),
                 encoding='utf-8')
    db = tmp_path / 'c.sqlite'
    assert NhiJsonAdapter().import_file(p, db_path=db, assume_profile=True) == 3
    assert '格式異常' in capsys.readouterr().err
    s = Store(db)
    assert s.con.execute('SELECT COUNT(*) FROM source_documents').fetchone()[0] == 0
    s.close()


def test_medication_reconciliation_includes_inpatient(tmp_path, monkeypatch):
    """醫囑對帳涵蓋 r2_1：首次匯入 expected_in_file 等於 inserted_new，且含住院醫囑。"""
    reports = []
    monkeypatch.setattr('src.adapters.nhi_json.render_text', lambda r: reports.append(r) or '')
    db = tmp_path / 'rec.sqlite'
    assert NhiJsonAdapter().import_file(FIXTURE, db_path=db, assume_profile=True) == 0
    s = Store(db)
    by_sec = dict(s.con.execute("SELECT section, COUNT(*) FROM medications GROUP BY section").fetchall())
    s.close()
    rec = json.dumps(reports[0], ensure_ascii=False, default=str)
    found = [v for v in _walk(reports[0]) if isinstance(v, dict) and 'expected_in_file' in v]
    assert found, rec[:200]
    assert found[0]['expected_in_file'] == found[0]['inserted_new'] == sum(by_sec.values())
    assert by_sec.get('r2>r2_1', 0) >= 1


def _walk(o):
    yield o
    if isinstance(o, dict):
        for v in o.values():
            yield from _walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v)
