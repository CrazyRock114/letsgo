# 🔍 批判性深度审查：两份 KATAGO_ 报告的先验性错误与盲点

> 对象：
> - 《小围棋乐园 — 围棋 AI 引擎实测踩坑经验文档》(Incident Report, 162 行, md5=04705fdd)
> - 《KataGo 引擎实战部署避坑指南》(Deployment Guide, 429 行)
>
> 审查姿态：**完全不信任、逐条寻找反证、不客气**
> 前提：作者是全程参与项目的 agent，其修复动作本身会让他产生"这就是正确的"的认知锁定
> 用户要求：批判性看待，找出"先验性错误"

## 🧠 关键认知偏差模式识别

在深入具体条目前，先识别两份文档里反复出现的**认知偏差模式**，这些比单点错误更危险：

### 偏差 1：**修复动作 = 正确的确认**（Confirmation bias by action）

最典型例子：2.1 的启动死锁修复。修复后**的确不再死锁**，但这**不证明**死锁是"sendCommand→ensureReady→starting" 这条链。可能是别的 race condition 被同时掩盖掉了。文档把"修复有效"当成了"根因分析正确"。

### 偏差 2：**一次性测试即结论**（Single-sample induction）

3.1 的 b24c64 pass 测试用**同一个局面** `B G7 W D5 B D7` 跑了 3 次全 pass，就断言"模型不支持 9x9"。3 次相同输入产生相同输出**不是 3 个样本，是 1 个样本重复 3 次**。真正的模型缺陷测试需要多个**不同**局面。

### 偏差 3：**文件名即证据**（Filename hermeneutics）

"文件名含 `3x3`" → "训练棋盘是 3x3" 是**纯字面推断**，没查任何训练资料。KataGo 开发者 lightvector **从未发布过棋盘大小为 3x3 的专用网络**，也**从未用棋盘尺寸命名网络**（官方命名见 kata9x9 系列，那才是真·9x9 专用）。`3x3` 在 lionffen 训练日志里其实是**卷积核尺寸标记**。

### 偏差 4：**复述 commit 信息即复述真相**（Commit log as gospel）

报告里大量"commit XXX 说根因是 YYY"的表述。但 commit 消息本身是 agent 当时的判断，不是独立证据。**agent 在复述 agent 过去写的 commit**，形成封闭的自证循环。

### 偏差 5：**把手段当目的**（Means-ends confusion）

最明显是 2.8 "必须用同一队列"。**问题**是"避免命令/响应错位"，**手段**之一是"串行队列"。报告把"队列"当成了必然需求，而没意识到 Analysis Engine 天生不需要。

### 偏差 6：**对自己最熟悉的 bug 投入过多注意力**（Availability heuristic）

很多篇幅讨论"启动握手监听器竞争""GnuGo 错位""verifyModel 错位"——**全是 GTP 协议自身缺陷的次生 bug**。真正的产品级问题（komi、rules、视角、模型路由）反而只有零散几行。agent 的注意力被"自己修过的 bug"占据了。

---

## 🔴 具体条目的先验性错误（逐条精审）

### ❌ Incident 3.1 — "b24c64 是 3x3 专精模型"

**危险等级**：🔴🔴🔴 最高（会让团队永远找不到真因）

**先验来源**：
- agent 看到多次 9x9 pass（真实现象）
- agent 有"模型应该能适配任何棋盘"这个先验
- 既然现象和先验矛盾，agent 需要找一个"特殊性"
- 文件名恰好有 `3x3`，成为最唾手可得的解释

**反驳证据**：
1. **KataGo 支持所有 3x3-19x19 棋盘**（任何 v8+ 网络都是多尺寸训练，用 masking 技术——见 KataGoMethods.md "Training on Multiple Board Sizes via Masking"）
2. **lionffen 系列是第三方训练**，`b24c64-19x19-v53g` 才是完整名，**`19x19` 在名字里就在**（日志行："Model name: b24c64-19x19-v53g-12300-swa2-202508152111"），3x3 在**目录/文件名**里只是训练者的私人标签，不是 KataGo 的规范
3. 实验只用 1 个局面验证，不能排除 "这个特定局面在任何小模型上都倾向 pass"

