# app-viewer Specification

## Purpose

App 內的即時檢視層：DataProvider 契約、四分頁即時檢視、成員切換與依人
檢視、匯出（單檔 HTML 與 EPUB），以及趨勢圖的共用時間域定位、區間選擇、標記降級與
日期健全性。要求 dashboard-generator 的既有互動行為在 App 內全數不退化
（change tauri-desktop-app，2026-08-10）。

## Requirements

### Requirement: DataProvider 契約

檢視層 MUST 透過 DataProvider 介面取得資料，provider MUST 接受
成員 id（必填）並僅回傳該成員的資料（meta.profile ＝該成員顯示
名稱；counts 的 profiles 一欄維持全庫成員數）；回傳結構 MUST 與
既有單檔 dashboard 嵌入 JSON 同構並以 JSON Schema（shape.json）
鎖定；App 實作以 SQL 查詢組裝，聚合規則（活動類月聚合、每日單一
來源最大步數等）沿用 `dashboard-generator` spec 的既有 requirements。

**payload 新增 CPAP 區塊**，且 shape.json MUST 一併涵蓋它（契約若不跟上
實作，日後移除該區塊不會被任何檢查抓到）。CPAP 區塊 MUST 包含每日摘要、
每日各類事件計數、逐筆事件、事件總數與截斷旗標、每晚血氧彙總。

**逐分鐘血氧 MUST NOT 進 payload**：payload 會嵌入單檔 HTML，數年的
逐分鐘資料會是數十萬列。改帶每晚彙總（整晚最低與平均），趨勢呈現需要
的正是這個粒度。

**逐筆事件 MUST 有數量上限**，超過時只帶最近的並在 payload 標明已截斷；
檢視層 MUST 據此顯示「僅列最近 N 筆」，MUST NOT 靜默截斷。

跨語言一致性：新增的彙總 MUST 以 SQL 計算而非在兩種語言各自實作四捨五入
（既有 payload 已有為了模擬另一語言捨入行為而存在的補丁，不應再增加）。

**量測序列的鍵集合與形狀**（2026-08-19 帶狀改版）：

- `measures` MUST 為逐筆保留型別的每日中位數序列 `[[day, value]]`，
  鍵集合為常數 `MEDIAN_TYPES`，其值 MUST 與逐筆保留清單
  （PER_ROW_TYPES）**全等**（9 個型別：體重、BMI、體脂率、除脂體重、
  身高、收縮壓、舒張壓、安靜心率、行走穩定度）；心率、血氧
  MUST NOT 再出現於 `measures`。
- 新頂層鍵 `measure_bands` MUST 為 `{型別: [[day, avg, min, max]]}`，
  鍵集合為常數 `BAND_TYPES` ＝心率、血氧、呼吸速率；資料讀
  apple_daily，同日多來源 MUST 合併為單點（avg ＝ SUM(sum_v)/SUM(n)，
  與全體 raw 直算精確全等；min/max 取跨來源極值；avg 捨入 MUST 以
  SQL ROUND 取 2 位——血氧值域 0-1，取 1 位會砍光解析度），每日
  MUST NOT 輸出多於一點；MUST 排除帶
  epoch_placeholder_date 旗標的列；`partial_reimport_skipped` 的列
  MUST 照常帶出（其數值仍是既有最完整值）。
- 新頂層鍵 `sleep_daily` MUST 為 `[[day, {識別字: 分鐘}]]`（apple_daily
  睡眠列的 extra_json 解析原樣帶出，識別字 MUST NOT 在 provider 層
  轉譯或過濾）。同日多來源時 MUST 取分鐘合計最大的單一來源列
  （語意同活動類防雙計），MUST NOT 跨來源相加；合計同分時以
  source_name 排序取首（決定性，兩端 SQL 逐字同形）。
- `MEDIAN_TYPES` 與 `BAND_TYPES` 在兩端各一份、值 MUST 相同，且
  MEDIAN_TYPES MUST 與逐筆保留清單（PER_ROW_TYPES）全等、
  BAND_TYPES MUST 為彙總清單（AGGREGATE_TYPES）的子集，以測試釘住
  （帶狀型別若誤入逐筆組，清理後圖會破且無錯誤訊息）。
- shape.json MUST 一併涵蓋 `measure_bands` 與 `sleep_daily`。

#### Scenario: 契約驗證
- **WHEN** 對同一單成員資料庫分別執行 App provider（帶該成員 id）
  與 Python embed 產出
- **THEN** 兩者皆通過 shape.json 驗證，且數值內容全等（鍵順序除外）

#### Scenario: 成員隔離 marker 掃描
- **WHEN** 兩成員 fixture 庫中成員 B 的全部紀錄含唯一 marker
  字串，對成員 A 執行 provider
- **THEN** 成員 A 的 payload 序列化結果零出現該 marker（任一查詢
  漏加 profile 過濾即失敗）

#### Scenario: 沒有 CPAP 資料時的契約
- **WHEN** 資料庫沒有任何 CPAP 資料
- **THEN** payload 仍含 CPAP 區塊（各項為空），MUST NOT 缺鍵

#### Scenario: 帶狀數值獨立驗證
- **WHEN** 以含多筆／日心率的 fixture 匯入後產出 payload
- **THEN** `measure_bands` 的心率各日 avg/min/max 與對 raw 直算的
  結果全等（不信任彙總表寫入方的既有測試）

#### Scenario: 無帶狀資料時的契約
- **WHEN** 資料庫沒有任何心率、血氧、呼吸速率、睡眠紀錄
- **THEN** payload 仍含 `measure_bands`（各型別空序列）與 `sleep_daily`
  （空），MUST NOT 缺鍵


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/multi_profile_qa_closeout.md
  - docs/verification/cpap_viewer.md
  - docs/verification/display_revamp.md
-->

---
### Requirement: 即時檢視

開啟 App MUST 直接顯示資料庫最新資料（四分頁＋搜尋，元件沿用既有
app.js），匯入完成後 MUST 自動刷新，毋須重啟或手動重新整理。

