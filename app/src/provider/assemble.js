// 單檔 dashboard 組裝 JS 版（自 src/dashboard/generate.py assemble 移植）。
// 檢視器（iframe srcdoc）與「匯出單檔 HTML」共用同一份輸出，天生同構。
// 資產由呼叫端載入傳入（App：fetch viewer/assets；測試：讀檔）。
import shape from "./shape.json" with { type: "json" };
import { checkText } from "../knowledge/forbidden.js";

export const SIZE_LIMIT = 10 * 1024 * 1024; // 10MB（design Implementation Contract）

// 契約驗證：頂層鍵齊全＋型別正確（shape.json 為 SSOT）
export function validateShape(payload) {
  const problems = [];
  for (const k of shape.required) {
    if (!(k in payload)) problems.push(`缺頂層鍵 ${k}`);
  }
  for (const [k, def] of Object.entries(shape.properties)) {
    if (!(k in payload)) continue;
    const v = payload[k];
    const ok = def.type === "array" ? Array.isArray(v)
      : typeof v === "object" && v !== null && !Array.isArray(v);
    if (!ok) problems.push(`${k} 型別應為 ${def.type}`);
    for (const rk of def.required ?? []) {
      if (v && !(rk in v)) problems.push(`${k}.${rk} 缺欄位`);
    }
  }
  return problems;
}

// 安全內嵌（同 embed.py to_embedded_json）：< 跳脫防 </script> 逃逸
export function toEmbeddedJson(payload) {
  return JSON.stringify(payload)
    .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

// assets: { appJs, css, vendor: [preact, hooks, htm] }
export function assemble(payload, assets) {
  const problems = validateShape(payload);
  if (problems.length) throw new Error(`payload 不符 shape 契約：${problems.join("；")}`);
  for (const [name, text] of [["app.js", assets.appJs], ["style.css", assets.css]]) {
    const hits = checkText(text);
    if (hits.length) throw new Error(`介面文案含禁用詞 ${hits}（${name}）`);
  }
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>個人健康資料工作台（私人）</title>
<style>${assets.css}</style>
</head>
<body>
<div id="app"><p>載入中…若一直停在這行，表示目前的開啟方式不會執行網頁程式
（例如 iOS「檔案」App 的預覽視窗）。電腦上請用瀏覽器開啟本檔；iPhone、
iPad 請改用「HTML &amp; Markdown 檢視器」這類會執行網頁程式的 App。<br>
更省事的辦法：請傳這個檔案給你的人改寄 EPUB 版，用 iPhone、iPad 的
「書籍」（Apple Books）打開就能直接看。</p></div>
<script type="application/json" id="hwb-data">${toEmbeddedJson(payload)}</script>
<script>${assets.vendor.join("\n")}</script>
<script>${assets.appJs}</script>
</body>
</html>`;
  if (new TextEncoder().encode(html).length > SIZE_LIMIT) {
    throw new Error("檔案超過 10MB 上限");
  }
  return html;
}

// App 端資產載入（frontendDist 相對路徑）
export async function loadAssets() {
  const get = async (p) => (await fetch(p)).text();
  return {
    appJs: await get("./viewer/assets/app.js"),
    css: await get("./viewer/assets/style.css"),
    vendor: [
      await get("./viewer/assets/vendor/preact.min.js"),
      await get("./viewer/assets/vendor/hooks.umd.js"),
      await get("./viewer/assets/vendor/htm.umd.js"),
    ],
  };
}
