import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import { pictureUrl } from "../app/folder-images.ts";
import type { EmailDraftContent, EmailDraftEditor, EmailDraftState } from "../cloud/email-drafts.ts";
import {
	type InteractionAnswer,
	type InteractionOutcome,
	type InteractionRequest,
	interactionState,
	type QuestionOption,
	questionOptions,
} from "../cloud/interactions.ts";
import type { JsonValue } from "../cloud/types.ts";
import { foldLong, shownLength } from "./card-fold.ts";
import { stoppedCardNote } from "./card-notes.ts";
import { badge, button, fmtTime, h, icon } from "./dom.ts";
import { renderEmailDraftCard } from "./email-draft-card.ts";
import { interfaceEmblem } from "./interface-emblem.ts";
import { markdown } from "./markdown.ts";
import { phrase, t } from "./preferences.ts";

/* Cards an agent raises in its thread (THREAD-WIDGETS-DESIGN-20260922.md).
 * One shell for every surface: a quiet header with the agent's name, the
 * title, a state badge; the body per surface; pills at the foot, primary on
 * the left, Skip on the right, as the failed-run line does it. Once answered a
 * card stays in the thread, inert, showing what was chosen. Secret inputs go
 * directly to the vault broker through provideSecret, never into an answer. */

/** A body longer than this many lines, or than this many characters as shown, folds behind Show more (ui/card-fold.ts):
 * past what a card the agent may write holds (5 short lines), so a readable card shows whole. */
const BODY_LINES = 5;
const BODY_CHARS = 360;
/** A list item's line. */
const LIST = /^\s*(?:[-*+]|\d+[.)])\s/;

/** A card's body drawn as a message draws Markdown (lines, lists, folder links), folded when long. `key`: the card's
 * id, which keeps it open across redraws. */
export function cardBody(text: string, key: string): HTMLElement {
	// A line right after a list that is no item of it starts a paragraph of its own (such as the link under the bullets),
	// where Markdown would fold it into the last item; never inside a fenced code block.
	const lines = text.split("\n");
	let fenced = false;
	const shaped = lines.map((line, index) => {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		const after = index > 0 && LIST.test(lines[index - 1] ?? "");
		return !fenced && after && line.trim() && !/^\s/.test(line) && !LIST.test(line) ? `\n${line}` : line;
	});
	const body = h("div", { class: "interaction-body" }, markdown(shaped.join("\n")));
	const long = lines.filter((line) => line.trim()).length > BODY_LINES || shownLength(text) > BODY_CHARS;
	return foldLong(body, long, key);
}

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
	 * absent when this context cannot reach the vault. */
	provideSecret?: (value: string) => Promise<void>;
	emailDraft?: EmailDraftEditor;
	loadEmailDraft?: () => Promise<EmailDraftState>;
	actEmailDraft?: (action: "save" | "send" | "discard", content: EmailDraftContent) => Promise<EmailDraftState>;
	/** Reads a picture of the company's folder for an option's preview; null when there is none to show. */
	image?: (path: string, signal: AbortSignal) => Promise<Blob | null>;
	now?: number;
}

/** Pictures read for options, per reader (one per company, app/application.ts) and path: read once, kept while the
 * page is open. */
const PICTURES = new WeakMap<NonNullable<InteractionCardContext["image"]>, Map<string, Promise<string | null>>>();

function picture(read: NonNullable<InteractionCardContext["image"]>, path: string): Promise<string | null> {
	let kept = PICTURES.get(read);
	if (!kept) {
		kept = new Map();
		PICTURES.set(read, kept);
	}
	let shown = kept.get(path);
	if (!shown) {
		shown = read(path, new AbortController().signal).then(
			(blob) => (blob ? pictureUrl(blob) : null),
			() => null,
		);
		kept.set(path, shown);
		// A picture that could not be read is read again by the next card that shows it.
		const reading = shown;
		void reading.then((url) => {
			if (!url && kept.get(path) === reading) kept.delete(path);
		});
	}
	return shown;
}

/** The picture area of a visual choice: the image the agent made, or the app's emblem and name. */
function choicePicture(preview: string, context: InteractionCardContext): HTMLElement {
	const app = /^app:(.+)$/.exec(preview);
	if (app && isInterfaceName(app[1] ?? ""))
		return h(
			"span",
			{ class: "choice-picture is-app", "aria-hidden": "true" },
			interfaceEmblem(null, null, 40),
			h("span", { class: "choice-app-name" }, app[1] ?? ""),
		);
	const box = h("span", { class: "choice-picture is-loading", "aria-hidden": "true" });
	const read = context.image;
	if (!read) {
		box.classList.remove("is-loading");
		return box;
	}
	void picture(read, preview).then((url) => {
		box.classList.remove("is-loading");
		if (url) box.append(h("img", { src: url, alt: "", decoding: "async" }));
	});
	return box;
}

