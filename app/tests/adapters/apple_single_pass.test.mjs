// 單遍匯入＋容器指紋快篩＋終點判定（change import-progress-and-single-pass T3）。
// 驗四件事：跨格式指紋等價、同 zip 快篩秒擋、重壓 zip 終點回滾、佔位值不外漏。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nodeFileSource } from "../helpers/node_source.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;
const FIXTURE = `${REPO}/tests/fixtures/apple_sample.xml`;

const sha256Of = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// fixture XML 壓成 zip（成員名照真實匯出形態）；compresslevel 供「重新壓製」情境
function makeZip(name, compresslevel) {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-singlepass-"));
  const zipPath = path.join(dir, name);
  execFileSync("python3", ["-c", [
    "import sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED,",
    `                     compresslevel=${compresslevel}) as z:`,
    "    z.write(sys.argv[2], 'apple_health_export/export.xml')",
  ].join("\n"), zipPath, FIXTURE]);
  return zipPath;
}

async function freshDriver() {
  const d = new NodeDriver();
  await initSchema(d);
  d.pid = await createProfile(d, "本人");
  return d;
}

const count = async (d, table) =>
  (await d.select(`SELECT COUNT(*) c FROM ${table}`))[0].c;
const pendingCount = (d) =>
  d.select("SELECT COUNT(*) c FROM source_documents WHERE sha256='pending'")
    .then(r => r[0].c);

test("zip 與 XML 直接匯入：內容指紋相同、逐表筆數相同、跨格式判重", async () => {
  const zipPath = makeZip("export.zip", 6);

  const a = await freshDriver();
  const rZip = await appleHealthAdapter.importSource(
    await nodeFileSource(zipPath), a, null, { profileId: a.pid });
  assert.equal(rZip.status, "ok");

  const b = await freshDriver();
  const rXml = await appleHealthAdapter.importSource(
    await nodeFileSource(FIXTURE), b, null, { profileId: b.pid });
  assert.equal(rXml.status, "ok");

  for (const t of ["apple_records", "apple_workouts"]) {
    assert.equal(await count(a, t), await count(b, t), `${t} 筆數應相同`);
  }
  const [{ sha256: viaZip }] = await a.select(
    "SELECT sha256 FROM source_documents");
  const [{ sha256: viaXml }] = await b.select(
    "SELECT sha256 FROM source_documents");
  assert.equal(viaZip, viaXml, "zip 解壓內容與 XML 檔的指紋必須相同");

  // 跨格式判重：庫 A 已收 zip，再餵原 XML 檔 → 內容指紋命中
  const rCross = await appleHealthAdapter.importSource(
    await nodeFileSource(FIXTURE), a, null, { profileId: a.pid });
  assert.equal(rCross.status, "skipped_duplicate");
  await a.close();
  await b.close();
});

test("同一顆 zip 第二次匯入：容器快篩秒擋、未進解析", async () => {
  const zipPath = makeZip("export.zip", 6);
  const d = await freshDriver();
  const r1 = await appleHealthAdapter.importSource(
    await nodeFileSource(zipPath), d, null, { profileId: d.pid });
  assert.equal(r1.status, "ok");
  const before = await count(d, "apple_records");
  const [{ imported_at: firstAt }] = await d.select(
    "SELECT imported_at FROM source_documents");

  const events = [];
  const r2 = await appleHealthAdapter.importSource(
    await nodeFileSource(zipPath), d,
    (processed, total, read) => events.push({ processed, total, read }),
    { profileId: d.pid });
  assert.equal(r2.status, "skipped_duplicate");
  assert.equal(r2.importedAt, firstAt);
  assert.match(r2.messages[0], /此檔案已於 .+ 匯入至成員「本人」（SHA-256 相同），跳過。/u);
  assert.equal(events.filter(e => e.processed > 0).length, 0,
    "快篩命中不得進解析（processed>0 的 progress 事件應為 0）");
  assert.equal(await count(d, "apple_records"), before);
  await d.close();
});

test("重新壓製（位元組不同、內容相同）的 zip：終點回滾、零殘留", async () => {
  const zipA = makeZip("export.zip", 6);
  const zipB = makeZip("export.zip", 1);
  assert.notDeepEqual(readFileSync(zipA), readFileSync(zipB),
    "兩顆 zip 位元組必須不同，否則測的是容器快篩不是終點判定");

  const d = await freshDriver();
  const r1 = await appleHealthAdapter.importSource(
    await nodeFileSource(zipA), d, null, { profileId: d.pid });
  assert.equal(r1.status, "ok");
  const snapshot = {};
  for (const t of ["apple_records", "apple_workouts", "source_documents"]) {
    snapshot[t] = await count(d, t);
  }

  const r2 = await appleHealthAdapter.importSource(
    await nodeFileSource(zipB), d, null, { profileId: d.pid });
  assert.equal(r2.status, "skipped_duplicate");
  assert.match(r2.messages[0], /SHA-256 相同/);
  for (const t of Object.keys(snapshot)) {
    assert.equal(await count(d, t), snapshot[t], `${t} 筆數不得改變`);
  }
  assert.equal(await pendingCount(d), 0, "回滾後不得殘留佔位值");
  await d.close();
});

test("佔位值不外漏（成功路徑）：sha256 與 container_sha256 為正確真值", async () => {
  const zipPath = makeZip("export.zip", 6);
  const d = await freshDriver();
  const r = await appleHealthAdapter.importSource(
    await nodeFileSource(zipPath), d, null, { profileId: d.pid });
  assert.equal(r.status, "ok");
  assert.equal(await pendingCount(d), 0);
  const [row] = await d.select(
    "SELECT sha256, container_sha256 FROM source_documents");
  assert.equal(row.sha256, sha256Of(FIXTURE),
    "內容指紋必須等於解壓後 XML（即 fixture 檔）的 SHA-256");
  assert.equal(row.container_sha256, sha256Of(zipPath),
    "容器指紋必須等於 zip 位元組的 SHA-256");
  await d.close();
});
