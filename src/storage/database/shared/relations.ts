import { relations } from "drizzle-orm/relations";
import { letsgoUsers, letsgoGames, letsgoPointTransactions } from "./schema";

export const letsgoGamesRelations = relations(letsgoGames, ({one}) => ({
	letsgoUser: one(letsgoUsers, {
		fields: [letsgoGames.userId],
		references: [letsgoUsers.id]
	}),
}));

export const letsgoUsersRelations = relations(letsgoUsers, ({many}) => ({
	letsgoGames: many(letsgoGames),
	letsgoPointTransactions: many(letsgoPointTransactions),
}));

export const letsgoPointTransactionsRelations = relations(letsgoPointTransactions, ({one}) => ({
	letsgoUser: one(letsgoUsers, {
		fields: [letsgoPointTransactions.userId],
		references: [letsgoUsers.id]
	}),
}));