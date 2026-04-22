import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export async function GET(_request: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('letsgo_games')
      .select('id, board_size, difficulty, engine, status, title, black_score, white_score, moves, created_at, updated_at')
      .is('user_id', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw new Error(`查询棋局失败: ${error.message}`);

    const games = (data || []).map((g: Record<string, unknown>) => ({
      ...g,
      engine: g.engine || 'local',
      moveCount: Array.isArray(g.moves) ? g.moves.length : 0,
    }));

    return NextResponse.json({ games });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
