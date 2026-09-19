// 檢驗名稱正規化 JS 版（自 src/knowledge/labs.py 移植，兩端 MUST 同形）。
// 條目來源：建置期由 labs.yaml 轉出的 labs.json，呼叫端負責載入後傳入
// （App：bundle 資源；測試：讀 repo 檔）。
//
// 比對規則（change lab-order-code-normalization design D1/D2）：名稱鬆比對
// 優先、單一分析物醫令代碼後備。差異由 app/tests/parity/ 逐位元組對帳。

// 鬆化移除的字元：空白（NFKC 已把全形空白轉半形）與常見分隔標點。
// 字母、數字、`+`、`%` 全保留——「eGFR Male」與「eGFR (CKD-EPI)」鬆化後
// 仍不同鍵（design D2 保留字元說明）。
const LOOSE_STRIP = /[\s\-_./,、()]/g;
const WS = /\s+/g;
const ORDER_CODE_LEN = 6;

// 名稱比對分兩層（design D2）：
// (a) 精確層：NFKC → 去頭尾空白 → 大寫，任何長度的別名都適用（Na、K、Hb 走這層）；
// (b) 鬆化層：NFKC → 大寫 → 移除空白與 `- _ . / , 、 ( )`，只對鬆化後長度
//     ≥ MIN_LOOSE_LEN 的鍵生效——短鍵鬆化會把 N/A、U/A 這類非項目字串
//     誤合成 Na、UA（QA 實測），故短別名只允許精確層命中。
const MIN_LOOSE_LEN = 3;

export function exactKey(s) {
  return String(s ?? "").normalize("NFKC").trim().toUpperCase();
}

export function looseKey(s) {
  return String(s ?? "").normalize("NFKC").toUpperCase().replace(LOOSE_STRIP, "");
}

// 名稱兩層短路：精確層命中 → 鬆化層（僅長鍵）→ null
export function matchName(raw, exact, loose) {
  const ek = exactKey(raw);
  const hit = ek ? exact.get(ek) : undefined;
  if (hit) return hit;
  const lk = looseKey(raw);
  return (lk.length >= MIN_LOOSE_LEN ? loose.get(lk) : undefined) ?? null;
}

// order_code 去空白（`\s+`）、大寫、取前 6 碼；不足 6 碼回 null（無代碼）
function normalizedOrderCode(raw) {
  const code = String(raw ?? "").replace(WS, "").toUpperCase().slice(0, ORDER_CODE_LEN);
  return code.length === ORDER_CODE_LEN ? code : null;
}

// 鬆化鍵（正規名與別名）→ normalized_name。跨條目同鍵 → 建置失敗。
export function aliasMap(entries) {
  const m = new Map();
  for (const e of entries) {
    for (const alias of [e.normalized_name, ...e.aliases]) {
      const key = looseKey(alias);
      if (!key) continue;   // 空鍵 MUST NOT 進別名表（design D1）
      if (m.has(key) && m.get(key) !== e.normalized_name) {
        throw new Error(`別名衝突：${key} 同時指向 ${m.get(key)} 與 ${e.normalized_name}`);
      }
      m.set(key, e.normalized_name);
    }
  }
  return m;
}

// 精確鍵（正規名與別名）→ normalized_name。鬆化鍵同鍵是精確鍵同鍵的超集，
// 碰撞檢查由 aliasMap 負責；這裡只建表。
export function exactMap(entries) {
  const m = new Map();
  for (const e of entries) {
    for (const alias of [e.normalized_name, ...e.aliases]) {
      const key = exactKey(alias);
      if (key) m.set(key, e.normalized_name);
    }
  }
  return m;
}

// order_codes（6 碼醫令）→ normalized_name。型別/格式/重複 → 建置失敗。
export function codeMap(entries) {
  const m = new Map();
  for (const e of entries) {
    const codes = e.order_codes;
    if (codes === undefined || codes === null) continue;  // 無此欄位＝不參與後備
    const name = e.normalized_name ?? "(未命名)";
    if (!Array.isArray(codes) || !codes.every(c => typeof c === "string")) {
      throw new Error(`條目 ${name} 的 order_codes 必須為字串清單，實得 ${JSON.stringify(codes)}`);
    }
    for (const c of codes) {
      if (!/^\d{5}[A-Z]$/.test(c)) {
        throw new Error(`條目 ${name} 的醫令代碼格式錯誤：${c}（需 5 位數字加 1 位大寫英文字母）`);
      }
      if (m.has(c) && m.get(c) !== e.normalized_name) {
        throw new Error(`醫令代碼重複宣告：${c} 同時宣告於 ${m.get(c)} 與 ${name}`);
      }
      m.set(c, e.normalized_name);
    }
  }
  return m;
}

// 三級短路重算全部 lab_results（design D1）：
// (1) 名稱命中（精確層或長鍵鬆化層）→ 該正規名，無新旗標；(2) 名稱不中且醫令
// 代碼前 6 碼恰為某條目宣告 → 該正規名並標 `mapped_by_code`；(3) 皆不中 → NULL
// 並標 `unmapped`。兩旗標互斥、重算時先移除再依結果加回，其他旗標原樣保留。
// 冪等：只 UPDATE 結果有變動的列，故第二次呼叫 updated 為 0。
// 寫入依（normalized, flags）目標值分組、每組一句 `WHERE id IN (...)`（design D3）：
// App 端每句 SQL 是一次 IPC，升版首啟全表變動時把 IPC 次數從列數降到組數。
const UPDATE_CHUNK = 500;

export async function normalizeLabResults(driver, entries) {
  const exact = exactMap(entries);
  const loose = aliasMap(entries);
  const codes = codeMap(entries);
  const rows = await driver.select(
    "SELECT id, test_name_raw, order_code, test_name_normalized, quality_flags "
    + "FROM lab_results");
  let mapped = 0, unmapped = 0, mappedByCode = 0, updated = 0;
  const groups = new Map();   // `${normalized}\u0000${flags}` → ids
  for (const r of rows) {
    let normalized = matchName(r.test_name_raw, exact, loose);
    let byCode = false;
    if (!normalized) {
      const code = normalizedOrderCode(r.order_code);
      if (code) {
        normalized = codes.get(code) ?? null;
        byCode = normalized !== null;
      }
    }
    const flags = (r.quality_flags || "").split(",")
      .filter(f => f && f !== "unmapped" && f !== "mapped_by_code");
    if (normalized) {
      mapped += 1;
      if (byCode) { mappedByCode += 1; flags.push("mapped_by_code"); }
    } else {
      unmapped += 1;
      flags.push("unmapped");
    }
    const flagText = flags.join(",");
    // 結果與現值相同 → 不寫（冪等，第二次 updated=0）
    if (normalized === (r.test_name_normalized ?? null)
      && flagText === (r.quality_flags || "")) continue;
    const key = `${normalized ?? ""}\u0000${flagText}`;
    if (!groups.has(key)) groups.set(key, { normalized, flagText, ids: [] });
    groups.get(key).ids.push(r.id);
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += UPDATE_CHUNK) {
      const chunk = g.ids.slice(i, i + UPDATE_CHUNK);
      await driver.execute(
        "UPDATE lab_results SET test_name_normalized=?, quality_flags=? WHERE id IN ("
        + chunk.map(() => "?").join(",") + ")",
        [g.normalized, g.flagText, ...chunk]);
      updated += chunk.length;
    }
  }
  return { mapped, unmapped, mappedByCode, updated };
}

// 薄包裝：既有匯入路徑傳的是 store（driver 在 store.driver 上）
export async function applyNormalization(store, entries) {
  return normalizeLabResults(store.driver, entries);
}
