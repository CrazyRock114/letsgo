# 小围棋乐园 - 更新计划

## 1. [已解决] KataGo 胜率振荡问题

**结论**：rect15 模型（87MB 通用模型）已验证稳定，是当前主要模型。lionffen 小模型（2MB）存在胜率评估异常问题，已降级为备选。

**历史**：
- lionffen_b6c64（2MB）在 9x9 空棋盘实测 winRate=96.2%、scoreLead=+4.1，但 komi 设置错误（实际为 2.5 而非 fair komi），导致评估扭曲
- rect15-b20c256（87MB）在正确 komi 下评估一致且稳定
- b24c64 不是 3x3 专精模型（之前结论错误）

**当前状态**：
- 默认模型：`rect15`（`DEFAULT_GAME_MODEL = 'rect15'`）
- 难度 visits：easy=50, medium=100, hard=200
- komi 已修正为 fair komi：9x9=7.0, 13x13=7.5, 19x19=7.5
- winRate 已修复为黑方视角；scoreLead 仍为 side-to-move 视角（待修复）

---

## 2. [长期] RAG + 精确数据方案 — 解说系统根本性优化

**目标**：消除 LLM 解说幻觉（如把非星位说成星位），提升解说专业性和准确性。

### Phase 1：SGF 解析器 + 事实骨架重构

**1.1 SGF 解析器** (`src/lib/sgf-parser.ts`) ✅ 已完成
- 手写递归下降解析器，支持转义字符、坐标转换（aa→(0,0)）
- 提取对局元数据（棋盘大小、贴目、棋手、结果）和落子序列
- 只提取主分支，忽略变体
- ✅ 已验证：100局职业对局成功解析入库
- 手写递归下降解析器，支持转义字符、坐标转换（aa→(0,0)）
- 提取对局元数据（棋盘大小、贴目、棋手、结果）和落子序列
- 只提取主分支，忽略变体
- ⚠️ 需测试验证：多值属性（如 `AB[aa][ab]`）、复杂注释转义

**1.2 棋盘快照生成** (`src/lib/board-snapshot.ts`) ✅ 已完成
- 对每一步落子生成结构化描述（BoardSnapshot）
- 包含：落子坐标、区域、棋盘统计、区域描述、棋型关键词、对局元数据
- 生成位置描述文本（用于 embedding）
- ✅ 已修复 cornerZone 计算（9路=3线，13/19路=4线），4-4 星位不再被误判为"中腹"
- ⚠️ 需测试验证：从 SGF 生成快照序列的端到端流程

**1.3 类型定义** (`src/lib/move-facts.ts`) ✅ 稳定
- 定义 MoveFacts、BoardSnapshot、ParsedGame、SgfMove 等核心类型
- MoveFacts 包含：坐标、颜色、isStarPoint（严格判断）、区域、气数、提子数、棋型列表（含置信度）、KataGo 数据

**1.4 事实骨架重构** (`src/app/api/go-ai/route.ts`) ✅ 已完成
- 将 `recognizePatterns` 输出从自然语言改为结构化 JSON（MoveFacts）
- LLM 只能基于 JSON 事实生成解说，禁止自行推断棋型
- 改造 prompt 组装逻辑：事实数据用 JSON 传入，增加"禁止自行推断"规则

### Phase 2：向量数据库建设

**2.1 Supabase pgvector 扩展** ✅ 已完成
- 启用 pgvector 扩展
- 创建 `letsgo_position_index` 表（id, board_size, move_number, description, embedding, snapshot JSONB）
- 创建 HNSW 向量搜索索引

**2.2 数据入库与检索 API** (`src/app/api/go-knowledge/`) ✅ 已完成
- `POST /api/go-knowledge/import` — 导入 SGF 文件，解析为快照序列，生成 embedding，写入 Supabase
- `POST /api/go-knowledge/search` — 向量搜索相似位置（支持棋盘大小/步数/区域过滤）
- `GET /api/go-knowledge/stats` — 查询知识库统计（总记录数、最近导入等）

**2.3 Embedding 生成** ✅ 已完成
- 使用 SiliconFlow BGE-M3（1024维），通过 OpenAI 兼容 API 调用
- 配置在 `.env.local`：
  ```
  EMBEDDING_API_BASE_URL=https://api.siliconflow.cn/v1
  EMBEDDING_API_KEY=sk-...
  EMBEDDING_MODEL=BAAI/bge-m3
  EMBEDDING_DIMENSION=1024
  ```
- 实现文件：`src/lib/embedding.ts`（单条/批量 embedding）、`src/lib/go-knowledge.ts`（pgvector 格式转换、批量入库）