#### Scenario: 開啟即見最新
- **WHEN** 使用者完成一次匯入後關閉並重新開啟 App
- **THEN** 總覽 tiles 與各分頁直接反映最新資料

#### Scenario: 匯入後自動刷新
- **WHEN** 檢視頁開啟狀態下完成一次匯入
- **THEN** 目前分頁資料自動更新，搜尋索引含新資料


<!-- @trace
source: tauri-desktop-app
updated: 2026-08-10
code:
  - docs/verification/app_qa_closeout.md
-->

---
### Requirement: 既有互動行為不退化

六分頁（總覽／就醫／用藥／檢驗／測量／睡眠呼吸）、全文搜尋、篩選連動、
用藥三分類、處方時間軸展開、藥↔看診雙向跳轉與捲動定位、匯入紀錄卡等
`dashboard-generator` spec 既有 requirements 在 App 內 MUST 全數成立。
2026-08-19 分頁改版後：原趨勢分頁的內容由檢驗與測量兩分頁承接，
搬移 MUST NOT 改變各圖的資料語意——總覽頁的體重趨勢卡（維持既有
「最後 365 筆」語意不變）、體重成健同圖、檢驗趨勢的項目下拉（移至
檢驗分頁）、最新檢驗表點入跳轉（改指向檢驗分頁）、步數圖在近一年與
全部區間維持月平均（近三月改逐日，移至測量分頁）MUST 維持既有行為。

#### Scenario: 走查清單
- **WHEN** 依 dashboard-generator spec 的 scenario 清單逐項走查 App
- **THEN** 全數通過，無互動退化

#### Scenario: 總覽體重卡不受影響
- **WHEN** 測量分頁區間切為「近三月」
- **THEN** 總覽頁的體重趨勢卡顯示內容不變（其資料範圍與趨勢類分頁的
  區間選擇無關）

#### Scenario: 舊分頁 id 清除
- **WHEN** 對檢視程式全文搜尋跳轉目標 `"trends"`
- **THEN** 零出現（總覽與搜尋的檢驗跳轉皆已指向檢驗分頁）


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/app_qa_closeout.md
  - docs/verification/trend_time_axis_closeout.md
  - docs/verification/display_revamp.md
-->

---
### Requirement: 單檔 HTML 匯出（選用功能）

（既有內容不變）匯出的單檔 HTML MUST 自包含、可離線開啟，且與 App 內
檢視共用同一份檢視程式與 payload。

**匯出 MUST 涵蓋 CPAP 區塊**：嵌入資料含 CPAP 內容、檢視程式含睡眠呼吸
分頁。沒有 CPAP 資料時匯出仍 MUST 為合法產物。

#### Scenario: 匯出涵蓋新區塊
- **WHEN** 對含 CPAP 資料的成員匯出單檔 HTML
- **THEN** 嵌入資料含每日摘要與事件，檢視程式含睡眠呼吸分頁，且不超過
  既有體積門檻

<!-- @trace
source: cpap-sleep-therapy
updated: 2026-08-13
code:
  - docs/verification/multi_profile_qa_closeout.md
  - docs/verification/trend_time_axis_closeout.md
  - docs/verification/cpap_closeout.md
-->

---
### Requirement: EPUB 匯出

App MUST 提供 EPUB 3 匯出，與單檔 HTML 匯出並存。兩條路徑 MUST 共用同一份
payload 與同一份檢視程式，差別僅在外層骨架（HTML5 對 XHTML）。

**產物結構**（違反其一，閱讀器會拒絕開啟或合法地不執行 JS）：
- `mimetype` MUST 是 zip 的第一個項目且不壓縮
- 內容文件在 manifest MUST 標 `properties="scripted"`，用到 SVG 時併標 `svg`
- 內容文件 MUST 是合法 XML

**內嵌資產**：檢視程式與樣式以 CDATA 承載。資產含 `]]>` 序列時 MUST 拒絕
產出（該序列會提前終止 CDATA，使內容文件變成非法 XML）。

**寫檔路徑**：EPUB 是二進位 zip，MUST 走 `fs.writeFile`；對應的權限
identifier MUST 在 capabilities 明列（`fs:default` 不含任何寫入權限），
且允許路徑 MUST NOT 放寬為 `**`，實際匯出位置由儲存對話框動態授權。

**匯出前確認**：匯出 MUST 先顯示頁內提醒（把檔案加進 Apple Books 後，
Books 的 iCloud 同步會讓它在 iCloud 有備份），使用者確認後才寫檔。
提醒 MUST 用頁內元素，MUST NOT 用原生 `confirm`（會凍住 WebView 事件）。

**可重現**：同一份 payload 與資產 MUST 產生相同位元組（時間戳固定，不取
執行當下時間），否則無法用雜湊確認內容未變。

**沿用單檔 HTML 的既有護欄**：payload 形狀契約（shape.json）、介面文案的
禁用詞檢查、10MB 體積上限三者一體適用。EPUB 走 deflate 後遠小於同資料的
HTML，上限實務上不會觸發，但兩條路徑的判準 MUST 相同，避免其中一條在體積
上無聲失守。

**書櫃識別**：`dc:title` MUST 是「{成員}的個人健康資料（{資料日期}）」，
`dc:creator` MUST 是「HealthWorkbench：個人健康資料工作台」。這不是裝飾：
Apple Books 用 `dc:title` 命名書櫃項目與其在 iCloud 容器裡的檔名，改動後
使用者找不到自己的書，而且沒有任何其他地方會轉紅。

**閱讀器限制**：互動依賴閱讀器支援 EPUB 3 的 scripted content，而多數
閱讀器不支援（支援 EPUB 3 不等於支援 scripted content）。實測可用：Apple
Books（macOS 與 iOS）、Thorium Reader、Android 的 Reasily；Google Play
Books 實測不執行。內容文件 MUST 帶一段在 JS 未執行時就看得到的說明，指出
原因與可用的替代路徑，MUST NOT 只留一個空白或永遠停在「載入中」的畫面。
對外文件 MUST NOT 把 EPUB 描述成任何閱讀器都能得到完整互動，且列為「實測
可用」的閱讀器 MUST 真的被實測過。

