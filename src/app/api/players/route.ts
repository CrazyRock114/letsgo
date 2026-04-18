// 用户API - 创建/查找用户
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export async function POST(request: NextRequest) {
  try {
    const { nickname } = await request.json();
    if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
      return NextResponse.json({ error: '请输入昵称' }, { status: 400 });
    }

    const client = getSupabaseClient();

    // 先查找是否已有该昵称
    const { data: existing, error: findError } = await client
      .from('letsgo_players')
      .select('id, nickname')
      .eq('nickname', nickname.trim())
      .maybeSingle();

    if (findError) throw new Error(`查找用户失败: ${findError.message}`);

    if (existing) {
      return NextResponse.json({ player: existing });
    }

    // 创建新用户
    const { data, error } = await client
      .from('letsgo_players')
      .insert({ nickname: nickname.trim() })
      .select('id, nickname')
      .single();

    if (error) throw new Error(`创建用户失败: ${error.message}`);

    return NextResponse.json({ player: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('letsgo_players')
      .select('id, nickname')
      .order('id', { ascending: true })
      .limit(50);

    if (error) throw new Error(`查询用户失败: ${error.message}`);

    return NextResponse.json({ players: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
