# 小围棋乐园 - 项目规范

## 项目概述

专为儿童设计的围棋AI对弈与教学平台，通过有趣可爱的界面和AI互动，帮助孩子轻松学习围棋。

## 技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **AI 集成**: DeepSeek API (LLM流式输出，OpenAI 兼容格式) + SiliconFlow BGE-M3 (embedding)
- **数据库**: Supabase（表名前缀 `letsgo_`，与其他项目共用同一Supabase实例）

## 项目结构

```
src/
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── register/route.ts  # 用户注册API
│   │   │   ├── login/route.ts     # 用户登录API
│   │   │   └── me/route.ts        # 当前用户信息API
│   │   ├── go-ai/
│   │   │   └── route.ts     # AI教学与解说API（LLM流式输出）
│   │   ├── go-engine/
│   │   │   └── route.ts     # KataGo/GnuGo围棋AI引擎（Analysis Engine协议+排队+积分扣除）
│   │   ├── go-knowledge/
│   │   │   ├── import/route.ts  # SGF导入+embedding+写入pgvector
│   │   │   ├── search/route.ts  # 向量搜索相似棋局位置
│   │   │   └── stats/route.ts   # 知识库统计查询
│   │   ├── games/
│   │   │   ├── route.ts     # 棋局保存/载入/列表/删除API（需登录）
│   │   │   └── [id]/route.ts # 单个棋局载入/删除API
│   │   ├── users/
│   │   │   └── points/route.ts # 积分查询API
│   │   ├── monitor/
│   │   │   └── route.ts     # 运行监控API（用户/棋局/引擎统计）
│   │   └── db-check/
│   │       └── route.ts     # 数据库诊断端点
│   ├── globals.css           # 全局样式
│   ├── layout.tsx            # 布局组件（含AuthProvider+Toaster）
│   └── page.tsx              # 主页面（围棋游戏+百科+教程+用户面板）
├── monitor/
│   └── page.tsx              # 运行监控页面（引擎状态/在线人数/排队）
├── components/
│   └── ui/                   # shadcn/ui 组件库（含sonner toast）
├── lib/
│   ├── auth.ts               # 认证核心（JWT签发/验证，密码哈希）
│   ├── auth-context.tsx      # React Auth Context（useAuth hook）
│   ├── go-logic.ts          # 围棋游戏核心逻辑
│   ├── go-encyclopedia.ts   # 围棋百科数据（35+核心术语）
│   ├── go-tutorial.ts       # 围棋教程数据（8章40+步骤）
│   ├── move-facts.ts        # MoveFacts/BoardSnapshot/ParsedGame 类型定义
│   ├── sgf-parser.ts        # SGF 格式解析器（递归下降）
│   ├── board-snapshot.ts    # 棋盘快照生成器（每步结构化描述）
│   ├── embedding.ts         # SiliconFlow BGE-M3 embedding 客户端
│   ├── go-knowledge.ts      # pgvector 格式转换、批量入库工具
│   └── utils.ts              # 通用工具函数
├── storage/
│   └── database/            # Supabase数据库
└── server.ts                 # 自定义服务端入口
```

## 核心功能

### 1. 围棋对弈
- 支持 9路(入门)、13路(进阶)、19路(标准) 三种棋盘
- 棋子落在交叉点上（SVG渲染）
- 黑白双方轮流落子，自动提子
- 最后一手标记（圆点标识）
- **玩家颜色选择**：可选执黑(先手)或执白(后手)，执白时AI先下
- AI方：KataGo深度学习引擎（Analysis Engine协议，优先） + GnuGo回退（GTP协议） + 本地AI兜底
  - 初级：KataGo visits=30 / GnuGo Level 3 / 本地随机+避傻
  - 中级：KataGo visits=80 / GnuGo Level 7 / 本地评分选择
  - 高级：KataGo visits=150 / GnuGo Level 10 / 本地1步前瞻
  - 默认模型：rect15-b20c256（87MB，通用模型，已验证稳定）
- 停手(Pass)功能：双方连续停手结束棋局
- 贴目规则（fair komi，网络训练时的固定参数）：
  - 9路：7.0目（Tromp-Taylor）/ 6.0目（Japanese）
  - 13路：7.5目 / 8.0目
  - 19路：7.5目（中国规则标准）
  - ⚠️ komi 不是可调参数，偏离 fair komi 会扭曲 KataGo 胜率评估
- 自动结束：步数上限（9路150步/13路300步/19路500步）+ 最低步数门槛 + 领地优势绝对判定

