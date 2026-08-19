# health-database Specification

## Purpose

SQLite schema 的 SSOT：多人預留欄位、來源追溯、品質旗標貫穿、檢驗名稱
正規化欄位、schema 版本化與遷移、匯入統計記錄，以及 CPAP 三張資料表。
JS 與 Python 兩端實作 MUST 逐字同步（空庫 schema dump 全等）
（change mvp-core-dashboard，2026-08-09）。

## Requirements

### Requirement: 多人預留 schema

所有資料表 SHALL 含 profile_id 欄位並以其為複合索引首欄；多成員
資料 SHALL 以 profile_id 完全隔離（去重 UNIQUE 鍵含 profile_id，
成員間冪等互不干擾）。profiles 表 SHALL 儲存顯示名稱與遮罩身分證，
MUST NOT 儲存完整身分證字號。刪除成員 MUST 於單一交易內清除該
成員在全部資料表（含 source_documents）的所有列。

（刪除原文末句「本輪 MUST NOT 變更 DDL（schema 維持 v3…）」：該句是
change `multi-profile-management` 的範圍護欄，delta 覆蓋時被寫進主
spec 殘留至今；DDL 凍結是單一 change 的執行約束，不是資料模型的長期
規格。schema 版本現況由「匯入統計記錄」requirement 的 v5 條文陳述。）

#### Scenario: 兩人資料隔離
- **WHEN** 同一資料庫含兩位成員的資料，查詢以 profile_id 篩選
- **THEN** 任一成員的查詢結果不含另一成員任何紀錄；同內容紀錄
  分屬兩成員時各自入庫，不被跨成員去重

#### Scenario: 刪除成員交易原子
- **WHEN** 刪除成員的逐表清除進行中發生中斷
- **THEN** 整批回滾，該成員資料完整保留，無半刪狀態

<!-- @trace
source: import-progress-and-single-pass
updated: 2026-08-19
code:
  - docs/verification/multi_profile_qa_closeout.md
  - docs/verification/import_single_pass.md
-->

---
### Requirement: 來源追溯

每筆正規化資料 SHALL 帶 source_document 外鍵、來源節區/型別與
來源索引，足以還原至原始檔案中的位置。source_documents SHALL 記錄
檔名、SHA-256、匯入時間與 adapter 名稱及版本；另 SHALL 有 nullable
欄位 `container_sha256` 記錄 zip 容器位元組的 SHA-256（僅 zip 來源
填值，供重複匯入快篩；非 zip 來源為 NULL）。內容 SHA-256 的語意
（zip 與資料夾匯入同一份資料得到相同指紋）不變。

#### Scenario: 從圖表回到原始檔
- **WHEN** 查詢任一檢驗結果的來源
- **THEN** 可得原始檔名、節區（r7）與該筆在節區中的索引

#### Scenario: 容器指紋只在 zip 來源出現
- **WHEN** 分別以 zip 與 XML 檔匯入
- **THEN** zip 的來源列 container_sha256 非空，XML 檔的為 NULL

<!-- @trace
source: import-progress-and-single-pass
updated: 2026-08-19
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
  - docs/verification/import_single_pass.md
-->

---
### Requirement: 品質旗標貫穿
quality_flags SHALL 為每筆資料的可累加欄位，聚合查詢與趨勢 MUST
排除帶排除性旗標（epoch_placeholder_date、out_of_range）的資料，
品質報告 SHALL 按旗標統計筆數。

#### Scenario: 品質報告
- **WHEN** 執行 hwb quality
- **THEN** 輸出各旗標筆數、unmapped 檢驗名清單、superseded 對照組數


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 檢驗名稱正規化欄位
lab_results SHALL 同時保存 test_name_raw 與 test_name_normalized；
正規化依 knowledge 別名表，未匹配者 normalized 為 NULL 並標 unmapped。
趨勢分組 MUST 使用 normalized 名稱；unmapped 者 MUST 以原名獨立成組
並標示 unmapped，MUST NOT 因未匹配而自趨勢圖消失；不同計算法的同名概念
（如 eGFR (CKD-EPI) 與 eGFR (MDRD)）MUST 維持獨立正規化名，
MUST NOT 合併為同一趨勢線。

#### Scenario: Hb 與 HB 合併
- **WHEN** 兩院所分別回報 Hb 與 HB
- **THEN** 兩者 normalized 同為 Hemoglobin，趨勢圖同一條線

#### Scenario: eGFR 不合併
- **WHEN** 資料含 eGFR (CKD-EPI) 與 eGFR (MDRD)
- **THEN** 兩者為不同正規化名、各自成線


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: schema 版本化
資料庫 SHALL 含 schema_version 表；CLI 開啟資料庫時版本不符 MUST
執行前向遷移或明確報錯，MUST NOT 以不符版本靜默讀寫。

