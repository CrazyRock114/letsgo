# 小围棋乐园 - 项目规范

## 项目概述

专为儿童设计的围棋AI对弈与教学平台，通过有趣可爱的界面和AI互动，帮助孩子轻松学习围棋。

## 技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **AI 集成**: coze-coding-dev-sdk (LLM流式输出) + DeepSeek API (Railway/外部部署)
- **数据库**: Supabase（表名前缀 `letsgo_`，与其他项目共用同一Supabase实例）

## 项目结构

```
src/
├── app/
│   ├── api/
│   │   ├── go-ai/
│   │   │   └── route.ts     # AI教学与解说API（LLM流式输出）
│   │   ├── go-engine/
│   │   │   └── route.ts     # KataGo/GnuGo围棋AI引擎（GTP协议桥接）
│   │   ├── games/
│   │   │   ├── route.ts     # 棋局保存/载入/列表/删除API
│   │   │   └── [id]/route.ts # 单个棋局载入API
│   │   └── players/
│   │       └── route.ts     # 用户创建/查找API
│   ├── globals.css           # 全局样式
│   ├── layout.tsx            # 布局组件
│   └── page.tsx              # 主页面（围棋游戏+百科+教程）
├── components/
│   └── ui/                   # shadcn/ui 组件库
├── lib/
│   ├── go-logic.ts          # 围棋游戏核心逻辑
│   ├── go-encyclopedia.ts   # 围棋百科数据（35+核心术语）
│   ├── go-tutorial.ts       # 围棋教程数据（8章40+步骤）
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
- AI方：KataGo深度学习引擎（GTP协议，优先） + GnuGo回退 + 本地AI兜底
  - 初级：KataGo maxVisits=15 / GnuGo Level 3 / 本地随机+避傻
  - 中级：KataGo maxVisits=50 / GnuGo Level 7 / 本地评分选择
  - 高级：KataGo maxVisits=150 / GnuGo Level 10 / 本地1步前瞻
- 停手(Pass)功能：双方连续停手结束棋局
- 贴目规则：9路2.5目、13路3.5目、19路6.5目（白方补偿）
- 自动结束：步数上限（9路60步/13路100步/19路200步）

### 2. 每步AI解说
- 每步棋后自动获取AI简短解说（1句）
- 真正的LLM流式输出（打字机效果）
- 解说包含落子位置、作用、鼓励
- **专业术语嵌入**：解说中自然融入围棋术语并在括号中解释
- **智能气数提及**：只在打吃(1气)或提子时提及气数，3气以上不提
- **解说防丢失**：快速落子时，旧解说仍会被保存到解说列表，不会被新请求覆盖

### 3. AI教学
- 流式AI教学解读（结合当前棋局）
- **提示与教学合一**：点击按钮同时显示建议落点+AI解释为何该位置好
- 提示位置由评分引擎选出（findBestHint），教学内容解释该位置
- **围棋百科**：35+核心术语，7大分类，搜索/筛选/详情查看
- **围棋教程**：8章40+步骤渐进课程（启蒙→吃子→棋形→布局→中盘→官子→提高）
- 上下文感知问答（发送棋盘状态给AI）

### 4. 辅助功能
- 提示功能（评分引擎选最佳位置，永久停留直到再次点击）
- 悔棋功能（撤销2步：玩家+AI）
- 停手功能（双方连续停手结束棋局）
- 重新开始（支持切换棋盘大小）
- 比分实时计算（白方含动态贴目）
- 游戏结束判定（停手/步数上限/棋盘满）
- 引擎/难度无缝切换：难度切换不重开棋局（toast提示），引擎切换需确认
- 保存棋局命名含引擎信息（如"9路 初级 KataGo 2026/4/19"）
- 复盘从任意步继续对弈：复盘模式下可"从第N步继续对弈"，截取历史继续游戏

## API接口

### POST /api/go-ai
LLM流式响应，Content-Type: text/event-stream

**请求类型：**

| type | 说明 | 额外参数 |
|------|------|---------|
| `commentary` | 每步棋简短解说 | lastMove, moveColor, captured |
| `teach` | 教学解读 | lastMove, hintPosition |
| `chat` | 结合棋局的问答 | question |
| `ai-move` | AI落子建议 | - |

**通用参数：**
- `board`: 棋盘状态数组
- `currentPlayer`: "black" | "white"

### POST /api/go-engine
KataGo/GnuGo AI引擎桥接（GTP协议），优先KataGo，GnuGo回退

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
- `score`: 终局得分（仅final_score）

### GET /api/go-engine
返回可用引擎列表

**响应：**
- `engines`: [{id, name, available, desc}, ...]

## 引擎安装与恢复

### KataGo（深度学习引擎）
- **安装路径**: `/usr/local/katago/`
- **持久化进程**: `go-engine/route.ts` 中的 `PersistentKataGo` 类管理长期运行的KataGo进程
  - 进程只启动一次，模型只加载一次（避免每步重新加载模型导致超时）
  - 通过 `kata-set-param maxVisits` 动态调整难度
  - 每次落子：发送 `boardsize` + `clear_board` + 重放落子历史 + `genmove`
  - 进程崩溃自动重启，下次请求时恢复
- **自动安装**: `scripts/install-katago.sh`
  - 从源码编译 KataGo v1.15.3 Eigen/AVX2 CPU 后端（无需GPU）
  - 自动下载所有可用模型（lionffen小模型 + rect15通用模型）
  - 配置生成时自动注释重复键（避免KataGo因重复键崩溃）
  - `scripts/prepare.sh` 会在每次 `pnpm install` 时自动检测并安装
- **模型自动发现**: `go-engine/route.ts` 中的 `findKataGoModel()` 自动扫描 `/usr/local/katago/` 下的模型文件
  - 优先级：lionffen(2MB,快,支持所有棋盘) > g170-b6c96(小,快) > rect15(87MB,通用) > 其他
- **沙箱重置**: KataGo 编译产物在系统目录，沙箱重置后会丢失，`prepare.sh` 会自动恢复

### GnuGo（经典引擎）
- **项目捆绑**: `bin/gnugo`（8MB x86_64 二进制，随 git 持久化）
- **备选路径**: `/usr/games/gnugo`（系统安装）

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
