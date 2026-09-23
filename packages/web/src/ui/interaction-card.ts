import {
	describeAnswer,
	type InteractionAnswer,
	type InteractionOutcome,
	type InteractionRequest,
	interactionState,
	questionOptions,
} from "../cloud/interactions.ts";
import type { JsonValue } from "../cloud/types.ts";
import { badge, button, fmtTime, h, icon } from "./dom.ts";

/* Cards an agent raises in its thread (THREAD-WIDGETS-DESIGN-20260922.md).
 * One shell for every surface: a quiet header with the agent's name, the
 * title, a state badge; the body per surface; pills at the foot, primary on
 * the left, Skip on the right, as the failed-run line does it. Once answered a
 * card stays in the thread, inert, showing what was chosen. A secret card never
 * has an input here: the value goes to the vault through the broker, which
 * this version does not have yet, so it can only be declined. */

export interface InteractionCardContext {
	agentName: string;
	memberName: (userId: string | undefined) => string;
	/** Whether this member may answer (the thread's own member, with write access). */
	canAnswer: boolean;
	/** Sends the outcome and answer; the card shows its busy state until it resolves. */
	answer: (outcome: InteractionOutcome, answer: Record<string, JsonValue>) => Promise<void>;
	/** Opens the agent's computer for a takeover; absent when the thread has none. */
	takeOver?: () => void;
	now?: number;
}

export interface InteractionCardItem {
	id: string;
	actorUserId: string;
	request: InteractionRequest;
	answer?: InteractionAnswer;
	createdAt: string;
}

const STATE_LABEL = {
	waiting: "Waiting for you",
	answered: "Answered",
	declined: "Declined",
	expired: "Expired",
} as const;

const SURFACE_LABEL = {
	question: "Question",
	secret: "Secret",
	form: "Form",
	takeover: "Computer",
	draft: "Draft",
	credential: "Sign-in",
} as const;

function pill(label: string, onClick: () => void, kind: "primary" | "secondary" | "quiet", busy: boolean) {
	const element = button(
		label,
		() => {
			if (!busy) onClick();
		},
		{ primary: kind === "primary" },
	);
	element.classList.add(`interaction-${kind}`);
	if (busy) element.setAttribute("aria-disabled", "true");
	return element;
}

