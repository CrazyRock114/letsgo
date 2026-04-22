/**
 * AI测试直播后台Worker
 * 常驻进程，驱动AI对弈棋局，所有前端 spectator 页面共享同一盘棋
 */

// 加载环境变量（.env.local）
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config({ path: '.env.local' });
} catch {
  // dotenv not available, rely on existing env
}

import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  createEmptyBoard,
  playMove,
  getValidMoves,
  easyAIMove,
  mediumAIMove,
  hardAIMove,
  checkGameEnd,
  calculateFinalScore,
  getKomi,
  type Stone,
  type Board,
  type Position,
} from '@/lib/go-logic';

// ========== 类型 ==========
interface SpectatorConfig {
  boardSize: 9 | 13 | 19;
  stepInterval: number;
  winRateEndCondition: number;
  aiPlayer: {
    color: 'black' | 'white';
    analysisSeconds: number;
  };
  opponent: {
    engine: 'katago' | 'gnugo' | 'local';
    difficulty: 'easy' | 'medium' | 'hard';
  };
}

interface MoveEntry {
  position: { row: number; col: number };
  color: Stone;
  captured: number;
  analysis?: {
    winRate: number;
    scoreLead: number;
    actualVisits: number;
    bestMoves: Array<{ move: string; winrate: number; scoreMean: number; visits: number }>;
    analysisSeconds: number;
    timestamp: string;
  };
}

// ========== 常量 ==========
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';
const PORT = parseInt(process.env.PORT || '5001', 10);
const BASE_URL = `http://localhost:${PORT}`;
const WORKER_USER_ID = 0;

// ========== 内部状态 ==========
let timer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;
let currentGameId: number | null = null;

// ========== 工具函数 ==========

function getSupabase() {
  return getSupabaseClient();
}

async function fetchInternal(path: string, body: unknown): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  console.log(`[ai-test-worker] fetchInternal → ${url}`, JSON.stringify(body).slice(0, 200));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': INTERNAL_KEY,
    },
    body: JSON.stringify(body),
  });
  console.log(`[ai-test-worker] fetchInternal ← ${url} status=${res.status}`);
  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown error');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  console.log(`[ai-test-worker] fetchInternal ← ${url} body=`, JSON.stringify(json).slice(0, 300));
  return json;
}

function coordinateToPosition(coord: string, boardSize: number): { row: number; col: number } | null {
  if (!coord || coord.length < 2) return null;
  const colChar = coord[0].toUpperCase();
  const rowNum = parseInt(coord.slice(1));
  if (isNaN(rowNum)) return null;
  let col = colChar.charCodeAt(0) - 65;
  if (colChar >= 'J') col--;
  if (col < 0 || col >= boardSize) return null;
  const row = boardSize - rowNum;
  if (row < 0 || row >= boardSize) return null;
  return { row, col };
}

function boardToMoves(board: Board): MoveEntry[] {
  // 这个函数不会被用到，moves 是从数据库读取的
  return [];
}

function rebuildBoard(size: number, moves: MoveEntry[]): Board {
  let board = createEmptyBoard(size);
  for (const move of moves) {
    const result = playMove(board, move.position.row, move.position.col, move.color);
    board = result.newBoard;
  }
  return board;
}

// ========== 核心对弈逻辑 ==========

