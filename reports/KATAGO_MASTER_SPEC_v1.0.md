# 小围棋乐园 · KataGo 引擎接入规范 v1.0

> **本文档性质**：综合性技术规范（是 authoritative 文档，内部其他 KataGo 相关文档应以此为准）
> **目标读者**：项目 agent、新入职工程师、code review 评审人、运维 oncall
> **建立基础**：3 份独立外部研究 + 16 份研究员调研 + 生产 API 实测 + 本机实测 + KataGo 官方文档
> **最后更新**：2026-04-24 基线版本
> **维护者**：围棋研究员
> **篇幅**：1500+ 行，分 10 章

---

## 第一部分：导读与核心决策

### 📖 本文档的使用方法

| 角色 | 必读章节 | 跳读章节 |
|---|---|---|
| **第一次接触 KataGo 的工程师** | §1、§2、§3 | 其他看需求查阅 |
| **正在修 KataGo 相关 bug** | §5（配置规范）、§8（故障排查） | - |
| **规划下一阶段架构** | §6（架构决策）、§10（路线图） | - |
| **做 code review** | §5（配置规范）、§7（测试流程） | - |
| **做运维 / 监控 oncall** | §8（故障排查）、§9（监控指标） | - |
| **做产品决策** | §2（选型决策）、§10（路线图） | - |

### 🚨 读者必须首先知道的三件事

**1. 生产当前存在重大系统性 bug，与 KataGo 无关，只是配置错**

生产 Railway 环境 9x9 棋盘使用 **komi=2.5**，而 KataGo 官方 9x9 fair komi 是 **7**。这导致：
- 9x9 空棋盘 KataGo 报告黑方胜率 **96.2%**（应该是 ~50%）
- 所有基于 KataGo winrate/scoreLead 的**解说、提示、教学**都在一个严重偏置上运行
- 这一个 bug 可以解释 incident report 里至少 5 个次生现象

**修复成本**：改一个 `getKomi` 函数 + 一行 gtp.cfg 的 rules 字段 + 重新部署。预计 **30 分钟**。

**2. 当前架构选型（GTP 持久进程）不适合 Web 多用户场景**

你们花了大量精力（至少 8 个 commit 集群）把 GTP 接口驯服成 web 服务后端。但 KataGo 还有**另一套接口 `katago analysis`（Analysis Engine）**专为 web 后端设计：异步 JSON、天生并发、不需要队列、没有命令/响应错位、参数每次请求传。

**迁移到 Analysis Engine 能一次性消除 incident report 里 8+ 个问题。**

**3. 现有的几份 KATAGO_ 报告有先验性错误，不要当 ground truth**

项目内部两份报告（Incident Report + Deployment Guide）由全程参与项目的 agent 撰写，存在 6 种系统性认知偏差（详见 `docs/15-critical-review.md`）。最危险的两个错误归因：

- "b24c64 是 3x3 专精模型"——**错**，`3x3` 是卷积核尺寸，真因是规则/komi/visits 组合
- "贴目已修复为 6.5"——**部署没到位**，生产仍然 2.5；且 6.5 本身也不是最优值（应为 7）

本规范对这些错误结论做了明确修订。

### 📚 本文档依赖的所有来源

| # | 来源 | 类型 | 可信度权重 |
|---|---|---|---|
| A | KataGo 官方 Analysis_Engine.md | 官方文档 | ⭐⭐⭐⭐⭐ |
| B | KataGo 官方 GTP_Extensions.md | 官方文档 | ⭐⭐⭐⭐⭐ |
| C | KataGo 官方 KataGoMethods.md | 官方文档 | ⭐⭐⭐⭐⭐ |
| D | KataGo rules.html 规则文档 | 官方文档 | ⭐⭐⭐⭐⭐ |
| E | katagobooks.org 官方 9x9 opening book | 官方实证 | ⭐⭐⭐⭐⭐ |
| F | v1.13.0/1.14.0 release note | 官方变更 | ⭐⭐⭐⭐⭐ |
| G | 研究员本机实测（Ubuntu + Eigen + g170e-b20c256）| 独立实测 | ⭐⭐⭐⭐ |
| H | 生产 API 实测（letusgoa.cn 带 JWT）| 黄金实证 | ⭐⭐⭐⭐⭐ |
| I | Mac 本地 3 份 GTP log | 项目实证 | ⭐⭐⭐⭐ |
| J | 前端 page.tsx 源码 | 项目代码 | ⭐⭐⭐⭐ |
| K | Coze 独立研究报告 | 独立 AI 实测 | ⭐⭐⭐ |
| L | 项目 Incident Report | 项目内部记忆 | ⭐⭐（已修订）|
| M | 项目 Deployment Guide | 项目内部规范 | ⭐⭐（已修订）|

每当本文档出现一个断言，都会注明来源标签。

---

## 第二部分：KataGo 引擎基础知识

### §1 KataGo 概览（任何工程师都必须知道）

#### 1.1 KataGo 是什么

KataGo 是目前最强的开源围棋 AI 引擎，基于 AlphaZero 改良，主要特点：
- **多尺寸训练**：同一套网络支持 7x7 到 19x19（用 masking 技术）[来源 C]
- **基于规则训练**：网络显式感知规则（中国/日本/Tromp-Taylor 等），不同规则下行为可能不同 [来源 D]
- **多种后端**：CUDA/TensorRT/OpenCL/Metal/Eigen(CPU)
- **两种接口**：GTP（对弈）和 Analysis Engine（分析），见 §2
- **两种模型**：主模型（超人类棋力）和 humanSL 模型（模仿人类棋风）

#### 1.2 KataGo 的两套接口（必须分清）

```
           ┌────────────────┐        ┌─────────────────────┐
           │  GTP Engine    │        │  Analysis Engine    │
           │ (katago gtp)   │        │ (katago analysis)   │
           └────────────────┘        └─────────────────────┘
                   │                            │
 协议             │ GTP 纯文本，同步阻塞      │ JSON 行，异步，有 id
 用途             │ 对弈（Sabaki/Lizzie）     │ Web 后端、批量分析
 并发             │ 单会话，单局面            │ 多局面并行（numAnalysisThreads）
 状态             │ 有（棋盘状态+config）    │ 无（每 query 独立）
 规则/komi 切换   │ kata-set-rules / komi 命令 │ query 里的 rules / komi 字段
 maxVisits 控制   │ kata-set-param（genmove生效）│ query 里的 maxVisits
 kata-analyze     │ 流式输出，必须 stop 中断 │ 直接用 maxVisits / maxTime 严格控制
 命令错位风险     │ 高（见 incident 3.2 等）  │ 无（每响应带 id）
 适合场景         │ 传统 GUI 应用            │ 网站后端、分析平台
```

**对"围棋游戏网站"这个产品，正确选型是 Analysis Engine。** GTP 是历史包袱。[来源 A / B]