### 2. 每步AI解说
- 每步棋后自动获取AI简短解说（1句）
- 真正的LLM流式输出（打字机效果）
- **KataGo分析数据驱动**：所有引擎的解说都基于KataGo分析数据
  - winRate：黑方胜率 0-100（已修复为黑方视角）
  - scoreLead：黑方领先目数（⚠️ 仍为 side-to-move 视角，白方落子时符号会翻转，待修复）
  - bestMoves：推荐落点及对应评估（黑方视角）
- 解说包含落子位置、作用、鼓励、形势判断
- **专业术语嵌入**：解说中自然融入围棋术语并在括号中解释
- **智能气数提及**：只在打吃(1气)或提子时提及气数，3气以上不提
- **棋型识别**：自动识别星位占角、挂角、连接、切断、做眼、拆边等棋型
  - 当前：自然语言字符串数组（go-ai/route.ts 中 recognizePatterns）
  - 改造中：结构化 JSON 事实骨架（MoveFacts），LLM 禁止自行推断棋型
- **解说防丢失**：快速落子时，旧解说仍会被保存到解说列表，不会被新请求覆盖

### 3. AI教学
- 流式AI教学解读（结合当前棋局+KataGo分析数据）
- **提示与教学合一**：点击按钮同时显示建议落点+AI解释为何该位置好
- 提示位置由评分引擎选出（findBestHint），教学内容结合KataGo分析数据解释该位置
- **围棋百科**：35+核心术语，7大分类，搜索/筛选/详情查看
- **围棋教程**：8章40+步骤渐进课程（启蒙→吃子→棋形→布局→中盘→官子→提高）
- 上下文感知问答（发送棋盘状态+KataGo分析给AI）

### 4. 用户系统
- **注册/登录**：昵称+密码，JWT认证（7天有效期）
- **积分体系**：注册送1000积分，每日首次登录送1000积分，不同引擎消耗不同积分
  - KataGo: 5积分/步（深度学习引擎）
  - GnuGo: 2积分/步（经典引擎）
  - 本地AI: 0积分/步（免费，无需登录）
- **积分扣除**：引擎API先扣积分再返回落子，积分不足回退本地AI
- **引擎管理**：KataGo 通过 EnginePool 管理多模型常驻进程（每个模型一个进程，模型加载一次后复用）；GnuGo 每次 spawn 新进程并行执行，不阻塞 KataGo
- **棋局关联**：保存棋局关联user_id，登录用户只看自己的棋局
- **前端体验**：用户面板显示昵称/积分/局数/胜场，积分不足时toast提示
- **未登录**：可使用本地AI对弈，不可保存棋局或使用KataGo/GnuGo

### 5. 辅助功能
- 提示功能（评分引擎选最佳位置，永久停留直到再次点击）
- 悔棋功能（撤销2步：玩家+AI）
- 停手功能（双方连续停手结束棋局）
- 重新开始（支持切换棋盘大小）
- 比分实时计算（白方含动态贴目）
- 游戏结束判定（严格条件：停手+最低步数门槛/领地优势绝对判定/步数上限/棋盘满）
- 引擎/难度无缝切换：难度切换不重开棋局（toast提示），引擎切换需确认
- 保存棋局命名含引擎信息（如"9路 初级 KataGo 2026/4/19"）
- 复盘从任意步继续对弈：复盘模式下可"从第N步继续对弈"，截取历史继续游戏

## API接口

### POST /api/auth/register
用户注册

**请求参数：**
- `nickname`: 昵称（2-20字符，唯一）
- `password`: 密码（6位以上）

**响应：** `{ user: {id, nickname, points, totalGames, wins}, token }`

### POST /api/auth/login
用户登录

**请求参数：**
- `nickname`: 昵称
- `password`: 密码

**响应：** `{ user: {id, nickname, points, totalGames, wins}, token }`

### GET /api/auth/me
获取当前用户信息（需Authorization: Bearer token）

**响应：** `{ user: {id, nickname, points, totalGames, wins} }`

### GET /api/users/points
获取积分余额和交易记录（需登录）

**响应：** `{ points: number, transactions: [{id, amount, type, description, created_at}] }`

### POST /api/go-ai
LLM流式响应，Content-Type: text/event-stream

**请求类型：**

| type | 说明 | 额外参数 |
|------|------|---------|
| `commentary` | 每步棋简短解说 | lastMove, moveColor, captured, analysis |
| `teach` | 教学解读 | lastMove, hintPosition, analysis |
| `chat` | 结合棋局的问答 | question, analysis |
| `ai-move` | AI落子建议 | - |

**通用参数：**
- `board`: 棋盘状态数组
- `currentPlayer`: "black" | "white"
- `analysis`: KataGo分析数据（可选）`{ winRate(黑方胜率0-100), scoreLead(⚠️side-to-move视角，待修复), bestMoves: [{move, winrate(黑方胜率), scoreMean(黑方视角)}] }`

