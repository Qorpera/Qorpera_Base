import type { InterfaceEmblem } from "@qorpera/cloud-client/interfaces";
import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import { forgetPictureUrl, pictureUrl } from "../app/folder-images.ts";
import type { EmailDraftContent, EmailDraftEditor, EmailDraftState } from "../cloud/email-drafts.ts";
import { MAIL_HANDLE } from "../cloud/event-hooks.ts";
import {
	type DecisionRound,
	type InteractionAnswer,
	type InteractionOutcome,
	type InteractionRequest,
	interactionState,
	isGmailDraft,
	type QuestionOption,
	questionInput,
	questionOptions,
	typedNote,
} from "../cloud/interactions.ts";
import type { JsonValue } from "../cloud/types.ts";
import { foldLong, shownLength } from "./card-fold.ts";
import { stoppedCardNote } from "./card-notes.ts";
import { badge, button, fmtTime, h, icon } from "./dom.ts";
import { renderEmailDraftCard } from "./email-draft-card.ts";
import { interfaceEmblem } from "./interface-emblem.ts";
import {
	cleanHandle,
	HANDLE_MAX_CHARACTERS,
	HandleCheck,
	handleUsable,
	handleWords,
	type MailAddressCalls,
} from "./mail-address.ts";
import { appCard, markdown } from "./markdown.ts";
import { phrase, t } from "./preferences.ts";

/* Cards an agent raises in its thread (THREAD-WIDGETS-DESIGN-20260922.md).
 * One shell for every surface: a quiet header with the agent's name, the
 * title, a state badge; the body per surface; pills at the foot, primary on
 * the left, Skip on the right, as the failed-run line does it. Once answered a
 * card stays in the thread, inert, showing what was chosen. Secret inputs go
 * directly to the vault broker through provideSecret, never into an answer.
 *
 * In a thread (`inThread`) a card that has its answer, or is past its time, is drawn as the exchange it was (Jonas,
 * 13 November 2026, on an answered question: "could we improve that visually too?"): what the agent asked as the
 * agent's bubble, a question's answer as the member's own bubble on their side, and anything else done with the card
 * (saved, handed back, declined, past its time) as one quiet line under the question, marked as a decided approval is.
 * It has no frame, and its label row is kept for a screen reader only: each part tells its time on a hover, as a
 * message does (ui/sent-time-hover.ts).
 *
 * A card that waits for this member in a thread is the one thing there to act on, and says so (Jonas, 13 November
 * 2026: "I still want some form of widget with proposed answers and a clear visual that indicates something to do"):
 * it keeps its frame, a quiet line on a soft shadow (Jonas, 14 November 2026: "the border is red and ugly"), and its
 * head is the agent's figure, waiting, beside "{name} asks you" in the accent colour, in place of the label row (kept
 * for a screen reader). The proposed answers are large pills, and an answer of the member's own has a Send button in
 * its field. Options with pictures are boxes over the pills; an app is linked once. */

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

/** An app of the company an option's preview names (`app:<name>`), as the card shows it. */
export interface InteractionCardApp {
	/** The app's own title, never its folder name. */
	readonly title: string;
	readonly emblem: InterfaceEmblem;
	/** Its cover's path in the company's folder, read as any other preview picture; null when it has none. */
	readonly cover: string | null;
}

function roundLine(round: DecisionRound, context: InteractionCardContext): HTMLElement {
	const said = round.note
		? round.by !== undefined && round.by === context.viewerId?.toLowerCase()
			? t("You said: “{note}”", { note: round.note })
			: t("{member} said: “{note}”", { member: context.memberName(round.by), note: round.note })
		: undefined;
	return h(
		"p",
		{ class: "interaction-round" },
		h("span", { class: "interaction-round-number" }, t("Round {number}", { number: String(round.number) })),
		said ? h("span", { class: "interaction-round-note" }, said) : null,
	);
}

