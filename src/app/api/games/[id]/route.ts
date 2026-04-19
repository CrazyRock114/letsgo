// 单个棋局API - 载入完整棋局数据
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

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

    // 确保 engine 字段有默认值（旧表可能没有此列）
    const game = data ? { ...data, engine: data.engine || 'local' } : data;

    return NextResponse.json({ game });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
