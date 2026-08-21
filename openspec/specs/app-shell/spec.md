# app-shell Specification

## Purpose

桌面應用的外殼與啟動鏈：Tauri 應用的基本規範、資料庫定位與首次啟動、
knowledge 資源隨 bundle 出貨，以及雙平台建置與 CI 的零個資紀律
（change tauri-desktop-app，2026-08-10）。

## Requirements

### Requirement: 桌面應用基本規範

App MUST 以 Tauri 2 建置，介面繁體中文、跟隨系統深淺色；
src-tauri MUST 僅含殼與插件註冊，不得出現匯入業務邏輯。

#### Scenario: 啟動與外觀
- **WHEN** 於 macOS 啟動 App（系統深色模式）
- **THEN** 視窗以深色主題顯示繁中介面，切換系統至淺色後 App 跟隨

#### Scenario: 業務邏輯位置守衛
- **WHEN** 掃描 `app/src-tauri/src/`
- **THEN** 無任何解析、schema、knowledge 相關符號（rg 守衛清單通過）


<!-- @trace
source: tauri-desktop-app
updated: 2026-08-10
code:
  - docs/verification/app_qa_closeout.md
-->

---
### Requirement: 資料庫定位與首次啟動

資料庫 MUST 位於系統 App 資料目錄（Tauri appDataDir），路徑 MUST NOT
硬編碼；開發模式 MUST 可用環境變數覆寫。首次啟動無資料庫時 MUST 建立
空庫（schema 版本為現行版），並提供「匯入既有資料庫檔」入口。App
MUST 同時提供「匯出資料庫檔」入口（與匯入同區）：以一致性快照方式
（SQLite VACUUM INTO）將全庫複製到使用者指定位置，過程 MUST NOT
中斷或修改使用中的主庫；預設檔名 MUST 含日期以避免覆蓋；目標檔案
已存在時 MUST 拒絕並提示換檔名（零寫入）；成功與失敗 MUST 以通知
列回報（成功含路徑與大小、含個資提醒）。

#### Scenario: 首次啟動
- **WHEN** App 資料目錄不存在任何資料庫時啟動
- **THEN** 建立空庫，檢視頁顯示「尚無資料」與匯入引導，設定頁顯示
  資料庫實際路徑

#### Scenario: 既有資料庫遷移
- **WHEN** 使用者以「匯入既有資料庫檔」選擇一個 CLI 產生的
  hwb.sqlite（schema 版本 ≤ 現行）
- **THEN** 檔案複製至 App 資料目錄並完成前向遷移，檢視頁顯示既有資料；
  原檔不被修改

#### Scenario: 版本過新防護
- **WHEN** 選擇的資料庫 schema 版本高於 App 支援版本
- **THEN** 拒絕匯入並顯示「請更新 App」訊息，零寫入

#### Scenario: 匯出資料庫檔（備份／搬機）
- **WHEN** 使用者於管理成員面板進階區點「匯出資料庫檔…」並選擇
  儲存位置
- **THEN** 產生可直接被「匯入既有資料庫檔」讀回的單一 sqlite 檔
  （全成員、schema 版本一致、各表筆數與主庫一致），主庫維持開啟
  且內容不變；通知列顯示匯出路徑與大小

#### Scenario: 目標檔案已存在
- **WHEN** 匯出目標路徑已有同名檔案
- **THEN** 拒絕匯出並提示換檔名，既有檔案逐位元組不變


<!-- @trace
source: misattribution-rescue
updated: 2026-08-12
code:
  - docs/verification/misattribution_rescue_qa_closeout.md
-->

---
### Requirement: knowledge 資源隨 bundle

藥品品項資料庫與檢驗 knowledge MUST 以唯讀資源隨 bundle 發佈：
`drug_items.sqlite` 以唯讀 ATTACH 使用；`labs.yaml` MUST 於建置期
轉為 JSON 進 bundle，執行期不依賴 YAML 解析。

#### Scenario: 資源存在且唯讀
- **WHEN** App 啟動並執行一次藥品 join 查詢
- **THEN** 查詢成功且對 drug_items 的寫入嘗試失敗（唯讀連接）