export interface InteractionCardContext {
	agentName: string;
	memberName: (userId: string | undefined) => string;
	/** Whether this member may answer (the thread's own member, with write access). */
	canAnswer: boolean;
	/** The card stands in a thread: once it has its answer it is drawn as the exchange it was (see above). */
	inThread?: boolean;
	/** The card stands in the questions dock (app/views/question-dock.ts), which heads it with the agent's figure and
	 * "{name} asks you" of its own: the label row is then a screen reader's, as in a thread. */
	inDock?: boolean;
	/** The member looking, whose own answer stands on their side of the thread. */
	viewerId?: string;
	/** The agent's figure, waiting: the head of a card that waits for this member in a thread. */
	figure?: () => HTMLElement;
	reworking?: boolean;
	round?: DecisionRound;
	vote?: { answerer: string; own?: true; pick?: (value: string) => void };
	/** Sends the outcome and answer; the card shows its busy state until it resolves. */
	answer: (outcome: InteractionOutcome, answer: Record<string, JsonValue>) => Promise<void>;
	/** A takeover card's Open computer: the agent's computer in the thread (woken when it sleeps), its large view once
	 * a picture shows; absent when the thread has none. It begins no private hold (Jonas, 14 Nov 2026). */
	openComputer?: () => void;
	/** Saves a secret card's value into the company vault and marks the card provided;
	 * absent when this context cannot reach the vault. */
	provideSecret?: (value: string) => Promise<void>;
	/** A secret saved from this card is the company's, not the member's own (app/company.ts secretSavedForCompany): for a
	 * coding value it decides which repositories' sessions get it, which the card says. */
	savesForCompany?: boolean;
	emailDraft?: EmailDraftEditor;
	loadEmailDraft?: () => Promise<EmailDraftState>;
	actEmailDraft?: (action: "save" | "send" | "discard", content: EmailDraftContent) => Promise<EmailDraftState>;
	mailAddress?: MailAddressCalls;
	/** Reads a picture of the company's folder for an option's preview; null when there is none to show. */
	image?: (path: string, signal: AbortSignal) => Promise<Blob | null>;
	/** An app of the company by its name, for an option whose preview names one; undefined when the company has no
	 * such app, or where the apps cannot be reached. */
	app?: (name: string) => InteractionCardApp | undefined;
	/** WHY: optional per-card signal for callers to abort mail_address probes and timers before rerender. */
	signal?: AbortSignal;
	now?: number;
}

interface PictureCache {
	readonly entries: Map<string, Promise<string | null>>;
	readonly controller: AbortController;
	disposed: boolean;
}

const MAX_CARD_PICTURES = 48;
const PICTURES = new WeakMap<NonNullable<InteractionCardContext["image"]>, PictureCache>();

export function disposeCardPictures(read: NonNullable<InteractionCardContext["image"]> | undefined): void {
	if (!read) return;
	const cache = PICTURES.get(read);
	if (!cache) return;
	PICTURES.delete(read);
	cache.disposed = true;
	cache.controller.abort();
	for (const pending of cache.entries.values()) {
		void pending.then((url) => {
			if (url) forgetPictureUrl(url);
		});
	}
	cache.entries.clear();
}

function picture(read: NonNullable<InteractionCardContext["image"]>, path: string): Promise<string | null> {
	let cache = PICTURES.get(read);
	if (!cache) {
		cache = { entries: new Map(), controller: new AbortController(), disposed: false };
		PICTURES.set(read, cache);
	}
	let shown = cache.entries.get(path);
	if (shown) {
		cache.entries.delete(path);
		cache.entries.set(path, shown);
	}
	if (!shown) {
		if (cache.entries.size >= MAX_CARD_PICTURES) {
			const oldestKey = cache.entries.keys().next().value;
			if (oldestKey !== undefined) {
				const evicted = cache.entries.get(oldestKey);
				cache.entries.delete(oldestKey);
				void evicted?.then((url) => {
					if (url) forgetPictureUrl(url);
				});
			}
		}
		const active = cache;
		shown = read(path, active.controller.signal)
			.then(async (blob) => {
				if (!blob || active.disposed) return null;
				const url = await pictureUrl(blob);
				if (active.disposed) {
					forgetPictureUrl(url);
					return null;
				}
				return url;
			})
			.catch(() => null);
		cache.entries.set(path, shown);
		// A picture that could not be read is read again by the next card that shows it.
		const reading = shown;
		void reading.then((url) => {
			if (!url && active.entries.get(path) === reading) active.entries.delete(path);
		});
	}
	return shown;
}

