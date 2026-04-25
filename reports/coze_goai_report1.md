好的，以下是 KataGo 深度研究的完整报告。

---

# KataGo 引擎深度研究报告

## 一、引擎基本信息

| 项目 | 详情 |
|------|------|
| 版本 | v1.16.4 (从源码编译) |
| 后端 | Eigen (纯 CPU，无 GPU/OpenCL) |
| 编译选项 | `-DUSE_BACKEND=EIGEN -DUSE_AVX2=ON` |
| 二进制路径 | `/usr/local/bin/katago` |
| 配置目录 | `/workspace/projects/engines/katago/` |
| 模型目录 | `/workspace/projects/engines/katago/models/` |
| 启动命令 | `katago gtp -model <模型文件> -config <配置文件>` |

---

## 二、模型清单与性能基准

共获取并测试了 **9 个模型**，其中 5 个可正常使用中国规则，4 个仅支持 tromp-taylor 规则。

### 2.1 可用模型（支持中国规则，version >= 8）

| 模型名 | 文件名 | 版本 | 大小 | 格式 | visits/s | nnEvals/s | 棋力估计 |
|--------|--------|------|------|------|----------|-----------|---------|
| **b6c96** | g170-b6c96-s175395328-d26788732.bin.gz | v8 | 3.8 MB | .bin.gz | **202** | 199 | ~5-8 级 |
| **b10c128** | g170e-b10c128-s1141046784-d204142634.bin.gz | v8 | 11.1 MB | .bin.gz | **83** | 82 | ~1-3 级 |
| **b18c384 ★** | kata1-b18c384nbt-s7709731328-d3715293823.bin.gz | v14 | 97.9 MB | .bin.gz | **7.4** | 7.1 | 专业级 |
| **b28c512 ★★** | kata1-b28c512nbt-s12763923712-d5805955894.bin.gz | v15 | 271.4 MB | .bin.gz | **2.7** | 2.6 | 超专业级 |

**性能对比要点：**
- b6c96 是最快的，但也是最弱的（6 个残差块、96 个滤波器）
- b18c384 比 b6c96 慢 **27 倍**，但棋力从业余级跃升到专业级
- b28c512 是最新一代模型，比 b18c384 再慢约 2.7 倍，但理论上是最强的
- 在纯 CPU 环境下，**b6c96 或 b10c128 是最实用的选择**，b18c384/b28c512 仅适合 9x9 小棋盘

**模型格式说明：**
- `.bin.gz` 和 `.txt.gz` 两种格式都被 KataGo 支持
- 模型名中的 `b` = blocks（残差块数），`c` = channels（滤波器数）
- `nbt` = no-byoyomi-training（不使用读秒训练的模型）
- `s` = steps（训练步数），`d` = date（训练日期标识）

### 2.2 旧版模型（仅支持 tromp-taylor 规则，version <= 5）

| 模型名 | 文件名 | 版本 | 大小 | visits/s | 备注 |
|--------|--------|------|------|----------|------|
| g103 | g103-b6c96-s103408384-d26419149.txt.gz | v3 | 5.0 MB | ~208 | 使用中国规则**会崩溃** |
| grun2 | grun2-b6c96-s128700160-d49811312.txt.gz | v3 | - | - | 使用中国规则**会崩溃** |
| grun50 | grun50-b6c96-s156348160-d118286860.txt.gz | v3 | - | - | 使用中国规则**会崩溃** |
| run4 | run4-s67105280-d24430742-b6c96.txt.gz | v3 | - | - | 使用中国规则**会崩溃** |

**⚠️ 关键发现：** 所有 version <= 5 的模型，在使用 `chinese`、`japanese`、`korean` 等规则启动时会直接崩溃并输出：
```
ERROR: Neural net g103-b6c96 does not support the specified rules
This net only supports tromp-taylor rules
```
解决方案：为这些模型创建单独的 `gtp_config_tt.cfg`，设置 `rules = tromp-taylor`。

### 2.3 不同模型的首着偏好（9x9 空盘，100 visits）

