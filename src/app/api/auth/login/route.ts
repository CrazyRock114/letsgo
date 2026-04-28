import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { generateToken } from '@/lib/auth';

const DAILY_BONUS = 2000;

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
      .select('id, nickname, password_hash, points, total_games, wins, created_at, is_admin')
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

    // Check daily bonus: is there a daily_bonus transaction today?
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const { data: todayBonus } = await supabase
      .from('letsgo_point_transactions')
      .select('id')
      .eq('user_id', user.id)
      .eq('type', 'daily_bonus')
      .gte('created_at', todayStart)
      .limit(1);

    let dailyBonusAwarded = false;
    let currentPoints = user.points;

    if (!todayBonus || todayBonus.length === 0) {
      // Award daily bonus: update points
      const newPoints = currentPoints + DAILY_BONUS;
      const { error: updateErr } = await supabase
        .from('letsgo_users')
        .update({ points: newPoints, updated_at: new Date().toISOString() })
        .eq('id', user.id);

      if (!updateErr) {
        // Record transaction
        await supabase.from('letsgo_point_transactions').insert({
          user_id: user.id,
          amount: DAILY_BONUS,
          type: 'daily_bonus',
          description: `每日登录奖励 +${DAILY_BONUS}积分`,
        });
        currentPoints = newPoints;
        dailyBonusAwarded = true;
      } else {
        console.error('[auth] Daily bonus update failed:', updateErr);
      }
    }

    // Generate token
    const token = generateToken({ userId: user.id, nickname: user.nickname, isAdmin: user.is_admin === 1 });

    return NextResponse.json({
      user: { id: user.id, nickname: user.nickname, points: currentPoints, totalGames: user.total_games, wins: user.wins, isAdmin: user.is_admin === 1 },
      token,
      dailyBonusAwarded,
      dailyBonusAmount: dailyBonusAwarded ? DAILY_BONUS : 0,
    });
  } catch (err) {
    console.error('[auth] Login error:', err);
    return NextResponse.json({ error: '登录失败' }, { status: 500 });
  }
}