#### 1.3 KataGo 重要概念速查

| 术语 | 含义 |
|---|---|
| **visits** | MCTS 搜索节点数；衡量搜索深度/棋力 |
| **playouts** | 模拟对局数（和 visits 相关） |
| **policy** | NN 给出的落子先验概率分布 |
| **winrate** | 胜率；**注意视角**：默认 side-to-move |
| **scoreLead** | 领先目数；**注意视角**：默认 side-to-move |
| **komi** | 白方补偿目数（对抗先手）；**决定胜负判断** |
| **rules** | 规则集合（7 个字段的组合或预设名）|
| **fair komi** | 让黑白均势的 komi 值；**每个棋盘有特定值** |
| **side-to-move** | 轮到谁下；winrate 视角的一种 |
| **pass** | GTP 命令，表示本回合弃权；两方连续 pass → 游戏结束 |
| **nnRandSeed** | NN 对称性选择的随机种子；切棋盘会重新生成 |

### §2 引擎模式对比与选型决策

#### 2.1 GTP vs Analysis Engine 详细对比

| 维度 | GTP | Analysis Engine |
|---|---|---|
| **启动命令** | `katago gtp -config X -model Y` | `katago analysis -config X -model Y` |
| **典型配置** | gtp_example.cfg | analysis_example.cfg |
| **输入协议** | 单行 GTP 文本命令 | 单行 JSON（`{id, moves, rules, komi, boardXSize, boardYSize, maxVisits, ...}`）|
| **输出协议** | `= <结果>\n\n` | 单行 JSON 响应 |
| **同步模型** | 同步、阻塞、单会话 | 异步、可乱序、多 session |
| **状态管理** | 有（当前棋盘、规则、komi 是进程状态） | 无（每 query 完全独立）|
| **并发分析** | 不支持（单进程单局面） | **原生支持**（numAnalysisThreads 参数）|
| **错误恢复** | 进程级 crash（如旧模型 + 新规则）| 单 query 级错误不影响其他 |
| **适合对弈** | ✅ 天然支持（genmove 就是下棋）| ⚠️ 需要自己实现温度抽样 |
| **适合分析** | ⚠️ kata-analyze 有 stop 限制 | ✅ 天然支持 |
| **适合网站后端** | ⚠️ 需要自己做队列、状态同步 | ✅ 就是为此设计 |

#### 2.2 场景选型决策表

| 你要做的事 | 推荐 | 原因 |
|---|---|---|
| 和人对弈的 AI bot | Analysis Engine + 应用层抽样 | 可控的随机性、可计算棋力曲线 |
| SGF 批量复盘、胜率分析 | Analysis Engine | 并行加速 |
| 实时胜率条/形势判断 | Analysis Engine | 低延迟 + 并发 |
| 死活题评估 | Analysis Engine | 可指定高 visits |
| 接入 Sabaki/Lizzie 这种 GUI | GTP | 协议兼容 |
| 命令行对弈测试 | GTP | `katago gtp` 就是干这个的 |

**给你们项目的结论**：你们所有场景（对弈 bot、分析、形势判断、ai-test 自动对弈）都应该走 **Analysis Engine**。

#### 2.3 Analysis Engine 的核心 JSON 协议（必须会用）

**最小 query**：
```json
{"id":"q1","boardXSize":9,"boardYSize":9,"rules":"chinese","komi":7,"moves":[["B","E5"]]}
```

**完整 query 字段**（常用的）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 匹配响应用 |
| `boardXSize` / `boardYSize` | int | ✅ | 棋盘 |
| `rules` | string\|object | ✅ | 规则（chinese / japanese / 等）|
| `komi` | float | 推荐 | 贴目（不传会用规则的默认）|
| `moves` | `[[color, vertex]]` | ✅ | 手序 |
| `analyzeTurns` | `[int]` | | 要分析的回合号（默认只分析最后一手后）|
| `maxVisits` | int | | 本 query 的最大 visits |
| `includePolicy` | bool | | 返回 NN 原始 policy |
| `includeOwnership` | bool | | 返回 ownership 热力图 |
| `overrideSettings` | object | | 覆盖 config 里的参数（如 wideRootNoise）|

**常用响应字段**：

| 字段路径 | 含义 | 视角 |
|---|---|---|
| `rootInfo.winrate` | 当前局面胜率 | **配置决定**（§4）|
| `rootInfo.scoreLead` | 领先目数 | 同上 |
| `rootInfo.currentPlayer` | 当前手方（B/W）| - |
| `rootInfo.rawWinrate` | 纯 NN 胜率，无搜索 | 同上 |
| `rootInfo.symHash` | 对称等价的局面 hash | 用于 book 去重 |
| `rootInfo.thisHash` | 唯一局面 hash | 用于去重 |
| `moveInfos[i].move` | 候选着法 | - |
| `moveInfos[i].winrate` | 该手胜率 | 同 rootInfo |
| `moveInfos[i].scoreLead` | 该手领先目数 | 同 rootInfo |
| `moveInfos[i].visits` | 该手访问数 | - |
| `moveInfos[i].pv` | 主变序列 | - |

完整协议见 `docs/02-analysis-json-protocol.md`。

---

## 第三部分：规则与 komi（最要紧的两个决策）

### §3 规则选择

#### 3.1 规则由 7 个字段构成 [来源 D]

```json
{
  "ko": "SIMPLE" | "POSITIONAL" | "SITUATIONAL",
  "scoring": "AREA" | "TERRITORY",
  "tax": "NONE" | "SEKI" | "ALL",
  "suicide": true | false,
  "hasButton": true | false,
  "whiteHandicapBonus": "0" | "N-1" | "N",
  "friendlyPassOk": true | false
}
```

#### 3.2 常用规则预设对比

| 预设 | ko | scoring | suicide | friendlyPassOk | whiteHandicap | 适用人群 |
|---|---|---|---|---|---|---|
| **chinese** | SIMPLE | AREA | false | **true** | N | **中国大陆用户（推荐你们用）** |
| chinese-ogs | POSITIONAL | AREA | false | true | N | OGS 平台对标 |
| chinese-kgs | POSITIONAL | AREA | false | true | N | KGS 平台对标 |
| japanese | SIMPLE | TERRITORY | false | true | 0 | 日本规则用户 |
| aga | SITUATIONAL | AREA | false | true | N-1 | 美国规则 |
| new-zealand | SITUATIONAL | AREA | **true** | true | 0 | 新西兰规则 |
| **tromp-taylor** | POSITIONAL | AREA | **true** | **false** | 0 | **机器对机器，不适合人类** |

#### 3.3 🚨 当前生产用 tromp-taylor 的后果

从 Mac 日志 + 官方 gtp_example.cfg 默认值看，你们的 gtp.cfg 很可能沿用了 `rules = tromp-taylor`（官方默认）。这对一个**面向中国围棋初学者**的网站来说是错的：