**範圍**：EPUB 只做 App 端。Python `src/dashboard/generate.py` 不提供 EPUB
輸出，是裁定的範圍而非未完成項（沿用 Python CLI 作為 oracle 與開發者路徑
的既有定位）。

#### Scenario: 產物能被第三方解析器開啟
- **WHEN** 對有資料的成員匯出 EPUB
- **THEN** 產物通過獨立於本專案 zip 實作的解析器檢查：CRC 全數正確、
  mimetype 為第一項且未壓縮、四份 XML 文件皆為合法 XML、內容文件宣告
  `scripted`

#### Scenario: 壓縮能力不可用時仍為合法產物
- **WHEN** 執行環境沒有 `CompressionStream`
- **THEN** 全部項目退回不壓縮，產物仍為合法 EPUB（體積變大但可開啟）

#### Scenario: 資產含 CDATA 終止序列
- **WHEN** 檢視程式或樣式含 `]]>`
- **THEN** 匯出 MUST 拋錯而非產出無法開啟的檔案

#### Scenario: 閱讀器不執行網頁程式
- **WHEN** 使用者用不執行 JS 的閱讀器開啟匯出的 EPUB
- **THEN** 看到的是說明文字（原因＋改用哪個閱讀器＋電腦上可改看 HTML），
  不是空白畫面

#### Scenario: 匯出前的同步提醒
- **WHEN** 使用者點選匯出 EPUB
- **THEN** 先出現頁內提醒說明 iCloud 備份行為與關閉位置，取消則不產生
  任何檔案，確認後才進入儲存對話框

<!-- @trace
source: epub-export
updated: 2026-08-17
code:
  - app/src/provider/epub.js
  - app/src/provider/zip.js
  - app/tests/provider/epub.test.mjs
  - app/src-tauri/capabilities/default.json
-->

---
### Requirement: 成員切換與依人檢視

App MUST 提供全域成員切換器（含「管理成員…」入口）；檢視頁
（四分頁＋搜尋）與總覽狀態列 MUST 僅顯示當前成員的資料，切換
成員 MUST 即時刷新、毋須重啟。匯入紀錄卡屬資料庫管理視角，
MUST 依成員分組列出全部來源檔案（不隨切換器過濾），資料庫位置
等全庫資訊維持原樣；每筆來源檔案列 MUST 提供「刪除」與
「改歸屬」操作入口（行為由 profile-management 的匯入紀錄刪除、
改歸屬與健保身分綁定守恆 requirements 定義），操作完成後匯入
紀錄卡 MUST 即時刷新，若影響當前檢視成員，檢視頁與狀態列 MUST
同步刷新。

#### Scenario: 切換即刷新
- **WHEN** 資料庫含兩位成員資料，使用者由「本人」切換至「媽媽」
- **THEN** 四分頁、搜尋與狀態列筆數即時改為「媽媽」的資料，
  不含「本人」任何紀錄；匯入紀錄卡仍列出兩位成員的來源檔案
  （各自分組）

#### Scenario: 匯入他人不動當前檢視
- **WHEN** 檢視「本人」時完成一筆歸屬「媽媽」的匯入
- **THEN** 檢視頁維持「本人」資料不變，切至「媽媽」即見新匯入
  內容

#### Scenario: 救援操作後即時刷新
- **WHEN** 檢視「媽媽」時，使用者將「媽媽」名下一筆來源檔案
  改歸屬至「爸爸」
- **THEN** 匯入紀錄卡該筆移入「爸爸」分組，檢視頁與狀態列筆數
  即時扣除該批資料，毋須重啟或手動重整

<!-- @trace
source: misattribution-rescue
updated: 2026-08-12
code:
  - docs/verification/misattribution_rescue_qa_closeout.md
-->

---
### Requirement: 趨勢圖以共用時間域定位

**本 requirement 適用於趨勢類分頁（檢驗、測量、睡眠呼吸）的圖表；
時間域與區間選擇的作用域為單一分頁。** 總覽頁的體重趨勢卡沒有區間
控制項，其時間域 MUST 為該卡資料自身的首末日期。

同一趨勢類分頁的全部圖表 MUST 共用一組時間域 `[tMin, tMax]`，該時間域
MUST 由當前顯示區間的日曆邊界決定，MUST NOT 由個別序列自身的資料
範圍決定：近三月為 `[today - 90 日, today]`、近一年為
`[today - 365 日, today]`、全部為 `[該頁趨勢序列集合中的最早日期, today]`。

`today` MUST 為 `max(meta.generated_at, 該頁趨勢序列集合中的最新日期)`，
MUST NOT 取執行當下的系統時間（匯出的單檔 HTML 是「資料截至某日」的
快照，其區間與預設值 MUST NOT 隨開啟時間改變）。取 max 的理由：
`generated_at` 在 App 端與 Python 端的產生方式不同（一為 UTC 日期、
一為本地日期），且資料最新一筆可能晚於 `generated_at`；若上界不含
最新資料，該筆量測會被靜默隱藏。任何資料點 MUST NOT 因落在時間域
之外而被無聲剔除。

**趨勢序列集合**（`tMin`、`today` 與預設區間判定皆以此為準）MUST 為
該分頁繪製的**全部**序列：檢驗分頁 MUST 含全部可繪圖的檢驗項目（即有
數值結果者；純文字結果不繪圖故不影響時間域），MUST NOT 只計入下拉
當前選中的項目（否則切換檢驗項目會位移同頁其他圖表的 x 軸）；測量
分頁含四個子區塊的全部序列（帶狀序列以其日期參與）；睡眠呼吸分頁含
CPAP 各序列與 Apple 睡眠、呼吸速率、血氧序列。

