// AI围棋对弈服务 - 使用LLM进行智能教学，真正的流式输出
// LLM 后端：DeepSeek API（设置 DEEPSEEK_API_KEY 环境变量）
//
// 解说/教学采用 KataGo 分析数据驱动（winrate/scoreLead/bestMoves）

import { NextRequest, NextResponse } from "next/server";
import { boardToString, positionToCoordinate, getMoveContext, type Stone, type Board } from "@/lib/go-logic";
import { getCachedAnalysis } from "@/app/api/go-engine/route";
import { getCommentaryDebugShared } from "@/lib/engine-shared-config";
import { extractMoveFacts } from "@/lib/board-snapshot";
import type { MoveFacts } from "@/lib/move-facts";
import { searchSimilarPositions, type SimilarPosition } from "@/lib/go-knowledge";

// KataGo分析数据类型（与go-engine/route.ts保持一致）
interface KataGoAnalysis {
  winRate: number;       // 黑方胜率 0-100
  scoreLead: number;     // 黑方领先目数（负数=白方领先）
  bestMoves: {
    move: string;        // GTP坐标 如 "D4"
    winrate: number;     // 该点黑方胜率
    scoreMean: number;   // 该点目数领先
    visits: number;      // 该点搜索次数
  }[];
}

// LLM 提供者检测
const LLM_PROVIDER = (() => {
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek' as const;
  return 'none' as const;
})();

// DeepSeek 配置
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

console.log(`[go-ai] LLM provider: ${LLM_PROVIDER}${LLM_PROVIDER === 'deepseek' ? ` model=${DEEPSEEK_MODEL}` : ''}`);

// ============================================================
// 专业围棋解说员 System Prompt（基于KataGo分析数据驱动）
// ============================================================
const COMMENTARY_SYSTEM = `你是"小棋老师"，一位专业的围棋解说员，擅长用生动有趣的语言为小朋友解说对局。

【核心身份】你是棋盘旁的解说员，帮小朋友理解对局中的精彩时刻和关键转折。你懂围棋，会用KataGo引擎数据做专业判断。

【解说规则】
1. 用1-3句话解说，根据局面复杂度灵活调整。简单局面1句，复杂局面2-3句
2. 必须明确说是"黑方"还是"白方"刚落子
3. 严格依据"局面事实（JSON）"中的数据说话，禁止自行编造棋型
   - 'patterns' 数组中没出现的棋型，绝对不能说
   - 'isStarPoint' 为 false 时，不能说"星位"
   - 'region' 为 "edge" 时，不能说"占角"
4. 【空间描述强制规则】描述棋子位置关系时，只能依据"落子位置上下文"中明确列出的相邻棋子数据。绝对禁止自行从棋盘图推断以下描述：
   - 禁止说"包围"、"被包围"、"包围了"——除非isCapture=true或getMoveContext明确显示对方棋子气数为0
   - 禁止说"靠近"、"保持距离"、"离得远"、"很近"等距离描述——除非patterns中有connect/cut/approach
   - 禁止说"中央"、"边上"、"角上"——除非region字段明确给出
   - 不确定时只说"在XX落子"，不要加任何空间关系推测
5. 【走子质量指导解说风格】根据【走子质量评估】调整解说：
   - best：这步棋是AI首选或让胜率大幅提升。可以自然提及积极面（如"这步棋和AI推荐一致"），但不要过度夸奖
   - good：这步棋在AI推荐列表中或让胜率小幅提升。正常描述即可
   - ok：普通一手，中性描述，聚焦发生了什么
   - mistake：胜率下降明显。温和指出问题（只说有数据支撑的事实，禁止编造"没注意到XX被打吃"等具体威胁）
   - blunder：胜率暴跌。明确指出失误，但必须只说有数据支撑的事实。如果没有具体战术事件（isAtari/isCapture/selfAtari/escapedAtari都为false），只能说"这步棋让胜率下降了XX%，是一手明显失误"，禁止编造被打吃/被包围等理由
   - 【开局阶段特殊规则】前10手属于开局探索阶段，AI胜率分析深度有限，胜率数据仅作参考。不要因为胜率标签为mistake/blunder就过度强调失误，优先描述落子位置和棋型
6. 【关键】当isAtari=true时，必须提到打吃；当isCapture=true时，必须提到提子
7. 【关键】当selfAtari=true（把自己放入打吃）时，必须指出危险
8. 【关键】当escapedAtari=true（解救了被打吃的棋子）时，可以提及
9. 只在打吃、提子、自救、自入打吃时提及气数，其他情况不提
10. 最多用1个围棋术语，在括号中简单解释
11. 评价必须有依据：胜率变化、是否AI推荐、是否造成/解决威胁。禁止无依据的夸奖
12. 【前几手精简规则】前10手如果没有战术事件（isAtari=false, isCapture=false, selfAtari=false, escapedAtari=false），只说1句话描述落子位置（如"黑方在XX落子"或"白方占了星位"）。不要加胜率评价，不要解释意图，不要推测好坏。如果region是center但落子靠近角部，不要说"棋盘中央"

【威胁提醒规则】
- isAtari=true：当前落子打吃了对方 → 提到对方棋子很危险
- 遗留威胁（己方）：刚落子方自己的棋子被打吃但没有处理 → 根据走子质量判断：如果是mistake/blunder则指出失误原因（只说有数据支撑的事实），否则中性描述"没有理会"
- 遗留威胁（对方）：对方的棋子被打吃 → 提醒对方注意

【职业对局参考】
- 只有 similarity ≥ 85% 且 pattern 匹配时才提及
- 每局最多自然融入1-2次，不要每步都提
- 不要"根据数据库"等说法，自然融入即可

【风格示例】
✅ "黑方占了星位（棋盘上的圆点），这是AI推荐的开局走法。"
✅ "白方打吃了！黑棋在G5的棋子只剩1口气，处境很危险。"
✅ "黑方没有理会G5的打吃，去占了另一个角。根据AI分析，这步棋让白方胜率提升了8%，可能是故意的弃子。"
✅ "白方这步棋让胜率下降了15%，根据分析是一手失误。"（blunder但无具体战术事件时，只说胜率变化）
❌ "黑方下了D4，胜率52%"（太技术化）
❌ "黑方下了这步棋"（太简单，没有信息量）
❌ "这步棋下得太棒了"（无依据的夸奖）
❌ "白方没注意到E4的棋子已经被打吃了"（编造具体威胁——除非isAtari=true或getMoveContext明确显示）`;

