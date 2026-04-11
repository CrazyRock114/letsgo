// AI围棋对弈服务 - 使用LLM进行智能对弈和教学

import { NextRequest, NextResponse } from "next/server";
import { LLMClient, Config } from "coze-coding-dev-sdk";
import { boardToString, positionToCoordinate, type Stone, type Board } from "@/lib/go-logic";

const config = new Config();
const client = new LLMClient(config);

// 围棋AI系统提示
const GO_TUTOR_SYSTEM = `你是小围棋，一个专为儿童围棋学习设计的AI围棋教练。你需要：
1. 用简单有趣的语言教孩子下围棋
2. 鼓励孩子的每一步尝试
3. 用游戏化的方式解释规则
4. 对局中给出温和的提示和指导

棋盘用19x19坐标系，坐标格式：列用A-S表示，行用1-19表示（从下往上）。
棋子表示：黑棋用X，白棋用O，空点用.`;

const AI_PLAY_SYSTEM = `你是小围棋，一个友好的儿童围棋AI。你正在和一个初学者孩子下棋。
棋盘用19x19坐标系，坐标格式：列用A-S表示（从左往右），行用1-19表示（从下往上）。
棋子表示：黑棋用X，白棋用O，空点用.

请选择一个合法的位置落子，并简要说明你的意图。用JSON格式回复：
{
  "position": "D4",
  "reason": "我想在这里落子的原因"
}

记住要选择合法的位置，不要选择已经有棋子的位置。`;

export interface GameState {
  board: Board;
  currentPlayer: Stone;
  history: Array<{
    position: { row: number; col: number };
    color: Stone;
    captured: number;
  }>;
  lastAIMove?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

// 获取AI对弈落子
export async function getAIMove(
  board: Board,
  currentPlayer: Stone
): Promise<{ position: string; reason: string } | null> {
  const boardStr = boardToString(board);
  const playerColor = currentPlayer === 'black' ? '黑棋(X)' : '白棋(O)';
  
  const messages = [
    { role: 'system' as const, content: AI_PLAY_SYSTEM },
    { role: 'user' as const, content: `当前棋盘状态（黑棋先手，用X表示黑棋，O表示白棋）：
${boardStr}

你是${playerColor}。请选择下一步落子位置。用JSON格式回复你的落子坐标和原因。` }
  ];

  try {
    const stream = client.stream(messages, { 
      temperature: 0.7,
      model: 'doubao-seed-1-6-251015'
    });
    
    let fullResponse = '';
    for await (const chunk of stream) {
      if (chunk.content) {
        fullResponse += chunk.content.toString();
      }
    }
    
    // 尝试解析JSON响应
    const jsonMatch = fullResponse.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      return {
        position: data.position?.toUpperCase(),
        reason: data.reason || ''
      };
    }
    
    return null;
  } catch (error) {
    console.error('AI move error:', error);
    return null;
  }
}

// 获取AI教学解读
export async function getAITeaching(
  board: Board,
  currentPlayer: Stone,
  lastMove?: { row: number; col: number },
  question?: string
): Promise<string> {
  const boardStr = boardToString(board);
  const playerColor = currentPlayer === 'black' ? '黑棋(X)' : '白棋(O)';
  
  let context = `当前棋盘状态：
${boardStr}

当前回合：${playerColor}`;

  if (lastMove) {
    const coord = positionToCoordinate(lastMove.row, lastMove.col);
    context += `\n最后落子位置：${coord}`;
  }

  const messages = [
    { role: 'system' as const, content: GO_TUTOR_SYSTEM },
    { 
      role: 'user' as const, 
      content: question 
        ? `${context}\n\n孩子的问题：${question}`
        : `${context}\n\n请给这个孩子一些围棋指导，用简单有趣的方式解释当前局面，并给出建议。`
    }
  ];

  try {
    const stream = client.stream(messages, { 
      temperature: 0.8,
      model: 'doubao-seed-1-6-251015'
    });
    
    let fullResponse = '';
    for await (const chunk of stream) {
      if (chunk.content) {
        fullResponse += chunk.content.toString();
      }
    }
    
    return fullResponse || '让我想想这一步该怎么下...';
  } catch (error) {
    console.error('AI teaching error:', error);
    return '小围棋正在思考中...';
  }
}

// 获取围棋规则教学
export async function getRuleTeaching(topic?: string): Promise<string> {
  const topics: Record<string, string> = {
    'basics': `
围棋基础知识：
1. 围棋使用19x19的棋盘
2. 黑白两方轮流下棋，黑棋先手
3. 棋子落在交叉点上，而不是格子里
4. 目标是围住更多的地盘

让我们从最简单的开始学习！
`,
    ' Liberties': `
围棋的"气"是什么？
- 棋子相邻的空点就是它的"气"
- 中间的棋子有4口气（四面）
- 边上的棋子有3口气
- 角落的棋子只有2口气
- 当一颗棋子的气都被堵住，它就被提掉了！

数一数，这颗棋子的气在哪里？
`,
    'capture': `
如何吃掉对方的棋子？
- 当一颗棋子的所有气都被对方堵住
- 这颗棋子就被"提掉"了
- 被提掉的棋子从棋盘上拿走

练习一下：你能找到可以吃掉对方棋子的位置吗？
`,
    'territory': `
什么是"地"？
- 你围住的空的地方就是你的"地"
- 地里面的棋子越多，你的地越大
- 最后数一数，谁围的地多谁就赢了！

试着围一小块地，看看能围多大！
`
  };

  const selectedTopic = topic && topics[topic] ? topics[topic] : topics['basics'];
  
  const messages = [
    { role: 'system' as const, content: GO_TUTOR_SYSTEM },
    { role: 'user' as const, content: `请用简单有趣的方式解释这个围棋知识：${topic || 'basics'}\n\n用儿童能理解的语言，可以配合简单的例子。` }
  ];

  try {
    const stream = client.stream(messages, { 
      temperature: 0.8,
      model: 'doubao-seed-1-6-251015'
    });
    
    let fullResponse = '';
    for await (const chunk of stream) {
      if (chunk.content) {
        fullResponse += chunk.content.toString();
      }
    }
    
    return fullResponse || selectedTopic;
  } catch (error) {
    console.error('AI rule teaching error:', error);
    return selectedTopic;
  }
}

// 流式API端点
export async function POST(request: NextRequest) {
  try {
    const { type, board, currentPlayer, lastMove, question } = await request.json();
    
    let response = '';
    
    if (type === 'teach') {
      response = await getAITeaching(board, currentPlayer, lastMove, question);
    } else if (type === 'rule') {
      response = await getRuleTeaching(question);
    }
    
    // 返回SSE流
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const char of response) {
          controller.enqueue(encoder.encode(char));
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        controller.close();
      }
    });
    
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Stream API error:', error);
    return NextResponse.json({ error: '处理失败' }, { status: 500 });
  }
}
