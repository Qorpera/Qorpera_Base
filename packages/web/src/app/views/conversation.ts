import { companyPathKey } from "@qorpera/cloud-client/company-state-files";
import { type CodingSession, codingSessionGoing } from "../../cloud/coding-session.ts";
import type { EmailDraftAction, EmailDraftContent } from "../../cloud/email-drafts.ts";
import {
	type InterfaceChange,
	type InterfaceChangeSubject,
	interfaceChangeUndoable,
} from "../../cloud/interface-changes.ts";
import { type MessageErase, MessageEraseError } from "../../cloud/message-erases.ts";
import { type MessageQuote, QUOTES_MAX } from "../../cloud/quotes.ts";
import {
	ACTION_REVIEW_SCHEMA,
	type ActionReviewAnswer,
	type ActionReviewCard,
	actionReviewCard,
	answersActionReview,
} from "../../cloud/review-rules.ts";
import { sessionAttachmentProblem } from "../../cloud/session-attachments.ts";
import type { TranscriptCard, TranscriptItem, TranscriptMessage, TranscriptPeerLink } from "../../cloud/transcript.ts";
import type { HostedSession, HostedStaffAgent, JsonValue } from "../../cloud/types.ts";
import { AGENT_LOOK, activityCaption, syncCaption } from "../../ui/agent-activity.ts";
import { AttachmentTray, attachmentProblemText } from "../../ui/attachments.ts";
import {
	type ActionReviewDraft,
	authorizationData,
	authorizationRequestId,
	renderActionReviewCard,
	renderAuthorizationCard,
} from "../../ui/authorization-card.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { CodingSessionSlot, codingSessionLine, harnessMark } from "../../ui/coding-session.ts";
import { CodingSessionThreadView } from "../../ui/coding-session-thread.ts";
import { menuPoint, openContextMenu } from "../../ui/context-menu.ts";
import {
	conversationTimestampLabel,
	conversationTimestampTitle,
	needsConversationTimestamp,
	parseConversationTimestamp,
} from "../../ui/conversation-timestamps.ts";
import { confirmDialog, fmtTime, h, icon, notice, personAvatar, replace } from "../../ui/dom.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import { renderInteractionCard } from "../../ui/interaction-card.ts";
import {
	type InterfaceUndoState,
	interfaceChangeText,
	renderInterfaceChangeLine,
} from "../../ui/interface-change-line.ts";
import { matchesKey } from "../../ui/keys.ts";
import { markdownBubbles } from "../../ui/markdown.ts";
import { findMentions, type MentionTarget, matchTargets, mentionParts, mentionQuery } from "../../ui/mentions.ts";
import { foldFrom, playOnce } from "../../ui/motion.ts";
import { presentationDay, presentationLocale, presentationTimeZone, t, timeZoneOption } from "../../ui/preferences.ts";
import { renderProposalCard } from "../../ui/proposal-card.ts";
import { quietScroll } from "../../ui/quiet-scroll.ts";
import { ReceivedAttachments } from "../../ui/received-attachments.ts";
import {
	manageUsageLink,
	planUsageLimitReason,
	runFailureCard,
	runFailureInterrupted,
	runFailureReason,
} from "../../ui/run-failure.ts";
import { uiScale } from "../../ui/scale.ts";
import { composerSkeleton, messagesSkeleton, threadIdentitySkeleton } from "../../ui/skeleton.ts";
import { markSkillNames, SkillMentions } from "../../ui/skill-mentions.ts";
import { type AgentState, answersInteraction, type CompanyController, type ConversationState } from "../company.ts";
import { type QuotePiece, quotePieces } from "../quotes.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import { AgentDetails } from "./agent-details.ts";
import { ComposerModels } from "./composer-models.ts";
import {
	type FieldEdits,
	FieldHistory,
	type FieldState,
	type HistoryStep,
	historyRun,
	historyStep,
	keepCaretOutOfQuotes,
	watchEdits,
	watchHistory,
} from "./composer-quotes.ts";
import { type ComputerPanel, ComputerPanels } from "./computer.ts";
import { GroupDetails } from "./group-details.ts";
import { InterfacePreview, proposedSave } from "./interface-preview.ts";
import { PairTranscriptView } from "./pair-transcript.ts";
import { SessionExecutionView } from "./session-execution.ts";
import { SessionRunView } from "./session-run.ts";
import { SharedDrafts } from "./shared-drafts.ts";

/* How often the thread re-reads its coding sessions while one is still going: the
 * header's figures follow them. Nothing is read once they all settled. */
const CODING_POLL_WORKING_MS = 2_500;
const CODING_POLL_WAITING_MS = 6_000;
const CODING_POLL_HIDDEN_MS = 20_000;

// Popup dismissal lasts for this company controller, including conversation navigation.
// It does not settle or discard work whose outcome still needs review.
const dismissedRunNotifications = new WeakMap<CompanyController, Set<string>>();

/** One transcript item as the thread drew it. The element is kept while its key (everything the
 * item shows but its times) and its time key are the same, so a new message adds one node and the
 * rest stay as they are; a change is made in place where that is safe (#renderMessages). */
interface DrawnItem {
	key: string;
	/** How the item's times read: the zone, and each moment's day against today. */
	time: string;
	element: HTMLElement;
	/** The session input a member's message stood for while it was on its way (the browser's copy,
	 * then the cloud's waiting input): the next form of that message takes the element over. */
	input?: string | undefined;
	/** A message's parts, so a change redraws only the part that changed. */
	message?: MessageParts;
}

/** A node of the thread by its moment, and the day separator it stands under, if any. */
interface TimestampRow {
	date: Date;
	node: HTMLElement;
	separator?: HTMLTimeElement;
	/** A line that holds messages over a while (messages with coworkers in a row): its last one's moment. */
	last?: Date;
}

interface MessageParts {
	author?: { text: string; node: HTMLElement };
	body: { key: string; nodes: HTMLElement[] };
	/** Received files: disposed with their part (it may hold an open preview). */
	files?: { key: string; view: ReceivedAttachments };
	caption?: HTMLElement;
}

/** The member's erase of one message here, as the line above the composer tells it: which message (its author and
 * time, never a file), how far the erase got, and why it stopped if it did. */
interface EraseLine {
	readonly what: { readonly author: string; readonly time: string };
	erase?: MessageErase;
	failure?: string;
}

/** Waits `ms`, or less if `signal` aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Why an erase could not be asked for, in the member's words. */
function eraseFailure(error: unknown, what: EraseLine["what"]): string {
	const status = error instanceof MessageEraseError ? error.status : null;
	if (status === 401 || status === 403) return t("Only an owner or admin can erase messages.");
	if (status === 404) return t("The message from {author} at {time} can't be erased.", what);
	if (status === 423) return t("The company is paused, so no message can be erased now.");
	return t("Could not erase the message from {author} at {time}. Try again.", what);
}

/** Elements that hold a handler of their own or what the member typed or opened. */
const INTERACTIVE = "button, input, select, textarea, a[href], details, [contenteditable]";

/** An element without controls: nothing in it acts on what it showed when it was drawn. */
function inert(element: Element): boolean {
	return !element.matches(INTERACTIVE) && !element.querySelector(INTERACTIVE);
}

/** The same elements and text nodes in the same places. A figure counts as one node: its
 * motion draws inside it on its own. */
function sameShape(a: Node, b: Node): boolean {
	if (a.nodeName !== b.nodeName) return false;
	if (a instanceof Element && a.classList.contains("figure")) return true;
	if (a.childNodes.length !== b.childNodes.length) return false;
	for (let index = 0; index < a.childNodes.length; index++)
		if (!sameShape(a.childNodes[index]!, b.childNodes[index]!)) return false;
	return true;
}

/** Makes `target` read as `source`, which has its shape (sameShape): text node by text node, so
 * the live log hears only the words that changed. With `labelsOnly`, only titles and labels of
 * elements are copied besides text, so a control keeps its state (pressed, open, busy). */
function copyShape(target: Node, source: Node, labelsOnly: boolean): void {
	if (target instanceof Text) {
		if (target.data !== (source as Text).data) target.data = (source as Text).data;
		return;
	}
	if (!(target instanceof Element) || !(source instanceof Element) || target.classList.contains("figure")) return;
	for (const name of labelsOnly ? ["title", "aria-label"] : target.getAttributeNames())
		if (!source.hasAttribute(name)) target.removeAttribute(name);
	for (const name of labelsOnly ? ["title", "aria-label"] : source.getAttributeNames()) {
		const value = source.getAttribute(name);
		if (value !== null && target.getAttribute(name) !== value) target.setAttribute(name, value);
	}
	for (let index = 0; index < target.childNodes.length; index++)
		copyShape(target.childNodes[index]!, source.childNodes[index]!, labelsOnly);
}

/** A card that has its answer: an approval folded to its outcome, a question answered or declined. */
/** How long an answered card settles (styles/motion.css, the longest of its parts). */
const SETTLING = 1500;
/** Its parts (not the fold, which restarts from the height it had got to). */
const SETTLING_PARTS = new Set(["decided-edge", "decided-line", "decided-mark", "draw-stroke", "motion-hold"]);
const DECIDED = [
	".action-review-card.is-folded",
	".interaction-card:is(.state-answered, .state-declined)",
	".auth-card:not(.action-review-card):is([data-decision-state='approved'], [data-decision-state='declined'], [data-decision-state='denied'])",
].join(", ");

/** Puts `children` in `parent` in this order, moving only what is out of place and removing the
 * rest: a node that stays is never taken out, so a live log does not read it again. */
function placeChildren(parent: Element, children: readonly Node[]): void {
	const wanted = new Set(children);
	for (const child of [...parent.childNodes]) if (!wanted.has(child)) child.remove();
	let cursor = parent.firstChild;
	for (const node of children) {
		if (node !== cursor) parent.insertBefore(node, cursor);
		cursor = node.nextSibling;
	}
}

export { renderAuthorizationCard } from "../../ui/authorization-card.ts";

/* One conversation over the canonical transcript. Rendering follows
 * DECISIONS.md "Transcript projection rules": member inputs and agent sends
 * only. Composer drafts remain local until a message adapter is supplied. */

export class ConversationView {
	readonly el: HTMLElement;
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #header = h("header", { class: "thread-header" });
	/** The thread's scroller: "Show earlier", the older items it read, then the live log. */
	readonly #messages = h("div", { class: "messages" });
	/** The live log: the items the thread opened with and everything that comes after. A screen
	 * reader hears what is added here, so older items never come in here. */
	readonly #log = h("div", { class: "messages-log", role: "log", "aria-live": "polite" });
	/** Older items "Show earlier" read, above the live log and outside it: they are history, not news. */
	readonly #older = h("div", { class: "thread-older" });
	/** The first sequence of the live log: the oldest item the thread showed first. */
	#liveFrom: number | undefined;
	readonly #status = h("div", { class: "thread-status" });
	readonly #composer: HTMLTextAreaElement;
	/** "/" in the composer: the conversation's skills, and their names in blue. */
	readonly #skills: SkillMentions;
	readonly #send: HTMLButtonElement;
	#stopMode = false;
	#cannotSend = true;
	#submitting = false;
	#working = false;
	#agentState: AgentState = "idle";
	#activityKey = "";
	readonly #composerWrap: HTMLElement;
	/** Where the composer will stand while the company still opens. */
	#composerPlaceholder: HTMLElement | undefined;
	/** The messages' placeholder, one per load, so the log does not read it out again on each redraw. */
	#messagesPlaceholder: HTMLElement | undefined;
	readonly #composerShell: HTMLElement;
	/** Other members' unsent messages above the composer, and who writes in this member's own. */
	readonly #sharedDrafts: SharedDrafts;
	/** Names to mention, shown while "@" and the start of a name are typed. */
	readonly #mentionPicker: HTMLElement;
	#mention: { start: number; end: number; options: MentionTarget[]; active: number } | undefined;
	/** In a group chat, which agents will answer the message being written. */
	readonly #mentionNote = h("p", { class: "composer-mention-note", role: "status", hidden: true });
	/** While the draft holds quotes of outside content: that they travel as quoted, never as the member's words. */
	readonly #quoteNote = h("p", { class: "composer-quote-note", role: "status", hidden: true });
	/** The quotes the field's copy last set apart, so a change in them alone redraws it. */
	#piecesShown = "[]";
	/** What each edit of the composer replaced, and its own undo history (composer-quotes.ts). */
	readonly #edits: FieldEdits;
	readonly #history: FieldHistory;
	/** The draft change (ConversationState.draftEpoch) the history last started from. */
	#historyEpoch = 0;
	readonly #attachments: AttachmentTray;
	readonly #more: HTMLButtonElement;
	readonly #menu: HTMLElement;
	readonly #menuMain: HTMLElement;
	readonly #models: ComposerModels;
	readonly #attach: HTMLButtonElement;
	readonly #attachNote: HTMLElement;
	readonly #identity: HTMLButtonElement;
	/** The coding sessions still going, beside the agent in the header. */
	readonly #codingSlots = h("div", { class: "thread-coding-sessions" });
	/** The other members who have this conversation open right now. */
	readonly #here = h("div", { class: "thread-presence", role: "group", hidden: true });
	#hereKey = "";
	readonly #codingSlotViews = new Map<string, CodingSessionSlot>();
	#codingPoll: ReturnType<typeof setTimeout> | undefined;
	/** A read is on its way; the next one is scheduled when it lands, never beside it. */
	#codingReading = false;
	/** Reads that failed in a row; each one doubles the wait, up to eight times. */
	#codingFailures = 0;
	readonly #computer: HTMLButtonElement;
	readonly #navigation: HTMLButtonElement;
	readonly #body: HTMLElement;
	readonly #conversationPane: HTMLElement;
	readonly #lifetime = new AbortController();
	readonly #notificationSignal: AbortSignal;
	readonly #actions: WorkspaceActions;
	/** Undo of an agent's interface change, by its commit, while the member is in this thread. */
	readonly #undos = new Map<string, InterfaceUndoState>();
	/** Each message drawn in the thread: what it is and who wrote it, for its right-click menu. */
	readonly #messageItems = new WeakMap<Element, { item: TranscriptMessage; author: string; mine: boolean }>();
	/** The member's latest erase of a message here, from the ask until it is done or fails (summary trees M3c). */
	#erase: EraseLine | undefined;
	readonly #run: SessionRunView | undefined;
	readonly #execution: SessionExecutionView | undefined;
	#details: AgentDetails | GroupDetails | undefined;
	/** The company's open computers; this thread shows its agent's while the member is here. */
	readonly #panels: ComputerPanels;
	readonly #ownPanels: boolean;
	#panel: ComputerPanel | undefined;
	/** The transcript of this agent and a coworker, laid over the thread from a chip. */
	#pair: PairTranscriptView | undefined;
	/** The chip that opened the transcript; focus returns there when it closes. */
	#pairOpener: HTMLElement | undefined;
	#headerKey = "";
	#renderedKey = "";
	#stickToBottom = true;
	/** Where the last pin that moved the thread put it. Its scroll event arrives a frame
	 * later, when the pane may already have shrunk (the composer or a notice above it
	 * appeared in the same task); that event is not the member scrolling away. Armed
	 * only by a pin that changed the position, so it is consumed by exactly that event
	 * and never lingers to swallow a real scroll. */
	#pinnedTop = -1;
	/** Re-reads the scroll position for the hidden-bar fade after a programmatic scroll. */
	#refreshFade: () => void = () => {};
	/** Re-pins the thread to its end when the message pane gets its size: the first
	 * render happens before the view is in the page, and a pane that shrinks or
	 * grows (window, computer panel, composer) must keep showing the latest message. */
	readonly #sizes: ResizeObserver | undefined;
	readonly #unsubscribe: (() => void)[] = [];
	#disposed = false;
	#statusKey = "";
	/** A failed run, shown as one line right above the composer, in the same band as the company notices. */
	readonly #runNotification = h("div", { class: "thread-run-failure", hidden: true });
	#runNotificationKey = "";
	/** An approval card's Always allow editor, by review id: kept across re-renders. */
	readonly #reviewDrafts = new Map<string, ActionReviewDraft>();
	/** A waiting approval card's preview of the pages its save would leave (I10), by review id: kept across re-renders
	 * and drawn again as the folder is read. Null: its call saves no page. */
	readonly #previews = new Map<string, InterfacePreview | null>();
	/** The approval card to give focus after the thread redraws (it was just answered). */
	#focusReview: string | undefined;
	/** Every item of the last render by its id: a redraw keeps the nodes of unchanged items. */
	#drawn = new Map<string, DrawnItem>();
	/** The working figure's row and the empty thread's line, kept while they read the same. */
	#activityRow: { key: string; element: HTMLElement } | undefined;
	#emptyRow: HTMLElement | undefined;
	/** The thread has shown its first messages: what joins the log after this comes in moving. */
	#filled = false;
	/** "Show earlier" at the top of a thread that has not read all its history yet. */
	readonly #earlierButton: HTMLButtonElement;
	readonly #earlierNote = h("p", { class: "thread-earlier-note", role: "status", hidden: true });
	readonly #earlier: HTMLElement;
	/** Says how many older messages "Show earlier" brought, which come in outside the live log. */
	readonly #earlierStatus = h("p", { class: "visually-hidden", role: "status" });
	/** "Show earlier" was reading at the last render, and the sequence of the oldest item then. */
	#earlierWasLoading = false;
	#oldestSequence: number | undefined;
	/** A coding session opened as its own thread over this one, from its line or its
	 * figure in the header; focus returns to the opener when it closes. */
	#codingThread: { workerId: string; view: CodingSessionThreadView } | undefined;
	readonly #timestampTimer: number;
	#timestampRows: TimestampRow[] = [];
	/** The clock (#clock) the day separators were last labelled with. */
	#timestampClock = "";
	/** The day each shown moment falls on in #daysZone, so a redraw need not work it out again. */
	readonly #days = new Map<string, string>();
	#daysZone = "";

