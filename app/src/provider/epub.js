// EPUB 3 匯出（app-viewer spec）。與 assemble.js 的單檔 HTML 並存：
// 兩者內容相同，EPUB 多的是能被電子書 App 直接開啟並重排字級。手機、
// 平板尤其需要（iOS 開不了本機 HTML，「檔案」App 的預覽不執行 JS）。
//
// 檢視層資產（app.js／vendor／style.css）與 HTML 匯出共用同一份，差別只在
// 外層骨架：EPUB 的內容文件 MUST 是合法 XML，而 assemble.js 產的是 HTML5。
//
// 三條 EPUB 3 硬性要求（違反其一，Books 直接拒絕開啟或靜默不執行 JS）：
//   1. mimetype MUST 是 zip 的第一個項目且不壓縮
//   2. 內容文件在 manifest MUST 標 properties="scripted"（用到 SVG 再加 svg），
//      沒宣告的話閱讀器可以合法地不執行 JS
//   3. 內容文件 MUST 是合法 XML（不是寬鬆 HTML）
// 以上三條由 scripts/probe_epub_capability.py 於 Books 實機驗證過。
import { validateShape, toEmbeddedJson, SIZE_LIMIT } from "./assemble.js";
import { checkText } from "../knowledge/forbidden.js";
import { createZip } from "./zip.js";

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

// XML 文字節點與屬性值跳脫（成員名等使用者輸入會進 OPF 的 dc:title）
export function xmlEscape(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

// EPUB 的識別碼要求唯一且穩定。刻意不用隨機 UUID：同一份資料匯出兩次
// 應得到相同位元組，否則無法用雜湊確認「內容真的沒變」。
export function epubIdentifier(profileName, generatedAt) {
  return `urn:hwb:${encodeURIComponent(String(profileName ?? ""))}:${generatedAt}`;
}

function opf(payload) {
  const { profile, generated_at: at } = payload.meta;
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${xmlEscape(epubIdentifier(profile, at))}</dc:identifier>
    <dc:title>${xmlEscape(profile)}的個人健康資料（${xmlEscape(at)}）</dc:title>
    <dc:creator>HealthWorkbench：個人健康資料工作台</dc:creator>
    <dc:language>zh-TW</dc:language>
    <meta property="dcterms:modified">${xmlEscape(at)}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="main" href="dashboard.xhtml" media-type="application/xhtml+xml" properties="scripted svg"/>
  </manifest>
  <spine>
    <itemref idref="main"/>
  </spine>
</package>`;
}

function nav(payload) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-TW" xml:lang="zh-TW">
<head><meta charset="utf-8"/><title>目錄</title></head>
<body>
  <nav epub:type="toc" id="toc"><h1>目錄</h1>
    <ol><li><a href="dashboard.xhtml">${xmlEscape(payload.meta.profile)}的健康資料</a></li></ol>
  </nav>
</body>
</html>`;
}

// CDATA 內若出現 ]]> 會提前終止區段，把後半段 JS 當成標籤解析，
// 症狀是整個內容文件變成非法 XML、Books 拒絕開啟。現有四份資產出現次數
// 皆為 0，但將來有人在字串裡寫進去不會有別的地方轉紅，所以在此擋。
function cdata(text, what) {
  if (text.includes("]]>")) {
    throw new Error(`${what} 含 ]]> 序列，無法安全放進 EPUB 的 CDATA 區段`);
  }
  return `<![CDATA[\n${text}\n]]>`;
}

// HWB_EPUB 旗標必須先於 app.js 執行（app.js 一載入就渲染），讓檢視層知道
// 自己在 EPUB 閱讀器裡而不渲染列印鈕——閱讀器的 window.print 語意不受控。
// 旗標內容無 XML 特殊字元也無 ]]>，不需要 CDATA。App 與 HTML 匯出不設旗標。
function dashboard(payload, assets) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-TW" xml:lang="zh-TW">
<head>
<meta charset="utf-8"/>
<title>個人健康資料工作台（私人）</title>
<style>${cdata(assets.css, "style.css")}</style>
</head>
<body>
<div id="app"><p>載入中…若一直停在這行，表示這個閱讀器不會執行網頁程式
（Google Play Books 實測如此）。請改用 Apple Books、Thorium Reader 或
Android 的 Reasily 開啟；在電腦上也可以改看「匯出單檔 HTML」產生的檔案，
內容相同。</p></div>
<script type="application/json" id="hwb-data">${toEmbeddedJson(payload)}</script>
<script>window.HWB_EPUB=true</script>
<script>${cdata(assets.vendor.join("\n"), "vendor")}</script>
<script>${cdata(assets.appJs, "app.js")}</script>
</body>
</html>`;
}

// assets 同 assemble()：{ appJs, css, vendor: [preact, hooks, htm] }
// 回傳 Uint8Array（zip 二進位，寫檔要用 fs.writeFile 不是 writeTextFile）
export async function assembleEpub(payload, assets) {
  const problems = validateShape(payload);
  if (problems.length) throw new Error(`payload 不符 shape 契約：${problems.join("；")}`);
  for (const [name, text] of [["app.js", assets.appJs], ["style.css", assets.css]]) {
    const hits = checkText(text);
    if (hits.length) throw new Error(`介面文案含禁用詞 ${hits}（${name}）`);
  }
  const enc = new TextEncoder();
  const bytes = await createZip([
    // mimetype 必須第一且不壓縮
    { name: "mimetype", data: enc.encode("application/epub+zip"), store: true },
    { name: "META-INF/container.xml", data: enc.encode(CONTAINER) },
    { name: "OEBPS/content.opf", data: enc.encode(opf(payload)) },
    { name: "OEBPS/nav.xhtml", data: enc.encode(nav(payload)) },
    { name: "OEBPS/dashboard.xhtml", data: enc.encode(dashboard(payload, assets)) },
  ]);
  if (bytes.length > SIZE_LIMIT) throw new Error("檔案超過 10MB 上限");
  return bytes;
}
