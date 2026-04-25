'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  createEmptyBoard,
  playMove,
  isValidMove,
  getMoveRejectionReason,
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth-context';
import GoBoard from '@/components/go-board';
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
  LogOut,
  Coins,
  Eye,
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

type EngineId = 'katago' | 'gnugo' | 'local';

const ENGINE_OPTIONS: { id: EngineId; name: string; desc: string }[] = [
  { id: 'katago', name: 'KataGo', desc: '深度学习引擎' },
  { id: 'gnugo', name: 'GnuGo', desc: '经典围棋引擎' },
  { id: 'local', name: '本地AI', desc: '内置启发式' },
];

const ENGINE_COSTS: Record<EngineId, number> = {
  katago: 5,
  gnugo: 2,
  local: 0,
};

// 解说条目
interface CommentaryEntry {
  moveIndex: number;
  color: Stone;
  position: Position;
  commentary: string;
  isPass?: boolean;
}

// 棋局历史步
interface MoveEntry {
  position: Position;
  color: Stone;
  captured: number;
  isPass?: boolean;
}

// 保存的棋局
interface SavedGame {
  id?: number;
  user_id?: number;
  board_size: number;
  difficulty: string;
  engine?: string;
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
  // ===== 认证 =====
  const { user, token, login, register, logout, refreshUser, deductPoints } = useAuth();

  // ===== 游戏状态 =====
  const [boardSize, setBoardSize] = useState(9);
  const [difficulty, setDifficulty] = useState<string>('easy');
  const [engine, setEngine] = useState<EngineId>('local');
  const [playerColor, setPlayerColor] = useState<Stone>('black'); // 玩家执子颜色
  const [availableEngines, setAvailableEngines] = useState<Record<EngineId, boolean>>({ katago: false, gnugo: false, local: true });
  const [enginesLoading, setEnginesLoading] = useState(true);
  // KataGo 模型选择
  const [availableKataGoModels, setAvailableKataGoModels] = useState<Array<{ path: string; name: string; sizeMB: number; displayName: string }>>([]);
  const [selectedKataGoModel, setSelectedKataGoModel] = useState<string>('');
  const [modelSwitching, setModelSwitching] = useState(false);
  const [board, setBoard] = useState<Board>(() => createEmptyBoard(9));
  const [currentPlayer, setCurrentPlayer] = useState<Stone>('black');
  const [history, setHistory] = useState<MoveEntry[]>([]);
  const [lastMove, setLastMove] = useState<Position | null>(null);
  const [showHint, setShowHint] = useState<Position | null>(null);
  const [isLocalhost, setIsLocalhost] = useState(false);
  useEffect(() => {
    setIsLocalhost(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  }, []);

  // 提子统计
  const captures = useMemo(() => {
    return history.reduce((acc, m) => {
      if (m.color === 'black') acc.black += m.captured;
      else acc.white += m.captured;
      return acc;
    }, { black: 0, white: 0 });
  }, [history]);

  // 同步history长度到ref，供useCallback闭包使用最新值
  useEffect(() => { historyLengthRef.current = history.length; }, [history.length]);

  // 每次落子历史变化时，强制同步lastMove标记到最新一手（防止残留，跳过pass）
  useEffect(() => {
    if (history.length > 0) {
      // 从后往前找第一个非pass的落子
      for (let i = history.length - 1; i >= 0; i--) {
        if (!history[i].isPass) {
          setLastMove({ row: history[i].position.row, col: history[i].position.col });
          return;
        }
      }
      setLastMove(null);
    } else {
      setLastMove(null);
    }
  }, [history]);
  const [score, setScore] = useState({ black: 0, white: 0 });
  const [isAIThinking, setIsAIThinking] = useState(false);
  const [queuePosition, setQueuePosition] = useState(0); // 0=无排队，>0=排队位置
  const [lastEngineInfo, setLastEngineInfo] = useState<{ modelUsed?: string; actualVisits?: number; engine?: string } | null>(null);
  const queuePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [savedGameId, setSavedGameId] = useState<number | null>(null);
  // 同步savedGameId到ref，供自动保存useEffect闭包使用最新值
  useEffect(() => { savedGameIdRef.current = savedGameId; }, [savedGameId]);
  const [consecutivePasses, setConsecutivePasses] = useState(0);
  const gameEpochRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const commentaryAbortRef = useRef<AbortController | null>(null);
  // 防止handleMove重入（快速点击时闭包值可能过期）
  const isProcessingMoveRef = useRef(false);
  // 追踪最新的history长度，避免useCallback闭包中的history过时
  const historyLengthRef = useRef(0);
  // 追踪最新的savedGameId，避免自动保存useEffect闭包中savedGameId过时导致创建新棋局
  const savedGameIdRef = useRef<number | null>(null);

  // AI思考时轮询队列位置
  useEffect(() => {
    if (isAIThinking) {
      const pollQueue = async () => {
        try {
          const userId = user?.userId;
          const url = userId ? `/api/go-engine?userId=${userId}` : '/api/go-engine';
          const res = await fetch(url);
          if (res.ok) {
            const data = await res.json();
            // 优先使用用户自己的排队位置
            const userPos = data.userQueuePosition ?? -1;
            if (userPos === 0) {
              // 正在处理自己的任务，不需要显示排队
              setQueuePosition(0);
            } else if (userPos > 0) {
              // 在队列中，userPos=前方任务数（含正在处理的任务）
              setQueuePosition(userPos);
            } else {
              // 不在队列中，不显示排队
              setQueuePosition(0);
            }
          }
        } catch {
          // 轮询失败不处理
        }
      };
      // 立即查一次
      pollQueue();
      // 每2秒轮询
      queuePollRef.current = setInterval(pollQueue, 2000);
    } else {
      setQueuePosition(0);
      if (queuePollRef.current) {
        clearInterval(queuePollRef.current);
        queuePollRef.current = null;
      }
    }
    return () => {
      if (queuePollRef.current) {
        clearInterval(queuePollRef.current);
        queuePollRef.current = null;
      }
    };
  }, [isAIThinking, user?.userId]);
  // KataGo分析数据（来自引擎响应，传给解说/教学API）
  const latestAnalysisRef = useRef<{winRate: number; scoreLead: number; bestMoves: {move: string; winrate: number; scoreMean: number}[]} | null>(null);
  const [gameEnded, setGameEnded] = useState(false);
  const [gameResult, setGameResult] = useState<{ winner: string; detail: string } | null>(null);
  const [showGameEndDialog, setShowGameEndDialog] = useState(false);

  // ===== 解说历史 =====
  const [commentaries, setCommentaries] = useState<CommentaryEntry[]>([]);
  const [isCommentaryStreaming, setIsCommentaryStreaming] = useState(false);

  const [streamingText, setStreamingText] = useState('');

  // AI先下标记
  const needsAIMoveRef = useRef(false);
  // 切换执子需要重开标记
  const [needsNewGame, setNeedsNewGame] = useState(false);

  const router = useRouter();

  // ===== 认证 UI =====
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [authTab, setAuthTab] = useState<'login' | 'register'>('login');
  const [authError, setAuthError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // ===== 切换确认 =====
  const [difficultyToast, setDifficultyToast] = useState<string>('');

  // 难度提示自动消失
  useEffect(() => {
    if (!difficultyToast) return;
    const timer = setTimeout(() => setDifficultyToast(''), 2000);
    return () => clearTimeout(timer);
  }, [difficultyToast]);
  // 统一的重开确认弹窗（引擎/执子/棋盘大小切换）
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [restartConfirmMsg, setRestartConfirmMsg] = useState('');
  const [pendingRestartAction, setPendingRestartAction] = useState<(() => void) | null>(null);

  // AI先手触发：restartGame后如果playerColor=white，触发AI下第一步
  useEffect(() => {
    if (!needsAIMoveRef.current) return;
    needsAIMoveRef.current = false;
    // AI先下的触发在restartGame中通过setTimeout处理
  }, [history, playerColor, gameEnded, isAIThinking]);

  // 切换执子颜色需要重开
  useEffect(() => {
    if (!needsNewGame) return;
    setNeedsNewGame(false);
    restartGame();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsNewGame]);

  // 解说请求ID，用于取消旧请求的流式输出
  const commentaryRequestId = useRef(0);
  // 当前正在进行的解说Promise，AI落子时需要等它完成后再发起新解说
  const commentaryPromiseRef = useRef<Promise<void> | null>(null);

  // ===== 复盘模式 =====
  const [isReplayMode, setIsReplayMode] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayMoves, setReplayMoves] = useState<MoveEntry[]>([]);


  // ===== AI教学 =====
  // 教学历史条目
  interface TeachEntry {
    moveIndex: number;       // 教学针对的手数
    hintPosition: Position | null; // 提示点位
    content: string;         // 教学内容
    faded: boolean;          // 是否已过时（用户已落子或新一局）
  }
  const [teachingMessage, setTeachingMessage] = useState('');
  const [teachHistory, setTeachHistory] = useState<TeachEntry[]>([]);
  const [isTeachStreaming, setIsTeachStreaming] = useState(false);
  const [teachMoveIndex, setTeachMoveIndex] = useState<number | null>(null); // 教学针对的手数
  const teachAbortRef = useRef<AbortController | null>(null); // 教学请求的中断控制器
  const [teachUsedCount, setTeachUsedCount] = useState(0);
  const [autoSave, setAutoSave] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [commentaryVersion, setCommentaryVersion] = useState(0); // 解说完成时递增，触发自动保存
  const MAX_TEACH_PER_GAME = 10; // 每局最多使用次数
  const TEACH_COST = 20; // 每次消耗积分

  // ===== 聊天 =====
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const commentaryScrollRef = useRef<HTMLDivElement>(null);
  const teachScrollRef = useRef<HTMLDivElement>(null);

  // 解说区自动滚到底部（仅滚动ScrollArea内部，不影响页面）
  useEffect(() => {
    if (commentaryScrollRef.current) {
      commentaryScrollRef.current.scrollTop = commentaryScrollRef.current.scrollHeight;
    }
  }, [commentaries, streamingText]);

  // 教学区自动滚到底部
  useEffect(() => {
    if (teachScrollRef.current) {
      teachScrollRef.current.scrollTop = teachScrollRef.current.scrollHeight;
    }
  }, [teachHistory, teachingMessage, isTeachStreaming]);

  // ===== 弹窗 =====
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [savedGames, setSavedGames] = useState<SavedGame[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  // ===== 学习面板 =====
  const [learnTab, setLearnTab] = useState<'tutorial' | 'encyclopedia'>('tutorial');
  // 教程
  const [tutorialChapterIdx, setTutorialChapterIdx] = useState(0);
  const [tutorialStepIdx, setTutorialStepIdx] = useState(0);
  // 百科
  const [encCategory, setEncCategory] = useState<string>('all');
  const [encSearch, setEncSearch] = useState('');
  const [selectedTerm, setSelectedTerm] = useState<GoTerm | null>(null);

  // 检测可用引擎
  useEffect(() => {
    fetch('/api/go-engine')
      .then(res => res.json())
      .then(data => {
        if (data.engines) {
          const avail: Record<EngineId, boolean> = { katago: false, gnugo: false, local: true };
          for (const e of data.engines) {
            avail[e.id as EngineId] = e.available;
          }
          setAvailableEngines(avail);
          // 加载可用模型列表
          if (data.availableModels) {
            setAvailableKataGoModels(data.availableModels);
          }
          if (data.currentModel?.path) {
            setSelectedKataGoModel(data.currentModel.path);
          }
          // 自动选择最高可用引擎（未登录只能用本地AI）
          if (!user) {
            setEngine('local');
          } else if (avail.katago) {
            setEngine('katago');
          } else if (avail.gnugo) {
            setEngine('gnugo');
          } else {
            setEngine('local');
          }
        }
      })
      .catch(() => {})
      .finally(() => setEnginesLoading(false));
  }, []);

  // 登录/登出时调整引擎选择
  useEffect(() => {
    if (!user && engine !== 'local') {
      setEngine('local');
    }
  }, [user]);

  // 计算比分（中国规则：子数+地盘+提子，白方再加贴目）
  useEffect(() => {
    const evaluation = evaluateBoard(board);
    const komi = getKomi(boardSize);
    setScore({
      black: Math.round((evaluation.black + captures.black) * 10) / 10,
      white: Math.round((evaluation.white + captures.white + komi) * 10) / 10,
    });
  }, [board, boardSize, captures.black, captures.white]);

  // 聊天滚到底部（仅滚动内部容器，不影响页面）
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ===== 认证相关（使用auth context）=====

  // ===== 切换棋盘大小 =====
  const changeBoardSize = useCallback((newSize: number) => {
    gameEpochRef.current++;
    commentaryRequestId.current++;
    // 中止所有正在进行的AI请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // 中止正在进行的解说/教学/聊天请求
    if (commentaryAbortRef.current) {
      commentaryAbortRef.current.abort();
    }
    commentaryAbortRef.current = new AbortController();
    if (teachAbortRef.current) {
      teachAbortRef.current.abort();
      teachAbortRef.current = null;
    }
    setIsAIThinking(false);
    setQueuePosition(0);
    setIsCommentaryStreaming(false);
    setStreamingText('');
    setIsTeachStreaming(false);
    setIsChatStreaming(false);
    setBoardSize(newSize);
    setBoard(createEmptyBoard(newSize));
    setCurrentPlayer(playerColor);
    setHistory([]);
    setLastMove(null);
    setShowHint(null);
    setCommentaries([]);
    setSaveTitle('');
    setSavedGameId(null);
    latestAnalysisRef.current = null;
    setIsReplayMode(false);
    setReplayIndex(0);
    setReplayMoves([]);
    setTeachingMessage('');
    setTeachHistory([]);
    setIsCommentaryStreaming(false);
    setStreamingText('');
    setIsTeachStreaming(false);
    setIsChatStreaming(false);
    setTeachUsedCount(0);
    setConsecutivePasses(0);
    setGameEnded(false);
    setGameResult(null);
    setShowGameEndDialog(false);
  }, [playerColor]);

  // ===== 请求AI解说（第三方观赛视角） =====
  const requestCommentary = useCallback(async (
    newBoard: Board,
    movePos: Position,
    moveColor: Stone,
    capturedCount: number,
    moveIdx: number,
    currentHistory: MoveEntry[],
    isPass = false
  ) => {
    // 每次新请求递增ID，仅用于控制流式文本显示（不阻止旧解说保存）
    const thisRequestId = ++commentaryRequestId.current;
    const epochAtStart = gameEpochRef.current;
    const isLatestRequest = () => commentaryRequestId.current === thisRequestId && gameEpochRef.current === epochAtStart;

    if (isLatestRequest()) {
      setIsCommentaryStreaming(true);
      setStreamingText('');
    }

    // 不中止之前的解说请求——让它继续完成生成，只控制流式文本显示归最新请求
    // 解说请求之间互不abort，防止快速落子时旧解说丢失
    // restartGame/changeBoardSize才会统一abort所有解说
    const thisAbortSignal = commentaryAbortRef.current?.signal;

    // 兜底解说（API失败时使用）
    const moveDesc = isPass ? '停一手' : `下在${positionToCoordinate(movePos.row, movePos.col, boardSize)}`;
    const fallbackCommentary = `${moveColor === 'black' ? '黑方' : '白方'}${moveDesc}`;

    try {
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        signal: thisAbortSignal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          type: 'commentary',
          board: newBoard,
          currentPlayer: moveColor === 'black' ? 'white' : 'black',
          lastMove: movePos,
          moveColor,
          captured: capturedCount,
          moveHistory: currentHistory,
          isPass,
        }),
      });
      if (response.ok) {
        const fullText = await readStream(response, (text) => {
          // 只有最新请求才更新流式文本显示
          if (isLatestRequest()) {
            setStreamingText(text);
          }
        });
        // 只有epoch匹配时才保存解说（防止旧棋局解说写入新棋局）
        if (gameEpochRef.current === epochAtStart) {
          setCommentaries(prev => {
            const newEntry = {
              moveIndex: moveIdx,
              color: moveColor,
              position: movePos,
              commentary: fullText || fallbackCommentary,
              isPass,
            };
            const next = [...prev, newEntry];
            next.sort((a, b) => a.moveIndex - b.moveIndex);
            return next;
          });
          setCommentaryVersion(v => v + 1); // 触发自动保存
        }
      } else {
        // API 返回非200，使用兜底解说（epoch匹配时才保存）
        console.warn('[commentary] API returned', response.status, await response.text().catch(() => ''));
        if (gameEpochRef.current === epochAtStart) {
          setCommentaries(prev => {
            const newEntry = {
              moveIndex: moveIdx,
              color: moveColor,
              position: movePos,
              commentary: fallbackCommentary,
              isPass,
            };
            const next = [...prev, newEntry];
            next.sort((a, b) => a.moveIndex - b.moveIndex);
            return next;
          });
          setCommentaryVersion(v => v + 1); // 触发自动保存
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.warn('[commentary] fetch error:', err);
      // epoch匹配时才保存兜底解说
      if (gameEpochRef.current === epochAtStart) {
        setCommentaries(prev => {
          const newEntry = {
            moveIndex: moveIdx,
            color: moveColor,
            position: movePos,
            commentary: fallbackCommentary,
          };
          const next = [...prev, newEntry];
          next.sort((a, b) => a.moveIndex - b.moveIndex);
          return next;
        });
      }
    } finally {
      // 只有最新请求才清理流式状态
      if (isLatestRequest()) {
        setIsCommentaryStreaming(false);
        setStreamingText('');
      }
    }
  }, [boardSize]);

