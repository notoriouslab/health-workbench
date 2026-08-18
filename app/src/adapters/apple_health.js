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
    // 解出 XML 串流工廠與顯示名（zip → 成員；否則整檔即 XML）
    const header = await source.readAt(0, Math.min(65536, source.size));
    let displayName = source.name;
    let makeStream;
    // 進度總量＝解析內容的未壓縮總量；0＝不可得，GUI 不顯示百分比
    // （app-import-engine「匯入進度回報」）
    let totalBytes;
    if (isZip(header)) {
      const member = await findZipXmlMember(source);
      if (!member) throw new Error("zip 內找不到 Apple Health XML 成員");
      displayName = `${source.name}:${member.name}`;
      makeStream = () => zipMemberStream(source, member);
      totalBytes = member.uncompSize;
    } else if (looksLikeHealthData(header)) {
      makeStream = () => source.stream();
      totalBytes = source.size;
    } else {
      throw new Error("非 Apple Health 匯出檔");
    }

    // 檔案指紋：串流計算（zip 時對解壓後 XML 內容，語意同 Python）。
    // 此階段也回報進度（processed=0 表示指紋階段），大檔（百 MB 量級 約數秒）
    // 才不會呈現無說明的等待（2026-08-10 使用者走查回饋）
    const hasher = new Sha256();
    let hashedBytes = 0;
    for await (const chunk of await makeStream()) {
      hasher.update(chunk);
      hashedBytes += chunk.length;
      progress?.(0, totalBytes, hashedBytes);
    }
    const sha256 = hasher.hex();

    const store = new EngineStore(driver);
    return driver.transaction(async () => {
      // Apple 檔無身分識別：直接歸入所選成員（歸屬正確性由 GUI 面板
      // 人眼確認，app-import-engine spec「匯入歸屬指定」）
      const pid = profile.id;
      const { docId, importedAt, originDisplayName } = await store.registerSource(
        pid, displayName, sha256, "apple_health", ADAPTER_VERSION);
      if (importedAt) {
        messages.push(`此檔案已於 ${importedAt} 匯入至成員`
          + `「${originDisplayName}」（SHA-256 相同），跳過。`);
        return { status: "skipped_duplicate", importedAt, originDisplayName, messages };
      }

      // 第二遍串流：解析＋批次入庫
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
      for await (const chunk of await makeStream()) {
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

      // 統計語意鏡像 Python（store.stats 由批次結果回填；0 時不建鍵，
      // 與 Python 逐筆計數的鍵存在性一致，import_stats 序列化才對得上）
      if (insertedRecords) store.stats.inserted.apple_records = insertedRecords;
      if (skippedRecords) store.stats.skipped_dup.apple_records = skippedRecords;

      await store.finalizeImport(docId);
      const stats = { records: scanned, workouts, parse_errors: errors };
      const report = await buildIncremental(store, {
        sections: { apple_records: { status: "parsed", ...stats } },
        sourceInfo: { filename: displayName, sha256,
          adapter: "apple_health", adapter_version: ADAPTER_VERSION },
      });
      return { status: "ok", messages, report };
    });
  },
};
