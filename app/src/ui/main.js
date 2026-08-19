// App 前端入口。Tauri API 走 withGlobalTauri（window.__TAURI__），
// 引擎模組（engine/、adapters/、store/）維持純 ESM，Node 測試可直接 import。
// 多成員（change multi-profile-management）：currentProfileId 為單一
// 事實來源，檢視相關介面（狀態列/檢視頁）跟當前成員，匯入紀錄卡全庫。
import { TauriDriver } from "../store/tauri_driver.js";
import { initSchema, SCHEMA_VERSION } from "../store/schema.js";
import { resolveDbPath, importExistingDb, backupFileName, exportDbSnapshot,
  readSchemaVersion, needsPreMigrationSnapshot, preMigrationSnapshotName }
  from "../store/location.js";
import { loadSettings, saveSettings, resolveCurrentProfile } from "../store/settings.js";
import { listProfiles } from "../engine/profiles.js";
import { createImportFlow } from "./import_flow.js";
import { createViewer } from "./viewer.js";
import { defaultSavePath } from "./paths.js";
import { createHistory } from "./history.js";
import { createProfileManager } from "./profile_manager.js";
import { localDateISO } from "../engine/values.js";

const statusEl = document.getElementById("status");
const noticeEl = document.getElementById("notice");

// 暫時性提示走獨立通知列，NEVER 覆蓋狀態列的成員統計
// （2026-08-10 走查回饋：複製連結把成員統計行蓋掉了）
let noticeTimer = null;
function notify(text, ms = 5000) {
  noticeEl.textContent = text;
  noticeEl.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, ms);
}
const app = { driver: null, dbPath: null, dbDir: null, currentProfileId: null,
  flow: null, viewer: null, history: null, manager: null };

const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function tableCounts(driver, profileId) {
  const tables = ["encounters", "medications", "lab_results", "apple_records"];
  const out = {};
  for (const t of tables) {
    const [{ c }] = profileId == null
      ? [{ c: 0 }]
      : await driver.select(
        `SELECT count(*) c FROM ${t} WHERE profile_id=?`, [profileId]);
    out[t] = c;
  }
  return out;
}

