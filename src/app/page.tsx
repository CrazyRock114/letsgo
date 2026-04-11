'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  createEmptyBoard,
  playMove,
  isValidMove,
  positionToCoordinate,
  evaluateBoard,
  getValidMoves,
  type Stone,
  type Board,
  type Position,
} from '@/lib/go-logic';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  RotateCcw,
  HelpCircle,
  BookOpen,
  Play,
  MessageCircle,
  Lightbulb,
  Trophy,
  Send,
} from 'lucide-react';

// 棋盘尺寸选项
const BOARD_SIZES = [
  { size: 9, label: '9路', desc: '初学入门' },
  { size: 13, label: '13路', desc: '进阶练习' },
  { size: 19, label: '19路', desc: '正式对局' },
] as const;

// 围棋坐标字母（跳过I）
const COL_LABELS = 'ABCDEFGHJKLMNOPQRST';

// 星位坐标
function getStarPoints(boardSize: number): [number, number][] {
  if (boardSize === 9) {
    return [[2, 2], [2, 6], [4, 4], [6, 2], [6, 6]];
  }
  if (boardSize === 13) {
    return [[3, 3], [3, 9], [6, 6], [9, 3], [9, 9], [3, 6], [6, 3], [6, 9], [9, 6]];
  }
  if (boardSize === 19) {
    return [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]];
  }
  return [];
}

// 流式读取工具
async function readStream(
  response: Response,
  onChunk: (text: string) => void
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    full += text;
    onChunk(full);
  }
  return full;
}