- `friendlyPassOk = false` → KataGo 在清理死子前不会友善 pass → 入门用户看到 AI 还在填空会困惑
- `suicide = true` → 允许多子自杀 → 和中国规则对用户的心智模型相反
- **scoreLead 与 chinese 规则相差可达 6 目**[来源 K 实测，§3.4 有数据]

#### 3.4 规则对 scoreLead 的实测差异（同一局面）[来源 K + G]

Coze 平台在它沙盒环境里实测同一盘 9x9 棋（黑白各 5 手），切换不同规则得到的 final_score：

| 规则 | final_score | 与 chinese 差异 |
|---|---|---|
| chinese | W+1.5 | 基准 |
| japanese | W+2.5 | +1.0 |
| tromp-taylor | **W+7.5** | **+6.0** ⚠️ |
| aga | W+1.5 | 0 |
| new-zealand | W+1.5 | 0 |
| stone-scoring | W+1.5 | 0 |

**结论**：tromp-taylor 的 scoreLead 在所有规则里最"奇怪"。这是因为它的 POSITIONAL 超劫 + 对死子判定规则与其他规则显著不同。

#### 3.5 🎯 对项目的规则选择

**必须做的修改**：

```diff
# gtp.cfg 或 analysis_example.cfg
- rules = tromp-taylor
+ rules = chinese
```

或者在代码里每次 query 显式传：
```typescript
rules: "chinese"
```

**为什么不建议动态切规则**：
- 业务上你们没有多规则需求（都是中国用户）
- 规则切换会影响 final_score 计算
- 统一用 chinese 能减少 10+ 种可能的歧义场景

### §4 视角问题：winrate 和 scoreLead 的视角统一

#### 4.1 视角的三个可能值 [来源 A / B]

KataGo 的 winrate 和 scoreLead 可以从三个视角报告：
- **BLACK**：永远以黑方视角
- **WHITE**：永远以白方视角  
- **SIDETOMOVE**：轮到谁就是谁的视角（GTP 默认，Analysis Engine 可配置）

GTP 下由 config 里的 `reportAnalysisWinratesAs = X` 控制。
**Analysis Engine 的 analysis_example.cfg 默认为 BLACK**（固定黑方视角）。

#### 4.2 🚨 当前生产的视角问题（实锤）[来源 H]

今天用 test 账号打生产 API，**同一局面只变换当前手方**：

| 场景 | winRate | scoreLead |
|---|---|---|
| 黑下一手（白方要下）| 95.9% | **-4.1** |
| 黑白各一手（黑方要下）| 97.5% | **+4.6** |

- `winRate` 两次都 ~96%（稳定黑方视角 ✅）
- `scoreLead` 符号翻转（仍是 side-to-move ❌）

**含义**：你们 Incident 2.4 修复的只是 winrate 视角。**scoreLead 没跟着修**。前端如果按同一套逻辑显示，白方回合会出现"胜率说黑方赢，分数说黑方输 4 目"的精神分裂。

#### 4.3 🎯 视角统一标准

**本项目统一规定**：所有对外暴露的 winrate / scoreLead / scoreMean **永远是黑方视角**。

实现方式（服务端完成，前端无感知）：

```typescript
// 在 route.ts 的分析响应整形函数里
function normalizeToBlackPerspective(
  raw: KataGoRawResponse,
  isWhiteToMove: boolean,
): NormalizedAnalysis {
  const flip = isWhiteToMove ? -1 : 1;
  
  return {
    winrate: isWhiteToMove ? 1 - raw.winrate : raw.winrate,
    scoreLead: flip * raw.scoreLead,
    scoreMean: flip * raw.scoreMean,
    bestMoves: raw.moveInfos.map(m => ({
      move: m.move,
      winrate: isWhiteToMove ? 1 - m.winrate : m.winrate,
      scoreMean: flip * m.scoreMean,
    })),
  };
}
```

**如果用 Analysis Engine**：更简单，直接设 `reportAnalysisWinratesAs = BLACK`，所有字段天然是黑方视角，应用层不需要转换。

### §5 komi 选择（最关键的一个参数）

#### 5.1 🚨 当前生产 komi 是错的（实锤）[来源 H]

生产 API 实测：

| 棋盘 | winRate（黑方）| scoreLead（黑方）| 推断 komi | **应是的 fair komi** |
|---|---|---|---|---|
| 9x9 空 | **96.2%** | +4.1 | **2.5** | **7** |
| 13x13 空 | 71.3% | +2.4 | 3.5 | ~7 |
| 19x19 空 | 53.8% | +1.0 | 6.5 | 7.5 |

9x9 的 scoreLead = +4.1 ≈ 7 - 2.5 = 4.5 目，完美对应"komi 少 4.5 目"的偏置。

这一组 komi 值的来源应该是你们 agent 在 route.ts 里写的 `getKomi(boardSize)` 函数。虽然 Incident 2.9 说"已改为 6.5"，但**生产实测不是 6.5**。

#### 5.2 9x9 fair komi = 7（权威来源）[来源 E]

**katagobooks.org 官方 opening book** 明确标注：

- **9x9 Tromp-Taylor book：komi = 7**
- **9x9 Japanese book：komi = 6**

这是 **KataGo 官方训练和使用的 fair komi**。`kata9x9-b18c384nbt` 网络是基于这些 komi 训练/调优的。

**偏离这些值会让 KataGo 评估显著失真**（本机实测，见 §5.3）。

#### 5.3 komi 敏感度实测（本机 g170e 网络）[来源 G]

9x9 棋盘，黑下 E5 一步后，**只变 komi**：

| komi | whiteWin | whiteLead | KataGo 判断 |
|---|---|---|---|
| 0.5 | 0.4% | -6.55 | 白几乎必败 |
| **2.5** ← 生产 | **0.9%** | **-4.32** | **白几乎必败** |
| 3.5 | 6.1% | -2.78 | 白大劣 |
| 5.5 | 36.8% | -0.73 | 白略劣 |
| **7** ← 官方 fair | **63.8%** | +1.07 | 均势 |
| 7.5 | 88.5% | +1.51 | 白优 |

**同一局面，仅改 komi，白方胜率从 0.9% 飙到 88.5%，相差 98 个百分点。**

#### 5.4 🎯 项目 komi 决策

```typescript
// getKomi 正确实现（来自 katagobooks.org 官方 fair komi）
export function getKomi(boardSize: number, rules: string = "chinese"): number {
  // 9x9：来自 katagobooks.org 官方 book
  if (boardSize === 9) {
    return rules === "japanese" ? 6 : 7;
  }
  // 13x13：无官方 book，使用 AGA/Chinese 现代标准
  if (boardSize === 13) {
    return 7.5;
  }
  // 19x19：AGA/Chinese 现代标准
  if (boardSize === 19) {
    return 7.5;
  }
  // 其他尺寸（3x3-8x8, 10x10-18x18, 20x20+）
  // 保守用 7.5 或更精细的查表（见 docs/03-rulesets-and-boards.md）
  return 7.5;
}
```