### POST /api/go-engine
KataGo/GnuGo AI引擎桥接（排队+积分扣除）
- **KataGo**：使用 Analysis Engine JSON 协议（单进程 + 按需切换模型），通过 EnginePool 管理
  - 默认模型：rect15-b20c256（87MB，通用模型）
  - 难度通过 visits 控制：easy=30, medium=80, hard=150（对弈和分析统一）
  - 支持 monitor 页面动态切换模型和 visits
- **GnuGo**：每次 spawn 新进程并行执行，不走队列，不阻塞 KataGo

**请求头：**
- `Authorization: Bearer <token>`（KataGo/GnuGo必须登录，local无需登录）

**请求参数：**
- `boardSize`: 9 | 13 | 19
- `difficulty`: "easy" | "medium" | "hard"
- `engine`: "katago" | "gnugo" | "local"（指定引擎，可选）
- `moves`: 落子历史数组 [{row, col, color}, ...]

**响应：**
- `move`: AI落子坐标 {row, col} 或 null（停手/认输）
- `pass`: boolean（AI停手）
- `resign`: boolean（AI认输）
- `engine`: "katago" | "gnugo"（使用的引擎）
- `noEngine`: boolean（引擎不可用，前端应回退本地AI）
- `pointsUsed`: number（本次扣除积分数）
- `remainingPoints`: number（剩余积分）
- `insufficientPoints`: boolean（积分不足，仅403响应时）
- `analysis`: KataGo分析数据 `{ winRate(黑方胜率0-100), scoreLead(⚠️side-to-move视角), bestMoves }` 或 null

**错误响应：**
- 401: `{ error, needLogin: true }` — 未登录使用收费引擎
- 403: `{ error, insufficientPoints: true, required, current }` — 积分不足

### GET /api/go-engine
返回可用引擎列表（含积分费用和队列信息）

**响应：**
- `engines`: [{id, name, available, desc, cost}, ...]
- `queueLength`: number（当前排队人数）
- `isProcessing`: boolean

### POST /api/go-knowledge/import
导入 SGF 文件到向量知识库

**请求参数：**
- `sgf`: string — SGF 文件内容
- `metadata`（可选）: { blackPlayer, whitePlayer, event, date }

**流程：** 解析 SGF → 生成 BoardSnapshot 序列 → SiliconFlow BGE-M3 embedding → 写入 Supabase pgvector

### POST /api/go-knowledge/search
向量搜索相似棋局位置

**请求参数：**
- `boardSize`: number — 棋盘大小过滤
- `description`: string — 当前局面描述文本（用于生成 embedding）
- `moveNumber`（可选）: number — 当前手数（用于步数窗口过滤 ±30%）
- `region`（可选）: 'corner' | 'edge' | 'center' — 区域过滤
- `limit`（可选）: number — 返回条数，默认 5

**响应：** [{ id, board_size, move_number, region, description, similarity, game_meta, snapshot }]

### GET /api/go-knowledge/stats
查询知识库统计

**响应：**
- `totalCount`: number — 总记录数
- `boardSizeCounts`: { boardSize, count }[] — 各棋盘大小分布
- `regionCounts`: { region, count }[] — 各区域分布
- `latestImport`: string — 最近导入时间

## 引擎安装与恢复

### KataGo（深度学习引擎）
- **安装路径**: 支持环境变量 `KATAGO_DIR` 覆盖，默认自动探测：
  - 生产：`/usr/local/katago/`
  - 本地开发：`~/katago/`
- **Analysis Engine 协议**: `go-engine/route.ts` 使用 KataGo Analysis Engine JSON 协议（非 GTP）
  - 通过 `EnginePool` + `KataGoAnalysisManager` 管理多模型常驻进程
  - 每个模型一个常驻进程，模型加载一次后复用
  - 落子请求通过 JSON query（含棋盘状态、rules、komi、maxVisits）获取分析结果
  - 支持 monitor 页面动态切换模型和 visits
  - 进程崩溃自动重启，下次请求时恢复
- **自动安装**: `scripts/install-katago.sh`
  - 从源码编译 KataGo v1.15.3 Eigen/AVX2 CPU 后端（无需GPU）
  - 自动下载可用模型（rect15通用模型 + 其他）
  - 配置生成时自动注释重复键（避免KataGo因重复键崩溃）
  - `scripts/prepare.sh` 会在每次 `pnpm install` 时自动检测并安装
