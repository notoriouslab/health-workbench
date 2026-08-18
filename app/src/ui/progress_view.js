// 匯入進度的顯示規則（app-import-gui「進度與結果報告」）。純函式，
// import_flow 接 DOM、測試直測規則。
//
// 百分比僅於 totalBytes > 0 時顯示；0＝總量不可得（zip64 或欄位無效，
// 見 app-import-engine「匯入進度回報」），此時只顯示筆數：寧可不顯示，
// 也不顯示假的百分比。pct 為 null 時呼叫端把進度條切 indeterminate。
export function progressView(processed, totalBytes, readBytes) {
  const pct = totalBytes > 0 ? Math.min(100, (readBytes / totalBytes) * 100) : null;
  const suffix = pct === null ? "" : `（${Math.round(pct)}%）`;
  const text = processed === 0
    ? `正在檢查檔案是否曾經匯入…${suffix}`
    : `已處理 ${processed.toLocaleString()} 筆${suffix}`;
  return { pct, text };
}
