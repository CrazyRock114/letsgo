# KataGo 引擎深度研究文档

> 生成时间: 2026-04-23  
> 研究目的: 为围棋游戏网站集成KataGo引擎提供完整技术参考

---

## 一、KataGo 核心架构概述

### 1.1 引擎运行模式
KataGo 有两种主要运行模式：
- **GTP 模式** (`katago gtp`): 用于人机对弈和实时分析
- **Analysis 引擎模式** (`katago analysis`): 用于批量并行分析

```
katago gtp -model <model.bin.gz> -config gtp.cfg
katago analysis -model <model.bin.gz> -config analysis.cfg
```

### 1.2 支持的棋盘尺寸
| 尺寸 | 支持情况 | 备注 |
|------|----------|------|
| 9x9 | ✅ 完全支持 | KataGo 专门训练过 |
| 13x13 | ✅ 完全支持 | |
| 19x19 | ✅ 完全支持 | 标准比赛尺寸 |
| 方形非标准 | ✅ 支持 | 如 11x11, 15x15 |
| 矩形 | ✅ 支持 | 通过 `rectangular_boardsize X Y` 设置 |
| > 21x21 | ⚠️ 可能有问题 | 取决于模型训练数据 |

**重要**: 默认 KataGo 模型在各种尺寸上都经过训练，但如果使用自定义模型，请确认该模型是否支持目标尺寸。

---

## 二、GTP 协议详解

### 2.1 基础 GTP 命令（标准）
| 命令 | 说明 | 示例 |
|------|------|------|
| `boardsize N` | 设置方形棋盘 | `boardsize 19` |
| `boardsize X Y` | 设置矩形棋盘 | `boardsize 9 11` |
| `clear_board` | 清空棋盘 | `clear_board` |
| `komi <float>` | 设置贴目 | `komi 7.5` |
| `play <color> <vertex>` | 落子 | `play black D4` |
| `genmove <color>` | 生成最优着法 | `genmove black` |
| `showboard` | 显示棋盘 | `showboard` |
| `undo` | 撤销 | `undo` |
| `quit` | 退出 | `quit` |

**Vertex 格式**:
- 列: A-T (跳过 I)，即 A, B, C, ..., H, J, K, ..., T
- 行: 1-19 或 1-9
- 特殊值: `pass`, `resign`

### 2.2 KataGo GTP 扩展命令

#### 2.2.1 棋盘和规则设置
```
# 设置棋盘
rectangular_boardsize X Y    # 矩形棋盘

# 获取/设置规则
kata-get-rules               # 返回当前规则 JSON
kata-set-rules <rules>       # 设置规则 (JSON 或简写)
kata-set-rule <rule> <value> # 设置单个规则

# 支持的规则简写
tromp-taylor, chinese, chinese-ogs, chinese-kgs, 
japanese, korean, stone-scoring, aga, bga, 
new-zealand, aga-button
```

**kata-get-rules 返回示例**:
```json
{
  "hasButton": false,
  "ko": "POSITIONAL",
  "scoring": "AREA",
  "suicide": true,
  "tax": "NONE",
  "whiteHandicapBonus": "N-1",
  "friendlyPassOk": true
}
```

**规则字段详解**:
| 字段 | 可选值 | 说明 |
|------|--------|------|
| ko | SIMPLE, POSITIONAL, SITUATIONAL | 劫的规则 |
| scoring | AREA, TERRITORY | 计法(数棋法) |
| tax | NONE, SEKI, ALL | 纳税规则 |
| suicide | true/false | 是否允许自杀着法 |
| hasButton | true/false | 是否有按钮 |
| whiteHandicapBonus | 0, N-1, N | 白棋让子奖励 |
| friendlyPassOk | true/false | 友好 Pass 是否允许 |

#### 2.2.2 时间控制
```
kata-time_settings none | absolute <main> | 
                    byoyomi <main> <byo> <periods> |
                    canadian <main> <byo> <stones> |
                    fischer <main> <increment>

kata-list_time_settings      # 列出支持的时间设置
kata-debug-print-tc          # 打印时间控制调试信息
```

