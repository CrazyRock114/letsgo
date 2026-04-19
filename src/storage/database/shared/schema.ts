import { sql } from "drizzle-orm";
import { pgTable, serial, varchar, timestamp, integer, jsonb, text, index } from "drizzle-orm/pg-core";

// 系统表 - 禁止删除
export const healthCheck = pgTable("health_check", {
  id: serial().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 用户表 - 用昵称简单标识（无Auth，场景A）
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
    player_id: integer("player_id").notNull().references(() => letsgoPlayers.id),
    board_size: integer("board_size").notNull().default(9),
    difficulty: varchar("difficulty", { length: 20 }).notNull().default("easy"),
    engine: text("engine").default("local"),
    // 完整的落子历史：[{position:{row,col}, color, captured}]
    moves: jsonb("moves").notNull().default(sql`'[]'::jsonb`),
    // 每步解说：[{moveIndex, color, commentary}]
    commentaries: jsonb("commentaries").notNull().default(sql`'[]'::jsonb`),
    // 最终棋盘状态
    final_board: jsonb("final_board"),
    // 比分
    black_score: integer("black_score").default(0),
    white_score: integer("white_score").default(0),
    // 状态：playing / finished
    status: varchar("status", { length: 20 }).notNull().default("playing"),
    // 棋局名称
    title: varchar("title", { length: 200 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("letsgo_games_player_id_idx").on(table.player_id),
    index("letsgo_games_status_idx").on(table.status),
    index("letsgo_games_created_at_idx").on(table.created_at),
  ]
);
