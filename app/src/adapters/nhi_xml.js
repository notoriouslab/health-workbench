// 健保存摺醫療類 XML adapter（app-import-engine spec：r1-r14 與 JSON 版
// 等價入庫、r8 報告保留原始換行、缺少節區標記來源未提供）。
// 解析結果轉成 JSON 版 bdata 形狀後走 nhi_json.js 的共用匯入核心，
// 確保兩格式的欄位對照、指紋、防護行為零分叉。
import { importNhiBdata, stripBom } from "./nhi_json.js";
import { sha256Hex } from "../engine/fingerprint.js";

export const ADAPTER_VERSION = "1.1.0";

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decodeEntities = (s) =>
  s.includes("&") ? s.replace(/&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-fA-F]+);/g,
    (m, d, h) => d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ENT[m]) : s;

// 迷你 XML 解析（此格式無屬性、無自閉合標籤、無 CDATA；標籤名含「.」「_」）。
// 回傳 (tag, value) 序列；value 為字串（葉節點，實體已解碼）或子 pairs 陣列。
const OPEN_RE = /<([\w.]+)>/y;

function parsePairs(text, pos, endPos) {
  const pairs = [];
  for (;;) {
    // 跳過元素間空白
    while (pos < endPos && /\s/.test(text[pos])) pos++;
    if (pos >= endPos) return { pairs, pos };
    OPEN_RE.lastIndex = pos;
    const m = OPEN_RE.exec(text);
    if (!m || m.index !== pos) {
      throw new Error(`XML 結構異常於位移 ${pos}：${JSON.stringify(text.slice(pos, pos + 40))}`);
    }
    const tag = m[1];
    const contentStart = pos + m[0].length;
    const closeTag = `</${tag}>`;
    const closeAt = text.indexOf(closeTag, contentStart);
    if (closeAt === -1 || closeAt > endPos) throw new Error(`缺少關閉標籤 ${closeTag}`);
    const inner = text.slice(contentStart, closeAt);
    if (inner.includes("<")) {
      const { pairs: children } = parsePairs(text, contentStart, closeAt);
      pairs.push([tag, children]);
    } else {
      pairs.push([tag, decodeEntities(inner)]);
    }
    pos = closeAt + closeTag.length;
  }
}

// pairs → JSON 版 bdata 形狀
// 同一標籤同時出現文字佔位（<r1_1>無資料</r1_1>、空標籤）與巢狀子項時，
// 佔位不得覆蓋已收集的子項，子項也要能取代先出現的佔位
const isPlaceholderText = v => typeof v === "string" && ["", "無資料"].includes(v.trim());
function shapeRecord(children) {
  const rec = {};
  for (const [tag, val] of children) {
    if (Array.isArray(val)) {
      if (!Array.isArray(rec[tag])) rec[tag] = [];
      rec[tag].push(shapeRecord(val));
    } else if (!(Array.isArray(rec[tag]) && isPlaceholderText(val))) {
      rec[tag] = val;
    }
  }
  return rec;
}

export function xmlToBdata(text) {
  const t = stripBom(text);
  const open = t.indexOf("<bdata>");
  const close = t.indexOf("</bdata>");
  if (open === -1 || close === -1) throw new Error("找不到 bdata 節點");
  const { pairs } = parsePairs(t, open + "<bdata>".length, close);
  const bdata = {};
  const rawOf = new Map();
  // 只有佔位（[{rN: 無資料／空字串}]）的節區
  const placeholderOnly = (tag) => Array.isArray(bdata[tag]) && bdata[tag].length === 1
    && Object.keys(bdata[tag][0]).length === 1 && isPlaceholderText(bdata[tag][0][tag]);
  for (const [rawTag, val] of pairs) {
    const tag = rawTag.toLowerCase();
    // 同層大小寫變體（<b1.1> 與 <B1.1>、<r1> 與 <R1>）不得靜默覆蓋或合併：與 JSON 版
    // codeKeys 一致，整份中止
    if (rawOf.has(tag) && rawOf.get(tag) !== rawTag) throw new Error(`Conflicting NHI keys: ${tag}`);
    rawOf.set(tag, rawTag);
    if (Array.isArray(val)) {
      // 真紀錄取代先出現的「無資料」佔位，避免佔位被當成一筆假紀錄
      if (!Array.isArray(bdata[tag]) || placeholderOnly(tag)) bdata[tag] = [];
      bdata[tag].push(shapeRecord(val));
    } else if (/^r\d+$/.test(tag)) {
      // 葉節點型節區（如 <r2>無資料</r2>、<r0>聲明文字</r0>）→ JSON 版同形；
      // 已有真紀錄時，後出現的佔位不得覆蓋
      if (Array.isArray(bdata[tag]) && !placeholderOnly(tag) && isPlaceholderText(val)) continue;
      bdata[tag] = [{ [tag]: val }];
    } else {
      bdata[tag] = val; // b1.1 / b1.2
    }
  }
  return bdata;
}

export const nhiXmlAdapter = {
  id: "nhi_xml",
  formatDesc: "健保存摺醫療類 XML（健康存摺醫療類_*.xml）",

  detect(header) {
    try {
      const head = new TextDecoder("utf-8").decode(header.subarray(0, 2048));
      return head.includes("<myhealthbank>");
    } catch {
      return false;
    }
  },

  // source: { bytes: Uint8Array, name: string }
  async importSource(source, driver, progress, opts = {}) {
    const bdata = xmlToBdata(new TextDecoder("utf-8").decode(source.bytes));
    return importNhiBdata(bdata, {
      name: source.name, sha256: await sha256Hex(source.bytes),
      adapter: "nhi_xml", formatVariant: "xml",
    }, driver, progress, opts);
  },
};
