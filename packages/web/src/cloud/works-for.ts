import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, oneOf, record, timestamp, uuid } from "./parse.ts";

/* Who each agent works for (supabase/CLIENT-CONTRACT.md "Who each agent works for", migration
 * 20260930700000_agent_works_for): the Members page's live read, and the ask and answer that move an agent. */

export type LoginState = "ready" | "full" | "sign_in" | "none";

export interface WorksForLogin {
	readonly userId: string;
	readonly state: LoginState;
	/** 0–100 of the login with the most room; null when no fresh reading says. */
	readonly usedPercent: number | null;
	/** When a used-up login resets, when known. */
	readonly resetsAt: string | null;
}

export interface WorksForAsk {
	readonly id: string;
	readonly agentId: string;
	readonly fromUserId: string | null;
	readonly toUserId: string;
	readonly askedByUserId: string | null;
	readonly askedByAgentId: string | null;
	readonly answerByUserId: string;
	readonly createdAt: string;
}

export interface WorksFor {
	readonly mayAsk: boolean;
	readonly mayAskForOthers: boolean;
	/** Each agent but the Co-Founder, with the member it works for (null: nobody). */
	readonly agents: readonly { readonly agentId: string; readonly userId: string | null }[];
	readonly logins: readonly WorksForLogin[];
	readonly asks: readonly WorksForAsk[];
}

const LOGIN_STATES: readonly LoginState[] = ["ready", "full", "sign_in", "none"];
const ASK_STATUSES = ["yes", "no", "withdrawn", "void", "open"] as const;

const nullableUuid = (value: unknown, label: string) =>
	value === null || value === undefined ? null : uuid(value, label);
const nullableTimestamp = (value: unknown, label: string) =>
	value === null || value === undefined ? null : timestamp(value, label);

export function parseWorksFor(value: unknown): WorksFor {
	const input = record(value, "works for");
	if (input.schema !== "qorpera.works-for/v1" || typeof input.may_ask !== "boolean")
		throw new CloudShapeError("works for");
	if (typeof input.may_ask_for_others !== "boolean") throw new CloudShapeError("works for");
	return {
		mayAsk: input.may_ask,
		mayAskForOthers: input.may_ask_for_others,
		agents: array(input.agents, "agents").map((entry) => {
			const item = record(entry, "agent");
			return { agentId: uuid(item.staff_agent_id, "agent"), userId: nullableUuid(item.user_id, "member") };
		}),
		logins: array(input.logins, "logins").map((entry) => {
			const item = record(entry, "login");
			return {
				userId: uuid(item.user_id, "member"),
				state: oneOf(item.state, LOGIN_STATES, "login state"),
				usedPercent:
					item.used_percent === null || item.used_percent === undefined
						? null
						: boundedInteger(item.used_percent, "used", 0, 100),
				resetsAt: nullableTimestamp(item.resets_at, "resets at"),
			};
		}),
		asks: array(input.asks, "asks").map((entry) => {
			const item = record(entry, "ask");
			return {
				id: uuid(item.id, "ask"),
				agentId: uuid(item.staff_agent_id, "agent"),
				fromUserId: nullableUuid(item.from_user_id, "member"),
				toUserId: uuid(item.to_user_id, "member"),
				askedByUserId: nullableUuid(item.asked_by_user_id, "member"),
				askedByAgentId: nullableUuid(item.asked_by_staff_agent_id, "agent"),
				answerByUserId: uuid(item.answer_by_user_id, "member"),
				createdAt: timestamp(item.created_at, "asked at"),
			};
		}),
	};
}

export interface WorksForCalls {
	read(): Promise<WorksFor>;
	/** Asks for the agent to work for the member: moved at once when no one else's yes is needed. */
	ask(agentId: string, toUserId: string): Promise<{ moved: boolean; askId: string | null }>;
	/** Yes or no from the member asked; false from the member who asked withdraws. */
	answer(askId: string, yes: boolean): Promise<{ status: (typeof ASK_STATUSES)[number]; moved: boolean }>;
}

export function worksForCalls(cloud: Cloud, profileId: string): WorksForCalls {
	return {
		read: async () => parseWorksFor(await cloud.rpc("qorpera_read_works_for", { p_profile_id: profileId })),
		ask: async (agentId, toUserId) => {
			const value = record(
				await cloud.rpc("qorpera_ask_works_for", {
					p_profile_id: profileId,
					p_staff_agent_id: agentId,
					p_to_user_id: toUserId,
				}),
				"ask",
			);
			if (typeof value.moved !== "boolean") throw new CloudShapeError("ask");
			return { moved: value.moved, askId: nullableUuid(value.ask_id, "ask") };
		},
		answer: async (askId, yes) => {
			const value = record(await cloud.rpc("qorpera_answer_works_for", { p_ask_id: askId, p_yes: yes }), "answer");
			if (typeof value.moved !== "boolean") throw new CloudShapeError("answer");
			return { status: oneOf(value.status, ASK_STATUSES, "answer"), moved: value.moved };
		},
	};
}
