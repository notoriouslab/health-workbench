// StoreDriver 的 App 端實作：走 shell 層 SQLite 橋（db_* commands，
// 每個 DB 路徑一條 rusqlite 連線＋Mutex 序列化）。介面與 node_driver 同形。
// design D2 修訂二：原 tauri-plugin-sql（sqlx 10 連線池）跨呼叫交易語意
// 不安全（孤兒交易幽靈讀，2026-08-09 實測），棄用改本橋。
import { healWalResidue } from "../engine/bulk_write.js";

const BATCH_SIZE = 20000;

const invoke = (...args) => window.__TAURI__.core.invoke(...args);

export class TauriDriver {
  static async open(dbPath) {
    const d = new TauriDriver();
    d.path = dbPath;
    await d.execute("PRAGMA foreign_keys = ON");
    // 上次匯入中斷會殘留 WAL 模式（跨連線持久），開啟時收斂回單檔
    await healWalResidue(d);
    return d;
  }

  async execute(sql, params = []) {
    const [changes, lastInsertRowid] = await invoke("db_execute",
      { path: this.path, sql, params: params.map(nullify) });
    return { changes, lastInsertRowid };
  }

  async select(sql, params = []) {
    return invoke("db_select", { path: this.path, sql, params: params.map(nullify) });
  }

  // 批次寫入＝json_each 單參數展開（design D2 修訂；兩 driver 同 SQL 形狀）
  async batchInsert(table, columns, rows, { ignore = false } = {}) {
    if (rows.length === 0) return 0;
    const verb = ignore ? "INSERT OR IGNORE" : "INSERT";
    const sel = columns.map((_, c) => `json_extract(value,'$[${c}]')`).join(", ");
    const sql = `${verb} INTO ${table} (${columns.join(", ")}) SELECT ${sel} FROM json_each(?)`;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const r = await this.execute(sql, [JSON.stringify(rows.slice(i, i + BATCH_SIZE))]);
      inserted += r.changes;
    }
    return inserted;
  }

  async transaction(fn) {
    await this.execute("BEGIN");
    try {
      const result = await fn(this);
      await this.execute("COMMIT");
      return result;
    } catch (err) {
      await this.execute("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  async close() {
    await invoke("db_close", { path: this.path });
  }
}

const nullify = (v) => v === undefined ? null : v;
