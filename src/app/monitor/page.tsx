"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface EngineVisitsConfig {
  easy: number;
  medium: number;
  hard: number;
}

interface EngineConfig {
  gameModel: string;
  gameVisits: EngineVisitsConfig;
  analysisModel: string;
  analysisVisits: EngineVisitsConfig;
  dualEngine: boolean;
}

interface ModelInfo {
  path: string;
  name: string;
  key: string;
}

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
    katago: {
      queueLength: number;
      processing: boolean;
      analysisSeconds: number;
      currentTask: { id: string; userId: number; isAnalysis: boolean; engine: string } | null;
      queueEntries: Array<{ id: string; userId: number; type: string; engine: string; boardSize: number; difficulty: string }>;
      // 双引擎配置（新架构）
      gameModel: ModelInfo | null;
      analysisModel: ModelInfo | null;
      engineConfig: EngineConfig;
      availableModels: Array<{ name: string; path: string; sizeMB: number; displayName: string; key: string | null }>;
    };
    gnugo: { queueLength: number; processing: boolean };
  };
  usage: { pointsUsedLastHour: number; engineCallsLastHour: number };
  system: {
    memory: { totalMB: number; usedMB: number; freeMB: number; totalGB: number; usedGB: number; freeGB: number; usagePercent: number };
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
  katago: "border-purple-500/30",
  gnugo: "border-blue-500/30",
  local: "border-green-500/30",
};

