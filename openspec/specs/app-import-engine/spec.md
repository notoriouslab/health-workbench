# app-import-engine Specification

## Purpose

App 內建的匯入引擎：把原本 Python CLI 的匯入能力搬進桌面 App，涵蓋
儲存存取抽象、串流解析與大檔門檻、adapter 註冊制，以及多檔來源的原子性
與逐檔韌性。核心約束是與既有匯入 specs（nhi-import、apple-health-import、
incremental-merge）行為等價，且匯入 MUST NOT 破壞既有資料
（change tauri-desktop-app，2026-08-10）。

## Requirements

### Requirement: 與既有匯入 specs 的行為等價

JS 匯入引擎 MUST 滿足既有 `nhi-import`、`apple-health-import`、
`incremental-merge`、`health-database` specs（openspec/specs/）的
requirements，**唯一例外為 `nhi-import` 的「遮罩身分證歸戶」
requirement**：該條描述 Python CLI 的單人自動歸戶行為（維持凍結），
App 引擎改由本 spec 的「匯入歸屬指定」requirement 約束。其餘
requirements 的行為描述對本引擎具約束力，本 spec 不重抄。

#### Scenario: 差分對帳全等（fixture 全集）
- **WHEN** 將既有去識別化 fixture 全集分別經 Python CLI 與 JS 引擎
  （node:sqlite driver）匯入兩個空庫；JS 側先建立顯示名稱「本人」
  的成員並以其 id 為匯入歸屬（健保檔匯入時綁定 b1.1，終態與
  oracle 自動建檔結果一致）
- **THEN** 逐表排序 dump diff 全等（含 profiles 表；排除
  imported_at 時間戳；自增主鍵不直接比對，外鍵欄位先解析為參照列
  自然鍵再比，關聯正確性必須被覆蓋），增量品質報告 JSON（時間戳
  除外）全等，harness exit code 0

#### Scenario: 畸形數值契約
- **WHEN** fixture 含 value="12abc" 的紀錄
- **THEN** JS 引擎與 Python 一致視為文字值（value_text），
  MUST NOT 以 parseFloat 前綴寬鬆解析為 12
<!-- @trace
source: multi-profile-management
updated: 2026-08-10
code:
  - docs/verification/multi_profile_qa_closeout.md
-->

---
### Requirement: 儲存存取抽象與批次寫入

匯入引擎與 adapter MUST 僅透過 StoreDriver 介面（execute/select/
batchInsert/transaction）存取資料庫；App 實作走 app 自有 SQLite 橋
（rusqlite 單連線＋Mutex，design D2 修訂二），測試實作走 node:sqlite。批次寫入 MUST 於單一交易內以 json_each
單參數展開分批（每批 20000 列）執行（2026-08-09 task 0.3 實測定案；
多列 VALUES 因 sqlx 參數綁定成本被否決）。

#### Scenario: 同一套業務碼雙環境執行
- **WHEN** 以 node:sqlite driver 執行完整匯入測試套件
- **THEN** 全部通過，且被測模組與 App 打包進 bundle 的引擎模組為同一
  份檔案（非複製）

#### Scenario: 批次效能門檻
- **WHEN** 在真實 App（WKWebView）內經 SQLite 橋批次寫入
  10 萬筆 apple_records（2026-08-09 橋接後復驗 1.96s）
- **THEN** 10 秒內完成且交易原子（中斷即整批回滾）


<!-- @trace
source: tauri-desktop-app
updated: 2026-08-10
code:
  - docs/verification/app_qa_closeout.md
-->

---
### Requirement: 串流解析與大檔門檻

adapter MUST 分塊串流讀檔與解析（禁止一次性讀入整檔）；zip MUST 以
DecompressionStream 串流解壓。220MB 合成 Apple 匯出檔於真實 App 內
解析＋入庫 MUST 於 60 秒內完成。

#### Scenario: 大檔匯入
- **WHEN** 在 App 內匯入 220MB 去識別化合成 export.xml（90 萬元素）
- **THEN** 60 秒內完成，過程中記憶體峰值不隨檔案大小線性成長
  （分塊上限固定），結果與 oracle 對帳全等

