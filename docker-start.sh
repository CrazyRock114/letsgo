#!/bin/bash
# 数据库自动迁移脚本 - 使用 psql 直连 PostgreSQL
# 需要设置 COZE_SUPABASE_DB_URL 环境变量
# 格式: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres

set -e

echo "=== 小围棋乐园 启动 ==="

# 尝试数据库迁移
if [ -n "$COZE_SUPABASE_DB_URL" ]; then
  echo "[migrate] 检测到 COZE_SUPABASE_DB_URL，运行迁移..."

  # 先测试连接
  echo "[migrate] 测试数据库连接..."
  if psql "$COZE_SUPABASE_DB_URL" -c "SELECT 1 AS test;" >/dev/null 2>&1; then
    echo "[migrate] 数据库连接成功 ✓"
  else
    echo "[migrate] ✗ 数据库连接失败！尝试输出详细错误："
    psql "$COZE_SUPABASE_DB_URL" -c "SELECT 1;" 2>&1 || true
    echo "[migrate] 跳过迁移，继续启动（非致命）"
    echo "[app] 启动服务器..."
    exec node server.js
  fi

  # 运行迁移 SQL
  echo "[migrate] 执行迁移 SQL..."
  MIGRATE_OUTPUT=$(psql "$COZE_SUPABASE_DB_URL" -v ON_ERROR_STOP=0 <<'SQL' 2>&1 || true
    -- 创建 letsgo_players 表（如不存在，旧兼容）
    CREATE TABLE IF NOT EXISTS letsgo_players (
      id SERIAL PRIMARY KEY,
      nickname VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    -- 创建 letsgo_users 表（用户系统）
    CREATE TABLE IF NOT EXISTS letsgo_users (
      id SERIAL PRIMARY KEY,
      nickname VARCHAR(50) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 100,
      total_games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 创建 letsgo_point_transactions 表（积分流水）
    CREATE TABLE IF NOT EXISTS letsgo_point_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES letsgo_users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      type VARCHAR(50) NOT NULL,
      description TEXT,
      game_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    -- 创建 letsgo_games 表（如不存在）
    CREATE TABLE IF NOT EXISTS letsgo_games (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES letsgo_players(id),
      user_id INTEGER REFERENCES letsgo_users(id),
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

    -- 添加 engine 列（如不存在）
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'letsgo_games' AND column_name = 'engine') THEN
        ALTER TABLE letsgo_games ADD COLUMN engine TEXT DEFAULT 'local';
      END IF;
    END $$;

    -- 添加 user_id 列（如不存在）
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'letsgo_games' AND column_name = 'user_id') THEN
        ALTER TABLE letsgo_games ADD COLUMN user_id INTEGER REFERENCES letsgo_users(id);
      END IF;
    END $$;

    -- player_id 改为可空（新用户系统不再依赖 player_id）
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'letsgo_games' AND column_name = 'player_id' AND is_nullable = 'NO') THEN
        ALTER TABLE letsgo_games ALTER COLUMN player_id DROP NOT NULL;
      END IF;
    END $$;

    -- 迁移旧表数据（如果存在旧 players/games 表且有数据）
    INSERT INTO letsgo_players (id, nickname, created_at)
    SELECT id, nickname, created_at FROM players
    WHERE NOT EXISTS (SELECT 1 FROM letsgo_players WHERE letsgo_players.id = players.id)
    LIMIT 100;

    INSERT INTO letsgo_games (id, player_id, board_size, difficulty, engine, moves, commentaries, final_board, black_score, white_score, status, title, created_at, updated_at)
    SELECT id, player_id, board_size, difficulty, 'local', moves, commentaries, final_board, black_score, white_score, status, title, created_at, updated_at FROM games
    WHERE NOT EXISTS (SELECT 1 FROM letsgo_games WHERE letsgo_games.id = games.id)
    LIMIT 100;

    -- 为积分流水创建索引
    CREATE INDEX IF NOT EXISTS idx_point_transactions_user_id ON letsgo_point_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_point_transactions_type ON letsgo_point_transactions(type);
    CREATE INDEX IF NOT EXISTS idx_games_user_id ON letsgo_games(user_id);
SQL
  )

  if [ -n "$MIGRATE_OUTPUT" ]; then
    echo "[migrate] 迁移输出:"
    echo "$MIGRATE_OUTPUT" | head -20
  fi
  echo "[migrate] 迁移完成 ✓"
else
  echo "[migrate] 未设置 COZE_SUPABASE_DB_URL，跳过数据库迁移"
  echo "[migrate] 如需自动迁移，请在 Railway 设置该环境变量"
fi

# 启动应用
echo "[app] 启动服务器..."
exec node server.js
