'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  createEmptyBoard,
  playMove,
  isValidMove,
  positionToCoordinate,
  evaluateBoard,
  getValidMoves,
  easyAIMove,
  mediumAIMove,
  hardAIMove,
  findBestHint,
  checkGameEnd,
  calculateFinalScore,
  getKomi,
  type Stone,
  type Board,
  type Position,
} from '@/lib/go-logic';
import { GO_TERMS, TERM_CATEGORIES, type GoTerm } from '@/lib/go-encyclopedia';
import { GO_TUTORIAL, getAllSteps } from '@/lib/go-tutorial';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  RotateCcw,
  MessageCircle,
  Lightbulb,
  Send,
  Save,
  FolderOpen,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Play,
  User,
  BookMarked,
  Search,
  Pause,
  Trophy,
  X,
  GraduationCap,
} from 'lucide-react';

// ========== 常量 ==========
const BOARD_SIZES = [
  { size: 9, label: '9路', desc: '初学入门' },
  { size: 13, label: '13路', desc: '进阶练习' },
  { size: 19, label: '19路', desc: '正式对局' },
] as const;

const DIFFICULTIES = [
  { key: 'easy', label: '初级', emoji: '🌱', desc: 'AI温柔陪练' },
  { key: 'medium', label: '中级', emoji: '⚔️', desc: 'AI认真对弈' },
  { key: 'hard', label: '高级', emoji: '🐉', desc: 'AI全力出击' },
] as const;

const COL_LABELS = 'ABCDEFGHJKLMNOPQRST';

// 星位坐标
function getStarPoints(boardSize: number): [number, number][] {
  if (boardSize === 9) return [[2, 2], [2, 6], [4, 4], [6, 2], [6, 6]];
  if (boardSize === 13) return [[3, 3], [3, 9], [6, 6], [9, 3], [9, 9], [3, 6], [6, 3], [6, 9], [9, 6]];
  if (boardSize === 19) return [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]];
  return [];
}

// 解说条目
interface CommentaryEntry {
  moveIndex: number;
  color: Stone;
  position: Position;
  commentary: string;
}

// 棋局历史步
interface MoveEntry {
  position: Position;
  color: Stone;
  captured: number;
}

// 保存的棋局
interface SavedGame {
  id?: number;
  board_size: number;
  difficulty: string;
  moves: MoveEntry[];
  commentaries: CommentaryEntry[];
  final_board: Board | null;
  black_score: number;
  white_score: number;
  status: string;
  title: string;
  created_at?: string;
}