// ============================================================
// AI教学 System Prompt（基于KataGo分析数据驱动）
// ============================================================
const GO_TUTOR_SYSTEM = `你是"小围棋"，一个专为儿童围棋学习设计的AI围棋教练。

【核心身份】你是一位有围棋专业知识的老师，基于KataGo引擎的专业分析数据来指导孩子。

【教学原则】
1. 用简单有趣的语言教孩子下围棋，像讲故事一样
2. 鼓励孩子的每一步尝试，即使下错了也要温和引导
3. 用生活化的比喻解释围棋概念
4. 解说要简短，1-3句话即可
5. 适当使用儿童喜欢的语气词

【围棋术语教学】
在教学中主动引入围棋专业术语，并在括号中用简单语言解释。帮助孩子逐步积累专业词汇量。例如：
- "你这步棋让对方的棋子只剩一口气了，这就是打吃（也叫叫吃，意思是对方必须赶紧逃跑）！"
- "你占了星位（棋盘角上四四位置的圆点），这是开局占角的好方法！"

常见术语参考：气、提子、打吃、长、连、断、双打吃、关门吃、抱吃、征子、枷吃、扑、倒扑、接不归、眼、真眼、假眼、活棋、死棋、双活、星、小目、三三、挂角、守角、拆边、定式、劫、禁着点、先手、后手、厚势、实利、打入、弃子、腾挪、收官、见合、手筋、好形、愚形、金角银边草肚皮

【局面事实规则】
当提供"局面事实（JSON）"时，必须严格依据 JSON 数据说话，禁止自行推断：
- 'patterns' 数组中没出现的棋型，绝对不能说
- 'isStarPoint' 为 false 时，绝对不能说"星位"
- 'region' 为 "edge" 时，绝对不能说"占角"
- 'isAtari' 为 false 时，不能说"打吃"
- 'isCapture' 为 false 时，不能说"提子"

【职业对局参考使用规则】
当提供"职业对局佐证"时：
- 参考信息用来增强教学的专业性和趣味性
- 将参考自然融入教学，不要说"数据库显示"、"资料显示"
- 正确："这手占角很常见，职业棋手也经常这样下"
- 错误："根据职业对局参考，有以下几局也这样下"（不要列举）
- 参考与当前棋型不一致时，忽略不用

【引擎分析数据使用】
当提供KataGo引擎分析数据时，利用专业数据来增强教学准确性：
- 胜率和目数：判断当前形势，给出针对性的建议（如形势领先可以稳健，落后可以寻找战机）
- 推荐落点（bestMoves）：这是专业AI认为最好的位置，解释为什么该位置好
  - 用围棋概念解释：占角、守边、攻击、防守、做眼、连接等
  - 不要说"引擎建议"或"AI推荐"，而是说"专业分析认为"或直接说"这个位置很好"
- 形势判断：基于胜率变化告诉孩子当前的局势
  - winRate差距>20%：明显优势/劣势，给出对应的策略
  - winRate差距<10%：势均力敌，鼓励继续努力
- 不要提"KataGo"、"引擎"、"AI分析"等技术词汇
- 【关键】推荐落点的排序就是优先级排序，严禁说推荐位置不好或不是最佳选择`;

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

