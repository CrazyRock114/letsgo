"use client";

import { useState, useEffect, useCallback } from "react";

interface MonitorData {
  timestamp: string;
  users: { total: number; recentlyActive: number };
  games: {
    total: number;
    active: number;
    finishedLastHour: number;
    activeByEngine: Record<string, number>;
    activeByBoardSize: Record<number, number>;
    activeSessions: Array<{
      player: string;
      engine: string;
      boardSize: number;
      difficulty: string;
      totalMoves: number;
      lastMoveAt: string;
      startedAt: string;
    }>;
  };
  engineQueue: {
    total: number;
    isProcessing: boolean;
    katago: { queueLength: number; processing: boolean };
    gnugo: { queueLength: number; processing: boolean };
  };
  usage: { pointsUsedLastHour: number; engineCallsLastHour: number };
  system: {
    memory: { total: number; used: number; free: number; usagePercent: number };
    cpu: { model: string; cores: number; nodeUsage: number };
    uptime: number;
  };
}

const ENGINE_NAMES: Record<string, string> = {
  katago: "KataGo",
  gnugo: "GnuGo",
  local: "本地AI",
};

const ENGINE_COLORS: Record<string, string> = {
  katago: "bg-purple-500",
  gnugo: "bg-blue-500",
  local: "bg-green-500",
};