#### 2.2.3 缓存控制
```
clear_cache    # 清除搜索树和 NN 缓存
stop           # 停止正在进行的 pondering
```

#### 2.2.4 参数管理
```
kata-get-param <name>        # 获取单个参数
kata-set-param <name> <val>  # 设置单个参数
kata-get-params              # 获取所有参数 JSON
kata-set-params <params>     # 批量设置参数
kata-list-params             # 列出所有可用参数
```

---

## 三、核心分析命令详解

### 3.1 lz-analyze 命令
**格式**: `lz-analyze [player] [interval] [key=value]...`

**参数**:
| 参数 | 说明 | 示例 |
|------|------|------|
| interval | 打印间隔(厘秒) | `interval 100` |
| minmoves | 最少显示着法数 | `minmoves 5` |
| maxmoves | 最多显示着法数 | `maxmoves 20` |
| avoid | 禁止着法 | `avoid black D4 10` |
| allow | 允许着法 | `allow black D4 10` |

**输出格式**:
```
info move D4 visits 156 winrate 5243 order 0 pv D4 Q16 R5 ...
info move Q16 visits 89 winrate 5089 order 1 pv Q16 D4 ...
```

**字段说明**:
- `move`: 着法坐标
- `visits`: 搜索次数
- `winrate`: 胜率 (0-10000，如 5243 = 52.43%)
- `order`: 排序顺序
- `pv`: 主要变化线
- `score`: 预期目数差
- `lcb`: 置信区间下限
- `prior`: 先验概率

### 3.2 kata-analyze 命令
**格式**: `kata-analyze [player] [interval] [key=value]...`

**扩展参数**:
| 参数 | 说明 |
|------|------|
| rootInfo true | 输出根节点信息 |
| ownership true | 输出归属统计 |
| ownershipStdev true | 输出归属标准差 |
| movesOwnership true | 输出每步归属 |
| pvVisits true | 输出 PV 访问数 |
| pvEdgeVisits true | 输出 PV 边缘访问数 |
| noResultValue true | 输出无结果值 |

**输出格式** (JSON):
```json
{
  "type":"info",
  "action":"D4",
  "visits":156,
  "winrate":0.5243,
  "scoreMean":2.5,
  "scoreStdev":8.2,
  "scoreLead":1.2,
  "scoreMeanBeforePass":2.8,
  "scoreStdevBeforePass":7.9,
  "utility":0.45,
  "utilityLcb":0.42,
  "rank":0,
  "prior":0.12,
  "order":0,
  "pv":["D4","Q16","R5","... 更多着法"],
  "pvVisits":[156,145,132,...],
  "ownership":{
    "D4":0.85,
    "Q16":-0.45,
    ...
  }
}
```

### 3.3 kata-search 命令族
| 命令 | 说明 |
|------|------|
| `kata-search` | 搜索但不落子 |
| `kata-search_cancellable` | 可取消的搜索 |
| `kata-search_analyze` | 搜索+分析输出 |
| `kata-search_analyze_cancellable` | 可取消的搜索+分析 |

### 3.4 genmove 系列
| 命令 | 说明 |
|------|------|
| `genmove <color>` | 生成最优着法 |
| `genmove_analyze <color> [interval]` | 生成+分析 |
| `kata-genmove_analyze <color> [interval]` | Kata格式生成+分析 |

---

## 四、GTP 配置参数详解

### 4.1 关键配置参数