export function renderInteractionCard(item: InteractionCardItem, context: InteractionCardContext): HTMLElement {
	const { request } = item;
	const state = interactionState(request, item.answer, context.now);
	let busy = false;
	let card: HTMLElement;
	const rerender = () => {
		const next = renderInteractionCard(item, { ...context, now: context.now });
		card.replaceWith(next);
		card = next;
	};
	const answer = (outcome: InteractionOutcome, value: Record<string, JsonValue> = {}) => {
		if (busy || !context.canAnswer) return;
		busy = true;
		for (const control of card.querySelectorAll<HTMLElement>("button, input"))
			control.setAttribute("aria-disabled", "true");
		void context.answer(outcome, value).then(rerender, () => {
			busy = false;
			for (const control of card.querySelectorAll<HTMLElement>("button, input"))
				control.removeAttribute("aria-disabled");
		});
	};
	const open = state === "waiting" && context.canAnswer;
	const stateTone = state === "waiting" ? "warn" : state === "answered" ? "ok" : "neutral";

	const body: (HTMLElement | null)[] = [];
	const actions: (HTMLElement | null)[] = [];
	const result: (HTMLElement | null)[] = [];
	if (state === "answered" && item.answer) {
		result.push(
			h(
				"p",
				{ class: "interaction-result" },
				h("span", { class: "interaction-chosen" }, describeAnswer(request, item.answer)),
				" ",
				h(
					"span",
					{ class: "interaction-attribution" },
					`${item.answer.answeredBy ? context.memberName(item.answer.answeredBy) : "You"}${
						item.answer.answeredAt ? ` · ${fmtTime(item.answer.answeredAt)}` : ""
					}${item.answer.pending ? " · Sending" : ""}`,
				),
			),
		);
	} else if (state === "declined" && item.answer) {
		result.push(h("p", { class: "interaction-result" }, describeAnswer(request, item.answer)));
	} else if (state === "expired") {
		result.push(
			h(
				"p",
				{ class: "interaction-result" },
				"This card is past its time. The agent will ask again if it still needs it.",
			),
		);
	}

	if (request.surface === "question") {
		const options = questionOptions(request);
		const multi = request.payload.multiSelect === true;
		const custom = request.payload.allowCustom === true;
		const chosen = new Set<string>();
		if (open) {
			const send = () => {
				const values = [...chosen];
				if (values.length) answer("answered", { values });
			};
			const optionButtons = options.map((option) => {
				const element = pill(
					option.label,
					() => {
						if (!multi) {
							answer("answered", { values: [option.value] });
							return;
						}
						if (chosen.has(option.value)) chosen.delete(option.value);
						else chosen.add(option.value);
						element.setAttribute("aria-pressed", String(chosen.has(option.value)));
					},
					option.style === "primary" ? "primary" : "secondary",
					busy,
				);
				if (multi) element.setAttribute("aria-pressed", "false");
				if (option.description) element.title = option.description;
				return element;
			});
			body.push(h("div", { class: "interaction-options" }, ...optionButtons));
			const field = custom
				? h("input", {
						type: "text",
						class: "interaction-field",
						placeholder: "Something else…",
						"aria-label": "Your own answer",
						onkeydown: (event: KeyboardEvent) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							const value = (event.currentTarget as HTMLInputElement).value.trim();
							if (value) answer("answered", { values: [value] });
						},
					})
				: null;
			const sendButton = multi ? pill("Send", send, "primary", busy) : null;
			actions.push(
				field,
				sendButton,
				pill("Skip", () => answer("declined"), "quiet", busy),
			);
		}
	} else if (request.surface === "takeover") {
		const instruction = typeof request.payload.instruction === "string" ? request.payload.instruction : "";
		if (instruction) body.push(h("p", { class: "interaction-text" }, instruction));
		if (open) {
			actions.push(
				context.takeOver ? pill("Take over", context.takeOver, "primary", busy) : null,
				pill("I'm done", () => answer("handed_back"), context.takeOver ? "secondary" : "primary", busy),
				pill("Skip", () => answer("dismissed"), "quiet", busy),
			);
		}
	} else if (request.surface === "secret") {
		const purpose = typeof request.payload.purpose === "string" ? request.payload.purpose : "";
		if (purpose) body.push(h("p", { class: "interaction-text" }, purpose));
		if (open) {
			body.push(
				h(
					"p",
					{ class: "interaction-note" },
					icon("lock"),
					" Entering a secret here needs a newer version of the app. The value would go to the company vault, never to the agent.",
				),
			);
			actions.push(pill("Decline", () => answer("declined"), "quiet", busy));
		}
	} else if (request.surface === "form") {
		const domain = typeof request.payload.domain === "string" ? request.payload.domain : "";
		if (domain)
			body.push(h("p", { class: "interaction-note" }, icon("lock"), ` Filled on the computer at ${domain} only`));
		if (open) {
			body.push(h("p", { class: "interaction-note" }, "Filling this form here needs a newer version of the app."));
			actions.push(pill("Skip", () => answer("declined"), "quiet", busy));
		}
	} else if (request.surface === "draft") {
		const subject = typeof request.payload.subject === "string" ? request.payload.subject : "";
		const text = typeof request.payload.body === "string" ? request.payload.body : "";
		if (subject) body.push(h("p", { class: "interaction-text interaction-subject" }, subject));
		if (text) body.push(h("pre", { class: "interaction-draft" }, text));
		if (open) {
			body.push(
				h("p", { class: "interaction-note" }, "Sending this draft from here needs a newer version of the app."),
			);
			actions.push(pill("Discard", () => answer("discarded"), "quiet", busy));
		}
	} else if (request.surface === "credential") {
		const domain = typeof request.payload.domain === "string" ? request.payload.domain : "";
		body.push(
			h(
				"p",
				{ class: "interaction-note" },
				icon("lock"),
				` The computer signs in${domain ? ` at ${domain}` : ""} with the company account. Nothing to do here.`,
			),
		);
	}

	card = h(
		"article",
		{
			class: `interaction-card surface-${request.surface} state-${state}`,
			dataset: { interactionId: item.id, surface: request.surface, state },
			"aria-label": `${SURFACE_LABEL[request.surface]} from ${context.agentName}: ${request.title}`,
		},
		h(
			"header",
			{ class: "interaction-heading" },
			h("span", { class: "interaction-kind" }, SURFACE_LABEL[request.surface]),
			h("span", { class: "interaction-from" }, `${context.agentName} · ${fmtTime(item.createdAt)}`),
			badge(STATE_LABEL[state], stateTone),
		),
		h("h3", { class: "interaction-title" }, request.title),
		request.body ? h("p", { class: "interaction-text" }, request.body) : null,
		...body,
		...result,
		actions.some(Boolean) ? h("div", { class: "interaction-actions" }, ...actions) : null,
	);
	return card;
}