async function makeAIPlayerMove(
  boardSize: number,
  moves: MoveEntry[],
  analysisSeconds: number
): Promise<{ move: MoveEntry; board: Board } | null> {
  const movesForEngine = moves.map(m => ({
    row: m.position.row,
    col: m.position.col,
    color: m.color as 'black' | 'white',
  }));

  const data = await fetchInternal('/api/go-engine', {
    action: 'analyze',
    boardSize,
    moves: movesForEngine,
    isAITest: true,
    analysisSeconds,
  }) as { analysis?: { winRate: number; scoreLead: number; actualVisits?: number; bestMoves: Array<{ move: string; winrate: number; scoreMean: number; visits?: number }> } | null; error?: string };

  if (!data.analysis) {
    throw new Error(`AI player analyze failed: ${data.error || 'no analysis returned'}`);
  }
  if (!data.analysis.bestMoves || data.analysis.bestMoves.length === 0) {
    throw new Error('AI player analyze returned empty bestMoves');
  }

  const best = data.analysis.bestMoves[0];
  if (best.move === 'pass') {
    console.log('[ai-test-worker] AI player passes');
    return null;
  }

  const pos = coordinateToPosition(best.move, boardSize);
  if (!pos) {
    throw new Error(`Invalid best move coordinate: ${best.move}`);
  }

  const board = rebuildBoard(boardSize, moves);
  if (board[pos.row][pos.col] !== null) {
    throw new Error(`AI player recommended occupied point: ${best.move} (already ${board[pos.row][pos.col]})`);
  }
  const color: Stone = moves.length % 2 === 0 ? 'black' : 'white';
  const result = playMove(board, pos.row, pos.col, color);

  const analysisSnapshot = {
    winRate: data.analysis.winRate,
    scoreLead: data.analysis.scoreLead,
    actualVisits: data.analysis.actualVisits ?? 0,
    bestMoves: data.analysis.bestMoves.slice(0, 5).map(m => ({
      move: m.move,
      winrate: m.winrate,
      scoreMean: m.scoreMean,
      visits: m.visits ?? 0,
    })),
    analysisSeconds,
    timestamp: new Date().toISOString(),
  };

  const moveEntry: MoveEntry = {
    position: pos,
    color,
    captured: result.captured,
    analysis: analysisSnapshot,
  };

  return { move: moveEntry, board: result.newBoard };
}

async function makeOpponentMove(
  boardSize: number,
  moves: MoveEntry[],
  engine: string,
  difficulty: string,
  aiColor: 'black' | 'white'
): Promise<{ move: MoveEntry; board: Board } | null> {
  // Local AI
  if (engine === 'local') {
    const board = rebuildBoard(boardSize, moves);
    const color: Stone = moves.length % 2 === 0 ? 'black' : 'white';
    let pos: Position | null = null;
    if (difficulty === 'easy') pos = easyAIMove(board, color);
    else if (difficulty === 'medium') pos = mediumAIMove(board, color);
    else pos = hardAIMove(board, color);

    if (!pos) {
      console.log('[ai-test-worker] Local AI passes');
      return null;
    }

    const result = playMove(board, pos.row, pos.col, color);
    const moveEntry: MoveEntry = {
      position: pos,
      color,
      captured: result.captured,
    };
    return { move: moveEntry, board: result.newBoard };
  }

  // KataGo / GnuGo via API
  const movesForEngine = moves.map(m => ({
    row: m.position.row,
    col: m.position.col,
    color: m.color,
  }));

  const data = await fetchInternal('/api/go-engine', {
    boardSize,
    moves: movesForEngine,
    difficulty,
    engine,
    aiColor,
    isAutoRun: true,
  }) as { move?: { row: number; col: number } | null; pass?: boolean; resign?: boolean; engine?: string; engineError?: boolean; errorDetail?: string };

  if (data.engineError) {
    throw new Error(`Opponent engine error: ${data.errorDetail || 'unknown'}`);
  }
  if (data.pass) {
    console.log('[ai-test-worker] Opponent passes');
    return null;
  }
  if (data.resign) {
    console.log('[ai-test-worker] Opponent resigns');
    return null;
  }
  if (!data.move) {
    throw new Error('Opponent returned no move and no pass/resign flag');
  }

  const pos = data.move;
  const board = rebuildBoard(boardSize, moves);
  if (board[pos.row][pos.col] !== null) {
    throw new Error(`Opponent recommended occupied point: (${pos.row},${pos.col}) already ${board[pos.row][pos.col]}`);
  }
  const color: Stone = moves.length % 2 === 0 ? 'black' : 'white';
  const result = playMove(board, pos.row, pos.col, color);

  const moveEntry: MoveEntry = {
    position: pos,
    color,
    captured: result.captured,
  };

  return { move: moveEntry, board: result.newBoard };
}

async function saveGame(
  gameId: number,
  moves: MoveEntry[],
  board: Board,
  status: 'running' | 'paused' | 'finished',
  title: string,
  commentaries?: Record<string, unknown>[]
): Promise<void> {
  const supabase = getSupabase();
  const scores = calculateFinalScore(board);
  const update: Record<string, unknown> = {
    moves: moves as unknown as Record<string, unknown>[],
    final_board: board as unknown as Record<string, unknown>[],
    black_score: scores.black,
    white_score: scores.white,
    status,
    title,
    updated_at: new Date().toISOString(),
  };
  if (commentaries !== undefined) {
    update.commentaries = commentaries;
  }
  await supabase
    .from('letsgo_games')
    .update(update)
    .eq('id', gameId);
}

