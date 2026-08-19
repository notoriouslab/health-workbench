// Apple Health 匯出 adapter JS 版（自 src/adapters/apple_health.py 移植；
// 行為受既有 openspec/specs/apple-health-import spec 約束）。
// 串流解析、內容判型、來源別單位正規化、品質旗標、檔內去重（自然鍵）。
import { EngineStore } from "../engine/store.js";
import { requireProfile } from "../engine/profiles.js";
import { pyFloat } from "../engine/values.js";
import { Sha256 } from "../engine/sha256.js";
import { buildIncremental } from "../engine/quality_report.js";
import { isZip, looksLikeHealthData, findZipXmlMember, zipMemberStream }
  from "../engine/bytesource.js";
import { importAggregateStatements } from "../engine/aggregate.js";

export const ADAPTER_VERSION = "1.0.0";

export const WANTED = {
  HKQuantityTypeIdentifierBodyMass: "體重",
  HKQuantityTypeIdentifierBodyMassIndex: "BMI",
  HKQuantityTypeIdentifierHeight: "身高",
  HKQuantityTypeIdentifierBodyFatPercentage: "體脂率",
  HKQuantityTypeIdentifierLeanBodyMass: "除脂體重",
  HKQuantityTypeIdentifierBloodPressureSystolic: "收縮壓",
  HKQuantityTypeIdentifierBloodPressureDiastolic: "舒張壓",
  HKQuantityTypeIdentifierHeartRate: "心率",
  HKQuantityTypeIdentifierRestingHeartRate: "安靜心率",
  HKQuantityTypeIdentifierOxygenSaturation: "血氧",
  HKQuantityTypeIdentifierRespiratoryRate: "呼吸速率",
  HKCategoryTypeIdentifierSleepAnalysis: "睡眠",
  HKQuantityTypeIdentifierStepCount: "步數",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "步行跑步距離",
  HKQuantityTypeIdentifierDistanceCycling: "騎車距離",
  HKQuantityTypeIdentifierFlightsClimbed: "爬樓層數",
  HKQuantityTypeIdentifierActiveEnergyBurned: "活動能量",
  HKQuantityTypeIdentifierBasalEnergyBurned: "基礎能量",
  HKQuantityTypeIdentifierWalkingSpeed: "步行速度",
  HKQuantityTypeIdentifierWalkingStepLength: "步幅",
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: "雙腳支撐比例",
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: "步態不對稱比例",
  HKQuantityTypeIdentifierAppleWalkingSteadiness: "行走穩定度",
  HKQuantityTypeIdentifierHeadphoneAudioExposure: "耳機音量暴露",
  HKQuantityTypeIdentifierDietaryWater: "飲水量",
  HKQuantityTypeIdentifierDietaryEnergyConsumed: "攝取熱量",
  HKQuantityTypeIdentifierDietaryFatTotal: "攝取脂肪",
  HKQuantityTypeIdentifierDietaryCarbohydrates: "攝取碳水",
  HKQuantityTypeIdentifierDietaryProtein: "攝取蛋白質",
};

// 來源別正規化規則（Python UNIT_RULES）：部分來源以 0-1 小數存體脂率
function bodyfatRule(v) {
  if (v !== null && v > 0 && v <= 1) return Math.round(v * 100 * 100) / 100;
  return null;
}
const UNIT_RULES = { 體脂率: bodyfatRule };

const RANGE_TABLE = {
  體重: [30, 200], 身高: [100, 250], BMI: [10, 60], 體脂率: [3, 60],
  收縮壓: [60, 250], 舒張壓: [30, 150], 心率: [25, 250],
};
const EPOCH_CUTOFF = "2000-01-01";

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decodeEntities = (s) =>
  s.includes("&") ? s.replace(/&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-fA-F]+);/g,
    (m, d, h) => d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ENT[m]) : s;

const ATTR_RE = /([A-Za-z_][\w.:-]*)="([^"]*)"/g;
function attrs(tag) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tag)) !== null) out[m[1]] = decodeEntities(m[2]);
  return out;
}

