import type { Cloud } from "./client.ts";
import { array, CloudShapeError, nonEmptyString, record, timestamp, uuid } from "./parse.ts";

/* Friends' last online time and the friends leaderboard (migration 20260930690000). The web app marks the account
 * online while a tab is in front (qorpera_mark_online); accepted friends read that time on their friends list. The
 * leaderboard (qorpera_friends_leaderboard) compares the account and its accepted friends, and the companies any of
 * them is a member of, in two categories: the busiest (tasks done this week) and the most revenue (all sales so far,
 * without VAT, in øre). A person's figure is the sum over their companies. */

export interface LeaderboardPerson {
	userId: string;
	displayName: string;
	me: boolean;
	lastSeenAt: string | null;
	companies: number;
	/** Tasks the agents of their companies finished this week: runs that saved work. */
	tasks: number;
	lastWeekTasks: number;
	revenueOre: number;
	/** Their busiest company this week, else the one they joined first: its figure stands for them. */
	mainProfileId: string | null;
}

export interface LeaderboardCompany {
	profileId: string;
	name: string;
	/** Board members (the account and its friends) who are members of the company. */
	members: string[];
	tasks: number;
	lastWeekTasks: number;
	revenueOre: number;
}

export interface Leaderboard {
	/** This week's round: Monday 00:00 to the next Monday 00:00, Danish time. */
	since: string;
	until: string;
	/** The ISO week number. */
	week: number;
	/** This account has left its friends' boards; it still sees its own row. */
	hidden: boolean;
	people: LeaderboardPerson[];
	companies: LeaderboardCompany[];
}

function amount(value: unknown, label: string): number {
	const number = typeof value === "string" ? Number(value) : value;
	if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new CloudShapeError(label);
	return number;
}

function optionalTime(value: unknown, label: string): string | null {
	return value === null || value === undefined ? null : timestamp(value, label);
}

export function parseLeaderboard(value: unknown): Leaderboard {
	const input = record(value, "leaderboard");
	if (typeof input.hidden !== "boolean") throw new CloudShapeError("leaderboard hidden");
	return {
		since: timestamp(input.since, "leaderboard since"),
		until: timestamp(input.until, "leaderboard until"),
		week: amount(input.week, "leaderboard week"),
		hidden: input.hidden,
		people: array(input.people, "leaderboard people").map((item) => {
			const row = record(item, "leaderboard person");
			return {
				userId: uuid(row.user_id, "leaderboard person id"),
				displayName: nonEmptyString(row.display_name, "leaderboard person name", 256),
				me: row.me === true,
				lastSeenAt: optionalTime(row.last_seen_at, "leaderboard person last online"),
				companies: amount(row.companies, "leaderboard companies"),
				tasks: amount(row.tasks, "leaderboard tasks"),
				lastWeekTasks: amount(row.last_week_tasks, "leaderboard last week tasks"),
				revenueOre: amount(row.revenue_ore, "leaderboard revenue"),
				mainProfileId: row.main_profile_id == null ? null : uuid(row.main_profile_id, "leaderboard main company"),
			};
		}),
		companies: array(input.companies, "leaderboard companies").map((item) => {
			const row = record(item, "leaderboard company");
			return {
				profileId: uuid(row.profile_id, "leaderboard company id"),
				name: nonEmptyString(row.name, "leaderboard company name", 256),
				members:
					row.members == null
						? []
						: array(row.members, "leaderboard company members").map((id) => uuid(id, "member id")),
				tasks: amount(row.tasks, "leaderboard company tasks"),
				lastWeekTasks: amount(row.last_week_tasks, "leaderboard company last week tasks"),
				revenueOre: amount(row.revenue_ore, "leaderboard company revenue"),
			};
		}),
	};
}

export async function readLeaderboard(cloud: Pick<Cloud, "rpc">): Promise<Leaderboard> {
	return parseLeaderboard(await cloud.rpc("qorpera_friends_leaderboard", {}));
}

export async function setLeaderboardHidden(cloud: Pick<Cloud, "rpc">, hidden: boolean): Promise<void> {
	await cloud.rpc("qorpera_set_leaderboard_hidden", { p_hidden: hidden });
}

export async function markOnline(cloud: Pick<Cloud, "rpc">): Promise<void> {
	await cloud.rpc("qorpera_mark_online", {});
}
