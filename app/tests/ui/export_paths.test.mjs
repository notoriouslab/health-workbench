// 兩條匯出路徑的流程守衛。原本這一層完全沒有測試：export_name.test.mjs
// 只測檔名純函式，匯出本身（要不要開對話框、取消時有沒有寫檔、走哪個
// 寫檔 API）從來沒被驗證過，而 EPUB 上線時把 HTML 那條也重構了
// （抽出共用的 askTarget），這種重構退化不會有任何地方轉紅。
//
// 注意這一層測不到什麼：Tauri 的權限是在 Rust 端判定的，這裡的 fs 是注入
// 的假物件，測得到「呼叫了哪個 API、帶什麼參數」，測不到 capabilities
// 有沒有授權（那次只能實機驗，見 v0.6.0 的 fs scope 事故）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeDriver } from "../../src/store/node_driver.js";
import { initSchema } from "../../src/store/schema.js";
import { createProfile } from "../../src/engine/profiles.js";
import { nhiJsonAdapter } from "../../src/adapters/nhi_json.js";
import { makeDocument } from "../helpers/mini_dom.mjs";

const REPO = new URL("../../..", import.meta.url).pathname;
const LAB_ENTRIES = JSON.parse(
  readFileSync(new URL("../../src/knowledge/labs.json", import.meta.url), "utf-8"));

// viewer.js 在 createViewer 內才碰 document，所以 DOM 要在 import 之後、
// 呼叫之前備妥即可。
function installDom() {
  const doc = makeDocument();
  for (const id of ["viewer-frame", "viewer-empty", "export-html-btn", "export-epub-btn"]) {
    doc.registerId(id, doc.createElement("div"));
  }
  doc.getElementById("viewer-empty").textContent = "尚無資料。";
  globalThis.document = doc;
  return doc;
}

