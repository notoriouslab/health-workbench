// 「資料庫與匯入紀錄」卡（匯入分頁）：資料庫管理視角（design D3），
// 不隨成員切換器過濾——資料庫位置、全庫各類筆數、來源檔案清單
// 依成員分組列出全部成員。分組邏輯為純函式（groupDocsByProfile），
// tests/ui/history_grouping.test.mjs 直測。
// 誤歸屬救援入口（misattribution-rescue design D5）：每筆來源檔案列
// 「刪除…」「改歸屬…」，開明細預覽確認面板；面板模型為純函式
// （buildRescuePreviewModel），tests/ui/rescue_preview.test.mjs 直測。
import { previewDocRescue, deleteSourceDocument, reattributeSourceDocument,
  previewBatchRescue, deleteSourceBatch, reattributeSourceBatch }
  from "../engine/doc_rescue.js";
import { cleanupPreview, releaseSpace } from "../engine/cleanup.js";
import { listProfiles } from "../engine/profiles.js";

export const ADAPTER_LABELS = {
  nhi_json: "健保存摺（JSON）",
  nhi_xml: "健保存摺（XML）",
  apple_health: "Apple 健康",
  // 與檢視層 app.js 的 ADAPTER_ZH 同字串（另三個 adapter 兩處本來就一致）。
  // 兩份標籤表無自動守衛，改一邊要記得改另一邊。
  resmed_edf: "CPAP（ResMed）",
};

export const RESCUE_TABLE_LABELS = {
  encounters: "就醫", medications: "用藥", lab_results: "檢驗",
  reports: "報告", immunizations: "疫苗", body_measurements: "身體數值",
  cancer_screenings: "癌症篩檢", apple_records: "Apple 紀錄",
  apple_workouts: "Apple 體能訓練", apple_daily: "Apple 每日彙總",
  cpap_daily: "睡眠每日摘要", cpap_events: "呼吸事件", cpap_oximetry: "睡眠血氧",
};

// 紀錄頁「全部資料」那行要統計的表，依顯示順序排（標籤共用
// RESCUE_TABLE_LABELS，不另養一份）。2026-08-13 實機走查發現這份清單原本
// 漏了六張表（CPAP 三表、apple_workouts、body_measurements、
// cancer_screenings），畫面上列著 41 個 CPAP 來源檔卻一筆都沒算進去。
// tests/ui/history_grouping.test.mjs 以 DDL 對帳釘住：schema 新增資料表
// 而這裡沒跟上就會轉紅。
export const COUNT_TABLES = ["encounters", "medications", "lab_results",
  "reports", "immunizations", "cancer_screenings", "apple_records",
  "apple_workouts", "apple_daily", "body_measurements",
  "cpap_daily", "cpap_events", "cpap_oximetry"];

