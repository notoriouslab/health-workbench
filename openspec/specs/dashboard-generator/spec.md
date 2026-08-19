# dashboard-generator Specification

## Purpose

單檔自足的 HTML 檢視產出：資料嵌入分層與體積上限、四件套視圖、客戶端
全文搜尋、篩選連動、用藥醫令分類、處方時間軸展開與搜尋結果跳轉，以及
個資與醫療邊界防護。其互動行為同時是 app-viewer 的不退化基準
（change mvp-core-dashboard，2026-08-09）。

## Requirements

### Requirement: 單檔自足與體積上限
`hwb rebuild` SHALL 產出單一 HTML 檔（檔名 dashboard_YYYYMMDD-private.html，
MUST NOT 覆蓋既有檔案），內嵌全部前端代碼（Preact + htm）與資料，
MUST NOT 於執行期發出任何網路請求（外部連結除外，僅使用者點擊才離開）；
檔案 MUST <10MB，超標時 MUST 中止並輸出各資料層體積明細。

#### Scenario: 離線開啟
- **WHEN** 於無網路的 iPad Safari 開啟產出檔
- **THEN** 四件套視圖與搜尋全部可用，無載入錯誤

#### Scenario: 體積守門
- **WHEN** 嵌入資料使總檔 >10MB
- **THEN** 建置失敗並列出醫療類/活動聚合/前端代碼各層體積


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 資料嵌入分層
嵌入資料 SHALL 分層：醫療類（就醫/用藥/檢驗/報告文字/疫苗/身體數值）
全量、活動類僅日聚合序列（已套用防雙計規則）、其餘明細僅存於 SQLite。

#### Scenario: 活動類不嵌明細
- **WHEN** 資料庫含數十萬筆活動原始紀錄
- **THEN** 嵌入資料僅含每日聚合值，dashboard 步數視圖正常顯示


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 四件套視圖

dashboard SHALL 提供六個分頁視圖（名稱沿革：本 requirement 原稱
四件套，2026-08-19 顯示改版後為六分頁，requirement 名稱保留以維持
溯源）：(1) 總覽 tiles（各類筆數、資料期間、最近事件）；(2) 就醫——
依日期列出事件、可依類型/院所篩選、點入顯示該次診斷與用藥明細及
來源檔名，並含疫苗接種區塊；(3) 用藥清單——同健保代碼分組、顯示
處方日期/天數/院所、連結仿單查詢；(4) 檢驗——項目清單與每項趨勢
（檢驗依正規化名分組、顯示參考值）；(5) 測量——身體／循環／活動／
其他四子區塊（身體數值將 Apple 量測與健保成健紀錄同圖呈現）；
(6) 睡眠呼吸（有資料時）。
所有圖表 SHALL 支援深淺色並符合無障礙色彩驗證。

趨勢圖的 x 軸 SHALL 以時間比例定位（同頁共用時間域，上界為該檔的
`generated_at` 與其資料最新日期的較大者），SHALL NOT 依資料點序位
等距排列；各趨勢類分頁 SHALL 提供作用於該頁的時間區間選擇。詳細行為由
`app-viewer` 的「趨勢圖以共用時間域定位」、「趨勢頁時間區間選擇」、
「趨勢圖依區間過濾資料點」、「密集序列的標記降級」與「趨勢圖日期
健全性」五個 requirements 定義，兩處 SHALL 一致；分頁組成與各分頁
內容由 `app-viewer` 的檢驗、測量、睡眠呼吸分頁 requirements 定義，
兩處 SHALL 一致。

#### Scenario: 時間軸點入明細
- **WHEN** 點擊時間軸上任一西醫門診事件
- **THEN** 顯示該次主診斷、醫囑用藥清單與來源（檔名＋節區）

#### Scenario: 成健與自主量測印證
- **WHEN** 開啟測量分頁的體重圖
- **THEN** Apple 連續量測為折線、健保成健單點以獨立標記同圖顯示且圖例區分

