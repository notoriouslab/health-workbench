"""型別分配對帳（change apple-daily-aggregates）：逐筆∪彙總 恰等於 WANTED。

漏接的型別不會有任何錯誤訊息（既不進彙總也不被清理保護），故兩端各以
本測試釘住；兩端清單彼此逐字相等由 app/tests/engine/aggregate.test.mjs
的 parity 測試把守。
"""
import sys

sys.path.insert(0, ".")

from src.adapters.apple_health import WANTED
from src.store.schema import AGGREGATE_TYPES, PER_ROW_TYPES


def test_allocation_covers_wanted_exactly():
    alloc = PER_ROW_TYPES + AGGREGATE_TYPES
    assert len(alloc) == len(set(alloc)), "分配表內不得重複"
    assert sorted(alloc) == sorted(WANTED.values())
