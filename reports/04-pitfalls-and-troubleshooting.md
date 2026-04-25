# KataGo 实测坑点大全（"结果不稳定/差异大"完整排查手册）

这是围绕"结果不稳定"这个核心痛点整理的 checklist。按**优先级**排，遇到问题从上往下排查。

---

## 🔴 P0：导致"同局面多次运行结果差异巨大"的根因

### 1. `chosenMoveTemperature` 在作祟（GTP 模式下）

**症状**：用 GTP 模式 `genmove` 对同一局面多次，返回不同的手。
**原因**：GTP 默认 `chosenMoveTemperatureEarly = 0.5` + `chosenMoveTemperature = 0.10`，开局阶段按 `playSelectionValue` 的温度幂**随机抽样**选点，不是 argmax。
**定位**：`kata-analyze` 看到的 `order=0` 那手 ≠ `genmove` 实际下出来的手。
**修复**：
- 若要对弈有变化：保持默认
- 若要确定性：在 config 里设 `chosenMoveTemperatureEarly = 0` 和 `chosenMoveTemperature = 0`
- 或改用 Analysis Engine（天然无此温度）

### 2. `wideRootNoise` 引入根节点策略噪声

**症状**：Analysis Engine 对同一 query 多次，候选手的 visits 分布波动。
**原因**：`analysis_example.cfg` 默认 `wideRootNoise = 0.04`（注释掉但注释里说明默认值）；`gtp_example.cfg` 里 **分析指令**（kata-analyze）的 `analysisWideRootNoise = 0.04`。
**修复**：
```json
"overrideSettings": {"wideRootNoise": 0.0}
```
或在 config 文件里 `wideRootNoise = 0.0`。

### 3. NN cache + 对称性随机化混合出的"伪确定性"

**症状**：跑两次相同 query 完全一致；但把另一个不同 query 穿插进来后再跑，就不一致了。
**原因**：`nnRandomize = true`（默认）让每次 NN 评估从 8 个对称中随机选 1 个。**但如果结果被 cache 了**，下次命中直接用上次的随机结果 → 看起来确定。一旦 cache 被替换/清空，再次评估会换个对称，结果变了。
**修复**（确定性测试专用）：
```
nnRandomize = false   # 禁用对称随机
```
并在每次 query 前发 `{"action":"clear_cache","id":"..."}`。

### 4. 多线程 MCTS 调度非确定性

**症状**：single-threaded 稳定，多线程时微幅波动。
**原因**：多个 search thread 抢扩展同一棵树时，因 OS 调度导致扩展顺序不同。
**修复**：
```
numSearchThreadsPerAnalysisThread = 1
```
注意这样性能会下降很多，只适合**确定性测试场景**，正式服务不能这样配。

### 5. `rootNumSymmetriesToSample` 不为 1

**症状**：同局面下 `rootInfo.rawWinrate` 每次略有浮动。
**原因**：根节点对 1~8 个对称旋转采样并平均，默认 1，设为 >1 会降噪但轻微非确定（除非 cache 命中）。

---

## 🟠 P1：导致"数值看起来很怪/和预期差异大"的根因

### 6. 视角没对齐（`reportAnalysisWinratesAs`）

**症状**：Analysis Engine 返回的 winrate/scoreLead 有时"和直觉相反"。
**原因**：Analysis Engine 的 **默认是 `BLACK`**，**不是当前手方**。前端如果默认按"当前手方"解释，白棋要下时看到的 winrate 就是反的。
**修复**：
- 前端明确：一个 session 只用一种视角（推荐 `BLACK` 或 `SIDETOMOVE`）
- 换视角时：`score_for_current_player = BLACK_score * (current_is_black ? 1 : -1)`

### 7. 规则没对齐（komi、scoring）

**症状**：终局时 `scoreLead` 差了 1 目或 0.5 目。
**原因**：
- 前端用中国规则贴 7.5，KataGo 默认 territory 贴 6.5
- `hasButton=true` 下默认 komi 是 7.0
**修复**：**永远显式传 komi**，永远显式传 rules；不要依赖默认值。

### 8. Analysis Engine 用 `initialStones` 导致 ko 失效

