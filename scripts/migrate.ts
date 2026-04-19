/**
 * 数据库迁移脚本 - 小围棋乐园
 * 在服务器启动前运行，确保数据库表结构是最新的
 * 
 * 使用方式：
 * 1. 通过 COZE_SUPABASE_DB_URL (PostgreSQL直连) - 推荐用于 Railway
 * 2. 通过 coze-coding-ai db upgrade - 推荐用于 Coze 开发环境
 */

import { Client } from 'pg';

const MIGRATIONS = [
  {
    name: 'create_letsgo_players_table',
    sql: `CREATE TABLE IF NOT EXISTS letsgo_players (
      id SERIAL PRIMARY KEY,
      nickname VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS letsgo_players_nickname_idx ON letsgo_players (nickname);`
  },
  {
    name: 'create_letsgo_games_table',
    sql: `CREATE TABLE IF NOT EXISTS letsgo_games (
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
    );
    CREATE INDEX IF NOT EXISTS letsgo_games_player_id_idx ON letsgo_games (player_id);
    CREATE INDEX IF NOT EXISTS letsgo_games_status_idx ON letsgo_games (status);
    CREATE INDEX IF NOT EXISTS letsgo_games_created_at_idx ON letsgo_games (created_at);`
  },
  {
    name: 'add_engine_column_to_letsgo_games',
    sql: `ALTER TABLE letsgo_games ADD COLUMN IF NOT EXISTS engine TEXT DEFAULT 'local';`
  },
  {
    name: 'migrate_data_from_old_tables',
    sql: `-- 将旧表 players/games 中的数据迁移到新表（如果旧表存在且有数据）
    DO $$
    BEGIN
      -- 迁移 players
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN
        INSERT INTO letsgo_players (id, nickname, created_at)
        SELECT id, nickname, created_at FROM players
        ON CONFLICT (id) DO NOTHING;
      END IF;
      
      -- 迁移 games（不包含 engine 列，因为旧表没有）
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'games') THEN
        INSERT INTO letsgo_games (id, player_id, board_size, difficulty, moves, commentaries, final_board, black_score, white_score, status, title, created_at, updated_at)
        SELECT id, player_id, board_size, difficulty, moves, commentaries, final_board, black_score, white_score, status, title, created_at, updated_at FROM games
        ON CONFLICT (id) DO NOTHING;
      END IF;
    END
    $$;`
  }
];

async function runMigrations(dbUrl: string) {
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  
  try {
    await client.connect();
    console.log('[migrate] Connected to database');

    // 创建迁移记录表
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name VARCHAR(200) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    for (const migration of MIGRATIONS) {
      const result = await client.query(
        'SELECT 1 FROM _migrations WHERE name = $1',
        [migration.name]
      );
      
      if (result.rows.length > 0) {
        console.log(`[migrate] Skipping ${migration.name} (already applied)`);
        continue;
      }

      console.log(`[migrate] Running ${migration.name}...`);
      await client.query(migration.sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
      console.log(`[migrate] ✓ ${migration.name} applied`);
    }

    console.log('[migrate] All migrations complete');
  } catch (error) {
    console.error('[migrate] Migration failed:', error);
    // 不抛出错误，让服务器继续启动（降级模式）
    console.error('[migrate] Server will start anyway, but some features may not work');
  } finally {
    await client.end();
  }
}

// 主入口
const dbUrl = process.env.COZE_SUPABASE_DB_URL || process.env.DATABASE_URL;

if (!dbUrl) {
  console.log('[migrate] No COZE_SUPABASE_DB_URL or DATABASE_URL set, skipping migrations');
  console.log('[migrate] If using Supabase, you may need to run SQL manually in the dashboard');
  process.exit(0);
}

runMigrations(dbUrl).then(() => process.exit(0)).catch(() => process.exit(0));