#### Scenario: rebuild 產出與 App 一致
- **WHEN** 以 `hwb rebuild` 產出單檔並以瀏覽器開啟各分頁
- **THEN** 六分頁組成、時間軸定位、區間選擇與標記降級行為與 App 內
  完全一致


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
  - docs/verification/trend_time_axis_closeout.md
  - docs/verification/display_revamp.md
-->

---
### Requirement: 客戶端全文搜尋
dashboard SHALL 提供跨類別即時搜尋（院所、診斷、藥名、檢驗名、
報告文字），結果依類別分組並可點入對應視圖。搜尋 MUST 於客戶端
執行，不依賴任何服務。

#### Scenario: 搜尋藥名
- **WHEN** 輸入資料中實際存在的藥品名稱關鍵字
- **THEN** 結果列出含該藥的用藥紀錄與對應就醫事件


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 個資與醫療邊界防護
所有嵌入之資料字串 MUST 經 HTML 跳脫（含 `<`、`>`、`&`、引號）；
頁首 SHALL 顯著顯示醫療邊界聲明（僅供資料整理、非診斷依據）與
「本檔含個人醫療資料，請勿外傳」提示；介面用語 MUST 通過禁用詞檢查
（不得出現診斷/預測/建議停藥等結論式詞彙）。

#### Scenario: 資料含 HTML 特殊字元
- **WHEN** 影像報告文字含 "<1cm" 字樣
- **THEN** 頁面正確顯示 <1cm 且版面不破壞

#### Scenario: 禁用詞把關
- **WHEN** 建置時介面文案含「正常」一詞用於數值判定
- **THEN** 建置失敗並指出違規字串位置


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 篩選連動
就醫時間軸的院所選單 SHALL 只列出當前所選類型下實際存在的院所；
切換類型時 MUST 重置院所選擇，MUST NOT 殘留不屬於該類型的院所條件。

#### Scenario: 選類型後院所縮減
- **WHEN** 類型選「中醫門診」
- **THEN** 院所選單僅含有中醫就醫紀錄的院所，先前選定的西醫院所被重置


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 用藥醫令分類
用藥視圖 SHALL 將醫令分為三類分頁：藥品（健保品項檔命中）、
中醫用藥（中醫節區醫令）、診療項目與其他；MUST NOT 將診療處置
與藥品混列於同一清單。

#### Scenario: 診察費不混入藥品
- **WHEN** 開啟用藥視圖的「藥品」分類
- **THEN** 清單僅含品項檔命中之藥品，6 碼診療項目代碼出現在「診療項目與其他」


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 處方時間軸展開
每個用藥分組 SHALL 可展開，展開內容含：處方時間軸（以全資料期間為
x 軸，每次處方一根長條、高度對應給藥日數）、成分與仿單連結（如有）、
逐次處方明細表；明細列 SHALL 可點選跳轉至該次就醫紀錄。

#### Scenario: 展開看處方史
- **WHEN** 點擊任一藥品分組
- **THEN** 顯示該藥全期間的處方時間軸與逐次明細

#### Scenario: 明細跳轉看診
- **WHEN** 點擊展開明細中的任一列
- **THEN** 切換至就醫時間軸、該次看診展開並捲動至可視位置


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 搜尋結果跳轉
搜尋結果中的就醫、用藥、檢驗項目 SHALL 可點選：就醫跳至時間軸並
展開該筆、用藥跳至用藥視圖並展開該分組、檢驗跳至趨勢視圖並選中
該項目；跳轉後目標 MUST 捲動至可視位置。

#### Scenario: 搜尋藥名跳轉
- **WHEN** 搜尋結果中點擊某藥品
- **THEN** 進入用藥視圖、該分組已展開且位於視窗頂部附近


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 匯入紀錄顯示
總覽 SHALL 顯示匯入紀錄表：每次匯入的時間、檔案名稱、來源 adapter
與新增內容統計；統計缺失（早期匯入）時 SHALL 明確標示而非留空。

#### Scenario: 匯入歷史
- **WHEN** 完成一次健保檔匯入後開啟總覽
- **THEN** 匯入紀錄表新增一列，含時間、檔名與各類新增筆數

<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->