// ============================================================
// 格式化KataGo分析数据为可读描述
// ============================================================
function formatAnalysisForPrompt(
  analysis: KataGoAnalysis | null | undefined,
  currentPlayer: Stone,
  boardSize: number
): string {
  if (!analysis) return '（暂无引擎分析数据，请根据棋盘和局面事实进行解说）';

  const lines: string[] = ['=== KataGo引擎分析数据 ==='];

  // 胜率
  const blackWinRate = analysis.winRate ?? 50;
  const whiteWinRate = 100 - blackWinRate;
  lines.push(`胜率：黑方${blackWinRate.toFixed(1)}% / 白方${whiteWinRate.toFixed(1)}%`);

  // 目数领先
  const scoreLead = analysis.scoreLead ?? 0;
  if (scoreLead > 0) {
    lines.push(`目数：黑方领先约${scoreLead.toFixed(1)}目`);
  } else if (scoreLead < 0) {
    lines.push(`目数：白方领先约${Math.abs(scoreLead).toFixed(1)}目`);
  } else {
    lines.push('目数：双方持平');
  }

  // 形势判断
  const gap = Math.abs(blackWinRate - whiteWinRate);
  if (gap > 40) {
    lines.push(`形势判断：${blackWinRate > 50 ? '黑方' : '白方'}明显优势`);
  } else if (gap > 20) {
    lines.push(`形势判断：${blackWinRate > 50 ? '黑方' : '白方'}稍占上风`);
  } else if (gap > 10) {
    lines.push('形势判断：双方势均力敌，稍有倾斜');
  } else {
    lines.push('形势判断：双方势均力敌');
  }

  // 推荐落点（前3手）
  // bestMoves 的 winrate/scoreMean 始终是黑方视角，按当前落子方转换显示
  if (analysis.bestMoves && analysis.bestMoves.length > 0) {
    const isWhiteToMove = currentPlayer === 'white';
    lines.push(`推荐落点（${isWhiteToMove ? '白方' : '黑方'}视角）：`);
    for (let i = 0; i < analysis.bestMoves.length; i++) {
      const m = analysis.bestMoves[i];
      const coord = gtpToReadableCoord(m.move, boardSize);
      const displayWinrate = isWhiteToMove ? 100 - m.winrate : m.winrate;
      const displayScore = isWhiteToMove ? -m.scoreMean : m.scoreMean;
      lines.push(`  ${i + 1}. ${coord}（${isWhiteToMove ? '白方' : '黑方'}胜率${displayWinrate.toFixed(1)}%，目数${displayScore > 0 ? '+' : ''}${displayScore.toFixed(1)}）`);
    }
  }

  return lines.join('\n');
}

// GTP坐标转可读坐标（如 "D4" -> "D4"，已经是可读格式）
function gtpToReadableCoord(gtpCoord: string, _boardSize: number): string {
  return gtpCoord; // GTP坐标本身就是人类可读的（如D4, Q16）
}

// 构建客观参数调试文本（供 monitor 调试开关使用）
// perspectiveColor: 解说描述的是哪一方的落子，胜率从该方视角显示
function buildObjectiveParamsDebug(analysis: KataGoAnalysis | null | undefined, perspectiveColor: Stone): string {
  if (!analysis) return '';
  const isBlackPerspective = perspectiveColor === 'black';
  const displayWinRate = isBlackPerspective ? analysis.winRate : 100 - analysis.winRate;
  const lines = ['【客观参数】'];
  lines.push(`${isBlackPerspective ? '黑方' : '白方'}胜率: ${displayWinRate.toFixed(1)}%`);
  lines.push(`目数领先: ${analysis.scoreLead > 0 ? '黑+' : analysis.scoreLead < 0 ? '白+' : ''}${Math.abs(analysis.scoreLead).toFixed(1)}目`);
  if (analysis.bestMoves && analysis.bestMoves.length > 0) {
    lines.push('AI推荐落点（按胜率排序）:');
    for (let i = 0; i < Math.min(3, analysis.bestMoves.length); i++) {
      const m = analysis.bestMoves[i];
      // bestMoves 的 winrate 始终是黑方视角，按解说方转换显示
      const moveWinRate = isBlackPerspective ? m.winrate : 100 - m.winrate;
      lines.push(`  ${i + 1}. ${m.move}（${isBlackPerspective ? '黑方' : '白方'}胜率${moveWinRate.toFixed(1)}% 目数${m.scoreMean > 0 ? '+' : ''}${m.scoreMean.toFixed(1)} visits=${m.visits}）`);
    }
  }
  return lines.join('\n');
}