// ========== 主循环 ==========

async function tick(): Promise<void> {
  console.log(`[ai-test-worker] tick() running=${isRunning} gameId=${currentGameId}`);
  if (!isRunning || !currentGameId) {
    console.log('[ai-test-worker] tick() aborted: not running or no gameId');
    return;
  }

  // 更新心跳，防止其他实例抢占领导权
  await updateHeartbeat().catch(() => { /* ignore */ });

  const supabase = getSupabase();

  // 重新加载棋局
  const { data: game, error } = await supabase
    .from('letsgo_games')
    .select('id, status, moves, board_size, config, commentaries')
    .eq('id', currentGameId)
    .single();

  if (error || !game) {
    console.warn('[ai-test-worker] Game not found, stopping');
    stop();
    return;
  }

  if (game.status !== 'running') {
    // 棋局被暂停或结束，等待恢复
    return;
  }

  const config = (game.config as SpectatorConfig | null) || {
    boardSize: 9,
    stepInterval: 15000,
    winRateEndCondition: 99,
    aiPlayer: { color: 'black', analysisSeconds: 5 },
    opponent: { engine: 'katago', difficulty: 'medium' },
  };

  const boardSize = game.board_size as 9 | 13 | 19;
  const moves = (game.moves as MoveEntry[] | null) || [];
  const existingCommentaries = (game.commentaries as Array<Record<string, unknown>> | null) || [];

  // 确定当前轮到谁
  const currentColor: Stone = moves.length % 2 === 0 ? 'black' : 'white';
  const isAIPlayerTurn = currentColor === config.aiPlayer.color;

  let result: { move: MoveEntry; board: Board } | null = null;

  try {
    if (isAIPlayerTurn) {
      console.log(`[ai-test-worker] AI player (${config.aiPlayer.color}) move #${moves.length + 1}`);
      result = await makeAIPlayerMove(boardSize, moves, config.aiPlayer.analysisSeconds);
    } else {
      console.log(`[ai-test-worker] Opponent (${config.opponent.engine}) move #${moves.length + 1}`);
      result = await makeOpponentMove(
        boardSize,
        moves,
        config.opponent.engine,
        config.opponent.difficulty,
        config.aiPlayer.color === 'black' ? 'white' : 'black'
      );
    }
  } catch (err) {
    console.error('[ai-test-worker] Move error:', err instanceof Error ? err.message : String(err));
    // 出错后等待一段时间再重试
    scheduleNext(config.stepInterval + 5000);
    return;
  }

  if (!result) {
    // 某一方 pass，结束棋局
    const board = rebuildBoard(boardSize, moves);
    const scores = calculateFinalScore(board);
    const passCommentary = buildPassCommentary(moves.length, currentColor, config, isAIPlayerTurn);
    await saveGame(currentGameId, moves, board, 'finished', configTitle(config), [...existingCommentaries, passCommentary]);
    console.log('[ai-test-worker] Game finished (pass)');
    await autoRestart(config);
    return;
  }

  const newMoves = [...moves, result.move];
  const newBoard = result.board;

  // 构建解说日志
  const moveCommentary = buildMoveCommentary(newMoves.length, result.move, config, isAIPlayerTurn, boardSize, newBoard);
  const newCommentaries = [...existingCommentaries, moveCommentary];

  // 检查胜率结束条件（需 analyze 数据 + 最少步数 + 目差 ≥ 2，避免开局误触发）
  const minMovesForWinRateCheck = boardSize <= 9 ? 40 : boardSize <= 13 ? 80 : 300;
  if (isAIPlayerTurn && result.move.analysis && newMoves.length >= minMovesForWinRateCheck) {
    const winRate = result.move.analysis.winRate;
    const threshold = config.winRateEndCondition;
    // winRate 是黑方胜率，如果 AI 玩家执白，需要换算
    const aiWinRate = config.aiPlayer.color === 'black' ? winRate : 100 - winRate;
    if (aiWinRate >= threshold) {
      const scores = calculateFinalScore(newBoard);
      const aiIsWinner = scores.winner === config.aiPlayer.color;
      const margin = Math.abs(scores.black - scores.white);
      if (aiIsWinner && margin >= 2) {
        const endCommentary = buildEndCommentary(scores, `AI胜率${aiWinRate.toFixed(1)}%且目差+${margin.toFixed(1)}目，达到结束条件`);
        await saveGame(currentGameId, newMoves, newBoard, 'finished', configTitle(config), [...newCommentaries, endCommentary]);
        console.log(`[ai-test-worker] Game finished: AI win rate ${aiWinRate.toFixed(1)}% >= ${threshold}%, margin=${margin.toFixed(1)} >= 2`);
        await autoRestart(config);
        return;
      }
      console.log(`[ai-test-worker] Win rate ${aiWinRate.toFixed(1)}% >= ${threshold}% but margin=${margin.toFixed(1)} < 2 or AI not winner (${scores.winner}), continuing`);
    }
  }

  // 保存
  await saveGame(currentGameId, newMoves, newBoard, 'running', configTitle(config), newCommentaries);

  // 检查常规结束条件（连续 pass 等）
  const gameEnd = checkGameEnd(newBoard, 0, newMoves.length);
  if (gameEnd.ended) {
    const scores = calculateFinalScore(newBoard);
    const endCommentary = buildEndCommentary(scores, gameEnd.reason || '棋局结束');
    await saveGame(currentGameId, newMoves, newBoard, 'finished', configTitle(config), [...newCommentaries, endCommentary]);
    console.log('[ai-test-worker] Game finished:', gameEnd.reason);
    await autoRestart(config);
    return;
  }

  // 安排下一步
  scheduleNext(config.stepInterval);
}