- **模型配置**: `go-engine/route.ts` 中 `getModelPathFromKey()` 映射模型键到文件路径
  - 主要模型：`rect15`（rect15-b20c256, 87MB, 通用, 默认）
  - 其他模型：`kata9x9`（9x9专用）、`humanv0`（人类风格）、`g170`（官方小模型）、`b6c64`/`b24c64`（lionffen系列，备选）
- **沙箱重置**: KataGo 编译产物在系统目录，沙箱重置后会丢失，`prepare.sh` 会自动恢复

### GnuGo（经典引擎）
- **项目捆绑**: `bin/gnugo`（8MB x86_64 二进制，随 git 持久化）
- **备选路径**: `/usr/games/gnugo`（系统安装）

## 数据库Schema（Supabase，表名前缀 letsgo_）

### letsgo_users
| 列名 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | 用户ID |
| nickname | VARCHAR(50) UNIQUE | 昵称 |
| password_hash | TEXT | bcrypt密码哈希 |
| points | INTEGER DEFAULT 100 | 积分余额 |
| total_games | INTEGER DEFAULT 0 | 总局数 |
| wins | INTEGER DEFAULT 0 | 胜场 |
| created_at | TIMESTAMPTZ | 创建时间 |
| updated_at | TIMESTAMPTZ | 更新时间 |

### letsgo_point_transactions
| 列名 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | 交易ID |
| user_id | INTEGER FK→letsgo_users | 用户ID |
| amount | INTEGER | 变动量（负数为扣除） |
| type | VARCHAR(50) | 类型（engine_use等） |
| description | TEXT | 描述 |
| game_id | INTEGER | 关联棋局ID |
| created_at | TIMESTAMPTZ | 创建时间 |

### letsgo_games
| 列名 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | 棋局ID |
| player_id | INTEGER FK→letsgo_players | 旧关联（可空） |
| user_id | INTEGER FK→letsgo_users | 新关联（用户系统） |
| board_size | INTEGER DEFAULT 9 | 棋盘大小 |
| difficulty | VARCHAR(20) DEFAULT 'easy' | 难度 |
| engine | TEXT DEFAULT 'local' | 使用的引擎 |
| moves | JSONB | 落子历史 |
| commentaries | JSONB | 解说记录 |
| final_board | JSONB | 终局棋盘 |
| black_score / white_score | INTEGER | 比分 |
| status | VARCHAR(20) | playing/finished |
| title | VARCHAR(200) | 棋局标题 |
| created_at / updated_at | TIMESTAMPTZ | 时间 |

### letsgo_position_index（向量知识库）
| 列名 | 类型 | 说明 |
|------|------|------|
| id | UUID PK | 记录ID |
| board_size | INTEGER | 棋盘大小（9/13/19） |
| move_number | INTEGER | 手数 |
| region | VARCHAR(20) | 区域（corner/edge/center） |
| description | TEXT | 自然语言描述（用于embedding） |
| embedding | vector(1024) | BGE-M3向量（pgvector格式） |
| snapshot | JSONB | 完整BoardSnapshot |
| game_meta | JSONB | 对局元数据（棋手、结果等） |
| created_at | TIMESTAMPTZ | 创建时间 |

**索引**：HNSW向量索引（cosine相似度）+ board_size/move_number/region 联合过滤索引

**迁移方式**：`docker-start.sh` 使用psql自动迁移（需设置 `COZE_SUPABASE_DB_URL` 环境变量，Session pooler模式）

## 围棋逻辑说明

### 核心概念
- **气 (Liberty)**: 棋子相邻的空交叉点
- **提子 (Capture)**: 气被堵住时被吃掉
- **合法落子**: 不能落在无气的位置（除非能提子）
- **打劫 (Ko)**: 单子互提的禁止规则

### 星位 (Hoshi)
- 9路: 5个星位（四角+天元）
- 13路: 9个星位
- 19路: 9个星位（标准）

### 坐标系统
- 列标签: A-T（跳过I），从左到右
- 行标签: 1-19，从下到上
- 棋盘数组: board[0][0] = 左上角

## 设计规范

### 棋盘渲染
- 使用SVG渲染，棋子精确落在交叉点
- 木纹渐变背景，棋子径向渐变+阴影
- 动态cellSize：9路=44px, 13路=34px, 19路=26px

### 配色
- 主色调：琥珀色/金色 (#d4a574)
- 背景：渐变琥珀色
- 棋子：黑/白径向渐变效果

### 响应式
- 移动端：单列布局
- 桌面端：3列布局（左面板+棋盘+聊天）

## 开发命令

```bash
pnpm dev          # 启动开发服务器
pnpm build        # 构建生产版本
pnpm start        # 启动生产服务器
pnpm lint         # 代码检查
pnpm ts-check     # TypeScript类型检查
```
