// 公開倉庫的個資守衛（2026-08-14）。
//
// 為什麼需要這個：這個 repo 是公開的，而專案的驗證素材是真人的健康資料。
// 2026-08-12 曾人工做過一次「全面中性化改寫」，兩天後在 HEAD 又找到 30 個
// 檔案帶真實數值（就醫科別分佈、CPAP 使用天數與事件數、量測序列點數、
// 資料庫規模、體重離群值）。人工改寫不會收斂，必須有機器擋。
//
// 分工（2026-08-14 決定）：
//   - 開發過程紀錄（proposal／design／驗證紀錄／交接文件）**整批不入公開庫**
//     （見 .gitignore）。那些檔案的存在目的就是記錄實測，偵測型守衛擋得住
//     數字，卻擋不住「所有 session 都在 20:00 至 22:00 開始」這種敘述型的
//     健康資訊，所以用結構性隔離而非偵測。
//   - 留在公開庫的規格、CHANGELOG 與 README 天然不該出現實測數字，由這裡
//     以嚴格規則守住。
//
// 判準：同一行同時出現「三位數以上的數字（或 N 萬）」與「健康／資料量術語」
// 即視為可疑，除非命中白名單。要寫效能或容量要求時請寫量級（「百 MB 量級
// 檔案 MUST 於 60 秒內完成匯入」），不要寫某一份真實檔案的大小與筆數。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;

// 掃描範圍：留在公開庫且不該有實測數字的文字檔
const SCAN = ["openspec/specs", "CHANGELOG.md", "README.md"];

// 兩條判準（2026-08-14 經稽核與紅隊各找到一個漏洞後改寫）：
//   A 資料規模類：三位數以上的數字 × 資料量術語（筆數、天數、檔案大小）
//   B 臨床量測類：**任何位數**的數字 × 生理量測術語。門檻不能設在三位數，
//     因為 AHI、血氧、體重、心率這些最敏感的臨床值多半是一到兩位數
//     （紅隊實測：「體重 68 公斤，血氧 88，AHI 45」原本完全不會被攔）。
const BIG_NUMBER = /(?:\d{1,3}(?:,\d{3})+|\d{3,}|\d+(?:\.\d+)?\s*萬)/;
const ANY_NUMBER = /\d/;
const SCALE_TERM = new RegExp([
  "晚", "夜", "天", "筆", "列", "事件", "摘要", "就醫", "用藥", "藥品",
  "檢驗", "疫苗", "癌篩", "運動", "步數", "睡眠", "MB", "萬", "點",
].join("|"));
const CLINICAL_TERM =
  /AHI|血氧|SpO2|體重|體脂|BMI|心率|脈搏|血壓|公斤|\bkg\b|次\/小時/i;

// 安全片段：在判定前**逐段消去**，而不是整行豁免。
//
// 為什麼不能整行豁免（稽核發現）：原本只要同一行命中任一條白名單就整行放行，
// 於是「2024-03-15 該晚 AHI 187 次事件」會因為含日期而通過。現行內容裡也
// 已經有一行（app-import-engine spec 的每批 20000 列）是靠同行的日期巧合
// 通過，而不是正規走「加進白名單並附理由」的流程。
//
// 新增條目 MUST 附理由，且 MUST 是與真實個人資料無關的數字。
const SAFE_FRAGMENTS = [
  [/\b\d{4}-\d{2}-\d{2}\b/g, "日期"],
  [/"20\d\d-\d\d"/g, "年月字串（序列日期格式）"],
  [/\br\d+[._]\d+/g, "健保節區代碼"],
  [/\b1970\b/g, "epoch 佔位日期"],
  [/\b(365|366)\b/g, "一年：區間與保留範圍的設計值"],
  [/\b(300|2000|8000|8,000|20000)\b/g, "上限與批次大小的設計值"],
  [/\b(119|237|238|400)\b/g, "標記降級門檻，由繪圖區寬度推導"],
  [/\b5000\b/g, "進度回報間隔"],
  [/<\s*30\b|>\s*200\s*kg/g, "體重合理範圍的驗證邊界（規則本身，非某人的量測值）"],
  [/\b0\.255\b|\b25\.5\b/g, "體脂率單位換算的示範值"],
  [/\b(6,000|7,500|13,500)\b/g, "步數防雙計的構造示範（非某日真實步數）"],
  [/220\s*MB|90\s*萬元素|90\s*萬/g, "去識別化合成檔的規模"],
  // 註：\b 只認 ASCII word char，緊鄰中文字時不成立，中文樣式不要加 \b
  [/10\s*萬筆/g, "效能測試的合成資料規模（非真實庫筆數）"],
  [/"20\d{6}"/g, "健保欄位的 YYYYMMDD 日期範例值"],
  [/\b10\s*MB\b/g, "單檔 HTML 上限"],
  [/\b100\s*MB\b/g, "匯入效能契約的檔案大小下界（規格常數，非某個真實檔案）"],
  [/\b60\s*秒|\b60s\b/g, "匯入耗時契約"],
  [/百\s*MB\s*量級|數十萬|數百|數千|逾千|十餘|數萬/g, "已量級化的表述"],
  [/(?:container_)?sha256|SHA-256/g, "雜湊演算法名與欄位識別字（規格常數，256 是演算法位元數不是量測值）"],
];

