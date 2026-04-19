#!/bin/bash
# 小围棋乐园 - Docker 启动脚本
# 先运行数据库迁移，然后启动 Next.js 服务器

set -e

echo "[startup] 小围棋乐园 starting..."

# 如果设置了 PostgreSQL 直连 URL，运行迁移
if [ -n "$COZE_SUPABASE_DB_URL" ] || [ -n "$DATABASE_URL" ]; then
  echo "[startup] Running database migrations..."
  DB_URL="${COZE_SUPABASE_DB_URL:-$DATABASE_URL}"
  
  # 检查 psql 是否可用
  if command -v psql &> /dev/null; then
    echo "[startup] Using psql for migrations"
    psql "$DB_URL" -c "
      CREATE TABLE IF NOT EXISTS letsgo_players (
        id SERIAL PRIMARY KEY,
        nickname VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS letsgo_players_nickname_idx ON letsgo_players (nickname);
      
      CREATE TABLE IF NOT EXISTS letsgo_games (
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
      CREATE INDEX IF NOT EXISTS letsgo_games_created_at_idx ON letsgo_games (created_at);
      
      ALTER TABLE letsgo_games ADD COLUMN IF NOT EXISTS engine TEXT DEFAULT 'local';
      
      -- 迁移旧表数据（如果存在）
      DO \$\$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'players') THEN
          INSERT INTO letsgo_players (id, nickname, created_at)
          SELECT id, nickname, created_at FROM players
          ON CONFLICT (id) DO NOTHING;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'games') THEN
          INSERT INTO letsgo_games (id, player_id, board_size, difficulty, moves, commentaries, final_board, black_score, white_score, status, title, created_at, updated_at)
          SELECT id, player_id, board_size, difficulty, moves, commentaries, final_board, black_score, white_score, status, title, created_at, updated_at FROM games
          ON CONFLICT (id) DO NOTHING;
        END IF;
      END
      \$\$;
    " 2>&1 || echo "[startup] Migration had errors, continuing anyway..."
  else
    echo "[startup] psql not available, using Node.js migration"
    node /app/migrate.js 2>/dev/null || echo "[startup] Node.js migration failed, continuing anyway..."
  fi
  echo "[startup] Database migrations done"
else
  echo "[startup] No COZE_SUPABASE_DB_URL set, skipping database migrations"
  echo "[startup] To enable auto-migration, set COZE_SUPABASE_DB_URL in Railway env vars"
  echo "[startup] Format: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
fi

# 启动 Next.js 服务器
echo "[startup] Starting Next.js server..."
exec node server.js