**前向遷移 MUST 在單一交易內完成**：版本註記與結構變更同進同出。未交易化
時，若結構變更執行到一半中斷，資料庫會停在「版本已寫新值但結構只完成
一部分」的狀態，之後每次開啟都會略過遷移而讀寫缺表的資料庫。

**版本紀錄存在但為空 MUST 明確報錯**（`schema_version` 表存在卻沒有任何
列）。此時「最大版本」為 null，而 null 與數字的所有比較都是 false，
不明確攔下就會靜默通過並讓後續操作跑在缺表的資料庫上。

#### Scenario: 舊庫開啟
- **WHEN** 以新版 CLI 開啟舊 schema 資料庫
- **THEN** 自動執行遷移並更新版本註記，或列出不可遷移原因後中止

#### Scenario: 遷移中途中斷
- **WHEN** 前向遷移執行到一半發生錯誤
- **THEN** 整段回滾至遷移前的版本，新結構不存在，既有資料逐位元組不變

#### Scenario: 版本紀錄被清空
- **WHEN** `schema_version` 表存在但沒有任何列
- **THEN** 明確報錯並指引使用者以備份還原，MUST NOT 靜默視為最新版

<!-- @trace
source: cpap-sleep-therapy
updated: 2026-08-13
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
  - docs/verification/cpap_schema_v4_migration.md
-->

---
### Requirement: 匯入統計記錄

source_documents SHALL 記錄每次匯入的統計（import_stats，JSON：
inserted/skipped_dup/collisions）；adapter 於匯入收尾 MUST 寫入。
schema 演進 SHALL 以 MIGRATIONS 前向遷移表實作，舊版資料庫開啟時
自動逐版升級。現行 schema 版本為 **v6**（v5 新增 `container_sha256`、v6 新增
`apple_daily` 表），
JS 與 Python 兩端的 DDL、MIGRATIONS、SCHEMA_VERSION MUST 同步
（schema parity 測試以空庫 dump 全等釘住）。
v5 → v6 遷移 MUST 於遷移交易內以匯入用的同一份聚合 SQL 對既有
raw 資料一次性回填 apple_daily，raw 資料逐位元組不變。

**遷移前 MUST 自動產生升級前的資料庫快照**，且僅在偵測到既有版本低於
程式版本時產生（全新資料庫不做）。快照失敗 MUST 中止遷移並明確告知
（含目標路徑），MUST NOT 靜默續行。

快照 MUST 以資料庫自身的一致性快照機制產生，MUST NOT 以檔案複製實作：
複製前必須先關閉主資料庫連線，而遷移發生在開啟流程之中，連線必然是開著的。

**多檔來源的每個被解析檔案各佔一列** `source_documents`：沿用既有的
單檔內容雜湊唯一性，下次匯入同一批時只有新檔會被處理，且來源追溯精確
到檔案。既有列的統計 MUST NOT 被覆寫（違反「匯入不破壞既有資料」的白名單）。

**每一列的 import_stats MUST 只記載該檔自身**新增與略過的筆數，MUST NOT
在任何一列寫入整批合計：呈現層以「同 adapter ＋同 imported_at」分批並將
組內各列相加，任一列裝的若是合計，該批的筆數就會被重複計算而無任何錯誤
訊息（2026-08-14 實測：多檔批次的顯示值接近實際的兩倍）。整批合計
MAY 用於匯入當下的報告，MUST NOT 寫入 `source_documents`。

#### Scenario: 匯入後留下統計
- **WHEN** 完成一次匯入
- **THEN** 該 source_documents 列的 import_stats 含本次新增與略過筆數

#### Scenario: v1 庫自動升級
- **WHEN** 以現行程式開啟 schema v1 資料庫
- **THEN** 自動遷移至現行版本且既有資料完整保留

#### Scenario: 舊庫自動升級（v4 → v5）
- **WHEN** v4 資料庫被新版開啟
- **THEN** 自動執行 v5 遷移，source_documents 具 container_sha256 欄位
  且既有列該欄為 NULL

#### Scenario: 升級前自動快照
- **WHEN** 開啟一個版本落後於程式的既有資料庫
- **THEN** 先產生一份升級前的快照再遷移；快照可被「匯入既有資料庫檔」
  讀回且維持升級前的版本

#### Scenario: 部分新檔的批次匯入
- **WHEN** 同一個多檔來源第二次匯入，其中只有部分檔案是新的
- **THEN** 只有新檔被解析，既有檔案的來源列與其統計逐位元組不變