#### Scenario: zip 直接匯入
- **WHEN** 使用者選擇 export.zip（含中文檔名成員、cp437 旗標未設）
- **THEN** 正確找到 XML 成員並串流解壓匯入，毋須使用者先解壓


<!-- @trace
source: tauri-desktop-app
updated: 2026-08-10
code:
  - docs/verification/app_qa_closeout.md
-->

---
### Requirement: adapter 註冊制與格式擴充點

MUST 以註冊表管理 adapter，每個 adapter 提供內容判型
`detect(header, name)` 與 `import(source, store, progress)`；
新增格式 MUST 只需新增 adapter 模組與註冊項，引擎與 GUI 不改。

**多檔來源** MUST 另以可選介面支援：集合判型與集合匯入。註冊表的介面
檢查 MUST 接受「單檔匯入與集合匯入至少實作其一」，MUST NOT 要求多檔
adapter 實作單檔匯入（半批匯入沒有意義）。

集合判型收到的項目 MUST 以**惰性方式**提供檔頭，由 adapter 自行決定要
讀哪幾個檔。MUST NOT 由呼叫端預先讀取全部檔頭：資料夾可能含上千個與該
adapter 無關的檔案（如另一個來源的匯出目錄），逐檔讀取會讓其他來源的
每次匯入都多出上千次輸入輸出。

只實作單檔匯入的既有 adapter MUST NOT 因本擴充而需要修改。

#### Scenario: 內容判型
- **WHEN** 使用者選擇副檔名改為 .txt 的健保 JSON 檔
- **THEN** 仍被 NHI JSON adapter 正確識別並匯入（判內容不判檔名）

#### Scenario: 擴充點驗證
- **WHEN** 測試注入一個假格式 adapter（detect 匹配魔術位元組）
- **THEN** 引擎自動判型並路由至該 adapter，GUI 格式清單自動含其名稱

#### Scenario: 集合判型只讀必要的檔
- **WHEN** 對一個含大量無關檔案的資料夾進行集合判型
- **THEN** 不符合該 adapter 特徵時一個檔案都不讀取；符合時只讀取該
  adapter 需要的那幾個檔

#### Scenario: 多檔 adapter 的註冊
- **WHEN** 註冊一個只實作集合匯入的 adapter
- **THEN** 註冊成功；兩種匯入介面都沒有時才拒絕

<!-- @trace
source: cpap-sleep-therapy
updated: 2026-08-13
code:
  - docs/verification/app_qa_closeout.md
  - docs/verification/cpap_gui_batch.md
-->

---
### Requirement: 健保 XML 匯入

MUST 新增 NHI XML adapter：解析 XML 版共同節區（r1-r8，官方 XML 格式
無 r9-r14），欄位對照與 JSON 版一致，r8 報告 MUST 保留原始換行。

#### Scenario: 同批 JSON/XML 交叉對帳
- **WHEN** 將同批下載的 JSON 與 XML 檔分別匯入兩個空庫，以
  （section, record_fp）對齊紀錄（兩格式檔內排序不同，不得以列序對齊）
- **THEN** r1-r7 全部紀錄指紋對齊且欄位全等；白名單僅 r8：官方 JSON
  移除換行字元（非代換空白），故含換行報告的指紋跨格式必然不同，
  以弱鍵（test_date＋order_code＋facility_name）對齊後 report_text
  去除全部空白後 MUST 全等（2026-08-09 真實同批檔實測：65 encounters
  ＋68 labs＋4 immunizations 指紋全對齊零差異；r8 7 筆中 6 筆含換行）

#### Scenario: XML 節區缺漏事實
- **WHEN** 匯入 XML 檔
- **THEN** r9-r14 節區標記 no_data 且品質報告註明「XML 格式無此節區」，
  不誤報為資料異常


<!-- @trace
source: tauri-desktop-app
updated: 2026-08-10
code:
  - docs/verification/app_qa_closeout.md
-->

---
### Requirement: 匯入進度回報

adapter MUST 以已讀位元組數回報進度（每處理 5000 筆呼叫一次
progress），供 GUI 顯示百分比；進度回報失敗 MUST NOT 影響匯入結果。

