// App 內即時檢視（app-viewer spec）：provider payload（僅當前成員）→
// assemble 單檔 HTML → iframe srcdoc。「匯出單檔 HTML」寫出同一份字串，
// 天生同構且僅含當前成員（D3）。檔名含成員名稱（exportFileName 純函式，
// tests/ui/export_name.test.mjs 直測）。
import { buildPayload } from "../provider/payload.js";
import { assemble, loadAssets } from "../provider/assemble.js";
import { assembleEpub } from "../provider/epub.js";
import { localDateISO } from "../engine/values.js";
import { PROFILE_DATA_TABLES } from "../engine/profiles.js";
import { defaultSavePath } from "./paths.js";

// 「這位成員有沒有可檢視的資料」＝任一資料表有列。沿用 PROFILE_DATA_TABLES
// （成員刪除用的同一份清單，已被 tests/engine/table_coverage.test.mjs 的 DDL
// 對帳釘住），扣掉來源紀錄本身。
//
// 原本硬編成「encounters ＋ apple_records 兩表相加」，於是只有 CPAP 資料的
// 成員會被判定成沒有資料，檢視頁整片空白且沒有任何錯誤訊息（2026-08-13 實機
// 走查：把 CPAP 匯給新成員後檢視頁空白）。新增來源時漏改這裡不會有測試轉紅，
// 所以改成沿用清單而不是再列一份表名。
const HAS_DATA_TABLES = PROFILE_DATA_TABLES.filter(t => t !== "source_documents");

