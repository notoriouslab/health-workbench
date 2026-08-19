#!/bin/bash
# 重產藥品品項快取（drug_items.sqlite）並同步到 bundle 資源與 dev 路徑。
#
# 發版前必跑（release runbook Step 0）：App 零連網、藥品資料只隨發版更新，
# 不跑這支等於把陳舊的適應症與品項資料再發一版。
#
# 用法：
#   scripts/refresh_drug_cache.sh                        # 線上下載兩個資料集
#   scripts/refresh_drug_cache.sh <品項CSV> <許可證CSV或ZIP>  # 用本地檔（離線/測試）
#
# 產物：app/src-tauri/resources/drug_items.sqlite（bundle 資源）
#       data/drug_items.sqlite（dev／測試「真實快取」路徑）
# 驗收（機器可判）：印出的筆數 >= 40000 且 join 命中率 >= 0.98，
# 低於門檻＝資料集異常，停下查因、不得照發。
set -euo pipefail
cd "$(dirname "$0")/.."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ARGS=()
if [ "$#" -ge 1 ]; then ARGS+=(--source-items "$1"); fi
if [ "$#" -ge 2 ]; then ARGS+=(--source-licenses "$2"); fi

./bin/hwb --db "$TMP_DIR/db.sqlite" knowledge update "${ARGS[@]+"${ARGS[@]}"}"

CACHE="$TMP_DIR/drug_items.sqlite"
[ -f "$CACHE" ] || { echo "快取檔未產出：$CACHE" >&2; exit 1; }

echo "---- 快取統計 ----"
sqlite3 "$CACHE" "SELECT '品項數 ' || count(*) || '、有適應症 ' || count(indication)
  || '、join 命中率 ' || round(count(license_id)*1.0/count(*), 4) FROM drug_items"
sqlite3 "$CACHE" "SELECT key || '=' || value FROM cache_meta"

cp "$CACHE" app/src-tauri/resources/drug_items.sqlite
cp "$CACHE" data/drug_items.sqlite
echo "已更新：app/src-tauri/resources/drug_items.sqlite 與 data/drug_items.sqlite"
