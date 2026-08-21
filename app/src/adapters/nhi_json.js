// 健保存摺醫療類 JSON adapter JS 版（自 src/adapters/nhi_json.py 移植；
// 行為受既有 openspec/specs/nhi-import spec 約束，差分驗收見 tests/parity/）。
// 與 Python 版刻意不同處僅一項：判型純看內容不看副檔名（app-import-engine spec）。
import * as fm from "./nhi_fieldmap.js";
import { EngineStore } from "../engine/store.js";
import { requireProfile } from "../engine/profiles.js";
import { toNum, normDate } from "../engine/values.js";
import { pyJsonDumps, sha256Hex } from "../engine/fingerprint.js";
import { buildIncremental } from "../engine/quality_report.js";
import { applyNormalization } from "../knowledge/labs.js";

export const ADAPTER_VERSION = "1.0.0";
const NO_DATA = "無資料";

// (事件型別, 日期鍵, 院所名, 院所代碼, 診斷碼, 診斷名, 部分負擔, 支付點數, 就醫序號, 欄位表)
const ENCOUNTER_SECTIONS = {
  r1: ["western_outpatient", "r1.5", "r1.4", "r1.3", "r1.8", "r1.9", "r1.12", "r1.13", "r1.7", fm.R1],
  r3: ["dental", "r3.5", "r3.4", "r3.3", "r3.7", "r3.8", "r3.11", "r3.12", "r3.6", fm.R3],
  r9: ["tcm", "r9.5", "r9.4", "r9.3", "r9.7", "r9.8", "r9.11", "r9.12", "r9.6", fm.R9],
};
const KNOWN_FIELDS = {
  r1: { ...fm.R1, r1_1: null }, r3: { ...fm.R3, r3_1: null },
  r9: { ...fm.R9, r9_1: null }, r6: fm.R6, r7: fm.R7,
  r8: fm.R8, r10: fm.R10, r11: { ...fm.R11, r11_1: null },
};

function isNoData(rows, sec) {
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const keys = Object.keys(rows[0]);
  return (keys.length === 1 && (keys[0] === sec || keys[0] === sec.toUpperCase())
    && rows[0][keys[0]] === NO_DATA);
}

export const stripBom = (s) => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;

// 健保署匯出的報告類自由文字欄位（如 r8.10 影像／病理報告）會塞入未跳脫的原始
// 控制字元，例如聽力檢查用 TAB 對齊左右耳結果。這違反 RFC 8259，但確實是官方
// 匯出工具的真實輸出，JSON.parse 會讓整批匯入在解析階段就中止，連逐筆 guard()
// 防線都來不及發揮。Python 版用 json.loads(strict=False) 容忍；JS 沒有對應開關，
// 因此自行跳脫字串內的原始控制字元。值刻意保留原字元不做替換：報告以等寬
// pre-wrap 呈現，TAB 的對齊有意義。兩實作等價性由 tests/parity/ 釘住。
const CTRL_ESCAPES = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
const escapeCtrl = (code) =>
  CTRL_ESCAPES[code] ?? "\\u" + code.toString(16).padStart(4, "0");

// 只跳脫「字串內」的原始控制字元，故必須追蹤 in-string 與反斜線跳脫狀態。
// NEVER 簡化成全域 replace：健保署檔案是格式化多行 JSON，全域替換會把結構
// 縮排的 TAB 與換行一起跳脫，JSON 從第一個字元就壞掉（tests 有負向對照）。
export function escapeRawCtrlInStrings(text) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], code = text.charCodeAt(i);
    if (esc) { out += ch; esc = false; continue; }
    if (inStr) {
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (code < 0x20) { out += escapeCtrl(code); continue; }
      out += ch; continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

// 先照規格解析；失敗才付出一次 O(n) 掃描的代價重試（正常檔案零成本）。
// 刻意不比對錯誤訊息文字來判斷是否為控制字元問題：那是引擎措辭，不同 V8
// 版本會變，一變就靜默退回原本的整批中止。重試仍失敗則拋原始錯誤（貼近真因）。
export function parseJsonTolerant(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    try {
      return JSON.parse(escapeRawCtrlInStrings(text));
    } catch {
      throw err;
    }
  }
}

export const nhiJsonAdapter = {
  id: "nhi_json",
  formatDesc: "健保存摺醫療類 JSON（健康存摺醫療類_*.json）",

  detect(header) {
    try {
      const head = new TextDecoder("utf-8").decode(header.subarray(0, 2048));
      return head.includes('"myhealthbank"');
    } catch {
      return false;
    }
  },

  // source: { bytes: Uint8Array, name: string }
  async importSource(source, driver, progress, opts = {}) {
    const data = parseJsonTolerant(
      stripBom(new TextDecoder("utf-8").decode(source.bytes)));
    const bdata = Object.fromEntries(
      Object.entries(data.myhealthbank.bdata).map(([k, v]) => [k.toLowerCase(), v]));
    return importNhiBdata(bdata, {
      name: source.name, sha256: await sha256Hex(source.bytes),
      adapter: "nhi_json",
    }, driver, progress, opts);
  },
};

