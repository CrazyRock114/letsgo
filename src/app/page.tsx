'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { 
  createEmptyBoard, 
  playMove, 
  isValidMove, 
  evaluateBoard,
  type Stone, 
  type Board, 
  type Position 
} from '@/lib/go-logic';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  Trophy
} from 'lucide-react';

const BOARD_SIZE = 9; // 简化版9路棋盘，适合初学者

export default function GoGamePage() {
  const [board, setBoard] = useState<Board>(() => createEmptyBoard(BOARD_SIZE));
  const [currentPlayer, setCurrentPlayer] = useState<Stone>('black');
  const [history, setHistory] = useState<Array<{ position: Position; color: Stone; captured: number }>>([]);
  const [teachingMessage, setTeachingMessage] = useState<string>('');
  const [isAIThinking, setIsAIThinking] = useState(false);
  const [showHint, setShowHint] = useState<Position | null>(null);
  const [gameMode, setGameMode] = useState<'play' | 'learn'>('play');
  const [lastMove, setLastMove] = useState<Position | null>(null);
  const [score, setScore] = useState({ black: 0, white: 0 });
  const [lessonStep, setLessonStep] = useState(0);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingRef = useRef<boolean>(false);
  
  // 计算当前分数
  useEffect(() => {
    const evalResult = evaluateBoard(board);
    setScore(evalResult);
  }, [board, history]);
  
  // 获取AI教学建议
  const getTeachingSuggestion = useCallback(async () => {
    if (isAIThinking) return;
    setIsAIThinking(true);
    
    try {
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'teach',
          board,
          currentPlayer,
          lastMove: lastMove ? { row: lastMove.row, col: lastMove.col } : undefined
        })
      });
      
      if (response.ok) {
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
            setTeachingMessage(fullText);
          }
        }
      }
    } catch (error) {
      console.error('Teaching error:', error);
      setTeachingMessage('小围棋正在思考中...');
    } finally {
      setIsAIThinking(false);
    }
  }, [board, currentPlayer, lastMove, isAIThinking]);
  
  // 发送消息给AI教练
  const sendMessage = async () => {
    if (!inputMessage.trim() || isStreaming) return;
    
    const userMessage = inputMessage;
    setInputMessage('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsStreaming(true);
    streamingRef.current = true;
    
    try {
      const response = await fetch('/api/go-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'teach',
          board,
          currentPlayer,
          question: userMessage
        })
      });
      
      if (response.ok) {
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        
        setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
        
        if (reader) {
          while (streamingRef.current) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
            setMessages(prev => {
              const newMessages = [...prev];
              newMessages[newMessages.length - 1] = { role: 'assistant', content: fullText };
              return newMessages;
            });
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsStreaming(false);
    }
  };
  
  // 处理落子
  const handleMove = useCallback(async (row: number, col: number) => {
    if (!isValidMove(board, row, col, currentPlayer)) return;
    
    const { newBoard, captured } = playMove(board, row, col, currentPlayer);
    setBoard(newBoard);
    setLastMove({ row, col });
    setHistory(prev => [...prev, { position: { row, col }, color: currentPlayer, captured }]);
    setShowHint(null);
    
    // AI回合
    if (gameMode === 'play' && currentPlayer === 'black') {
      setIsAIThinking(true);
      
      // 简单AI：随机落子
      await new Promise(resolve => setTimeout(resolve, 800));
      
      const validMoves = [];
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          if (isValidMove(newBoard, r, c, 'white')) {
            validMoves.push({ row: r, col: c });
          }
        }
      }
      
      if (validMoves.length > 0) {
        const aiMove = validMoves[Math.floor(Math.random() * validMoves.length)];
        const { newBoard: finalBoard, captured: aiCaptured } = playMove(newBoard, aiMove.row, aiMove.col, 'white');
        setBoard(finalBoard);
        setLastMove({ row: aiMove.row, col: aiMove.col });
        setHistory(prev => [...prev, { position: aiMove, color: 'white', captured: aiCaptured }]);
      }
      
      setCurrentPlayer('black');
      setIsAIThinking(false);
    } else {
      setCurrentPlayer(currentPlayer === 'black' ? 'white' : 'black');
    }
  }, [board, currentPlayer, gameMode]);
  
  // 悔棋
  const undoMove = useCallback(() => {
    if (history.length === 0) return;
    
    // 悔两步（玩家和AI）
    const stepsToUndo = gameMode === 'play' && history.length >= 2 ? 2 : 1;
    const newHistory = history.slice(0, -stepsToUndo);
    
    let newBoard = createEmptyBoard(BOARD_SIZE);
    for (const move of newHistory) {
      const result = playMove(newBoard, move.position.row, move.position.col, move.color);
      newBoard = result.newBoard;
    }
    
    setBoard(newBoard);
    setHistory(newHistory);
    setCurrentPlayer('black');
    setLastMove(newHistory.length > 0 ? newHistory[newHistory.length - 1].position : null);
  }, [history, gameMode]);
  
  // 重新开始
  const restartGame = useCallback(() => {
    setBoard(createEmptyBoard(BOARD_SIZE));
    setCurrentPlayer('black');
    setHistory([]);
    setLastMove(null);
    setShowHint(null);
    setTeachingMessage('');
    setLessonStep(0);
  }, []);
  
  // 显示提示
  const showAIMoveHint = useCallback(() => {
    // 给一个简单的提示：显示一个合法的落子位置
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (isValidMove(board, r, c, currentPlayer)) {
          setShowHint({ row: r, col: c });
          return;
        }
      }
    }
  }, [board, currentPlayer]);
  
  // 渲染棋盘
  const renderBoard = () => {
    const cells = [];
    const size = BOARD_SIZE;
    
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const stone = board[row][col];
        const isLastMove = lastMove?.row === row && lastMove?.col === col;
        const isHint = showHint?.row === row && showHint?.col === col;
        
        cells.push(
          <div
            key={`${row}-${col}`}
            className={`
              relative w-8 h-8 sm:w-10 sm:h-10 
              border border-gray-400 
              ${row === 0 ? 'border-t-2' : ''} 
              ${row === size - 1 ? 'border-b-2' : ''} 
              ${col === 0 ? 'border-l-2' : ''} 
              ${col === size - 1 ? 'border-r-2' : ''}
              flex items-center justify-center
              cursor-pointer
              hover:bg-green-200/50
              transition-colors duration-200
            `}
            onClick={() => handleMove(row, col)}
            style={{
              backgroundColor: '#d4a574'
            }}
          >
            {/* 棋盘星位标记 */}
            {(row === 2 && col === 2) || (row === 2 && col === 6) ||
             (row === 6 && col === 2) || (row === 6 && col === 6) ||
             (row === 4 && col === 4 && size === 9) ? (
              <div className="absolute w-2 h-2 rounded-full bg-gray-600/50" />
            ) : null}
            
            {/* 棋子 */}
            {stone && (
              <div
                className={`
                  w-7 h-7 sm:w-8 sm:h-8 rounded-full
                  flex items-center justify-center
                  shadow-md
                  transition-all duration-300
                  ${isLastMove ? 'ring-4 ring-yellow-400 ring-offset-2' : ''}
                `}
                style={{
                  background: stone === 'black' 
                    ? 'radial-gradient(circle at 30% 30%, #4a4a4a, #1a1a1a)'
                    : 'radial-gradient(circle at 30% 30%, #ffffff, #e0e0e0)',
                  border: stone === 'white' ? '1px solid #ccc' : 'none'
                }}
              >
                {/* 显示最后一手的白棋上的标记 */}
                {isLastMove && stone === 'white' && (
                  <div className="w-2 h-2 rounded-full bg-black" />
                )}
                {isLastMove && stone === 'black' && (
                  <div className="w-2 h-2 rounded-full bg-white" />
                )}
              </div>
            )}
            
            {/* 提示标记 */}
            {isHint && !stone && (
              <div className="absolute w-6 h-6 rounded-full border-2 border-blue-500/50 bg-blue-400/20 animate-pulse" />
            )}
          </div>
        );
      }
    }
    
    return (
      <div 
        className="inline-grid gap-0"
        style={{ 
          gridTemplateColumns: `repeat(${size}, 1fr)`,
          padding: '8px',
          background: 'linear-gradient(135deg, #c4a06a 0%, #d4b896 50%, #c4a06a 100%)',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
        }}
      >
        {cells}
      </div>
    );
  };
  
  // 围棋规则教学内容
  const lessons = [
    {
      title: '认识棋盘',
      content: '围棋棋盘由横竖各19条线组成，我们先用9路的迷你棋盘来学习。棋子要下在线的交叉点上哦！'
    },
    {
      title: '认识棋子',
      content: '围棋有两种棋子：黑棋和白棋。下棋时，黑棋先走，然后轮流交替。黑白两方都要想办法围住更多的地盘！'
    },
    {
      title: '什么是"气"？',
      content: '每颗棋子都有"气"。一颗棋子的气，就是它旁边四个方向的空交叉点。中间4口气，边上3口气，角落2口气。'
    },
    {
      title: '如何吃子',
      content: '当一颗棋子的所有气都被对方堵住时，这颗棋子就被"吃掉"了！被吃掉的棋子会从棋盘上拿走。'
    },
    {
      title: '围地',
      content: '围棋的目标是围住更多的地！地就是被你的棋子围住的空交叉点。游戏结束时，谁围的地多谁就赢了！'
    }
  ];
  
  return (
    <div className="min-h-screen bg-gradient-to-b from-amber-100 to-amber-50 p-4">
      {/* 头部 */}
      <header className="text-center mb-6">
        <h1 className="text-3xl sm:text-4xl font-bold text-amber-800 flex items-center justify-center gap-3">
          <span className="text-4xl">&#9675;</span>
          小围棋乐园
          <span className="text-4xl">&#9673;</span>
        </h1>
        <p className="text-amber-600 mt-2">和AI一起学围棋，下棋真快乐！</p>
      </header>
      
      {/* 主内容区 */}
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左侧面板 */}
        <div className="lg:col-span-1 space-y-4">
          {/* 比分板 */}
          <Card className="bg-white/90 shadow-lg">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-500" />
                当前比分
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex justify-around text-center">
                <div className="flex flex-col items-center">
                  <div className="w-10 h-10 rounded-full bg-gray-800 shadow flex items-center justify-center text-white font-bold mb-1">
                    &#9673;
                  </div>
                  <span className="font-semibold text-gray-700">黑方</span>
                  <span className="text-2xl font-bold text-gray-800">{score.black}</span>
                </div>
                <div className="flex flex-col items-center justify-center">
                  <span className="text-gray-400 text-sm">VS</span>
                </div>
                <div className="flex flex-col items-center">
                  <div className="w-10 h-10 rounded-full bg-white border-2 border-gray-300 shadow flex items-center justify-center text-gray-800 font-bold mb-1">
                    &#9675;
                  </div>
                  <span className="font-semibold text-gray-700">白方</span>
                  <span className="text-2xl font-bold text-gray-800">{score.white}</span>
                </div>
              </div>
              
              {/* 当前回合 */}
              <div className="mt-4 text-center">
                <Badge variant={currentPlayer === 'black' ? 'default' : 'secondary'} className="text-sm px-4 py-1">
                  {currentPlayer === 'black' ? '黑方' : '白方'}回合
                  {isAIThinking && <Spinner className="w-3 h-3 ml-2" />}
                </Badge>
              </div>
            </CardContent>
          </Card>
          
          {/* 控制按钮 */}
          <Card className="bg-white/90 shadow-lg">
            <CardContent className="pt-4">
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={restartGame} variant="outline" className="gap-2">
                  <RotateCcw className="w-4 h-4" /> 重新开始
                </Button>
                <Button onClick={undoMove} variant="outline" className="gap-2" disabled={history.length === 0}>
                  <RotateCcw className="w-4 h-4" /> 悔棋
                </Button>
                <Button onClick={showAIMoveHint} variant="secondary" className="gap-2">
                  <Lightbulb className="w-4 h-4" /> 提示
                </Button>
                <Button onClick={getTeachingSuggestion} variant="secondary" className="gap-2">
                  <HelpCircle className="w-4 h-4" /> 教学
                </Button>
              </div>
            </CardContent>
          </Card>
          
          {/* 学习模式切换 */}
          <Tabs value={gameMode} onValueChange={(v) => setGameMode(v as 'play' | 'learn')}>
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="play" className="gap-1">
                <Play className="w-4 h-4" /> 对弈模式
              </TabsTrigger>
              <TabsTrigger value="learn" className="gap-1">
                <BookOpen className="w-4 h-4" /> 学习模式
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="learn" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{lessons[lessonStep].title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-gray-600 leading-relaxed">{lessons[lessonStep].content}</p>
                  
                  <div className="flex justify-between mt-4">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => setLessonStep(Math.max(0, lessonStep - 1))}
                      disabled={lessonStep === 0}
                    >
                      上一步
                    </Button>
                    <Button 
                      variant="default" 
                      size="sm"
                      onClick={() => setLessonStep(Math.min(lessons.length - 1, lessonStep + 1))}
                    >
                      {lessonStep === lessons.length - 1 ? '完成' : '下一步'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
          
          {/* AI教学反馈 */}
          {(teachingMessage || isAIThinking) && (
            <Card className="bg-gradient-to-br from-blue-50 to-purple-50 border-blue-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2 text-blue-700">
                  <MessageCircle className="w-5 h-5" />
                  小围棋说
                </CardTitle>
              </CardHeader>
              <CardContent>
                {isAIThinking ? (
                  <div className="flex items-center gap-2 text-blue-600">
                    <Spinner className="w-4 h-4" />
                    <span>小围棋正在思考...</span>
                  </div>
                ) : (
                  <p className="text-gray-700 leading-relaxed whitespace-pre-wrap">
                    {teachingMessage}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
        
        {/* 棋盘区域 */}
        <div className="lg:col-span-2 flex flex-col items-center">
          <Card className="bg-white/95 shadow-2xl">
            <CardContent className="p-6">
              {/* 列坐标 */}
              <div className="flex justify-center mb-1 pl-8">
                {'ABCDEFGHI'.split('').map((letter) => (
                  <div key={letter} className="w-8 sm:w-10 text-center text-sm text-amber-700 font-medium">
                    {letter}
                  </div>
                ))}
              </div>
              
              {/* 棋盘主体 */}
              <div className="flex">
                {/* 行坐标 */}
                <div className="flex flex-col justify-around mr-1">
                  {'123456789'.split('').map((num) => (
                    <div key={num} className="h-8 sm:h-10 flex items-center justify-center text-sm text-amber-700 font-medium w-6">
                      {num}
                    </div>
                  ))}
                </div>
                
                {/* 棋盘格子 */}
                {renderBoard()}
              </div>
              
              {/* 下一步提示 */}
              <div className="mt-4 text-center text-sm text-amber-600">
                {currentPlayer === 'black' ? '黑方' : '白方'}请选择落子位置
              </div>
            </CardContent>
          </Card>
          
          {/* 聊天区域 */}
          <Card className="w-full mt-4 bg-white/95">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <MessageCircle className="w-5 h-5 text-purple-500" />
                有什么问题尽管问我
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-48 mb-4">
                <div className="space-y-3">
                  {messages.map((msg, i) => (
                    <div 
                      key={i}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div 
                        className={`
                          max-w-[80%] rounded-2xl px-4 py-2
                          ${msg.role === 'user' 
                            ? 'bg-purple-500 text-white rounded-br-md' 
                            : 'bg-gray-100 text-gray-800 rounded-bl-md'
                          }
                        `}
                      >
                        <p className="text-sm">{msg.content}</p>
                      </div>
                    </div>
                  ))}
                  {isStreaming && (
                    <div className="flex justify-start">
                      <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-2">
                        <div className="flex gap-1">
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
              
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !isStreaming && sendMessage()}
                  placeholder="问我围棋问题..."
                  className="flex-1 px-4 py-2 border rounded-full focus:outline-none focus:ring-2 focus:ring-purple-400"
                  disabled={isStreaming}
                />
                <Button 
                  onClick={sendMessage} 
                  disabled={!inputMessage.trim() || isStreaming}
                  className="bg-purple-500 hover:bg-purple-600"
                >
                  发送
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