| 模型 | 首着 | 胜率估计 |
|------|------|---------|
| b6c96 | E5 (天元) | ~54% |
| b10c128 | F5 (偏右) | ~55% |
| b18c384 | G5 (三三附近) | ~56% |
| b28c512 | E5 (天元) | ~56% |
| g103 | G5 | ~53% |

---

## 三、规则系统详解

### 3.1 11 种规则预设（全部实测验证）

通过 `kata-set-rules <规则名>` 设置，通过 `kata-get-rules` 查看当前规则。

| 规则预设 | ko 规则 | 计分方式 | 税 | 自杀 | hasButton | 贴目奖励 | 贴目自带 |
|----------|---------|---------|-----|------|-----------|---------|---------|
| **tromp-taylor** | POSITIONAL | AREA | NONE | true | false | 0 | true |
| **chinese** | SIMPLE | AREA | NONE | false | false | 0 | true |
| **chinese-ogs** | SIMPLE | AREA | NONE | false | false | N-1 | true |
| **chinese-kgs** | SIMPLE | AREA | NONE | false | false | N | true |
| **japanese** | SIMPLE | TERRITORY | SEKI | false | false | 0 | true |
| **korean** | SIMPLE | TERRITORY | SEKI | false | false | 0 | true |
| **aga** | SITUATIONAL | AREA | ALL | false | false | N-1 | true |
| **aga-button** | SITUATIONAL | AREA | ALL | false | true | N-1 | true |
| **new-zealand** | SITUATIONAL | AREA | NONE | true | false | 0 | true |
| **stone-scoring** | SIMPLE | AREA | NONE | false | false | 0 | true |
| **bga** | SITUATIONAL | AREA | ALL | false | false | 0 | true |

**规则术语解释：**
- **ko 规则**: SIMPLE=简单劫(仅禁止立即回提), POSITIONAL=位置超劫, SITUATIONAL=情景超劫
- **计分方式**: AREA=数子法(中国), TERRITORY=数目法(日本)
- **税(tax)**: NONE=不扣目, SEKI=双活扣目, ALL=所有死子扣目
- **hasButton**: AGA 规则的特殊 Pass 按钮
- **贴目奖励(whiteHandicapBonus)**: 白方因让子获得的额外贴目补偿

### 3.2 细粒度规则配置（kata-set-rule）

可以通过 `kata-set-rule <规则项> <值>` 单独设置规则组件：

| 规则项 | 可选值 | 说明 |
|--------|--------|------|
| ko | SIMPLE, POSITIONAL, SITUATIONAL | 劫规则类型 |
| scoring | AREA, TERRITORY | 计分方式 |
| tax | NONE, SEKI, ALL | 税规则 |
| suicide | true, false | **仅控制多子自杀**，单子自杀始终非法 |
| hasButton | true, false | AGA Pass 按钮 |
| whiteHandicapBonus | 0, N, N-1 | 白方贴目奖励（**N-2 不被支持**） |
| friendlyPassOk | true, false | 友方 Pass 是否合法 |

**⚠️ 异常发现 1：hasButton + TERRITORY 被拒绝**

所有模型版本（v8, v14, v15）都拒绝 `hasButton=true` + `scoring=TERRITORY` 的组合：
```
kata-set-rule hasButton true    → = 
kata-set-rule scoring TERRITORY → ? Board position is invalid for this neural net
```
这是合理的，因为 hasButton 是 AGA 规则特有的，而 AGA 使用 AREA 计分。

**⚠️ 异常发现 2：suicide=true 的误导**

`suicide=true` **仅控制多子自杀**是否合法。单子自杀在所有规则设定下**始终被拒绝**，即使设置 `suicide=true`：
```
kata-set-rule suicide true  → =
play white A1               → ? illegal move
```
这是 KataGo 的设计决策，而非 bug。文档原文："Whether multi-stone suicide is legal"。

### 3.3 kgs-rules 命令

KGS 平台兼容命令，仅支持 4 种规则：
- `japanese` ✅
- `chinese` ✅
- `aga` ✅
- `new_zealand` ✅
- `norwegian`, `finnish`, `dutch` ❌ → 返回 `? unknown rule system`

### 3.4 规则对计分的实际影响（实测验证）

同一盘棋（9x9，黑白各 5 手），在不同规则下计分：

