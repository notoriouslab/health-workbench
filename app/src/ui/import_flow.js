// 匯入操作流程（app-import-gui spec）：判型確認（含歸屬成員選擇）→
// 進度 → 報告卡/防護訊息。狀態機：idle → confirming → importing →
// done/aborted/error。防重入：importing 期間拒收新檔。
// 歸屬選擇（D1）：必選無預設、可就地新增成員；健保檔選定成員即時顯示
// 身分證比對三態（attributionState 純函式，tests/ui/attribution.test.mjs
// 直測），不符停用「開始匯入」；b1.1 預讀不可得時交引擎護欄第二層把關。
import { registry } from "../adapters/index.js";
import { tauriFileSource, resolveAppleDirTauri, collectDirEntriesTauri,
  buildSourceSetTauri } from "../engine/tauri_source.js";
import { nhiJsonAdapter } from "../adapters/nhi_json.js";
import { nhiXmlAdapter } from "../adapters/nhi_xml.js";
import { listProfiles, createProfile } from "../engine/profiles.js";
import { withWalWindow } from "../engine/bulk_write.js";

const $ = (id) => document.getElementById(id);

// 純函式：三態判定（app-import-gui spec）。member=null 表示未選。
// 回傳 "none"（未選/非健保/預讀不到）| "bind"（將綁定）| "match" | "mismatch"
export function attributionState(maskedId, member) {
  if (!member || !maskedId) return "none";
  if (!member.masked_id) return "bind";
  return member.masked_id === maskedId ? "match" : "mismatch";
}

export function attributionNote(maskedId, member) {
  const esc = escapeHtml;
  switch (attributionState(maskedId, member)) {
    case "bind":
      return `<p>將把遮罩身分證 <strong>${esc(maskedId)}</strong> 綁定至成員「${esc(member.display_name)}」。</p>`;
    case "match":
      return `<p>檔案遮罩身分證與成員「${esc(member.display_name)}」相符。</p>`;
    case "mismatch":
      return `<p class="warn">檔案遮罩身分證 ${esc(maskedId)} 與成員「${esc(member.display_name)}」`
        + `已綁定的 ${esc(member.masked_id)} 不符，請改選正確成員。</p>`;
    default:
      return "";
  }
}

// 確認面板的來源標籤（純函式，tests/ui/import_batch.test.mjs 直測）。
// 單檔顯示檔名與大小；多檔來源顯示資料夾名、檔數與合計大小。
export function sourceChipText(pending) {
  const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
  if (pending?.sourceSet) {
    return `${pending.sourceSet.rootName}｜${pending.fileCount} 個檔案，`
      + `合計 ${mb(pending.totalBytes)}`;
  }
  return `${pending.source.name}｜${mb(pending.source.size)}`;
}

// 批次匯入的檔案摘要（純函式）。files 為 [{ file, status, rows }]
export function batchSummary(files) {
  const by = (s) => files.filter(f => f.status === s).length;
  return {
    total: files.length,
    parsed: by("parsed"),
    duplicate: by("duplicate"),
    parseError: by("parse_error"),
    oversize: by("skipped_oversize"),
    rows: files.reduce((a, f) => a + (f.rows || 0), 0),
  };
}

const FILE_STATUS_ZH = {
  parsed: "已解析",
  duplicate: "先前已匯入",
  parse_error: "解析失敗",
  skipped_oversize: "超過單檔上限，略過",
};

// 逐檔明細（批次匯入才有）。收合呈現：上百個檔案不該淹沒節區摘要。
function fileDetails(files) {
  const s = batchSummary(files);
  const head = [
    `${s.total} 個檔案`,
    s.parsed ? `已解析 ${s.parsed}` : "",
    s.duplicate ? `先前已匯入 ${s.duplicate}` : "",
    s.parseError ? `解析失敗 ${s.parseError}` : "",
    s.oversize ? `略過 ${s.oversize}` : "",
  ].filter(Boolean).join("｜");
  const rows = files.map(f => `<tr><td>${escapeHtml(f.file)}</td>
    <td>${escapeHtml(FILE_STATUS_ZH[f.status] ?? f.status)}</td>
    <td>${Number(f.rows) || 0}</td></tr>`).join("");
  return `<details><summary>逐檔明細（${escapeHtml(head)}）</summary>
    <table><thead><tr><th>檔案</th><th>狀態</th><th>筆數</th></tr></thead>
    <tbody>${rows}</tbody></table></details>`;
}