資料點 x 座標 MUST 為 `(t - tMin) / (tMax - tMin)` 的線性映射，
使時間間隔與圖上水平距離成正比。x 軸刻度 MUST 依時間挑選（跨度
超過 2 年按年、超過 3 月按月、否則按週），MUST NOT 依資料點序位
挑選。刻度數 MUST 有上限，超過時 MUST 逐級降粒度直到不超過上限。粒度階梯
MUST 單調由細到粗（週→每 2 週→月→每季→每半年→年→每 2／5／10／20／
50 年），MUST NOT 在粗粒度用盡後回到更細的粒度；階梯全部用盡時
MUST 至少回傳首末兩個刻度，MUST NOT 回傳空刻度（跨度極大時 x 軸
整條標籤消失且不會報錯，屬無聲失敗）。年粒度且間隔大於 1 年時，
刻度 MUST 對齊該間隔的倍數年。刻度標籤格式 MUST 隨粒度
決定（年為 `YYYY`，季與月為 `YY-MM`，週與日為 `MM-DD`），
MUST NOT 讓同一個月內的多個刻度標成相同文字。

各序列的名稱與最新值 MUST 標示於繪圖區右側的固定位置（圖例式、
垂直排列不重疊），MUST NOT 緊貼折線末端（末端標籤在時間軸下會被
右邊界截斷，或落在圖中央壓住其他資料）。圖例可用寬度僅約 100px，
故名稱與數值 MUST 分行，名稱過長 MUST 截斷；格線右緣 MUST 收至
繪圖區右緣以免壓在圖例上。

區間跨度為零時 MUST 正常渲染而不除以零（資料點置於繪圖區左緣）。

#### Scenario: 停止記錄的序列不再看似最新
- **WHEN** 某序列最後一筆距 `today` 超過一年，顯示區間為「全部」
- **THEN** 該序列末點依其日期定位、明顯不在繪圖區右緣，右側空窗
  如實留白，使用者看得出資料已停止

#### Scenario: 不規則間隔的斜率正確
- **WHEN** 某檢驗項目僅 3 筆、分別相隔數月與一年以上
- **THEN** 各段折線的水平距離比例與實際天數比例相符，MUST NOT 鋪滿
  整個圖寬而看似連續趨勢

#### Scenario: 刻度不重疊
- **WHEN** 序列僅分佈於時間域左側三分之二（其後停止記錄）
- **THEN** x 軸刻度依時間分佈於整個時間域，相鄰刻度水平間距不小於
  文字寬度所需（實作以 40px 為驗收門檻）

#### Scenario: 極大跨度仍有刻度
- **WHEN** 時間域跨度超過 40 年（例如一筆年份被誤解析的老舊日期）
- **THEN** x 軸仍有至少兩個刻度，MUST NOT 變成沒有任何標籤

#### Scenario: 匯出檔的時間基準固定
- **WHEN** 同一份匯出的單檔 HTML 於產出後數個月再開啟
- **THEN** 時間域、預設區間與各點位置與產出當時完全相同

#### Scenario: 退化輸入
- **WHEN** 序列只有一個資料點，或全部點日期相同，或區間跨度為零
- **THEN** 圖表正常渲染（無 NaN 座標、無空白圖），資料點可見

#### Scenario: 切換檢驗項目不位移他圖
- **WHEN** 於檢驗分頁切換下拉選中的檢驗項目
- **THEN** 該頁時間域不變（集合含全部項目），其他趨勢類分頁不受影響


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/trend_time_axis_closeout.md
  - docs/verification/display_revamp.md
-->

---
### Requirement: 趨勢頁時間區間選擇

各趨勢類分頁（檢驗、測量、睡眠呼吸）MUST 各自提供一組作用於**該頁**
全部圖表的時間區間選擇（近三月、近一年、全部）；單張圖表 MUST NOT
各自帶獨立的區間控制項，以維持「同頁各圖恆為同一區間」的同期對照
語意。切換區間 MUST 即時重繪、毋須重新載入。跨分頁的區間各自獨立，
MUST NOT 互相連動（同期對照不變式的作用域是單一分頁）。

預設區間 MUST 依資料新舊自動決定：當前成員**該頁**趨勢序列集合中最新
的一筆（各序列末筆取最大值）在 `today` 前 90 日內者預設為近一年，
否則預設為全部。

某圖在當前區間內無任何資料時，該圖 MUST 顯示無資料訊息並提供
「看全部」入口；使用該入口 MUST 將**整頁**區間切為全部，
MUST NOT 只切換單張圖表（否則破壞同期對照不變式）。

#### Scenario: 同期對照
- **WHEN** 使用者於測量分頁選「近一年」
- **THEN** 該頁全部圖表同步改為近一年，各圖 x 軸起訖一致

#### Scenario: 整體陳舊資料的預設區間
- **WHEN** 成員該頁趨勢序列的最新一筆距 `today` 超過 90 日
- **THEN** 預設區間為「全部」，圖表有內容可看

#### Scenario: 單一序列在區間內無資料
- **WHEN** 預設為近一年，但某序列最後一筆早於一年前
- **THEN** 該序列的圖顯示無資料訊息與「看全部」入口，其他圖照常顯示
  近一年；點擊該入口後整頁切為「全部」，該圖出現內容


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/trend_time_axis_closeout.md
  - docs/verification/display_revamp.md
-->

---
### Requirement: 趨勢圖依區間過濾資料點

各圖 MUST 只以落在當前時間域內（含邊界）的資料點繪製；y 軸上下界
MUST 只由這些點（與參考值區間）決定，否則切換區間後縱軸不縮放。
MUST NOT 保留區間外的相鄰點來延續折線（手寫 SVG 無裁切區域，跨界
點會畫出繪圖區）；此為明示選擇。

月粒度序列（如步數的月平均）MUST 以「該月與區間有交集」判定是否
納入，MUST NOT 以桶代表日期是否落在區間內判定，否則區間下界所在
月份的整桶會被丟棄，連帶失去該月落在區間內的資料。此類桶的代表日期
（該月一日）可能早於時間域下界，其 x 座標 MUST 夾在繪圖區內；
MUST NOT 讓資料點畫到繪圖區之外（極端情況會畫出 viewBox 而完全
不可見，並使折線自畫布外進入）。

步數圖的資料粒度 MUST 隨區間變化：近三月用逐日序列，近一年與全部
用月平均，圖說 MUST 標明當前粒度。理由：月粒度在近三月只剩約 3 點。

