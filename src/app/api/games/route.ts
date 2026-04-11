// 棋局API - 保存/载入/列表/删除
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 保存棋局（创建或更新）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, player_id, board_size, difficulty, moves, commentaries, final_board, black_score, white_score, status, title } = body;

    if (!player_id) {
      return NextResponse.json({ error: '缺少玩家ID' }, { status: 400 });
    }

    const client = getSupabaseClient();

    if (id) {
      // 更新已有棋局
      const { data, error } = await client
        .from('games')
        .update({
          moves,
          commentaries,
          final_board,
          black_score,
          white_score,
          status,
          title,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(`更新棋局失败: ${error.message}`);
      return NextResponse.json({ game: data });
    } else {
      // 创建新棋局
      const { data, error } = await client
        .from('games')
        .insert({
          player_id,
          board_size,
          difficulty,
          moves,
          commentaries,
          final_board,
          black_score,
          white_score,
          status,
          title,
        })
        .select()
        .single();

      if (error) throw new Error(`保存棋局失败: ${error.message}`);
      return NextResponse.json({ game: data });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// 获取棋局列表
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const playerId = searchParams.get('player_id');

    const client = getSupabaseClient();

    let query = client
      .from('games')
      .select('id, player_id, board_size, difficulty, status, title, black_score, white_score, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (playerId) {
      query = query.eq('player_id', parseInt(playerId));
    }

    const { data, error } = await query;

    if (error) throw new Error(`查询棋局失败: ${error.message}`);

    return NextResponse.json({ games: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// 删除棋局
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: '缺少棋局ID' }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { error } = await client.from('games').delete().eq('id', parseInt(id));

    if (error) throw new Error(`删除棋局失败: ${error.message}`);

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
