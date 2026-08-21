// 更新檢查的版本比對、請求最小化、徵詢決策與「前往查看」的 URL 白名單
// （change: update-check-optin，T2／T3）。全部走注入的 fetch，測試零連網。
import test from "node:test";
import assert from "node:assert/strict";
import {
  LATEST_URL, RELEASES_URL, stripPrefix, isDifferent, shouldCheck, checkLatest,
  decideCheck, safeReleaseUrl,
} from "../../src/ui/update_check.js";

test("stripPrefix：去除發布 tag 的 v 前綴", () => {
  assert.equal(stripPrefix("v0.8.0"), "0.8.0");
  assert.equal(stripPrefix("0.8.0"), "0.8.0");
  assert.equal(stripPrefix("  v1.2.3  "), "1.2.3");
  assert.equal(stripPrefix(null), "");
});

test("isDifferent：只判斷是否不同，不判斷新舊", () => {
  // 前綴不得造成誤判
  assert.equal(isDifferent("v0.8.0", "0.8.0"), false);
  assert.equal(isDifferent("v0.9.0", "0.9.0"), false);
  // 釘住字串大小比較的錯誤：若誤用 `<` 會把 0.10.0 判成不比 0.9.0 新
  assert.equal(isDifferent("v0.10.0", "0.9.0"), true);
  // 釘住「不得改回需要解析版本號的實作」：tag 格式改變仍要能通知
  assert.equal(isDifferent("2026.08", "0.8.0"), true);
  // 缺值不通知（寧可沉默，不可誤報）
  assert.equal(isDifferent(null, "0.8.0"), false);
  assert.equal(isDifferent("v0.9.0", ""), false);
});

test("shouldCheck：開發版與本機建置不檢查", () => {
  assert.equal(shouldCheck({ origin: "開發版" }), false);
  assert.equal(shouldCheck({ origin: "本機建置" }), false);
  assert.equal(shouldCheck({ origin: "" }), true);
  assert.equal(shouldCheck({}), true);
  assert.equal(shouldCheck(), true);
  // 非空的任何來源標示都不檢查（不比對特定字樣，改文案不會靜默失效）
  assert.equal(shouldCheck({ origin: "日後新增的來源" }), false);
});

// 記錄呼叫參數的假 fetch
function recordingFetch(payload, { ok = true } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok, json: async () => payload };
  };
  return { impl, calls };
}

test("checkLatest：取回 tag 與頁面連結", async () => {
  const { impl } = recordingFetch({
    tag_name: "v0.9.0",
    html_url: "https://github.com/notoriouslab/health-workbench/releases/tag/v0.9.0",
  });
  const r = await checkLatest({ fetchImpl: impl });
  assert.equal(r.tag, "v0.9.0");
  assert.match(r.url, /releases\/tag\/v0\.9\.0$/);
});

test("checkLatest：請求最小化，不送出當前版本或識別資訊", async () => {
  const { impl, calls } = recordingFetch({ tag_name: "v0.9.0", html_url: "u" });
  await checkLatest({ fetchImpl: impl });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, LATEST_URL);
  // URL 不得帶任何查詢參數（版本、識別碼、統計都可能藏在這裡）
  assert.equal(url.includes("?"), false);
  assert.equal(url.includes("0.8.0"), false);
  assert.equal(init.method, "GET");
  // 標頭只允許 Accept（內容協商，非識別資訊）
  assert.deepEqual(Object.keys(init.headers), ["Accept"]);
  // 整個請求序列化後不得出現任何版本號樣態
  assert.equal(/\d+\.\d+\.\d+/.test(JSON.stringify(calls[0])), false);
  assert.equal("body" in init, false);
});

test("checkLatest：回應缺 tag_name 時回 null", async () => {
  const { impl } = recordingFetch({ message: "Not Found" });
  assert.equal(await checkLatest({ fetchImpl: impl }), null);
});

test("checkLatest：HTTP 非成功時回 null", async () => {
  const { impl } = recordingFetch({ tag_name: "v0.9.0" }, { ok: false });
  assert.equal(await checkLatest({ fetchImpl: impl }), null);
});

test("decideCheck：未取得同意一律不查（T3 核心規則）", () => {
  assert.equal(decideCheck({}), "ask");                              // 還沒問過
  assert.equal(decideCheck({ updateCheck: false }), "skip");          // 拒絕
  assert.equal(decideCheck({ updateCheck: true }), "check");          // 同意
  // 開發版無論是否同意都不查
  assert.equal(decideCheck({ origin: "開發版", updateCheck: true }), "skip");
  assert.equal(decideCheck({ origin: "本機建置", updateCheck: true }), "skip");
});

test("負向對照：非 check 的決策絕不發出請求", async () => {
  const { impl, calls } = recordingFetch({ tag_name: "v0.9.0", html_url: "u" });
  const cases = [
    {},                                              // 還沒問過
    { updateCheck: false },                          // 拒絕
    { origin: "開發版", updateCheck: true },          // 開發版
  ];
  for (const cfg of cases) {
    if (decideCheck(cfg) === "check") await checkLatest({ fetchImpl: impl });
  }
  assert.equal(calls.length, 0, "未同意或開發版時不得發出任何請求");

  // 對照：同意時確實會查一次（證明上面的零不是因為整條路都不通）
  if (decideCheck({ updateCheck: true }) === "check") {
    await checkLatest({ fetchImpl: impl });
  }
  assert.equal(calls.length, 1);
});

// 「前往查看」的目標來自 API 回應的 html_url，是唯一一條把外部輸入交給
// 開系統瀏覽器的路徑，因此白名單是安全防線而非美化。
test("safeReleaseUrl：非本專案 GitHub 頁一律退回 releases 頁", () => {
  const ok = "https://github.com/notoriouslab/health-workbench/releases/tag/v0.9.0";
  assert.equal(safeReleaseUrl(ok), ok);
  assert.equal(safeReleaseUrl("https://github.com/notoriouslab/health-workbench"),
    "https://github.com/notoriouslab/health-workbench");

  for (const bad of [
    "javascript:alert(1)",                                   // scheme 注入
    "file:///etc/passwd",                                    // 本機檔案
    "http://github.com/notoriouslab/health-workbench",       // 非 https
    "https://github.com/someoneelse/malware/releases",       // 他人 repo
    "https://github.com/notoriouslab/health-workbench-evil", // 前綴撞名
    "https://github.com@evil.tld/notoriouslab/health-workbench", // host 混淆
    "https://raw.githubusercontent.com/notoriouslab/health-workbench/x",
    "not a url", "", null, undefined,
  ]) {
    assert.equal(safeReleaseUrl(bad), RELEASES_URL, `未擋下：${String(bad)}`);
  }
});

// 檔頭宣稱「離線與壞 JSON 都測得到」，那就 MUST 真的有這兩則：checkLatest 的
// catch 分支若沒被覆蓋，日後把 try 拿掉也不會轉紅，而它一拋錯就會打斷啟動流程。
test("checkLatest：離線（fetch 拋錯）與壞 JSON 皆靜默回 null", async () => {
  const offline = async () => { throw new TypeError("Load failed"); };
  assert.equal(await checkLatest({ fetchImpl: offline }), null);

  const badJson = async () => ({ ok: true, json: async () => { throw new SyntaxError("x"); } });
  assert.equal(await checkLatest({ fetchImpl: badJson }), null);

  // 額度限制：GitHub 回 403 帶 message，不得誤判成有新版
  const rateLimited = async () => ({ ok: false, json: async () => ({ message: "rate limit" }) });
  assert.equal(await checkLatest({ fetchImpl: rateLimited }), null);
});
