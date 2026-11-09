import type { Cloud } from "./client.ts";
import { array, CloudShapeError, nonEmptyString, record, timestamp, uuid } from "./parse.ts";

/* Friends' last online time and the friends leaderboard (migration 20260930690000). The web app marks the account
 * online while a tab is in front (qorpera_mark_online); accepted friends read that time on their friends list. The
 * leaderboard (qorpera_friends_leaderboard) compares the account and its accepted friends, their companies, and the
 * agents of those companies over the last 7 or 30 days. Sales are øre. */

export const LEADERBOARD_DAYS = [7, 30] as const;
export type LeaderboardDays = (typeof LEADERBOARD_DAYS)[number];

export interface LeaderboardPerson {
	userId: string;
	displayName: string;
	me: boolean;
	lastSeenAt: string | null;
	activeDays: number;
	messages: number;
	companies: number;
	agents: number;
	agentRuns: number;
	agentHours: number;
	salesOre: number;
}

export interface LeaderboardCompany {
	profileId: string;
	name: string;
	/** Board members (the account and its friends) who are members of the company. */
	members: string[];
	agents: number;
	agentRuns: number;
	agentHours: number;
	salesOre: number;
}

export interface LeaderboardAgent {
	profileId: string;
	staffAgentId: string;
	displayName: string;
	role: string;
	appearance: { color: string; shape: string };
	templateId: string | undefined;
	companyName: string;
	runs: number;
	finished: number;
	/** Finished runs that saved work to the company (published or sent for review). */
	saved: number;
}

export interface Leaderboard {
	days: LeaderboardDays;
	since: string;
	/** This account has left its friends' boards; it still sees its own row. */
	hidden: boolean;
	people: LeaderboardPerson[];
	companies: LeaderboardCompany[];
	agents: LeaderboardAgent[];
}

function amount(value: unknown, label: string): number {
	const number = typeof value === "string" ? Number(value) : value;
	if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new CloudShapeError(label);
	return number;
}

function optionalTime(value: unknown, label: string): string | null {
	return value === null || value === undefined ? null : timestamp(value, label);
}

function text(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function parseLeaderboard(value: unknown): Leaderboard {
	const input = record(value, "leaderboard");
	const days = input.days === 30 ? 30 : input.days === 7 ? 7 : undefined;
	if (!days) throw new CloudShapeError("leaderboard days");
	if (typeof input.hidden !== "boolean") throw new CloudShapeError("leaderboard hidden");
	return {
		days,
		since: timestamp(input.since, "leaderboard since"),
		hidden: input.hidden,
		people: array(input.people, "leaderboard people").map((item) => {
			const row = record(item, "leaderboard person");
			return {
				userId: uuid(row.user_id, "leaderboard person id"),
				displayName: nonEmptyString(row.display_name, "leaderboard person name", 256),
				me: row.me === true,
				lastSeenAt: optionalTime(row.last_seen_at, "leaderboard person last online"),
				activeDays: amount(row.active_days, "leaderboard active days"),
				messages: amount(row.messages, "leaderboard messages"),
				companies: amount(row.companies, "leaderboard companies"),
				agents: amount(row.agents, "leaderboard agents"),
				agentRuns: amount(row.agent_runs, "leaderboard agent runs"),
				agentHours: amount(row.agent_hours, "leaderboard agent hours"),
				salesOre: amount(row.sales_ore, "leaderboard sales"),
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
				agents: amount(row.agents, "leaderboard company agents"),
				agentRuns: amount(row.agent_runs, "leaderboard company agent runs"),
				agentHours: amount(row.agent_hours, "leaderboard company agent hours"),
				salesOre: amount(row.sales_ore, "leaderboard company sales"),
			};
		}),
		agents: array(input.agents, "leaderboard agents").map((item) => {
			const row = record(item, "leaderboard agent");
			const templateId = text(row.template_id);
			return {
				profileId: uuid(row.profile_id, "leaderboard agent company id"),
				staffAgentId: uuid(row.staff_agent_id, "leaderboard agent id"),
				displayName: nonEmptyString(row.display_name, "leaderboard agent name", 256),
				role: text(row.role),
				appearance: { color: text(row.appearance_color), shape: text(row.appearance_shape) },
				templateId: templateId || undefined,
				companyName: nonEmptyString(row.company_name, "leaderboard agent company", 256),
				runs: amount(row.runs, "leaderboard agent runs"),
				finished: amount(row.finished, "leaderboard agent finished"),
				saved: amount(row.saved, "leaderboard agent saved"),
			};
		}),
	};
}

export async function readLeaderboard(cloud: Pick<Cloud, "rpc">, days: LeaderboardDays): Promise<Leaderboard> {
	return parseLeaderboard(await cloud.rpc("qorpera_friends_leaderboard", { p_days: days }));
}

export async function setLeaderboardHidden(cloud: Pick<Cloud, "rpc">, hidden: boolean): Promise<void> {
	await cloud.rpc("qorpera_set_leaderboard_hidden", { p_hidden: hidden });
}

export async function markOnline(cloud: Pick<Cloud, "rpc">): Promise<void> {
	await cloud.rpc("qorpera_mark_online", {});
}
