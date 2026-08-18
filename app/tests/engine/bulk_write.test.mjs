// WAL 窗口與自癒（app-import-engine「匯入期間的日誌模式窗口」）。
// 用檔案庫（:memory: 沒有 -wal/-shm 可驗）驗三件事：窗口內外的模式、
// 失敗路徑同樣收斂、殘留自癒。注意：rusqlite 的 execute 陷阱（回傳列
// 語句要走 select）Node 層測不出來，實機驗收在 change 的 T6 dogfood。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { withWalWindow, healWalResidue } from "../../src/engine/bulk_write.js";

function freshDbPath() {
  return path.join(mkdtempSync(path.join(tmpdir(), "hwb-wal-")), "t.sqlite");
}

const mode = async (d) =>
  (await d.select("PRAGMA journal_mode"))[0].journal_mode;

test("窗口內為 wal、窗口後收斂回 delete 且無 -wal/-shm", async () => {
  const p = freshDbPath();
  const d = new NodeDriver(p);
  await initSchema(d);
  assert.equal(await mode(d), "delete");

  let inside;
  const result = await withWalWindow(d, async () => {
    inside = await mode(d);
    await d.transaction(async () => {
      await d.execute("INSERT INTO profiles(display_name) VALUES ('甲')");
    });
    return "done";
  });
  assert.equal(result, "done", "窗口必須透傳 fn 的回傳值");
  assert.equal(inside, "wal");
  assert.equal(await mode(d), "delete");
  assert.equal(existsSync(`${p}-wal`), false, "-wal 不得殘留");
  assert.equal(existsSync(`${p}-shm`), false, "-shm 不得殘留");
  const [{ c }] = await d.select("SELECT COUNT(*) c FROM profiles");
  assert.equal(c, 1, "窗口內寫入的資料必須留存");
  await d.close();
});

test("fn 丟錯：錯誤原樣上拋，模式同樣收斂", async () => {
  const p = freshDbPath();
  const d = new NodeDriver(p);
  await initSchema(d);
  await assert.rejects(
    withWalWindow(d, async () => { throw new Error("匯入失敗"); }),
    /匯入失敗/);
  assert.equal(await mode(d), "delete");
  assert.equal(existsSync(`${p}-wal`), false);
  await d.close();
});

test("殘留自癒：WAL 模式跨連線持久，重開呼叫 healWalResidue 即收斂", async () => {
  const p = freshDbPath();
  let d = new NodeDriver(p);
  await initSchema(d);
  // 模擬匯入中斷：切 WAL、寫資料、不收斂直接關
  await d.select("PRAGMA journal_mode=WAL");
  await d.execute("INSERT INTO profiles(display_name) VALUES ('乙')");
  await d.close();

  d = new NodeDriver(p);
  assert.equal(await mode(d), "wal", "WAL 模式必須跨連線持久（自癒的前提）");
  await healWalResidue(d);
  assert.equal(await mode(d), "delete");
  assert.equal(existsSync(`${p}-wal`), false);
  assert.equal(existsSync(`${p}-shm`), false);
  const [{ c }] = await d.select("SELECT COUNT(*) c FROM profiles");
  assert.equal(c, 1, "自癒不得弄丟殘留在 WAL 裡的資料");
  await d.close();
});
