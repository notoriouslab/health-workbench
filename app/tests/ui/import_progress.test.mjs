// 進度顯示規則（app-import-gui「進度與結果報告」）＋整條 zip 匯入的
// 百分比單調性。進度路徑此前零測試覆蓋（change import-progress-and-single-pass
// T0 盤點），本檔起建。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { progressView } from "../../src/ui/progress_view.js";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nodeFileSource } from "../helpers/node_source.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;
const FIXTURE = `${REPO}/tests/fixtures/apple_sample.xml`;

test("百分比僅於 totalBytes>0 顯示；0＝只顯示筆數", () => {
  // 正常：有百分比
  assert.deepEqual(progressView(0, 100, 50),
    { pct: 50, text: "正在檢查檔案是否曾經匯入…（50%）" });
  assert.deepEqual(progressView(12000, 100, 100),
    { pct: 100, text: `已處理 ${(12000).toLocaleString()} 筆（100%）` });
  // fallback：totalBytes=0（zip64 或欄位無效）→ 無百分比、pct 為 null
  assert.deepEqual(progressView(0, 0, 12345),
    { pct: null, text: "正在檢查檔案是否曾經匯入…" });
  assert.deepEqual(progressView(7000, 0, 12345),
    { pct: null, text: `已處理 ${(7000).toLocaleString()} 筆` });
});

test("百分比夾在 100 以內（分子異常大也不得爆表）", () => {
  assert.equal(progressView(1, 100, 250).pct, 100);
});

test("zip 匯入全程：百分比單調遞增且收在 100%", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-progress-"));
  const zipPath = path.join(dir, "export.zip");
  execFileSync("python3", ["-c", [
    "import sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:",
    "    z.write(sys.argv[2], 'apple_health_export/export.xml')",
  ].join("\n"), zipPath, FIXTURE]);

  const d = new NodeDriver();
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  const pcts = [];
  const r = await appleHealthAdapter.importSource(
    await nodeFileSource(zipPath), d,
    (processed, total, read) => {
      const v = progressView(processed, total, read);
      assert.notEqual(v.pct, null, "zip 有未壓縮大小時不得落入 fallback");
      pcts.push(v.pct);
    }, { profileId: pid });
  assert.equal(r.status, "ok");
  assert.ok(pcts.length >= 1, "至少要有收尾一次 progress");
  for (let i = 1; i < pcts.length; i++) {
    assert.ok(pcts[i] >= pcts[i - 1],
      `百分比不得倒退：第 ${i} 次 ${pcts[i]} < 前次 ${pcts[i - 1]}`);
  }
  assert.equal(pcts.at(-1), 100, "最後一次必須收在 100%（到達即完成）");
  await d.close();
});

test("zip64 fallback 端到端：totalBytes=0 貫通 adapter，匯入照常完成", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-progress64-"));
  const zipPath = path.join(dir, "export.zip");
  execFileSync("python3", ["-c", [
    "import sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:",
    "    z.write(sys.argv[2], 'apple_health_export/export.xml')",
  ].join("\n"), zipPath, FIXTURE]);
  // 把 central directory 的未壓縮大小覆成 zip64 標記（同 zip_uncomp_size 測試）
  const buf = readFileSync(zipPath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let patched = 0;
  for (let q = 0; q + 46 <= buf.length; q++) {
    if (dv.getUint32(q, true) === 0x02014b50) { dv.setUint32(q + 24, 0xFFFFFFFF, true); patched += 1; }
  }
  assert.equal(patched, 1);
  const zip64Path = path.join(dir, "export64.zip");
  writeFileSync(zip64Path, buf);

  const d = new NodeDriver();
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  const totals = [];
  const r = await appleHealthAdapter.importSource(
    await nodeFileSource(zip64Path), d,
    (processed, total, read) => {
      totals.push(total);
      assert.equal(progressView(processed, total, read).pct, null,
        "總量不可得時百分比必須為 null（fallback）");
    }, { profileId: pid });
  assert.equal(r.status, "ok", "fallback 不得影響匯入結果");
  assert.ok(totals.length >= 1);
  assert.ok(totals.every(t => t === 0), "adapter 必須把 totalBytes=0 貫通到每個事件");
  const [{ c }] = await d.select("SELECT COUNT(*) c FROM apple_records");
  assert.ok(c > 0, "資料照常入庫");
  await d.close();
});