| 规则 | 计分结果 | 与 chinese 差异 |
|------|---------|----------------|
| chinese | W+1.5 | 基准 |
| japanese | W+2.5 | +1.0 |
| tromp-taylor | W+7.5 | +6.0 ⚠️ |
| aga | W+1.5 | 0 |
| new-zealand | W+1.5 | 0 |
| stone-scoring | W+1.5 | 0 |

**⚠️ 关键发现：tromp-taylor 的计分差异极大！** 这是因为 tromp-taylor 使用 AREA 计分 + POSITIONAL 超劫，对死子的判定与其他规则不同。

**规则可以在对局中途切换**，立即影响 `final_score` 的计算结果：
```
kata-set-rules japanese  → final_score = B+0.5
kata-set-rules chinese   → final_score = B+1.5
```

---

## 四、GTP 命令完整清单

通过 `list_commands` 获取的完整命令列表，共 **54 条**，全部经过实测验证。

### 4.1 标准 GTP 命令

| 命令 | 功能 | 实测状态 |
|------|------|---------|
| `protocol_version` | 返回 2 | ✅ |
| `name` | 返回引擎名 | ✅ |
| `version` | 返回版本号 | ✅ |
| `known_command <cmd>` | 检查命令是否存在 | ✅ |
| `list_commands` | 列出所有命令 | ✅ |
| `quit` | 退出 | ✅ |
| `boardsize <N>` | 设置棋盘大小 | ✅ |
| `clear_board` | 清空棋盘 | ✅ |
| `komi <K>` | 设置贴目 | ✅ |
| `play <color> <vertex>` | 落子 | ✅（⚠️ 不检查超级劫） |
| `genmove <color>` | 生成着法 | ✅ |
| `showboard` | 显示棋盘 | ✅ |
| `final_score` | 计算终局分数 | ✅ |
| `final_status_list <type>` | 列出死活子 | ✅ |
| `fixed_handicap <N>` | 固定让子 | ✅ |
| `place_free_handicap <N>` | 自由让子 | ✅ |
| `set_free_handicap <vertex>...` | 设置让子位置 | ✅ |
| `loadsgf <file>` | 加载 SGF 文件 | ✅ |
| `printsgf` | 输出当前局面的 SGF | ✅ |
| `undo` | 悔棋 | ✅ |
| `time_settings <M> <T> <S>` | 设置时间 | ✅ |
| `time_left <color> <T> <S>` | 报告剩余时间 | ✅ |
| `cputime` | 报告 CPU 使用时间 | ✅ |

### 4.2 KataGo 扩展命令

| 命令 | 功能 | 实测状态 | 备注 |
|------|------|---------|------|
| `kata-get-rules` | 获取当前规则(JSON) | ✅ | 返回完整规则描述 |
| `kata-set-rules <name>` | 设置规则预设 | ✅ | 支持 11 种 |
| `kata-set-rule <key> <val>` | 设置单个规则项 | ✅ | 见规则配置表 |
| `kata-list-params` | 列出可覆盖参数 | ✅ | **100+ 参数** |
| `kata-get-param <name>` | 获取参数值 | ✅ | |
| `kata-set-param <name> <val>` | 设置参数值 | ✅ | ⚠️ resignThreshold 不可覆盖 |
| `kata-get-models` | 获取模型信息(JSON) | ✅ | 包含版本、大小、校验和 |
| `kata-search <color>` | 搜索但不落子 | ✅ | |
| `kata-genmove_analyze <color> <visits>` | 生成着法+分析 | ✅ | 返回 JSON 含胜率/分数 |
| `kata-analyze <color> [interval] key value...` | 持续分析 | ✅ | 格式复杂，见下文 |
| `kata-raw-nn <symmetry>` | 原始神经网络输出 | ✅ | 策略+价值+领地预测 |
| `kata-time_settings <type> <args>` | 扩展时间设置 | ✅ | 支持 byoyomi 等 |
| `kata-list_time_settings` | 列出时间设置类型 | ✅ | |
| `kata-debug-print-tc` | 打印时间控制状态 | ✅ | |
| `kata-benchmark <visits>` | 性能基准测试 | ✅ | 返回 visits/s 和 nnEvals/s |
| `kata-search_cancellable <color>` | 可取消搜索 | ✅ | |

