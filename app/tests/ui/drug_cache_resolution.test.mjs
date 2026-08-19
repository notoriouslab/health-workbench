// 藥品快取解析的決策測試（change drug-info-and-lab-refband，QA BLOCKER 修正）。
// 背景：viewer 首次開啟會把 bundle 複製到資料目錄，原本「local 存在就用」讓
// 之後每一版新 bundle 都永遠讀不到（2026-08-20 稽核以實機檔與舊 bundle 逐
// 位元組對帳實證）。resolveDrugCachePath 以 cache_meta 建置日期裁決，這裡以
// 注入 deps 直測六種形狀；fs 權限層注入測不到（feedback_injected_fs），實機
// dogfood 另驗「升級後 meta 日期變新版」。
import test from "node:test";
import assert from "node:assert/strict";
import { resolveDrugCachePath } from "../../src/ui/viewer.js";

const DIR = "/data";
const LOCAL = "/data/drug_items.sqlite";
const BUNDLE = "/app/resources/drug_items.sqlite";

function makeDeps({ hasLocal, bundleOk = true, localDate = "", bundleDate = "",
  copyFails = false }) {
  const calls = { copies: [] };
  return {
    calls,
    exists: async (p) => { assert.equal(p, LOCAL); return hasLocal; },
    resolveResource: async () => {
      if (!bundleOk) throw new Error("resource 不可解析");
      return BUNDLE;
    },
    cacheDate: async (p) => (p === LOCAL ? localDate : bundleDate),
    copyFile: async (from, to) => {
      if (copyFails) throw new Error("copy 失敗");
      calls.copies.push([from, to]);
    },
  };
}

test("local 不存在：從 bundle 複製一份（既有語意不變）", async () => {
  const deps = makeDeps({ hasLocal: false });
  assert.equal(await resolveDrugCachePath(deps, DIR, "/"), LOCAL);
  assert.deepEqual(deps.calls.copies, [[BUNDLE, LOCAL]]);
});

test("local 較舊（升級後的預設形狀）：bundle 覆蓋——BLOCKER 修正本體", async () => {
  const deps = makeDeps({ hasLocal: true,
    localDate: "2026-08-08", bundleDate: "2026-08-20" });
  assert.equal(await resolveDrugCachePath(deps, DIR, "/"), LOCAL);
  assert.deepEqual(deps.calls.copies, [[BUNDLE, LOCAL]], "舊 local 必須被新 bundle 覆蓋");
});

test("local 較新或同日（使用者自行 knowledge update）：不覆蓋", async () => {
  for (const localDate of ["2026-08-21", "2026-08-20"]) {
    const deps = makeDeps({ hasLocal: true, localDate, bundleDate: "2026-08-20" });
    assert.equal(await resolveDrugCachePath(deps, DIR, "/"), LOCAL);
    assert.deepEqual(deps.calls.copies, [], `localDate=${localDate} 不該被蓋掉`);
  }
});

test("local 日期讀不到（檔壞／無 cache_meta）：視為最舊，bundle 覆蓋", async () => {
  const deps = makeDeps({ hasLocal: true, localDate: "", bundleDate: "2026-08-20" });
  assert.equal(await resolveDrugCachePath(deps, DIR, "/"), LOCAL);
  assert.deepEqual(deps.calls.copies, [[BUNDLE, LOCAL]]);
});

test("bundle 不可解析（dev 探測失敗前例）：沿用既有 local，不炸", async () => {
  const deps = makeDeps({ hasLocal: true, bundleOk: false, localDate: "2026-08-08" });
  assert.equal(await resolveDrugCachePath(deps, DIR, "/"), LOCAL);
  assert.deepEqual(deps.calls.copies, []);
});

test("覆蓋失敗：退回舊資料（可用但陳舊），不回 null", async () => {
  const deps = makeDeps({ hasLocal: true, copyFails: true,
    localDate: "2026-08-08", bundleDate: "2026-08-20" });
  assert.equal(await resolveDrugCachePath(deps, DIR, "/"), LOCAL);
});

test("雙邊都拿不到：回 null（既有降級語意）", async () => {
  const deps = makeDeps({ hasLocal: false, bundleOk: false });
  assert.equal(await resolveDrugCachePath(deps, DIR, "/"), null);
});
