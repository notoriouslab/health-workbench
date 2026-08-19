# apple-health-import Specification

## Purpose

Apple 健康匯出檔（export.xml）的匯入：串流解析與型別擷取、來源別的單位
正規化、佔位日期與離群值的品質旗標，以及匯出檔內部的重複去除。與
incremental-merge 的自然鍵冪等共同保證重複匯入不增列
（change mvp-core-dashboard，2026-08-09）。

## Requirements

### Requirement: 串流解析與型別擷取
系統 SHALL 以串流方式（iterparse 等常數記憶體法）解析 Apple Health
匯出的主 XML（檔名 MAY 為本地化名稱如「輸出.xml」，MUST 以內容而非
檔名判型），擷取健康型別（身體組成/血壓/心率/睡眠/血氧）與活動型別
（步數/距離/能量/步態/飲食等）之 Record 與 Workout 元素。
**100 MB 以上**的匯出檔 MUST 於 60 秒內完成匯入。

#### Scenario: 大檔匯入
- **WHEN** 匯入 100 MB 以上、數十萬筆 Record 的輸出.xml
- **THEN** 60 秒內完成，尖峰記憶體不隨檔案大小線性成長


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 來源別單位正規化
系統 SHALL 維護來源正規化規則表（sourceName → 欄位修正），
至少涵蓋：體脂率以小數儲存者（0.255 標單位 %）MUST 換算為百分比 25.5。
未涵蓋之來源資料 SHALL 原樣入庫並可於規則表擴充後重算。

#### Scenario: 好轻體脂率修正
- **WHEN** 匯入 sourceName=好轻、type=體脂率、value=0.255、unit=% 的紀錄
- **THEN** 正規化值為 25.5%，原始值 0.255 保留可追溯


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 佔位日期與離群值品質旗標
系統 SHALL 對 epoch 佔位日期（2000-01-01 以前之 startDate）標記
quality_flag=epoch_placeholder_date；SHALL 對超出型別合理範圍的量測
（如體重 <30 或 >200 kg）標記 out_of_range。被標記資料 MUST 入庫
但 MUST NOT 進入趨勢統計。

#### Scenario: 1970 佔位日期
- **WHEN** 匯入 startDate=1970-01-02 的體重紀錄
- **THEN** 該筆入庫且帶 epoch_placeholder_date 旗標，體重趨勢圖不含此點

#### Scenario: 離群體重
- **WHEN** 匯入一筆低於合理下界（<30 kg）的體重紀錄
- **THEN** 該筆入庫且帶 out_of_range 旗標，不進趨勢


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 匯出檔內部重複去除
同一匯出檔內相同 (type, startDate, endDate, sourceName, value) 的紀錄
（多裝置雙上報）SHALL 只入庫一筆，去除數量記入品質報告。

#### Scenario: 手錶手機雙上報
- **WHEN** 匯出檔含 27 筆完全相同的重複紀錄
- **THEN** 各只入庫一筆，品質報告顯示 skipped_dup=27

<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 匯入時每日彙總

Apple 匯入 MUST 於同一交易終點，以 SQL（INSERT…SELECT…GROUP BY
＋UPSERT）更新 apple_daily：**以本次匯入觸及的鍵（該檔的每日 × 型別 ×
來源組合）從全部 raw 列重算**該鍵統計，MUST NOT 只聚合本次 doc 的列
（增量日會把既有統計縮小或使其過期）；聚合輸入 MUST 取正規化值優先（COALESCE(value_normalized,
value_numeric)），與趨勢查詢同一判準。JS 與 Python 兩端 MUST 使用
逐字相同的聚合 SQL（既有條文「新增彙總 MUST 以 SQL 計算而非兩語言
各自實作」的延伸），差分對帳的逐表 dump 自動涵蓋 apple_daily。

睡眠型別 MUST 按原始 value_text 識別字分組聚合每日分鐘數
（四捨五入至整數分鐘）寫入 extra_json，MUST NOT 寫死階段清單
（無 Watch 的匯出檔只有 InBed 等識別字，有 Watch 才有階段名）。

彙總失敗 MUST 使整筆匯入回滾（彙總與 raw 寫入同一交易，不允許
兩者不一致的中間態）。

#### Scenario: 聚合與趨勢判準一致
- **WHEN** 匯入含 unit_normalized 修正值的檔案
- **THEN** apple_daily 的統計以正規化後的值計算

#### Scenario: 睡眠按識別字聚合
- **WHEN** 匯入含睡眠紀錄（任意識別字）的檔案
- **THEN** extra_json 含每日各識別字的分鐘數，識別字原樣保留

#### Scenario: 增量日重算
- **WHEN** 先匯入含某日部分紀錄的檔案，再匯入對同日新增紀錄的檔案
- **THEN** 該日該鍵的統計等於兩檔合計的 raw 列重算值（不縮小、不過期）

#### Scenario: 兩端聚合一致
- **WHEN** 同一檔分別經 JS 與 Python 匯入兩個空庫
- **THEN** 兩庫的 apple_daily 逐表 dump 全等

<!-- @trace
source: apple-daily-aggregates
updated: 2026-08-19
code:
  - docs/verification/apple_daily_aggregates.md
-->
