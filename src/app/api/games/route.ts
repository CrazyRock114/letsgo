// 棋局API - 保存/载入/列表/删除
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// 构建棋局数据对象（如果 engine 列不存在则排除）
function buildGameData(body: Record<string, unknown>, includeEngine: boolean) {
  const data: Record<string, unknown> = {
    player_id: body.player_id,
    board_size: body.board_size,
    difficulty: body.difficulty,
    moves: body.moves,
    commentaries: body.commentaries,
    final_board: body.final_board,
    black_score: body.black_score,
    white_score: body.white_score,
    status: body.status,
    title: body.title,
  };
  if (includeEngine) {
    data.engine = body.engine;
  }
  return data;
}

// 检查是否是 schema cache 相关错误
function isSchemaCacheError(error: { message: string }): boolean {
  return error.message.includes('schema cache') || error.message.includes('Could not find');
}

// 保存棋局（创建或更新）
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body;

    if (!body.player_id) {
      return NextResponse.json({ error: '缺少玩家ID' }, { status: 400 });
    }

    const client = getSupabaseClient();

    if (id) {
      // 更新已有棋局
      const updateData = {
        moves: body.moves,
        commentaries: body.commentaries,
        final_board: body.final_board,
        black_score: body.black_score,
        white_score: body.white_score,
        status: body.status,
        title: body.title,
        engine: body.engine,
        updated_at: new Date().toISOString(),
      };

      let { data, error } = await client
        .from('letsgo_games')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      // 如果 engine 列不存在，重试不带 engine
      if (error && isSchemaCacheError(error)) {
        console.warn('[games] Schema cache error, retrying without engine column:', error.message);
        const { engine, ...dataWithoutEngine } = updateData;
        const result = await client
          .from('letsgo_games')
          .update(dataWithoutEngine)
          .eq('id', id)
          .select()
          .single();
        data = result.data;
        error = result.error;
      }

      if (error) throw new Error(`更新棋局失败: ${error.message}`);
      return NextResponse.json({ game: data });
    } else {
      // 创建新棋局
      let { data, error } = await client
        .from('letsgo_games')
        .insert(buildGameData(body, true))
        .select()
        .single();

      // 如果 engine 列不存在，重试不带 engine
      if (error && isSchemaCacheError(error)) {
        console.warn('[games] Schema cache error, retrying without engine column:', error.message);
        const result = await client
          .from('letsgo_games')
          .insert(buildGameData(body, false))
          .select()
          .single();
        data = result.data;
        error = result.error;
      }

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

    // 先尝试包含 engine 列的查询
    let query = client
      .from('letsgo_games')
      .select('id, player_id, board_size, difficulty, engine, status, title, black_score, white_score, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (playerId) {
      query = query.eq('player_id', parseInt(playerId));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let { data, error }: { data: any[] | null; error: any } = await query;

    // 如果 engine 列不存在，重试不带 engine
    if (error && isSchemaCacheError(error)) {
      console.warn('[games] Schema cache error in GET, retrying without engine column:', error.message);
      let fallbackQuery = client
        .from('letsgo_games')
        .select('id, player_id, board_size, difficulty, status, title, black_score, white_score, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(50);

      if (playerId) {
        fallbackQuery = fallbackQuery.eq('player_id', parseInt(playerId));
      }

      const result = await fallbackQuery;
      data = result.data;
      error = result.error;
    }

    if (error) throw new Error(`查询棋局失败: ${error.message}`);

    // 确保 engine 字段有默认值
    const games = (data || []).map((g: Record<string, unknown>) => ({
      ...g,
      engine: g.engine || 'local',
    }));

    return NextResponse.json({ games });
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
    const { error } = await client.from('letsgo_games').delete().eq('id', parseInt(id));

    if (error) throw new Error(`删除棋局失败: ${error.message}`);

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
