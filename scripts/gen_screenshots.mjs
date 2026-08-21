// 產生 README 與下載頁用的截圖（docs/screenshots/*.png）。
//
// 為什麼要有這支腳本：截圖過時是反覆發生的問題（2026-08-20 UX 檢視的
// friction 6：文件寫著六分頁、截圖卻是四分頁時代，還拍著當時畫不出來的
// 灰帶）。根因是「重拍」需要手動開瀏覽器、逐頁點擊、對齊視窗尺寸，
// 沒人願意做。這支腳本把整套流程變成一個命令。
//
// 手法：demo.html 是自家頁面，分頁狀態存在元件內（沒有 URL 路由），
// 所以對每張截圖各產生一份注入了「自動點到該分頁」的變體 HTML，再用
// headless Chrome 拍純頁面（無瀏覽器介面）。輸出規格固定 1280x900 @2x
// （2560x1800 PNG），與既有截圖一致。
//
// 用法：
//   node scripts/gen_demo_data.mjs            # 先產出示範資料與 demo.html
//   node scripts/gen_screenshots.mjs [demo.html 路徑] [輸出目錄]
// 預設讀系統暫存目錄下的 hwb-demo/demo.html，寫入 docs/screenshots/。
// Chrome 路徑可用 CHROME_BIN 覆寫。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const DEMO = process.argv[2] || path.join(tmpdir(), "hwb-demo", "demo.html");
const OUT_DIR = process.argv[3] || path.join(REPO, "docs/screenshots");
const CHROME = process.env.CHROME_BIN
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// 每張截圖：檔名、要點的分頁、以及進入分頁後的額外動作（可省略）。
// 額外動作寫成在頁面裡跑的原始碼片段，不是選擇器字串：需要的操作
// （展開某張卡、切換下拉選單）用選擇器表達不完。
const SHOTS = [
  { name: "overview", tab: "總覽" },
  { name: "timeline", tab: "就醫" },
  {
    name: "meds", tab: "用藥",
    // 展開第一張用藥卡（現有截圖的重點是成分與官方登記適應症原文）
    after: `document.querySelector("section .event .evhead")?.click();`,
  },
  {
    name: "labs", tab: "檢驗",
    // 選一個參考值畫得出灰帶的項目，否則截圖上看不到本頁的重點
    after: `
      const sel = document.querySelector("section select");
      if (sel) {
        const want = [...sel.options].find((o) => /Hemoglobin|血色素|ALT|GPT/.test(o.value));
        if (want) {
          sel.value = want.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }`,
  },
  { name: "measures", tab: "測量" },
  { name: "sleep", tab: "睡眠呼吸" },
];

const clickTab = (label) => `
  const tab = [...document.querySelectorAll("nav button")]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
  if (!tab) { document.title = "TAB_NOT_FOUND:" + ${JSON.stringify(label)}; }
  else tab.click();`;

const inject = (tab, after) => `
<script>
// 截圖用：載入後切到目標分頁，再跑該張截圖的額外動作。兩段之間讓
// preact 有機會渲染完（同一輪跑完的話 after 會抓不到剛換頁的 DOM）。
window.addEventListener("load", () => {
  setTimeout(() => {
    ${clickTab(tab)}
    setTimeout(() => { ${after || ""} }, 120);
  }, 120);
});
</script>
`;

const demoHtml = readFileSync(DEMO, "utf-8");
if (!demoHtml.includes('id="hwb-data"')) {
  throw new Error(`${DEMO} 看起來不是檢視頁（找不到 hwb-data）`);
}
mkdirSync(OUT_DIR, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), "hwb-shots-"));

for (const { name, tab, after } of SHOTS) {
  const variant = path.join(work, `${name}.html`);
  writeFileSync(variant,
    demoHtml.replace("</body>", `${inject(tab, after)}</body>`));
  const out = path.join(OUT_DIR, `${name}.png`);
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--window-size=1280,900", "--force-device-scale-factor=2",
    // 分頁切換與圖表渲染都在 setTimeout 裡，時間預算要蓋過它們
    "--virtual-time-budget=6000",
    `--screenshot=${out}`, `file://${variant}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const buf = readFileSync(out);
  if (buf.length < 20_000) {
    throw new Error(`${name}.png 只有 ${buf.length} bytes，八成拍到空白頁`);
  }
  // PNG 前 24 bytes 帶寬高：規格跑掉（例如 Chrome 忽略了 scale factor）
  // 會讓截圖在 README 上模糊，而檔案大小看不出來
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w !== 2560 || h !== 1800) {
    throw new Error(`${name}.png 尺寸 ${w}x${h}，預期 2560x1800`);
  }
  console.log(`${name}.png  ${w}x${h}  ${(buf.length / 1024).toFixed(0)}KB`);
}
console.log(`\n輸出目錄：${OUT_DIR}`);
console.log("逐張目視確認過再 commit：分頁對不對、圖有沒有畫出來、有沒有空區塊");
