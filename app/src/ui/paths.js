// 儲存對話框的預設路徑組裝。獨立成一支的理由：這個判斷原本在 viewer.js
// 與 main.js 各寫一次，其中一處漏了分隔符判斷（Windows 上產生
// "C:\Users\me\Documents/健康紀錄_....epub" 這種混合路徑），而少一處
// 不會有任何測試轉紅。放 ui/ 而非 engine/values.js，是因為後者有 Python
// 端逐位元組孿生守衛，純前端工具加進去會要求 Python 端一起長出來。
export function defaultSavePath(startDir, name) {
  if (!startDir) return name;
  const sep = startDir.includes("\\") ? "\\" : "/";
  return startDir.endsWith(sep) ? `${startDir}${name}` : `${startDir}${sep}${name}`;
}