// 檢視層資產在 App 裡是 fetch 相對路徑取得（frontendDist 之下），
// Node 的 fetch 不吃相對路徑，改為從原始碼目錄讀同一批檔案。
function installFetch() {
  const base = new URL("../../src/", import.meta.url);
  globalThis.fetch = async (p) => {
    const text = readFileSync(new URL(String(p).replace(/^\.\//, ""), base), "utf-8");
    return { text: async () => text };
  };
}

// saveResult：對話框回傳值（null 代表使用者取消）
function installTauri({ saveResult, writeError = null, startDir = null }) {
  const calls = [];
  globalThis.window = {
    __TAURI__: {
      fs: {
        exists: async () => false,
        copyFile: async () => {},
        writeTextFile: async (p, data) => {
          calls.push({ api: "writeTextFile", p, data });
          if (writeError) throw new Error(writeError);
        },
        writeFile: async (p, data) => {
          calls.push({ api: "writeFile", p, data });
          if (writeError) throw new Error(writeError);
        },
      },
      // 藥品快取在測試環境取不到，viewer 會 catch 成 null（走無快取路徑）
      path: { resolveResource: async () => { throw new Error("test: no bundled resource"); } },
      dialog: {
        save: async (opts) => { calls.push({ api: "save", opts }); return saveResult; },
      },
    },
  };
  return calls;
}

async function makeDb({ withData }) {
  const dir = mkdtempSync(path.join(tmpdir(), "hwb-export-"));
  const dbPath = path.join(dir, "t.sqlite");
  const d = new NodeDriver(dbPath);
  await initSchema(d);
  const pid = await createProfile(d, "測試成員");
  if (withData) {
    await nhiJsonAdapter.importSource(
      { bytes: new Uint8Array(readFileSync(`${REPO}/tests/fixtures/nhi_sample.json`)),
        name: "nhi_sample.json" },
      d, null, { labEntries: LAB_ENTRIES, profileId: pid });
  }
  return { d, pid, dbPath };
}

async function makeViewer({ withData, saveResult, writeError = null, startDir = null }) {
  installDom();
  installFetch();
  const calls = installTauri({ saveResult, writeError });
  const { d, pid, dbPath } = await makeDb({ withData });
  const { createViewer } = await import("../../src/ui/viewer.js");
  const viewer = createViewer({
    getDriver: () => d,
    getDbPath: () => dbPath,
    getProfileId: () => pid,
    getExportStartDir: () => startDir,
    labEntries: LAB_ENTRIES,
    onNotify: () => {},
  });
  return { viewer, calls, driver: d };
}

// 快取取不到時 viewer 會 console.error 一行（刻意不靜默吞掉），測試中壓掉
function quietConsole(t) {
  const orig = console.error;
  console.error = () => {};
  t.after(() => { console.error = orig; });
}

test("沒有資料的成員：兩條路徑都回 no_data，不開對話框也不寫檔", async (t) => {
  quietConsole(t);
  const { viewer, calls } = await makeViewer({ withData: false, saveResult: "/tmp/x.epub" });
  assert.deepEqual(await viewer.exportEpub(), { ok: false, reason: "no_data" });
  assert.deepEqual(await viewer.exportHtml(), { ok: false, reason: "no_data" });
  assert.deepEqual(calls.filter(c => c.api !== "exists"), []);
});

test("使用者取消儲存對話框：回 cancelled，且完全沒有寫檔", async (t) => {
  quietConsole(t);
  const { viewer, calls } = await makeViewer({ withData: true, saveResult: null });
  assert.deepEqual(await viewer.exportEpub(), { ok: false, reason: "cancelled" });
  assert.deepEqual(await viewer.exportHtml(), { ok: false, reason: "cancelled" });
  assert.equal(calls.filter(c => c.api === "save").length, 2);
  assert.deepEqual(calls.filter(c => c.api.startsWith("write")), []);
});

test("EPUB 走 fs.writeFile 且內容是 zip（不是被當字串處理的 writeTextFile）", async (t) => {
  quietConsole(t);
  const { viewer, calls } = await makeViewer({ withData: true, saveResult: "/tmp/out.epub" });
  const r = await viewer.exportEpub();
  assert.equal(r.ok, true);
  const writes = calls.filter(c => c.api.startsWith("write"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].api, "writeFile", "EPUB 用 writeTextFile 會毀掉二進位內容");
  assert.ok(writes[0].data instanceof Uint8Array);
  // zip 本體特徵：local file header magic
  assert.deepEqual([...writes[0].data.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(r.bytes, writes[0].data.length);
  // 對話框的預設檔名副檔名要對，否則使用者存出來的是 .html 內容卻是 zip
  const save = calls.find(c => c.api === "save");
  assert.match(save.opts.defaultPath, /-private\.epub$/);
});

test("HTML 那條沒有因為重構而退化：仍走 writeTextFile 且副檔名為 html", async (t) => {
  quietConsole(t);
  const { viewer, calls } = await makeViewer({ withData: true, saveResult: "/tmp/out.html" });
  const r = await viewer.exportHtml();
  assert.equal(r.ok, true);
  const writes = calls.filter(c => c.api.startsWith("write"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].api, "writeTextFile");
  assert.ok(writes[0].data.startsWith("<!doctype html>"));
  const save = calls.find(c => c.api === "save");
  assert.match(save.opts.defaultPath, /-private\.html$/);
});

test("指定路徑時不開對話框（兩條路徑行為一致）", async (t) => {
  quietConsole(t);
  const { viewer, calls } = await makeViewer({ withData: true, saveResult: null });
  const a = await viewer.exportEpub("/tmp/direct.epub");
  const b = await viewer.exportHtml("/tmp/direct.html");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(calls.filter(c => c.api === "save"), []);
  assert.deepEqual(calls.filter(c => c.api.startsWith("write")).map(c => c.p),
    ["/tmp/direct.epub", "/tmp/direct.html"]);
});

test("寫檔失敗要往上拋，不得吞成看似成功（呼叫端靠它才能提示使用者）", async (t) => {
  quietConsole(t);
  const { viewer } = await makeViewer({
    withData: true, saveResult: "/tmp/out.epub", writeError: "磁碟空間不足",
  });
  await assert.rejects(() => viewer.exportEpub(), /磁碟空間不足/);
  await assert.rejects(() => viewer.exportHtml("/tmp/out.html"), /磁碟空間不足/);
});

test("Windows 起始目錄不得產生混合分隔符的預設檔名", async (t) => {
  quietConsole(t);
  const { viewer, calls } = await makeViewer({
    withData: true, saveResult: null, startDir: "C:\\Users\\me\\Documents",
  });
  await viewer.exportEpub();
  const save = calls.find(c => c.api === "save");
  assert.ok(!save.opts.defaultPath.includes("/"),
    `Windows 路徑混進了斜線：${save.opts.defaultPath}`);
  assert.match(save.opts.defaultPath, /^C:\\Users\\me\\Documents\\健康紀錄_.*\.epub$/);
});
