// AI围棋对弈服务 - 使用LLM进行智能教学，真正的流式输出

import { NextRequest, NextResponse } from "next/server";
import { LLMClient, Config, HeaderUtils } from "coze-coding-dev-sdk";
import { boardToString, positionToCoordinate, type Stone, type Board } from "@/lib/go-logic";

const config = new Config();

// 第三方观赛者视角的解说系统提示
const COMMENTARY_SYSTEM = `你是围棋比赛的"解说员"，正在为小朋友观众解说一盘围棋对局。
你是第三方观赛者，不是棋手本人。规则：
1. 简短1-2句话解说
2. 明确说明是"黑方"还是"白方"下的这步棋
3. 用儿童能理解的语言解说：这步棋在做什么（占角、守边、连结、进攻、防守等）
4. 如果有提子，说明提了几个子
5. 语气活泼有趣，像体育解说员`;

// AI教学系统提示
const GO_TUTOR_SYSTEM = `你是"小围棋"，一个专为儿童围棋学习设计的AI围棋教练。
规则：
1. 用简单有趣的语言教孩子下围棋，像讲故事一样
2. 鼓励孩子的每一步尝试，即使下错了也要温和引导
3. 用生活化的比喻解释围棋概念
4. 解说要简短，1-3句话即可
5. 适当使用儿童喜欢的语气词`;

// AI对弈系统提示 - 根据难度调整
function getAIPlaySystem(difficulty: string): string {
  if (difficulty === 'hard') {
    return `你是一个有实力的围棋AI，正在和初学者下棋。但你要认真下，下出有水平的棋。
策略优先级：
1. 攻击对方弱子，切断对方连结
2. 抢占大场，扩展自己的势力
3. 防守自己的弱子
4. 占角、守边
用JSON格式回复：{"position": "坐标", "reason": "1句话"}
坐标格式：列用A-T表示（跳过I），行用1-19表示`;
  }
  if (difficulty === 'medium') {
    return `你是一个中等水平的围棋AI，正在和初学者孩子下棋。
策略：
1. 优先占角，然后守边
2. 如果对方棋子只有1-2口气，尝试吃掉
3. 连结自己的棋子
4. 不要故意下烂棋，但不要太难
用JSON格式回复：{"position": "坐标", "reason": "1句话"}
坐标格式：列用A-T表示（跳过I），行用1-19表示`;
  }
  // easy
  return `你是一个温柔的围棋AI，正在教初学者孩子下棋。
策略：
1. 随机下在合法位置
2. 偶尔占角，偶尔占边
3. 不主动进攻，让孩子有发挥空间
4. 如果自己的棋子快被吃了，尝试逃跑
用JSON格式回复：{"position": "坐标", "reason": "1句话"}
坐标格式：列用A-T表示（跳过I），行用1-19表示`;
}

// 构建棋局描述
function buildBoardDescription(
  board: Board,
  currentPlayer: Stone,
  lastMove?: { row: number; col: number },
  moveColor?: Stone,
  captured?: number
): string {
  const boardStr = boardToString(board);
  const size = board.length;
  let desc = `当前棋盘大小：${size}x${size}\n棋盘状态（X=黑棋, O=白棋, .=空位）：\n${boardStr}\n当前轮到：${currentPlayer === 'black' ? '黑棋' : '白棋'}`;

  if (lastMove) {
    const coord = positionToCoordinate(lastMove.row, lastMove.col);
    const color = moveColor === 'black' ? '黑方' : '白方';
    desc += `\n最后一手：${color}下在${coord}`;
    if (captured && captured > 0) {
      desc += `，提了${captured}个子`;
    }
  }

  return desc;
}

// 流式API端点
export async function POST(request: NextRequest) {
  try {
    const { type, board, currentPlayer, lastMove, moveColor, captured, question, difficulty } = await request.json();
    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
    const client = new LLMClient(config, customHeaders);

    let messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    const boardDesc = buildBoardDescription(board, currentPlayer, lastMove, moveColor, captured);

    if (type === 'commentary') {
      // 第三方观赛者解说
      messages = [
        { role: 'system', content: COMMENTARY_SYSTEM },
        { role: 'user', content: boardDesc + '\n\n请用1-2句话，以观赛解说员的身份解说这步棋。' }
      ];
    } else if (type === 'teach') {
      messages = [
        { role: 'system', content: GO_TUTOR_SYSTEM },
        { role: 'user', content: boardDesc + '\n\n请给这个孩子一些围棋指导。' }
      ];
    } else if (type === 'chat') {
      messages = [
        { role: 'system', content: GO_TUTOR_SYSTEM + '\n\n你要结合当前棋局来回答问题，参考棋盘上棋子的位置和形势来给出具体的、有针对性的回答。' },
        { role: 'user', content: boardDesc + '\n\n孩子的问题：' + question }
      ];
    } else if (type === 'ai-move') {
      messages = [
        { role: 'system', content: getAIPlaySystem(difficulty || 'easy') },
        { role: 'user', content: boardDesc + '\n\n你是白棋(O)，请选择下一步落子位置。只回复JSON。' }
      ];
    }

    const llmStream = client.stream(messages, {
      temperature: type === 'ai-move' ? 0.4 : 0.8,
      model: type === 'ai-move' ? 'doubao-seed-1-6-251015' : 'doubao-seed-1-6-251015',
    });

    const encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of llmStream) {
            if (chunk.content) {
              controller.enqueue(encoder.encode(chunk.content.toString()));
            }
          }
        } catch (error) {
          console.error('LLM stream error:', error);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: '处理失败' }, { status: 500 });
  }
}
