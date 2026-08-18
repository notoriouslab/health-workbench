// 差分對帳 harness（design D3 / app-import-engine spec 等價協定）。
// 同一組輸入檔分別經 Python adapter 與 JS 引擎匯入兩個空庫，
// 逐表 dump（外鍵解析為參照列自然鍵、排除時間戳）diff 全等才 PASS；
// 增量品質報告 JSON 一併比對。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { nhiXmlAdapter } from "../../src/adapters/nhi_xml.js";
import { appleHealthAdapter } from "../../src/adapters/apple_health.js";
import { nodeFileSource } from "../helpers/node_source.mjs";

export const REPO = new URL("../../..", import.meta.url).pathname;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

// Python 端：直接呼叫 adapter（攔截 render_text 取得報告 dict）
export function runPythonImports(files, dbPath) {
  const script = [
    "import json, sys",
    "sys.path.insert(0, '.')",
    "from pathlib import Path",
    "import src.adapters.nhi_json as nhi",
    "import src.adapters.apple_health as ap",
    "reports = []",
    "def cap(mod):",
    "    def f(r):",
    "        reports.append(r)",
    "        return ''",
    "    mod.render_text = f",
    "cap(nhi); cap(ap)",
    "db, files = sys.argv[1], json.loads(sys.argv[2])",
    "for f in files:",
    "    p = Path(f)",
    "    if p.suffix.lower() == '.json':",
    "        rc = nhi.NhiJsonAdapter().import_file(p, db_path=db, assume_profile=True)",
    "    else:",
    "        rc = ap.AppleHealthAdapter().import_file(p, db_path=db)",
    "    assert rc == 0, f'{f} rc={rc}'",
    "print(json.dumps(reports, ensure_ascii=False, default=str))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script, dbPath, JSON.stringify(files)],
    { cwd: REPO, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim().split("\n").at(-1));
}

// JS 端：依副檔名/內容路由 adapter（XML：Apple 或 NHI 以內容判別）
export async function runJsImports(files, dbPath) {
  const driver = new NodeDriver(dbPath);
  await initSchema(driver);
  // 歸屬指定（design D6）：前置建立「本人」，健保匯入時綁定 b1.1，
  // 終態 profiles 列與 Python oracle 自動建檔結果全等
  const pid = await createProfile(driver, "本人");
  const reports = [];
  for (const f of files) {
    const src = await nodeFileSource(f);
    const header = await src.readAt(0, Math.min(65536, src.size));
    let result;
    if (nhiJsonAdapter.detect(header, src.name)) {
      result = await nhiJsonAdapter.importSource(
        { bytes: new Uint8Array(readFileSync(f)), name: src.name },
        driver, null, { labEntries: LAB_ENTRIES, profileId: pid });
    } else if (nhiXmlAdapter.detect(header, src.name)) {
      result = await nhiXmlAdapter.importSource(
        { bytes: new Uint8Array(readFileSync(f)), name: src.name },
        driver, null, { labEntries: LAB_ENTRIES, profileId: pid });
    } else if (appleHealthAdapter.detect(header, src.name)) {
      result = await appleHealthAdapter.importSource(src, driver, null, { profileId: pid });
    } else {
      throw new Error(`無法判型：${f}`);
    }
    if (result.status === "skipped_duplicate") continue; // Python 端同樣不產報告
    if (result.status !== "ok") throw new Error(`${f} status=${result.status}`);
    reports.push(result.report);
  }
  await driver.close();
  return reports;
}

// dump 規則（design Implementation Contract）：排除自增 id 與 *_at 時間戳；
// 外鍵欄位解析為參照列自然鍵；import_stats 以解析後物件比對。
const FP_TABLES = ["encounters", "lab_results", "reports", "immunizations",
  "body_measurements", "cancer_screenings"];

export async function dumpDb(dbPath) {
  const d = new NodeDriver(dbPath);
  const docKey = new Map((await d.select("SELECT id, sha256 FROM source_documents"))
    .map(r => [r.id, r.sha256]));
  const profKey = new Map((await d.select("SELECT id, display_name, masked_id FROM profiles"))
    .map(r => [r.id, `${r.display_name}|${r.masked_id ?? ""}`]));
  const encKey = new Map((await d.select("SELECT id, section, record_fp FROM encounters"))
    .map(r => [r.id, `${r.section}|${r.record_fp}`]));

  const out = {};
  const canonicalize = (rows) => rows
    .map(o => [JSON.stringify(o), o]).sort((a, b) => a[0] < b[0] ? -1 : 1).map(p => p[1]);

  out.profiles = canonicalize((await d.select("SELECT * FROM profiles")).map(r => {
    const { id, created_at, ...rest } = { ...r };
    return rest;
  }));
  out.source_documents = canonicalize(
    (await d.select("SELECT * FROM source_documents")).map(r => {
      // container_sha256 為 App 端 zip 快篩專用（Python CLI 不填），
      // 依 app-import-engine spec 排除於對帳欄位
      const { id, imported_at, profile_id, import_stats, container_sha256,
        ...rest } = { ...r };
      return { ...rest, profile: profKey.get(profile_id),
        import_stats: import_stats ? JSON.parse(import_stats) : null };
    }));
  for (const t of [...FP_TABLES, "apple_records", "apple_workouts"]) {
    out[t] = canonicalize((await d.select(`SELECT * FROM ${t}`)).map(r => {
      const { id, profile_id, doc_id, ...rest } = { ...r };
      return { ...rest, profile: profKey.get(profile_id), doc: docKey.get(doc_id) };
    }));
  }
  out.medications = canonicalize((await d.select("SELECT * FROM medications")).map(r => {
    const { id, profile_id, doc_id, encounter_id, ...rest } = { ...r };
    return { ...rest, profile: profKey.get(profile_id), doc: docKey.get(doc_id),
      encounter: encKey.get(encounter_id) };
  }));
  await d.close();
  return out;
}

// 深度比對兩份 dump；回傳差異清單（空＝全等）
export function diffDumps(a, b) {
  const diffs = [];
  const tables = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const t of tables) {
    const ra = a[t] ?? [], rb = b[t] ?? [];
    if (ra.length !== rb.length) {
      diffs.push(`${t}: 筆數 ${ra.length} vs ${rb.length}`);
      continue;
    }
    for (let i = 0; i < ra.length; i++) {
      const sa = JSON.stringify(ra[i]), sb = JSON.stringify(rb[i]);
      if (sa !== sb) {
        for (const k of new Set([...Object.keys(ra[i]), ...Object.keys(rb[i])])) {
          if (JSON.stringify(ra[i][k]) !== JSON.stringify(rb[i][k])) {
            diffs.push(`${t}[${i}].${k}: ${JSON.stringify(ra[i][k])} vs ${JSON.stringify(rb[i][k])}`);
            if (diffs.length > 20) return diffs;
          }
        }
      }
    }
  }
  return diffs;
}

