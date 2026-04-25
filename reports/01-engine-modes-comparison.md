# KataGo 引擎模式对比：GTP vs Analysis Engine

> 资料来源：
> - https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md
> - https://github.com/lightvector/KataGo/blob/master/docs/GTP_Extensions.md
> - https://github.com/lightvector/KataGo/blob/master/cpp/configs/analysis_example.cfg

## TL;DR

| 维度 | GTP（`katago gtp`） | Analysis Engine（`katago analysis`） |
|---|---|---|
| 启动命令 | `katago gtp -config gtp.cfg -model model.gz` | `katago analysis -config analysis.cfg -model model.gz` |
| 输入协议 | GTP 纯文本命令（同步、阻塞、单会话） | 单行 JSON，stdin/stdout，**异步**，可乱序回复 |
| 典型场景 | 实际对弈（对接 GUI / OGS / KGS） | 分析服务后端、批量析谱、自动化工具 |
| 并行能力 | 单局面多线程 MCTS；不能跨局面批处理 | **同时分析多个局面**，跨局面 GPU 批处理 |
| 随机性控制 | 有 `chosenMoveTemperature*` 随机选点；默认随机 | 默认**无随机选点温度**，只有 NN 对称性随机 |
| 规则切换 | `kata-set-rules <ruleset>` 动态切换 | 每次 query 中传入 `rules` 字段 |
| 胜率视角 | 默认当前手（SIDETOMOVE） | 受 `reportAnalysisWinratesAs` 控制（默认 **BLACK**） |
| 典型前端 | Sabaki / Lizzie / KaTrain / katrain / GoReviewPartner | 自研网站后端、批量 review 脚本 |

**如果你做的是"围棋游戏网站"，需要分清两个子场景：**

1. **人机对弈（bot 走棋）** → 用 **GTP**，或者用 analysis engine 自己做落子决策逻辑。GTP 本身就支持 pondering、时间控制、genmove 的温度随机化。
2. **局面分析 / 复盘 / 胜率标注** → 用 **Analysis Engine**，批量更快，接口更稳。

混用两套接口做同一件事时，最容易出"结果差异大"的现象——**不是 bug，是两套接口默认配置和默认温度策略不一样**。

## 核心差异细节

### 1. 视角差异（**极高概率导致"结果和预期差异很大"**）

- **GTP (`kata-analyze`)**：所有 `winrate` / `scoreLead` 默认是 **当前要下子的一方** 的视角。
- **Analysis Engine**：默认 `reportAnalysisWinratesAs = BLACK` → 无论谁该下，都以**黑棋**视角报告。
  - 可改为 `WHITE` 或 `SIDETOMOVE`。

👉 如果你在前端直接展示数字而没做视角转换，看到的胜率会"一会儿在说黑棋，一会儿在说白棋"，很容易以为是 bug。

### 2. 随机性差异（**"同一局面跑两遍结果不同"的第一嫌疑**）

两种模式都存在的随机源：
- `nnRandomize = true`（默认）：每次 NN eval 随机选 8 种对称旋转之一。若 NN cache 已命中则不会重新随机。
- `wideRootNoise`（analysis 默认 **0.04**，gtp 默认 0.0 除非是分析指令）：在根节点加策略噪声以扩展搜索面。
- `rootNumSymmetriesToSample`（默认 1）：根处对 NN 做多少次对称旋转采样后平均。
- MCTS 线程调度非确定性：多线程时 PUCT 扩展顺序会因线程竞争微变。

GTP 特有：
- `chosenMoveTemperatureEarly = 0.5`、`chosenMoveTemperature = 0.10`：**对弈时按此温度随机选点**（不是完全 argmax！）。
- `chosenMoveTemperatureHalflife = 19`：随棋局进展温度衰减。

👉 要做确定性测试，必须同时：
1. 用 Analysis Engine（天然无选点温度）
2. 设置 `numSearchThreadsPerAnalysisThread = 1`（单线程避免调度抖动）
3. `nnRandomize = false`
4. 每次 query 前发 `clear_cache`（否则命中 cache 的对称结果是"上次的随机结果"，会诱导"假确定性"）
5. `overrideSettings: {wideRootNoise: 0.0, rootNumSymmetriesToSample: 1}`

### 3. 搜索预算差异

Analysis Engine 配置示例里 **默认 `maxVisits = 500`**，对于严肃分析是远远不够的。不少实测不稳定是因为 visits 太少、MCTS 没收敛。

GTP 默认没有 maxVisits，而是靠 `maxTime` / byoyomi 控制。若你把 GTP 的 kata-analyze 输出当成 ground truth，而 Analysis Engine 用默认 500 visits，两边结果天然会差。

### 4. 批处理 & 线程差异

Analysis Engine 有两级并发：
- `numAnalysisThreads`：同时分析的**局面数**
- `numSearchThreadsPerAnalysisThread`：每个局面内的 MCTS 线程数

**错误搭配**：
- 只有少量请求时用 `numAnalysisThreads=32, numSearchThreadsPerAnalysisThread=1` → GPU 空转
- 大量请求时用 `numAnalysisThreads=2, numSearchThreadsPerAnalysisThread=16` → 吞吐低

**GPU 批处理大小**：`nnMaxBatchSize` 应该 ≥ `numAnalysisThreads * numSearchThreadsPerAnalysisThread`，否则 GPU 吃不饱。

### 5. 规则的 history 处理差异

Analysis Engine：
- 默认 `ignorePreRootHistory = true`（忽略到达当前局面的手序，消除历史偏差）
- 如果用 `initialStones` 而非 `moves` 传入局面，**不会有 ko/superko 记录**。

GTP：
- 逐手 `play` 累积棋盘状态，自然保留 ko 历史。
- `set_position` 也是不保留手序。

👉 **对于有 ko 的局面，用 Analysis Engine 的 `initialStones` 传入时可能丢失 ko 禁入点**，导致 KataGo 认为某些违法着法是合法的，结果和实际对弈偏差。一定要用 `moves` 字段传棋谱。

## 选型建议（针对"围棋游戏网站"）

| 需求 | 推荐接口 | 关键参数 |
|---|---|---|
| 陪人下棋的 AI 对手 | **GTP**（或 analysis + 自己选点） | 合适的 `chosenMoveTemperature` 让棋局有变化 |
| 让子棋 AI | GTP | 开启 `dynamicPlayoutDoublingAdvantageCapPerOppLead` |
| 局面胜率条、推荐点 | **Analysis Engine** | 关闭 `wideRootNoise`，高 visits，fix `reportAnalysisWinratesAs` |
| 复盘 / 标注每步好坏 | **Analysis Engine** | `analyzeTurns=[0..N]` 一次批量 |
| 形势判断 / 死活标注 | Analysis Engine + `includeOwnership:true` | ownership 值绝对值越接近 1 越确定 |
| 判断地盘归属 | Analysis Engine + `includeOwnership:true` | 以 0 为阈值判黑白；用 ownershipStdev 看置信度 |

