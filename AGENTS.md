# 小围棋乐园 - 项目规范

## 项目概述

专为儿童设计的围棋AI对弈与教学平台，通过有趣可爱的界面和AI互动，帮助孩子轻松学习围棋。

## 技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **AI 集成**: coze-coding-dev-sdk (LLM流式输出)

## 项目结构

```
src/
├── app/
│   ├── api/
│   │   ├── go-ai/
│   │   │   └── route.ts     # AI教学与解说API（真正LLM流式输出，含专业术语）
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
- AI白方：加权随机策略（优先角>边>中腹）

### 2. 每步AI解说
- 每步棋后自动获取AI简短解说（2-3句）
- 真正的LLM流式输出（打字机效果）
- 解说包含落子位置、作用、鼓励
- **专业术语嵌入**：解说中自然融入围棋术语并在括号中解释（如"打吃（让对方只剩一口气）"）

### 3. AI教学
- 流式AI教学解读（结合当前棋局）
- **围棋百科**：35+核心术语，7大分类，搜索/筛选/详情查看
- **围棋教程**：8章40+步骤渐进课程（启蒙→吃子→棋形→布局→中盘→官子→提高）
- 上下文感知问答（发送棋盘状态给AI）
- 教学中主动引入专业术语并解释

### 4. 辅助功能
- 提示功能（优先显示角部合法位置）
- 悔棋功能（撤销2步：玩家+AI）
- 重新开始（支持切换棋盘大小）
- 比分实时计算（含领地评估）

## API接口

### POST /api/go-ai
LLM流式响应，Content-Type: text/event-stream

**请求类型：**

| type | 说明 | 额外参数 |
|------|------|---------|
| `commentary` | 每步棋简短解说 | lastMove, moveColor, captured |
| `teach` | 教学解读 | lastMove |
| `chat` | 结合棋局的问答 | question |
| `ai-move` | AI落子建议 | - |

**通用参数：**
- `board`: 棋盘状态数组
- `currentPlayer`: "black" | "white"

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
