'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  RotateCcw,
  Play,
  Pause,
  Square,
  Settings,
  Monitor,
  AlertTriangle,
  Brain,
  Bot,
  Clock,
  FolderOpen,
  ExternalLink,
} from 'lucide-react';

type EngineId = 'katago' | 'gnugo' | 'local';
type Difficulty = 'easy' | 'medium' | 'hard';

interface AITestConfig {
  boardSize: 9 | 13 | 19;
  stepInterval: number;
  winRateEndCondition: number;
  aiPlayer: {
    color: 'black' | 'white';
    analysisDifficulty: Difficulty;
  };
  opponent: {
    engine: EngineId;
    difficulty: Difficulty;
  };
}

const DEFAULT_CONFIG: AITestConfig = {
  boardSize: 9,
  stepInterval: 15000,
  winRateEndCondition: 99,
  aiPlayer: { color: 'black', analysisDifficulty: 'medium' },
  opponent: { engine: 'katago', difficulty: 'medium' },
};

const BOARD_SIZES = [
  { size: 9 as const, label: '9路', desc: '初学入门' },
  { size: 13 as const, label: '13路', desc: '进阶练习' },
  { size: 19 as const, label: '19路', desc: '正式对局' },
] as const;

const DIFFICULTIES = [
  { key: 'easy' as const, label: '初级', emoji: '\u{1F331}' },
  { key: 'medium' as const, label: '中级', emoji: '\u{2694}\u{FE0F}' },
  { key: 'hard' as const, label: '高级', emoji: '\u{1F409}' },
] as const;

const ENGINES: { id: EngineId; name: string; desc: string }[] = [
  { id: 'katago', name: 'KataGo', desc: '深度学习引擎' },
  { id: 'gnugo', name: 'GnuGo', desc: '经典围棋引擎' },
  { id: 'local', name: '本地AI', desc: '内置启发式' },
];