```cfg
# ========== 基础配置 ==========
# 模型文件路径
model = models/best.bin.gz

# 缓存大小 (必须是 2 的幂)
nnCacheSizePowerOfTwo = 20          # 默认 2^20 = 1M 条目

# ========== 搜索限制 ==========
# 最大访问数 (0=无限制)
maxVisits = 100

# 最大 playouts (0=无限制)
# 注意: playouts 和 visits 在 MCTS 中不完全等价
maxPlayouts = 500

# 最大思考时间(秒)
maxTime = 10

# ========== 分析参数 ==========
# 分析宽度根节点噪声
# 值越大，搜索更多候选项
analysisWideRootNoise = 0.0         # 默认 0，建议 0.05-0.3

# 根节点温度 (影响随机性)
rootNoiseEnabled = false
rootTemperature = 1.0

# ========== 博弈设置 ==========
# 思考模式
#   reading, playing, analysis
# reading 模式不会提前返回结果
playoutDoublingAdvantage = 0        # [-3, 3]
fpuBehavior = 0                     # [-2, 2]

# ========== 强度设置 ==========
# 动态强度 (相对于默认)
# -2.0 ~ +2.0，负值更强
playoutDoublingAdvantagePla = -0.2

# 或者固定强度
# UseFixedReadPolicy = true
# FixedReadPolicyValue = 0
```

### 4.2 配置参数对照表

| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| maxVisits | int | 0 | 最大访问数，0=无限制 |
| maxPlayouts | int | 0 | 最大 playouts |
| maxTime | float | 0 | 最大时间(秒) |
| analysisWideRootNoise | float | 0.0 | 分析宽度噪声 |
| rootNoiseEnabled | bool | false | 根节点噪声开关 |
| rootTemperature | float | 1.0 | 温度参数 |
| playoutDoublingAdvantage | int | 0 | Playout 加倍优势 |
| numSearchThreads | int | 自动 | 搜索线程数 |
| nnCacheSizePowerOfTwo | int | 17 | NN 缓存大小 |
| earlyExitSaver | float | 0.5 | 早退阈值 |

---

## 五、Analysis 引擎模式

### 5.1 启动方式
```bash
katago analysis -model models/best.bin.gz -config analysis.cfg
```

### 5.2 协议格式
Analysis 引擎使用异步 JSON 协议：
- 查询: 通过 stdin 发送 JSON 行
- 响应: 通过 stdout 返回 JSON 行

**查询格式**:
```json
{
  "id": "query-1",
  "type": "analysis",
  "moves": [["B", "D4"], ["W", "Q16"]],
  "visitLimit": 100,
  "allowAsync": true
}
```

**响应格式**:
```json
{
  "id": "query-1",
  "type": "analysis",
  "moves": [...],
  "results": {
    "winrates": {"D4": 0.5243, "Q16": 0.4892, ...},
    "visits": {"D4": 156, "Q16": 89, ...},
    "pv": {"D4": ["D4", "Q16", ...], ...},
    "ownership": {"D4": 0.85, ...}
  }
}
```

### 5.3 查询类型

| 类型 | 说明 |
|------|------|
| analysis | 分析当前局面 |
| quit | 优雅退出 |
| echo | 心跳测试 |

---

## 六、已知问题与 Bug

### 6.1 高优先级问题 (会导致测试不稳定)

#### 6.1.1 Loose Ladder 问题 ⚠️
```
状态: 长期存在，v1.14+ 更严重
问题: KataGo 无法正确处理松散的征子(ladders)
影响: 征子相关局面分析可能完全错误
缓解: 增加 visits 或使用更强的模型
```

#### 6.1.2 模型不匹配问题 ⚠️
```
问题: 不同版本模型在同一位置给出差异很大的评估
原因: 模型训练数据或超参数差异
影响: 换模型后测试结果不可比
解决: 固定使用同一模型版本
```

#### 6.1.3 GPU 驱动兼容问题 ⚠️
```
问题: 特定 GPU 驱动版本导致崩溃或错误结果
影响: OpenCL/CUDA 版本稳定性
解决: 使用官方预编译版本，或确认驱动兼容性
```

### 6.2 中优先级问题

#### 6.2.1 NN 缓存导致的非确定性
```
问题: 相同局面可能因缓存命中返回不同结果
原因: 并行访问缓存的顺序差异
影响: 相同设置下结果略有波动
解决: 设置 numSearchThreads = 1 或禁用缓存
```

