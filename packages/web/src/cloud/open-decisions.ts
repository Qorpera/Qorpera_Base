import type { Cloud } from "./client.ts";
import { parseInteractionRequest } from "./interactions.ts";
import type { OpenQuestion } from "./open-questions.ts";
import { array, boundedInteger, CloudShapeError, jsonValue, record, timestamp, uuid } from "./parse.ts";
import { type ActionReviewCard, actionReviewCard } from "./review-rules.ts";
import type { JsonValue } from "./types.ts";

export const OPEN_DECISIONS_SCHEMA = "qorpera.member-open-decisions/v1";

export interface OpenCard extends OpenQuestion {
	kind: "question";
}

export interface OpenApproval {
	kind: "approval";
	sessionId: string;
	interactionId: string;
	staffAgentId: string;
	review: ActionReviewCard;
	createdAt: string;
}

export type OpenDecision = OpenCard | OpenApproval;

export function asOpenCards(questions: readonly OpenQuestion[]): OpenCard[] {
	return questions.map((question) => ({ ...question, kind: "question" }));
}

export function decisionTitle(decision: OpenDecision): string {
	return decision.kind === "approval" ? decision.review.title : decision.request.title;
}

export function parseOpenDecisions(value: unknown): OpenDecision[] {
	const input = record(value, "open decisions");
	if (input.schema !== OPEN_DECISIONS_SCHEMA) throw new CloudShapeError("open decisions");
	return array(input.decisions, "open decisions").flatMap((value): OpenDecision[] => {
		const item = record(value, "open decision");
		const shared = {
			sessionId: uuid(item.sessionId, "open decision conversation"),
			interactionId: uuid(item.id, "open decision id").toLowerCase(),
			staffAgentId: uuid(item.staffAgentId, "open decision agent"),
			createdAt: timestamp(item.createdAt, "open decision time"),
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
		if (item.kind !== "question") return [];
		const request = parseInteractionRequest(jsonValue(item.body));
		if (request?.surface !== "question") return [];
		return [
			{
				kind: "question",
				...shared,
				sequence: boundedInteger(item.sequence, "open decision sequence", 1, Number.MAX_SAFE_INTEGER),
				actorUserId: uuid(item.answererUserId, "open decision member"),
				request,
			},
		];
	});
}

export async function listOpenDecisions(cloud: Cloud, profileId: string): Promise<OpenDecision[]> {
	return parseOpenDecisions(await cloud.rpc("qorpera_list_member_open_decisions", { p_profile_id: profileId }));
}
