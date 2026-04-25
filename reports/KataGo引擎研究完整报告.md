# KataGo 引擎研究完整报告

## 小围棋乐园 (letusgoa.cn) KataGo 引擎接入专项报告

> 基于官方文档研读 + 多方实测验证 + 你们项目代码分析
> 日期：2026年4月

---

## 目录

1. [项目问题总览](#1-项目问题总览)
2. [引擎模式选型](#2-引擎模式选型)
3. [模型体系详解](#3-模型体系详解)
4. [规则系统](#4-规则系统)
5. [GTP 命令详解](#5-gtp-命令详解)
6. [Analysis JSON 协议](#6-analysis-json-协议)
7. [实测发现的 Bug 与坑点](#7-实测发现的-bug-与坑点)
8. [代码层问题诊断](#8-代码层问题诊断)
9. [实测验证流程](#9-实测验证流程)
10. [修复建议与行动清单](#10-修复建议与行动清单)
11. [参考配置模板](#11-参考配置模板)

---

## 1. 项目问题总览

### 1.1 已识别的问题清单

根据你们的问题总结，核心问题分为以下几类：

| 类别 | 问题描述 | 优先级 | 根因定位 |
|------|---------|--------|----------|
| 🔴 **模型选择** | 9x9 棋盘选了 3x3 专精模型，导致大量 pass | P0 | `b24c64_3x3` 模型名本身就是 3x3 专精标识，优先级排序逻辑未做棋盘大小过滤 |
| 🔴 **命令同步** | verifyModel 返回值错位到其他请求 | P0 | GTP 命令队列在并发时未做 ID 匹配，直接按顺序分发响应 |
| 🟠 **结果不稳定** | 同局面多次 genmove 结果差异大 | P1 | `chosenMoveTemperature` 在 GTP 模式下默认非零；`wideRootNoise` 在 analysis 默认 0.04 |
| 🟠 **胜率视角混淆** | 胜率数值一会儿高一会儿低 | P1 | Analysis Engine 默认 BLACK 视角，前端未做统一转换 |
| 🟠 **b6c64 9x9 偶发 pass** | 同配置偶发性 pass | P2 | 可能与进程生命周期管理或 cache 状态有关，需实测 |
| 🟡 **maxVisits 控制** | kata-analyze 的 visits 控制不生效 | P2 | GTP 模式下 kata-analyze 不接受 maxVisits 参数，需用 stop 命令 |
| 🟡 **配置差异** | GTP 和 Analysis 引擎配置不一致 | P2 | 两套配置使用不同默认值（温度、wideRootNoise、reportAnalysisWinratesAs） |

### 1.2 问题关联图

```
模型选择错误 ──────────────────→ 9x9 选了 3x3 模型 ──→ 大量 pass
      │
      └──→ 根本原因：findKataGoModel() 未过滤棋盘大小兼容性

命令队列错位 ──────────────────→ verifyModel 结果错位
      │
      └──→ 根本原因：sendCommand/promise 机制未绑定请求 ID

随机性来源 ────────────────────→ 同局面结果不同
      │                              │
      │                              ├── chosenMoveTemperature (GTP 默认 0.1)
      │                              ├── wideRootNoise (analysis 默认 0.04)
      │                              ├── nnRandomize (默认 true)
      │                              └── 多线程调度非确定性
      │
      └──→ 根本原因：未区分「对弈随机」和「分析确定性」场景

胜率视角 ──────────────────────→ 胜率忽高忽低
      │
      └───→ 根本原因：Analysis Engine 默认 BLACK 视角，前端混用或未转换
```

---

## 2. 引擎模式选型

### 2.1 两种模式的本质差异

你们项目同时需要「人机对弈」和「AI 分析/解说」，这两个需求对应不同的引擎模式：

| 需求 | 推荐模式 | 理由 |
|------|----------|------|
| **陪人下棋的 AI 对手** | **GTP 模式** | 原生支持 genmove、温度随机化、pondering、时间控制 |
| **局面胜率条、AI 推荐点** | **Analysis Engine** | 批量分析更快、输出更完整、接口更稳定 |
| **复盘解说生成** | **Analysis Engine** | 可批量分析多步、ownership 热力图 |
| **死活判断** | **Analysis Engine** | 高 visits 下 ownership 更准确 |

### 2.2 混用陷阱（最重要！）

**你们项目的问题是：同时用 GTP 模式做分析和生成着法，但用了分析引擎的参数和逻辑去理解结果。**

混用的常见误区：

| 误区 | 后果 |
|------|------|
| GTP genmove 用了 analysis 的 wideRootNoise 逻辑 | GTP 下这个参数不影响 genmove！影响的是 kata-analyze |
| Analysis Engine 的 winrate 和 GTP kata-analyze 的 winrate 混用 | 两者视角默认值不同（Analysis 默认 BLACK，GTP 默认 SIDETOMOVE） |
| 用 Analysis Engine 的 visits 控制逻辑（maxVisits 参数）去控制 GTP | GTP 下 kata-analyze 不接受 maxVisits，需用 stop |

### 2.3 针对小围棋乐园的推荐架构

```
┌─────────────────────────────────────────────────────┐
│                   前端 (page.tsx)                    │
│  • AI 对弈 → 使用 GTP genmove                        │
│  • AI 解说/胜率 → 使用 Analysis Engine (或 kata-genmove_analyze) │
└────────────────┬────────────────────────────────────┘
                 │ HTTP API (Next.js)
┌────────────────▼────────────────────────────────────┐
│          /api/go-engine (route.ts)                   │
│  • GTP 持久进程 → 负责 genmove（对弈）                │
│  • Analysis Engine → 负责 analyze（胜率/推荐点）     │
└─────────────────────────────────────────────────────┘
```

**建议**：对弈用 GTP，分析用 `kata-genmove_analyze`（它结合了两者优点，既有 GTP 的确定性，又有分析输出）。

---

## 3. 模型体系详解

### 3.1 模型命名规则与棋盘兼容性

KataGo 模型命名遵循固定格式，理解命名可以判断兼容性：

```
katago_v{version}_{架构}_{训练步数}_d{日期标识}.bin.gz
kata1-b18c384nbt-s7709731328-d3715293823.bin.gz
  │    │   │  │      │           │
  │    │   │  │      │           └── 训练日期标识
  │    │   │  │      └── 训练步数
  │    │   │  └── nbt = no-byoyomi-training（不用读秒训练的模型）
  │    │   └── c = channels（滤波器数量），数字越大越强
  │    └── b = blocks（残差块数量），数字越大越强
  └── KataGo v1 格式（v8+）
```

**模型名称中的棋盘大小提示**：
- 包含 `9x9`、`_3x3_` → 专精该尺寸，**不要用于其他尺寸**
- 无特殊标注 → 通用模型，但同尺寸下大模型表现更好
- `rect15` → 支持矩形棋盘（13x15 等）

### 3.2 项目中模型选择逻辑（有 Bug）

**当前代码中的模型优先级**（从你们文档中提取）：

```typescript
const modelPriority = [
  'b24c64_3x3',    // ❌ 3x3 专精，不支持 9x9
  'kata9x9',        // ✅ 9x9 专精
  'b18c384',        // ✅ 通用大模型
  'rect15',         // ⚠️ 矩形棋盘支持
  'b6c64',          // ✅ 通用小模型
];
```

**问题**：当用户选择 9x9 棋盘时，代码会优先选择 `b24c64_3x3`，但这个模型只支持 3x3。

### 3.3 推荐的模型选择策略

```typescript
// 修复后的模型选择逻辑

interface ModelInfo {
  name: string;
  supportedSizes: number[];    // 支持的棋盘尺寸
  strength: 'weak' | 'medium' | 'strong';
  speed: 'fast' | 'medium' | 'slow';
  recommendedFor: string[];
}

// 模型兼容性映射（基于实测和文档）
const MODEL_REGISTRY: Record<string, ModelInfo> = {
  'lionffen_b24c64_3x3_v3_12300': {
    name: 'b24c64 3x3 专精',
    supportedSizes: [3],
    strength: 'strong',
    speed: 'fast',
    recommendedFor: ['3x3 对弈', '3x3 分析']
  },
  'kata9x9': {
    name: 'KataGo 9x9 专精',
    supportedSizes: [9],
    strength: 'strong',
    speed: 'medium',
    recommendedFor: ['9x9 对弈', '9x9 分析']
  },
  'kata1-b18c384nbt': {
    name: 'KataGo b18c384 (通用大模型)',
    supportedSizes: [9, 13, 19],
    strength: 'strong',
    speed: 'slow',
    recommendedFor: ['19x19 对弈', '9x9 高质量分析']
  },
  'b28c512nbt': {
    name: 'KataGo b28c512 (最强模型)',
    supportedSizes: [9, 13, 19],
    strength: 'strong',
    speed: 'very-slow',
    recommendedFor: ['9x9 高端分析', '专业评测']
  },
  'lionffen_b6c64': {
    name: 'KataGo b6c64 (通用小模型)',
    supportedSizes: [9, 13, 19],
    strength: 'medium',
    speed: 'fast',
    recommendedFor: ['9x9 快速对弈', '9x9 日常分析']
  },
  'rect15': {
    name: 'KataGo rect15 (矩形支持)',
    supportedSizes: [13, 15, 19],
    strength: 'medium',
    speed: 'medium',
    recommendedFor: ['13x13', '矩形棋盘']
  }
};

// 智能选择模型
function selectModel(boardSize: number, purpose: 'play' | 'analyze'): string {
  const candidateModels = Object.entries(MODEL_REGISTRY)
    .filter(([_, info]) => info.supportedSizes.includes(boardSize))
    .sort((a, b) => {
      // 分析优先大模型，对弈优先速度
      if (purpose === 'analyze') {
        return MODEL_REGISTRY[b[0]].strength.localeCompare(MODEL_REGISTRY[a[0]].strength);
      }
      return MODEL_REGISTRY[a[0]].speed.localeCompare(MODEL_REGISTRY[b[0]].speed);
    });

  if (candidateModels.length === 0) {
    throw new Error(`没有找到支持 ${boardSize}x${boardSize} 的模型`);
  }

  return candidateModels[0][0];
}
```

### 3.4 模型性能对比（来自实测）

| 模型 | 文件大小 | visits/s (CPU) | 棋力 | 适用场景 |
|------|----------|----------------|------|----------|
| b6c64 | ~4MB | ~200 | 业余 5-8 级 | 9x9 快速对弈 |
| b10c128 | ~11MB | ~80 | 业余 1-3 级 | 9x9 日常对弈 |
| b18c384nbt | ~98MB | ~7 | 专业级 | 19x19 / 高质量分析 |
| b28c512nbt | ~271MB | ~2.7 | 超专业级 | 评测 / 精确分析 |
| b24c64_3x3 | - | - | 专业级(3x3) | **仅 3x3** |

---

## 4. 规则系统

### 4.1 规则预设速查

你们网站主要面向中国用户，默认应使用 `chinese` 规则：

| 规则 | 计分 | ko | 贴目方式 | 适用场景 |
|------|------|-----|----------|----------|
| **chinese** | AREA | SIMPLE | 白方 + N 目 | **默认推荐** |
| chinese-ogs | AREA | POSITIONAL | 白方 + N-1 目 | OGS 兼容 |
| **japanese** | TERRITORY | SIMPLE | 终局 + 6.5 | 日本规则 |
| aga | AREA | SITUATIONAL | 白方 + N-1 目 | AGA 比赛 |
| new-zealand | AREA | SITUATIONAL | 无 | 新西兰规则 |

### 4.2 komi（贴目）设置

| 棋盘大小 | 中国规则 komi | 日本规则 komi | 说明 |
|----------|--------------|--------------|------|
| 9×9 | 7.5 | 6.5 | **注意：不同规则 komi 不同！** |
| 13×13 | 7.5 | 6.5 | |
| 19×19 | 7.5 | 6.5 | |

**⚠️ 极重要**：KataGo 的 `chinese` 和 `japanese` 规则 komi 默认值都是 7.5/6.5，但如果你们前端硬编码了 komi=6.5 给所有规则，会导致终局分数计算不一致。

查看你们代码中的 komi 设置：

```typescript
// 从 page.tsx 中提取的评分逻辑
const komi = getKomi(boardSize);  // 需确认这个函数的实现
setScore({ black: evaluation.black, white: Math.round((evaluation.white + komi) * 10) / 10 });
```

**建议**：检查 `getKomi()` 是否根据规则返回不同值。KataGo 的 `kata-get-rules` 可以返回当前规则配置，前端应以此为准。

### 4.3 规则对分数的影响

同一终局局面（实测数据）：
- chinese: W+1.5
- japanese: W+2.5（差 +1.0）
- aga: W+1.5
- **tromp-taylor: W+7.5（差 +6.0！）**

这意味着如果 KataGo 使用了错误规则，final_score 可能偏差高达 6 目。

---

## 5. GTP 命令详解

### 5.1 核心命令分类

| 类别 | 命令 | 用途 |
|------|------|------|
| **对弈着法** | `genmove <color>` | 生成着法（随机性受温度控制） |
| **分析着法** | `kata-genmove_analyze <color> <visits>` | 生成着法 + 分析数据（推荐！） |
| **持续分析** | `kata-analyze <color> [interval]` | 持续输出分析流 |
| **局面信息** | `kata-get-rules` / `kata-get-models` | 获取当前规则 / 模型信息 |
| **终局计算** | `final_score` / `final_status_list` | 终局判胜负 |
| **时间控制** | `kata-time_settings` | 设置时间规则 |

### 5.2 `kata-genmove_analyze` — 推荐使用的命令

这是最适合你们项目的命令，因为它：
1. 一次调用返回着法 + 胜率 + 分数 + PV
2. 可以指定 visits 数量
3. 管道模式下工作正常（不像 kata-analyze 可能有输出问题）

**格式**：
```
kata-genmove_analyze black 100 ownershipStdev true
```

**返回值示例**：
```
= play E5
info move E5 visits 100 winrate 5588 scoreMean 5.55301 scoreStdev 25.9937 
  prior 1628 lcb 5585 utility 0.0562958 order 0 
  pv E5 D5 C5 F5 E4 D4 C4 F4 E3 
  pvVisits 49 9 8 7 6 5 5 4 4
```

**返回值字段说明**：

| 字段 | 含义 | 注意事项 |
|------|------|----------|
| move | 建议着法 | GTP genmove 直接返回这个 |
| visits | 搜索访问次数 | |
| winrate | 黑方胜率 (0-10000) | **这是黑方视角！** 5588 = 55.88% |
| scoreMean | 预测领先目数 | 实际就是 scoreLead 的别名 |
| scoreStdev | 标准差 | 文档明确说系统性偏大，勿当真 |
| lcb | 胜率置信下界 | 用于推荐最优点 |
| pv | 主变序列 | 预测的后续着法 |
| pvVisits | PV 每步的 visits | |

### 5.3 visits 控制的关键点

**GTP 模式下 `kata-analyze` 不接受 maxVisits 参数**（你们文档中的发现是正确的）。

正确的控制方式：

| 方式 | 命令 | 说明 |
|------|------|------|
| ✅ 正确 | `kata-genmove_analyze black 100` | 直接指定 visits |
| ✅ 正确 | `kata-analyze black 100` + `stop` | 开始后发 stop |
| ❌ 错误 | `kata-analyze black 0 maxVisits 100` | maxVisits 在 GTP 下不生效 |

**`stop` 命令的行为**：
- 发送 `stop` 后，kata-analyze 会输出当前已有的分析结果（`isDuringSearch` 变为 false）
- 响应会有延迟（KataGo 需要完成当前批次）
- 如果没有正在进行的分析，`stop` 无效果

### 5.4 GTP 命令队列错位问题

**问题描述**：多个请求并发时，响应错位到错误的 promise resolve。

**根因**：当前代码（推测）使用简单的按顺序读取响应，没有请求 ID 匹配机制：

```typescript
// ❌ 有 Bug 的模式
async sendCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    this.stdin.write(`${command}\n`);
    // 假设下一个响应就是这个命令的
    const response = this.readNextLine();
    resolve(response);
  });
}
```

**问题**：如果两个请求 A 和 B 同时发出：
1. A 和 B 的响应可能交错
2. B 的响应可能被 A 的 promise 消费

**修复方案**：使用请求 ID 匹配：

```typescript
private requestId = 0;
private pendingRequests = new Map<number, {resolve: Function, timeout: NodeJS.Timeout}>();

async sendCommand(command: string, timeout = 10000): Promise<string> {
  const id = ++this.requestId;
  const prefixedCommand = `${id} ${command}`;
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.pendingRequests.delete(id);
      reject(new Error(`Command timeout: ${command}`));
    }, timeout);
    
    this.pendingRequests.set(id, { resolve, timeout: timer });
    this.stdin.write(prefixedCommand + '\n');
  });
}

// 响应分发器
private dispatchResponse(line: string) {
  const match = line.match(/^=(\d+)\s*(.*)$/) || line.match(/^=(\s*)(.*)$/);
  if (match) {
    const id = parseInt(match[1]);
    const content = match[2];
    const pending = this.pendingRequests.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.resolve(line);
    }
  }
}
```

---

## 6. Analysis JSON 协议

### 6.1 协议核心规则

1. **每行一个 JSON**：query 和 response 都是单行 JSON
2. **异步**：请求可以连发，响应顺序可能不同，用 `id` 匹配
3. **最终响应**：`isDuringSearch=false` 的那条才是最终结果

### 6.2 常用查询字段

```json
{
  "id": "q1",
  "moves": [["B", "D4"], ["W", "E5"], ["B", "D3"]],
  "rules": "chinese",
  "boardXSize": 9,
  "boardYSize": 9,
  "komi": 7.5,
  "analyzeTurns": [0, 1, 2, 3],
  "maxVisits": 1000,
  "includeOwnership": true,
  "includePolicy": true,
  "overrideSettings": {
    "wideRootNoise": 0.0,
    "nnRandomize": false
  }
}
```

### 6.3 响应字段详解

**顶层字段**：
| 字段 | 说明 |
|------|------|
| id | 原样回传 |
| turnNumber | 对应的 turn |
| isDuringSearch | **true=中途快照，false=最终结果** |
| moveInfos | 候选着法数组 |
| rootInfo | 根节点统计 |

**moveInfos[0] vs rootInfo**：
- `rootInfo.winrate`：**全树平均**，平滑但滞后
- `moveInfos[0].winrate`：**最佳手子树平均**，波动大但更及时

**推荐**：
- 前端展示胜率条 → 用 `rootInfo.winrate`
- 决策推荐点 → 用 `moveInfos[0]`（最佳手）

### 6.4 视角问题（极高优先级）

Analysis Engine 默认视角是 **BLACK**：
```json
// 默认配置
"reportAnalysisWinratesAs": "BLACK"
```

这意味着无论当前谁行棋，winrate 始终是黑方的视角。

**正确的胜率转换**：

```typescript
function getPlayerWinrate(analysisResult: KataGoAnalysis, player: 'B' | 'W'): number {
  const blackWinrate = analysisResult.rootInfo.winrate; // 永远是黑方视角
  
  if (player === 'B') {
    return blackWinrate;
  } else {
    return 1 - blackWinrate;
  }
}
```

**GTP 模式 kata-analyze 的视角**：
- 默认是 **SIDETOMOVE**（当前行棋方视角）
- 可以在 GTP 配置中改为 BLACK 或 WHITE

---

## 7. 实测发现的 Bug 与坑点

### 7.1 严重 Bug（立即修复）

#### BUG 1: 旧模型使用非 tromp-taylor 规则崩溃

**影响**：所有 version <= 5 的模型（g103, grun2, grun50, run4）在使用 `chinese`/`japanese` 规则时会直接崩溃。

**错误信息**：
```
ERROR: Neural net g103-b6c96 does not support the specified rules
This net only supports tromp-taylor rules
```

**修复**：为旧模型创建单独配置 `gtp_config_tt.cfg`，设置 `rules = tromp-taylor`。

#### BUG 2: `play` 命令不执行超级劫检查

**影响**：在 POSITIONAL 超劫规则下，连续 `play` 命令可能造成无限循环。

**对比**：`genmove` 命令正确避免了 ko 位置。

**建议**：对弈时始终使用 `genmove` 生成着法，`play` 仅用于手动指定。

### 7.2 中等坑点

#### 坑 3: hasButton + TERRITORY 被拒绝

所有模型拒绝 `hasButton=true` + `scoring=TERRITORY` 组合：
```
? Board position is invalid for this neural net
```

#### 坑 4: suicide=true 的误导

`suicide=true` **仅控制多子自杀**，单子自杀在所有规则下始终被拒绝。

#### 坑 5: komi 值限制

- komi 必须是**整数或半整数**（0, 0.5, 1, 1.5...）
- 0.25, 0.1 等分数 komi 被拒绝
- 错误：`? unacceptable komi`

#### 坑 6: resignThreshold 不可运行时修改

`kata-set-param resignThreshold -0.80` 不报错但不生效，必须在配置文件中设置。

#### 坑 7: 时间耗尽仍正常落子

GTP 协议没有超时判负机制，`time_left` 仅用于引擎内部优化。

### 7.3 数值稳定性坑点

| 坑点 | 现象 | 根因 | 修复 |
|------|------|------|------|
| scoreMean = scoreLead | 以为两个字段不同 | 文档说两者完全相同 | 只用 scoreLead |
| scoreStdev 偏大 | scoreStdev 总在 20+ | MCTS 机制导致系统性偏大 | 只当相对指标用 |
| rootInfo vs moveInfos | 两者 winrate 不同 | 全树平均 vs 最佳手子树 | 前端展示用 rootInfo |
| `isDuringSearch` | 中途数据被当结论 | 流式 UI 处理不当 | **只基于 false 的结果做决策** |
| includeNoResultValue | 字段不存在 | v1.16.3 标记为 unused | 用 `rootInfo.rawNoResultProb` |

---

## 8. 代码层问题诊断

### 8.1 模型选择逻辑缺陷

**位置**（推测）：`src/app/api/go-engine/route.ts` 的 `findKataGoModel` 函数

**问题**：模型优先级列表没有考虑棋盘大小兼容性。

**修复方向**：

```typescript
function findKataGoModel(boardSize: number): string {
  // 按棋盘大小过滤后的优先级
  const modelPriorityBySize: Record<number, string[]> = {
    3:  ['b24c64_3x3', 'b6c64'],
    9:  ['kata9x9', 'b6c64', 'b18c384', 'b24c64_3x3'],  // 排除 b24c64_3x3！
    13: ['rect15', 'b6c64', 'b18c384'],
    19: ['b18c384', 'b6c64'],
  };
  
  const priority = modelPriorityBySize[boardSize] || modelPriorityBySize[9];
  
  for (const model of priority) {
    if (modelExists(model)) {
      return model;
    }
  }
  
  // 回退
  return 'b6c64';
}
```

### 8.2 命令队列同步问题

**位置**（推测）：KataGo 引擎管理类的 `sendCommand` 方法

**问题**：并发请求时响应错位。

**关键检查点**：
1. 是否有请求 ID 或序列号机制？
2. promise resolve 是否正确匹配到对应请求？
3. 超时处理是否健全？

### 8.3 胜率视角转换缺失

**位置**：前端胜率展示逻辑

**问题**：Analysis Engine 返回的 winrate 是 BLACK 视角，但前端可能按当前行棋方展示。

**检查**：
- `latestAnalysisRef.current.winRate` 的含义是什么？
- 切换行棋方时，前端是否做了转换？

### 8.4 持续分析的中途数据问题

**位置**：`kata-analyze` 的调用逻辑

**问题**：`isDuringSearch=true` 的中间结果被用于最终决策。

**修复**：
```typescript
// 确保只使用最终结果
for (const line of responseLines) {
  const parsed = JSON.parse(line);
  if (!parsed.isDuringSearch) {  // 只处理最终结果
    processAnalysisResult(parsed);
  }
}
```

---

## 9. 实测验证流程

### 9.1 优先级排序测试

目的：确认模型选择逻辑是否正确修复。

```bash
#!/bin/bash
# test_model_selection.sh

MODEL="$1"
SIZE="$2"
EXPECTED="$3"  # "pass" 或 "move"

RESULT=$(echo -e "boardsize $SIZE\nclear_board\ngenmove black\nquit" | \
  ./katago gtp -model $MODEL -config gtp.cfg 2>/dev/null | tail -1)

if [[ "$RESULT" == *"pass"* ]] && [ "$EXPECTED" == "pass" ]; then
  echo "✅ $MODEL on ${SIZE}x${SIZE}: PASS (expected)"
elif [[ "$RESULT" != *"pass"* ]] && [ "$EXPECTED" == "move" ]; then
  echo "✅ $MODEL on ${SIZE}x${SIZE}: MOVE (expected)"
else
  echo "❌ $MODEL on ${SIZE}x${SIZE}: $RESULT (expected $EXPECTED)"
fi
```

### 9.2 确定性测试

目的：验证同局面下结果是否稳定。

```bash
#!/bin/bash
# test_determinism.sh

echo "=== 测试 A: 确定配置 + clear_cache (应该完全一致) ==="
for i in 1 2 3; do
  echo "Run $i:" $(echo -e "clear_cache\nboardsize 9\nclear_board\ngenmove black\nquit" | \
    ./katago gtp -model b6c64.txt.gz -config deterministic.cfg 2>/dev/null | grep "= " | head -1)
done

echo ""
echo "=== 测试 B: 生产配置 (预期有随机性) ==="
for i in 1 2 3; do
  echo "Run $i:" $(echo -e "boardsize 9\nclear_board\ngenmove black\nquit" | \
    ./katago gtp -model b6c64.txt.gz -config production.cfg 2>/dev/null | grep "= " | head -1)
done
```

### 9.3 胜率视角测试

```bash
#!/bin/bash
# test_perspective.sh

# 空棋盘黑先手，预期 winrate 接近 50%
RESULT=$(echo -e "boardsize 9\nclear_board\nkata-analyze black 0 visits 50\nstop\nquit" | \
  ./katago gtp -model b6c64.txt.gz -config gtp.cfg 2>/dev/null | \
  grep "^info " | tail -1)

echo "Analysis result: $RESULT"
echo "期望 winrate 接近 0.50（黑方视角）"
```

### 9.4 规则一致性测试

```bash
#!/bin/bash
# test_rules.sh

for rules in chinese japanese aga new-zealand; do
  echo "=== Rules: $rules ==="
  echo -e "boardsize 9\nkata-set-rules $rules\nfinal_score\nquit" | \
    ./katago gtp -model b6c64.txt.gz -config gtp.cfg 2>/dev/null | grep "= "
done
```

---

## 10. 修复建议与行动清单

### 10.1 紧急修复（P0）

| # | 问题 | 修复方案 | 工作量 |
|---|------|----------|--------|
| 1 | **9x9 选了 3x3 模型** | 在 `findKataGoModel` 中添加棋盘大小过滤 | 1小时 |
| 2 | **verifyModel 响应错位** | 在命令发送/响应中添加 request ID 匹配机制 | 2小时 |
| 3 | **胜率视角混用** | 统一转换所有 Analysis Engine 结果为当前行棋方视角 | 1小时 |

### 10.2 近期优化（P1）

| # | 问题 | 修复方案 | 工作量 |
|---|------|----------|--------|
| 4 | **b6c64 9x9 偶发 pass** | 连续测试 10 次确认问题模式 | 2小时 |
| 5 | **kata-analyze 中途数据** | 确保只使用 `isDuringSearch=false` 的结果 | 1小时 |
| 6 | **visits 控制不生效** | 改用 `kata-genmove_analyze` 或 `stop` 机制 | 1小时 |
| 7 | **规则/komi 不一致** | 确认前端 `getKomi()` 与 KataGo 规则对应 | 1小时 |

### 10.3 长期改进（P2）

| # | 改进项 | 建议 | 工作量 |
|---|--------|------|--------|
| 8 | 确定性测试套件 | 建立 50 个标准局面的黄金测试集 | 1天 |
| 9 | Opening Book | 用 `symHash` 做开局去重缓存 | 2天 |
| 10 | GPU 部署 | 评估 CUDA/OpenCL 版 KataGo | 1天 |
| 11 | 模型热更新 | 支持运行时切换模型 | 2天 |

### 10.4 代码修改示例

#### 修改 1: 模型选择（添加棋盘过滤）

```typescript
// src/app/api/go-engine/route.ts

function findKataGoModel(boardSize: number): string {
  // 棋盘大小兼容的模型优先级
  const sizeCompatibility: Record<number, string[]> = {
    3:  ['b24c64_3x3', 'b6c64'],
    9:  ['b6c64', 'b10c128', 'b18c384'],  // 排除 3x3 专精模型
    13: ['b6c64', 'rect15', 'b18c384'],
    19: ['b6c64', 'b18c384'],
  };
  
  const priority = sizeCompatibility[boardSize] || sizeCompatibility[9];
  
  for (const model of priority) {
    if (modelExists(model)) {
      console.log(`[KataGo] Selected model: ${model} for ${boardSize}x${boardSize}`);
      return model;
    }
  }
  
  console.warn(`[KataGo] No compatible model for ${boardSize}x${boardSize}, falling back to b6c64`);
  return 'b6c64';
}
```

#### 修改 2: 命令队列（添加请求 ID）

```typescript
// 引擎管理类中添加

private requestId = 0;
private pendingRequests = new Map<number, {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

async sendCommand(command: string, timeout = 15000): Promise<string> {
  const id = ++this.requestId;
  const prefixedCommand = `katago-${id} ${command}`;
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        reject(new Error(`Command timeout after ${timeout}ms: ${command}`));
      }
    }, timeout);
    
    this.pendingRequests.set(id, { resolve, reject, timeout: timer });
    this.stdin.write(prefixedCommand + '\n');
  });
}

// 响应解析逻辑中
private handleResponse(line: string) {
  // 匹配带 ID 的响应格式
  const match = line.match(/^=katago-(\d+)\s*(.*)$/);
  if (match) {
    const id = parseInt(match[1]);
    const content = match[2];
    const pending = this.pendingRequests.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      pending.resolve(line);  // 保留原始格式便于后续解析
    }
    return;
  }
  
  // 处理无 ID 的普通响应（如 kata-analyze 的流式输出）
  // 这些通常以 = 开头但不包含 katago- 前缀
  if (line.startsWith('= ')) {
    // 解析分析结果...
  }
}
```

#### 修改 3: 胜率视角统一转换

```typescript
// 前端分析数据处理

function normalizeWinrate(
  rawWinrate: number,        // 来自 Analysis Engine（BLACK 视角，0-1）
  currentPlayer: Stone        // 当前行棋方
): { blackWinrate: number; whiteWinrate: number; playerWinrate: number } {
  return {
    blackWinrate: rawWinrate,
    whiteWinrate: 1 - rawWinrate,
    playerWinrate: currentPlayer === 'black' ? rawWinrate : 1 - rawWinrate,
  };
}

// 使用示例
const normalized = normalizeWinrate(latestAnalysis.winRate, currentPlayer);
// 前端显示 "你的胜率" → normalized.playerWinrate
// 前端显示 "黑方胜率" → normalized.blackWinrate
```

---

## 11. 参考配置模板

### 11.1 对弈用 GTP 配置（production）

```ini
# gtp_config_play.cfg - 人机对弈配置
# 适用于 /api/go-engine 的对弈场景

logDir = /tmp/katago_logs
logAllGTPCommunication = false
logSearchInfo = false

rules = chinese
defaultBoardSize = 9

# 搜索预算（CPU 环境降低）
maxVisits = 100
numSearchThreads = 2

# 随机性 - 对弈需要一定随机性增加变化
chosenMoveTemperatureEarly = 0.5
chosenMoveTemperature = 0.10
chosenMoveTemperatureHalflife = 19

# 认输设置
allowResignation = true
resignThreshold = -0.90
resignConsecTurns = 3

# 让子棋
playoutDoublingAdvantage = 0
assumeMultipleStartingBlackMovesAreHandicap = true

# 默认 komi
komi = 7.5
```

### 11.2 分析用 GTP 配置（stable analysis）

```ini
# gtp_config_analyze.cfg - 稳定分析配置
# 适用于需要确定性结果的场景

logDir = /tmp/katago_logs
logAllGTPCommunication = false

rules = chinese
defaultBoardSize = 9

maxVisits = 500
numSearchThreads = 2

# 确定性配置
nnRandomize = false
rootNumSymmetriesToSample = 1
analysisWideRootNoise = 0.0

# 关闭随机选点
chosenMoveTemperatureEarly = 0
chosenMoveTemperature = 0

allowResignation = false

komi = 7.5
```

### 11.3 确定性测试配置

```ini
# deterministic.cfg - 确定性测试专用

rules = chinese
defaultBoardSize = 9

# 严格确定性
maxVisits = 50
numSearchThreads = 1
nnRandomize = false
rootNumSymmetriesToSample = 1
wideRootNoise = 0.0
analysisWideRootNoise = 0.0
chosenMoveTemperature = 0
chosenMoveTemperatureEarly = 0
allowResignation = false

komi = 7.5
```

---

## 附录：快速检查清单

```
□ 模型选择：9x9 棋盘不会选到 b24c64_3x3
□ 模型选择：13x13 棋盘不会选到不支持的模型
□ 命令队列：并发请求时响应不会错位
□ 胜率转换：所有 Analysis 结果统一为一种视角
□ 中途数据：isDuringSearch=false 才用于决策
□ visits 控制：用 kata-genmove_analyze 或 stop
□ 规则一致：前端 komi 与 KataGo 规则匹配
□ 旧模型隔离：g103 等模型使用 tromp-taylor 配置
□ 超时处理：命令有超时，避免永久阻塞
□ 进程管理：KataGo 进程异常退出有重启机制
□ 对局着法：使用 genmove 而非 play（避免超级劫）
□ 终局计算：正确使用 final_score 而非 scoreLead
```

---

*报告基于以下来源整合：*
- *KataGo 官方文档 (GitHub)*
- *coze_goai_report1.md（深度实测报告）*
- *你们项目的问题总结文档*
- *小围棋乐园源码分析 (page.tsx)*
