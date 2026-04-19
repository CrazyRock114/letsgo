/**
 * 数据库迁移脚本 - Node.js 版本（无 TypeScript 依赖）
 * 在 Docker 容器启动时运行，使用 pg 库连接 PostgreSQL
 */
const { Client } = require('pg');

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS letsgo_players (
    id SERIAL PRIMARY KEY,
    nickname VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS letsgo_players_nickname_idx ON letsgo_players (nickname)`,
  `CREATE TABLE IF NOT EXISTS letsgo_games (
    id SERIAL PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES letsgo_players(id),
    board_size INTEGER NOT NULL DEFAULT 9,
    difficulty VARCHAR(20) NOT NULL DEFAULT 'easy',
    engine TEXT DEFAULT 'local',
    moves JSONB NOT NULL DEFAULT '[]'::jsonb,
    commentaries JSONB NOT NULL DEFAULT '[]'::jsonb,
    final_board JSONB,
    black_score INTEGER DEFAULT 0,
    white_score INTEGER DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'playing',
    title VARCHAR(200),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS letsgo_games_player_id_idx ON letsgo_games (player_id)`,
  `CREATE INDEX IF NOT EXISTS letsgo_games_status_idx ON letsgo_games (status)`,
  `CREATE INDEX IF NOT EXISTS letsgo_games_created_at_idx ON letsgo_games (created_at)`,
  `ALTER TABLE letsgo_games ADD COLUMN IF NOT EXISTS engine TEXT DEFAULT 'local'`,
  // 迁移旧表数据
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN
      INSERT INTO letsgo_players (id, nickname, created_at)
      SELECT id, nickname, created_at FROM players ON CONFLICT (id) DO NOTHING;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'games') THEN
      INSERT INTO letsgo_games (id, player_id, board_size, difficulty, moves, commentaries, final_board, black_score, white_score, status, title, created_at, updated_at)
      SELECT id, player_id, board_size, difficulty, moves, commentaries, final_board, black_score, white_score, status, title, created_at, updated_at FROM games ON CONFLICT (id) DO NOTHING;
    END IF;
  END $$`,
];

async function run() {
  const dbUrl = process.env.COZE_SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('[migrate] No database URL, skipping');
    return;
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('[migrate] Connected to database');

    for (let i = 0; i < MIGRATIONS.length; i++) {
      try {
        await client.query(MIGRATIONS[i]);
        console.log(`[migrate] ✓ Migration ${i + 1}/${MIGRATIONS.length}`);
      } catch (err) {
        console.error(`[migrate] ✗ Migration ${i + 1}/${MIGRATIONS.length}:`, err.message);
      }
    }
    console.log('[migrate] Done');
  } catch (err) {
    console.error('[migrate] Failed:', err.message);
  } finally {
    await client.end();
  }
}

run().catch(() => {});
