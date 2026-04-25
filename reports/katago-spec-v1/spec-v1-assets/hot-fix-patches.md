# Hot Fix Patch 清单（按阶段 1 路线图）

> 本文件列出阶段 1 的**每一行代码变更**，按优先级排序
> 总预期工作量：4-6 小时
> 预期收益：消灭 §5 所述的 komi 错配、scoreLead 视角、rules 错配三个最严重的问题

## 修改清单（按部署顺序）

### 🔧 Patch 1: getKomi 修正（5 分钟）

**目的**：把错误的 `2.5/3.5/6.5` 改成官方 fair komi

**文件**：`src/lib/go-logic.ts`

**修改**：
```diff
 /**
  * 获取指定棋盘大小的 komi (贴目)
+ * 来源: KataGo 官方 opening book (katagobooks.org)
+ * 这些是 fair komi (让黑白均势的贴目值)
+ * 偏离这些值会让 KataGo 胜率评估失真
  */
 export function getKomi(boardSize: number): number {
-  if (boardSize === 9) return 2.5;
-  if (boardSize === 13) return 3.5;
-  if (boardSize === 19) return 6.5;
+  if (boardSize === 9) return 7;     // katagobooks.org 9x9 TT book komi=7
+  if (boardSize === 13) return 7.5;  // 现代中国/AGA 规则标准
+  if (boardSize === 19) return 7.5;  // 现代中国/AGA 规则标准
   return 7.5;
 }
```

**验证**：
```bash
# 部署后立即跑
curl -sf -X POST https://letusgoa.cn/api/go-engine \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"action":"analyze","boardSize":9,"moves":[]}' | jq '.analysis.winRate'
# 应从 96.2% 回到 [40%, 60%]
```

---

### 🔧 Patch 2: scoreLead 视角统一（15 分钟）

**目的**：让 scoreLead 和 winRate 一样固定为黑方视角

**文件**：`src/app/api/go-engine/route.ts`（找 `parseKataAnalyze` 或 `getKataGoAnalysis` 函数）

**修改**：假设现有结构是：
```typescript
// 修改前
function parseKataAnalyze(output: string, isWhiteToMove: boolean) {
  // ... 解析各字段
  const winRate = isWhiteToMove ? 100 - rawWinrate : rawWinrate;
  const scoreLead = rawScoreLead;  // 🔴 没做视角转换
  // ...
}
```

改为：
```typescript
// 修改后
function parseKataAnalyze(output: string, isWhiteToMove: boolean) {
  // ... 解析各字段
  const winRate = isWhiteToMove ? 100 - rawWinrate : rawWinrate;
  // 🆕 scoreLead 和 scoreMean 都统一到黑方视角
  const scoreLead = isWhiteToMove ? -rawScoreLead : rawScoreLead;
  
  const bestMoves = rawBestMoves.map(m => ({
    move: m.move,
    winrate: isWhiteToMove ? 100 - m.winrate : m.winrate,
    scoreMean: isWhiteToMove ? -m.scoreMean : m.scoreMean,  // 🆕
    visits: m.visits,
  }));
  
  return { winRate, scoreLead, bestMoves };
}
```

**验证**：
```bash
# 黑下一手（白方要下），scoreLead 应是正（黑方刚下一步先手优势）
curl -sf -X POST ... -d '{"action":"analyze","boardSize":9,"moves":[{"row":4,"col":4,"color":"black"}]}' | jq '.analysis.scoreLead'
# 修复前: -4.1 (负)
# 修复后: +4.1 (正，和 winRate>50% 符号一致)
```

---

### 🔧 Patch 3: rules 从 tromp-taylor 改 chinese（10 分钟）

**目的**：使用对中国用户友好的规则（friendlyPassOk=true，suicide=false）

**文件**：`Dockerfile` 或 `/usr/local/katago/gtp.cfg`（生产路径）

**修改**：
```diff
# gtp.cfg
- rules = tromp-taylor
+ rules = chinese
```

如果 rules 在代码里动态传（通过 GTP `kata-set-rules chinese` 命令），改对应代码：
```diff
 // src/app/api/go-engine/route.ts PersistentKataGo.setup 函数
-const setupCmds = [`boardsize ${boardSize}`, `clear_board`];
+const setupCmds = [
+  `boardsize ${boardSize}`,
+  `kata-set-rules chinese`,   // 🆕 显式设置规则
+  `clear_board`,
+];
```

**验证**：
```bash
# 手动执行 GTP
echo -e "boardsize 9\nkata-get-rules\nquit" | katago gtp -config /usr/local/katago/gtp.cfg
# 应返回: {"friendlyPassOk":true,"hasButton":false,"ko":"SIMPLE","scoring":"AREA","suicide":false,"tax":"NONE","whiteHandicapBonus":"N"}
```

---

### 🔧 Patch 4: API 返回 komi/rules 方便对账（30 分钟）

**目的**：前端能验证"实际用的 komi/rules 是什么"，长期防止两端漂移

**文件**：`src/app/api/go-engine/route.ts`

