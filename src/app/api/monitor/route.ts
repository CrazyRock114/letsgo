import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getEngineMonitorData } from "@/app/api/go-engine/route";
import os from "os";

export async function GET() {
  try {
    const supabase = getSupabaseClient();

    // 清理过期的playing状态棋局（超过2小时未更新的视为已结束）
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("letsgo_games")
      .update({ status: "finished" })
      .eq("status", "playing")
      .lt("updated_at", twoHoursAgo);

    // 并行获取数据库数据
    const [usersResult, gamesResult, recentGamesResult] = await Promise.all([
      supabase.from("letsgo_users").select("id", { count: "exact", head: true }),
      supabase.from("letsgo_games").select("id", { count: "exact", head: true }),
      supabase.from("letsgo_games").select("id", { count: "exact", head: true }).eq("status", "finished").gte("updated_at", new Date(Date.now() - 60 * 60 * 1000).toISOString()),
    ]);

    // 最近5分钟活跃用户
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count: recentActiveUsers } = await supabase
      .from("letsgo_users")
      .select("id", { count: "exact", head: true })
      .gte("updated_at", fiveMinAgo);

    // 最近1小时引擎使用统计
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentTransactions } = await supabase
      .from("letsgo_point_transactions")
      .select("amount, type, created_at")
      .lt("amount", 0)
      .gte("created_at", oneHourAgo);

    const pointsUsedLastHour = recentTransactions?.reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0) || 0;
    const engineCallsLastHour = recentTransactions?.length || 0;

    // 引擎实时数据（从go-engine模块直接获取进程内变量）
    const engineData = getEngineMonitorData();

    // 系统资源信息（容器环境需从cgroup读取实际内存限制）
    let totalMem = os.totalmem();
    let freeMem = os.freemem();
    // Docker/Railway容器中os.totalmem()读取的是宿主机内存，需从cgroup获取容器实际限制
    try {
      const fs = await import('fs');
      const cgroupLimit = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf-8').trim();
      const limitNum = parseInt(cgroupLimit);
      if (limitNum > 0 && limitNum < totalMem) totalMem = limitNum;
      const cgroupUsage = fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf-8').trim();
      const usageNum = parseInt(cgroupUsage);
      if (usageNum > 0) freeMem = totalMem - usageNum;
    } catch {
      // cgroup v2 尝试
      try {
        const fs = await import('fs');
        const cgroupMax = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim();
        if (cgroupMax !== 'max') {
          const limitNum = parseInt(cgroupMax);
          if (limitNum > 0 && limitNum < totalMem) totalMem = limitNum;
        }
        const cgroupCurrent = fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf-8').trim();
        const usageNum = parseInt(cgroupCurrent);
        if (usageNum > 0) freeMem = totalMem - usageNum;
      } catch {
        // 无法读取cgroup，使用os默认值
      }
    }
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model || "Unknown";
    const cpuCores = cpus.length;

    // CPU使用率（通过1秒采样计算）
    let cpuUsage = 0;
    try {
      const startUsage = process.cpuUsage();
      const startTime = Date.now();
      await new Promise(r => setTimeout(r, 2000)); // 采样2秒
      const endUsage = process.cpuUsage(startUsage);
      const elapsed = (Date.now() - startTime) * 1000; // 微秒
      cpuUsage = ((endUsage.user + endUsage.system) / elapsed) * 100;
    } catch {
      cpuUsage = 0;
    }

    // 活跃对弈统计
    const activeSessions = engineData.activeSessions;
    const activeByEngine: Record<string, number> = {};
    const activeByBoardSize: Record<number, number> = {};
    for (const s of activeSessions) {
      activeByEngine[s.engine] = (activeByEngine[s.engine] || 0) + 1;
      activeByBoardSize[s.boardSize] = (activeByBoardSize[s.boardSize] || 0) + 1;
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      users: {
        total: usersResult.count ?? 0,
        recentlyActive: recentActiveUsers ?? 0,
      },
      games: {
        total: gamesResult.count ?? 0,
        active: activeSessions.length,
        finishedLastHour: recentGamesResult.count ?? 0,
        activeByEngine,
        activeByBoardSize,
        activeSessions: activeSessions.map(s => ({
          player: s.player,
          engine: s.engine,
          boardSize: s.boardSize,
          difficulty: s.difficulty,
          totalMoves: s.totalMoves,
          lastMoveAt: s.lastActive,
          startedAt: s.lastActive,
        })),
      },
      engineQueue: {
        total: engineData.kataGo.queueLength + engineData.gnugo.queueLength,
        isProcessing: engineData.kataGo.processing || engineData.gnugo.processing,
        katago: {
          queueLength: engineData.kataGo.queueLength,
          processing: engineData.kataGo.processing,
          analysisSeconds: engineData.kataGo.analysisSeconds,
          currentTask: engineData.kataGo.currentTask,
          queueEntries: engineData.kataGo.queueEntries,
          gameModel: engineData.kataGo.gameModel,
          analysisModel: engineData.kataGo.analysisModel,
          engineConfig: engineData.kataGo.engineConfig,
          availableModels: engineData.kataGo.availableModels,
        },
        gnugo: {
          queueLength: engineData.gnugo.queueLength,
          processing: engineData.gnugo.processing,
          note: engineData.gnugo.note,
        },
      },
      usage: {
        pointsUsedLastHour,
        engineCallsLastHour,
      },
      system: {
        memory: {
          totalMB: Math.round(totalMem / 1024 / 1024),
          usedMB: Math.round(usedMem / 1024 / 1024),
          freeMB: Math.round(freeMem / 1024 / 1024),
          totalGB: Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10,
          usedGB: Math.round(usedMem / 1024 / 1024 / 1024 * 10) / 10,
          freeGB: Math.round(freeMem / 1024 / 1024 / 1024 * 10) / 10,
          usagePercent: Math.round((usedMem / totalMem) * 100),
        },
        cpu: {
          model: cpuModel,
          cores: cpuCores,
          nodeUsage: Math.round(cpuUsage * 10) / 10,
        },
        uptime: Math.round(process.uptime()),
      },
    });
  } catch (err) {
    console.error("[monitor] Error:", err);
    return NextResponse.json(
      { error: "监控数据获取失败", details: String(err) },
      { status: 500 }
    );
  }
}
