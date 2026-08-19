/* hwb dashboard 前端：總覽 / 時間軸 / 用藥 / 趨勢 ＋ 全文搜尋。
   Preact + htm（vendored），零執行期網路請求；外部連結僅使用者點擊才離開。 */
(function () {
  "use strict";
  const DATA = JSON.parse(document.getElementById("hwb-data").textContent);

  /* ---------- CPAP（睡眠呼吸） ---------- */
  // payload 可能來自尚無 CPAP 區塊的舊版本，一律防禦性取值
  const CPAP = DATA.cpap || {};
  const CPAP_DAILY = CPAP.daily || [];
  const HAS_CPAP = CPAP_DAILY.length > 0;
  // 沒有 CPAP 資料的使用者不該看到空分頁與空卡片（proposal 相容性要求），
  // 因此分頁、總覽卡與趨勢圖都以 HAS_CPAP 為條件顯示
  const cpapSeries = (field) => CPAP_DAILY
    .filter((r) => r[field] != null).map((r) => [r.date, r[field]]);

  /* ---------- Apple 睡眠（sleep_daily：[day, {識別字: 分鐘}]） ---------- */
  const SLEEP_DAILY = DATA.sleep_daily || [];
  const SLEEP_PREFIX = "HKCategoryValueSleepAnalysis";
  // 總睡眠＝識別字（去前綴後）以 Asleep 開頭者合計；未知識別字不計入
  // 總數（語意不明寧可少算），但分項照原名列出
  const asleepMinutes = (o) => Object.entries(o)
    .filter(([k]) => k.startsWith(SLEEP_PREFIX + "Asleep"))
    .reduce((a, [, v]) => a + v, 0);
  const SLEEP_HOURS = SLEEP_DAILY
    .map(([d, o]) => [d, Math.round((asleepMinutes(o) / 60) * 10) / 10])
    .filter((p) => p[1] > 0);
  const HAS_SLEEP = SLEEP_DAILY.length > 0;
  const SLEEP_ZH = { InBed: "躺床", AsleepUnspecified: "睡眠（未分類）",
    AsleepCore: "核心", AsleepDeep: "深層", AsleepREM: "快速動眼", Awake: "清醒" };
  const sleepIdentZh = (k) => {
    const s = k.startsWith(SLEEP_PREFIX) ? k.slice(SLEEP_PREFIX.length) : k;
    return SLEEP_ZH[s] || k;   // 未知識別字顯示原名，不丟棄
  };

  /* ---------- 身體數值參考標準（body_refs：knowledge 條目承載） ----------
     標準值不寫死在本檔：條目被移除時對應參考線就消失（spec「身體數值的
     參考線」）。顯示帶來源與引用日期，措辭為「參考」、無判定字樣。 */
  const BODY_REFS = DATA.body_refs || [];
  const refsFor = (t) => BODY_REFS.filter((r) => r.type_zh === t);
  const refLinesFor = (types) => types.flatMap(refsFor)
    .filter((r) => r.kind === "line").map((r) => ({ v: r.value, label: r.label }));
  const refBandFor = (t) => {
    const b = refsFor(t).find((r) => r.kind === "band");
    return b ? [b.lo, b.hi] : null;
  };
  const refNote = (types) => {
    const rs = types.flatMap(refsFor);
    if (!rs.length) return null;
    const bySrc = new Map();
    for (const r of rs) {
      const k = `${r.source_name}（引用日期 ${r.cited_date}）`;
      if (!bySrc.has(k)) bySrc.set(k, []);
      bySrc.get(k).push(r.label);
    }
    return [...bySrc.entries()]
      .map(([src, labels]) => `${labels.join("、")}：${src}`).join("；");
  };

  // 視窗/分頁標題帶成員名（2026-08-10 走查回饋：多成員一目瞭然）
  if (DATA.meta.profile) document.title = DATA.meta.profile + " 的個人健康資料工作台（私人）";
  const { h, render } = preact;
  const { useState, useMemo, useEffect } = preactHooks;
  const html = htm.bind(h);

  const TYPE_META = {
    western_outpatient: ["西醫門診", "var(--s1)"],
    tcm: ["中醫門診", "var(--s2)"],
    dental: ["牙醫門診", "var(--s3)"],
    pharmacy_dispensing: ["藥局調劑", "var(--s4)"],
  };
  const fmtType = (t) => (TYPE_META[t] || [t, "var(--ink2)"])[0];
  const typeColor = (t) => (TYPE_META[t] || [t, "var(--ink2)"])[1];
  const medKey = (m) => m.order_code || m.order_name;

  /* 醫令分類：西醫藥品（品項檔命中）/ 中醫用藥 / 診療項目與其他 */
  function medCategory(m) {
    if (m.drug_zh) return "drug";
    if ((m.section_hint || "").startsWith("r9")) return "tcm";
    return "order";
  }

  /* ---------- 共用元件 ---------- */
  function latestAndDelta(series, daysBack) {
    // series: [[date, val]...] 日序列；回傳 [最新值, 與 daysBack 天前的差]
    if (!series || !series.length) return [null, null];
    const last = series[series.length - 1];
    const target = new Date(new Date(last[0]) - daysBack * 864e5)
      .toISOString().slice(0, 10);
    let ref = null;
    for (const p of series) if (p[0] <= target) ref = p;
    return [last[1], ref ? +(last[1] - ref[1]).toFixed(1) : null];
  }

  function avgWindow(series, days, endOffset) {
    if (!series || !series.length) return null;
    const end = new Date(new Date(series[series.length - 1][0]) - (endOffset || 0) * 864e5);
    const start = new Date(end - days * 864e5);
    const vals = series.filter((p) => new Date(p[0]) > start && new Date(p[0]) <= end)
      .map((p) => p[1]);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }

  function Delta({ d, unit, invert }) {
    if (d == null || d === 0) return html`<div class="delta flat">— 持平</div>`;
    const worse = invert ? d < 0 : d > 0;
    return html`<div class="delta ${worse ? "up" : "down"}">
      ${d > 0 ? "▲" : "▼"} ${Math.abs(d)}${unit || ""}</div>`;
  }

  function Card({ icon, color, title, wide, children }) {
    return html`<div class="card ${wide ? "wide" : ""}">
      <div class="cat"><span class="cdot" style="background:${color}">${icon}</span>${title}</div>
      ${children}</div>`;
  }

  function Chip({ type }) {
    return html`<span class="chip" style="background:${typeColor(type)}"></span>${fmtType(type)}`;
  }

  /* ---------- 趨勢圖的時間軸工具（純函式，供 LineChart 與趨勢頁共用） ---------- */
  const DAY = 864e5;
  /* 日期字串 → 毫秒。"YYYY-MM" 視為該月一日（normDate 與 monthlyAvg 都會
     產生這種形式）；null 與無法解析者回 NaN 由呼叫端剔除。 */
  function tsOf(d) {
    // 先擋非字串與空字串：new Date(null) 是 1970（epoch 0）而不是
    // Invalid Date，光靠 isNaN 抓不到，一筆 null 就會把時間域下界
    // 拉到 1970 且不拋錯
    if (typeof d !== "string" || !d.trim()) return NaN;
    const t = new Date(d).getTime();
    return Number.isNaN(t) ? NaN : t;
  }
  const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

  /* 剔除日期無法解析的點。一筆 null 會讓 new Date(null) 得 1970 而把時間域
     下界整個拉走，且不拋錯（無聲失敗），故必須在算域之前處理。 */
  function sanitize(points) {
    const kept = [], dropped = [];
    for (const p of points || []) (Number.isNaN(tsOf(p[0])) ? dropped : kept).push(p);
    return { kept, dropped: dropped.length };
  }

  /* 依時間域過濾（含邊界）。不保留域外相鄰點：手寫 SVG 無裁切區域，
     跨界點會畫到繪圖區外（design D5 明示選擇）。
     月粒度（"YYYY-MM"）以「該月與區間有交集」判定，否則區間下界所在
     月份的整桶會被丟掉。 */
  function inRange(points, tMin, tMax) {
    return (points || []).filter(([d]) => {
      const t = tsOf(d);
      if (Number.isNaN(t)) return false;
      if (/^\d{4}-\d{2}$/.test(d)) {
        const end = new Date(t); end.setUTCMonth(end.getUTCMonth() + 1);
        return end.getTime() - 1 >= tMin && t <= tMax;   // 月份與區間有交集
      }
      return t >= tMin && t <= tMax;
    });
  }

  /* 依時間挑刻度：粒度隨跨度，超過上限逐級降到不超過為止。
     每個粒度都有下一級，近三月（週粒度 13 個）才有解。 */
  /* 由細到粗的單一階梯：起始粒度依跨度挑，之後只會往「更粗」走。
     用平坦陣列且順序不單調會出事——舊版年粒度用盡後掉進 month/1（更細），
     一路更細直到耗盡而回傳空陣列，跨度超過約 40 年時 x 軸一個標籤都沒有，
     且不拋錯（民國年被誤解析成 19xx 就會踩到）。 */
  const TICK_LADDER = [
    ["week", 1], ["week", 2],
    ["month", 1], ["month", 3], ["month", 6],
    ["year", 1], ["year", 2], ["year", 5], ["year", 10], ["year", 20], ["year", 50],
  ];
  function timeTicks(tMin, tMax, maxTicks = 8) {
    const span = Math.max(tMax - tMin, 1);
    const start = span > 730 * DAY ? 5 : span > 91 * DAY ? 2 : 0;
    for (let i = start; i < TICK_LADDER.length; i++) {
      const [unit, n] = TICK_LADDER[i];
      const ticks = [];
      const d = new Date(tMin);
      if (unit === "year") {
        d.setUTCMonth(0, 1); d.setUTCHours(0, 0, 0, 0);
        // 對齊到 n 的倍數年，否則刻度會錨在資料起點的年份（如 2007/2012/2017）
        if (n > 1) d.setUTCFullYear(Math.ceil(d.getUTCFullYear() / n) * n);
        while (d.getTime() < tMin) d.setUTCFullYear(d.getUTCFullYear() + n);
        for (; d.getTime() <= tMax; d.setUTCFullYear(d.getUTCFullYear() + n)) {
          ticks.push({ t: d.getTime(), label: String(d.getUTCFullYear()) });
        }
      } else if (unit === "month") {
        d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
        while (d.getTime() < tMin) d.setUTCMonth(d.getUTCMonth() + 1);
        for (; d.getTime() <= tMax; d.setUTCMonth(d.getUTCMonth() + n)) {
          ticks.push({ t: d.getTime(), label: fmtDate(d.getTime()).slice(2, 7) });
        }
      } else {
        d.setUTCHours(0, 0, 0, 0);
        for (; d.getTime() <= tMax; d.setUTCDate(d.getUTCDate() + 7 * n)) {
          ticks.push({ t: d.getTime(), label: fmtDate(d.getTime()).slice(5) });
        }
      }
      if (ticks.length <= maxTicks) return ticks;
    }
    // 保底：跨度大到連最粗粒度都超過上限時，仍給首末兩刻度（絕不回空）
    return [{ t: tMin, label: fmtDate(tMin).slice(0, 4) },
            { t: tMax, label: fmtDate(tMax).slice(0, 4) }];
  }

  /* SVG 折線圖：series = [{label, color, points:[[date,val],…]}]，
     domain={tMin,tMax} 為呼叫端傳入的共用時間域（趨勢頁四張圖同一組；
     未傳則以本圖資料自身首末日為域，供總覽卡使用）。
     空序列不畫（單一來源時常見），全空才顯示無資料。 */
  /* 折線圖尺寸提到模組層，讓標記門檻由繪圖區寬度推導而非硬編碼
     （改 W／PL／PR 時門檻自動跟著走） */
  const CH = { W: 860, H: 240, PL: 48, PB: 28, PT: 10, PR: 100 };
  const CH_PW = CH.W - CH.PL - CH.PR;              // 繪圖區寬 712px
  const MARK_FULL = Math.floor(CH_PW / 6);         // r=3 直徑 6px → 118 點
  const MARK_SMALL = Math.floor(CH_PW / 3);        // r=1.5 直徑 3px → 237 點
  // 無區間控制項的圖（總覽卡）不得套用「不畫標記」那一段：使用者在那裡
  // 沒有切區間的手段可以把逐點數值提示要回來，故上限放寬到不歸零
  const MARK_NO_RANGE = Math.ceil(CH_PW / 1.8);    // 396 點
  /* 帶狀序列：series 另帶 band=[[date, lo, hi],…]（與 points 的 avg 同日
     成對）。帶是面不是點：不繪標記、不參與標記門檻；lo/hi 參與 y 域，
     否則帶會畫出繪圖區。refLines=[{v,label}] 為水平參考虛線（值參與
     y 域，沿 refRange 前例，否則參考線落在域外看不見）。 */
  function LineChart({ series, unit, refRange, refLines, domain, note, onShowAll,
    markerLimit = MARK_SMALL, rangeLabel }) {
    const { W, H, PL, PB, PT, PR } = CH;
    const PW = CH_PW;
    let dropped = 0;
    const cleaned = series.map((s) => {
      const r = sanitize(s.points);
      dropped += r.dropped;
      return { ...s, points: r.kept, band: s.band ? sanitize(s.band).kept : null };
    });
    const dom = domain || (() => {
      const ts = cleaned.flatMap((s) => s.points.map((p) => tsOf(p[0])));
      return ts.length ? { tMin: Math.min(...ts), tMax: Math.max(...ts) } : null;
    })();
    const scoped = dom
      ? cleaned.map((s) => ({ ...s, points: inRange(s.points, dom.tMin, dom.tMax),
          band: s.band ? inRange(s.band, dom.tMin, dom.tMax) : null }))
      : cleaned;
    const drawn = scoped.filter((s) => s.points.length);
    const all = drawn.flatMap((s) => s.points);
    const foot = [note, dropped ? `已略過 ${dropped} 筆日期無法識別的紀錄` : null]
      .filter(Boolean).join("；");
    if (!all.length || !dom) {
      return html`<p class="note">${rangeLabel || "此區間"}無資料${foot ? `（${foot}）` : ""}
        ${onShowAll && html` <button class="catbtn" onClick=${onShowAll}>看全部</button>`}</p>`;
    }
    const vals = all.map((p) => p[1]);
    for (const s of drawn) {
      for (const b of s.band || []) {
        if (b[1] != null) vals.push(b[1]);
        if (b[2] != null) vals.push(b[2]);
      }
    }
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (refRange) { lo = Math.min(lo, refRange[0]); hi = Math.max(hi, refRange[1]); }
    for (const rl of refLines || []) { lo = Math.min(lo, rl.v); hi = Math.max(hi, rl.v); }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const span = Math.max(dom.tMax - dom.tMin, 1);
    // 座標夾在時間域內：月粒度序列以「月份與區間有交集」納入（見 inRange），
    // 其代表日期是該月 1 日，可能早於 tMin；不夾的話會畫到繪圖區左外側，
    // 極端情況（區間下界在月底）甚至畫出 viewBox 而完全看不見
    const x = (d) => PL
      + ((Math.min(Math.max(tsOf(d), dom.tMin), dom.tMax) - dom.tMin) / span) * PW;
    const y = (v) => PT + (H - PB - PT) - ((v - lo) / (hi - lo)) * (H - PB - PT);
    const gridN = 4, grid = [];
    for (let i = 0; i <= gridN; i++) {
      const v = lo + ((hi - lo) * i) / gridN;
      grid.push(html`<line x1=${PL} y1=${y(v)} x2=${W - PR} y2=${y(v)} class="grid" />
        <text x=${PL - 6} y=${y(v) + 4} class="ax" text-anchor="end">${v.toFixed(v > 99 ? 0 : 1)}</text>`);
    }
    const xlab = timeTicks(dom.tMin, dom.tMax).map((tk) =>
      html`<text x=${PL + ((tk.t - dom.tMin) / span) * PW} y=${H - 8}
        class="ax" text-anchor="middle">${tk.label}</text>`);
    const band = refRange ? html`<rect x=${PL} y=${y(refRange[1])} width=${PW}
        height=${Math.max(y(refRange[0]) - y(refRange[1]), 1)} class="refband" />` : null;
    const rline = (refLines || []).map((rl) => html`<line x1=${PL} y1=${y(rl.v)}
        x2=${W - PR} y2=${y(rl.v)} class="refline" />
      <text x=${W - PR - 4} y=${y(rl.v) - 3} class="ax" text-anchor="end">${rl.label}</text>`);
    return html`<div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" width=${W} role="img">
      ${band}${grid}${xlab}${rline}
      ${drawn.map((s, si) => {
        const pts = s.points.map((p) => `${x(p[0])},${y(p[1])}`).join(" ");
        const last = s.points[s.points.length - 1];
        // 標記半徑：序列顯式指定（如健保成健的獨立標記）優先，否則依
        // 區間內點數兩段降級；超過 MARK_SMALL 不畫標記只畫折線
        const r = s.marker || (s.points.length > markerLimit ? 0
          : s.points.length > MARK_FULL ? 1.5 : 3);
        const name = s.label.length > 7 ? s.label.slice(0, 6) + "…" : s.label;
        // 帶（min-max 面）：去程沿 hi、回程沿 lo；單日退化成一段豎線。
        // 面不繪標記也不參與標記門檻（門檻只管 avg 折線的標記）。
        const bmap = s.band && s.band.length
          ? new Map(s.band.map((b) => [b[0], b])) : null;
        const bandPoly = s.band && s.band.length > 1
          ? s.band.map((b) => `${x(b[0])},${y(b[2])}`).join(" ") + " "
            + s.band.slice().reverse().map((b) => `${x(b[0])},${y(b[1])}`).join(" ")
          : null;
        return html`<g>
          ${bandPoly && html`<polygon points=${bandPoly} fill=${s.color}
              fill-opacity="0.15" stroke="none" />`}
          ${s.band && s.band.length === 1 && html`<line x1=${x(s.band[0][0])}
              x2=${x(s.band[0][0])} y1=${y(s.band[0][1])} y2=${y(s.band[0][2])}
              stroke=${s.color} stroke-width="3" opacity="0.3" />`}
          ${s.points.length > 1 && html`<polyline points=${pts} fill="none" stroke=${s.color} stroke-width="2" />`}
          ${r > 0 && s.points.map((p) => html`<circle cx=${x(p[0])} cy=${y(p[1])} r=${r}
              fill=${s.color} stroke=${s.stroke || "none"} stroke-width="2">
            <title>${s.label} ${p[0]}：${p[1]}${bmap && bmap.get(p[0])
              ? `（${bmap.get(p[0])[1]}-${bmap.get(p[0])[2]}）` : ""} ${unit || ""}</title></circle>`)}
          <text x=${W - PR + 6} y=${PT + 14 + si * 30} class="ax" fill=${s.color}>${name}</text>
          <text x=${W - PR + 6} y=${PT + 27 + si * 30} class="ax" fill=${s.color}>${last[1]}</text>
        </g>`;
      })}</svg></div>
      ${foot && html`<p class="note">${foot}</p>`}`;
  }

  /* 處方時間軸：全資料期間為 x 軸，每次處方一根長條（高度＝給藥日數） */
  function DispenseTimeline({ items }) {
    const dated = items.filter((m) => m.date).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!dated.length) return html`<p class="note">無日期資料</p>`;
    const t0 = new Date(DATA.meta.date_min).getTime();
    const t1 = new Date(DATA.meta.date_max).getTime();
    const W = 820, H = 90, PL = 8, PB = 20, PT = 8;
    const x = (d) => PL + ((new Date(d).getTime() - t0) / Math.max(t1 - t0, 1)) * (W - PL - 12);
    const maxDays = Math.max(...dated.map((m) => m.days_supply || 1), 1);
    const bh = (d) => Math.max(((d || 1) / maxDays) * (H - PB - PT), 3);
    const years = [];
    for (let yy = new Date(DATA.meta.date_min).getFullYear();
         yy <= new Date(DATA.meta.date_max).getFullYear(); yy++) years.push(yy);
    return html`<div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" width=${W} role="img">
      <line x1=${PL} y1=${H - PB} x2=${W - 8} y2=${H - PB} class="grid" />
      ${years.map((yy) => html`<text x=${Math.max(x(yy + "-01-01"), PL)} y=${H - 5}
          class="ax">${yy}</text>`)}
      ${dated.map((m) => html`<rect x=${x(m.date) - 2} y=${H - PB - bh(m.days_supply)}
          width="4" rx="1.5" height=${bh(m.days_supply)} fill="var(--s1)">
        <title>${m.date}：${m.days_supply || "?"} 日份（${m.facility_name}）</title></rect>`)}
    </svg></div><p class="note">每根長條＝一次處方，高度＝給藥日數（滑過看明細）</p>`;
  }

  const STAT_ZH = { encounters: "就醫", medications: "用藥", lab_results: "檢驗",
    reports: "報告", immunizations: "疫苗", body_measurements: "身體數值",
    cancer_screenings: "癌篩", apple_records: "量測", apple_workouts: "運動",
    cpap_daily: "睡眠每日摘要", cpap_events: "呼吸事件", cpap_oximetry: "睡眠血氧",
    cpap_daily_unused: "無使用紀錄的日子" };

  // 單筆 import_stats（JSON 字串）→ { inserted, dupTotal }；不可解析回 null
  function parseStats(statsJson) {
    if (!statsJson) return null;
    try {
      const st = JSON.parse(statsJson);
      return {
        inserted: st.inserted || {},
        dupTotal: Object.values(st.skipped_dup || {}).reduce((a, b) => a + b, 0),
      };
    } catch (e) { return null; }
  }

  // 接受 groupSources 合計後的物件（單檔來源即該檔自身的統計）。
  // 組內有列缺統計時仍呈現其餘列的合計，只在尾端註明幾個檔案沒有統計：
  // 一個解析失敗的檔不該讓整批的真實筆數消失（2026-08-14）。
  function importSummary(stats) {
    if (!stats) return "（早期匯入，無統計）";
    const parts = Object.entries(stats.inserted || {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${STAT_ZH[k] || k} +${n.toLocaleString()}`);
    if (stats.dupTotal) parts.push(`重複略過 ${stats.dupTotal.toLocaleString()}`);
    if (stats.missing) {
      if (!parts.length) return "（早期匯入，無統計）";
      parts.push(`另有 ${stats.missingCount} 個檔案無統計`);
    }
    return parts.join("、") || "無新增（內容均已存在）";
  }

  /* ---------- 總覽（洞察式摘要卡） ---------- */
  const ADAPTER_ZH = {
    nhi_json: "健保存摺（JSON）", nhi_xml: "健保存摺（XML）",
    apple_health: "Apple 健康", resmed_edf: "CPAP（ResMed）",
  };

  // 同一 adapter 且同一匯入時刻的多個檔併為一組（design D2：payload 保留
  // 逐檔追溯，摺疊做在檢視層）。stats 取組內各檔的合計。
  function groupSources(sources) {
    const out = [];
    const idx = new Map();
    for (const s of sources || []) {
      const key = `${s.adapter}|${s.imported_at}`;
      if (!idx.has(key)) {
        idx.set(key, out.length);
        out.push({ adapter: s.adapter, imported_at: s.imported_at, files: [], stats: {} });
      }
      const g = out[idx.get(key)];
      g.files.push(s);
      const st = parseStats(s.import_stats);
      if (!st) {
        g.stats.missing = true;
        g.stats.missingCount = (g.stats.missingCount || 0) + 1;
        continue;
      }
      g.stats.inserted = g.stats.inserted || {};
      for (const [k, v] of Object.entries(st.inserted)) {
        g.stats.inserted[k] = (g.stats.inserted[k] || 0) + v;
      }
      g.stats.dupTotal = (g.stats.dupTotal || 0) + st.dupTotal;
    }
    return out;
  }

  function Overview({ go }) {
    const c = DATA.meta.counts;
    const encs = DATA.encounters.slice(0, 8);
    const [w, wd] = latestAndDelta(DATA.measures["體重"], 7);
    const [sys] = latestAndDelta(DATA.measures["收縮壓"], 7);
    const [dia] = latestAndDelta(DATA.measures["舒張壓"], 7);
    const steps30 = avgWindow(DATA.activity["步數"], 30, 0);
    const stepsPrev = avgWindow(DATA.activity["步數"], 30, 30);
    const latest = DATA.encounters[0];
    const weightYear = (DATA.measures["體重"] || []).slice(-365);
    const recentLabs = DATA.labs.filter((l) => l.value_numeric != null).slice(-4).reverse();
    const lastNight = HAS_CPAP ? CPAP_DAILY.at(-1) : null;
    return html`<section>
      <div class="cards">
        <${Card} icon="⚖︎" color="var(--s1)" title="體重">
          ${w != null ? html`<div class="big">${w}<small> kg</small></div>
            <${Delta} d=${wd} unit=" kg（7日）" invert=${false} />`
            : html`<p class="note">尚無量測資料</p>`}
        </${Card}>
        <${Card} icon="♥" color="var(--s2)" title="血壓（最近量測日）">
          ${sys != null ? html`<div class="big">${sys}<small>/${dia}</small></div>
            <div class="delta flat">mmHg｜${(DATA.measures["收縮壓"] || []).at(-1)?.[0] || ""}</div>`
            : html`<p class="note">尚無量測資料</p>`}
        </${Card}>
        ${lastNight && html`<${Card} icon="😴" color="var(--s3)" title="睡眠呼吸（最近一晚）">
          <div class="big">${lastNight.ahi ?? "—"}<small> AHI</small></div>
          <div class="delta flat">
            ${lastNight.usage_min != null
              ? `使用 ${Math.round((lastNight.usage_min / 60) * 10) / 10} 小時` : "使用時數不明"}
            ｜${lastNight.date}</div>
        </${Card}>`}
        <${Card} icon="🏃" color="var(--s4)" title="日均步數（30日）">
          ${steps30 != null ? html`<div class="big">${steps30.toLocaleString()}</div>
            <${Delta} d=${stepsPrev != null ? steps30 - stepsPrev : null} unit=" 較前期" invert=${true} />`
            : html`<p class="note">尚無資料</p>`}
        </${Card}>
        <${Card} icon="📅" color="var(--accent)" title="最近就診">
          ${latest ? html`<div class="big" style="font-size:20px">
              ${latest.date?.slice(5).replace("-", "/")} ${fmtType(latest.type)}</div>
            <div class="delta flat">${latest.facility_name}｜${latest.dx_name || ""}</div>`
            : html`<p class="note">尚無資料</p>`}
        </${Card}>
        <${Card} wide icon="⚖︎" color="var(--s1)" title="體重趨勢（一年）">
          <${LineChart} unit="kg" markerLimit=${MARK_NO_RANGE}
            series=${[{ label: "體重", color: "var(--s1)", points: weightYear }]} />
        </${Card}>
        <${Card} wide icon="🧪" color="var(--s3)" title="最新檢驗（點入看趨勢）">
          <table>${recentLabs.map((l) => html`<tr class="rowlink"
              onClick=${() => go("labs", { lab: l.name })}>
            <td>${l.name}</td><td class="num">${l.value_text}</td>
            <td class="dt">${l.ref_range || ""}</td><td class="dt">${l.test_date}</td></tr>`)}
          </table>
        </${Card}>
        <${Card} wide icon="📅" color="var(--accent)" title="最近就醫">
          <table>${encs.map((e) => html`<tr class="rowlink" onClick=${() => go("timeline", { enc: e.id })}>
            <td class="dt">${e.date}</td><td><${Chip} type=${e.type} /></td>
            <td>${e.facility_name}</td><td class="dt">${e.dx_name || ""}</td></tr>`)}</table>
        </${Card}>
        <${Card} wide icon="🗂" color="var(--ink2)" title="資料庫與匯入紀錄">
          <p class="note">就醫 ${c.encounters}｜用藥 ${c.medications}｜檢驗 ${c.lab_results}｜
            報告 ${c.reports}｜疫苗 ${c.immunizations}｜Apple 量測 ${c.apple_records.toLocaleString()}
            ${HAS_CPAP ? `｜睡眠呼吸 ${c.cpap_daily} 晚` : ""}</p>
          <table><tr><th>匯入時間</th><th>檔案</th><th>來源</th><th>新增內容</th></tr>
            ${groupSources(DATA.meta.sources).map((g) => html`<tr>
              <td class="dt">${g.imported_at}</td>
              <td>${g.files.length === 1 ? g.files[0].filename
                : html`<details><summary>${g.files.length} 個檔案</summary>
                    ${g.files.map((f) => html`<div class="dt">${f.filename}</div>`)}</details>`}</td>
              <td class="dt">${ADAPTER_ZH[g.adapter] || g.adapter}</td>
              <td class="dt">${importSummary(g.stats)}</td></tr>`)}</table>
        </${Card}>
      </div>
    </section>`;
  }

  /* ---------- 時間軸 ---------- */
  function Timeline({ focus }) {
    const [type, setType] = useState("");
    const [fac, setFac] = useState("");
    const [open, setOpen] = useState((focus && focus.enc) || null);
    // 院所選單跟著已選類型連動
    const facilities = useMemo(
      () => [...new Set(DATA.encounters.filter((e) => !type || e.type === type)
        .map((e) => e.facility_name).filter(Boolean))].sort(), [type]);
    const effFac = facilities.includes(fac) ? fac : "";
    const list = DATA.encounters.filter(
      (e) => (!type || e.type === type) && (!effFac || e.facility_name === effFac));
    // 依年分組（list 已依日期新→舊）：只展開一年，其餘只留年份那一行。就醫
    // 筆數會隨年份累積，平鋪的話標頭數量線性增長。
    const byYear = [];
    for (const e of list) {
      const y = String(e.date || "").slice(0, 4) || "未知";
      const last = byYear[byYear.length - 1];
      if (last && last.year === y) last.items.push(e);
      else byYear.push({ year: y, items: [e] });
    }
    // 預設展開：從搜尋／用藥頁跳轉來的那筆所在年份，否則最近一年。少了這個，
    // 跳轉目標會落在收起來的年份裡而看不到。
    const focusYear = focus && focus.enc
      ? String(list.find((e) => e.id === focus.enc)?.date || "").slice(0, 4)
      : null;
    const [openYear, setOpenYear] = useState(focusYear || null);
    // 篩選改變後原本展開的年份可能已不存在，退回第一年（最近一年）
    const effYear = byYear.some((y) => y.year === openYear)
      ? openYear : (byYear[0]?.year ?? null);
    const medById = useMemo(() => {
      const m = {}; DATA.medications.forEach((x) => (m[x.id] = x)); return m;
    }, []);
    useEffect(() => {
      if (focus && focus.enc) {
        // 年份層也帶 event class，選擇器要排除它才不會捲到年份標頭
        const el = document.querySelector(".event:not(.yeargroup).open");
        if (el) el.scrollIntoView({ block: "start" });
      }
    }, []);
    return html`<section>
      <div class="filters">
        <select value=${type} onChange=${(e) => { setType(e.target.value); setFac(""); }}>
          <option value="">全部類型</option>
          ${Object.keys(TYPE_META).map((t) => html`<option value=${t}>${fmtType(t)}</option>`)}
        </select>
        <select value=${effFac} onChange=${(e) => setFac(e.target.value)}>
          <option value="">全部院所（${facilities.length}）</option>
          ${facilities.map((f) => html`<option value=${f}>${f}</option>`)}
        </select>
        <span class="note">${list.length} 筆</span>
      </div>
      ${byYear.map((y) => html`
        <div class="event yeargroup ${effYear === y.year ? "open" : ""}">
          <div class="evhead rowlink"
            onClick=${() => setOpenYear(effYear === y.year ? null : y.year)}>
            <b>${y.year} 年</b>
            <span class="note">${y.items.length} 筆</span>
            <span class="note" style="margin-left:auto">
              ${effYear === y.year ? "▴" : "▾"}</span>
          </div>
          ${effYear === y.year && html`<div class="evbody">
      ${y.items.map((e) => html`<div class="event ${open === e.id ? "open" : ""}">
        <div class="evhead rowlink" onClick=${() => setOpen(open === e.id ? null : e.id)}>
          <span class="dt">${e.date}</span> <${Chip} type=${e.type} />
          <b> ${e.facility_name}</b> <span>${e.dx_name || ""}</span>
        </div>
        ${open === e.id && html`<div class="evbody">
          ${e.dx_code && html`<p>主診斷：${e.dx_name}（${e.dx_code}）</p>`}
          ${(DATA.meds_by_enc[e.id] || []).length > 0 && html`<table>
            <tr><th>醫令/藥品</th><th>成分</th><th>總量</th><th>天數</th><th>仿單</th></tr>
            ${DATA.meds_by_enc[e.id].map((mid) => { const m = medById[mid];
              return html`<tr><td>${m.drug_zh || m.order_name}${m.tooth_name ? `（${m.tooth_name}）` : ""}</td>
                <td class="dt">${m.ingredient || ""}</td>
                <td class="num">${m.total_qty ?? ""}</td><td class="num">${m.days_supply ?? ""}</td>
                <td>${m.leaflet_url ? html`<a href=${m.leaflet_url} target="_blank" rel="noopener">仿單↗</a>` : ""}</td></tr>`; })}
          </table>`}
          <p class="src">來源：${e.source_file}［${e.section}#${e.source_index}］
            ${e.copay != null ? ` ｜ 部分負擔 ${e.copay} 元 ｜ 健保 ${e.nhi_points} 點` : ""}</p>
        </div>`}
      </div>`)}
          </div>`}
        </div>`)}
      ${DATA.immunizations.length > 0 && html`<h2>疫苗接種</h2>
        <div class="card"><table><tr><th>日期</th><th>疫苗</th><th>院所</th></tr>
          ${DATA.immunizations.map((i) => html`<tr><td class="dt">${i.date}</td>
            <td>${i.vaccine_name}</td><td class="dt">${i.facility_name || ""}</td></tr>`)}
        </table></div>`}
    </section>`;
  }

  /* ---------- 用藥（分類＋可展開處方時間軸） ---------- */
  const MED_CATS = [["drug", "藥品"], ["tcm", "中醫用藥"], ["order", "診療項目與其他"]];

  /* ---------- 用藥卡的適應症（引述官方登記原文） ----------
     原文動輒數百字，超過門檻先截斷、由使用者自己按開（元件內部狀態，
     收合時不影響其他卡片）。許可證版本日期是頁級資訊，讀
     DATA.meta.drug_cache.license_updated_at，不在每列重複帶。
     許可證非有效狀態（已註銷／已廢止）是歷史處方的常態，註記用中性
     語氣、沿既有 .note 樣式，不用警示樣式。舊快取沒有這些欄位時整個
     區塊不渲染（不留空區塊）。 */
  const INDICATION_CLAMP = 120;

  function MedIndication({ m }) {
    const [full, setFull] = useState(false);
    // 適應症、狀態註記、用法用量三段各自獨立條件：命中證有 6/44775 列
    // 「已註銷但無適應症」，註記不得被適應症有無綁架（spec：非有效
    // SHALL 註記，無前提）。
    const text = m.indication ? String(m.indication) : "";
    const long = text.length > INDICATION_CLAMP;
    const shown = long && !full ? `${text.slice(0, INDICATION_CLAMP)}…` : text;
    const ver = DATA.meta.drug_cache && DATA.meta.drug_cache.license_updated_at;
    return html`<div>
      ${text && html`<p class="note">官方登記適應症原文${ver ? `（${ver}）` : ""}</p>
      <p>${shown}${long && html` <button class="catbtn"
        onClick=${() => setFull(!full)}>${full ? "收合" : "顯示全部"}</button>`}</p>`}
      ${m.license_status && html`<p class="note">${
        `此藥品許可證${m.license_status}（歷史處方仍可對照品項資訊）`}</p>`}
      ${m.usage_text && html`<p class="note">用法用量（原文）：${m.usage_text}</p>`}
    </div>`;
  }

  function MedGroup({ g, open, onToggle, go }) {
    const m = g.m;
    const days = g.items.reduce((s, x) => s + (x.days_supply || 0), 0);
    const facs = [...new Set(g.items.map((x) => x.facility_name))];
    return html`<div class="event ${open ? "open" : ""}">
      <div class="evhead rowlink" onClick=${onToggle}>
        <b>${m.drug_zh || m.order_name}</b>
        <span class="note">${g.items.length} 次${days ? `｜合計 ${days} 日份` : ""}｜最近 ${g.items[0].date}</span>
        <span class="note" style="margin-left:auto">${open ? "▴" : "▾"}</span>
      </div>
      ${open && html`<div class="evbody">
        ${!m.drug_zh && html`<p class="note"><span class="flag">品項檔未對照</span>
          顯示原始醫囑名稱（診療項目與中藥不在西藥品項檔範圍）</p>`}
        ${m.ingredient && html`<p class="note">成分：${m.ingredient}
          ${m.leaflet_url && html`｜<a href=${m.leaflet_url} target="_blank" rel="noopener">仿單↗</a>`}</p>`}
        ${(m.indication || m.license_status || m.usage_text) && html`<${MedIndication} m=${m} />`}
        <${DispenseTimeline} items=${g.items} />
        <table><tr><th>日期</th><th>院所</th><th>總量</th><th>天數</th><th></th></tr>
          ${g.items.map((x) => html`<tr class="rowlink"
              onClick=${() => go("timeline", { enc: x.encounter_id })}>
            <td class="dt">${x.date}</td>
            <td class="dt">${x.facility_name}</td>
            <td class="num">${x.total_qty ?? ""}</td><td class="num">${x.days_supply ?? ""}</td>
            <td class="dt">看診紀錄 ›</td></tr>`)}
        </table>
        <p class="note">院所：${facs.join("、")}</p>
      </div>`}
    </div>`;
  }

  /* ---------- 列印用藥清單（print-only DOM ＋ @media print） ----------
     常駐在用藥分頁裡的隱藏清單區：平時 .print-sheet 是 display:none，
     @media print 時樣式表把介面其餘部分關掉、只留這一區，所以按鈕呼叫
     window.print() 就能印出清單，不開新視窗、不產生檔案、不連網。
     範圍＝「藥品」與「中醫用藥」兩類（診療項目不是藥，不進清單）；
     每列的最近處方日期與用藥卡標頭的「最近」同一筆（items[0].date，
     payload 的 medications 已按就醫日期 DESC 排序）。
     兩類都沒有資料時整區不渲染（不留空清單）。 */
  const PRINT_CATS = [["drug", "藥品"], ["tcm", "中醫用藥"]];

  function MedPrintSheet({ groups }) {
    const secs = PRINT_CATS
      .map(([c, label]) => [label, groups.filter((g) => medCategory(g.m) === c)])
      .filter(([, gs]) => gs.length);
    if (!secs.length) return null;
    const ver = DATA.meta.drug_cache ? DATA.meta.drug_cache.updated_at : "未建快取";
    return html`<div class="print-sheet">
      <h2>用藥清單</h2>
      <p class="note">成員：${DATA.meta.profile}｜產生日期：${DATA.meta.generated_at}</p>
      <p class="note">藥品資訊來自健保用藥品項檔（版本 ${ver}）</p>
      ${secs.map(([label, gs]) => html`<div>
        <h3>${label}（${gs.length}）</h3>
        <table>
          <thead><tr><th>名稱</th><th>成分</th><th>最近處方日期</th></tr></thead>
          <tbody>${gs.map((g) => html`<tr>
            <td>${g.m.drug_zh || g.m.order_name}</td>
            <td>${g.m.ingredient || ""}</td>
            <td class="dt">${g.items[0].date}</td></tr>`)}</tbody>
        </table></div>`)}
      <p class="note">本清單僅為就醫溝通輔助，不含醫療判斷</p>
    </div>`;
  }

  function Meds({ focus, go }) {
    const groups = useMemo(() => {
      const g = {};
      DATA.medications.forEach((m) => {
        const key = medKey(m);
        (g[key] = g[key] || { key, items: [], m }).items.push(m);
      });
      return Object.values(g).sort((a, b) => b.items.length - a.items.length);
    }, []);
    const focusGroup = focus && focus.med ? groups.find((g) => g.key === focus.med) : null;
    const [openKey, setOpenKey] = useState(focusGroup ? focusGroup.key : null);
    const [cat, setCat] = useState(focusGroup ? medCategory(focusGroup.m) : "drug");
    const byCat = (c) => groups.filter((g) => medCategory(g.m) === c);
    useEffect(() => {
      if (focusGroup) {
        const el = document.querySelector(".event.open");
        if (el) el.scrollIntoView({ block: "start" });
      }
    }, []);
    return html`<section>
      <div class="filters">
        ${MED_CATS.map(([c, label]) => html`<button
          class="catbtn ${cat === c ? "on" : ""}"
          onClick=${() => { setCat(c); setOpenKey(null); }}>${label}（${byCat(c).length}）</button>`)}
        ${!window.HWB_EPUB && html`<button class="catbtn"
          onClick=${() => window.print()}>列印用藥清單</button>`}
      </div>
      <p class="note">藥品資訊來自健保用藥品項檔（版本
        ${DATA.meta.drug_cache ? DATA.meta.drug_cache.updated_at : "未建快取"}）；
        點列展開處方時間軸。</p>
      ${byCat(cat).map((g) => html`<${MedGroup} g=${g} open=${openKey === g.key} go=${go}
        onToggle=${() => setOpenKey(openKey === g.key ? null : g.key)} />`)}
      <${MedPrintSheet} groups=${groups} />
    </section>`;
  }

  /* ---------- 趨勢 ---------- */
  /* 檢驗參考值字串 → null（不畫）／{ band:[lo,hi] }（灰帶）／
     { limit, kind:"upper"|"lower" }（單條參考線）。判定依 design D5 五步
     短路，順序不可調換：
     1. 全字串恰為 NHI 雙欄形 `[左][右]`（欄內無括號）→ 兩側各自先試範圍
        （`低-高`／`低~高`，取該側首個配對），無範圍才取第一個數值（容許
        `= 7.0` 這種前綴）；「無」「.」等無數可取＝該側缺。帶＝[左 lo, 右 hi]，
        僅單側有數＝一側性，兩側皆缺＝null，組合後 lo ≥ hi 也 null
        （本機庫真有「兩欄各塞完整範圍且左右相同」一族，如 `[0~41][0~41]`，
        只取首數會畫出零高度帶＝錯畫）。
     2. 其餘含 `[` 的字串一律 null：年齡分段複合值（`[[0-14d]144-450 …]`）
        與一切未知括號形。**不畫比錯畫好**——舊版首個配對會把「0-14 天」
        當成參考帶 [0,14] 畫在圖上。
     3-5. 無括號者：試範圍 → 試一側性符號 → 皆不符 null。 */
  const REF_PAIR = /[+]?(-?\d+\.?\d*)\s*[-–~]\s*[+]?(-?\d+\.?\d*)/;
  const REF_NUM = /-?\d+(?:\.\d+)?/;
  /* 雙欄形的單側取數：有範圍取其 lo/hi，否則單數同時充當 lo 與 hi */
  function refSide(t) {
    const p = REF_PAIR.exec(t || "");
    if (p) return { lo: parseFloat(p[1]), hi: parseFloat(p[2]) };
    const n = REF_NUM.exec(t || "");
    return n ? { lo: parseFloat(n[0]), hi: parseFloat(n[0]) } : null;
  }
  function parseRef(s) {
    const str = s == null ? "" : String(s);
    const two = /^\[([^\[\]]*)\]\[([^\[\]]*)\]$/.exec(str);
    if (two) {
      const l = refSide(two[1]), r = refSide(two[2]);
      if (l && r) return l.lo < r.hi ? { band: [l.lo, r.hi] } : null;
      if (l) return { limit: l.lo, kind: "lower" };
      if (r) return { limit: r.hi, kind: "upper" };
      return null;
    }
    if (str.includes("[")) return null;
    const p = REF_PAIR.exec(str);
    if (p) {
      const lo = parseFloat(p[1]), hi = parseFloat(p[2]);
      return lo < hi ? { band: [lo, hi] } : null;   // 反向範圍＝形狀異常，不畫
    }
    const n = REF_NUM.exec(str);
    if (n) {
      const upper = /[<≦≤]|以下/.test(str), lower = /[>≧≥]|以上/.test(str);
      if (upper && lower) return null;   // 雙向符號並存＝語意不明，保守不畫
      if (upper) return { limit: parseFloat(n[0]), kind: "upper" };
      if (lower) return { limit: parseFloat(n[0]), kind: "lower" };
    }
    return null;
  }

  /* 趨勢序列集合＝該分頁繪製的全部序列（檢驗、測量、睡眠呼吸各自一組；
     spec「趨勢圖以共用時間域定位」）。檢驗分頁 MUST 含全部項目而非下拉
     當前選中者，否則切換檢驗項目會連帶位移同頁其他圖的 x 軸。 */
  function pageBounds(groups) {
    const ts = groups.flat().map((p) => tsOf(p[0])).filter((t) => !Number.isNaN(t));
    const gen = tsOf(DATA.meta.generated_at);
    const latest = ts.length ? Math.max(...ts) : NaN;
    // 上界取 generated_at 與資料最新日期的較大者：兩端 generated_at 的
    // 產生方式曾不一致，且最新一筆可能晚於它，取小的會靜默隱藏該筆
    const cands = [gen, latest].filter((t) => !Number.isNaN(t));
    const today = cands.length ? Math.max(...cands) : Date.parse("2000-01-01");
    return { today, latest, earliest: ts.length ? Math.min(...ts) : today };
  }

  /* 每個趨勢類分頁自己的區間狀態（同頁各圖恆為同一區間；跨頁不連動） */
  function useRange(groups) {
    const { today, latest, earliest } = useMemo(() => pageBounds(groups), []);
    const [range, setRange] = useState(() => defaultRange(today, latest));
    const dom = rangeDomain(range, today, earliest);
    const showAll = range === "all" ? null : () => setRange("all");
    const rangeLabel = (RANGES.find(([k]) => k === range) || [])[1];
    return { range, setRange, dom, showAll, rangeLabel };
  }

  function RangeBar({ range, setRange, children }) {
    return html`<div class="filters">
      ${RANGES.map(([k, label]) => html`<button class="catbtn ${range === k ? "on" : ""}"
        onClick=${() => setRange(k)}>${label}</button>`)}
      ${children}
    </div>`;
  }

  /* 0-1 存百分比的型別（血氧、行走穩定度；HealthKit 官方值域）：整序列
     判定（全部值 ≤ 1.5）後換算為百分比顯示。混不得逐點判定：同一序列
     兩種值域會畫出鋸齒。 */
  const isFraction = (vals) => vals.length > 0 && vals.every((v) => v == null || v <= 1.5);
  const pct = (v) => Math.round(v * 10000) / 100;
  function scaleSeries(points) {
    return isFraction(points.map((p) => p[1]))
      ? points.map(([d, v]) => [d, pct(v)]) : points;
  }
  /* measure_bands 的 [day, avg, min, max] → LineChart 的 points＋band */
  function bandChart(t) {
    const rows = DATA.measure_bands?.[t] || [];
    let points = rows.map((r) => [r[0], r[1]]);
    let band = rows.map((r) => [r[0], r[2], r[3]]);
    if (isFraction(rows.flatMap((r) => [r[1], r[2], r[3]]))) {
      points = points.map(([d, v]) => [d, pct(v)]);
      band = band.map(([d, lo, hi]) => [d, pct(lo), pct(hi)]);
    }
    return { points, band };
  }

  const RANGES = [["3m", "近三月", 90], ["1y", "近一年", 365], ["all", "全部", null]];
  function rangeDomain(key, today, earliest) {
    const r = RANGES.find(([k]) => k === key) || RANGES[2];
    return { tMin: r[2] == null ? earliest : today - r[2] * DAY, tMax: today };
  }
  /* 整體資料已停止數年時預設「全部」，否則會全頁皆空 */
  function defaultRange(today, latest) {
    return !Number.isNaN(latest) && today - latest <= 90 * DAY ? "1y" : "all";
  }

  /* ---------- 檢驗分頁：項目清單＋選中項趨勢＋逐筆表 ---------- */
  function Labs({ focus }) {
    const labNames = useMemo(() => {
      const names = {};
      DATA.labs.forEach((l) => (names[l.name] = names[l.name] || []).push(l));
      return Object.entries(names).sort((a, b) => b[1].length - a[1].length);
    }, []);
    const init = focus && focus.lab && labNames.some(([n]) => n === focus.lab)
      ? focus.lab : (labNames.length ? labNames[0][0] : "");
    const [sel, setSel] = useState(init);
    // 時間域集合＝全部可繪圖檢驗項目（非當前選中），切換項目不位移 x 軸
    const rangeState = useRange([
      DATA.labs.filter((l) => l.value_numeric != null)
        .map((l) => [l.test_date, l.value_numeric])]);
    const { range, setRange, dom, showAll, rangeLabel } = rangeState;
    const rows = (labNames.find(([n]) => n === sel) || [null, []])[1];
    const numRows = rows.filter((l) => l.value_numeric != null);
    const refRaw = numRows.length ? numRows[numRows.length - 1].ref_range : null;
    const ref = parseRef(refRaw);              // 無數值列時 refRaw 為 null → null
    // 三形態：帶走灰帶（refRange），一側性走單條參考線（refLines，值參與
    // y 域故不會落在域外），null 則兩者皆不傳；說明文字隨形態切換
    const refBand = ref && ref.band ? ref.band : null;
    const refKindZh = ref && ref.kind === "lower" ? "下限" : "上限";
    const refLines = ref && ref.limit != null
      ? [{ v: ref.limit, label: `參考${refKindZh} ${ref.limit}` }] : null;
    // 檢驗在當前區間內有無數值點（無則不印灰帶說明，避免說明沒有的東西）
    const labInRange = inRange(numRows.map((l) => [l.test_date, l.value_numeric]),
      dom.tMin, dom.tMax).length > 0;
    const know = DATA.knowledge[sel];
    if (!labNames.length) return html`<section><p class="note">尚無檢驗資料。</p></section>`;
    return html`<section>
      <${RangeBar} range=${range} setRange=${setRange}>
        <span class="note">本頁各圖共用同一時間區間</span>
      </${RangeBar}>
      <div class="filters"><select value=${sel} onChange=${(e) => setSel(e.target.value)}>
        ${labNames.map(([n, arr]) => html`<option value=${n}>${n}（${arr.length} 筆）</option>`)}
      </select></div>
      ${numRows.length > 0
        ? html`<${LineChart} unit="" refRange=${refBand} refLines=${refLines} domain=${dom}
            onShowAll=${showAll} rangeLabel=${rangeLabel}
            series=${[{ label: sel, color: "var(--s1)",
                        points: numRows.map((l) => [l.test_date, l.value_numeric]) }]} />`
        : html`<p class="note">此項目為文字型結果，僅列表不繪圖。</p>`}
      ${refBand && labInRange && html`<p class="note">灰帶為最近一次報告之參考值區間 ${refRaw}</p>`}
      ${refLines && labInRange && html`<p class="note">虛線為最近一次報告之參考${refKindZh} ${refRaw}</p>`}
      ${know && html`<p class="know">${know.description}<br />
        <span class="dt">來源：<a href=${know.source_url} target="_blank" rel="noopener">${know.source_name}</a>
        （引用日期 ${know.cited_date}）</span></p>`}
      <table><tr><th>日期</th><th>數值</th><th>參考值</th><th>院所</th></tr>
        ${rows.slice().reverse().map((l) => html`<tr><td class="dt">${l.test_date}</td>
          <td class="num">${l.value_text}${l.unmapped ? html` <span class="flag">unmapped</span>` : ""}</td>
          <td class="dt">${l.ref_range || "—"}</td><td class="dt">${l.facility_name}</td></tr>`)}</table>
      <h2>全部項目（${labNames.length}）</h2>
      <div class="card">${labNames.map(([n, arr]) => html`
        <div class="rowlink srow" onClick=${() => setSel(n)}>
          <span>${n}</span><span class="dt">${arr.length} 筆</span>
          <span class="dt">最近 ${arr[arr.length - 1].test_date}＝${arr[arr.length - 1].value_text}</span>
          <span class="go">›</span></div>`)}</div>
    </section>`;
  }

  /* ---------- 測量分頁：身體／循環／活動／其他四子區塊 ---------- */
  function Measures() {
    const m = (t) => DATA.measures[t] || [];
    const act = (t) => DATA.activity[t] || [];
    const hr = bandChart("心率");
    const spo2 = bandChart("血氧");
    const steadiness = scaleSeries(m("行走穩定度"));
    const nhiWeight = DATA.nhi_body.filter((b) => b.weight_kg)
      .map((b) => [b.check_date, b.weight_kg]);
    const workouts = DATA.workouts || [];
    // CPAP 的 AHI 也在本頁（同期對照 requirement），日期納入時間域
    const rangeState = useRange([
      m("體重"), nhiWeight, m("BMI"), m("體脂率"), m("除脂體重"), steadiness,
      m("收縮壓"), m("舒張壓"), hr.points, m("安靜心率"), spo2.points,
      act("步數"), act("步行跑步距離"), act("騎車距離"), act("爬樓層數"),
      act("活動能量"), act("基礎能量"), cpapSeries("ahi")]);
    const { range, setRange, dom, showAll, rangeLabel } = rangeState;
    const [openWYear, setOpenWYear] = useState(null);

    // 圖有全期資料才渲染（「無資料不留空區塊」；區間內無資料的既有
    // 「看全部」訊息由 LineChart 自己處理）
    const chart = (title, props) => {
      if (!props.series.some((s) => (s.points || []).length)) return null;
      return html`<h3>${title}</h3>
        <${LineChart} domain=${dom} onShowAll=${showAll} rangeLabel=${rangeLabel} ...${props} />`;
    };
    const block = (name, items) => {
      const kept = items.filter(Boolean);
      return kept.length ? html`<h2>${name}</h2>${kept}` : null;
    };

    // 運動記錄：依年分層摺疊（沿就醫時間軸模式，平鋪會隨年數線性增長）
    const workoutsByYear = [];
    for (const w of workouts) {
      const y = String(w.date || "").slice(0, 4) || "未知";
      const last = workoutsByYear[workoutsByYear.length - 1];
      if (last && last.year === y) last.items.push(w);
      else workoutsByYear.push({ year: y, items: [w] });
    }
    const workoutList = workouts.length ? html`<h3>運動記錄（${workouts.length} 次）</h3>
      ${workoutsByYear.map((y) => html`
        <div class="event ${openWYear === y.year ? "open" : ""}">
          <div class="evhead rowlink"
            onClick=${() => setOpenWYear(openWYear === y.year ? null : y.year)}>
            <b>${y.year} 年</b><span class="note">${y.items.length} 次</span>
            <span class="note" style="margin-left:auto">${openWYear === y.year ? "▴" : "▾"}</span>
          </div>
          ${openWYear === y.year && html`<div class="evbody">
            <table><tr><th>日期</th><th>類型</th><th>時長</th><th>來源</th></tr>
              ${y.items.map((w) => html`<tr><td class="dt">${w.date}</td>
                <td>${w.activity}</td>
                <td class="num">${w.duration_min != null ? `${Math.round(w.duration_min)} 分` : "—"}</td>
                <td class="dt">${w.source_name || ""}</td></tr>`)}</table>
          </div>`}
        </div>`)}` : null;

    const height = m("身高");
    const body = block("身體", [
      chart("體重", { unit: "kg", series: [
        { label: "體重（自主量測）", color: "var(--s1)", points: m("體重") },
        { label: "成健", color: "var(--s2)", marker: 6, stroke: "var(--card)", points: nhiWeight }] }),
      chart("BMI", { unit: "", refRange: refBandFor("BMI"), note: refNote(["BMI"]),
        series: [{ label: "BMI", color: "var(--s1)", points: m("BMI") }] }),
      chart("體脂率", { unit: "%", series: [{ label: "體脂率", color: "var(--s4)", points: m("體脂率") }] }),
      chart("除脂體重", { unit: "kg", series: [{ label: "除脂體重", color: "var(--s3)", points: m("除脂體重") }] }),
      chart("行走穩定度", { unit: "%",
        note: "Apple 依此值評估行走穩定，分級請見 iPhone 健康 App",
        series: [{ label: "行走穩定度", color: "var(--s1)", points: steadiness }] }),
    ]);
    const circ = block("循環", [
      chart("血壓（每日中位數）", { unit: "mmHg",
        refLines: refLinesFor(["收縮壓", "舒張壓"]),
        note: refNote(["收縮壓", "舒張壓"]),
        series: [
          { label: "收縮壓", color: "var(--s1)", points: m("收縮壓") },
          { label: "舒張壓", color: "var(--s2)", points: m("舒張壓") }] }),
      chart("心率（每日範圍與平均）", { unit: "次/分",
        note: "面為每日最低到最高，線為每日平均；安靜心率由 Apple 每日估算",
        series: [
          { label: "心率", color: "var(--s1)", points: hr.points, band: hr.band },
          { label: "安靜心率", color: "var(--s3)", points: m("安靜心率") }] }),
      chart("血氧（每日範圍與平均）", { unit: "%",
        note: "面為每日最低到最高，線為每日平均",
        series: [{ label: "血氧", color: "var(--s2)", points: spo2.points, band: spo2.band }] }),
    ]);
    const activity = block("活動", [
      chart("日均步數（每日單一來源最大值）", { unit: "步",
        note: range === "3m" ? "逐日" : "月平均",
        series: [{ label: "日均步數", color: "var(--s1)",
          points: range === "3m" ? act("步數") : monthlyAvg(act("步數")) }] }),
      chart("距離", { unit: "km", series: [
        { label: "步行跑步", color: "var(--s1)", points: act("步行跑步距離") },
        { label: "騎車", color: "var(--s4)", points: act("騎車距離") }] }),
      chart("爬樓層數", { unit: "層", series: [
        { label: "爬樓層數", color: "var(--s3)", points: act("爬樓層數") }] }),
      chart("能量消耗", { unit: "kcal", series: [
        { label: "活動能量", color: "var(--s2)", points: act("活動能量") },
        { label: "基礎能量", color: "var(--s1)", points: act("基礎能量") }] }),
      workoutList,
    ]);
    // 每晚 AHI：既有「趨勢頁的睡眠呼吸對照」requirement 的承載處——
    // 存在理由是與體重、步數的同期對照（睡眠呼吸分頁另有完整版）
    const other = block("其他", [
      height.length ? html`<p class="note">身高：最近量測
        ${height[height.length - 1][1]} cm（${height[height.length - 1][0]}）</p>` : null,
      chart("每晚 AHI（睡眠呼吸）", { unit: "次/小時",
        note: "日期為入睡當晚；與本頁其他圖共用同一時間區間，可直接同期對照",
        series: [{ label: "AHI", color: "var(--s3)", points: cpapSeries("ahi") }] }),
    ]);
    const blocks = [body, circ, activity, other].filter(Boolean);
    if (!blocks.length) return html`<section><p class="note">尚無量測資料。</p></section>`;
    return html`<section>
      <${RangeBar} range=${range} setRange=${setRange}>
        <span class="note">本頁各圖共用同一時間區間，可直接同期對照</span>
      </${RangeBar}>
      ${blocks}
    </section>`;
  }

  /* ---------- 睡眠呼吸分頁 ---------- */
  // 只顯示不解讀：不對 AHI 等指標下任何判定性描述（假設 #66）
  function Sleep() {
    const oxiAll = CPAP.oximetry || [];
    // 本頁時間域集合：CPAP 各序列＋Apple 睡眠、呼吸速率、血氧（spec：
    // 該分頁繪製的全部序列）
    const rangeState = useRange([
      cpapSeries("ahi"), cpapSeries("usage_min"), cpapSeries("leak_95"),
      cpapSeries("pressure_95"),
      oxiAll.map((r) => [r.date, r.spo2_min]),
      (CPAP.event_daily || []).map((r) => [r.date, r.n]),
      SLEEP_HOURS, bandChart("呼吸速率").points, bandChart("血氧").points]);
    const { range, setRange, dom, showAll, rangeLabel } = rangeState;
    const [breakdown, setBreakdown] = useState(false);
    // 逐筆事件只在展開那一晚才建 DOM（沿用用藥頁 MedGroup 的作法）。摺疊起來
    // 也全部渲染的話，上限情境會是 8,000 個 <tr> 掛在頁面上。
    const [openNight, setOpenNight] = useState(null);
    const [openYear, setOpenYear] = useState(null);

    const ahiSeries = [{ label: "AHI", color: "var(--s3)", points: cpapSeries("ahi") }];
    if (breakdown) {
      ahiSeries.push(
        { label: "阻塞", color: "var(--s1)", points: cpapSeries("oai") },
        { label: "中樞", color: "var(--s2)", points: cpapSeries("cai") },
        { label: "低通氣", color: "var(--s4)", points: cpapSeries("hi") });
    }
    const oxi = CPAP.oximetry || [];
    const events = CPAP.events || [];
    // 每晚事件數用 event_daily（每晚 × 類型的計數）：它不受逐筆保留範圍
    // 影響，資料量再大都畫得完。中文標籤與色票沿用 AHI 分項圖，未分類另給
    // 一色（AHI 圖的主線色，該圖沒有主線）。
    const EVENT_ZH = { "Obstructive Apnea": "阻塞", "Central Apnea": "中樞",
      "Hypopnea": "低通氣", "Apnea": "未分類" };
    const EVENT_COLOR = { "Obstructive Apnea": "var(--s1)",
      "Central Apnea": "var(--s2)", "Hypopnea": "var(--s4)",
      "Apnea": "var(--s3)" };
    const nightlyEventSeries = Object.keys(EVENT_ZH)
      .map((t) => ({ label: EVENT_ZH[t], color: EVENT_COLOR[t],
        points: (CPAP.event_daily || [])
          .filter((r) => r.event_type === t).map((r) => [r.date, r.n]) }))
      .filter((s) => s.points.length);
    // 逐筆依晚分組（payload 的 events 已依 start_ts 遞增，同一晚必相鄰）
    const eventsByNight = [];
    for (const e of events) {
      const last = eventsByNight[eventsByNight.length - 1];
      if (last && last.date === e.session_date) last.rows.push(e);
      else eventsByNight.push({ date: e.session_date, rows: [e] });
    }
    // 再依年分組：年 → 晚 → 逐筆三層，預設全收。常駐 DOM 只有年份那幾行，
    // 十年也就十行；沒有這層的話光是晚的標頭就會隨年數線性增長。
    const nightsByYear = [];
    for (const n of eventsByNight) {
      const y = n.date.slice(0, 4);
      const last = nightsByYear[nightsByYear.length - 1];
      if (last && last.year === y) last.nights.push(n);
      else nightsByYear.push({ year: y, nights: [n] });
    }
    const devices = [...new Set(CPAP_DAILY.map((r) => r.device))].filter(Boolean);
    const nights = CPAP_DAILY.length;
    const usagePoints = CPAP_DAILY.filter((r) => r.usage_min != null)
      .map((r) => [r.date, Math.round((r.usage_min / 60) * 10) / 10]);
    const usageSeries = [{ label: "使用時數", color: "var(--s1)", points: usagePoints }];

    /* ---- Apple 睡眠與呼吸（各區塊無資料不渲染） ---- */
    const [sleepBreakdown, setSleepBreakdown] = useState(false);
    const sleepIdents = [...new Set(SLEEP_DAILY.flatMap(([, o]) => Object.keys(o)))].sort();
    const SLEEP_COLORS = ["var(--s2)", "var(--s3)", "var(--s4)", "var(--accent)", "var(--warn)"];
    const sleepSeries = SLEEP_HOURS.length
      ? [{ label: "總睡眠", color: "var(--s1)", points: SLEEP_HOURS }] : [];
    if (sleepBreakdown || !SLEEP_HOURS.length) {
      sleepIdents.forEach((k, i) => sleepSeries.push({
        label: sleepIdentZh(k), color: SLEEP_COLORS[i % SLEEP_COLORS.length],
        points: SLEEP_DAILY.filter(([, o]) => o[k] != null)
          .map(([d, o]) => [d, Math.round((o[k] / 60) * 10) / 10]) }));
    }
    const respiratory = bandChart("呼吸速率");
    const spo2low = bandChart("血氧").band.map((b) => [b[0], b[1]]);
    // 使用時數 ÷ 睡眠時數的合計比值：當前區間 ∩ 兩來源皆有資料的日期
    // 範圍，各自加總再相除。不逐晚相除：兩來源「一晚」定義不同（CPAP
    // 正午分界紀錄夜 vs Apple 入睡起始日曆日），凌晨入睡的夜兩邊差一天，
    // 逐晚除是系統性錯位；合計層面天級錯位互相抵消。
    const coverage = (() => {
      if (!usagePoints.length || !SLEEP_HOURS.length) return null;
      const lo = Math.max(tsOf(usagePoints[0][0]), tsOf(SLEEP_HOURS[0][0]), dom.tMin);
      const hi = Math.min(tsOf(usagePoints[usagePoints.length - 1][0]),
        tsOf(SLEEP_HOURS[SLEEP_HOURS.length - 1][0]), dom.tMax);
      if (lo > hi) return null;
      const win = (pts) => pts.filter(([d]) => {
        const t = tsOf(d); return t >= lo && t <= hi;
      });
      const use = win(usagePoints), slp = win(SLEEP_HOURS);
      const sum = (pts) => pts.reduce((a, p) => a + p[1], 0);
      const sSlp = sum(slp);
      if (!use.length || !slp.length || !sSlp) return null;
      return { p: Math.round((sum(use) / sSlp) * 100), nUse: use.length, nSlp: slp.length };
    })();

    return html`<section>
      <div class="filters">
        ${RANGES.map(([k, label]) => html`<button class="catbtn ${range === k ? "on" : ""}"
          onClick=${() => setRange(k)}>${label}</button>`)}
        <span class="note">${HAS_CPAP
          ? `有紀錄的夜晚 ${nights} 晚${devices.length ? `｜機型 ${devices.join("、")}` : ""}`
          : `有睡眠紀錄 ${SLEEP_DAILY.length} 天`}</span>
      </div>
      ${HAS_SLEEP && html`<h2>睡眠時數</h2>
        ${SLEEP_HOURS.length > 0 && sleepIdents.length > 0 && html`<div class="filters">
          <button class="catbtn ${sleepBreakdown ? "on" : ""}"
            onClick=${() => setSleepBreakdown(!sleepBreakdown)}>顯示分項（各睡眠階段）</button>
        </div>`}
        <${LineChart} unit="小時" series=${sleepSeries} domain=${dom}
          onShowAll=${showAll} rangeLabel=${rangeLabel}
          note="來自 Apple 健康；日期為入睡起始的日曆日，依賴裝置配戴、可能不完整" />`}
      ${HAS_CPAP && SLEEP_HOURS.length > 0 && html`<h2>睡眠時數與 CPAP 使用對照</h2>
        <${LineChart} unit="小時" domain=${dom} onShowAll=${showAll} rangeLabel=${rangeLabel}
          note="兩來源的「一晚」定義不同（機器以正午分界、Apple 以入睡起始的日曆日），逐晚可能相差一天，適合看趨勢對照"
          series=${[
            { label: "CPAP 使用", color: "var(--s1)", points: usagePoints },
            { label: "Apple 睡眠", color: "var(--s3)", points: SLEEP_HOURS }]} />
        ${coverage && html`<p class="note">此區間兩來源重疊期間：使用時數佔睡眠時數比例約
          ${coverage.p}%（CPAP ${coverage.nUse} 晚、Apple 睡眠 ${coverage.nSlp} 天）。
          比例可能超過 100%：Apple 睡眠依賴裝置配戴，記錄可能不完整。</p>`}`}
      ${respiratory.points.length > 0 && html`<h2>呼吸速率（睡眠期間）</h2>
        <${LineChart} unit="次/分" domain=${dom} onShowAll=${showAll} rangeLabel=${rangeLabel}
          note="來自 Apple 健康；面為每日最低到最高，線為每日平均"
          series=${[{ label: "呼吸速率", color: "var(--s4)",
            points: respiratory.points, band: respiratory.band }]} />`}
      ${spo2low.length > 0 && html`<h2>血氧低點（Apple）</h2>
        <${LineChart} unit="%" domain=${dom} onShowAll=${showAll} rangeLabel=${rangeLabel}
          note="來自 Apple 健康的每日最低血氧；與下方 CPAP 睡眠期血氧為不同來源與量測情境，分開呈現"
          series=${[{ label: "每日最低", color: "var(--s2)", points: spo2low }]} />`}
      ${HAS_CPAP && html`<h2>每晚 AHI</h2>
      <div class="filters">
        <button class="catbtn ${breakdown ? "on" : ""}"
          onClick=${() => setBreakdown(!breakdown)}>顯示分項（阻塞／中樞／低通氣）</button>
      </div>
      <${LineChart} unit="次/小時" series=${ahiSeries} domain=${dom}
        onShowAll=${showAll} rangeLabel=${rangeLabel}
        note="日期為入睡當晚（機器以正午為分界劃分一晚）" />
      <h2>使用時數</h2>
      <${LineChart} unit="小時" series=${usageSeries} domain=${dom}
        onShowAll=${showAll} rangeLabel=${rangeLabel}
        note="未使用機器的日子不列入，不畫成 0" />
      <h2>漏氣（95 百分位）</h2>
      <${LineChart} unit="L/s" domain=${dom} onShowAll=${showAll} rangeLabel=${rangeLabel}
        series=${[{ label: "漏氣", color: "var(--s2)", points: cpapSeries("leak_95") }]} />
      <h2>送氣壓力（95 百分位）</h2>
      ${/* 與漏氣分成兩張圖而非疊在一起：兩者單位與數量級都不同（漏氣約
           0-1 L/s、壓力約 6-8 cmH2O），LineChart 只有單一 y 軸，疊在一起
           會把漏氣線壓成貼底的平線。同 design D10 否決雙軸圖的理由。 */""}
      <${LineChart} unit="cmH2O" domain=${dom} onShowAll=${showAll} rangeLabel=${rangeLabel}
        series=${[{ label: "壓力", color: "var(--s4)", points: cpapSeries("pressure_95") }]} />
      <h2>睡眠期血氧</h2>
      ${oxi.length
        ? html`<${LineChart} unit="%" domain=${dom} onShowAll=${showAll} rangeLabel=${rangeLabel}
            note="每晚一點：整晚最低與平均"
            series=${[
              { label: "最低", color: "var(--s2)", points: oxi.map((r) => [r.date, r.spo2_min]) },
              { label: "平均", color: "var(--s1)", points: oxi.map((r) => [r.date, r.spo2_mean]) },
            ]} />`
        : html`<p class="note">此來源沒有血氧資料。血氧需要機器外接血氧模組才會記錄。</p>`}
      <h2>每晚事件數</h2>
      ${nightlyEventSeries.length
        ? html`<${LineChart} unit="筆" series=${nightlyEventSeries} domain=${dom}
            onShowAll=${showAll} rangeLabel=${rangeLabel}
            note="每晚各類型的事件筆數，涵蓋全部有紀錄的夜晚" />`
        : html`<p class="note">此來源沒有逐次事件紀錄（僅有每日摘要）。</p>`}
      <h2>逐筆事件紀錄${eventsByNight.length ? `（${events.length} 筆，分 ${eventsByNight.length} 晚）` : ""}</h2>
      ${eventsByNight.length
        ? html`<div>
            ${CPAP.events_truncated
              ? html`<p class="note">逐筆僅保留最近 ${CPAP.events_nights} 晚
                  （共 ${CPAP.events_nights_total} 晚有事件）；較早的夜晚仍有
                  每日摘要與上方的每晚事件數。</p>`
              : ""}
            ${nightsByYear.slice().reverse().map((y) => html`
              <div class="event ${openYear === y.year ? "open" : ""}">
                <div class="evhead rowlink"
                  onClick=${() => { setOpenYear(openYear === y.year ? null : y.year);
                    setOpenNight(null); }}>
                  <b>${y.year} 年</b>
                  <span class="note">${y.nights.length} 晚｜
                    ${y.nights.reduce((a, n) => a + n.rows.length, 0)} 筆</span>
                  <span class="note" style="margin-left:auto">
                    ${openYear === y.year ? "▴" : "▾"}</span>
                </div>
                ${openYear === y.year && html`<div class="evbody">
                  ${y.nights.slice().reverse().map((n) => html`
                    <div class="event ${openNight === n.date ? "open" : ""}">
                      <div class="evhead rowlink"
                        onClick=${() => setOpenNight(openNight === n.date ? null : n.date)}>
                        <b>${n.date}</b>
                        <span class="note">${n.rows.length} 筆</span>
                        <span class="note" style="margin-left:auto">
                          ${openNight === n.date ? "▴" : "▾"}</span>
                      </div>
                      ${openNight === n.date && html`<div class="evbody">
                        <table><tr><th>時刻</th><th>類型</th><th>持續</th></tr>
                          ${n.rows.map((e) => html`<tr>
                            <td class="dt">${(e.start_ts || "").slice(11, 19)}</td>
                            <td>${e.event_type}</td>
                            <td class="num">${e.duration_sec != null ? `${e.duration_sec} 秒` : "—"}</td>
                          </tr>`)}
                        </table></div>`}
                    </div>`)}
                </div>`}
              </div>`)}
          </div>`
        : ""}`}
    </section>`;
  }

  function monthlyAvg(daily) {
    const b = {};
    daily.forEach(([d, v]) => { const m = d.slice(0, 7); (b[m] = b[m] || []).push(v); });
    return Object.entries(b).sort().map(([m, vs]) =>
      [m, Math.round(vs.reduce((s, x) => s + x, 0) / vs.length)]);
  }

  /* ---------- 搜尋（結果全面可點選跳轉） ---------- */
  function Search({ q, go }) {
    const needle = q.trim().toLowerCase();
    const res = useMemo(() => {
      if (!needle) return null;
      const has = (s) => (s || "").toLowerCase().includes(needle);
      return {
        encounters: DATA.encounters.filter((e) => has(e.facility_name) || has(e.dx_name)),
        medications: DATA.medications.filter((m) => has(m.order_name) || has(m.drug_zh) || has(m.ingredient)),
        labs: DATA.labs.filter((l) => has(l.name) || has(l.test_name_raw) || has(l.order_name)),
        reports: DATA.reports.filter((r) => has(r.report_text) || has(r.order_name)),
      };
    }, [needle]);
    if (!res) return html`<p class="note">輸入院所、診斷、藥名、檢驗名或報告文字。</p>`;
    const medGroups = [...new Map(res.medications.map((m) => [medKey(m), m])).values()];
    const labGroups = [...new Map(res.labs.map((l) => [l.name, l])).values()];
    return html`<section>
      <h2>就醫（${res.encounters.length}）</h2>
      <div class="card">${res.encounters.slice(0, 20).map((e) => html`
        <div class="rowlink srow" onClick=${() => go("timeline", { enc: e.id })}>
          <span class="dt">${e.date}</span> <${Chip} type=${e.type} />
          <span> ${e.facility_name}：${e.dx_name || ""}</span><span class="go">›</span></div>`)}
        ${!res.encounters.length && html`<p class="note">無符合</p>`}</div>
      <h2>用藥（${medGroups.length} 項）</h2>
      <div class="card">${medGroups.slice(0, 20).map((m) => html`
        <div class="rowlink srow" onClick=${() => go("meds", { med: medKey(m) })}>
          <span>${m.drug_zh || m.order_name}</span>
          <span class="dt">${m.ingredient || ""}</span><span class="go">›</span></div>`)}
        ${!medGroups.length && html`<p class="note">無符合</p>`}</div>
      <h2>檢驗（${labGroups.length} 項）</h2>
      <div class="card">${labGroups.slice(0, 20).map((l) => html`
        <div class="rowlink srow" onClick=${() => go("labs", { lab: l.name })}>
          <span>${l.name}</span>
          <span class="dt">最近 ${l.test_date}＝${l.value_text}</span><span class="go">›</span></div>`)}
        ${!labGroups.length && html`<p class="note">無符合</p>`}</div>
      <h2>影像病理報告（${res.reports.length}）</h2>
      <div class="card">${res.reports.slice(0, 10).map((r) => html`<details><summary>
        <span class="dt">${r.test_date}</span> ${r.order_name}（${r.facility_name}）</summary>
        <pre class="report">${r.report_text}</pre></details>`)}
        ${!res.reports.length && html`<p class="note">無符合</p>`}</div>
    </section>`;
  }

  /* ---------- App ---------- */
  /* 錯誤邊界：單一分頁渲染拋錯只讓該頁顯示錯誤訊息，不拖垮整個 App
     （key 隨分頁切換重建，換頁即重試）。 */
  class Boundary extends preact.Component {
    componentDidCatch(err) { this.setState({ err }); }
    render() {
      if (this.state.err) return html`<section><p class="note">
        這個分頁載入失敗：${String(this.state.err)}。
        可切換其他分頁繼續使用；若持續發生，請回報此訊息文字。</p></section>`;
      return this.props.children;
    }
  }

  // 六分頁（change display-revamp-bands-cleanup D5）；睡眠呼吸有 CPAP
  // 或 Apple 睡眠彙總任一即顯示
  const TABS = [["overview", "總覽"], ["timeline", "就醫"], ["meds", "用藥"],
    ["labs", "檢驗"], ["measures", "測量"],
    ...(HAS_CPAP || HAS_SLEEP ? [["sleep", "睡眠呼吸"]] : [])];
  function App() {
    const [tab, setTab] = useState("overview");
    const [focus, setFocus] = useState(null);
    const [q, setQ] = useState("");
    const go = (t, payload) => { setTab(t); setFocus(payload || null); setQ(""); };
    const view = q.trim() ? html`<${Search} q=${q} go=${go} />`
      : tab === "overview" ? html`<${Overview} go=${go} />`
      : tab === "timeline" ? html`<${Timeline} key=${"t" + JSON.stringify(focus)} focus=${focus} />`
      : tab === "meds" ? html`<${Meds} key=${"m" + JSON.stringify(focus)} focus=${focus} go=${go} />`
      : tab === "sleep" ? html`<${Sleep} />`
      : tab === "measures" ? html`<${Measures} />`
      : html`<${Labs} key=${"r" + JSON.stringify(focus)} focus=${focus} />`;
    return html`<div>
      <header>
        <h1>${DATA.meta.profile ? DATA.meta.profile + " 的個人健康資料工作台" : "個人健康資料工作台"}</h1>
        <p class="disclaimer">本頁僅協助整理、搜尋與視覺化您自行提供的健康資料，不提供診斷、
          治療、用藥或其他醫療判斷建議；資料可能不完整或有格式誤差，如有醫療問題請諮詢
          合格醫事人員。<b>本檔含個人醫療資料，請勿外傳。</b>
          資料截至 ${DATA.meta.generated_at}。</p>
        <div class="topbar">
          <nav>${TABS.map(([id, label]) => html`<button
            class=${tab === id && !q.trim() ? "active" : ""}
            onClick=${() => go(id)}>${label}</button>`)}</nav>
          <input type="search" placeholder="搜尋全部資料…" value=${q}
            onInput=${(e) => setQ(e.target.value)} />
        </div>
      </header>
      <${Boundary} key=${"b" + tab + "|" + q.trim() + "|" + JSON.stringify(focus)}>${view}</${Boundary}>
    </div>`;
  }

  const root = document.getElementById("app");
  root.textContent = "";
  render(html`<${App} />`, root);
})();
