"use client";

import { useState, useEffect, useCallback } from "react";

interface MonitorData {
  timestamp: string;
  users: { total: number; recentlyActive: number };
  games: {
    total: number;
    active: number;
    activeByEngine: Record<string, number>;
    activeByBoardSize: Record<number, number>;
    activeGames: {
      id: number;
      boardSize: number;
      difficulty: string;
      engine: string;
      title: string;
      player: string;
      createdAt: string;
      updatedAt: string;
    }[];
  };
  engineQueue: { note: string };
}

interface EngineData {
  engines: {
    id: string;
    name: string;
    available: boolean;
    desc: string;
    cost: number;
  }[];
  queue: { length: number; processing: boolean };
}

export default function MonitorPage() {
  const [monitor, setMonitor] = useState<MonitorData | null>(null);
  const [engine, setEngine] = useState<EngineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = useCallback(async () => {
    try {
      const [monitorRes, engineRes] = await Promise.all([
        fetch("/api/monitor"),
        fetch("/api/go-engine"),
      ]);
      if (monitorRes.ok) {
        setMonitor(await monitorRes.json());
      }
      if (engineRes.ok) {
        setEngine(await engineRes.json());
      }
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Monitor fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const engineLabel: Record<string, string> = {
    katago: "KataGo",
    gnugo: "GnuGo",
    local: "本地AI",
  };

  const difficultyLabel: Record<string, string> = {
    easy: "初级",
    medium: "中级",
    hard: "高级",
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-50 flex items-center justify-center">
        <div className="text-amber-700 text-lg">加载监控数据...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-50 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-amber-900">小围棋乐园 - 运行监控</h1>
            <p className="text-sm text-amber-600 mt-1">
              最后刷新: {lastRefresh.toLocaleTimeString()} | 服务器时间: {monitor?.timestamp ? new Date(monitor.timestamp).toLocaleTimeString() : "-"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-amber-700">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              自动刷新 (5s)
            </label>
            <button
              onClick={fetchData}
              className="px-3 py-1.5 bg-amber-600 text-white rounded text-sm hover:bg-amber-700 transition-colors"
            >
              刷新
            </button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl shadow-sm p-4 border border-amber-100">
            <div className="text-sm text-amber-600">注册用户</div>
            <div className="text-3xl font-bold text-amber-900">{monitor?.users.total ?? "-"}</div>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4 border border-amber-100">
            <div className="text-sm text-amber-600">近期活跃 (5min)</div>
            <div className="text-3xl font-bold text-amber-900">{monitor?.users.recentlyActive ?? "-"}</div>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4 border border-amber-100">
            <div className="text-sm text-amber-600">总棋局数</div>
            <div className="text-3xl font-bold text-amber-900">{monitor?.games.total ?? "-"}</div>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4 border border-amber-100">
            <div className="text-sm text-amber-600">进行中棋局</div>
            <div className="text-3xl font-bold text-amber-900">{monitor?.games.active ?? "-"}</div>
          </div>
        </div>

        {/* Engine Status */}
        <div className="bg-white rounded-xl shadow-sm p-5 border border-amber-100 mb-6">
          <h2 className="text-lg font-semibold text-amber-900 mb-4">引擎状态</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {engine?.engines.map((eng) => (
              <div
                key={eng.id}
                className={`rounded-lg p-4 border-2 ${
                  eng.available
                    ? "border-green-300 bg-green-50"
                    : "border-red-300 bg-red-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-900">{eng.name}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      eng.available
                        ? "bg-green-200 text-green-800"
                        : "bg-red-200 text-red-800"
                    }`}
                  >
                    {eng.available ? "在线" : "离线"}
                  </span>
                </div>
                <div className="text-sm text-gray-600 mt-1">{eng.desc}</div>
                <div className="text-sm text-gray-500 mt-1">
                  积分消耗: {eng.cost === 0 ? "免费" : `${eng.cost}分/步`}
                </div>
              </div>
            ))}
          </div>

          {/* Queue Info */}
          <div className="mt-4 flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  engine?.queue.processing ? "bg-yellow-400 animate-pulse" : "bg-gray-300"
                }`}
              />
              <span className="text-gray-700">
                {engine?.queue.processing ? "KataGo 处理中" : "KataGo 空闲"}
              </span>
            </div>
            <div className="text-gray-700">
              排队等待: <span className="font-semibold">{engine?.queue.length ?? 0}</span> 人
            </div>
          </div>
        </div>

        {/* Engine & Board Size Distribution */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div className="bg-white rounded-xl shadow-sm p-5 border border-amber-100">
            <h2 className="text-lg font-semibold text-amber-900 mb-3">引擎使用分布</h2>
            {monitor?.games.activeByEngine && Object.keys(monitor.games.activeByEngine).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(monitor.games.activeByEngine).map(([eng, count]) => {
                  const total = monitor.games.active || 1;
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div key={eng} className="flex items-center gap-3">
                      <span className="text-sm text-gray-700 w-16">{engineLabel[eng] || eng}</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                        <div
                          className="bg-amber-500 h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium text-gray-700 w-12 text-right">
                        {count} ({pct}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-gray-400 text-sm">暂无进行中的棋局</div>
            )}
          </div>

          <div className="bg-white rounded-xl shadow-sm p-5 border border-amber-100">
            <h2 className="text-lg font-semibold text-amber-900 mb-3">棋盘大小分布</h2>
            {monitor?.games.activeByBoardSize && Object.keys(monitor.games.activeByBoardSize).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(monitor.games.activeByBoardSize).map(([size, count]) => {
                  const total = monitor.games.active || 1;
                  const pct = Math.round((count / total) * 100);
                  const label: Record<string, string> = { "9": "9路(入门)", "13": "13路(进阶)", "19": "19路(标准)" };
                  return (
                    <div key={size} className="flex items-center gap-3">
                      <span className="text-sm text-gray-700 w-20">{label[size] || `${size}路`}</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                        <div
                          className="bg-orange-400 h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium text-gray-700 w-12 text-right">
                        {count} ({pct}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-gray-400 text-sm">暂无进行中的棋局</div>
            )}
          </div>
        </div>

        {/* Active Games Table */}
        <div className="bg-white rounded-xl shadow-sm p-5 border border-amber-100">
          <h2 className="text-lg font-semibold text-amber-900 mb-3">进行中的棋局</h2>
          {monitor?.games.activeGames && monitor.games.activeGames.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-amber-100">
                    <th className="text-left py-2 px-3 text-amber-700 font-medium">棋局</th>
                    <th className="text-left py-2 px-3 text-amber-700 font-medium">玩家</th>
                    <th className="text-left py-2 px-3 text-amber-700 font-medium">棋盘</th>
                    <th className="text-left py-2 px-3 text-amber-700 font-medium">难度</th>
                    <th className="text-left py-2 px-3 text-amber-700 font-medium">引擎</th>
                    <th className="text-left py-2 px-3 text-amber-700 font-medium">最后活跃</th>
                  </tr>
                </thead>
                <tbody>
                  {monitor.games.activeGames.map((game) => (
                    <tr key={game.id} className="border-b border-gray-50 hover:bg-amber-50/50">
                      <td className="py-2 px-3 text-gray-900">{game.title || `棋局 #${game.id}`}</td>
                      <td className="py-2 px-3 text-gray-600">{game.player}</td>
                      <td className="py-2 px-3 text-gray-600">{game.boardSize}路</td>
                      <td className="py-2 px-3 text-gray-600">{difficultyLabel[game.difficulty] || game.difficulty}</td>
                      <td className="py-2 px-3">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            game.engine === "katago"
                              ? "bg-purple-100 text-purple-700"
                              : game.engine === "gnugo"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {engineLabel[game.engine] || game.engine}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-gray-500 text-xs">
                        {new Date(game.updatedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-gray-400 text-sm">暂无进行中的棋局</div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 text-center text-xs text-amber-400">
          小围棋乐园 监控面板
        </div>
      </div>
    </div>
  );
}