type PictureReader = NonNullable<InteractionCardContext["image"]>;
type AppReader = NonNullable<InteractionCardContext["app"]>;

/** What an app preview shows of the app, to tell whether it is still what the company's apps say: "" for no app. */
const appShown = (app: InteractionCardApp | undefined) =>
	app ? JSON.stringify([app.title, app.emblem, app.cover]) : "";

/** The picture area of a visual choice: the picture the agent made, or, for a preview that names an app, that app's
 * cover, or its emblem beside its title. Null when there is nothing to show (Jonas, 13 November 2026, on a question's
 * options: the previews "do not load their visual"): an empty grey frame is no preview, so none is drawn. `coverOnly`:
 * an app's cover or nothing, for the app's own card, which has its emblem and title already. */
function choicePicture(
	preview: string,
	apps: AppReader | undefined,
	read: PictureReader | undefined,
	coverOnly = false,
): HTMLElement | null {
	const shown = (path: string) => {
		if (!read) return null;
		const box = h("span", { class: "choice-picture is-loading", "aria-hidden": "true" });
		void picture(read, path).then((url) => {
			box.classList.remove("is-loading");
			// A picture that is not there, or that cannot be shown, leaves no empty frame behind.
			if (url) box.append(h("img", { src: url, alt: "", decoding: "async" }));
			else box.remove();
		});
		return box;
	};
	const named = /^app:(.+)$/.exec(preview)?.[1];
	if (named === undefined) return shown(preview);
	// An app the company has: its cover is a picture of the folder like any other, and with none the app stands for
	// itself, by its own emblem and title. An app that is not there has nothing to show.
	const app = isInterfaceName(named) ? apps?.(named) : undefined;
	if (!app) return null;
	const cover = app.cover ? shown(app.cover) : null;
	if (coverOnly) return cover;
	return (
		cover ??
		h(
			"span",
			{ class: "choice-picture is-app", "aria-hidden": "true" },
			interfaceEmblem(app.emblem, 40),
			h("span", { class: "choice-app-name" }, app.title),
		)
	);
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
	others: HTMLElement | null = null,
): HTMLElement {
	const boxes = options.map((option) => {
		// A box that previews an app says which, and what of it it shows: refreshAppPreviews brings it up to date.
		const app = appPreviewName(option.preview);
		const box = h(
			"button",
			{
				type: "button",
				class: `choice-box${chosen.has(option.value) ? " is-chosen" : ""}`,
				...(pick ? {} : { disabled: true }),
				...(pick && multi ? { "aria-pressed": String(chosen.has(option.value)) } : {}),
				...(busy ? { "aria-disabled": "true" } : {}),
				dataset: {
					optionValue: option.value,
					...(app ? { previewApp: app, previewShown: appShown(context.app?.(app)) } : {}),
				},
			},
			// An option with no preview draws no preview: a box of its own, with its label, and nothing above it.
			option.preview ? choicePicture(option.preview, context.app, context.image) : null,
			h("strong", { class: "choice-label" }, option.label),
			option.description ? h("span", { class: "choice-description" }, option.description) : null,
		) as HTMLButtonElement;
		if (pick)
			box.addEventListener("click", () => {
				if (!busy) pick(option, box);
			});
		return box;
	});
	// An app's option opens the app's own page from its link: the box itself picks. Each app once, however many of the
	// options show it (two headlines in one concept).
	const apps = [
		...new Set(options.map((option) => appPreviewName(option.preview)).filter((name) => name !== undefined)),
	];
	const grid = h(
		"div",
		{ class: "interaction-choices" },
		...boxes,
		others,
		apps.length
			? h(
					"div",
					{ class: "choice-apps" },
					// By the app's own title, never its folder name (Jonas, 13 November 2026).
					h(
						"div",
						{ class: "app-cards" },
						...apps.map((name) => appCard(name, context.app?.(name)?.title ?? name)),
					),
				)
			: null,
	);
	// Set through the style object: the page's CSP takes no inline style attribute.
	// Never fewer than two columns: a lone picture is a box of a choice, not a banner across the card.
	grid.style.setProperty("--choices", String(Math.max(2, Math.min(boxes.length, 3))));
	return grid;
}