<!-- @trace
source: tauri-desktop-app
updated: 2026-08-10
code:
  - docs/verification/app_qa_closeout.md
-->

---
### Requirement: 雙平台建置與 CI 零個資

MUST 以 GitHub Actions matrix（macOS、Windows）用官方 tauri-action
建置雙平台安裝包。CI MUST 僅使用去識別化 fixtures，
workflow MUST NOT 讀取 `data/` 目錄。

macOS 簽章為條件式：release 建置在六個 Apple Secrets 齊全時 MUST
簽章（Developer ID Application）並公證，且 MUST 通過機器驗收
（憑證類型、codesign 嚴格驗證、App 與 DMG 兩層公證票據）才可發布；
Secrets 全缺時 MUST 照常產出未簽章產物並於發布說明註明；部分設定
MUST 使建置失敗（半簽章產物不出貨）。Windows 產物不簽章。

#### Scenario: CI 建置
- **WHEN** push 觸發建置 workflow
- **THEN** macOS 產出 .dmg/.app、Windows 產出 .msi 或 .exe 安裝包，
  上傳為 artifacts

#### Scenario: 個資防線
- **WHEN** 檢查 workflow 定義與建置日誌
- **THEN** 無 `data/` 路徑引用；bundle 內容清單不含任何個資檔案

#### Scenario: 簽章驗收擋下不合格產物
- **WHEN** release 建置的簽章或公證不完整（憑證類型錯誤、票據缺失、
  或 DMG 後處理後未重新公證）
- **THEN** 驗收步驟非零退出，最終 DMG 不上傳，release 草稿本體
  被標記「勿發布」

#### Scenario: 未簽章建置的負向對照
- **WHEN** 推 main 觸發未簽章建置
- **THEN** 驗收腳本以 unsigned 模式斷言產物非 Developer ID 簽章
  且無公證票據（驗收機制每次推 main 都被實跑）

<!-- @trace
source: tauri-desktop-app
updated: 2026-08-15
code:
  - docs/verification/app_qa_closeout.md
  - .github/workflows/release.yml
  - .github/workflows/app-build.yml
  - scripts/verify_macos_signing.sh
-->

---
### Requirement: 檔案存取範圍

寫入類權限 MUST 只開放 `$APPDATA`（設定檔與藥品快取）。匯出 HTML 與資料庫
檔寫的是使用者在儲存對話框選定的路徑，由 dialog 插件在選檔當下動態授權，
MUST NOT 為此擴大靜態寫入範圍。

**讀取類權限 MUST 維持不限定位置（`**`），MUST NOT 改為位置白名單。**

理由：本 App 離線處理本機檔案，使用者主動把來源拖入視窗，該動作本身就是
授權的表示。位置白名單等於規定使用者的檔案要放在哪幾個資料夾，把假設性的
安全成本轉嫁給每個人的檔案組織習慣，而那不是本 App 該規定的事。

收窄也無法達成其表面目的，2026-08-17 實測為證：把讀取九項由 `**` 改為
「下載／桌面／文件匣／`/Volumes`」白名單後，範圍外路徑（`~/Pictures`）
**仍可讀取**（`read_dir` 成功、走到判型失敗），而範圍內的讀卡機掛載磁碟
**反而拖不進去**。該擋的沒擋、該通的通不了，兩頭皆錯。防線在模型不正確時
上線，比不上線更危險。

威脅模型的前提也不成立：可濫用讀取範圍的路徑需要先有 script 注入，而
2026-08-17 已逐處驗證 App shell 的 `innerHTML` 組裝（`history.js`、
`main.js`、`profile_manager.js`，含檔名、成員名與各類訊息）全數經過
`esc()`，檢視層走 preact/htm 自動轉義，且無 `eval`／`new Function`、
前端不載入任何遠端資源。此結論 MUST 於新增 `innerHTML` 組裝點時重驗。

