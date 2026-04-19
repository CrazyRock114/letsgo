// 单个棋局API - 载入完整棋局数据
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getUserFromAuthHeader } from '@/lib/auth';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const client = getSupabaseClient();

    const { data, error } = await client
      .from('letsgo_games')
      .select('*')
      .eq('id', parseInt(id))
      .single();

    if (error) throw new Error(`载入棋局失败: ${error.message}`);

    // 确保 engine 字段有默认值
    const game = data ? { ...data, engine: data.engine || 'local' } : data;

    return NextResponse.json({ game });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// 删除单个棋局 - 需要登录且是自己的
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = getUserFromAuthHeader(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    const { id } = await params;
    const client = getSupabaseClient();

    // 验证所有权
    const { data: existing } = await client
      .from('letsgo_games')
      .select('user_id')
      .eq('id', parseInt(id))
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
