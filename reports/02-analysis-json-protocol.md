# Analysis Engine JSON 协议完整字段速查

> 完整文档：https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md

## 协议基本规则

1. **每一行一个 JSON**：query 和 response 都是单行 JSON，不允许换行。
2. **异步**：请求可以连发，响应顺序可能与请求顺序不同，用 `id` 字段匹配。
3. **一次请求可多次响应**：`analyzeTurns` 数组指定多个 turn 时每个 turn 出一条响应。
4. **每个 query 最终**会有一条 `isDuringSearch=false` 的最终响应，用它判断"这个 turn 分析完了"。
5. stdin 关闭后引擎会处理完队列再退出；加 `-quit-without-waiting` 则立即停。

## 查询字段（query）

### 必填
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 查询 ID，响应会原样回带。**必须唯一**，否则 terminate 等功能会混淆 |
| `moves` | `[["B"\|"W", "C4"]...]` | 棋谱手序。**空位面请留空数组，不要伪造手序** |
| `rules` | string \| object | 规则。见 [03-rulesets.md](./03-rulesets.md) |
| `boardXSize` | int | 宽。>19 需自行编译 `MAX_LEN` |
| `boardYSize` | int | 高 |

### 强烈建议填
| 字段 | 类型 | 说明 |
|---|---|---|
| `komi` | float (0.5 步长) | 贴目。默认 area 7.5 / territory 6.5 / button 7.0。范围 [-150, 150] |
| `analyzeTurns` | `[int]` | 要分析的回合。0=初始，1=第一手后，…。默认只分析最后一手后 |
| `maxVisits` | int | 本次查询的最大 visits。覆盖 config 里的值 |

### 局面定制
| 字段 | 说明 |
|---|---|
| `initialStones` | `[[color, vertex]]` 预置棋子（无手序）。**有 ko 的局面慎用** |
| `initialPlayer` | 起始手方，当 `moves` 为空时有用 |
| `whiteHandicapBonus` | `"0"` / `"N-1"` / `"N"` 覆盖规则的让子贴目 |

### 输出控制（新手常漏配，然后抱怨"拿不到 xxx"）
| 字段 | 说明 |
|---|---|
| `includeOwnership` | 返回整局 ownership 热力图。**内存翻倍** |
| `includeOwnershipStdev` | ownership 的 stdev |
| `includeMovesOwnership` | 每个候选着法的 ownership |
| `includePolicy` | 返回神经网络原始 policy（长度 X*Y+1，最后是 pass） |
| `includePVVisits` | PV 每步的 visits |
| `includeNoResultValue` | 打劫/循环的无胜负概率（日规关键） |

### 搜索行为微调
| 字段 | 说明 |
|---|---|
| `rootPolicyTemperature` | >1 使搜索更广。类似 gumbel 探索 |
| `rootFpuReductionMax` | 设为 0 让 KataGo 更愿意尝试各种手 |
| `analysisPVLen` | PV 返回长度上限 |

### 黑名单/白名单
| 字段 | 说明 |
|---|---|
| `avoidMoves` | `[{player, moves, untilDepth}]` 前 N 手禁下某些点 |
| `allowMoves` | 反向：只允许某些点（长度必须为 1） |

### overrideSettings（所有 config 里的搜索参数都能覆盖）

```json
"overrideSettings": {
  "playoutDoublingAdvantage": 0.0,
  "wideRootNoise": 0.0,
  "ignorePreRootHistory": true,
  "antiMirror": false,
  "rootNumSymmetriesToSample": 1,
  "humanSLProfile": "rank_3d",
  "cpuctExploration": 1.0,
  "winLossUtilityFactor": 1.0,
  "staticScoreUtilityFactor": 0.10,
  "dynamicScoreUtilityFactor": 0.30
}
```

⚠️ **陷阱**：如果把 `humanSLProfile` 等参数写在**外层** query JSON 里（而不是 `overrideSettings` 里），KataGo **会静默忽略**（会报 warning，但代码不一定处理）。开 `warnUnusedFields = true` 能捕获这类错误。

### 调度与中断
| 字段 | 说明 |
|---|---|
| `priority` | 高优先级的 query 先处理 |
| `priorities` | 配合 `analyzeTurns` 对每个 turn 设置不同 priority |
| `reportDuringSearchEvery` | 每 N 秒报告中间结果（响应里 `isDuringSearch=true`） |

