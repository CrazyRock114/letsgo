// AI围棋对弈服务 - 使用LLM进行智能教学，真正的流式输出
// 支持两种 LLM 后端：
//   1. Coze SDK（沙箱环境自动注入 COZE_WORKLOAD_IDENTITY_API_KEY）
//   2. DeepSeek API（设置 DEEPSEEK_API_KEY 环境变量）

import { NextRequest, NextResponse } from "next/server";
import { LLMClient, Config, HeaderUtils } from "coze-coding-dev-sdk";
import { boardToString, positionToCoordinate, getMoveContext, type Stone, type Board } from "@/lib/go-logic";

// LLM 提供者检测
const LLM_PROVIDER = (() => {
  if (process.env.COZE_WORKLOAD_IDENTITY_API_KEY) return 'coze' as const;
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek' as const;
  return 'none' as const;
})();

// Coze 配置（仅 Coze 环境下使用）
const cozeConfig = new Config();

// DeepSeek 配置
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

console.log(`[go-ai] LLM provider: ${LLM_PROVIDER}${LLM_PROVIDER === 'deepseek' ? ` model=${DEEPSEEK_MODEL}` : ''}`);

// 第三方观赛者视角的解说系统提示
const COMMENTARY_SYSTEM = `你是围棋解说员，为小朋友解说对局。第三方视角，不是棋手。
规则：
1. 只说1句话，言简意赅，绝不啰嗦
2.【最重要】你是在解说"刚刚下出的这步棋"，必须明确说是"黑方"还是"白方"刚落子
3. 简述这步棋的作用（占角、连接、进攻、防守等）
4. 如有提子，说明提了几个
5.【最高优先级】严格依据"局面事实"数据说话！
   - 不要自己从棋盘数气，直接看给出的气数
   - 事实没说"只剩1口气"，就不能说"打吃"
   - 事实没说提子，就不能说"提子"
   - 棋子颜色以事实为准
6. 不要每次都说"有几口气"，只在打吃(对方只剩1口气)或提子时才提到气
7. 最多用1个围棋术语，在括号中简短解释。只有事实确实显示只剩1口气时才能说"打吃"
8. 不要提"即将落子"、"接下来"等关于下一步的内容，只解说刚刚下的这一步`;

// AI教学系统提示
const GO_TUTOR_SYSTEM = `你是"小围棋"，一个专为儿童围棋学习设计的AI围棋教练。
规则：
1. 用简单有趣的语言教孩子下围棋，像讲故事一样
2. 鼓励孩子的每一步尝试，即使下错了也要温和引导
3. 用生活化的比喻解释围棋概念
4. 解说要简短，1-3句话即可
5. 适当使用儿童喜欢的语气词
6. 【重要】在教学中主动引入围棋专业术语，并在括号中用简单语言解释。帮助孩子逐步积累专业词汇量。例如：
   - "你这步棋让对方的棋子只剩一口气了，这就是打吃（也叫叫吃，意思是对方必须赶紧逃跑）！"
   - "你占了星位（棋盘角上四四位置的圆点），这是开局占角的好方法！"
7. 常见术语参考：气、提子、打吃、长、连、断、双打吃、关门吃、抱吃、征子、枷吃、扑、倒扑、接不归、眼、真眼、假眼、活棋、死棋、双活、星、小目、三三、挂角、守角、拆边、定式、劫、禁着点、先手、后手、厚势、实利、打入、弃子、腾挪、收官、见合、手筋、好形、愚形、金角银边草肚皮`;

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

