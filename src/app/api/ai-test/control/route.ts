import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuthHeader } from '@/lib/auth';
import * as worker from '@/lib/ai-test-worker';

interface SpectatorConfig {
  boardSize: 9 | 13 | 19;
  stepInterval: number;
  winRateEndCondition: number;
  aiPlayer: {
    color: 'black' | 'white';
    analysisDifficulty: 'easy' | 'medium' | 'hard';
  };
  opponent: {
    engine: 'katago' | 'gnugo' | 'local';
    difficulty: 'easy' | 'medium' | 'hard';
  };
}

export async function POST(request: NextRequest) {
  try {
    const user = getUserFromAuthHeader(request.headers.get('Authorization'));
    if (!user?.isAdmin) {
      return NextResponse.json({ error: '无权操作' }, { status: 403 });
    }

    const body = await request.json();
    const { action, config } = body;

    switch (action) {
      case 'start': {
        if (!config) {
          return NextResponse.json({ error: '缺少配置' }, { status: 400 });
        }
        const result = await worker.createGame(config as SpectatorConfig);
        if (!result.success) {
          return NextResponse.json({ error: result.error }, { status: 500 });
        }
        return NextResponse.json({ success: true, gameId: result.gameId });
      }
      case 'pause': {
        await worker.pauseGame();
        return NextResponse.json({ success: true });
      }
      case 'resume': {
        await worker.resumeGame();
        return NextResponse.json({ success: true });
      }
      case 'end': {
        await worker.endGame();
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