#### Scenario: 切區間後縱軸跟著縮放
- **WHEN** 由「全部」切到「近三月」
- **THEN** 各圖 y 軸上下界依近三月內的資料重算，非沿用全期範圍

#### Scenario: 下界所在月份的月桶不被丟棄且不出界
- **WHEN** 近一年區間下界為某月中旬，步數該月的月桶代表日期為該月 1 日
- **THEN** 該桶仍納入繪製，且其 x 座標不小於繪圖區左緣

#### Scenario: 步數粒度隨區間
- **WHEN** 切至「近三月」
- **THEN** 步數圖改以逐日序列繪製，圖說標明為逐日


<!-- @trace
source: trend-time-axis
updated: 2026-08-12
code:
  - docs/verification/trend_time_axis_closeout.md
-->

---
### Requirement: 密集序列的標記降級

折線圖 MUST 依序列在當前區間內的點數決定標記呈現：點數不超過
繪圖區可容納 r=3 標記的數量時以 r=3 繪製；超過但仍可容納 r=1.5
標記時以 r=1.5 繪製；再超過時 MUST NOT 繪製標記，僅繪製折線。
門檻 MUST 由標記直徑與繪圖區寬度**在程式中推導**（MUST NOT 硬編碼
數字，否則改動圖表尺寸時門檻不會跟著走），且 MUST 為單一套門檻
（MUST NOT 與其他半徑降級規則並存）。

**沒有區間控制項的圖表（總覽頁的體重趨勢卡）MUST NOT 套用「不繪標記」
那一段門檻**：該處沒有切換區間的手段，可讀性緩解在那裡不存在，使用者
無法把逐點數值提示要回來。其標記半徑仍依點數在 3 與 1.5 之間降級。

序列若顯式指定標記尺寸（如健保成健的獨立標記），MUST 沿用該指定值
而不套用上述門檻，以維持 `dashboard-generator` 對成健單點「以獨立
標記同圖顯示且圖例區分」的既有要求。

三項已知限制 MUST 記載於本 requirement，不得省略：
1. 本 requirement 不含時間桶聚合，折線頂點數不因此減少（效能面）；
   聚合延後至單日多次量測或逐分鐘序列進入資料庫後再評估。
2. **密集序列在「全部」區間下的可讀性由區間選擇承接，不由本
   requirement 解決**：不繪標記只降低節點數，密集序列仍為一條雜訊
   帶，使用者需切換至較短區間才看得清楚。
3. 不繪標記的序列同時失去掛在標記上的逐點數值提示；且門檻以區間內
   點數推導，隱含點在時間上大致均勻，時間集中的序列仍可能重疊。

#### Scenario: 密集序列只畫線
- **WHEN** 某序列在當前區間內的點數超過「不繪標記」門檻
- **THEN** 該序列僅繪製折線、不繪製標記，趨勢形狀維持可讀

#### Scenario: 無區間控制項的圖保留標記
- **WHEN** 總覽頁體重趨勢卡的資料點超過「不繪標記」門檻
- **THEN** 仍繪製標記與逐點數值提示（半徑可降至 1.5）

#### Scenario: 混合序列各自降級
- **WHEN** 體重圖同時含 Apple 每日量測（點數超過門檻）與健保成健（點數遠低於門檻）
- **THEN** Apple 序列僅繪製折線，成健序列繪製獨立標記，兩者以圖例
  區分（符合 dashboard-generator 對此圖的既有要求）

#### Scenario: 稀疏序列保留標記
- **WHEN** 某序列在當前區間內僅 32 點
- **THEN** 逐點繪製標記


<!-- @trace
source: trend-time-axis
updated: 2026-08-12
code:
  - docs/verification/trend_time_axis_closeout.md
-->

---
### Requirement: 趨勢圖日期健全性

繪製前 MUST 剔除日期為 null 或無法解析的資料點，並於圖說標示剔除
筆數；MUST NOT 讓此類點參與時間域計算（`new Date(null)` 為 1970,
單一筆即可把時間域下界拉到 1970 並使整張圖失去意義，且不會拋錯，
屬無聲失敗）。`"YYYY-MM"` 形式的日期 MUST 視為該月第一日。

#### Scenario: null 日期不污染時間域
- **WHEN** 某檢驗序列含一筆 `test_date` 為 null 的紀錄
- **THEN** 該點被剔除、圖說標示剔除 1 筆，時間域下界為其餘資料的
  最早日期而非 1970

#### Scenario: 月粒度日期
- **WHEN** 序列日期為 `"2026-08"` 形式
- **THEN** 該點定位於 2026-08-01

<!-- @trace
source: trend-time-axis
updated: 2026-08-12
code:
  - docs/verification/trend_time_axis_closeout.md
-->

---
### Requirement: 睡眠呼吸分頁

有 CPAP 資料**或 Apple 睡眠彙總資料**時 MUST 提供獨立分頁；兩者皆無時
MUST NOT 顯示本分頁。CPAP 內容為：每晚 AHI（可切換顯示阻塞、
中樞、低通氣分項）、使用時數、漏氣、送氣壓力、睡眠期血氧、**每晚事件數**
與逐筆事件明細。區間選擇 MUST 沿用趨勢類分頁既有的共用時間域機制，
MUST NOT 自造一套。

**Apple 睡眠與呼吸內容**（2026-08-19 新增，各區塊無資料不渲染）：

- **睡眠時數**：每日總睡眠時數折線（`sleep_daily` 中識別字去除
  `HKCategoryValueSleepAnalysis` 前綴後以 `Asleep` 開頭者的分鐘數
  合計，換算小時；實測識別字為完整字串）；有多種睡眠識別字時 MUST 提供分項
  切換（沿 AHI 分項模式），識別字 MUST 以對照表轉中文（InBed=躺床、
  AsleepUnspecified=睡眠（未分類）、AsleepCore=核心、AsleepDeep=深層、
  AsleepREM=快速動眼、Awake=清醒），**未知識別字 MUST 顯示原名**，
  MUST NOT 丟棄；未知識別字 MUST NOT 計入總睡眠時數（語意不明，寧可
  少算並如實列出分項）。
