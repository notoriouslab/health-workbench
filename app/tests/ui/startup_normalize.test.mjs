// 啟動時檢驗名稱重算（change lab-order-code-normalization D3 / T3.2）。
//
// main.js 的 boot() 沒有匯出，順序只能從外部觀察，所以這裡把整層 Tauri 橋
// 換成注入 driver 的假 open 流程：window.__TAURI__.core.invoke 把 db_execute
// ／db_select 轉給一顆真的 node:sqlite NodeDriver，同時逐句記下 SQL。
// 順序（遷移 → 重算 → 讀成員）因此是由真實程式流跑出來的，不是靠讀原始碼
// 比對字串。fetch 被換成回傳指定條目，藉此也能讓重算路徑必然拋錯。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";

const ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

// 鬆化後同鍵的兩個條目 → aliasMap 拋錯 → 重算整段失敗
const COLLIDING = [
  { normalized_name: "CA-199", aliases: [] },
  { normalized_name: "Tumor X", aliases: ["CA 199"] },
];

const MIGRATE = "CREATE TABLE IF NOT EXISTS lab_results";
const NORMALIZE = "SELECT id, test_name_raw, order_code, test_name_normalized";
const PROFILE = "FROM profiles ORDER BY id";

function stubEl() {
  return { textContent: "", hidden: false, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} } };
}

// 假 open 流程：回傳 SQL 記錄陣列與 console.warn 攔截結果
function installFakeTauri(labEntries, reuseDbPath = null) {
  const dir = reuseDbPath ? path.dirname(reuseDbPath)
    : mkdtempSync(path.join(tmpdir(), "hwb-startup-"));
  const dbPath = reuseDbPath ?? path.join(dir, "db.sqlite");
  const driver = new NodeDriver(dbPath);
  const sqls = [];
  const warns = [];
  const ok = async () => {};
  globalThis.document = {
    getElementById: (id) => (id === "status" || id === "notice" ? stubEl() : null),
  };
  globalThis.window = {
    __TAURI__: {
      core: {
        async invoke(cmd, args = {}) {
          if (cmd === "env_db_override") return dbPath;
          sqls.push(args.sql);
          if (cmd === "db_execute") {
            const r = await driver.execute(args.sql, args.params ?? []);
            return [r.changes, r.lastInsertRowid];
          }
          if (cmd === "db_select") return driver.select(args.sql, args.params ?? []);
          throw new Error(`未預期的指令：${cmd}`);
        },
      },
      // settings.json 讀不到＝首次啟動（loadSettings 自行吞例外回 {}）
      fs: { mkdir: ok, exists: async () => false, writeTextFile: ok,
        async readTextFile() { throw new Error("no settings"); } },
      path: { appDataDir: async () => dir },
      event: { listen: ok },
    },
  };
  globalThis.fetch = async () => ({ json: async () => labEntries });
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a); };
  return { sqls, warns, driver, dbPath, restore: () => { console.warn = realWarn; } };
}

// 模擬 0.9.0 舊庫：一列 LDL-Cholesterol 在舊規則下對不到（NULL＋unmapped）
async function seedStaleRow(driver) {
  await initSchema(driver);
  await driver.execute("INSERT INTO profiles(id, display_name) VALUES (1, '測試成員')");
  await driver.execute(
    "INSERT INTO source_documents(id, profile_id, filename, sha256, adapter, "
    + "adapter_version) VALUES (1, 1, 'f.json', 'x', 'test', '1')");
  await driver.execute(
    "INSERT INTO lab_results(profile_id, doc_id, section, source_index, record_fp, "
    + "canonical, order_code, test_name_raw, test_name_normalized, quality_flags) "
    + "VALUES (1, 1, 'r7', 0, 'fp0', '{}', '09044C', 'LDL-Cholesterol', NULL, 'unmapped')");
}

// boot().then(wireUi) 是模組載入時自跑的鏈，沒有把柄可 await；輪詢到
// 「讀成員」出現為止（或逾時），逾時本身就是「流程沒跑完」的失敗訊號。
async function waitFor(pred, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`等待逾時：${label}`);
}

const firstIndex = (sqls, needle) => sqls.findIndex(s => s && s.includes(needle));

test("啟動順序：遷移 → 檢驗名稱重算 → 讀當前成員", async () => {
  const env = installFakeTauri(ENTRIES);
  try {
    await import(`../../src/ui/main.js?case=order`);
    await waitFor(() => firstIndex(env.sqls, PROFILE) >= 0, "讀成員");
    const [m, n, p] = [MIGRATE, NORMALIZE, PROFILE].map(x => firstIndex(env.sqls, x));
    assert.ok(m >= 0, "沒看到建表（遷移）");
    assert.ok(n >= 0, "沒看到檢驗名稱重算的 SELECT");
    assert.ok(m < n, `遷移 MUST 在重算之前（migrate=${m} normalize=${n}）`);
    assert.ok(n < p, `重算 MUST 在讀成員之前（normalize=${n} profile=${p}）`);
    assert.deepEqual(env.warns, []);
  } finally { env.restore(); }
});

test("重算拋錯只警告不阻擋：後續流程照跑完", async () => {
  const env = installFakeTauri(COLLIDING);
  try {
    await import(`../../src/ui/main.js?case=throws`);
    await waitFor(() => firstIndex(env.sqls, PROFILE) >= 0, "讀成員");
    assert.ok(firstIndex(env.sqls, MIGRATE) >= 0, "沒看到建表（遷移）");
    assert.equal(env.warns.length, 1);
    assert.equal(env.warns[0][0], "檢驗名稱重算失敗");
    assert.match(String(env.warns[0][1]?.message), /別名衝突/);
  } finally { env.restore(); }
});

test("升版後開啟舊資料庫：unmapped 列自動帶正規名，再次啟動零列變動", async () => {
  const env = installFakeTauri(ENTRIES);
  try {
    await seedStaleRow(env.driver);
    await import(`../../src/ui/main.js?case=stale-first`);
    await waitFor(() => firstIndex(env.sqls, PROFILE) >= 0, "讀成員");
    const [row] = await env.driver.select(
      "SELECT test_name_normalized, quality_flags FROM lab_results WHERE test_name_raw='LDL-Cholesterol'");
    assert.deepEqual({ ...row }, { test_name_normalized: "LDL-C", quality_flags: "" });
    assert.ok(env.sqls.some(s => s && s.startsWith("UPDATE lab_results")), "第一次啟動應寫入該列");
    assert.deepEqual(env.warns, []);
  } finally { env.restore(); }
  // 第二次啟動：同一顆庫，MUST NOT 再寫任何 lab_results 列
  const env2 = installFakeTauri(ENTRIES, env.dbPath);
  try {
    await import(`../../src/ui/main.js?case=stale-second`);
    await waitFor(() => firstIndex(env2.sqls, PROFILE) >= 0, "讀成員（第二次）");
    assert.ok(firstIndex(env2.sqls, NORMALIZE) >= 0, "第二次啟動仍有重算 SELECT");
    assert.equal(env2.sqls.filter(s => s && s.startsWith("UPDATE lab_results")).length, 0);
  } finally { env2.restore(); }
});
