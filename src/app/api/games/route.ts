// 棋局API - 保存/载入/列表/删除（需登录）
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getUserFromAuthHeader } from '@/lib/auth';

// 检查是否是 schema cache 相关错误
function isSchemaCacheError(error: { message: string }): boolean {
  return error.message.includes('schema cache') || error.message.includes('Could not find');
}

// 构建棋局数据对象
function buildGameData(body: Record<string, unknown>, userId: number) {
  return {
    user_id: userId,
    board_size: body.board_size,
    difficulty: body.difficulty,
    engine: body.engine,
    moves: body.moves,
    commentaries: body.commentaries,
    teach_history: body.teachHistory,
    final_board: body.final_board,
    black_score: body.black_score,
    white_score: body.white_score,
    status: body.status,
    title: body.title,
  };
}

// 保存棋局（创建或更新）- 需要登录
export async function POST(request: NextRequest) {
  try {
    const user = getUserFromAuthHeader(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    const body = await request.json();
    const { id } = body;
    const client = getSupabaseClient();

    if (id) {
      // 更新已有棋局 - 验证所有权
      const { data: existing } = await client
        .from('letsgo_games')
        .select('user_id')
        .eq('id', id)
        .single();

      if (!existing || existing.user_id !== user.userId) {
        return NextResponse.json({ error: '无权修改此棋局' }, { status: 403 });
      }

      const updateData = {
        moves: body.moves,
        commentaries: body.commentaries,
        teach_history: body.teachHistory,
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

      if (error && isSchemaCacheError(error)) {
        const { engine: _, ...dataWithoutEngine } = updateData;
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

      // 更新用户统计（棋局结束时）
      if (body.status === 'finished') {
        const isWin = (body.black_score as number) > (body.white_score as number);
        await client
          .from('letsgo_users')
          .update({
            total_games: await getGameCount(client, user.userId),
            wins: await getWinCount(client, user.userId),
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.userId);
      }

      return NextResponse.json({ game: data });
    } else {
      // 创建新棋局
      let { data, error } = await client
        .from('letsgo_games')
        .insert(buildGameData(body, user.userId))
        .select()
        .single();

      if (error && isSchemaCacheError(error)) {
        const result = await client
          .from('letsgo_games')
          .insert({ ...buildGameData(body, user.userId), engine: undefined })
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

// 获取棋局列表 - 需要登录，只看自己的
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const user = getUserFromAuthHeader(request.headers.get('Authorization'));
    const client = getSupabaseClient();

    let query = client
      .from('letsgo_games')
      .select('id, user_id, board_size, difficulty, engine, status, title, black_score, white_score, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(50);

    // 登录用户只看自己的棋局
    if (user) {
      query = query.eq('user_id', user.userId);
    } else {
      // 未登录用户不返回任何棋局
      return NextResponse.json({ games: [] });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let { data, error }: { data: any[] | null; error: any } = await query;

    if (error && isSchemaCacheError(error)) {
      let fallbackQuery = client
        .from('letsgo_games')
        .select('id, user_id, board_size, difficulty, status, title, black_score, white_score, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(50);

      if (user) {
        fallbackQuery = fallbackQuery.eq('user_id', user.userId);
      }

      const result = await fallbackQuery;
      data = result.data;
      error = result.error;
    }

    if (error) throw new Error(`查询棋局失败: ${error.message}`);

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

// 删除棋局 - 需要登录且是自己的
export async function DELETE(request: NextRequest) {
  try {
    const user = getUserFromAuthHeader(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: '缺少棋局ID' }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 验证所有权
    const { data: existing } = await client
      .from('letsgo_games')
      .select('user_id')
      .eq('id', id)
      .single();

    if (!existing || existing.user_id !== user.userId) {
      return NextResponse.json({ error: '无权删除此棋局' }, { status: 403 });
    }

    const { error } = await client.from('letsgo_games').delete().eq('id', parseInt(id));
    if (error) throw new Error(`删除棋局失败: ${error.message}`);

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// 辅助函数：获取用户棋局数
async function getGameCount(client: ReturnType<typeof getSupabaseClient>, userId: number): Promise<number> {
  const { count } = await client
    .from('letsgo_games')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'finished');
  return count ?? 0;
}

// 辅助函数：获取用户胜局数
async function getWinCount(client: ReturnType<typeof getSupabaseClient>, userId: number): Promise<number> {
  const { count } = await client
    .from('letsgo_games')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'finished');
  // 简化：胜局数需要根据黑白方和比分判断，这里先返回0，后续优化
  return count ?? 0;
}