- **CPAP 使用對照**：CPAP 使用時數與 Apple 睡眠時數兩條線同圖（同單位
  小時），並以文字顯示合計比值「使用時數佔睡眠時數比例 ≈ N%」。
  合計範圍 MUST 為「當前區間 ∩ 兩來源皆有資料的日期範圍
  （[max(兩來源各自最早日), min(兩來源各自最晚日)]）」，兩端取同一
  範圍後各自加總再相除。比值旁 MUST 標示重疊晚數；重疊日期範圍為空
  時 MUST NOT 顯示比值文字（兩條線照畫）。比值 MUST 由程式實算並隨
  區間切換重算，
  MUST NOT 逐晚相除（兩來源的「一晚」定義不同：CPAP 為正午分界的
  紀錄夜、Apple 為入睡起始的日曆日，凌晨入睡的夜兩邊差一天，逐晚相除
  會產生系統性錯位）。比值超過 100% 時 MUST 如實顯示，說明文字 MUST
  註明兩來源一晚定義不同、且 Apple 睡眠依賴裝置配戴而可能不完整。
  本區塊的標題與說明 MUST NOT 使用「治療覆蓋率」「治療依從」等
  判定性組合詞（禁用詞守衛以精確詞入清單，MUST NOT 加寬為單字
  「治療」——同資產的免責聲明合法含有該字）。
- **呼吸速率**：每日帶狀（沿「量測帶狀圖」requirement）。
- **血氧低點**：apple_daily 血氧 min 折線。MUST 與 CPAP 睡眠期血氧
  分開成圖（兩者來源、量測情境不同，疊圖會誤導為同一量測）。

**單位或數量級不同的序列 MUST NOT 疊在同一張圖**：圖表只有單一 y 軸，
上下界由全部序列共同決定，數量級小的序列會被壓成貼底的平線。需要對照時
MUST 改用上下堆疊、共用同一時間域的多張圖。

日期語意 MUST 於圖表旁明示：CPAP 各圖為「入睡當晚」，Apple 睡眠各圖為
「入睡起始的日曆日」。

**每晚事件數 MUST 以每晚各類型的事件計數呈現**，且該序列 MUST NOT 受
逐筆保留範圍影響：它是聚合視角，庫內有事件的每一晚都要畫得出來，資料
累積多年也不會被截斷。

**逐筆事件明細 MUST 分層定位而非平鋪**：以「年 → 晚 → 逐筆」分層，
任一時刻只展開一層路徑，且**未展開的層 MUST NOT 渲染其內容**。平鋪或
「摺疊但仍全部渲染」都會使頁面節點數隨資料量線性增長（逐筆的上限情境
為數千列，每晚一行標頭則隨年數增長）。

#### Scenario: 分項切換
- **WHEN** 使用者切換顯示分項
- **THEN** 阻塞、中樞、低通氣三條序列疊加於 AHI 圖上（同為次數／小時，
  數量級一致）

#### Scenario: 漏氣與壓力分開呈現
- **WHEN** 檢視漏氣與送氣壓力
- **THEN** 兩者為各自獨立、共用同一時間區間的圖表

#### Scenario: 逐筆事件預設不渲染任何明細
- **WHEN** 進入睡眠呼吸分頁而未展開任何年份
- **THEN** 畫面只有年份層（各標明該年的晚數與筆數），沒有每晚標頭也沒有
  任何逐筆列

#### Scenario: 逐層展開
- **WHEN** 展開某一年，再展開該年某一晚
- **THEN** 展開年份時列出該年每一晚但仍無逐筆列；展開某晚後才出現該晚的
  逐筆明細（時刻、類型、持續）

#### Scenario: 只有 Apple 睡眠沒有 CPAP
- **WHEN** 資料庫有 Apple 睡眠彙總但無任何 CPAP 資料
- **THEN** 睡眠呼吸分頁存在，顯示睡眠時數（與呼吸速率、血氧低點，如有
  資料），CPAP 各圖與使用對照皆不渲染

#### Scenario: 使用對照的比值
- **WHEN** 同時有 CPAP 使用時數與 Apple 睡眠時數，區間為近一年
- **THEN** 同圖顯示兩條線，文字顯示該區間重疊日期範圍的合計比值與
  重疊晚數；切換區間後兩者隨之重算

#### Scenario: 無重疊日期
- **WHEN** CPAP 與 Apple 睡眠的資料日期範圍完全不重疊
- **THEN** 兩條線照常繪製，比值文字不顯示（不顯示 0% 或錯誤值）

#### Scenario: 未知睡眠識別字
- **WHEN** sleep_daily 含對照表沒有的識別字
- **THEN** 分項中以原名列出其分鐘數，且不計入總睡眠時數


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/cpap_viewer.md
  - docs/verification/viewer_history_refinement.md
  - docs/verification/display_revamp.md
-->

---
### Requirement: 沒有 CPAP 資料時不留空區塊

沒有 CPAP 資料的使用者 MUST NOT 看到睡眠呼吸分頁、總覽的 CPAP 卡片，
以及趨勢頁的 AHI 圖。空分頁與空卡片是雜訊，且會讓使用者誤以為功能故障。

有 CPAP 資料但缺少其中某一類（如來源未接血氧模組）時，該區塊 MUST 顯示
原因說明，MUST NOT 呈現一張空的圖表。

#### Scenario: 只有既有來源的資料庫
- **WHEN** 資料庫只有健保或 Apple 資料
- **THEN** 分頁清單、總覽與趨勢頁均無任何 CPAP 相關區塊，既有內容不受影響

<!-- @trace
source: cpap-sleep-therapy
updated: 2026-08-13
code:
  - docs/verification/cpap_viewer.md
-->

---
### Requirement: 趨勢頁的睡眠呼吸對照