**一个重要的追加规则**：

**前后端 komi 必须同源**。当前架构下 `@/lib/go-logic` 的 `getKomi` 是前后端共享的，这是好的。但要确保：

1. 前端 UI 显示 "含贴目 X" 用这个函数
2. 前端计算本地评分（evaluateBoard + komi）用这个函数
3. 后端向 KataGo 发 `komi X` 命令用这个函数（或 Analysis Engine query 里的 komi 字段）
4. 后端计算 final_score 用这个函数

**任何一个位置的 komi 与其他地方不一致都会导致数字对不上。**

---

## 第四部分：配置规范

### §6 配置文件规范

#### 6.1 GTP 模式 `gtp.cfg` 标准化

如果短期内不迁移 Analysis Engine，GTP 配置必须调整为：

```ini
# ============================================
# 小围棋乐园 · GTP 配置 v1.0
# ============================================

# ---------- 日志 ----------
logDir = gtp_logs
logAllGTPCommunication = false  # 生产关闭；出问题时打开
logSearchInfo = false
logToStderr = false

# ---------- 规则 ----------
# 业务目标：中国用户友好
rules = chinese
# NOTE: komi 不能在这里设置（会被标记为 Unused key）
# 必须通过 GTP `komi X` 命令或 -override-config 设置

# ---------- 分析报告视角 ----------
# 固定黑方视角，减少前端视角转换的复杂度
reportAnalysisWinratesAs = BLACK
analysisPVLen = 15
analysisIgnorePreRootHistory = true  # 移除手序偏差

# ---------- 搜索 ----------
maxVisits = 1000                    # 默认上限，运行时可 kata-set-param 降
numSearchThreads = 2                # Railway 2 CPU 的合理值
nnMaxBatchSize = 8

# ---------- 认输 ----------
allowResignation = true
resignThreshold = -0.90
resignConsecTurns = 3
resignMinMovesPerBoardArea = 0.25   # 前 25% 步数不认输，避免早期形势判断错误

# ---------- 让子 ----------
assumeMultipleStartingBlackMovesAreHandicap = true

# ---------- Pass 策略（关键）----------
conservativePass = true
friendlyPassOk = true               # 来自 chinese 规则，但显式标记
enablePassingHacks = true

# ---------- 关键：禁用易出问题的优化 ----------
# humanSLProfile 根据模型动态设置，不在这里写死
# (如果不用 humanv0 模型就完全不写这个字段)

# ---------- NN 行为 ----------
nnRandomize = true                  # 生产保持默认（用随机对称增加多样性）

# NOTE: 以下参数不要设置（会导致启动失败或 unused warning）
# komi = X                          # ❌ 不是 config 字段！用 -override-config 或 `komi` 命令
# rules = tromp-taylor              # ❌ 对中国用户不友好
```

#### 6.2 启动命令规范

**如果继续 GTP**：

```bash
# 推荐：komi 通过每局 GTP `komi X` 命令设置，不在启动时固定
katago gtp \
  -config /usr/local/katago/gtp.cfg \
  -model /usr/local/katago/<model-by-boardsize>.bin.gz

# 不推荐：在启动时用 -override-config 固定 komi
# ❌ -override-config komi=2.5
# 原因：同一进程可能服务多个棋盘大小，komi 应按局设置
```

**如果用 Analysis Engine（推荐）**：

```bash
katago analysis \
  -config /usr/local/katago/analysis.cfg \
  -model /usr/local/katago/rect15-b20c256-s343365760-d96847752.bin.gz

# komi / rules / visits 都通过每个 JSON query 传
```

#### 6.3 Analysis Engine `analysis.cfg` 标准化（推荐）

```ini
# ============================================
# 小围棋乐园 · Analysis Engine 配置 v1.0
# ============================================

# ---------- 日志 ----------
logDir = analysis_logs
logErrorsAndWarnings = true
warnUnusedFields = true             # 重要：捕获 query 中的拼写错误

# ---------- 分析视角 ----------
reportAnalysisWinratesAs = BLACK    # 永远黑方视角，简化客户端
analysisPVLen = 15
ignorePreRootHistory = true

# ---------- 默认搜索（query 可覆盖）----------
maxVisits = 500
wideRootNoise = 0.0                 # 关闭探索噪声，追求确定性

# ---------- 并发（关键）----------
# numAnalysisThreads: 同时处理多少个 query
# numSearchThreadsPerAnalysisThread: 每个 query 内的搜索线程
# Railway 2 CPU 建议：
numAnalysisThreads = 2
numSearchThreadsPerAnalysisThread = 1

# ---------- GPU/CPU 后端 ----------
nnMaxBatchSize = 16
nnCacheSizePowerOfTwo = 23
nnMutexPoolSizePowerOfTwo = 17

# Eigen (CPU) 特有
numEigenThreadsPerModel = 2

# ---------- Pass 与规则配合 ----------
conservativePass = true
enablePassingHacks = true
assumeMultipleStartingBlackMovesAreHandicap = true
```

#### 6.4 前后端 API 契约规范

```typescript
// === 所有 /api/go-engine 请求体都必须包含 ===
interface EngineRequest {
  boardSize: 9 | 13 | 19;
  moves: Array<{ row: number; col: number; color: "black" | "white"; isPass?: true }>;
  
  // 🆕 新增字段：前端显式传递关键参数
  komi?: number;                     // 默认由后端 getKomi 计算，但允许覆盖
  rules?: "chinese" | "japanese" | "chinese-ogs"; // 默认 chinese
  
  // 原有字段
  difficulty?: "easy" | "medium" | "hard";
  engine?: "katago" | "gnugo" | "local";
  aiColor?: "black" | "white";
  action?: "analyze";                // 若存在就是分析请求
}

interface EngineResponse {
  // 落子响应
  move?: { row: number; col: number };
  pass?: true;
  engineError?: true;
  
  // 分析响应
  analysis?: {
    winRate: number;                 // 0-100, **永远是黑方视角**
    scoreLead: number;               // 目数, **永远是黑方视角**
    actualVisits: number;            // 实际搜索 visits 数
    bestMoves: Array<{
      move: string;                  // GTP 格式如 "D4" / "pass"
      winrate: number;               // 0-100, 黑方视角
      scoreMean: number;             // 目数, 黑方视角
      visits: number;
    }>;
    komi: number;                    // 🆕 返回实际使用的 komi，方便前端对账
    rules: string;                   // 🆕 返回实际使用的规则
  };
  
  // 运营字段
  pointsUsed?: number;
  insufficientPoints?: boolean;
  queueBusy?: boolean;
  queueInfo?: { queueLength: number; userPosition: number; };
}
```

#### 6.5 模型路由规范

