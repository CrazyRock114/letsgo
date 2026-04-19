import { NextResponse } from 'next/server';

const SUPABASE_URL = process.env.COZE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.COZE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export async function GET() {
  const results: {
    env: Record<string, unknown>;
    tables: Record<string, Record<string, unknown>>;
    error?: string;
  } = {
    env: {
      hasSupabaseUrl: !!SUPABASE_URL,
      hasSupabaseKey: !!SUPABASE_KEY,
      hasDbUrl: !!process.env.COZE_SUPABASE_DB_URL,
      supabaseUrlHost: SUPABASE_URL ? new URL(SUPABASE_URL).hostname : 'not set',
    },
    tables: {},
  };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ...results, error: 'Supabase credentials not configured' });
  }

  try {
    // Check letsgo_players table
    const playersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/letsgo_players?select=id&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    results.tables.letsgo_players = {
      exists: playersRes.ok,
      status: playersRes.status,
      error: playersRes.ok ? null : await playersRes.text().catch(() => 'unknown'),
    };

    // Check letsgo_games table + engine column
    const gamesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/letsgo_games?select=id,engine&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const gamesBody = await gamesRes.text().catch(() => '');
    results.tables.letsgo_games = {
      exists: gamesRes.ok,
      hasEngineColumn: gamesRes.ok,
      status: gamesRes.status,
      error: gamesRes.ok ? null : gamesBody.substring(0, 200),
    };

    // If letsgo_games fails, check old games table
    if (!gamesRes.ok) {
      const oldGamesRes = await fetch(
        `${SUPABASE_URL}/rest/v1/games?select=id&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      results.tables.games_legacy = {
        exists: oldGamesRes.ok,
        status: oldGamesRes.status,
      };
    }
  } catch (err) {
    results.error = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(results, { status: 200 });
}