進度的總量（totalBytes）MUST 為**解析內容的未壓縮總量**，與分子同一
單位：zip 來源取 central directory 的未壓縮大小欄位；非 zip 來源即檔案
大小。未壓縮大小取不到時（zip64 標記 `0xFFFFFFFF` 或欄位為 0）
totalBytes MUST 以 0 回報，GUI 據此不顯示百分比（見 `app-import-gui`）。
MUST NOT 以壓縮後大小當總量、以解壓後位元組當分子（兩者相差一個壓縮比，
實測真實匯出檔為 24.1 倍，百分比會在流程早期即到頂）。

**多檔來源** MUST 以整批合計位元組為總量、跨檔累加已讀位元組，進度在
整批匯入過程中 MUST 維持單調遞增。

#### Scenario: 進度單調
- **WHEN** 匯入 220MB 合成檔並記錄 progress 事件
- **THEN** readBytes 單調遞增至 totalBytes，事件數 ≥ 50（進度以資料塊為
  週期回報，220MB／4MB 塊＝56 事件，2026-08-09 實測校準）

#### Scenario: zip 分母誠實
- **WHEN** 匯入 zip 來源並記錄 progress 事件
- **THEN** totalBytes 等於主 XML 的未壓縮大小（非 zip 檔大小），百分比
  到達 100% 時匯入隨即完成，不存在「停在 100% 繼續跑」的區間

#### Scenario: 未壓縮大小不可得的 fallback
- **WHEN** zip 的未壓縮大小欄位為 0xFFFFFFFF 或 0
- **THEN** totalBytes 以 0 回報，匯入照常完成，進度僅以筆數呈現

#### Scenario: 多檔進度單調
- **WHEN** 匯入含多個檔案的來源
- **THEN** 已讀位元組跨檔累加且不回退，總量為整批合計

<!-- @trace
source: import-progress-and-single-pass
updated: 2026-08-19
code:
  - docs/verification/app_qa_closeout.md
  - docs/verification/cpap_resmed_adapter.md
  - docs/verification/import_single_pass.md
-->

---

### Requirement: 匯入歸屬指定

adapter 匯入 MUST 接受明確的成員 id（opts.profileId，必填）並於
開頭驗證該成員存在，MUST NOT 自動歸入第一個成員或自動建立成員。
健保檔 MUST 對所選成員執行遮罩身分證護欄：成員未綁定身分證則於
匯入時綁定檔案 b1.1，但綁定前 MUST 檢查該身分證未綁定於其他成員
（已綁他人＝選錯成員，中止並提示該身分證所屬成員）；已綁定且
相符則通過；不符 MUST 中止且零寫入（訊息列出成員名稱與兩個
遮罩值）；檔案缺 b1.1 MUST 中止。
Apple 檔（無身分識別）直接歸入所選成員。重複檔案（全庫 SHA-256
命中）MUST 於訊息中附原歸屬成員名稱與原匯入時間後跳過。

#### Scenario: 身分證護欄阻擋
- **WHEN** 成員「爸爸」已綁定 A12345****，匯入檔 b1.1=B98765****
  且歸屬選「爸爸」
- **THEN** 中止並顯示成員名稱與兩個遮罩值，資料庫零寫入

#### Scenario: 首次綁定
- **WHEN** 成員「媽媽」尚未綁定身分證，歸屬選「媽媽」匯入
  b1.1=B98765**** 的健保檔
- **THEN** 匯入完成且「媽媽」綁定 B98765****，後續不符檔案被護欄
  阻擋

#### Scenario: 綁定衝突（選錯未綁定成員）
- **WHEN** 成員「本人」已綁定 A12345****，新成員「媽媽」未綁定，
  歸屬選「媽媽」匯入 b1.1=A12345**** 的健保檔
- **THEN** 中止並提示該身分證已屬成員「本人」，「媽媽」不被綁定，
  資料庫零寫入

#### Scenario: 缺 profileId 即錯
- **WHEN** 呼叫 adapter 未帶 opts.profileId（或 id 不存在）
- **THEN** 匯入立即失敗（明確錯誤），MUST NOT 回退至第一個成員