**症状**：某些打劫局面，KataGo 建议的手**在真实对弈里是违法的**（刚被提的劫不能立刻回提）。
**原因**：`initialStones` 不保留手序 → 没有 ko 禁入记录。
**修复**：**能用 `moves` 就用 `moves`**，即使棋谱很长。只有 tsumego 或无合法手序的局面才用 `initialStones`。

### 9. handicap 局面下 `whiteHandicapBonus` 错配

**症状**：让子棋里 scoreLead 有一个持续的奇怪偏移（如 2 目或 3 目）。
**原因**：`whiteHandicapBonus` 默认由规则决定：
- `chinese`：`"N"`（白方加 N 目，抵消让子）
- `aga`：`"N-1"`
- `japanese` / `tromp-taylor`：`"0"`

如果你前端按 "N-1" 算，KataGo 按 "N" 算，就会持续差 1 目。

**修复**：**让子棋时显式传 `whiteHandicapBonus`**，不要依赖 rules 默认：
```json
{"rules":"chinese", "whiteHandicapBonus":"0", "komi": 0.5}
```
（然后自己在前端计算让子补偿，最简单）

### 10. 让子棋用连续 `play B` 摆子，没开 `assumeMultipleStartingBlackMovesAreHandicap`

GTP 下有些前端这样摆让子：
```
play B Q4
play B C4
play B Q16
play B C16
```
KataGo 默认会把这当成真的连续下（黑方放弃权限），但贴目计算会错。
**修复**：config 里确认 `assumeMultipleStartingBlackMovesAreHandicap = true`（默认是 true，但有些精简配置文件删了）。

### 11. scoreStdev **系统性偏大**（文档明说）

**症状**：scoreStdev 总是 20+，看起来不确定度很高。
**原因**：MCTS 机制导致 scoreStdev **存在已知的正向偏差**。
**修复**：**只把它当相对指标用**（比较两手的不确定度），**不要当真实 stdev**。看真实短期不确定度用 `rootInfo.rawStScoreError`。

### 12. `scoreMean` ≠ "得分均值"

**症状**：以为 `scoreMean` 是分布的 mean、`scoreLead` 是 median 之类，其实两者完全相同。
**事实**：`scoreMean` **就是 `scoreLead` 的别名**，留着只是为了兼容旧工具。推荐只用 `scoreLead`。

### 13. `rootInfo.winrate` vs `moveInfos[0].winrate` 不同

**症状**：页面左上角"总体胜率"和"最佳手预估"不一致。
**原因**：
- `rootInfo.winrate` 是**全树平均**（平滑、滞后）
- `moveInfos[0].winrate` 是**最佳手的子树平均**（更新及时、波动大）

低 visits 时两者差距明显，高 visits 下会收敛。
**修复**：选一个坚持用。推荐给用户展示的是 `rootInfo`，决策用 `moveInfos[0]`。

### 14. `isDuringSearch=true` 的中间结果被当最终结果

**症状**：开了 `reportDuringSearchEvery` 或前端自己定了轮询，把中途的数据当成结论。
**修复**：**只信 `isDuringSearch=false` 的响应**。流式 UI 可以展示中间结果但不要落库。

---

## 🟡 P2：导致"结果不如其他工具"的原因

### 15. visits 太少

Analysis Engine config 默认 `maxVisits = 500`。对严肃分析偏少。
- 快速胜率条：500 可以接受
- 判断最佳手：建议 ≥ 2000
- 官子精准度：建议 ≥ 5000
- 死活题：建议 ≥ 10000，且可能需要 `wideRootNoise` 略放大

### 16. 网络太旧

- 2020 前的 g170 系列网络：缺很多改进（uncertainty weighting、nested bottleneck 等）
- 当前推荐：`kata1-b18c384nbt-sNNN.bin.gz`（v1.15 之后）或更大的 `b28c512nbt`
- 千万别用 v1.3 之前的网络，很多规则选项不支持

### 17. Eigen (纯 CPU) 模式下开了过多线程

**症状**：CPU 跑 KataGo，`numSearchThreadsPerAnalysisThread = 16`，以为会更快，其实更慢。
**原因**：Eigen 后端本身会在 NN 评估里用多线程；再叠加外层搜索线程会竞争。
**修复**：Eigen 后端 `numSearchThreadsPerAnalysisThread` 建议 2~4，并让 `numEigenThreadsPerModel ≈ CPU 核数 / numSearchThreads`。

