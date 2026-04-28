import { pgTable, serial, timestamp, index, foreignKey, integer, varchar, jsonb, text, unique } from "drizzle-orm/pg-core"



export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const letsgoGames = pgTable("letsgo_games", {
	id: serial().primaryKey().notNull(),
	boardSize: integer("board_size").default(9).notNull(),
	difficulty: varchar({ length: 20 }).default('easy').notNull(),
	moves: jsonb().default([]).notNull(),
	commentaries: jsonb().default([]).notNull(),
	finalBoard: jsonb("final_board"),
	blackScore: integer("black_score").default(0),
	whiteScore: integer("white_score").default(0),
	status: varchar({ length: 20 }).default('playing').notNull(),
	title: varchar({ length: 200 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	engine: text().default('local'),
	config: jsonb().default({}),
	userId: integer("user_id"),
}, (table) => [
	index("idx_games_user_id").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	index("letsgo_games_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("letsgo_games_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("letsgo_games_user_id_idx").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	foreignKey({
				columns: [table.userId],
				foreignColumns: [letsgoUsers.id],
				name: "letsgo_games_user_id_fkey"
			}),
]);

export const letsgoUsers = pgTable("letsgo_users", {
	id: serial().primaryKey().notNull(),
	nickname: varchar({ length: 50 }).notNull(),
	passwordHash: varchar("password_hash", { length: 255 }).notNull(),
	points: integer().default(2000).notNull(),
	totalGames: integer("total_games").default(0).notNull(),
	wins: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	isAdmin: integer("is_admin").default(0).notNull(),
}, (table) => [
	index("letsgo_users_nickname_idx").using("btree", table.nickname.asc().nullsLast().op("text_ops")),
	unique("letsgo_users_nickname_key").on(table.nickname),
]);

export const letsgoPointTransactions = pgTable("letsgo_point_transactions", {
	id: serial().primaryKey().notNull(),
	userId: integer("user_id").notNull(),
	amount: integer().notNull(),
	type: varchar({ length: 20 }).notNull(),
	description: text(),
	gameId: integer("game_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_point_transactions_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
	index("idx_point_transactions_user_id").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	index("letsgo_point_transactions_user_id_idx").using("btree", table.userId.asc().nullsLast().op("int4_ops")),
	foreignKey({
				columns: [table.userId],
				foreignColumns: [letsgoUsers.id],
				name: "letsgo_point_transactions_user_id_fkey"
			}),
]);