#### Scenario: 多檔批次的統計相加等於實際筆數
- **WHEN** 一次多檔匯入完成
- **THEN** 該批各列 import_stats 的 inserted 逐表相加，等於本次實際寫入
  資料庫的筆數（沒有任何一列裝著整批合計）
#### Scenario: v5 庫升級並回填
- **WHEN** v5 資料庫（含既有 apple_records）被新版開啟
- **THEN** 自動建 apple_daily 並以既有 raw 列回填彙總，raw 資料逐位元組
  不變

<!-- @trace
source: apple-daily-aggregates
updated: 2026-08-19
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
  - docs/verification/cpap_schema_v4_migration.md
  - docs/verification/batch_stats_double_count.md
  - docs/verification/import_single_pass.md
  - docs/verification/apple_daily_aggregates.md
-->

---

### Requirement: CPAP 資料表

SHALL 含每日摘要、呼吸事件與睡眠血氧三張表，均帶 `profile_id` 與
`doc_id`（沿用「多人預留 schema」與「來源追溯」既有 requirement）。

三張表的 UNIQUE 鍵 MUST 包含裝置識別欄位：不同機器的資料期間可能重疊，
鍵不含裝置時重疊期間的同一天會被視為重複而靜默丟棄。

每日摘要的多段使用資訊（同一天中途取下面罩再戴回）MUST 保留段數與完整
逐段起訖，MUST NOT 只存首段：機器提供的使用時數是全天合計，只存首段會
使「就寢到起床」與使用時數自相矛盾。

#### Scenario: 兩台機器的重疊日期
- **WHEN** 兩台不同機型在同一天都有每日摘要
- **THEN** 兩筆各自入庫，MUST NOT 因日期相同而丟棄其中一筆

#### Scenario: 一天分多段使用
- **WHEN** 某日的來源含多段使用區間
- **THEN** 段數、首段起、末段止與完整逐段資料都被保留，且該列標記為多段

<!-- @trace
source: cpap-sleep-therapy
updated: 2026-08-13
code:
  - docs/verification/cpap_schema_v4_migration.md
  - docs/verification/cpap_resmed_adapter.md
-->

---
### Requirement: Apple 每日彙總表

SHALL 有 `apple_daily` 表：每日 × 型別 × 來源一列，鍵為
`(profile_id, type_zh, day, source_name)`（UNIQUE；source_name
NOT NULL DEFAULT ''，raw 的 NULL 來源以空字串寫入，鍵不含 NULL），欄位為
`n`（原始筆數，用於「已收錄 N 筆」顯示與縮水防線）、`sum_v`／`min_v`／
`max_v`／`avg_v`（統一五統計，個別型別的顯示取用哪個統計屬檢視層）、
`extra_json`（睡眠的每日各識別字分鐘數；其餘型別為 NULL）、
`doc_id`、`quality_flags`（day 早於 epoch 判準日的列 MUST 帶
epoch_placeholder_date，趨勢讀取據此排除，語意同 raw 的既有旗標）。
型別欄只存中文名 `type_zh`（29 個 WANTED
中文名互異，唯一性由 adapter 的型別表保證）。

**跨批次覆蓋語意**：同鍵新值 MUST 覆蓋舊值（Apple 匯出為全量歷史）；
但新值的 n 小於既有 n 時 MUST NOT 無聲覆蓋：數值保留既有，並對該鍵
追加 quality_flag `partial_reimport_skipped`（換機後以部分來源重新匯出
不得蓋掉完整資料）。

彙總涵蓋的 20 個型別與逐筆保留的 9 個型別，兩份清單 MUST 為程式常數
且聯集恰等於 adapter 的 WANTED（無重複、無遺漏），以測試釘住。

#### Scenario: 匯入後彙總表就緒
- **WHEN** 完成一次 Apple 匯入
- **THEN** apple_daily 含該檔 20 個彙總型別的每日 × 來源列，n 總和等於
  該檔這些型別實際入庫的 raw 列數

#### Scenario: 縮水防線
- **WHEN** 先匯入完整檔，再匯入同期間但某日筆數較少的重新匯出檔
- **THEN** 該日該鍵數值不變，quality_flags 含 partial_reimport_skipped

#### Scenario: 分配表對帳
- **WHEN** 比對彙總清單與逐筆保留清單的聯集
- **THEN** 恰等於 WANTED 的 29 個型別，無重複、無遺漏

<!-- @trace
source: apple-daily-aggregates
updated: 2026-08-19
code:
  - docs/verification/apple_daily_aggregates.md
-->