// 构建棋局描述（带行列标签 + 关键位置气数 + 落子历史）
function buildBoardDescription(
  board: Board,
  currentPlayer: Stone,
  lastMove?: { row: number; col: number },
  moveColor?: Stone,
  captured?: number,
  moveHistory?: Array<{ position: { row: number; col: number }; color: Stone }>
): string {
  const boardStr = boardToString(board);
  const size = board.length;
  let desc = `棋盘大小：${size}x${size}\nX=黑棋 O=白棋 .=空位\n行号从下到上1-${size}（1在底部），列号从左到右（跳过I列）\n\n${boardStr}`;

  // 落子历史
  if (moveHistory && moveHistory.length > 0) {
    const historyStr = moveHistory.slice(-10).map((m, i) => {
      const idx = moveHistory.length - Math.min(moveHistory.length, 10) + i + 1;
      const coord = positionToCoordinate(m.position.row, m.position.col, size);
      const color = m.color === 'black' ? '黑' : '白';
      return `第${idx}手: ${color}方 ${coord}`;
    }).join('\n');
    desc += `\n\n最近落子记录：\n${historyStr}`;
  }

  // 最后一手详细上下文
  if (lastMove) {
    const coord = positionToCoordinate(lastMove.row, lastMove.col, size);
    const color = moveColor === 'black' ? '黑方' : '白方';
    desc += `\n\n最后一手：${color}下在${coord}`;
    if (captured && captured > 0) {
      desc += `，提了${captured}个子`;
    }

    // === 关键局面事实（解说必须依据这些事实） ===
    const facts: string[] = [];

    // 落子位置的精确上下文（相邻棋子）
    const moveCtx = getMoveContext(board, lastMove.row, lastMove.col);
    facts.push(`落子位置：${moveCtx}`);

    // 相邻对方棋子的气数（只标注关键状态）
    const directions: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const checkedGroups = new Set<string>();
    for (const [dr, dc] of directions) {
      const nr = lastMove.row + dr;
      const nc = lastMove.col + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
        const neighbor = board[nr][nc];
        if (neighbor && neighbor !== moveColor) {
          const group = getGroupKey(board, nr, nc);
          if (!checkedGroups.has(group)) {
            checkedGroups.add(group);
            const libs = getGroupLibertiesExport(board, nr, nc);
            const nCoord = positionToCoordinate(nr, nc, size);
            const nColor = neighbor === 'black' ? '黑棋' : '白棋';
            if (libs === 1) {
              facts.push(`【打吃】相邻${nColor}(${nCoord}所在的棋组)只剩1口气，被${color}打吃了！`);
            } else if (libs === 2) {
              facts.push(`相邻${nColor}(${nCoord}所在的棋组)剩2口气`);
            }
            // 3口气及以上不提及，避免解说啰嗦
          }
        }
      }
    }

    if (captured && captured > 0) {
      facts.push(`【提子】这步棋提了${captured}个${moveColor === 'black' ? '白' : '黑'}子`);
    }

    desc += '\n\n=== 局面事实（解说必须严格依据以下事实，不得自行推断） ===\n' + facts.join('\n');
  }

  // 明确标注：这是谁刚刚下的（而不是"轮到谁"）
  if (moveColor) {
    desc += `\n\n【刚落子方】${moveColor === 'black' ? '黑方' : '白方'}刚下完这步棋`;
  }
  desc += `\n接下来轮到：${currentPlayer === 'black' ? '黑棋' : '白棋'}`;

  return desc;
}

// 获取棋组唯一标识（避免重复报告同一组的气数）
function getGroupKey(board: Board, row: number, col: number): string {
  const stone = board[row][col];
  if (!stone) return '';
  const visited = new Set<string>();
  const stack = [`${row},${col}`];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const [r, c] = key.split(',').map(Number);
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr;
      const nc = c + dc;
      const nk = `${nr},${nc}`;
      if (nr >= 0 && nr < board.length && nc >= 0 && nc < board.length && !visited.has(nk) && board[nr][nc] === stone) {
        stack.push(nk);
      }
    }
  }
  return Array.from(visited).sort().join(';');
}

// 导出getGroupLiberties的别名
function getGroupLibertiesExport(board: Board, row: number, col: number): number {
  const stone = board[row][col];
  if (!stone) return 0;
  const visited = new Set<string>();
  const liberties = new Set<string>();
  const stack = [`${row},${col}`];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const [r, c] = key.split(',').map(Number);
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < board.length && nc >= 0 && nc < board.length) {
        const nk = `${nr},${nc}`;
        if (board[nr][nc] === null) {
          liberties.add(nk);
        } else if (board[nr][nc] === stone && !visited.has(nk)) {
          stack.push(nk);
        }
      }
    }
  }
  return liberties.size;
}