// 轉義含 " （面板有屬性位置插值需求，且與 profile_manager／import_flow
// 的 esc 保持一致，杜絕屬性逃逸；tests/ui/esc_consistency.test.mjs 釘住）
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// 純函式：來源檔列（含 profile 名）→ [{ profileName, docs: [...] }]，
// 依成員 id 升冪分組、組內維持傳入順序（呼叫端以匯入時間排序）
export function groupDocsByProfile(docs) {
  const groups = new Map();
  for (const d of docs) {
    if (!groups.has(d.profile_id)) {
      groups.set(d.profile_id, { profileName: d.profile_name, docs: [] });
    }
    groups.get(d.profile_id).docs.push(d);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}

// 純函式：來源檔列 → 依「同 adapter ＋同 imported_at」分批（change
// viewer-and-history-refinement D7）。一次多檔匯入會產生數十列，逐列呈現使
// 該區塊失去可讀性。
//
// 語意 MUST 與檢視層 app.js 的 groupSources 一致：那份是自包含嵌進單檔 HTML
// 的（零外部相依是它的設計前提），不能 import 這裡，所以兩份必然分開。
// tests/ui/history_batching.test.mjs 與 sleep_render.test.mjs 用**同一組測試
// 向量**分別斷言兩邊，避免規則各自漂移而沒有任何錯誤訊息。
//
// 批次判定依賴 imported_at 在批內相同，這由匯入端保證（多檔來源整批共用一個
// 時間戳，見 engine/store.js 的 registerSource）。
export function groupDocsByBatch(docs) {
  const out = [];
  const idx = new Map();
  for (const d of docs || []) {
    const key = `${d.adapter}|${d.imported_at}`;
    if (!idx.has(key)) {
      idx.set(key, out.length);
      out.push({ adapter: d.adapter, importedAt: d.imported_at, docs: [],
        inserted: {}, dupTotal: 0, missingStats: false, missingCount: 0 });
    }
    const g = out[idx.get(key)];
    g.docs.push(d);
    let st = null;
    try {
      st = d.import_stats ? JSON.parse(d.import_stats) : null;
    } catch { st = null; } // 不可解析＝當作沒有統計，不讓整批渲染失敗
    if (!st) { g.missingStats = true; g.missingCount += 1; continue; }
    for (const [t, n] of Object.entries(st.inserted || {})) {
      g.inserted[t] = (g.inserted[t] || 0) + n;
    }
    g.dupTotal += Object.values(st.skipped_dup || {})
      .reduce((a, b) => a + b, 0);
  }
  return out;
}

// 純函式：批次的統計 → 匯入紀錄那一欄的文字。
//
// 缺統計的列不得抹掉同批其他列的數字（2026-08-14 紅隊複現）：一批裡只要有
// 一個檔解析失敗，它的 import_stats 就是 NULL（registerSource 在 parseHeader
// 之前，失敗時 continue 跳過 finalizeImport），原本整批因此顯示「早期匯入，
// 無統計」，把同批成功檔案的真實筆數全部丟掉。
export function insertedText(inserted, missing, missingCount = 0) {
  const n = Object.values(inserted).reduce((a, b) => a + b, 0);
  if (!missing) return `新增 ${n.toLocaleString()} 筆`;
  if (!n) return "（早期匯入，無統計）";
  return `新增 ${n.toLocaleString()} 筆（另有 ${missingCount} 個檔案無統計）`;
}

// 純函式：previewDocRescue 結果 → 面板顯示模型（design D5、決定 #52）。
// mode: "delete" | "reattribute"；targetName: 已選目標成員名（未選＝null）
export function buildRescuePreviewModel(preview, { mode, targetName = null }) {
  const countsTotal = Object.values(preview.counts).reduce((s, n) => s + n, 0);
  const countsText = Object.entries(preview.counts)
    .filter(([, c]) => c > 0)
    .map(([t, c]) => `${RESCUE_TABLE_LABELS[t] || t} ${c.toLocaleString()}`)
    .join("、") || "無資料列";
  // D2 重疊警告（doc 級啟發式，可能過度警告故文案用「可能」）
  const warning = preview.overlapWarning
    ? "注意：這位成員的其他匯入檔案曾與本檔發生重複紀錄。此操作可能"
      + "連帶移除其他檔案也含有的紀錄，且因重複檔案判定，該些檔案"
      + "無法重匯回補。"
    : null;
  if (mode === "delete") {
    return {
      summary: `即將刪除來源檔案「${preview.doc.filename}」與其全部資料列`
        + "（此檔案之後可重新匯入）。",
      countsText, warning,
      blocked: false, blockReason: null, mergeText: null, bindingText: null,
      confirmDisabled: false,
    };
  }
  // reattribute
  const guard = preview.nhiGuard;
  const blocked = guard?.blocked ?? false;
  let mergeText = null;
  if (targetName != null && preview.merge) {
    const moved = countsTotal - preview.merge.total;
    mergeText = `搬移 ${moved.toLocaleString()} 筆`
      + (preview.merge.total > 0
        ? `、與「${targetName}」既有紀錄重複合併 ${preview.merge.total.toLocaleString()} 筆`
        : "");
  }
  const bindingText = guard && !blocked && guard.willUnbindSource
    ? `「${preview.doc.displayName}」的健保身分證綁定將解除並轉移給`
      + `「${targetName}」。`
    : null;
  return {
    summary: `即將把來源檔案「${preview.doc.filename}」連同其全部資料列`
      + `改歸屬${targetName ? `給「${targetName}」` : ""}。`,
    countsText, warning,
    blocked, blockReason: blocked ? guard.reason : null,
    mergeText, bindingText,
    confirmDisabled: blocked || targetName == null,
  };
}

// 純函式：previewBatchRescue 結果 → 面板模型（形狀與 buildRescuePreviewModel
// 相同，面板渲染共用）。mode: "batch-delete" | "batch-reattribute"
export function buildBatchRescuePreviewModel(preview, { mode, targetName = null }) {
  const countsTotal = Object.values(preview.counts).reduce((s, n) => s + n, 0);
  const countsText = Object.entries(preview.counts)
    .filter(([, c]) => c > 0)
    .map(([t, c]) => `${RESCUE_TABLE_LABELS[t] || t} ${c.toLocaleString()}`)
    .join("、") || "無資料列";
  const warning = preview.overlapWarning
    ? "注意：這位成員的其他匯入檔案曾與這批檔案發生重複紀錄。此操作可能"
      + "連帶移除其他檔案也含有的紀錄，且因重複檔案判定，該些檔案"
      + "無法重匯回補。"
    : null;
  const batchDesc = `這批 ${preview.docCount} 個來源檔案`;
  if (mode === "batch-delete") {
    return {
      summary: `即將刪除${batchDesc}與其全部資料列（這些檔案之後可重新匯入）。`,
      countsText, warning,
      blocked: false, blockReason: null, mergeText: null, bindingText: null,
      confirmDisabled: false,
    };
  }
  const guard = preview.nhiGuard;
  const blocked = guard?.blocked ?? false;
  let mergeText = null;
  if (targetName != null && preview.merge) {
    const moved = countsTotal - preview.merge.total;
    mergeText = `搬移 ${moved.toLocaleString()} 筆`
      + (preview.merge.total > 0
        ? `、與「${targetName}」既有紀錄重複合併 ${preview.merge.total.toLocaleString()} 筆`
        : "");
  }
  const bindingText = guard && !blocked && guard.willUnbindSource
    ? `「${preview.displayName}」的健保身分證綁定將解除並轉移給`
      + `「${targetName}」。`
    : null;
  return {
    summary: `即將把${batchDesc}連同其全部資料列`
      + `改歸屬${targetName ? `給「${targetName}」` : ""}。`,
    countsText, warning,
    blocked, blockReason: blocked ? guard.reason : null,
    mergeText, bindingText,
    confirmDisabled: blocked || targetName == null,
  };
}

export function createHistory({ getDriver, getDbPath, onRescued, notify }) {
  const box = document.getElementById("import-history");
  // 進行中的救援面板狀態；refresh() 整卡重繪即收合
  let rescue = null; // { mode, docId, targetProfileId }

  const sumValues = (obj) => Object.values(obj).reduce((s, n) => s + n, 0);

  async function renderRescuePanel() {
    const panel = box.querySelector("#rescue-inline");
    if (!panel || !rescue) return;
    const driver = getDriver();
    const batch = rescue.docIds != null;
    const preview = batch
      ? await previewBatchRescue(driver, rescue.docIds,
        { targetProfileId: rescue.targetProfileId })
      : await previewDocRescue(driver, rescue.docId,
        { targetProfileId: rescue.targetProfileId });
    // 批次預覽把 doc 攤平在頂層，單檔版包在 preview.doc 裡
    const owner = batch
      ? { profileId: preview.profileId, displayName: preview.displayName,
        importedAt: preview.importedAt }
      : preview.doc;
    const profiles = await listProfiles(driver);
    const targets = profiles.filter(p => p.id !== owner.profileId);
    const target = targets.find(t => t.id === rescue.targetProfileId) ?? null;
    const model = batch
      ? buildBatchRescuePreviewModel(preview,
        { mode: rescue.mode, targetName: target?.display_name ?? null })
      : buildRescuePreviewModel(preview,
        { mode: rescue.mode, targetName: target?.display_name ?? null });
    const isReattribute = rescue.mode === "reattribute"
      || rescue.mode === "batch-reattribute";
    const targetPicker = !isReattribute ? "" : (targets.length
      ? `<p>改歸屬給：<select id="rescue-target">
          <option value="" ${target ? "" : "selected"} disabled>請選擇成員</option>
          ${targets.map(t => `<option value="${t.id}"
            ${t.id === rescue.targetProfileId ? "selected" : ""}>
            ${esc(t.display_name)}</option>`).join("")}
        </select></p>`
      : "<p class=\"warn\">尚無其他成員可改歸屬，請先於「管理成員…」新增。</p>");
    panel.hidden = false;
    panel.innerHTML = `
      <p>${esc(model.summary)}</p>
      <p class="dt">內容：${esc(model.countsText)}；匯入於 ${esc(owner.importedAt)}，
        原歸屬「${esc(owner.displayName)}」。</p>
      ${targetPicker}
      ${model.mergeText ? `<p>${esc(model.mergeText)}</p>` : ""}
      ${model.bindingText ? `<p>${esc(model.bindingText)}</p>` : ""}
      ${model.warning ? `<p class="warn">${esc(model.warning)}</p>` : ""}
      ${model.blockReason ? `<p class="warn">${esc(model.blockReason)}</p>` : ""}
      <button id="rescue-go" type="button" class="danger"
        ${model.confirmDisabled ? "disabled" : ""}>
        ${isReattribute ? "確認改歸屬"
          : (batch ? "確認剔除整批" : "確認刪除")}</button>
      <button id="rescue-cancel" type="button" class="btn">取消</button>`;
    panel.querySelector("#rescue-target")?.addEventListener("change", async (e) => {
      rescue.targetProfileId = Number(e.target.value);
      await renderRescuePanel();
    });
    panel.querySelector("#rescue-cancel").addEventListener("click", () => {
      rescue = null;
      panel.hidden = true;
      panel.innerHTML = "";
    });
    panel.querySelector("#rescue-go").addEventListener("click", executeRescue);
  }

  async function executeRescue() {
    const { mode, docId, docIds, targetProfileId } = rescue;
    const driver = getDriver();
    try {
      if (mode === "delete" || mode === "batch-delete") {
        const r = mode === "batch-delete"
          ? await deleteSourceBatch(driver, docIds)
          : await deleteSourceDocument(driver, docId);
        const what = r.docCount != null
          ? `${r.docCount} 個來源檔案` : "來源檔案";
        notify(`已刪除${what}與其資料 ${sumValues(r.deleted).toLocaleString()} 筆`
          + `${r.unbound ? "，並解除該成員的健保身分證綁定" : ""}。`
          + "同一檔案之後可重新匯入。", 10000);
      } else {
        const r = mode === "batch-reattribute"
          ? await reattributeSourceBatch(driver, docIds, targetProfileId)
          : await reattributeSourceDocument(driver, docId, targetProfileId);
        notify(`已改歸屬：搬移 ${sumValues(r.moved).toLocaleString()} 筆`
          + (sumValues(r.merged) > 0
            ? `、與目標既有紀錄合併 ${sumValues(r.merged).toLocaleString()} 筆` : "")
          + `${r.binding.targetBound ? "，健保身分證綁定已隨之轉移" : ""}。`, 10000);
      }
      rescue = null;
      // 統一收斂點刷新（切換器＋狀態列＋檢視頁＋本卡）；失敗上浮不靜默
      await onRescued?.();
    } catch (err) {
      notify(`救援操作失敗：${String(err?.message || err)}`, 10000);
      // 面板留著讓使用者重試或取消；重算預覽（資料庫狀態可能已不同）
      await renderRescuePanel().catch(() => {
        rescue = null;
        box.querySelector("#rescue-inline")?.setAttribute("hidden", "");
      });
    }
  }

  // 大小顯示：MB／GB 自動換檔（文案數字全程實算，NEVER 寫死容量）
  function fmtBytes(n) {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    return `${Math.max(Math.round(n / 1024 ** 2), 1)} MB`;
  }

  // 釋放空間（health-database「釋放空間」）：頁內確認（MUST NOT 原生
  // confirm）→ 引擎執行（對帳防線＋交易 DELETE＋交易外 VACUUM）→
  // 回報實際前後大小 → 卡片與檢視頁刷新
  function wireCleanup() {
    const btn = box.querySelector("#cleanup-btn");
    const inline = box.querySelector("#cleanup-inline");
    if (!btn || !inline) return;
    btn.addEventListener("click", async () => {
      try {
        const p = await cleanupPreview(getDriver());
        if (!p.deletableRows) {
          notify("沒有可清理的逐筆明細（彙總型別的明細已是空的）。");
          return;
        }
        inline.innerHTML = `
          <p><b>釋放空間</b></p>
          <p>刪除已彙總的逐筆明細（${p.deletableRows.toLocaleString()} 筆）。
            目前資料庫 ${esc(fmtBytes(p.sizeBytes))}，清理後約
            ${esc(fmtBytes(p.estAfterBytes))}。</p>
          <p>每日統計與所有圖表不受影響，但逐筆明細刪除後不會再回來。
            整理過程需要約等於清理後資料庫大小的暫時磁碟空間。</p>
          <p><button id="cleanup-go" type="button" class="primary">確認釋放空間</button>
            <button id="cleanup-cancel" type="button" class="btn">取消</button></p>`;
        inline.hidden = false;
        inline.querySelector("#cleanup-cancel").addEventListener("click", () => {
          inline.hidden = true; inline.innerHTML = "";
        });
        inline.querySelector("#cleanup-go").addEventListener("click", async () => {
          const go = inline.querySelector("#cleanup-go");
          go.disabled = true;
          go.textContent = "清理中…";
          try {
            const r = await releaseSpace(getDriver());
            inline.hidden = true; inline.innerHTML = "";
            const sizeMsg = `${fmtBytes(r.beforeBytes)} → ${fmtBytes(r.afterBytes)}`;
            if (r.vacuumError) {
              notify(`已刪除 ${r.deletedRows.toLocaleString()} 筆逐筆明細，資料一致；`
                + `但空間整理未完成（${r.vacuumError}），可稍後再按一次釋放空間重試。`, 12000);
            } else {
              notify(`釋放空間完成：刪除 ${r.deletedRows.toLocaleString()} 筆逐筆明細，`
                + `資料庫 ${sizeMsg}。`, 12000);
            }
            await refresh();
            await onRescued?.();
          } catch (err) {
            inline.hidden = true; inline.innerHTML = "";
            notify(`釋放空間已中止：${String(err?.message || err)}`, 12000);
          }
        });
      } catch (err) {
        notify(`無法計算清理範圍：${String(err?.message || err)}`, 10000);
      }
    });
  }

  async function refresh() {
    rescue = null; // 整卡重繪：收合進行中的面板，避免引用失效 doc
    const driver = getDriver();
    const counts = {};
    for (const t of COUNT_TABLES) {
      const [{ c }] = await driver.select(`SELECT count(*) c FROM ${t}`);
      counts[RESCUE_TABLE_LABELS[t] || t] = c;
    }
    const docs = await driver.select(
      "SELECT d.id, d.filename, d.adapter, d.imported_at, d.import_stats,"
      + " d.profile_id, p.display_name AS profile_name"
      + " FROM source_documents d JOIN profiles p ON d.profile_id = p.id"
      + " ORDER BY d.imported_at DESC");
    const countText = Object.entries(counts)
      .filter(([, c]) => c > 0)
      .map(([label, c]) => `${label} ${c.toLocaleString()}`).join("、") || "尚無資料";
    // 單檔操作鈕（多檔批次展開後每一檔也有一組，見 D5）
    const docBtns = (d) => `<button type="button" class="btn rescue-btn"
        data-mode="reattribute" data-doc="${d.id}">改歸屬…</button>
      <button type="button" class="btn rescue-btn"
        data-mode="delete" data-doc="${d.id}">刪除…</button>`;
    // 一批一列：單檔批次直接顯示檔名；多檔批次摺疊成「N 個檔案」，展開後
    // 逐檔仍在（payload 與資料層都保留逐檔追溯，摺疊只做在檢視層）
    const batchRow = (b) => {
      const single = b.docs.length === 1;
      const fileCell = single
        ? esc(b.docs[0].filename)
        : `<details><summary>${b.docs.length} 個檔案</summary>
            ${b.docs.map(d => `<div class="dt">${esc(d.filename)}
              ${docBtns(d)}</div>`).join("")}</details>`;
      const ids = b.docs.map(d => d.id).join(",");
      const actions = single ? docBtns(b.docs[0])
        : `<button type="button" class="btn rescue-btn"
              data-mode="batch-reattribute" data-docs="${ids}">改歸屬…</button>
           <button type="button" class="btn rescue-btn"
              data-mode="batch-delete" data-docs="${ids}">剔除整批…</button>`;
      return `<tr><td class="dt">${esc(b.importedAt)}</td>
        <td>${esc(ADAPTER_LABELS[b.adapter] || b.adapter)}</td>
        <td>${fileCell}</td>
        <td class="dt">${esc(insertedText(b.inserted, b.missingStats, b.missingCount))}</td>
        <td class="dt">${actions}</td></tr>`;
    };
    const groups = groupDocsByProfile(docs.map(r => ({ ...r })));
    const groupHtml = groups.map((g) => `
      <h4 class="profile-group">成員「${esc(g.profileName)}」</h4>
      <table><thead><tr><th>匯入時間</th><th>格式</th><th>檔案</th><th></th><th></th></tr></thead>
        <tbody>${groupDocsByBatch(g.docs).map(batchRow).join("")}</tbody></table>`).join("");
    // 整卡重繪會重置 <details> 的展開狀態，先記下來再還原
    const wasOpen = box.open;
    box.innerHTML = `
      <summary>資料庫與匯入紀錄<span class="dt">（${docs.length} 筆來源檔案）</span></summary>
      <p class="dbline">全部資料：${esc(countText)}</p>
      <p class="dbline dt">資料庫位置：${esc(getDbPath())}</p>
      <p class="dbline"><button id="cleanup-btn" type="button" class="btn">釋放空間…</button></p>
      <div id="cleanup-inline" hidden></div>
      <div id="rescue-inline" hidden></div>
      ${groupHtml}`;
    box.open = wasOpen;
    wireCleanup();
    for (const btn of box.querySelectorAll(".rescue-btn")) {
      btn.addEventListener("click", async () => {
        const docIds = btn.dataset.docs
          ? btn.dataset.docs.split(",").map(Number) : null;
        rescue = { mode: btn.dataset.mode, docIds,
          docId: docIds ? null : Number(btn.dataset.doc),
          targetProfileId: null };
        try {
          await renderRescuePanel();
        } catch (err) {
          rescue = null;
          notify(`無法載入救援預覽：${String(err?.message || err)}`, 10000);
        }
      });
    }
  }

  return { refresh };
}