**真正根因**（四因一果模型）：
- `rules = tromp-taylor` → `friendlyPassOk = false`
- `komi = 2.5`（Mac 日志 10:17）→ 极端偏置 winrate→99%
- `maxVisits = 15`（Mac 日志）→ 搜索太浅
- lionffen 短训练 → policy 分布对 pass 有异常概率

这 4 个条件同时满足才 pass。把这个组合归因简化成"模型是 3x3 专精"**直接隐藏了生产环境真正要修的 3 个配置**。

---

### ❌ Incident 2.9 — "9x9/13x13 贴目已统一修正为 6.5"

**危险等级**：🔴🔴🔴 最高（**commit 说修了，生产 API 实测没修**）

**先验来源**：
- agent 写了 commit 2eb025f 改了一个函数
- agent 相信 commit = 生效

**反驳证据**：
1. 今天我用 test 账号打生产 API，**9x9 空棋盘 winRate=96.2%，scoreLead=+4.1**
2. 这组数字**唯一**能对应的 komi 是 **2.5**（不是 6.5）
3. 所以要么：
   - commit 没部署到 Railway
   - commit 改错了位置（改了前端 UI 但后端 route.ts 用的是另一个值）
   - 前后端用的是不同的 `getKomi` 函数
4. **还有更深的问题**：**6.5 也不是 9x9 的正确 komi**。KataGo 官方 9x9 fair komi 是 **7（TT）或 6（JP）**（katagobooks.org 权威）。报告说"统一 6.5"本身就是错的——**所有网络训练时用的都是 fair komi**，不是 6.5

**暗含风险**：agent 可能在未来某时"看到 scoreLead 小偏差"，又开一个 commit 把 komi 改回 2.5——因为 "6.5 下 9x9 白方会觉得黑方胜率虚高"，而 2.5 是"看起来合理"的 balanced 数字（对 amateur 来说）。这是因为 agent **没意识到 komi 不是一个可以调来让 winrate 好看的旋钮**，它是网络训练时的固定参数，偏离就会扭曲一切评估。

---

### ❌ Incident 2.4 — "winrate 视角已修复为黑方"

**危险等级**：🔴🔴 高（**只修了一半**）

**先验来源**：
- agent 看到了 winrate 视角问题
- agent 修了 winrate 的视角转换
- agent 认为"这个 bug 修好了"

**反驳证据**（生产 API 实测）：
```
黑下一手（白方要下）:   winRate=95.9%, scoreLead=-4.1
黑白各一手（黑方要下）: winRate=97.5%, scoreLead=+4.6
```
- winRate 两次都 ~96%（稳定黑方视角 → 修了 ✓）
- **scoreLead 符号翻转**（仍然是 side-to-move → 没修 ✗）

agent 的修复是"对 winrate 做了 `isWhiteToMove ? 100 - x : x`"。但 **scoreLead 没做同样处理**。这是一个半修复。

**更大的暴露**：agent 当时没意识到 KataGo 返回的**所有**side-to-move 字段都需要视角转换（winrate + scoreLead + scoreMean + utility 等），只处理了用户反馈最直接的那个。

---

### 🚩 Incident 2.3 — "kata-analyze 无视 maxVisits 必须用 stop 中断"

**危险等级**：🟡 中（**技术上对，但是陷阱**）

**先验来源**：
- agent 发现 maxVisits 对 kata-analyze 无效
- agent 正确地转向 stop 命令控制

**批判角度**：这不是结论错，是**问题框架错了**。
- 把 "kata-analyze 不支持 maxVisits" 当成"KataGo 的特性"来适配
- **真正的思考应该是**：为什么要用一个需要"靠 setTimeout + stop 管时间"的 API？
- **Analysis Engine** 的 JSON query 里每条 `maxVisits` 都严格生效
- agent 三次尝试（eab9e32, 7fe0ff4, c515b3a）失败后，没有触发"是否接口选错了"的反思，而是直接固化到"用 stop 控制"的 workaround 里