export default function GoGamePage() {
  // ===== 游戏状态 =====
  const [boardSize, setBoardSize] = useState(9);
  const [board, setBoard] = useState<Board>(() => createEmptyBoard(9));
  const [currentPlayer, setCurrentPlayer] = useState<Stone>('black');
  const [history, setHistory] = useState<Array<{ position: Position; color: Stone; captured: number }>>([]);
  const [lastMove, setLastMove] = useState<Position | null>(null);
  const [showHint, setShowHint] = useState<Position | null>(null);
  const [score, setScore] = useState({ black: 0, white: 0 });
  const [isAIThinking, setIsAIThinking] = useState(false);

  // ===== AI解说 =====
  const [moveCommentary, setMoveCommentary] = useState<string>('');
  const [isCommentaryStreaming, setIsCommentaryStreaming] = useState(false);

  // ===== AI教学 =====
  const [teachingMessage, setTeachingMessage] = useState<string>('');
  const [isTeachStreaming, setIsTeachStreaming] = useState(false);

  // ===== 聊天 =====
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ===== 学习模式 =====
  const [lessonStep, setLessonStep] = useState(0);

  // 计算比分
  useEffect(() => {
    setScore(evaluateBoard(board));
  }, [board]);

  // 聊天自动滚到底部
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ===== 切换棋盘大小 =====
  const changeBoardSize = useCallback((newSize: number) => {
    setBoardSize(newSize);
    setBoard(createEmptyBoard(newSize));
    setCurrentPlayer('black');
    setHistory([]);
    setLastMove(null);
    setShowHint(null);
    setMoveCommentary('');
    setTeachingMessage('');
    setLessonStep(0);
  }, []);

  // ===== 请求AI解说 =====
  const requestCommentary = useCallback(async (
    newBoard: Board,
    movePos: Position,
    moveColor: Stone,
    capturedCount: number
  ) => {
    setIsCommentaryStreaming(true);
    setMoveCommentary('');
    try {
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'commentary',
          board: newBoard,
          currentPlayer: moveColor === 'black' ? 'white' : 'black',
          lastMove: movePos,
          moveColor,
          captured: capturedCount,
        }),
      });
      if (response.ok) {
        await readStream(response, (text) => setMoveCommentary(text));
      }
    } catch {
      setMoveCommentary('这步棋下得不错！');
    } finally {
      setIsCommentaryStreaming(false);
    }
  }, []);

  // ===== 处理落子 =====
  const handleMove = useCallback(async (row: number, col: number) => {
    if (!isValidMove(board, row, col, currentPlayer) || isAIThinking) return;

    const { newBoard, captured } = playMove(board, row, col, currentPlayer);
    setBoard(newBoard);
    setLastMove({ row, col });
    setHistory((prev) => [...prev, { position: { row, col }, color: currentPlayer, captured }]);
    setShowHint(null);

    // 请求这步棋的解说
    requestCommentary(newBoard, { row, col }, currentPlayer, captured);

    // AI回合（白棋）
    if (currentPlayer === 'black') {
      setIsAIThinking(true);
      await new Promise((r) => setTimeout(r, 600));

      // 简单AI：随机选择合法位置
      const validMoves = getValidMoves(newBoard, 'white');
      if (validMoves.length > 0) {
        // 加权随机：优先角和边
        let aiMove: Position;
        const cornerMoves = validMoves.filter(
          (m) => (m.row <= 2 || m.row >= boardSize - 3) && (m.col <= 2 || m.col >= boardSize - 3)
        );
        const edgeMoves = validMoves.filter(
          (m) => m.row <= 1 || m.row >= boardSize - 2 || m.col <= 1 || m.col >= boardSize - 2
        );

        if (cornerMoves.length > 0 && Math.random() < 0.5) {
          aiMove = cornerMoves[Math.floor(Math.random() * cornerMoves.length)];
        } else if (edgeMoves.length > 0 && Math.random() < 0.4) {
          aiMove = edgeMoves[Math.floor(Math.random() * edgeMoves.length)];
        } else {
          aiMove = validMoves[Math.floor(Math.random() * validMoves.length)];
        }

        const { newBoard: finalBoard, captured: aiCaptured } = playMove(newBoard, aiMove.row, aiMove.col, 'white');
        setBoard(finalBoard);
        setLastMove({ row: aiMove.row, col: aiMove.col });
        setHistory((prev) => [...prev, { position: aiMove, color: 'white', captured: aiCaptured }]);

        // AI落子解说
        requestCommentary(finalBoard, aiMove, 'white', aiCaptured);
      }

      setCurrentPlayer('black');
      setIsAIThinking(false);
    }
  }, [board, currentPlayer, isAIThinking, boardSize, requestCommentary]);

  // ===== 悔棋 =====
  const undoMove = useCallback(() => {
    if (history.length === 0) return;
    const stepsToUndo = history.length >= 2 ? 2 : 1;
    const newHistory = history.slice(0, -stepsToUndo);

    let newBoard = createEmptyBoard(boardSize);
    for (const move of newHistory) {
      const result = playMove(newBoard, move.position.row, move.position.col, move.color);
      newBoard = result.newBoard;
    }

    setBoard(newBoard);
    setHistory(newHistory);
    setCurrentPlayer('black');
    setLastMove(newHistory.length > 0 ? newHistory[newHistory.length - 1].position : null);
    setMoveCommentary('');
  }, [history, boardSize]);

  // ===== 重新开始 =====
  const restartGame = useCallback(() => {
    setBoard(createEmptyBoard(boardSize));
    setCurrentPlayer('black');
    setHistory([]);
    setLastMove(null);
    setShowHint(null);
    setMoveCommentary('');
    setTeachingMessage('');
    setLessonStep(0);
  }, [boardSize]);

  // ===== 提示 =====
  const showHintFn = useCallback(() => {
    const validMoves = getValidMoves(board, currentPlayer);
    if (validMoves.length === 0) return;
    // 优先角部提示
    const corners = validMoves.filter(
      (m) => (m.row <= 2 || m.row >= boardSize - 3) && (m.col <= 2 || m.col >= boardSize - 3)
    );
    const hint = corners.length > 0
      ? corners[Math.floor(Math.random() * corners.length)]
      : validMoves[Math.floor(Math.random() * validMoves.length)];
    setShowHint(hint);
    setTimeout(() => setShowHint(null), 3000);
  }, [board, currentPlayer, boardSize]);

  // ===== AI教学 =====
  const getTeaching = useCallback(async () => {
    if (isTeachStreaming) return;
    setIsTeachStreaming(true);
    setTeachingMessage('');
    try {
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'teach',
          board,
          currentPlayer,
          lastMove: lastMove ? { row: lastMove.row, col: lastMove.col } : undefined,
        }),
      });
      if (response.ok) {
        await readStream(response, (text) => setTeachingMessage(text));
      }
    } catch {
      setTeachingMessage('小围棋正在思考中...');
    } finally {
      setIsTeachStreaming(false);
    }
  }, [board, currentPlayer, lastMove, isTeachStreaming]);

  // ===== 聊天（结合棋局） =====
  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || isChatStreaming) return;
    const userMsg = inputMessage.trim();
    setInputMessage('');
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);
    setIsChatStreaming(true);

    try {
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'chat',
          board,
          currentPlayer,
          lastMove: lastMove ? { row: lastMove.row, col: lastMove.col } : undefined,
          question: userMsg,
        }),
      });
      if (response.ok) {
        setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
        await readStream(response, (text) => {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: text };
            return updated;
          });
        });
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: '抱歉，我遇到了一点问题，请再试一次。' }]);
    } finally {
      setIsChatStreaming(false);
    }
  }, [inputMessage, isChatStreaming, board, currentPlayer, lastMove]);

  // ===== SVG棋盘渲染 =====
  const renderSVGBoard = () => {
    const size = boardSize;
    // 动态计算格子大小
    const cellSize = size <= 9 ? 44 : size <= 13 ? 34 : 26;
    const padding = cellSize;
    const stoneRadius = cellSize * 0.44;
    const boardPx = cellSize * (size - 1) + padding * 2;
    const starPts = getStarPoints(size);

    return (
      <svg
        width={boardPx}
        height={boardPx}
        viewBox={`0 0 ${boardPx} ${boardPx}`}
        className="max-w-full h-auto"
        style={{ filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.18))' }}
      >
        {/* 棋盘木纹背景 */}
        <defs>
          <radialGradient id="bgGrad" cx="50%" cy="50%">
            <stop offset="0%" stopColor="#dcb87a" />
            <stop offset="100%" stopColor="#c4a06a" />
          </radialGradient>
          <radialGradient id="blackStone" cx="35%" cy="30%">
            <stop offset="0%" stopColor="#666" />
            <stop offset="50%" stopColor="#333" />
            <stop offset="100%" stopColor="#111" />
          </radialGradient>
          <radialGradient id="whiteStone" cx="35%" cy="30%">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="80%" stopColor="#e8e8e8" />
            <stop offset="100%" stopColor="#d0d0d0" />
          </radialGradient>
          <filter id="stoneShadow">
            <feDropShadow dx="1" dy="1" stdDeviation="1.5" floodOpacity="0.3" />
          </filter>
        </defs>

        {/* 背景 */}
        <rect width={boardPx} height={boardPx} rx="6" fill="url(#bgGrad)" />

        {/* 网格线 */}
        {Array.from({ length: size }, (_, i) => (
          <g key={`line-${i}`}>
            <line
              x1={padding} y1={padding + i * cellSize}
              x2={padding + (size - 1) * cellSize} y2={padding + i * cellSize}
              stroke="#6b5a3e" strokeWidth={size >= 19 ? 0.7 : 1}
            />
            <line
              x1={padding + i * cellSize} y1={padding}
              x2={padding + i * cellSize} y2={padding + (size - 1) * cellSize}
              stroke="#6b5a3e" strokeWidth={size >= 19 ? 0.7 : 1}
            />
          </g>
        ))}

        {/* 边框加粗 */}
        <rect
          x={padding} y={padding}
          width={(size - 1) * cellSize} height={(size - 1) * cellSize}
          fill="none" stroke="#5a4a3a" strokeWidth={size >= 19 ? 1.5 : 2}
        />

        {/* 星位 */}
        {starPts.map(([r, c]) => (
          <circle
            key={`star-${r}-${c}`}
            cx={padding + c * cellSize} cy={padding + r * cellSize}
            r={size >= 19 ? 3 : 4}
            fill="#5a4a3a"
          />
        ))}

        {/* 坐标标签 */}
        {Array.from({ length: size }, (_, i) => (
          <g key={`label-${i}`}>
            {/* 列标签 - 上方 */}
            <text
              x={padding + i * cellSize} y={padding - cellSize * 0.4}
              textAnchor="middle" fontSize={size >= 19 ? 9 : 11}
              fill="#8b7355" fontFamily="sans-serif"
            >
              {COL_LABELS[i]}
            </text>
            {/* 行标签 - 左侧 */}
            <text
              x={padding - cellSize * 0.4} y={padding + i * cellSize + 4}
              textAnchor="middle" fontSize={size >= 19 ? 9 : 11}
              fill="#8b7355" fontFamily="sans-serif"
            >
              {size - i}
            </text>
          </g>
        ))}

        {/* 棋子 */}
        {board.map((row, r) =>
          row.map((stone, c) => {
            if (!stone) return null;
            const isLast = lastMove?.row === r && lastMove?.col === c;
            return (
              <g key={`s-${r}-${c}`} filter="url(#stoneShadow)">
                <circle
                  cx={padding + c * cellSize}
                  cy={padding + r * cellSize}
                  r={stoneRadius}
                  fill={stone === 'black' ? 'url(#blackStone)' : 'url(#whiteStone)'}
                  stroke={stone === 'white' ? '#bbb' : 'none'}
                  strokeWidth={0.5}
                />
                {/* 最后一手标记 */}
                {isLast && (
                  <circle
                    cx={padding + c * cellSize}
                    cy={padding + r * cellSize}
                    r={stoneRadius * 0.28}
                    fill={stone === 'black' ? '#fff' : '#333'}
                  />
                )}
              </g>
            );
          })
        )}

        {/* 提示标记 */}
        {showHint && !board[showHint.row][showHint.col] && (
          <circle
            cx={padding + showHint.col * cellSize}
            cy={padding + showHint.row * cellSize}
            r={stoneRadius}
            fill="rgba(59, 130, 246, 0.25)"
            stroke="rgba(59, 130, 246, 0.6)"
            strokeWidth={2}
          >
            <animate attributeName="opacity" values="0.4;0.8;0.4" dur="1.5s" repeatCount="indefinite" />
          </circle>
        )}

        {/* 可点击区域（透明覆盖） */}
        {!isAIThinking && board.map((row, r) =>
          row.map((stone, c) => {
            if (stone) return null;
            return (
              <circle
                key={`c-${r}-${c}`}
                cx={padding + c * cellSize}
                cy={padding + r * cellSize}
                r={stoneRadius}
                fill="transparent"
                cursor="pointer"
                onClick={() => handleMove(r, c)}
              >
                <animate
                  attributeName="r"
                  from={stoneRadius * 0.8}
                  to={stoneRadius}
                  dur="0.15s"
                  begin="mouseover"
                  fill="freeze"
                />
              </circle>
            );
          })
        )}

        {/* 悬停预览（半透明棋子）- 由CSS hover处理 */}
      </svg>
    );
  };

  // 围棋规则教程
  const lessons = [
    { title: '认识棋盘', content: '围棋棋盘由横竖线交叉组成，标准棋盘是19x19路。棋子要下在线的交叉点上，不是格子里面哦！我们先用9路小棋盘来练习。' },
    { title: '认识棋子', content: '围棋有黑白两色棋子，黑棋先走。双方轮流在交叉点上放一颗棋子，棋子一旦放下就不能再移动了。' },
    { title: '什么是"气"？', content: '每颗棋子旁边上下左右的空交叉点就是它的"气"。中间的棋子有4口气，边上的3口气，角落的2口气。气就像棋子的呼吸！' },
    { title: '如何吃子', content: '当一颗棋子所有的气都被对方堵住，它就"没气"了，会被从棋盘上拿走，这就叫"提子"。就像把对方包围起来！' },
    { title: '围地获胜', content: '围棋的目的是围住更多的地盘。用你的棋子围住空交叉点，谁围的地盘大谁就赢！记住：金角银边草肚皮，先占角，再占边！' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-amber-100 via-amber-50 to-orange-50">
      {/* 头部 */}
      <header className="text-center py-4 px-4">
        <h1 className="text-3xl sm:text-4xl font-bold text-amber-800 flex items-center justify-center gap-2">
          <span className="inline-block w-8 h-8 rounded-full bg-gray-800 shadow" />
          小围棋乐园
          <span className="inline-block w-8 h-8 rounded-full bg-white border-2 border-gray-300 shadow" />
        </h1>
        <p className="text-amber-600 mt-1 text-sm">和AI一起学围棋，下棋真快乐！</p>

        {/* 棋盘尺寸选择 */}
        <div className="flex items-center justify-center gap-2 mt-3">
          <span className="text-sm text-amber-700 font-medium">棋盘大小：</span>
          {BOARD_SIZES.map(({ size, label, desc }) => (
            <Button
              key={size}
              size="sm"
              variant={boardSize === size ? 'default' : 'outline'}
              onClick={() => changeBoardSize(size)}
              className={boardSize === size ? 'bg-amber-700 hover:bg-amber-800' : 'border-amber-300 text-amber-700'}
            >
              {label}
              <span className="ml-1 text-xs opacity-70">{desc}</span>
            </Button>
          ))}
        </div>
      </header>

      {/* 主内容 */}
      <div className="max-w-7xl mx-auto px-4 pb-8 grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 左侧面板 */}
        <div className="lg:col-span-3 space-y-4">
          {/* 比分 */}
          <Card className="bg-white/90 shadow-lg">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Trophy className="w-4 h-4 text-amber-500" /> 当前局面
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex justify-around text-center">
                <div className="flex flex-col items-center">
                  <div className="w-8 h-8 rounded-full bg-gray-800 shadow mb-1" />
                  <span className="text-xs text-gray-500">黑方(你)</span>
                  <span className="text-xl font-bold">{score.black}</span>
                </div>
                <div className="flex items-center text-gray-300 text-sm">VS</div>
                <div className="flex flex-col items-center">
                  <div className="w-8 h-8 rounded-full bg-white border-2 border-gray-300 shadow mb-1" />
                  <span className="text-xs text-gray-500">白方(AI)</span>
                  <span className="text-xl font-bold">{score.white}</span>
                </div>
              </div>
              <div className="mt-3 text-center">
                <Badge variant={currentPlayer === 'black' ? 'default' : 'secondary'} className="text-xs px-3">
                  {isAIThinking ? 'AI思考中...' : currentPlayer === 'black' ? '轮到你落子' : '白方回合'}
                  {isAIThinking && <Spinner className="w-3 h-3 ml-1 inline" />}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* 控制按钮 */}
          <Card className="bg-white/90 shadow-lg">
            <CardContent className="pt-4 grid grid-cols-2 gap-2">
              <Button onClick={restartGame} variant="outline" size="sm" className="gap-1">
                <RotateCcw className="w-3 h-3" /> 重新开始
              </Button>
              <Button onClick={undoMove} variant="outline" size="sm" className="gap-1" disabled={history.length === 0}>
                <RotateCcw className="w-3 h-3" /> 悔棋
              </Button>
              <Button onClick={showHintFn} variant="secondary" size="sm" className="gap-1">
                <Lightbulb className="w-3 h-3" /> 提示
              </Button>
              <Button onClick={getTeaching} variant="secondary" size="sm" className="gap-1" disabled={isTeachStreaming}>
                <HelpCircle className="w-3 h-3" /> 教学
              </Button>
            </CardContent>
          </Card>

          {/* 学习步骤 */}
          <Card className="bg-white/90 shadow-lg">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-blue-500" /> 围棋入门
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-medium text-amber-800 mb-1">{lessons[lessonStep].title}</p>
              <p className="text-xs text-gray-600 leading-relaxed">{lessons[lessonStep].content}</p>
              <div className="flex justify-between mt-3">
                <Button size="sm" variant="outline" onClick={() => setLessonStep(Math.max(0, lessonStep - 1))} disabled={lessonStep === 0}>
                  上一步
                </Button>
                <span className="text-xs text-gray-400 self-center">{lessonStep + 1}/{lessons.length}</span>
                <Button size="sm" variant="default" onClick={() => setLessonStep(Math.min(lessons.length - 1, lessonStep + 1))} disabled={lessonStep === lessons.length - 1}>
                  下一步
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* AI教学反馈 */}
          {teachingMessage && (
            <Card className="bg-gradient-to-br from-blue-50 to-purple-50 border-blue-200">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm flex items-center gap-1 text-blue-700">
                  <MessageCircle className="w-4 h-4" /> 小围棋说
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">{teachingMessage}</p>
                {isTeachStreaming && <Spinner className="w-3 h-3 mt-1" />}
              </CardContent>
            </Card>
          )}
        </div>

        {/* 棋盘区域 */}
        <div className="lg:col-span-5 flex flex-col items-center">
          <div className="overflow-x-auto w-full flex justify-center">
            {renderSVGBoard()}
          </div>

          {/* 每步棋解说 */}
          <Card className="w-full mt-3 bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200">
            <CardContent className="py-3 px-4">
              <div className="flex items-start gap-2">
                <Play className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="min-h-[2rem]">
                  {lastMove && (
                    <span className="text-xs text-amber-600 font-medium">
                      {board[lastMove.row][lastMove.col] === 'black' ? '黑' : '白'}方 {positionToCoordinate(lastMove.row, lastMove.col)} -{' '}
                    </span>
                  )}
                  {isCommentaryStreaming && !moveCommentary ? (
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <Spinner className="w-3 h-3" /> AI正在解说...
                    </span>
                  ) : (
                    <span className="text-sm text-gray-700">{moveCommentary || '点击棋盘交叉点开始落子'}</span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右侧聊天面板 */}
        <div className="lg:col-span-4">
          <Card className="bg-white/95 shadow-lg h-full flex flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-purple-500" /> 问我围棋问题
              </CardTitle>
              <p className="text-xs text-gray-400">我会结合当前棋局来回答你</p>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col pt-0">
              <ScrollArea className="flex-1 h-[400px] lg:h-[500px] mb-3">
                <div className="space-y-3 pr-2">
                  {messages.length === 0 && (
                    <div className="text-center text-gray-300 text-sm py-8">
                      <p>试试问我：</p>
                      <p className="mt-1">&ldquo;我现在应该下在哪里？&rdquo;</p>
                      <p>&ldquo;这步棋是什么意思？&rdquo;</p>
                      <p>&ldquo;怎么才能吃掉对方的棋子？&rdquo;</p>
                    </div>
                  )}
                  {messages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                          msg.role === 'user'
                            ? 'bg-purple-500 text-white rounded-br-sm'
                            : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                        }`}
                      >
                        {msg.content || (
                          <span className="flex items-center gap-1">
                            <Spinner className="w-3 h-3" /> 思考中...
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
              </ScrollArea>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !isChatStreaming && sendMessage()}
                  placeholder="问我关于围棋的问题..."
                  className="flex-1 px-3 py-2 border rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
                  disabled={isChatStreaming}
                />
                <Button
                  onClick={sendMessage}
                  disabled={!inputMessage.trim() || isChatStreaming}
                  size="sm"
                  className="bg-purple-500 hover:bg-purple-600 rounded-full px-3"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