// JSON/XML 共用的匯入核心：bdata 形狀＝JSON 版 myhealthbank.bdata。
// meta: { name, sha256, adapter, formatVariant? }
// opts: { labEntries, profileId }（profileId 必填：匯入歸屬指定，
// app-import-engine spec；缺省或失效即錯，NEVER 回退第一個成員）
// 回傳 { status: "ok"|"aborted"|"skipped_duplicate", messages, report? }
export async function importNhiBdata(bdata, meta, driver, progress, opts = {}) {
  const messages = [];
  const sha256 = meta.sha256;
  const maskedId = (bdata["b1.1"] || "").trim();
  const store = new EngineStore(driver);
  const profile = await requireProfile(driver, opts.profileId);

  return driver.transaction(async () => {
      // 重複檔判定先於歸戶護欄（Jenny 稽核修正，2026-08-10）：同一檔案
      // 不論本次歸屬選誰，一律以「已於（時間）匯入至成員 X」跳過——
      // 「這檔已匯過」比「你選錯人了」更貼近事實（app-import-engine/
      // app-import-gui spec 跨成員重複檔 scenario）。未命中時插入的
      // source_documents 列若隨後被護欄中止，由交易回滾清除（零寫入）。
      const pid = profile.id;
      const { docId, importedAt, originDisplayName } = await store.registerSource(
        pid, meta.name, sha256, meta.adapter, ADAPTER_VERSION);
      if (importedAt) {
        messages.push(`此檔案已於 ${importedAt} 匯入至成員`
          + `「${originDisplayName}」（SHA-256 相同），跳過。`);
        return { status: "skipped_duplicate", importedAt, originDisplayName, messages };
      }

      // 遮罩身分證護欄（對所選成員）：缺 b1.1 中止／已綁定必須相符／
      // 未綁定先查身分證未屬他人再綁定（選錯成員防護）
      if (!maskedId) {
        messages.push("匯入中止：檔案缺少遮罩身分證（b1.1），無法確認歸戶。");
        throw new AbortImport(messages);
      }
      if (profile.masked_id) {
        if (profile.masked_id !== maskedId) {
          messages.push(`匯入中止：檔案遮罩身分證 ${maskedId} 與成員`
            + `「${profile.display_name}」已綁定的 ${profile.masked_id} 不符。`
            + "資料庫未寫入任何資料。");
          throw new AbortImport(messages);
        }
      } else {
        const [taken] = await driver.select(
          "SELECT display_name FROM profiles WHERE masked_id=? AND id!=?",
          [maskedId, pid]);
        if (taken) {
          messages.push(`匯入中止：檔案遮罩身分證 ${maskedId} 已屬於成員`
            + `「${taken.display_name}」，請改選該成員後重新匯入。`
            + "資料庫未寫入任何資料。");
          throw new AbortImport(messages);
        }
        await driver.execute("UPDATE profiles SET masked_id=? WHERE id=?", [maskedId, pid]);
        messages.push(`已將遮罩身分證 ${maskedId} 綁定至成員「${profile.display_name}」。`);
      }

      const sections = {};
      const unknownFields = {};
      const parseErrors = [];

      const guard = async (sec, i, fn) => {
        // 單筆解析失敗：記錄後續行，NEVER 讓整批中止或靜默丟棄
        try {
          await fn();
          return true;
        } catch (e) {
          if (e instanceof AbortImport) throw e;
          parseErrors.push(`${sec}[${i}] ${e.name}: ${e.message}`);
          return false;
        }
      };

      const noteUnknown = (sec, rec) => {
        const known = KNOWN_FIELDS[sec] || {};
        const extra = {};
        for (const [k, v] of Object.entries(rec)) {
          if (!(k in known) && !k.endsWith("_1") && v !== null && v !== "" && v !== undefined) {
            extra[k] = v;
            unknownFields[sec] = unknownFields[sec] || {};
            unknownFields[sec][k] = (unknownFields[sec][k] || 0) + 1;
          }
        }
        return extra;
      };

      // --- 就醫事件（r1/r3/r9）與巢狀醫囑 ---
      let medExpected = 0;
      for (const [sec, [etype, dkey, fnameK, fcodeK, dxcK, dxnK, copayK, ptsK, seqK]]
        of Object.entries(ENCOUNTER_SECTIONS)) {
        const rows = bdata[sec] || [];
        if (isNoData(rows, sec)) {
          sections[sec] = { status: "no_data", records: 0 };
          continue;
        }
        let nOut = 0;
        for (let i = 0; i < rows.length; i++) {
          const rec = rows[i];
          await guard(sec, i, async () => {
            const extra = noteUnknown(sec, rec);
            let d = normDate(rec[dkey]);
            let recType = etype;
            const flags = [];
            if (d === null && sec === "r1" && normDate(rec["r1.6"])) {
              d = normDate(rec["r1.6"]);
              recType = "pharmacy_dispensing";
            }
            if (d === null) flags.push("missing_date");
            const result = await store.insertFpRecord("encounters", rec, {
              profileId: pid, docId, section: sec, sourceIndex: i,
              qualityFlags: flags.join(","),
              columns: { type: recType, date: d,
                visit_seq: rec[seqK] ?? null,
                facility_name: rec[fnameK] ?? null,
                facility_code: rec[fcodeK] ?? null,
                dx_code: rec[dxcK] ?? null, dx_name: rec[dxnK] ?? null,
                copay: toNum(rec[copayK]), nhi_points: toNum(rec[ptsK]),
                extra_json: Object.keys(extra).length
                  ? pyJsonDumps(extra, { sortKeys: false }) : null },
            });
            const subKey = `${sec}_1`;
            const meds = rec[subKey] || [];
            medExpected += meds.length;
            if (result === "inserted") {
              nOut += 1;
              const encId = store.lastInsertId;
              for (let j = 0; j < meds.length; j++) {
                const med = meds[j];
                const daysKey = sec === "r3" ? `${subKey}.6` : `${subKey}.4`;
                await store.insertMedication({
                  profileId: pid, docId, encounterId: encId,
                  section: `${sec}>${subKey}`, sourceIndex: j,
                  order_code: med[`${subKey}.1`] ?? null,
                  order_name: med[`${subKey}.2`] ?? null,
                  total_qty: toNum(med[`${subKey}.3`]),
                  days_supply: toNum(med[daysKey]),
                  tooth_code: sec === "r3" ? (med[`${subKey}.4`] ?? null) : null,
                  tooth_name: sec === "r3" ? (med[`${subKey}.5`] ?? null) : null,
                });
              }
            }
          });
        }
        sections[sec] = { status: "parsed", records: rows.length, inserted: nOut };
      }

      // --- r7 檢驗 ---
      {
        const rows = bdata.r7 || [];
        if (isNoData(rows, "r7")) {
          sections.r7 = { status: "no_data", records: 0 };
        } else {
          for (let i = 0; i < rows.length; i++) {
            const rec = rows[i];
            await guard("r7", i, async () => {
              noteUnknown("r7", rec);
              const vt = rec["r7.11"];
              const vnum = toNum(vt);
              const flags = [];
              if (vt === null || vt === "" || vt === undefined) flags.push("missing_value");
              else if (vnum === null) flags.push("non_numeric_value");
              if (rec["r7.12"] === null || rec["r7.12"] === "" || rec["r7.12"] === undefined) {
                flags.push("missing_ref_range");
              }
              await store.insertFpRecord("lab_results", rec, {
                profileId: pid, docId, section: "r7", sourceIndex: i,
                qualityFlags: flags.join(","),
                columns: { visit_date: normDate(rec["r7.5"]), test_date: normDate(rec["r7.6"]),
                  facility_name: rec["r7.4"] ?? null,
                  order_code: rec["r7.8"] ?? null, order_name: rec["r7.9"] ?? null,
                  test_name_raw: rec["r7.10"] ?? null,
                  value_text: vt ?? null, value_numeric: vnum,
                  ref_range: rec["r7.12"] ?? null },
              });
            });
          }
          sections.r7 = { status: "parsed", records: rows.length };
        }
      }

      // --- r8 影像病理 ---
      {
        const rows = bdata.r8 || [];
        if (isNoData(rows, "r8")) {
          sections.r8 = { status: "no_data", records: 0 };
        } else {
          for (let i = 0; i < rows.length; i++) {
            const rec = rows[i];
            await guard("r8", i, async () => {
              noteUnknown("r8", rec);
              await store.insertFpRecord("reports", rec, {
                profileId: pid, docId, section: "r8", sourceIndex: i,
                columns: { visit_date: normDate(rec["r8.5"]), test_date: normDate(rec["r8.6"]),
                  facility_name: rec["r8.4"] ?? null,
                  order_code: rec["r8.8"] ?? null, order_name: rec["r8.9"] ?? null,
                  report_text: rec["r8.10"] ?? null },
              });
            });
          }
          sections.r8 = { status: "parsed", records: rows.length };
        }
      }

      // --- r6 疫苗 ---
      {
        const rows = bdata.r6 || [];
        if (isNoData(rows, "r6")) {
          sections.r6 = { status: "no_data", records: 0 };
        } else {
          for (let i = 0; i < rows.length; i++) {
            const rec = rows[i];
            await guard("r6", i, async () => {
              noteUnknown("r6", rec);
              await store.insertFpRecord("immunizations", rec, {
                profileId: pid, docId, section: "r6", sourceIndex: i,
                columns: { date: normDate(rec["r6.1"]),
                  vaccine_name: rec["r6.3"] ?? null,
                  facility_name: rec["r6.5"] ?? null },
              });
            });
          }
          sections.r6 = { status: "parsed", records: rows.length };
        }
      }

      // --- r10 成健 ---
      {
        const rows = bdata.r10 || [];
        if (isNoData(rows, "r10")) {
          sections.r10 = { status: "no_data", records: 0 };
        } else {
          for (let i = 0; i < rows.length; i++) {
            const rec = rows[i];
            await guard("r10", i, async () => {
              const extra = {};
              for (const [k, v] of Object.entries(rec)) {
                if (v !== null && v !== "" && v !== undefined) extra[fm.R10[k] ?? k] = v;
              }
              await store.insertFpRecord("body_measurements", rec, {
                profileId: pid, docId, section: "r10", sourceIndex: i,
                columns: { check_date: normDate(rec["r10.5"]),
                  height_cm: toNum(rec["r10.6"]), weight_kg: toNum(rec["r10.7"]),
                  bmi: toNum(rec["r10.8"]), waist: toNum(rec["r10.9"]),
                  systolic: toNum(rec["r10.10"]), diastolic: toNum(rec["r10.11"]),
                  extra_json: pyJsonDumps(extra, { sortKeys: false }) },
              });
            });
          }
          sections.r10 = { status: "parsed", records: rows.length };
        }
      }

      // --- r11 癌篩 ---
      {
        const rows = bdata.r11 || [];
        if (isNoData(rows, "r11")) {
          sections.r11 = { status: "no_data", records: 0 };
        } else {
          for (let i = 0; i < rows.length; i++) {
            const rec = rows[i];
            await guard("r11", i, async () => {
              noteUnknown("r11", rec);
              await store.insertFpRecord("cancer_screenings", rec, {
                profileId: pid, docId, section: "r11", sourceIndex: i,
                columns: { category: rec["r11.1"] ?? null, item_name: rec["r11.2"] ?? null,
                  detail_json: pyJsonDumps(rec.r11_1 ?? [], { sortKeys: false }) },
              });
            });
          }
          sections.r11 = { status: "parsed", records: rows.length };
        }
      }

      // --- 其餘節區與未知節區 ---
      for (const sec of ["r2", "r4", "r5", "r12", "r13", "r14"]) {
        const rows = bdata[sec] || [];
        if (isNoData(rows, sec)) sections[sec] = { status: "no_data", records: 0 };
        else if (rows.length) sections[sec] = { status: "UNPARSED_HAS_DATA", records: rows.length };
      }
      const knownSecs = new Set([...Object.keys(ENCOUNTER_SECTIONS), "r0", "r2", "r4", "r5",
        "r6", "r7", "r8", "r10", "r11", "r12", "r13", "r14", "b1.1", "b1.2"]);
      for (const sec of Object.keys(bdata)) {
        if (!knownSecs.has(sec)) {
          sections[sec] = { status: "UNKNOWN_SECTION", records: bdata[sec].length };
        }
      }

      // XML 官方格式無 r9-r14（格式事實，非資料異常）
      if (meta.formatVariant === "xml") {
        for (const sec of ["r9", "r10", "r11", "r12", "r13", "r14"]) {
          if (!(sec in bdata)) {
            sections[sec] = { status: "no_data", records: 0, note: "XML 格式無此節區" };
          }
        }
      }

      // 檢驗名稱正規化（D5）：冪等重算全部 lab_results
      await applyNormalization(store, opts.labEntries ?? []);

      const medInserted = store.stats.inserted.medications || 0;
      const reconciliation = { expected_in_file: medExpected, inserted_new: medInserted,
        note: "重複匯入時 inserted_new < expected_in_file 為正常（紀錄已存在）" };

      await store.finalizeImport(docId);
      const report = await buildIncremental(store, {
        sections,
        sourceInfo: { filename: meta.name, sha256,
          adapter: meta.adapter, adapter_version: ADAPTER_VERSION,
          unknown_fields: unknownFields, parse_errors: parseErrors,
          medication_reconciliation: reconciliation },
      });
      return { status: "ok", messages, report };
  }).catch((e) => {
    if (e instanceof AbortImport) return { status: "aborted", messages: e.messages };
    throw e;
  });
}

class AbortImport extends Error {
  constructor(messages) {
    super(messages[messages.length - 1] || "匯入中止");
    this.name = "AbortImport";
    this.messages = messages;
  }
}