**2.4 数据填充脚本** (`scripts/import-pro-games.ts`) ✅ 已完成
- 从 GOAT 库采样 100 局 19x19 职业对局
- 合成 50 局 9x9 + 50 局 13x13 棋谱（标准开局 + 随机合法后续）
- 批量解析 → 生成快照 → embedding → 写入 Supabase
- 数据库当前：9x9=2,000 / 13x13=3,000 / 19x19=44,836（含 ~18K 重复）

### Phase 3：RAG 检索集成

**3.1 检索逻辑**
- 将当前棋盘 BoardSnapshot 转为描述文本 → embedding → 向量搜索
- Supabase RPC 执行向量搜索（cosine similarity + 棋盘大小/步数过滤）
- 返回 Top-5 相似位置及其对局信息

**3.2 相似度优化**
- 棋盘大小过滤、步数窗口（±30%）
- 区域权重：落子所在区域的棋型匹配权重更高

### Phase 4：Prompt 工程重构

**4.1 新 Prompt 模板**
- 事实数据用 JSON 传入（取代自然语言描述）
- RAG 参考作为"佐证"（如"类似局面下职业棋手也经常这样下"）
- 移除风格示例（避免 LLM 套用模板）
- 明确禁止添加数据中未提及的棋型判断

### Phase 5：集成与测试

- go-ai API 改造：生成事实骨架 → RAG 检索 → 组装 Prompt → 流式输出
- 降级策略：RAG 超时/无结果时退回仅用事实骨架 + KataGo 数据
- 对比测试：新旧解说输出幻觉率

### 文件清单

| 文件 | 新增/修改 | 状态 |
|------|----------|------|
| `src/lib/move-facts.ts` | 新增 | ✅ 稳定 |
| `src/lib/sgf-parser.ts` | 新增 | ✅ 已验证（100局职业对局成功解析） |
| `src/lib/board-snapshot.ts` | 新增 | ✅ 已验证（cornerZone 等 bug 已修复） |
| `src/lib/embedding.ts` | 新增 | ✅ 已验证（SiliconFlow BGE-M3） |
| `src/lib/go-knowledge.ts` | 新增 | ✅ 已验证（含自动 chunking + 重试） |
| `src/app/api/go-knowledge/import/route.ts` | 新增 | ✅ 已验证 |
| `src/app/api/go-knowledge/search/route.ts` | 新增 | ✅ 已验证 |
| `src/app/api/go-knowledge/stats/route.ts` | 新增 | ✅ 已验证 |
| `supabase/migrations/20260425_enable_pgvector_and_position_index.sql` | 新增 | ✅ 已应用 |
| `src/app/api/go-ai/route.ts` | 修改 | ✅ 已完成（事实骨架重构 + RAG 接入） |
| `scripts/import-pro-games.ts` | 新增 | ✅ 已完成（200局导入，31,157 位置） |
| `scripts/generate-synthetic-games.ts` | 新增 | ✅ 已完成（合成 9x9/13x13 棋谱） |
| `scripts/test-hallucination.ts` | 新增 | ✅ 已完成（幻觉率 0%） |
| `data/sgf/` | 新增目录 | ✅ 已填充（100局 19x19 职业对局 + 100局合成小棋盘） |

### 实施顺序

**已完成**：
1. ✅ Phase 1.4：`go-ai/route.ts` 事实骨架重构（recognizePatterns → extractMoveFacts + JSON prompt）
2. ✅ Phase 2：向量数据库建设（pgvector + embedding 管线 + 100局职业对局导入 = ~26K 位置）
3. ✅ Phase 3：RAG 检索接入 go-ai（当前局面 → embedding → 向量搜索 → 相似对局注入 prompt）

**已完成**：
4. ✅ Phase 5：端到端幻觉测试（40 用例 × 9 检测项 = 360 项，幻觉率 0.0%）

**待实施**：
1. Phase 4：Prompt 工程进一步优化（严格 JSON 事实 + RAG 佐证的 few-shot 调优）
2. ✅ ~~知识库去重~~（19x19 从 44,836 → 26,157，总计删除 19,045 条重复，剩余 30,791 条唯一记录）
3. 补充更多 9x9/13x13 真实对局（当前为合成棋谱）

**已知技术债务（独立排期）**：
- scoreLead 视角问题：KataGo 返回 side-to-move 视角，需统一转换为黑方视角（和 winRate 处理方式一致）
- rules 问题：当前用 tromp-taylor（friendlyPassOk=false），可考虑改为 chinese 规则