#### 6.2.2 时间控制精度
```
问题: GTP 模式下的时间控制可能有秒级误差
影响: 快速对局中影响更大
解决: 使用 maxVisits 而非 maxTime
```

#### 6.2.3 规则实现差异
```
问题: 不同规则设置下胜负判定可能与你的网站不一致
原因: KataGo 的规则实现与标准可能有细微差别
影响: 和棋判定、超时处理等
解决: 明确设置正确的规则并验证
```

### 6.3 低优先级问题

#### 6.3.1 analyze 命令的顺序不确定性
```
问题: `kata-analyze` 的输出顺序在某些版本中可能不一致
影响: 解析时需注意排序
解决: 始终按 winrate 排序后再使用
```

#### 6.3.2 矩形棋盘支持不完整
```
问题: 某些分析工具对矩形棋盘支持有限
影响: 分析可视化可能出错
解决: 测试特定尺寸，或使用方形棋盘
```

---

## 七、实测流程设计

### 7.1 环境验证流程

```bash
#!/bin/bash
# 1. 基本连接测试
echo "list_commands" | katago gtp -model model.gz -config cfg.yaml
# 期望: 返回支持的命令列表

# 2. 版本验证
echo "kata-get-params" | katago gtp -model model.gz -config cfg.yaml
# 期望: 返回参数字典，包含 version 字段

# 3. 规则验证
echo "kata-get-rules" | katago gtp -model model.gz -config cfg.yaml
# 期望: 返回规则 JSON
```

### 7.2 确定性测试流程

**目标**: 验证相同设置下结果的一致性

```python
def test_determinism():
    """测试多次查询的一致性"""
    
    # 固定设置
    setup_commands = [
        "boardsize 19",
        "clear_board",
        "kata-set-rules chinese",
        "komi 7.5",
        "play black D4",
        "play white Q16"
    ]
    
    # 多次查询
    results = []
    for _ in range(5):
        engine.reset()
        for cmd in setup_commands:
            engine.send(cmd)
        
        # 使用固定 visits
        engine.send("kata-search_analyze black maxVisits 100")
        result = engine.read_analysis()
        results.append(result)
    
    # 验证一致性
    winrates = [r['winrate'] for r in results]
    assert max(winrates) - min(winrates) < 0.001, \
        f"Winrate variance too high: {winrates}"
```

### 7.3 评估验证流程

**目标**: 验证 KataGo 评估与你网站逻辑的一致性

```python
def test_evaluation_consistency():
    """测试评估结果与网站逻辑的一致性"""
    
    # 设置已知局面
    # 例如: 空棋盘黑先手，应该有约 50% 胜率
    
    test_cases = [
        {
            "name": "empty_board_first_move",
            "setup": ["boardsize 19", "clear_board"],
            "expected_winrate_range": (0.48, 0.52),
            "tolerance": 0.05
        },
        {
            "name": "simple_eye",
            "setup": [
                "boardsize 9", "clear_board",
                "play black A1", "play white A2",
                "play black B1", "play white B2"
            ],
            "expected": "黑先手有利",
            "tolerance": 0.1
        }
        # 更多测试用例...
    ]
    
    for case in test_cases:
        engine.reset()
        for cmd in case["setup"]:
            engine.send(cmd)
        
        result = engine.analyze(visits=200)
        
        # 验证
        assert case["expected_winrate_range"][0] <= result.winrate <= case["expected_winrate_range"][1], \
            f"Case {case['name']} failed: {result.winrate}"
```

### 7.4 性能测试流程

