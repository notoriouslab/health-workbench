// 更新檢查（app-shell「更新檢查的徵詢」「版本查詢的請求最小化」等條文）。
//
// 只取得最新發布版本號，不送出當前版本、不送識別碼：比對一律在本機做，
// 對方因此無法統計版本分布。已知暴露面為 IP、時間，以及 WebView 自帶的
// User-Agent（由 WebView 決定，無法自程式移除，故列為已知暴露面而非可控項）。
//
// IO 注入（fetchImpl 參數）比照 store/settings.js 的作法，讓 node:test
// 能零連網直測全部路徑（成功、額度限制、離線、壞 JSON）。

export const LATEST_URL =
  "https://api.github.com/repos/notoriouslab/health-workbench/releases/latest";

// App 端預設實作：WebView 的 fetch。2026-08-21 於 tauri dev 實機驗證可用
// （回 status=200、tag=v0.8.0），tauri.conf.json 的 csp 為 null，因此不需
// tauri-plugin-http、不需新增 capability。
export const webviewFetch = (url, init) => fetch(url, init);

// 發布 tag 帶 v 前綴（實測 v0.8.0），tauri.conf.json 的 version 不帶（0.8.0）
export const stripPrefix = (text) =>
  String(text ?? "").trim().replace(/^v/i, "");

// 只判斷「是否不同」，NEVER 判斷新舊。正式安裝版的版本必然不晚於最新發布版，
// 故「不同」即「有新版」（開發版與本機建置由 shouldCheck 排除，見下）。
//
// NEVER 改成字串大小比較：`"0.10.0" < "0.9.0"` 為真，版本過 9 即失效。
// NEVER 改成解析數值後逐段比較：tag 格式若日後改變（例如改用日期版本），
// 解析會全面失敗而變成永遠不通知，那是靜默失效，比偶爾誤報一次更糟。
export function isDifferent(latest, current) {
  const a = stripPrefix(latest);
  const b = stripPrefix(current);
  if (!a || !b) return false;
  return a !== b;
}

// 開發版與本機建置 MUST NOT 檢查：發版流程先提升 version 再打 tag，因此在
// 提升之後、發布之前，開發版的版本必然不同於最新發布版且「更新」，此時
// 通知只會叫開發者去下載較舊的版本。origin 由殼層既有的執行來源偵測提供
// （main.js 以 resolveResource 路徑判定；空字串＝正式安裝版）。
// 刻意判斷「非空」而不比對特定字樣，避免日後改動來源標示文案時靜默失效。
export const shouldCheck = ({ origin } = {}) => !String(origin ?? "").trim();

// 啟動時的決策：skip（不查也不問）／ask（徵詢）／check（查）。
// 抽成純函式的理由：「未取得同意就不查」是整個隱私主張的實際防線，必須能被
// 測試直接釘住，不能只存在於 UI 流程裡而無從驗證。
// updateCheck 為 undefined＝還沒問過。
export function decideCheck({ origin, updateCheck } = {}) {
  if (!shouldCheck({ origin })) return "skip";
  if (updateCheck === true) return "check";
  if (updateCheck === false) return "skip";
  return "ask";
}

export const RELEASES_URL =
  "https://github.com/notoriouslab/health-workbench/releases";

// 「前往查看」開的是 API 回應裡的 html_url，也就是**外部輸入**進到開系統
// 瀏覽器的路徑（其餘 openExternal 呼叫端都是硬編碼常數，只有這一條不是）。
// 因此 MUST 白名單：用 URL 解析比對 protocol、host 與 path 前綴，不合就退回
// 本專案的 releases 頁。NEVER 改成字串前綴比對：`https://github.com@evil.tld/`
// 這種混淆會通過前綴比對，而 URL 解析後 host 是 evil.tld，擋得掉。
export function safeReleaseUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return RELEASES_URL;
    if (u.host !== "github.com") return RELEASES_URL;
    const repo = "/notoriouslab/health-workbench";
    // 要求正好是該 repo 或其子路徑：光用 startsWith 會放過 `<repo>-evil`
    if (u.pathname !== repo && !u.pathname.startsWith(`${repo}/`)) return RELEASES_URL;
    return u.href;
  } catch {
    return RELEASES_URL;
  }
}

// 回傳 { tag, url } 或 null。任何失敗一律回 null 且不拋出：更新檢查是附帶
// 便利，為它產生的錯誤訊息是純粹干擾（app-shell「節制與靜默失敗」條文）。
export async function checkLatest({ fetchImpl = webviewFetch } = {}) {
  try {
    const res = await fetchImpl(LATEST_URL, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res || res.ok === false) return null;
    const data = await res.json();
    const tag = typeof data?.tag_name === "string" ? data.tag_name : null;
    if (!tag) return null;
    const url = typeof data?.html_url === "string" ? data.html_url : null;
    return { tag, url };
  } catch {
    return null;
  }
}