export default function MonitorPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ time: string; mem: number; cpu: number; active: number }>>([]);
  // 引擎配置状态
  const [selectedGameModel, setSelectedGameModel] = useState<string>("");
  const [selectedAnalysisModel, setSelectedAnalysisModel] = useState<string>("");
  const [selectedGameVisits, setSelectedGameVisits] = useState<EngineVisitsConfig>({ easy: 50, medium: 100, hard: 200 });
  const [selectedAnalysisVisits, setSelectedAnalysisVisits] = useState<EngineVisitsConfig>({ easy: 30, medium: 60, hard: 120 });
  const [isDualEngine, setIsDualEngine] = useState<boolean>(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configMsg, setConfigMsg] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/monitor");
      if (!res.ok) throw new Error("获取失败");
      const d = await res.json();
      setData(d);
      // 同步引擎配置到选择器
      const cfg = d?.engineQueue?.katago?.engineConfig;
      if (cfg) {
        setSelectedGameModel(cfg.gameModel || "");
        setSelectedGameVisits(cfg.gameVisits || { easy: 50, medium: 100, hard: 200 });
        setSelectedAnalysisVisits(cfg.analysisVisits || { easy: 30, medium: 60, hard: 120 });
        setIsDualEngine(cfg.dualEngine ?? false);
        // 单引擎模式下，分析引擎下拉框显示空值（对应"同步共用"选项）
        // 双引擎模式下，显示当前分析模型
        setSelectedAnalysisModel(cfg.dualEngine ? (cfg.analysisModel || "") : "");
      }
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

  const handleSaveConfig = useCallback(async () => {
    setConfigSaving(true);
    setConfigMsg(null);
    try {
      const payload: Record<string, unknown> = { action: "setConfig" };
      const currentCfg = data?.engineQueue?.katago?.engineConfig;

      // 对弈引擎模型
      if (selectedGameModel && selectedGameModel !== (currentCfg?.gameModel ?? "")) {
        payload.gameModel = selectedGameModel;
      }

      // 分析引擎模式切换
      const wasDual = currentCfg?.dualEngine ?? false;
      const willBeDual = selectedAnalysisModel !== "";
      if (wasDual !== willBeDual) {
        payload.dualEngine = willBeDual;
      }
      // 分析引擎模型（仅双引擎模式时发送）
      if (willBeDual && selectedAnalysisModel && selectedAnalysisModel !== (currentCfg?.analysisModel ?? "")) {
        payload.analysisModel = selectedAnalysisModel;
      }

      // 对弈 visits
      if (JSON.stringify(selectedGameVisits) !== JSON.stringify(currentCfg?.gameVisits ?? {})) {
        payload.gameVisits = selectedGameVisits;
      }
      // 分析 visits
      if (JSON.stringify(selectedAnalysisVisits) !== JSON.stringify(currentCfg?.analysisVisits ?? {})) {
        payload.analysisVisits = selectedAnalysisVisits;
      }

      if (Object.keys(payload).length === 1) {
        setConfigMsg("未做任何更改");
        setConfigSaving(false);
        setTimeout(() => setConfigMsg(null), 3000);
        return;
      }

      const res = await fetch("/api/go-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (res.ok && result.success) {
        const parts: string[] = [];
        if (result.gameModel) parts.push(`对弈=${result.gameModel.key}`);
        if (result.dualEngine) parts.push(`分析=${result.analysisModel?.key}`);
        if (result.dualEngine === false) parts.push("单引擎模式");
        if (result.gameVisits) parts.push(`对弈visits已更新`);
        if (result.analysisVisits) parts.push(`分析visits已更新`);
        setConfigMsg(`已更新: ${parts.join(" + ")}`);
        setIsDualEngine(result.engineConfig?.dualEngine ?? false);
        fetchData();
      } else {
        // 引擎启动失败回退
        if (result.rollback) {
          setSelectedAnalysisModel("");
          setIsDualEngine(false);
        }
        setConfigMsg(`失败: ${result.error || "未知错误"}`);
      }
    } catch {
      setConfigMsg("网络错误");
    } finally {
      setConfigSaving(false);
      setTimeout(() => setConfigMsg(null), 5000);
    }
  }, [selectedGameModel, selectedAnalysisModel, selectedGameVisits, selectedAnalysisVisits, data, fetchData]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 5000);
    return () => clearInterval(timer);
  }, [fetchData]);

  // 管理员权限检查
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <div className="text-gray-400">加载中...</div>
      </div>
    );
  }

  if (!user?.isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <Card className="w-full max-w-md mx-4 bg-gray-900 border-gray-800">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="w-12 h-12 text-orange-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-gray-100 mb-2">访问受限</h2>
            <p className="text-gray-400 mb-4">此页面仅限管理员访问。</p>
            <Button onClick={() => router.push("/")} variant="outline" className="border-gray-700 text-gray-300 hover:bg-gray-800">
              返回首页
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

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

  const currentCfg = data?.engineQueue?.katago?.engineConfig;
  const analysisModelChanged =
    (!currentCfg?.dualEngine && selectedAnalysisModel !== "") ||
    (currentCfg?.dualEngine && selectedAnalysisModel === "") ||
    (currentCfg?.dualEngine && selectedAnalysisModel !== "" && selectedAnalysisModel !== (currentCfg?.analysisModel ?? ""));
  const hasConfigChanges =
    (selectedGameModel && selectedGameModel !== (currentCfg?.gameModel ?? "")) ||
    analysisModelChanged ||
    JSON.stringify(selectedGameVisits) !== JSON.stringify(currentCfg?.gameVisits ?? {}) ||
    JSON.stringify(selectedAnalysisVisits) !== JSON.stringify(currentCfg?.analysisVisits ?? {});

  const availableModels = data?.engineQueue?.katago?.availableModels ?? [];

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
          <StatCard label="对弈引擎" value={data?.engineQueue?.katago?.gameModel?.name?.split('(')[0]?.trim() ?? '-'} sub={data?.engineQueue?.katago?.gameModel?.key ?? '未配置'} color="purple" />
          <StatCard
            label="分析引擎"
            value={isDualEngine ? (data?.engineQueue?.katago?.analysisModel?.name?.split('(')[0]?.trim() ?? '-') : '共用对弈引擎'}
            sub={isDualEngine ? (data?.engineQueue?.katago?.analysisModel?.key ?? '未配置') : data?.engineQueue?.katago?.gameModel?.key ?? '-'}
            color="amber"
          />
        </div>

        {/* 1小时统计 */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <StatCard label="1h引擎调用" value={fmt(data?.usage.engineCallsLastHour ?? 0)} sub={`消耗 ${fmt(data?.usage.pointsUsedLastHour ?? 0)} 积分`} color="purple" />
          <StatCard label="1h完成棋局" value={fmt(data?.games.finishedLastHour ?? 0)} sub={`活跃 ${data?.games.active ?? 0} 局`} color="green" />
        </div>

        {/* 双引擎配置面板 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* 对弈引擎配置 */}
          <div className="bg-gray-900 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-purple-400 mb-3">对弈引擎配置 (genmove)</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">神经网络模型</label>
                <select
                  value={selectedGameModel}
                  onChange={e => setSelectedGameModel(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  {availableModels.length === 0 && <option value="">无可用模型</option>}
                  {availableModels.map(m => (
                    m.key ? (
                      <option key={m.path} value={m.key}>
                        {m.displayName} ({m.sizeMB}MB)
                      </option>
                    ) : null
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {(['easy', 'medium', 'hard'] as const).map(key => (
                  <div key={key}>
                    <label className="text-xs text-gray-500 block mb-1 capitalize">{key === 'easy' ? '初级' : key === 'medium' ? '中级' : '高级'} visits</label>
                    <input
                      type="number"
                      min={1}
                      max={5000}
                      value={selectedGameVisits[key]}
                      onChange={e => setSelectedGameVisits(prev => ({ ...prev, [key]: Math.max(1, Math.min(5000, Number(e.target.value))) }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                ))}
              </div>

              <div className="text-xs text-gray-600 space-y-0.5 pt-2 border-t border-gray-800">
                <div>当前模型: <span className="text-gray-400">{data?.engineQueue?.katago?.gameModel?.name ?? "自动选择"}</span></div>
                <div>当前 visits: <span className="text-gray-400">E={currentCfg?.gameVisits?.easy ?? '-'} M={currentCfg?.gameVisits?.medium ?? '-'} H={currentCfg?.gameVisits?.hard ?? '-'}</span></div>
              </div>
            </div>
          </div>

          {/* 分析引擎配置 */}
          <div className="bg-gray-900 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-amber-400 mb-3">分析引擎配置 (analyze)</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">神经网络模型</label>
                <select
                  value={selectedAnalysisModel}
                  onChange={e => setSelectedAnalysisModel(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="">同步共用对弈引擎 (单引擎模式)</option>
                  {availableModels.length === 0 && <option value="" disabled>无可用模型</option>}
                  {availableModels.map(m => (
                    m.key ? (
                      <option key={m.path} value={m.key}>
                        {m.displayName} ({m.sizeMB}MB)
                      </option>
                    ) : null
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {(['easy', 'medium', 'hard'] as const).map(key => (
                  <div key={key}>
                    <label className="text-xs text-gray-500 block mb-1 capitalize">{key === 'easy' ? '初级' : key === 'medium' ? '中级' : '高级'} visits</label>
                    <input
                      type="number"
                      min={1}
                      max={5000}
                      value={selectedAnalysisVisits[key]}
                      onChange={e => setSelectedAnalysisVisits(prev => ({ ...prev, [key]: Math.max(1, Math.min(5000, Number(e.target.value))) }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                ))}
              </div>

              <div className="text-xs text-gray-600 space-y-0.5 pt-2 border-t border-gray-800">
                <div>当前模型: <span className="text-gray-400">{data?.engineQueue?.katago?.analysisModel?.name ?? "自动选择"}</span></div>
                <div>当前 visits: <span className="text-gray-400">E={currentCfg?.analysisVisits?.easy ?? '-'} M={currentCfg?.analysisVisits?.medium ?? '-'} H={currentCfg?.analysisVisits?.hard ?? '-'}</span></div>
              </div>
            </div>
          </div>
        </div>

        {/* 保存按钮行 */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={handleSaveConfig}
            disabled={configSaving || !hasConfigChanges}
            className={`px-6 py-2 rounded-lg text-sm font-medium transition-colors ${
              configSaving || !hasConfigChanges
                ? "bg-gray-700 text-gray-500 cursor-not-allowed"
                : "bg-purple-600 hover:bg-purple-500 text-white"
            }`}
          >
            {configSaving ? "保存中..." : "应用引擎配置"}
          </button>
          {configMsg && (
            <span className={`text-sm ${configMsg.startsWith("已") ? "text-green-400" : "text-red-400"}`}>
              {configMsg}
            </span>
          )}
        </div>

        {/* 引擎状态面板 */}
        <div className="bg-gray-900 rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-400">引擎状态</h2>
            <span className={`text-xs px-2 py-0.5 rounded-full ${isDualEngine ? 'bg-purple-500/20 text-purple-400' : 'bg-green-500/20 text-green-400'}`}>
              {isDualEngine ? '双引擎模式' : '单引擎模式'}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full" />
                <span className="text-sm text-green-400">对弈引擎常驻进程</span>
              </div>
              <div className="text-xs text-gray-500 pl-4">
                模型: {data?.engineQueue?.katago?.gameModel?.name ?? '-'}
                <br />文件: {data?.engineQueue?.katago?.gameModel?.path ?? '-'}
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${isDualEngine ? 'bg-green-500' : 'bg-gray-600'}`} />
                <span className={`text-sm ${isDualEngine ? 'text-green-400' : 'text-gray-500'}`}>
                  {isDualEngine ? '分析引擎常驻进程' : '分析引擎与对弈共用'}
                </span>
              </div>
              <div className="text-xs text-gray-500 pl-4">
                {isDualEngine ? (
                  <>
                    模型: {data?.engineQueue?.katago?.analysisModel?.name ?? '-'}
                    <br />文件: {data?.engineQueue?.katago?.analysisModel?.path ?? '-'}
                  </>
                ) : (
                  <>analyze / genmove 共用同一进程，节省内存</>
                )}
              </div>
            </div>
          </div>
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
                    <span>{data.system.memory.usedGB}GB / {data.system.memory.totalGB}GB ({data.system.memory.usagePercent}%)</span>
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
                      <div className={`h-full rounded-full ${ENGINE_COLORS[engine]?.replace('border-', 'bg-') || "bg-gray-500"}`}
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