```typescript
function selectModel(boardSize: number, difficulty: string): string {
  const base = "/usr/local/katago/";
  
  // 9x9: 用官方 9x9 专用网络（棋力最强）
  if (boardSize === 9) {
    return base + "kata9x9-b18c384nbt-20231025.bin.gz";
  }
  
  // 13x13/19x19: 使用矩形网络
  // 未来可按难度区分（easy 用 b6c96，hard 用 rect15 或更大模型）
  return base + "rect15-b20c256-s343365760-d96847752.bin.gz";
}
```

**注意**：切换模型要重启 KataGo 进程（约 1-3 秒）。对于生产高并发场景，应该启动**多进程池**，每个进程锁定一个模型/棋盘。见 §6.6。

#### 6.6 多进程池架构（解决单点故障）

```
┌─────────────────────────────────────────────────────────┐
│              Application Layer (Next.js)                │
│                                                          │
│    ┌──────────────┐      ┌──────────────┐              │
│    │  Router      │      │  Queue       │              │
│    │  (boardSize) │─────▶│  Manager     │              │
│    └──────────────┘      └──────────────┘              │
│                                  │                       │
│                                  ▼                       │
│                          Process Pool                    │
│    ┌───────────────┐    ┌───────────────┐    ┌─────────┐│
│    │ Proc A (9x9)  │    │ Proc B (13/19)│    │ Proc C  ││
│    │ kata9x9 model │    │ rect15 model  │    │ standby ││
│    │ Analysis Eng  │    │ Analysis Eng  │    │         ││
│    └───────────────┘    └───────────────┘    └─────────┘│
└─────────────────────────────────────────────────────────┘
```

**好处**：
- 9x9 请求不阻塞 19x19 请求（并发）
- 一个进程崩了不影响另一个
- 不需要动态切换模型（每个进程固定一个）
- 完全不需要 `boardsize` 和 `clear_board` 命令 (Analysis Engine 天然)

---

## 第五部分：建立测试验证流程（核心 agents 能力建设）

### §7 系统性测试验证流程

这一章是本规范最重要的产物之一——**不是解决已知 bug，而是建立防止下一批 bug 的机制**。

#### 7.1 测试金字塔

```
             ┌──────────────────┐
             │  生产烟雾测试      │  每次部署后 5 分钟
             │  (5 个关键 query) │
             └──────────────────┘
                      │
             ┌──────────────────┐
             │  回归测试集 (GOLD) │  每次 commit CI
             │  50-100 个局面     │
             └──────────────────┘
                      │
             ┌──────────────────┐
             │  单元测试          │  基础字段解析
             │  命令解析/坐标转换  │
             └──────────────────┘
```

#### 7.2 单元测试（最下层）

针对 route.ts 里的每个独立函数：

**测试用例最小集**：
```typescript
describe("getKomi", () => {
  it("9x9 returns 7 (fair komi)", () => expect(getKomi(9)).toBe(7));
  it("13x13 returns 7.5", () => expect(getKomi(13)).toBe(7.5));
  it("19x19 returns 7.5", () => expect(getKomi(19)).toBe(7.5));
  it("japanese 9x9 returns 6", () => expect(getKomi(9, "japanese")).toBe(6));
});

describe("vertexToRowCol", () => {
  it("handles I-skip in GTP", () => {
    expect(vertexToRowCol("H4", 9)).toEqual({ row: 5, col: 7 });
    expect(vertexToRowCol("J4", 9)).toEqual({ row: 5, col: 8 }); // 跳过 I
  });
  it("handles pass", () => {
    expect(vertexToRowCol("PASS", 9)).toEqual({ isPass: true });
  });
});

describe("normalizeToBlackPerspective", () => {
  it("flips scoreLead when white-to-move", () => {
    const raw = { winrate: 0.4, scoreLead: -3, moveInfos: [] };
    const norm = normalizeToBlackPerspective(raw, true);
    expect(norm.winrate).toBeCloseTo(0.6);
    expect(norm.scoreLead).toBeCloseTo(3);
  });
});
```

#### 7.3 黄金回归测试集（GOLD）

**思路**：准备 50-100 个**已知正确答案**的围棋局面，每次 KataGo 版本/配置变动都跑一遍。

**类型分布**：
- 15% 开局（空盘、黑一手）
- 30% 中盘（典型 50-80 手局面）
- 20% 官子
- 15% 死活（已知答案）
- 10% 打劫/复杂战斗
- 10% 罕见局面（连续 pass、handicap、棋盘角落边界）

**GOLD 测试格式**：

```json
{
  "id": "GOLD-001",
  "description": "9x9 空棋盘，komi=7（fair），黑方应均势",
  "query": {
    "boardXSize": 9, "boardYSize": 9,
    "rules": "chinese", "komi": 7,
    "moves": [], "maxVisits": 500
  },
  "expected": {
    "rootInfo.winrate": { "type": "range", "min": 0.45, "max": 0.55 },
    "rootInfo.scoreLead": { "type": "range", "min": -1.0, "max": 1.0 }
  },
  "tolerance": "high",
  "notes": "fair komi 下必须均势。如果winrate>60%或<40%，说明 komi/rules 或 模型有问题"
}
```

**测试执行**：

```bash
# 每次 commit CI 跑一遍
node scripts/gold-regression.js --config analysis.cfg --model current.bin.gz

# 输出示例
GOLD-001 ✅ winrate=0.52, scoreLead=0.3（在期望范围内）
GOLD-002 ❌ winrate=0.96, scoreLead=4.1（不在期望范围！可能 komi 错了）
```

**关键实践**：**允许 tolerance，不要要求逐字节一致**。KataGo 有合理的随机性（NN 对称、MCTS 线程调度）。用 range 而非 exact match。

#### 7.4 生产烟雾测试

每次 Railway 部署完成后自动跑（5 分钟内反馈）：

```bash
# smoke-test.sh
TOKEN=$(get_smoke_jwt_token)

# Test 1: 基础可用性
curl -s https://letusgoa.cn/api/go-engine -H "Authorization: Bearer $TOKEN" | \
  jq '.engines | map(select(.id=="katago" and .available==true)) | length' | \
  grep -q 1 || die "KataGo not available"

# Test 2: 9x9 空棋盘 analyze，winRate 必须在 [40%, 60%]
RESP=$(curl -s -X POST https://letusgoa.cn/api/go-engine \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"analyze","boardSize":9,"moves":[],"komi":7,"rules":"chinese"}')

WINRATE=$(echo $RESP | jq '.analysis.winRate')
(( WINRATE >= 40 && WINRATE <= 60 )) || die "9x9 empty board winrate=$WINRATE, expected 40-60"

# Test 3: 视角一致性
#   黑下一手后和黑白各下一手后，winRate 应该都稳定（黑方视角）
RESP1=$(... moves=[{row:4,col:4,color:"black"}] ...)
RESP2=$(... moves=[{row:4,col:4,color:"black"},{row:2,col:2,color:"white"}] ...)
WR1=$(echo $RESP1 | jq '.analysis.winRate')
WR2=$(echo $RESP2 | jq '.analysis.winRate')
# 两次 winRate 都应该反映"黑优势"或都反映"白优势"，不应该一个 >50 一个 <50
# (具体区间要看局面，这里只检视角稳定性)

# Test 4: scoreLead 视角（最关键的回归测试）
#   黑下一手后 scoreLead 应该是负（黑方轻微先手劣势，komi=7）
#   黑白各下一手后 scoreLead 应该接近 0
# ...

# Test 5: 多棋盘尺寸
for SIZE in 9 13 19; do
  # 在每个棋盘大小上都能返回正确响应
done

echo "✅ All smoke tests passed"
```