拖放與選檔的授權機制不同，這是理解上述判斷的前提，MUST 記載：選檔按鈕走
dialog，插件在選中當下 `allow_file` 動態授權，不受靜態 scope 約束；拖放
（`tauri://drag-drop`）只取得路徑字串、無任何動態授權，能否讀取完全由靜態
scope 決定。而 CPAP 整張記錄卡與 Apple 匯出資料夾只能經拖放匯入。

fs scope 拒絕的錯誤 MUST 轉為畫面上的訊息，MUST NOT 成為未捕捉的 rejection
（那會使拖入毫無反應）。訊息 MUST 指出「改用選擇檔案按鈕」這條確定可行的
替代路徑，且 MUST NOT 要求使用者搬移資料夾到特定位置（讀取範圍是 `**`，
沒有位置白名單，那是錯誤的引導）。

#### Scenario: 從任意位置拖入來源
- **WHEN** 使用者從家目錄以外的任意位置（外接磁碟、記錄卡掛載點、
  自訂資料夾）拖入受支援的來源
- **THEN** 匯入正常進行，不因來源位置被拒絕

#### Scenario: 讀取被系統拒絕時的呈現
- **WHEN** 讀取路徑遭 fs scope 拒絕（例如 Tauri glob 不匹配 leading dot
  的路徑）
- **THEN** 畫面顯示錯誤卡並指出可改用選擇檔案按鈕，資料庫零寫入，
  且訊息不要求使用者搬移資料夾

<!-- @trace
source: tauri-desktop-app
updated: 2026-08-17
code:
  - app/src-tauri/capabilities/default.json
  - app/src/ui/import_flow.js
  - app/tests/adapters/edge_cases.test.mjs
  - docs/verification/cpap_dotfile_scope_fix.md
  - docs/verification/viewer_history_refinement.md
-->

---
### Requirement: 內容安全政策

`tauri.conf.json` 的 `app.security.csp` MUST 為 `null`，MUST NOT 設定任何
CSP 字串。

理由：Tauri 在 `csp` 非 `null` 時會注入 `script-src 'nonce-…'` 以保護自身
腳本，而 CSP 規範規定 `script-src` 存在 nonce 時 `'unsafe-inline'` 失效。
檢視層以 `iframe srcdoc` 承載單檔自足的 HTML（inline 一切是它的設計前提，
見 `dashboard-generator` 的「單檔自足」），srcdoc 繼承父文件的 CSP，於是
所有 inline script 被擋，四個分頁完全失效。

失效的症狀 MUST 記載，因為它不像權限問題：App shell 一切正常（狀態列顯示
成員與各表筆數），只有 iframe 停在 assemble 的 fallback 文字「載入中…」，
看起來像資料載入很慢或卡住。判別法是看 renderer 的 CPU：JS 被擋時 CPU 為
零且記憶體不成長，真的在解析大量資料時 CPU 會滿載。

2026-08-17 v0.6.0 實測三種設定：
1. `default-src 'self'; script-src 'self' 'unsafe-inline'; …` → 壞
2. 移除 `script-src`，只留 `connect-src`／`object-src`／`base-uri`／
   `form-action` → **仍壞**（注入的是 Tauri，與我方是否宣告該指令無關）
3. `csp: null` → 恢復正常

**MUST NOT 以 dev 模式走查作為 CSP 變更的驗證**：dev 走 `devUrl`
（`http://127.0.0.1:*`），不經正式版自訂協議的注入路徑，測不出此差異。
本輪即因 dev 走查「四分頁與搜尋皆正常」而誤判為安全，正式版才炸。CSP 相關
變更 MUST 以 `tauri build` 的正式產物驗證。

要取得 CSP 的防護（尤其 `connect-src` 對外送的限制）必須先改掉 srcdoc
架構，例如改由自訂協議提供檢視頁、或讓 assemble 接受 nonce 注入，屬獨立
變更，MUST NOT 在未做該項的情況下逕自設定 csp。

#### Scenario: 檢視層在正式建置下維持完整功能
- **WHEN** 以 `tauri build` 的產物開啟資料檢視
- **THEN** 四個分頁正常顯示內容，全文搜尋與趨勢區間切換可用，
  iframe 不停留在「載入中…」