/** A question's options as big pictures to pick from (Jonas, 5 November 2026: a choice between something visual is two
 * big boxes, not a long text). Answered, the boxes stay, inert, the chosen one marked. */
function visualChoices(
	options: readonly QuestionOption[],
	context: InteractionCardContext,
	pick: ((option: QuestionOption, box: HTMLButtonElement) => void) | null,
	chosen: ReadonlySet<string>,
	busy: boolean,
	multi = false,
): HTMLElement {
	const boxes = options.map((option) => {
		const box = h(
			"button",
			{
				type: "button",
				class: `choice-box${chosen.has(option.value) ? " is-chosen" : ""}`,
				...(pick ? {} : { disabled: true }),
				...(pick && multi ? { "aria-pressed": String(chosen.has(option.value)) } : {}),
				...(busy ? { "aria-disabled": "true" } : {}),
			},
			option.preview ? choicePicture(option.preview, context) : h("span", { class: "choice-picture is-empty" }),
			h("strong", { class: "choice-label" }, option.label),
			option.description ? h("span", { class: "choice-description" }, option.description) : null,
		) as HTMLButtonElement;
		if (pick)
			box.addEventListener("click", () => {
				if (!busy) pick(option, box);
			});
		return box;
	});
	// An app's option opens the app beside the chat from its link: the box itself picks.
	const apps = options
		.map((option) => /^app:(.+)$/.exec(option.preview ?? "")?.[1])
		.filter((name): name is string => Boolean(name) && isInterfaceName(name ?? ""));
	const grid = h(
		"div",
		{ class: "interaction-choices" },
		...boxes,
		apps.length
			? h("div", { class: "choice-apps" }, markdown(apps.map((name) => `[${name}](app:${name})`).join(" ")))
			: null,
	);
	// Set through the style object: the page's CSP takes no inline style attribute.
	grid.style.setProperty("--choices", String(Math.min(options.length, 3)));
	return grid;
}

export interface InteractionCardItem {
	id: string;
	actorUserId: string;
	request: InteractionRequest;
	answer?: InteractionAnswer;
	/** An answer was sent but never reached the agent; the card is open again. */
	answerFailed?: boolean;
	/** A member stopped the work that raised the card; it stays open, and an answer starts new work. */
	chainStopped?: boolean;
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
	if (state === "waiting" && item.chainStopped)
		result.push(h("p", { class: "interaction-result" }, stoppedCardNote(context.canAnswer)));

	if (request.surface === "question") {
		const options = questionOptions(request);
		const multi = request.payload.multiSelect === true;
		const custom = request.payload.allowCustom === true;
		const chosen = new Set<string>();
		const visual = options.some((option) => option.preview);
		if (visual && !open && state === "answered" && item.answer?.answer) {
			const values = item.answer.answer.values;
			body.push(
				visualChoices(
					options,
					context,
					null,
					new Set(
						Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [],
					),
					false,
				),
			);
		}
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
			body.push(
				visual
					? visualChoices(
							options,
							context,
							(option, box) => {
								if (!multi) {
									answer("answered", { values: [option.value] });
									return;
								}
								if (chosen.has(option.value)) chosen.delete(option.value);
								else chosen.add(option.value);
								box.setAttribute("aria-pressed", String(chosen.has(option.value)));
								box.classList.toggle("is-chosen", chosen.has(option.value));
							},
							chosen,
							busy,
							multi,
						)
					: h("div", { class: "interaction-options" }, ...optionButtons),
			);
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
					` ${t("Saving a secret to the company vault is unavailable here. Do not paste it into chat.")}`,
				),
			);
			actions.push(pill(t("Decline"), () => answer("declined"), "quiet", busy));
		}
	} else if (request.surface === "form") {
		const domain = typeof request.payload.domain === "string" ? request.payload.domain : "";
		if (domain) body.push(h("p", { class: "interaction-note" }, t("Website: {domain}", { domain })));
		if (state === "waiting") {
			body.push(h("p", { class: "interaction-note" }, t("Filling a webpage through this card is unavailable.")));
		}
		if (open) actions.push(pill(t("Skip"), () => answer("declined"), "quiet", busy));
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
				` ${
					domain
						? t("Signing in to {domain} through this card is unavailable.", { domain })
						: t("Signing in through this card is unavailable.")
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
		request.body ? cardBody(request.body, item.id) : null,
		...body,
		...result,
		actions.some(Boolean) ? h("div", { class: "interaction-actions" }, ...actions) : null,
	);
	return card;
}