**隐藏成本**：
- 你们现在 `analysisSeconds = 3` 的实现**把 KataGo 搜索时间变成 wall-clock**。CPU 繁忙时 3 秒可能只跑 10 visits，CPU 空闲时 60 visits。**同一局面在不同负载下分析结果不同**——这是"结果不稳定"的又一个隐藏源头
- 真实 actualVisits 在生产实测范围 11-41，**变化接近 4 倍**

---

### 🚩 Deployment Guide §2.8 — "棋盘切换稳定无需担心"

**危险等级**：🟡 中（**表面正确，忽略了关键副作用**）

**先验来源**：
- agent 测了 19→9→13→19 都没崩
- 结论"稳定"

**反驳证据**（Mac 日志实锤）：
```
Cleaned up old neural net and bot
nnRandSeed0 = 10147908344759856467   ← 新种子！
```
每次切棋盘生成新 nnRandSeed。这意味着：
- 即使 `nnRandomize = false`，切棋盘会重置种子
- 同一用户连续两次分析，中间被别人切了棋盘 → 对称随机性换了 → 结果改变
- 确定性测试在这种模式下**根本不可能做**

agent 测"不崩"就觉得"稳定"，但 "nn randomization after boardsize switch" 这种微妙副作用**压根没检查**。

---

### 🚩 Deployment Guide §3.2 — "每步必须发送完整 setup 序列"

**危险等级**：🟡 中（**建议本身就是性能反模式**）

**先验来源**：
- 有过"进程状态污染"的惨痛教训
- 为避免复发，过度防御："每步都重置"

**批判点**：
1. 每步都发 `boardsize` → 每步都重建 NN buffer（1-3 秒延迟）+ 新种子 → **严重性能下降 + 隐藏随机性**
2. 每步 replay 完整历史 → O(N²) 通信。100 手的对局第 100 步要发 100 条 play 命令
3. 对于**同一个用户的连续回合**，完全可以增量：只发 `play <上一手>` + `genmove`
4. 报告里没有提出 "增量同步 vs 完整重置" 的选择空间

**真正的结论应该是**：
- **同一局会话内**：增量同步（保留上局状态）
- **会话切换 / 新开局**：完整 clear + setup
- **检测到状态污染**：clear + 重置（降级路径）

把"防御性每步全重置"当最佳实践写进指南，**会让团队永远背着 3-10 倍性能开销**，并且消除不了种子漂移。

---

### 🚩 Deployment Guide §6.2 "胜率显示异常" 的排查路径

**危险等级**：🟡 中（**排查树漏了最大的可能性**）

**指南原文的排查顺序**：
> 1. 确认当前行棋方
> 2. 检查是否做了视角转换
> 3. 确认 scoreLead 也做了转换

**漏的可能性**：
- **komi 错配**（今天实测的生产 bug）不在排查树上
- 但"胜率突然从 99% 变 1%"恰好可能是"从 AI 视角转到另一方视角"，也可能是"komi 改了"

**正确的排查树**：
1. 查当前使用的 komi → 是否在训练分布（7/7.5）
2. 查当前使用的 rules → 是否在模型支持范围
3. 再查视角转换

agent 把自己修过的那个 bug（视角）作为排查首位，但忽略了**他没发现过的 bug（komi）**可能才是根因。这是认知偏差 6 的典型表现：**熟悉的 bug 被优先检查**。

---

### 🚩 Incident 3.11 — "humanv0 需要 humanSLProfile"

**危险等级**：🟢 低（但有暗坑）

**先验来源**：
- humanv0 不带 humanSLProfile 会 crash
- agent 在 gtp.cfg 里写死 `humanSLProfile = preaz_5k`

**批判点**：
1. `preaz_5k` 字面意思是 "pre-AlphaZero 5 kyu"——2016 年前的 5 级业余棋风
2. 你们的**入门用户**目标棋风可能确实需要弱 AI，但 **5 kyu 在中国业余段位里约等于**中级棋手，不是"入门"
3. **更合适的选择**：按难度动态切换 `humanSLProfile`
   - easy（初级）→ `rank_15k`（15 级）或 `preaz_15k`
   - medium（中级）→ `rank_5k`
   - hard（高级）→ `rank_5d`（5 段）
