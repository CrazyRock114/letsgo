import { sql } from "drizzle-orm";
import { pgTable, serial, varchar, timestamp, integer, jsonb, text, index } from "drizzle-orm/pg-core";

// 系统表 - 禁止删除
export const healthCheck = pgTable("health_check", {
  id: serial().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 用户表 - 含认证和积分
export const letsgoUsers = pgTable(
  "letsgo_users",
  {
    id: serial().primaryKey(),
    nickname: varchar("nickname", { length: 50 }).notNull().unique(),
    password_hash: varchar("password_hash", { length: 255 }).notNull(),
    points: integer("points").notNull().default(100),
    total_games: integer("total_games").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("letsgo_users_nickname_idx").on(table.nickname),
  ]
);

// 积分流水表
export const letsgoPointTransactions = pgTable(
  "letsgo_point_transactions",
  {
    id: serial().primaryKey(),
    user_id: integer("user_id").notNull().references(() => letsgoUsers.id),
    amount: integer("amount").notNull(), // 正数=获得, 负数=消耗
    type: varchar("type", { length: 20 }).notNull(), // 'earn', 'spend'
    description: text("description"),
    game_id: integer("game_id"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("letsgo_point_transactions_user_id_idx").on(table.user_id),
    index("letsgo_point_transactions_created_at_idx").on(table.created_at),
  ]
);

// 旧玩家表（向后兼容）
export const letsgoPlayers = pgTable(
  "letsgo_players",
  {
    id: serial().primaryKey(),
    nickname: varchar("nickname", { length: 50 }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("letsgo_players_nickname_idx").on(table.nickname),
  ]
);

// 棋局表 - 保存完整棋局信息
export const letsgoGames = pgTable(
  "letsgo_games",
  {
    id: serial().primaryKey(),
    user_id: integer("user_id").references(() => letsgoUsers.id),
    player_id: integer("player_id"), // 旧字段，向后兼容
    board_size: integer("board_size").notNull().default(9),
    difficulty: varchar("difficulty", { length: 20 }).notNull().default("easy"),
    engine: text("engine").default("local"),
    moves: jsonb("moves").notNull().default(sql`'[]'::jsonb`),
    commentaries: jsonb("commentaries").notNull().default(sql`'[]'::jsonb`),
    final_board: jsonb("final_board"),
    black_score: integer("black_score").default(0),
    white_score: integer("white_score").default(0),
    status: varchar("status", { length: 20 }).notNull().default("playing"),
    title: varchar("title", { length: 200 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("letsgo_games_user_id_idx").on(table.user_id),
    index("letsgo_games_player_id_idx").on(table.player_id),
    index("letsgo_games_status_idx").on(table.status),
    index("letsgo_games_created_at_idx").on(table.created_at),
  ]
);