/** The app an option's preview names (`app:<name>`, a name an app may have), or undefined. */
function appPreviewName(preview: string | undefined): string | undefined {
	const name = /^app:(.+)$/.exec(preview ?? "")?.[1];
	return name !== undefined && isInterfaceName(name) ? name : undefined;
}

/** Brings every question card under `root` up to the company's apps as they are now (review r1 of #1763, F1): a card
 * drawn before the apps were read showed no preview for an option that names an app, and kept none. Each such option
 * gets the app's cover, or its emblem and title, once the apps are read or when they change, and the app's card under
 * the options its title. Only those parts change, in place: the card itself, a picked option and an answer being
 * typed stay as they are. Called by app/application.ts after each read of the company's apps and each change on its
 * page, as the cards of apps in messages are brought up to date. */
export function refreshAppPreviews(root: ParentNode, apps: AppReader, read?: PictureReader): void {
	// The options' boxes, and the app cards of a question's words that carry the app's cover.
	for (const box of root.querySelectorAll<HTMLElement>(
		":is(.choice-box, .interaction-body .app-card)[data-preview-app]",
	)) {
		const name = box.dataset.previewApp ?? "";
		const shown = appShown(apps(name));
		if (box.dataset.previewShown === shown) continue;
		box.dataset.previewShown = shown;
		for (const old of box.querySelectorAll(":scope > .choice-picture")) old.remove();
		const picture = choicePicture(`app:${name}`, apps, read, box.classList.contains("app-card"));
		if (picture) box.prepend(picture);
	}
	for (const card of root.querySelectorAll<HTMLElement>(".choice-apps .app-card[data-app-name]")) {
		const name = card.dataset.appName ?? "";
		const title = card.querySelector(".app-card-title");
		const text = apps(name)?.title ?? name;
		if (title && title.textContent !== text) title.textContent = text;
	}
}

