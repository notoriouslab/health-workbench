#!/usr/bin/env node
// Apple 健康匯入的分段效能量測：指紋、解析、入庫三段各自計時。
//
// 用產品原碼（app/src/adapters/apple_health.js）跑合成的 Apple Health 匯出 XML，
// 目的是回答「大資料量的時間花在哪一段」，而不是驗證正確性（正確性在
// app/tests/adapters/）。
//
// **每個階段各自開一個 process**：同一個 process 內連跑兩遍匯入，第二遍會被前一遍
// 的堆積與 GC 壓力拖慢（實測 100 萬筆的入庫段從乾淨 process 的 9 至 16s 跳到 23s，
// 是量測污染不是真成本）。App 端一次 session 只匯入一次，乾淨 process 才是對的
// 量測對象。
//
// 注意：這是 Node 環境的數字。App 端另有 zip 解壓兩遍與跨 Tauri IPC 的 JSON
// 傳輸成本（每批數百 KB），要據此動架構之前 MUST 先在 App 端實測一次。
//
// 用法：
//   node scripts/bench_apple_import.mjs                  # 預設 100 萬筆
//   node scripts/bench_apple_import.mjs --records 200000
//   node scripts/bench_apple_import.mjs --keep           # 保留合成檔與 DB 供檢查
//
// 基準數字（2026-08-18、MacBook Air M2、Node v25.5.0、100 萬筆合成檔 232MB，
// 每階段獨立 process、連續三輪）：
//   指紋 3.5／3.7／3.7s、解析 2.4／2.7／2.3s、
//   入庫 15.8／8.9／12.8s（磁碟同步與機器負載造成 1.8 倍變異）、
//   合計 21.8／15.3／18.8s。
// 重跑差異過大先查環境。要主張某項改動有效，MUST 同一輪連續各跑三次比較，
// NEVER 拿今天一次比上週一次。

import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 路徑不可硬編碼；用 fileURLToPath 而非 URL.pathname，後者在 Windows 與含空白的
// 路徑上會壞（多一個前導斜線、空白變 %20）。動態 import 要餵 pathToFileURL。
const SELF = fileURLToPath(import.meta.url);
const APP = path.join(path.dirname(SELF), "..", "app");
const load = (rel) => import(pathToFileURL(path.join(APP, rel)).href);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
// 上下界都要擋：只擋下界會讓負數或 NaN 一路傳到除法與迴圈，輸出無意義的數字
const RECORDS = Math.min(Math.max(Math.trunc(Number(flag("records", 1_000_000))) || 1_000_000, 1),
  50_000_000);
const KEEP = argv.includes("--keep");
const STAGE = flag("stage", null); // 子 process 專用：hash / parse / full
const XML = flag("xml", null);
const DB = flag("db", null);

const secs = (ms) => ms / 1000;
const MB = 1048576;

// 合成資料：六種型別輪替，其中一種刻意不在 WANTED 內（模擬真實匯出檔含大量不
// 收錄的型別）。startDate 有規律重複，因此自然鍵去重會吃掉一部分，入庫列數少於
// 產生列數是預期行為。
const TYPES = [
  ["HKQuantityTypeIdentifierStepCount", "count"],
  ["HKQuantityTypeIdentifierHeartRate", "count/min"],
  ["HKQuantityTypeIdentifierActiveEnergyBurned", "kcal"],
  ["HKQuantityTypeIdentifierDistanceWalkingRunning", "km"],
  ["HKQuantityTypeIdentifierBasalEnergyBurned", "kcal"],
  ["HKQuantityTypeIdentifierNotWantedProbe", "x"],
];

async function generate(xmlPath, n) {
  const out = createWriteStream(xmlPath);
  const write = async (s) => {
    if (!out.write(s)) await new Promise((r) => out.once("drain", r));
  };
  await write('<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="zh_TW">\n');
  let buf = "";
  for (let i = 0; i < n; i++) {
    const [type, unit] = TYPES[i % TYPES.length];
    const ts = `${2019 + (i % 6)}-${String(1 + (i % 12)).padStart(2, "0")}-`
      + `${String(1 + (i % 28)).padStart(2, "0")} `
      + `${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00 +0800`;
    buf += `<Record type="${type}" sourceName="Bench iPhone" sourceVersion="17.5"`
      + ` unit="${unit}" creationDate="${ts}" startDate="${ts}" endDate="${ts}"`
      + ` value="${(i % 997) + 1}"/>\n`;
    if (buf.length > 4 << 20) { await write(buf); buf = ""; }
  }
  await write(`${buf}</HealthData>\n`);
  out.end();
  await new Promise((r) => out.on("close", r));
}