// 狀態列＝當前成員視角（design D3）
async function refreshStatus() {
  const profiles = await listProfiles(app.driver);
  const current = profiles.find(p => p.id === app.currentProfileId) ?? null;
  if (!current) {
    statusEl.textContent = "尚無成員。請匯入健保存摺或 Apple 健康匯出檔（匯入時建立成員）。";
  } else {
    const counts = await tableCounts(app.driver, current.id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    statusEl.textContent = total === 0
      ? `成員「${current.display_name}」尚無資料。請匯入健保存摺或 Apple 健康匯出檔。`
      : `成員「${current.display_name}」：就醫 ${counts.encounters}、用藥 ${counts.medications}、`
        + `檢驗 ${counts.lab_results}、Apple ${counts.apple_records.toLocaleString()}`;
  }
  await app.history?.refresh().catch(() => {});
}

// 成員切換器（app-viewer spec：全域切換器＋管理入口）
async function refreshSwitcher() {
  const select = document.getElementById("profile-select");
  const profiles = await listProfiles(app.driver);
  if (profiles.length === 0) {
    select.innerHTML = `<option value="">尚無成員</option>`;
    select.disabled = true;
    return profiles;
  }
  select.disabled = false;
  select.innerHTML = profiles.map(p =>
    `<option value="${p.id}">${esc(p.display_name)}</option>`).join("");
  select.value = String(app.currentProfileId ?? "");
  return profiles;
}

// settings 一律讀取合併後回寫（單鍵覆寫會洗掉其他鍵，如記憶的目錄）。
// 寫入失敗 NEVER 靜默（Karen 稽核 CRITICAL-1：出貨 ACL 擋寫時，靜默
// 失敗＝「成員記憶」整個功能無聲失效且手測不可見）
async function updateSettings(patch) {
  const s = await loadSettings(app.dbDir);
  try {
    await saveSettings(app.dbDir, { ...s, ...patch });
  } catch (err) {
    notify(`設定無法儲存（下次開啟可能不會記住目前成員）：${String(err?.message || err)}`, 10000);
  }
}

// 切換／成員異動後的統一收斂點：驗證 currentProfileId、存 settings、
// 刷新切換器＋狀態列＋檢視頁（匯入紀錄卡在 refreshStatus 內連帶刷新）
async function setCurrentProfile(id, { save = true } = {}) {
  const profiles = await listProfiles(app.driver);
  app.currentProfileId = resolveCurrentProfile(
    { current_profile_id: id }, profiles);
  if (save && app.currentProfileId != null) {
    await updateSettings({ current_profile_id: app.currentProfileId });
  }
  await refreshSwitcher();
  await refreshStatus();
  // 檢視刷新失敗 NEVER 靜默（2026-08-10 走查回饋 3 的診斷面）
  try {
    await app.viewer?.refresh();
  } catch (err) {
    statusEl.textContent = `檢視頁載入失敗：${String(err?.message || err)}`;
  }
}

// 對話框起始目錄：記憶上次使用的資料夾；首次開檔預設「下載項目」
// （健保/Apple 匯出檔的常見落點）、匯出預設「文件」（2026-08-10 走查回饋 2）
async function dialogStartDir(kind) {
  const t = window.__TAURI__;
  const s = await loadSettings(app.dbDir);
  const remembered = kind === "export" ? s.last_export_dir : s.last_open_dir;
  if (remembered && await t.fs.exists(remembered).catch(() => false)) {
    return remembered;
  }
  const fallback = kind === "export" ? t.path.documentDir() : t.path.downloadDir();
  return fallback.catch(() => null);
}

async function rememberDialogDir(kind, usedPath) {
  if (!usedPath) return;
  const dir = String(usedPath).replace(/[/\\][^/\\]+$/, "");
  if (!dir) return;
  await updateSettings(
    kind === "export" ? { last_export_dir: dir } : { last_open_dir: dir });
}

// 遷移前自動快照 → 遷移（cpap-sleep-therapy design D8）。
// 用 exportDbSnapshot（VACUUM INTO）而非 fs.copyFile：複製前必須先關閉主庫
// 連線（連線池握檔陷阱，見 g3_task0.md），而遷移正發生在開庫流程中，庫必然
// 開著。VACUUM INTO 取單一交易視角、不中斷主庫，且輸出可被 importExistingDb
// 讀回。快照失敗 MUST 中止遷移，不得靜默續行（失敗代價是資料庫打不開）。
async function migrateWithSnapshot() {
  const fs = window.__TAURI__.fs;
  const from = await readSchemaVersion(app.driver);
  if (needsPreMigrationSnapshot(from, SCHEMA_VERSION)) {
    const sep = app.dbDir.includes("\\") ? "\\" : "/";
    const today = localDateISO();
    let dest = null;
    for (let seq = 0; seq < 100; seq += 1) {
      const cand = `${app.dbDir}${sep}${preMigrationSnapshotName(from, today, seq)}`;
      if (!(await fs.exists(cand))) { dest = cand; break; }
    }
    if (!dest) {
      throw new Error("升級資料庫前的自動備份無法命名（同日備份過多），"
        + "為保護既有資料已停止升級，請先整理資料目錄內的 hwb-premigrate-* 檔案。");
    }
    try {
      await exportDbSnapshot(app.driver, dest);
    } catch (err) {
      throw new Error(`升級資料庫前的自動備份失敗（磁碟空間或權限不足），`
        + `為保護既有資料已停止升級。備份目標：${dest}（${err?.message || err}）`);
    }
    app.preMigrateSnapshot = dest;
  }
  return initSchema(app.driver);
}

async function boot() {
  const { path, overridden } = await resolveDbPath();
  app.dbPath = path;
  app.dbDir = path.replace(/[/\\][^/\\]+$/, "");
  await window.__TAURI__.fs.mkdir(app.dbDir, { recursive: true }).catch(() => {});
  app.driver = await TauriDriver.open(path);
  await migrateWithSnapshot();
  const profiles = await listProfiles(app.driver);
  app.currentProfileId = resolveCurrentProfile(
    await loadSettings(app.dbDir), profiles);
  // 開機落章：settings 寫入路徑在首次啟動就被驗證（Karen CRITICAL-1
  // 驗收條件：正式安裝路徑下 settings.json 必須真的存在）
  if (app.currentProfileId != null) {
    await updateSettings({ current_profile_id: app.currentProfileId });
  }
  return { path, overridden };
}

// 「匯入既有資料庫檔」：選檔 → 驗版本 → 關主庫 → 複製 → 重開＋遷移
async function importExisting(srcPath) {
  await app.driver.close();
  try {
    const r = await importExistingDb(srcPath, app.dbPath,
      TauriDriver.open, SCHEMA_VERSION);
    if (!r.ok) {
      statusEl.textContent = r.reason === "too_new"
        ? `此資料庫版本（${r.version}）較新，請更新 App 後再匯入`
        : "所選檔案不是本工具的資料庫檔";
    }
    return r;
  } finally {
    app.driver = await TauriDriver.open(app.dbPath);
    // 匯入的舊庫同樣可能需要遷移，走同一條「先快照再遷移」的路徑
    await migrateWithSnapshot();
    if (app.flow) await setCurrentProfile(app.currentProfileId).catch(() => {});
  }
}

async function loadLabEntries() {
  const res = await fetch("./knowledge/labs.json");
  return res.json();
}

// 身體數值參考線條目（載入失敗回空清單＝不畫參考線，檢視功能不受影響）
async function loadBodyRefs() {
  try {
    const res = await fetch("./knowledge/body_refs.json");
    return await res.json();
  } catch { return []; }
}

function dialogOpen(opts) {
  const dialog = window.__TAURI__.dialog;
  const open = dialog.open || dialog.default?.open;
  return open(opts);
}

function setTab(name) {
  for (const t of ["import", "viewer"]) {
    document.getElementById(`tab-${t}`).hidden = t !== name;
    document.getElementById(`tab-btn-${t}`).classList.toggle("active", t === name);
  }
}

async function wireUi() {
  const labEntries = await loadLabEntries();
  const bodyRefs = await loadBodyRefs();
  document.getElementById("tab-btn-import").addEventListener("click", () => setTab("import"));
  document.getElementById("tab-btn-viewer").addEventListener("click", () => setTab("viewer"));
  app.viewer = createViewer({
    getDriver: () => app.driver,
    getDbPath: () => app.dbPath,
    getProfileId: () => app.currentProfileId,
    getExportStartDir: () => dialogStartDir("export"),
    labEntries,
    bodyRefs,
    onNotify: notify,
  });
  app.history = createHistory({
    getDriver: () => app.driver,
    getDbPath: () => app.dbPath,
    // 救援（刪除/改歸屬）後統一收斂：切換器＋狀態列＋檢視頁＋本卡
    onRescued: async () => { await setCurrentProfile(app.currentProfileId); },
    notify,
  });
  app.manager = createProfileManager({
    getDriver: () => app.driver,
    getCurrentProfileId: () => app.currentProfileId,
    // 成員異動（新增/改名/刪除）→ 清掉過時匯入面板、重新驗證當前成員並全面刷新
    onChanged: async () => {
      app.flow?.resetPanel();
      await setCurrentProfile(app.currentProfileId);
    },
  });

  // 換電腦或備份（2026-08-14 走查回饋：自管理成員面板的進階區移到「資料管理」
  // 分頁最下方）。2026-08-10 當初把「匯入既有資料庫檔」收進面板是因為它會
  // 取代整個資料庫、不該出現在主要動線上；移出後改以順序與警告文案處理——
  // 匯出（安全、常用）在前，匯入（破壞性）在後並明說會取代目前資料。
  document.getElementById("db-export-btn").addEventListener("click", async () => {
    const t = window.__TAURI__;
    const save = t.dialog.save || t.dialog.default?.save;
    const startDir = await dialogStartDir("export");
    const name = backupFileName(localDateISO());
    let target;
    try {
      target = await save({
        title: "匯出資料庫檔（含全部成員個資，請妥善保管）",
        defaultPath: defaultSavePath(startDir, name),
      });
    } catch (e) {
      notify(`匯出失敗：${String(e.message || e)}`, 10000);
      return;
    }
    if (!target) return;
    if (await t.fs.exists(target).catch(() => false)) {
      notify("目標已有同名檔案，請換一個檔名再匯出（未寫入任何內容）。", 10000);
      return;
    }
    try {
      await exportDbSnapshot(app.driver, target);
    } catch (e) {
      notify(`匯出失敗：${String(e.message || e)}`, 10000);
      return;
    }
    await rememberDialogDir("export", target);
    const bytes = await t.fs.stat(target).then(s => s.size).catch(() => null);
    const size = bytes != null ? `（${(bytes / 1024 / 1024).toFixed(1)}MB）` : "";
    notify(`已匯出資料庫：${target}${size}，含全部成員個資請妥善保管。`, 12000);
  });

  document.getElementById("db-import-btn").addEventListener("click", async () => {
    const p = await dialogOpen({ multiple: false, title: "選擇既有的 hwb.sqlite" });
    if (!p) return;
    const r = await importExisting(p);
    if (r?.ok) {
      app.flow?.resetPanel();
      await setCurrentProfile(app.currentProfileId);
      notify(`已匯入資料庫（schema v${r.version}）。`, 10000);
    } else if (r && r.reason !== "cancelled") {
      notify(r.reason === "too_new" ? "此資料庫版本較新，請先更新 App。"
        : "所選檔案不是本工具的資料庫檔。", 10000);
    }
  });
  app.flow = createImportFlow({
    getDriver: () => app.driver,
    labEntries,
    // 匯入面板就地新增成員 → 切換器同步；若此前零成員（currentProfileId
    // 為 null），必須立刻收斂當前成員，否則取消匯入後 header 與狀態列
    // 不一致且下拉點不動（Karen MEDIUM-1）
    onProfilesChanged: async () => {
      if (app.currentProfileId == null) await setCurrentProfile(null);
      else await refreshSwitcher();
    },
    onImported: async () => {
      await setCurrentProfile(app.currentProfileId);
      const report = document.getElementById("import-report");
      if (report && !report.querySelector("#goto-viewer-btn")) {
        const btn = document.createElement("button");
        btn.id = "goto-viewer-btn";
        btn.type = "button";
        btn.textContent = "前往資料檢視 →";
        btn.addEventListener("click", () => setTab("viewer"));
        report.prepend(btn);
      }
    },
  });
  document.getElementById("profile-select").addEventListener("change", async (e) => {
    // 換人時收起匯出提醒卡：卡片留在畫面上會讓確認鈕看起來仍屬於前一位成員
    document.getElementById("epub-confirm").hidden = true;
    await setCurrentProfile(Number(e.target.value));
  });
  document.getElementById("manage-profiles-btn").addEventListener("click",
    () => app.manager.open());
  // EPUB 匯出：先出 in-app 提醒卡（Books 的 iCloud 同步會讓健康資料離開
  // 本機，與本專案「不上傳」的定位衝突），確認後才進儲存對話框。
  // 用頁內元素不用原生 confirm（會凍住 WebView 事件，見 profile_manager.js）。
  const epubCard = document.getElementById("epub-confirm");
  document.getElementById("export-epub-btn").addEventListener("click", () => {
    epubCard.hidden = false;
  });
  document.getElementById("epub-cancel").addEventListener("click", () => {
    epubCard.hidden = true;
  });
  document.getElementById("epub-go").addEventListener("click", async () => {
    epubCard.hidden = true;
    let r;
    try {
      r = await app.viewer.exportEpub();
    } catch (err) {
      notify(`匯出失敗：${String(err?.message || err)}`, 10000);
      return;
    }
    if (r.ok) {
      await rememberDialogDir("export", r.path);
      notify(`已匯出：${r.path}（${(r.bytes / 1024).toFixed(0)}KB，含全部個資請妥善保管）`, 10000);
    } else if (r.reason === "no_data") {
      notify("目前成員尚無資料可匯出。");
    }
  });

  document.getElementById("export-html-btn").addEventListener("click", async () => {
    // 匯出失敗 NEVER 無聲（Karen HIGH-2：磁碟滿/唯讀/超長檔名原本
    // 表現為「按了沒反應」）
    let r;
    try {
      r = await app.viewer.exportHtml();
    } catch (err) {
      notify(`匯出失敗：${String(err?.message || err)}`, 10000);
      return;
    }
    if (r.ok) {
      await rememberDialogDir("export", r.path);
      notify(`已匯出：${r.path}（${(r.bytes / 1024).toFixed(0)}KB，含全部個資請妥善保管）`, 10000);
    } else if (r.reason === "no_data") {
      notify("目前成員尚無資料可匯出。");
    }
  });

  await refreshSwitcher();
  await refreshStatus();
  const { rendered } = await app.viewer.refresh();
  setTab(rendered ? "viewer" : "import");

  document.getElementById("dropzone").addEventListener("click", async () => {
    const p = await dialogOpen({ multiple: false, title: "選擇健保存摺或 Apple 健康匯出檔",
      defaultPath: await dialogStartDir("open") });
    if (p) {
      await rememberDialogDir("open", p);
      await app.flow.offerFile(p);
    }
  });
  // 通用選檔（2026-08-10 走查回饋：與拖放同能力，健保/Apple 都走這顆；
  // Apple 匯出「資料夾」情境用拖放，dropzone 文案已註明）
  document.getElementById("pick-file-btn").addEventListener("click", async () => {
    const p = await dialogOpen({ multiple: false, title: "選擇要匯入的檔案",
      defaultPath: await dialogStartDir("open") });
    if (p) {
      await rememberDialogDir("open", p);
      await app.flow.offerFile(p);
    }
  });
  // opener 插件到位後改直接開瀏覽器（2026-08-11 指示；剪貼簿方案退場），
  // 開啟失敗回退複製，確保任何情況都有路可走
  // 開瀏覽器（app-shell「檢查新版入口」：App 本體零連網，連網只發生在
  // 使用者主動開瀏覽器；不做自動版本檢查）
  const openExternal = async (url) => {
    try {
      await window.__TAURI__.opener.openUrl(url);
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        notify("無法直接開啟，已複製連結，貼到瀏覽器開啟即可。");
      } catch {
        notify(`請手動前往：${url}`);
      }
    }
  };
  document.getElementById("gh-open-btn").addEventListener("click", () =>
    openExternal("https://github.com/notoriouslab/health-workbench"));
  document.getElementById("check-update-btn").addEventListener("click", () =>
    openExternal("https://github.com/notoriouslab/health-workbench/releases"));

  // 版本標示（2026-08-13 走查：安裝版與 dev 版共用同一個資料目錄，開錯版本
  // 會建出舊 schema 的庫而症狀像功能壞掉）。版號兩者相同，光看版號分不出來，
  // 所以連執行來源一起標：資源路徑落在 target/debug 就是開發版。
  (async () => {
    const el = document.getElementById("app-version");
    if (!el) return;
    const t = window.__TAURI__;
    let ver = null, origin = "";
    try { ver = await t.app.getVersion(); } catch { /* 權限不足時只標來源 */ }
    try {
      const res = await t.path.resolveResource("");
      if (/[/\\]target[/\\]debug[/\\]/.test(res)) origin = "開發版";
      else if (/[/\\]target[/\\]release[/\\]/.test(res)) origin = "本機建置";
    } catch { /* 取不到就不標來源 */ }
    const parts = [ver ? `v${ver}` : null, origin || null].filter(Boolean);
    el.textContent = parts.length ? `｜${parts.join("・")}` : "";
  })();

  // 原生拖放（Tauri drag-drop 事件；HTML5 drop 在 Tauri 內拿不到路徑）
  const { listen } = window.__TAURI__.event;
  await listen("tauri://drag-enter", () => document.body.classList.add("dragover"));
  await listen("tauri://drag-leave", () => document.body.classList.remove("dragover"));
  await listen("tauri://drag-drop", async (e) => {
    document.body.classList.remove("dragover");
    const paths = e.payload?.paths ?? [];
    if (paths.length) await app.flow.offerFile(paths[0]);
  });
}

if (window.__TAURI__) {
  boot()
    .then(() => wireUi())
    .catch((err) => {
      const raw = String(err?.message || err);
      statusEl.textContent = /database|open|readonly|permission/i.test(raw)
        ? `無法建立或開啟資料庫，請確認應用程式資料目錄可寫入。（${raw}）`
        : `啟動失敗：${raw}`;
    });
} else {
  statusEl.textContent = "非 Tauri 環境（瀏覽器預覽模式）。";
}
