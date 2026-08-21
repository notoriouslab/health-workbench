// 當前成員狀態記憶（design D4；profile-management spec）。
// settings.json 與資料庫同目錄。存當前成員 id（數字）與更新檢查的徵詢結果
// （updateCheck 布林；鍵不存在＝還沒問過）。不含健康或身分資料。
// loadSettings＝純 JSON 解析零驗證；id 有效性驗證只在
// resolveCurrentProfile（純函式），ui/main.js 於啟動與刪除成員後呼叫。
// IO 注入（io 參數）讓 node:test 直測；App 端用預設 tauriIo。

export const SETTINGS_FILENAME = "settings.json";

const joinPath = (dir, name) => {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
};

// App 端 IO（延遲取用 window.__TAURI__，模組載入時不觸碰）
export const tauriIo = {
  readTextFile: (p) => window.__TAURI__.fs.readTextFile(p),
  writeTextFile: (p, text) => window.__TAURI__.fs.writeTextFile(p, text),
};

// 測試端 IO（node:fs；不進 App bundle 的引用路徑）
export const nodeIo = {
  readTextFile: async (p) => (await import("node:fs/promises")).readFile(p, "utf-8"),
  writeTextFile: async (p, text) =>
    (await import("node:fs/promises")).writeFile(p, text, "utf-8"),
};

// 缺檔、壞 JSON、非物件一律靜默回傳 {}（spec：失效回退不顯示錯誤）
export async function loadSettings(dir, io = tauriIo) {
  let text;
  try {
    text = await io.readTextFile(joinPath(dir, SETTINGS_FILENAME));
  } catch {
    return {};
  }
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

export async function saveSettings(dir, obj, io = tauriIo) {
  await io.writeTextFile(joinPath(dir, SETTINGS_FILENAME),
    JSON.stringify(obj, null, 2));
}

// 唯一的 id 驗證點：settings 指向存在的成員→用之；否則 id 最小成員；
// 零成員→null。嚴格等值比對（型別髒值視同失效）。
export function resolveCurrentProfile(settings, profiles) {
  if (!profiles.length) return null;
  const wanted = settings?.current_profile_id;
  if (profiles.some(p => p.id === wanted)) return wanted;
  return profiles.reduce((m, p) => (p.id < m ? p.id : m), profiles[0].id);
}