### 4.3 Leela Zero 兼容命令

| 命令 | 功能 | 实测状态 | 备注 |
|------|------|---------|------|
| `lz-genmove_analyze <color> <visits>` | LZ 格式的着法+分析 | ✅ | winrate 范围 0-10000 |
| `lz-analyze <color> <interval>` | LZ 格式持续分析 | ✅ | 输出格式不同于 kata 版 |

### 4.4 KGS 兼容命令

| 命令 | 功能 | 实测状态 |
|------|------|---------|
| `kgs-rules <name>` | 设置 KGS 规则 | ✅ 仅支持 4 种 |
| `kgs-genmove_cleanup <color>` | KGS 清理模式落子 | ✅ |
| `kgs-time_settings <type> <args>` | KGS 时间设置 | ✅ |
| `kgs-game_over` | KGS 对局结束 | ✅ |

### 4.5 其他命令

| 命令 | 功能 | 实测状态 |
|------|------|---------|
| `genmove_debug <color>` | 带调试信息的落子 | ✅ |
| `set_position <stones>` | 直接设置棋盘状态 | ✅ |
| `rectangular_boardsize <W> <H>` | 矩形棋盘 | ✅ |
| `clear_cache` | 清除搜索缓存 | ✅ |

---

## 五、关键 GTP 命令详细说明

### 5.1 `kata-genmove_analyze` — 最重要的分析命令

**格式**: `kata-genmove_analyze <color> <visits>`

**返回示例** (b18c384 模型，9x9 空盘):
```
= play E5
info move E5 visits 100 winrate 5588 scoreMean 5.55301 scoreStdev 25.9937 
  prior 1628 lcb 5585 utility 0.0562958 order 0 
  pv E5 D5 C5 F5 E4 D4 C4 F4 E3 
  pvVisits 49 9 8 7 6 5 5 4 4
```

**字段含义**：
| 字段 | 含义 |
|------|------|
| move | 推荐着法 |
| visits | 搜索访问次数 |
| winrate | 黑方胜率 (0-10000, 即 5588 = 55.88%) |
| scoreMean | 预期分数领先 (目数) |
| scoreStdev | 分数标准差 |
| prior | 先验概率 |
| lcb | 置信下界 |
| utility | 效用值 |
| pv | 主要变体序列 (预测的后续着法) |
| pvVisits | 各 PV 着法的访问次数 |

**扩展选项**:
```
kata-genmove_analyze black 100 ownershipStdev true
```
可附加 `ownershipStdev true` 获取每个位置的领地归属标准差。

**b18c384 模型额外字段** (v14+):
- `shorttermWinlossError`: 短期胜负预测误差
- `shorttermScoreError`: 短期分数预测误差
- `varTimeLeft`: 变体剩余时间

b6c96 模型这些字段值为 -1.000（不可用）。

### 5.2 `kata-analyze` — 持续分析模式

**格式**: `kata-analyze <color> [interval_centisec] key value...`

**键值对参数**:
| 键 | 值 | 说明 |
|-----|-----|------|
| visits | 整数 | 最大搜索次数 |
| rootInfo | true/false | 包含根节点信息 |
| ownership | true/false | 包含领地归属 |
| ownershipStdev | true/false | 包含领地标准差 |
| movesOwnership | true/false | 每个候选着的领地 |
| movesStdev | true/false | 每个候选着的标准差 |
| pvEdgeVisits | true/false | PV 边访问次数 |
| minmoves | 整数 | 最少候选着数 |

**⚠️ 管道模式问题**: 在非交互式管道输入中，`kata-analyze` 可能无法正常输出中间结果。建议使用 `kata-genmove_analyze` 替代，后者在管道模式下工作正常。

### 5.3 `kata-raw-nn` — 原始神经网络输出

**格式**: `kata-raw-nn <symmetry_index>`

- symmetry_index: 0-N (取决于模型，通常 0-7)
- 返回完整的策略分布和价值评估