// 流式读取
async function readStream(response: Response, onChunk: (text: string) => void): Promise<string> {
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
  // ===== 玩家身份 =====
  const [nickname, setNickname] = useState('');
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [showLogin, setShowLogin] = useState(true);

  // ===== 游戏状态 =====
  const [boardSize, setBoardSize] = useState(9);
  const [difficulty, setDifficulty] = useState<string>('easy');
  const [board, setBoard] = useState<Board>(() => createEmptyBoard(9));
  const [currentPlayer, setCurrentPlayer] = useState<Stone>('black');
  const [history, setHistory] = useState<MoveEntry[]>([]);
  const [lastMove, setLastMove] = useState<Position | null>(null);
  const [showHint, setShowHint] = useState<Position | null>(null);
  const [score, setScore] = useState({ black: 0, white: 0 });
  const [isAIThinking, setIsAIThinking] = useState(false);
  const [savedGameId, setSavedGameId] = useState<number | null>(null);
  const [consecutivePasses, setConsecutivePasses] = useState(0);
  const [gameEnded, setGameEnded] = useState(false);
  const [gameResult, setGameResult] = useState<{ winner: string; detail: string } | null>(null);

  // ===== 解说历史 =====
  const [commentaries, setCommentaries] = useState<CommentaryEntry[]>([]);
  const [isCommentaryStreaming, setIsCommentaryStreaming] = useState(false);

  const [streamingText, setStreamingText] = useState('');

  // 解说请求ID，用于非阻塞时取消旧请求的流式输出
  const commentaryRequestId = useRef(0);
  // 当前正在进行的解说Promise，AI落子时需要等它完成后再发起新解说
  const commentaryPromiseRef = useRef<Promise<void> | null>(null);

  // ===== 复盘模式 =====
  const [isReplayMode, setIsReplayMode] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayMoves, setReplayMoves] = useState<MoveEntry[]>([]);


  // ===== AI教学 =====
  const [teachingMessage, setTeachingMessage] = useState('');
  const [isTeachStreaming, setIsTeachStreaming] = useState(false);

  // ===== 聊天 =====
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const commentaryScrollRef = useRef<HTMLDivElement>(null);

  // 解说区自动滚到底部（仅滚动ScrollArea内部，不影响页面）
  useEffect(() => {
    if (commentaryScrollRef.current) {
      commentaryScrollRef.current.scrollTop = commentaryScrollRef.current.scrollHeight;
    }
  }, [commentaries, streamingText]);

  // ===== 弹窗 =====
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [savedGames, setSavedGames] = useState<SavedGame[]>([]);

  // ===== 学习面板 =====
  const [learnTab, setLearnTab] = useState<'tutorial' | 'encyclopedia'>('tutorial');
  // 教程
  const [tutorialChapterIdx, setTutorialChapterIdx] = useState(0);
  const [tutorialStepIdx, setTutorialStepIdx] = useState(0);
  // 百科
  const [encCategory, setEncCategory] = useState<string>('all');
  const [encSearch, setEncSearch] = useState('');
  const [selectedTerm, setSelectedTerm] = useState<GoTerm | null>(null);

  // 计算比分（白方含贴目）
  useEffect(() => {
    const evaluation = evaluateBoard(board);
    const komi = getKomi(boardSize);
    setScore({ black: evaluation.black, white: Math.round((evaluation.white + komi) * 10) / 10 });
  }, [board, boardSize]);

  // 聊天滚到底部（仅滚动内部容器，不影响页面）
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ===== 登录 =====
  const handleLogin = useCallback(async () => {
    if (!nickname.trim()) return;
    try {
      const res = await fetch('/api/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nickname.trim() }),
      });
      const data = await res.json();
      if (data.player) {
        setPlayerId(data.player.id);
        setShowLogin(false);
      }
    } catch {
      // 降级：允许无身份使用
      setPlayerId(0);
      setShowLogin(false);
    }
  }, [nickname]);

  // ===== 切换棋盘大小 =====
  const changeBoardSize = useCallback((newSize: number) => {
    setBoardSize(newSize);
    setBoard(createEmptyBoard(newSize));
    setCurrentPlayer('black');
    setHistory([]);
    setLastMove(null);
    setShowHint(null);
    setCommentaries([]);
    setSavedGameId(null);
    setIsReplayMode(false);
    setTeachingMessage('');
  }, []);

  // ===== 请求AI解说（第三方观赛视角） =====
  const requestCommentary = useCallback(async (
    newBoard: Board,
    movePos: Position,
    moveColor: Stone,
    capturedCount: number,
    moveIdx: number,
    currentHistory: MoveEntry[]
  ) => {
    // 每次新请求递增ID，旧请求的回调会被忽略
    const thisRequestId = ++commentaryRequestId.current;
    setIsCommentaryStreaming(true);
    setStreamingText('');

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
          moveHistory: currentHistory,
        }),
      });
      if (response.ok && commentaryRequestId.current === thisRequestId) {
        const fullText = await readStream(response, (text) => {
          if (commentaryRequestId.current === thisRequestId) {
            setStreamingText(text);
          }
        });
        if (commentaryRequestId.current === thisRequestId) {
          setCommentaries(prev => [...prev, {
            moveIndex: moveIdx,
            color: moveColor,
            position: movePos,
            commentary: fullText,
          }]);
        }
      }
    } catch {
      if (commentaryRequestId.current === thisRequestId) {
        setCommentaries(prev => [...prev, {
          moveIndex: moveIdx,
          color: moveColor,
          position: movePos,
          commentary: `${moveColor === 'black' ? '黑方' : '白方'}下在${positionToCoordinate(movePos.row, movePos.col, boardSize)}`,
        }]);
      }
    } finally {
      if (commentaryRequestId.current === thisRequestId) {
        setIsCommentaryStreaming(false);
        setStreamingText('');
      }
    }
  }, [boardSize]);

  // ===== 处理落子 =====
  const handleMove = useCallback(async (row: number, col: number) => {
    if (!isValidMove(board, row, col, currentPlayer) || isAIThinking || isReplayMode || gameEnded) return;

    const { newBoard, captured } = playMove(board, row, col, currentPlayer);
    const moveIdx = history.length;

    // 构建含本手的落子历史
    const historyWithThisMove = [...history, { position: { row, col }, color: currentPlayer, captured }];

    setBoard(newBoard);
    setLastMove({ row, col });
    setHistory(historyWithThisMove);
    setShowHint(null);
    setConsecutivePasses(0);

    // 玩家落子解说 - 非阻塞启动，后台流式显示
    const playerCommentaryPromise = requestCommentary(newBoard, { row, col }, currentPlayer, captured, moveIdx, historyWithThisMove);
    commentaryPromiseRef.current = playerCommentaryPromise;

    // 检查游戏是否应该结束
    const endCheck = checkGameEnd(newBoard, 0, historyWithThisMove.length);
    if (endCheck.ended) {
      const result = calculateFinalScore(newBoard);
      setGameEnded(true);
      setGameResult(result);
      setCurrentPlayer('black');
      return;
    }

    // AI回合
    if (currentPlayer === 'black') {
      setIsAIThinking(true);
      // AI思考延迟，让体验更自然
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

      const validMoves = getValidMoves(newBoard, 'white');
      if (validMoves.length > 0) {
        let aiMove: Position = validMoves[0];

        // 尝试使用GnuGo引擎
        let usedGnuGo = false;
        try {
          const moveHistoryForEngine = historyWithThisMove.map(m => ({
            row: m.position.row,
            col: m.position.col,
            color: m.color,
          }));
          const res = await fetch('/api/go-engine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              boardSize,
              moves: moveHistoryForEngine,
              difficulty,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.move && isValidMove(newBoard, data.move.row, data.move.col, 'white')) {
              aiMove = data.move;
              usedGnuGo = true;
            } else if (data.pass) {
              // AI停手
              const newPasses = consecutivePasses + 1;
              setConsecutivePasses(newPasses);
              if (newPasses >= 2) {
                const result = calculateFinalScore(newBoard);
                setGameEnded(true);
                setGameResult(result);
              }
              setCurrentPlayer('black');
              setIsAIThinking(false);
              return;
            }
          }
        } catch {
          // GnuGo引擎失败，使用本地AI
        }

        if (!usedGnuGo) {
          // 本地AI兜底
          if (difficulty === 'hard') {
            aiMove = hardAIMove(newBoard, 'white') || validMoves[0];
          } else if (difficulty === 'medium') {
            aiMove = mediumAIMove(newBoard, 'white') || validMoves[0];
          } else {
            aiMove = easyAIMove(newBoard, 'white') || validMoves[0];
          }
        }

        const { newBoard: finalBoard, captured: aiCaptured } = playMove(newBoard, aiMove.row, aiMove.col, 'white');
        const aiMoveIdx = moveIdx + 1;
        const historyWithAIMove = [...historyWithThisMove, { position: aiMove, color: 'white' as Stone, captured: aiCaptured }];

        setBoard(finalBoard);
        setLastMove({ row: aiMove.row, col: aiMove.col });
        setHistory(historyWithAIMove);

        // AI落子解说 - 等玩家解说完成后再发起，避免流式输出冲突
        const aiCommentary = async () => {
          if (commentaryPromiseRef.current) {
            await commentaryPromiseRef.current;
          }
          requestCommentary(finalBoard, aiMove, 'white', aiCaptured, aiMoveIdx, historyWithAIMove);
        };
        aiCommentary();

        // 检查游戏是否应该结束
        const endCheck2 = checkGameEnd(finalBoard, 0, historyWithAIMove.length);
        if (endCheck2.ended) {
          const result = calculateFinalScore(finalBoard);
          setGameEnded(true);
          setGameResult(result);
        }
      } else {
        // AI无合法落子，自动停手
        const newPasses = consecutivePasses + 1;
        setConsecutivePasses(newPasses);
        if (newPasses >= 2) {
          const result = calculateFinalScore(newBoard);
          setGameEnded(true);
          setGameResult(result);
        }
      }

      setCurrentPlayer('black');
      setIsAIThinking(false);
    }
  }, [board, currentPlayer, isAIThinking, isReplayMode, difficulty, history, requestCommentary, gameEnded, consecutivePasses, boardSize]);


  // ===== 悔棋 =====
  const undoMove = useCallback(() => {
    if (history.length === 0 || isReplayMode) return;
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
    setCommentaries(prev => prev.slice(0, -stepsToUndo));
  }, [history, boardSize, isReplayMode]);

  // ===== 重新开始 =====
  const restartGame = useCallback(() => {
    setBoard(createEmptyBoard(boardSize));
    setCurrentPlayer('black');
    setHistory([]);
    setLastMove(null);
    setShowHint(null);
    setCommentaries([]);
    setSavedGameId(null);
    setIsReplayMode(false);
    setReplayIndex(0);
    setTeachingMessage('');
    setConsecutivePasses(0);
    setGameEnded(false);
    setGameResult(null);
  }, [boardSize]);

  // ===== 停手 =====
  const passMove = useCallback(async () => {
    if (currentPlayer !== 'black' || isAIThinking || isReplayMode || gameEnded) return;

    const newPasses = consecutivePasses + 1;
    setConsecutivePasses(newPasses);

    if (newPasses >= 2) {
      // 双方连续停手，游戏结束
      const result = calculateFinalScore(board);
      setGameEnded(true);
      setGameResult(result);
      return;
    }

    // AI回合
    setIsAIThinking(true);
    // AI思考延迟，让体验更自然
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

    // AI也考虑停手（如果没好位置）
    const validMoves = getValidMoves(board, 'white');
    if (validMoves.length === 0) {
      // AI也无子可下
      const result = calculateFinalScore(board);
      setGameEnded(true);
      setGameResult(result);
      setIsAIThinking(false);
      return;
    }

    // AI正常落子
    let aiMove: Position = validMoves[0];
    let usedGnuGo = false;
    try {
      const moveHistoryForEngine = history.map(m => ({
        row: m.position.row,
        col: m.position.col,
        color: m.color,
      }));
      const res = await fetch('/api/go-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardSize,
          moves: moveHistoryForEngine,
          difficulty,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.move && isValidMove(board, data.move.row, data.move.col, 'white')) {
          aiMove = data.move;
          usedGnuGo = true;
        } else if (data.pass) {
          const result = calculateFinalScore(board);
          setGameEnded(true);
          setGameResult(result);
          setIsAIThinking(false);
          return;
        }
      }
    } catch {
      // GnuGo失败，使用本地AI
    }

    if (!usedGnuGo) {
      if (difficulty === 'hard') {
        aiMove = hardAIMove(board, 'white') || validMoves[0];
      } else if (difficulty === 'medium') {
        aiMove = mediumAIMove(board, 'white') || validMoves[0];
      } else {
        aiMove = easyAIMove(board, 'white') || validMoves[0];
      }
    }

    const moveIdx = history.length;
    const { newBoard: finalBoard, captured: aiCaptured } = playMove(board, aiMove.row, aiMove.col, 'white');
    const historyWithAIMove = [...history, { position: aiMove, color: 'white' as Stone, captured: aiCaptured }];

    setBoard(finalBoard);
    setLastMove({ row: aiMove.row, col: aiMove.col });
    setHistory(historyWithAIMove);
    setConsecutivePasses(0);

    // AI落子解说 - 等玩家解说完成后再发起
    const aiCommentary = async () => {
      if (commentaryPromiseRef.current) {
        await commentaryPromiseRef.current;
      }
      requestCommentary(finalBoard, aiMove, 'white', aiCaptured, moveIdx, historyWithAIMove);
    };
    aiCommentary();

    // 检查游戏结束
    const endCheck = checkGameEnd(finalBoard, 0, historyWithAIMove.length);
    if (endCheck.ended) {
      const result = calculateFinalScore(finalBoard);
      setGameEnded(true);
      setGameResult(result);
    }

    setCurrentPlayer('black');
    setIsAIThinking(false);
  }, [board, currentPlayer, isAIThinking, isReplayMode, gameEnded, consecutivePasses, difficulty, history, requestCommentary, boardSize]);

  // ===== 提示 =====
  const showHintFn = useCallback(() => {
    if (isReplayMode || gameEnded) return null;
    const hint = findBestHint(board, currentPlayer);
    if (hint) setShowHint(hint);
    return hint;
  }, [board, currentPlayer, isReplayMode, gameEnded]);

  // ===== AI教学 =====
  const getTeaching = useCallback(async (hintPosition?: Position) => {
    if (isTeachStreaming) return;
    setIsTeachStreaming(true);
    setTeachingMessage('');
    try {
      const teachingBody: Record<string, unknown> = {
        type: 'teach',
        board,
        currentPlayer,
        lastMove: lastMove ? { row: lastMove.row, col: lastMove.col } : undefined,
      };
      // 如果有提示位置，告诉AI要解释这个位置
      if (hintPosition) {
        teachingBody.hintPosition = positionToCoordinate(hintPosition.row, hintPosition.col, boardSize);
      }
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(teachingBody),
      });
      if (response.ok) await readStream(response, text => setTeachingMessage(text));
    } catch {
      setTeachingMessage('小围棋正在思考中...');
    } finally {
      setIsTeachStreaming(false);
    }
  }, [board, currentPlayer, lastMove, isTeachStreaming, boardSize]);

  // ===== 聊天 =====
  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || isChatStreaming) return;
    const userMsg = inputMessage.trim();
    setInputMessage('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
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
        setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
        await readStream(response, text => {
          setMessages(prev => {
            const u = [...prev];
            u[u.length - 1] = { role: 'assistant', content: text };
            return u;
          });
        });
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '抱歉，遇到问题了，请再试。' }]);
    } finally {
      setIsChatStreaming(false);
    }
  }, [inputMessage, isChatStreaming, board, currentPlayer, lastMove]);

  // ===== 保存棋局 =====
  const saveGame = useCallback(async () => {
    if (!playerId) return;
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: savedGameId,
          player_id: playerId,
          board_size: boardSize,
          difficulty,
          moves: history,
          commentaries,
          final_board: board,
          black_score: score.black,
          white_score: score.white,
          status: 'playing',
          title: saveTitle || `${boardSize}路${difficulty === 'easy' ? '初级' : difficulty === 'medium' ? '中级' : '高级'}对局`,
        }),
      });
      const data = await res.json();
      if (data.game) setSavedGameId(data.game.id);
      setShowSaveDialog(false);
      setSaveTitle('');
    } catch {
      // 静默失败
    }
  }, [playerId, savedGameId, boardSize, difficulty, history, commentaries, board, score, saveTitle]);

  // ===== 载入棋局列表 =====
  const loadGames = useCallback(async () => {
    try {
      const res = await fetch(`/api/games${playerId ? `?player_id=${playerId}` : ''}`);
      const data = await res.json();
      if (data.games) setSavedGames(data.games as SavedGame[]);
    } catch {
      // 静默
    }
  }, [playerId]);

  // ===== 载入棋局 =====
  const loadGame = useCallback(async (gameId: number) => {
    try {
      const res = await fetch(`/api/games/${gameId}`);
      const data = await res.json();
      const game = data.game as SavedGame;
      if (!game) return;

      setBoardSize(game.board_size);
      setDifficulty(game.difficulty);
      setHistory(game.moves || []);
      setCommentaries(game.commentaries || []);
      setSavedGameId(game.id ?? null);
      setIsReplayMode(true);
      setReplayIndex(0);

      // 重放棋步到初始状态
      setBoard(createEmptyBoard(game.board_size));
      setLastMove(null);
      setCurrentPlayer('black');

      // 存储复盘数据
      setReplayMoves(game.moves || []);

      setShowLoadDialog(false);
    } catch {
      // 静默
    }
  }, []);

  // ===== 删除棋局 =====
  const deleteGame = useCallback(async (gameId: number) => {
    try {
      await fetch(`/api/games?id=${gameId}`, { method: 'DELETE' });
      setSavedGames(prev => prev.filter(g => g.id !== gameId));
    } catch {
      // 静默
    }
  }, []);

  // ===== 复盘导航 =====
  const replayStep = useCallback((direction: number) => {
    const newIdx = Math.max(0, Math.min(replayMoves.length, replayIndex + direction));
    setReplayIndex(newIdx);

    // 重放到指定步数
    let newBoard = createEmptyBoard(boardSize);
    for (let i = 0; i < newIdx; i++) {
      const move = replayMoves[i];
      const result = playMove(newBoard, move.position.row, move.position.col, move.color);
      newBoard = result.newBoard;
    }
    setBoard(newBoard);
    setLastMove(newIdx > 0 ? replayMoves[newIdx - 1].position : null);
    setCurrentPlayer(newIdx % 2 === 0 ? 'black' : 'white');
  }, [replayIndex, replayMoves, boardSize]);

  // 退出复盘
  const exitReplay = useCallback(() => {
    setIsReplayMode(false);
    setReplayIndex(0);
    restartGame();
  }, [restartGame]);

  // ===== SVG棋盘 =====
  const renderSVGBoard = () => {
    const size = boardSize;
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

        <rect width={boardPx} height={boardPx} rx="6" fill="url(#bgGrad)" />

        {Array.from({ length: size }, (_, i) => (
          <g key={`line-${i}`}>
            <line x1={padding} y1={padding + i * cellSize} x2={padding + (size - 1) * cellSize} y2={padding + i * cellSize} stroke="#6b5a3e" strokeWidth={size >= 19 ? 0.7 : 1} />
            <line x1={padding + i * cellSize} y1={padding} x2={padding + i * cellSize} y2={padding + (size - 1) * cellSize} stroke="#6b5a3e" strokeWidth={size >= 19 ? 0.7 : 1} />
          </g>
        ))}

        <rect x={padding} y={padding} width={(size - 1) * cellSize} height={(size - 1) * cellSize} fill="none" stroke="#5a4a3a" strokeWidth={size >= 19 ? 1.5 : 2} />

        {starPts.map(([r, c]) => (
          <circle key={`star-${r}-${c}`} cx={padding + c * cellSize} cy={padding + r * cellSize} r={size >= 19 ? 3 : 4} fill="#5a4a3a" />
        ))}

        {Array.from({ length: size }, (_, i) => (
          <g key={`label-${i}`}>
            <text x={padding + i * cellSize} y={padding - cellSize * 0.4} textAnchor="middle" fontSize={size >= 19 ? 9 : 11} fill="#8b7355" fontFamily="sans-serif">{COL_LABELS[i]}</text>
            <text x={padding - cellSize * 0.4} y={padding + i * cellSize + 4} textAnchor="middle" fontSize={size >= 19 ? 9 : 11} fill="#8b7355" fontFamily="sans-serif">{size - i}</text>
          </g>
        ))}

        {board.map((row, r) =>
          row.map((stone, c) => {
            if (!stone) return null;
            const isLast = lastMove?.row === r && lastMove?.col === c;
            return (
              <g key={`s-${r}-${c}`} filter="url(#stoneShadow)">
                <circle cx={padding + c * cellSize} cy={padding + r * cellSize} r={stoneRadius} fill={stone === 'black' ? 'url(#blackStone)' : 'url(#whiteStone)'} stroke={stone === 'white' ? '#bbb' : 'none'} strokeWidth={0.5} />
                {isLast && <circle cx={padding + c * cellSize} cy={padding + r * cellSize} r={stoneRadius * 0.28} fill={stone === 'black' ? '#fff' : '#333'} />}
              </g>
            );
          })
        )}

        {showHint && !board[showHint.row][showHint.col] && (
          <circle cx={padding + showHint.col * cellSize} cy={padding + showHint.row * cellSize} r={stoneRadius} fill="rgba(59,130,246,0.25)" stroke="rgba(59,130,246,0.6)" strokeWidth={2}>
            <animate attributeName="opacity" values="0.4;0.8;0.4" dur="1.5s" repeatCount="indefinite" />
          </circle>
        )}

        {!isAIThinking && !isReplayMode && board.map((row, r) =>
          row.map((stone, c) => {
            if (stone) return null;
            return (
              <circle key={`c-${r}-${c}`} cx={padding + c * cellSize} cy={padding + r * cellSize} r={stoneRadius} fill="transparent" cursor="pointer" onClick={() => handleMove(r, c)} />
            );
          })
        )}
      </svg>
    );
  };

  // 教程与百科数据
  const allTutorialSteps = getAllSteps();
  const currentChapter = GO_TUTORIAL[tutorialChapterIdx];
  const currentStep = currentChapter?.steps[tutorialStepIdx];

  // ===== 登录界面 =====
  if (showLogin) {
    return (
      <div className="min-h-[100dvh] bg-gradient-to-b from-amber-100 via-amber-50 to-orange-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-white/95 shadow-2xl">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl flex items-center justify-center gap-2">
              <span className="inline-block w-7 h-7 rounded-full bg-gray-800 shadow" />
              小围棋乐园
              <span className="inline-block w-7 h-7 rounded-full bg-white border-2 border-gray-300 shadow" />
            </CardTitle>
            <p className="text-amber-600 text-sm">输入昵称开始下棋吧！</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              placeholder="你的昵称..."
              maxLength={20}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              enterKeyHint="done"
            />
            <Button onClick={handleLogin} disabled={!nickname.trim()} className="w-full bg-amber-700 hover:bg-amber-800 h-12 text-base">
              进入
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-amber-100 via-amber-50 to-orange-50">
      {/* 头部 */}
      <header className="text-center py-3 px-4">
        <h1 className="text-2xl sm:text-3xl font-bold text-amber-800 flex items-center justify-center gap-2">
          <span className="inline-block w-6 h-6 rounded-full bg-gray-800 shadow" />
          小围棋乐园
          <span className="inline-block w-6 h-6 rounded-full bg-white border-2 border-gray-300 shadow" />
        </h1>
        <div className="flex items-center justify-center gap-2 mt-2 flex-wrap">
          {/* 用户信息 */}
          <Badge variant="outline" className="text-xs gap-1">
            <User className="w-3 h-3" /> {nickname}
          </Badge>

          {/* 棋盘尺寸 */}
          {BOARD_SIZES.map(({ size, label, desc }) => (
            <Button
              key={size}
              size="sm"
              variant={boardSize === size ? 'default' : 'outline'}
              onClick={() => changeBoardSize(size)}
              className={boardSize === size ? 'bg-amber-700 hover:bg-amber-800 h-7 text-xs' : 'h-7 text-xs'}
              disabled={isReplayMode}
            >
              {label}<span className="ml-0.5 opacity-60">{desc}</span>
            </Button>
          ))}

          {/* 难度 */}
          {DIFFICULTIES.map(({ key, label, emoji }) => (
            <Button
              key={key}
              size="sm"
              variant={difficulty === key ? 'default' : 'outline'}
              onClick={() => { setDifficulty(key); restartGame(); }}
              className={difficulty === key ? 'bg-amber-700 hover:bg-amber-800 h-7 text-xs' : 'h-7 text-xs'}
              disabled={isReplayMode}
            >
              {emoji} {label}
            </Button>
          ))}
        </div>
      </header>

      {/* 主内容 - 桌面端固定视口高度，避免页面整体滚动 */}
      <div className="max-w-7xl mx-auto px-3 pb-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:h-[calc(100vh-120px)]">
        {/* 左侧面板 */}
        <div className="lg:col-span-3 space-y-3 lg:overflow-y-auto lg:pr-1">
          {/* 比分 */}
          <Card className="bg-white/90 shadow-lg">
            <CardContent className="py-3">
              <div className="flex justify-around text-center">
                <div className="flex flex-col items-center">
                  <div className="w-7 h-7 rounded-full bg-gray-800 shadow mb-1" />
                  <span className="text-xs text-gray-500">黑方(你)</span>
                  <span className="text-lg font-bold">{score.black}</span>
                </div>
                <div className="flex items-center text-gray-300 text-xs">VS</div>
                <div className="flex flex-col items-center">
                  <div className="w-7 h-7 rounded-full bg-white border-2 border-gray-300 shadow mb-1" />
                  <span className="text-xs text-gray-500">白方(AI)</span>
                  <span className="text-lg font-bold">{score.white}</span>
                  <span className="text-[9px] text-gray-400">含贴目{getKomi(boardSize)}</span>
                </div>
              </div>
              <div className="mt-2 text-center">
                <Badge variant={currentPlayer === 'black' ? 'default' : 'secondary'} className="text-xs px-3">
                  {gameEnded ? '棋局结束' : isReplayMode ? `复盘 ${replayIndex}/${replayMoves.length}步` : isAIThinking ? 'AI思考中...' : currentPlayer === 'black' ? `轮到你落子 (${history.length}手)` : '白方回合'}
                  {isAIThinking && <Spinner className="w-3 h-3 ml-1 inline" />}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* 控制按钮 */}
          <Card className="bg-white/90 shadow-lg">
            <CardContent className="py-3 grid grid-cols-2 gap-1.5">
              <Button onClick={restartGame} variant="outline" size="sm" className="gap-1 h-8 text-xs" disabled={isReplayMode}>
                <RotateCcw className="w-3 h-3" /> 重新开始
              </Button>
              <Button onClick={undoMove} variant="outline" size="sm" className="gap-1 h-8 text-xs" disabled={history.length === 0 || isReplayMode}>
                <RotateCcw className="w-3 h-3" /> 悔棋
              </Button>
              <Button onClick={passMove} variant="outline" size="sm" className="gap-1 h-8 text-xs" disabled={currentPlayer !== 'black' || isAIThinking || isReplayMode || gameEnded}>
                <Pause className="w-3 h-3" /> 停手
              </Button>

              {/* 保存/载入 */}
              <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1 h-8 text-xs" disabled={history.length === 0}>
                    <Save className="w-3 h-3" /> 保存棋局
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>保存棋局</DialogTitle>
                  </DialogHeader>
                  <Input value={saveTitle} onChange={e => setSaveTitle(e.target.value)} placeholder="棋局名称（可选）" />
                  <Button onClick={saveGame} className="bg-amber-700 hover:bg-amber-800">确认保存</Button>
                </DialogContent>
              </Dialog>

              <Dialog open={showLoadDialog} onOpenChange={(open) => { setShowLoadDialog(open); if (open) loadGames(); }}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1 h-8 text-xs">
                    <FolderOpen className="w-3 h-3" /> 载入棋局
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[70vh]">
                  <DialogHeader>
                    <DialogTitle>载入棋局</DialogTitle>
                  </DialogHeader>
                  <ScrollArea className="max-h-[50vh]">
                    {savedGames.length === 0 ? (
                      <p className="text-center text-gray-400 text-sm py-8">还没有保存的棋局</p>
                    ) : (
                      <div className="space-y-2">
                        {savedGames.map(g => (
                          <div key={g.id} className="flex items-center justify-between p-2 border rounded-lg hover:bg-gray-50">
                            <button
                              className="flex-1 text-left"
                              onClick={() => loadGame(g.id!)}
                            >
                              <p className="text-sm font-medium">{g.title || '未命名棋局'}</p>
                              <p className="text-xs text-gray-400">
                                {g.board_size}路 | {g.difficulty === 'easy' ? '初级' : g.difficulty === 'medium' ? '中级' : '高级'} | 黑{g.black_score} - 白{g.white_score}
                              </p>
                            </button>
                            <Button variant="ghost" size="sm" onClick={() => deleteGame(g.id!)} className="text-red-400 hover:text-red-600">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>

          {/* 复盘控制 */}
          {isReplayMode && (
            <Card className="bg-blue-50 border-blue-200">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm text-blue-700">复盘模式</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => replayStep(-1)} disabled={replayIndex <= 0}>
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm font-medium min-w-[60px] text-center">{replayIndex}/{replayMoves.length}</span>
                  <Button size="sm" variant="outline" onClick={() => replayStep(1)} disabled={replayIndex >= replayMoves.length}>
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
                <Button size="sm" variant="destructive" className="w-full mt-2" onClick={exitReplay}>
                  退出复盘
                </Button>
              </CardContent>
            </Card>
          )}

          {/* 提示+教学 */}
          <Card className="bg-gradient-to-br from-amber-50 to-yellow-50 border-amber-200">
            <CardContent className="py-3">
              <Button
                onClick={() => {
                  const hint = showHintFn();
                  if (!isTeachStreaming) getTeaching(hint || undefined);
                }}
                variant="default"
                size="sm"
                className="w-full gap-1.5 h-9 bg-amber-600 hover:bg-amber-700"
                disabled={isReplayMode || isTeachStreaming || gameEnded}
              >
                <Lightbulb className="w-4 h-4" /> 提示与教学
                {isTeachStreaming && <Spinner className="w-3 h-3 ml-1" />}
              </Button>
              {(teachingMessage || isTeachStreaming) && (
                <div className="mt-2 space-y-1">
                  {showHint && (
                    <p className="text-xs text-amber-700 font-medium">
                      建议落在 {positionToCoordinate(showHint.row, showHint.col, boardSize)}
                    </p>
                  )}
                  <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
                    {teachingMessage || (isTeachStreaming ? '正在分析...' : '')}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 游戏结束 - 居中弹窗 */}

        </div>

        {/* 中间：棋盘 + 聊天 */}
        <div className="lg:col-span-5 space-y-3 lg:overflow-y-auto">
          <div className="flex justify-center overflow-x-auto">
            {renderSVGBoard()}
          </div>

          {/* 问我围棋问题（棋盘正下方） */}
          <Card className="bg-white/95 shadow-lg">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm flex items-center gap-1">
                <MessageCircle className="w-4 h-4 text-purple-500" /> 问我围棋问题
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div ref={chatScrollRef} className="h-[160px] overflow-y-auto mb-2">
                <div className="space-y-2 pr-1">
                  {messages.length === 0 && (
                    <div className="text-center text-gray-300 text-xs py-4">
                      <p>结合当前棋局回答你的问题</p>
                    </div>
                  )}
                  {messages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-xs ${msg.role === 'user' ? 'bg-purple-500 text-white rounded-br-sm' : 'bg-gray-100 text-gray-800 rounded-bl-sm'}`}>
                        {msg.content || <span className="flex items-center gap-1"><Spinner className="w-3 h-3" /> 思考中...</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={e => setInputMessage(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !isChatStreaming && sendMessage()}
                  placeholder="问我围棋问题..."
                  className="flex-1 px-3 py-1.5 border rounded-full text-xs focus:outline-none focus:ring-2 focus:ring-purple-400"
                  disabled={isChatStreaming}
                />
                <Button onClick={sendMessage} disabled={!inputMessage.trim() || isChatStreaming} size="sm" className="bg-purple-500 hover:bg-purple-600 rounded-full px-2.5 h-8">
                  <Send className="w-3.5 h-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右侧：解说 + 学习 */}
        <div className="lg:col-span-4 space-y-3 lg:overflow-y-auto lg:pr-1">
          {/* 棋局解说 */}
          <Card className="bg-white/95 shadow-lg">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm flex items-center gap-1">
                <Play className="w-4 h-4 text-amber-600" /> 棋局解说
                {commentaries.length > 0 && <Badge variant="secondary" className="text-xs ml-1">{commentaries.length}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div ref={commentaryScrollRef} className="h-[260px] overflow-y-auto">
                <div className="space-y-2 pr-1">
                  {commentaries.length === 0 && !isCommentaryStreaming && (
                    <p className="text-center text-gray-300 text-xs py-4">落子后，解说员会为你解说每一步</p>
                  )}
                  {commentaries.map((entry, idx) => (
                    <div key={idx} className={`rounded-lg px-3 py-2 ${entry.color === 'black' ? 'bg-gray-50 border-l-3 border-gray-700' : 'bg-orange-50 border-l-3 border-orange-400'}`}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <div className={`w-4 h-4 rounded-full ${entry.color === 'black' ? 'bg-gray-800' : 'bg-white border border-gray-300'}`} />
                        <span className="text-xs font-medium text-gray-600">
                          第{entry.moveIndex + 1}手 | {entry.color === 'black' ? '黑方' : '白方'} {positionToCoordinate(entry.position.row, entry.position.col, boardSize)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-700 leading-relaxed">{entry.commentary}</p>
                    </div>
                  ))}
                  {isCommentaryStreaming && streamingText && (
                    <div className="rounded-lg px-3 py-2 bg-amber-50 border-l-3 border-amber-400">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <Spinner className="w-3 h-3" />
                        <span className="text-xs text-gray-400">解说中...</span>
                      </div>
                      <p className="text-xs text-gray-700 leading-relaxed">{streamingText}</p>
                    </div>
                  )}
                  {isCommentaryStreaming && !streamingText && (
                    <div className="flex items-center gap-2 text-gray-400 text-xs py-2">
                      <Spinner className="w-3 h-3" /> 解说员正在分析...
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 学习面板：教程 + 百科 */}
          <Card className="bg-white/90 shadow-lg">
            <CardHeader className="pb-1">
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={learnTab === 'tutorial' ? 'default' : 'ghost'}
                  onClick={() => setLearnTab('tutorial')}
                  className={`h-7 text-xs gap-1 ${learnTab === 'tutorial' ? 'bg-amber-700 hover:bg-amber-800' : ''}`}
                >
                  <GraduationCap className="w-3.5 h-3.5" /> 教程
                </Button>
                <Button
                  size="sm"
                  variant={learnTab === 'encyclopedia' ? 'default' : 'ghost'}
                  onClick={() => setLearnTab('encyclopedia')}
                  className={`h-7 text-xs gap-1 ${learnTab === 'encyclopedia' ? 'bg-amber-700 hover:bg-amber-800' : ''}`}
                >
                  <BookMarked className="w-3.5 h-3.5" /> 百科
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {learnTab === 'tutorial' ? (
                <div>
                  {/* 章节标题 */}
                  <div className="flex items-center gap-1.5 mb-2">
                    <span className="text-sm">{currentChapter?.emoji}</span>
                    <span className="text-xs font-bold text-amber-800">{currentChapter?.chapter}</span>
                    <span className="text-[10px] text-gray-400 ml-auto">
                      第{tutorialChapterIdx + 1}/{GO_TUTORIAL.length}章
                    </span>
                  </div>
                  {/* 步骤内容 */}
                  {currentStep && (
                    <>
                      <p className="text-xs font-medium text-amber-900">{currentStep.title}</p>
                      <p className="text-xs text-gray-600 leading-relaxed mt-1">{currentStep.content}</p>
                      {currentStep.keyPoint && (
                        <div className="mt-1.5 px-2 py-1 bg-amber-50 rounded border border-amber-200">
                          <p className="text-[10px] text-amber-700 font-medium">💡 {currentStep.keyPoint}</p>
                        </div>
                      )}
                      {currentStep.termIds && currentStep.termIds.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {currentStep.termIds.map(tid => {
                            const term = GO_TERMS.find(t => t.id === tid);
                            if (!term) return null;
                            return (
                              <button
                                key={tid}
                                className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded-full hover:bg-blue-100 border border-blue-200"
                                onClick={() => { setSelectedTerm(term); setLearnTab('encyclopedia'); }}
                              >
                                {term.term}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                  {/* 章节内导航 */}
                  <div className="flex justify-between mt-2">
                    <Button
                      size="sm" variant="outline"
                      onClick={() => {
                        if (tutorialStepIdx > 0) {
                          setTutorialStepIdx(tutorialStepIdx - 1);
                        } else if (tutorialChapterIdx > 0) {
                          setTutorialChapterIdx(tutorialChapterIdx - 1);
                          setTutorialStepIdx(GO_TUTORIAL[tutorialChapterIdx - 1].steps.length - 1);
                        }
                      }}
                      disabled={tutorialChapterIdx === 0 && tutorialStepIdx === 0}
                      className="h-7 text-xs"
                    >
                      <ChevronLeft className="w-3 h-3" /> 上一步
                    </Button>
                    <span className="text-[10px] text-gray-400 self-center">
                      {currentStep ? `${allTutorialSteps.findIndex(s => s.chapterId === currentChapter?.id && s.title === currentStep.title) + 1}/${allTutorialSteps.length}` : ''}
                    </span>
                    <Button
                      size="sm" variant="default"
                      onClick={() => {
                        if (tutorialStepIdx < (currentChapter?.steps.length ?? 0) - 1) {
                          setTutorialStepIdx(tutorialStepIdx + 1);
                        } else if (tutorialChapterIdx < GO_TUTORIAL.length - 1) {
                          setTutorialChapterIdx(tutorialChapterIdx + 1);
                          setTutorialStepIdx(0);
                        }
                      }}
                      disabled={tutorialChapterIdx === GO_TUTORIAL.length - 1 && tutorialStepIdx >= (currentChapter?.steps.length ?? 0) - 1}
                      className="h-7 text-xs"
                    >
                      下一步 <ChevronRight className="w-3 h-3" />
                    </Button>
                  </div>
                  {/* 章节快速跳转 */}
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {GO_TUTORIAL.map((ch, idx) => (
                      <button
                        key={ch.id}
                        className={`text-[10px] px-1.5 py-0.5 rounded ${idx === tutorialChapterIdx ? 'bg-amber-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                        onClick={() => { setTutorialChapterIdx(idx); setTutorialStepIdx(0); }}
                      >
                        {ch.emoji} {ch.chapter}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col" style={{ maxHeight: '300px' }}>
                  {/* 百科搜索 */}
                  <div className="flex gap-1.5 mb-2 shrink-0">
                    <div className="relative flex-1">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
                      <input
                        type="text"
                        value={encSearch}
                        onChange={e => setEncSearch(e.target.value)}
                        placeholder="搜索术语..."
                        className="w-full pl-6 pr-2 py-1 border rounded text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                      />
                      {encSearch && (
                        <button onClick={() => setEncSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2">
                          <X className="w-3 h-3 text-gray-400" />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* 分类筛选 */}
                  <div className="flex gap-1 mb-2 flex-wrap shrink-0">
                    <button
                      className={`text-[10px] px-1.5 py-0.5 rounded ${encCategory === 'all' ? 'bg-amber-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                      onClick={() => setEncCategory('all')}
                    >
                      全部
                    </button>
                    {TERM_CATEGORIES.map(cat => (
                      <button
                        key={cat.key}
                        className={`text-[10px] px-1.5 py-0.5 rounded ${encCategory === cat.key ? 'bg-amber-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                        onClick={() => setEncCategory(cat.key)}
                      >
                        {cat.icon} {cat.label}
                      </button>
                    ))}
                  </div>
                  {/* 术语内容区（可滚动） */}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {selectedTerm ? (
                      <div className="pr-1">
                        <button
                          className="text-[10px] text-amber-600 hover:text-amber-800 mb-1 flex items-center gap-0.5"
                          onClick={() => setSelectedTerm(null)}
                        >
                          <ChevronLeft className="w-3 h-3" /> 返回列表
                        </button>
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-bold text-amber-800">{selectedTerm.term}</span>
                            {selectedTerm.reading && <span className="text-[10px] text-gray-400">({selectedTerm.reading})</span>}
                            <span className={`text-[9px] px-1 py-0.5 rounded ${selectedTerm.difficulty === 1 ? 'bg-green-100 text-green-700' : selectedTerm.difficulty === 2 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                              {selectedTerm.difficulty === 1 ? '入门' : selectedTerm.difficulty === 2 ? '进阶' : '高级'}
                            </span>
                          </div>
                          <p className="text-xs text-amber-700 font-medium">{selectedTerm.shortDesc}</p>
                          <p className="text-xs text-gray-600 leading-relaxed">{selectedTerm.fullDesc}</p>
                          {selectedTerm.analogy && (
                            <div className="px-2 py-1 bg-blue-50 rounded border border-blue-200">
                              <p className="text-[10px] text-blue-700">🎯 {selectedTerm.analogy}</p>
                            </div>
                          )}
                          {selectedTerm.tip && (
                            <div className="px-2 py-1 bg-green-50 rounded border border-green-200">
                              <p className="text-[10px] text-green-700">💡 {selectedTerm.tip}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1 pr-1">
                        {GO_TERMS
                          .filter(t => encCategory === 'all' || t.category === encCategory)
                          .filter(t => {
                            if (!encSearch) return true;
                            const q = encSearch.toLowerCase();
                            return t.term.includes(q) || t.shortDesc.includes(q) || (t.reading && t.reading.includes(q));
                          })
                          .map(term => (
                            <button
                              key={term.id}
                              className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-amber-50 border border-transparent hover:border-amber-200 transition-colors"
                              onClick={() => setSelectedTerm(term)}
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium text-amber-800">{term.term}</span>
                                {term.reading && <span className="text-[9px] text-gray-400">({term.reading})</span>}
                                <span className={`text-[9px] px-1 py-0 rounded ${term.difficulty === 1 ? 'bg-green-100 text-green-700' : term.difficulty === 2 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                                  {term.difficulty === 1 ? '入门' : term.difficulty === 2 ? '进阶' : '高级'}
                                </span>
                                <span className="text-[9px] text-gray-400 ml-auto">{TERM_CATEGORIES.find(c => c.key === term.category)?.icon}</span>
                              </div>
                              <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-1">{term.shortDesc}</p>
                            </button>
                          ))}
                        {GO_TERMS.filter(t => encCategory === 'all' || t.category === encCategory).filter(t => {
                          if (!encSearch) return true;
                          const q = encSearch.toLowerCase();
                          return t.term.includes(q) || t.shortDesc.includes(q) || (t.reading && t.reading.includes(q));
                        }).length === 0 && (
                          <p className="text-center text-gray-300 text-xs py-4">没有找到匹配的术语</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 游戏结束弹窗 - 居中显示 */}
      <Dialog open={gameEnded && !!gameResult} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader className="items-center">
            <DialogTitle className="flex flex-col items-center gap-2">
              <Trophy className="w-12 h-12 text-yellow-500" />
              <span className="text-xl">{gameResult?.winner === 'black' ? '你赢了!' : '白方(AI)获胜'}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="text-center space-y-3 py-2">
            <p className="text-sm text-gray-600">{gameResult?.detail}</p>
            <Button onClick={restartGame} size="lg" className="bg-amber-700 hover:bg-amber-800 text-white px-8">
              再来一局
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