測量分頁 MUST 提供每晚 AHI 圖（有 CPAP 資料時；沿用「無資料不留空」），
與同頁其他圖共用時間域與區間選擇（本 requirement 的存在理由是 AHI 與
體重、步數等健康序列的**同期對照**，2026-08-19 分頁改版後由測量分頁
承載，requirement 名稱保留以維持溯源）。
CPAP 的日期 MUST 納入該頁共用時間域的計算來源，否則此圖的 x 軸會與
同頁其他圖不一致，資料點被壓到繪圖區邊界。

#### Scenario: 時間域涵蓋 CPAP 日期
- **WHEN** CPAP 資料的起始日期早於其他所有序列
- **THEN** 該頁共用時間域的下界為該日期，x 軸刻度涵蓋該區間

#### Scenario: 與其他序列同期對照
- **WHEN** 資料庫含 CPAP 資料，使用者於測量分頁切換區間
- **THEN** AHI 圖與體重、步數等圖同步切換、x 軸起訖一致


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/cpap_viewer.md
  - docs/verification/display_revamp.md
-->

---
### Requirement: 來源清單的摺疊呈現

匯入紀錄的來源清單 MUST 將「同一 adapter 且同一匯入時刻」的多個檔案摺疊
為一列，顯示檔案數並可展開檢視逐檔。多檔來源一次匯入會產生數十列，逐列
呈現會使該區塊失去可讀性。

摺疊 MUST 做在檢視層，payload MUST 保留逐檔紀錄：payload 端摺疊會使匯出
的單檔 HTML 失去逐檔追溯，且分組邏輯需要在兩種語言各自實作並保持一致。

**此分組以 `imported_at` 為鍵的前提是同一批寫入同一個值**，該保證由匯入
端負責（見 `app-import-engine`）。若每筆各自取當下時間，批次大或機器慢
就會跨秒，同一批會被拆成數批而畫面上看不出異常。

檢視層與 App 的匯入紀錄卡各有一份分組實作（前者自包含嵌入單檔 HTML、
不能引用外部模組）。兩份 MUST 以**同一組測試向量**分別斷言，避免規則
各自漂移而沒有任何錯誤訊息。

#### Scenario: 多檔來源的匯入紀錄
- **WHEN** 檢視含多檔來源的匯入紀錄
- **THEN** 該批顯示為一列「N 個檔案」，展開後可見逐檔檔名，統計為該批合計

#### Scenario: 同 adapter 不同匯入時刻
- **WHEN** 同一位成員有兩次多檔匯入，匯入時刻不同
- **THEN** 兩批各自摺疊為一列，MUST NOT 合併為同一批

<!-- @trace
source: viewer-and-history-refinement
updated: 2026-08-14
code:
  - docs/verification/cpap_viewer.md
  - docs/verification/viewer_history_refinement.md
-->

---
### Requirement: 就醫時間軸的年份分層

就醫時間軸 MUST 依年份分層，任一時刻只展開一年，未展開的年份
MUST NOT 渲染其就醫列。就醫筆數隨年份累積，平鋪會使標頭數量線性增長。

從其他分頁跳轉至特定就醫紀錄時，MUST 自動展開該筆所在的年份並捲動至
該筆；否則跳轉目標會落在收起的年份內而使用者看不到任何對應內容。

篩選條件改變後，若原本展開的年份已不在結果中，MUST 退回展開結果中最近
的一年，MUST NOT 呈現全部收起而看似無資料的清單。

#### Scenario: 預設只展開最近一年
- **WHEN** 進入就醫時間軸且資料跨越多個年份
- **THEN** 各年份列出該年筆數，僅最近一年展開，其他年份不渲染就醫列

#### Scenario: 自其他分頁跳轉至舊年份的紀錄
- **WHEN** 於搜尋結果或用藥頁點選一筆屬於較早年份的就醫紀錄
- **THEN** 時間軸開啟時該年份已展開、該筆已展開並捲動至可見位置

#### Scenario: 篩選後原展開年份消失
- **WHEN** 套用類型或院所篩選，使原本展開的年份沒有任何符合的紀錄
- **THEN** 自動展開結果中最近的一年

<!-- @trace
source: viewer-and-history-refinement
updated: 2026-08-14
code:
  - docs/verification/viewer_history_refinement.md
-->

---
### Requirement: 檢驗分頁

App MUST 提供獨立的檢驗分頁：檢驗項目清單（依筆數排序、顯示每項筆數）、
選中項目的趨勢圖（含參考值灰帶與 knowledge 說明，行為沿用原趨勢頁檢驗段）
與該項逐筆表。文字型結果的項目 MUST 照常列於清單並顯示逐筆表、
僅不繪圖（沿用既有語意）。

總覽「最新檢驗」表與搜尋結果的檢驗項目點入 MUST 跳轉至檢驗分頁並選中
該項目，MUST NOT 再指向已不存在的趨勢分頁。

#### Scenario: 檢驗有自己的入口
- **WHEN** 使用者點選檢驗分頁
- **THEN** 看到全部檢驗項目清單（含筆數），點選任一項即見其趨勢與逐筆表

#### Scenario: 跳轉指向檢驗分頁
- **WHEN** 於總覽最新檢驗表或搜尋結果點選某檢驗項目
- **THEN** 進入檢驗分頁且該項目已選中


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/display_revamp.md
-->

---
### Requirement: 測量分頁

App MUST 提供測量分頁，分為身體／循環／活動／其他四個子區塊，
MUST NOT 平鋪十幾條線。序列歸屬：

- **身體**：體重（Apple 中位數＋健保成健獨立標記，沿用既有同圖要求）、
  BMI、體脂率、除脂體重、行走穩定度
- **循環**：血壓（收縮壓＋舒張壓同圖）、心率（每日帶狀＋安靜心率
  折線同圖，兩者同單位同數量級）、血氧（每日帶狀）
- **活動**：步數（粒度隨區間的既有語意）、步行跑步距離＋騎車距離同圖、
  爬樓層數、活動能量＋基礎能量同圖、運動記錄
- **其他**：身高（有資料時顯示最近值一行文字，不繪趨勢圖）

同圖疊加 MUST 遵守既有「單位或數量級不同的序列 MUST NOT 疊在同一張圖」
條款。運動記錄 MUST 以列表呈現（日期、類型、時長）並依年分層摺疊
（沿用就醫時間軸的年份分層模式），MUST NOT 平鋪全部歷史。