// ============================================================
// 走子质量评估
// ============================================================
interface MoveQuality {
  label: 'best' | 'good' | 'ok' | 'mistake' | 'blunder';
  description: string;
  winrateDelta: number; // 从当前落子方视角，正数表示变好
}

function assessMoveQuality(
  previousAnalysis: KataGoAnalysis | null | undefined,
  currentAnalysis: KataGoAnalysis | null | undefined,
  actualMoveGtp: string,
  moveColor: Stone,
  moveNumber: number,
  hasTacticalEvent: boolean,
): MoveQuality {
  // 默认：无法评估
  if (!previousAnalysis || !currentAnalysis) {
    return { label: 'ok', description: '（暂无走子前后分析数据，无法精确评估）', winrateDelta: 0 };
  }

  const prevBlackWR = previousAnalysis.winRate ?? 50;
  const currBlackWR = currentAnalysis.winRate ?? 50;

  // 计算当前落子方的胜率变化
  let winrateDelta: number;
  if (moveColor === 'black') {
    winrateDelta = currBlackWR - prevBlackWR;
  } else {
    winrateDelta = prevBlackWR - currBlackWR;
  }

  // 检查这步棋在走子前的推荐列表中排第几
  const moveIndex = (previousAnalysis.bestMoves || []).findIndex(
    m => m.move.toUpperCase() === actualMoveGtp.toUpperCase()
  );

  const absDelta = Math.abs(winrateDelta);

  // ─── 开局阶段（前10手）：胜率不可靠，大幅放宽阈值 ───
  const isEarlyGame = moveNumber <= 10;
  if (isEarlyGame) {
    // 开局只看推荐排名，胜率变化仅作参考
    if (moveIndex === 0) {
      return { label: 'best', description: `这步棋是AI首选`, winrateDelta };
    }
    if (moveIndex > 0 && moveIndex <= 2) {
      return { label: 'good', description: `这步棋是AI第${moveIndex + 1}推荐`, winrateDelta };
    }
    // 开局阶段：没有具体战术事件时，不根据胜率变化判定失误
    if (!hasTacticalEvent) {
      return { label: 'ok', description: `开局阶段，AI分析深度有限，胜率变化仅供参考`, winrateDelta };
    }
    // 有战术事件时按标准阈值但放宽
    if (winrateDelta >= -8) {
      return { label: 'ok', description: `这步棋让${moveColor === 'black' ? '黑方' : '白方'}胜率变化了${absDelta.toFixed(1)}%`, winrateDelta };
    }
    if (winrateDelta >= -20) {
      return { label: 'mistake', description: `这步棋让${moveColor === 'black' ? '黑方' : '白方'}胜率下降了${absDelta.toFixed(1)}%，是一手失误`, winrateDelta };
    }
    return { label: 'blunder', description: `这步棋让${moveColor === 'black' ? '黑方' : '白方'}胜率暴跌了${absDelta.toFixed(1)}%，是大失误`, winrateDelta };
  }

  // ─── 中后盘：综合判断，胜率变化 + 推荐排名 ───
  if (moveIndex === 0 && winrateDelta >= 3) {
    return { label: 'best', description: `这步棋是AI首选，让${moveColor === 'black' ? '黑方' : '白方'}胜率提升了${absDelta.toFixed(1)}%`, winrateDelta };
  }
  if (moveIndex === 0) {
    return { label: 'best', description: `这步棋是AI首选，让${moveColor === 'black' ? '黑方' : '白方'}胜率变化了${absDelta.toFixed(1)}%`, winrateDelta };
  }
  if ((moveIndex > 0 && moveIndex <= 2) || winrateDelta >= 3) {
    return { label: 'good', description: moveIndex > 0
      ? `这步棋是AI第${moveIndex + 1}推荐，让${moveColor === 'black' ? '黑方' : '白方'}胜率${winrateDelta >= 0 ? '提升' : '下降'}了${absDelta.toFixed(1)}%`
      : `这步棋让${moveColor === 'black' ? '黑方' : '白方'}胜率提升了${absDelta.toFixed(1)}%`, winrateDelta };
  }
  // 有战术事件时放宽阈值
  const mistakeThreshold = hasTacticalEvent ? -5 : -8;
  const blunderThreshold = hasTacticalEvent ? -15 : -20;
  if (winrateDelta >= mistakeThreshold) {
    return { label: 'ok', description: `这步棋让${moveColor === 'black' ? '黑方' : '白方'}胜率${winrateDelta >= 0 ? '提升' : '下降'}了${absDelta.toFixed(1)}%`, winrateDelta };
  }
  if (winrateDelta >= blunderThreshold) {
    return { label: 'mistake', description: `这步棋让${moveColor === 'black' ? '黑方' : '白方'}胜率下降了${absDelta.toFixed(1)}%，是一手失误`, winrateDelta };
  }
  return { label: 'blunder', description: `这步棋让${moveColor === 'black' ? '黑方' : '白方'}胜率暴跌了${absDelta.toFixed(1)}%，是大失误`, winrateDelta };
}