#### Scenario: 跨成員重複檔案
- **WHEN** 一份已歸屬成員「本人」的檔案再次匯入且歸屬選「媽媽」
- **THEN** 跳過並顯示「已於（時間）匯入至成員『本人』」，零寫入
<!-- @trace
source: multi-profile-management
updated: 2026-08-10
code:
  - docs/verification/multi_profile_qa_closeout.md
-->

---
### Requirement: 匯入不破壞既有資料

任何一次匯入（成功、冪等跳過、中止、中途失敗）對資料庫既有資料
的變更 MUST 侷限白名單：新增列（本次歸屬成員的資料列與
source_documents 列）、所選成員 masked_id 首次綁定、指紋碰撞時
既有列 quality_flags 追加 fingerprint_collision、本次新建
source_documents 列的 import_stats 收尾寫入。其他成員的既有列
MUST 逐位元組不變；中止或失敗 MUST 使全庫狀態與匯入前全等。
此不變量 MUST 以 before/after 全庫排序 dump diff 的對抗情境
測試矩陣持續驗證（進 CI）。

#### Scenario: 中途失敗全庫全等
- **WHEN** 匯入於任一節區中途拋出例外（含畸形／截斷檔案）
- **THEN** 全庫排序 dump 與匯入前全等（單交易回滾，無半寫狀態）

#### Scenario: 追加匯入不改舊列
- **WHEN** 對已有資料的成員匯入新一批下載檔（含與既有重疊的紀錄）
- **THEN** 既有列除白名單（碰撞 quality_flags 追加）外逐位元組
  不變，重疊紀錄冪等跳過、新紀錄純新增

#### Scenario: 同內容紀錄分屬兩成員不互擾
- **WHEN** 成員 A 已有某筆紀錄，成員 B 匯入內容完全相同的紀錄
- **THEN** 成員 B 正常新增（UNIQUE 鍵含 profile_id，不被跨成員
  去重），成員 A 的列逐位元組不變
<!-- @trace
source: multi-profile-management
updated: 2026-08-10
code:
  - docs/verification/multi_profile_qa_closeout.md
-->

---
### Requirement: 多檔來源的原子性與逐檔韌性

一次多檔匯入 MUST 在**單一交易**內完成：中途失敗時全庫回滾，連來源紀錄
都不留下。逐檔失敗 MUST NOT 使整批中止：單一檔案解析失敗時該檔跳過並
計數，其餘檔案照常入庫，失敗清單 MUST 出現在匯入結果中。

單檔讀入 MUST 有大小上限，且上限 MUST 在**決定是否讀入該檔**的那一層
把關。在解析層檢查沒有意義：該層收到的已經是位元組陣列，記憶體已經耗掉。

**同一批的來源紀錄 MUST 寫入同一個匯入時刻**：呼叫端於交易內取得一個
時間戳並套用於整批，MUST NOT 讓每一筆各自取當下時間。檢視層以
「同 adapter ＋同匯入時刻」判定批次（見 `app-viewer`），逐筆各自取時間
在批次大或機器慢時會跨秒，使同一批被拆成數批，而這不會產生任何錯誤訊息。

時間戳 MUST 由資料庫時鐘產生，MUST NOT 在各語言實作各自的時間格式化：
兩條匯入路徑（App 與命令列）寫入的格式必須一致，且必須與既有資料相同。

單檔來源的匯入路徑 MUST NOT 因此改變語意：一批一檔時，逐筆時間即批次
時間。註冊來源的回傳值中「先前已匯入時刻」的語意 MUST 保持不變（新插入
時為空），呼叫端以它判定重複檔；回傳剛寫入的時間會使新檔被誤判為重複。

#### Scenario: 整批原子
- **WHEN** 多檔匯入因缺少必要參數而失敗
- **THEN** 三張資料表與 source_documents 皆零寫入

#### Scenario: 壞檔不拖垮整批
- **WHEN** 批次中有一個檔案內容損毀無法解析
- **THEN** 其餘檔案正常入庫，該檔在結果中標示為解析失敗並計入錯誤數

#### Scenario: 超過單檔上限
- **WHEN** 批次中某個檔案超過單檔讀入上限
- **THEN** 該檔跳過並在結果中標示，不影響其他檔案

