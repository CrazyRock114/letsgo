'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { createEmptyBoard, isValidMove, playMove, checkGameEnd, evaluateBoard, findBestHint } from '@/lib/go-logic';
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

function stoneToColor(stone: Stone): 'black' | 'white' | null {
  return stone;
}

export default function AITestPage() {
  const [token, setToken] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [points, setPoints] = useState(0);
  const [loggedIn, setLoggedIn] = useState(false);
  const [boardSize, setBoardSize] = useState<9 | 13 | 19>(9);
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [engine, setEngine] = useState<EngineId>('gnugo');
  const [playerColor, setPlayerColor] = useState<'black' | 'white'>('black');
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stepInterval, setStepInterval] = useState(5000);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [totalGames, setTotalGames] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [lastAnalysis, setLastAnalysis] = useState<AnalysisData | null>(null);
  const [board, setBoard] = useState<Board>(createEmptyBoard(9));

  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    const time = new Date().toLocaleTimeString('zh-CN');
    setLogs(prev => [...prev.slice(-500), { time, type, message }]);
  }, []);

  // Login
  const handleLogin = useCallback(async () => {
    try {
      let res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: AI_TEST_USER, password: AI_TEST_PASS }),
      });
      let data = await res.json();
      if (!res.ok && data.error?.includes('已存在')) {
        res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname: AI_TEST_USER, password: AI_TEST_PASS }),
        });
        data = await res.json();
      }
      if (data.token) {
        setToken(data.token);
        setUserId(data.user.id);
        setPoints(data.user.points);
        setLoggedIn(true);
        addLog('success', `登录成功，积分: ${data.user.points}`);
      } else {
        addLog('error', `登录失败: ${data.error}`);
      }
    } catch (err) {
      addLog('error', `登录异常: ${err}`);
    }
  }, [addLog]);

  // Convert moves to API format (color number: 1=black, 2=white)
  const movesToApi = useCallback((moves: Array<{ row: number; col: number; color: Stone }>) => {
    return moves.map(m => ({
      row: m.row,
      col: m.col,
      color: m.color === 'black' ? 1 : 2,
    }));
  }, []);

  // Get AI move from engine
  const getAIMove = useCallback(async (
    moves: Array<{ row: number; col: number; color: Stone }>,
    bSize: number,
    diff: Difficulty,
    eng: EngineId,
    tok: string
  ): Promise<{ move: { row: number; col: number } | null; pass?: boolean; analysis?: AnalysisData | null; error?: string }> => {
    try {
      const res = await fetch('/api/go-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ boardSize: bSize, difficulty: diff, engine: eng, moves: movesToApi(moves) }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await res.json();
      if (data.error) return { move: null, error: data.error };
      return { move: data.move, pass: data.pass, analysis: data.analysis };
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
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json();
      if (data.analysis) return data.analysis;
      if (data.queueBusy) {
        addLog('warn', `分析排队拒绝: 队列${data.queueLength}人`);
      }
      return null;
    } catch {
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
    // Random valid move
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

    const abortController = new AbortController();
    abortRef.current = abortController;

    let gameCount = 0;
    let totalStepCount = 0;

    while (runningRef.current) {
      gameCount++;
      setTotalGames(gameCount);
      addLog('info', `===== 第${gameCount}局开始 ${boardSize}路 ${difficulty} ${engine} =====`);

      let currentBoard = createEmptyBoard(boardSize);
      setBoard([...currentBoard.map(r => [...r])]);
      const moves: Array<{ row: number; col: number; color: Stone }> = [];
      let currentPlayer: Stone = 'black';
      let consecutivePasses = 0;
      let stepCount = 0;
      const aiColor: Stone = playerColor === 'black' ? 'white' : 'black';

      // If player is white, AI (black) goes first
      if (playerColor === 'white') {
        addLog('info', `玩家执白，AI(黑)先手`);
        const aiResult = await getAIMove(moves, boardSize, difficulty, engine, token);
        if (abortController.signal.aborted) break;
        if (aiResult.move) {
          moves.push({ row: aiResult.move.row, col: aiResult.move.col, color: 'black' });
          const result = playMove(currentBoard, aiResult.move.row, aiResult.move.col, 'black');
          currentBoard = result.newBoard;
          setBoard([...currentBoard.map(r => [...r])]);
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

          // Get analysis for hint
          let hint: { row: number; col: number } | null = null;
          const analysis = await getAnalysis(moves, boardSize, token);
          if (analysis) {
            setLastAnalysis(analysis);
            hint = getHintFromAnalysis(analysis, boardSize);
            if (hint) {
              addLog('success', `  KataGo建议: (${hint.row},${hint.col}) 胜率=${analysis.winRate.toFixed(1)} 领先=${analysis.scoreLead.toFixed(1)}`);
            }
          }

          // Use hint or fallback
          let move = hint;
          if (!move) {
            move = findFallbackMove(currentBoard, playerColor);
          }

          if (move && isValidMove(currentBoard, move.row, move.col, playerColor)) {
            moves.push({ row: move.row, col: move.col, color: playerColor });
            const result = playMove(currentBoard, move.row, move.col, playerColor);
            currentBoard = result.newBoard;
            setBoard([...currentBoard.map(r => [...r])]);
            consecutivePasses = 0;
            stepCount++;
            totalStepCount++;
            setCurrentStep(stepCount);
            setTotalSteps(totalStepCount);
            addLog('info', `  落子: (${move.row},${move.col})`);
          } else {
            addLog('warn', `  无合法落子，停手`);
            consecutivePasses++;
          }
        } else {
          addLog('info', `第${stepCount + 1}步: AI(${aiColor === 'black' ? '黑' : '白'})思考中...`);
          const aiResult = await getAIMove(moves, boardSize, difficulty, engine, token);
          if (abortController.signal.aborted) break;

          if (aiResult.error) {
            addLog('error', `  AI错误: ${aiResult.error}`);
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }

          if (aiResult.move) {
            moves.push({ row: aiResult.move.row, col: aiResult.move.col, color: aiColor });
            const result = playMove(currentBoard, aiResult.move.row, aiResult.move.col, aiColor);
            currentBoard = result.newBoard;
            setBoard([...currentBoard.map(r => [...r])]);
            consecutivePasses = 0;
            stepCount++;
            totalStepCount++;
            setCurrentStep(stepCount);
            setTotalSteps(totalStepCount);
            addLog('info', `  AI落子: (${aiResult.move.row},${aiResult.move.col})`);
            if (aiResult.analysis) {
              setLastAnalysis(aiResult.analysis);
            }
          } else if (aiResult.pass) {
            consecutivePasses++;
            addLog('info', `  AI停手`);
          }
        }

        // Check game end
        const endCheck = checkGameEnd(currentBoard, consecutivePasses, stepCount);
        if (endCheck.ended) {
          const eval_ = evaluateBoard(currentBoard);
          addLog('info', `===== 第${gameCount}局结束: ${endCheck.reason} =====`);
          addLog('info', `  黑${eval_.black}目 vs 白${eval_.white}目`);
          break;
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
  }, [token, userId, boardSize, difficulty, engine, playerColor, stepInterval, addLog, getAIMove, getAnalysis, getHintFromAnalysis, findFallbackMove]);

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

  // Render mini board
  const renderMiniBoard = () => {
    const cellSize = boardSize <= 9 ? 28 : boardSize <= 13 ? 22 : 16;
    const padding = cellSize;
    const boardPx = cellSize * (boardSize - 1) + padding * 2;

    return (
      <svg width={boardPx} height={boardPx} className="border border-amber-300 rounded">
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
        {Array.from({ length: boardSize }, (_, i) => (
          <g key={i}>
            <line x1={padding + i * cellSize} y1={padding} x2={padding + i * cellSize} y2={padding + (boardSize - 1) * cellSize} stroke="#8b6914" strokeWidth="0.5" />
            <line x1={padding} y1={padding + i * cellSize} x2={padding + (boardSize - 1) * cellSize} y2={padding + i * cellSize} stroke="#8b6914" strokeWidth="0.5" />
          </g>
        ))}
        {board.map((row: Board[number], r: number) => row.map((cell: Stone, c: number) => cell !== null && (
          <circle
            key={`s-${r}-${c}`}
            cx={padding + c * cellSize}
            cy={padding + r * cellSize}
            r={cellSize * 0.43}
            fill={cell === 'black' ? 'url(#aiBlackStone)' : 'url(#aiWhiteStone)'}
            stroke={cell === 'white' ? '#999' : '#000'}
            strokeWidth="0.5"
          />
        )))}
      </svg>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-50 p-4">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-amber-800 mb-4">AI模拟实战测试</h1>

        {!loggedIn ? (
          <div className="bg-white rounded-lg shadow p-6 text-center">
            <p className="text-gray-600 mb-4">请先登录AI测试账号</p>
            <button
              onClick={handleLogin}
              className="px-6 py-2 bg-amber-700 text-white rounded-lg hover:bg-amber-800"
            >
              登录 AItest
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
                      <option value={2000}>2秒</option>
                      <option value={3000}>3秒</option>
                      <option value={5000}>5秒</option>
                      <option value={10000}>10秒</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-4">
                <h2 className="font-semibold text-amber-800 mb-3">控制</h2>
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
                  {lastAnalysis && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-600">黑方胜率</span>
                        <span className="font-mono">{lastAnalysis.winRate.toFixed(1)}%</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">黑方领先</span>
                        <span className="font-mono">{lastAnalysis.scoreLead.toFixed(1)}目</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Center: Board */}
            <div className="flex flex-col items-center">
              <div className="bg-white rounded-lg shadow p-4">
                {renderMiniBoard()}
              </div>
              {running && (
                <div className="mt-2 text-center">
                  <p className="text-sm text-amber-700">
                    {paused ? '已暂停' : `第${currentStep}步 运行中...`}
                  </p>
                </div>
              )}
            </div>

            {/* Right: Logs */}
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-amber-800">运行日志</h2>
                <button
                  onClick={() => setLogs([])}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  清空
                </button>
              </div>
              <div className="h-[500px] overflow-y-auto space-y-0.5 font-mono text-xs">
                {logs.map((log, idx) => (
                  <div
                    key={idx}
                    className={
                      log.type === 'error' ? 'text-red-600' :
                      log.type === 'success' ? 'text-green-600' :
                      log.type === 'warn' ? 'text-yellow-600' :
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
      </div>
    </div>
  );
}