  // ===== 处理落子 =====
  const handleMove = useCallback(async (row: number, col: number) => {
    // 禁用状态提示
    if (gameEnded) { toast.info('棋局已结束，请开始新棋局'); return; }
    if (isReplayMode) { toast.info('复盘模式下不能落子'); return; }
    if (enginesLoading && engine !== 'local') { toast.info('AI引擎加载中，请稍候'); return; }
    if (isAIThinking) { toast.info('AI正在思考，请稍等'); return; }
    if (isProcessingMoveRef.current) { toast.info('请稍等，正在处理中'); return; }
    if (currentPlayer !== playerColor) { toast.info('现在不是你的回合'); return; }

    // 禁着点提示
    if (!isValidMove(board, row, col, currentPlayer)) {
      const reason = getMoveRejectionReason(board, row, col, currentPlayer);
      toast.info(reason || '此处不能落子', { description: positionToCoordinate(row, col, boardSize) });
      return;
    }
    isProcessingMoveRef.current = true;

    // 用户落子时，截断正在进行的提示与教学（分析+输出+点位）
    if (teachAbortRef.current) {
      teachAbortRef.current.abort();
      teachAbortRef.current = null;
    }
    setIsTeachStreaming(false);
    setTeachingMessage('');
    setTeachHistory(prev => prev.map(e => ({ ...e, faded: true })));
    setShowHint(null);

    const { newBoard, captured } = playMove(board, row, col, currentPlayer);
    if (!newBoard) {
      isProcessingMoveRef.current = false;
      return;
    }
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
    setShowGameEndDialog(true);
      setGameResult(result);
      setCurrentPlayer(playerColor);
      isProcessingMoveRef.current = false;
      return;
    }

    // AI回合 - 玩家落子后，AI执另一种颜色
    const aiColor = playerColor === 'black' ? 'white' : 'black';
    if (currentPlayer === playerColor) {
      const epochAtStart = gameEpochRef.current;
      setIsAIThinking(true);
      setQueuePosition(0);

      // 等待玩家落子解说完成，避免解说流式输出被打断
      if (commentaryPromiseRef.current) {
        await commentaryPromiseRef.current;
      }

      // AI思考延迟，让体验更自然（模拟思考时间）
      await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

      // 检查epoch：如果用户已经重新开始，丢弃本次AI落子
      if (gameEpochRef.current !== epochAtStart) { isProcessingMoveRef.current = false; return; }

      const validMoves = getValidMoves(newBoard, aiColor);
      if (validMoves.length > 0) {
        let aiMove: Position = validMoves[0];
        let usedEngine = false;

        // 根据引擎选择获取AI落子
        if (engine !== 'local') {
          try {
            const moveHistoryForEngine = historyWithThisMove.map(m => ({
              row: m.position.row,
              col: m.position.col,
              color: m.color,
              ...(m.isPass ? { isPass: true } : {}),
            }));
            const res = await fetch('/api/go-engine', {
              method: 'POST',
              signal: createAbortableFetch(),
              headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
              body: JSON.stringify({
                boardSize,
                moves: moveHistoryForEngine,
                difficulty,
                engine,
                aiColor,
              }),
            });
            if (res.ok) {
              const data = await res.json();
              // 检查epoch：引擎响应可能很慢，用户可能已重新开始
              if (gameEpochRef.current !== epochAtStart) { isProcessingMoveRef.current = false; return; }
              // 更新前端积分
              if (data.pointsUsed > 0) {
                deductPoints(data.pointsUsed);
              }
              // 记录引擎信息（modelUsed + actualVisits）
              if (data.modelUsed || data.actualVisits) {
                setLastEngineInfo({ modelUsed: data.modelUsed, actualVisits: data.actualVisits, engine });
              }
              // 如果genmove返回了analysis数据，保存供解说/教学使用
              if (data.analysis) {
                latestAnalysisRef.current = data.analysis;
              }
              // queuePosition 由轮询机制实时更新，不再从响应中读取
              if (data.move && isValidMove(newBoard, data.move.row, data.move.col, aiColor)) {
                aiMove = data.move;
                usedEngine = true;
              } else if (data.pass && !data.engineError) {
                // 引擎主动停手（非错误），记录到历史并计入连续停手
                const passEntry = { position: { row: 0, col: 0 }, color: aiColor as Stone, captured: 0, isPass: true };
                const historyWithPass = [...historyWithThisMove, passEntry];
                setHistory(historyWithPass);
                // AI停手解说
                requestCommentary(newBoard, { row: 0, col: 0 }, aiColor, 0, moveIdx + 1, historyWithPass, true);

                const newPasses = consecutivePasses + 1;
                setConsecutivePasses(newPasses);
                const endCheck = checkGameEnd(newBoard, newPasses, historyWithPass.length);
                if (endCheck.ended) {
                  const result = calculateFinalScore(newBoard);
                  setGameEnded(true);
    setShowGameEndDialog(true);
                  setGameResult(result);
                }
                setCurrentPlayer(playerColor);
                if (gameEpochRef.current === epochAtStart) setIsAIThinking(false);
                isProcessingMoveRef.current = false;
                return;
              } else {
                // 引擎错误(engineError)或move无效/null，回退到本地AI
                console.warn(`[engine] ${engine} returned invalid/null move (engineError=${data.engineError}), falling back to local AI. Data:`, data);
              }
            } else if (res.status === 403) {
              const data = await res.json().catch(() => ({}));
              console.warn(`[engine] 积分不足:`, data.error);
              if (data.insufficientPoints) {
                toast.error('积分不足', { description: data.error || `需要${data.required}积分，当前${data.current}积分` });
                refreshUser(); // 刷新用户积分信息
              }
              // 积分不足，回退到本地AI
            } else if (res.status === 401) {
              console.warn(`[engine] 未登录，回退到本地AI`);
              // 未登录，回退到本地AI
            } else {
              console.warn(`[engine] ${engine} API returned ${res.status}`);
            }
          } catch (engineErr) {
            // 请求被中止：如果epoch变了说明用户重新开始，直接返回；否则回退本地AI
            if (engineErr instanceof DOMException && engineErr.name === 'AbortError') {
              if (gameEpochRef.current !== epochAtStart) { isProcessingMoveRef.current = false; return; }
              // 超时或被新请求中止，回退到本地AI继续
              console.warn(`[engine] ${engine} request aborted (not epoch change), falling back to local AI`);
            } else {
              console.warn(`[engine] ${engine} fetch failed:`, engineErr);
            }
          }
        }

        if (!usedEngine) {
          // 本地AI
          if (difficulty === 'hard') {
            aiMove = hardAIMove(newBoard, aiColor) || validMoves[0];
          } else if (difficulty === 'medium') {
            aiMove = mediumAIMove(newBoard, aiColor) || validMoves[0];
          } else {
            aiMove = easyAIMove(newBoard, aiColor) || validMoves[0];
          }
        }

        const { newBoard: finalBoard, captured: aiCaptured } = playMove(newBoard, aiMove.row, aiMove.col, aiColor);
        if (!finalBoard) {
          // AI落子无效（不应发生，但做防御性处理），跳过AI回合
          console.warn('[AI] playMove returned null for', aiMove, aiColor);
          setCurrentPlayer(playerColor);
          if (gameEpochRef.current === epochAtStart) setIsAIThinking(false);
          isProcessingMoveRef.current = false;
          return;
        }
        const aiMoveIdx = moveIdx + 1;
        const historyWithAIMove = [...historyWithThisMove, { position: aiMove, color: aiColor as Stone, captured: aiCaptured }];

        setBoard(finalBoard);
        setLastMove({ row: aiMove.row, col: aiMove.col });
        setHistory(historyWithAIMove);

        // AI落子解说 - 同步发起，因为玩家解说已经完成
        requestCommentary(finalBoard, aiMove, aiColor, aiCaptured, aiMoveIdx, historyWithAIMove);

        // 检查游戏是否应该结束
        const endCheck2 = checkGameEnd(finalBoard, 0, historyWithAIMove.length);
        if (endCheck2.ended) {
          const result = calculateFinalScore(finalBoard);
          setGameEnded(true);
    setShowGameEndDialog(true);
          setGameResult(result);
        }
      } else {
        // AI无合法落子，自动停手
        const newPasses = consecutivePasses + 1;
        setConsecutivePasses(newPasses);
        const endCheck = checkGameEnd(newBoard, newPasses, history.length + 1);
        if (endCheck.ended) {
          const result = calculateFinalScore(newBoard);
          setGameEnded(true);
    setShowGameEndDialog(true);
          setGameResult(result);
        }
      }

      setCurrentPlayer(playerColor);
      if (gameEpochRef.current === epochAtStart) {
        setIsAIThinking(false);
    setQueuePosition(0);
      }
    }
    isProcessingMoveRef.current = false;
  }, [board, currentPlayer, isAIThinking, isReplayMode, difficulty, engine, history, requestCommentary, gameEnded, consecutivePasses, boardSize, playerColor, token, deductPoints, refreshUser]);

  // ===== 自动保存 =====
  const autoSaveGame = useCallback(async () => {
    if (!autoSave || !user || autoSaving || isReplayMode) return;
    // 每步扣1积分，检查积分
    if (user.points < 1) {
      toast.error('积分不足，自动保存已暂停');
      setAutoSave(false);
      return;
    }
    setAutoSaving(true);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const res = await fetch('/api/games', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: savedGameIdRef.current,
          board_size: boardSize,
          difficulty,
          engine,
          moves: history,
          commentaries,
          teachHistory: teachHistory.map(e => ({ moveIndex: e.moveIndex, content: e.content, hintPosition: e.hintPosition, faded: e.faded })),
          final_board: board,
          black_score: score.black,
          white_score: score.white,
          status: 'playing',
          title: saveTitle || `${boardSize}路 ${difficulty === 'easy' ? '初级' : difficulty === 'medium' ? '中级' : '高级'} ${engine === 'katago' ? 'KataGo' : engine === 'gnugo' ? 'GnuGo' : '本地AI'} ${new Date().toLocaleDateString('zh-CN')}`,
          autoSave: true, // 标记为自动保存，后端扣1积分
        }),
      });
      const data = await res.json();
      if (data.game) {
        setSavedGameId(data.game.id);
        // 扣除1积分
        deductPoints(1);
      }
    } catch (err) {
      console.error('自动保存失败:', err);
    }
    setAutoSaving(false);
  }, [autoSave, user, autoSaving, isReplayMode, token, savedGameId, boardSize, difficulty, engine, history, commentaries, teachHistory, board, score, saveTitle, deductPoints]);

  // AI落子完成后触发自动保存（等解说流式完成后再保存）
  useEffect(() => {
    // 条件：自动保存开启 + AI已思考完 + 有落子历史 + 轮到玩家 + 游戏未结束 + 解说已结束
    if (autoSave && !isAIThinking && history.length > 0 && currentPlayer === playerColor && !gameEnded && !isCommentaryStreaming) {
      const timer = setTimeout(() => { autoSaveGame(); }, 1000);
      return () => clearTimeout(timer);
    }
  }, [autoSave, isAIThinking, history.length, currentPlayer, playerColor, gameEnded, commentaryVersion, isCommentaryStreaming]);


  // ===== 悔棋 =====
  const undoMove = useCallback(() => {
    if (history.length === 0) { toast.info('还没有落子，无法悔棋'); return; }
    if (isReplayMode) { toast.info('复盘模式下无法悔棋'); return; }
    if (isAIThinking) { toast.info('AI正在思考，请稍等'); return; }
    const stepsToUndo = history.length >= 2 ? 2 : 1;
    const newHistory = history.slice(0, -stepsToUndo);
    let newBoard = createEmptyBoard(boardSize);
    for (const move of newHistory) {
      if (!move.isPass) {
        const result = playMove(newBoard, move.position.row, move.position.col, move.color);
        newBoard = result.newBoard;
      }
    }
    setBoard(newBoard);
    setHistory(newHistory);
    setCurrentPlayer(playerColor);
    setLastMove(newHistory.length > 0 && !newHistory[newHistory.length - 1].isPass ? newHistory[newHistory.length - 1].position : null);
    setCommentaries(prev => prev.slice(0, -stepsToUndo));
  }, [history, boardSize, isReplayMode, playerColor]);

  // 创建带中断控制的fetch请求
  const createAbortableFetch = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    // 120秒超时（排队时可能等待其他用户的分析完成，30秒太短）
    setTimeout(() => {
      try { controller.abort(); } catch {}
    }, 120000);
    return controller.signal;
  }, []);

  // ===== 重新开始 =====
  const restartGame = useCallback(() => {
    const epoch = ++gameEpochRef.current;
    // 递增解说请求ID，使旧请求的isLatestRequest()返回false
    commentaryRequestId.current++;
    // 中止所有正在进行的AI请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // 中止正在进行的解说/教学/聊天请求
    if (commentaryAbortRef.current) {
      commentaryAbortRef.current.abort();
    }
    commentaryAbortRef.current = new AbortController();
    setIsAIThinking(false);
    setQueuePosition(0);
    setIsCommentaryStreaming(false);
    setStreamingText('');
    setIsTeachStreaming(false);
    setIsChatStreaming(false);
    const emptyBoard = createEmptyBoard(boardSize);
    setBoard(emptyBoard);
    setCurrentPlayer(playerColor);
    setHistory([]);
    setLastMove(null);
    setShowHint(null);
    setCommentaries([]);
    setSavedGameId(null);
    setSaveTitle('');
    latestAnalysisRef.current = null;
    setIsReplayMode(false);
    setReplayIndex(0);
    setReplayMoves([]);
    setTeachingMessage('');
    setTeachHistory([]);
    setTeachUsedCount(0);
    setConsecutivePasses(0);
    setGameEnded(false);
    setGameResult(null);
    setShowGameEndDialog(false);
    // AI先下：玩家执白时，AI（黑棋）先走
    if (playerColor === 'white') {
      setCurrentPlayer('black');
      // 延迟触发AI落子，等状态更新完成
      setTimeout(() => {
        void (async () => {
          setIsAIThinking(true);
          try {
            const aiColor = 'black';
            const res = await fetch('/api/go-engine', {
              method: 'POST',
              signal: createAbortableFetch(),
              headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
              body: JSON.stringify({ boardSize, difficulty, engine, moves: [], aiColor: 'black' }),
            });
            const data = await res.json();
            // 检查epoch，如果用户已经重新开始则丢弃结果
            if (gameEpochRef.current !== epoch) return;
            if (data.move) {
              const { row, col } = data.move;
              const { newBoard, captured } = playMove(emptyBoard, row, col, aiColor);
              if (newBoard) {
                setBoard(newBoard);
                setHistory([{ position: { row, col }, color: aiColor, captured }]);
                setCurrentPlayer(playerColor);
                void requestCommentary(newBoard, { row, col }, aiColor, captured, 0, []);
              }
            } else if (data.noEngine) {
              // 引擎不可用，用本地AI
              const aiMove = findBestHint(emptyBoard, aiColor);
              if (aiMove) {
                const { newBoard: nb, captured: cap } = playMove(emptyBoard, aiMove.row, aiMove.col, aiColor);
                if (nb) {
                  setBoard(nb);
                  setHistory([{ position: { row: aiMove.row, col: aiMove.col }, color: aiColor, captured: cap }]);
                  setCurrentPlayer(playerColor);
                  void requestCommentary(nb, { row: aiMove.row, col: aiMove.col }, aiColor, cap, 0, []);
                }
              }
            }
          } catch (err) {
            if (gameEpochRef.current !== epoch) return;
            console.warn('[engine] AI first move failed:', err);
          } finally {
            if (gameEpochRef.current === epoch) {
              setIsAIThinking(false);
    setQueuePosition(0);
            }
          }
        })();
      }, 200);
    }
  }, [boardSize, playerColor, difficulty, engine, token, requestCommentary]);

  // ===== 切换 KataGo 模型 =====
  const handleSwitchModel = useCallback(async (modelPath: string) => {
    if (!token || modelPath === selectedKataGoModel) return;
    setModelSwitching(true);
    try {
      const res = await fetch('/api/go-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'setConfig', model: modelPath }),
      });
      const data = await res.json();
      if (data.success) {
        setSelectedKataGoModel(modelPath);
        toast.success('AI 引擎已切换', { description: data.currentModel?.name || modelPath });
      } else {
        toast.error('引擎切换失败', { description: data.error || '未知错误' });
      }
    } catch (err) {
      toast.error('引擎切换失败', { description: err instanceof Error ? err.message : '网络错误' });
    } finally {
      setModelSwitching(false);
    }
  }, [token, selectedKataGoModel]);

  // ===== 停手 =====
  const passMove = useCallback(async () => {
    if (gameEnded) { toast.info('棋局已结束'); return; }
    if (isReplayMode) { toast.info('复盘模式下无法操作'); return; }
    if (isAIThinking) { toast.info('AI正在思考，请稍等'); return; }
    if (currentPlayer !== playerColor) { toast.info('现在不是你的回合'); return; }
    const aiColor: 'black' | 'white' = playerColor === 'black' ? 'white' : 'black';
    const epochAtStart = gameEpochRef.current;

    // 记录玩家停手到历史
    const passEntry = { position: { row: 0, col: 0 }, color: playerColor, captured: 0, isPass: true };
    const historyWithPass = [...history, passEntry];
    setHistory(historyWithPass);
    const passMoveIdx = history.length;
    requestCommentary(board, { row: 0, col: 0 }, playerColor, 0, passMoveIdx, historyWithPass, true);

    const newPasses = consecutivePasses + 1;
    setConsecutivePasses(newPasses);

    const endCheck = checkGameEnd(board, newPasses, historyWithPass.length);
    if (endCheck.ended) {
      // 满足严格结束条件
      const result = calculateFinalScore(board);
      setGameEnded(true);
    setShowGameEndDialog(true);
      setGameResult(result);
      return;
    }

    // AI回合
    setIsAIThinking(true);

    // 等待解说完成，避免流式输出被打断
    if (commentaryPromiseRef.current) {
      await commentaryPromiseRef.current;
    }

    // AI思考延迟
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

    // 检查epoch
    if (gameEpochRef.current !== epochAtStart) return;

    // AI也考虑停手（如果没好位置）
    const validMoves = getValidMoves(board, aiColor);
    if (validMoves.length === 0) {
      // AI也无子可下
      const result = calculateFinalScore(board);
      setGameEnded(true);
    setShowGameEndDialog(true);
      setGameResult(result);
      if (gameEpochRef.current === epochAtStart) setIsAIThinking(false);
      return;
    }

    // AI正常落子
    let aiMove: Position = validMoves[0];
    let usedEngine = false;

    if (engine !== 'local') {
      try {
        const moveHistoryForEngine = historyWithPass.map(m => ({
          row: m.position.row,
          col: m.position.col,
          color: m.color,
          ...(m.isPass ? { isPass: true } : {}),
        }));
        const res = await fetch('/api/go-engine', {
          method: 'POST',
          signal: createAbortableFetch(),
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({
            boardSize,
            moves: moveHistoryForEngine,
            difficulty,
            engine,
            aiColor,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          // 检查epoch
          if (gameEpochRef.current !== epochAtStart) return;
          if (data.move && isValidMove(board, data.move.row, data.move.col, aiColor)) {
            aiMove = data.move;
            usedEngine = true;
          } else if (data.pass) {
            // 引擎也停手，记录到历史并计入连续停手
            const aiPassEntry = { position: { row: 0, col: 0 }, color: aiColor, captured: 0, isPass: true };
            const historyWithAIPass = [...historyWithPass, aiPassEntry];
            setHistory(historyWithAIPass);
            requestCommentary(board, { row: 0, col: 0 }, aiColor, 0, historyWithPass.length, historyWithAIPass, true);

            const newPasses2 = consecutivePasses + 2; // 玩家+AI都停手
            setConsecutivePasses(newPasses2);
            const endCheck = checkGameEnd(board, newPasses2, historyWithAIPass.length);
            if (endCheck.ended) {
              const result = calculateFinalScore(board);
              setGameEnded(true);
    setShowGameEndDialog(true);
              setGameResult(result);
            }
            if (gameEpochRef.current === epochAtStart) setIsAIThinking(false);
            return;
          } else {
            console.warn(`[engine-restart] ${engine} returned invalid/null move, falling back. Data:`, data);
          }
        } else {
          console.warn(`[engine-restart] ${engine} API returned ${res.status}`);
        }
      } catch (engineErr) {
        if (engineErr instanceof DOMException && engineErr.name === 'AbortError') {
          if (gameEpochRef.current !== epochAtStart) return;
          console.warn(`[engine-restart] request aborted (not epoch change), falling back to local AI`);
        } else {
          console.warn(`[engine-restart] ${engine} fetch failed:`, engineErr);
        }
      }
    }

    if (!usedEngine) {
      if (difficulty === 'hard') {
        aiMove = hardAIMove(board, aiColor) || validMoves[0];
      } else if (difficulty === 'medium') {
        aiMove = mediumAIMove(board, aiColor) || validMoves[0];
      } else {
        aiMove = easyAIMove(board, aiColor) || validMoves[0];
      }
    }

    const moveIdx = history.length;
    const { newBoard: finalBoard, captured: aiCaptured } = playMove(board, aiMove.row, aiMove.col, aiColor);
    if (!finalBoard) {
      console.warn('[AI-passMove] playMove returned null for', aiMove, aiColor);
      setCurrentPlayer(playerColor);
      if (gameEpochRef.current === epochAtStart) setIsAIThinking(false);
      return;
    }
    const historyWithAIMove = [...history, { position: aiMove, color: aiColor as Stone, captured: aiCaptured }];

    setBoard(finalBoard);
    setLastMove({ row: aiMove.row, col: aiMove.col });
    setHistory(historyWithAIMove);
    setConsecutivePasses(0);

    // AI落子解说 - 同步发起
    requestCommentary(finalBoard, aiMove, aiColor, aiCaptured, moveIdx, historyWithAIMove);

    // 检查游戏结束
    const passEndCheck = checkGameEnd(finalBoard, 0, historyWithAIMove.length);
    if (passEndCheck.ended) {
      const result = calculateFinalScore(finalBoard);
      setGameEnded(true);
    setShowGameEndDialog(true);
      setGameResult(result);
    }

    setCurrentPlayer(playerColor);
    setCurrentPlayer(playerColor);
    if (gameEpochRef.current === epochAtStart) {
      setIsAIThinking(false);
    setQueuePosition(0);
    }
  }, [board, currentPlayer, isAIThinking, isReplayMode, gameEnded, consecutivePasses, difficulty, engine, history, requestCommentary, boardSize, playerColor, token]);

  // ===== 提示与教学（一体化流程：先KataGo分析→提示点位+教学内容） =====
  const getTeaching = useCallback(async () => {
    if (isTeachStreaming) return;
    // 检查每局使用次数限制
    if (teachUsedCount >= MAX_TEACH_PER_GAME) {
      toast.error('本局提示与教学已达上限', { description: `每局最多使用${MAX_TEACH_PER_GAME}次` });
      return;
    }
    // 检查积分（提示需要20积分）
    if (user && user.points < TEACH_COST) {
      toast.error('积分不足', { description: `提示与教学需要${TEACH_COST}积分，当前${user.points}积分` });
      return;
    }
    if (!user) {
      toast.error('请先登录', { description: '提示与教学需要登录' });
      return;
    }
    setIsTeachStreaming(true);
    setTeachingMessage('');
    setTeachHistory(prev => prev.map(e => ({ ...e, faded: true })));
    const currentMoveIndex = historyLengthRef.current; // 记录教学针对的手数（使用ref避免闭包过时）

    // 创建本轮教学专用的AbortController
    const thisAbortController = new AbortController();
    teachAbortRef.current = thisAbortController;
    const teachEpoch = historyLengthRef.current; // 记录当前手数，用于判断教学是否已过时

    try {
      // 第一步：请求KataGo分析，用分析结果的bestMoves作为提示点位
      let analysisData: typeof latestAnalysisRef.current = null;
      let hintPosition: Position | null = null;
      // 清除旧分析数据，防止使用上一步的残留数据
      latestAnalysisRef.current = null;

      if (token && boardSize > 0 && history.length > 0) {
        try {
          setTeachingMessage('正在请求KataGo分析...');
          const movesForAnalysis = history.map(h => ({
            row: h.position.row, col: h.position.col, color: h.color,
            ...(h.isPass ? { isPass: true } : {}),
          }));
          const analyzeController = new AbortController();
          const analyzeTimeout = setTimeout(() => analyzeController.abort(), 95000);
          const analyzeRes = await fetch('/api/go-engine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              action: 'analyze',
              boardSize,
              moves: movesForAnalysis,
            }),
            signal: AbortSignal.any
              ? AbortSignal.any([analyzeController.signal, thisAbortController.signal])
              : analyzeController.signal,
          });
          clearTimeout(analyzeTimeout);
          if (thisAbortController.signal.aborted) return;
          if (analyzeRes.ok) {
            const analyzeData = await analyzeRes.json();
            if (analyzeData.queueBusy) {
              // 队列繁忙，提示用户（积分已退回）
              setTeachingMessage(analyzeData.error || '当前AI任务队列繁忙，请稍后再试');
              setIsTeachStreaming(false);
              return;
            }
            if (analyzeData.insufficientPoints) {
              toast.error('积分不足', { description: analyzeData.error });
              setIsTeachStreaming(false);
              return;
            }
            if (analyzeData.analysis) {
              analysisData = analyzeData.analysis;
              latestAnalysisRef.current = analysisData;
              // 积分扣除成功，增加使用次数
              setTeachUsedCount(prev => prev + 1);
              // 更新前端积分显示
              if (user && analyzeData.pointsUsed) {
                deductPoints(analyzeData.pointsUsed);
              }
            }
          } else if (analyzeRes.status === 403) {
            // 积分不足
            const errorData = await analyzeRes.json().catch(() => ({}));
            toast.error('积分不足', { description: errorData.error || '积分不足' });
            setIsTeachStreaming(false);
            return;
          }
        } catch {
          // 分析失败/超时不影响教学，无分析数据也能给出专业解说
        }
      }

      // 再次检查是否已被用户落子中断
      if (thisAbortController.signal.aborted) return;

      // 第二步：确定提示点位 — 优先使用KataGo分析的bestMoves，否则本地评分
      if (analysisData?.bestMoves && analysisData.bestMoves.length > 0) {
        // 跳过pass/resign建议，取第一个有效坐标
        const validMove = analysisData.bestMoves.find(bm => bm.move !== 'pass' && bm.move !== 'resign');
        if (validMove) {
          const bestMove = validMove.move;
          // KataGo坐标格式: D4, Q16等，转换为row/col
          const colChar = bestMove.charAt(0).toUpperCase();
          const rowNum = parseInt(bestMove.substring(1));
          // KataGo坐标: 列A-T(跳过I), 行从1开始(1=底行)
          // 跳过I: A=0, B=1, ..., H=7, J=8, K=9, ...
          let actualCol = colChar.charCodeAt(0) - 'A'.charCodeAt(0);
          if (actualCol >= 8) actualCol -= 1; // 跳过I
          const actualRow = boardSize - rowNum;
          if (actualRow >= 0 && actualRow < boardSize && actualCol >= 0 && actualCol < boardSize) {
            hintPosition = { row: actualRow, col: actualCol };
          }
        }
      }
      if (!hintPosition) {
        hintPosition = findBestHint(board, currentPlayer);
      }
      // 只有未被中断时才设置提示点位
      if (hintPosition && !thisAbortController.signal.aborted) {
        setShowHint(hintPosition);
      }

      // 再次检查是否已被用户落子中断
      if (thisAbortController.signal.aborted) return;

      // 第三步：用分析数据+提示点位生成教学内容
      const teachingBody: Record<string, unknown> = {
        type: 'teach',
        board,
        currentPlayer,
        lastMove: lastMove ? { row: lastMove.row, col: lastMove.col } : undefined,
        analysis: analysisData,
      };
      if (hintPosition) {
        teachingBody.hintPosition = positionToCoordinate(hintPosition.row, hintPosition.col, boardSize);
      }
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        signal: thisAbortController.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(teachingBody),
      });
      if (response.ok) {
        let finalText = '';
        await readStream(response, text => {
          finalText = text;
          // 只有未被中断时才更新教学内容
          if (!thisAbortController.signal.aborted) {
            setTeachingMessage(text);
          }
        });
        // 保存到教学历史
        if (!thisAbortController.signal.aborted) {
          const entry: TeachEntry = {
            moveIndex: currentMoveIndex,
            hintPosition: hintPosition ?? null,
            content: finalText,
            faded: false,
          };
          setTeachHistory(prev => [...prev, entry]);
        }
      } else {
        console.warn('[teach] API returned', response.status);
        if (!thisAbortController.signal.aborted) {
          const fallbackMsg = '小围棋暂时无法思考，请稍后再试。';
          setTeachingMessage(fallbackMsg);
          const entry: TeachEntry = {
            moveIndex: currentMoveIndex,
            hintPosition: hintPosition ?? null,
            content: fallbackMsg,
            faded: false,
          };
          setTeachHistory(prev => [...prev, entry]);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (!thisAbortController.signal.aborted) {
        const fallbackMsg = '小围棋正在思考中...';
        setTeachingMessage(fallbackMsg);
        const entry: TeachEntry = {
          moveIndex: currentMoveIndex,
          hintPosition: null,
          content: fallbackMsg,
          faded: false,
        };
        setTeachHistory(prev => [...prev, entry]);
      }
    } finally {
      // 只有当前AbortController仍是最新的才重置状态
      if (teachAbortRef.current === thisAbortController) {
        teachAbortRef.current = null;
      }
      setIsTeachStreaming(false);
    }
  }, [board, currentPlayer, lastMove, isTeachStreaming, boardSize, history, token, teachUsedCount, user]);

  // ===== 聊天 =====
  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || isChatStreaming) return;
    const userMsg = inputMessage.trim();
    setInputMessage('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setMessages(prev => [...prev, { role: 'assistant', content: '🔍 正在帮你分析问题...' }]);
    setIsChatStreaming(true);
    try {
      // 先获取KataGo分析数据（每次都重新分析，避免使用旧数据）
      let chatAnalysis: typeof latestAnalysisRef.current = null;
      if (engine !== 'local' && board && history.length > 0) {
        try {
          const cacheMoves = history.map(m => ({
            row: m.position.row, col: m.position.col, color: m.color,
            ...(m.isPass ? { isPass: true } : {}),
          }));
          const analyzeRes = await fetch('/api/go-engine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({
              action: 'analyze', boardSize, moves: cacheMoves, aiColor: currentPlayer,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (analyzeRes.ok) {
            const analyzeData = await analyzeRes.json();
            if (analyzeData.analysis) {
              chatAnalysis = analyzeData.analysis;
              latestAnalysisRef.current = analyzeData.analysis;
            }
          }
        } catch { /* 分析失败不影响聊天 */ }
      }
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        signal: commentaryAbortRef.current?.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          type: 'chat',
          board,
          currentPlayer,
          lastMove: lastMove ? { row: lastMove.row, col: lastMove.col } : undefined,
          question: userMsg,
          analysis: chatAnalysis,
        }),
      });
      if (response.ok) {
        await readStream(response, text => {
          setMessages(prev => {
            const u = [...prev];
            u[u.length - 1] = { role: 'assistant', content: text };
            return u;
          });
        });
      } else {
        console.warn('[chat] API returned', response.status);
        setMessages(prev => [...prev, { role: 'assistant', content: '抱歉，小围棋暂时无法回答，请稍后再试。' }]);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setMessages(prev => [...prev, { role: 'assistant', content: '抱歉，遇到问题了，请再试。' }]);
    } finally {
      setIsChatStreaming(false);
    }
  }, [inputMessage, isChatStreaming, board, currentPlayer, lastMove]);

  // ===== 保存棋局 =====
  const saveGame = useCallback(async () => {
    if (isSaving) return;
    if (!user) {
      setSaveMessage('请先登录再保存棋局');
      return;
    }
    setIsSaving(true);
    setSaveMessage('');
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const res = await fetch('/api/games', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: savedGameId,
          board_size: boardSize,
          difficulty,
          engine,
          moves: history,
          commentaries,
          teachHistory: teachHistory.map(e => ({ moveIndex: e.moveIndex, content: e.content, hintPosition: e.hintPosition, faded: e.faded })),
          final_board: board,
          black_score: score.black,
          white_score: score.white,
          status: gameEnded ? 'finished' : 'playing',
          title: saveTitle || `${boardSize}路 ${difficulty === 'easy' ? '初级' : difficulty === 'medium' ? '中级' : '高级'} ${engine === 'katago' ? 'KataGo' : engine === 'gnugo' ? 'GnuGo' : '本地AI'} ${new Date().toLocaleDateString('zh-CN')}`,
        }),
      });
      const data = await res.json();
      if (data.game) {
        setSavedGameId(data.game.id);
        setSaveMessage('保存成功！');
        toast.success('棋局已保存', { description: '可在历史棋局中查看' });
        setTimeout(() => {
          setShowSaveDialog(false);
          setSaveMessage('');
        }, 800);
      } else if (data.error) {
        setSaveMessage(`保存失败：${data.error}`);
        toast.error('保存失败', { description: data.error });
      }
    } catch (err) {
      console.error('保存棋局失败:', err);
      setSaveMessage('保存失败，请重试');
      toast.error('保存失败', { description: '网络错误，请重试' });
    }
    setIsSaving(false);
  }, [user, token, savedGameId, boardSize, difficulty, engine, history, commentaries, board, score, saveTitle, isSaving]);

  // ===== 载入棋局列表 =====
  const loadGames = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/games', { headers });
      const data = await res.json();
      if (data.games) setSavedGames(data.games as SavedGame[]);
      else if (data.error) console.error('载入棋局失败:', data.error);
    } catch (err) {
      console.error('载入棋局失败:', err);
    }
  }, [token]);

  // ===== 载入棋局 =====
  const loadGame = useCallback(async (gameId: number) => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`/api/games/${gameId}`, { headers });
      const data = await res.json();
      const game = data.game as SavedGame;
      if (!game) return;

      setBoardSize(game.board_size);
      setDifficulty(game.difficulty);
      if (game.engine) setEngine(game.engine as EngineId);
      setHistory(game.moves || []);
      setCommentaries(game.commentaries || []);
      setTeachHistory(((game as unknown as Record<string, unknown>).teach_history || []) as TeachEntry[]);
      setSavedGameId(game.id ?? null);
      setSaveTitle((game as unknown as Record<string, unknown>).title as string || ''); // 载入棋局名称
      setIsReplayMode(true);
      setReplayIndex(0);

      // 重放棋步到初始状态
      setBoard(createEmptyBoard(game.board_size));
      setLastMove(null);
      setCurrentPlayer(playerColor);

      // 存储复盘数据
      setReplayMoves(game.moves || []);

      setShowLoadDialog(false);
    } catch (err) {
      console.error('载入棋局失败:', err);
    }
  }, []);

  // 支持 ?loadGame=xxx URL 参数自动加载复盘
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const loadGameId = params.get('loadGame');
    if (loadGameId) {
      const id = parseInt(loadGameId, 10);
      if (!isNaN(id)) {
        loadGame(id);
        params.delete('loadGame');
        const newSearch = params.toString();
        const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
        window.history.replaceState(null, '', newUrl);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 删除棋局 =====
  const deleteGame = useCallback(async (gameId: number) => {
    try {
      await fetch(`/api/games?id=${gameId}`, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} });
      setSavedGames(prev => prev.filter(g => g.id !== gameId));
    } catch (err) {
      console.error('删除棋局失败:', err);
    }
  }, [token]);

  // ===== 复盘导航 =====
  const replayStep = useCallback((direction: number) => {
    const newIdx = Math.max(0, Math.min(replayMoves.length, replayIndex + direction));
    setReplayIndex(newIdx);

    // 重放到指定步数（跳过pass）
    let newBoard = createEmptyBoard(boardSize);
    for (let i = 0; i < newIdx; i++) {
      const move = replayMoves[i];
      if (!move.isPass) {
        const result = playMove(newBoard, move.position.row, move.position.col, move.color);
        newBoard = result.newBoard;
      }
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

  // 从复盘的当前步继续对弈
  const resumeFromReplay = useCallback(() => {
    if (!isReplayMode || replayIndex === 0) {
      // 没有步数，直接退出复盘重开
      exitReplay();
      return;
    }

    // 截取到当前步的落子历史
    const truncatedMoves = replayMoves.slice(0, replayIndex);
    const truncatedCommentaries = commentaries.filter(c => c.moveIndex < replayIndex);

    // 重放到当前步的棋盘状态（跳过pass）
    let newBoard = createEmptyBoard(boardSize);
    for (let i = 0; i < truncatedMoves.length; i++) {
      const move = truncatedMoves[i];
      if (!move.isPass) {
        const result = playMove(newBoard, move.position.row, move.position.col, move.color);
        newBoard = result.newBoard;
      }
    }

    // 判断下一步是谁：偶数步=黑方，奇数步=白方
    const nextColor: Stone = replayIndex % 2 === 0 ? 'black' : 'white';

    // 设置状态
    setBoard(newBoard);
    setHistory(truncatedMoves);
    setCommentaries(truncatedCommentaries);
    setLastMove(replayIndex > 0 && !replayMoves[replayIndex - 1].isPass ? replayMoves[replayIndex - 1].position : null);
    setGameEnded(false);
    setShowGameEndDialog(false);
    setConsecutivePasses(0);
    setShowHint(null);
    setCurrentPlayer(nextColor);

    // 清理流式状态
    commentaryRequestId.current++;
    setIsCommentaryStreaming(false);
    setStreamingText('');
    setIsTeachStreaming(false);
    setIsChatStreaming(false);

    // 退出复盘模式
    setIsReplayMode(false);
    setReplayIndex(0);
    setReplayMoves([]);

    // 如果下一步是AI的回合，延迟触发AI落子
    if (nextColor !== playerColor) {
      const resumeEpoch = ++gameEpochRef.current;
      setTimeout(() => {
        void (async () => {
          setIsAIThinking(true);
          try {
            const aiColorCalc = nextColor;
            const moveHistoryForEngine = truncatedMoves.map(m => ({
              row: m.position.row,
              col: m.position.col,
              color: m.color,
              ...(m.isPass ? { isPass: true } : {}),
            }));
            let aiMove: Position | null = null;
            let usedEngine = false;

            if (engine !== 'local') {
              try {
                const res = await fetch('/api/go-engine', {
                  method: 'POST',
                  signal: createAbortableFetch(),
                  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                  body: JSON.stringify({ boardSize, difficulty, engine, moves: moveHistoryForEngine, aiColor: aiColorCalc }),
                });
                const data = await res.json();
                if (data.move && isValidMove(newBoard, data.move.row, data.move.col, aiColorCalc)) {
                  aiMove = data.move;
                  usedEngine = true;
                } else if (data.pass) {
                  console.log(`[frontend] Engine pass (replay resume)`);
                  // AI停手，记录到历史
                  const aiPassEntry = { position: { row: 0, col: 0 }, color: aiColorCalc as Stone, captured: 0, isPass: true };
                  const historyWithAIPass = [...truncatedMoves, aiPassEntry];
                  setHistory(historyWithAIPass);
                  requestCommentary(newBoard, { row: 0, col: 0 }, aiColorCalc, 0, truncatedMoves.length, historyWithAIPass, true);

                  setConsecutivePasses(prev => {
                    const newPasses = prev + 1;
                    const endCheck = checkGameEnd(newBoard, newPasses, historyWithAIPass.length);
                    if (endCheck.ended) {
                      const result = calculateFinalScore(newBoard);
                      setGameEnded(true);
                      setShowGameEndDialog(true);
                      setGameResult(result);
                    }
                    return newPasses;
                  });
                  setCurrentPlayer(playerColor);
                  setIsAIThinking(false);
    setQueuePosition(0);
                  return;
                } else {
                  console.warn(`[frontend] Engine returned invalid/null move. data:`, JSON.stringify(data));
                }
              } catch (err) {
                console.warn(`[frontend] Engine fetch failed:`, err instanceof Error ? err.message : String(err));
                // 引擎失败，用本地AI
              }
            }

            if (!usedEngine) {
              const validMoves = getValidMoves(newBoard, aiColorCalc);
              if (validMoves.length === 0) {
                // AI无合法落子
                setConsecutivePasses(prev => {
                  const newPasses = prev + 1;
                  const endCheck = checkGameEnd(newBoard, newPasses, replayIndex + 2);
                  if (endCheck.ended) {
                    const result = calculateFinalScore(newBoard);
                    setGameEnded(true);
                    setShowGameEndDialog(true);
                    setGameResult(result);
                  }
                  return newPasses;
                });
                setCurrentPlayer(playerColor);
                setIsAIThinking(false);
    setQueuePosition(0);
                return;
              }
              if (difficulty === 'hard') {
                aiMove = hardAIMove(newBoard, aiColorCalc) || validMoves[0];
              } else if (difficulty === 'medium') {
                aiMove = mediumAIMove(newBoard, aiColorCalc) || validMoves[0];
              } else {
                aiMove = easyAIMove(newBoard, aiColorCalc) || validMoves[0];
              }
            }

            if (aiMove) {
              const { newBoard: finalBoard, captured: aiCaptured } = playMove(newBoard, aiMove.row, aiMove.col, aiColorCalc);
              const aiMoveIdx = truncatedMoves.length;
              const historyWithAIMove = [...truncatedMoves, { position: aiMove, color: aiColorCalc as Stone, captured: aiCaptured }];

              setBoard(finalBoard);
              setLastMove({ row: aiMove.row, col: aiMove.col });
              setHistory(historyWithAIMove);
              setCurrentPlayer(playerColor);
              requestCommentary(finalBoard, aiMove, aiColorCalc, aiCaptured, aiMoveIdx, historyWithAIMove);
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            console.warn('[resumeFromReplay] AI move failed:', err);
          } finally {
            if (gameEpochRef.current === resumeEpoch) setIsAIThinking(false);
          }
        })();
      }, 300);
    }
  }, [isReplayMode, replayIndex, replayMoves, boardSize, commentaries, exitReplay, playerColor, engine, difficulty, requestCommentary]);

  // 教程与百科数据
  const allTutorialSteps = getAllSteps();
  const currentChapter = GO_TUTORIAL[tutorialChapterIdx];
  const currentStep = currentChapter?.steps[tutorialStepIdx];

  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-amber-100 via-amber-50 to-orange-50">
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
            <User className="w-3 h-3" /> {user?.nickname || '棋手'}
          </Badge>

          {/* 棋盘尺寸 */}
          {BOARD_SIZES.map(({ size, label, desc }) => (
            <Button
              key={size}
              size="sm"
              variant={boardSize === size ? 'default' : 'outline'}
              onClick={() => {
                if (size === boardSize) return;
                if (history.length > 0 && !gameEnded) {
                  setRestartConfirmMsg('切换棋盘大小将重新开始一局棋，当前棋局不会保存。');
                  setPendingRestartAction(() => () => changeBoardSize(size));
                  setShowRestartConfirm(true);
                } else {
                  changeBoardSize(size);
                }
              }}
              className={boardSize === size ? 'bg-amber-700 hover:bg-amber-800 h-7 text-xs' : 'h-7 text-xs'}
              disabled={isReplayMode}
            >
              {label}<span className="ml-0.5 opacity-60">{desc}</span>
            </Button>
          ))}

          {/* 引擎选择 */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-amber-600 mr-0.5">引擎{isReplayMode ? ' 🔒' : ''}</span>
            {ENGINE_OPTIONS.map(({ id, name, desc }) => {
              const avail = availableEngines[id];
              const isLoading = enginesLoading && id !== 'local' && !avail;
              const isActive = engine === id && avail;
              const cost = ENGINE_COSTS[id as keyof typeof ENGINE_COSTS] || 0;
              const needLogin = cost > 0 && !user;
              const insufficientPoints = user && user.points < cost;
              return (
                <button
                  key={id}
                  onClick={() => {
                    if (!avail || isLoading || isReplayMode) return;
                    if (id === engine) return;
                    if (needLogin) {
                      toast.error('请先登录', { description: `${name}引擎需要登录后使用（${cost}积分/步）` });
                      setAuthTab('login');
                      setShowAuthDialog(true);
                      return;
                    }
                    if (insufficientPoints) {
                      toast.error('积分不足', { description: `${name}每步需要${cost}积分，您当前${user?.points ?? 0}积分` });
                      return;
                    }
                    // 如果棋局已开始（有落子历史），弹窗确认
                    if (history.length > 0 && !gameEnded) {
                      setRestartConfirmMsg(`切换引擎将重新开始一局棋，当前棋局不会保存。`);
                      setPendingRestartAction(() => () => {
                        setEngine(id);
                        restartGame();
                      });
                      setShowRestartConfirm(true);
                    } else {
                      // 棋局未开始或已结束，直接切换
                      setEngine(id);
                      restartGame();
                    }
                  }}
                  disabled={isReplayMode || !avail || isLoading || needLogin}
                  title={isReplayMode ? '复盘模式中不可切换引擎' : isLoading ? `${name}加载中...` : needLogin ? `请先登录使用${name}（${cost}积分/步）` : insufficientPoints ? `积分不足（需要${cost}，当前${user?.points ?? 0}）` : avail ? `${desc}（${cost ? cost + '积分/步' : '免费'}）` : `${name}不可用`}
                  className={`
                    h-7 px-2 text-xs rounded-md border transition-colors flex items-center gap-1
                    ${isActive
                      ? isReplayMode
                        ? 'bg-amber-100 text-amber-700 border-amber-300 cursor-not-allowed'
                        : 'bg-amber-700 text-white border-amber-700 hover:bg-amber-800'
                      : needLogin || insufficientPoints
                        ? 'bg-red-50 border-red-200 text-red-300 cursor-not-allowed'
                        : isLoading
                          ? 'bg-amber-50 border-amber-200 text-amber-500 cursor-wait'
                          : avail
                            ? isReplayMode
                              ? 'bg-gray-50 border-gray-200 text-gray-300 cursor-not-allowed'
                              : 'bg-white border-gray-200 hover:border-amber-400 text-gray-700'
                            : 'bg-gray-100 border-gray-200 text-gray-300 cursor-not-allowed line-through'
                    }
                  `}
                >
                  {isLoading && <Spinner className="w-3 h-3" />}
                  {isReplayMode && isActive && <span>🔒</span>}
                  {name}
                  {cost > 0 && <span className="text-[9px] opacity-70">{cost}分</span>}
                </button>
              );
            })}
          </div>

          {/* KataGo 模型选择 - 短期禁用：单进程架构下模型切换会导致全局冷启动 */}
          {false && engine === 'katago' && availableEngines.katago && availableKataGoModels.length > 0 && user && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-amber-600 mr-0.5">引擎模型</span>
              <select
                value={selectedKataGoModel}
                onChange={e => {
                  const path = e.target.value;
                  if (path === selectedKataGoModel) return;
                  if (history.length > 0 && !gameEnded) {
                    setRestartConfirmMsg('切换 AI 模型将重新开始一局棋，当前棋局不会保存。');
                    setPendingRestartAction(() => () => {
                      void handleSwitchModel(path);
                      restartGame();
                    });
                    setShowRestartConfirm(true);
                  } else {
                    void handleSwitchModel(path);
                  }
                }}
                disabled={modelSwitching || isReplayMode}
                className={`
                  h-7 px-2 text-xs rounded-md border transition-colors focus:outline-none focus:ring-1 focus:ring-amber-400
                  ${modelSwitching
                    ? 'bg-amber-50 border-amber-200 text-amber-500 cursor-wait'
                    : isReplayMode
                      ? 'bg-gray-50 border-gray-200 text-gray-300 cursor-not-allowed'
                      : 'bg-white border-gray-200 hover:border-amber-400 text-gray-700'
                  }
                `}
              >
                {availableKataGoModels.map(m => (
                  <option key={m.path} value={m.path}>
                    {m.displayName.split(' (')[0]} ({m.sizeMB}MB)
                  </option>
                ))}
              </select>
              {modelSwitching && <Spinner className="w-3 h-3" />}
            </div>
          )}

          {/* 难度 */}
          {DIFFICULTIES.map(({ key, label, emoji }) => (
            <Button
              key={key}
              size="sm"
              variant={difficulty === key ? 'default' : 'outline'}
              onClick={() => {
                if (key === difficulty) return;
                setDifficulty(key);
                const diffInfo = DIFFICULTIES.find(d => d.key === key);
                setDifficultyToast(`难度已调整为${diffInfo?.emoji || ''} ${diffInfo?.label || key}`);
              }}
              className={difficulty === key ? 'bg-amber-700 hover:bg-amber-800 h-7 text-xs' : 'h-7 text-xs'}
              disabled={isReplayMode}
            >
              {emoji} {label}
            </Button>
          ))}

          {/* 执子选择 */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-amber-600 mr-0.5">执子</span>
            {([
              { key: 'black' as const, label: '⚫黑先', desc: '你执黑' },
              { key: 'white' as const, label: '⚪白后', desc: '你执白' },
            ]).map(({ key, label }) => (
              <Button
                key={key}
                size="sm"
                variant={playerColor === key ? 'default' : 'outline'}
                onClick={() => {
                  if (key === playerColor) return;
                  if (history.length > 0 && !gameEnded) {
                    setRestartConfirmMsg('切换执子颜色将重新开始一局棋，当前棋局不会保存。');
                    setPendingRestartAction(() => () => {
                      setPlayerColor(key);
                      setNeedsNewGame(true);
                    });
                    setShowRestartConfirm(true);
                  } else {
                    setPlayerColor(key);
                    setNeedsNewGame(true);
                  }
                }}
                className={playerColor === key ? 'bg-amber-700 hover:bg-amber-800 h-7 text-xs' : 'h-7 text-xs'}
                disabled={isReplayMode}
              >
                {label}
              </Button>
            ))}
          </div>

          {/* 围观AI对弈入口 */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => router.push('/ai-test')}
            className="h-7 text-xs"
            title="围观AI对弈"
          >
            <Eye className="w-3 h-3 mr-1" />
            围观AI对弈
          </Button>
        </div>
      </header>

      {/* 本地开发警告 */}
      {isLocalhost && (
        <div className="bg-orange-100 border-b border-orange-300 px-4 py-2 text-center text-xs text-orange-700">
          <span className="font-semibold">⚠️ 本地开发环境</span> — 当前连接的是线上数据库，操作会写入真实数据。请使用测试账号，避免影响线上用户。
        </div>
      )}

      {/* 引擎加载提示 */}
      {enginesLoading && (
        <div className="bg-amber-500 text-white border-b border-amber-600 px-4 py-3 flex items-center justify-center gap-2 text-sm font-medium shadow-md z-50">
          <Spinner className="w-4 h-4" />
          <span>AI引擎加载中，请稍候，暂时无法下棋...</span>
        </div>
      )}

      {/* 主内容 - 桌面端固定视口高度，避免页面整体滚动 */}
      <div className="max-w-7xl mx-auto px-3 pb-3 grid grid-cols-1 lg:grid-cols-12 gap-3 lg:h-[calc(100vh-120px)]">
        {/* 左侧面板 */}
        <div className="lg:col-span-3 space-y-3 lg:overflow-y-auto lg:pr-1">
          {/* 用户信息 */}
          <Card className="bg-white/90 shadow-lg">
            <CardContent className="py-2 px-3">
              {user ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-bold text-sm flex-shrink-0">
                      {user.nickname.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{user.nickname}</div>
                      <div className="text-xs text-gray-500 flex items-center gap-1">
                        <span className="text-amber-600">💎 {user.points}</span>
                        <span className="text-gray-300">|</span>
                        <span>{user.totalGames}局</span>
                        <span className="text-gray-300">|</span>
                        <span>胜{user.wins}</span>
                      </div>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={logout} className="text-gray-400 hover:text-gray-600 h-7 px-2 flex-shrink-0">
                    退出
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">登录后可保存棋局和使用KataGo/GnuGo引擎</span>
                  <Button size="sm" onClick={() => setShowAuthDialog(true)} className="h-7 px-3 text-xs bg-amber-500 hover:bg-amber-600">
                    登录
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 比分 */}
          <Card className="bg-white/90 shadow-lg">
            <CardContent className="py-3">
              <div className="flex justify-around text-center">
                <div className="flex flex-col items-center">
                  <div className="w-7 h-7 rounded-full bg-gray-800 shadow mb-1" />
                  <span className="text-xs text-gray-500">黑方{playerColor === 'black' ? '(你)' : '(AI)'}</span>
                  <span className="text-lg font-bold">{score.black}</span>
                  <span className="text-[9px] text-gray-400">提{captures.black}子</span>
                </div>
                <div className="flex items-center text-gray-300 text-xs">VS</div>
                <div className="flex flex-col items-center">
                  <div className="w-7 h-7 rounded-full bg-white border-2 border-gray-300 shadow mb-1" />
                  <span className="text-xs text-gray-500">白方{playerColor === 'white' ? '(你)' : '(AI)'}</span>
                  <span className="text-lg font-bold">{score.white}</span>
                  <span className="text-[9px] text-gray-400">贴目{getKomi(boardSize)} 提{captures.white}子</span>
                </div>
              </div>
              <div className="mt-2 text-center">
                {isReplayMode && replayIndex > 0 ? (
                  <Badge className="text-xs px-3" style={{
                    backgroundColor: replayMoves[replayIndex - 1]?.color === 'black' ? '#1f2937' : '#f9fafb',
                    color: replayMoves[replayIndex - 1]?.color === 'black' ? '#fff' : '#374151',
                    border: replayMoves[replayIndex - 1]?.color === 'white' ? '1px solid #d1d5db' : 'none',
                  }}>
                    复盘 {replayIndex}/{replayMoves.length}手 {replayMoves[replayIndex - 1]?.color === 'black' ? '黑' : '白'} {replayMoves[replayIndex - 1]?.isPass ? '停一手' : positionToCoordinate(replayMoves[replayIndex - 1].position.row, replayMoves[replayIndex - 1].position.col, boardSize)}
                  </Badge>
                ) : isReplayMode ? (
                  <Badge variant="secondary" className="text-xs px-3">
                    复盘 0/{replayMoves.length}手
                  </Badge>
                ) : (
                  <div className="flex flex-col items-center gap-0.5">
                    <Badge variant={currentPlayer === playerColor ? 'default' : 'secondary'} className={`text-xs px-3 ${isAIThinking ? 'animate-pulse bg-amber-500 text-white' : ''}`}>
                      {gameEnded ? '棋局结束' : isAIThinking ? (queuePosition > 0 ? `AI排队中，你在第${queuePosition}位` : 'AI思考中，请等待...') : currentPlayer === playerColor ? `轮到你落子（已下${history.length}手）` : 'AI回合'}
                      {isAIThinking && <Spinner className="w-3 h-3 ml-1 inline" />}
                    </Badge>
                    {lastEngineInfo && lastEngineInfo.modelUsed && (
                      <span className="text-[10px] text-gray-400">
                        {lastEngineInfo.engine === 'katago' ? 'KataGo' : lastEngineInfo.engine === 'gnugo' ? 'GnuGo' : '本地AI'}
                        {lastEngineInfo.modelUsed ? ` · ${lastEngineInfo.modelUsed}` : ''}
                        {lastEngineInfo.actualVisits ? ` · ${lastEngineInfo.actualVisits} visits` : ''}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 控制按钮 */}
          <Card className="bg-white/90 shadow-lg">
            <CardContent className="py-3 grid grid-cols-2 gap-1.5">
              <Button onClick={restartGame} variant="outline" size="sm" className="gap-1 h-8 text-xs" disabled={isReplayMode}>
                <RotateCcw className="w-3 h-3" /> 重新开始
              </Button>
              <Button onClick={undoMove} variant="outline" size="sm" className="gap-1 h-8 text-xs" disabled={history.length === 0 || isReplayMode || isAIThinking}>
                <RotateCcw className="w-3 h-3" /> 悔棋
              </Button>
              <Button onClick={passMove} variant="outline" size="sm" className="gap-1 h-8 text-xs" disabled={currentPlayer !== playerColor || isAIThinking || isReplayMode || gameEnded}>
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
                  <div className="space-y-3">
                    <div className="text-sm text-muted-foreground">棋手：{user?.nickname || '未登录'}</div>
                    <Input value={saveTitle} onChange={e => setSaveTitle(e.target.value)} placeholder="棋局名称（可选）" />
                    {saveMessage && (
                      <p className={`text-sm ${saveMessage.includes('成功') ? 'text-green-600' : 'text-red-500'}`}>{saveMessage}</p>
                    )}
                    <Button onClick={saveGame} disabled={isSaving} className="w-full bg-amber-700 hover:bg-amber-800">
                      {isSaving ? '保存中...' : '确认保存'}
                    </Button>
                    {/* 自动保存开关 */}
                    {user && (
                      <div className="flex items-center justify-between pt-1 border-t">
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-600">自动保存每步</label>
                          <span className="text-xs text-gray-400">（1积分/步）</span>
                        </div>
                        <button
                          onClick={() => setAutoSave(!autoSave)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${autoSave ? 'bg-amber-600' : 'bg-gray-300'}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${autoSave ? 'translate-x-4.5' : 'translate-x-1'}`} />
                        </button>
                      </div>
                    )}
                  </div>
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
                                {g.board_size}路 | {g.difficulty === 'easy' ? '初级' : g.difficulty === 'medium' ? '中级' : '高级'} | 黑{g.black_score} - 白{g.white_score} {g.created_at ? `| ${new Date(g.created_at).toLocaleDateString('zh-CN')}` : ''}
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
                {replayIndex > 0 && (
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <div className={`w-5 h-5 rounded-full ${replayMoves[replayIndex - 1].color === 'black' ? 'bg-gray-800' : 'bg-white border border-gray-300'}`} />
                    <span className="text-sm font-medium text-blue-800">
                      {replayMoves[replayIndex - 1].color === 'black' ? '黑' : '白'} {replayMoves[replayIndex - 1].isPass ? '停一手' : positionToCoordinate(replayMoves[replayIndex - 1].position.row, replayMoves[replayIndex - 1].position.col, boardSize)}
                    </span>
                  </div>
                )}
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
                {replayIndex > 0 && (
                  <Button size="sm" className="w-full mt-2 bg-green-600 hover:bg-green-700 text-white" onClick={resumeFromReplay}>
                    从第{replayIndex}步继续对弈
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* 提示+教学 */}
          <Card className="bg-gradient-to-br from-amber-50 to-yellow-50 border-amber-200">
            <CardContent className="py-3">
              <Button
                onClick={() => {
                  if (!isTeachStreaming) getTeaching();
                }}
                variant="default"
                size="sm"
                className="w-full gap-1.5 h-9 bg-amber-600 hover:bg-amber-700"
                disabled={isReplayMode || isTeachStreaming || gameEnded || isAIThinking || teachUsedCount >= MAX_TEACH_PER_GAME}
              >
                <Lightbulb className="w-4 h-4" /> 提示与教学
                {isTeachStreaming && <Spinner className="w-3 h-3 ml-1" />}
                <span className="text-xs opacity-80">{teachUsedCount}/{MAX_TEACH_PER_GAME} · {TEACH_COST}积分</span>
              </Button>
              {(teachHistory.length > 0 || teachingMessage || isTeachStreaming) && (
                <div ref={teachScrollRef} className="mt-2 max-h-48 overflow-y-auto pr-1 space-y-2">
                  {teachHistory.map((entry, idx) => (
                    <div key={idx} className={`space-y-0.5 ${entry.faded ? 'opacity-40' : ''}`}>
                      {entry.hintPosition && (
                        <p className={`text-xs font-medium ${entry.faded ? 'text-amber-400' : 'text-amber-700'}`}>
                          建议落在 {positionToCoordinate(entry.hintPosition.row, entry.hintPosition.col, boardSize)}
                        </p>
                      )}
                      <p className={`text-xs leading-relaxed whitespace-pre-wrap ${entry.faded ? 'text-gray-400' : 'text-gray-700'}`}>
                        <span className="text-amber-600 font-medium">【第{entry.moveIndex + 1}手】</span>
                        {entry.content}
                      </p>
                    </div>
                  ))}
                  {(teachingMessage || isTeachStreaming) && !teachHistory.find(e => !e.faded) && (
                    <div className="space-y-1">
                      {showHint && (
                        <p className="text-xs text-amber-700 font-medium">
                          建议落在 {positionToCoordinate(showHint.row, showHint.col, boardSize)}
                        </p>
                      )}
                      <p className="text-xs leading-relaxed whitespace-pre-wrap text-gray-700">
                        {isTeachStreaming ? '正在分析...' : teachingMessage}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 游戏结束 - 居中弹窗 */}

        </div>

        {/* 中间：棋盘 + 聊天 */}
        <div className="lg:col-span-5 space-y-3 lg:overflow-y-auto">
          <div className="flex justify-center" style={{ touchAction: 'manipulation' }}>
            <GoBoard board={board} boardSize={boardSize} lastMove={lastMove} showHint={showHint} isAIThinking={isAIThinking} isReplayMode={isReplayMode} onMove={handleMove} />
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
                  {commentaries.map((entry, idx) => {
                    // 围棋中 moveIndex 偶数=黑方，奇数=白方，以此为准避免颜色标记错误
                    const displayColor: 'black' | 'white' = entry.moveIndex % 2 === 0 ? 'black' : 'white';
                    return (
                    <div key={idx} className={`rounded-lg px-3 py-2 ${displayColor === 'black' ? 'bg-gray-50 border-l-3 border-gray-700' : 'bg-orange-50 border-l-3 border-orange-400'}`}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <div className={`w-4 h-4 rounded-full ${displayColor === 'black' ? 'bg-gray-800' : 'bg-white border border-gray-300'}`} />
                        <span className="text-xs font-medium text-gray-600">
                          第{entry.moveIndex + 1}手 | {displayColor === 'black' ? '黑方' : '白方'} {entry.isPass ? '停一手' : positionToCoordinate(entry.position.row, entry.position.col, boardSize)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-700 leading-relaxed">{entry.commentary}</p>
                    </div>
                    );
                  })}
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
      <Dialog open={showGameEndDialog} onOpenChange={(open) => { if (!open) setShowGameEndDialog(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="items-center">
            <DialogTitle className="flex flex-col items-center gap-2">
              <Trophy className="w-12 h-12 text-yellow-500" />
              <span className="text-xl">{gameResult?.winner === playerColor ? '你赢了!' : (playerColor === 'black' ? '白方(AI)获胜' : '黑方(AI)获胜')}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="text-center space-y-3 py-2">
            <p className="text-sm text-gray-600">{gameResult?.detail}</p>
            <div className="flex gap-3 justify-center">
              <Button onClick={saveGame} disabled={isSaving} variant="outline" size="lg" className="px-6">
                {isSaving ? '保存中...' : '保存棋局'}
              </Button>
              <Button onClick={restartGame} size="lg" className="bg-amber-700 hover:bg-amber-800 text-white px-6">
                再来一局
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 重开确认弹窗（引擎/执子/棋盘大小切换） */}
      <Dialog open={showRestartConfirm} onOpenChange={(open) => { if (!open) { setShowRestartConfirm(false); setPendingRestartAction(null); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重新开始</DialogTitle>
            <DialogDescription>{restartConfirmMsg}</DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => { setShowRestartConfirm(false); setPendingRestartAction(null); }}>
              取消
            </Button>
            <Button className="bg-amber-700 hover:bg-amber-800 text-white" onClick={() => {
              if (pendingRestartAction) {
                pendingRestartAction();
              }
              setShowRestartConfirm(false);
              setPendingRestartAction(null);
            }}>
              确认并重开
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 难度调整提示 */}
      {difficultyToast && (
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-white/95 shadow-lg rounded-lg px-5 py-3 text-sm font-medium text-amber-800 border border-amber-200 transition-all duration-300 animate-in fade-in slide-in-from-top-2"
          onAnimationEnd={() => {}}
        >
          {difficultyToast}
        </div>
      )}

      {/* 登录/注册弹窗 */}
      <Dialog open={showAuthDialog} onOpenChange={(open) => { setShowAuthDialog(open); if (!open) setAuthError(''); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{authTab === 'login' ? '登录' : '注册'}</DialogTitle>
            <DialogDescription>
              {authTab === 'login' ? '登录后即可与AI对弈' : '注册账号，获取1000积分'}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={async (e: React.FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const n = fd.get('nickname') as string;
              const p = fd.get('password') as string;
              if (authTab === 'register') {
                const cp = fd.get('confirmPassword') as string;
                if (p !== cp) { setAuthError('两次密码不一致'); return; }
              }
              setAuthSubmitting(true);
              setAuthError('');
              try {
                if (authTab === 'login') {
                  const result = await login(n, p);
                  if (!result.success) { setAuthError(result.error || '登录失败'); return; }
                  setShowAuthDialog(false);
                  if (result.dailyBonusAwarded && result.dailyBonusAmount) {
                    toast.success(`每日登录奖励 +${result.dailyBonusAmount}积分！`);
                  }
                } else {
                  const result = await register(n, p);
                  if (!result.success) { setAuthError(result.error || '注册失败'); return; }
                  setShowAuthDialog(false);
                }
              } catch { setAuthError('网络错误'); }
              finally { setAuthSubmitting(false); }
            }}
            className="space-y-3"
          >
            <div>
              <label className="text-sm font-medium text-gray-700">昵称</label>
              <input name="nickname" required minLength={2} maxLength={20}
                className="w-full mt-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                placeholder="2-20个字符" />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700">密码</label>
              <input name="password" type="password" required minLength={6} maxLength={50}
                className="w-full mt-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                placeholder="6-50个字符" />
            </div>
            {authTab === 'register' && (
              <div>
                <label className="text-sm font-medium text-gray-700">确认密码</label>
                <input name="confirmPassword" type="password" required minLength={6}
                  className="w-full mt-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                  placeholder="再次输入密码" />
              </div>
            )}
            {authError && <p className="text-xs text-red-500">{authError}</p>}
            <Button type="submit" disabled={authSubmitting} className="w-full bg-amber-600 hover:bg-amber-700 text-white">
              {authSubmitting ? '处理中...' : authTab === 'login' ? '登录' : '注册'}
            </Button>
            <p className="text-xs text-center text-gray-500">
              {authTab === 'login' ? (
                <>没有账号？<button type="button" className="text-amber-600 hover:underline" onClick={() => { setAuthTab('register'); setAuthError(''); }}>注册</button></>
              ) : (
                <>已有账号？<button type="button" className="text-amber-600 hover:underline" onClick={() => { setAuthTab('login'); setAuthError(''); }}>登录</button></>
              )}
            </p>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