#### Scenario: 整批共用同一匯入時刻
- **WHEN** 一次匯入多個檔案且各檔建立來源紀錄
- **THEN** 該批全部來源紀錄的匯入時刻相同（同一個值，非「相近」）

#### Scenario: 重複檔判定不受影響
- **WHEN** 批次中某檔的 SHA-256 已存在於全庫
- **THEN** 該檔標示為重複並跳過，訊息含其先前的匯入時刻

<!-- @trace
source: viewer-and-history-refinement
updated: 2026-08-14
code:
  - docs/verification/cpap_resmed_adapter.md
  - docs/verification/viewer_history_refinement.md
-->

---
### Requirement: 單遍匯入與重複檔終點判定

Apple zip 來源 MUST 以單次解壓完成匯入：同一遍串流內計算內容 SHA-256、
解析並批次入庫，MUST NOT 為了先取得指紋而額外解壓一遍。

重複判定據此移至交易終點：來源列於交易內先以佔位值 `pending` 寫入
sha256 取得 docId，解析結束算出真值後查全庫，命中 MUST 整筆回滾且訊息
含原歸屬成員名稱與原匯入時刻（語意同既有重複檔訊息）；未命中 MUST 於
COMMIT 前將佔位值更新為真值。佔位值 MUST NOT 被提交。

**容器指紋快篩**：zip 來源 MUST 於解壓前先計算 zip 檔位元組的 SHA-256
並查 `container_sha256`，命中即跳過（訊息同重複檔）；快篩 miss MUST NOT
影響正確性（終點判定兜底）。`container_sha256` MUST 排除於 Python 差分
對帳的比對欄位（App 端快篩專用；Python CLI 不實作快篩）。

非 zip 來源（XML 檔、資料夾）MUST 維持既有流程：先雜湊檔案位元組（即
內容指紋）判重，再解析；其重複判定時機與訊息不變。

#### Scenario: 同一顆 zip 重複匯入被快篩擋下
- **WHEN** 同一個 zip 檔第二次匯入
- **THEN** 不發生解壓與解析，直接回報重複（含原歸屬成員與原匯入時刻），
  資料庫零寫入

#### Scenario: 重新匯出的同內容 zip 於終點回滾
- **WHEN** zip 位元組不同但主 XML 內容相同的檔案匯入
- **THEN** 匯入流程跑完後於終點判定重複，整筆回滾（含來源列），訊息
  含原歸屬成員與原匯入時刻

#### Scenario: 佔位值不外漏
- **WHEN** 任何匯入完成或失敗後查詢 source_documents
- **THEN** 不存在 sha256 為佔位值的列

<!-- @trace
source: import-progress-and-single-pass
updated: 2026-08-19
code:
  - docs/verification/import_single_pass.md
-->

---

### Requirement: 匯入期間的日誌模式窗口

匯入 MUST 在 WAL 日誌模式窗口內執行：開始前切
`journal_mode=WAL`＋`synchronous=NORMAL`，完成或失敗後 MUST
`wal_checkpoint(TRUNCATE)` 並切回 `journal_mode=DELETE`，使 `-wal`／
`-shm` 檔不殘留。切換與 checkpoint MUST 於交易外執行。

日誌模式的切換與查詢語句 MUST 以查詢介面執行：rusqlite 的 `execute`
對回傳列的語句回錯，而 `journal_mode` 與 `wal_checkpoint` 都回傳列
（`synchronous` 賦值不回列）。

App 開啟資料庫時 MUST 自癒：偵測 journal_mode 為 wal（上次匯入中斷
殘留）即 checkpoint 並切回 DELETE。

#### Scenario: 匯入後不殘留 WAL 檔
- **WHEN** 一次匯入完成（成功或失敗皆然）
- **THEN** 資料庫目錄無 `-wal` 與 `-shm` 檔，journal_mode 為 delete

#### Scenario: 中斷殘留的自癒
- **WHEN** 資料庫檔處於 WAL 模式（模擬匯入中斷）且 App 重新開啟
- **THEN** 開啟後 journal_mode 為 delete、`-wal` 檔消失、資料完整

<!-- @trace
source: import-progress-and-single-pass
updated: 2026-08-19
code:
  - docs/verification/import_single_pass.md
-->
