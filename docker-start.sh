#!/bin/bash
# 数据库自动迁移脚本 - 使用 psql 直连 PostgreSQL
# 需要设置 COZE_SUPABASE_DB_URL 环境变量
# 格式: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres

set -e

echo "=== 小围棋乐园 启动 ==="

# 尝试数据库迁移
if [ -n "$COZE_SUPABASE_DB_URL" ]; then
  echo "[migrate] 检测到数据库连接，运行迁移..."
  psql "$COZE_SUPABASE_DB_URL" -v ON_ERROR_STOP=0 <<'SQL' 2>/dev/null || echo "[migrate] 迁移失败（非致命），继续启动..."
    -- 创建 letsgo_players 表（如不存在）
    CREATE TABLE IF NOT EXISTS letsgo_players (
      id SERIAL PRIMARY KEY,
      nickname VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    -- 创建 letsgo_games 表（如不存在）
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

    -- 添加 engine 列（如不存在）
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'letsgo_games' AND column_name = 'engine') THEN
        ALTER TABLE letsgo_games ADD COLUMN engine TEXT DEFAULT 'local';
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
SQL
  echo "[migrate] 迁移完成"
else
  echo "[migrate] 未设置 COZE_SUPABASE_DB_URL，跳过数据库迁移"
  echo "[migrate] 如需自动迁移，请在 Railway 设置该环境变量"
fi

# 启动应用
echo "[app] 启动服务器..."
exec node server.js
