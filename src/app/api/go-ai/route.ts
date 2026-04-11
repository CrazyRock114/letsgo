// AI围棋对弈服务 - 使用LLM进行智能教学，真正的流式输出

import { NextRequest, NextResponse } from "next/server";
import { LLMClient, Config, HeaderUtils } from "coze-coding-dev-sdk";
import { boardToString, positionToCoordinate, type Stone, type Board } from "@/lib/go-logic";

const config = new Config();

// 围棋教学系统提示
const GO_TUTOR_SYSTEM = `你是"小围棋"，一个专为儿童围棋学习设计的AI围棋教练。
规则：
1. 用简单有趣的语言教孩子下围棋，像讲故事一样
2. 鼓励孩子的每一步尝试，即使下错了也要温和引导
3. 用生活化的比喻解释围棋概念（比如：气就像呼吸，围地就像圈地盘）
4. 解说要简短，1-3句话即可，不要太长
5. 适当使用儿童喜欢的语气词`;

// 棋局解说系统提示
const COMMENTARY_SYSTEM = `你是"小围棋"，一个儿童围棋教练。你正在为孩子的每一步棋做简短解说。
要求：
1. 简短1-2句话，用儿童能理解的语言
2. 如果是好棋，给予鼓励
3. 可以简单提一下这步棋的作用（占角、连结、防守、进攻等）
4. 如果这步棋有提子，说明提了几个子
5. 语气活泼可爱`;

// AI对弈系统提示
const AI_PLAY_SYSTEM = `你是儿童围棋AI，正在和一个初学者孩子下棋。
你要选择一个合理的落子位置。要求：
1. 选择合法的空位落子
2. 优先考虑：占角 > 守边 > 连结自己的棋子 > 堵对方
3. 不要下在已经被占的位置
4. 用JSON格式回复：{"position": "坐标", "reason": "1句话说明原因"}
坐标格式：列用A-T表示（跳过I），行用1-19表示，如"D4"`;

// 构建棋局描述文本
function buildBoardDescription(board: Board, currentPlayer: Stone, lastMove?: { row: number; col: number }, moveColor?: Stone, captured?: number): string {
  const boardStr = boardToString(board);
  const size = board.length;
  let desc = `当前棋盘大小：${size}x${size}\n棋盘状态（X=黑棋, O=白棋, .=空位）：\n${boardStr}\n当前轮到：${currentPlayer === 'black' ? '黑棋' : '白棋'}`;
  
  if (lastMove) {
    const coord = positionToCoordinate(lastMove.row, lastMove.col);
    const color = moveColor === 'black' ? '黑棋' : '白棋';
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
    const { type, board, currentPlayer, lastMove, moveColor, captured, question } = await request.json();
    const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
    const client = new LLMClient(config, customHeaders);
    
    let messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    const boardDesc = buildBoardDescription(board, currentPlayer, lastMove, moveColor, captured);
    
    if (type === 'commentary') {
      // 每步棋的简短解说
      messages = [
        { role: 'system', content: COMMENTARY_SYSTEM },
        { role: 'user', content: boardDesc + '\n\n请用1-2句话简短解说这步棋。' }
      ];
    } else if (type === 'teach') {
      // 教学解读
      messages = [
        { role: 'system', content: GO_TUTOR_SYSTEM },
        { role: 'user', content: boardDesc + '\n\n请给这个孩子一些围棋指导，用简单有趣的方式解释当前局面并给出建议。' }
      ];
    } else if (type === 'chat') {
      // 结合棋局的问答
      messages = [
        { role: 'system', content: GO_TUTOR_SYSTEM + '\n\n你要结合当前棋局来回答问题，参考棋盘上棋子的位置和形势来给出具体的、有针对性的回答，不要给笼统的回答。' },
        { role: 'user', content: boardDesc + '\n\n孩子的问题：' + question }
      ];
    } else if (type === 'ai-move') {
      // AI对弈落子
      messages = [
        { role: 'system', content: AI_PLAY_SYSTEM },
        { role: 'user', content: boardDesc + '\n\n你是白棋(O)，请选择下一步落子位置。只回复JSON。' }
      ];
    }
    
    // 使用LLM流式输出，直接pipe到HTTP响应
    const llmStream = client.stream(messages, {
      temperature: type === 'ai-move' ? 0.4 : 0.8,
      model: 'doubao-seed-1-6-251015'
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
