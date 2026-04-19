import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { verifyToken } from '@/lib/auth';

// GET /api/users/points — 获取积分余额和交易记录
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const payload = verifyToken(authHeader.slice(7));
    if (!payload) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 });
    }

    const supabase = getSupabaseClient();

    // 获取用户积分
    const { data: user, error: userError } = await supabase
      .from('letsgo_users')
      .select('points')
      .eq('id', payload.userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    }

    // 获取最近交易记录
    const { data: transactions } = await supabase
      .from('letsgo_point_transactions')
      .select('id, amount, type, description, created_at')
      .eq('user_id', payload.userId)
      .order('created_at', { ascending: false })
      .limit(20);

    return NextResponse.json({
      points: user.points,
      transactions: transactions || [],
    });
  } catch (err) {
    console.error('[points] GET error:', err);
    return NextResponse.json({ error: '获取积分失败' }, { status: 500 });
  }
}

// POST /api/users/points — 扣除积分（引擎使用）
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }

    const payload = verifyToken(authHeader.slice(7));
    if (!payload) {
      return NextResponse.json({ error: '登录已过期' }, { status: 401 });
    }

    const body = await request.json();
    const { amount, type, description, gameId } = body as {
      amount: number;
      type: string;
      description?: string;
      gameId?: number;
    };

    if (!amount || !type) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    const supabase = getSupabaseClient();

    // 获取当前积分
    const { data: user, error: userError } = await supabase
      .from('letsgo_users')
      .select('points')
      .eq('id', payload.userId)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    }

    if (user.points + amount < 0) {
      return NextResponse.json({ error: '积分不足', points: user.points }, { status: 400 });
    }

    // 扣除/增加积分
    const newPoints = user.points + amount;
    const { error: updateError } = await supabase
      .from('letsgo_users')
      .update({ points: newPoints, updated_at: new Date().toISOString() })
      .eq('id', payload.userId);

    if (updateError) {
      console.error('[points] Update error:', updateError);
      return NextResponse.json({ error: '积分更新失败' }, { status: 500 });
    }

    // 记录交易
    await supabase.from('letsgo_point_transactions').insert({
      user_id: payload.userId,
      amount,
      type,
      description: description || null,
      game_id: gameId || null,
    });

    return NextResponse.json({ points: newPoints, deducted: amount });
  } catch (err) {
    console.error('[points] POST error:', err);
    return NextResponse.json({ error: '积分操作失败' }, { status: 500 });
  }
}
