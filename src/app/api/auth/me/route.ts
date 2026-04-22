import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { verifyToken } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 });
    }

    const supabase = getSupabaseClient();
    const { data: user, error } = await supabase
      .from('letsgo_users')
      .select('id, nickname, points, total_games, wins, created_at, is_admin')
      .eq('id', payload.userId)
      .single();

    if (error || !user) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    }

    return NextResponse.json({
      user: { id: user.id, nickname: user.nickname, points: user.points, totalGames: user.total_games, wins: user.wins, isAdmin: user.is_admin === 1 },
    });
  } catch (err) {
    console.error('[auth] Me error:', err);
    return NextResponse.json({ error: '获取用户信息失败' }, { status: 500 });
  }
}