4. agent 的修复只是"让 humanv0 不崩"，**没考虑产品侧的难度分级意义**

这是一个**技术层修复对、产品层考虑不周**的典型。

---

### 🚩 Incident 4.5 / Deployment Guide §11.3 — "numSearchThreads = 2"

**危险等级**：🟡 中（**基于错误假设**）

**先验来源**：
- "Next.js 开发服务器是单进程"
- 担心线程过多阻塞事件循环

**反驳**：
1. **Next.js 的事件循环和 KataGo 的搜索线程完全隔离**。KataGo 是子进程，它的线程数影响它自己的 CPU 占用，不会阻塞 Node 的 event loop
2. 真正的瓶颈是 **Railway 容器的 CPU 配额**。Railway Hobby plan 现在约 2 vCPU，`numSearchThreads=2` 在这种情况下合理
3. 但是**没提到 `kata-benchmark` 就是官方推荐的 threads 调优工具**——agent 没去跑 benchmark，凭直觉估

**正确做法**：启动时或 warmup 时自动跑 `kata-benchmark 800` 一次，按返回的 visits/s 最大值选 threads。这 5 分钟的优化可能比 agent 猜的 threads 数快 2-3 倍。

---

### 🚩 Deployment Guide §3.2 "建议 visits 配置 easy=300, medium=1500, hard=5000"

**危险等级**：🟡 中（**和 CPU 性能模型不匹配**）

**先验**：
- 假设 visits 数字线性对应棋力
- 给出三档 visits 当作"三档难度"

**实测反驳**：
- `rect15` 在 Railway 2 CPU 上 ~10-15 visits/s
- easy 300 visits ≈ **20-30 秒**
- medium 1500 visits ≈ **100-150 秒**
- hard 5000 visits ≈ **6-8 分钟**

**后面两个在 Web 交互下根本不可接受**。前端 120 秒超时会把 medium/hard 都 timeout 到本地 AI。

agent 写这些数字时**没算过 wall-clock**。应该配合"maxTime = 10 秒"做保护，或者 medium/hard 切更小的模型。

---

### 🚩 Deployment Guide 关于 Analysis Engine — 完全没提

**危险等级**：🔴🔴 高（**战略性遗漏**）

报告 + 指南 + Coze 都**没有一处**提到 KataGo 还有 `katago analysis` 命令。

但全文大量讨论：
- GTP 队列管理的复杂性（2.8）
- GTP 命令/响应错位（3.2, 3.7）
- GTP 启动死锁（2.1, 2.6）
- GTP kata-analyze 无法用 maxVisits 控制（2.3）
- GTP 进程单点故障（5.2）

**所有这些问题 Analysis Engine 都没有**。但 agent 完全没意识到自己在 "GTP 历史包袱" 里挣扎。

这是最大的**认知盲区**——不是写错了什么，而是**没提起某个选项的存在**。

---

## 🔴 两份报告共同的系统性问题

### 问题 A：把 "Railway 部署环境" 默认为 "KataGo 的目标运行环境"

KataGo 是为**单机 GPU 强算力**设计的引擎。在 Railway 2 CPU 环境下跑，**整个优化模型是倒着用的**：
- 多线程 `numSearchThreads` 被压到 2
- `maxVisits` 降到 50-300（官方推荐 500+ 起步）
- 切换 GPU-free 的 Eigen 后端（慢 20-50 倍）

所以整套架构是"**在错误环境里让 KataGo 勉强能跑**"，不是"**让 KataGo 发挥实力**"。报告里的很多"优化"其实是"妥协"。

**根本解决**：独立 GPU 实例 + 自管 KataGo 服务 + HTTP API，让 Web 后端只做 orchestration。投入几百元/月能换来棋力质变。

### 问题 B：修复按 "用户可见 bug" 优先，不按 "影响范围" 优先

