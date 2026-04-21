# 小围棋乐园 - 更新计划

## 1. [诊断] KataGo 胜率振荡问题

**现象**：ai-test 页面使用 GnuGo 引擎时，KataGo 分析的 winRate 在相邻两步之间从 0.1% 跳到 99.9%，且 scoreLead 始终为 0。这表明 winRate 和 scoreLead 互相矛盾。

**诊断方向**：
- 切换到 rect15 模型（87MB 通用模型），看振荡是否消失
- 如果 rect15 下 winRate 和 scoreLead 一致（高胜率伴随大目数领先），则为 lionffen 模型问题
- 如果 rect15 也振荡，则可能是棋盘重建逻辑的 bug

**待执行**：
- 在代码中将 KataGo 模型优先级改为 rect15 > lionffen
- 全面测试评估后决定是否恢复 lionffen 或保持 rect15

---

## 2. [长期] RAG + 精确数据方案 — 解说系统根本性优化

**目标**：消除 LLM 解说幻觉（如把非星位说成星位），提升解说专业性和准确性。

### Phase 1：SGF 解析器 + 事实骨架重构

**1.1 SGF 解析器** (`src/lib/sgf-parser.ts`)
- 解析 SGF 格式文件，提取对局元数据和落子序列
- 支持带注释的 SGF（C[] 标签）

**1.2 棋盘快照生成** (`src/lib/board-snapshot.ts`)
- 对每一步落子生成结构化描述（BoardSnapshot）
- 包含：落子坐标、区域、棋盘统计、区域描述、棋型关键词、对局元数据
- 生成位置描述文本（用于 embedding）

**1.3 事实骨架重构** (`src/app/api/go-ai/route.ts`)
- 将 `recognizePatterns` 输出从自然语言改为结构化 JSON（MoveFacts）
- 包含：坐标、颜色、isStarPoint（严格判断）、区域、气数、提子数、棋型列表（含置信度）、KataGo 数据
- LLM 只能基于 JSON 事实生成解说，禁止自行推断棋型

### Phase 2：向量数据库建设

**2.1 Supabase pgvector 扩展**
- 启用 pgvector 扩展
- 创建 `letsgo_position_index` 表（id, board_size, move_number, description, embedding, snapshot JSONB）
- 创建 HNSW 向量搜索索引

**2.2 数据入库流程** (`src/app/api/go-knowledge/route.ts` - 新 API)
- `POST /api/go-knowledge/import` — 导入 SGF 文件
- `POST /api/go-knowledge/search` — 搜索相似职业对局

**2.3 Embedding 生成**
- 使用 coze-coding-dev-sdk 的 EmbeddingClient
- 模型：doubao-embedding-vision-251215，1024 维

**2.4 数据填充脚本** (`scripts/import-pro-games.ts`)
- 精选 100-200 局经典职业对局 SGF 文件
- 批量解析 → 生成快照 → embedding → 写入 Supabase

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

| 文件 | 新增/修改 |
|------|----------|
| `src/lib/sgf-parser.ts` | 新增 |
| `src/lib/board-snapshot.ts` | 新增 |
| `src/app/api/go-knowledge/route.ts` | 新增 |
| `scripts/import-pro-games.ts` | 新增 |
| `data/sgf/` | 新增目录 |
| `src/app/api/go-ai/route.ts` | 修改 |
| `docker-start.sh` | 修改 |

### 实施顺序

1. Phase 1.2-1.3 + Phase 4.1（独立于 RAG 的核心改进，先做）
2. Phase 2（数据库 + embedding 管线）
3. Phase 3（RAG 检索集成）
4. Phase 4.2 + Phase 5（端到端测试）
