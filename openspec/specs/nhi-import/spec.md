# nhi-import Specification

## Purpose

健保個人健康存摺資料的匯入：14 節區完整解析、藥局交付調劑日期回退、
巢狀醫囑明細完整入庫、遮罩身分證歸戶，以及檔案指紋防重複匯入
（change mvp-core-dashboard，2026-08-09）。

## Requirements

### Requirement: 14 節區完整解析
系統 SHALL 解析健康存摺醫療類 JSON 的全部節區（b1.1/b1.2 與 r1～r14），
節區代碼 MUST 先正規化為小寫（原始檔 r1～r11 小寫、R12～R14 大寫混用）。
「無資料」佔位節區（`[{"rN": "無資料"}]`）SHALL 記入品質報告為 no_data，
MUST NOT 產生資料列。未知的新節區或未知欄位 MUST 保留於 extra_json
並記入品質報告，MUST NOT 靜默丟棄。

#### Scenario: 完整檔案匯入
- **WHEN** 匯入一份含 r1(63)/r3(2)/r6(4)/r7(68)/r8(7)/r9(15)/r10(1)/r11(2)
  且 r2/r4/r5/r12/r13/r14 為無資料的下載檔
- **THEN** 各節區筆數與品質報告一致，無資料節區標記 no_data，
  總就醫事件 = r1+r3+r9 筆數

#### Scenario: 未知欄位保留
- **WHEN** 某 r1 紀錄含 spec 未定義的欄位 r1.99
- **THEN** 該值保存於 extra_json，品質報告列出 unknown_field 統計


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 藥局交付調劑日期回退
當 r1 紀錄的就醫日期（r1.5）為空且交付調劑日期（r1.6）有值時，
系統 SHALL 以 r1.6 作為事件日期並將事件型別標為 pharmacy_dispensing。

#### Scenario: 調劑紀錄
- **WHEN** 匯入 r1.5=""、r1.6="20260715"、就醫序號="XXXX" 的紀錄
- **THEN** 事件日期為 2026-07-15、type=pharmacy_dispensing，品質報告無日期錯誤


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 巢狀醫囑明細完整入庫
系統 SHALL 解析 r1_1（西醫醫囑）、r3_1（牙醫醫囑，含牙位欄）、
r9_1（中醫醫囑）為用藥/處置明細，每筆 MUST 關聯所屬就醫事件。
匯入完成後明細總數 MUST 與原始檔逐節區加總相等（對帳驗證）。

#### Scenario: 醫囑對帳
- **WHEN** 原始檔 r1_1+r3_1+r9_1 合計 N 筆用藥
- **THEN** medications 表恰好新增 N 筆且每筆 encounter_id 有效


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 遮罩身分證歸戶
系統 SHALL 讀取 b1.1（遮罩身分證，如 A12345****）與現有 profile 比對：
一致則歸入該 profile；不一致或首見 MUST 停止並要求使用者確認，
MUST NOT 自動建新 profile 或混入現有 profile。

#### Scenario: 不同人檔案誤匯防護
- **WHEN** 資料庫 profile 的遮罩身分證為 A12345****，匯入檔 b1.1=B98765****
- **THEN** 匯入中止並顯示兩者差異，資料庫無任何寫入


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 檔案指紋防重複匯入
系統 SHALL 以檔案 SHA-256 記錄每次匯入（source_documents），
同一檔案再次匯入 SHALL 直接回報「已匯入過」並跳過解析。

#### Scenario: 同檔重匯
- **WHEN** 同一 JSON 檔匯入兩次
- **THEN** 第二次不新增任何資料列，輸出提示已於某日匯入過

<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 報告欄位非規格控制字元容忍
健保署匯出工具會在報告類自由文字欄位（如 r8.10 影像／病理報告）寫入未跳脫的
原始控制字元，例如聽力檢查以 TAB 對齊左右耳結果。此輸出違反 RFC 8259（字串內
控制字元須跳脫），但確實是官方工具的真實輸出，系統 SHALL 完成匯入，
MUST NOT 在解析階段整批中止（中止會讓逐筆 guard() 防線完全來不及發揮，
資料庫零寫入）。

解析出的值 MUST 原樣保留該控制字元，MUST NOT 替換為空白：報告以等寬
pre-wrap 呈現，TAB 的對齊帶有原始語意。

兩實作的容忍手段不對稱（Python 用 `json.loads(strict=False)`；JS 無對應開關，
於 `JSON.parse` 失敗後跳脫字串內控制字元重試一次），語意等價性 MUST 由差分
測試釘住，MUST NOT 僅以人工對帳宣稱。跳脫 MUST 限定於字串內：健保署檔案為
格式化多行 JSON，全域替換會連結構縮排一起跳脫而破壞整份文件。

回歸素材 MUST 是位元層面的原始控制字元。JSON 跳脫寫法是合法 JSON，
`strict=True` 也解析得過，用它當測試向量測不到這條路徑。

#### Scenario: 報告欄位含未跳脫原始 TAB
- **WHEN** 匯入一份 r8.10 值含位元層面原始 0x09 的下載檔
- **THEN** 匯入完成回報成功，報告列入庫，且 report_text 與原始值逐字元相同

#### Scenario: 兩實作差分等價
- **WHEN** 同一含原始控制字元的檔案分別經 Python adapter 與 App 引擎匯入
- **THEN** 全表 dump 與增量品質報告全等

#### Scenario: XML 格式同素材不中止
- **WHEN** 同類控制字元出現在 XML 版的文字節點
- **THEN** 迷你解析器原樣通過、不中止（TAB 於 XML 文字節點本即合法）

**已知限制**：值原樣入庫對 TAB 與 0x1f 等字元無下游影響（EPUB 與單檔 HTML
的健康資料走 JSON.stringify 嵌入，控制字元被跳脫為 ASCII 序列，產出經標準
XML 解析器判定為有效；SQL 字串函式行為正常）。NUL（0x00）另有兩項後果尚未
處理：SQLite 的 length()／substr()／LIKE 在 NUL 處截斷，且 Python sqlite3
與 node:sqlite 的值往返一致性不同（前者無損、後者有損）。健保署檔案至今未
觀測到 NUL，故解析層一律容忍但不納入回歸基準。另 EPUB metadata 路徑的
xmlEscape 不處理控制字元，該路徑只取用成員名稱與日期，不取用下載檔內容。

<!-- @trace
source: issue-2-raw-control-chars
updated: 2026-08-21
code:
  - src/adapters/nhi_json.py
  - app/src/adapters/nhi_json.js
  - tests/fixtures/nhi_ctrlchar.json
  - tests/test_nhi.py
  - app/tests/adapters/edge_cases.test.mjs
  - app/tests/adapters/nhi_xml.test.mjs
  - app/tests/parity/parity.test.mjs
-->