**输出字段**:
- `policy`: 每个位置的先验概率
- `whiteWin`: 白方胜率
- `whiteLead`: 白方预期领先
- `whiteOwnership`: 每个位置的领地归属 (-1 到 1)

### 5.4 `kata-benchmark` — 性能基准

**格式**: `kata-benchmark <visits>`

输出示例:
```
= Benchmark visits/sec: 7.4448 nnEvals/sec: 7.14611 
  maxBatchSize: 64 avgBatchSize: 1.00000 
  totalNumNNEvals: 145 totalNumBatches: 145 
  elapsedNs: 20292952869
```

### 5.5 `kata-set-param` / `kata-get-param` — 运行时参数

通过 `kata-list-params` 可以获取 **100+** 可运行时覆盖的参数。

**常用参数**:
| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxVisits | 100 | 最大搜索次数 |
| numSearchThreads | 2 | 搜索线程数 |
| playoutDoublingAdvantage | -1 | 让子/倒贴模式 |
| analysisWideRootNoise | 0 | 分析时根节点噪声 |
| rootPolicyTemperature | 1.09 | 策略温度 |
| rootFpuReductionMax | 0.98 | FPU 衰减 |
| searchFactorAfterOnePass | 0.5 | 一次 Pass 后搜索量缩减 |
| searchFactorAfterTwoPass | 0.25 | 两次 Pass 后搜索量缩减 |
| allowResignation | true | 是否允许认输 |

**⚠️ 重要**: `resignThreshold` 不能通过 `kata-set-param` 修改，只能在配置文件中设置。尝试修改不会报错但不会生效。

---

## 六、棋盘尺寸与几何

### 6.1 标准棋盘

| 棋盘 | 支持 | 实测状态 |
|------|------|---------|
| 9×9 | ✅ | 正常工作，CPU 下可快速对弈 |
| 13×13 | ✅ | 正常工作，速度约为 9×9 的 1/3 |
| 19×19 | ✅ | 正常工作，b18c384 下约 30s+/步 |

### 6.2 特殊尺寸

| 棋盘 | 支持 | 实测状态 |
|------|------|---------|
| 2×2 | ✅ | 正常工作，可完成对局 |
| 5×5 | ✅ | 正常工作 |
| 9×13 (矩形) | ✅ | `rectangular_boardsize 9 13` |
| 20×20 | ❌ | "Unacceptable board size"，需重新编译 |

**⚠️ 矩形棋盘注意**: 使用 `rectangular_boardsize W H` 命令，其中 W 是列数，H 是行数。之后 `showboard` 正确显示矩形棋盘。

### 6.3 首次落子延迟

切换到新的棋盘大小时，首次 `genmove` 会有 **1-3 秒** 的额外延迟，原因是 NN 缓冲区需要调整。后续落子不受影响。

---

## 七、异常现象与 Bug 详录

### BUG 1: 旧模型使用非 tromp-taylor 规则崩溃 🔴 严重

**现象**: 模型版本 <=5（g103, grun2, grun50, run4）在使用 chinese/japanese/korean 等规则配置时崩溃。

**错误信息**:
```
ERROR: Neural net <model_name> does not support the specified rules
This net only supports tromp-taylor rules
```

**影响**: 引擎进程直接退出，无法继续使用。

**解决方案**: 为旧模型创建单独的配置文件 `gtp_config_tt.cfg`，设置 `rules = tromp-taylor`。

**根因**: 旧版模型训练时仅使用 tromp-taylor 规则，NN 不包含其他规则的训练数据。

### BUG 2: `play` 命令不执行超级劫检查 🔴 严重

**现象**: 在 POSITIONAL 超劫规则下，`play` 命令允许无限循环提子，不检查是否违反超级劫。

**复现步骤**:
```
kata-set-rules tromp-taylor
play black B1  → =
play white C1  → =
play black A2  → =
play white B2  → =
play black C2  → =
play white A1  → =  (白提黑 B1)
play black B1  → =  (黑提白 A1) ← 这是 ko
play white A1  → =  (白提黑 B1) ← 应该被超级劫禁止！但实际被允许
play black B1  → =  (循环继续...)
```

**对比**: `genmove` 命令正确避免了 ko 位置，选择了其他着法（如 B3）。

