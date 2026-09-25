import type { EmailDraftContent, EmailDraftEditor, EmailDraftState } from "../cloud/email-drafts.ts";
import {
	type InteractionAnswer,
	type InteractionOutcome,
	type InteractionRequest,
	interactionState,
	questionOptions,
} from "../cloud/interactions.ts";
import type { JsonValue } from "../cloud/types.ts";
import { badge, button, fmtTime, h, icon } from "./dom.ts";
import { renderEmailDraftCard } from "./email-draft-card.ts";
import { phrase, t } from "./preferences.ts";

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
	/** Saves a secret card's value into the company vault and marks the card provided;
	 * absent while this version cannot reach the vault. */
	provideSecret?: (value: string) => Promise<void>;
	emailDraft?: EmailDraftEditor;
	loadEmailDraft?: () => Promise<EmailDraftState>;
	actEmailDraft?: (action: "save" | "send" | "discard", content: EmailDraftContent) => Promise<EmailDraftState>;
	now?: number;
}

export interface InteractionCardItem {
	id: string;
	actorUserId: string;
	request: InteractionRequest;
	answer?: InteractionAnswer;
	/** An answer was sent but never reached the agent; the card is open again. */
	answerFailed?: boolean;
	createdAt: string;
}

const STATE_LABEL = {
	waiting: phrase("Waiting for you"),
	answered: phrase("Answered"),
	declined: phrase("Declined"),
	expired: phrase("Expired"),
} as const;

const SURFACE_LABEL = {
	question: phrase("Question"),
	secret: phrase("Secret"),
	form: phrase("Form"),
	takeover: phrase("Computer"),
	draft: phrase("Draft"),
	credential: phrase("Sign-in"),
} as const;

/** What an answer did, for every outcome but a question's chosen options. */
const OUTCOME_LABEL: Record<InteractionOutcome, string> = {
	answered: phrase("Filled in"),
	provided: phrase("Saved to the company vault"),
	handed_back: phrase("Handed back"),
	sent: phrase("Sent"),
	approved: phrase("Approved"),
	declined: phrase("Declined"),
	dismissed: phrase("Skipped"),
	discarded: phrase("Discarded"),
};

/** The answer as the card shows it: a question's chosen options in the agent's own
 * words, otherwise what the member did. */
