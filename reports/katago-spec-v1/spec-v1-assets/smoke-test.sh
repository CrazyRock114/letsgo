#!/usr/bin/env bash
# smoke-test.sh — KataGo 部署后生产烟雾测试
# 每次 deploy 到 Railway 后应自动跑此脚本
#
# 用法:
#   TOKEN=<valid_jwt> ./smoke-test.sh https://letusgoa.cn
#
# 退出码: 0=通过, 非 0=失败

set -euo pipefail

BASE_URL="${1:-https://letusgoa.cn}"
TOKEN="${TOKEN:?TOKEN env var required}"

# 工具: 计算 JSON 字段
jq_num() {
  local json="$1"; local path="$2"
  echo "$json" | jq -r "$path"
}

die() {
  echo "❌ FAIL: $*" >&2
  exit 1
}

pass() {
  echo "✅ $*"
}

echo "=========================================="
echo "KataGo Production Smoke Test"
echo "Target: $BASE_URL"
echo "=========================================="

# -----------------------------------------
# Test 1: 引擎可用性
# -----------------------------------------
echo ""
echo "[1/6] KataGo 引擎可用性检查..."
RESP=$(curl -sf "$BASE_URL/api/go-engine" -H "Authorization: Bearer $TOKEN")
KATA_AVAILABLE=$(echo "$RESP" | jq -r '.engines | map(select(.id=="katago" and .available==true)) | length')
[[ "$KATA_AVAILABLE" == "1" ]] || die "KataGo 不可用: $RESP"
pass "KataGo 在线"

# 解析后端配置信息
MODEL_PATH=$(echo "$RESP" | jq -r '.engines[] | select(.id=="katago") | .debug.model')
VERSION_LINE=$(echo "$RESP" | jq -r '.engines[] | select(.id=="katago") | .debug.versionTest' | head -1)
echo "    Model: $MODEL_PATH"
echo "    Version: $VERSION_LINE"

# -----------------------------------------
# Test 2: 9x9 空棋盘 analyze, winRate 必须在 [35%, 65%]
# -----------------------------------------
echo ""
echo "[2/6] 9x9 空棋盘均势验证..."
RESP=$(curl -sf -X POST "$BASE_URL/api/go-engine" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"analyze","boardSize":9,"moves":[]}')

WINRATE=$(jq_num "$RESP" ".analysis.winRate")
SCORELEAD=$(jq_num "$RESP" ".analysis.scoreLead")

echo "    winRate = $WINRATE%, scoreLead = $SCORELEAD 目"

# 使用 bc 做浮点比较
if (( $(echo "$WINRATE >= 35 && $WINRATE <= 65" | bc -l) )); then
  pass "9x9 空棋盘 winRate 在合理范围"
else
  die "9x9 空棋盘 winRate=$WINRATE 不在 [35, 65]，可能 komi/rules 错配"
fi

if (( $(echo "($SCORELEAD * $SCORELEAD) <= 9" | bc -l) )); then
  pass "9x9 空棋盘 scoreLead 在合理范围（|x| <= 3）"
else
  die "9x9 空棋盘 scoreLead=$SCORELEAD 超出 ±3 目，komi 可能严重错配"
fi

# -----------------------------------------
# Test 3: 13x13 空棋盘均势
# -----------------------------------------
echo ""
echo "[3/6] 13x13 空棋盘均势验证..."
RESP=$(curl -sf -X POST "$BASE_URL/api/go-engine" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"analyze","boardSize":13,"moves":[]}')

WINRATE=$(jq_num "$RESP" ".analysis.winRate")
echo "    winRate = $WINRATE%"
if (( $(echo "$WINRATE >= 35 && $WINRATE <= 65" | bc -l) )); then
  pass "13x13 空棋盘 winRate 在合理范围"
else
  die "13x13 空棋盘 winRate=$WINRATE 不在 [35, 65]"
fi

# -----------------------------------------
# Test 4: 19x19 空棋盘均势
# -----------------------------------------
echo ""
echo "[4/6] 19x19 空棋盘均势验证..."
RESP=$(curl -sf -X POST "$BASE_URL/api/go-engine" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"analyze","boardSize":19,"moves":[]}')

WINRATE=$(jq_num "$RESP" ".analysis.winRate")
echo "    winRate = $WINRATE%"
if (( $(echo "$WINRATE >= 35 && $WINRATE <= 65" | bc -l) )); then
  pass "19x19 空棋盘 winRate 在合理范围"
else
  die "19x19 空棋盘 winRate=$WINRATE 不在 [35, 65]"
fi

# -----------------------------------------
# Test 5: 视角一致性
#   黑下一手后 scoreLead 应该反映"白方要下，黑方刚走一步，小幅领先"
#   如果固定为黑方视角：应为正或接近 0
#   如果是 side-to-move 视角：应为负（白方的视角看黑方领先是负）
#   关键：和 winRate 视角必须一致
# -----------------------------------------
echo ""
echo "[5/6] 视角一致性验证（黑下一手后）..."
RESP=$(curl -sf -X POST "$BASE_URL/api/go-engine" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"analyze","boardSize":9,"moves":[{"row":4,"col":4,"color":"black"}]}')

WINRATE=$(jq_num "$RESP" ".analysis.winRate")
SCORELEAD=$(jq_num "$RESP" ".analysis.scoreLead")
echo "    黑下天元后: winRate=$WINRATE%, scoreLead=$SCORELEAD 目"

# 规范要求：都是黑方视角
# - winRate > 50% 表示黑方优势
# - scoreLead > 0 表示黑方领先
# 所以符号必须一致！
if (( $(echo "($WINRATE > 50 && $SCORELEAD > 0) || ($WINRATE < 50 && $SCORELEAD < 0) || ($SCORELEAD == 0)" | bc -l) )); then
  pass "winRate 和 scoreLead 视角一致"
else
  die "视角不一致！winRate=$WINRATE 和 scoreLead=$SCORELEAD 符号相反（应同为黑方视角）"
fi

# -----------------------------------------
# Test 6: genmove 能下出合法手
# -----------------------------------------
echo ""
echo "[6/6] genmove 验证..."
RESP=$(curl -sf -X POST "$BASE_URL/api/go-engine" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"boardSize":9,"moves":[{"row":4,"col":4,"color":"black"}],"engine":"katago","difficulty":"easy","aiColor":"white"}')

MOVE_ROW=$(jq_num "$RESP" ".move.row")
MOVE_COL=$(jq_num "$RESP" ".move.col")
IS_PASS=$(jq_num "$RESP" ".pass // false")
ENGINE_ERROR=$(jq_num "$RESP" ".engineError // false")

echo "    move: row=$MOVE_ROW, col=$MOVE_COL, pass=$IS_PASS, engineError=$ENGINE_ERROR"

if [[ "$IS_PASS" == "true" ]]; then
  die "⚠️ 9x9 开局第二手 AI 就 pass，这不应发生（可能是 komi 错或模型问题）"
fi
if [[ "$ENGINE_ERROR" == "true" ]]; then
  die "引擎返回 engineError"
fi
if [[ "$MOVE_ROW" -ge 0 && "$MOVE_ROW" -lt 9 && "$MOVE_COL" -ge 0 && "$MOVE_COL" -lt 9 ]]; then
  pass "genmove 返回合法手"
else
  die "genmove 返回非法坐标 row=$MOVE_ROW col=$MOVE_COL"
fi

# -----------------------------------------
# 总结
# -----------------------------------------
echo ""
echo "=========================================="
echo "✅ 所有 6 项烟雾测试通过"
echo "=========================================="
exit 0