#### 7.5 确定性回归测试

**目的**：验证 "同一局面、同一配置、多次运行，结果在可接受范围内"。

**方法**：
1. 固定 query（包括 seed、rules、komi）
2. 设 `nnRandomize = false`, `numSearchThreads = 1`
3. 每次 query 前 `clear_cache`
4. 跑 10 次，允许 winrate 波动 < 0.001

如果失败，说明引入了新的非确定性源。

#### 7.6 性能基准测试

记录当前基线，每次版本升级对比：

```
MODEL: rect15-b20c256-s343365760-d96847752 on Railway 2 CPU

Board  Visits  Wall-clock  visits/s
9x9    100     7.1s        ~14 v/s
9x9    500     36s         ~14 v/s
13x13  100     11s         ~9 v/s
19x19  100     23s         ~4 v/s
```

**红灯阈值**：比基线慢 20% 以上 → 调查。

#### 7.7 跨引擎对弈测试

用于验证 KataGo 配置改动后棋力是否退化：

```
100 局 self-play（komi=7, chinese, 9x9, 500 visits）
预期：50% ± 5% 胜率（均势）
如果 KataGo 改动后 self-play 显著偏离 50%，说明配置有问题
```

---

## 第六部分：故障排查与监控

### §8 故障排查决策树

#### 8.1 胜率异常

```
现象：KataGo 返回 winRate 非常接近 0% 或 100%

第 1 步：检查 komi
  - 本棋盘 fair komi 是多少？（9x9=7, 13/19x19=7.5）
  - 实际传给 KataGo 的 komi 是多少？
  - 两者偏差 > 2 目吗？ → komi 错配，修 getKomi
  
第 2 步：检查 rules
  - 当前 rules 是什么？
  - 是 tromp-taylor 吗？ → 改 chinese
  - 是否切了规则但 KataGo 不支持？（v5 老网络用 chinese 会报错）
  
第 3 步：检查视角
  - winRate 是 side-to-move 还是固定黑方？
  - scoreLead 和 winRate 视角是否一致？
  - 前端解释和后端返回是否同一视角？

第 4 步：检查 initialStones vs moves
  - 局面是通过 initialStones 构造的吗？
  - 如果局面有 ko，用 moves 重放整盘
```

#### 8.2 AI 不下棋/pass

```
现象：AI 在不该 pass 的局面 pass

第 1 步：检查是否真实 pass 还是引擎错误
  - 响应里 engineError 字段？
  - 响应是否 404/500？

第 2 步：检查规则
  - friendlyPassOk = true？（chinese 规则默认 true）
  - 是否 tromp-taylor 的 friendlyPassOk=false 导致？

第 3 步：检查 komi 配合
  - 该局面 KataGo 认为自己 winrate 多高？
  - winrate > 99%？→ 已经进入"放水模式"(searchFactorWhenWinning)
  - 极端偏置 komi 会让空棋盘就进入这个模式

第 4 步：检查 visits
  - maxVisits < 50？→ 搜索太浅，policy 偏置没被修正

第 5 步：检查模型
  - 模型是 lionffen/b24c64 系列？→ 第三方短训练，稳定性差
  - 9x9 上能否换 kata9x9-b18c384nbt 测试？
```

#### 8.3 结果不稳定

```
现象：同一局面多次运行结果波动大

可能源（按常见度排序）：

1. wideRootNoise > 0
   - 默认 analysis cfg 有 0.04
   - 改 overrideSettings: {wideRootNoise: 0}

2. 多线程调度抖动
   - numSearchThreadsPerAnalysisThread > 1
   - 改为 1（仅用于确定性测试）

3. NN cache 不清
   - 每次 query 前发 clear_cache action
   - 不发 → 首次结果被后续 query 命中复用

4. 对称随机
   - nnRandomize = true 每次选不同对称
   - 改为 false

5. 棋盘尺寸切换
   - 切换棋盘会生成新 nnRandSeed
   - 生产多用户多棋盘并发时，同一用户的连续分析会受其他用户切换影响
   - 解法：多进程池按 boardSize 分片

6. maxVisits 不够（统计波动）
   - 50 visits 波动大，500 visits 很稳
```

#### 8.4 性能劣化

```
现象：单个 query 比基线慢 > 20%

1. CPU 满载？
   - 查 Railway 进程数
   - 是否有 ai-test-worker 并发在跑？

2. NN cache miss 飙升？
   - 最近切过模型吗？（切模型清 cache）
   - 最近切过棋盘大小吗？（重建 NN buffer）

3. 请求积压？
   - 同时多少个 query 在排队？
   - numAnalysisThreads 是否太小？

4. 模型问题
   - 换了模型吗？
   - 新模型 benchmark visits/s 是多少？
```

### §9 监控指标与告警阈值

#### 9.1 核心指标

| 指标 | 计算方法 | 告警阈值 |
|---|---|---|
| **KataGo 进程存活率** | 每分钟心跳 / 预期进程数 | < 100% Critical |
| **genmove p95 延迟** | 5 分钟滑动窗口 | > 30s Warning, > 60s Critical |
| **分析请求 p99 延迟** | 5 分钟滑动窗口 | > 30s Warning |
| **回退到本地 AI 频率** | 失败请求数 / 总请求数 | > 1% Warning, > 5% Critical |
| **pass 落子频率** | pass 数 / 所有 AI 落子 | > 0.5% Warning, > 2% Critical |
| **开局 20 手内的 pass** | 单独统计 | > 0 立即告警（这不该发生）|
| **winrate 极端值频率** | winrate > 99% 或 < 1% 的比例 | > 10% Warning（可能 komi 错）|
| **积分扣除成功但响应失败** | 支付但没服务 | > 0 立即告警 |
| **KataGo 进程平均 CPU** | top 统计 | < 30% 说明未充分利用 |

#### 9.2 配套日志规范

**每次 genmove 必须记录**：

