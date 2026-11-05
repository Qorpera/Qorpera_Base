import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, record, timestamp, uuid } from "./parse.ts";
import type { JsonValue } from "./types.ts";

/**
 * Auto-review rules and approval cards (kernel bundle v130; CLIENT-CONTRACT.md
 * §2 "Auto-review rules and approvals"). A rule is one sentence, "When an agent
 * wants to …, it should: Ask first | Allow automatically", written by a member
 * for themself or, by an owner or admin, for the whole company. Before an
 * agent's acting call runs, the runtime reviews it against the rules; an ask
 * raises an approval card (an authorization_request whose data carries
 * `schema: qorpera.action-review/v1`) that the member it waits for answers.
 */

export type ReviewRuleScope = "company" | "member";
export type ReviewRuleOutcome = "ask_first" | "allow_automatically";

export interface HostedReviewRule {
	id: string;
	scope: ReviewRuleScope;
	memberUserId: string | null;
	when: string;
	outcome: ReviewRuleOutcome;
	createdVia: "settings" | "card" | "agent" | "folder";
	createdAt: string;
	updatedAt: string;
}

export interface HostedReviewRules {
	/** Owners and admins write the company's rules; everyone reads them. */
	canManageCompanyRules: boolean;
	/** The company's rules, then the member's own. */
	rules: HostedReviewRule[];
}

export interface WebReviewRules {
	list(): Promise<HostedReviewRules>;
	save(input: {
		id: string;
		scope: ReviewRuleScope;
		when: string;
		outcome: ReviewRuleOutcome;
	}): Promise<HostedReviewRule>;
	archive(id: string): Promise<void>;
}

