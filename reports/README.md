# KataGo 引擎研究 & 测试床

> 这份研究针对 KataGo 引擎在实际接入围棋游戏/分析服务时常见的"结果不稳定、与预期差异大"
> 等问题，系统整理了文档细节、踩坑点，并**在本机以 Eigen (CPU) 后端 + g170 b20c256x2 网络真实跑通了 4 类验证实验**。
>
> 本目录结构即可交付给开发团队作为 KataGo 接入规范的参考。

## 目录导览

```
research/katago/
├── README.md                   # 本文件
├── docs/                       # 静态研究文档 (不依赖引擎)
│   ├── 01-engine-modes-comparison.md    # GTP vs Analysis Engine 对比
│   ├── 02-analysis-json-protocol.md     # Analysis JSON 协议字段速查
│   ├── 03-rulesets-and-boards.md        # 规则集 / 棋盘尺寸 / 让子棋
│   └── 04-pitfalls-and-troubleshooting.md   # 踩坑大全 (按优先级分类)
├── configs/
│   ├── deterministic.cfg       # 确定性测试专用配置 (单线程, nnRandomize=false)
│   └── production.cfg          # 模拟生产配置 (多线程, wideRootNoise, 用于对比)
├── scripts/
│   ├── kata_client.py          # Python 客户端 (纯 stdlib)
│   ├── test_01_determinism.py      # 验证: 可控条件下 KataGo 完全确定
│   ├── test_02_rules_komi.py       # 验证: 规则/komi/让子补偿对 scoreLead 的影响
│   ├── test_03_output_fields.py    # 验证: 所有 include* 字段 / symHash / rootInfo
│   └── test_04_perspective_and_history.py  # 验证: 视角 + ignorePreRootHistory
└── results/                    # 测试运行结果 (JSON + 日志)
```

## 当前环境

- OS: Ubuntu 24.04, x86_64, 2 核 CPU, 3.4GB 内存, **无 GPU**
- KataGo: v1.16.3, **Eigen (CPU) + AVX2** 后端
- 网络: `g170e-b20c256x2-s5303129600-d1228401921.bin.gz` (~87MB, 2020 年训练)
- 性能: 约 **7 visits/s** on 19x19, 足够做协议/字段/规则类验证

CPU + 老网络跑不动大规模棋力对比，但**完全够用来验证文档描述的所有协议细节**。
把本测试床部署到你的 GPU 环境里，换成 `b18c384nbt-humanv0` 或 `b28c512nbt` 现役网络，
即可跑正式的棋力/性能测试。

## 快速上手

### 1. 跑一个确定性测试

```bash
cd /home/ecs-user/.openclaw/workspace-weiqiyanjiuyuan
python3 research/katago/scripts/test_01_determinism.py --visits 30 --n-runs 3 --board 9
```

应该看到 3 组实验：
- A (deterministic.cfg + clear_cache 每次)：**✅ 完全一致**
- B (deterministic.cfg, 无 clear_cache)：**✅ 完全一致** (NN cache 命中后秒回)
- C (production.cfg)：**❌ 每次结果略有波动** (wideRootNoise + 多线程)

### 2. 验证规则 / komi / 让子补偿

```bash
python3 research/katago/scripts/test_02_rules_komi.py --visits 20
```

### 3. 验证所有 JSON 输出字段

```bash
python3 research/katago/scripts/test_03_output_fields.py
```

### 4. 验证视角 + 手序影响

```bash
python3 research/katago/scripts/test_04_perspective_and_history.py
```

## 核心结论（来自实测）

### ✅ 已验证的文档行为

1. **`reportAnalysisWinratesAs`** 决定视角：`winrate(BLACK) + winrate(WHITE) == 1.000`
2. **`scoreMean == scoreLead`** 逐字节一致（所有候选手）
3. **`ignorePreRootHistory = true`** 确实消除了手序影响：同一局面两种到达方式，winrate 差异 = 0.0000
4. **`symHash` 对称等价**：C3 和 G3（镜像）有相同 symHash，但 thisHash 不同
5. **`policy` 数组长度 = X*Y + 1**，最后一位是 pass，合法着法的概率和 ≈ 1.0
6. **`ownership` 数组值域 [-1, 1]**，长度 = X*Y
7. **`clear_cache` 实际生效**：首次调用后，第二次 query 需要重新跑完整 MCTS

### 🔥 发现的文档/实现差异

1. **`includeNoResultValue` 在 v1.16.3 被标记为 unused 字段**！
   - 文档说能用，但实测触发 warning："Unexpected or unused field"
   - 正确做法：从 `rootInfo.rawNoResultProb` 取值（本测试床已验证此字段存在且返回真实数据，如 `0.00106`）
