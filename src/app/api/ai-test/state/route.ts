import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export async function GET(_request: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('letsgo_games')
      .select('id, board_size, difficulty, engine, moves, commentaries, final_board, black_score, white_score, status, title, config, created_at, updated_at')
      .in('status', ['running', 'paused'])
      .is('user_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return NextResponse.json({ game: null });
    }

    return NextResponse.json({ game: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
