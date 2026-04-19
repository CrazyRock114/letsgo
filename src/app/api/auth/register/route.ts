import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { generateToken } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { nickname, password } = await request.json();

    if (!nickname || !password) {
      return NextResponse.json({ error: '请输入昵称和密码' }, { status: 400 });
    }

    if (nickname.length < 2 || nickname.length > 20) {
      return NextResponse.json({ error: '昵称需要2-20个字符' }, { status: 400 });
    }

    if (password.length < 4) {
      return NextResponse.json({ error: '密码至少4位' }, { status: 400 });
    }

    const supabase = getSupabaseClient();

    // Check if nickname exists
    const { data: existing } = await supabase
      .from('letsgo_users')
      .select('id')
      .eq('nickname', nickname)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ error: '这个昵称已被使用' }, { status: 409 });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const { data: user, error } = await supabase
      .from('letsgo_users')
      .insert({ nickname, password_hash: passwordHash })
      .select('id, nickname, points, total_games, wins, created_at')
      .single();

    if (error) {
      console.error('[auth] Register error:', error);
      return NextResponse.json({ error: '注册失败，请重试' }, { status: 500 });
    }

    // Generate token
    const token = generateToken({ userId: user.id, nickname: user.nickname });

    return NextResponse.json({
      user: { id: user.id, nickname: user.nickname, points: user.points, totalGames: user.total_games, wins: user.wins },
      token,
    });
  } catch (err) {
    console.error('[auth] Register error:', err);
    return NextResponse.json({ error: '注册失败' }, { status: 500 });
  }
}