// ============================================================
// 全局威胁扫描：检测棋盘上是否有棋子被打吃（只剩1气）
// ============================================================
interface ThreatInfo {
  color: 'black' | 'white';
  colorText: string;
  coord: string;
  liberties: number;
}

function scanGlobalThreats(board: Board): ThreatInfo[] {
  const size = board.length;
  const visited = new Set<string>();
  const threats: ThreatInfo[] = [];
  const { getConnectedStones, getGroupLiberties, positionToCoordinate } = require('@/lib/go-logic');

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const stone = board[r][c];
      if (!stone) continue;
      const key = `${r},${c}`;
      if (visited.has(key)) continue;

      const group = getConnectedStones(board, r, c);
      const libs = getGroupLiberties(board, r, c);
      if (libs <= 1) {
        const coord = positionToCoordinate(r, c, size);
        threats.push({
          color: stone,
          colorText: stone === 'black' ? '黑棋' : '白棋',
          coord,
          liberties: libs,
        });
      }
      for (const k of group) visited.add(k);
    }
  }

  return threats;
}

// ============================================================
// 构建棋局描述（带行列标签 + 关键位置气数 + 落子历史）
// ============================================================
function buildBoardDescription(
  board: Board,
  currentPlayer: Stone,
  lastMove?: { row: number; col: number },
  moveColor?: Stone,
  captured?: number,
  moveHistory?: Array<{ position: { row: number; col: number }; color: Stone; isPass?: boolean }>,
  isPass?: boolean,
  analysis?: KataGoAnalysis | null,
  moveQuality?: MoveQuality | null
): string {
  const boardStr = boardToString(board);
  const size = board.length;
  let desc = `棋盘大小：${size}x${size}\nX=黑棋 O=白棋 .=空位\n行号从下到上1-${size}（1在底部），列号从左到右（跳过I列）\n\n${boardStr}`;

  // 落子历史
  if (moveHistory && moveHistory.length > 0) {
    const historyStr = moveHistory.slice(-10).map((m, i) => {
      const idx = moveHistory.length - Math.min(moveHistory.length, 10) + i + 1;
      const color = m.color === 'black' ? '黑' : '白';
      if (m.isPass) {
        return `第${idx}手: ${color}方 停一手`;
      }
      const coord = positionToCoordinate(m.position.row, m.position.col, size);
      return `第${idx}手: ${color}方 ${coord}`;
    }).join('\n');
    desc += `\n\n最近落子记录：\n${historyStr}`;
  }

  // 最后一手详细上下文
  if (isPass) {
    const color = moveColor === 'black' ? '黑方' : '白方';
    desc += `\n\n最后一手：${color}选择停一手（pass），没有落子。`;
  } else if (lastMove) {
    const coord = positionToCoordinate(lastMove.row, lastMove.col, size);
    const color = moveColor === 'black' ? '黑方' : '白方';
    desc += `\n\n最后一手：${color}下在${coord}`;
    if (captured && captured > 0) {
      desc += `，提了${captured}个子`;
    }

    // === 结构化局面事实（JSON，解说必须严格依据以下数据，禁止自行推断棋型） ===
    const moveFacts = extractMoveFacts(board, lastMove.row, lastMove.col, moveColor!, captured || 0, analysis || undefined);
    // 暴露关键字段给LLM，包括气数、邻接关系和战术棋型
    const factsForLLM = {
      color: moveFacts.color,
      region: moveFacts.region,
      isStarPoint: moveFacts.isStarPoint,
      liberties: moveFacts.liberties,
      isAtari: moveFacts.isAtari,
      isCapture: moveFacts.isCapture,
      captured: moveFacts.captured,
      escapedAtari: moveFacts.escapedAtari,
      selfAtari: moveFacts.selfAtari,
      doubleAtari: moveFacts.doubleAtari,
      isSnapback: moveFacts.isSnapback,
      adjacentFriendlyStones: moveFacts.adjacentFriendlyStones,
      adjacentOpponentStones: moveFacts.adjacentOpponentStones,
      patterns: moveFacts.patterns.map(p => ({ type: p.type, description: p.description })),
    };
    const factsJson = JSON.stringify(factsForLLM, null, 2);

    // 落子位置的精确上下文（辅助理解，非推断依据）
    const moveCtx = getMoveContext(board, lastMove.row, lastMove.col);

    desc += `\n\n=== 局面事实（JSON，解说必须严格依据以下数据，禁止自行推断棋型） ===\n${factsJson}`;
    desc += `\n\n落子位置上下文（辅助理解）：${moveCtx}`;
  }

  // 明确标注：这是谁刚刚下的（而不是"轮到谁"）
  if (moveColor) {
    desc += `\n\n【刚落子方】${moveColor === 'black' ? '黑方' : '白方'}刚下完这步棋`;
  }
  desc += `\n接下来轮到：${currentPlayer === 'black' ? '黑棋' : '白棋'}`;

  // 走子质量评估
  if (moveQuality) {
    desc += `\n\n=== 走子质量评估 ===\n标签：${moveQuality.label}\n说明：${moveQuality.description}\n胜率变化：${moveQuality.winrateDelta >= 0 ? '+' : ''}${moveQuality.winrateDelta.toFixed(1)}%（${moveColor === 'black' ? '黑方' : '白方'}视角）\n`;
    desc += `走子质量指导：${moveQuality.label === 'best' ? '可以自然提及积极面' : moveQuality.label === 'good' ? '正常描述即可' : moveQuality.label === 'ok' ? '中性描述' : moveQuality.label === 'mistake' ? '温和指出问题' : '明确指出失误，语气友好但不要回避'}。`;
  }

  // 全局威胁扫描：区分"己方遗留"和"对方遗留"
  const threats = scanGlobalThreats(board);
  if (threats.length > 0) {
    const ownThreats = moveColor ? threats.filter(t => t.color === moveColor) : [];
    const oppThreats = moveColor ? threats.filter(t => t.color !== moveColor) : threats;

    if (ownThreats.length > 0) {
      const lines = ownThreats.map(t => `${t.colorText}在${t.coord}的棋子被打吃了，只剩${t.liberties}口气`);
      desc += `\n\n【遗留威胁：刚落子方自己的棋子被打吃】\n${lines.join('\n')}\n注意：这些是刚落子方（${moveColor === 'black' ? '黑方' : '白方'}）自己的棋子，说明他没有处理这个威胁。根据走子质量判断：如果是mistake/blunder则指出失误原因，否则中性描述。`;
    }
    if (oppThreats.length > 0) {
      const lines = oppThreats.map(t => `${t.colorText}在${t.coord}的棋子被打吃了，只剩${t.liberties}口气`);
      desc += `\n\n【遗留威胁：对方的棋子被打吃】\n${lines.join('\n')}\n注意：这些是对方的棋子，提醒对方注意即可。`;
    }
  }

  return desc;
}