// 純函式：匯出檔名。檔名不安全字元（含控制字元）代換為底線。
// ext 讓 HTML 與 EPUB 兩條匯出路徑共用同一套命名規則（含成員名與日期）。
export function exportFileName(memberName, dateStr, ext = "html") {
  const safe = String(memberName ?? "")
    .replaceAll(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim() || "成員";
  return `dashboard_${safe}_${dateStr.replaceAll("-", "")}-private.${ext}`;
}

// 藥品快取解析的決策核心（依賴注入純化，tests/ui/drug_cache_resolution
// 直測六種形狀；權限層測不到，實機 dogfood 另驗——feedback_injected_fs）。
// 回傳 local 路徑或 null（雙邊都拿不到）。deps.cacheDate(path) 回建置日期
// 字串（ISO，讀不到回 ""）。
export async function resolveDrugCachePath(deps, dir, sep) {
  const local = `${dir}${sep}drug_items.sqlite`;
  const hasLocal = await deps.exists(local).catch(() => false);
  let bundled = null;
  try {
    bundled = await deps.resolveResource("resources/drug_items.sqlite");
  } catch {
    bundled = null;
  }
  if (hasLocal) {
    if (!bundled) return local;
    const localDate = await deps.cacheDate(local);
    const bundleDate = await deps.cacheDate(bundled);
    if (localDate >= bundleDate) return local;
    try {
      await deps.copyFile(bundled, local);
    } catch (err) {
      // 覆蓋失敗＝退回舊資料（可用但陳舊），比整包 null 好
      console.error("[hwb] 藥品快取更新失敗，沿用既有快取：", err);
    }
    return local;
  }
  if (!bundled) {
    console.error("[hwb] 用藥品項檔快取取不到，西藥品項將無法辨識");
    return null;
  }
  try {
    await deps.copyFile(bundled, local);
    return local;
  } catch (err) {
    console.error("[hwb] 用藥品項檔快取取不到，西藥品項將無法辨識：", err);
    return null;
  }
}

export function createViewer({ getDriver, getDbPath, getProfileId,
  getExportStartDir, labEntries, bodyRefs = [], onNotify }) {
  let assets = null;
  let lastHtml = null;
  let lastPayload = null;
  let lastMemberName = null;

  const frame = document.getElementById("viewer-frame");
  const emptyEl = document.getElementById("viewer-empty");
  const exportBtn = document.getElementById("export-html-btn");
  const epubBtn = document.getElementById("export-epub-btn");
  const EMPTY_TEXT = emptyEl.textContent; // 首啟引導原文（載入提示後要還原）
  // 外部連結攔截掛在 frame 的 load 上（初始化一次，非每次 refresh；
  // srcdoc 每次重設都會觸發 load 對新 document 重掛委派，避免累積）
  frame.addEventListener("load", wireExternalLinks);

  // 解析順序：db 同目錄（使用者可自行更新快取，Python 慣例）→ 沒有就從 bundle
  // 資源複製一份過去。
  //
  // 兩個歷史陷阱都釘在這裡：
  // 1. 原本第二條是「exists(bundled) 為真才回 bundled」，dev 模式探測失敗被
  //    catch 吞成 null → 靜默降級（2026-08-13 實機），故改直接 copyFile、
  //    失敗寫 console。
  // 2. 原本第一條「local 存在就用」讓發版後的新 bundle 永遠讀不到——上面的
  //    copyFile 首次就會把 local 建出來，之後 exists 恆真，所有既有使用者
  //    停在舊資料且無任何提示（2026-08-20 稽核以實機檔與舊 bundle 逐位元組
  //    對帳實證）。故 local 與 bundle 都在時比對 cache_meta 的建置日期，
  //    bundle 較新才覆蓋；使用者以 hwb knowledge update 自行更新（日期較新
  //    或同日）不被回頭蓋掉。日期讀不到（檔壞、無表）視為最舊。
  async function probeCacheDate(p) {
    const driver = getDriver();
    const esc = String(p).replaceAll("'", "''");
    try {
      try {
        await driver.execute(`ATTACH DATABASE 'file:${esc}?mode=ro' AS cacheprobe`);
      } catch {
        await driver.execute(`ATTACH DATABASE '${esc}' AS cacheprobe`);
      }
    } catch {
      return "";
    }
    try {
      const rows = await driver.select(
        "SELECT value FROM cacheprobe.cache_meta WHERE key='updated_at'");
      return rows.length ? String(rows[0].value || "") : "";
    } catch {
      return "";
    } finally {
      await driver.execute("DETACH DATABASE cacheprobe").catch(() => {});
    }
  }

  async function drugCachePath() {
    const t = window.__TAURI__;
    const dir = getDbPath().replace(/[/\\][^/\\]+$/, "");
    const sep = dir.includes("\\") ? "\\" : "/";
    return resolveDrugCachePath({
      exists: (p) => t.fs.exists(p),
      copyFile: (from, to) => t.fs.copyFile(from, to),
      resolveResource: (p) => t.path.resolveResource(p),
      cacheDate: probeCacheDate,
    }, dir, sep);
  }

  function showEmpty() {
    frame.hidden = true;
    exportBtn.hidden = true;
    epubBtn.hidden = true;
    emptyEl.textContent = EMPTY_TEXT;
    emptyEl.hidden = false;
    lastHtml = null;
    lastPayload = null;
    lastMemberName = null;
    return { rendered: false };
  }

  async function refresh() {
    const driver = getDriver();
    const profileId = getProfileId();
    if (profileId == null) return showEmpty();
    // 先遮住舊內容再查新資料（Karen HIGH-1：大量資料下 payload 組裝
    // 需 2-3 秒，不遮會出現「新成員標籤配舊成員病歷」的錯配窗）
    frame.hidden = true;
    emptyEl.textContent = "正在載入資料…";
    emptyEl.hidden = false;
    // EXISTS 逐表短路：apple_records 有數十萬列，不能用 count(*) 相加
    const [{ has }] = await driver.select(
      "SELECT (" + HAS_DATA_TABLES
        .map(t => `EXISTS(SELECT 1 FROM ${t} WHERE profile_id=?)`).join(" OR ")
      + ") AS has", HAS_DATA_TABLES.map(() => profileId));
    if (!has) return showEmpty();
    assets = assets || await loadAssets();
    const payload = await buildPayload(driver, {
      profileId,
      knowledgeEntries: labEntries,
      bodyRefs,
      drugCachePath: await drugCachePath(),
      today: localDateISO(),
    });
    lastHtml = assemble(payload, assets);
    lastPayload = payload;
    lastMemberName = payload.meta.profile;
    frame.srcdoc = lastHtml;
    frame.hidden = false;
    exportBtn.hidden = false;
    epubBtn.hidden = false;
    emptyEl.hidden = true;
    return { rendered: true, bytes: lastHtml.length, counts: payload.meta.counts };
  }

  // 仿單等外部連結：WebView 內 target=_blank 會被 Tauri 攔下無反應
  //（2026-08-11 使用者走查發現），改經 opener 插件開系統瀏覽器。
  // srcdoc iframe 與外層同源，可直接掛委派監聽；匯出的單檔 HTML 在
  // 一般瀏覽器開啟，維持原生 target=_blank 行為不受影響。
  function wireExternalLinks() {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", (e) => {
      const a = e.target.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      const openUrl = window.__TAURI__?.opener?.openUrl;
      if (openUrl) {
        openUrl(href).catch((err) => {
          onNotify?.(`無法開啟連結：${String(err?.message || err)}`, 10000);
        });
      } else {
        onNotify?.(`此版本無法開啟外部連結，請手動前往：${href}`, 10000);
      }
    });
  }

  // HTML 與 EPUB 共用的儲存對話框流程（起始目錄記憶上次匯出位置，
  // 首次退「文件」，見 main.js dialogStartDir）
  async function askTarget(ext, title) {
    const t = window.__TAURI__;
    const save = t.dialog.save || t.dialog.default?.save;
    const startDir = await (getExportStartDir?.() ?? null);
    const name = exportFileName(lastMemberName, localDateISO(), ext);
    return save({ title, defaultPath: defaultSavePath(startDir, name) });
  }

  async function exportHtml(destPath = null) {
    if (!lastHtml) await refresh();
    if (!lastHtml) return { ok: false, reason: "no_data" };
    const target = destPath || await askTarget("html",
      `匯出單檔 HTML（僅成員「${lastMemberName}」的資料，含個資請妥善保管）`);
    if (!target) return { ok: false, reason: "cancelled" };
    await window.__TAURI__.fs.writeTextFile(target, lastHtml);
    return { ok: true, path: target, bytes: lastHtml.length };
  }

  // EPUB 是 zip 二進位，寫檔走 fs.writeFile（writeTextFile 會把位元組
  // 當 UTF-8 字串處理而毀掉檔案）。呼叫端負責先取得 iCloud 同步的確認。
  async function exportEpub(destPath = null) {
    if (!lastPayload) await refresh();
    if (!lastPayload) return { ok: false, reason: "no_data" };
    const target = destPath || await askTarget("epub",
      `匯出 EPUB（僅成員「${lastMemberName}」的資料，含個資請妥善保管）`);
    if (!target) return { ok: false, reason: "cancelled" };
    const bytes = await assembleEpub(lastPayload, assets);
    await window.__TAURI__.fs.writeFile(target, bytes);
    return { ok: true, path: target, bytes: bytes.length };
  }

  return { refresh, exportHtml, exportEpub };
}
