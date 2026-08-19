# knowledge-annotations Specification

## Purpose

檢驗與藥品的知識標註：條目結構與來源標註、非結論式用語約束、藥品資訊
對接與過時提醒。用語約束以禁用詞守衛落實，掃描 `app/src` 全部檔案內容
含註解，確保介面只呈現數值與出處而不作判定
（change mvp-core-dashboard，2026-08-09）。

## Requirements

### Requirement: 條目結構與來源標註
knowledge 條目 SHALL 以版本化 YAML 維護於 repo，每條 MUST 含：
normalized_name、aliases、description、source_name、source_url、
cited_date。缺任一欄位 MUST 使建置失敗。dashboard 顯示說明時
SHALL 同時顯示來源名稱與引用日期。

#### Scenario: 完整條目顯示
- **WHEN** 檢視 Hemoglobin 檢驗說明
- **THEN** 顯示說明文字、來源（如國健署成人預防保健專區）與引用日期

#### Scenario: 缺來源欄位
- **WHEN** labs.yaml 有條目缺 source_url
- **THEN** 建置失敗並指出條目名


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 非結論式用語約束
knowledge 條目與 dashboard 顯示文案 MUST 通過禁用詞清單檢查
（禁用：診斷、預測、你可能罹患、建議停藥、換藥、不適合、
正常/不正常之判定式用法）；引述原始報告文字時 SHALL 標示為原文，
不受此限。

#### Scenario: 條目含結論式用語
- **WHEN** 條目 description 寫「數值過高代表你可能罹患糖尿病」
- **THEN** 建置失敗並指出違規詞


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 藥品資訊對接
系統 SHALL 以醫囑代碼比對本機快取的健保藥品品項檔（記錄資料集
版本日期），為每筆用藥提供商品名、成分名與食藥署仿單查詢連結；
比對不到者 SHALL 顯示原始醫囑名稱並標 unmapped。快取更新 MUST 為
使用者主動觸發（hwb knowledge update），MUST NOT 於匯入或建置時外連。

#### Scenario: 藥品連結
- **WHEN** 檢視任一筆醫囑代碼可對應品項檔的用藥紀錄
- **THEN** 顯示成分名與仿單平台查詢連結，並標示品項檔版本日期

#### Scenario: 離線建置
- **WHEN** 無網路環境執行 hwb rebuild
- **THEN** 建置成功，藥品資訊使用既有快取


<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 過時提醒
品質報告 SHALL 對 cited_date 超過一年的 knowledge 條目與超過一年的
藥品品項快取提出更新提醒，MUST NOT 自動更新。

#### Scenario: 引用過期
- **WHEN** 條目 cited_date=2025-06-01，今日為 2026-08-08
- **THEN** hwb quality 輸出該條目於過時清單

<!-- @trace
source: mvp-core-dashboard
updated: 2026-08-09
code:
  - bin/hwb
  - docs/verification/karen_reality.md
  - README.md
-->

---
### Requirement: 身體數值參考標準條目

身體數值的參考線／參考帶標準 SHALL 以版本化 YAML 維護於 repo
（建置期轉 JSON 進 bundle，沿 labs 慣例），每條 MUST 含：型別、
線或帶的數值、標示文字、source_name、source_url、cited_date。
缺任一欄位 MUST 使建置失敗。顯示時 MUST 帶來源名稱與引用日期。
非結論式用語約束與過時提醒對本類條目一體適用。

第一版條目 MUST 僅含：血壓居家判準（收縮 130、舒張 80；
2022 台灣高血壓治療指引，經國健署 722 原則頁轉述）與
BMI 18.5-24（國健署）。

#### Scenario: 條目欄位齊備
- **WHEN** 參考標準條目缺 cited_date
- **THEN** 建置失敗並指出條目名

#### Scenario: 過時提醒涵蓋
- **WHEN** 參考標準條目的 cited_date 超過一年
- **THEN** 品質報告將其列入過時清單

<!-- @trace
source: display-revamp-bands-cleanup
updated: 2026-08-19
code:
  - docs/verification/display_revamp.md
-->
