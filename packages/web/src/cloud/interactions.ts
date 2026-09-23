import type { JsonValue } from "./types.ts";

/* Thread interactions (kernel bundle v70, runtime v71): an agent raises a typed
 * card in its thread as an `interaction_request` event; the member answers
 * through `qorpera_answer_interaction`, which queues an input the kernel later
 * materializes as an `interaction_answer` event. This module is the closed
 * vocabulary the web renders. Anything outside it is shown as "a card this
 * version cannot show", never guessed and never rendered from agent text. */

export const INTERACTION_SCHEMA = "qorpera.interaction/v1";
export const INTERACTION_ANSWER_SCHEMA = "qorpera.interaction-answer/v1";

export const INTERACTION_SURFACES = ["question", "secret", "form", "takeover", "draft", "credential"] as const;
export type InteractionSurface = (typeof INTERACTION_SURFACES)[number];

export interface QuestionOption {
	label: string;
	value: string;
	description?: string;
	style?: "default" | "primary" | "danger";
}

export interface InteractionRequest {
	surface: InteractionSurface;
	title: string;
	body?: string;
	expiresAt?: string;
	/** The surface's own payload, closed by the kernel; read per surface. */
	payload: Record<string, JsonValue>;
}

export type InteractionOutcome =
	| "answered"
	| "declined"
	| "provided"
	| "handed_back"
	| "dismissed"
	| "sent"
	| "discarded"
	| "approved";

export interface InteractionAnswer {
	outcome: InteractionOutcome;
	answer: Record<string, JsonValue>;
	answeredBy?: string;
	answeredAt?: string;
	/** True until the kernel has written the answer to the transcript. */
	pending?: boolean;
}

export const OUTCOMES: Record<InteractionSurface, readonly InteractionOutcome[]> = {
	question: ["answered", "declined"],
	secret: ["provided", "declined"],
	form: ["answered", "declined"],
	takeover: ["handed_back", "dismissed"],
	draft: ["sent", "discarded"],
	credential: [],
};

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, JsonValue>)
		: undefined;
}

/** The request data out of a runner custom entry (`body.entry.data`), or undefined
 * when it is not a card this version renders. */
export function parseInteractionRequest(body: JsonValue): InteractionRequest | undefined {
	const entry = asRecord(asRecord(body)?.entry);
	const data = asRecord(entry?.data);
	if (
		!data ||
		entry?.type !== "custom" ||
		entry.customType !== "interaction_request" ||
		data.schema !== INTERACTION_SCHEMA ||
		typeof data.surface !== "string" ||
		!(INTERACTION_SURFACES as readonly string[]).includes(data.surface) ||
		typeof data.title !== "string" ||
		!data.title.trim()
	)
		return undefined;
	const payload = asRecord(data.payload);
	if (!payload) return undefined;
	return {
		surface: data.surface as InteractionSurface,
		title: data.title,
		...(typeof data.body === "string" && data.body.trim() ? { body: data.body } : {}),
		...(typeof data.expiresAt === "string" && Number.isFinite(Date.parse(data.expiresAt))
			? { expiresAt: data.expiresAt }
			: {}),
		payload,
	};
}

function answerFrom(data: Record<string, JsonValue> | undefined): Omit<InteractionAnswer, "pending"> | undefined {
	if (!data || typeof data.outcome !== "string") return undefined;
	const outcomes = new Set<string>([...Object.values(OUTCOMES).flat(), "approved", "declined"]);
	if (!outcomes.has(data.outcome)) return undefined;
	return {
		outcome: data.outcome as InteractionOutcome,
		answer: asRecord(data.answer) ?? {},
		...(typeof data.answeredBy === "string" ? { answeredBy: data.answeredBy } : {}),
	};
}

/** The interaction id and answer out of a materialized `interaction_answer`
 * (or `authorization_decision`) event body. */
export function parseInteractionAnswerEvent(
	body: JsonValue,
): { interactionId: string; answer: Omit<InteractionAnswer, "pending"> } | undefined {
	const entry = asRecord(asRecord(body)?.entry);
	const data = asRecord(entry?.data);
	if (!data || entry?.type !== "custom" || data.schema !== INTERACTION_ANSWER_SCHEMA) return undefined;
	const interactionId = typeof data.interactionId === "string" ? data.interactionId.toLowerCase() : undefined;
	const answer = answerFrom(data);
	return interactionId && answer ? { interactionId, answer } : undefined;
}

/** The same out of a queued answer input (`qorpera.interaction-answer/v1`). */
export function parseInteractionAnswerInput(
	body: JsonValue,
): { interactionId: string; answer: Omit<InteractionAnswer, "pending"> } | undefined {
	const data = asRecord(body);
	if (!data || data.schema !== INTERACTION_ANSWER_SCHEMA) return undefined;
	const interactionId = typeof data.interactionId === "string" ? data.interactionId.toLowerCase() : undefined;
	const answer = answerFrom(data);
	return interactionId && answer ? { interactionId, answer } : undefined;
}

/** The options of a question card, in the shape the kernel accepted. */
export function questionOptions(request: InteractionRequest): QuestionOption[] {
	if (request.surface !== "question" || !Array.isArray(request.payload.options)) return [];
	const options: QuestionOption[] = [];
	for (const candidate of request.payload.options) {
		const option = asRecord(candidate);
		if (!option || typeof option.label !== "string") continue;
		options.push({
			label: option.label,
			value: typeof option.value === "string" ? option.value : option.label,
			...(typeof option.description === "string" ? { description: option.description } : {}),
			...(option.style === "primary" || option.style === "danger" ? { style: option.style } : {}),
		});
	}
	return options;
}

export type InteractionState = "waiting" | "answered" | "declined" | "expired";

/** What the card shows: still open, answered in some way, declined, or past its time. */
export function interactionState(
	request: InteractionRequest,
	answer: InteractionAnswer | undefined,
	now = Date.now(),
): InteractionState {
	if (answer) return ["declined", "dismissed", "discarded"].includes(answer.outcome) ? "declined" : "answered";
	if (request.expiresAt && Date.parse(request.expiresAt) <= now) return "expired";
	return "waiting";
}

/** The plain words on an answered card. */
export function describeAnswer(request: InteractionRequest, answer: InteractionAnswer): string {
	switch (answer.outcome) {
		case "answered": {
			if (request.surface === "question") {
				const values = Array.isArray(answer.answer.values)
					? answer.answer.values.filter((value): value is string => typeof value === "string")
					: [];
				const labels = new Map(questionOptions(request).map((option) => [option.value, option.label]));
				return values.map((value) => labels.get(value) ?? value).join(", ") || "Answered";
			}
			return "Filled in";
		}
		case "provided":
			return "Saved to the company vault";
		case "handed_back":
			return "Handed back";
		case "sent":
			return "Sent";
		case "approved":
			return "Approved";
		case "declined":
			return "Declined";
		case "dismissed":
			return "Skipped";
		case "discarded":
			return "Discarded";
	}
}