export default function MonitorPage() {
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ time: string; mem: number; cpu: number; active: number }>>([]);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/monitor");
      if (!res.ok) throw new Error("获取失败");
      const d = await res.json();
      setData(d);
      setError(null);
      // 记录历史数据（最多60个点=5分钟）
      setHistory(prev => {
        const next = [...prev, {
          time: new Date().toLocaleTimeString(),
          mem: d.system?.memory?.usagePercent ?? 0,
          cpu: d.system?.cpu?.nodeUsage ?? 0,
          active: d.games?.active ?? 0,
        }];
        return next.slice(-60);
      });
    } catch {
      setError("连接失败");
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 5000);
    return () => clearInterval(timer);
  }, [fetchData]);

  if (error && !data) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-red-400 text-lg">{error}</p>
      </div>
    );
  }

  const fmt = (n: number) => n.toLocaleString();
  const uptime = data?.system?.uptime ?? 0;
  const uptimeStr = uptime > 3600
    ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
    : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">围棋乐园 - 运行监控</h1>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              实时
            </span>
            <span>{data?.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "--:--:--"}</span>
          </div>
        </div>

        {/* 顶部统计卡片 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label="注册用户" value={fmt(data?.users.total ?? 0)} sub={`活跃 ${data?.users.recentlyActive ?? 0}`} color="blue" />
          <StatCard label="活跃对弈" value={fmt(data?.games.active ?? 0)} sub={`总计 ${fmt(data?.games.total ?? 0)}`} color="green" />
          <StatCard label="KataGo排队" value={fmt(data?.engineQueue.katago?.queueLength ?? 0)} sub={data?.engineQueue.katago?.processing ? "处理中" : "空闲"} color="purple" />
          <StatCard label="GnuGo排队" value={fmt(data?.engineQueue.gnugo?.queueLength ?? 0)} sub={data?.engineQueue.gnugo?.processing ? "处理中" : "空闲"} color="yellow" />
        </div>

        {/* 1小时统计 */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <StatCard label="1h引擎调用" value={fmt(data?.usage.engineCallsLastHour ?? 0)} sub={`消耗 ${fmt(data?.usage.pointsUsedLastHour ?? 0)} 积分`} color="purple" />
          <StatCard label="1h完成棋局" value={fmt(data?.games.finishedLastHour ?? 0)} sub={`活跃 ${fmt(data?.games.active ?? 0)} 局`} color="green" />
        </div>

        {/* 系统资源 + 历史图表 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* 内存 & CPU */}
          <div className="bg-gray-900 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-400 mb-3">系统资源</h2>
            {data?.system && (
              <div className="space-y-4">
                {/* 内存 */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>内存</span>
                    <span>{data.system.memory.used}MB / {data.system.memory.total}MB ({data.system.memory.usagePercent}%)</span>
                  </div>
                  <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        data.system.memory.usagePercent > 85 ? "bg-red-500" : data.system.memory.usagePercent > 60 ? "bg-yellow-500" : "bg-green-500"
                      }`}
                      style={{ width: `${Math.min(data.system.memory.usagePercent, 100)}%` }}
                    />
                  </div>
                </div>
                {/* CPU */}
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Node CPU</span>
                    <span>{data.system.cpu.nodeUsage}%</span>
                  </div>
                  <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        data.system.cpu.nodeUsage > 80 ? "bg-red-500" : data.system.cpu.nodeUsage > 40 ? "bg-yellow-500" : "bg-green-500"
                      }`}
                      style={{ width: `${Math.min(data.system.cpu.nodeUsage, 100)}%` }}
                    />
                  </div>
                </div>
                {/* 系统信息 */}
                <div className="text-xs text-gray-500 pt-2 border-t border-gray-800 space-y-1">
                  <div>CPU: {data.system.cpu.model}</div>
                  <div>核心: {data.system.cpu.cores} | 运行: {uptimeStr}</div>
                </div>
              </div>
            )}
          </div>

          {/* 资源历史图表 */}
          <div className="bg-gray-900 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-400 mb-3">资源趋势（5分钟）</h2>
            <div className="h-40 flex items-end gap-px">
              {history.map((h, i) => (
                <div key={i} className="flex-1 flex flex-col justify-end gap-px min-w-0">
                  <div
                    className="bg-green-500/70 rounded-t-sm"
                    style={{ height: `${h.mem * 1.5}px` }}
                    title={`内存: ${h.mem}%`}
                  />
                  <div
                    className="bg-blue-500/70 rounded-t-sm"
                    style={{ height: `${Math.min(h.cpu * 3, 60)}px` }}
                    title={`CPU: ${h.cpu}%`}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-2">
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500/70 rounded" /> 内存</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-500/70 rounded" /> CPU</span>
            </div>
            {history.length > 0 && (
              <div className="flex justify-between text-xs text-gray-600 mt-1">
                <span>{history[0]?.time}</span>
                <span>{history[history.length - 1]?.time}</span>
              </div>
            )}
          </div>
        </div>

        {/* 引擎分布 + 棋盘分布 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="bg-gray-900 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-400 mb-3">引擎使用分布</h2>
            {data?.games.activeByEngine && Object.keys(data.games.activeByEngine).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(data.games.activeByEngine).map(([engine, count]) => (
                  <div key={engine}>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{ENGINE_NAMES[engine] || engine}</span>
                      <span>{count} 局</span>
                    </div>
                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${ENGINE_COLORS[engine] || "bg-gray-500"}`}
                        style={{ width: `${Math.max((count / Math.max(data.games.active, 1)) * 100, 5)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-600 text-sm">当前无活跃对弈</p>
            )}
          </div>

          <div className="bg-gray-900 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-400 mb-3">棋盘大小分布</h2>
            {data?.games.activeByBoardSize && Object.keys(data.games.activeByBoardSize).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(data.games.activeByBoardSize).map(([size, count]) => (
                  <div key={size}>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{size}路</span>
                      <span>{count} 局</span>
                    </div>
                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-amber-500"
                        style={{ width: `${Math.max((count / Math.max(data.games.active, 1)) * 100, 5)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-600 text-sm">当前无活跃对弈</p>
            )}
          </div>
        </div>

        {/* 活跃对弈列表 */}
        <div className="bg-gray-900 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-400 mb-3">活跃对弈</h2>
          {data?.games.activeSessions && data.games.activeSessions.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="text-left py-2 px-2">玩家</th>
                    <th className="text-left py-2 px-2">引擎</th>
                    <th className="text-left py-2 px-2">棋盘</th>
                    <th className="text-left py-2 px-2">难度</th>
                    <th className="text-left py-2 px-2">手数</th>
                    <th className="text-left py-2 px-2">最后活跃</th>
                  </tr>
                </thead>
                <tbody>
                  {data.games.activeSessions.map((s, i) => (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                      <td className="py-2 px-2">{s.player}</td>
                      <td className="py-2 px-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${
                          s.engine === "katago" ? "bg-purple-500/20 text-purple-300" :
                          s.engine === "gnugo" ? "bg-blue-500/20 text-blue-300" :
                          "bg-green-500/20 text-green-300"
                        }`}>
                          {ENGINE_NAMES[s.engine] || s.engine}
                        </span>
                      </td>
                      <td className="py-2 px-2">{s.boardSize}路</td>
                      <td className="py-2 px-2">{s.difficulty}</td>
                      <td className="py-2 px-2">{s.totalMoves}</td>
                      <td className="py-2 px-2 text-gray-400">
                        {Math.round((Date.now() - new Date(s.lastMoveAt).getTime()) / 1000)}秒前
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-gray-600 text-sm">当前无活跃对弈</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const colorMap: Record<string, string> = {
    blue: "border-blue-500/30",
    green: "border-green-500/30",
    yellow: "border-yellow-500/30",
    purple: "border-purple-500/30",
  };
  return (
    <div className={`bg-gray-900 rounded-xl p-3 border ${colorMap[color] || "border-gray-800"}`}>
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-xl font-bold mt-1">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
    </div>
  );
}