// 掃描完整 start tag；回傳消化位置，殘尾由呼叫端接續（跨 chunk 安全）
function scan(buf, sink) {
  let pos = 0;
  for (;;) {
    const lt = buf.indexOf("<", pos);
    if (lt === -1) return buf.length;
    // 「<」距 buffer 尾不足以判定標籤名（如殘尾「<Reco」）→ 保留給下一 chunk。
    // 漏此檢查會把切在標籤名中間的 Record 當雜訊丟棄（真實 百 MB 量級 檔實測踩中，
    // 差分對帳 數十萬 vs 數十萬 抓出；tests/adapters/apple_boundary.test.mjs 回歸）
    if (buf.length - lt < 9) return lt;
    const rest = buf.slice(lt + 1, lt + 9);
    const isRecord = rest.startsWith("Record ") || rest.startsWith("Record\t");
    const isWorkout = rest.startsWith("Workout ");
    if (!isRecord && !isWorkout) { pos = lt + 1; continue; }
    const gt = buf.indexOf(">", lt);
    if (gt === -1) return lt;
    sink(isRecord ? "Record" : "Workout",
      attrs(buf.slice(lt + 1, buf[gt - 1] === "/" ? gt - 1 : gt)));
    pos = gt + 1;
  }
}

const BATCH_FLUSH = 5000;

// 重複檔訊息：三個判定點（plain 開頭、zip 容器快篩、zip 終點）MUST 逐字同文
const dupMessage = (importedAt, originDisplayName) =>
  `此檔案已於 ${importedAt} 匯入至成員`
  + `「${originDisplayName}」（SHA-256 相同），跳過。`;

// 控制流例外：單遍匯入在交易終點才知道內容重複，丟出讓交易整筆回滾，
// 呼叫端轉成 skipped_duplicate 結果（不是錯誤）
class DuplicateContent extends Error {
  constructor(importedAt, originDisplayName) {
    super("duplicate content");
    this.importedAt = importedAt;
    this.originDisplayName = originDisplayName;
  }
}

// 解析＋批次入庫核心：zip 單遍與 plain 第二遍共用同一份（sink／flush／
// 統計不准有兩份實作）。onChunk 讓 zip 路徑在 decode 前對同一位元組流
// 累計內容指紋（值與舊兩遍法必然相同：同一 zipMemberStream 輸出）。
async function parseAndInsert(driver, stream, { pid, docId, progress, totalBytes,
  onChunk }) {
  const RECORD_COLS = ["profile_id", "doc_id", "type", "type_zh", "start_ts",
    "end_ts", "value_numeric", "value_normalized", "value_text", "unit",
    "source_name", "quality_flags"];
  const WORKOUT_COLS = ["profile_id", "doc_id", "activity", "start_ts",
    "end_ts", "duration_min", "source_name"];
  let scanned = 0, workouts = 0, errors = 0, readBytes = 0, processed = 0;
  let recordRows = [], workoutRows = [];
  let insertedRecords = 0, skippedRecords = 0;

  const flush = async () => {
    if (recordRows.length) {
      const n = await driver.batchInsert("apple_records", RECORD_COLS,
        recordRows, { ignore: true });
      insertedRecords += n;
      skippedRecords += recordRows.length - n;
      recordRows = [];
    }
    if (workoutRows.length) {
      await driver.batchInsert("apple_workouts", WORKOUT_COLS,
        workoutRows, { ignore: true });
      workoutRows = [];
    }
  };

  const sink = (kind, a) => {
    try {
      if (kind === "Workout") {
        workouts += 1;
        workoutRows.push([pid, docId,
          (a.workoutActivityType || "").replace("HKWorkoutActivityType", ""),
          (a.startDate || "").slice(0, 19), (a.endDate || "").slice(0, 19),
          pyFloat(a.duration), a.sourceName ?? null]);
        return;
      }
      const t = a.type;
      const typeZh = WANTED[t];
      if (!typeZh) return;
      scanned += 1;
      const start = (a.startDate || "").slice(0, 19);
      const end = (a.endDate || "").slice(0, 19);
      const vnum = pyFloat(a.value);
      const vtext = vnum !== null ? null : (a.value ?? null);
      const flags = [];
      let vnorm = null;
      const rule = UNIT_RULES[typeZh];
      if (rule && vnum !== null) {
        vnorm = rule(vnum, a.unit, a.sourceName);
        if (vnorm !== null) flags.push("unit_normalized");
      }
      const effective = vnorm !== null ? vnorm : vnum;
      if (start < EPOCH_CUTOFF) flags.push("epoch_placeholder_date");
      const rng = RANGE_TABLE[typeZh];
      if (rng && effective !== null && !(rng[0] <= effective && effective <= rng[1])) {
        flags.push("out_of_range");
      }
      recordRows.push([pid, docId, t, typeZh, start, end, vnum, vnorm,
        vtext, a.unit ?? null, a.sourceName ?? null, flags.join(",")]);
    } catch {
      errors += 1; // 逐筆防線
    }
  };

  const decoder = new TextDecoder("utf-8");
  let carry = "";
  for await (const chunk of stream) {
    onChunk?.(chunk);
    readBytes += chunk.length;
    carry += decoder.decode(chunk, { stream: true });
    const consumed = scan(carry, sink);
    carry = carry.slice(consumed);
    if (recordRows.length + workoutRows.length >= BATCH_FLUSH) {
      await flush();
      processed = scanned + workouts;
      progress?.(processed, totalBytes, readBytes);
    }
  }
  carry += decoder.decode();
  scan(carry, sink);
  await flush();
  // 收尾以 readBytes=totalBytes 表示完成（zip 時 source.size 是壓縮檔
  // 大小，與未壓縮分母不同單位，用它會讓最終百分比失真）
  progress?.(scanned + workouts, totalBytes, totalBytes);
  return { scanned, workouts, errors, insertedRecords, skippedRecords };
}

