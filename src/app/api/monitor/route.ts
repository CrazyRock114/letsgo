import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";

// 实时引擎使用统计（进程内变量，与go-engine共享）
// 这个文件不能直接import go-engine的变量，但可以通过fetch获取

// 监控数据API - 引擎状态、在线用户、排队情况
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

    // 并行获取所有监控数据
    const [usersResult, gamesResult, activeGamesResult, recentGamesResult] = await Promise.all([
      // 总注册用户数
      supabase.from("letsgo_users").select("id", { count: "exact", head: true }),
      // 总棋局数
      supabase.from("letsgo_games").select("id", { count: "exact", head: true }),
      // 进行中的棋局
      supabase.from("letsgo_games").select("id, board_size, difficulty, engine, title, created_at, updated_at, user_id").eq("status", "playing").order("updated_at", { ascending: false }).limit(50),
      // 最近1小时完成的棋局数
      supabase.from("letsgo_games").select("id", { count: "exact", head: true }).eq("status", "finished").gte("updated_at", new Date(Date.now() - 60 * 60 * 1000).toISOString()),
    ]);

    // 获取在线用户（最近5分钟活跃的用户 - 通过updated_at判断）
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count: recentActiveUsers } = await supabase
      .from("letsgo_users")
      .select("id", { count: "exact", head: true })
      .gte("updated_at", fiveMinAgo);

    // 获取最近1小时的积分消耗
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentTransactions } = await supabase
      .from("letsgo_point_transactions")
      .select("amount, type, created_at")
      .lt("amount", 0)
      .gte("created_at", oneHourAgo);

    const pointsUsedLastHour = recentTransactions?.reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0) || 0;
    const engineCallsLastHour = recentTransactions?.length || 0;

    // 获取活跃棋局的用户昵称
    const activeUserIds = activeGamesResult.data?.map((g: { user_id: number | null }) => g.user_id).filter(Boolean) as number[];
    let userNicknames: Record<number, string> = {};
    if (activeUserIds.length > 0) {
      const { data: users } = await supabase
        .from("letsgo_users")
        .select("id, nickname")
        .in("id", [...new Set(activeUserIds)]);
      if (users) {
        userNicknames = Object.fromEntries(users.map((u: { id: number; nickname: string }) => [u.id, u.nickname]));
      }
    }

    // 引擎统计
    const engineStats: Record<string, number> = {};
    activeGamesResult.data?.forEach((g: { engine: string | null }) => {
      const eng = g.engine || "local";
      engineStats[eng] = (engineStats[eng] || 0) + 1;
    });

    // 棋盘大小统计
    const boardSizeStats: Record<number, number> = {};
    activeGamesResult.data?.forEach((g: { board_size: number }) => {
      boardSizeStats[g.board_size] = (boardSizeStats[g.board_size] || 0) + 1;
    });

    // 获取引擎队列信息
    let engineQueueInfo = { queueLength: 0, isProcessing: false, engines: [] as Array<{ id: string; name: string; available: boolean; cost: number }> };
    try {
      const engineRes = await fetch(`http://localhost:${process.env.DEPLOY_RUN_PORT || 5000}/api/go-engine`);
      if (engineRes.ok) {
        const engineData = await engineRes.json();
        engineQueueInfo = {
          queueLength: engineData.queueLength || 0,
          isProcessing: engineData.isProcessing || false,
          engines: (engineData.engines || []).map((e: { id: string; name: string; available: boolean; cost: number }) => ({
            id: e.id,
            name: e.name,
            available: e.available,
            cost: e.cost,
          })),
        };
      }
    } catch {
      // 内部fetch失败，使用默认值
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      users: {
        total: usersResult.count ?? 0,
        recentlyActive: recentActiveUsers ?? 0,
      },
      games: {
        total: gamesResult.count ?? 0,
        active: activeGamesResult.data?.length ?? 0,
        finishedLastHour: recentGamesResult.count ?? 0,
        activeByEngine: engineStats,
        activeByBoardSize: boardSizeStats,
        activeGames: (activeGamesResult.data || []).map((g: {
          id: number; board_size: number; difficulty: string; engine: string | null;
          title: string; created_at: string; updated_at: string; user_id: number | null;
        }) => ({
          id: g.id,
          boardSize: g.board_size,
          difficulty: g.difficulty,
          engine: g.engine || "local",
          title: g.title,
          player: g.user_id ? userNicknames[g.user_id] || `User#${g.user_id}` : "未登录",
          createdAt: g.created_at,
          updatedAt: g.updated_at,
        })),
      },
      engineQueue: engineQueueInfo,
      usage: {
        pointsUsedLastHour: pointsUsedLastHour,
        engineCallsLastHour: engineCallsLastHour,
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