// 報告比對：整包深度比對（報告內無時間戳；parse_errors 訊息文字兩語言
// 必然不同，僅比筆數）
export function diffReports(pyReports, jsReports) {
  const diffs = [];
  if (pyReports.length !== jsReports.length) {
    return [`報告數 ${pyReports.length} vs ${jsReports.length}`];
  }
  const norm = (r) => {
    const c = JSON.parse(JSON.stringify(r));
    if (Array.isArray(c.source?.parse_errors)) {
      c.source.parse_errors = c.source.parse_errors.length;
    }
    return c;
  };
  for (let i = 0; i < pyReports.length; i++) {
    const pa = norm(pyReports[i]), jb = norm(jsReports[i]);
    const walk = (x, y, p) => {
      if (JSON.stringify(x) === JSON.stringify(y)) return;
      if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x)) {
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
          walk(x[k], y[k], `${p}.${k}`);
        }
        return;
      }
      diffs.push(`報告[${i}]${p}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    };
    walk(pa, jb, "");
    if (diffs.length > 20) return diffs;
  }
  return diffs;
}

export async function runParity(files, workDir) {
  const pyDb = path.join(workDir, "py.sqlite");
  const jsDb = path.join(workDir, "js.sqlite");
  const pyReports = runPythonImports(files, pyDb);
  const jsReports = await runJsImports(files, jsDb);
  const dbDiffs = diffDumps(await dumpDb(pyDb), await dumpDb(jsDb));
  const reportDiffs = diffReports(pyReports, jsReports);
  return { dbDiffs, reportDiffs };
}
