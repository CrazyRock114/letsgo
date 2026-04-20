#!/bin/bash
# 数据库自动迁移脚本 - 使用 psql 直连 PostgreSQL
# 需要设置 SUPABASE_DB_URL 或 COZE_SUPABASE_DB_URL 环境变量
# 格式: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres

set -e

echo "=== 小围棋乐园 启动 ==="

# 确定 DB URL（优先 SUPABASE_DB_URL，兼容 COZE_SUPABASE_DB_URL）
DB_URL="${SUPABASE_DB_URL:-$COZE_SUPABASE_DB_URL}"

# 尝试数据库迁移
if [ -n "$DB_URL" ]; then
  echo "[migrate] 检测到数据库连接字符串，运行迁移..."

  # 先测试连接
  echo "[migrate] 测试数据库连接..."
  if psql "$DB_URL" -c "SELECT 1 AS test;" >/dev/null 2>&1; then
    echo "[migrate] 数据库连接成功 ✓"
  else
    echo "[migrate] ✗ 数据库连接失败！尝试输出详细错误："
    psql "$DB_URL" -c "SELECT 1;" 2>&1 || true
    echo "[migrate] 跳过迁移，继续启动（非致命）"
    echo "[app] 启动服务器..."
    exec node server.js
  fi

  # 运行迁移 SQL
  echo "[migrate] 执行迁移 SQL..."
  MIGRATE_OUTPUT=$(psql "$DB_URL" -v ON_ERROR_STOP=0 <<'SQL' 2>&1 || true
    -- ============================================
    -- 阶段1: 创建核心表（如不存在）
    -- ============================================

    -- 创建 letsgo_users 表（用户系统）
    CREATE TABLE IF NOT EXISTS letsgo_users (
      id SERIAL PRIMARY KEY,
      nickname VARCHAR(50) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 1000,
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

    -- 创建 letsgo_games 表（如不存在，兼容旧 player_id 列）
    CREATE TABLE IF NOT EXISTS letsgo_games (
      id SERIAL PRIMARY KEY,
      player_id INTEGER,
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

    -- 创建 letsgo_players 表（旧兼容，如不存在）
    CREATE TABLE IF NOT EXISTS letsgo_players (
      id SERIAL PRIMARY KEY,
      nickname VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    -- ============================================
    -- 阶段2: 增量列迁移（幂等）
    -- ============================================

    -- 添加 engine 列（如不存在）
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'letsgo_games' AND column_name = 'engine') THEN
        ALTER TABLE letsgo_games ADD COLUMN engine TEXT DEFAULT 'local';
      END IF;
    END $$;

    -- 添加 user_id 列（如不存在）
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'letsgo_games' AND column_name = 'user_id') THEN
        ALTER TABLE letsgo_games ADD COLUMN user_id INTEGER REFERENCES letsgo_users(id);
      END IF;
    END $$;

    -- player_id 改为可空
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'letsgo_games' AND column_name = 'player_id' AND is_nullable = 'NO') THEN
        ALTER TABLE letsgo_games ALTER COLUMN player_id DROP NOT NULL;
      END IF;
    END $$;

    -- ============================================
    -- 阶段3: 索引创建（幂等）
    -- ============================================

    CREATE INDEX IF NOT EXISTS idx_point_transactions_user_id ON letsgo_point_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_point_transactions_type ON letsgo_point_transactions(type);
    CREATE INDEX IF NOT EXISTS idx_games_user_id ON letsgo_games(user_id);
    CREATE INDEX IF NOT EXISTS idx_games_status ON letsgo_games(status);
    CREATE INDEX IF NOT EXISTS idx_games_created_at ON letsgo_games(created_at);
    CREATE INDEX IF NOT EXISTS idx_users_nickname ON letsgo_users(nickname);

    -- ============================================
    -- 阶段4: 清理旧表和旧列
    -- ============================================

    -- 删除 letsgo_players 外键约束（letsgo_games.player_id 可能引用它）
    DO $$
    DECLARE
      fk_record RECORD;
    BEGIN
      FOR fk_record IN
        SELECT conname, conrelid::regclass AS tbl
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = 'letsgo_games'::regclass
          AND confrelid = 'letsgo_players'::regclass
      LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk_record.tbl, fk_record.conname);
      END LOOP;
    END $$;

    -- 删除 letsgo_games.player_id 列
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'letsgo_games' AND column_name = 'player_id') THEN
        ALTER TABLE letsgo_games DROP COLUMN player_id;
      END IF;
    END $$;

    -- 删除 letsgo_players 表
    DROP TABLE IF EXISTS letsgo_players CASCADE;

    -- ============================================
    -- 阶段5: 启用 RLS + 安全策略
    -- ============================================

    -- 启用 RLS
    ALTER TABLE letsgo_users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE letsgo_point_transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE letsgo_games ENABLE ROW LEVEL SECURITY;

    -- letsgo_users: 仅 service_role 可访问
    DROP POLICY IF EXISTS "service_role_access" ON letsgo_users;
    DROP POLICY IF EXISTS "letsgo_users_service_role" ON letsgo_users;
    CREATE POLICY "letsgo_users_service_role" ON letsgo_users
      FOR ALL USING ((SELECT auth.jwt() ->> 'role'::text) = 'service_role'::text)
      WITH CHECK ((SELECT auth.jwt() ->> 'role'::text) = 'service_role'::text);

    -- letsgo_point_transactions: 仅 service_role 可访问
    DROP POLICY IF EXISTS "service_role_access" ON letsgo_point_transactions;
    DROP POLICY IF EXISTS "letsgo_point_transactions_service_role" ON letsgo_point_transactions;
    CREATE POLICY "letsgo_point_transactions_service_role" ON letsgo_point_transactions
      FOR ALL USING ((SELECT auth.jwt() ->> 'role'::text) = 'service_role'::text)
      WITH CHECK ((SELECT auth.jwt() ->> 'role'::text) = 'service_role'::text);

    -- letsgo_games: 仅 service_role 可访问
    DROP POLICY IF EXISTS "service_role_access" ON letsgo_games;
    DROP POLICY IF EXISTS "anon_readonly" ON letsgo_games;
    DROP POLICY IF EXISTS "letsgo_games_service_role" ON letsgo_games;
    CREATE POLICY "letsgo_games_service_role" ON letsgo_games
      FOR ALL USING ((SELECT auth.jwt() ->> 'role'::text) = 'service_role'::text)
      WITH CHECK ((SELECT auth.jwt() ->> 'role'::text) = 'service_role'::text);

    -- ============================================
    -- 阶段6: 数据迁移
    -- ============================================

    -- 修改默认积分为1000
    ALTER TABLE letsgo_users ALTER COLUMN points SET DEFAULT 1000;

    -- 历史用户积分补偿：给所有现有用户增加1000积分（仅一次）
    UPDATE letsgo_users SET points = points + 1000 WHERE points < 2000;
SQL
  )

  if [ -n "$MIGRATE_OUTPUT" ]; then
    echo "[migrate] 迁移输出:"
    echo "$MIGRATE_OUTPUT" | head -30
  fi
  echo "[migrate] 迁移完成 ✓"
else
  echo "[migrate] 未设置 SUPABASE_DB_URL 或 COZE_SUPABASE_DB_URL，跳过数据库迁移"
  echo "[migrate] 如需自动迁移，请在部署平台设置该环境变量"
fi

# 启动应用
echo "[app] 启动服务器..."
exec node server.js