**影响**: 在引擎对战中，如果一方使用 `play` 而非 `genmove`，可能出现无限循环。

**建议**: 在对弈调度代码中，始终使用 `genmove` 而非 `play` 来生成着法，`play` 仅用于手动指定。

### BUG 3: hasButton + TERRITORY 计分被拒绝 🟡 中等

**现象**: 所有模型版本拒绝 `hasButton=true` + `scoring=TERRITORY` 的组合。

**错误信息**: `? Board position is invalid for this neural net`

**影响**: 无法创建同时使用 hasButton 和 TERRITORY 计分的规则组合。

**解决方案**: hasButton 仅用于 AREA 计分（如 `aga-button` 预设）。

### BUG 4: suicide=true 仅控制多子自杀 🟡 中等

**现象**: 设置 `suicide=true` 后，单子自杀着法仍然被拒绝为 "illegal move"。

**文档确认**: KataGo 文档原文为 "Whether **multi-stone** suicide is legal"，单子自杀始终非法。

**影响**: 在 new-zealand 规则下（suicide=true），理论上所有自杀都应该合法，但实际只有多子自杀被允许。对于新新西兰规则的完整实现可能有问题。

### BUG 5: komi 值限制 🟡 中等

**限制详情**:
- komi 必须是**整数或半整数**（0, 0.5, 1, 1.5, ...）
- 0.25, 0.1, 0.125 等分数 komi 被拒绝
- 上限与棋盘大小相关：9×9 约 185.5，19×19 约 380.5
- 负 komi 允许（如 -5.5）
- komi=0 允许

**错误信息**: `? unacceptable komi`

### BUG 6: resignThreshold 不可运行时修改 🟢 轻微

**现象**: `kata-set-param resignThreshold -0.80` 命令不报错，但实际不生效。

**影响**: 无法在对局中动态调整认输阈值。

**解决方案**: 在配置文件中预设，或启动新实例时使用不同配置。

### BUG 7: 时间耗尽仍正常落子 🟢 轻微

**现象**: 即使设置 `time_left black 0 0`，KataGo 仍然正常生成着法。

**根因**: GTP 协议本身没有"超时判负"的概念，`time_left` 仅用于引擎内部的时间管理优化（更聪明地分配搜索时间）。

**影响**: 对弈平台需要自行实现超时判负逻辑，不能依赖引擎。

---

## 八、时间控制系统

### 8.1 标准时间设置

```
time_settings <main_time> <byo_yomi_time> <byo_yomi_stones>
```
- `0 0 0`: 无时间限制
- `0 300 1`: 30 秒加拿大式读秒（每 1 手 300 秒）

### 8.2 KataGo 扩展时间设置

```
kata-time_settings <type> <args...>
```

支持类型:
| 类型 | 格式 | 说明 |
|------|------|------|
| absolute | `<seconds>` | 绝对时间 |
| byoyomi | `<main> <period> <stones>` | 日本读秒 |
| canadian | `<main> <period> <stones>` | 加拿大读秒 |
| fischer | `<main> <increment>` | 菲舍尔增时 |

### 8.3 调试输出

`kata-debug-print-tc` 输出当前时间控制状态，包含 mainTimeLeft, stonesLeft 等。

---

## 九、让子（Handicap）系统

### 9.1 `fixed_handicap <N>`

在标准星位放置让子，返回放置的位置列表。

9×9 固定让子位置:
| 让子数 | 位置 |
|--------|------|
| 2 | G7, C3 |
| 3 | G7, C3, C7 |
| 4 | G7, C3, G3, C7 |
| 5 | G7, C3, G3, C7, E5 (天元) |

### 9.2 `place_free_handicap <N>`

引擎自行选择让子位置（通常与固定位置不同，更灵活）。

**关键差异**: `fixed_handicap` 使用传统星位，`place_free_handicap` 由引擎根据策略选择。

两种方式都会触发 `Handicap bonus score` 影响 `final_score` 的计算。

---

## 十、对战实测结果

### 10.1 跨引擎对战（9×9, 中国规则, 贴目 7.5）