### 18. GPU batching 没吃满

**症状**：GPU 利用率长期 <50%，性能远低于 benchmark 值。
**排查**：
- 实际并发 query 数有没有达到 `numAnalysisThreads`？
- `nnMaxBatchSize` 是否 ≥ `numAnalysisThreads * numSearchThreadsPerAnalysisThread`？
- 用 `kata-benchmark` 跑一下看理论峰值多少。

### 19. FP16 / backend 不对

- CUDA < 7.5 compute capability：FP16 其实是模拟，不快反慢。`cudaUseFP16 = false` 更好。
- TensorRT：第一次启动要**编译 engine**，耗时几分钟，期间没输出让人以为卡死。后续启动读缓存很快。
- OpenCL：首次需 **tuning**，20 分钟起步。tuning 缓存建议持久化（默认在 `~/.katago/opencltuning/`）。

### 20. 对称剪枝 (`rootSymmetryPruning`) 让数据看起来"少"

**症状**：某些手的 `visits = 0` 但 `order` 不是特别靠后。
**原因**：开启了对称剪枝，对称等价的手只搜了一个，其他的数据**复制过来**（`isSymmetryOf` 字段指向原手）。
**修复**：如果要"每手都真实搜过"，设 `rootSymmetryPruning = false`。但这样浪费算力。

---

## 🟢 P3：少数人会踩的冷门坑

### 21. Japanese 规则 + 无超级劫 → noResult 概率非 0

日规没有超级劫概念，三劫真的会无胜负。`scoreLead` 和 `winrate` 的含义在这种场景下比较微妙：
- `winrate` 不含 noResult 概率（黑胜 + 白胜 = 1 - noResult）
- 需要 `includeNoResultValue: true` 才能拿到明确的 `noResultValue`

### 22. `avoidMYTDaggerHack` 默认 false

某些网络对 MYT 刺手定式有已知误判。如果你的 AI 总是被人用这个套路坑，加：
```
avoidMYTDaggerHack = true
```

### 23. 分析阶段的 `analysisIgnorePreRootHistory` 和 play 阶段的 `ignorePreRootHistory` 不一样

GTP 配置里两个开关是分开的：
- `analysisIgnorePreRootHistory`：影响 `kata-analyze` 时
- `ignorePreRootHistory`：影响 `genmove` 时（通常不建议开，对弈需要历史）

### 24. `enablePassingHacks` 默认 true

为了修复"pass 把搜索搞乱"的 bug 加的小 hack。大多数时候不用管，但做严格复现实验时可能影响结果。

### 25. 对抗性弱点：Circulation Ko Attack / Early Stop Bug

2022 年 MIT & FAR 的论文发现 KataGo 在特定对抗样本下会严重误判（"循环劫攻击"、"过早停手"）。这些攻击在**正常对弈**里几乎遇不到，但你的 AI 面对**恶意客户端/作弊玩家**时可能崩溃。
- 修补：使用 v1.15+ 加了 `enablePassingHacks` 的版本
- 监控：在你的服务端跑"合理性检查"——AI 若在明显占优时投降或明显形势下强行 pass，报警

---

## 坑点速查决策树

```
现象：同局面多次结果不同？
├─ GTP 下 genmove → 多半是 chosenMoveTemperature（见 #1）
├─ Analysis 下 winrate 小幅波动
│   ├─ 多线程？ → 见 #4
│   ├─ wideRootNoise ? → 见 #2
│   └─ 偶发抽样对称 → 见 #3/#5
└─ 差异超过 5%？ → 可能 visits 太低（#15）或触发真实 blind spot

现象：数值和预期差很大？
├─ 正负号错？ → reportAnalysisWinratesAs (#6)
├─ scoreLead 有固定偏移？
│   ├─ 让子棋？ → whiteHandicapBonus (#9)
│   └─ 规则？ → komi + rules 不匹配 (#7)
├─ 有打劫的局面 AI 选了违法手？ → initialStones 问题 (#8)
└─ 总体胜率和最佳手胜率不符？ → rootInfo vs moveInfos (#13)

现象：性能不达预期？
├─ GPU 利用率低？ → #18
├─ 首次启动慢？ → TensorRT compile / OpenCL tune (#19)
└─ CPU 模式慢？ → Eigen 线程设置 (#17)
```

