'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { createEmptyBoard, isValidMove, playMove, checkGameEnd, evaluateBoard, findBestHint, getKomi } from '@/lib/go-logic';
import type { Stone, Board } from '@/lib/go-logic';

type EngineId = 'katago' | 'gnugo' | 'local';
type Difficulty = 'easy' | 'medium' | 'hard';

interface AnalysisData {
  winRate: number;
  scoreLead: number;
  bestMoves?: Array<{ move: string; winrate: number; scoreMean: number }>;
  actualVisits?: number;
}

interface LogEntry {
  time: string;
  type: 'info' | 'success' | 'error' | 'warn';
  message: string;
}



const AI_TEST_USER = 'AItest';
const AI_TEST_PASS = 'AItest2026';
const MAX_STEPS = 200;

// Column labels (skip I)
const COL_LABELS = 'ABCDEFGHJKLMNOPQRST';

export default function AITestPage() {
  const [token, setToken] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [points, setPoints] = useState(0);
  const [loggedIn, setLoggedIn] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [boardSize, setBoardSize] = useState<9 | 13 | 19>(9);
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [engine, setEngine] = useState<EngineId>('gnugo');
  const [playerColor, setPlayerColor] = useState<'black' | 'white'>('black');
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stepInterval, setStepInterval] = useState(15000);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [totalGames, setTotalGames] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [lastAnalysis, setLastAnalysis] = useState<AnalysisData | null>(null);
  const [board, setBoard] = useState<Board>(createEmptyBoard(9));
  const [lastMove, setLastMove] = useState<{ row: number; col: number } | null>(null);
  const [currentGameId, setCurrentGameId] = useState<number | null>(null);
  const [hintPosition, setHintPosition] = useState<{ row: number; col: number } | null>(null);
  const [usedHintCount, setUsedHintCount] = useState(0);
  const [missedHintCount, setMissedHintCount] = useState(0);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [winRateEndCondition, setWinRateEndCondition] = useState<number>(99); // default 99%
  const maxSteps = boardSize === 9 ? 150 : boardSize === 13 ? 300 : 500;
  const [savedGames, setSavedGames] = useState<Array<{
    id: number; board_size: number; difficulty: string; engine: string;
    title: string; status: string; created_at: string;
  }>>([]);

  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const loadedMovesRef = useRef<Array<{ row: number; col: number; color: Stone }>>([]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    const time = new Date().toLocaleTimeString('zh-CN');
    setLogs(prev => [...prev.slice(-500), { time, type, message }]);
  }, []);

  // Login
  const handleLogin = useCallback(async () => {
    if (!password) {
      setLoginError('请输入密码');
      return;
    }
    setLoginError('');
    try {
      addLog('info', `尝试登录 ${AI_TEST_USER}...`);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: AI_TEST_USER, password }),
      });
      const data = await res.json();

      if (data.token) {
        setToken(data.token);
        setUserId(data.user.id);
        setPoints(data.user.points);
        setLoggedIn(true);
        addLog('success', `登录成功，积分: ${data.user.points}`);
      } else {
        const errorMsg = data.error === '昵称或密码错误' ? '密码错误' : (data.error || '登录失败');
        setLoginError(errorMsg);
        addLog('error', `登录失败: ${errorMsg}`);
      }
    } catch (err) {
      setLoginError('登录异常');
      addLog('error', `登录异常: ${err}`);
    }
  }, [addLog, password]);

  // Convert moves to API format (color must be string 'black'/'white', not number 1/2)
  const movesToApi = useCallback((moves: Array<{ row: number; col: number; color: Stone }>) => {
    return moves.map(m => ({
      row: m.row,
      col: m.col,
      color: m.color,
    }));
  }, []);

  // Save or update game (uses same MoveEntry format as main page for compatibility)
  const saveGameToDB = useCallback(async (
    tok: string,
    bSize: number,
    diff: Difficulty,
    eng: EngineId,
    moves: Array<{ row: number; col: number; color: Stone }>,
    commentaries: Array<{ moveIndex: number; text: string }>,
    gameId: number | null,
    status: string = 'playing'
  ): Promise<number | null> => {
    try {
      // Convert to main-page compatible MoveEntry format: {position: {row, col}, color: Stone, captured: 0}
      const movesCompat = moves.map(m => ({
        position: { row: m.row, col: m.col },
        color: m.color,
        captured: 0,
      }));
      const body: Record<string, unknown> = {
        board_size: bSize,
        difficulty: diff,
        engine: eng,
        moves: movesCompat,
        commentaries,
        title: `${bSize}路 ${diff === 'easy' ? '初级' : diff === 'medium' ? '中级' : '高级'} ${eng} AI测试 ${new Date().toLocaleDateString('zh-CN')}`,
        status,
        final_board: null,
        black_score: 0,
        white_score: 0,
      };
      if (gameId) {
        body.id = gameId;
      }
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.game?.id) return data.game.id;
      return null;
    } catch {
      return null;
    }
  }, []);

  // Get AI move from engine (separate from analysis - same as main page)
  const getAIMove = useCallback(async (
    moves: Array<{ row: number; col: number; color: Stone }>,
    bSize: number,
    diff: Difficulty,
    eng: EngineId,
    tok: string,
    aiColor: 'black' | 'white'
  ): Promise<{ move: { row: number; col: number } | null; pass?: boolean; resign?: boolean; noEngine?: boolean; engine?: string; analysis?: AnalysisData | null; error?: string; pointsUsed?: number }> => {
    try {
      const res = await fetch('/api/go-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ boardSize: bSize, difficulty: diff, engine: eng, moves: movesToApi(moves), aiColor }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await res.json();
      if (data.error) return { move: null, error: data.error };
      return { move: data.move, pass: data.pass, resign: data.resign, noEngine: data.noEngine, engine: data.engine, analysis: data.analysis, pointsUsed: data.pointsUsed };
    } catch (err) {
      return { move: null, error: String(err) };
    }
  }, [movesToApi]);

  // Get analysis (teaching hint) - uses isAITest flag to bypass limits
  const getAnalysis = useCallback(async (
    moves: Array<{ row: number; col: number; color: Stone }>,
    bSize: number,
    tok: string
  ): Promise<AnalysisData | null> => {
    try {
      const res = await fetch('/api/go-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ action: 'analyze', boardSize: bSize, moves: movesToApi(moves), aiColor: 2, isAITest: true }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await res.json();
      if (data.analysis) {
        addLog('info', `  分析完成: winRate=${data.analysis.winRate?.toFixed(1) ?? '?'}, scoreLead=${data.analysis.scoreLead?.toFixed(1) ?? '?'}, bestMoves=${data.analysis.bestMoves?.slice(0,3).map((m: {move: string}) => m.move).join(',') ?? 'none'}`);
        return data.analysis;
      }
      if (data.queueBusy) {
        addLog('warn', `分析排队拒绝: 队列${data.queueLength}人`);
      } else if (data.insufficientPoints) {
        addLog('warn', `积分不足，无法获取分析`);
      } else if (data.error) {
        addLog('warn', `分析失败: ${data.error}`);
      } else {
        addLog('warn', `分析返回空结果 (HTTP ${res.status})`);
      }
      return null;
    } catch (err) {
      addLog('warn', `分析请求异常: ${err}`);
      return null;
    }
  }, [addLog, movesToApi]);

  // Get hint from analysis bestMoves
  const getHintFromAnalysis = useCallback((analysis: AnalysisData | null, bSize: number): { row: number; col: number } | null => {
    if (!analysis?.bestMoves?.length) return null;
    for (const bm of analysis.bestMoves) {
      if (!bm.move || bm.move === 'pass' || bm.move === 'resign') continue;
      const colLetter = bm.move[0];
      const rowNum = parseInt(bm.move.substring(1));
      if (isNaN(rowNum)) continue;
      const col = colLetter.charCodeAt(0) - 'A'.charCodeAt(0) + (colLetter >= 'I' ? -1 : 0);
      const row = bSize - rowNum;
      if (row >= 0 && row < bSize && col >= 0 && col < bSize) {
        return { row, col };
      }
    }
    return null;
  }, []);

  // Fallback: find best empty position using findBestHint + random
  const findFallbackMove = useCallback((b: Board, color: Stone): { row: number; col: number } | null => {
    const hint = findBestHint(b, color);
    if (hint) return hint;
    const bSize = b.length;
    const validMoves: Array<{ row: number; col: number }> = [];
    for (let r = 0; r < bSize; r++) {
      for (let c = 0; c < bSize; c++) {
        if (b[r][c] === null && isValidMove(b, r, c, color)) {
          validMoves.push({ row: r, col: c });
        }
      }
    }
    if (validMoves.length === 0) return null;
    return validMoves[Math.floor(Math.random() * validMoves.length)];
  }, []);

  // Main game loop
  const runGame = useCallback(async () => {
    if (!token || !userId) return;
    runningRef.current = true;
    pausedRef.current = false;
    setRunning(true);
    setPaused(false);
    setUsedHintCount(0);
    setMissedHintCount(0);

    const abortController = new AbortController();
    abortRef.current = abortController;

    let gameCount = 0;
    let totalStepCount = 0;

    while (runningRef.current) {
      gameCount++;
      setTotalGames(gameCount);

      // Check if we have loaded moves to continue from
      const startingMoves = [...loadedMovesRef.current];
      loadedMovesRef.current = [];

      let currentBoard = createEmptyBoard(boardSize);
      const moves: Array<{ row: number; col: number; color: Stone }> = [];
      const gameCommentaries: Array<{ moveIndex: number; text: string }> = [];
      let currentPlayer: Stone = 'black';
      let consecutivePasses = 0;
      let stepCount = 0;
      let gameId: number | null = currentGameId;

      // Replay loaded moves if any
      if (startingMoves.length > 0) {
        addLog('info', `===== 继续棋局 ${boardSize}路 ${difficulty} ${engine} (已有${startingMoves.length}步) =====`);
        for (const m of startingMoves) {
          const result = playMove(currentBoard, m.row, m.col, m.color);
          currentBoard = result.newBoard;
          moves.push(m);
          currentPlayer = m.color === 'black' ? 'white' : 'black';
        }
        stepCount = startingMoves.length;
        setBoard([...currentBoard.map(r => [...r])]);
        setCurrentStep(stepCount);
        setLastMove(startingMoves[startingMoves.length - 1]);
      } else {
        addLog('info', `===== 第${gameCount}局开始 ${boardSize}路 ${difficulty} ${engine} (上限${maxSteps}步, 胜率结束>${winRateEndCondition / 10}%) =====`);
        setBoard([...currentBoard.map(r => [...r])]);
        setLastMove(null);
      }
      setHintPosition(null);
      const aiColor: Stone = playerColor === 'black' ? 'white' : 'black';
      let currentAnalysis: { winRate: number; scoreLead: number; bestMoves?: Array<{ move: string; winrate: number; scoreMean: number }> } | null = null;

      // If starting fresh (no loaded moves) and player is white, AI (black) goes first
      if (startingMoves.length === 0 && playerColor === 'white') {
        addLog('info', `玩家执白，AI(黑)先手`);
        const aiResult = await getAIMove(moves, boardSize, difficulty, engine, token, aiColor);
        if (abortController.signal.aborted) break;
        if (aiResult.move) {
          moves.push({ row: aiResult.move.row, col: aiResult.move.col, color: 'black' });
          const result = playMove(currentBoard, aiResult.move.row, aiResult.move.col, 'black');
          currentBoard = result.newBoard;
          setBoard([...currentBoard.map(r => [...r])]);
          setLastMove(aiResult.move);
          consecutivePasses = 0;
          stepCount++;
          setCurrentStep(stepCount);
        } else if (aiResult.pass) {
          consecutivePasses++;
        }
        currentPlayer = 'white';
      }

      while (runningRef.current && stepCount < MAX_STEPS) {
        while (pausedRef.current && runningRef.current) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (!runningRef.current) break;
        if (abortController.signal.aborted) break;

        const isPlayerTurn = currentPlayer === playerColor;

        if (isPlayerTurn) {
          addLog('info', `第${stepCount + 1}步: 玩家(${playerColor === 'black' ? '黑' : '白'})思考中...`);

          // 玩家回合：总是获取新的分析（与首页"提示与教学"完全一致）
          let hint: { row: number; col: number } | null = null;
          const analysis = await getAnalysis(moves, boardSize, token);
          if (analysis) {
            currentAnalysis = analysis;
            setLastAnalysis(analysis);
            hint = getHintFromAnalysis(analysis, boardSize);
            if (hint) {
              setHintPosition(hint);
              addLog('success', `  KataGo建议: ${COL_LABELS[hint.col]}${boardSize - hint.row} 黑胜率=${analysis.winRate.toFixed(1)}%${Math.abs(analysis.scoreLead) > 0.05 ? ` 领先=${analysis.scoreLead.toFixed(1)}目` : ''} visits=${analysis.actualVisits || '?'}`);
            } else {
              const hasPass = analysis.bestMoves?.some((bm: { move: string }) => bm.move === 'pass');
              if (hasPass) {
                addLog('warn', `  KataGo建议认输(pass)，使用本地提示`);
              } else {
                addLog('warn', `  KataGo分析完成但无法解析建议位置, bestMoves=${JSON.stringify(analysis.bestMoves?.slice(0, 3))}`);
              }
            }
          } else {
            addLog('warn', `  KataGo分析未返回数据，使用本地提示`);
          }

          // Use hint or fallback
          let move = hint;
          const usedKataGoHint = !!hint;
          if (!move) {
            move = findFallbackMove(currentBoard, playerColor);
          }

          if (move && isValidMove(currentBoard, move.row, move.col, playerColor)) {
            moves.push({ row: move.row, col: move.col, color: playerColor });
            const result = playMove(currentBoard, move.row, move.col, playerColor);
            currentBoard = result.newBoard;
            setBoard([...currentBoard.map(r => [...r])]);
            setLastMove(move);
            consecutivePasses = 0;
            stepCount++;
            totalStepCount++;
            setCurrentStep(stepCount);
            setTotalSteps(totalStepCount);
            const moveLabel = `${COL_LABELS[move.col]}${boardSize - move.row}`;
            if (usedKataGoHint) {
              setUsedHintCount(prev => prev + 1);
              addLog('success', `  落子: ${moveLabel} (使用KataGo建议)`);
              gameCommentaries.push({ moveIndex: stepCount - 1, text: `[KataGo建议] ${moveLabel} 黑胜率${analysis?.winRate.toFixed(1)}%${analysis && Math.abs(analysis.scoreLead) > 0.05 ? ` 领先${analysis.scoreLead.toFixed(1)}目` : ''}` });
            } else {
              setMissedHintCount(prev => prev + 1);
              addLog('warn', `  落子: ${moveLabel} (本地提示，KataGo建议未使用)`);
              gameCommentaries.push({ moveIndex: stepCount - 1, text: `[本地提示] ${moveLabel}` });
            }
          } else {
            addLog('warn', `  无合法落子，停手`);
            consecutivePasses++;
            gameCommentaries.push({ moveIndex: stepCount, text: '[停手]' });
          }
        } else {
          addLog('info', `第${stepCount + 1}步: AI(${aiColor === 'black' ? '黑' : '白'})思考中...`);
          // AI落子：与首页完全一致的两步请求方式
          // 第1步：获取分析数据（与首页教学路径完全一致）
          let analysis: AnalysisData | null = null;
          try {
            analysis = await getAnalysis(moves, boardSize, token);
            if (analysis) {
              currentAnalysis = analysis;
              setLastAnalysis(analysis);
              const hintInfo = getHintFromAnalysis(analysis, boardSize);
              if (hintInfo) {
                addLog('info', `  AI分析: 建议${COL_LABELS[hintInfo.col]}${boardSize - hintInfo.row} 黑胜率=${analysis.winRate.toFixed(1)}%${Math.abs(analysis.scoreLead) > 0.05 ? ` 领先=${analysis.scoreLead.toFixed(1)}目` : ''} visits=${analysis.actualVisits || '?'}`);
              }
            }
          } catch {
            addLog('warn', `  AI分析请求异常，继续落子`);
          }
          if (abortController.signal.aborted) break;

          // 第2步：获取AI落子（与首页完全一致）
          const aiResult = await getAIMove(moves, boardSize, difficulty, engine, token, aiColor);
          if (abortController.signal.aborted) break;

          if (aiResult.error) {
            addLog('error', `  AI错误: ${aiResult.error}`);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }

          // 更新积分
          if (aiResult.pointsUsed && aiResult.pointsUsed > 0) {
            setPoints(prev => Math.max(0, prev - aiResult.pointsUsed!));
          }

          if (aiResult.move) {
            moves.push({ row: aiResult.move.row, col: aiResult.move.col, color: aiColor });
            const result = playMove(currentBoard, aiResult.move.row, aiResult.move.col, aiColor);
            currentBoard = result.newBoard;
            setBoard([...currentBoard.map(r => [...r])]);
            setLastMove(aiResult.move);
            consecutivePasses = 0;
            stepCount++;
            totalStepCount++;
            setCurrentStep(stepCount);
            setTotalSteps(totalStepCount);
            const moveLabel = `${COL_LABELS[aiResult.move.col]}${boardSize - aiResult.move.row}`;
            addLog('info', `  AI落子: ${moveLabel}`);
            // genmove也可能返回analysis数据（向后兼容）
            if (aiResult.analysis) {
              setLastAnalysis(aiResult.analysis);
            }
            gameCommentaries.push({ moveIndex: stepCount - 1, text: `[AI] ${moveLabel}` });
          } else if (aiResult.pass) {
            consecutivePasses++;
            addLog('info', `  AI停手`);
            gameCommentaries.push({ moveIndex: stepCount, text: '[AI停手]' });
          } else {
            // 兜底处理：move=null, pass=false, error=undefined
            if (aiResult.resign) {
              addLog('info', `  AI认输，棋局结束`);
              gameCommentaries.push({ moveIndex: stepCount, text: '[AI认输]' });
              const eval_ = evaluateBoard(currentBoard);
              addLog('info', `===== 第${gameCount}局结束: AI认输 =====`);
              addLog('info', `  黑${eval_.black}目 vs 白${eval_.white}目`);
              gameId = await saveGameToDB(token, boardSize, difficulty, engine, moves, gameCommentaries, gameId, 'finished');
              if (gameId) { setCurrentGameId(gameId); addLog('success', `  棋局已保存 (ID:${gameId})`); }
              break;
            } else if (aiResult.noEngine) {
              addLog('warn', `  引擎不可用，回退本地AI`);
              const fallbackMove = findFallbackMove(currentBoard, aiColor);
              if (fallbackMove && isValidMove(currentBoard, fallbackMove.row, fallbackMove.col, aiColor)) {
                moves.push({ row: fallbackMove.row, col: fallbackMove.col, color: aiColor });
                const result = playMove(currentBoard, fallbackMove.row, fallbackMove.col, aiColor);
                currentBoard = result.newBoard;
                setBoard([...currentBoard.map(r => [...r])]);
                setLastMove(fallbackMove);
                consecutivePasses = 0;
                stepCount++;
                totalStepCount++;
                setCurrentStep(stepCount);
                setTotalSteps(totalStepCount);
                const moveLabel = `${COL_LABELS[fallbackMove.col]}${boardSize - fallbackMove.row}`;
                addLog('info', `  本地AI落子: ${moveLabel}`);
                gameCommentaries.push({ moveIndex: stepCount - 1, text: `[本地AI] ${moveLabel}` });
              } else {
                addLog('warn', `  本地AI也无合法落子，停手`);
                consecutivePasses++;
                gameCommentaries.push({ moveIndex: stepCount, text: '[AI停手-无合法]' });
              }
            } else {
              addLog('warn', `  AI无合法落子，按停手处理`);
              consecutivePasses++;
              gameCommentaries.push({ moveIndex: stepCount, text: '[AI停手-无合法]' });
            }
          }
        }

        // Check game end
        const endCheck = checkGameEnd(currentBoard, consecutivePasses, stepCount);
        // Also check win rate end condition (use currentAnalysis from this iteration, not stale lastAnalysis state)
        let winRateEnded = false;
        let winRateReason = '';
        if (!endCheck.ended && currentAnalysis && stepCount >= 10) {
          const wr = currentAnalysis.winRate;
          const threshold = winRateEndCondition / 10; // 95→9.5, 99→9.9, 995→99.5, 999→99.9
          if (wr >= threshold || wr <= (100 - threshold)) {
            winRateEnded = true;
            const winner = wr >= threshold ? '黑方' : '白方';
            winRateReason = `黑胜率=${wr.toFixed(1)}%，${winner}绝对优势，棋局结束`;
          }
        }
        if (endCheck.ended || winRateEnded) {
          const eval_ = evaluateBoard(currentBoard);
          const komi = boardSize === 9 ? 2.5 : boardSize === 13 ? 3.5 : 6.5;
          const whiteWithKomi = eval_.white + komi;
          const blackWins = eval_.black > whiteWithKomi;
          const reason = winRateEnded ? winRateReason : endCheck.reason;
          addLog('info', `===== 第${gameCount}局结束: ${reason} =====`);
          addLog('info', `  黑${eval_.black}目 vs 白${eval_.white}目(含贴目${komi}目) = ${whiteWithKomi.toFixed(1)}目`);
          addLog('info', `  ${blackWins ? '⚫ 黑方胜' : '⚪ 白方胜'} ${blackWins ? (eval_.black - whiteWithKomi).toFixed(1) : (whiteWithKomi - eval_.black).toFixed(1)}目`);

          // Save finished game
          gameId = await saveGameToDB(token, boardSize, difficulty, engine, moves, gameCommentaries, gameId, 'finished');
          if (gameId) {
            setCurrentGameId(gameId);
            addLog('success', `  棋局已保存 (ID:${gameId})`);
          }
          break;
        }

        // Auto-save every 10 steps
        if (stepCount > 0 && stepCount % 10 === 0 && moves.length > 0) {
          gameId = await saveGameToDB(token, boardSize, difficulty, engine, moves, gameCommentaries, gameId, 'playing');
          if (gameId) setCurrentGameId(gameId);
        }

        // Switch player
        currentPlayer = currentPlayer === 'black' ? 'white' : 'black';

        // Wait interval
        if (runningRef.current) {
          await new Promise(r => setTimeout(r, stepInterval));
        }
      }

      if (stepCount >= MAX_STEPS) {
        addLog('warn', `步数上限${MAX_STEPS}，本局结束`);
        // Save game at max steps
        gameId = await saveGameToDB(token, boardSize, difficulty, engine, moves, gameCommentaries, gameId, 'finished');
        if (gameId) setCurrentGameId(gameId);
      }

      // Refresh points
      try {
        const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (data.user) setPoints(data.user.points);
      } catch { /* ignore */ }

      // Game interval
      if (runningRef.current) {
        addLog('info', `等待5秒后开始下一局...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    setRunning(false);
    addLog('info', `测试已停止，共${gameCount}局${totalStepCount}步`);
  }, [token, userId, boardSize, difficulty, engine, playerColor, stepInterval, currentGameId, winRateEndCondition, maxSteps, addLog, getAIMove, getAnalysis, getHintFromAnalysis, findFallbackMove, saveGameToDB]);

  const stopGame = useCallback(() => {
    runningRef.current = false;
    pausedRef.current = false;
    if (abortRef.current) abortRef.current.abort();
    setRunning(false);
    setPaused(false);
  }, []);

  const togglePause = useCallback(() => {
    const newPaused = !pausedRef.current;
    pausedRef.current = newPaused;
    setPaused(newPaused);
    addLog('info', newPaused ? '已暂停' : '继续运行');
  }, [addLog]);

  // Reset all AI test state (full restart)
  const resetAITest = useCallback(() => {
    stopGame();
    loadedMovesRef.current = [];
    setBoard(createEmptyBoard(boardSize));
    setLastMove(null);
    setCurrentStep(0);
    setTotalGames(0);
    setTotalSteps(0);
    setLastAnalysis(null);
    setCurrentGameId(null);
    setHintPosition(null);
    setUsedHintCount(0);
    setMissedHintCount(0);
    setLogs([{ type: 'info', message: '已重置所有数据', time: new Date().toLocaleTimeString() }]);
  }, [stopGame, boardSize]);

  // Load saved games list
  const loadGamesList = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/games', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setSavedGames(data.games || []);
    } catch {
      addLog('error', '加载棋局列表失败');
    }
  }, [token, addLog]);

  // Load a saved game and continue testing from where it left off
  const loadGame = useCallback(async (gameId: number) => {
    if (!token) return;
    try {
      stopGame();
      const res = await fetch(`/api/games/${gameId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      const game = data.game;
      if (!game) return;

      // Set game parameters
      setBoardSize(game.board_size);
      setDifficulty(game.difficulty || 'easy');
      if (game.engine) setEngine(game.engine as EngineId);
      setCurrentGameId(game.id);
      setShowLoadDialog(false);

      // Replay all moves to reconstruct board state
      const moves = game.moves || [];
      let currentBoard = createEmptyBoard(game.board_size);
      const replayedMoves: Array<{ row: number; col: number; color: Stone }> = [];
      let currentColor: Stone = 'black';

      for (const move of moves) {
        // Handle both main-page format {position: {row, col}, color: 'black'} and ai-test format {row, col, color: 1}
        const row = move.position?.row ?? move.row;
        const col = move.position?.col ?? move.col;
        const color: Stone = move.color === 'black' || move.color === 1 ? 'black' : 'white';

        if (row !== undefined && col !== undefined) {
          const result = playMove(currentBoard, row, col, color);
          currentBoard = result.newBoard;
          replayedMoves.push({ row, col, color });
          currentColor = color === 'black' ? 'white' : 'black';
        }
      }

      setBoard([...currentBoard.map(r => [...r])]);
      setLastMove(replayedMoves.length > 0 ? replayedMoves[replayedMoves.length - 1] : null);
      setCurrentStep(replayedMoves.length);
      setLastAnalysis(null);
      setHintPosition(null);
      setUsedHintCount(0);
      setMissedHintCount(0);

      // Store replayed moves for the runGame loop to pick up
      // We'll store them in a ref so the game loop can use them as starting moves
      loadedMovesRef.current = replayedMoves;

      // Determine player color from the game
      // If the last move was black, next is white; use stored playerColor
      setPlayerColor(playerColor);

      addLog('success', `已加载棋局 #${gameId}: ${game.title || '无标题'} (${replayedMoves.length}步)`);
    } catch (err) {
      addLog('error', `加载棋局失败: ${err}`);
    }
  }, [token, stopGame, addLog, playerColor]);

  // Delete a saved game
  const deleteGame = useCallback(async (gameId: number) => {
    if (!token) return;
    try {
      await fetch(`/api/games?id=${gameId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      setSavedGames(prev => prev.filter(g => g.id !== gameId));
      addLog('info', `已删除棋局 #${gameId}`);
    } catch {
      addLog('error', '删除棋局失败');
    }
  }, [token, addLog]);

  // Export logs as text file
  const exportLogs = useCallback(() => {
    const text = logs.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-test-log-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  // Render board with coordinates (reusing main game style)
  const baseCellSize = boardSize <= 9 ? 44 : boardSize <= 13 ? 34 : 28;
  const padding = baseCellSize;
  const boardPx = baseCellSize * (boardSize - 1) + padding * 2;

  const starPoints9 = [[2,2],[2,6],[4,4],[6,2],[6,6]];
  const starPoints13 = [[3,3],[3,9],[6,6],[9,3],[9,9],[3,6],[6,3],[6,9],[9,6]];
  const starPoints19 = [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
  const starPoints = boardSize === 9 ? starPoints9 : boardSize === 13 ? starPoints13 : starPoints19;

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-50 p-4">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-amber-800 mb-4">AI模拟实战测试</h1>

        {!loggedIn ? (
          <div className="bg-white rounded-lg shadow p-6 max-w-sm mx-auto">
            <p className="text-gray-600 mb-4 text-center">请登录AI测试账号</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-500 mb-1">用户名</label>
                <input
                  type="text"
                  value={AI_TEST_USER}
                  readOnly
                  className="w-full border rounded px-3 py-2 bg-gray-50 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-500 mb-1">密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setLoginError(''); }}
                  onKeyDown={e => e.key === 'Enter' && handleLogin()}
                  placeholder="请输入密码"
                  className="w-full border rounded px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              {loginError && <p className="text-red-500 text-sm">{loginError}</p>}
              <button
                onClick={handleLogin}
                className="w-full px-4 py-2 bg-amber-700 text-white rounded-lg hover:bg-amber-800"
              >
                登录
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr_260px] gap-3">
            {/* Left: Controls */}
            <div className="space-y-4">
              <div className="bg-white rounded-lg shadow p-4">
                <h2 className="font-semibold text-amber-800 mb-3">配置</h2>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-gray-600">棋盘</label>
                    <select
                      value={boardSize}
                      onChange={e => setBoardSize(Number(e.target.value) as 9 | 13 | 19)}
                      disabled={running}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value={9}>9路</option>
                      <option value={13}>13路</option>
                      <option value={19}>19路</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-gray-600">难度</label>
                    <select
                      value={difficulty}
                      onChange={e => setDifficulty(e.target.value as Difficulty)}
                      disabled={running}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value="easy">初级</option>
                      <option value="medium">中级</option>
                      <option value="hard">高级</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-gray-600">引擎</label>
                    <select
                      value={engine}
                      onChange={e => setEngine(e.target.value as EngineId)}
                      disabled={running}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value="gnugo">GnuGo</option>
                      <option value="katago">KataGo</option>
                      <option value="local">本地AI</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-gray-600">执子</label>
                    <select
                      value={playerColor}
                      onChange={e => setPlayerColor(e.target.value as 'black' | 'white')}
                      disabled={running}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value="black">执黑(先手)</option>
                      <option value="white">执白(后手)</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-gray-600">步间隔</label>
                    <select
                      value={stepInterval}
                      onChange={e => setStepInterval(Number(e.target.value))}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value={5000}>5秒</option>
                      <option value={10000}>10秒</option>
                      <option value={15000}>15秒</option>
                      <option value={20000}>20秒</option>
                      <option value={30000}>30秒</option>
                      <option value={60000}>60秒</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-gray-600">胜率结束</label>
                    <select
                      value={winRateEndCondition}
                      onChange={e => setWinRateEndCondition(Number(e.target.value))}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value={95}>95%</option>
                      <option value={99}>99%</option>
                      <option value={995}>99.5%</option>
                      <option value={999}>99.9%</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-4">
                <h2 className="font-semibold text-amber-800 mb-3">控制</h2>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    {!running ? (
                      <button
                        onClick={runGame}
                        className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
                      >
                        开始测试
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={togglePause}
                          className="flex-1 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 text-sm"
                        >
                          {paused ? '继续' : '暂停'}
                        </button>
                        <button
                          onClick={stopGame}
                          className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
                        >
                          停止
                        </button>
                      </>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setShowLoadDialog(true); loadGamesList(); }}
                      disabled={running}
                      className="flex-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      加载棋局
                    </button>
                    <button
                      onClick={resetAITest}
                      disabled={running}
                      className="flex-1 px-3 py-1.5 bg-gray-600 text-white rounded-lg hover:bg-gray-700 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      重新开始
                    </button>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-4">
                <h2 className="font-semibold text-amber-800 mb-3">统计</h2>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">积分</span>
                    <span className="font-mono">{points}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">当前局步数</span>
                    <span className="font-mono">{currentStep}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">总对局数</span>
                    <span className="font-mono">{totalGames}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">总落子数</span>
                    <span className="font-mono">{totalSteps}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">KataGo建议使用</span>
                    <span className="font-mono text-green-600">{usedHintCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">KataGo建议未用</span>
                    <span className="font-mono text-orange-500">{missedHintCount}</span>
                  </div>
                  {currentGameId && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">棋局ID</span>
                      <span className="font-mono">{currentGameId}</span>
                    </div>
                  )}
                  {/* Territory count */}
                  {(() => {
                    const ev = evaluateBoard(board);
                    return (
                      <>
                        <div className="border-t my-1" />
                        <div className="flex justify-between">
                          <span className="text-gray-600">⚫ 黑方</span>
                          <span className="font-mono">{ev.black}目</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">⚪ 白方</span>
                          <span className="font-mono">{ev.white}目</span>
                        </div>
                      </>
                    );
                  })()}
                  {lastAnalysis && (
                    <>
                      <div className="border-t my-1" />
                      <div className="flex justify-between">
                        <span className="text-gray-600">黑方胜率</span>
                        <span className="font-mono">{lastAnalysis.winRate.toFixed(1)}%</span>
                      </div>
                      {Math.abs(lastAnalysis.scoreLead) > 0.05 && (
                        <div className="flex justify-between">
                          <span className="text-gray-600">黑方领先</span>
                          <span className="font-mono">{lastAnalysis.scoreLead.toFixed(1)}目</span>
                        </div>
                      )}
                      {lastAnalysis.actualVisits && (
                        <div className="flex justify-between">
                          <span className="text-gray-600">搜索量</span>
                          <span className="font-mono">{lastAnalysis.actualVisits}</span>
                        </div>
                      )}
                      {lastAnalysis.bestMoves && lastAnalysis.bestMoves.length > 0 && (
                        <div className="mt-1">
                          <span className="text-gray-600 text-xs">推荐:</span>
                          <div className="text-xs font-mono text-blue-600">
                            {lastAnalysis.bestMoves.slice(0, 5).map((bm, i) => (
                              <span key={i} className="mr-2">{bm.move}(黑胜率:{bm.winrate.toFixed(0)}%)</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Center: Board */}
            <div className="flex flex-col items-center">
              <div className="bg-white rounded-lg shadow p-4">
                <svg viewBox={`0 0 ${boardPx} ${boardPx}`} className="border border-amber-300 rounded" style={{ width: boardPx, maxWidth: '100%', height: 'auto' }}>
                  <defs>
                    <linearGradient id="aiBoardBg" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#dcb35c" />
                      <stop offset="100%" stopColor="#c49a2f" />
                    </linearGradient>
                    <radialGradient id="aiBlackStone" cx="35%" cy="35%">
                      <stop offset="0%" stopColor="#555" />
                      <stop offset="100%" stopColor="#111" />
                    </radialGradient>
                    <radialGradient id="aiWhiteStone" cx="35%" cy="35%">
                      <stop offset="0%" stopColor="#fff" />
                      <stop offset="100%" stopColor="#ccc" />
                    </radialGradient>
                  </defs>
                  <rect width={boardPx} height={boardPx} fill="url(#aiBoardBg)" />
                  {/* Grid lines */}
                  {Array.from({ length: boardSize }, (_, i) => (
                    <g key={`line-${i}`}>
                      <line x1={padding + i * baseCellSize} y1={padding} x2={padding + i * baseCellSize} y2={padding + (boardSize - 1) * baseCellSize} stroke="#8b6914" strokeWidth="0.5" />
                      <line x1={padding} y1={padding + i * baseCellSize} x2={padding + (boardSize - 1) * baseCellSize} y2={padding + i * baseCellSize} stroke="#8b6914" strokeWidth="0.5" />
                    </g>
                  ))}
                  {/* Star points */}
                  {starPoints.map(([r, c]) => (
                    <circle key={`sp-${r}-${c}`} cx={padding + c * baseCellSize} cy={padding + r * baseCellSize} r={baseCellSize * 0.1} fill="#8b6914" />
                  ))}
                  {/* Column labels */}
                  {Array.from({ length: boardSize }, (_, i) => (
                    <text key={`col-${i}`} x={padding + i * baseCellSize} y={padding * 0.5} textAnchor="middle" fontSize={baseCellSize * 0.35} fill="#8b6914">{COL_LABELS[i]}</text>
                  ))}
                  {/* Row labels */}
                  {Array.from({ length: boardSize }, (_, i) => (
                    <text key={`row-${i}`} x={padding * 0.35} y={padding + (boardSize - 1 - i) * baseCellSize + baseCellSize * 0.12} textAnchor="middle" fontSize={baseCellSize * 0.35} fill="#8b6914">{i + 1}</text>
                  ))}
                  {/* Hint position marker */}
                  {hintPosition && (
                    <rect
                      x={padding + hintPosition.col * baseCellSize - baseCellSize * 0.4}
                      y={padding + hintPosition.row * baseCellSize - baseCellSize * 0.4}
                      width={baseCellSize * 0.8}
                      height={baseCellSize * 0.8}
                      fill="rgba(34,197,94,0.3)"
                      stroke="#22c55e"
                      strokeWidth="2"
                      rx="4"
                    />
                  )}
                  {/* Stones */}
                  {board.map((row: Board[number], r: number) => row.map((cell: Stone, c: number) => cell !== null && (
                    <g key={`s-${r}-${c}`}>
                      <circle
                        cx={padding + c * baseCellSize}
                        cy={padding + r * baseCellSize}
                        r={baseCellSize * 0.43}
                        fill={cell === 'black' ? 'url(#aiBlackStone)' : 'url(#aiWhiteStone)'}
                        stroke={cell === 'white' ? '#999' : '#000'}
                        strokeWidth="0.5"
                      />
                      {/* Last move marker */}
                      {lastMove && lastMove.row === r && lastMove.col === c && (
                        <circle
                          cx={padding + c * baseCellSize}
                          cy={padding + r * baseCellSize}
                          r={baseCellSize * 0.12}
                          fill={cell === 'black' ? '#fff' : '#000'}
                        />
                      )}
                    </g>
                  )))}
                </svg>
              </div>
              {running && (
                <div className="mt-2 text-center">
                  <p className="text-sm text-amber-700">
                    {paused ? '⏸ 已暂停' : `▶ 第${currentStep}步 运行中...`}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    KataGo建议: 使用{usedHintCount}次 / 未用{missedHintCount}次
                  </p>
                </div>
              )}
            </div>

            {/* Right: Logs */}
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-amber-800">运行日志</h2>
                <div className="flex gap-2">
                  <button
                    onClick={exportLogs}
                    className="text-xs text-blue-500 hover:text-blue-700"
                  >
                    导出日志
                  </button>
                  <button
                    onClick={() => setLogs([])}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    清空
                  </button>
                </div>
              </div>
              <div className="h-[500px] overflow-y-auto space-y-0.5 font-mono text-xs">
                {logs.map((log, idx) => (
                  <div
                    key={idx}
                    className={
                      log.type === 'error' ? 'text-red-600' :
                      log.type === 'success' ? 'text-green-600' :
                      log.type === 'warn' ? 'text-orange-500' :
                      'text-gray-600'
                    }
                  >
                    <span className="text-gray-400">{log.time}</span> {log.message}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>
        )}

        {/* Load Game Dialog */}
        {showLoadDialog && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[70vh] flex flex-col">
              <div className="flex items-center justify-between p-4 border-b">
                <h3 className="font-semibold text-amber-800">加载棋局</h3>
                <button onClick={() => setShowLoadDialog(false)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {savedGames.length === 0 ? (
                  <p className="text-center text-gray-400 text-sm py-8">没有已保存的棋局</p>
                ) : (
                  <div className="space-y-2">
                    {savedGames.map(g => (
                      <div key={g.id} className="flex items-center justify-between p-2 border rounded-lg hover:bg-gray-50">
                        <button
                          onClick={() => loadGame(g.id)}
                          className="flex-1 text-left"
                        >
                          <p className="text-sm font-medium">{g.title || `棋局 #${g.id}`}</p>
                          <p className="text-xs text-gray-500">
                            {g.board_size}路 {g.engine} {g.status === 'finished' ? '已结束' : '进行中'} {g.created_at ? new Date(g.created_at).toLocaleDateString('zh-CN') : ''}
                          </p>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteGame(g.id); }}
                          className="text-red-400 hover:text-red-600 text-xs ml-2"
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