// 統計鏡像＋收尾＋增量報告（兩條路徑共用；語意同 Python：0 時不建鍵，
// import_stats 序列化才對得上）
async function finishImport(store, docId, parsed, sourceInfo, messages) {
  // 每日彙總（apple-health-import「匯入時每日彙總」）：交易終點、以本次
  // 觸及的鍵從全部 raw 列重算（增量日不縮小）。彙總失敗讓交易整筆回滾。
  for (const { sql, params } of importAggregateStatements()) {
    await store.driver.execute(sql, Array(params).fill(docId));
  }
  if (parsed.insertedRecords) {
    store.stats.inserted.apple_records = parsed.insertedRecords;
  }
  if (parsed.skippedRecords) {
    store.stats.skipped_dup.apple_records = parsed.skippedRecords;
  }
  await store.finalizeImport(docId);
  const stats = { records: parsed.scanned, workouts: parsed.workouts,
    parse_errors: parsed.errors };
  const report = await buildIncremental(store, {
    sections: { apple_records: { status: "parsed", ...stats } },
    sourceInfo,
  });
  return { status: "ok", messages, report };
}

export const appleHealthAdapter = {
  id: "apple_health",
  formatDesc: "Apple Health 匯出（zip、apple_health_export 資料夾或匯出 XML）",

  detect(header) {
    return isZip(header) || looksLikeHealthData(header);
  },

  // source: ByteSource（zip 檔或 XML 檔；資料夾由 GUI/測試層先解析成 XML 檔）
  async importSource(source, driver, progress, opts = {}) {
    const messages = [];
    // 歸屬驗證放最前：指紋計算是大檔昂貴步驟，缺 profileId 不該白算
    const profile = await requireProfile(driver, opts.profileId);
    const pid = profile.id;
    const header = await source.readAt(0, Math.min(65536, source.size));
    const store = new EngineStore(driver);

    if (isZip(header)) {
      const member = await findZipXmlMember(source);
      if (!member) throw new Error("zip 內找不到 Apple Health XML 成員");
      const displayName = `${source.name}:${member.name}`;
      // 進度總量＝解析內容的未壓縮總量；0＝不可得，GUI 不顯示百分比
      // （app-import-engine「匯入進度回報」）
      const totalBytes = member.uncompSize;

      // 容器指紋快篩：雜湊 zip 原始位元組（壓縮檔比內容小一個壓縮比，
      // 秒級）。命中＝同一顆檔案再匯入，免解壓免解析。此階段不發 progress。
      const containerHasher = new Sha256();
      for await (const chunk of await source.stream()) containerHasher.update(chunk);
      const containerHex = containerHasher.hex();
      const hit = await driver.select(
        "SELECT d.imported_at, p.display_name FROM source_documents d"
        + " JOIN profiles p ON d.profile_id = p.id WHERE d.container_sha256=?",
        [containerHex]);
      if (hit.length) {
        const { imported_at: importedAt, display_name: originDisplayName } = hit[0];
        messages.push(dupMessage(importedAt, originDisplayName));
        return { status: "skipped_duplicate", importedAt, originDisplayName, messages };
      }

      // 單遍匯入：同一遍解壓內算內容指紋＋解析＋入庫。內容指紋要全檔
      // 才算得出來，重複判定因此移到交易終點：命中丟 DuplicateContent
      // 讓交易整筆回滾（ROLLBACK 實測 0.03s／70 萬列，成本在插入不在回滾）
      try {
        return await driver.transaction(async () => {
          const docId = await store.registerPending(
            pid, displayName, "apple_health", ADAPTER_VERSION, containerHex);
          const contentHasher = new Sha256();
          const parsed = await parseAndInsert(driver, await zipMemberStream(source, member),
            { pid, docId, progress, totalBytes,
              onChunk: (chunk) => contentHasher.update(chunk) });
          const sha256 = contentHasher.hex();
          const dup = await store.resolveSource(docId, sha256);
          if (dup.duplicate) {
            throw new DuplicateContent(dup.importedAt, dup.originDisplayName);
          }
          return finishImport(store, docId, parsed, { filename: displayName, sha256,
            adapter: "apple_health", adapter_version: ADAPTER_VERSION }, messages);
        });
      } catch (err) {
        if (err instanceof DuplicateContent) {
          messages.push(dupMessage(err.importedAt, err.originDisplayName));
          return { status: "skipped_duplicate", importedAt: err.importedAt,
            originDisplayName: err.originDisplayName, messages };
        }
        throw err;
      }
    }

    if (!looksLikeHealthData(header)) throw new Error("非 Apple Health 匯出檔");

    // plain XML／資料夾：檔案位元組即內容，先雜湊即可判重（單遍化對
    // plain 無收益），流程與訊息維持既有兩段式。容器指紋欄位不填。
    const displayName = source.name;
    const totalBytes = source.size;
    // 此階段也回報進度（processed=0 表示指紋階段），大檔（百 MB 量級
    // 約數秒）才不會呈現無說明的等待（2026-08-10 使用者走查回饋）
    const hasher = new Sha256();
    let hashedBytes = 0;
    for await (const chunk of await source.stream()) {
      hasher.update(chunk);
      hashedBytes += chunk.length;
      progress?.(0, totalBytes, hashedBytes);
    }
    const sha256 = hasher.hex();

    return driver.transaction(async () => {
      // Apple 檔無身分識別：直接歸入所選成員（歸屬正確性由 GUI 面板
      // 人眼確認，app-import-engine spec「匯入歸屬指定」）
      const { docId, importedAt, originDisplayName } = await store.registerSource(
        pid, displayName, sha256, "apple_health", ADAPTER_VERSION);
      if (importedAt) {
        messages.push(dupMessage(importedAt, originDisplayName));
        return { status: "skipped_duplicate", importedAt, originDisplayName, messages };
      }
      const parsed = await parseAndInsert(driver, await source.stream(),
        { pid, docId, progress, totalBytes });
      return finishImport(store, docId, parsed, { filename: displayName, sha256,
        adapter: "apple_health", adapter_version: ADAPTER_VERSION }, messages);
    });
  },
};
