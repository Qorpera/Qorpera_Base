import type { Cloud } from "./client.ts";
import { type InteractionRequest, parseInteractionRequest } from "./interactions.ts";
import { array, boundedInteger, CloudShapeError, cloudRecord, cloudUuid, jsonValue, timestamp } from "./parse.ts";

/* The question cards waiting for the signed-in member in the company's agent threads (migration 20260930706000): those
 * raised for them, not answered and not past their time, newest first. The web draws the ones that point at an
 * interface app on the app's page and in the Concepts viewer (app/open-questions.ts), and answers them as the thread
 * does. */

export const OPEN_QUESTIONS_SCHEMA = "qorpera.open-questions/v1";

export interface OpenQuestion {
	sessionId: string;
	interactionId: string;
	sequence: number;
	/** Whom the card was raised for: the signed-in member. */
	actorUserId: string;
	/** The agent whose thread it is. */
	staffAgentId: string;
	request: InteractionRequest;
	createdAt: string;
}

/** The list as the cloud gives it, without a card this version can't show (a body it can't read, or no question). */
export function parseOpenQuestions(value: unknown): OpenQuestion[] {
	const input = cloudRecord(value, "open questions");
	if (input.schema !== OPEN_QUESTIONS_SCHEMA) throw new CloudShapeError("open questions");
	return array(input.questions, "open questions").flatMap((value): OpenQuestion[] => {
		const item = cloudRecord(value, "open question");
		const request = parseInteractionRequest(jsonValue(item.body));
		if (request?.surface !== "question") return [];
		return [
			{
				sessionId: cloudUuid(item.sessionId, "open question conversation"),
				interactionId: cloudUuid(item.interactionId, "open question id").toLowerCase(),
				sequence: boundedInteger(item.sequence, "open question sequence", 1, Number.MAX_SAFE_INTEGER),
				actorUserId: cloudUuid(item.actorUserId, "open question member"),
				staffAgentId: cloudUuid(item.staffAgentId, "open question agent"),
				request,
				createdAt: timestamp(item.createdAt, "open question time"),
			},
		];
	});
}

export async function listOpenQuestions(cloud: Cloud, profileId: string): Promise<OpenQuestion[]> {
	return parseOpenQuestions(await cloud.rpc("qorpera_list_member_open_questions", { p_profile_id: profileId }));
}
