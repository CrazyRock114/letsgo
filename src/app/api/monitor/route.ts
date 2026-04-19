import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";

// 监控数据API - 引擎状态、在线用户、排队情况
export async function GET() {
  try {
    const supabase = getSupabaseClient();

    // 并行获取所有监控数据
    const [usersResult, gamesResult, activeGamesResult] = await Promise.all([
      // 总注册用户数
      supabase.from("letsgo_users").select("id", { count: "exact", head: true }),
      // 总棋局数
      supabase.from("letsgo_games").select("id", { count: "exact", head: true }),
      // 进行中的棋局
      supabase.from("letsgo_games").select("id, board_size, difficulty, engine, title, created_at, updated_at, user_id").eq("status", "playing").order("updated_at", { ascending: false }).limit(50),
    ]);

    // 获取在线用户（最近5分钟活跃的用户 - 通过updated_at判断）
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count: recentActiveUsers } = await supabase
      .from("letsgo_users")
      .select("id", { count: "exact", head: true })
      .gte("updated_at", fiveMinAgo);

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

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      users: {
        total: usersResult.count ?? 0,
        recentlyActive: recentActiveUsers ?? 0,
      },
      games: {
        total: gamesResult.count ?? 0,
        active: activeGamesResult.data?.length ?? 0,
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
      engineQueue: {
        // 这些数据从 go-engine GET API 获取
        note: "引擎队列信息请访问 /api/go-engine",
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