// 一個階段 = 一個 process；結果以單行 JSON 回給主流程。
async function runStage(stage, xmlPath, dbPath) {
  const { NodeDriver } = await load("src/store/node_driver.js");
  const { initSchema } = await load("src/store/schema.js");
  const { appleHealthAdapter } = await load("src/adapters/apple_health.js");
  const { createProfile } = await load("src/engine/profiles.js");
  const { nodeFileSource } = await load("tests/helpers/node_source.mjs");
  const { Sha256 } = await load("src/engine/sha256.js");

  // hash：產品匯入的第一遍讀檔（純 JS SHA-256；WebCrypto 無串流介面故不可用）
  if (stage === "hash") {
    const t0 = performance.now();
    const hasher = new Sha256();
    for await (const chunk of await (await nodeFileSource(xmlPath)).stream()) hasher.update(chunk);
    hasher.hex();
    return { seconds: secs(performance.now() - t0) };
  }

  const driver = new NodeDriver(stage === "parse" ? ":memory:" : dbPath);
  await initSchema(driver);
  const profileId = await createProfile(driver, "本人");
  let jsonBytes = 0;
  if (stage === "parse") {
    // 入庫換成 no-op，但保留 JSON.stringify 成本（App 端那筆字串一定會產生並過 IPC）
    driver.batchInsert = async (_table, _cols, rows) => {
      jsonBytes += JSON.stringify(rows).length;
      return rows.length;
    };
  }
  const t0 = performance.now();
  const result = await appleHealthAdapter.importSource(
    await nodeFileSource(xmlPath), driver, null, { profileId });
  const seconds = secs(performance.now() - t0);
  if (result.status !== "ok") throw new Error(`匯入未成功：${result.status}`);
  const inserted = stage === "full"
    ? (await driver.select("SELECT COUNT(*) c FROM apple_records"))[0].c : 0;
  await driver.close();
  return { seconds, jsonBytes, inserted };
}

if (STAGE) {
  process.stdout.write(JSON.stringify(await runStage(STAGE, XML, DB)));
} else {
  const dir = await mkdtemp(path.join(tmpdir(), "hwb-bench-"));
  const xmlPath = path.join(dir, "export.xml");
  const dbPath = path.join(dir, "bench.sqlite");
  try {
    process.stdout.write(`產生 ${RECORDS.toLocaleString("en-US")} 筆合成 XML…`);
    let t0 = performance.now();
    await generate(xmlPath, RECORDS);
    const xmlBytes = (await stat(xmlPath)).size;
    console.log(` ${(xmlBytes / MB).toFixed(0)}MB（${secs(performance.now() - t0).toFixed(1)}s）`);

    const child = (stage) => JSON.parse(execFileSync(process.execPath,
      [SELF, "--stage", stage, "--xml", xmlPath, "--db", dbPath],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] }));
    const hash = child("hash");
    const parse = child("parse");
    const full = child("full");

    const tParse = parse.seconds - hash.seconds; // parse 階段本身含第一遍指紋
    const tInsert = full.seconds - parse.seconds;
    const per = (v) => (v / RECORDS) * 1_000_000;
    const dbBytes = (await stat(dbPath)).size;
    const row = (label, v, extra = "") => `${label}\t${v.toFixed(1)}s\t${per(v).toFixed(1)}s\t${extra}`;
    console.log(`
階段\t本次\t每百萬筆\t備註
${row("指紋（純 JS SHA-256）", hash.seconds, `${(xmlBytes / MB / hash.seconds).toFixed(0)} MB/s`)}
${row("解析（第二遍讀檔）", tParse, `JSON ${(parse.jsonBytes / MB).toFixed(0)}MB`)}
${row("入庫（json_each＋索引）", tInsert)}
${row("合計", full.seconds)}

產生 ${RECORDS.toLocaleString("en-US")} 筆、入庫 ${full.inserted.toLocaleString("en-US")} 筆（其餘為不收錄型別與自然鍵去重）
XML ${(xmlBytes / MB).toFixed(0)}MB、DB ${(dbBytes / MB).toFixed(0)}MB、每階段獨立 process`);
  } finally {
    if (KEEP) console.log(`\n保留於 ${dir}`);
    else await rm(dir, { recursive: true, force: true });
  }
}