async function autoRestart(config: SpectatorConfig): Promise<void> {
  // 防止 endGame() 被调用后仍然触发自动重启
  if (!isRunning || !currentGameId) {
    console.log('[ai-test-worker] Auto-restart skipped: worker stopped or game cleared');
    return;
  }
  console.log('[ai-test-worker] Auto-restarting with same config...');
  const result = await createGame(config);
  if (!result.success) {
    console.error('[ai-test-worker] Auto-restart failed:', result.error);
    currentGameId = null;
    isRunning = false;
    return;
  }
  console.log(`[ai-test-worker] Auto-restarted game ${result.gameId}`);
}

function scheduleNext(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    tick().catch(err => {
      console.error('[ai-test-worker] Tick error:', err instanceof Error ? err.message : String(err));
    });
  }, delay);
}

function configTitle(config: SpectatorConfig): string {
  return `${config.boardSize}路 AI对战 ${config.aiPlayer.color === 'black' ? 'AI黑' : 'AI白'}(分析${config.aiPlayer.analysisSeconds}s) vs ${config.opponent.engine}(${config.opponent.difficulty})`;
}

function positionToCoord(pos: { row: number; col: number }, boardSize: number): string {
  const colChar = 'ABCDEFGHJKLMNOPQRST'[pos.col];
  if (!colChar) return '??';
  return `${colChar}${boardSize - pos.row}`;
}

function buildMoveCommentary(
  moveIndex: number,
  move: MoveEntry,
  config: SpectatorConfig,
  isAIPlayer: boolean,
  boardSize: number,
  board: Board
): Record<string, unknown> {
  const coord = positionToCoord(move.position, boardSize);
  const color = move.color;
  let text: string;
  if (isAIPlayer && move.analysis) {
    const a = move.analysis;
    let scoreLead = a.scoreLead;
    // 模型目差为0时，用当前棋盘静态估算的实际目差（含贴目）作为fallback
    if (scoreLead === 0) {
      const actual = calculateFinalScore(board);
      scoreLead = actual.black - actual.white;
    }
    const topMoves = a.bestMoves.slice(0, 3).map(m => `${m.move}(${m.winrate.toFixed(1)}%,${m.visits}v)`).join(', ');
    text = `第${moveIndex}手 ${color === 'black' ? '黑' : '白'} ${coord} | AI玩家(${config.aiPlayer.analysisSeconds === 0 ? 'kata-raw-nn瞬时' : config.aiPlayer.analysisSeconds + '秒分析'}) | 胜率${a.winRate.toFixed(1)}% | 目差${scoreLead >= 0 ? '+' : ''}${scoreLead.toFixed(1)} | visits:${a.actualVisits} | 推荐:${topMoves}`;
  } else {
    const who = isAIPlayer ? 'AI玩家' : `对手(${config.opponent.engine}/${config.opponent.difficulty})`;
    text = `第${moveIndex}手 ${color === 'black' ? '黑' : '白'} ${coord} | ${who}落子`;
  }
  return {
    moveIndex: moveIndex - 1,
    color,
    position: move.position,
    commentary: text,
  };
}