**行走穩定度** MUST 以百分比顯示（原始值域 0-1，顯示層 ×100、單位標
%），MUST NOT 自行推斷或顯示跌倒風險分級（分級屬另一個未收錄的
category 型別；自行分級是判定性描述）。圖說 MUST 說明該值由 Apple
用於評估行走穩定，分級請見 iPhone 健康 App。

#### Scenario: 四子區塊分區呈現
- **WHEN** 使用者進入測量分頁
- **THEN** 序列依上表歸屬於身體／循環／活動／其他，各子區塊有標題分隔

#### Scenario: 行走穩定度的呈現
- **WHEN** 資料庫含行走穩定度紀錄（raw 值 0.79）
- **THEN** 圖上顯示 79%，且介面無任何風險分級字樣

#### Scenario: 運動記錄分層
- **WHEN** 運動記錄跨多個年份
- **THEN** 預設只見年份列（含該年筆數），展開該年才渲染逐筆列


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/display_revamp.md
-->

---
### Requirement: 量測帶狀圖

心率、血氧、呼吸速率 MUST 以每日帶狀呈現：avg 為折線、min 與 max 為
半透明面（同色系）。帶狀資料 MUST 讀取 apple_daily 的 avg_v／min_v／
max_v（payload 的 `measure_bands`），MUST NOT 由 raw 逐筆計算（清理
raw 後仍須可繪）。

帶的上下界 MUST 參與該圖 y 軸上下界計算（否則帶會畫出繪圖區）；帶的面
MUST 隨區間切換以與 avg 相同的規則過濾。逐點數值提示 MUST 含
「avg（min-max）」三值。血氧的原始值域為 0-1 標 %（HealthKit 官方
定義，同體脂率、行走穩定度款），顯示 MUST 以整序列判定（全部值
≤ 1.5）換算為百分比，MUST NOT 直接以 0-1 值標 % 單位繪製。帶的面 MUST NOT 繪製標記也不參與標記門檻
計算；avg 折線視同一般序列，套用「密集序列的標記降級」的同一套門檻。

心率帶狀圖 MUST 同圖疊加安靜心率折線（同單位 bpm、同數量級），
以圖例區分。

#### Scenario: 帶狀渲染與提示
- **WHEN** 檢視心率帶狀圖上的某一日
- **THEN** 該日顯示 avg 折線點與 min-max 面，逐點提示含三個數值

#### Scenario: 帶狀不依賴 raw
- **WHEN** 對已執行「釋放空間」的資料庫開啟測量分頁
- **THEN** 心率、血氧、呼吸速率帶狀圖內容與清理前完全相同

#### Scenario: 帶參與 y 軸域
- **WHEN** 某日 max 遠高於全部 avg 值
- **THEN** y 軸上界涵蓋該 max，帶不超出繪圖區


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/display_revamp.md
-->

---
### Requirement: 身體數值的參考線

血壓圖 MUST 顯示收縮 130 與舒張 80 兩條水平參考線（居家量測判準），
BMI 圖 MUST 顯示 18.5-24 參考帶。參考標準 MUST 取自 knowledge 條目
（見 knowledge-annotations），MUST NOT 寫死在圖表程式；圖下 MUST
顯示來源名稱與引用日期。標示措辭 MUST 為「參考」性質，MUST NOT
出現正常／超標等判定字樣。

本 requirement 的涵蓋範圍第一版**僅此兩項**：腰圍標準分性別而系統
未收性別欄、血氧與心率無合適的通用官方標準、體重無通用標準（BMI
已涵蓋），MUST NOT 在未補齊依據前對這些型別加參考線。

#### Scenario: 血壓參考線
- **WHEN** 檢視血壓圖
- **THEN** 130 與 80 兩條參考虛線可見，圖下標示來源與引用日期，
  無任何判定字樣

#### Scenario: 標準值來自 knowledge
- **WHEN** knowledge 的參考標準條目被移除
- **THEN** 對應參考線不顯示（而非顯示寫死的預設值），圖表其餘內容
  照常


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/display_revamp.md
-->

---
### Requirement: 就醫分頁的疫苗接種區塊

就醫分頁 MUST 顯示疫苗接種紀錄區塊（日期、疫苗名稱、院所），資料為
payload 既有的 `immunizations`。沒有疫苗資料時 MUST NOT 顯示該區塊。

#### Scenario: 疫苗紀錄可見
- **WHEN** 資料庫含健保疫苗接種紀錄
- **THEN** 就醫分頁顯示疫苗區塊，列出日期、疫苗名稱與院所

#### Scenario: 無疫苗資料
- **WHEN** 資料庫沒有疫苗接種紀錄
- **THEN** 就醫分頁無疫苗區塊（不留空區塊）


<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/display_revamp.md
-->

---
### Requirement: 新增區塊的無資料呈現

本次新增的所有條件性內容（疫苗區塊、運動記錄、睡眠時數、CPAP 使用
對照、呼吸速率、血氧低點、各帶狀圖、測量分頁各子區塊）MUST 沿用
「沒有資料就不渲染該區塊」的既有原則：整塊無資料時不顯示標題與空圖；
子區塊內全部序列皆空時整個子區塊不渲染。部分缺失（如有心率無血氧）
時只渲染有資料的部分。

理由同 CPAP 前例：空分頁與空卡片是雜訊，且會讓使用者誤以為功能故障。

#### Scenario: 無 Watch 的資料庫
- **WHEN** 資料庫的 Apple 資料無心率、血氧、呼吸速率、睡眠（無 Watch
  樣態）
- **THEN** 循環子區塊只顯示血壓，睡眠呼吸分頁不出現 Apple 睡眠相關
  區塊，畫面無任何空圖表

#### Scenario: 子區塊部分缺失
- **WHEN** 身體子區塊只有體重資料、無 BMI 與體脂率
- **THEN** 子區塊標題與體重圖照常渲染，BMI 與體脂率不出現任何空圖
  或無資料訊息

<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/display_revamp.md
-->