/** A rule sentence as the kernel keeps it: 1-280 characters after trimming. */
export const REVIEW_RULE_MAX_LENGTH = 280;

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} is invalid.`);
	return value;
}

export function parseReviewRule(value: unknown): HostedReviewRule {
	const rule = object(value, "Rule");
	const scope = text(rule.scope, "Rule scope");
	const outcome = text(rule.outcome, "Rule outcome");
	const createdVia = text(rule.createdVia, "Rule origin");
	if (
		(scope !== "company" && scope !== "member") ||
		(outcome !== "ask_first" && outcome !== "allow_automatically") ||
		!["settings", "card", "agent", "folder"].includes(createdVia)
	)
		throw new Error("Rule is invalid.");
	return {
		id: text(rule.id, "Rule id"),
		scope,
		memberUserId: typeof rule.memberUserId === "string" ? rule.memberUserId : null,
		when: text(rule.when, "Rule text"),
		outcome,
		createdVia: createdVia as HostedReviewRule["createdVia"],
		createdAt: text(rule.createdAt, "Rule time"),
		updatedAt: text(rule.updatedAt, "Rule time"),
	};
}

export function parseReviewRules(value: unknown): HostedReviewRules {
	const body = object(value, "Rules");
	if (body.schema !== "qorpera.review-rules/v1" || !Array.isArray(body.rules)) throw new Error("Rules are invalid.");
	return { canManageCompanyRules: body.canManageCompanyRules === true, rules: body.rules.map(parseReviewRule) };
}

export function createWebReviewRules(cloud: Pick<Cloud, "rpc">, profileId: string): WebReviewRules {
	return {
		list: async () => parseReviewRules(await cloud.rpc("qorpera_list_review_rules", { p_profile_id: profileId })),
		save: async (input) =>
			parseReviewRule(
				await cloud.rpc("qorpera_save_review_rule", {
					p_profile_id: profileId,
					p_rule_id: input.id,
					p_scope: input.scope,
					p_when: input.when,
					p_outcome: input.outcome,
				}),
			),
		archive: async (id) => {
			await cloud.rpc("qorpera_archive_review_rule", { p_profile_id: profileId, p_rule_id: id });
		},
	};
}

export const ACTION_REVIEW_SCHEMA = "qorpera.action-review/v1";
export type ActionReviewAnswer = "allow_once" | "always_allow" | "deny";

export interface ActionReviewCard {
	reviewId: string;
	title: string;
	/** The reviewer's reason, one plain sentence. */
	summary: string;
	target?: string;
	details: Array<[string, string]>;
	/** The exact call, so a member sees precisely what would run. */
	tool?: string;
	arguments?: string;
	builtIn: string;
	rules: Array<{ id: string; scope: ReviewRuleScope; when: string; outcome: ReviewRuleOutcome }>;
	approverScope: "member" | "owners_admins";
	approverUserId?: string;
	approverName?: string;
	alwaysAllow: boolean;
	proposedRule?: string;
}

const optional = (value: JsonValue | undefined) => (typeof value === "string" && value ? value : undefined);

/** The facts of an approval card, from its request event's `entry.data`; undefined for any other approval. */
export function actionReviewCard(data: Record<string, JsonValue>): ActionReviewCard | undefined {
	if (data.schema !== ACTION_REVIEW_SCHEMA || typeof data.reviewId !== "string") return undefined;
	if (data.approverScope !== "member" && data.approverScope !== "owners_admins") return undefined;
	const details =
		data.details && typeof data.details === "object" && !Array.isArray(data.details)
			? Object.entries(data.details).flatMap(
					([key, value]): Array<[string, string]> => (typeof value === "string" ? [[key, value]] : []),
				)
			: [];
	const rules: ActionReviewCard["rules"] = Array.isArray(data.rules)
		? data.rules.flatMap((value): ActionReviewCard["rules"] => {
				if (!value || typeof value !== "object" || Array.isArray(value)) return [];
				const { id, scope, when, outcome } = value;
				return typeof id === "string" &&
					(scope === "company" || scope === "member") &&
					typeof when === "string" &&
					(outcome === "ask_first" || outcome === "allow_automatically")
					? [{ id, scope, when, outcome }]
					: [];
			})
		: [];
	return {
		reviewId: data.reviewId.toLowerCase(),
		title: optional(data.title) ?? "",
		summary: optional(data.summary) ?? "",
		target: optional(data.target),
		details,
		tool: optional(data.tool),
		arguments: optional(data.arguments),
		builtIn: optional(data.builtIn) ?? "none",
		rules,
		approverScope: data.approverScope,
		approverUserId: optional(data.approverUserId),
		approverName: optional(data.approverName),
		alwaysAllow: data.alwaysAllow === true,
		proposedRule: optional(data.proposedRule),
	};
}

/** Whether this member answers the card, as qorpera_answer_action_review checks it. */
export function answersActionReview(card: ActionReviewCard, userId: string, role: string): boolean {
	return card.approverScope === "member" ? card.approverUserId === userId : role === "owner" || role === "admin";
}

/** Approval cards that wait for the signed-in member's answer, by agent and conversation
 * (migration 20260930568000): their own, and the company's for an owner or admin. */
export interface WaitingApproval {
	staffAgentId: string;
	sessionId: string;
	count: number;
	latestAt: string;
}

export async function listWaitingApprovals(cloud: Cloud, profileId: string): Promise<WaitingApproval[]> {
	const input = record(
		await cloud.rpc("qorpera_list_member_waiting_approvals", { p_profile_id: profileId }),
		"waiting approvals",
	);
	if (input.schema !== "qorpera.member-waiting-approvals/v1") throw new CloudShapeError("waiting approvals");
	return array(input.approvals, "waiting approvals").map((value) => {
		const item = record(value, "waiting approval");
		return {
			staffAgentId: uuid(item.staffAgentId, "waiting approval agent"),
			sessionId: uuid(item.sessionId, "waiting approval conversation"),
			count: boundedInteger(item.count, "waiting approval count", 1, 1_000_000),
			latestAt: timestamp(item.latestAt, "waiting approval time"),
		};
	});
}

export interface ActionReviewReceipt {
	reviewId: string;
	answer: ActionReviewAnswer;
	inputId: string;
	savedRuleId: string | null;
	woke: boolean;
}

export function parseActionReviewReceipt(value: unknown): ActionReviewReceipt {
	const receipt = object(value, "Approval receipt");
	const answer = text(receipt.answer, "Approval answer");
	if (!["allow_once", "always_allow", "deny"].includes(answer)) throw new Error("Approval receipt is invalid.");
	return {
		reviewId: text(receipt.reviewId, "Approval id"),
		answer: answer as ActionReviewAnswer,
		inputId: text(receipt.inputId, "Approval input"),
		savedRuleId: typeof receipt.savedRuleId === "string" ? receipt.savedRuleId : null,
		woke: receipt.woke === true,
	};
}