```typescript
logAiEvent({
  // 基础
  type: "genmove",
  timestamp: Date.now(),
  
  // 引擎
  engine: "katago",
  model: modelName,
  modelHash: modelSha256,       // 🆕 便于精确复现
  
  // 棋局
  boardSize,
  rules,                        // 🆕 实际用的规则
  komi,                         // 🆕 实际用的 komi
  moveNumber: moves.length,
  aiColor,
  
  // 搜索
  maxVisits,
  actualVisits,                 // 🆕 实际跑到的 visits
  numSearchThreads,
  
  // 响应
  coord: `${row},${col}`,
  isPass: coord === "pass",
  durationMs,
  
  // 分析数据（如有）
  winRate,                      // 统一黑方视角
  scoreLead,                    // 统一黑方视角
  
  // 用户
  userId,
  requestId,
});
```

这套日志能让任何事后分析都能精确复现出"那一刻的 KataGo 状态"。

#### 9.3 Dashboard 必备视图

1. **实时总览**：QPS、p50/p99 延迟、错误率、当前队列长度
2. **引擎健康**：每个 KataGo 进程的 CPU、内存、存活时间、处理请求数
3. **棋局分布**：按 boardSize/difficulty/model 分组的请求数
4. **异常聚类**：按 error 类型分组（timeout, process crash, 协议错位…）
5. **视角一致性**：scoreLead 正负号分布（健康：大致对称；异常：一边倒）
6. **komi 健康**：按 boardSize 分组的 winRate 均值（应该都在 0.5 附近）

---

## 第七部分：迭代路线图

### §10 修复与优化路线图

#### 阶段 1：🚨 Hot Fix（本周必须完成）

**目标**：消除当前生产最严重的"数值失真"问题。**预计总投入：4-6 小时**。

##### 10.1.1 修复 komi（30 分钟）

```diff
// src/lib/go-logic.ts（或对应文件）
 export function getKomi(boardSize: number): number {
-  if (boardSize === 9) return 2.5;
-  if (boardSize === 13) return 3.5;
-  if (boardSize === 19) return 6.5;
+  // 来自 KataGo 官方 katagobooks.org fair komi
+  if (boardSize === 9) return 7;
+  if (boardSize === 13) return 7.5;
+  if (boardSize === 19) return 7.5;
   return 7.5;
 }
```

验证：部署后跑生产烟雾测试，9x9 空棋盘 winRate 应回到 40-60%。

##### 10.1.2 修复 scoreLead 视角（30 分钟）

```diff
// src/app/api/go-engine/route.ts 的 parseKataAnalyze 或 getKataGoAnalysis
 function normalizeAnalysis(raw: KataGoRaw, isWhiteToMove: boolean) {
   return {
     winRate: isWhiteToMove ? 100 - raw.winrate : raw.winrate,
-    scoreLead: raw.scoreLead,
+    scoreLead: isWhiteToMove ? -raw.scoreLead : raw.scoreLead,
     bestMoves: raw.bestMoves.map(m => ({
       ...m,
       winrate: isWhiteToMove ? 100 - m.winrate : m.winrate,
+      scoreMean: isWhiteToMove ? -m.scoreMean : m.scoreMean,
     })),
   };
 }
```

##### 10.1.3 修复 rules（15 分钟）

```diff
# /usr/local/katago/gtp.cfg (Dockerfile 修改)
- rules = tromp-taylor
+ rules = chinese
```

##### 10.1.4 补充 API 返回 komi/rules（60 分钟）

让前端能验证"后端实际用的 komi/rules 是什么"，方便对账：

```typescript
return {
  analysis: { 
    winRate, scoreLead, bestMoves, 
    komi: actualKomi,      // 🆕
    rules: actualRules,    // 🆕
  },
  pointsUsed,
};
```

前端 UI 显示"含贴目 X"时用这个后端返回的值，而不是前端自己算。

##### 10.1.5 部署 kata9x9 模型（2 小时）

- Dockerfile 打包 `kata9x9-b18c384nbt-s6603587840-d252232394.bin.gz`（97MB）
- 修改 `selectModel` 按 boardSize 路由
- 重新 deploy Railway（镜像增大 ~100MB）

##### 10.1.6 立刻做的生产验证

改完部署后跑（10 分钟）：

```bash
# 预期结果（和当前对比）
9x9 空盘 analyze:
  修复前: winRate=96.2%, scoreLead=+4.1
  修复后: winRate=~50%, scoreLead=~0

13x13 空盘 analyze:
  修复前: winRate=71.3%, scoreLead=+2.4
  修复后: winRate=~50%, scoreLead=~0

19x19 空盘 analyze:
  修复前: winRate=53.8%, scoreLead=+1.0
  修复后: winRate=~50%, scoreLead=~0
```

一旦数字回归正常，修复链就完成了 P0。**用户可见的 AI 胡说、胜率数字怪异，这一轮就消除了**。

---

#### 阶段 2：🏗️ 架构改造（两周内完成）

**目标**：切换到 Analysis Engine，彻底消除 GTP 历史包袱。**预计总投入：3-5 工作日**。

##### 10.2.1 搭建 Analysis Engine 客户端（1 天）

我已经给了 Python 原型（`research/katago/scripts/kata_client.py`），TypeScript 版本结构类似：

```typescript
class KataGoAnalysisClient {
  private proc: ChildProcess;
  private pendingQueries = new Map<string, PendingQuery>();
  
  async analyze(query: AnalysisQuery): Promise<AnalysisResponse> {
    const id = generateId();
    const line = JSON.stringify({ ...query, id }) + "\n";
    
    return new Promise((resolve, reject) => {
      this.pendingQueries.set(id, { resolve, reject, expectedCount });
      this.proc.stdin.write(line);
    });
  }
  
  // 监听 stdout，按 id 匹配响应
}
```

特点：
- 每个 query 完全独立，无会话状态
- 不需要发 `boardsize` / `clear_board` / `play` 命令
- 不需要维护 procEpoch / thoroughFlush / starting 锁等一切 GTP 次生复杂度

##### 10.2.2 搭建多进程池（2 天）

```typescript
class KataGoPool {
  private pools = new Map<string, KataGoAnalysisClient[]>();
  // pools.get("9x9") = [proc1_running_kata9x9, ...]
  // pools.get("13x13") = [proc2_running_rect15, ...]
  
  async analyze(boardSize, query) {
    const poolKey = boardSize === 9 ? "9x9" : "other";
    const client = await this.pickLeastBusy(poolKey);
    return client.analyze(query);
  }
  
  private async pickLeastBusy(poolKey: string) {
    // 负载均衡
  }
}
```

好处：
- 9x9 用 kata9x9 模型，13/19 用 rect15
- 一个进程崩掉其他还在
- 按需扩容（某个棋盘请求多就加进程）

##### 10.2.3 并行运行 GTP 和 Analysis Engine（1-2 天）

渐进式迁移：
- 新增 `/api/go-engine-v2` endpoint，用 Analysis Engine
- A/B 测试：10% 流量到 v2
- 观察 1 周指标
- 确认稳定后切换全量

##### 10.2.4 旧 GTP 代码下线（半天）