function mailAddressParts(
	options: readonly QuestionOption[],
	calls: MailAddressCalls | undefined,
	busy: boolean,
	use: (handle: string, refused: (text: string) => void) => void,
	signal: AbortSignal,
): { body: HTMLElement[]; actions: HTMLElement[] } {
	const suggestions = [...new Set(options.map((option) => option.value).filter((value) => MAIL_HANDLE.test(value)))];
	const able = calls?.canChoose === true;
	const input = h("input", {
		type: "text",
		class: "interaction-address-handle",
		value: suggestions[0] ?? "",
		maxlength: String(HANDLE_MAX_CHARACTERS),
		autocomplete: "off",
		autocapitalize: "none",
		spellcheck: "false",
		placeholder: t("e.g. acme"),
		"aria-label": t("The company's part of the address"),
		disabled: !able,
	});
	const domain = h("span", { class: "interaction-address-domain" }, "@…");
	const line = h("p", { class: "interaction-address-check service-outcome", role: "status" });
	let mailOff = false;
	const say = (text: string, tone: "ok" | "error" | "") => {
		if (line.textContent !== text) line.textContent = text;
		line.classList.toggle("is-ok", tone === "ok");
		line.classList.toggle("is-error", tone === "error");
	};
	const submit = () => {
		if (!able || mailOff || !check || !handleUsable(check.state)) return;
		use(input.value, (text) => say(text, "error"));
	};
	const useButton = able ? pill(t("Use this address"), submit, "primary", busy) : null;
	const draw = () => {
		const state = check?.state ?? "unknown";
		if (useButton) useButton.disabled = mailOff || !handleUsable(state) || state === "checking";
		if (!calls) say(t("The address can be chosen in the chat."), "");
		else if (!able) say(t("Only founders and admins can choose the address"), "");
		else if (mailOff) say(t("Company mail is not set up yet."), "error");
		else
			say(
				handleWords(state),
				state === "free" || state === "ours" ? "ok" : state === "taken" || state === "invalid" ? "error" : "",
			);
	};
	const check = able && calls ? new HandleCheck(calls.status, draw) : undefined;
	if (signal.aborted) check?.stop();
	else signal.addEventListener("abort", () => check?.stop(), { once: true });
	input.addEventListener(
		"input",
		() => {
			const cleaned = cleanHandle(input.value);
			if (cleaned !== input.value) input.value = cleaned;
			check?.set(cleaned);
		},
		{ signal },
	);
	input.addEventListener(
		"keydown",
		(event) => {
			if (event.key !== "Enter" || event.isComposing) return;
			event.preventDefault();
			submit();
		},
		{ signal },
	);
	if (!signal.aborted) {
		void calls?.handles(signal).then(
			(mail) => {
				if (signal.aborted) return;
				if (mail.domain === null) mailOff = true;
				else domain.textContent = `@${mail.domain}`;
				draw();
			},
			() => undefined,
		);
	}
	const pills =
		able && suggestions.length > 1
			? h(
					"div",
					{ class: "interaction-options interaction-address-suggestions" },
					...suggestions.map((handle) =>
						pill(
							handle,
							() => {
								if (input.getAttribute("aria-disabled") === "true") return;
								input.value = handle;
								check?.set(handle);
								input.focus();
							},
							"secondary",
							busy,
						),
					),
				)
			: null;
	draw();
	check?.set(input.value);
	return {
		body: [h("label", { class: "interaction-address" }, input, domain), ...(pills ? [pills] : []), line],
		actions: useButton ? [useButton] : [],
	};
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
 * words, otherwise what the member did. A question or a form the member passed with Skip says so: "Declined" under a
 * question would read as its answer being no. */
function answerText(request: InteractionRequest, answer: InteractionAnswer): string {
	if (answer.outcome === "declined" && (request.surface === "question" || request.surface === "form"))
		return t(OUTCOME_LABEL.dismissed);
	if (answer.outcome !== "answered" || request.surface !== "question") return t(OUTCOME_LABEL[answer.outcome]);
	const values = Array.isArray(answer.answer.values)
		? answer.answer.values.filter((value): value is string => typeof value === "string")
		: [];
	const labels = new Map(questionOptions(request).map((option) => [option.value, option.label]));
	return values.map((value) => labels.get(value) ?? value).join(", ") || t("Answered");
}

const NAME_MARK = "\u0000";

function named(line: string, name: string): (string | HTMLElement)[] {
	const at = line.indexOf(NAME_MARK);
	return at < 0 ? [line] : [line.slice(0, at), h("b", null, name), line.slice(at + NAME_MARK.length)];
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
	if (isGmailDraft(request)) return renderEmailDraftCard(item, context);
	const state = interactionState(request, item.answer, context.now);
	let busy = false;
	let card: HTMLElement;
	let disposeParts: (() => void) | undefined;
	const rerender = () => {
		disposeParts?.();
		disposeParts = undefined;
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
	const vote =
		state === "waiting" &&
		!context.canAnswer &&
		request.surface === "question" &&
		questionInput(request) !== "mail_address"
			? context.vote
			: undefined;
	const stateTone = state === "waiting" ? "warn" : state === "answered" ? "ok" : "neutral";

	// The card's own words, drawn as a message's Markdown.
	const words = request.body ? cardBody(request.body, item.id) : null;
	const body: (HTMLElement | null)[] = [];
	const actions: (HTMLElement | null)[] = [];
	const result: (HTMLElement | null)[] = [];
	// In a thread a card with its answer is the exchange it was: the bubbles' own classes draw it (styles/conversation.css).
	const note = typedNote(request, item.answer);
	const reworking = context.inThread === true && context.reworking === true && note !== undefined;
	const exchange = context.inThread === true && state !== "waiting" && !reworking;
	// In a thread a card this member can answer says that it waits for them.
	const asking = context.inThread === true && open;
	const mark = (name: "check" | "close") =>
		exchange
			? h(
					"span",
					{ class: `review-mark is-${name === "check" ? "approved" : "declined"}`, "aria-hidden": "true" },
					icon(name),
				)
			: null;
	if (reworking) {
		body.push(h("p", { class: "interaction-text interaction-noted" }, `“${note}”`));
	} else if (state === "answered" && item.answer) {
		const { answeredBy, answeredAt, pending } = item.answer;
		const own = !answeredBy || answeredBy === context.viewerId;
		// A question's answer is what the member said: their bubble. Anything else is what they did: a line.
		const said = request.surface === "question" && item.answer.outcome === "answered";
		const who = answeredBy ? context.memberName(answeredBy) : t("You");
		const asked =
			said && answeredBy && item.actorUserId && answeredBy !== item.actorUserId ? item.actorUserId : undefined;
		const sentFor = asked
			? own
				? t("{name}'s pick, sent by you", { name: context.memberName(asked) })
				: asked === context.viewerId
					? t("Your pick, sent by {sender}", { sender: who })
					: t("{name}'s pick, sent by {sender}", { name: context.memberName(asked), sender: who })
			: undefined;
		// Beside the answer: whose it is when it is not the member's own, and that it is on its way.
		const beside = [sentFor ?? (own ? null : who), pending ? t("Sending") : null].filter(Boolean).join(" · ");
		const whole = `${sentFor ?? who}${answeredAt ? ` · ${fmtTime(answeredAt)}` : ""}${pending ? ` · ${t("Sending")}` : ""}`;
		result.push(
			h(
				"p",
				{
					class: `interaction-result${exchange ? (said ? ` is-said${own ? " mine" : ""}` : " is-done") : ""}`,
					...(exchange && answeredAt ? { dataset: { sentAt: answeredAt } } : {}),
				},
				said ? null : mark("check"),
				h(
					"span",
					{ class: `interaction-chosen${exchange && said ? " bubble" : ""}` },
					answerText(request, item.answer),
				),
				" ",
				// Who answered, when, and that it is on its way. In a thread the eye gets only `beside` (the time is on a
				// hover) and a screen reader gets the whole line; both parts are always there, so an answer that is sent
				// changes words only and its card is kept (views/conversation.ts sameShape).
				exchange
					? h(
							"span",
							{ class: "interaction-attribution" },
							h("span", { class: "interaction-beside", "aria-hidden": "true" }, document.createTextNode(beside)),
							h("span", { class: "visually-hidden" }, whole),
						)
					: h("span", { class: "interaction-attribution" }, whole),
			),
		);
	} else if (state === "declined" && item.answer) {
		result.push(
			h(
				"p",
				{
					class: `interaction-result${exchange ? " is-done" : ""}`,
					...(exchange && item.answer.answeredAt ? { dataset: { sentAt: item.answer.answeredAt } } : {}),
				},
				mark("close"),
				answerText(request, item.answer),
			),
		);
	} else if (state === "expired") {
		result.push(
			h(
				"p",
				{ class: `interaction-result${exchange ? " is-done" : ""}` },
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
		// An app the question's own words link is a card under them already, and is not shown again (Jonas, 14 November
		// 2026: "the interface reference is there twice"): an option that previews it is a pill like any other, and its
		// cover stands on that card. Only the options with a picture of their own are boxes, with the other options as
		// pills under them ("the selections are unfitted"): never a picture's box beside an empty one.
		const linked = new Map(
			[...(words?.querySelectorAll<HTMLElement>(".app-card[data-app-name]") ?? [])].map((card) => [
				card.dataset.appName ?? "",
				card,
			]),
		);
		const boxed = (option: QuestionOption) =>
			Boolean(option.preview) && !linked.has(appPreviewName(option.preview) ?? "");
		const pictured = options.filter(boxed);
		const visual = pictured.length > 0;
		for (const [name, linkCard] of linked) {
			if (!options.some((option) => appPreviewName(option.preview) === name)) continue;
			linkCard.dataset.previewApp = name;
			linkCard.dataset.previewShown = appShown(context.app?.(name));
			const cover = choicePicture(`app:${name}`, context.app, context.image, true);
			if (cover) linkCard.prepend(cover);
		}
		if (visual && !open && state === "answered" && item.answer?.answer && note === undefined) {
			const values = item.answer.answer.values;
			body.push(
				visualChoices(
					pictured,
					context,
					null,
					new Set(
						Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [],
					),
					false,
				),
			);
		}
		if (open && questionInput(request) === "mail_address") {
			const cardAbort = new AbortController();
			const onContextAbort = () => cardAbort.abort();
			if (context.signal?.aborted) cardAbort.abort();
			else context.signal?.addEventListener("abort", onContextAbort, { once: true });
			disposeParts = () => {
				context.signal?.removeEventListener("abort", onContextAbort);
				cardAbort.abort();
			};
			const parts = mailAddressParts(
				options,
				context.mailAddress,
				busy,
				(handle, refused) => {
					if (busy || !context.mailAddress) return;
					busy = true;
					for (const control of card.querySelectorAll<HTMLElement>("button, input"))
						control.setAttribute("aria-disabled", "true");
					void context.mailAddress.choose(handle).then(
						() => {
							if (!cardAbort.signal.aborted) rerender();
						},
						(error: unknown) => {
							if (cardAbort.signal.aborted) return;
							busy = false;
							for (const control of card.querySelectorAll<HTMLElement>("button, input"))
								control.removeAttribute("aria-disabled");
							refused(
								error instanceof Error && error.message
									? error.message
									: t("The address could not be made. Try again."),
							);
						},
					);
				},
				cardAbort.signal,
			);
			body.push(...parts.body);
			actions.push(
				...parts.actions,
				pill(t("Skip"), () => answer("declined"), "quiet", busy),
			);
		} else if (open || vote) {
			const send = () => {
				const values = [...chosen];
				if (values.length) answer("answered", { values });
			};
			// With pictures, the options without a box of their own are these pills under the boxes.
			const optionButtons = options
				.filter((option) => !boxed(option))
				.map((option) => {
					const element = pill(
						option.label,
						() => {
							if (vote) {
								vote.pick?.(option.value);
								return;
							}
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
					if (multi && !vote) element.setAttribute("aria-pressed", "false");
					if (option.description) element.title = option.description;
					element.dataset.optionValue = option.value;
					if (vote && !vote.pick) element.disabled = true;
					return element;
				});
			const pickBox =
				vote && !vote.pick
					? null
					: (option: QuestionOption, box: HTMLButtonElement) => {
							if (vote) {
								vote.pick?.(option.value);
								return;
							}
							if (!multi) {
								answer("answered", { values: [option.value] });
								return;
							}
							if (chosen.has(option.value)) chosen.delete(option.value);
							else chosen.add(option.value);
							box.setAttribute("aria-pressed", String(chosen.has(option.value)));
							box.classList.toggle("is-chosen", chosen.has(option.value));
						};
			body.push(
				visual
					? visualChoices(
							pictured,
							context,
							pickBox,
							chosen,
							busy,
							multi && !vote,
							optionButtons.length
								? h("div", { class: "interaction-options choice-others" }, ...optionButtons)
								: null,
						)
					: h("div", { class: "interaction-options" }, ...optionButtons),
			);
			const field =
				custom && !vote
					? (h("input", {
							type: "text",
							class: "interaction-field",
							placeholder: t("Something else…"),
							"aria-label": t("Your own answer"),
							onkeydown: (event: KeyboardEvent) => {
								if (event.key !== "Enter") return;
								event.preventDefault();
								sendOwn();
							},
						}) as HTMLInputElement)
					: null;
			const sendOwn = () => {
				const value = field?.value.trim();
				if (value) answer("answered", { values: [value] });
			};
			// In a thread the field has a Send of its own, live once something is typed: Enter is not the only way. A
			// question that takes several answers has its Send beside the field already.
			let own: HTMLElement | null = field;
			if (field && asking && !multi) {
				const sendOwnButton = h(
					"button",
					{ type: "button", class: "interaction-send", "aria-label": t("Send"), disabled: true, onclick: sendOwn },
					icon("send"),
				) as HTMLButtonElement;
				field.addEventListener("input", () => {
					sendOwnButton.disabled = !field.value.trim();
				});
				own = h("span", { class: "interaction-own" }, field, sendOwnButton);
			}
			const sendButton = multi && !vote ? pill(t("Send"), send, "primary", busy) : null;
			actions.push(own, sendButton, vote ? null : pill(t("Skip"), () => answer("declined"), "quiet", busy));
		}
	} else if (request.surface === "takeover") {
		const instruction = typeof request.payload.instruction === "string" ? request.payload.instruction : "";
		if (instruction) body.push(h("p", { class: "interaction-text" }, instruction));
		if (open) {
			actions.push(
				// Open computer takes the member to the agent's computer, where they do what the card asks as it is shared:
				// nothing begins private typing in the web any more (Jonas, 14 Nov 2026). I'm done says it is done.
				context.openComputer ? pill(t("Open computer"), context.openComputer, "primary", busy) : null,
				pill(t("I'm done"), () => answer("handed_back"), context.openComputer ? "secondary" : "primary", busy),
				pill(t("Skip"), () => answer("dismissed"), "quiet", busy),
			);
		}
	} else if (request.surface === "secret") {
		const purpose = typeof request.payload.purpose === "string" ? request.payload.purpose : "";
		if (purpose) body.push(h("p", { class: "interaction-text" }, purpose));
		// A coding value (20260930693000): an environment variable the agent's coding sessions get, so the card says so
		// instead of "the agent never sees it".
		const coding = request.payload.connectorId === "environment";
		const repository = typeof request.payload.repository === "string" ? request.payload.repository : "";
		const variable = typeof request.payload.name === "string" ? request.payload.name.toUpperCase() : "";
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
					` ${
						coding
							? repository && context.savesForCompany
								? t(
										"Encrypted in the company vault. Coding sessions in {repository} get it as {variable}; it never shows in the chat.",
										{ repository, variable },
									)
								: t(
										"Saved as your own in the company vault: your coding sessions in every repository get it as {variable}. It never shows in the chat.",
										{ variable },
									)
							: t("Encrypted in the company vault. The agent never sees the value, only that it was saved.")
					}`,
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

	// What the agent asked stands together; a visual choice's pictures stand under it, as wide as the card.
	const pictures = body.filter((part) => part?.classList.contains("interaction-choices"));
	card = h(
		"article",
		{
			class: `interaction-card surface-${request.surface} state-${state}${exchange ? " is-exchange" : ""}${asking || reworking || vote ? " is-asking" : ""}${reworking ? " is-reworking" : ""}${vote ? " is-voting" : ""}`,
			dataset: {
				interactionId: item.id,
				surface: request.surface,
				state,
				...(asking ? { sentAt: item.createdAt } : {}),
			},
			"aria-label": t("{kind} from {name}: {title}", {
				kind: t(SURFACE_LABEL[request.surface]),
				name: context.agentName,
				title: request.title,
			}),
		},
		h(
			"div",
			{
				class: `interaction-ask${exchange ? " bubble" : ""}`,
				...(exchange ? { dataset: { sentAt: item.createdAt } } : {}),
			},
			// A card that waits for the member in a thread is headed by who asks: the label row is then a screen reader's.
			asking || reworking || vote
				? h(
						"div",
						{ class: "interaction-call" },
						context.figure
							? h("span", { class: "interaction-figure" }, context.figure())
							: h("span", { class: "interaction-dot", "aria-hidden": "true" }),
						h(
							"strong",
							null,
							...named(
								reworking
									? t("{name} is reworking this", { name: NAME_MARK })
									: vote && !vote.own
										? t("{name} asks {member}", { name: NAME_MARK, member: vote.answerer })
										: request.surface === "question"
											? t("{name} asks you", { name: NAME_MARK })
											: t("{name} needs you", { name: NAME_MARK }),
								context.agentName,
							),
						),
					)
				: null,
			h(
				"header",
				// Who asks, when, and the card's state. In a thread, and in the questions dock, that already stands over
				// the card: the row is then a screen reader's alone.
				{
					class: `interaction-heading${exchange || asking || reworking || vote || context.inDock === true ? " visually-hidden" : ""}`,
				},
				h("span", { class: "interaction-kind" }, t(SURFACE_LABEL[request.surface])),
				h("span", { class: "interaction-from" }, `${context.agentName} · ${fmtTime(item.createdAt)}`),
				badge(t(STATE_LABEL[state]), stateTone),
			),
			context.round && state === "waiting" ? roundLine(context.round, context) : null,
			h("h3", { class: "interaction-title" }, request.title),
			reworking ? null : words,
			...body.filter((part) => !pictures.includes(part)),
		),
		...pictures,
		...result,
		actions.some(Boolean) ? h("div", { class: "interaction-actions" }, ...actions) : null,
	);
	return card;
}