function buildPassCommentary(
  moveIndex: number,
  color: Stone,
  config: SpectatorConfig,
  isAIPlayer: boolean
): Record<string, unknown> {
  const who = isAIPlayer ? 'AI玩家' : `对手(${config.opponent.engine})`;
  return {
    moveIndex,
    color,
    position: { row: -1, col: -1 },
    commentary: `第${moveIndex + 1}手 ${color === 'black' ? '黑' : '白'} 停一手(Pass) | ${who}`,
  };
}

function buildEndCommentary(scores: ReturnType<typeof calculateFinalScore>, reason: string): Record<string, unknown> {
  const winnerText = scores.winner === 'draw' ? '平局' : `${scores.winner === 'black' ? '黑方' : '白方'}胜`;
  return {
    moveIndex: -1,
    color: scores.winner === 'draw' ? 'black' : scores.winner,
    position: { row: -1, col: -1 },
    commentary: `【棋局结束】${reason} | 最终结果: ${winnerText} | 黑${scores.black} - 白${scores.white} | ${scores.detail}`,
  };
}

// ========== 对外接口 ==========

const WORKER_INSTANCE_ID = `${process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'local'}-${Date.now()}`;

async function tryAcquireLeadership(): Promise<boolean> {
  if (!INTERNAL_KEY) {
    console.error('[ai-test-worker] FATAL: INTERNAL_API_KEY is not set. Worker cannot authenticate with go-engine API.');
    return false;
  }

  const supabase = getSupabase();
  const now = new Date().toISOString();
  const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString();

  // 检查最近30秒内是否有其他活跃worker
  const { data: heartbeats } = await supabase
    .from('letsgo_games')
    .select('id, commentaries, updated_at')
    .eq('title', '__WORKER_HEARTBEAT__')
    .gt('updated_at', thirtySecondsAgo)
    .order('updated_at', { ascending: false })
    .limit(1);

  if (heartbeats && heartbeats.length > 0) {
    const hb = heartbeats[0];
    const commentaries = (hb.commentaries as Array<Record<string, unknown>> | null) || [];
    const lastEntry = commentaries[0] as { instanceId?: string; heartbeat?: string } | undefined;
    if (lastEntry?.instanceId !== WORKER_INSTANCE_ID) {
      console.log(`[ai-test-worker] Another worker is active (instance=${lastEntry?.instanceId}), this instance (${WORKER_INSTANCE_ID}) will not start`);
      return false;
    }
  }

  // 更新心跳记录
  const { data: existing } = await supabase
    .from('letsgo_games')
    .select('id')
    .eq('title', '__WORKER_HEARTBEAT__')
    .maybeSingle();

  if (existing) {
    await supabase.from('letsgo_games').update({
      commentaries: [{ instanceId: WORKER_INSTANCE_ID, heartbeat: now }],
      updated_at: now,
    }).eq('id', existing.id);
  } else {
    await supabase.from('letsgo_games').insert({
      user_id: null,
      board_size: 9,
      difficulty: 'medium',
      engine: 'local',
      moves: [],
      commentaries: [{ instanceId: WORKER_INSTANCE_ID, heartbeat: now }],
      final_board: [],
      black_score: 0,
      white_score: 0,
      status: 'finished',
      title: '__WORKER_HEARTBEAT__',
    });
  }

  return true;
}

async function updateHeartbeat(): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('letsgo_games').update({
    commentaries: [{ instanceId: WORKER_INSTANCE_ID, heartbeat: new Date().toISOString() }],
    updated_at: new Date().toISOString(),
  }).eq('title', '__WORKER_HEARTBEAT__');
}

