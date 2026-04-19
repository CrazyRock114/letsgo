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

    const supabase = getSupabaseClient();

    // Find user
    const { data: user, error } = await supabase
      .from('letsgo_users')
      .select('id, nickname, password_hash, points, total_games, wins, created_at')
      .eq('nickname', nickname)
      .single();

    if (error || !user) {
      return NextResponse.json({ error: '昵称或密码错误' }, { status: 401 });
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return NextResponse.json({ error: '昵称或密码错误' }, { status: 401 });
    }

    // Generate token
    const token = generateToken({ userId: user.id, nickname: user.nickname });

    return NextResponse.json({
      user: { id: user.id, nickname: user.nickname, points: user.points, totalGames: user.total_games, wins: user.wins },
      token,
    });
  } catch (err) {
    console.error('[auth] Login error:', err);
    return NextResponse.json({ error: '登录失败' }, { status: 500 });
  }
}
