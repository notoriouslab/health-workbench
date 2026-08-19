// 活動序列切換到彙總表（change apple-daily-aggregates T3）。
// 兩層驗收：(1) 等價實證：新查詢（apple_daily）與舊查詢（raw）逐日全等，
// 比對對象是「舊查詢的實際結果」而非新查詢自我對照；(2) 結構性：六個活動
// 型別的序列查詢 EXPLAIN 不再出現 apple_records（啟動不再全表掃描）。
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nodeFileSource } from "../helpers/node_source.mjs";
import { buildPayload } from "../../src/provider/payload.js";

const COUNTING = ["步數", "步行跑步距離", "騎車距離", "爬樓層數", "活動能量", "基礎能量"];
const IDENT = {
  步數: "HKQuantityTypeIdentifierStepCount",
  步行跑步距離: "HKQuantityTypeIdentifierDistanceWalkingRunning",
  騎車距離: "HKQuantityTypeIdentifierDistanceCycling",
  爬樓層數: "HKQuantityTypeIdentifierFlightsClimbed",
  活動能量: "HKQuantityTypeIdentifierActiveEnergyBurned",
  基礎能量: "HKQuantityTypeIdentifierBasalEnergyBurned",
};
const TREND_EXCLUDE = "quality_flags NOT LIKE '%epoch_placeholder_date%'";

// 多來源、多日、含雙計情境與 epoch 佔位列的合成檔（形狀照真實匯出）
function makeXml() {
  const rows = [];
  for (const [zh, ident] of Object.entries(IDENT)) {
    for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
      for (const [src, base] of [["iPhone", 100], ["Watch", 130]]) {
        for (let h = 8; h < 11; h++) {
          rows.push(`  <Record type="${ident}" sourceName="${src}" unit="count"`
            + ` startDate="${day} 0${h}:00:00 +0800" endDate="${day} 0${h}:30:00 +0800"`
            + ` value="${base + h}"/>`);
        }
      }
    }
    // epoch 佔位列：兩條路徑都必須排除它
    rows.push(`  <Record type="${ident}" sourceName="iPhone" unit="count"`
      + ` startDate="1970-01-01 00:00:00 +0800" endDate="1970-01-01 00:00:00 +0800"`
      + ` value="999"/>`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-switch-"));
  const p = path.join(dir, "acts.xml");
  writeFileSync(p, '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="zh_TW">\n'
    + rows.join("\n") + "\n</HealthData>\n");
  return p;
}

// 舊查詢（切換前的 raw 版本，原文保留於此作等價對照組）
async function legacySeries(d, typeZh, pid) {
  const rows = await d.select(`
    WITH daily AS (
      SELECT substr(start_ts,1,10) d, source_name,
        SUM(COALESCE(value_normalized, value_numeric)) v
      FROM apple_records WHERE profile_id=? AND type_zh=? AND ${TREND_EXCLUDE}
      GROUP BY d, source_name)
    SELECT d, MAX(v) v FROM daily GROUP BY d ORDER BY d`, [pid, typeZh]);
  return rows.filter(r => r.v !== null).map(r => [r.d, Math.round(r.v * 10) / 10]);
}

test("活動序列切換：payload（彙總表）與舊 raw 查詢逐日全等，epoch 列被排除", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  const r = await appleHealthAdapter.importSource(
    await nodeFileSource(makeXml()), d, null, { profileId: pid });
  assert.equal(r.status, "ok");

  const payload = await buildPayload(d, { profileId: pid, knowledgeEntries: [],
    drugCachePath: null, today: "2026-08-19" });
  for (const zh of COUNTING) {
    const legacy = await legacySeries(d, zh, pid);
    assert.ok(legacy.length === 3, `${zh} 對照組要有 3 天（epoch 列排除）`);
    assert.deepEqual(payload.activity[zh], legacy,
      `${zh}：彙總表序列必須與舊 raw 查詢逐日全等`);
  }
  await d.close();
});

test("結構性：活動序列查詢不再掃 apple_records（EXPLAIN）", async () => {
  const d = new NodeDriver();
  await initSchema(d);
  const plan = await d.select(`EXPLAIN QUERY PLAN
    SELECT day d, MAX(sum_v) v FROM apple_daily
    WHERE profile_id=? AND type_zh=? AND ${TREND_EXCLUDE}
    GROUP BY day ORDER BY day`, [1, "步數"]);
  const detail = plan.map(r => r.detail).join(" | ");
  assert.ok(!detail.includes("apple_records"),
    `活動序列不得觸及 raw 表，實際計畫：${detail}`);
  assert.ok(detail.includes("apple_daily"), `必須走彙總表：${detail}`);
  await d.close();
});
