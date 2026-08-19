// 成員管理 API（profile-management spec）。名稱檢查在應用層（零 DDL）：
// trim 後非空、不與他成員重名。deleteProfile 單一交易逐表清除，
// 順序照 FK 反向（medications 引用 encounters、各表引用 source_documents）。

// 刪除與計數的資料表清單（不含 profiles 本身）；順序即刪除順序。
// 一位成員名下的全部資料表。新增資料表 MUST 同步加進這裡，否則刪除成員會在
// DELETE source_documents 那步 FOREIGN KEY constraint failed（2026-08-13 實測：
// CPAP change 加了三張表卻沒接上，含 CPAP 資料的成員刪不掉）。
// 順序有意義：cpap_* 的 doc_id 指向 source_documents，MUST 排在它之前。
// tests/engine/table_coverage.test.mjs 以 DDL 對帳釘住。
export const PROFILE_DATA_TABLES = [
  "medications", "encounters", "lab_results", "reports", "immunizations",
  "body_measurements", "cancer_screenings", "apple_records", "apple_workouts", "apple_daily",
  "cpap_daily", "cpap_events", "cpap_oximetry",
  "source_documents",
];

const NAME_MAX = 30;

function normalizeName(displayName) {
  const name = String(displayName ?? "").trim();
  if (!name) throw new Error("成員名稱不可為空白。");
  // 上限防外溢（Karen MEDIUM-2：名稱直入匯出檔名與 UI 版面，
  // macOS 檔名上限 255 bytes，超長會讓匯出無聲失敗）
  if (name.length > NAME_MAX) {
    throw new Error(`成員名稱請在 ${NAME_MAX} 字以內。`);
  }
  return name;
}

async function assertNameFree(driver, name, excludeId = null) {
  const rows = await driver.select(
    "SELECT id FROM profiles WHERE display_name=?", [name]);
  if (rows.some(r => r.id !== excludeId)) {
    throw new Error(`成員名稱「${name}」已存在，請換一個名稱。`);
  }
}

export async function listProfiles(driver) {
  return driver.select(
    "SELECT id, display_name, masked_id, created_at FROM profiles ORDER BY id");
}

export async function getProfile(driver, id) {
  const rows = await driver.select(
    "SELECT id, display_name, masked_id FROM profiles WHERE id=?", [id]);
  return rows[0] ?? null;
}

// 匯入歸屬驗證（app-import-engine spec）：profileId 必填且存在，
// 缺省或失效一律明確報錯，NEVER 回退第一個成員。
export async function requireProfile(driver, profileId) {
  if (profileId == null) {
    throw new Error("匯入缺少歸屬成員，請先選擇這份資料屬於哪位成員。");
  }
  const p = await getProfile(driver, profileId);
  if (!p) throw new Error(`歸屬成員不存在（id=${profileId}），請重新選擇成員。`);
  return p;
}

export async function createProfile(driver, displayName) {
  const name = normalizeName(displayName);
  await assertNameFree(driver, name);
  const r = await driver.execute(
    "INSERT INTO profiles(display_name) VALUES(?)", [name]);
  return r.lastInsertRowid;
}

export async function renameProfile(driver, id, displayName) {
  const name = normalizeName(displayName);
  await assertNameFree(driver, name, id);
  const r = await driver.execute(
    "UPDATE profiles SET display_name=? WHERE id=?", [name, id]);
  if (r.changes === 0) throw new Error(`成員不存在（id=${id}）。`);
}

// 刪除確認面板用：該成員各資料表筆數
export async function profileCounts(driver, id) {
  const out = {};
  for (const t of PROFILE_DATA_TABLES) {
    const [{ c }] = await driver.select(
      `SELECT count(*) c FROM ${t} WHERE profile_id=?`, [id]);
    out[t] = c;
  }
  return out;
}

// 單一交易逐表清除該成員全部資料，回傳各表刪除筆數。中斷即整批回滾。
export async function deleteProfile(driver, id) {
  return driver.transaction(async (tx) => {
    const deleted = {};
    for (const t of PROFILE_DATA_TABLES) {
      const r = await tx.execute(`DELETE FROM ${t} WHERE profile_id=?`, [id]);
      deleted[t] = r.changes;
    }
    const p = await tx.execute("DELETE FROM profiles WHERE id=?", [id]);
    if (p.changes === 0) throw new Error(`成員不存在（id=${id}）。`);
    return deleted;
  });
}