#### Scenario: 設定 CSP 會使檢視層失效
- **WHEN** `app.security.csp` 被設為任何非 `null` 值並以正式建置開啟
- **THEN** iframe 內的 inline script 被 Gatekeeper 以外的 CSP 機制擋下，
  四個分頁無內容（此為已知限制，不是可調參數）

<!-- @trace
source: tauri-desktop-app
updated: 2026-08-17
code:
  - app/src-tauri/tauri.conf.json
  - app/src/ui/viewer.js
  - app/src/provider/assemble.js
-->

---
### Requirement: 檢查新版入口

App MUST 於版號旁提供「檢查新版」入口，點擊以系統瀏覽器開啟本專案的
GitHub releases 頁。開啟失敗時沿用既有 fallback（複製連結並提示手動前往）。

先前版本要求「App 本體 MUST NOT 為此發出任何網路請求，MUST NOT 自動檢查
版本」。該限制已放寬：App MAY 在**取得使用者明示同意後**自動查詢最新版本號，
其約束由後續三條 Requirement 規範（徵詢、請求最小化、節制與靜默失敗）。
放寬的理由與界線：「不連網」承諾的正確範圍是使用者的健康資料不離開本機，
不含一個不攜帶任何使用者資料的版本號查詢；而僅靠使用者主動點擊的入口，
無法觸及不會自行回到專案頁的使用者。

未取得同意時，行為 MUST 與先前版本完全一致：App 本體 MUST NOT 為版本檢查
發出任何網路請求。

#### Scenario: 使用者主動檢查
- **WHEN** 使用者點擊「檢查新版」
- **THEN** 系統瀏覽器開啟 releases 頁

#### Scenario: 未同意時維持零連網
- **WHEN** 徵詢結果為未定或拒絕，App 啟動並閒置
- **THEN** 無任何對外請求（含版本檢查類）

<!-- @trace
source: update-check-optin
updated: 2026-08-21
code:
  - docs/verification/display_revamp.md
  - docs/verification/update_check_optin.md
-->

---
### Requirement: 更新檢查的徵詢

App SHALL 於首次啟動時徵詢一次是否啟用更新檢查。徵詢文字 MUST 說明三件事：
只查詢最新版本號、不送出任何使用者資料、隨時可以關閉。

徵詢結果為三態：未定、同意、拒絕。**狀態為未定或拒絕時，App MUST NOT 發出
任何版本查詢請求**。使用者做出選擇後 MUST NOT 再次徵詢，但 SHALL 提供一個
常駐入口讓設定隨時可變更，且該入口 MUST 顯示當前狀態。

徵詢狀態 SHALL 存於既有設定檔（與資料庫同目錄）。該檔先前僅存數字 id，
本變更後另存一個布林；其檔頭說明 MUST 同步更新。MUST NOT 記錄上次檢查
時間：那等於記錄「使用者曾於該日開啟 App」，而它唯一的用途（頻率節流）
已刪除（design D5）。

#### Scenario: 首次啟動徵詢
- **WHEN** 設定檔無徵詢紀錄且 App 啟動
- **THEN** 出現徵詢，且在使用者選擇之前無任何對外請求

#### Scenario: 選擇後不再詢問
- **WHEN** 使用者已做出選擇並重新啟動 App
- **THEN** 不再出現徵詢

#### Scenario: 拒絕後零請求
- **WHEN** 徵詢結果為拒絕
- **THEN** 啟動與閒置期間皆無版本查詢請求

#### Scenario: 選擇後仍可隨時變更
- **WHEN** 使用者已做出選擇，App 啟動且執行來源為正式安裝版
- **THEN** 版號那一行出現顯示當前狀態的開關，按一下即切換並立即生效
  （由關轉開時當次啟動即檢查一次，由開轉關時清掉既有的新版提示）

<!-- @trace
source: update-check-optin
updated: 2026-08-21
code:
  - docs/verification/update_check_optin.md
-->

---
### Requirement: 版本查詢的請求最小化