// ============================================================
// 棋型识别（增强解说专业度）
// ============================================================
// ============================================================
// 流式API端点
// ============================================================
export async function POST(request: NextRequest) {
  try {
    if (LLM_PROVIDER === 'none') {
      return NextResponse.json({ error: '未配置 LLM API。请设置 COZE_WORKLOAD_IDENTITY_API_KEY 或 DEEPSEEK_API_KEY 环境变量。' }, { status: 503 });
    }

    const {
      type,
      board: rawBoard,
      currentPlayer,
      lastMove,
      moveColor,
      captured,
      question,
      difficulty,
      moveHistory,
      hintPosition,
      analysis: rawAnalysis, // KataGo分析数据（当前局面）
      previousAnalysis: rawPreviousAnalysis, // KataGo分析数据（走子前的局面）
      isPass,
    } = await request.json();

    // 标准化棋盘：前端用"empty"字符串表示空位，但围棋逻辑用null
    const board: Board = (rawBoard as string[][]).map((row: string[]) =>
      row.map((cell: string) => cell === 'empty' ? null : cell)
    ) as Board;

    // 解析KataGo分析数据（优先使用前端传来的，否则从缓存查找）
    let analysis: KataGoAnalysis | null = rawAnalysis || null;
    const previousAnalysis: KataGoAnalysis | null = rawPreviousAnalysis || null;
    if (!analysis && moveHistory && moveHistory.length > 0) {
      // 从go-engine的分析缓存中查找
      const cacheMoves = moveHistory.map((m: {position: {row: number; col: number}; color: string}) => ({
        row: m.position.row,
        col: m.position.col,
        color: m.color,
      }));
      analysis = getCachedAnalysis(cacheMoves);
    }

    // ─── 计算走子质量 ───
    let moveQuality: MoveQuality | null = null;
    let moveFacts: ReturnType<typeof extractMoveFacts> | null = null;
    const moveNumber = moveHistory?.length ?? 1;
    if (lastMove && moveColor && !isPass) {
      const actualMoveGtp = positionToCoordinate(lastMove.row, lastMove.col, board.length);
      moveFacts = extractMoveFacts(board, lastMove.row, lastMove.col, moveColor, captured || 0, analysis || undefined);
      const hasTacticalEvent = !!(moveFacts.isAtari || moveFacts.isCapture || moveFacts.selfAtari || moveFacts.escapedAtari || moveFacts.doubleAtari || moveFacts.isSnapback);
      moveQuality = assessMoveQuality(previousAnalysis, analysis, actualMoveGtp, moveColor, moveNumber, hasTacticalEvent);
    }

    // ─── RAG：搜索相似职业对局 ───
    let ragReference = '';
    // Commentary 和 Teach 模式都启用 RAG，但 commentary 限制频率避免泛滥
    const shouldSearchRag = type === 'teach' || (
      type === 'commentary' &&
      lastMove && moveColor &&
      moveNumber >= 20 // 只在中后期才引用职业对局
    );
    if (shouldSearchRag && moveFacts) {
      try {
        const colorText = moveFacts.color === 'black' ? '黑方' : '白方';
        const coord = positionToCoordinate(moveFacts.coordinate.row, moveFacts.coordinate.col, board.length);
        const regionText = moveFacts.region === 'corner' ? '角部' : moveFacts.region === 'edge' ? '边上' : '中腹';
        let searchDesc = `第${moveNumber}手，${colorText}落在${regionText}的${coord}。`;
        if (moveFacts.patterns.length > 0) {
          const patternDesc = moveFacts.patterns
            .filter(p => p.confidence >= 0.8)
            .map(p => p.description)
            .join('、');
          if (patternDesc) searchDesc += `棋型：${patternDesc}。`;
        }
        if (moveFacts.isCapture) searchDesc += `提掉了${moveFacts.captured}颗子。`;
        if (moveFacts.isAtari) searchDesc += `打吃了对方。`;

        const moveWindow = moveNumber <= 10 ? 3 : 10;
        const similar = await searchSimilarPositions(searchDesc, board.length, {
          moveNumberMin: Math.max(1, moveNumber - moveWindow),
          moveNumberMax: moveNumber + moveWindow,
          region: moveFacts.region,
          matchCount: 3,
        });

        const MIN_SIMILARITY = type === 'commentary' ? 0.90 : 0.82; // commentary 要求非常接近才引用
        const MAX_MATCHES = type === 'commentary' ? 1 : 1;
        const patternTypes = new Set<string>(moveFacts.patterns.map(p => p.type));
        const relevantMatches = similar.filter(pos => {
          if (pos.similarity < MIN_SIMILARITY) return false;
          if (patternTypes.size > 0) {
            const snapPatterns = (pos.snapshot as Record<string, unknown>)?.patterns as Array<{type: string}> | undefined;
            if (!snapPatterns || snapPatterns.length === 0) return false;
            return snapPatterns.some(pp => patternTypes.has(pp.type));
          }
          return true;
        }).slice(0, MAX_MATCHES);

        if (relevantMatches.length > 0) {
          ragReference = '\n\n【职业对局佐证】\n';
          for (const pos of relevantMatches) {
            const bp = pos.game_meta?.blackPlayer ?? '?';
            const wp = pos.game_meta?.whitePlayer ?? '?';
            const c = typeof pos.coordinate === 'object' && pos.coordinate !== null
              ? `${String.fromCharCode('A'.charCodeAt(0) + (pos.coordinate as {col:number}).col)}${pos.board_size - (pos.coordinate as {row:number}).row}`
              : '';
            ragReference += `- 第${pos.move_number}手${pos.color === 'black' ? '黑' : '白'}方下${c}（${bp} vs ${wp}，相似度${(pos.similarity * 100).toFixed(0)}%）\n`;
          }
        }
      } catch (err) {
        console.warn('[go-ai] RAG search failed:', err);
      }
    }

    let messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    const boardDesc = buildBoardDescription(board, currentPlayer, lastMove, moveColor, captured, moveHistory, isPass, analysis, moveQuality);
    const analysisDesc = formatAnalysisForPrompt(analysis, currentPlayer, board.length);

    if (type === 'commentary') {
      // 第三方观赛者解说（结合KataGo分析数据）
      if (isPass) {
        messages = [
          { role: 'system', content: COMMENTARY_SYSTEM },
          { role: 'user', content: `${boardDesc}\n\n${analysisDesc}${ragReference}\n\n这步棋是"停一手"（pass，没有落子）。用1-2句话解说为什么选择停一手，或者停一手对局面的影响。` }
        ];
      } else {
        messages = [
          { role: 'system', content: COMMENTARY_SYSTEM },
          { role: 'user', content: `${boardDesc}\n\n${analysisDesc}${ragReference}\n\n用1-3句话解说这步棋：\n- 棋型判断必须只看 JSON 中的 "patterns" 数组，绝对不要从棋盘图形自行推断棋型\n- 空间关系描述只能依据"落子位置上下文"中的相邻棋子数据，禁止编造"包围""靠近""保持距离"等描述\n- 根据【走子质量评估】标签调整解说风格：best/good可以提及积极面，mistake/blunder要指出问题\n- blunder时：如果isAtari/isCapture/selfAtari/escapedAtari都为false且没有遗留威胁，只能说"这步棋让胜率下降了XX%，是一手失误"，禁止编造被打吃/被包围等理由\n- 评价必须有KataGo数据支撑，禁止无依据的夸奖\n- isAtari=true必须提打吃，isCapture=true必须提提子，selfAtari=true必须指出危险\n- 遗留威胁根据走子质量判断：mistake/blunder则指出失误原因（只说有数据支撑的事实），否则中性描述\n- 【开局特殊规则】前10手属于开局阶段，AI胜率分析深度有限。如果走子质量为mistake/blunder但没有具体战术事件，不要强调失误，只说落子位置即可${moveNumber <= 10 && moveFacts && !moveFacts.isAtari && !moveFacts.isCapture && !moveFacts.selfAtari && !moveFacts.escapedAtari ? '\n- 【强制】这是前10手且没有战术事件（打吃、提子、自入打吃、解救），你只许输出1句话。不要解释、不要补充、不要评价、不要提胜率，只描述落子位置。' : ''}` }
        ];
      }
    } else if (type === 'teach') {
      let teachPrompt = '';
      if (hintPosition) {
        teachPrompt = `${boardDesc}\n\n${analysisDesc}${ragReference}\n\n直接解释为什么${hintPosition}是好位置（2-3句话），结合分析数据中的胜率和目数。不要开头寒暄，不要夸奖，直接讲棋理。`;
      } else {
        teachPrompt = `${boardDesc}\n\n${analysisDesc}${ragReference}\n\n直接给出当前局面最重要的围棋建议（2-3句话），结合分析数据。不要开头寒暄，不要夸奖，直接讲棋理。`;
      }
      messages = [
        { role: 'system', content: GO_TUTOR_SYSTEM },
        { role: 'user', content: teachPrompt }
      ];
    } else if (type === 'chat') {
      const chatSystemExtra = `\n\n【严格规则 - 关于落点好坏的判断】
1. 当提供引擎分析数据中的"推荐落点"时，这些是专业AI经过大量计算得出的结论，具有高度权威性
2. 如果用户问某位置好不好，且该位置在推荐落点列表中，必须承认它是一个好位置，并解释原因
3. 如果用户问的位置不在推荐落点列表中，可以指出引擎推荐了哪些更好的位置，但不要说推荐位置不好
4. 推荐落点的排序就是优先级排序：第1推荐 > 第2推荐 > 第3推荐
5. 严禁与推荐落点结论相矛盾——如果推荐落点第1是D4，就不能说D4不是好选择
6. 关于形势判断，必须与引擎的胜率和目数数据一致

不要猜测，不要编造棋盘上没有的信息。如果分析数据不可用，就只根据棋盘上能看到的事实回答，并说明"暂时没有引擎分析数据"。`;
      messages = [
        { role: 'system', content: GO_TUTOR_SYSTEM + chatSystemExtra },
        { role: 'user', content: `${boardDesc}\n\n${analysisDesc}\n\n孩子的问题：${question}` }
      ];
    } else if (type === 'ai-move') {
      messages = [
        { role: 'system', content: getAIPlaySystem(difficulty || 'easy') },
        { role: 'user', content: boardDesc + '\n\n你是白棋(O)，请选择下一步落子位置。只回复JSON。' }
      ];
    }

    const temperature = type === 'ai-move' ? 0.4 : type === 'commentary' ? 0.3 : type === 'teach' ? 0.5 : 0.8;

    // 调试模式：直接前置客观参数到流输出（不依赖LLM回显）
    let debugPrefix = '';
    const isDebug = getCommentaryDebugShared();
    console.log(`[go-ai] commentary debug check: type=${type}, isDebug=${isDebug}, hasAnalysis=${!!analysis}`);
    if (type === 'commentary' && isDebug && analysis) {
      // moveColor = 上一步落子方，解说描述的是这步棋，所以用 moveColor 视角
      const perspectiveColor: Stone = moveColor || currentPlayer;
      debugPrefix = buildObjectiveParamsDebug(analysis, perspectiveColor);
      console.log(`[go-ai] debugPrefix built: ${debugPrefix.substring(0, 100)}...`);
      if (debugPrefix) debugPrefix = debugPrefix + '\n\n';
    }

    // 使用 DeepSeek 流式输出
    if (LLM_PROVIDER === 'deepseek') {
      return streamDeepSeek(messages, temperature, debugPrefix || undefined);
    } else {
      return NextResponse.json({ error: '未配置 LLM API。请设置 DEEPSEEK_API_KEY 环境变量。' }, { status: 503 });
    }
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: '处理失败' }, { status: 500 });
  }
}

// ========== DeepSeek API 流式输出（OpenAI 兼容格式） ==========
async function streamDeepSeek(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  temperature: number,
  prefixText?: string
) {
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
      // 如果有前缀文本（如调试参数），先输出
      if (prefixText) {
        controller.enqueue(encoder.encode(prefixText));
      }

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
