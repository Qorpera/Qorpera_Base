import type { Cloud } from "./client.ts";
import { isGmailDraft, parseInteractionRequest } from "./interactions.ts";
import type { OpenQuestion } from "./open-questions.ts";
import { array, boundedInteger, CloudShapeError, jsonValue, record, timestamp, uuid } from "./parse.ts";
import { type ActionReviewCard, actionReviewCard } from "./review-rules.ts";
import type { JsonValue } from "./types.ts";

export const OPEN_DECISIONS_SCHEMA = "qorpera.member-open-decisions/v1";
export const COMPANY_OPEN_DECISIONS_SCHEMA = "qorpera.company-open-decisions/v1";

export interface DecisionVote {
	userId: string;
	choice?: string;
	note?: string;
	updatedAt: string;
}

interface CompanyStanding {
	othersAnswer?: true;
	votes?: readonly DecisionVote[];
}

export interface OpenCard extends OpenQuestion, CompanyStanding {
	kind: "question";
}

export interface OpenDraft extends OpenQuestion, CompanyStanding {
	kind: "draft";
}

export interface OpenApproval extends CompanyStanding {
	kind: "approval";
	sessionId: string;
	interactionId: string;
	staffAgentId: string;
	review: ActionReviewCard;
	createdAt: string;
}

export type OpenDecision = OpenCard | OpenDraft | OpenApproval;

export function asOpenCards(questions: readonly OpenQuestion[]): OpenCard[] {
	return questions.map((question) => ({ ...question, kind: "question" }));
}

export function decisionTitle(decision: OpenDecision): string {
	return decision.kind === "approval" ? decision.review.title : decision.request.title;
}

function parseVotes(value: unknown): DecisionVote[] {
	return array(value, "decision votes").flatMap((entry): DecisionVote[] => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const vote = entry as Record<string, unknown>;
		if (typeof vote.userId !== "string" || typeof vote.updatedAt !== "string") return [];
		const choice = typeof vote.choice === "string" && vote.choice ? vote.choice : undefined;
		const note = typeof vote.note === "string" && vote.note.trim() ? vote.note : undefined;
		try {
			return [
				{
					userId: uuid(vote.userId, "decision vote member"),
					...(choice === undefined ? {} : { choice }),
					...(note === undefined ? {} : { note }),
					updatedAt: timestamp(vote.updatedAt, "decision vote time"),
				},
			];
		} catch {
			return [];
		}
	});
}

export function parseOpenDecisions(value: unknown): OpenDecision[] {
	const input = record(value, "open decisions");
	const company = input.schema === COMPANY_OPEN_DECISIONS_SCHEMA;
	if (!company && input.schema !== OPEN_DECISIONS_SCHEMA) throw new CloudShapeError("open decisions");
	return array(input.decisions, "open decisions").flatMap((value): OpenDecision[] => {
		const item = record(value, "open decision");
		const shared = {
			sessionId: uuid(item.sessionId, "open decision conversation"),
			interactionId: uuid(item.id, "open decision id").toLowerCase(),
			staffAgentId: uuid(item.staffAgentId, "open decision agent"),
			createdAt: timestamp(item.createdAt, "open decision time"),
			...(company && item.canAnswer !== true ? { othersAnswer: true as const } : {}),
			...(company ? { votes: parseVotes(item.votes) } : {}),
		};
		if (item.kind === "approval") {
			const data = jsonValue(item.review);
			const review =
				data && typeof data === "object" && !Array.isArray(data)
					? actionReviewCard(data as Record<string, JsonValue>)
					: undefined;
			return review && review.reviewId.toLowerCase() === shared.interactionId
				? [{ kind: "approval", ...shared, review }]
				: [];
		}
		const kind = item.kind;
		if (kind !== "question" && kind !== "draft") return [];
		const request = parseInteractionRequest(jsonValue(item.body));
		if (request?.surface !== kind || (kind === "draft" && !isGmailDraft(request))) return [];
		return [
			{
				kind,
				...shared,
				sequence: boundedInteger(item.sequence, "open decision sequence", 1, Number.MAX_SAFE_INTEGER),
				actorUserId: uuid(item.answererUserId, "open decision member"),
				request,
			},
		];
	});
}

export async function listCompanyOpenDecisions(cloud: Cloud, profileId: string): Promise<OpenDecision[]> {
	return parseOpenDecisions(await cloud.rpc("qorpera_list_company_open_decisions", { p_profile_id: profileId }));
}

export async function castDecisionVote(
	cloud: Cloud,
	profileId: string,
	itemId: string,
	choice: string | undefined,
	note: string | undefined,
): Promise<void> {
	await cloud.rpc("qorpera_cast_decision_vote", {
		p_profile_id: profileId,
		p_item_id: itemId,
		p_choice: choice ?? null,
		p_note: note ?? null,
	});
}

export async function listOpenDecisions(cloud: Cloud, profileId: string): Promise<OpenDecision[]> {
	return parseOpenDecisions(await cloud.rpc("qorpera_list_member_open_decisions", { p_profile_id: profileId }));
}