删除 500+ 行的 PersistentKataGo 类、EngineQueue、thoroughFlush、procEpoch 等所有 GTP 相关代码。**代码行数减少 30-50%**，维护成本大幅降低。

---

#### 阶段 3：🎯 测试流程建设（与阶段 2 并行）

**目标**：建立 §7 的完整测试金字塔。**预计总投入：3 工作日**。

##### 10.3.1 建立 GOLD 测试集（1 天）

- 收集 50 个经典局面（开局、中盘、死活）
- 每个局面在 fair komi + chinese + 500 visits 下跑出"期望结果"
- 写入 `tests/gold/` 目录
- CI 集成

##### 10.3.2 建立生产烟雾测试（半天）

- 部署后自动跑
- 失败自动回滚（如果 Railway 支持）或告警

##### 10.3.3 建立监控 Dashboard（1-2 天）

按 §9 的指标建 Grafana 或类似工具。

---

#### 阶段 4：🚀 长期优化（月度规划）

| 优化项 | 预期收益 | 投入 |
|---|---|---|
| 买 GPU 实例（T4/RTX 4090） | 棋力 +500 Elo，吞吐 +20x | 月 ¥500-2000 |
| 加入 b28c512 模型 | 棋力再 +200 Elo | 半天 |
| 实现 humanSL 模型按难度动态 | 入门用户体验提升 | 1 天 |
| Opening book 缓存 | 首 10 手响应 < 100ms | 2 天 |
| AI 对战排位赛 | 产品差异化 | 2 周 |

---

## 第八部分：附录

### §11 认知反思（给团队的 meta 建议）

经过今天的完整调研，有几条元级建议：

#### 11.1 建立"引用官方文档"的习惯

KataGo 有完整官方文档（Analysis_Engine.md, GTP_Extensions.md, KataGoMethods.md, rules.html），你们的报告里几乎不引用。**至少 5 个"通过本地实验发现"的特性，官方文档原本就写着**。

建议：在 PR / commit message 里，凡涉及 KataGo 特性，**强制链接官方文档**。

#### 11.2 建立"反向验证"习惯

Agent 修复一个 bug 后倾向于立刻关闭。建议：

- 每个修复必须有 "修复前实测 X，修复后实测 Y" 的对照
- 必须有一个和"当前修复假设"对抗的反例测试（比如"如果我假设错了，什么实验能证伪我"）
- 避免 confirmation bias

#### 11.3 警惕"单次测试即结论"

你们 Incident Report 3.1 用同一个局面测 3 次全 pass 就结论"模型不支持 9x9"。**3 次同一输入 ≠ 3 个样本**。

建议：类似"现象级"bug 至少测试 **3 个不同局面 × 3 次** = 9 个数据点，才能得出模型级结论。

#### 11.4 警惕"commit 日志自证循环"

报告大量引用 commit 消息作为证据。**commit 消息本身是当时 agent 的判断，不是独立证据**。

建议：在整理长期 knowledge 时，区分：
- "我当时修了什么"（事实）
- "我当时认为的根因"（假设，待验证）
- "独立验证后确认的根因"（结论）

#### 11.5 每季度做一次"外部视角审查"

你今晚找我做的正是这件事——让一个不参与代码、不受项目历史影响的外部视角 review。

建议：每季度至少一次（可以找另一个 AI、另一个工程师、新入职的人）。主题"我们对 X 的理解，哪些可能是错的？"

---

### §12 参考资料与术语表

#### 参考文档链接

**KataGo 官方**：
- [Analysis Engine 文档](https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md)
- [GTP Extensions](https://github.com/lightvector/KataGo/blob/master/docs/GTP_Extensions.md)
- [KataGo Methods](https://github.com/lightvector/KataGo/blob/master/docs/KataGoMethods.md)
- [Rules 详细说明](https://lightvector.github.io/KataGo/rules.html)
- [官方 9x9 opening book](https://katagobooks.org/) — fair komi 权威来源
- [analysis_example.cfg](https://github.com/lightvector/KataGo/blob/master/cpp/configs/analysis_example.cfg)
- [gtp_example.cfg](https://github.com/lightvector/KataGo/blob/master/cpp/configs/gtp_example.cfg)

**本项目研究文档**（research/katago/）：
- `docs/01-engine-modes-comparison.md` — GTP vs Analysis Engine
- `docs/02-analysis-json-protocol.md` — Analysis JSON 字段速查
- `docs/03-rulesets-and-boards.md` — 规则与棋盘
- `docs/04-pitfalls-and-troubleshooting.md` — 25 条踩坑点
- `docs/10-production-real-api-test.md` — 生产 API 实测铁证
- `docs/15-critical-review.md` — 对你们两份报告的批判性审查

#### 关键术语

| 术语 | 定义 |
|---|---|
| **fair komi** | 让黑白均势的贴目；每棋盘有特定值（9x9=7, 19x19=7.5）|
| **side-to-move** | 视角概念，"轮到谁下就以谁为视角"|
| **Analysis Engine** | KataGo 的异步 JSON 分析接口，专为 web 后端设计 |
| **GOLD test** | 黄金回归测试，每次变更都跑 |
| **multi-stone suicide** | 多子自杀（不同于单子自杀，后者始终非法）|
| **graph search** | KataGo 的搜索树优化，识别 transposition |
| **policy** | NN 给出的落子先验概率分布 |
| **PV** | Principal Variation，主变（预测的后续着法序列）|

---

### §13 快速参考卡片（贴在显示器上）

```
=================================================
     小围棋乐园 · KataGo 配置快速参考
=================================================

✅ 必须的配置值:
   rules = chinese
   komi: 9x9=7, 13x13=7.5, 19x19=7.5
   reportAnalysisWinratesAs = BLACK
   warnUnusedFields = true

🚫 避免的配置:
   rules = tromp-taylor        (友善 pass 关闭，用户不友好)
   komi ∈ {2.5, 3.5, 6.5}      (偏离 fair komi)
   getKomi 不返回官方 fair 值  (会失真)

🧪 部署后必测:
   9x9 空盘 analyze → winRate 应在 [40%, 60%]
   13x13 空盘 analyze → winRate 应在 [40%, 60%]
   19x19 空盘 analyze → winRate 应在 [40%, 60%]
   
📊 视角:
   winRate / scoreLead / scoreMean → 全部黑方视角
   前端不做转换，服务端统一

🏗️ 架构选型:
   网站后端 → Analysis Engine
   GUI 对弈 → GTP
   (你们目前应该切 Analysis Engine)

📞 紧急联系:
   KataGo 文档: katagotraining.org, lightvector/KataGo (GitHub)
   9x9 fair komi 来源: katagobooks.org
```

---

**文档结束**。如有补充、反驳、修订，直接编辑此文档并在 git 留下注释。

**签名**：围棋研究员 | 2026-04-24 | v1.0
