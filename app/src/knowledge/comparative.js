// 比較性措辭約束（change clinic-visit-view，design D8；spec app-viewer
// 「使用者可見文案的比較性措辭約束」）。
//
// 為什麼要有這個守衛：診間視角的設計依據之一是「本 App 有些長歷史資料在
// 別處的收載區間之外」。這是**內部設計依據**，MUST NOT 變成使用者可見的
// 敘述——本 App 的資料同源且新鮮度較低，任何「別的系統看不到」的說法都會
// 讓使用者誤判對方手上資訊的完整性，或誤認本 App 更具權威性。
//
// 約束若只寫在文件裡，後續維護者會違反而無人察覺，所以在此機器化。
// 檢查邏輯抽成函式（而非在測試裡一次性 grep）的理由：要寫得出負向對照
// ——只證明「現在是綠的」不足以證明守衛有效。
//
// 本檔自身含定義用的字串，故守衛只掃檢視層的兩份 app.js，不掃本檔。

// 醫療人員稱謂與「無法取得」的同句共現。單獨出現都合法（「請諮詢合格
// 醫事人員」是免責語的一部分，「沒有資料」是空狀態的正常說法），
// 共現才構成比較性敘述。
export const ROLE_WORDS = ["醫師", "醫生", "醫事人員"];
export const DENIAL_WORDS = ["查不到", "看不到", "拿不到", "沒有"];

// 其他系統的指名。
export const OTHER_SYSTEM_WORDS = ["雲端藥歷", "雲端", "健保署系統"];

// 其他系統的收載區間數字樣態。**僅限** 6／12／24 個月這三個確實對應
// 那些區間的數字。
//
// 為何不含「三個月」：資料截止日的過期提示門檻（design D5）是本設計自選的
// 呈現門檻，與任何外部系統無關，其文案會合法地出現「三個月」。若後續有人
// 把「近 3 個月」加進本清單，會誤擋 D5 的合法文案。
export const COVERAGE_WINDOW_WORDS = [
  "近 6 個月", "近6個月", "近 12 個月", "近12個月", "近 24 個月", "近24個月",
];

// 句讀與換行切句；逗號不切（中文常以逗號連接同一個陳述，切掉會漏放行）
const SENTENCE_SPLIT = /[。！？；\n]+/;

// 回傳命中清單（空陣列＝通過）。每筆帶 kind 與命中內容，讓失敗訊息直接
// 指出違規字串，不必人工翻檔。
export function checkComparative(text) {
  const src = String(text || "");
  const hits = [];
  for (const sentence of src.split(SENTENCE_SPLIT)) {
    const role = ROLE_WORDS.find((w) => sentence.includes(w));
    const denial = DENIAL_WORDS.find((w) => sentence.includes(w));
    if (role && denial) {
      hits.push({ kind: "role_denial", term: `${role}＋${denial}`,
        sentence: sentence.trim().slice(0, 100) });
    }
  }
  for (const w of OTHER_SYSTEM_WORDS) {
    if (src.includes(w)) hits.push({ kind: "other_system", term: w });
  }
  for (const w of COVERAGE_WINDOW_WORDS) {
    if (src.includes(w)) hits.push({ kind: "coverage_window", term: w });
  }
  return hits;
}