	constructor(
		company: CompanyController,
		sessionId: string,
		actions: WorkspaceActions = {},
		toggleNavigation?: () => void,
	) {
		this.#company = company;
		this.#notificationSignal = AbortSignal.any([this.#lifetime.signal, company.signal]);
		this.#sessionId = sessionId;
		this.#actions = actions;
		this.#ownPanels = !actions.computerPanels;
		this.#panels = actions.computerPanels ?? new ComputerPanels(actions.computer, company.signal);
		this.#run = actions.runControl
			? new SessionRunView(
					actions.runControl,
					sessionId,
					AbortSignal.any([this.#lifetime.signal, company.signal]),
					() => this.#syncSend(),
				)
			: undefined;
		this.#execution = actions.nativeSubscription
			? new SessionExecutionView(
					company,
					sessionId,
					actions.nativeSubscription,
					() => this.update(),
					AbortSignal.any([this.#lifetime.signal, company.signal]),
				)
			: undefined;
		this.#composer = h("textarea", {
			class: "composer-input",
			rows: 1,
			placeholder: t("Message…"),
			"aria-label": t("Message"),
			onkeydown: (event: KeyboardEvent) => {
				if (this.#mentionKey(event)) return;
				if (this.#skills.keydown(event)) return;
				if (matchesKey(event, "accept") && !event.shiftKey) {
					event.preventDefault();
					this.#submit();
				}
			},
			oninput: (event: Event) => {
				// The browser applied its own undo or redo, which it would not let the page cancel: the composer's own
				// history answers instead (composer-quotes.ts, watchHistory).
				const which = historyStep(event);
				if (which) {
					this.#stepHistory(which);
					return;
				}
				// A change that reached into a quote removes the whole quote; the field shows what is kept. The field's
				// own account of what it replaced tells a quote pasted over another from words typed inside it.
				const composer = this.#composer;
				this.#followHistory();
				const before = company.conversation(sessionId).get().draft ?? "";
				const caret = composer.selectionStart === composer.selectionEnd ? composer.selectionEnd : undefined;
				const edit = this.#edits.take(event);
				const kept = company.editDraft(sessionId, composer.value, caret, edit);
				if (kept.text !== composer.value) {
					composer.value = kept.text;
					if (kept.caret !== undefined) composer.setSelectionRange(kept.caret, kept.caret);
				}
				this.#history.edited(before, this.#fieldState(), historyRun(edit, event));
				this.#edited();
			},
		});
		// Moving the caret with the keys or a click opens or closes the names as well.
		this.#composer.addEventListener("keyup", (event) => {
			if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) this.#updateMention();
		});
		this.#composer.addEventListener("click", () => this.#updateMention());
		this.#composer.addEventListener("blur", () => this.#closeMention());
		this.#mentionPicker = h("div", {
			class: "mention-picker",
			role: "listbox",
			id: `mention-picker-${sessionId}`,
			hidden: true,
			"aria-label": t("People and agents to mention"),
		});
		const skills = actions.skills;
		this.#skills = new SkillMentions(this.#composer, {
			load: skills
				? (signal) => {
						// An agent's own thread offers its own skills too; a group chat, the company's.
						const session = company.store.get().sessions.find((item) => item.sessionId === sessionId);
						return skills(this.#isRoom ? null : (session?.staffAgentId ?? null), signal);
					}
				: undefined,
			signal: this.#lifetime.signal,
			ownerName: () => {
				const session = company.store.get().sessions.find((item) => item.sessionId === sessionId);
				return company.staffById(session?.staffAgentId)?.displayName;
			},
			// The skills take the place of "···" and of the "@" names above the field; they never stand
			// together. (Opening "···" moves focus off the field, which closes the skills.)
			opened: () => {
				if (!this.#menu.hidden) this.#setMenu(false, false);
				this.#closeMention();
			},
			// Messages already written mark the names of skills once the list is known: through a
			// redraw, so the marks land with the messages (the live log reads nothing twice) and the
			// thread stays pinned to its end if a name re-wraps a line.
			listed: () => {
				this.#renderedKey = "";
				this.update();
			},
			quotes: () => this.#quotePieces(),
			replacing: (start, end) => this.#edits.declare(start, end),
		});
		keepCaretOutOfQuotes(this.#composer, () => this.#quotePieces(), this.#lifetime.signal);
		this.#edits = watchEdits(this.#composer, this.#lifetime.signal);
		this.#history = new FieldHistory(this.#fieldState());
		this.#historyEpoch = company.conversation(sessionId).get().draftEpoch ?? 0;
		watchHistory(this.#composer, this.#lifetime.signal, (which) => this.#stepHistory(which));
		this.#send = h(
			"button",
			{
				type: "button",
				class: "composer-send",
				"aria-label": t("Send message"),
				title: t("Send message"),
				onclick: () => (this.#stopMode ? this.#run?.stop() : this.#submit()),
			},
			icon("send"),
		);
		this.#attachments = new AttachmentTray(company.conversation(sessionId).get().attachments ?? [], (files) => {
			const hadFiles = Boolean(company.conversation(sessionId).get().attachments?.length);
			company.conversation(sessionId).set({ attachments: files });
			this.#autosize();
			this.update();
			if (hadFiles && !files.length && !this.#composer.disabled) this.#composer.focus();
		});
		const fileInput = h("input", { type: "file", multiple: true, hidden: true, "aria-label": t("Attach files") });
		fileInput.onchange = () => {
			if (!this.#composer.disabled && !this.#noImages) this.#attachments.add([...(fileInput.files ?? [])]);
			fileInput.value = "";
		};
		this.#more = h(
			"button",
			{
				type: "button",
				class: "composer-more icon-button",
				title: t("Chat settings and more"),
				"aria-label": t("Chat settings and more"),
				"aria-haspopup": "menu",
				"aria-expanded": "false",
				onclick: () => this.#setMenu(this.#menu.hidden),
			},
			icon("more"),
		);
		this.#attach = h(
			"button",
			{
				type: "button",
				role: "menuitem",
				onclick: () => {
					this.#setMenu(false);
					if (!this.#noImages) fileInput.click();
				},
			},
			icon("attach"),
			t("Attach files"),
		);
		this.#models = new ComposerModels(
			company,
			sessionId,
			actions.sessionModel,
			this.#notificationSignal,
			() => this.#setModelMenu(true),
			() => this.#setModelMenu(false),
			() => this.update(),
		);
		this.#attachNote = h(
			"p",
			{ class: "composer-menu-note", hidden: true },
			t("Images are not supported in group chats. Use Company File."),
		);
		this.#menuMain = h("div", null, this.#attach, this.#attachNote, this.#models.button);
		this.#menu = h(
			"div",
			{
				class: "composer-menu",
				role: "menu",
				hidden: true,
				tabindex: "-1",
				"aria-label": t("Chat settings and more"),
			},
			this.#menuMain,
			this.#models.el,
		);
		this.#menu.addEventListener("keydown", (event) => {
			if (matchesKey(event, "dismiss") || (matchesKey(event, "left") && !this.#models.el.hidden)) {
				event.preventDefault();
				event.stopPropagation();
				if (!this.#models.el.hidden) this.#setModelMenu(false);
				else this.#setMenu(false);
			} else if (matchesKey(event, "right") && document.activeElement === this.#models.button) {
				event.preventDefault();
				this.#setModelMenu(true);
			} else if (
				["next", "previous", "first", "last"].some((key) =>
					matchesKey(event, key as "next" | "previous" | "first" | "last"),
				)
			) {
				event.preventDefault();
				const page = this.#models.el.hidden ? this.#menuMain : this.#models.el;
				const controls = [...page.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])")];
				const current = controls.indexOf(document.activeElement as HTMLButtonElement);
				const index = matchesKey(event, "first")
					? 0
					: matchesKey(event, "last")
						? controls.length - 1
						: (current + (matchesKey(event, "previous") ? -1 : 1) + controls.length) % controls.length;
				controls[index]?.focus();
			} else if (matchesKey(event, "tab")) {
				this.#setMenu(false, false);
			}
		});
		this.#composerShell = h(
			"div",
			{ class: "composer-shell" },
			this.#attachments.el,
			this.#skills.field,
			this.#more,
			this.#send,
			fileInput,
			this.#menu,
			this.#mentionPicker,
			this.#skills.menu,
		);
		this.#composerShell.addEventListener("paste", (event) => {
			if (this.#composer.disabled) return;
			const files = [...(event.clipboardData?.files ?? [])];
			if (files.length) {
				event.preventDefault();
				if (!this.#noImages) this.#attachments.add(files);
			}
		});
		this.#composerShell.addEventListener("dragover", (event) => {
			if (!this.#composer.disabled && event.dataTransfer?.types.includes("Files")) {
				event.preventDefault();
				if (!this.#noImages) this.#composerShell.classList.add("is-dragging");
			}
		});
		this.#composerShell.addEventListener("dragleave", () => this.#composerShell.classList.remove("is-dragging"));
		this.#composerShell.addEventListener("drop", (event) => {
			event.preventDefault();
			this.#composerShell.classList.remove("is-dragging");
			if (!this.#composer.disabled && !this.#noImages) this.#attachments.add([...(event.dataTransfer?.files ?? [])]);
		});
		this.#sharedDrafts = new SharedDrafts(company, sessionId, this.#composer, () => this.#autosize());
		this.#composerWrap = h(
			"footer",
			{ class: "composer" },
			this.#sharedDrafts.el,
			this.#composerShell,
			this.#mentionNote,
			this.#quoteNote,
			this.#attachments.status,
		);
		this.#identity = h("button", {
			type: "button",
			class: "thread-identity",
			"aria-label": t("Open agent details"),
			"aria-haspopup": "dialog",
			"aria-expanded": "false",
			onclick: () => this.#openDetails(),
		});
		this.#computer = h(
			"button",
			{
				type: "button",
				class: "icon-button thread-computer",
				title: t("Open agent computer"),
				"aria-label": t("Open agent computer"),
				"aria-expanded": "false",
				onclick: () => this.#toggleComputer(),
			},
			icon("computer"),
		);
		this.#navigation = h(
			"button",
			{
				type: "button",
				class: "mobile-navigation-toggle icon-button",
				"aria-label": t("Company navigation"),
				"aria-controls": "company-navigation",
				"aria-expanded": "false",
				hidden: !toggleNavigation,
				onclick: toggleNavigation,
			},
			icon("navigation"),
		);
		this.#header.append(this.#navigation, this.#identity, this.#codingSlots, this.#here, this.#computer);
		// An open title pill lies over the figures after it; over one of them it steps aside,
		// so that figure opens and a click there opens its own session.
		const yieldTo = (event: PointerEvent) => {
			const over = [...this.#codingSlots.children].find((slot) => {
				const box = slot.getBoundingClientRect();
				return (
					event.clientX >= box.left &&
					event.clientX < box.right &&
					event.clientY >= box.top &&
					event.clientY < box.bottom
				);
			});
			for (const slot of this.#codingSlots.children)
				slot.classList.toggle("coding-slot-yield", over !== undefined && slot !== over);
		};
		this.#codingSlots.addEventListener("pointermove", yieldTo, { signal: this.#lifetime.signal });
		this.#codingSlots.addEventListener(
			"pointerleave",
			() => {
				for (const slot of this.#codingSlots.children) slot.classList.remove("coding-slot-yield");
			},
			{ signal: this.#lifetime.signal },
		);
		this.#earlierButton = h(
			"button",
			{
				type: "button",
				class: "btn btn-small thread-earlier-button",
				onclick: () => void this.#company.loadEarlier(this.#sessionId),
			},
			t("Show earlier messages"),
		);
		this.#earlier = h("div", { class: "thread-earlier" }, this.#earlierButton, this.#earlierNote);
		this.#messages.append(this.#log);
		this.#refreshFade = quietScroll(this.#messages);
		this.#messages.addEventListener("scroll", () => {
			const { scrollTop, scrollHeight, clientHeight } = this.#messages;
			if (this.#stickToBottom && scrollTop === this.#pinnedTop) {
				this.#pinnedTop = -1;
				return;
			}
			this.#stickToBottom = scrollHeight - scrollTop - clientHeight < 48 * uiScale();
		});
		// A message's own menu: a right-click, or Shift+F10 or the menu key from a link in it. Also on an earlier page's
		// message, which stands outside the live log.
		this.#messages.addEventListener("contextmenu", (event) => this.#openMessageMenu(event));
		if (typeof ResizeObserver !== "undefined") {
			this.#sizes = new ResizeObserver(() => this.#pinToBottom());
			this.#sizes.observe(this.#messages);
		} else queueMicrotask(() => this.#pinToBottom()); // The application mounts the view right after construction.
		// A conversation opened comes in: the thread fades up in place (styles/motion.css).
		playOnce(this.#messages, "is-entering");
		this.#conversationPane = h(
			"div",
			{ class: "thread-conversation" },
			this.#header,
			this.#messages,
			this.#earlierStatus,
			this.#status,
			...(actions.notificationHost ? [actions.notificationHost] : []),
			this.#runNotification,
			this.#composerWrap,
		);
		this.#body = h("div", { class: "thread-body" }, this.#conversationPane);
		this.el = h("section", { class: "thread" }, this.#body);
		company.signal.addEventListener("abort", () => this.#runNotification.remove(), {
			once: true,
			signal: this.#lifetime.signal,
		});
		window.addEventListener("resize", () => this.#autosize(), { signal: this.#lifetime.signal });
		window.addEventListener("qorpera-rail-resize", () => this.#autosize(), { signal: this.#lifetime.signal });
		const refreshTimestamps = () => this.#refreshTimestamps();
		this.#timestampTimer = window.setInterval(refreshTimestamps, 60_000);
		window.addEventListener("focus", refreshTimestamps, { signal: this.#lifetime.signal });
		window.addEventListener("qorpera-language-change", refreshTimestamps, { signal: this.#lifetime.signal });
		window.addEventListener("qorpera-time-zone-change", refreshTimestamps, { signal: this.#lifetime.signal });
		document.addEventListener("visibilitychange", refreshTimestamps, { signal: this.#lifetime.signal });
		// Back on the tab: the next read of the header's coding figures comes at the visible pace, not the hidden tab's.
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.hidden || this.#codingPoll === undefined) return;
				clearTimeout(this.#codingPoll);
				this.#codingPoll = undefined;
				this.#watchCodingSessions();
			},
			{ signal: this.#lifetime.signal },
		);
		document.addEventListener(
			"click",
			(event) => {
				if (!this.#menu.hidden && !this.#composerShell.contains(event.target as Node)) this.#setMenu(false, false);
			},
			{ signal: this.#lifetime.signal },
		);
		company.setOpenSession(sessionId);
		this.#unsubscribe.push(
			company.conversation(sessionId).subscribe(() => this.update()),
			company.store.subscribe(() => this.update()),
		);
		this.update();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort();
		window.clearInterval(this.#timestampTimer);
		this.#sizes?.disconnect();
		this.#runNotification.remove();
		this.#details?.dispose();
		this.#closePair(false);
		// The computer stays open, and connected, for the next thread that shows it.
		if (this.#ownPanels) this.#panels.dispose();
		else this.#panel?.detach();
		this.#panel = undefined;
		this.#attachments.dispose();
		this.#sharedDrafts.dispose();
		for (const drawn of this.#drawn.values()) drawn.message?.files?.view.dispose();
		this.#drawn.clear();
		for (const preview of this.#previews.values()) preview?.dispose();
		this.#previews.clear();
		this.#actions.previewInterfaces?.(this, []);
		this.#closeCodingSession();
		clearTimeout(this.#codingPoll);
		for (const unsubscribe of this.#unsubscribe) unsubscribe();
		this.#company.setOpenSession(undefined);
	}

	get sessionId(): string {
		return this.#sessionId;
	}
	/** A team room: a room with no single bound agent. An agent's shared thread
	 * is a room too, but it behaves like the agent's own conversation here. */
	get #isRoom(): boolean {
		const session = this.#company.store.get().sessions.find((s) => s.sessionId === this.#sessionId);
		return isGroupChat(session);
	}

	/** A group chat on a cloud that keeps group chats text-only (before 20260928030000).
	 * While that is not known yet, images may be chosen; sending checks. */
	get #noImages(): boolean {
		return this.#isRoom && this.#company.groupChatImages() === false;
	}

	focus(): void {
		this.#autosize();
		this.#composer.focus();
	}

	/** Shows the latest message unless the reader has scrolled up to read older ones. */
	#pinToBottom(): void {
		if (this.#disposed || !this.#stickToBottom) return;
		const before = this.#messages.scrollTop;
		this.#messages.scrollTop = this.#messages.scrollHeight;
		const after = this.#messages.scrollTop;
		if (after !== before) this.#pinnedTop = after;
		this.#refreshFade();
	}
	setNavigationOpen(open: boolean): void {
		this.#navigation.setAttribute("aria-expanded", String(open));
	}

	#autosize(): void {
		// Start with compact geometry: collapsing after measuring an expanded
		// field changes its padding and can clip a two-line draft.
		this.#composerShell.classList.toggle("is-expanded", this.#attachments.count > 0);
		this.#composer.style.height = "auto";
		// The sizes come from the stylesheet, so they follow the app's scale: one line is the field's
		// min-height, the tallest draft its max-height. scrollHeight is a whole number, so one line
		// at 42 × 1.3 = 54.6 reads 55; round the line up before comparing.
		const field = getComputedStyle(this.#composer);
		const oneLine = Math.ceil(Number.parseFloat(field.minHeight) || 0);
		const tallest = Number.parseFloat(field.maxHeight) || Number.POSITIVE_INFINITY;
		this.#composerShell.classList.toggle(
			"is-expanded",
			this.#composer.scrollHeight > oneLine || this.#attachments.count > 0,
		);
		this.#composer.style.height = `${Math.min(this.#composer.scrollHeight, tallest)}px`;
		this.#composer.style.overflowY = this.#composer.scrollHeight > tallest ? "auto" : "hidden";
		// The shell is border-box: its height is the field's, the attachments' and its own padding and borders.
		const shell = getComputedStyle(this.#composerShell);
		const frame = [shell.paddingTop, shell.paddingBottom, shell.borderTopWidth, shell.borderBottomWidth].reduce(
			(sum, value) => sum + (Number.parseFloat(value) || 0),
			0,
		);
		this.#composerShell.style.height = `${this.#composer.getBoundingClientRect().height + frame + this.#attachments.el.getBoundingClientRect().height}px`;
		// A new size can show or hide the field's scrollbar, which moves where its lines wrap.
		this.#skills.sync();
	}

	/** Written messages show skill names as the composer does. Only message text is marked:
	 * markSkillNames leaves code and links alone, and marked text is not marked twice.
	 * Only bubbles drawn now: a kept one was marked with the same names (its key has them). */
	#markSkills(bubbles: readonly HTMLElement[]): void {
		const names = this.#skills.names();
		if (!names.size) return;
		for (const bubble of bubbles) markSkillNames(bubble, names);
	}

	/** What every shown time depends on besides the moment itself: the language, the zone
	 * and today's date ("10:04" today reads "Sep 28, 10:04" tomorrow). */
	#clock(): string {
		return `${presentationLocale()} ${presentationTimeZone()} ${presentationDay(new Date())}`;
	}

	#setMenu(open: boolean, restoreFocus = true): void {
		this.#menuMain.hidden = false;
		this.#models.el.hidden = true;
		this.#models.button.setAttribute("aria-expanded", "false");
		this.#menu.hidden = !open;
		this.#more.setAttribute("aria-expanded", String(open));
		if (open) {
			// A group chat's menu may hold no live control; the menu itself then takes focus so Escape still closes it.
			const first = this.#menuMain.querySelector<HTMLButtonElement>("button:not(:disabled):not([hidden])");
			(first ?? this.#menu).focus();
		} else if (restoreFocus) this.#more.focus();
	}

	#setModelMenu(open: boolean): void {
		if (open && this.#models.button.disabled) return;
		this.#menuMain.hidden = open;
		this.#models.el.hidden = !open;
		this.#models.button.setAttribute("aria-expanded", String(open));
		if (open) {
			this.#models.focus();
			void this.#models.refresh();
		} else this.#models.button.focus();
	}

	#openDetails(): void {
		const state = this.#company.store.get();
		const session = state.sessions.find((session) => session.sessionId === this.#sessionId);
		const agent = this.#company.staffById(session?.staffAgentId);
		if (this.#details) {
			this.#details.dialog.close();
			return;
		}
		if (this.#company.signal.aborted || state.accessLost || !state.team?.capabilities.read) return;
		if (!agent && !isGroupChat(session)) return;
		this.#identity.setAttribute("aria-expanded", "true");
		const closed = () => {
			this.#details = undefined;
			this.#identity.setAttribute("aria-expanded", "false");
		};
		this.#details = agent
			? new AgentDetails(this.#company, agent, this.#actions, closed, this.#identity, this.#lifetime.signal)
			: new GroupDetails(
					this.#company,
					this.#sessionId,
					closed,
					this.#identity,
					this.#lifetime.signal,
					this.#actions,
				);
	}

	/** Lay the two agents' transcript over this thread; the thread waits underneath.
	 * The coworker reads on the left, this thread's own agent on the right. */
	#openPair(pairSessionId: string, agentIds: readonly [string, string], opener: HTMLElement): void {
		this.#closePair(false);
		const view = new PairTranscriptView(this.#company, pairSessionId, agentIds, () => this.#closePair(true));
		this.#pair = view;
		this.#pairOpener = opener;
		this.#conversationPane.inert = true;
		this.#body.append(view.el);
		view.focus();
	}

	#closePair(refocus: boolean): void {
		const view = this.#pair;
		if (!view) return;
		this.#pair = undefined;
		const opener = this.#pairOpener;
		this.#pairOpener = undefined;
		view.dispose();
		this.#conversationPane.inert = false;
		if (!refocus) return;
		// The chip that opened it, or the same chip after a re-render, or any chip.
		const target =
			opener?.isConnected && this.#messages.contains(opener)
				? opener
				: ((opener && this.#sameChip(opener)) ?? this.#messages.querySelector<HTMLElement>(".peer-chip"));
		target?.focus({ preventScroll: true });
	}

	/** A coworker's chip as drawn again: the one for the same messages with that coworker, else any for
	 * that coworker, each on the same line first, as a line can split in two; else the line's first. */
	#sameChip(chip: HTMLElement): HTMLElement | undefined {
		const messageId = chip.closest<HTMLElement>(".peer-link")?.dataset.messageId;
		if (!messageId) return undefined;
		const pair = chip.dataset.pairSessionId;
		const links = new Set(chip.dataset.linkIds?.split(" "));
		const chips = [...this.#messages.querySelectorAll<HTMLElement>(".peer-link[data-message-id] .peer-chip")];
		const onLine = (other: HTMLElement) => other.closest<HTMLElement>(".peer-link")?.dataset.messageId === messageId;
		const samePair = (other: HTMLElement) => other.dataset.pairSessionId === pair;
		const sameLinks = (other: HTMLElement) =>
			samePair(other) && (other.dataset.linkIds?.split(" ") ?? []).some((id) => links.has(id));
		const first = (match: (other: HTMLElement) => boolean) =>
			chips.find((other) => onLine(other) && match(other)) ?? chips.find(match);
		return first(sameLinks) ?? first(samePair) ?? chips.find(onLine);
	}

	#toggleComputer(): void {
		if (this.#panel) {
			this.#panels.close(this.#panel.agentId);
			this.#panel = undefined;
			this.#autosize();
			this.#computer.setAttribute("aria-expanded", "false");
			this.#computer.focus();
			return;
		}
		const state = this.#company.store.get();
		const agent = this.#company.staffById(
			state.sessions.find((session) => session.sessionId === this.#sessionId)?.staffAgentId,
		);
		if (!agent) return;
		this.#showPanel(agent);
	}

	/** Record the member's answer to a card; the card shows it at once and the
	 * error, if any, above the composer with the other conversation notices. */
	async #answerInteraction(
		interactionId: string,
		outcome: Parameters<CompanyController["answerInteraction"]>[2],
		answer: Record<string, JsonValue> = {},
	): Promise<void> {
		try {
			await this.#company.answerInteraction(this.#sessionId, interactionId, outcome, answer);
		} catch {
			// The controller keeps the reason in the conversation state.
		}
	}

	/** Record an answer to an approval card of an agent's action; the card shows it at once. */
	async #answerActionReview(reviewId: string, answer: ActionReviewAnswer, ruleText?: string): Promise<void> {
		this.#focusReview = reviewId.toLowerCase();
		try {
			await this.#company.answerActionReview(this.#sessionId, reviewId, answer, ruleText);
			this.#reviewDrafts.delete(reviewId.toLowerCase());
		} catch {
			// The controller keeps the reason in the conversation state; a refused
			// Always allow keeps the rule as the member edited it.
		}
	}

	/** Discard one of the member's open proposals; its card leaves the thread once the cloud took it. */
	async #discardProposal(proposalId: string): Promise<void> {
		try {
			await this.#company.discardProposal(this.#sessionId, proposalId);
		} catch {
			// The controller keeps the reason in the conversation state.
		}
	}

	/** Undo an agent's interface change as the member; its line says how it went. One at a time per change. */
	async #undoInterfaceChange(change: InterfaceChange): Promise<void> {
		const undo = this.#actions.undoInterfaceChange;
		if (!undo || this.#undos.get(change.commitId)?.state === "sending") return;
		this.#undos.set(change.commitId, { state: "sending" });
		this.update();
		let state: InterfaceUndoState;
		try {
			state = { state: "answered", answer: await undo(change, this.#lifetime.signal) };
		} catch {
			state = { state: "failed" };
		}
		if (this.#lifetime.signal.aborted) return;
		this.#undos.set(change.commitId, state);
		this.update();
	}

	/** A message's menu: Erase, for an owner or admin, the roles the erase route takes (M3c). A message on its way or
	 * already erased has none, and with nothing to offer the browser's own menu stays. */
	#openMessageMenu(event: MouseEvent): void {
		const element = event.target instanceof Element ? event.target.closest<HTMLElement>("article.message") : null;
		const drawn = element ? this.#messageItems.get(element) : undefined;
		const role = this.#company.store.get().team?.role;
		if (
			!element ||
			!drawn ||
			drawn.item.pending ||
			drawn.item.erased ||
			!this.#actions.messageErases ||
			(role !== "owner" && role !== "admin")
		)
			return;
		event.preventDefault();
		const { item, author, mine } = drawn;
		const point = menuPoint(event, element);
		// Focus goes back to the link the menu was opened from, else to the message itself.
		const focused = document.activeElement;
		const opener = focused instanceof HTMLElement && element.contains(focused) ? focused : this.#focusable(element);
		openContextMenu({
			label: t("Message from {name}", { name: author }),
			x: point.x,
			y: point.y,
			items: [
				{
					label: t("Erase message"),
					icon: "trash",
					danger: true,
					select: () => void this.#eraseMessage(item, author, mine),
				},
			],
			opener,
			// The message is redrawn as it changes; focus goes back to the new one.
			findOpener: () => this.#threadMessage(item.id) ?? null,
		});
	}

	/** A message of the thread (the live log or an earlier page), ready for the keyboard. */
	#threadMessage(id: string): HTMLElement | undefined {
		const message = [...this.#messages.querySelectorAll<HTMLElement>("article.message")].find(
			(element) => element.dataset.messageId === id,
		);
		return message && this.#focusable(message);
	}

	/** Gives the keyboard to a message of the thread, or to the thread itself when the message is no longer there. */
	#focusMessage(id: string): void {
		const target = this.#threadMessage(id);
		if (target) target.focus({ preventScroll: true });
		else {
			this.#messages.tabIndex = -1;
			this.#messages.focus({ preventScroll: true });
		}
	}

	/** A message has no tab stop of its own; it takes focus only when given back to it. */
	#focusable(message: HTMLElement): HTMLElement {
		if (!message.hasAttribute("tabindex")) message.tabIndex = -1;
		return message;
	}

	/** Erase one message for the whole company once the member confirms. The line above the composer says how it goes,
	 * and the thread shows "(erased)" in its place once the cloud has blanked it (a full read, M3d). */
	async #eraseMessage(item: TranscriptMessage, author: string, mine: boolean): Promise<void> {
		const erases = this.#actions.messageErases;
		const signal = this.#lifetime.signal;
		// Mid-sentence, the member's own message is "from you", not "from You".
		const what = { author: mine ? t("you") : author, time: fmtTime(item.createdAt) };
		if (
			!erases ||
			!(await confirmDialog(
				t(
					"Erase the message from {author} at {time}? It is erased for everyone: the thread shows (erased) in its place, and the company's memory forgets it. This can't be undone.",
					what,
				),
				t("Erase"),
				true,
				undefined,
				signal,
			)) ||
			signal.aborted
		) {
			// Cancelled: the dialog gave focus back to the link or message the menu was on, or, if a redraw took that, the
			// message has it (the thread, if the message is gone).
			if (!signal.aborted && (!document.activeElement?.isConnected || document.activeElement === document.body))
				this.#focusMessage(item.id);
			return;
		}
		const line: EraseLine = { what };
		this.#erase = line;
		this.update();
		let erase: MessageErase;
		try {
			erase = await erases.request(this.#sessionId, item.id, signal);
		} catch (error) {
			if (signal.aborted || this.#erase !== line) return;
			line.failure = eraseFailure(error, what);
			this.update();
			return;
		}
		// Read again after 1, 2, 4… seconds, then every 30 seconds, until it is done or refused.
		let reread = false;
		for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
			if (signal.aborted || this.#erase !== line) return;
			// From `open` on the message is blank in the cloud: a full read draws it as "(erased)".
			if (!reread && erase.state !== "pending" && erase.state !== "refused") {
				reread = true;
				void this.#company.loadConversation(this.#sessionId);
			}
			line.erase = erase;
			this.update();
			if (erase.state === "done" || erase.state === "refused") return;
			await pause(wait, signal);
			if (signal.aborted || this.#erase !== line) return;
			try {
				erase = await erases.status(erase, signal);
			} catch (error) {
				const status = error instanceof MessageEraseError ? error.status : null;
				// Refused or gone for this member: say so once. Anything else is read again at the next turn.
				if (status === 401 || status === 403 || status === 404) {
					if (signal.aborted || this.#erase !== line) return;
					line.failure = t("Could not read how the erase of the message from {author} at {time} is going.", what);
					this.update();
					return;
				}
			}
		}
	}

	/** How the member's erase goes, in plain words: which message, where it is gone from so far, and each file at
	 * another path that still holds a copy (the one exception to showing changes rather than files: the member erases
	 * such a copy by its path). */
	#eraseNotice({ what, erase, failure }: EraseLine): HTMLElement {
		if (failure) return notice("danger", failure);
		const here = this.#company.profile.environmentId.toLowerCase();
		const copies = (erase?.copies ?? []).map(({ environmentId, path, live }) =>
			h(
				"div",
				{ class: "erase-copy" },
				environmentId === here
					? live
						? t("A copy stays in {path}.", { path })
						: t("A copy stays in the history of {path}, which is deleted.", { path })
					: live
						? t("A copy stays in {path} in another Company File.", { path })
						: t("A copy stays in the history of {path} in another Company File, where it is deleted.", { path }),
			),
		);
		switch (erase?.state) {
			case undefined:
			case "pending":
				return notice("neutral", t("Erasing the message from {author} at {time}…", what));
			case "refused":
				return notice(
					"danger",
					t(
						"The message from {author} at {time} was not erased: only an owner or admin can erase messages.",
						what,
					),
				);
			case "done":
				return copies.length
					? notice(
							"warn",
							h(
								"div",
								{},
								t(
									"Erased the message from {author} at {time} from the thread and from the company's memory, but not from files that hold a copy of it.",
									what,
								),
							),
							...copies,
						)
					: notice(
							"ok",
							t(
								"Erased the message from {author} at {time}: it is gone from the thread and from the company's memory.",
								what,
							),
						);
			default:
				return notice(
					"neutral",
					h(
						"div",
						{},
						t(
							"The message from {author} at {time} is erased from the thread. Clearing it from the company's memory…",
							what,
						),
					),
					...copies,
				);
		}
	}

	/** The preview of a waiting approval card's save (I10), made the first time the card is drawn; none when its call
	 * saves no page. */
	#previewOf(review: ActionReviewCard): InterfacePreview | undefined {
		let preview = this.#previews.get(review.reviewId);
		if (preview === undefined) {
			const save = proposedSave(review);
			preview = save ? new InterfacePreview(this.#company, review.reviewId, save) : null;
			this.#previews.set(review.reviewId, preview);
		}
		return preview ?? undefined;
	}

	/** Take over the agent's computer for a card: open its screen here and give it the keyboard. */
	#takeOver(agent: HostedStaffAgent): void {
		const panel = this.#panel ?? this.#showPanel(agent);
		panel?.focus();
	}

	/** Show the agent's computer here: the one already open, or one started now. */
	#showPanel(agent: HostedStaffAgent): ComputerPanel | undefined {
		const panel = this.#panels.open(agent);
		if (!panel) return undefined;
		this.#panel = panel;
		panel.attach(this.#body, () => this.#toggleComputer());
		this.#autosize();
		this.#computer.setAttribute("aria-expanded", "true");
		return panel;
	}

	/** One button: it sends a draft, and with nothing to send it stops the run the agent is on. */
	#syncSend(): void {
		// The run controller reports once while this view is still being built.
		if (this.#disposed || !this.#send) return;
		const empty = !this.#composer.value.trim() && !this.#attachments.count;
		const stop = empty && this.#working && (this.#run?.stoppable === true || this.#run?.stopping === true);
		if (stop !== this.#stopMode) {
			this.#stopMode = stop;
			replace(this.#send, stop ? h("span", { class: "composer-stop", "aria-hidden": "true" }) : icon("send"));
			this.#send.classList.toggle("stopping", stop);
		}
		const label = stop
			? t("Stop")
			: this.#actions.sendMessage
				? t("Send message")
				: t("Sending messages is not available yet");
		this.#send.title = label;
		this.#send.setAttribute("aria-label", stop ? t("Stop") : t("Send message"));
		this.#send.disabled = stop ? this.#run?.stopping === true : this.#submitting || this.#cannotSend;
	}

	/** Names that match the "@" being typed at the caret, shown above the composer. */
	#updateMention(): void {
		const composer = this.#composer;
		const targets =
			composer.disabled || composer.selectionStart !== composer.selectionEnd
				? []
				: this.#company.mentionTargets(this.#sessionId);
		const query = targets.length ? mentionQuery(composer.value, composer.selectionStart) : undefined;
		const options = query ? matchTargets(query.query, targets) : [];
		this.#renderMentionNote();
		if (!query || !options.length) {
			this.#closeMention();
			return;
		}
		const chosen = this.#mention?.options[this.#mention.active]?.id;
		this.#mention = {
			start: query.start,
			end: composer.selectionStart,
			options,
			active: Math.max(
				0,
				options.findIndex((option) => option.id === chosen),
			),
		};
		this.#renderMention();
	}

	#renderMention(): void {
		const mention = this.#mention;
		if (!mention) return;
		const optionId = (index: number) => `${this.#mentionPicker.id}-${index}`;
		replace(
			this.#mentionPicker,
			...mention.options.map((option, index) =>
				h(
					"div",
					{
						class: "mention-option",
						role: "option",
						id: optionId(index),
						"aria-selected": String(index === mention.active),
						// The composer keeps the keyboard: a click chooses without taking focus.
						onmousedown: (event: MouseEvent) => {
							event.preventDefault();
							this.#chooseMention(index);
						},
						onmousemove: () => {
							if (this.#mention && this.#mention.active !== index) {
								this.#mention.active = index;
								this.#renderMention();
							}
						},
					},
					option.kind === "agent"
						? agentFigure(this.#company.staffById(option.id), option.name, { size: 26 })
						: personAvatar(option.name, option.id),
					h("span", { class: "mention-name" }, option.name),
					h("small", null, option.kind === "agent" ? t("Agent") : t("Member")),
				),
			),
		);
		this.#skills.close();
		this.#mentionPicker.hidden = false;
		this.#composer.setAttribute("aria-autocomplete", "list");
		this.#composer.setAttribute("aria-controls", this.#mentionPicker.id);
		this.#composer.setAttribute("aria-activedescendant", optionId(mention.active));
	}

	#closeMention(): void {
		if (!this.#mention && this.#mentionPicker.hidden) return;
		this.#mention = undefined;
		this.#mentionPicker.hidden = true;
		replace(this.#mentionPicker);
		for (const name of ["aria-activedescendant", "aria-controls", "aria-autocomplete"])
			this.#composer.removeAttribute(name);
	}

	/** Keys while names are shown: arrows choose, Enter or Tab puts the name in, Escape closes. */
	#mentionKey(event: KeyboardEvent): boolean {
		const mention = this.#mention;
		if (!mention || event.isComposing) return false;
		const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
		if (step) {
			event.preventDefault();
			mention.active = (mention.active + step + mention.options.length) % mention.options.length;
			this.#renderMention();
			return true;
		}
		if ((matchesKey(event, "accept") || event.key === "Tab") && !event.shiftKey) {
			event.preventDefault();
			this.#chooseMention(mention.active);
			return true;
		}
		if (matchesKey(event, "dismiss")) {
			event.preventDefault();
			event.stopPropagation();
			this.#closeMention();
			return true;
		}
		return false;
	}

	#chooseMention(index: number): void {
		const option = this.#mention?.options[index];
		if (!option) return;
		const value = this.#composer.value;
		// The text may have changed under the list (a teammate's words): read where the name starts now.
		const end = this.#composer.selectionStart;
		const query = this.#composer.selectionEnd === end ? mentionQuery(value, end) : undefined;
		if (!query) {
			this.#closeMention();
			return;
		}
		const name = `@${option.name} `;
		this.#edits.declare(query.start, end);
		this.#composer.value = value.slice(0, query.start) + name + value.slice(end);
		const caret = query.start + name.length;
		this.#composer.focus();
		this.#composer.setSelectionRange(caret, caret);
		this.#closeMention();
		this.#composer.dispatchEvent(new Event("input", { bubbles: true }));
	}

	/** After an edit of the composer, or an undo or redo: its height, the shared draft, the names and the quote note. */
	#edited(): void {
		this.#autosize();
		this.#sharedDrafts.input();
		this.#updateMention();
		this.#renderQuoteNote();
	}

	/** The draft as the composer holds it now, with its records. */
	#fieldState(): FieldState {
		const conversation = this.#company.conversation(this.#sessionId).get();
		const caret = this.#composer.selectionEnd;
		return { text: conversation.draft ?? "", caret, records: conversation.quoteRecords ?? [] };
	}

	/** The draft changed from outside the member's own edits (the controller says so: draftReplaced): the undo
	 * history starts again from it. */
	#followHistory(): void {
		const epoch = this.#company.conversation(this.#sessionId).get().draftEpoch ?? 0;
		if (epoch === this.#historyEpoch) return;
		this.#historyEpoch = epoch;
		this.#history.restart(this.#fieldState());
	}

	/** Undo or redo from the composer's own history. A state it held needs no quote rules: its quotes are whole, and
	 * its records come back with it. */
	#stepHistory(which: HistoryStep): void {
		this.#followHistory();
		const store = this.#company.conversation(this.#sessionId);
		const current = this.#fieldState();
		const state = this.#history.step(which, current);
		const composer = this.#composer;
		if (!state) {
			// Nothing to undo or redo: the field keeps the text the composer holds (a browser may have changed it).
			if (composer.value !== current.text) composer.value = current.text;
			return;
		}
		composer.value = state.text;
		composer.setSelectionRange(state.caret, state.caret);
		store.set({ draft: state.text, quoteRecords: state.records });
		this.#edited();
	}

	/** The quotes of outside content in the text the composer shows: the draft's, while the field shows the draft. */
	#composerQuotes(): MessageQuote[] {
		const draft = this.#company.conversation(this.#sessionId).get().draft ?? "";
		return draft === this.#composer.value ? this.#company.draftQuotes(this.#sessionId) : [];
	}

	#quotePieces(): QuotePiece[] {
		return quotePieces(this.#composer.value, this.#composerQuotes());
	}

	/** While the draft holds quotes: that they go as quoted, when there are more than a message carries, and when one
	 * has lost a mark (it is neither saved nor sent then). */
	#renderQuoteNote(): void {
		const count = this.#composerQuotes().length;
		const shown = this.#composer.value === (this.#company.conversation(this.#sessionId).get().draft ?? "");
		const text =
			shown && this.#company.draftBroken(this.#sessionId)
				? t("A quote is missing one of its « » marks. Remove it, or put the mark back.")
				: count > QUOTES_MAX
					? t("A message can hold at most {count} quotes. Remove some to send it.", { count: QUOTES_MAX })
					: count
						? t("Text in «» is quoted from an email. Agents read it as quoted, never as your words.")
						: "";
		this.#quoteNote.hidden = !text;
		if (this.#quoteNote.textContent !== text) this.#quoteNote.textContent = text;
	}

	/** In a group chat the agents a message names answer and the others stay quiet: say so as it is written. A name
	 * inside a quote names nobody. */
	#renderMentionNote(): void {
		const targets = this.#company.mentionTargets(this.#sessionId);
		const named =
			targets.filter((target) => target.kind === "agent").length > 1
				? [
						...new Map(
							findMentions(this.#composer.value, targets, this.#composerQuotes())
								.filter((mention) => mention.target.kind === "agent")
								.map((mention) => [mention.target.id, mention.target.name]),
						).values(),
					]
				: [];
		const text = named.length
			? t("Only {names} will answer", {
					names: new Intl.ListFormat(presentationLocale(), { style: "long", type: "conjunction" }).format(named),
				})
			: "";
		this.#mentionNote.hidden = !text;
		if (this.#mentionNote.textContent !== text) this.#mentionNote.textContent = text;
	}

	/** Every name a message here may mention, this member's own included. */
	#shownMentionTargets(): MentionTarget[] {
		const me = this.#company.userId;
		const own = this.#company.store.get().team?.members.find((member) => member.userId === me)?.displayName;
		return [
			...this.#company.mentionTargets(this.#sessionId),
			...(own ? [{ kind: "member" as const, id: me, name: own }] : []),
		];
	}

	/** A member's message with its mentions set apart, this member's own name most of all, and its quotes of outside
	 * content shown as quoted. A name inside a quote names nobody. */
	#withMentions(text: string, quotes: readonly MessageQuote[] = []): (string | HTMLElement)[] {
		const me = this.#company.userId;
		const marks: { start: number; end: number; node: HTMLElement }[] = [];
		for (const part of mentionParts(text, this.#shownMentionTargets(), quotes))
			if (typeof part !== "string")
				marks.push({
					...part,
					node: h(
						"span",
						{
							class: part.targets.some((target) => target.kind === "member" && target.id === me)
								? "mention mention-me"
								: "mention",
						},
						text.slice(part.start, part.end),
					),
				});
		for (const piece of quotePieces(text, quotes))
			marks.push({
				start: piece.from,
				end: piece.to,
				node: h(
					"span",
					{ class: "message-quote", title: t("Quoted from an email") },
					text.slice(piece.from, piece.to),
				),
			});
		marks.sort((a, b) => a.start - b.start);
		const parts: (string | HTMLElement)[] = [];
		let at = 0;
		for (const mark of marks) {
			if (mark.start > at) parts.push(text.slice(at, mark.start));
			parts.push(mark.node);
			at = mark.end;
		}
		if (at < text.length) parts.push(text.slice(at));
		return parts;
	}

	#submit(): void {
		const text = this.#composer.value;
		if (
			this.#submitting ||
			(!text.trim() && !this.#attachments.count) ||
			this.#send.disabled ||
			!this.#actions.sendMessage
		)
			return;
		const state = this.#company.conversation(this.#sessionId).get();
		const files = [...(state.attachments ?? [])];
		const retry = state.retrySend;
		this.#submitting = true;
		this.#syncSend();
		void (async () => {
			try {
				// Reconcile a runtime account handoff before new input. An uncertain
				// retry retains its exact original request and account authority.
				if (this.#execution && !retry) await this.#execution.refresh();
				if (this.#disposed || this.#notificationSignal.aborted) return;
				this.update();
				const current = this.#company.conversation(this.#sessionId).get();
				const currentFiles = current.attachments ?? [];
				// Editing during the account check cancels this submission; no draft
				// or attachment is replaced, and a later click sends the edited input.
				if (
					this.#cannotSend ||
					this.#composer.value !== text ||
					current.retrySend !== retry ||
					files.length !== currentFiles.length ||
					files.some((file, index) => file !== currentFiles[index])
				)
					return;
				const sent = await this.#actions.sendMessage!(this.#sessionId, text, this.#lifetime.signal);
				if (sent && !this.#disposed) {
					if (!this.#isRoom) this.#run?.messageSent();
					void this.#execution?.refresh();
				}
			} catch {
				if (!this.#disposed && !this.#notificationSignal.aborted)
					this.#company
						.conversation(this.#sessionId)
						.set({ sendError: t("The message could not be confirmed. Try again.") });
			} finally {
				this.#submitting = false;
				if (!this.#disposed) this.update();
			}
		})();
		this.update();
	}

	update(): void {
		if (this.#disposed) return;
		const company = this.#company.store.get();
		const conversation = this.#company.conversation(this.#sessionId).get();
		const session = company.sessions.find((item) => item.sessionId === this.#sessionId);
		const agent = this.#company.staffById(session?.staffAgentId);
		const canWrite = company.team?.capabilities.write === true && session?.status === "open";
		const room = this.#isRoom;
		const noImages = this.#noImages;
		// A group chat has one model and effort for every agent in it.
		this.#models.update(
			Boolean(agent) || room,
			!canWrite || conversation.sending || this.#submitting || Boolean(conversation.retrySend),
			room,
		);
		this.#execution?.update();
		this.#run?.update(
			room || company.accessLost || !company.team?.capabilities.read ? undefined : session?.staffAgentId,
			canWrite,
		);
		const problem = sessionAttachmentProblem(conversation.attachments ?? []);
		const attachmentIssue =
			noImages && conversation.attachments?.length
				? t("Images are not supported in group chats. Use Company File.")
				: problem && attachmentProblemText(problem);
		// A post into a room (an agent's thread or a group chat) carries text: the cloud
		// refuses images without a message, so they wait for one.
		const needsText =
			typeof session?.executionScope?.roomId === "string" &&
			Boolean(conversation.attachments?.length) &&
			!conversation.draft?.trim();
		this.#attachments.sync(
			conversation.attachments ?? [],
			!canWrite || conversation.sending,
			noImages
				? t("Images are not supported in group chats. Use Company File.")
				: this.#actions.sendMessage
					? attachmentIssue
						? t("Attachments stay on this device. {issue}", { issue: attachmentIssue })
						: conversation.sending
							? t("Uploading images and sending message…")
							: needsText
								? t("Add a message to send with the images.")
								: t("Images stay on this device until you send. Up to 5 images, 8 MiB total.")
					: undefined,
		);
		// The agent's run is watched quietly; a change in who is working re-reads it.
		const activity = room ? undefined : this.#company.activityFor(session?.staffAgentId);
		const activityKey = `${activity?.runId ?? ""}:${activity?.activity ?? ""}`;
		if (activityKey !== this.#activityKey) {
			this.#activityKey = activityKey;
			void this.#run?.refresh();
		}
		this.#agentState = room ? "idle" : this.#company.agentState(session?.staffAgentId);
		this.#working = this.#agentState === "working" || this.#agentState === "writing";
		this.#renderHeader(session, agent);
		this.#renderHere();
		this.#renderCodingSlots(conversation.codingSessions ?? [], agent);
		this.#renderMessages(
			conversation,
			room ? t("Agent reply") : (agent?.displayName ?? session?.title ?? t("Agent")),
			agent,
		);
		this.#renderStatus(conversation, canWrite, session);
		this.#composer.disabled = !canWrite || conversation.sending;
		if (this.#composer.disabled) this.#skills.close();
		this.#cannotSend =
			!this.#actions.sendMessage ||
			this.#models.pending ||
			(this.#execution !== undefined && !this.#execution.canSend) ||
			!canWrite ||
			conversation.sending ||
			(!conversation.draft?.trim() && !this.#attachments.count) ||
			needsText ||
			Boolean(attachmentIssue) ||
			// More quotes than a message carries, or a quote with a mark gone: the note under the field says so.
			this.#company.draftQuotes(this.#sessionId).length > QUOTES_MAX ||
			this.#company.draftBroken(this.#sessionId);
		this.#syncSend();
		this.#attach.disabled = this.#composer.disabled || noImages;
		this.#attachNote.hidden = !noImages;
		this.#more.disabled = this.#composer.disabled;
		if (this.#composer.disabled && !this.#menu.hidden) this.#setMenu(false, false);
		this.#composerWrap.hidden = !canWrite;
		// Until the company says who may write here, the composer's place holds a placeholder.
		const opening = company.loading && (!company.team || !session);
		if (opening && !this.#composerPlaceholder) {
			this.#composerPlaceholder = composerSkeleton();
			this.#composerWrap.after(this.#composerPlaceholder);
		} else if (!opening && this.#composerPlaceholder) {
			this.#composerPlaceholder.remove();
			this.#composerPlaceholder = undefined;
		}
		if (this.#composer.value !== (conversation.draft ?? "")) {
			// The text changed under any open menu (a send, another tab's draft): it closes.
			this.#skills.close();
			this.#composer.value = conversation.draft ?? "";
			this.#autosize();
		}
		this.#followHistory();
		// The same text can come to hold a quote it did not (a teammate's draft brought its record): the copy follows.
		const pieces = JSON.stringify(this.#quotePieces());
		if (pieces !== this.#piecesShown) this.#skills.sync();
		this.#piecesShown = pieces;
		if (this.#composer.disabled) this.#closeMention();
		// A teammate's words can land in this composer (shared drafts) while names are shown:
		// where the name being typed now starts is read again, or the names close.
		else if (this.#mention && document.activeElement === this.#composer) this.#updateMention();
		// The same for an open skill menu.
		this.#skills.refresh();
		this.#renderMentionNote();
		this.#renderQuoteNote();
		this.#sharedDrafts.update();
	}

	#renderHeader(session: HostedSession | undefined, agent: HostedStaffAgent | undefined): void {
		const title = agent?.displayName ?? session?.title ?? t("Conversation");
		const group = isGroupChat(session);
		const groupAgents = group ? this.#company.groupAgents(this.#sessionId) : [];
		const state = this.#company.store.get();
		// A conversation the company has not listed yet shows its header as a placeholder.
		const opening = !session && state.loading;
		const key = JSON.stringify([title, group, agent?.id, agent?.appearance, groupAgents, opening]);
		this.#identity.disabled =
			(!agent && !group) ||
			!state.team?.capabilities.read ||
			Boolean(state.accessLost) ||
			this.#company.signal.aborted;
		this.#computer.hidden = !agent;
		this.#identity.title = opening ? "" : title;
		this.#identity.setAttribute(
			"aria-label",
			agent ? t("Open agent details") : group ? t("Open group details") : title,
		);
		if (agent || group) {
			this.#identity.setAttribute("aria-haspopup", "dialog");
			this.#identity.setAttribute("aria-expanded", String(Boolean(this.#details)));
		} else {
			this.#identity.removeAttribute("aria-haspopup");
			this.#identity.removeAttribute("aria-expanded");
		}
		if (key !== this.#headerKey) {
			this.#headerKey = key;
			if (this.#panel && this.#panel.agentId !== agent?.id) {
				// The thread changed hands: the old agent's computer does not belong here.
				const focused = this.#panel.el.contains(document.activeElement);
				this.#panels.close(this.#panel.agentId);
				this.#panel = undefined;
				const shown = agent ? this.#showPanel(agent) : undefined;
				if (focused) shown ? shown.focus() : this.#composer.focus();
				this.#computer.setAttribute("aria-expanded", String(Boolean(shown)));
				this.#autosize();
			} else if (this.#panel && agent) this.#panel.retitle(agent.displayName);
			if (opening) replace(this.#identity, ...threadIdentitySkeleton());
			else
				replace(
					this.#identity,
					group
						? groupChatAvatar(groupAgents, { width: 40, height: 32 })
						: agentFigure(agent, title, { size: 32 }),
					h("h1", null, title),
					agent || group ? icon("chevron") : null,
				);
		}
		// A computer left open in another of this agent's threads shows here without a click.
		if (!this.#panel && agent) {
			const open = this.#panels.get(agent.id);
			if (open && !open.attached) this.#showPanel(agent);
		}
	}

	/** Faces of the other members looking at this conversation now, newest arrival last. */
	#renderHere(): void {
		const here = this.#company.presentIn(this.#sessionId);
		const key = JSON.stringify(here);
		if (key === this.#hereKey) return;
		this.#hereKey = key;
		this.#here.hidden = !here.length;
		if (!here.length) {
			replace(this.#here);
			return;
		}
		const names = new Intl.ListFormat(presentationLocale(), { style: "long", type: "conjunction" }).format(
			here.map((member) => member.name),
		);
		const label = here.length === 1 ? t("{name} is here", { name: names }) : t("{names} are here", { names });
		this.#here.setAttribute("aria-label", label);
		this.#here.title = label;
		// Faces already shown stay put (a renamed member's is drawn anew); a new one grows in.
		const kept = new Map(
			[...this.#here.querySelectorAll<HTMLElement>(".person-avatar[data-user]")].map((face) => [
				`${face.dataset.user}:${face.dataset.name}`,
				face,
			]),
		);
		const faces = here.slice(0, 3).map((member) => {
			const face = kept.get(`${member.userId}:${member.name}`) ?? personAvatar(member.name, member.userId);
			face.dataset.user = member.userId;
			face.dataset.name = member.name;
			return face;
		});
		const desired: Element[] = [...faces];
		if (here.length > 3) desired.push(h("span", { class: "thread-presence-more" }, `+${here.length - 3}`));
		for (const child of [...this.#here.children]) if (!desired.includes(child)) child.remove();
		let cursor = this.#here.firstElementChild;
		for (const node of desired) {
			if (node !== cursor) this.#here.insertBefore(node, cursor);
			cursor = node.nextElementSibling;
		}
	}

	/** The clock, window focus, a language or zone change: every separator reads its day again, and
	 * travel can add or remove a midnight between two messages. Message nodes stay; the reader's
	 * place in the thread stays too. (A redraw places and labels separators itself.) */
	#refreshTimestamps(): void {
		if (this.#disposed) return;
		const now = new Date();
		let previousDate: Date | undefined;
		const groups = this.#timestampRows.map((row) => {
			const separated = needsConversationTimestamp(row.date, previousDate);
			previousDate = row.last ?? row.date;
			return { row, separated };
		});
		const regroup = groups.some(({ row, separated }) => Boolean(row.separator) !== separated);
		const scrollTop = this.#messages.scrollTop;
		const viewportTop = regroup && !this.#stickToBottom ? this.#messages.getBoundingClientRect().top : 0;
		const anchor =
			regroup && !this.#stickToBottom
				? this.#timestampRows.find(({ node }) => node.getBoundingClientRect().bottom > viewportTop)?.node
				: undefined;
		const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
		this.#timestampClock = this.#clock();
		for (const { row, separated } of groups) {
			if (!separated) {
				row.separator?.remove();
				row.separator = undefined;
				continue;
			}
			const added = !row.separator;
			row.separator = this.#labelSeparator(
				row.separator ?? h("time", { class: "conversation-timestamp" }),
				row.date,
				now,
			);
			// Labelled before it joins the live log, which then reads it once, whole.
			if (added) row.node.before(row.separator);
		}
		if (regroup) {
			if (this.#stickToBottom) this.#pinToBottom();
			else if (anchor) this.#messages.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
			else this.#messages.scrollTop = scrollTop;
		}
	}

	/** A day separator reads its moment ("Today 10:04"), with the full date and time for a pointer
	 * and a screen reader; only what changed is written. */
	#labelSeparator(time: HTMLTimeElement, date: Date, now: Date): HTMLTimeElement {
		const moment = date.toISOString();
		if (time.getAttribute("datetime") !== moment) time.setAttribute("datetime", moment);
		const label = conversationTimestampLabel(date, now);
		const title = conversationTimestampTitle(date);
		if (time.textContent !== label) time.textContent = label;
		if (time.title !== title) {
			time.title = title;
			time.setAttribute("aria-label", title);
		}
		return time;
	}

	#renderMessages(conversation: ConversationState, agentName: string, agent: HostedStaffAgent | undefined): void {
		const items: TranscriptItem[] = [
			...conversation.projection.items,
			...conversation.optimistic.map(
				(item): TranscriptItem => ({
					kind: "member",
					id: item.clientInputId,
					sequence: Number.MAX_SAFE_INTEGER,
					authorUserId: item.authorUserId,
					text: item.text,
					...(item.quotes ? { quotes: item.quotes } : {}),
					attachmentCount: item.attachmentCount ?? 0,
					createdAt: item.createdAt,
					pending: "queued",
				}),
			),
		];
		const session = this.#company.store.get().sessions.find((item) => item.sessionId === this.#sessionId);
		const room = this.#isRoom;
		// Group chats carry no cards; elsewhere the kernel's answerer, per card.
		const canWrite = this.#company.store.get().team?.capabilities.write === true && !room;
		const role = this.#company.store.get().team?.role ?? "";
		const members = this.#company.store.get().team?.members;
		const canAnswer = (actorUserId: string) =>
			canWrite && !!session && answersInteraction(session, actorUserId, this.#company.userId);
		const canDecide = (actorUserId: string) => canAnswer(actorUserId) && ["owner", "admin"].includes(role);
		const answerable = items.flatMap((item) =>
			item.kind === "interaction" || item.kind === "authorization_request" ? [canAnswer(item.actorUserId)] : [],
		);
		// While older history is unread, a coding session started before the oldest item read belongs
		// to it: it shows once "Show earlier" reaches its place.
		const start = conversation.hasEarlier
			? conversation.projection.items.find((item) => !(item.kind === "member" && item.pending))?.createdAt
			: undefined;
		const codingSessions = [...(conversation.codingSessions ?? [])]
			.filter((coding) => start === undefined || coding.createdAt.localeCompare(start) >= 0)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		// The member's open proposals of the agent (P40c) wait below the thread, oldest first.
		const proposals = conversation.proposals?.proposals ?? [];
		const moreProposals = conversation.proposals?.moreProposals ?? 0;
		const discarding = conversation.discardingProposals ?? [];
		const mentionTargets = this.#shownMentionTargets();
		const clock = this.#clock();
		const skillNames = [...this.#skills.names()].sort().join(" ");
		// A coworker's chip shows its figure and name.
		const coworker = (staffId: string) => {
			const staff = this.#company.staffById(staffId);
			return [staff?.id, staff?.displayName, staff?.appearance, staff?.templateId];
		};
		// An agent's interface change names each interface and table by its title as the folder has it now (a folder's
		// name is one name in any case).
		const folder = this.#company.store.get().interfaceFolder;
		const titleOf = (subject: InterfaceChangeSubject) => {
			const name = companyPathKey(subject.name);
			if (subject.kind === "interface")
				return folder?.pages.find((page) => companyPathKey(page.name) === name)?.file?.name;
			for (const [table, read] of folder?.tables ?? []) if (companyPathKey(table) === name) return read.table?.name;
			return undefined;
		};
		const changeLines = new Map(
			items.flatMap((item) =>
				item.kind === "interface_change" ? [[item.id, interfaceChangeText(item.change, titleOf)] as const] : [],
			),
		);
		const undoes = Boolean(this.#actions.undoInterfaceChange) && this.#company.store.get().team?.capabilities.write;
		const key = JSON.stringify([
			items,
			mentionTargets,
			// Only what the line shows: the header's poll changes the rest every few seconds.
			codingSessions.map((coding) => [coding.workerId, coding.harness, coding.title, coding.createdAt]),
			proposals,
			moreProposals,
			discarding,
			agentName,
			room,
			answerable,
			items.flatMap((item) =>
				item.kind === "interaction" && item.request.expiresAt
					? [Date.parse(item.request.expiresAt) <= Date.now()]
					: [],
			),
			role,
			session?.status,
			canWrite,
			conversation.interactionAnswers,
			conversation.interactionError,
			members,
			conversation.projection.hiddenCount,
			conversation.hasEarlier,
			conversation.earlierLoading,
			conversation.earlierError,
			conversation.loading,
			conversation.error,
			this.#agentState,
			agent?.id,
			agent?.appearance,
			agent?.templateId,
			clock,
			skillNames,
			items.flatMap((item) => (item.kind === "peer_link" ? [coworker(item.counterpartStaffId)] : [])),
			[...changeLines.values()],
			undoes,
			[...this.#undos],
			// A sent message learns its input id: the element passes on by it (see `handedOver`).
			conversation.optimistic.map((item) => item.inputId ?? null),
		]);
		// A waiting card's preview is drawn again as the folder is read, whether or not the thread changed.
		for (const preview of this.#previews.values()) preview?.refresh();
		if (key === this.#renderedKey) return;
		this.#renderedKey = key;
		const decisions = new Map<string, TranscriptCard>();
		for (const item of items)
			if (item.kind === "authorization_decision") {
				const request = authorizationRequestId(item.body);
				if (request) decisions.set(request, item);
			}
		// Approval cards of agents' actions (auto-review, v130) show their own outcome.
		const reviews = new Map<string, ActionReviewCard>();
		const requests = new Set<string>();
		for (const item of items)
			if (item.kind === "authorization_request") {
				requests.add(item.id.toLowerCase());
				const review = actionReviewCard(authorizationData(item.body));
				if (review) reviews.set(item.id.toLowerCase(), review);
			}
		const locale = presentationLocale();
		// Shown times (fmtTime) read by the zone and by their day against today: the time alone
		// today, with the day this year, with the year before that. Only an item whose reading
		// changes at midnight has a new time key then; older items keep theirs.
		const zone = presentationTimeZone();
		if (zone !== this.#daysZone || this.#days.size > 20_000) {
			this.#days.clear();
			this.#daysZone = zone;
		}
		const zoneOption = timeZoneOption().timeZone;
		const today = presentationDay(new Date(), zoneOption);
		const when = (iso: string | undefined) => {
			if (!iso) return "";
			let day = this.#days.get(iso);
			if (day === undefined) {
				const date = parseConversationTimestamp(iso);
				day = date ? presentationDay(date, zoneOption) : "";
				this.#days.set(iso, day);
			}
			return day === today ? "today" : day.slice(0, 4) === today.slice(0, 4) ? "year" : "earlier";
		};
		const mentions = JSON.stringify(mentionTargets);
		// Each item keeps its element from the last render while its key (all it shows but its
		// times) and its time key are the same. A changed message is brought up to date in place,
		// part by part; so is a card whose times alone changed, or one without controls (an answer
		// the transcript confirmed). Only new items, and cards that change otherwise, are drawn
		// anew: the live log reads each message once, when it first appears.
		const drawn = new Map<string, DrawnItem>();
		/** Entries of the last render taken by this one: none is taken twice. */
		const taken = new Set<DrawnItem>();
		/** A card drawn anew → the element it replaces, whose day separator stays with it. */
		const replaced = new Map<HTMLElement, HTMLElement>();
		/** The waiting approval cards this render draws, by review id: the previews of all others go. */
		const waitingCards = new Set<string>();
		const slotFor = (id: string) => {
			let slot = id;
			for (let copy = 1; drawn.has(slot); copy++) slot = `${id}#${copy}`;
			return slot;
		};
		const previousAt = (slot: string) => {
			const previous = this.#drawn.get(slot);
			// A card that replaced itself (an answered interaction redraws in place) is gone from the log.
			return previous && !taken.has(previous) && this.#inThread(previous.element) ? previous : undefined;
		};
		const keep = (id: string, itemKey: string, time: string, draw: () => HTMLElement): HTMLElement => {
			const slot = slotFor(id);
			const previous = previousAt(slot);
			if (previous) taken.add(previous);
			if (previous?.key === itemKey && previous.time === time) {
				drawn.set(slot, previous);
				return previous.element;
			}
			const element = draw();
			if (previous) {
				const timesOnly = previous.key === itemKey;
				if ((timesOnly || (inert(previous.element) && inert(element))) && sameShape(previous.element, element)) {
					// Its controls and what the member typed stay: a times-only change copies text and
					// labels, never a control's state.
					copyShape(previous.element, element, timesOnly);
					previous.key = itemKey;
					previous.time = time;
					drawn.set(slot, previous);
					return previous.element;
				}
			}
			const former = this.#drawn.get(slot)?.element;
			if (former) replaced.set(element, former);
			drawn.set(slot, { key: itemKey, time, element });
			return element;
		};
		// A member's message changes form as it is sent: the browser's copy (its client id), the
		// cloud's waiting input (the input id), the transcript's message (its event, which names the
		// input). Each form takes over the element of the form before it, by the input id.
		const present = new Set(items.map((item) => item.id));
		const optimisticInputs = new Map(conversation.optimistic.map((item) => [item.clientInputId, item.inputId]));
		let handoffs: Map<string, DrawnItem> | undefined;
		let eventInputs: Map<string, string> | undefined;
		const handedOver = (item: TranscriptMessage): DrawnItem | undefined => {
			if (item.kind !== "member" || optimisticInputs.has(item.id)) return undefined;
			handoffs ??= new Map(
				[...this.#drawn].flatMap(([slot, entry]) =>
					entry.input && !present.has(slot.replace(/#\d+$/, "")) ? [[entry.input, entry] as const] : [],
				),
			);
			if (!handoffs.size) return undefined;
			eventInputs ??= new Map(
				conversation.events.flatMap((event) =>
					event.sessionInputId ? [[event.eventId, event.sessionInputId] as const] : [],
				),
			);
			const entry = handoffs.get(item.pending ? item.id : (eventInputs.get(item.id) ?? ""));
			return entry && !taken.has(entry) && this.#inThread(entry.element) ? entry : undefined;
		};
		const message = (item: TranscriptMessage, author: string, mine: boolean): HTMLElement => {
			const slot = slotFor(item.id);
			const mentioned = item.kind === "member" && Boolean(item.text);
			// A "/name" may be a skill. (An item that arrives without text still draws, as "(empty)".)
			const skilled = item.text?.includes("/") === true;
			// The mention targets and skill names go in as they are, once serialized for the render.
			const itemKey = `${JSON.stringify([item, author, mine, room, locale])}${mentioned ? `\n${mentions}` : ""}${skilled ? `\n${skillNames}` : ""}`;
			const time = `${zone} ${when(item.createdAt)}`;
			// The input this form stands for, which the next form finds it by.
			const input = optimisticInputs.has(item.id)
				? optimisticInputs.get(item.id)
				: item.pending
					? item.id
					: undefined;
			const previous = previousAt(slot) ?? handedOver(item);
			const base = previous?.message ? previous : undefined;
			if (previous) taken.add(previous);
			if (base?.key === itemKey && base.time === time) {
				base.input = input;
				drawn.set(slot, base);
				this.#messageItems.set(base.element, { item, author, mine });
				return base.element;
			}
			const entry = this.#drawMessage(
				item,
				author,
				mine,
				room,
				{
					body: `${JSON.stringify([item.kind, item.text, item.quotes ?? null, Boolean(item.attachmentCount), Boolean(item.erased), locale])}${mentioned ? `\n${mentions}` : ""}${skilled ? `\n${skillNames}` : ""}`,
					files: JSON.stringify([
						locale,
						item.attachmentCount,
						item.attachments?.map((file) => [file.kind, file.name, file.bytes]),
					]),
				},
				base,
			);
			entry.key = itemKey;
			entry.time = time;
			entry.input = input;
			const former = this.#drawn.get(slot)?.element;
			if (!base && former) replaced.set(entry.element, former);
			drawn.set(slot, entry);
			this.#messageItems.set(entry.element, { item, author, mine });
			return entry.element;
		};
		// A card's actions reach the thread's agent as it is when clicked, not as it was drawn.
		const currentAgent = () =>
			this.#company.staffById(
				this.#company.store.get().sessions.find((item) => item.sessionId === this.#sessionId)?.staffAgentId,
			);
		const nodes: HTMLElement[] = [];
		// An item kept, patched or drawn anew keeps its day separator; the log reads neither again.
		const separators = new Map<HTMLElement, HTMLTimeElement>();
		for (const row of this.#timestampRows) if (row.separator) separators.set(row.node, row.separator);
		this.#timestampRows = [];
		const markTime = (date: Date, node: HTMLElement, last?: Date) => {
			const former = replaced.get(node);
			const separator = separators.get(node) ?? (former ? separators.get(former) : undefined);
			separators.delete(node);
			if (former) separators.delete(former);
			const row: TimestampRow = { date, node };
			if (separator) row.separator = separator;
			if (last) row.last = last;
			this.#timestampRows.push(row);
		};
		// A coding session stands where the agent started it, before the first
		// message written after it: one line, like a message to a coworker.
		let nextSession = 0;
		const placeSessions = (before: string | undefined) => {
			while (nextSession < codingSessions.length) {
				const candidate = codingSessions[nextSession]!;
				if (before !== undefined && candidate.createdAt.localeCompare(before) > 0) break;
				nextSession += 1;
				const { before: lead, name, after } = codingSessionLine(candidate.harness);
				// Kept while its words are the same, so a keyboard user on it keeps focus.
				const line = keep(
					`coding ${candidate.workerId}`,
					JSON.stringify([lead, name, after, candidate.title, locale]),
					`${zone} ${when(candidate.createdAt)}`,
					() => this.#drawCodingLine(candidate),
				);
				nodes.push(line);
				const date = parseConversationTimestamp(candidate.createdAt);
				if (date) markTime(date, line);
			}
		};
		// Items the thread showed first, and all that come after, stand in the live log; older ones
		// "Show earlier" reads stand above it, outside the log, which announces only what is new.
		// A waiting message has no place in the transcript yet (it stands by its send time), so it
		// never opens the log: one sent before the first item shown stays above the log, in its place.
		const waiting = (item: TranscriptItem) => item.kind === "member" && item.pending !== undefined;
		this.#liveFrom ??= conversation.projection.items.find((item) => !waiting(item))?.sequence;
		const liveFrom = this.#liveFrom;
		let liveStart: number | undefined;
		for (let index = 0; index < items.length; index++) {
			const item = items[index]!;
			if (liveStart === undefined && (liveFrom === undefined || (!waiting(item) && item.sequence >= liveFrom)))
				liveStart = nodes.length;
			placeSessions(item.createdAt);
			if (item.kind === "member" || item.kind === "agent") {
				const mine = item.kind === "member" && item.authorUserId === this.#company.userId;
				const author =
					item.kind === "agent"
						? room
							? (item.staffSpeaker?.displayName ??
								(item.staffSpeaker
									? t("Agent {id}", { id: item.staffSpeaker.staffAgentId })
									: t("Agent reply · speaker unavailable")))
							: agentName
						: this.#company.memberName(item.authorUserId);
				nodes.push(message(item, author, mine));
			} else if (item.kind === "peer_link") {
				// Messages with coworkers in a row stand on one line, unless something stands between
				// them: a coding session, a time separator, or the start of the live log.
				const run: TranscriptPeerLink[] = [item];
				let last = parseConversationTimestamp(item.createdAt);
				for (;;) {
					const next = items[index + run.length];
					if (next?.kind !== "peer_link") break;
					const at = parseConversationTimestamp(next.createdAt);
					const session = codingSessions[nextSession];
					if (
						!at ||
						!last ||
						needsConversationTimestamp(at, last) ||
						(session !== undefined && session.createdAt.localeCompare(next.createdAt) <= 0) ||
						(liveStart === undefined && (liveFrom === undefined || next.sequence >= liveFrom))
					)
						break;
					run.push(next);
					last = at;
				}
				const own = agent?.id ?? "";
				if (run.length > 1) {
					index += run.length - 1;
					const line = keep(
						item.id,
						JSON.stringify([run, run.map((link) => coworker(link.counterpartStaffId)), own, locale]),
						`${zone} ${run.map((link) => when(link.createdAt)).join(" ")}`,
						() => this.#drawPeerGroup(run, own),
					);
					nodes.push(line);
					const date = parseConversationTimestamp(item.createdAt);
					// The next separator measures from the line's last message.
					if (date) markTime(date, line, last);
					continue;
				}
				// A message between this agent and a coworker: one centered line, the coworker's
				// figure before its name, no text; the transcript is behind it.
				nodes.push(
					keep(
						item.id,
						JSON.stringify([item, coworker(item.counterpartStaffId), own, locale]),
						`${zone} ${when(item.createdAt)}`,
						() => {
							const counterpart = this.#company.staffById(item.counterpartStaffId);
							const name = counterpart?.displayName ?? t("a coworker");
							// A held message was left for the coworker's next turn, so it is a note, not a message it has read.
							// One sentence around the name; the chip sets the name apart, with the figure
							// before it, wherever the language puts it.
							const [verb = "", after = ""] = (
								item.held
									? item.direction === "out"
										? t("Left a note for {name}")
										: t("Note from {name}")
									: item.direction === "out"
										? t("Messaged {name}")
										: t("Message from {name}")
							).split("{name}");
							const label = `${verb}${name}${after}`;
							return h(
								"div",
								{ class: "peer-link", dataset: { messageId: item.id } },
								h(
									"button",
									{
										type: "button",
										class: "peer-chip",
										dataset: { pairSessionId: item.pairSessionId, linkIds: item.id },
										title: `${label} · ${fmtTime(item.createdAt)}`,
										"aria-label": t("{label}. Open the conversation", { label }),
										onclick: (event: MouseEvent) =>
											this.#openPair(
												item.pairSessionId,
												[item.counterpartStaffId, own],
												event.currentTarget as HTMLElement,
											),
									},
									verb.trim() ? h("span", null, verb.trim()) : null,
									agentFigure(counterpart, name, { size: 16 }),
									h("span", null, name),
									after.trim() ? h("span", null, after.trim()) : null,
								),
							);
						},
					),
				);
			} else if (item.kind === "note") {
				nodes.push(
					keep(item.id, JSON.stringify([item.text]), "", () =>
						h("div", { class: "conversation-note", role: "note" }, item.text),
					),
				);
			} else if (item.kind === "interface_change") {
				// An agent's change to the interfaces or tables, saved without review: one line, with Undo when the
				// member can write and Undo can take it back.
				const text = changeLines.get(item.id) ?? "";
				const state = this.#undos.get(item.change.commitId);
				const offered = undoes && interfaceChangeUndoable(item.change);
				nodes.push(
					keep(item.id, JSON.stringify([item.change, text, state, offered]), "", () =>
						renderInterfaceChangeLine(item.change, text, {
							...(state ? { state } : {}),
							...(offered ? { undo: () => void this.#undoInterfaceChange(item.change) } : {}),
						}),
					),
				);
			} else if (item.kind === "authorization_request" && reviews.has(item.id.toLowerCase())) {
				const review = reviews.get(item.id.toLowerCase())!;
				// A decided card needs no editor any more.
				if (decisions.has(item.id.toLowerCase())) this.#reviewDrafts.delete(review.reviewId);
				// The decision in the transcript, or an answer on its way (this browser's, or queued).
				const given = conversation.interactionAnswers?.[item.id.toLowerCase()] ?? item.answer;
				const resolution =
					decisions.get(item.id.toLowerCase())?.body ??
					(given
						? { decision: given.outcome, answer: given.answer, answeredBy: given.answeredBy ?? null }
						: undefined);
				const answerFailed = item.answerFailed === true && !given;
				const answers =
					canWrite && session?.status === "open" && answersActionReview(review, this.#company.userId, role);
				// While it waits, a card whose call saves pages shows them as they would look (I10). Its preview is
				// kept, and moves into the card when the card is drawn anew.
				const preview = resolution === undefined ? this.#previewOf(review) : undefined;
				if (resolution === undefined) waitingCards.add(review.reviewId);
				// The Always allow draft is not part of the key: a kept card keeps the member's editor as it
				// is. The card shows no time.
				nodes.push(
					keep(item.id, JSON.stringify([item, resolution, answerFailed, answers, members, locale]), "", () =>
						renderActionReviewCard(review, resolution, {
							answerFailed,
							draft: this.#reviewDrafts.get(review.reviewId),
							onDraft: (draft) => this.#reviewDrafts.set(review.reviewId, draft),
							answer: answers
								? (answer, ruleText) => void this.#answerActionReview(item.id, answer, ruleText)
								: undefined,
							memberName: (userId) => this.#company.memberName(userId),
							...(preview ? { preview: preview.element } : {}),
						}),
					),
				);
			} else if (
				item.kind === "authorization_decision" &&
				(reviews.has(authorizationRequestId(item.body) ?? "") ||
					// While older history is unread, a decision on a card not read yet waits for its card.
					(conversation.hasEarlier && !requests.has(authorizationRequestId(item.body) ?? "")))
			) {
				// Its approval card already shows this decision; it draws nothing, so it marks no time either.
				continue;
			} else if (item.kind === "authorization_request" || item.kind === "authorization_decision") {
				const optimistic =
					item.kind === "authorization_request"
						? conversation.interactionAnswers?.[item.id.toLowerCase()]
						: undefined;
				const resolution =
					item.kind === "authorization_request"
						? (decisions.get(item.id.toLowerCase())?.body ??
							(optimistic ? { decision: optimistic.outcome, requestEventId: item.id } : undefined))
						: undefined;
				const actor = this.#company.memberName(item.actorUserId);
				// A card of an agent's action the web cannot read is shown read-only: the general
				// answer refuses those (kernel v130), so it offers no controls.
				const decides =
					item.kind === "authorization_request" &&
					canDecide(item.actorUserId) &&
					authorizationData(item.body).schema !== ACTION_REVIEW_SCHEMA;
				nodes.push(
					keep(
						item.id,
						JSON.stringify([item, resolution, actor, decides, locale]),
						`${zone} ${when(item.createdAt)}`,
						() =>
							renderAuthorizationCard(
								item.kind,
								item.body,
								item.createdAt,
								actor,
								resolution,
								decides ? (decision) => void this.#answerInteraction(item.id, decision) : undefined,
							),
					),
				);
			} else if (item.kind === "interaction") {
				const email =
					item.request.surface === "draft" &&
					item.request.payload.platform === "email" &&
					item.request.payload.connectorId === "gmail";
				const answer = item.answer ?? conversation.interactionAnswers?.[item.id.toLowerCase()];
				const answers = canAnswer(item.actorUserId);
				const takeOver = Boolean(agent) && item.request.surface === "takeover";
				const cardKey = JSON.stringify([
					item.request,
					// What the card shows of an answer; the input it went out as is not shown.
					answer && [answer.outcome, answer.answer, answer.answeredBy, answer.answeredAt, answer.pending],
					answers,
					item.answerFailed,
					item.request.expiresAt ? Date.parse(item.request.expiresAt) <= Date.now() : false,
					agentName,
					locale,
					// An email card shows no time or member name, and keeps its editor through the rest.
					...(email
						? []
						: [
								item.createdAt,
								answer?.answeredBy ? this.#company.memberName(answer.answeredBy) : null,
								takeOver,
							]),
				]);
				nodes.push(
					keep(item.id, cardKey, email ? "" : `${zone} ${when(item.createdAt)} ${when(answer?.answeredAt)}`, () =>
						renderInteractionCard(
							{ ...item, answer },
							{
								agentName,
								memberName: (userId) => this.#company.memberName(userId),
								canAnswer: answers,
								answer: (outcome, answer) => this.#answerInteraction(item.id, outcome, answer),
								...(email
									? {
											emailDraft: this.#company.emailDraftEditor(item.id),
											loadEmailDraft: () => this.#company.loadEmailDraft(this.#sessionId, item.id),
										}
									: {}),
								...(email && answers
									? {
											actEmailDraft: (action: EmailDraftAction, content: EmailDraftContent) =>
												this.#company.actEmailDraft(this.#sessionId, item.id, action, content),
										}
									: {}),
								...(takeOver
									? {
											takeOver: () => {
												const current = currentAgent();
												if (current) this.#takeOver(current);
											},
										}
									: {}),
								...(item.request.surface === "secret" && answers
									? {
											provideSecret: (value: string) =>
												this.#company.provideSecret(this.#sessionId, item.id, item.request, value),
										}
									: {}),
							},
						),
					),
				);
			}
			const date = parseConversationTimestamp(item.createdAt);
			const node = nodes[nodes.length - 1];
			if (date && node) markTime(date, node);
		}
		liveStart ??= nodes.length;
		placeSessions(undefined);
		// Kept while the card reads the same, so a keyboard user on it keeps focus. No time: each waits until it is
		// applied, declined or discarded.
		for (const proposal of proposals) {
			const busy = discarding.includes(proposal.proposalId);
			nodes.push(
				keep(`proposal ${proposal.proposalId}`, JSON.stringify([proposal, busy, locale]), "", () =>
					renderProposalCard(proposal, {
						discarding: busy,
						discard: () => void this.#discardProposal(proposal.proposalId),
					}),
				),
			);
		}
		if (moreProposals > 0)
			nodes.push(
				keep("proposals more", locale, "", () =>
					h("div", { class: "conversation-note", role: "note" }, t("More saved changes wait after these.")),
				),
			);
		// Items gone from the thread, and messages whose element passed on, let what they held go.
		const live = new Set(drawn.values());
		for (const previous of this.#drawn.values()) if (!live.has(previous)) previous.message?.files?.view.dispose();
		this.#drawn = drawn;
		// So do the previews of cards answered or gone; the folder reader reads what the others draw.
		for (const [reviewId, preview] of this.#previews)
			if (!waitingCards.has(reviewId)) {
				preview?.dispose();
				this.#previews.delete(reviewId);
			}
		this.#actions.previewInterfaces?.(
			this,
			[...this.#previews.values()].flatMap((preview) => preview?.pages ?? []),
		);
		const placeholderShown = this.#messagesPlaceholder?.isConnected === true;
		if (conversation.loading && !items.length) {
			this.#messagesPlaceholder ??= messagesSkeleton();
			nodes.push(this.#messagesPlaceholder);
		} else this.#messagesPlaceholder = undefined;
		if (conversation.hasEarlier && !conversation.loading) {
			// The thread opened at its newest messages; older ones are read a page at a time.
			const label = conversation.earlierLoading ? t("Loading earlier messages…") : t("Show earlier messages");
			if (this.#earlierButton.textContent !== label) this.#earlierButton.textContent = label;
			// Not disabled while it reads, so a keyboard user on it keeps it.
			if (conversation.earlierLoading) this.#earlierButton.setAttribute("aria-disabled", "true");
			else this.#earlierButton.removeAttribute("aria-disabled");
			const note = conversation.earlierError
				? t("Earlier messages could not be loaded. {reason}", { reason: conversation.earlierError })
				: "";
			if (this.#earlierNote.textContent !== note) this.#earlierNote.textContent = note;
			this.#earlierNote.hidden = !note;
		}
		if (
			!conversation.loading &&
			!items.length &&
			!codingSessions.length &&
			!proposals.length &&
			!conversation.error &&
			!this.#working &&
			!conversation.hasEarlier
		) {
			const empty = t("No messages yet.");
			if (this.#emptyRow?.textContent !== empty) this.#emptyRow = h("div", { class: "empty" }, empty);
			nodes.push(this.#emptyRow);
		}
		const priorActivity = this.#activityRow?.element;
		if (this.#working && !conversation.loading) {
			// As on the desktop: the figure works or writes, and "Nova is writing"
			// shows beside it on hover or focus, never as a bubble. The row is kept while it
			// reads the same, so its figure's motion runs on through new messages.
			const rowKey = JSON.stringify([
				this.#agentState,
				agentName,
				agent?.id,
				agent?.appearance,
				agent?.templateId,
				locale,
			]);
			if (this.#activityRow?.key !== rowKey) {
				const look = AGENT_LOOK[this.#agentState];
				const { label, caption } = activityCaption(look, agentName);
				const row = h(
					"div",
					{
						class: "message from-agent thread-activity",
						role: "status",
						tabindex: "0",
						"aria-label": label,
					},
					agentFigure(agent, agentName, { size: 40, activity: look.figure }),
					caption,
				);
				// The wave only runs while the caption shows; on showing it starts in step with the rail.
				row.addEventListener("mouseenter", () => syncCaption(caption));
				row.addEventListener("focus", () => syncCaption(caption));
				this.#activityRow = { key: rowKey, element: row };
			}
			nodes.push(this.#activityRow.element);
		} else this.#activityRow = undefined;
		// Day separators: a kept one stays where it is, relabelled only once the day changed; a new
		// one is labelled now and joins the log just before its message, in the same move.
		const now = new Date();
		const relabel = clock !== this.#timestampClock;
		this.#timestampClock = clock;
		let previousDate: Date | undefined;
		for (const row of this.#timestampRows) {
			const separated = needsConversationTimestamp(row.date, previousDate);
			previousDate = row.last ?? row.date;
			if (!separated) row.separator = undefined;
			else if (!row.separator)
				row.separator = this.#labelSeparator(h("time", { class: "conversation-timestamp" }), row.date, now);
			else if (relabel || row.separator.getAttribute("datetime") !== row.date.toISOString())
				this.#labelSeparator(row.separator, row.date, now);
		}
		const rowFocus = document.activeElement?.classList.contains("thread-activity") ?? false;
		// Read before the redraw: a browser blurs an input as it leaves the page.
		const active =
			document.activeElement instanceof HTMLElement && this.#messages.contains(document.activeElement)
				? document.activeElement
				: undefined;
		const reviewInput = active instanceof HTMLInputElement ? active : undefined;
		const reviewCard = active?.closest<HTMLElement>("[data-review-id]")?.dataset.reviewId;
		const proposalCard = active?.closest<HTMLElement>("[data-proposal-id]")?.dataset.proposalId;
		const changeLine = active?.closest<HTMLElement>("[data-interface-change]")?.dataset.interfaceChange;
		const focusedMessage = active?.closest<HTMLElement>("article.message[data-message-id]")?.dataset.messageId;
		// Nodes already in place stay put: a live log re-reads what is taken out and put back.
		// (replaceChildren would also drop keyboard focus, selection and an in-progress IME edit.)
		const separatorOf = new Map<HTMLElement, HTMLTimeElement>();
		for (const row of this.#timestampRows) if (row.separator) separatorOf.set(row.node, row.separator);
		// A reader scrolled up keeps their place when items come in above ("Show earlier"): the
		// first item in view stays where it was on screen.
		const anchor = this.#stickToBottom ? undefined : this.#firstInView();
		const anchorTop = anchor ? anchor.getBoundingClientRect().top - this.#messages.getBoundingClientRect().top : 0;
		const earlierFocused = this.#earlier.contains(document.activeElement);
		// "Show earlier" brought its page: it comes in above the live log, outside it, and one status
		// line says how many.
		// Counted by sequence: a waiting message moves to its place in the new page.
		const oldest = this.#oldestSequence;
		const earlierLoaded = this.#earlierWasLoading && !conversation.earlierLoading && !conversation.earlierError;
		this.#earlierWasLoading = conversation.earlierLoading === true;
		this.#oldestSequence = conversation.projection.items.find((item) => !waiting(item))?.sequence;
		const older =
			earlierLoaded && oldest !== undefined
				? conversation.projection.items.filter((item) => !waiting(item) && item.sequence < oldest).length
				: -1;
		if (earlierLoaded)
			this.#earlierStatus.textContent = [
				older === 1
					? t("Loaded 1 earlier message.")
					: older > 1
						? t("Loaded {count} earlier messages.", { count: older })
						: "",
				conversation.hasEarlier ? "" : t("This is the start of the conversation."),
			]
				.filter(Boolean)
				.join(" ");
		const rows = (part: HTMLElement[]) =>
			part.flatMap((node) => {
				const separator = separatorOf.get(node);
				return separator ? [separator, node] : [node];
			});
		const olderNodes = nodes.slice(0, liveStart);
		const liveNodes = nodes.slice(liveStart);
		// Once the thread has filled, what joins the live log comes in (styles/motion.css): a new
		// message, card or the working figure. Not a card redrawn in place of itself (an answer), nor
		// the figure's row rebuilt for a new state, nor what "Show earlier" reads above the log.
		const arriving = this.#filled
			? liveNodes.filter(
					(node) =>
						!node.parentNode &&
						!replaced.has(node) &&
						node !== this.#emptyRow &&
						!(node === this.#activityRow?.element && priorActivity),
				)
			: [];
		// A card answered just now is drawn anew in its old one's place: it folds from the old
		// card's height to its outcome line, and the outcome is stamped (styles/motion.css).
		const decided = this.#filled
			? liveNodes.flatMap(
					(node): { node: HTMLElement; card: HTMLElement; since: number; height: number; was?: Element }[] => {
						const former = replaced.get(node);
						if (!former?.isConnected || node.parentNode) return [];
						const card = node.matches(DECIDED) ? node : node.querySelector<HTMLElement>(DECIDED);
						if (!card) return [];
						// The answer as first drawn (the member's own click) is drawn again when the cloud
						// confirms it, a round trip later: the settling carries on from where it is.
						const since = Number(former.dataset.decidedAt);
						if (Number.isFinite(since) && since > 0) {
							const ghost = former.querySelector<HTMLElement>(":scope > .fold-ghost") ?? undefined;
							if (ghost) ghost.style.opacity = getComputedStyle(ghost).opacity;
							return [
								{ node, card, since, height: ghost ? former.getBoundingClientRect().height : 0, was: ghost },
							];
						}
						// A decided card redrawn for some other reason just stays.
						if (former.matches(DECIDED) || former.querySelector(DECIDED)) return [];
						return [
							{
								node,
								card,
								since: 0,
								height: former.getBoundingClientRect().height,
								was: former.cloneNode(true) as Element,
							},
						];
					},
				)
			: [];
		// A line of messages with coworkers that takes in another is drawn anew in its old one's place:
		// a coworker new to the line springs in, and its count ticks over.
		const joining = this.#filled
			? liveNodes.flatMap((node) => {
					const former = replaced.get(node);
					if (!former?.isConnected || !node.matches(".peer-link[data-message-id]")) return [];
					const known = new Set(
						[...former.querySelectorAll<HTMLElement>(".peer-chip")].map((chip) => chip.dataset.pairSessionId),
					);
					const count = node.querySelector<HTMLElement>(".peer-count");
					return [
						...[...node.querySelectorAll<HTMLElement>(".peer-chip")].filter(
							(chip) => !known.has(chip.dataset.pairSessionId),
						),
						...(count && count.textContent !== former.querySelector(".peer-count")?.textContent ? [count] : []),
					];
				})
			: [];
		placeChildren(this.#older, rows(olderNodes));
		placeChildren(this.#log, rows(liveNodes));
		for (const node of arriving) playOnce(node, "is-arriving");
		for (const part of joining) playOnce(part, "is-joining");
		for (const { node, card, since, height, was } of decided) {
			if (height) foldFrom(node, height, was);
			const now = performance.now();
			const elapsed = since ? now - since : 0;
			if (elapsed > SETTLING) continue;
			playOnce(card, "is-decided");
			node.dataset.decidedAt = String(since || now);
			// Picked up mid-way: every part of the settling starts where the first drawing had got to.
			if (elapsed && typeof card.getAnimations === "function")
				for (const animation of card.getAnimations({ subtree: true }))
					if (
						typeof CSSAnimation !== "undefined" &&
						animation instanceof CSSAnimation &&
						SETTLING_PARTS.has(animation.animationName)
					)
						animation.currentTime = elapsed;
		}
		// Filled once a read has worked: a thread that failed and is read again opens still.
		if (!this.#filled && !conversation.loading && !conversation.error) {
			this.#filled = true;
			// Messages taking the skeleton's place fade up into it.
			if (placeholderShown) playOnce(this.#log, "is-filling");
		}
		placeChildren(
			this.#messages,
			[
				conversation.hasEarlier && !conversation.loading ? this.#earlier : undefined,
				olderNodes.length ? this.#older : undefined,
				this.#log,
			].filter((node): node is HTMLElement => Boolean(node)),
		);
		if (anchor?.isConnected) {
			const top = anchor.getBoundingClientRect().top - this.#messages.getBoundingClientRect().top;
			if (top !== anchorTop) this.#messages.scrollTop += top - anchorTop;
		}
		// The whole history is read: the keyboard stays in the thread where "Show earlier" stood.
		if (earlierFocused && !this.#earlier.isConnected) {
			this.#messages.tabIndex = -1;
			this.#messages.focus({ preventScroll: true });
		}
		for (const item of items) if (item.kind === "member" || item.kind === "agent") this.#skills.want(item.text);
		// A keyboard user reading the row keeps it through a state change or a new message.
		if (rowFocus) this.#messages.querySelector<HTMLElement>(".thread-activity")?.focus({ preventScroll: true });
		// And one on a coworker's chip keeps it as its line takes in another message.
		if (active && !active.isConnected && active.matches(".peer-link[data-message-id] .peer-chip"))
			this.#sameChip(active)?.focus({ preventScroll: true });
		// An approval card keeps the keyboard through a redraw: the Always allow editor a member is
		// typing in (caret and all), else the card itself, also once it is answered.
		const editor = reviewInput?.dataset.reviewRule
			? [...this.#messages.querySelectorAll<HTMLInputElement>("input[data-review-rule]")].find(
					(input) => input.dataset.reviewRule === reviewInput.dataset.reviewRule,
				)
			: undefined;
		if (editor && reviewInput && document.activeElement !== editor) {
			const { selectionStart, selectionEnd, selectionDirection } = reviewInput;
			editor.focus({ preventScroll: true });
			if (selectionStart !== null && selectionEnd !== null)
				editor.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
		} else if (!editor) {
			// Safari does not focus a clicked button: the card just answered is named here too.
			const target = active && !active.isConnected ? (reviewCard ?? this.#focusReview) : this.#focusReview;
			const card = target
				? [...this.#messages.querySelectorAll<HTMLElement>("[data-review-id]")].find(
						(element) => element.dataset.reviewId === target,
					)
				: undefined;
			if (card) {
				if (!card.contains(document.activeElement)) card.focus({ preventScroll: true });
				this.#focusReview = undefined;
			}
		}
		// A proposal card redrawn (its Discard button sending) keeps the keyboard; once it is gone, the thread has it.
		if (proposalCard && active && !active.isConnected) {
			const card = [...this.#messages.querySelectorAll<HTMLElement>("[data-proposal-id]")].find(
				(element) => element.dataset.proposalId === proposalCard,
			);
			if (card) card.focus({ preventScroll: true });
			else {
				this.#messages.tabIndex = -1;
				this.#messages.focus({ preventScroll: true });
			}
		}
		// So does an interface change's line as its Undo is sent and answered: its Undo while it can be pressed, else the
		// line.
		if (changeLine && active && !active.isConnected) {
			const line = [...this.#messages.querySelectorAll<HTMLElement>("[data-interface-change]")].find(
				(element) => element.dataset.interfaceChange === changeLine,
			);
			const retry = line?.querySelector<HTMLButtonElement>("button:not(:disabled)");
			(retry ?? line)?.focus({ preventScroll: true });
		}
		// A link in a message that was redrawn without it (the message erased) leaves the keyboard on the message.
		const lost = !document.activeElement?.isConnected || document.activeElement === document.body;
		if (focusedMessage && active && !active.isConnected && lost) this.#focusMessage(focusedMessage);
		this.#pinToBottom();
	}

	/** The first item of the thread in view: a message, card or line. Not the "Show earlier" row, which
	 * stays first when older items come in, nor a day separator, which may move to the new page. */
	#firstInView(): Element | undefined {
		const top = this.#messages.getBoundingClientRect().top;
		for (const child of [...this.#older.children, ...this.#log.children])
			if (!child.matches("time.conversation-timestamp") && child.getBoundingClientRect().bottom > top) return child;
		return undefined;
	}

	/** Whether an item's element still stands in the thread (a card may have replaced itself). */
	#inThread(element: HTMLElement): boolean {
		return element.parentNode === this.#log || element.parentNode === this.#older;
	}

	/** A member's or agent's message: its author, its text (an agent's as markdown), its files
	 * and, while it waits, where it stands. Given the entry it was drawn as before (the same
	 * message, or the form of it before it was sent), that element is brought up to date in
	 * place, part by part, so the live log hears only a part that changed: "Processing" once it
	 * is taken, nothing once it is in the transcript. */
	#drawMessage(
		item: TranscriptMessage,
		author: string,
		mine: boolean,
		room: boolean,
		keys: { body: string; files: string },
		base: DrawnItem | undefined,
	): DrawnItem {
		const before = base?.message;
		const element = base?.element ?? h("article");
		const className = [
			"message",
			item.kind === "agent" ? "from-agent" : "from-member",
			mine && "mine",
			item.phase === "progress" && "message-progress",
			item.erased && "message-erased",
			item.pending && `pending-${item.pending}`,
			// A message still coming in keeps coming in while it changes ("Queued" to "Processing").
			element.classList.contains("is-arriving") && "is-arriving",
		]
			.filter(Boolean)
			.join(" ");
		if (element.className !== className) element.className = className;
		const label = `${author} · ${fmtTime(item.createdAt)}`;
		if (element.getAttribute("aria-label") !== label) element.setAttribute("aria-label", label);
		if (element.title !== label) element.title = label;
		if (element.dataset.messageId !== item.id) element.dataset.messageId = item.id;
		const shown = (item.kind === "agent" && room) || (item.kind === "member" && !mine);
		const authorPart = !shown
			? undefined
			: before?.author?.text === author
				? before.author
				: { text: author, node: h("div", { class: "message-author" }, author) };
		let body = before?.body;
		if (body?.key !== keys.body) {
			const nodes = (
				item.erased
					? [h("div", { class: "text" }, t("(erased)"))]
					: item.kind === "agent"
						? markdownBubbles(item.text)
						: item.text || !item.attachmentCount
							? [
									h(
										"div",
										{ class: "text" },
										...(item.text ? this.#withMentions(item.text, item.quotes) : [t("(empty)")]),
									),
								]
							: []
			).map((part) => h("div", { class: "bubble" }, part));
			// Marked before they join the log, which then reads them once.
			this.#markSkills(nodes);
			body = { key: keys.body, nodes };
		}
		let files = before?.files;
		if (!item.attachmentCount) {
			files?.view.dispose();
			files = undefined;
		} else if (files?.key === keys.files) files.view.follow(item);
		else {
			files?.view.dispose();
			files = { key: keys.files, view: new ReceivedAttachments(item, this.#actions.previewAttachment) };
		}
		const captionText =
			item.pending === "failed"
				? item.failureReason
					? t("Failed · {reason}", { reason: item.failureReason })
					: t("Failed")
				: item.pending === "processing"
					? t("Processing")
					: item.pending
						? t("Queued")
						: undefined;
		let caption = captionText ? before?.caption : undefined;
		if (caption && caption.textContent !== captionText) caption.textContent = captionText ?? "";
		else if (captionText && !caption) caption = h("div", { class: "message-caption" }, captionText);
		placeChildren(
			element,
			[authorPart?.node, ...body.nodes, files?.view.el, caption].filter((node): node is HTMLElement =>
				Boolean(node),
			),
		);
		const message: MessageParts = {
			body,
			...(authorPart ? { author: authorPart } : {}),
			...(files ? { files } : {}),
			...(caption ? { caption } : {}),
		};
		if (!base) return { key: "", time: "", element, message };
		base.message = message;
		return base;
	}

	#renderStatus(conversation: ConversationState, canWrite: boolean, session: HostedSession | undefined): void {
		const company = this.#company.store.get();
		this.#renderRunNotification(session);
		// The agent's run has made no progress for the cloud's stall minutes: said, never acted on.
		const minutes = this.#isRoom ? undefined : this.#company.noProgress(session?.staffAgentId)?.minutes;
		const stoppable = this.#run?.stoppable === true;
		// Rebuilt only when something shown changes, so a focused button survives polling.
		const key = JSON.stringify([
			conversation.error,
			conversation.sendError,
			conversation.interactionError,
			conversation.loading,
			canWrite,
			this.#isRoom,
			session?.status,
			company.accessLost,
			company.team?.role,
			company.team?.capabilities,
			company.waitingForHours,
			minutes,
			stoppable,
			this.#erase && [this.#erase.what, this.#erase.erase?.state, this.#erase.failure],
		]);
		if (key === this.#statusKey) return;
		this.#statusKey = key;
		const children: (HTMLElement | null)[] = [];
		if (conversation.error) children.push(notice("danger", conversation.error));
		if (conversation.sendError) children.push(notice("danger", conversation.sendError));
		if (conversation.interactionError) children.push(notice("danger", conversation.interactionError));
		if (this.#erase) children.push(this.#eraseNotice(this.#erase));
		if (canWrite && !this.#actions.sendMessage)
			children.push(
				h(
					"p",
					{ class: "surface-status", role: "status" },
					t("Sending messages is not available yet. Your draft stays here."),
				),
			);
		if (this.#execution) children.push(this.#execution.el);
		// The company is out of computer hours: what is sent here waits, and starts by itself once
		// hours are added (the zero rule). The message itself is sent and shown as usual.
		if (company.waitingForHours && session?.status !== "closed")
			children.push(
				notice("neutral", t("Out of computer hours. New work waits and starts by itself once hours are added.")),
			);
		if (minutes !== undefined)
			children.push(
				notice(
					"neutral",
					stoppable
						? t("No progress for {minutes} minutes. If it looks stuck, press Stop.", { minutes })
						: t("No progress for {minutes} minutes.", { minutes }),
				),
			);
		if (!canWrite && session?.status === "closed")
			children.push(notice("neutral", t("This conversation is archived.")));
		else if (
			!canWrite &&
			session &&
			!conversation.loading &&
			!conversation.error &&
			!company.accessLost &&
			company.team?.capabilities.read === true
		)
			children.push(notice("neutral", t("You can read this conversation. Contributors and above can write.")));
		const refocus = this.#status.contains(document.activeElement)
			? (document.activeElement as HTMLElement).dataset.action
			: undefined;
		replace(this.#status, ...children);
		if (refocus) this.#status.querySelector<HTMLElement>(`[data-action="${refocus}"]`)?.focus();
	}

	/** A coding session in the thread: "Started a coding session in (mark) Codex",
	 * one centered line that opens the session as its own thread. */
	#drawCodingLine(session: CodingSession): HTMLElement {
		const { before, name, after } = codingSessionLine(session.harness);
		const label = `${before}${name}${after}`;
		const time = fmtTime(session.createdAt);
		return h(
			"div",
			{ class: "peer-link coding-line", dataset: { workerId: session.workerId } },
			h(
				"button",
				{
					type: "button",
					class: "peer-chip",
					title: `${session.title} · ${time}`,
					// The title tells two sessions in one thread apart for a screen reader too.
					"aria-label": t("{label}. Open the session", { label: `${label} · ${session.title}` }),
					onclick: (event: MouseEvent) =>
						this.#openCodingSession(session.workerId, event.currentTarget as HTMLElement),
				},
				before.trim() ? h("span", null, before.trim()) : null,
				harnessMark(session.harness, 14),
				h("span", null, name),
				after.trim() ? h("span", null, after.trim()) : null,
			),
		);
	}

	/** Messages with coworkers in a row: "Messaged (figure) Nova and (figure) Ada · 3 messages", one
	 * centered line with a chip for each coworker that opens the two agents' transcript. From three
	 * coworkers on, a chip is the figure alone, with the name in its label. */
	#drawPeerGroup(run: readonly TranscriptPeerLink[], own: string): HTMLElement {
		// Each coworker once, where it first comes; its chip has the time of its last message.
		const latest = new Map<string, TranscriptPeerLink>();
		for (const link of run) latest.set(link.counterpartStaffId, link);
		const coworkers = [...latest.values()].map((link) => {
			const staff = this.#company.staffById(link.counterpartStaffId);
			// The messages its chip stands for, so a focused chip is found again if the line splits.
			const ids = run.filter((other) => other.counterpartStaffId === link.counterpartStaffId).map(({ id }) => id);
			return { link, staff, name: staff?.displayName ?? t("a coworker"), ids: ids.join(" ") };
		});
		const out = run.every((link) => link.direction === "out");
		const inward = run.every((link) => link.direction === "in");
		// Notes left for a next turn, as on one message's line.
		const held = run.every((link) => link.held);
		const [before = "", after = ""] = (
			out
				? held
					? t("Left notes for {names}")
					: t("Messaged {names}")
				: inward
					? held
						? t("Notes from {names}")
						: t("Messages from {names}")
					: t("Talked with {names}")
		).split("{names}");
		const list = new Intl.ListFormat(presentationLocale(), { style: "long", type: "conjunction" });
		const names = coworkers.map(({ name }) => name);
		const count = run.length > coworkers.length ? t("{count} messages", { count: run.length }) : "";
		const compact = coworkers.length > 2;
		const chips = coworkers.map(({ link, staff, name, ids }) =>
			h(
				"button",
				{
					type: "button",
					class: compact ? "peer-chip figure-only" : "peer-chip",
					dataset: { pairSessionId: link.pairSessionId, linkIds: ids },
					title: `${name} · ${fmtTime(link.createdAt)}`,
					"aria-label": t("{label}. Open the conversation", { label: name }),
					onclick: (event: MouseEvent) =>
						this.#openPair(
							link.pairSessionId,
							[link.counterpartStaffId, own],
							event.currentTarget as HTMLElement,
						),
				},
				agentFigure(staff, name, { size: 16 }),
				compact ? null : h("span", null, name),
			),
		);
		const words = (text: string) => (text.trim() ? h("span", { class: "peer-words" }, text.trim()) : null);
		// The chips stand where the language puts the names, with its own "and" between them.
		let next = 0;
		const parts = compact
			? chips
			: list.formatToParts(names).map((part) => (part.type === "element" ? chips[next++]! : words(part.value)));
		return h(
			"div",
			{
				class: "peer-link peer-group",
				role: "group",
				"aria-label": `${before}${list.format(names)}${after}${count ? ` · ${count}` : ""}`,
				dataset: { messageId: run[0]!.id },
			},
			words(before),
			...parts,
			words(after),
			count ? h("span", { class: "peer-count" }, `· ${count}`) : null,
		);
	}

	/** The sessions still going sit beside the agent in the header, each a figure
	 * that works while its session works; the figures are kept across renders so
	 * their motion runs on. */
	#renderCodingSlots(sessions: readonly CodingSession[], agent: HostedStaffAgent | undefined): void {
		// The session open as its own thread takes the fresh listing too.
		const open = this.#codingThread && sessions.find((session) => session.workerId === this.#codingThread?.workerId);
		if (open) this.#codingThread?.view.update(open);
		const going = [...sessions].filter(codingSessionGoing).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		const names = this.#codingNames(agent?.displayName ?? t("Agent"));
		const slots = going.map((session) => {
			let slot = this.#codingSlotViews.get(session.workerId);
			if (!slot) {
				slot = new CodingSessionSlot(session.workerId, (opener) =>
					this.#openCodingSession(session.workerId, opener),
				);
				this.#codingSlotViews.set(session.workerId, slot);
			}
			slot.update(session, this.#company.staffById(session.agentId) ?? agent, names(session));
			return slot;
		});
		for (const workerId of this.#codingSlotViews.keys())
			if (!going.some((session) => session.workerId === workerId)) this.#codingSlotViews.delete(workerId);
		const current = [...this.#codingSlots.children];
		if (current.length !== slots.length || slots.some((slot, index) => current[index] !== slot.el)) {
			const focused = this.#codingSlots.contains(document.activeElement)
				? (document.activeElement as HTMLElement)
				: undefined;
			replace(this.#codingSlots, ...slots.map((slot) => slot.el));
			// Moving the nodes drops focus to the page: back to the same figure, or to the agent if it left.
			if (focused && document.activeElement !== focused)
				(focused.isConnected ? focused : this.#identity.disabled ? this.#composer : this.#identity).focus({
					preventScroll: true,
				});
		}
		this.#codingSlots.hidden = !slots.length;
		this.#watchCodingSessions();
	}

	/** Re-reads the thread's coding sessions on a clock while one is still going, so
	 * the header's figures follow them; stops once they all settled. A new session or
	 * a follow-up starts it again from the next render. */
	#watchCodingSessions(): void {
		if (this.#codingPoll !== undefined || this.#codingReading || this.#disposed) return;
		const going = (this.#company.conversation(this.#sessionId).get().codingSessions ?? []).filter(codingSessionGoing);
		if (!going.length) return;
		const pace = document.hidden
			? CODING_POLL_HIDDEN_MS
			: going.some((session) => session.phase !== "awaiting_input" && session.phase !== "queued")
				? CODING_POLL_WORKING_MS
				: CODING_POLL_WAITING_MS;
		this.#codingPoll = setTimeout(
			() => {
				this.#codingPoll = undefined;
				this.#codingReading = true;
				void this.#company
					.refreshCodingSessions(this.#sessionId)
					.then(
						() => {
							this.#codingFailures = 0;
						},
						() => {
							this.#codingFailures += 1;
						},
					)
					.finally(() => {
						this.#codingReading = false;
						this.#watchCodingSessions();
					});
			},
			pace * 2 ** Math.min(this.#codingFailures, 3),
		);
	}

	/** The names a session's captions are written with; the owner is "you" for the owner. */
	#codingNames(agentName: string) {
		const company = this.#company;
		return (current: CodingSession) => {
			const ownerIsViewer = current.ownerUserId === company.userId;
			return {
				agent: company.staffById(current.agentId)?.displayName ?? agentName,
				owner: ownerIsViewer ? t("you") : company.memberName(current.ownerUserId),
				ownerIsViewer,
			};
		};
	}

	/** What the session's own thread needs to render and act. */
	#codingOptions(agent: HostedStaffAgent | undefined, agentName: string) {
		const sessionId = this.#sessionId;
		const company = this.#company;
		return {
			agent,
			names: this.#codingNames(agentName),
			viewerOwns: (current: CodingSession) => current.ownerUserId === company.userId,
			api: {
				read: (workerId: string, afterEvent: number) => company.readCodingSession(workerId, afterEvent),
				answer: (workerId: string, text: string, clientRequestId: string) =>
					company.answerCodingSession(sessionId, workerId, text, clientRequestId),
				delegate: (workerId: string, clientRequestId: string) =>
					company.delegateCodingSession(sessionId, workerId, clientRequestId),
				archive: (workerId: string, clientRequestId: string) =>
					company.archiveCodingSession(sessionId, workerId, clientRequestId),
			},
			signal: AbortSignal.any([this.#lifetime.signal, company.signal]),
			askAgent: this.#actions.sendMessage
				? (text: string) => {
						this.#closeCodingSession();
						this.#edits.declare(0, this.#composer.value.length);
						this.#composer.value = text;
						this.#composer.dispatchEvent(new Event("input", { bubbles: true }));
						this.#composer.focus();
					}
				: undefined,
		};
	}

	/** Open a coding session as its own thread over this one, as a message to a
	 * coworker opens; the line stays in the conversation. */
	#openCodingSession(workerId: string, opener?: HTMLElement): void {
		if (this.#codingThread?.workerId === workerId) return;
		this.#closeCodingSession();
		const conversation = this.#company.conversation(this.#sessionId).get();
		const session = conversation.codingSessions?.find((item) => item.workerId === workerId);
		if (!session) return;
		const company = this.#company.store.get();
		const thread = company.sessions.find((item) => item.sessionId === this.#sessionId);
		const agent = this.#company.staffById(thread?.staffAgentId);
		const view = new CodingSessionThreadView(session, {
			...this.#codingOptions(agent, agent?.displayName ?? t("Agent")),
			close: () => {
				if (this.#codingThread?.view === view) this.#codingThread = undefined;
				// Back where the member opened it; the line if the header's figure went away meanwhile.
				(opener?.isConnected
					? opener
					: this.#messages.querySelector<HTMLElement>(`.coding-line[data-worker-id="${workerId}"] .peer-chip`)
				)?.focus();
			},
		});
		this.#codingThread = { workerId, view };
		view.attach(this.#body);
	}

	#closeCodingSession(): void {
		const open = this.#codingThread;
		if (!open) return;
		this.#codingThread = undefined;
		open.view.dispose();
	}

	#renderRunNotification(session: HostedSession | undefined): void {
		const company = this.#company.store.get();
		const failed =
			this.#isRoom || company.accessLost || !company.team?.capabilities.read
				? undefined
				: this.#company.failedRunFor(session?.staffAgentId);
		const runId = failed?.activity.runId;
		const hidden = !runId || dismissedRunNotifications.get(this.#company)?.has(runId);
		const proposalId = failed?.recovery?.proposalId;
		const review = failed?.activity.sourceKind === "proposal_review";
		const agentName = this.#company.staffById(session?.staffAgentId ?? "")?.displayName ?? t("The agent");
		const title = proposalId
			? t("{name} stopped with changes to review", { name: agentName })
			: review
				? t("A review did not finish")
				: t("{name} did not finish this run", { name: agentName });
		const recovery = failed?.recovery;
		// The member's own ChatGPT plan reached its limit: OpenAI's words and "Manage usage" (Sign in with ChatGPT).
		// Anyone else reads that the account paying for the work reached its limit.
		const ownPlanLimit =
			!proposalId &&
			recovery?.usageLimit === true &&
			recovery.paidByChatgptPlan === true &&
			recovery.requestedByUserId === this.#company.userId.toLowerCase();
		const reason = proposalId
			? t("Its changes wait for your decision.")
			: ownPlanLimit
				? planUsageLimitReason()
				: recovery
					? runFailureReason(recovery.lastError, recovery.jobStatus, recovery.usageLimit)
					: undefined;
		const retryState = runId ? company.runRetries?.[runId] : undefined;
		// Try again is for an interrupted run; a refused one says what the member must do first.
		const canRetry =
			failed !== undefined &&
			!review &&
			this.#company.canRetryFailedRun(failed) &&
			recovery !== undefined &&
			runFailureInterrupted(recovery.lastError, recovery.jobStatus, recovery.usageLimit);
		const key = JSON.stringify([
			runId,
			hidden,
			proposalId,
			review,
			title,
			reason,
			recovery?.lastError,
			retryState,
			canRetry,
			ownPlanLimit,
		]);
		if (key === this.#runNotificationKey) return;
		this.#runNotificationKey = key;
		const focused = this.#runNotification.contains(document.activeElement);
		const focusedAction = focused ? (document.activeElement as HTMLElement).dataset.action : undefined;
		const dismiss = () => {
			if (!runId || this.#notificationSignal.aborted) return;
			let dismissed = dismissedRunNotifications.get(this.#company);
			if (dismissed?.has(runId)) return;
			if (!dismissed) {
				dismissed = new Set();
				dismissedRunNotifications.set(this.#company, dismissed);
			}
			dismissed.add(runId);
			this.update();
			// Durable for the company: the badge and this card do not come back on reload.
			// If nothing reached the cloud, the card comes back so it can be dismissed again.
			void this.#company.dismissFailedRun(runId).catch(() => {
				dismissed.delete(runId);
				if (!this.#company.signal.aborted) this.#company.store.set({});
			});
		};
		const profileId = this.#company.profile.profileId;
		const action = ownPlanLimit
			? manageUsageLink()
			: proposalId || review
				? h(
						"a",
						{
							class: "btn btn-small",
							// The Company File: a proposal has no page of its own (folder-v2 reviews in chat).
							href: `#/c/${profileId}/file`,
						},
						t("Review"),
					)
				: undefined;
		const sessionId = this.#sessionId;
		this.#runNotification.hidden = Boolean(hidden);
		replace(
			this.#runNotification,
			hidden || !runId
				? null
				: runFailureCard({
						title,
						reason,
						retry: canRetry ? () => void this.#company.retryFailedRun(runId, sessionId) : undefined,
						retrying: retryState?.pending,
						retryError: retryState?.error,
						dismiss,
						action,
					}),
		);
		if (focused) {
			if (!hidden)
				(
					(focusedAction
						? this.#runNotification.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`)
						: null) ?? this.#runNotification.querySelector<HTMLElement>(".run-failure-primary, a, button")
				)?.focus({ preventScroll: true });
			else if (this.#conversationPane.inert || this.#panel?.el.classList.contains("is-entered"))
				this.#panel?.focus();
			else if (!this.#composer.disabled && !this.#composerWrap.hidden) this.#composer.focus({ preventScroll: true });
			else if (!this.#identity.disabled) this.#identity.focus({ preventScroll: true });
			else {
				this.el.tabIndex = -1;
				this.el.focus({ preventScroll: true });
			}
		}
	}
}