export default function AITestAdminPage() {
  const { user, token, loading } = useAuth();
  const router = useRouter();
  const [config, setConfig] = useState<AITestConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);

  // Load config from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('ai-test-config');
      if (saved) {
        const parsed = JSON.parse(saved);
        // 向后兼容：旧配置使用 analysisSeconds，新配置使用 analysisDifficulty
        const migrated: AITestConfig = {
          ...DEFAULT_CONFIG,
          ...parsed,
          aiPlayer: {
            color: parsed.aiPlayer?.color || 'black',
            analysisDifficulty: parsed.aiPlayer?.analysisDifficulty || 'medium',
          },
        };
        setConfig(migrated);
      }
    } catch {
      // ignore
    }
  }, []);

  // Save config to localStorage
  const saveConfig = () => {
    localStorage.setItem('ai-test-config', JSON.stringify(config));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // 历史棋局
  const [historyGames, setHistoryGames] = useState<Array<{
    id: number;
    board_size: number;
    difficulty: string;
    engine: string;
    status: string;
    title: string;
    black_score: number;
    white_score: number;
    moveCount: number;
    created_at: string;
    updated_at: string;
  }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/ai-test/history');
      if (res.ok) {
        const data = await res.json();
        setHistoryGames(data.games || []);
      }
    } catch (err) {
      console.error('加载历史棋局失败:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  // Game control state
  const [gameStatus, setGameStatus] = useState<'none' | 'running' | 'paused' | 'finished'>('none');
  const [controlLoading, setControlLoading] = useState<string | null>(null);

  // Poll current game status
  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await fetch('/api/ai-test/state');
        if (res.ok) {
          const data = await res.json();
          if (data.game) {
            setGameStatus(data.game.status);
          } else {
            setGameStatus('none');
          }
        }
      } catch {
        // ignore
      }
    }
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const controlGame = async (action: string) => {
    if (!token) {
      alert('请先登录');
      return;
    }
    setControlLoading(action);
    try {
      const res = await fetch('/api/ai-test/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, config }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '操作失败');
      } else if (action === 'start') {
        setGameStatus('running');
      } else if (action === 'pause') {
        setGameStatus('paused');
      } else if (action === 'resume') {
        setGameStatus('running');
      } else if (action === 'end') {
        setGameStatus('none');
      }
    } catch {
      alert('网络错误');
    } finally {
      setControlLoading(null);
    }
  };

  // Check admin access
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  if (!user?.isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Card className="w-full max-w-md mx-4">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="w-12 h-12 text-orange-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-800 mb-2">访问受限</h2>
            <p className="text-gray-600 mb-4">此页面仅限管理员访问。</p>
            <Button onClick={() => router.push('/')} variant="outline">
              返回首页
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings className="w-6 h-6 text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-800">AI测试管理</h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              管理员: {user.nickname}
            </Badge>
            <Button size="sm" variant="outline" onClick={() => router.push('/ai-test')}>
              <Monitor className="w-4 h-4 mr-1" />
              展示页
            </Button>
          </div>
        </div>

        {/* Settings Form */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">运行配置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Board Size */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">棋盘大小</label>
              <div className="flex gap-2">
                {BOARD_SIZES.map(({ size, label, desc }) => (
                  <button
                    key={size}
                    onClick={() => setConfig(prev => ({ ...prev, boardSize: size }))}
                    className={`flex-1 px-4 py-3 rounded-lg border-2 text-center transition-colors ${
                      config.boardSize === size
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="font-semibold">{label}</div>
                    <div className="text-xs text-gray-500">{desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* AI Player Section */}
            <div className="border-t pt-4">
              <div className="flex items-center gap-2 mb-3">
                <Brain className="w-5 h-5 text-purple-600" />
                <h3 className="text-sm font-semibold text-gray-800">AI接管玩家（模拟人类玩家）</h3>
              </div>
              <div className="space-y-4 pl-1">
                {/* AI Player Color */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">执子颜色</label>
                  <div className="flex gap-2">
                    {[
                      { key: 'black' as const, label: '执黑' },
                      { key: 'white' as const, label: '执白' },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => setConfig(prev => ({ ...prev, aiPlayer: { ...prev.aiPlayer, color: key } }))}
                        className={`flex-1 px-4 py-2 rounded-lg border-2 text-center transition-colors ${
                          config.aiPlayer.color === key
                            ? 'border-purple-500 bg-purple-50 text-purple-700'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="font-semibold text-sm">{label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Analysis Difficulty */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">
                    分析深度
                  </label>
                  <div className="flex gap-2">
                    {DIFFICULTIES.map(({ key, label, emoji }) => (
                      <button
                        key={key}
                        onClick={() => setConfig(prev => ({ ...prev, aiPlayer: { ...prev.aiPlayer, analysisDifficulty: key } }))}
                        className={`flex-1 px-3 py-2 rounded-lg border-2 text-center transition-colors ${
                          config.aiPlayer.analysisDifficulty === key
                            ? 'border-purple-500 bg-purple-50 text-purple-700'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="font-semibold text-sm">{emoji} {label}</div>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    初级/中级/高级 对应分析引擎的 visits 配置（可在 Monitor 调整）
                  </p>
                </div>
              </div>
            </div>

            {/* Opponent Section */}
            <div className="border-t pt-4">
              <div className="flex items-center gap-2 mb-3">
                <Bot className="w-5 h-5 text-green-600" />
                <h3 className="text-sm font-semibold text-gray-800">对手AI</h3>
              </div>
              <div className="space-y-4 pl-1">
                {/* Engine */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">AI引擎</label>
                  <div className="flex gap-2">
                    {ENGINES.map(({ id, name, desc }) => (
                      <button
                        key={id}
                        onClick={() => setConfig(prev => ({ ...prev, opponent: { ...prev.opponent, engine: id } }))}
                        className={`flex-1 px-4 py-2 rounded-lg border-2 text-center transition-colors ${
                          config.opponent.engine === id
                            ? 'border-green-500 bg-green-50 text-green-700'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="font-semibold text-sm">{name}</div>
                        <div className="text-xs text-gray-500">{desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Difficulty */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">AI难度</label>
                  <div className="flex gap-2">
                    {DIFFICULTIES.map(({ key, label, emoji }) => (
                      <button
                        key={key}
                        onClick={() => setConfig(prev => ({ ...prev, opponent: { ...prev.opponent, difficulty: key } }))}
                        className={`flex-1 px-4 py-2 rounded-lg border-2 text-center transition-colors ${
                          config.opponent.difficulty === key
                            ? 'border-green-500 bg-green-50 text-green-700'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="font-semibold text-sm">{emoji} {label}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Common Settings */}
            <div className="border-t pt-4">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-5 h-5 text-amber-600" />
                <h3 className="text-sm font-semibold text-gray-800">通用配置</h3>
              </div>
              <div className="space-y-4 pl-1">
                {/* Step Interval */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">
                    每步间隔: {config.stepInterval / 1000}秒
                  </label>
                  <input
                    type="range"
                    min={1000}
                    max={60000}
                    step={1000}
                    value={config.stepInterval}
                    onChange={e => setConfig(prev => ({ ...prev, stepInterval: Number(e.target.value) }))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>1秒</span>
                    <span>60秒</span>
                  </div>
                </div>

                {/* Win Rate End Condition */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">
                    胜率结束阈值: {config.winRateEndCondition}%
                  </label>
                  <input
                    type="range"
                    min={80}
                    max={99}
                    step={1}
                    value={config.winRateEndCondition}
                    onChange={e => setConfig(prev => ({ ...prev, winRateEndCondition: Number(e.target.value) }))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>80%</span>
                    <span>99%</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    当某一方胜率超过此阈值时，棋局自动结束
                  </p>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-4 border-t">
              <Button onClick={saveConfig} variant="outline" className="flex-1">
                <RotateCcw className="w-4 h-4 mr-2" />
                保存配置
              </Button>
              <Button
                onClick={() => router.push('/ai-test')}
                variant="outline"
                className="flex-1"
              >
                <Monitor className="w-4 h-4 mr-2" />
                查看展示页
              </Button>
            </div>
            {saved && (
              <p className="text-sm text-green-600 text-center">配置已保存</p>
            )}

            {/* Game Control */}
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-800">棋局控制</h3>
                <Badge variant={gameStatus === 'running' ? 'default' : gameStatus === 'paused' ? 'secondary' : 'outline'} className="text-xs">
                  {gameStatus === 'running' ? '进行中' : gameStatus === 'paused' ? '已暂停' : gameStatus === 'finished' ? '已结束' : '未开始'}
                </Badge>
              </div>
              <div className="flex gap-2">
                {gameStatus !== 'running' && gameStatus !== 'paused' ? (
                  <Button
                    onClick={() => controlGame('start')}
                    disabled={controlLoading === 'start'}
                    className="flex-1 bg-green-600 hover:bg-green-700"
                  >
                    <Play className="w-4 h-4 mr-2" />
                    {controlLoading === 'start' ? '启动中...' : '开始新棋局'}
                  </Button>
                ) : gameStatus === 'running' ? (
                  <>
                    <Button
                      onClick={() => controlGame('pause')}
                      disabled={controlLoading === 'pause'}
                      variant="outline"
                      className="flex-1"
                    >
                      <Pause className="w-4 h-4 mr-2" />
                      {controlLoading === 'pause' ? '暂停中...' : '暂停'}
                    </Button>
                    <Button
                      onClick={() => controlGame('end')}
                      disabled={controlLoading === 'end'}
                      variant="destructive"
                      className="flex-1"
                    >
                      <Square className="w-4 h-4 mr-2" />
                      {controlLoading === 'end' ? '结束中...' : '结束'}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      onClick={() => controlGame('resume')}
                      disabled={controlLoading === 'resume'}
                      className="flex-1 bg-green-600 hover:bg-green-700"
                    >
                      <Play className="w-4 h-4 mr-2" />
                      {controlLoading === 'resume' ? '恢复中...' : '恢复'}
                    </Button>
                    <Button
                      onClick={() => controlGame('end')}
                      disabled={controlLoading === 'end'}
                      variant="destructive"
                      className="flex-1"
                    >
                      <Square className="w-4 h-4 mr-2" />
                      {controlLoading === 'end' ? '结束中...' : '结束'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Instructions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">使用说明</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-gray-600 space-y-2">
            <p>1. 在此页面配置AI对弈参数后，点击&quot;开始新棋局&quot;。</p>
            <p>2. 后台Worker将在服务器上持续运行AI对弈，每步间隔按配置执行。</p>
            <p>3. 展示页 (/ai-test) 所有人看到同一盘正在进行的棋局。</p>
            <p>4. 如果暂时没有棋局，展示页会显示&quot;暂无进行中的棋局&quot;。</p>
            <p>5. AI玩家的分析深度可选择初级/中级/高级，对应分析引擎的不同 visits 配置。</p>
          </CardContent>
        </Card>

        {/* 历史棋局 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">历史棋局</CardTitle>
            <Button size="sm" variant="outline" onClick={loadHistory} disabled={historyLoading}>
              <FolderOpen className="w-4 h-4 mr-1" />
              {historyLoading ? '加载中...' : '刷新列表'}
            </Button>
          </CardHeader>
          <CardContent>
            {historyGames.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">
                {historyLoading ? '加载中...' : '点击"刷新列表"查看历史直播棋局'}
              </p>
            ) : (
              <ScrollArea className="max-h-[400px]">
                <div className="space-y-2">
                  {historyGames.map(g => (
                    <div key={g.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{g.title || `棋局 #${g.id}`}</span>
                          <Badge variant={g.status === 'running' ? 'default' : g.status === 'paused' ? 'secondary' : 'outline'} className="text-[10px] h-5">
                            {g.status === 'running' ? '进行中' : g.status === 'paused' ? '已暂停' : '已结束'}
                          </Badge>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {g.board_size}路 | {g.engine === 'katago' ? 'KataGo' : g.engine === 'gnugo' ? 'GnuGo' : '本地AI'} | {g.difficulty === 'easy' ? '初级' : g.difficulty === 'medium' ? '中级' : '高级'} | {g.moveCount}手 | 黑{g.black_score} - 白{g.white_score}
                          {g.created_at && ` | ${new Date(g.created_at).toLocaleDateString('zh-CN')}`}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-blue-600 hover:text-blue-800 flex-shrink-0"
                        onClick={() => window.open(`/?loadGame=${g.id}`, '_blank')}
                      >
                        <ExternalLink className="w-4 h-4 mr-1" />
                        复盘
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