**修改**：在分析响应里加两个字段
```diff
 const analysisData = {
   winRate,
   scoreLead,
   bestMoves,
   actualVisits,
+  // 🆕 echo 回实际用的参数，方便前端对账/调试
+  komi: komiUsed,
+  rules: rulesUsed,
 };
```

**前端修改**（可选）：`src/app/page.tsx` 的 UI 显示改用后端返回的 komi：
```diff
-<span>含贴目{getKomi(boardSize)}</span>
+<span>含贴目{latestAnalysisRef.current?.komi ?? getKomi(boardSize)}</span>
```

---

### 🔧 Patch 5: gtp.cfg 加固（15 分钟）

**文件**：`/usr/local/katago/gtp.cfg`

**修改**：
```diff
 # 日志
 logDir = gtp_logs
-logAllGTPCommunication = false
+# 生产关闭，出问题时打开
+logAllGTPCommunication = false
+logErrorsAndWarnings = true

 # 规则
-rules = tromp-taylor
+rules = chinese

+# 分析视角统一为黑方
+reportAnalysisWinratesAs = BLACK
+analysisPVLen = 15
+analysisIgnorePreRootHistory = true

 # 搜索
-maxVisits = 50  # (之前版本遗留)
+maxVisits = 1000

+# Pass 和认输策略
+conservativePass = true
+friendlyPassOk = true
+enablePassingHacks = true
+assumeMultipleStartingBlackMovesAreHandicap = true
+resignMinMovesPerBoardArea = 0.25   # 前 25% 步数不认输

 # 线程
 numSearchThreads = 2
 nnMaxBatchSize = 8

-# humanSLProfile 删除（对 rect15 模型无效且产生 warning）
-humanSLProfile = preaz_5k

 # ❌ 删除以下行（KataGo 会标记为 unused）
-# komi = 2.5
```

---

### 🔧 Patch 6: kata9x9 模型部署（2 小时，最耗时的一步）

**目的**：9x9 用官方专用网络，棋力 +200 Elo

**文件**：`Dockerfile`

**修改**：
```diff
 # 下载 KataGo 主模型
 COPY rect15-b20c256-s343365760-d96847752.bin.gz /usr/local/katago/
+
+# 🆕 下载 9x9 专用模型（97MB）
+RUN wget -q -O /usr/local/katago/kata9x9-b18c384nbt.bin.gz \
+  https://github.com/lightvector/KataGo/releases/download/v1.13.2-kata9x9/kata9x9-b18c384nbt-s6603587840-d252232394.bin.gz
```

**代码修改**：`src/app/api/go-engine/route.ts`

```diff
 function findKataGoModel(boardSize?: number): string {
-  // 当前：总是返回 rect15
-  return "/usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz";
+  // 按棋盘大小路由
+  if (boardSize === 9) {
+    return "/usr/local/katago/kata9x9-b18c384nbt.bin.gz";
+  }
+  return "/usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz";
 }
```

**注意**：当前架构是单 KataGo 持久进程，切换模型需要重启进程。这会引入额外的 cold-start 延迟。**短期处理**：第一次 9x9 请求时延迟 1-2 秒（加载新模型），之后正常。**长期**：见阶段 2 的多进程池方案。

---

## 部署顺序建议

```
1. Patch 1 + 2 + 3 (komi/视角/规则) 合成一个 PR
   - 最安全，改动小，收益大
   - 部署后立即验证空棋盘 winRate

2. Patch 5 (gtp.cfg 加固) 独立 PR
   - 需要重新 build Docker
   - 部署后观察 warning 日志

3. Patch 4 (API 返回 komi/rules) 独立 PR
   - 纯添加字段，不破坏现有调用方
   - 方便后续对账

4. Patch 6 (kata9x9 模型) 独立 PR
   - 改 Dockerfile，镜像变大
   - 需要更多测试（9x9 棋力对比）
```

## 回滚策略

每个 Patch 失败时的回滚：

| Patch | 症状 | 回滚动作 |
|---|---|---|
| 1 (komi) | 9x9 胜率突然变成其他极端值 | revert commit，查是否有其他代码路径用 getKomi |
| 2 (视角) | 解说说反话 | revert，查是否后端其他地方也依赖旧视角 |
| 3 (rules) | 进程启动失败 | revert；模型可能不支持 chinese（检查 kata-get-rules） |
| 5 (gtp.cfg) | 进程加载失败 | revert；Docker logs 查 unused warning |
| 6 (kata9x9) | 9x9 响应变慢 | revert；或单独回退模型路由 |

## 验证 checklist（每个 Patch 都要跑）

```bash
# 1. 部署前
cd your-project
git status  # clean
./scripts/run-gold-tests.js  # 本地 CI

# 2. 部署
git push railway main  # or your deploy flow

# 3. 部署后 5 分钟内
TOKEN=<smoke-test-token> ./smoke-test.sh https://letusgoa.cn

# 4. 部署后 1 小时
# 查 production logs 有没有新 warning/error
railway logs --tail 1000

# 5. 部署后 24 小时
# 看监控数据：
#   - pass 频率是否下降
#   - winrate 极端值频率是否下降
#   - 用户投诉是否减少
```