## 响应字段（response）

### 顶层
- `id`：原样回传
- `turnNumber`：对应的 turn
- `isDuringSearch`：**true 表示中途快照，false 表示最终结果**。消费端应**只基于 isDuringSearch=false 的结果做决策**（除非你做流式 UI）
- `moveInfos`：候选着法数组
- `rootInfo`：根节点统计
- `ownership` / `ownershipStdev` / `policy` / `humanPolicy`：按配置返回

### moveInfos 每项（**重点！这里字段多到让人眼花**）

| 字段 | 含义 | 坑点 |
|---|---|---|
| `move` | 走法字符串，如 `"Q16"`、`"pass"` | |
| `visits` | 访问次数 | 这是 **child** 的 visits |
| `edgeVisits` | 根"想投入"的 visits | **transposition / 人类 SL 下会和 visits 不同** |
| `winrate` | 胜率 [0, 1] | **视角受 `reportAnalysisWinratesAs` 影响！** |
| `scoreLead` | 预测领先目数 | 推荐用这个 |
| `scoreMean` | 同 scoreLead | 为兼容旧工具，命名不准 |
| `scoreSelfplay` | 自对弈预测得分 | 有偏差，一般别用 |
| `scoreStdev` | 得分标准差 | 官方说法：**系统性偏大**，仅作相对指标 |
| `prior` | 策略先验 [0,1] | NN 原始 policy 经 softmax 温度后 |
| `utility` | 综合效用 [-C, C] | 结合胜率和得分 |
| `lcb` | winrate 的下界 | 用于推荐最优点 |
| `utilityLcb` | utility 的下界 | |
| `weight` / `edgeWeight` | 加权访问数 | 有 uncertainty-weighted MCTS 时 ≠ visits |
| `order` | KataGo 的排序（0 最佳） | 基于 `playSelectionValue` |
| `playSelectionValue` | 用于排序的分数 | GTP 下按此值的温度幂抽样选点 |
| `pv` | 主变 | 可能为空或很短 |
| `pvVisits` / `pvEdgeVisits` | PV 每步 visits | 需请求 `includePVVisits` |
| `isSymmetryOf` | 指向另一个对称手 | **重要**：此手**没真搜过**，数值抄过来的 |
| `ownership` / `ownershipStdev` | 361 floats | 需 `includeMovesOwnership` |

### rootInfo

| 字段 | 含义 |
|---|---|
| `visits`、`winrate`、`scoreLead`、`utility` | 全树统计 |
| `thisHash` | 局面唯一 hash（含 ko 禁入） |
| `symHash` | **对称等价的局面 hash 相同**。做去重时用 thisHash，做 book/缓存时用 symHash |
| `currentPlayer` | 当前手方 |
| `rawWinrate` / `rawLead` / `rawScoreSelfplay` / `rawNoResultProb` | **纯神经网络预测**，不经搜索 |
| `rawStWrError` / `rawStScoreError` | NN 自报的不确定度 |
| `rawVarTimeLeft` | NN 对"还需多少手才分清胜负"的估计 |

⚠️ **rootInfo 是整棵搜索树的平均**，相比之下 `moveInfos[0]`（最佳手）的数据**抖动更大但更及时**。你想展示"当前局面胜率"时：
- 要稳定、平滑的数字 → 用 `rootInfo.winrate`
- 要反映 KataGo 此刻的最佳评价 → 用 `moveInfos[0].winrate`

两者长期会一致，但短期（低 visits）差异明显。

## 特殊 action 查询

| action | 用途 |
|---|---|
| `query_version` | 查版本和 git_hash |
| `query_models` | 列出加载的模型（含是否是 humanSL） |
| `clear_cache` | 清空 NN cache。**想做确定性测试时每轮必发** |
| `terminate` | 终止指定 id 的查询 |
| `terminate_all` | 终止所有 |

被终止的 query 仍会返回一条 `{noResults: true}` 的终响应。

## 错误与告警

```json
{"error": "..."}                                       // 全局错误
{"error": "...", "field": "rules", "id": "q1"}         // 某字段解析错误
{"warning": "...", "field": "rules", "id": "q1"}       // 警告，但查询仍会继续
```

**强烈建议开 `warnUnusedFields = true`**，配合 CI 可以早期捕获拼写错误、参数放错层级等问题。