查詢 SHALL 僅取得最新發布版本號。請求 MUST NOT 攜帶當前版本、識別碼、
機器資訊或任何使用統計，版本比對 MUST 在本機進行。

理由：把當前版本送出可讓對方統計版本分布，那是實質的隱私退讓，而本機比對
不需要它。

發布版本號帶前綴（如 `v0.8.0`）而 App 版本不帶（如 `0.8.0`），比對前
MUST 去除前綴。比對 SHALL 只判斷兩者**是否不同**，MUST NOT 判斷新舊：
正式安裝版的版本必然不晚於最新發布版，因此「不同」即「有新版」。
MUST NOT 以字串大小比較（`0.10.0` 會被判為小於 `0.9.0`）。

開發版與本機建置 MUST NOT 執行更新檢查。理由：發版流程先提升版本號再打
tag，故在提升之後、發布之前，開發版的版本必然不同於最新發布版且更新，
若對其執行檢查會通知開發者去下載較舊的版本。執行來源的判定沿用既有機制。

查詢 MUST 只在已發布版本上判斷，MUST NOT 因未發布的草稿而通知使用者。

所有失敗（離線、HTTP 非 200、回應形狀不符）MUST 靜默處理：MUST NOT 顯示
錯誤訊息、MUST NOT 重試。更新檢查是附帶便利，為它產生的錯誤訊息是純干擾。

#### Scenario: 本機比對
- **WHEN** 執行版本查詢
- **THEN** 請求不含當前版本或任何識別資訊，是否不同由本機判定

#### Scenario: 跨十位數的版本
- **WHEN** 當前版本為 0.9.0、最新發布為 v0.10.0
- **THEN** 判定為有新版（不因字串大小比較而漏判）

#### Scenario: 版本相同
- **WHEN** 當前版本為 0.8.0、最新發布為 v0.8.0
- **THEN** 判定為無新版，不顯示提示

#### Scenario: 開發版不檢查
- **WHEN** 執行來源為開發版或本機建置
- **THEN** 不發出任何版本查詢請求

#### Scenario: 草稿不觸發通知
- **WHEN** 最新的發布項目仍為草稿狀態
- **THEN** 使用者不會被通知該版本

<!-- @trace
source: update-check-optin
updated: 2026-08-21
code:
  - docs/verification/update_check_optin.md
-->

---
### Requirement: 只通知不下載

偵測到較新版本時，App SHALL 於版號旁顯示一行提示與前往查看的入口，
點擊以系統瀏覽器開啟。App MUST NOT 自行下載、MUST NOT 自行安裝任何檔案，
MUST NOT 以彈出視窗打斷使用者當前操作。

匯出的單檔 HTML 與 EPUB MUST NOT 帶有更新檢查行為（實作位於殼層，匯出產物
天然不含；此條為驗收依據而非假設）。

#### Scenario: 有新版時的提示
- **WHEN** 查詢結果較新
- **THEN** 版號旁出現一行提示與前往查看入口，無彈窗、無下載

#### Scenario: 匯出檔不含此行為
- **WHEN** 開啟匯出的單檔 HTML 或 EPUB
- **THEN** 無任何版本查詢請求、無更新提示

<!-- @trace
source: update-check-optin
updated: 2026-08-21
code:
  - docs/verification/update_check_optin.md
-->

---
### Requirement: 隱私敘述與實際行為一致

使用者可見的隱私敘述（README、App 介面、專案下載頁）MUST 準確反映實際
網路行為。MUST NOT 使用會被單次連外行為推翻的絕對措辭（如無條件的
「不連網」「不追蹤」）。

敘述 SHALL 分述兩件事：使用者的健康資料不離開本機；更新檢查只查詢版本號、
不送出任何使用者資料、可以關閉。

檢視層的列印相關敘述不在此範圍（列印行為確實不連網）。

#### Scenario: 敘述可驗證
- **WHEN** 讀者比對隱私敘述與實際網路行為
- **THEN** 兩者一致，無需靠註腳解釋例外

<!-- @trace
source: update-check-optin
updated: 2026-08-21
code:
  - docs/verification/update_check_optin.md
-->
