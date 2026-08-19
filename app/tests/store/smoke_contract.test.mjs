import test from "node:test";
import assert from "node:assert/strict";
import { NodeDriver } from "../../src/store/node_driver.js";
import { runSmoke } from "../../src/store/smoke.js";
import { classifyVersion } from "../../src/store/location.js";

// App 內 spike（TauriDriver）跑同一 runSmoke 的期望輸出；
// tests/verification 對照 /tmp/hwb_spike_result.json 的 smoke 欄位。
// tableCount 為 schema 全表數（schema_version 亦計入）：v3 為 12，
// v4 加 CPAP 三表後為 15；v6 加 apple_daily 後為 16。
// 新增表時此數字 MUST 同步，否則 App 端 spike 對帳會失敗。
export const EXPECTED = {
  first: 1000, dup: 0, count: 1000, dur_sum: 499500,
  tableCount: 16,
};

test("driver 契約 smoke：NodeDriver 輸出符合期望", async () => {
  const d = new NodeDriver();
  const r = await runSmoke(d);
  assert.equal(r.first, EXPECTED.first);
  assert.equal(r.dup, EXPECTED.dup);
  assert.equal(r.count, EXPECTED.count);
  assert.equal(r.dur_sum, EXPECTED.dur_sum);
  assert.equal(r.tables.length, EXPECTED.tableCount);
  await d.close();
});

test("classifyVersion：版本判定純函式", () => {
  assert.deepEqual(classifyVersion(3, 3), { ok: true, version: 3 });
  assert.deepEqual(classifyVersion(2, 3), { ok: true, version: 2 });
  assert.deepEqual(classifyVersion(9, 3), { ok: false, reason: "too_new", version: 9 });
  assert.deepEqual(classifyVersion(null, 3), { ok: false, reason: "not_hwb_db" });
});