// 消去所有已知安全片段後，剩下的才拿去判定
function strip(line) {
  return SAFE_FRAGMENTS.reduce((s, [re]) => s.replace(re, " "), line);
}

function walk(p) {
  const abs = join(ROOT, p);
  if (statSync(abs).isFile()) return [p];
  return readdirSync(abs).flatMap((e) => walk(join(p, e)));
}

const files = SCAN.flatMap(walk).filter((f) => f.endsWith(".md"));

function suspicious(line) {
  const s = strip(line);
  if (BIG_NUMBER.test(s) && SCALE_TERM.test(s)) return "資料規模";
  if (ANY_NUMBER.test(s) && CLINICAL_TERM.test(s)) return "臨床量測";
  return null;
}

test("公開倉庫的規格與說明文件不得出現實測的個人資料數值", () => {
  assert.ok(files.length >= 12, `只掃到 ${files.length} 個檔案，掃描範圍可能已失效`);
  const hits = [];
  for (const f of files) {
    const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      const kind = suspicious(line);
      if (kind) hits.push(`${f}:${i + 1}  [${kind}]  ${line.trim().slice(0, 84)}`);
    });
  }
  assert.deepEqual(hits, [],
    "以上各行在消去已知安全片段後，仍同時出現數字與健康術語。若是真實資料的"
    + "實測值，請改寫為量級描述；若是設計常數或合成素材規模，請加進"
    + " SAFE_FRAGMENTS 並註明理由");
});

// 守衛自身的效力測試：這兩條漏洞分別由中立稽核與紅隊在 2026-08-14 找到，
// 修好後 MUST 留下回歸測試，否則下次改寫判準時會無聲退回原狀。
test("守衛不得被「同行有日期」整行豁免（稽核發現的漏洞）", () => {
  assert.ok(suspicious("2024-03-15 該晚 AHI 187 次事件，睡眠品質差"),
    "同行帶日期不得使其餘數字一併過關");
  assert.ok(!suspicious("- **WHEN** 匯入 startDate=1970-01-02 的體重紀錄"),
    "純日期與 epoch 佔位值仍應放行");
});

test("守衛必須攔得住一到兩位數的臨床量測值（紅隊發現的漏洞）", () => {
  for (const s of ["受試者體重 68 公斤", "本人 AHI 為 32，屬於中重度",
    "血氧最低降到 88", "靜息心率 58"]) {
    assert.ok(suspicious(s), `應攔下：${s}`);
  }
  assert.ok(!suspicious("（如體重 <30 或 >200 kg）標記 out_of_range"),
    "驗證邊界是規則本身，不是某人的量測值");
});

test("開發過程紀錄不得被追蹤進公開倉庫", async () => {
  const { execFileSync } = await import("node:child_process");
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
  const forbidden = tracked.filter((f) =>
    f.startsWith("openspec/changes/")
    || f.startsWith("docs/verification/")
    || f.startsWith("docs/spikes/")
    || /^docs\/.*handoff.*\.md$/.test(f)
    || f === "docs/20260808_phase0_findings.md");
  assert.deepEqual(forbidden, [],
    "這些路徑記錄的是對真人健康資料的實測，MUST NOT 進公開倉庫（見 .gitignore）");
});