export function createImportFlow({ getDriver, labEntries, onImported,
  onProfilesChanged }) {
  let state = "idle";
  let pending = null; // { adapter, source, path, maskedId, profileId }

  const panel = $("import-panel");
  const msg = $("import-msg");
  const confirmBox = $("import-confirm");
  const progressBox = $("import-progress");
  const bar = $("import-bar");
  const progressText = $("import-progress-text");
  const reportBox = $("import-report");

  function show(el) {
    for (const e of [confirmBox, progressBox, reportBox]) e.hidden = e !== el;
    panel.hidden = false;
  }
  function say(text) {
    msg.textContent = text;
    msg.hidden = !text;
  }

  // 對外殼層：判型與準備階段的例外一律轉成畫面上的錯誤卡。沒有這層時
  // 拖放的 listener（main.js 的 tauri://drag-drop）沒有接手者，例外會變成
  // 未捕捉的 rejection，畫面完全沒有反應（2026-08-13 走查：CPAP 資料夾
  // 撞上 fs scope 拒絕點開頭的檔案，拖進去毫無反應）。
  // 措辭不走 friendlyError：那組分類是為匯入階段寫的（「重新下載檔案」
  // 對讀取／權限類失敗是錯誤的引導）。
  async function offerFile(path) {
    try {
      return await offerFileInner(path);
    } catch (err) {
      pending = null;
      state = "idle";
      say("");
      const raw = String(err?.message || err);
      reportBox.innerHTML = `<p class="warn">${escapeHtml(readFailureMessage(raw))}</p>`
        + `<details><summary>技術細節</summary><p>${escapeHtml(raw)}</p></details>`;
      show(reportBox);
      return { state, error: raw };
    }
  }

  async function offerFileInner(path) {
    if (state === "importing") {
      say("匯入進行中，請等本次完成後再加入新檔案。");
      return { state, rejected: "busy" };
    }
    // 資料夾（Apple 匯出資料夾情境）→ 解析出 XML 檔
    const fs = window.__TAURI__.fs;
    const st = await fs.stat(path).catch(() => null);
    if (!st) {
      say(`讀不到檔案：${path}`);
      return { state, rejected: "unreadable" };
    }
    let filePath = path;
    if (st.isDirectory) {
      // 多檔來源優先（design D9）：detectSet 判的是「這批檔案整體是什麼」，
      // 條件嚴格；resolveAppleDirTauri 判的是「有沒有任何非 cda 的 XML」，
      // 條件寬鬆且會下潛一層。寬鬆的放後面，含無關 XML 的 SD 卡才不會被
      // 誤判成 Apple 匯出。
      const dirEntries = await collectDirEntriesTauri(path);
      const setAdapter = await registry.detectSet(dirEntries);
      if (setAdapter) {
        const sourceSet = await buildSourceSetTauri(path, dirEntries);
        const totalBytes = sourceSet.entries.reduce(
          (a, e) => a + (e.source.size || 0), 0);
        pending = { adapter: setAdapter, sourceSet, path, maskedId: null,
          profileId: null, fileCount: sourceSet.entries.length, totalBytes };
        state = "confirming";
        say("");
        await renderConfirm();
        return { state, detected: setAdapter.id };
      }
      const resolved = await resolveAppleDirTauri(path);
      if (!resolved) {
        // 兩種路徑都不認得：比照單檔未識別，列出全部支援格式，
        // 不再只說「找不到 Apple Health XML」（現在支援的不只 Apple）
        say(`無法識別資料夾「${escapeHtml(path.split(/[/\\]/).pop())}」。目前支援的格式：`);
        confirmBox.innerHTML = `<ul>${registry.formats()
          .map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`;
        show(confirmBox);
        state = "idle";
        return { state, rejected: "unknown_format", formats: registry.formats() };
      }
      filePath = resolved;
    }
    const source = await tauriFileSource(filePath);
    const header = await source.readAt(0, Math.min(65536, source.size));
    const adapter = registry.detect(header, source.name);
    if (!adapter) {
      say(`無法識別「${escapeHtml(source.name)}」。目前支援的格式：`);
      confirmBox.innerHTML = `<ul>${registry.formats()
        .map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`;
      show(confirmBox);
      state = "idle";
      return { state, rejected: "unknown_format", formats: registry.formats() };
    }
    // 健保檔：自 header 預讀遮罩身分證（64KB peek 的已知限制：讀不到時
    // note 為空、engine 護欄把關）
    let maskedId = null;
    if (adapter.id === "nhi_json" || adapter.id === "nhi_xml") {
      const headText = new TextDecoder("utf-8", { fatal: false }).decode(header);
      const m = headText.match(/"b1\.1"\s*:\s*"([^"]*)"/) || headText.match(/<b1\.1>([^<]*)<\/b1\.1>/);
      maskedId = m?.[1]?.trim() || null;
    }
    pending = { adapter, source, path: filePath, maskedId, profileId: null };
    state = "confirming";
    say("");
    await renderConfirm();
    return { state, detected: adapter.id };
  }

  // 判型確認面板：格式＋檔名＋歸屬成員選擇（必選無預設）＋三態提示
  async function renderConfirm({ newMemberMode = false } = {}) {
    const profiles = await listProfiles(getDriver());
    const { adapter, maskedId, profileId } = pending;
    const selected = profiles.find(p => p.id === profileId) ?? null;
    const zeroMembers = profiles.length === 0;
    const options = [
      `<option value="" disabled ${profileId == null ? "selected" : ""}>請選擇成員</option>`,
      ...profiles.map(p => `<option value="${p.id}" ${p.id === profileId ? "selected" : ""}>`
        + `${escapeHtml(p.display_name)}${p.masked_id ? `（${escapeHtml(p.masked_id)}）` : ""}</option>`),
      `<option value="__new__">＋新增成員…</option>`,
    ].join("");
    const mismatch = attributionState(maskedId, selected) === "mismatch";
    const canGo = profileId != null && !mismatch;
    confirmBox.innerHTML = `
      <p class="fmt">${escapeHtml(adapter.formatDesc)}</p>
      <p><span class="file-chip">${escapeHtml(sourceChipText(pending))}</span></p>
      <div class="attribution">
        <label for="import-profile-select">這份資料屬於：</label>
        ${zeroMembers && !newMemberMode
          ? `<p>第一次使用：請先建立這份資料所屬的成員。</p>`
          : `<select id="import-profile-select">${options}</select>`}
        ${selected ? `<p class="attribution-chip">歸屬成員：<strong>${escapeHtml(selected.display_name)}</strong></p>` : ""}
        ${attributionNote(maskedId, selected)}
        <div id="import-new-member" ${zeroMembers || newMemberMode ? "" : "hidden"}>
          <input id="import-new-name" type="text" placeholder="成員名稱（如：本人、媽媽）">
          <button id="import-new-go" type="button" class="btn">建立成員</button>
        </div>
      </div>
      <button id="import-go" type="button" class="primary" ${canGo ? "" : "disabled"}>開始匯入</button>
      <button id="import-cancel" type="button" class="btn">取消</button>`;
    show(confirmBox);
    confirmBox.querySelector("#import-profile-select")?.addEventListener("change",
      async (e) => {
        if (e.target.value === "__new__") {
          pending.profileId = null;
          await renderConfirm({ newMemberMode: true });
          confirmBox.querySelector("#import-new-name")?.focus();
          return;
        }
        pending.profileId = Number(e.target.value);
        await renderConfirm();
      });
    confirmBox.querySelector("#import-new-go")?.addEventListener("click", async () => {
      const name = confirmBox.querySelector("#import-new-name").value;
      try {
        pending.profileId = await createProfile(getDriver(), name);
        await onProfilesChanged?.();
        await renderConfirm();
      } catch (err) {
        say(String(err.message || err));
      }
    });
    $("import-go").addEventListener("click", () => runImport());
    $("import-cancel").addEventListener("click", () => {
      pending = null; state = "idle"; panel.hidden = true; say("");
    });
  }

  async function runImport() {
    if (!pending || state === "importing" || pending.profileId == null) return { state };
    const { adapter, source, sourceSet, path, profileId } = pending;
    // 報告卡顯示歸屬成員（D1 防呆：Apple 檔人眼確認的最後一環）
    const profiles = await listProfiles(getDriver());
    const memberName = profiles.find(p => p.id === profileId)?.display_name ?? "";
    state = "importing";
    show(progressBox);
    bar.value = 0;
    progressText.textContent = "開始匯入…";
    const progress = (processed, totalBytes, readBytes) => {
      window.__MHB_PROGRESS_EVENTS__ = (window.__MHB_PROGRESS_EVENTS__ || 0) + 1;
      if (totalBytes > 0) bar.value = Math.min(100, (readBytes / totalBytes) * 100);
      progressText.textContent = processed === 0
        ? `正在檢查檔案是否曾經匯入…（${Math.round(bar.value)}%）`
        : `已處理 ${processed.toLocaleString()} 筆（${Math.round(bar.value)}%）`;
    };
    let result;
    try {
      // 匯入期切 WAL（大量寫入 -26%），完成或失敗都收斂回單檔；
      // 窗口在交易外（adapter 內才開交易）
      if (sourceSet) {
        // 多檔來源：整批在單一交易內完成（design D1）
        result = await withWalWindow(getDriver(), () =>
          adapter.importSourceSet(sourceSet, getDriver(), progress,
            { labEntries, profileId }));
      } else {
        const needsBytes = adapter === nhiJsonAdapter || adapter === nhiXmlAdapter;
        const src = needsBytes
          ? { bytes: await window.__TAURI__.fs.readFile(path), name: source.name }
          : source;
        result = await withWalWindow(getDriver(), () =>
          adapter.importSource(src, getDriver(), progress,
            { labEntries, profileId }));
      }
    } catch (err) {
      state = "idle";
      pending = null;
      const [friendly, detail] = friendlyError(err);
      say("");
      reportBox.innerHTML = `<p class="warn">${escapeHtml(friendly)}</p>`
        + (detail ? `<details><summary>技術細節</summary><p>${escapeHtml(detail)}</p></details>` : "");
      show(reportBox);
      return { state, error: String(err.message || err) };
    }
    pending = null;
    state = "idle";
    renderResult(result, memberName);
    if (result.status === "ok") await onImported?.(result);
    return { state, result };
  }

  function renderResult(result, memberName) {
    say("");
    if (result.status === "skipped_duplicate") {
      // 多檔來源整批命中時已自帶訊息（「這張卡的 N 個檔案先前都已匯入」）
      if (result.source?.files) {
        reportBox.innerHTML = `<p>${escapeHtml(result.messages.at(-1) || "已全部匯入過")}</p>`
          + fileDetails(result.source.files);
        show(reportBox);
        return;
      }
      const origin = result.originDisplayName
        ? `匯入至成員「${escapeHtml(result.originDisplayName)}」` : "匯入過";
      reportBox.innerHTML = `<p>此檔案先前已於 <strong>${escapeHtml(result.importedAt)}</strong>
        ${origin}（內容完全相同），已自動跳過，資料不會重複。</p>`;
      show(reportBox);
      return;
    }
    if (result.status === "aborted") {
      reportBox.innerHTML = `<p class="warn">${escapeHtml(result.messages.at(-1) || "匯入中止")}</p>`;
      show(reportBox);
      return;
    }
    const r = result.report;
    const secRows = Object.entries(r.sections).map(([sec, info]) => {
      const extra = [
        info.inserted !== undefined ? `新增 ${info.inserted}` : "",
        info.note ? escapeHtml(info.note) : "",
      ].filter(Boolean).join("，");
      return `<tr><td>${escapeHtml(sec)}</td><td>${escapeHtml(info.status)}</td>
        <td>${info.records}${extra ? `（${extra}）` : ""}</td></tr>`;
    }).join("");
    const dedup = r.dedup?.skipped_dup ?? {};
    const dedupText = Object.entries(dedup)
      .map(([t, n]) => `${escapeHtml(t)} 跳過 ${n}`).join("、") || "無";
    const flags = Object.entries(r.quality_flags ?? {})
      .map(([k, v]) => `${escapeHtml(k)}×${v}`).join("、") || "無";
    const unmapped = (r.unmapped_lab_names ?? []);
    const perr = r.source.parse_errors ?? [];
    const files = r.source.files;
    const heading = files
      ? `匯入完成：${escapeHtml(r.source.filename)}（${files.length} 個檔案`
        + `，其中 ${r.source.new_files} 個是新的｜成員「${escapeHtml(memberName)}」）`
      : `匯入完成：${escapeHtml(r.source.filename)}（成員「${escapeHtml(memberName)}」）`;
    reportBox.innerHTML = `
      <h3>${heading}</h3>
      <table><thead><tr><th>節區</th><th>狀態</th><th>筆數</th></tr></thead>
        <tbody>${secRows}</tbody></table>
      <p>重複（冪等跳過）：${dedupText}</p>
      <p>品質旗標：${flags}</p>
      ${unmapped.length ? `<p>未對照檢驗名 ${unmapped.length} 項：${unmapped.map(escapeHtml).join("、")}</p>` : ""}
      ${perr.length ? `<details class="warn"><summary>部分紀錄解析失敗（已續行，該筆未入庫）：${perr.length} 筆</summary>
        <ul>${perr.map(e => `<li>${escapeHtml(e)}</li>`).join("")}</ul></details>` : ""}
      ${files ? fileDetails(files) : ""}`;
    show(reportBox);
  }

  // 成員異動（管理面板改名/刪除）後清掉過時面板內容：確認面板引用的
  // 成員與報告卡上的歸屬名稱都可能已失效（2026-08-10 走查回饋 1）。
  // 匯入進行中不動（交易完成後由結果呈現接手）。
  function resetPanel() {
    if (state === "importing") return;
    pending = null;
    state = "idle";
    say("");
    confirmBox.innerHTML = "";
    reportBox.innerHTML = "";
    panel.hidden = true;
  }

  return {
    offerFile,
    runImport,
    resetPanel,
    getState: () => state,
  };
}