| 对战组合 | 结果 | 手数 | 备注 |
|----------|------|------|------|
| GnuGo(L10) vs GnuGo(L5) | 白胜 2.5 目 | 68 | 水平差距不大 |
| KataGo(b6c96) vs GnuGo(L10) | 黑胜 22.5 目 | 70 | KataGo 明显强于 GnuGo |
| Pachi vs GnuGo(L10) | 黑胜 (resign) | 80 | Pachi 略强 |
| KataGo(b6c96) vs Pachi | 黑胜 (resign) | 52 | KataGo 远强于 Pachi |

### 10.2 KataGo 模型间对战

| 对战组合 | 结果 | 备注 |
|----------|------|------|
| b10c128 vs b6c96 | b10c128 胜 (resign) | 更大模型确实更强 |

### 10.3 各引擎每步耗时 (9×9, CPU)

| 引擎 | 每步耗时 | 备注 |
|------|---------|------|
| GnuGo | <0.1s | 极其稳定 |
| KataGo (b6c96) | 2-5s | 100 visits |
| KataGo (b10c128) | 3-8s | 100 visits |
| KataGo (b18c384) | 10-40s | 100 visits |
| KataGo (b28c512) | 30-120s | 100 visits |
| Pachi | 4-7s | 无 DCNN 版本 |

---

## 十一、配置文件详解

### 11.1 标准配置 (`gtp_config.cfg`)

```ini
logDir = /tmp/katago_logs
logAllGTPCommunication = true
logSearchInfo = false
logToStderr = false

rules = chinese           # 默认规则
defaultBoardSize = 19     # 默认棋盘

maxVisits = 100           # 搜索次数上限
numSearchThreads = 2      # 搜索线程数

allowResignation = true   # 允许认输
resignThreshold = -0.90   # 认输阈值
resignConsecTurns = 3     # 连续 N 步低于阈值才认输
```

### 11.2 旧模型配置 (`gtp_config_tt.cfg`)

```ini
rules = tromp-taylor      # 旧模型仅支持此规则
# 其余同上
```

### 11.3 关键配置参数说明

| 参数 | 推荐值(CPU) | 说明 |
|------|------------|------|
| maxVisits | 50-200 | CPU 下建议降低，100 约 3-10s/步 |
| numSearchThreads | 2-4 | 不超过 CPU 核心数 |
| maxPlayouts | 不设 | 与 maxVisits 二选一 |
| maxTime | 不设 | 时间限制（秒），与 maxVisits 二选一 |
| resignThreshold | -0.90 | 建议不低于 -0.85，避免过早认输 |
| logAllGTPCommunication | true | 调试时开启，生产环境关闭 |

---

## 十二、实践建议

### 12.1 模型选择指南

| 场景 | 推荐模型 | 理由 |
|------|---------|------|
| 快速测试 | b6c96 | 最快，但棋力弱 |
| 日常对弈 (9×9) | b10c128 | 速度/棋力平衡好 |
| 认真评测 (9×9) | b18c384 | 专业级棋力 |
| 19×19 对弈 | b6c96 或 b10c128 | 大模型在 CPU 上太慢 |
| 研究旧版 NN | g103 | 仅限 tromp-taylor |

### 12.2 对弈平台开发注意事项

1. **规则一致性**: 对战双方必须使用相同规则。建议默认使用 `chinese`（跨引擎兼容性最好）
2. **超时判负**: 必须在平台层实现，GTP 协议不支持
3. **着法验证**: 使用 `genmove` 生成着法（自动避免非法着），不要用 `play`
4. **进程管理**: KataGo 每次启动需要 1-3s 初始化，建议复用进程而非每次创建
5. **旧模型隔离**: g103 等模型必须使用 tromp-taylor 配置，否则崩溃
6. **ko 处理**: `play` 命令不做超级劫检查，平台需要额外验证或仅用 `genmove`
7. **认输处理**: KataGo 可能在劣势时自动认输（resignThreshold 可配），需正确处理
8. **并行实例**: 多个 KataGo 进程可以并行运行，互不干扰
The user wants a comprehensive detailed report of all the research findings on KataGo. Let me compile everything I've tested and discovered into a thorough report.
输出一份详尽的报告给我