// 流式API端点
export async function POST(request: NextRequest) {
  try {
    if (LLM_PROVIDER === 'none') {
      return NextResponse.json({ error: '未配置 LLM API。请设置 COZE_WORKLOAD_IDENTITY_API_KEY 或 DEEPSEEK_API_KEY 环境变量。' }, { status: 503 });
    }

    const { type, board: rawBoard, currentPlayer, lastMove, moveColor, captured, question, difficulty, moveHistory, hintPosition } = await request.json();
    // 标准化棋盘：前端用"empty"字符串表示空位，但围棋逻辑用null
    const board: Board = (rawBoard as string[][]).map((row: string[]) =>
      row.map((cell: string) => cell === 'empty' ? null : cell)
    ) as Board;

    let messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    const boardDesc = buildBoardDescription(board, currentPlayer, lastMove, moveColor, captured, moveHistory);

    if (type === 'commentary') {
      // 第三方观赛者解说
      messages = [
        { role: 'system', content: COMMENTARY_SYSTEM },
        { role: 'user', content: boardDesc + '\n\n用1句话简短解说这步棋，严格依据上面"局面事实"的数据。不要提气数，除非是打吃或提子。' }
      ];
    } else if (type === 'teach') {
      let teachPrompt = boardDesc + '\n\n请给这个孩子一些围棋指导。';
      if (hintPosition) {
        teachPrompt = boardDesc + `\n\n系统建议的落子位置是${hintPosition}。请解释为什么这个位置好（1-2句话），用简单有趣的语言告诉孩子。`;
      }
      messages = [
        { role: 'system', content: GO_TUTOR_SYSTEM },
        { role: 'user', content: teachPrompt }
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

    const temperature = type === 'ai-move' ? 0.4 : 0.8;

    // 根据提供者选择流式输出方式
    if (LLM_PROVIDER === 'coze') {
      return streamCoze(request, messages, temperature);
    } else {
      return streamDeepSeek(messages, temperature);
    }
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: '处理失败' }, { status: 500 });
  }
}

// ========== Coze SDK 流式输出 ==========
async function streamCoze(request: NextRequest, messages: Array<{ role: 'system' | 'user'; content: string }>, temperature: number) {
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  const client = new LLMClient(cozeConfig, customHeaders);

  const llmStream = client.stream(messages, {
    temperature,
    model: 'doubao-seed-1-6-251015',
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
        console.error('Coze LLM stream error:', error);
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
}

// ========== DeepSeek API 流式输出（OpenAI 兼容格式） ==========
async function streamDeepSeek(messages: Array<{ role: 'system' | 'user'; content: string }>, temperature: number) {
  const apiKey = process.env.DEEPSEEK_API_KEY!;
  const url = `${DEEPSEEK_API_URL}/chat/completions`;

  console.log(`[go-ai] Calling DeepSeek: url=${url}, model=${DEEPSEEK_MODEL}, msgs=${messages.length}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        temperature,
        stream: true,
        max_tokens: 512,
      }),
    });
  } catch (fetchError) {
    console.error('[go-ai] DeepSeek fetch network error:', fetchError);
    return NextResponse.json({ error: `DeepSeek 网络错误: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}` }, { status: 502 });
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[go-ai] DeepSeek API error: ${response.status} ${errorText}`);
    return NextResponse.json({ error: `DeepSeek API 调用失败: ${response.status}`, detail: errorText }, { status: 502 });
  }

  // 将 DeepSeek 的 SSE 格式转换为纯文本流
  const encoder = new TextEncoder();
  const readableStream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // SSE 格式：每条消息以 \n\n 分隔，每行格式为 "data: {...}"
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 最后一行可能不完整，保留

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6); // 去掉 "data: "
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                controller.enqueue(encoder.encode(content));
              }
            } catch {
              // 忽略解析失败的行
            }
          }
        }
      } catch (error) {
        console.error('DeepSeek stream read error:', error);
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
}