// 錯誤訊息友善化（Karen 收尾檢核發現：技術訊息外洩）。回傳 [主訊息, 技術細節]
// 讀取階段失敗的措辭。fs scope 類失敗要給出「怎麼做才會成功」而不只是
// 「失敗了」：拖放（tauri://drag-drop）只拿到路徑字串、沒有動態授權，能不能
// 讀完全由 capabilities/default.json 的靜態 scope 決定；而「選擇檔案」按鈕走
// dialog，插件在選中當下 allow_file，不受該 scope 限制，所以那是唯一確定
// 可繞過的替代路徑，MUST 在訊息裡指出來。
//
// 措辭 MUST NOT 叫使用者「把資料夾搬到某幾個位置」：讀取 scope 是 `**`
// （2026-08-17 決定，理由見 app-shell spec「檔案存取範圍」），沒有位置白名單
// 這回事，那樣寫是錯的引導。`**` 之下仍可能出現此類錯誤，已知成因是 Tauri 的
// glob 不匹配 leading dot（2026-08-13 傷疤），那是 App 該自己跳過的路徑而非
// 使用者能修的，所以措辭只描述現象並給替代路徑，不歸咎使用者的檔案擺放。
//
// 判別字串取自 2026-08-13 實機錯誤原文（docs/verification/
// cpap_dotfile_scope_fix.md）：
//   forbidden path: <路徑>, maybe it is not allowed on the scope for
//   `allow-stat` permission in your capability file
// 兩段特徵任一命中即可，權限名（allow-stat／allow-read-dir…）隨呼叫點不同，
// MUST NOT 綁定特定權限名。
export function readFailureMessage(raw) {
  if (/forbidden path:|not allowed on the scope/i.test(raw)) {
    return "系統擋住了對這個位置的讀取，資料庫未寫入任何資料。"
      + "請改用「選擇檔案」按鈕挑同一個來源再試一次。";
  }
  return "無法讀取這個來源，資料庫未寫入任何資料。";
}

export function friendlyError(err) {
  const raw = String(err?.message || err);
  if (/歸屬成員/.test(raw)) {
    return [raw, ""];
  }
  if (/JSON/i.test(raw) && /(Unexpected|end of|parse)/i.test(raw)) {
    return ["檔案內容不完整或已損毀，請重新下載後再試一次。", raw];
  }
  if (/bdata|myhealthbank/i.test(raw) || err instanceof TypeError) {
    return ["檔案結構與預期不符，請確認是健康存摺或 Apple 健康的原始匯出檔。", raw];
  }
  if (/找不到|不支援的 zip|非 Apple/i.test(raw)) {
    return [raw, ""];
  }
  return ["匯入失敗，資料庫未寫入任何資料。可重新下載檔案後再試一次。", raw];
}

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
