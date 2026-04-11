# 小围棋乐园 - 项目规范

## 项目概述

专为儿童设计的围棋AI对弈与教学平台，通过有趣可爱的界面和AI互动，帮助孩子轻松学习围棋。

## 技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **AI 集成**: coze-coding-dev-sdk (LLM)

## 项目结构

```
src/
├── app/
│   ├── api/
│   │   └── go-ai/
│   │       └── route.ts     # AI对弈与教学API
│   ├── globals.css           # 全局样式
│   ├── layout.tsx            # 布局组件
│   └── page.tsx              # 主页面（围棋游戏）
├── components/
│   └── ui/                   # shadcn/ui 组件库
├── lib/
│   ├── go-logic.ts          # 围棋游戏核心逻辑
│   └── utils.ts              # 通用工具函数
└── server.ts                 # 自定义服务端入口
```

## 核心功能

### 1. 围棋对弈
- 9路简化棋盘，适合初学者
- 黑白双方轮流落子
- 自动提子功能
- 最后一手标记

### 2. AI对战
- AI随机落子（白方）
- 实时显示AI思考状态

### 3. AI教学
- 流式AI教学解读
- 围棋规则教程（5个步骤）
- 实时问答功能

### 4. 辅助功能
- 提示功能（显示合法落子位置）
- 悔棋功能
- 重新开始
- 比分实时计算

## 开发命令

```bash
pnpm dev          # 启动开发服务器
pnpm build        # 构建生产版本
pnpm start        # 启动生产服务器
pnpm lint         # 代码检查
pnpm ts-check     # TypeScript类型检查
```

## 围棋逻辑说明

### 核心概念
- **气 (Liberty)**: 棋子相邻的空交叉点
- **提子 (Capture)**: 气被堵住时被吃掉
- **合法落子**: 不能落在无气的位置（除非能提子）

### API接口

#### POST /api/go-ai
获取AI教学解读（流式响应）

Request:
```json
{
  "type": "teach" | "rule",
  "board": [["X", "O", null, ...], ...],
  "currentPlayer": "black" | "white",
  "lastMove": { "row": 4, "col": 4 },
  "question": "这步棋是什么意思？"
}
```

## 设计规范

### 配色
- 主色调：琥珀色/金色 (#d4a574)
- 背景：渐变琥珀色
- 棋子：黑/白渐变效果

### 响应式
- 移动端：单列布局
- 桌面端：三列布局

## 注意事项

1. 棋盘使用9路（适合初学者）
2. AI使用随机落子策略（简化版）
3. 教学使用流式LLM响应
4. 所有API调用通过 `/api/go-ai` 路由