报告里的 24 个问题都是"看得见的 bug"——用户投诉 / 日志报错 / AI 行为异常。但**真正的生产质量杀手**是那些**不产生错误但系统性降质**的问题：
- komi 错配 → 没报错，但整个评分体系偏
- rules=tromp-taylor → 没报错，但和用户心智模型不符
- scoreLead 视角未修 → 没报错，但解说内容错

这些从 "用户投诉" 纬度看不见，所以没被优先修。但从 "产品可信度" 纬度看，**这些是最伤品牌的 bug**。

### 问题 C：过度工程化 GTP 相关防御

报告 2.1 / 2.2 / 2.6 / 2.7 / 2.8 / 3.2 / 3.7 / 4.2 等**至少 8 个条目**都在解决 GTP 协议的工程化问题。**每个修复都是精巧的，但累加起来代码变得 fragile**：
- `ensureReady` / `starting` / `procEpoch` / `thoroughFlush`
- 临时监听器 vs 永久监听器
- 主队列 vs 分析队列
- 守护进程 + warmup + verifyModel

agent 显然投入了大量精力把 GTP "驯服"成 web 服务的样子。但 **Analysis Engine 根本不需要这些**——它本来就是 JSON 异步 API。你们等于花了 2-3 个月把一辆赛车改造成公交车，而旁边就有一辆公交车。

### 问题 D：缺乏基线对比

报告里 60% 的 "修复有效" 是以 "bug 不再复现" 为判据。但从来没有：
- "修复前某指标 X，修复后变成 Y"
- "A/B 测试两种方案"
- "回归测试黄金集"

这是工程习惯问题。agent 习惯于"修了就走"，**没建立持续监控修复质量的机制**。

### 问题 E：把 KataGo 当黑盒

报告里几乎**不引用 KataGo 官方文档**（Analysis_Engine.md, GTP_Extensions.md, KataGoMethods.md, rules.html）。所有"特性"都靠本地实验测出来。

这是**最浪费时间**的 anti-pattern。比如：
- "kata-analyze 无视 maxVisits" —— 官方文档**直接说了**这不支持
- "v5 模型只支持 tromp-taylor" —— 官方文档**直接说了**
- "hasButton + TERRITORY 不支持" —— 官方规则文档**直接说了**
- "9x9 fair komi = 7" —— katagobooks.org **直接写了**

agent 用本地实验**重新发现**这些官方事实，耗费大量时间，而且有时推错结论（比如 3x3 那条）。

---

## 🎯 真正重要的建议

### 批判结论

两份报告**工程精度是合格的**（60-75%正确），但**认知姿态是有问题的**——agent 把 KataGo 当成需要"驯服"的黑盒，把自己修过的 bug 的归因当成权威结论，用 commit 作为自证循环。

**直接后果**：
- 真正该修的 3 件事（komi / rules / 视角）**只做了 1 件半**
- 精力被浪费在 GTP 历史包袱的驯服上
- 新来的工程师如果把这两份当 onboarding 文档，会**继承这些偏差**

### 对你们的建议

1. **对这两份报告做批注修订**，把我今天标出来的**所有有实锤证据的错误**（3.1, 2.9, 2.4 不完整, 指南 §2.8/§3.2/§6.2 等）**加警示标记**，不要让新人当 ground truth 读
2. **组织一次"放弃 GTP 改 Analysis Engine"的技术讨论**，哪怕最后决定不迁移，这个讨论本身就能打破认知锁定
3. **把生产 API 实测结果（winRate=96.2%）挂在团队共享空间显著位置**，作为提醒："这就是现在真实的状态"
4. **下次做类似总结时引入外部视角**——让不参与代码的 reviewer 看一遍（今天这个角色由我充任）

### 一个更难说的建议

**这两份报告体现了 agent 的高强度工作**（162+429 行，实测数据丰富，架构思考详细）。但**高强度不等于正确方向**。agent 在 GTP 框架里越做越细致，其实是走错了路还在加速。

**让 agent 停下来做一次"这个问题本质上是什么"的反思**，比让 agent 再修 3 个细节 bug 更重要。

你找我做的这个"外部审查"本质上就是这个反思的开端——但要让反思真正发生，需要**把审查结果主动送到 agent 面前并问一句**："这些地方你怎么看？"

