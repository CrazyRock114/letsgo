import { NextResponse } from 'next/server';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.COZE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || '';

export async function GET() {
  const results: {
    env: Record<string, unknown>;
    tables: Record<string, Record<string, unknown>>;
    error?: string;
  } = {
    env: {
      hasSupabaseUrl: !!SUPABASE_URL,
      hasSupabaseKey: !!SUPABASE_KEY,
      hasServiceKey: !!SUPABASE_SERVICE_KEY,
      hasDbUrl: !!(process.env.SUPABASE_DB_URL || process.env.COZE_SUPABASE_DB_URL),
      supabaseUrlHost: SUPABASE_URL ? new URL(SUPABASE_URL).hostname : 'not set',
    },
    tables: {},
  };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json({ ...results, error: 'Supabase credentials not configured' });
  }

  try {
    // Check letsgo_users table
    const usersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/letsgo_users?select=id&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY || SUPABASE_KEY}` } }
    );
    results.tables.letsgo_users = {
      exists: usersRes.ok,
      status: usersRes.status,
      error: usersRes.ok ? null : await usersRes.text().catch(() => 'unknown'),
    };

    // Check letsgo_games table
    const gamesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/letsgo_games?select=id,engine&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY || SUPABASE_KEY}` } }
    );
    const gamesBody = await gamesRes.text().catch(() => '');
    results.tables.letsgo_games = {
      exists: gamesRes.ok,
      hasEngineColumn: gamesRes.ok,
      status: gamesRes.status,
      error: gamesRes.ok ? null : gamesBody.substring(0, 200),
    };

    // Check letsgo_point_transactions table
    const txRes = await fetch(
      `${SUPABASE_URL}/rest/v1/letsgo_point_transactions?select=id&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY || SUPABASE_KEY}` } }
    );
    results.tables.letsgo_point_transactions = {
      exists: txRes.ok,
      status: txRes.status,
    };

    // Check letsgo_players table (legacy, should be removed)
    const playersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/letsgo_players?select=id&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY || SUPABASE_KEY}` } }
    );
    results.tables.letsgo_players = {
      exists: playersRes.ok,
      status: playersRes.status,
      note: playersRes.ok ? 'Legacy table, should be dropped' : 'Already dropped',
    };
  } catch (err) {
    results.error = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(results, { status: 200 });
}