2. **`komi` 对 `scoreLead` 的斜率不是完美的 -1**
   - 实测 -0.924（而非 -1.0）
   - 原因推测：MCTS 不是纯线性函数，不同 komi 下搜索树路径略有差异
3. **`g170-b20c256x2` 在 Japanese 规则下预测偏差较大**
   - 同局面 `chinese` rules 下 winrate=35.2%，`japanese` rules 下降到 20.8%
   - 老网络在 territory scoring 上的已知弱点

### ⚠️ 可观察到的"非确定性来源"清单

| 来源 | 是否默认开启 | 如何关闭/控制 |
|---|---|---|
| `wideRootNoise`（analysis 默认 0.04） | ✅ | `overrideSettings: {"wideRootNoise": 0.0}` 或配置里设 0 |
| `nnRandomize` | ✅ | `nnRandomize = false` |
| `rootNumSymmetriesToSample > 1` | ❌ (默认 1) | 保持 1 |
| 多线程调度（`numSearchThreads > 1`） | ✅ | `numSearchThreadsPerAnalysisThread = 1` |
| NN cache 命中（影响"变异后再查"行为） | ✅ | 每次 `clear_cache` |
| `chosenMoveTemperature*`（仅 GTP） | ✅ | GTP 配置里设 0 |

`deterministic.cfg` 把这些全部设成了"可重复"状态。

## 迁移到 GPU 环境的 checklist

当把这套测试床部署到有 GPU 的环境 (CUDA/OpenCL/TensorRT)：

1. 下载 GPU 版 KataGo
   ```bash
   wget https://github.com/lightvector/KataGo/releases/download/v1.16.3/katago-v1.16.3-cuda12.1-linux-x64.zip
   ```
2. 下载现役网络（看 <https://katagotraining.org/networks/>）
   ```bash
   # 推荐: b28c512nbt (最强) 或 b18c384nbt (速度平衡)
   ```
3. 覆盖配置：
   - `nnMaxBatchSize`: 根据 GPU 显存调大（A100 可以到 256+）
   - `numAnalysisThreads`: 按预期并发 query 数
   - `numSearchThreadsPerAnalysisThread`: 2~4（per position 内部并行）
   - 启用 GPU: 看 `analysis_example.cfg` 里的 CUDA/TensorRT 段
4. 跑 `kata-benchmark` 确认吞吐：
   ```bash
   ./katago benchmark -model MODEL -config analysis.cfg -v 800
   ```
5. 用本测试床的所有 test_*.py 重跑一遍做回归：
   - Group A 仍应 deterministic（改 `numSearchThreadsPerAnalysisThread=1`, `nnRandomize=false`）
   - Group C 应能看到预期规模的抖动

## 下一步建议（给用户）

根据这个研究，我给你这几个行动项：

### 立即行动
1. **对照 `04-pitfalls-and-troubleshooting.md` 过一遍你的配置**，特别是：
   - `reportAnalysisWinratesAs`：前端是按哪方视角解释？是否固定？
   - `wideRootNoise`：你的 analysis 引擎是否开了？如果要稳定结果就关掉
   - `chosenMoveTemperature`：GTP 的对弈 bot 有没有不小心设成 0？（完全确定性会让对弈太单调）
2. **复现一个你遇到过的"不稳定"案例**：
   - 把你的 config 和一个具体 query 发给我
   - 我把它丢到 `research/katago/test-positions/` 下跑确定/非确定对比

### 后续做
1. **用 Analysis Engine 的 `symHash` 做 opening book 去重**：
   - 镜像/旋转等价的局面可以共用一份分析结果，节省算力
2. **建立黄金测试集**：
   - 准备 50~100 个典型局面（开局、中盘战、死活、官子）
   - 在每次换网络/升 KataGo 版本时跑一次全量回归
3. **监控指标**：
   - 实时看 `rootInfo.rawStWrError` 和 `rawStScoreError`：当数值很大说明 NN 自己不确定
   - 自动触发 warning / 增加 visits 的逻辑

## 参考资料

- [Analysis Engine 官方文档](https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md)
- [GTP Extensions](https://github.com/lightvector/KataGo/blob/master/docs/GTP_Extensions.md)
- [KataGo Methods](https://github.com/lightvector/KataGo/blob/master/docs/KataGoMethods.md)
- [规则详细说明](https://lightvector.github.io/KataGo/rules.html)
- [示例 analysis 配置](https://github.com/lightvector/KataGo/blob/master/cpp/configs/analysis_example.cfg)
- [示例 GTP 配置](https://github.com/lightvector/KataGo/blob/master/cpp/configs/gtp_example.cfg)