```python
def test_performance():
    """测试引擎性能特征"""
    
    import time
    
    test_sizes = [9, 13, 19]
    visits_list = [50, 100, 200, 500]
    
    results = []
    
    for size in test_sizes:
        for visits in visits_list:
            engine.reset()
            engine.send(f"boardsize {size}")
            engine.send("clear_board")
            
            # 落子到一定深度
            for i in range(20):
                engine.send(f"play {'BW'[i%2]} {random_move()}")
            
            start = time.time()
            result = engine.analyze(visits=visits)
            elapsed = time.time() - start
            
            results.append({
                "board_size": size,
                "visits": visits,
                "time": elapsed,
                "throughput": visits / elapsed
            })
    
    # 分析性能特征
    # 预期: 9x9 最快，visits 增加时间近似线性
    print_results(results)
```

### 7.5 规则验证流程

```python
def test_rules():
    """验证各种规则设置"""
    
    rules_to_test = [
        ("tromp-taylor", {"scoring": "AREA", "suicide": True}),
        ("chinese", {"scoring": "AREA", "suicide": True}),
        ("japanese", {"scoring": "TERRITORY", "tax": "ALL"}),
    ]
    
    for rule_name, expected_fields in rules_to_test:
        engine.reset()
        engine.send(f"kata-set-rules {rule_name}")
        
        actual_rules = engine.send_and_read("kata-get-rules")
        
        for key, expected in expected_fields.items():
            actual = actual_rules.get(key)
            assert actual == expected, \
                f"Rule {rule_name}.{key}: expected {expected}, got {actual}"
```

---

## 八、常见问题排查清单

| 问题 | 可能原因 | 解决方案 |
|------|----------|---------|
| 分析结果波动大 | visits 太低 | 增加 visits 到 200+ |
| 结果不符合预期 | 规则设置错误 | 检查 komi 和 scoring |
| 引擎响应慢 | GPU 负载高/线程冲突 | 减少线程数，检查驱动 |
| 不同机器结果不同 | 浮点精度/模型不一致 | 使用相同版本 |
| 换模型后结果差异大 | 模型训练数据差异 | 理解模型特性 |
| 长计算后崩溃 | 内存不足 | 减少 nnCacheSize |
| 并行分析结果异常 | 异步协议处理错误 | 检查 JSON 解析 |

---

## 九、推荐配置方案

### 9.1 网站集成推荐配置

```cfg
# gtp_production.cfg

# 模型
model = /path/to/katago model.bin.gz

# 性能
numSearchThreads = 4              # 根据 CPU 调整
nnCacheSizePowerOfTwo = 20

# 分析质量
maxVisits = 200                   # 推荐最低值
analysisWideRootNoise = 0.1      # 分析时增加

# 规则
# 使用 Chinese Rules (中国规则)
kata-set-rules chinese

# komi
komi = 7.5

# 确定性 (如果需要)
# numSearchThreads = 1           # 单线程更确定
```

### 9.2 测试环境配置

```cfg
# gtp_test.cfg

model = /path/to/model.bin.gz
numSearchThreads = 1              # 确定性
nnCacheSizePowerOfTwo = 10        # 较小缓存

# 固定分析参数
maxVisits = 500
analysisWideRootNoise = 0.0      # 无噪声

# 日志
logFile = katago_test.log
logAllQueries = true
```

---

## 十、下一步建议

1. **模型选择**: 确认使用的 KataGo 模型版本和训练数据
2. **规则对齐**: 与你的围棋网站规则完全对齐
3. **测试用例**: 准备标准测试局面集合进行验证
4. **监控**: 添加结果监控，检测异常波动
5. **Fallback**: 考虑模型加载失败的处理方案

---

## 附录 A: GTP 响应码

| 码 | 含义 |
|----|------|
| = | 成功响应 |
| ? | 错误响应 |
| info | 信息输出 (analyze) |

## 附录 B: 坐标转换

```
KataGo GTP 使用:
- 列: A-T (跳过 I)
- 行: 1-19 (从下往上)
- 左下角是 A1

转换示例:
- D4 -> (3, 15) (0-indexed)
- T19 -> (18, 18) -> pass
```

---

*文档版本: 1.0*
*数据来源: KataGo GitHub 官方文档, v1.15*