export async function start(): Promise<void> {
  if (isRunning) {
    console.log('[ai-test-worker] Already running');
    return;
  }

  const isLeader = await tryAcquireLeadership();
  if (!isLeader) {
    console.log('[ai-test-worker] Not leader, skipping start');
    return;
  }

  console.log(`[ai-test-worker] Instance ${WORKER_INSTANCE_ID} acquired leadership`);

  // 检查是否有进行中的棋局
  const supabase = getSupabase();
  const { data: runningGames } = await supabase
    .from('letsgo_games')
    .select('id')
    .eq('status', 'running')
    .is('user_id', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (runningGames && runningGames.length > 0) {
    currentGameId = runningGames[0].id as number;
    isRunning = true;
    console.log(`[ai-test-worker] Resumed game ${currentGameId}`);
    scheduleNext(1000);
  } else {
    console.log('[ai-test-worker] No running game found');
  }
}

export function stop(): void {
  isRunning = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log('[ai-test-worker] Stopped');
}

export async function createGame(config: SpectatorConfig): Promise<{ success: boolean; gameId?: number; error?: string }> {
  console.log('[ai-test-worker] createGame called with config:', JSON.stringify(config));
  const supabase = getSupabase();

  // 结束任何已有的 running/paused 直播棋局
  const { error: finishRunningError } = await supabase
    .from('letsgo_games')
    .update({ status: 'finished', updated_at: new Date().toISOString() })
    .eq('status', 'running')
    .is('user_id', null);
  if (finishRunningError) console.warn('[ai-test-worker] finish running games error:', finishRunningError.message);

  const { error: finishPausedError } = await supabase
    .from('letsgo_games')
    .update({ status: 'finished', updated_at: new Date().toISOString() })
    .eq('status', 'paused')
    .is('user_id', null);
  if (finishPausedError) console.warn('[ai-test-worker] finish paused games error:', finishPausedError.message);

  // 创建新棋局
  const emptyBoard = createEmptyBoard(config.boardSize);
  console.log('[ai-test-worker] Inserting new game...');
  const { data, error } = await supabase
    .from('letsgo_games')
    .insert({
      user_id: null,
      board_size: config.boardSize,
      difficulty: config.opponent.difficulty,
      engine: config.opponent.engine,
      moves: [],
      commentaries: [],
      final_board: emptyBoard as unknown as Record<string, unknown>[],
      black_score: 0,
      white_score: getKomi(config.boardSize),
      status: 'running',
      title: configTitle(config),
      config: config as unknown as Record<string, unknown>,
    })
    .select()
    .single();

  if (error || !data) {
    console.error('[ai-test-worker] createGame insert failed:', error?.message);
    return { success: false, error: error?.message || '创建棋局失败' };
  }

  currentGameId = data.id as number;
  isRunning = true;
  console.log(`[ai-test-worker] Game ${currentGameId} created, scheduling first tick in ${config.stepInterval}ms`);
  scheduleNext(config.stepInterval);

  return { success: true, gameId: data.id as number };
}

async function findLiveGameId(): Promise<number | null> {
  const supabase = getSupabase();
  const { data: games } = await supabase
    .from('letsgo_games')
    .select('id')
    .in('status', ['running', 'paused'])
    .is('user_id', null)
    .order('created_at', { ascending: false })
    .limit(1);
  return games && games.length > 0 ? (games[0].id as number) : null;
}

export async function pauseGame(): Promise<void> {
  const gameId = currentGameId ?? await findLiveGameId();
  if (!gameId) return;
  const supabase = getSupabase();
  await supabase
    .from('letsgo_games')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('id', gameId);
  console.log(`[ai-test-worker] Game ${gameId} paused`);
}

export async function resumeGame(): Promise<void> {
  const gameId = currentGameId ?? await findLiveGameId();
  if (!gameId) return;
  const supabase = getSupabase();
  await supabase
    .from('letsgo_games')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', gameId);
  // 如果 currentGameId 丢失（模块重载），恢复它
  if (!currentGameId) {
    currentGameId = gameId;
  }
  isRunning = true;
  scheduleNext(1000);
  console.log(`[ai-test-worker] Game ${gameId} resumed`);
}

export async function endGame(): Promise<void> {
  const gameId = currentGameId ?? await findLiveGameId();
  if (gameId) {
    const supabase = getSupabase();
    await supabase
      .from('letsgo_games')
      .update({ status: 'finished', updated_at: new Date().toISOString() })
      .eq('id', gameId);
    console.log(`[ai-test-worker] Game ${gameId} ended`);
  }
  currentGameId = null;
  isRunning = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function getStatus(): { running: boolean; gameId: number | null } {
  return { running: isRunning, gameId: currentGameId };
}