function answerText(request: InteractionRequest, answer: InteractionAnswer): string {
	if (answer.outcome !== "answered" || request.surface !== "question") return t(OUTCOME_LABEL[answer.outcome]);
	const values = Array.isArray(answer.answer.values)
		? answer.answer.values.filter((value): value is string => typeof value === "string")
		: [];
	const labels = new Map(questionOptions(request).map((option) => [option.value, option.label]));
	return values.map((value) => labels.get(value) ?? value).join(", ") || t("Answered");
}

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
	if (request.surface === "draft" && request.payload.platform === "email" && request.payload.connectorId === "gmail")
		return renderEmailDraftCard(item, context);
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
				h("span", { class: "interaction-chosen" }, answerText(request, item.answer)),
				" ",
				h(
					"span",
					{ class: "interaction-attribution" },
					`${item.answer.answeredBy ? context.memberName(item.answer.answeredBy) : t("You")}${
						item.answer.answeredAt ? ` · ${fmtTime(item.answer.answeredAt)}` : ""
					}${item.answer.pending ? ` · ${t("Sending")}` : ""}`,
				),
			),
		);
	} else if (state === "declined" && item.answer) {
		result.push(h("p", { class: "interaction-result" }, answerText(request, item.answer)));
	} else if (state === "expired") {
		result.push(
			h(
				"p",
				{ class: "interaction-result" },
				t("This card is past its time. The agent will ask again if it still needs it."),
			),
		);
	} else if (state === "waiting" && item.answerFailed && context.canAnswer) {
		result.push(h("p", { class: "interaction-result" }, t("Your answer did not reach the agent. Answer again.")));
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
						placeholder: t("Something else…"),
						"aria-label": t("Your own answer"),
						onkeydown: (event: KeyboardEvent) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							const value = (event.currentTarget as HTMLInputElement).value.trim();
							if (value) answer("answered", { values: [value] });
						},
					})
				: null;
			const sendButton = multi ? pill(t("Send"), send, "primary", busy) : null;
			actions.push(
				field,
				sendButton,
				pill(t("Skip"), () => answer("declined"), "quiet", busy),
			);
		}
	} else if (request.surface === "takeover") {
		const instruction = typeof request.payload.instruction === "string" ? request.payload.instruction : "";
		if (instruction) body.push(h("p", { class: "interaction-text" }, instruction));
		if (open) {
			actions.push(
				context.takeOver ? pill(t("Take over"), context.takeOver, "primary", busy) : null,
				pill(t("I'm done"), () => answer("handed_back"), context.takeOver ? "secondary" : "primary", busy),
				pill(t("Skip"), () => answer("dismissed"), "quiet", busy),
			);
		}
	} else if (request.surface === "secret") {
		const purpose = typeof request.payload.purpose === "string" ? request.payload.purpose : "";
		if (purpose) body.push(h("p", { class: "interaction-text" }, purpose));
		if (open && context.provideSecret) {
			const label = typeof request.payload.label === "string" ? request.payload.label : t("Secret");
			const field = h("input", {
				type: "password",
				class: "interaction-field interaction-secret",
				autocomplete: "off",
				placeholder: t("Paste your {label}", { label: label.toLowerCase() }),
				"aria-label": label,
			}) as HTMLInputElement;
			const save = () => {
				const value = field.value;
				if (!value.trim() || busy || !context.provideSecret) return;
				busy = true;
				for (const control of card.querySelectorAll<HTMLElement>("button, input"))
					control.setAttribute("aria-disabled", "true");
				void context.provideSecret(value).then(
					() => {
						field.value = "";
						rerender();
					},
					() => {
						busy = false;
						for (const control of card.querySelectorAll<HTMLElement>("button, input"))
							control.removeAttribute("aria-disabled");
					},
				);
			};
			field.addEventListener("keydown", (event) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				save();
			});
			body.push(
				h("div", { class: "interaction-secret-row" }, field, pill(t("Save securely"), save, "primary", busy)),
			);
			body.push(
				h(
					"p",
					{ class: "interaction-note" },
					icon("lock"),
					` ${t("Encrypted in the company vault. The agent never sees the value, only that it was saved.")}`,
				),
			);
			actions.push(pill(t("Decline"), () => answer("declined"), "quiet", busy));
		} else if (open) {
			body.push(
				h(
					"p",
					{ class: "interaction-note" },
					icon("lock"),
					` ${t("Entering a secret here needs a newer version of the app. The value would go to the company vault, never to the agent.")}`,
				),
			);
			actions.push(pill(t("Decline"), () => answer("declined"), "quiet", busy));
		}
	} else if (request.surface === "form") {
		const domain = typeof request.payload.domain === "string" ? request.payload.domain : "";
		if (domain)
			body.push(
				h(
					"p",
					{ class: "interaction-note" },
					icon("lock"),
					` ${t("Filled on the computer at {domain} only", { domain })}`,
				),
			);
		if (open) {
			body.push(
				h("p", { class: "interaction-note" }, t("Filling this form here needs a newer version of the app.")),
			);
			actions.push(pill(t("Skip"), () => answer("declined"), "quiet", busy));
		}
	} else if (request.surface === "draft") {
		const subject = typeof request.payload.subject === "string" ? request.payload.subject : "";
		const text = typeof request.payload.body === "string" ? request.payload.body : "";
		if (subject) body.push(h("p", { class: "interaction-text interaction-subject" }, subject));
		if (text) body.push(h("pre", { class: "interaction-draft" }, text));
		if (open) {
			body.push(
				h("p", { class: "interaction-note" }, t("Sending this draft from here needs a newer version of the app.")),
			);
			actions.push(pill(t("Discard"), () => answer("discarded"), "quiet", busy));
		}
	} else if (request.surface === "credential") {
		const domain = typeof request.payload.domain === "string" ? request.payload.domain : "";
		body.push(
			h(
				"p",
				{ class: "interaction-note" },
				icon("lock"),
				` ${
					domain
						? t("The computer signs in at {domain} with the company account. Nothing to do here.", { domain })
						: t("The computer signs in with the company account. Nothing to do here.")
				}`,
			),
		);
	}

	card = h(
		"article",
		{
			class: `interaction-card surface-${request.surface} state-${state}`,
			dataset: { interactionId: item.id, surface: request.surface, state },
			"aria-label": t("{kind} from {name}: {title}", {
				kind: t(SURFACE_LABEL[request.surface]),
				name: context.agentName,
				title: request.title,
			}),
		},
		h(
			"header",
			{ class: "interaction-heading" },
			h("span", { class: "interaction-kind" }, t(SURFACE_LABEL[request.surface])),
			h("span", { class: "interaction-from" }, `${context.agentName} · ${fmtTime(item.createdAt)}`),
			badge(t(STATE_LABEL[state]), stateTone),
		),
		h("h3", { class: "interaction-title" }, request.title),
		request.body ? h("p", { class: "interaction-text" }, request.body) : null,
		...body,
		...result,
		actions.some(Boolean) ? h("div", { class: "interaction-actions" }, ...actions) : null,
	);
	return card;
}
