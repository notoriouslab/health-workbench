import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { nodeFileSource } from "../helpers/node_source.mjs";
import { buildPayload } from "../../src/provider/payload.js";
import { assemble, validateShape, toEmbeddedJson } from "../../src/provider/assemble.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));
// Python 端 build_payload 讀 body_refs.yaml，JS 端傳建置產物 json：
// 兩者同源（body_refs_json_fresh 守衛），parity 全等即證兩端一致
const BODY_REFS = JSON.parse(
  readFileSync(new URL("../../src/knowledge/body_refs.json", import.meta.url), "utf-8"));

// 建一個含兩來源的庫（檔案落地，Python 端要讀同一顆）
async function buildDb(dbPath) {
  const d = new NodeDriver(dbPath);
  await initSchema(d);
  const pid = await createProfile(d, "本人");
  d.pid = pid;
  await nhiJsonAdapter.importSource(
    { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
      name: "nhi_sample.json" },
    d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_sample.xml`), d, null,
    { profileId: pid });
  // Watch 樣態素材（心率多筆／日、睡眠多識別字含雙來源同日、呼吸速率、
  // 血氧）：讓 measure_bands 與 sleep_daily 在兩端 parity 中有非空內容
  await appleHealthAdapter.importSource(
    await nodeFileSource(`${REPO}/tests/fixtures/apple_watch_sample.xml`), d, null,
    { profileId: pid });
  return d;
}

function pyPayload(dbPath) {
  const out = execFileSync("python3", ["-c", [
    "import json, sys",
    "sys.path.insert(0, '.')",
    "from src.store.db import Store",
    "from src.dashboard.embed import build_payload",
    `db = ${JSON.stringify(dbPath)}`,
    "s = Store(db)",
    "p, _ = build_payload(s, db)",
    "s.close()",
    "print(json.dumps(p, ensure_ascii=False, default=str))",
  ].join("\n")], { cwd: REPO, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim().split("\n").at(-1));
}

const stripTs = (p) => { const c = JSON.parse(JSON.stringify(p)); delete c.meta.generated_at; return c; };

test("provider 同構：JS payload 與 Python build_payload 數值全等", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-prov-"));
  const dbPath = path.join(tmp, "db.sqlite");
  const d = await buildDb(dbPath);
  const js = await buildPayload(d, { profileId: d.pid, bodyRefs: BODY_REFS,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: null, today: "2026-08-09" });
  await d.close();
  assert.deepEqual(validateShape(js), []);
  const py = pyPayload(dbPath);
  assert.deepEqual(stripTs(JSON.parse(JSON.stringify(js))), stripTs(py));
});

test("匯出同構：assemble 輸出的嵌入資料與 hwb rebuild 產出全等", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hwb-exp-"));
  const dbPath = path.join(tmp, "db.sqlite");
  const d = await buildDb(dbPath);
  const js = await buildPayload(d, { profileId: d.pid, bodyRefs: BODY_REFS,
    knowledgeEntries: LAB_ENTRIES, drugCachePath: null, today: "2026-08-09" });
  await d.close();

  const assets = {
    appJs: readFileSync(`${REPO}/app/src/viewer/assets/app.js`, "utf-8"),
    css: readFileSync(`${REPO}/app/src/viewer/assets/style.css`, "utf-8"),
    vendor: ["preact.min.js", "hooks.umd.js", "htm.umd.js"].map(
      f => readFileSync(`${REPO}/app/src/viewer/assets/vendor/${f}`, "utf-8")),
  };
  const html = assemble(js, assets);

  execFileSync("python3", ["-m", "src.hwb_cli", "--db", dbPath, "rebuild",
    "--out", tmp], { cwd: REPO, encoding: "utf-8" });
  const pyHtml = readFileSync(path.join(tmp,
    readdirSync(tmp).find(f => f.endsWith(".html"))), "utf-8");

  const extract = (h) => JSON.parse(
    h.match(/<script type="application\/json" id="hwb-data">(.*?)<\/script>/s)[1]
      .replaceAll("\\u003c", "<").replaceAll("\\u003e", ">").replaceAll("\\u0026", "&"));
  assert.deepEqual(stripTs(extract(html)), stripTs(extract(pyHtml)));
});

test("跳脫安全：payload 含 </script> 不逃逸", () => {
  const s = toEmbeddedJson({ x: "</script><b>攻擊</b> & more" });
  assert.ok(!s.includes("</script>"));
  assert.ok(!s.includes("<"));
});

test("資產防漂移：viewer/assets 與 src/dashboard 逐位元組相同", () => {
  for (const [a, b] of [
    ["app/src/viewer/assets/app.js", "src/dashboard/app.js"],
    ["app/src/viewer/assets/style.css", "src/dashboard/style.css"],
    ["app/src/viewer/assets/vendor/preact.min.js", "src/dashboard/vendor/preact.min.js"],
    ["app/src/viewer/assets/vendor/hooks.umd.js", "src/dashboard/vendor/hooks.umd.js"],
    ["app/src/viewer/assets/vendor/htm.umd.js", "src/dashboard/vendor/htm.umd.js"],
  ]) {
    assert.equal(readFileSync(`${REPO}/${a}`, "utf-8"),
      readFileSync(`${REPO}/${b}`, "utf-8"), `${a} 與 ${b} 漂移`);
  }
});
