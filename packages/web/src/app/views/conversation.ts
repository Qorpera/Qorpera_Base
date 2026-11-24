import { companyPathKey } from "@qorpera/cloud-client/company-state-files";
import { type CodingSession, codingSessionGoing } from "../../cloud/coding-session.ts";
import type { EmailDraftAction, EmailDraftContent } from "../../cloud/email-drafts.ts";
import { isGmailDraft, questionInput } from "../../cloud/interactions.ts";
import {
	type InterfaceChange,
	type InterfaceChangeSubject,
	interfaceChangeUndoable,
} from "../../cloud/interface-changes.ts";
import { type MessageErase, MessageEraseError } from "../../cloud/message-erases.ts";
import { planLogin } from "../../cloud/native-subscription.ts";
import { type MessageQuote, QUOTES_MAX } from "../../cloud/quotes.ts";
import {
	ACTION_REVIEW_SCHEMA,
	type ActionReviewAnswer,
	type ActionReviewCard,
	actionReviewCard,
	answersActionReview,
} from "../../cloud/review-rules.ts";
import { sessionAttachmentProblem } from "../../cloud/session-attachments.ts";
import {
	decisionRound,
	foldText,
	latestReworkingReplyAfter,
	type RunAcknowledgement,
	reworkingNote,
	runAcknowledgements,
	type TranscriptCard,
	type TranscriptInteraction,
	type TranscriptItem,
	type TranscriptMessage,
	type TranscriptPeerLink,
	type TranscriptProjection,
	type UnaskedGroup,
	unaskedGroups,
} from "../../cloud/transcript.ts";
import type { HostedSession, HostedStaffAgent, JsonValue, PausedRun } from "../../cloud/types.ts";
import { appNoteHeader, splitReply } from "../../cloud/wall-reply.ts";
import { AGENT_LOOK, activityCaption, activityRow, activityWords } from "../../ui/agent-activity.ts";
import { AttachmentTray, attachmentProblemText } from "../../ui/attachments.ts";
import {
	type ActionReviewDraft,
	authorizationData,
	authorizationRequestId,
	renderActionReviewCard,
	renderAuthorizationCard,
} from "../../ui/authorization-card.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { CodingPill, codingSessionLine, harnessMark } from "../../ui/coding-session.ts";
import { CodingSessionThreadView } from "../../ui/coding-session-thread.ts";
import { menuPoint, openContextMenu } from "../../ui/context-menu.ts";
import {
	conversationTimestampLabel,
	conversationTimestampTitle,
	needsConversationTimestamp,
	parseConversationTimestamp,
} from "../../ui/conversation-timestamps.ts";
import { Dictation } from "../../ui/dictation.ts";
import { confirmDialog, fmtTime, h, icon, notice, personAvatar, replace } from "../../ui/dom.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import { renderInteractionCard } from "../../ui/interaction-card.ts";
import {
	type InterfaceUndoState,
	interfaceChangeText,
	renderInterfaceChangeLine,
} from "../../ui/interface-change-line.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { matchesKey } from "../../ui/keys.ts";
import { appCard, type LinkedSite, markdown, markdownBubbles } from "../../ui/markdown.ts";
import { findMentions, type MentionTarget, matchTargets, mentionParts, mentionQuery } from "../../ui/mentions.ts";
import { easing, foldFrom, leave, playOnce, reducedMotion } from "../../ui/motion.ts";
import { presentationDay, presentationLocale, presentationTimeZone, t, timeZoneOption } from "../../ui/preferences.ts";
import { renderProposalCard } from "../../ui/proposal-card.ts";
import { quietScroll } from "../../ui/quiet-scroll.ts";
import { ReceivedAttachments } from "../../ui/received-attachments.ts";
import {
	classifyRunFailure,
	manageUsageLink,
	planUsageLimitReason,
	runFailureCard,
	runFailureInterrupted,
	runFailureReason,
	runWaitingReason,
} from "../../ui/run-failure.ts";
import { uiScale } from "../../ui/scale.ts";
import { sentTimeHover } from "../../ui/sent-time-hover.ts";
import { composerSkeleton, messagesSkeleton, threadIdentitySkeleton } from "../../ui/skeleton.ts";
import { markSkillNames, SkillMentions } from "../../ui/skill-mentions.ts";
import { threadFold } from "../../ui/thread-fold.ts";
import {
	type AgentState,
	agentWorks,
	answersInteraction,
	type CompanyController,
	type ConversationState,
	sitePublicAnswer,
} from "../company.ts";
import { type QuotePiece, quotePieces } from "../quotes.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import { AgentDetails } from "./agent-details.ts";
import { ComposerLogins } from "./composer-logins.ts";
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
import { DecisionDock } from "./decision-dock.ts";
import { GroupDetails } from "./group-details.ts";
import { pageNoteApp, pageNoteCard } from "./page-note.ts";
import { PairTranscriptView } from "./pair-transcript.ts";
import { SessionExecutionView } from "./session-execution.ts";
import { SessionRunView } from "./session-run.ts";
import { SharedDrafts } from "./shared-drafts.ts";
import { type AppLook, appLook } from "./shell.ts";
import { ThreadReady } from "./thread-ready.ts";
import { ThreadSites } from "./thread-sites.ts";

const transcriptItemJsonCache = new WeakMap<TranscriptItem, string>();
function cachedTranscriptItemJson(item: TranscriptItem): string {
	let encoded = transcriptItemJsonCache.get(item);
	if (encoded === undefined) {
		encoded = JSON.stringify(item);
		transcriptItemJsonCache.set(item, encoded);
	}
	return encoded;
}

/* How often the thread re-reads its coding sessions while one is still going: the
 * pill's figures follow them. Nothing is read once they all settled. */
const CODING_POLL_WORKING_MS = 2_500;
const CODING_POLL_WAITING_MS = 6_000;
const CODING_POLL_HIDDEN_MS = 20_000;
const FIRST_WORDS_WAIT_MS = 5_000;

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
	abort?: () => void;
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

/** The member's erase of one message here, as its line above the composer tells it: which message (its author and
 * time, never a file), how far the erase got, and why it stopped if it did. */
interface EraseLine {
	readonly messageId: string;
	readonly what: { readonly author: string; readonly time: string };
	erase?: MessageErase;
	failure?: string;
}

/** Which message an erase line is about. Mid-sentence, the member's own message is "from you", not "from You". */
function eraseWhat(item: TranscriptMessage, author: string, mine: boolean): EraseLine["what"] {
	return { author: mine ? t("you") : author, time: fmtTime(item.createdAt) };
}

/** A line with nothing more to say: refused, failed, or done with no copy left to name. */
function eraseSettled({ erase, failure }: EraseLine): boolean {
	return failure !== undefined || erase?.state === "refused" || (erase?.state === "done" && !erase.copies.length);
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

/** Why an erase could not be asked for, in the member's words. A 401 is the member's sign-in, not their role. */
function eraseFailure(error: unknown, what: EraseLine["what"]): string {
	const status = error instanceof MessageEraseError ? error.status : null;
	if (status === 403) return t("Only an owner or admin can erase messages.");
	if (status === 404) return t("The message from {author} at {time} can't be erased.", what);
	if (status === 423) return t("The company is paused, so no message can be erased now.");
	return t("Could not erase the message from {author} at {time}. Try again.", what);
}

/** Elements that hold a handler of their own or what the member typed or opened. */
const INTERACTIVE = "button, input, select, textarea, a[href], a[data-href], details, [contenteditable]";

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
const SETTLING_PARTS = new Set([
	"decided-answer",
	"decided-edge",
	"decided-line",
	"decided-mark",
	"draw-stroke",
	"motion-hold",
]);
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

/** What an agent's card can open in the agent's chat. */
export type AgentPage = "computer";

/** The login a stopped run's "Continue with …" picked: its message is sent on that login only. */
interface ContinueLogin {
	runId: string;
	connectionId: string;
}

/* One conversation over the canonical transcript. Rendering follows
 * DECISIONS.md "Transcript projection rules": member inputs and agent sends
 * only. Composer drafts remain local until a message adapter is supplied. */

/** A peer chip's time for a screen reader, as its description; the chip's name says what it opens. A status line like
 * this shows no time on a hover (Jonas, 14 Nov 2026): only messages do (ui/sent-time-hover.ts). */
const peerTimeId = (linkId: string) => `peer-time-${linkId}`;
const peerTime = (linkId: string, at: string) =>
	h("span", { class: "visually-hidden", id: peerTimeId(linkId) }, fmtTime(at));

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
	#skillsCheckedProjection: TranscriptProjection | undefined;
	#skillsCheckedOptimistic: ConversationState["optimistic"] | undefined;
	readonly #send: HTMLButtonElement;
	/** Speech to text: the microphone beside the send button. */
	readonly #dictation: Dictation;
	#stopMode = false;
	#cannotSend = true;
	#submitting = false;
	#working = false;
	/** The agent's run waits at its login's usage limit (20260930703000): it shows no work, but it may be stopped. */
	#waitingRun = false;
	#decisions: DecisionDock | undefined;
	#agentState: AgentState = "idle";
	#activityKey = "";
	readonly #composerWrap: HTMLElement;
	/** Where the composer will stand while the company still opens. */
	#composerPlaceholder: HTMLElement | undefined;
	/** The messages' placeholder, one per load, so the log does not read it out again on each redraw. */
	#messagesPlaceholder: HTMLElement | undefined;
	readonly #composerShell: HTMLElement;
	/** What the draft answers, in the composer: the app a note from it is about (RUNTIME-INTERFACE-APPS.md §5 "tell"),
	 * which the message opens with once it is sent. */
	readonly #answerStrip: HTMLElement;
	readonly #answerEmblem = h("span", { class: "composer-answer-emblem", "aria-hidden": "true", hidden: true });
	readonly #answerLabel = h("span", { class: "composer-answer-label" }, t("Answering"));
	readonly #answerQuestion = h("span", { class: "composer-answer-question" });
	readonly #answerStop: HTMLButtonElement;
	/** What the strip shows now: the line answered, and for an app's note the app as the company's apps say it. */
	#answerDrawn = "";
	#answerShown: string | undefined;
	/** Enter pressed a moment before Send opens (the draft or the account check on its way): sent when it does, if the
	 * message is still the same: its text, the question it answers and its files. */
	#sendSoon:
		| { text: string; answering?: string; files: readonly File[]; until: number; login?: ContinueLogin }
		| undefined;
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
	/** Whether the "+" menu is open. It stays on the page a moment longer while it leaves (#setMenu). */
	#menuOpen = false;
	/** The menu taking the height of the page it just turned to (#turnMenuPage). */
	#menuResize: Animation | undefined;
	readonly #models: ComposerModels;
	/** Which of the member's logins pays here; only where the conversation's model account is shown. */
	readonly #logins: ComposerLogins | undefined;
	readonly #attach: HTMLButtonElement;
	readonly #attachNote: HTMLElement;
	readonly #identity: HTMLButtonElement;
	readonly #lifetime = new AbortController();
	/** The coding sessions still going, as a pill above the composer. */
	readonly #coding = new CodingPill(
		(workerId, opener) => this.#openCodingSession(workerId, opener),
		this.#lifetime.signal,
	);
	/** The other members who have this conversation open right now. */
	readonly #here = h("div", { class: "thread-presence", role: "group", hidden: true });
	#hereKey = "";
	#codingPoll: ReturnType<typeof setTimeout> | undefined;
	/** A read is on its way; the next one is scheduled when it lands, never beside it. */
	#codingReading = false;
	/** Reads that failed in a row; each one doubles the wait, up to eight times. */
	#codingFailures = 0;
	readonly #navigation: HTMLButtonElement;
	readonly #body: HTMLElement;
	readonly #conversationPane: HTMLElement;
	readonly #notificationSignal: AbortSignal;
	readonly #actions: WorkspaceActions;
	/** Undo of an agent's interface change, by its commit, while the member is in this thread. */
	readonly #undos = new Map<string, InterfaceUndoState>();
	/** Each message drawn in the thread: what it is and who wrote it, for its right-click menu. */
	readonly #messageItems = new WeakMap<Element, { item: TranscriptMessage; author: string; mine: boolean }>();
	/** What opens the next message menu: "key" after Shift+F10 or the menu key in the thread, else the type of the
	 * pointer last pressed there ("mouse", "pen", "touch"). */
	#menuInput = "";
	/** Why the last Copy from a message's menu failed, said above the composer until a Copy works. */
	#copyFailure: string | undefined;
	/** The member's erases of messages here, one line each, oldest first, each read until it is done or fails (summary
	 * trees M3c). */
	#erases: EraseLine[] = [];
	readonly #run: SessionRunView | undefined;
	readonly #execution: SessionExecutionView | undefined;
	#details: AgentDetails | GroupDetails | undefined;
	/** The company's open computers; this thread shows its agent's while the member is here. */
	readonly #panels: ComputerPanels;
	readonly #ownPanels: boolean;
	#panel: ComputerPanel | undefined;
	/** The transcript of this agent and a coworker, laid over the thread from a chip. */
	#pair: PairTranscriptView | undefined;
	/** What stands beside the thread: a page of the Company File (views/app-panel.ts). */
	#beside: { readonly el: HTMLElement; dispose(): void; focus(): void } | undefined;
	/** The chip that opened the transcript; focus returns there when it closes. */
	#pairOpener: HTMLElement | undefined;
	#headerKey = "";
	#renderedKey = "";
	#messagesSnap:
		| {
				readonly projection: ConversationState["projection"];
				readonly optimistic: ConversationState["optimistic"];
				readonly codingSessions: ConversationState["codingSessions"];
				readonly proposals: ConversationState["proposals"];
				readonly discardingProposals: ConversationState["discardingProposals"];
				readonly interactionAnswers: ConversationState["interactionAnswers"];
				readonly interactionError: ConversationState["interactionError"];
				readonly hasEarlier: ConversationState["hasEarlier"];
				readonly earlierLoading: ConversationState["earlierLoading"];
				readonly earlierError: ConversationState["earlierError"];
				readonly loading: ConversationState["loading"];
				readonly error: ConversationState["error"];
				readonly session: HostedSession | undefined;
				readonly team: ReturnType<CompanyController["store"]["get"]>["team"];
				readonly staff: ReturnType<CompanyController["store"]["get"]>["staff"];
				readonly interfaceFolder: ReturnType<CompanyController["store"]["get"]>["interfaceFolder"];
				readonly mentionsReady: ReturnType<CompanyController["store"]["get"]>["mentionsReady"];
				readonly groups: ReturnType<CompanyController["store"]["get"]>["groups"];
				readonly accessLost: ReturnType<CompanyController["store"]["get"]>["accessLost"];
				readonly agentName: string;
				readonly agent: HostedStaffAgent | undefined;
				readonly agentState: string;
				readonly working: boolean;
				readonly waitingRun: boolean;
				readonly runAtWork: string | undefined;
				readonly computerShown: boolean;
				readonly decisionsWaiting: unknown;
				readonly decisionsDecidedKey: unknown;
				readonly clock: string;
				readonly readyShown: unknown;
				readonly siteCardsKey: unknown;
				readonly nextExpiryAt: number;
		  }
		| undefined;
	readonly #foldPreviews = new Map<string, { readonly raw: string; readonly preview: string }>();
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
	 * grows (window, computer panel, composer), or messages that grow after they are
	 * drawn, must keep showing the latest message. */
	readonly #sizes: ResizeObserver | undefined;
	/** What stands under the messages (notices, the coding pill, the composer), laid over the thread's foot
	 * with no background of its own, so the messages scroll on behind it (Jonas, 9 Nov 2026). */
	readonly #foot = h("div", { class: "thread-foot" });
	readonly #unsubscribe: (() => void)[] = [];
	#disposed = false;
	#statusKey = "";
	/** A failed run, shown as one line right above the composer, in the same band as the company notices. */
	readonly #runNotification = h("div", { class: "thread-run-failure", hidden: true });
	#runNotificationKey = "";
	/** The login a stopped run's card is continuing its work with now ("Continue with …"). */
	#continuing: { runId: string; connectionId: string } | undefined;
	/** What the card says after its last pick: that it failed, or that the member's own message continues the work. */
	#continueNote: { runId: string; text: string } | undefined;
	/** An approval card's Always allow editor, by review id: kept across re-renders. */
	readonly #reviewDrafts = new Map<string, ActionReviewDraft>();
	/** The approval card to give focus after the thread redraws (it was just answered). */
	#focusReview: string | undefined;
	/** Every item of the last render by its id: a redraw keeps the nodes of unchanged items. */
	#drawn = new Map<string, DrawnItem>();
	/** The working figure's row and the empty thread's line, kept while they read the same. */
	#activityRow: { key: string; element: HTMLElement } | undefined;
	readonly #openFolds = new Set<string>();
	readonly #firstWords = new Map<string, { since?: number; shown?: true }>();
	#firstWordsThrough: number | undefined;
	#firstWordsTimer: ReturnType<typeof setTimeout> | undefined;
	#emptyRow: HTMLElement | undefined;
	/** The agent's computer is a row of the thread (Jonas, 14 Nov 2026: "a bigger window next to the working agent inside
	 * of the thread"): its window stands beside the agent's figure. While the agent uses its computer the row is the live
	 * end, in the working figure's place; once it stops, the row stays where it stood and what comes next goes under it. */
	readonly #computerSlot = h("div", { class: "thread-computer-window" });
	readonly #computerFigure = h("div", { class: "thread-computer-figure" });
	readonly #computerCaption = h("p", { class: "thread-computer-caption" });
	readonly #computerWords = h("p", { class: "thread-computer-caption thread-computer-words", hidden: true });
	readonly #computerRow = h(
		"div",
		{ class: "thread-computer" },
		this.#computerFigure,
		h("div", { class: "thread-computer-main" }, this.#computerSlot, this.#computerCaption, this.#computerWords),
	);
	/** What the figure beside the window was drawn for, kept while it reads the same (its motion runs on). */
	#computerFigureKey: string | undefined;
	/** The row stands after every item of the thread up to this time (ms): set while it is the live end, kept after. */
	#computerAfter: number | undefined;
	/** A redraw for the computer's row is on its way. */
	#computerRedraw = false;
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
	/** "A change is ready" (own code storage): a card below the thread for each project with a change ready from this
	 * thread's agent, with What's new's own buttons (views/thread-ready.ts). Made once the company has a project that
	 * makes a website, in an agent's thread. */
	#ready: ThreadReady | undefined;
	/** The company's sites, for the card of a site a message links (views/thread-sites.ts). Made once the company has a
	 * site. */
	#siteCards: ThreadSites | undefined;

	constructor(
		company: CompanyController,
		sessionId: string,
		actions: WorkspaceActions = {},
		toggleNavigation?: () => void,
	) {
		this.#company = company;
		const scoped = new AbortController();
		const abortScoped = () => scoped.abort();
		this.#lifetime.signal.addEventListener("abort", abortScoped, { once: true });
		if (company.signal.aborted) scoped.abort(company.signal.reason);
		else company.signal.addEventListener("abort", abortScoped, { once: true, signal: this.#lifetime.signal });
		this.#notificationSignal = scoped.signal;
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
				if (event.key === "Escape" && !event.isComposing && this.#answerShown) {
					company.setAnswering(sessionId, undefined);
					return;
				}
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
				if (this.#menuOpen) this.#setMenu(false, false);
				this.#closeMention();
			},
			// Messages already written mark the names of skills once the list is known: through a
			// redraw, so the marks land with the messages (the live log reads nothing twice) and the
			// thread stays pinned to its end if a name re-wraps a line.
			listed: () => {
				this.#renderedKey = "";
				this.#messagesSnap = undefined;
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
		this.#dictation = new Dictation(
			this.#composer,
			(start, end, text) => {
				this.#edits.declare(start, end);
				this.#composer.setRangeText(text, start, end, "end");
				this.#composer.dispatchEvent(new Event("input", { bubbles: true }));
			},
			this.#lifetime.signal,
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
				onclick: () => this.#setMenu(!this.#menuOpen),
			},
			icon("plus"),
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
			() => this.#setSubmenu(this.#models, true),
			() => this.update(),
		);
		this.#logins = this.#execution
			? new ComposerLogins(
					this.#execution,
					() => {
						if (this.#logins) this.#setSubmenu(this.#logins, true);
					},
					() => {
						if (this.#logins) this.#setSubmenu(this.#logins, false);
					},
				)
			: undefined;
		this.#attachNote = h(
			"p",
			{ class: "composer-menu-note", hidden: true },
			t("Images are not supported in group chats. Use Company File."),
		);
		this.#menuMain = h(
			"div",
			null,
			this.#attach,
			this.#attachNote,
			h("div", { class: "composer-menu-separator", role: "separator" }),
			this.#models.button,
			this.#logins?.button,
		);
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
			this.#logins?.el,
		);
		this.#menu.addEventListener("keydown", (event) => {
			const submenus = [this.#models, ...(this.#logins ? [this.#logins] : [])];
			const open = submenus.find((submenu) => !submenu.el.hidden);
			const opener = submenus.find((submenu) => document.activeElement === submenu.button);
			if (matchesKey(event, "dismiss") || (matchesKey(event, "left") && open)) {
				event.preventDefault();
				event.stopPropagation();
				if (open) this.#setSubmenu(open, false);
				else this.#setMenu(false);
			} else if (matchesKey(event, "right") && opener) {
				event.preventDefault();
				this.#setSubmenu(opener, true);
			} else if (
				["next", "previous", "first", "last"].some((key) =>
					matchesKey(event, key as "next" | "previous" | "first" | "last"),
				)
			) {
				event.preventDefault();
				const page = open?.el ?? this.#menuMain;
				const controls = [
					...page.querySelectorAll<HTMLElement>(
						'button:not(:disabled):not([hidden]), [role="slider"][tabindex="0"]:not([aria-disabled="true"])',
					),
				];
				const current = controls.indexOf(document.activeElement as HTMLElement);
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
		this.#answerStop = h(
			"button",
			{
				type: "button",
				class: "composer-answer-stop icon-button",
				"aria-label": t("Stop answering"),
				title: t("Stop answering"),
				onclick: () => {
					company.setAnswering(sessionId, undefined);
					this.#composer.focus();
				},
			},
			icon("close"),
		);
		this.#answerStrip = h(
			"div",
			{ class: "composer-answer", hidden: true },
			this.#answerEmblem,
			h("div", { class: "composer-answer-words" }, this.#answerLabel, this.#answerQuestion),
			this.#answerStop,
		);
		this.#composerShell = h(
			"div",
			{ class: "composer-shell" },
			this.#answerStrip,
			this.#attachments.el,
			this.#skills.field,
			this.#more,
			this.#dictation.button,
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
			this.#dictation.status,
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
		this.#header.append(this.#navigation, this.#identity, this.#here);
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
		sentTimeHover(this.#messages, this.#lifetime.signal);
		this.#refreshFade = quietScroll(this.#messages);
		this.#messages.addEventListener("scroll", () => {
			const { scrollTop, scrollHeight, clientHeight } = this.#messages;
			if (this.#stickToBottom && scrollTop === this.#pinnedTop) {
				this.#pinnedTop = -1;
				return;
			}
			this.#stickToBottom = scrollHeight - scrollTop - clientHeight < 48 * uiScale();
		});
		// A message's own menu: a right-click, a long press, or Shift+F10 or the menu key from a link in it. Also on an
		// earlier page's message, which stands outside the live log. A browser fires the keyboard's at the focused element's
		// place, not at 0,0, so the key itself is noted (on Windows the menu key opens it on release), and so is the type of
		// the pointer pressed last.
		const menuKey = (event: KeyboardEvent) => {
			if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) this.#menuInput = "key";
		};
		this.#messages.addEventListener("keydown", menuKey);
		this.#messages.addEventListener("keyup", menuKey);
		this.#messages.addEventListener("pointerdown", (event) => {
			this.#menuInput = event.pointerType;
		});
		this.#messages.addEventListener("contextmenu", (event) => this.#openMessageMenu(event));
		if (typeof ResizeObserver !== "undefined") {
			this.#sizes = new ResizeObserver(() => {
				// The messages keep room under their last line for the foot laid over them.
				this.#conversationPane.style.setProperty("--thread-foot", `${this.#foot.offsetHeight}px`);
				this.#pinToBottom();
			});
			this.#sizes.observe(this.#messages);
			this.#sizes.observe(this.#foot);
			// A message that grows after it is drawn (a sent image's picture arriving) keeps the latest one in view too.
			this.#sizes.observe(this.#log);
		} else queueMicrotask(() => this.#pinToBottom()); // The application mounts the view right after construction.
		// A conversation opened comes in: the thread fades up in place (styles/motion.css).
		playOnce(this.#messages, "is-entering");
		this.#conversationPane = h(
			"div",
			{ class: "thread-conversation" },
			this.#header,
			this.#messages,
			this.#earlierStatus,
			this.#foot,
		);
		this.#foot.append(
			this.#status,
			...(actions.notificationHost ? [actions.notificationHost] : []),
			this.#runNotification,
			this.#coding.el,
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
		const refreshTimestamps = () => {
			if (!document.hidden) this.#refreshTimestamps();
		};
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
				if (this.#menuOpen && !this.#composerShell.contains(event.target as Node)) this.#setMenu(false, false);
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

	#gatherDecisions(): void {
		if (this.#decisions || this.#disposed || !this.#actions.decisions) return;
		const dock = new DecisionDock(this.#actions.decisions);
		dock.onChange(() => this.update());
		this.#composerWrap.before(dock.el);
		this.#decisions = dock;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort();
		this.#decisions?.dispose();
		window.clearInterval(this.#timestampTimer);
		this.#sizes?.disconnect();
		this.#runNotification.remove();
		this.#details?.dispose();
		this.#closePair(false);
		this.closeBeside(false);
		// The computer stays open, and connected, for the next thread that shows it.
		if (this.#ownPanels) this.#panels.dispose();
		else this.#panel?.detach();
		this.#panel = undefined;
		this.#attachments.dispose();
		this.#sharedDrafts.dispose();
		for (const drawn of this.#drawn.values()) {
			drawn.abort?.();
			drawn.message?.files?.view.dispose();
		}
		this.#drawn.clear();
		this.#foldPreviews.clear();
		this.#messagesSnap = undefined;
		this.#skillsCheckedProjection = undefined;
		this.#skillsCheckedOptimistic = undefined;
		this.#closeCodingSession();
		clearTimeout(this.#codingPoll);
		clearTimeout(this.#firstWordsTimer);
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
		const taller = this.#attachments.count > 0 || this.#answerShown !== undefined;
		this.#composerShell.classList.toggle("is-expanded", taller);
		this.#composer.style.height = "auto";
		const field = getComputedStyle(this.#composer);
		const oneLine = Math.ceil(Number.parseFloat(field.minHeight) || 0);
		const tallest = Number.parseFloat(field.maxHeight) || Number.POSITIVE_INFINITY;
		let contentHeight = this.#composer.scrollHeight;
		const expanded = contentHeight > oneLine || taller;
		if (expanded !== taller) {
			this.#composerShell.classList.toggle("is-expanded", expanded);
			contentHeight = this.#composer.scrollHeight;
		}
		const targetHeight = Math.min(contentHeight, tallest);
		this.#composer.style.height = `${targetHeight}px`;
		this.#composer.style.overflowY = contentHeight > tallest ? "auto" : "hidden";
		const shell = getComputedStyle(this.#composerShell);
		const frame = [shell.paddingTop, shell.paddingBottom, shell.borderTopWidth, shell.borderBottomWidth].reduce(
			(sum, value) => sum + (Number.parseFloat(value) || 0),
			0,
		);
		const composerHeight = this.#composer.getBoundingClientRect().height;
		const attachmentsHeight = this.#attachments.count > 0 ? this.#attachments.el.getBoundingClientRect().height : 0;
		const answerHeight = this.#answerShown !== undefined ? this.#answerStrip.getBoundingClientRect().height : 0;
		this.#composerShell.style.height = `${composerHeight + frame + attachmentsHeight + answerHeight}px`;
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

	/** Opens the "+" menu on its main page, or closes it. Closing, the menu goes back into the "+" showing the
	 * page it was on (styles/motion.css) and is out of reach at once; it is hidden when that has played. */
	#setMenu(open: boolean, restoreFocus = true): void {
		const wasOpen = this.#menuOpen;
		this.#menuOpen = open;
		this.#more.setAttribute("aria-expanded", String(open));
		if (open) {
			this.#resetMenu();
			this.#menu.hidden = false;
			this.#focusMenu();
			return;
		}
		if (wasOpen)
			leave(this.#menu, "is-leaving", () => {
				// Opened again while it left: it stays.
				if (this.#menuOpen) return;
				this.#menu.hidden = true;
				this.#resetMenu();
			});
		if (restoreFocus) this.#more.focus();
	}

	/** The menu back on its main page and within reach: leave() takes it out of reach but, since the menu is
	 * kept for its next opening, cannot give it back. */
	#resetMenu(): void {
		this.#menuMain.hidden = false;
		for (const submenu of [this.#models, this.#logins]) {
			if (!submenu) continue;
			submenu.el.hidden = true;
			submenu.button.setAttribute("aria-expanded", "false");
		}
		this.#menuResize?.cancel();
		this.#menu.classList.remove("is-leaving");
		this.#menu.inert = false;
		delete this.#menu.dataset.leaving;
		this.#menu.style.removeProperty("pointer-events");
	}

	/** A group chat's menu may hold no live control; the menu itself then takes focus so Escape still closes it. */
	#focusMenu(): void {
		const first = this.#menuMain.querySelector<HTMLButtonElement>("button:not(:disabled):not([hidden])");
		(first ?? this.#menu).focus();
	}

	/** Opens a page of the menu (Model, Login) in place of its main page, or goes back from it. Going back,
	 * focus returns to the page's row, or to the menu while that row can't take it (hidden, or disabled
	 * during a read), so Escape and the arrows keep working. */
	#setSubmenu(submenu: ComposerModels | ComposerLogins, open: boolean, restoreFocus = true): void {
		if (open && (submenu.button.disabled || submenu.button.hidden)) return;
		const turns = this.#menuOpen && submenu.el.hidden === open;
		const height = this.#menu.offsetHeight;
		this.#menuMain.hidden = open;
		submenu.el.hidden = !open;
		submenu.button.setAttribute("aria-expanded", String(open));
		if (turns) this.#turnMenuPage(open ? submenu.el : this.#menuMain, height, open);
		if (open) {
			submenu.focus();
			if (submenu === this.#models) void this.#models.refresh();
		} else if (restoreFocus) {
			if (submenu.button.hidden || submenu.button.disabled) this.#focusMenu();
			else submenu.button.focus();
		}
	}

	/** The open menu turns to `page`: it comes in from the side it lies on (a page of its own from the right, the
	 * main page from the left) while the menu goes from the `height` it had to the page's. */
	#turnMenuPage(page: HTMLElement, height: number, forward: boolean): void {
		playOnce(page, forward ? "is-page-arriving" : "is-page-returning");
		this.#menuResize?.cancel();
		if (reducedMotion() || typeof this.#menu.animate !== "function") return;
		const to = this.#menu.offsetHeight;
		if (!height || !to || Math.abs(to - height) < 2) return;
		const resize = this.#menu.animate([{ height: `${height}px` }, { height: `${to}px` }], {
			duration: 220,
			easing: easing("--ease-out"),
		});
		this.#menuResize = resize;
		// The taller page shows no scroll bar while the menu grows to it.
		this.#menu.style.overflow = "clip";
		const clear = () => {
			if (this.#menuResize !== resize) return;
			this.#menuResize = undefined;
			this.#menu.style.removeProperty("overflow");
		};
		resize.finished.then(clear, clear);
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
			? new AgentDetails(this.#company, agent, this.#actions, closed, this.#identity, this.#lifetime.signal, {
					computer: () => this.show(agent.id, "computer", true),
					conversationId: this.#sessionId,
				})
			: new GroupDetails(
					this.#company,
					this.#sessionId,
					closed,
					this.#identity,
					this.#lifetime.signal,
					this.#actions,
					{ conversationId: this.#sessionId },
				);
	}

	/** Opens this agent's computer here, as its card asks. False while the thread is not that agent's, or does not know
	 * its agent yet: the card's request then waits. `asked`: the member's own click asked for it just now, so a sleeping
	 * computer wakes (computer.ts OPEN_STARTS); false, the default, for the page's own opens. */
	show(agentId: string, page: AgentPage, asked = false): boolean {
		const state = this.#company.store.get();
		const agent = this.#company.staffById(
			state.sessions.find((session) => session.sessionId === this.#sessionId)?.staffAgentId,
		);
		if (this.#disposed || !agent || agent.id !== agentId) return false;
		// The computer sits under the pages laid over the thread: they close for it.
		this.#closePair(false);
		this.#closeCodingSession();
		if (page === "computer") {
			const shown = this.#panel;
			// Already here: the click still asks for the computer (a sleeping one wakes).
			if (shown && asked) this.#panels.open(agent, { asked });
			(shown ?? this.#showPanel(agent, asked))?.focus();
			this.#revealComputer();
		}
		return true;
	}

	/** What stands beside the thread now, if anything. */
	get beside(): object | undefined {
		return this.#beside;
	}

	/** Stands `panel` beside the thread, in place of what stood there: the thread stays as it is, and usable (Jonas,
	 * 5 November 2026). A Company File page linked in a message stands here; an agent's app opens on its own page. */
	showBeside(panel: { readonly el: HTMLElement; dispose(): void; focus(): void }): void {
		if (this.#disposed) {
			panel.dispose();
			return;
		}
		this.#beside?.dispose();
		this.#beside = panel;
		this.#body.insertBefore(panel.el, this.#conversationPane.nextSibling);
		this.#body.classList.add("has-beside");
		this.#autosize();
		panel.focus();
	}

	closeBeside(refocus: boolean): void {
		const panel = this.#beside;
		if (!panel) return;
		this.#beside = undefined;
		panel.dispose();
		this.#body.classList.remove("has-beside");
		if (this.#disposed) return;
		this.#autosize();
		if (refocus && !this.#composer.disabled && !this.#composerWrap.hidden)
			this.#composer.focus({ preventScroll: true });
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
			// Closing it is the member's no for the rest of the agent's stretch at its computer (20260930742000).
			this.#panels.byItself.closed(this.#panel.agentId, this.#company.atComputer(this.#panel.agentId)?.since);
			this.#panels.close(this.#panel.agentId);
			this.#panel = undefined;
			this.#autosize();
			this.#redrawComputer();
			if (!this.#composer.disabled && !this.#composerWrap.hidden) this.#composer.focus({ preventScroll: true });
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
		this.#messagesSnap = undefined;
		this.update();
		let state: InterfaceUndoState;
		try {
			state = { state: "answered", answer: await undo(change, this.#lifetime.signal) };
		} catch {
			state = { state: "failed" };
		}
		if (this.#lifetime.signal.aborted) return;
		this.#undos.set(change.commitId, state);
		this.#messagesSnap = undefined;
		this.update();
	}

	/** A message's menu, for an owner or admin, the roles the erase route takes (M3c): Erase, or for a message already
	 * erased, how its erase went (its copies included), read again. A message on its way has none, and with nothing to
	 * offer the browser's own menu stays. So it does for a right-click or a long press on a link, an image or attachment
	 * (Open link, Copy link address, Save image), and for a mouse or pen right-click on text the member selected in the
	 * message (Copy). The keyboard (Shift+F10, the menu key) still opens the message's there, since a link is its only way
	 * into a message. So does a long press on the message's text (Android; iOS Safari sends no menu for a touch, so there
	 * a pointer or a keyboard opens it), and the message's menu then offers Copy in place of the browser's: Chrome selects
	 * the word under the finger before the menu comes, which Copy takes, while Firefox would select it only after an
	 * untaken menu, so with nothing selected it offers Copy message, the message's whole text. */
	#openMessageMenu(event: MouseEvent): void {
		// What opened it: a key noted, else the event's own pointer (Chrome and Firefox send the menu as a pointer event,
		// with no pointer type for a key), else the pointer pressed last.
		const input = this.#menuInput;
		this.#menuInput = "";
		const pointer = (event as Partial<PointerEvent>).pointerType;
		const keyboard = input === "key" || pointer === "" || !(event.clientX || event.clientY);
		const touch = (pointer || input) === "touch";
		const target = event.target instanceof Element ? event.target : null;
		const element = target?.closest<HTMLElement>("article.message") ?? null;
		const drawn = element ? this.#messageItems.get(element) : undefined;
		const role = this.#company.store.get().team?.role;
		if (
			!target ||
			!element ||
			!drawn ||
			drawn.item.pending ||
			!this.#actions.messageErases ||
			(role !== "owner" && role !== "admin")
		)
			return;
		const selection = document.getSelection();
		const selected =
			selection &&
			!selection.isCollapsed &&
			selection.toString().trim() &&
			(element.contains(selection.anchorNode) || element.contains(selection.focusNode))
				? selection.toString()
				: "";
		if (
			!keyboard &&
			(target.closest("a[href], a[data-href], img, video, audio, .received-attachments") || (!touch && selected))
		)
			return;
		event.preventDefault();
		const { item, author, mine } = drawn;
		const copy =
			!touch || item.erased || !navigator.clipboard
				? undefined
				: selected
					? { label: t("Copy"), text: selected }
					: item.text.trim()
						? { label: t("Copy message"), text: item.text }
						: undefined;
		const point = menuPoint(event, element);
		// Focus goes back to the link the menu was opened from, else to the message itself.
		const focused = document.activeElement;
		const opener = focused instanceof HTMLElement && element.contains(focused) ? focused : this.#focusable(element);
		openContextMenu({
			label: t("Message from {name}", { name: author }),
			x: point.x,
			y: point.y,
			items: [
				...(copy
					? [
							{
								label: copy.label,
								icon: "copy",
								select: () =>
									void navigator.clipboard.writeText(copy.text).then(
										() => this.#copied(undefined),
										() => this.#copied(t("The text could not be copied.")),
									),
							},
						]
					: []),
				item.erased
					? {
							label: t("Show how the erase went"),
							icon: "trash",
							select: () => void this.#showErase(item, author, mine),
						}
					: {
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
		const what = eraseWhat(item, author, mine);
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
		await this.#followErase(item, what, (error) => eraseFailure(error, what));
	}

	/** A Copy from a message's menu ended: says so above the composer when it failed, and clears that once one works. */
	#copied(failure: string | undefined): void {
		if (this.#lifetime.signal.aborted || failure === this.#copyFailure) return;
		this.#copyFailure = failure;
		this.update();
	}

	/** How the erase of a message already erased went, read again without asking: the erase route answers an erased
	 * message with the erase that did it, its copies included (an erase this view lost track of, or another member's). */
	async #showErase(item: TranscriptMessage, author: string, mine: boolean): Promise<void> {
		const what = eraseWhat(item, author, mine);
		await this.#followErase(item, what, () =>
			t("Could not read how the erase of the message from {author} at {time} is going.", what),
		);
	}

	/** Asks the erase route for one message's erase and gives it a line of its own above the composer, read again until
	 * it is done or refused, while the member erases other messages. A new line replaces the message's earlier one and
	 * takes the place of the lines with nothing more to say (refused, failed, or done with no copy left). */
	async #followErase(
		item: TranscriptMessage,
		what: EraseLine["what"],
		failure: (error: unknown) => string,
	): Promise<void> {
		const erases = this.#actions.messageErases;
		const signal = this.#lifetime.signal;
		if (!erases || signal.aborted) return;
		const line: EraseLine = { messageId: item.id, what };
		this.#erases = [...this.#erases.filter((other) => other.messageId !== item.id && !eraseSettled(other)), line];
		this.update();
		const followed = () => !signal.aborted && this.#erases.includes(line);
		let erase: MessageErase;
		try {
			erase = await erases.request(this.#sessionId, item.id, signal);
		} catch (error) {
			if (!followed()) return;
			line.failure = failure(error);
			this.update();
			return;
		}
		// Read again after 1, 2, 4… seconds, then every 30 seconds, until it is done or refused.
		let reread = item.erased === true;
		for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
			if (!followed()) return;
			// From `open` on the message is blank in the cloud: a full read draws it as "(erased)".
			if (!reread && erase.state !== "pending" && erase.state !== "refused") {
				reread = true;
				void this.#company.loadConversation(this.#sessionId);
			}
			line.erase = erase;
			this.update();
			if (erase.state === "done" || erase.state === "refused") return;
			await pause(wait, signal);
			if (!followed()) return;
			try {
				erase = await erases.status(erase, signal);
			} catch (error) {
				const status = error instanceof MessageEraseError ? error.status : null;
				// Refused or gone for this member: say so once. Anything else is read again at the next turn.
				if (status === 401 || status === 403 || status === 404) {
					if (!followed()) return;
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

	/** The take-over card's Open computer (review r1 F1 of #1812): what its Take over did, but the hold. The agent's
	 * computer here, asked by the member's own click (a sleeping one wakes: computer.ts OPEN_STARTS), focused, and its
	 * large view once a picture shows, where the member uses it as it is shared. */
	#openComputer(agent: HostedStaffAgent): void {
		if (this.#panel) this.#panels.open(agent, { asked: true });
		const panel = this.#panel ?? this.#showPanel(agent, true);
		panel?.focus();
		this.#revealComputer();
		panel?.enterWhenShown();
	}

	/** The computer opened on the member's click (the agent card's Computer, the take-over card's Open computer): the
	 * thread goes to where its window stands, for a click whose answer is under the fold is no answer (found on the
	 * live app, 15 Nov 2026: the window came in at the thread's end, under the composer). A window at the thread's end
	 * keeps the thread at its end while it grows into its place (the start scene, then the picture: the size observer
	 * pins it); one that stands further up, where the agent left it, comes into view between the thread's top and the
	 * foot laid over its bottom. The window takes the keyboard without a scroll of the browser's own (ComputerPanel
	 * focus): that scroll knew nothing of the foot and left the thread just short of its end, where it no longer
	 * followed. A window that shows by itself (#computerByItself) never moves a thread the member has scrolled. */
	#revealComputer(): void {
		// After the redraw that puts the row in its place (#redrawComputer's microtask, queued before this one).
		queueMicrotask(() => {
			const row = this.#computerRow;
			if (this.#disposed || !this.#panel || !row.isConnected) return;
			// The large view covers the thread from the row: nothing to bring into view.
			if (this.#panel.el.classList.contains("is-entered")) return;
			const followed = this.#timestampRows.some(
				({ node }) => (row.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
			);
			if (!followed) {
				this.#stickToBottom = true;
				this.#pinToBottom();
				return;
			}
			const view = this.#messages.getBoundingClientRect();
			const box = row.getBoundingClientRect();
			const gap = 12 * uiScale();
			const top = view.top + gap;
			const bottom = view.bottom - this.#foot.offsetHeight - gap;
			// Taller than the room, or above it: its top at the top. Below it: its bottom at the foot.
			const by = box.top < top || box.height > bottom - top ? box.top - top : Math.max(0, box.bottom - bottom);
			if (by !== 0) this.#messages.scrollTop += by;
		});
	}

	/** The agent's computer shows here by itself while the agent works at it (20260930742000; the rules are in
	 * computer-by-itself.ts): watch only, without focus, once per stretch of the agent's use; it stays after. */
	#computerByItself(agent: HostedStaffAgent | undefined): void {
		if (!agent || this.#disposed) return;
		const rules = this.#panels.byItself;
		const since = this.#agentState === "computer" ? this.#company.atComputer(agent.id)?.since : undefined;
		if (since === undefined || !rules.wanted(agent.id, since, this.#panel !== undefined, this.#panels.busy())) return;
		// Not the member's ask (`asked: false`): a window that shows by itself never wakes or starts a computer (the agent's
		// machine runs while it uses it); a sleeping one shows the asleep scene with Wake it, for the member to press.
		const panel = this.#showPanel(agent, false);
		if (panel) rules.opened(agent.id, since);
	}

	/** Show the agent's computer here: the one already open, or one started now. `asked`: the member's own click. */
	#showPanel(agent: HostedStaffAgent, asked = false): ComputerPanel | undefined {
		const panel = this.#panels.open(agent, { asked });
		if (!panel) return undefined;
		// A window that comes into the thread stands at its end; one already here stays where it is.
		if (!this.#computerSlot.contains(panel.el)) this.#computerAfter = undefined;
		this.#panel = panel;
		// In the thread at once (at its end, where a new window stands), before the window comes into it: one that comes
		// back entered covers the thread from there (review r1 F3 of #1787). The redraw puts the row in its place.
		if (!this.#computerRow.isConnected) this.#log.append(this.#computerRow);
		panel.attach(this.#computerSlot, () => this.#toggleComputer());
		this.#autosize();
		this.#redrawComputer();
		return panel;
	}

	/** The computer came into the thread or left it outside a redraw: its row is placed again (a row with no window
	 * leaves at once). */
	#redrawComputer(): void {
		if (!this.#panel) this.#computerRow.remove();
		if (this.#computerRedraw) return;
		this.#computerRedraw = true;
		queueMicrotask(() => {
			this.#computerRedraw = false;
			this.update();
		});
	}

	/** The figure beside the computer's window: working at it while the agent uses it, else still, as in its messages.
	 * The line under the window says so in words. */
	#drawComputerFigure(agent: HostedStaffAgent | undefined, agentName: string, working: boolean, locale: string): void {
		const state = working ? this.#agentState : "idle";
		const key = JSON.stringify([state, agentName, agent?.id, agent?.appearance, agent?.templateId, locale]);
		if (key === this.#computerFigureKey) return;
		this.#computerFigureKey = key;
		const look = AGENT_LOOK[state];
		replace(this.#computerFigure, agentFigure(agent, agentName, { size: 40, activity: look.figure }));
		const caption = working ? activityCaption(look, agentName).label : "";
		this.#computerCaption.textContent = caption;
		this.#computerCaption.hidden = !caption;
	}

	// WHY: the agent's state and the thread are read apart, so first words can be seen a moment before their run is
	// (or after it ended, before its answer is): they wait that moment out instead of flashing as a message.
	#holdFirstWords(
		items: readonly TranscriptItem[],
		acknowledgements: ReadonlyMap<string, RunAcknowledgement>,
		runAtWork: string | undefined,
		still: boolean,
	): string[] {
		clearTimeout(this.#firstWordsTimer);
		this.#firstWordsTimer = undefined;
		if (still) return [];
		const now = Date.now();
		const through = this.#firstWordsThrough;
		const held: string[] = [];
		let next = Number.POSITIVE_INFINITY;
		let newest = through ?? 0;
		for (const item of items) {
			if (item.sequence !== Number.MAX_SAFE_INTEGER) newest = Math.max(newest, item.sequence);
			const acknowledgement = acknowledgements.get(item.id);
			if (!acknowledgement) continue;
			let entry = this.#firstWords.get(item.id);
			if (!entry) {
				entry = through !== undefined && item.sequence > through ? { since: now } : {};
				this.#firstWords.set(item.id, entry);
			}
			if (acknowledgement.followed) continue;
			if (acknowledgement.runId === runAtWork) {
				entry.shown = true;
				entry.since = undefined;
				continue;
			}
			if (entry.shown) {
				entry.shown = undefined;
				entry.since = now;
			}
			if (entry.since === undefined) continue;
			const until = entry.since + FIRST_WORDS_WAIT_MS;
			if (until <= now) continue;
			held.push(item.id);
			next = Math.min(next, until);
		}
		this.#firstWordsThrough = newest;
		for (const id of this.#firstWords.keys()) if (!acknowledgements.has(id)) this.#firstWords.delete(id);
		if (held.length)
			this.#firstWordsTimer = setTimeout(() => {
				this.#messagesSnap = undefined;
				this.update();
			}, next - now);
		return held;
	}

	/** One button: it sends a draft, and with nothing to send it stops the run the agent is on. */
	#syncSend(): void {
		// The run controller reports once while this view is still being built.
		if (this.#disposed || !this.#send) return;
		const empty = !this.#composer.value.trim() && !this.#attachments.count;
		// A run waiting at its login's usage limit is no work in progress, yet it holds the conversation until it goes on:
		// the member may stop it as they stop a working run (20260930703000).
		const stop =
			empty &&
			(this.#working || this.#waitingRun) &&
			(this.#run?.stoppable === true || this.#run?.stopping === true);
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

	/** What the draft answers, above the field: for a note sent from an app's page and left waiting here
	 * (app/tell-agent.ts), the app (its own name and emblem once the company's apps are read) and what the note is about.
	 * Never the line as written: the send puts it first (cloud/wall-reply.ts `withReply`). A line that names no app
	 * shows as "Answering" and the line: the agent's wall used to set one, and nothing in the web does since it went
	 * (Jonas, 14 Nov 2026). */
	#showAnswering(answering: string | undefined): void {
		const note = answering === undefined ? undefined : appNoteHeader(answering);
		const app = this.#answerApp(answering);
		this.#answerStrip.hidden = !answering;
		this.#answerStrip.classList.toggle("is-note", note !== undefined);
		this.#answerEmblem.hidden = note === undefined;
		replace(this.#answerEmblem, note ? (app?.look?.emblem() ?? interfaceEmblem("page", 34)) : "");
		if (app?.look?.colour) this.#answerEmblem.style.setProperty("--app-colour", app.look.colour);
		else this.#answerEmblem.style.removeProperty("--app-colour");
		this.#answerLabel.textContent = note ? (app?.name ?? note.app) : t("Answering");
		this.#answerQuestion.textContent = note ? note.about : (answering ?? "");
		const stop = note?.page ? t("Leave the page out") : note ? t("Leave the app out") : t("Stop answering");
		this.#answerStop.setAttribute("aria-label", stop);
		this.#answerStop.title = stop;
		this.#composer.placeholder = answering && !note ? t("Your answer…") : t("Message…");
	}

	/** The app a waiting note answers, as the company's apps say it now (its name, and its emblem and colour as the
	 * drawer draws them), with a key that changes when any of it does. */
	#answerApp(answering: string | undefined): { name: string; look?: AppLook; key: string } | undefined {
		const note = answering === undefined ? undefined : appNoteHeader(answering);
		if (note?.page) return pageNoteApp(note.app);
		const app = note && this.#company.store.get().apps?.find((entry) => entry.name === note.app);
		if (!app?.manifest) return undefined;
		const look = appLook(this.#company, app);
		return {
			name: app.manifest.name,
			...(look ? { look } : {}),
			key: `${app.manifest.name}\u0000${look?.key ?? ""}`,
		};
	}

	/** A member's message; one that opens with a quoted line (`> question`, an empty line, the member's words) shows the
	 * line above the member's words. Members answered the questions on an agent's wall this way from 7 Nov 2026 until the
	 * wall went (14 Nov 2026), and those messages stay in the threads. A note
	 * sent from an app's page (RUNTIME-INTERFACE-APPS.md §5 "tell") opens with the app's card instead, with what the note
	 * is about as its line: it stands on the thread above the member's words, as an agent's message has its cards, and a
	 * press on it opens the app. */
	#memberParts(text: string, quotes: readonly MessageQuote[] = []): HTMLElement[] {
		const parts = this.#memberWords(text, quotes);
		// A site of the company the member's words link: its card under them, as under an agent's. (A message may come
		// without text: it shows as "(empty)".)
		if (!this.#siteCards || typeof text !== "string") return parts;
		const sites = new Map<string, HTMLElement>();
		for (const [href] of text.matchAll(/https:\/\/[^\s<>"'`]+/g)) {
			const site = this.#linkedSite(href.replace(/[.,;:!?)\]]+$/, ""));
			if (site && !sites.has(site.id)) sites.set(site.id, site.card());
		}
		return sites.size ? [...parts, h("div", { class: "app-cards site-cards" }, [...sites.values()])] : parts;
	}

	/** The card of the company's site a link leads to, once the thread knows the company's sites. */
	#linkedSite(href: string): LinkedSite | undefined {
		const cards = this.#siteCards;
		const site = cards?.match(href);
		return cards && site ? { id: site.id, card: () => cards.card(site) } : undefined;
	}

	/** Brings in the thread's pieces of the company's projects and sites once the company has any: the card of a change
	 * ready from this thread's agent (not in a group chat), and the cards of sites its messages link. */
	#threadPieces(room: boolean, known: boolean): void {
		const company = this.#company.store.get();
		const signal = this.#notificationSignal;
		const releases = this.#actions.codeReleases;
		if (!this.#ready && releases && known && !room && company.whatsNew !== undefined)
			this.#ready = new ThreadReady(this.#company, this.#sessionId, releases.client, releases.options, signal, {
				agentId: () =>
					this.#isRoom
						? undefined
						: this.#company.store.get().sessions.find((item) => item.sessionId === this.#sessionId)?.staffAgentId,
				focusComposer: () => {
					this.focus();
					const end = this.#composer.value.length;
					this.#composer.setSelectionRange(end, end);
				},
				shownChanged: () => this.#redrawItems(),
				...(releases.last ? { last: releases.last } : {}),
			});
		this.#ready?.update();
		const sites = this.#actions.companySites;
		if (!this.#siteCards && sites && (company.siteCount ?? 0) > 0)
			this.#siteCards = new ThreadSites(
				sites.client,
				sites.canManage,
				this.#company.profile.profileId,
				signal,
				() => this.#redrawItems(),
				(siteId) => sitePublicAnswer(this.#company.store.get(), siteId),
			);
		this.#siteCards?.update();
	}

	/** Draws the thread's items again, after the update that asked for it: a card came or went, or the company's sites
	 * changed what a message's links show. */
	#redrawItems(): void {
		queueMicrotask(() => {
			if (this.#disposed) return;
			this.#renderedKey = "";
			this.#messagesSnap = undefined;
			this.update();
		});
	}

	/** A member's words, as #memberParts draws them before any card of a site they link. */
	#memberWords(text: string, quotes: readonly MessageQuote[]): HTMLElement[] {
		const reply = splitReply(text);
		if (!reply) return [h("div", { class: "text" }, ...(text ? this.#withMentions(text, quotes) : [t("(empty)")]))];
		const shift = [...text.slice(0, reply.start)].length;
		const own = quotes.map((quote) => ({ ...quote, start: quote.start - shift, end: quote.end - shift }));
		const note = appNoteHeader(reply.question);
		if (note)
			return [
				h(
					"div",
					{ class: "app-cards" },
					note.page ? pageNoteCard(note.app, note.at, note.about) : appCard(note.app, note.app, note.about),
				),
				...(reply.text ? [h("div", { class: "text" }, ...this.#withMentions(reply.text, own))] : []),
			];
		return [
			h(
				"div",
				{ class: "text" },
				h("span", { class: "message-reply" }, reply.question),
				...this.#withMentions(reply.text, own),
			),
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

	/** Sends the composer's message. `login`: a stopped run's "Continue with …" sends it only on that login. */
	#submit(login?: ContinueLogin): void {
		const text = this.#composer.value;
		this.#sendSoon = undefined;
		if (text.trim() && this.#send.disabled && !this.#submitting && this.#actions.sendMessage) {
			const { answering, attachments } = this.#company.conversation(this.#sessionId).get();
			this.#sendSoon = {
				text,
				...(answering ? { answering } : {}),
				files: [...(attachments ?? [])],
				until: Date.now() + 2000,
				...(login ? { login } : {}),
			};
			return;
		}
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
		this.#dictation.cancel();
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
					current.answering !== state.answering ||
					current.retrySend !== retry ||
					files.length !== currentFiles.length ||
					files.some((file, index) => file !== currentFiles[index])
				)
					return;
				// The account check chose another login meanwhile (another tab's pick, or the cloud's): "Continue with …"
				// never sends on a login the member did not pick there. Its words leave the composer, and the card says so.
				if (login && current.executionSponsor?.connectionId !== login.connectionId) {
					this.#continueNote = { runId: login.runId, text: t("The login could not be chosen. Try again.") };
					this.#edits.declare(0, this.#composer.value.length);
					this.#composer.value = "";
					this.#composer.dispatchEvent(new Event("input", { bubbles: true }));
					return;
				}
				// Read at once by the send, before anything else may run: the message goes on this login.
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
		this.#logins?.update(room, this.#submitting);
		// The Login page leaves with its row: the member has no other login that can pay now. Focus moves only
		// if it was in the menu (the member may be typing in the field).
		if (this.#logins?.button.hidden && !this.#logins.el.hidden)
			this.#setSubmenu(this.#logins, false, this.#menu.contains(document.activeElement));
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
		this.#working = agentWorks(this.#agentState);
		this.#waitingRun = !room && this.#company.pausedRunFor(session?.staffAgentId) !== undefined;
		const isCofounder =
			!room && session?.staffAgentId !== undefined && session.staffAgentId === this.#company.cofounderId();
		if (isCofounder) this.#gatherDecisions();
		this.#renderHeader(session, agent);
		this.#threadPieces(room, Boolean(session));
		if (!room) this.#computerByItself(agent);
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
		if (this.#sendSoon && !this.#send.disabled) {
			const soon = this.#sendSoon;
			this.#sendSoon = undefined;
			const files = conversation.attachments ?? [];
			if (
				soon.text === this.#composer.value &&
				soon.answering === conversation.answering &&
				soon.files.length === files.length &&
				soon.files.every((file, index) => file === files[index]) &&
				Date.now() <= soon.until
			)
				queueMicrotask(() => this.#submit(soon.login));
		}
		this.#attach.disabled = this.#composer.disabled || noImages;
		this.#attachNote.hidden = !noImages;
		this.#more.disabled = this.#composer.disabled;
		this.#dictation.disabled = this.#composer.disabled;
		if (this.#composer.disabled && this.#menuOpen) this.#setMenu(false, false);
		this.#composerWrap.hidden = !canWrite;
		const drawn = JSON.stringify([
			conversation.answering ?? null,
			this.#answerApp(conversation.answering)?.key ?? null,
		]);
		if (conversation.answering !== this.#answerShown || drawn !== this.#answerDrawn) {
			this.#answerShown = conversation.answering;
			this.#answerDrawn = drawn;
			this.#showAnswering(conversation.answering);
			this.#autosize();
		}
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
		// An agent's own chat and a group chat have no header on a wide screen: the rail names them, and their card is there.
		this.#header.classList.toggle("is-agent", Boolean(agent));
		this.#header.classList.toggle("is-group", group);
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
		const companyState = this.#company.store.get();
		const session = companyState.sessions.find((item) => item.sessionId === this.#sessionId);
		const room = isGroupChat(session);
		const runAtWork =
			!room && this.#working && !conversation.loading
				? this.#company.activityFor(session?.staffAgentId)?.runId
				: undefined;
		const computerShown = this.#panel !== undefined && this.#computerSlot.contains(this.#panel.el);
		const clock = this.#clock();
		const nowMs = Date.now();
		const prevSnap = this.#messagesSnap;
		if (
			prevSnap !== undefined &&
			this.#renderedKey !== "" &&
			this.#firstWordsTimer === undefined &&
			nowMs < prevSnap.nextExpiryAt &&
			prevSnap.projection === conversation.projection &&
			prevSnap.optimistic === conversation.optimistic &&
			prevSnap.codingSessions === conversation.codingSessions &&
			prevSnap.proposals === conversation.proposals &&
			prevSnap.discardingProposals === conversation.discardingProposals &&
			prevSnap.interactionAnswers === conversation.interactionAnswers &&
			prevSnap.interactionError === conversation.interactionError &&
			prevSnap.hasEarlier === conversation.hasEarlier &&
			prevSnap.earlierLoading === conversation.earlierLoading &&
			prevSnap.earlierError === conversation.earlierError &&
			prevSnap.loading === conversation.loading &&
			prevSnap.error === conversation.error &&
			prevSnap.session === session &&
			prevSnap.team === companyState.team &&
			prevSnap.staff === companyState.staff &&
			prevSnap.interfaceFolder === companyState.interfaceFolder &&
			prevSnap.mentionsReady === companyState.mentionsReady &&
			prevSnap.groups === companyState.groups &&
			prevSnap.accessLost === companyState.accessLost &&
			prevSnap.agentName === agentName &&
			prevSnap.agent === agent &&
			prevSnap.agentState === this.#agentState &&
			prevSnap.working === this.#working &&
			prevSnap.waitingRun === this.#waitingRun &&
			prevSnap.runAtWork === runAtWork &&
			prevSnap.computerShown === computerShown &&
			prevSnap.decisionsWaiting === this.#decisions?.waiting &&
			prevSnap.decisionsDecidedKey === this.#decisions?.decidedKey &&
			prevSnap.clock === clock &&
			prevSnap.readyShown === this.#ready?.shown &&
			prevSnap.siteCardsKey === this.#siteCards?.key
		) {
			return;
		}
		// Read before any message is drawn: a message brought up to date in place (erased) drops a link in it that had
		// the keyboard.
		const focused = document.activeElement;
		const focusedMessage =
			focused instanceof HTMLElement && this.#messages.contains(focused)
				? focused.closest<HTMLElement>("article.message[data-message-id]")?.dataset.messageId
				: undefined;
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
		// Group chats carry no cards; elsewhere the kernel's answerer, per card.
		const canWrite = companyState.team?.capabilities.write === true && !room;
		const role = companyState.team?.role ?? "";
		const members = companyState.team?.members;
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
		const skillNames = [...this.#skills.names()].sort().join(" ");
		// A coworker's chip shows its figure and name.
		const coworker = (staffId: string) => {
			const staff = this.#company.staffById(staffId);
			return [staff?.id, staff?.displayName, staff?.appearance, staff?.templateId];
		};
		// An agent's interface change names each table by its title as the folder has it now (a folder's name is one
		// name in any case). An interface is named by its folder: the folder's QorperaOS/interfaces/ is not read
		// (Interfaces C6a).
		const folder = companyState.interfaceFolder;
		const titleOf = (subject: InterfaceChangeSubject) => {
			if (subject.kind === "interface") return undefined;
			const name = companyPathKey(subject.name);
			for (const [table, read] of folder?.tables ?? []) if (companyPathKey(table) === name) return read.table?.name;
			return undefined;
		};
		const changeLines = new Map(
			items.flatMap((item) =>
				item.kind === "interface_change" ? [[item.id, interfaceChangeText(item.change, titleOf)] as const] : [],
			),
		);
		const undoes = Boolean(this.#actions.undoInterfaceChange) && companyState.team?.capabilities.write;
		const acknowledgements = runAcknowledgements(items, !conversation.hasEarlier, room);
		const heldWords = this.#holdFirstWords(items, acknowledgements, runAtWork, room || conversation.loading === true);
		// Approval cards of agents' actions (auto-review, v130) show their own outcome.
		const reviews = new Map<string, ActionReviewCard>();
		const requests = new Set<string>();
		let nextExpiryAt = Number.POSITIVE_INFINITY;
		const expiredFlags: boolean[] = [];
		for (const item of items) {
			if (item.kind === "authorization_request") {
				requests.add(item.id.toLowerCase());
				const review = actionReviewCard(authorizationData(item.body));
				if (review) reviews.set(item.id.toLowerCase(), review);
			} else if (item.kind === "interaction" && item.request.expiresAt) {
				const expiresMs = Date.parse(item.request.expiresAt);
				const expired = expiresMs <= nowMs;
				expiredFlags.push(expired);
				if (!expired && expiresMs < nextExpiryAt) nextExpiryAt = expiresMs;
			}
		}
		const folds = room
			? new Map<string, UnaskedGroup>()
			: unaskedGroups(items, (item) => {
					const first = acknowledgements.get(item.id);
					if (first !== undefined)
						return first.followed || heldWords.includes(item.id) || first.runId === runAtWork;
					if (item.kind === "interaction" || item.kind === "authorization_request")
						return this.#decisions?.shows(item.id) === true;
					if (item.kind !== "authorization_decision") return false;
					const request = authorizationRequestId(item.body) ?? "";
					return reviews.has(request) || (conversation.hasEarlier === true && !requests.has(request));
				});
		const foldOf = new Map<string, string>();
		for (const [first, group] of folds) for (const id of group.items) foldOf.set(id, first);
		for (const first of this.#openFolds) if (!folds.has(first)) this.#openFolds.delete(first);
		const key = JSON.stringify([
			items.map(cachedTranscriptItemJson),
			mentionTargets,
			// Only what the line shows: the header's poll changes the rest every few seconds.
			codingSessions.map((coding) => [coding.workerId, coding.harness, coding.title, coding.createdAt]),
			proposals,
			moreProposals,
			discarding,
			agentName,
			room,
			answerable,
			expiredFlags,
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
			runAtWork,
			heldWords,
			[...folds].map(([first, group]) => [first, group.items, this.#openFolds.has(first)]),
			computerShown,
			this.#waitingRun,
			this.#decisions?.waiting,
			this.#decisions?.decidedKey,
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
			this.#ready?.shown,
			this.#siteCards?.key,
		]);
		this.#messagesSnap = {
			projection: conversation.projection,
			optimistic: conversation.optimistic,
			codingSessions: conversation.codingSessions,
			proposals: conversation.proposals,
			discardingProposals: conversation.discardingProposals,
			interactionAnswers: conversation.interactionAnswers,
			interactionError: conversation.interactionError,
			hasEarlier: conversation.hasEarlier,
			earlierLoading: conversation.earlierLoading,
			earlierError: conversation.earlierError,
			loading: conversation.loading,
			error: conversation.error,
			session,
			team: companyState.team,
			staff: companyState.staff,
			interfaceFolder: companyState.interfaceFolder,
			mentionsReady: companyState.mentionsReady,
			groups: companyState.groups,
			accessLost: companyState.accessLost,
			agentName,
			agent,
			agentState: this.#agentState,
			working: this.#working,
			waitingRun: this.#waitingRun,
			runAtWork,
			computerShown,
			decisionsWaiting: this.#decisions?.waiting,
			decisionsDecidedKey: this.#decisions?.decidedKey,
			clock,
			readyShown: this.#ready?.shown,
			siteCardsKey: this.#siteCards?.key,
			nextExpiryAt,
		};
		if (key === this.#renderedKey) return;
		this.#renderedKey = key;
		const itemsById = new Map<string, TranscriptItem>();
		const interactionCards = new Map<string, TranscriptInteraction>();
		const decisions = new Map<string, TranscriptCard>();
		for (const item of items) {
			itemsById.set(item.id, item);
			if (item.kind === "interaction") interactionCards.set(item.id.toLowerCase(), item);
			else if (item.kind === "authorization_decision") {
				const request = authorizationRequestId(item.body);
				if (request) decisions.set(request, item);
			}
		}
		const latestReplyAfter = latestReworkingReplyAfter(items, acknowledgements);
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
		const keep = (
			id: string,
			itemKey: string,
			time: string,
			draw: (signal: AbortSignal) => HTMLElement,
		): HTMLElement => {
			const slot = slotFor(id);
			const previous = previousAt(slot);
			if (previous) taken.add(previous);
			if (previous?.key === itemKey && previous.time === time) {
				drawn.set(slot, previous);
				return previous.element;
			}
			const card = new AbortController();
			const element = draw(card.signal);
			if (previous) {
				const timesOnly = previous.key === itemKey;
				if ((timesOnly || (inert(previous.element) && inert(element))) && sameShape(previous.element, element)) {
					// WHY: Abort the discarded scratch render so only the retained card keeps active probes/timers.
					card.abort();
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
			drawn.set(slot, { key: itemKey, time, element, abort: () => card.abort() });
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
			// A link may lead to one of the company's sites, whose card stands under the words: the sites as read go in too.
			const linked = this.#siteCards && item.text?.includes("https://") ? `\n${this.#siteCards.key}` : "";
			const itemKey = `${cachedTranscriptItemJson(item)}\n${JSON.stringify([author, mine, room, locale])}${mentioned ? `\n${mentions}` : ""}${skilled ? `\n${skillNames}` : ""}${linked}`;
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
					body: `${JSON.stringify([item.kind, item.text, item.quotes ?? null, Boolean(item.attachmentCount), Boolean(item.erased), locale])}${mentioned ? `\n${mentions}` : ""}${skilled ? `\n${skillNames}` : ""}${linked}`,
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
		let words = "";
		for (let index = 0; index < items.length; index++) {
			const item = items[index]!;
			if (liveStart === undefined && (liveFrom === undefined || (!waiting(item) && item.sequence >= liveFrom)))
				liveStart = nodes.length;
			placeSessions(item.createdAt);
			const acknowledgement = acknowledgements.get(item.id);
			if (acknowledgement?.followed || heldWords.includes(item.id)) continue;
			if (acknowledgement && acknowledgement.runId === runAtWork) {
				words = markdown(acknowledgement.text).textContent?.replace(/\s+/gu, " ").trim() ?? "";
				continue;
			}
			const folded = foldOf.get(item.id);
			if (folded !== undefined) {
				const open = this.#openFolds.has(folded);
				if (item.id === folded) {
					const group = folds.get(folded)!;
					const newestId = group.messages[group.messages.length - 1];
					const newest = newestId !== undefined ? itemsById.get(newestId) : undefined;
					let text = "";
					if (newest?.kind === "agent") {
						const cached = this.#foldPreviews.get(newest.id);
						if (cached && cached.raw === newest.text) {
							text = cached.preview;
						} else {
							text = foldText(
								[...markdown(newest.text).children].map((block) => block.textContent ?? "").join(" ") ||
									newest.text,
							);
							this.#foldPreviews.set(newest.id, { raw: newest.text, preview: text });
						}
					}
					nodes.push(
						keep(`fold ${folded}`, JSON.stringify([group.messages.length, text, open, locale]), "", () => {
							const row = threadFold({
								count: group.messages.length,
								text,
								open,
								toggle: () => {
									if (!this.#openFolds.delete(folded)) this.#openFolds.add(folded);
									this.#messagesSnap = undefined;
									this.update();
								},
							});
							row.dataset.fold = folded;
							return row;
						}),
					);
					const headed = parseConversationTimestamp(item.createdAt);
					const last = open || !newest ? undefined : parseConversationTimestamp(newest.createdAt);
					if (headed) markTime(headed, nodes[nodes.length - 1]!, last);
				}
				if (!open) continue;
			}
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
										"aria-label": t("{label}. Open the conversation", { label }),
										"aria-describedby": peerTimeId(item.id),
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
									peerTime(item.id, item.createdAt),
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
				if (this.#decisions?.shows(item.id)) continue;
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
				// The Always allow draft is not part of the key: a kept card keeps the member's editor as it
				// is. The card shows no time.
				nodes.push(
					keep(item.id, JSON.stringify([item, resolution, answerFailed, answers, members, locale]), "", () =>
						renderActionReviewCard(review, resolution, {
							answerFailed,
							chainStopped: item.chainStopped === true,
							draft: this.#reviewDrafts.get(review.reviewId),
							onDraft: (draft) => this.#reviewDrafts.set(review.reviewId, draft),
							answer: answers
								? (answer, ruleText) => void this.#answerActionReview(item.id, answer, ruleText)
								: undefined,
							memberName: (userId) => this.#company.memberName(userId),
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
				if (this.#decisions?.shows(item.id)) continue;
				const email = isGmailDraft(item.request);
				const answer = item.answer ?? conversation.interactionAnswers?.[item.id.toLowerCase()];
				const answers = canAnswer(item.actorUserId);
				const takeOver = Boolean(agent) && item.request.surface === "takeover";
				const address = questionInput(item.request) === "mail_address";
				const reworking = reworkingNote(
					items,
					index,
					answer,
					this.#working || this.#waitingRun,
					acknowledgements,
					latestReplyAfter[index],
				);
				const round = decisionRound(items, { ...item, ...(answer ? { answer } : {}) }, interactionCards);
				const cardKey = JSON.stringify([
					item.request,
					round ?? null,
					// What the card shows of an answer; the input it went out as is not shown.
					answer && [answer.outcome, answer.answer, answer.answeredBy, answer.answeredAt, answer.pending],
					answers,
					// Whose a secret saved here is: a coding value's card says which repositories get it (a role change
					// moves it).
					item.request.surface === "secret" ? this.#company.secretSavedForCompany(item.request) : null,
					address ? this.#company.canChooseMailAddress() : null,
					item.answerFailed,
					item.chainStopped,
					reworking,
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
				// The agent's figure, waiting, as it stands beside its question in the questions dock: the head of a card
				// that waits for the member. It becomes a "?" for a question and a "!" for anything else that waits (a
				// secret, a takeover, a draft), as in the rail.
				const ask = item.request.surface === "question" ? "question" : "bang";
				const waitingFigure = agent
					? () =>
							reworking
								? agentFigure(agent, agentName, { size: 30, activity: "Working" })
								: agentFigure(agent, agentName, { size: 30, activity: "Waiting", ask })
					: undefined;
				const card = keep(
					item.id,
					cardKey,
					email ? "" : `${zone} ${when(item.createdAt)} ${when(answer?.answeredAt)}`,
					(cardSignal) =>
						renderInteractionCard(
							{ ...item, answer },
							{
								agentName,
								memberName: (userId) => this.#company.memberName(userId),
								canAnswer: answers,
								inThread: true,
								viewerId: this.#company.userId,
								reworking,
								signal: cardSignal,
								...(round ? { round } : {}),
								...(waitingFigure ? { figure: waitingFigure } : {}),
								...(this.#actions.folderImage ? { image: this.#actions.folderImage } : {}),
								...(this.#actions.folderApp ? { app: this.#actions.folderApp } : {}),
								answer: async (outcome, answer) => {
									// The take-over card's I'm done gives the agent's desktop back first; the answer then wakes the agent, whose
									// looks are let in again (20260930713000).
									// It answers only once the database confirmed it has the desktop back (review r1 F4): otherwise the card
									// stays open and says so, and I'm done asks again. It asks the company's ledger, not a window: a window
									// closed meanwhile may still have a hand-back on its way (review r2 F4).
									if (takeOver && outcome === "handed_back") {
										const current = currentAgent();
										if (current && !(await this.#panels.releaseAgent(current.id))) {
											this.#company.conversation(this.#sessionId).set({
												interactionError: t(
													"The computer could not be given back yet. Press I'm done to try again. It goes back by itself within 5 minutes.",
												),
											});
											throw new Error("The computer was not given back");
										}
									}
									return this.#answerInteraction(item.id, outcome, answer);
								},
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
											openComputer: () => {
												const current = currentAgent();
												if (current) this.#openComputer(current);
											},
										}
									: {}),
								...(item.request.surface === "secret" && answers
									? {
											provideSecret: (value: string) =>
												this.#company.provideSecret(this.#sessionId, item.id, item.request, value),
											savesForCompany: this.#company.secretSavedForCompany(item.request),
										}
									: {}),
								...(address && answers
									? { mailAddress: this.#company.mailAddressCalls(this.#sessionId, item.id) }
									: {}),
							},
						),
				);
				// The figure follows the agent's look by itself. The look is no part of the card's key: a card drawn
				// again for it would lose an answer half made in it (review r1 F1 on #1730).
				const stand = card.querySelector<HTMLElement>(".interaction-figure");
				if (stand && waitingFigure) {
					const look = JSON.stringify([agent?.id, agent?.appearance, agent?.templateId]);
					if (stand.dataset.look !== undefined && stand.dataset.look !== look)
						stand.replaceChildren(waitingFigure());
					stand.dataset.look = look;
				}
				nodes.push(card);
			}
			const date = parseConversationTimestamp(item.createdAt);
			const node = nodes[nodes.length - 1];
			if (date && node && item.id !== folded) markTime(date, node);
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
		const dock = this.#decisions;
		for (const entry of dock?.decided ?? []) {
			const block = keep(`decided ${entry.decision.interactionId}`, JSON.stringify([entry.state, locale]), "", () =>
				dock ? dock.renderDecided(entry) : h("section"),
			);
			const next = this.#timestampRows.find((row) => row.date.getTime() > entry.at)?.node;
			const at = next ? nodes.indexOf(next) : -1;
			const index = at < 0 ? nodes.length : at;
			nodes.splice(index, 0, block);
			if (liveStart !== undefined && index < liveStart) liveStart += 1;
		}
		// A change of this agent's that is ready to go live waits below them; the card draws itself in place.
		const ready = this.#ready;
		if (ready?.shown) nodes.push(keep("code ready", "", "", () => ready.el));
		// Items gone from the thread, and messages whose element passed on, let what they held go.
		const live = new Set(drawn.values());
		for (const previous of this.#drawn.values()) {
			if (live.has(previous)) continue;
			previous.abort?.();
			previous.message?.files?.view.dispose();
		}
		this.#drawn = drawn;
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
			!this.#ready?.shown &&
			!conversation.error &&
			!this.#working &&
			!conversation.hasEarlier
		) {
			const empty = t("No messages yet.");
			if (this.#emptyRow?.textContent !== empty) this.#emptyRow = h("div", { class: "empty" }, empty);
			nodes.push(this.#emptyRow);
		}
		const priorActivity = this.#activityRow?.element;
		// The agent's computer, while this thread shows it: its own row (#computerRow). The live end while the agent uses
		// it, in the working figure's place; else where it stood then, before the first item that came after.
		const computer = this.#panel !== undefined && this.#computerSlot.contains(this.#panel.el);
		const atComputer = computer && this.#agentState === "computer" && !conversation.loading;
		const latest = this.#timestampRows.reduce(
			(time, row) => Math.max(time, (row.last ?? row.date).getTime()),
			Number.NEGATIVE_INFINITY,
		);
		if (computer) this.#drawComputerFigure(agent, agentName, atComputer, locale);
		if (computer && !atComputer) {
			// Its place is fixed once the thread has read what it holds; while it reads, or after a read that failed, the row
			// waits at the end (review r1 F1, r2 F1 of #1787).
			if (!conversation.loading && !conversation.error) this.#computerAfter ??= latest;
			const after = this.#computerAfter;
			const next =
				after === undefined ? undefined : this.#timestampRows.find((row) => row.date.getTime() > after)?.node;
			const at = next ? nodes.indexOf(next) : -1;
			const index = at < 0 ? nodes.length : at;
			nodes.splice(index, 0, this.#computerRow);
			if (index < liveStart) liveStart += 1;
		}
		const computerWords = atComputer ? words : "";
		if (this.#computerWords.textContent !== computerWords) this.#computerWords.textContent = computerWords;
		this.#computerWords.hidden = !computerWords;
		if (atComputer) {
			this.#computerAfter = latest;
			this.#activityRow = undefined;
			nodes.push(this.#computerRow);
		} else if (this.#working && !conversation.loading) {
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
				const row = activityRow(
					AGENT_LOOK[this.#agentState],
					agentName,
					agentFigure(agent, agentName, { size: 40, activity: AGENT_LOOK[this.#agentState].figure }),
				);
				this.#activityRow = { key: rowKey, element: row };
			}
			activityWords(this.#activityRow.element, words);
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
		const foldFocused = active?.classList.contains("thread-fold") ? active.dataset.fold : undefined;
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
		if (
			this.#skillsCheckedProjection !== conversation.projection ||
			this.#skillsCheckedOptimistic !== conversation.optimistic
		) {
			this.#skillsCheckedProjection = conversation.projection;
			this.#skillsCheckedOptimistic = conversation.optimistic;
			for (const item of items) if (item.kind === "member" || item.kind === "agent") this.#skills.want(item.text);
		}
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
		if (foldFocused !== undefined && active && !active.isConnected)
			[...this.#messages.querySelectorAll<HTMLElement>(".thread-fold")]
				.find((row) => row.dataset.fold === foldFocused)
				?.focus({ preventScroll: true });
		// A link in a message that was redrawn without it (the message erased) leaves the keyboard on the message, and a
		// message gone from the thread leaves it on the thread.
		if (focusedMessage && (!document.activeElement?.isConnected || document.activeElement === document.body))
			this.#focusMessage(focusedMessage);
		// Rows drawn now beside the computer's way are covered while its large view is open.
		this.#panel?.coverAgain();
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
		// Its time shows on a hover (ui/sent-time-hover.ts).
		if (element.dataset.sentAt !== item.createdAt) element.dataset.sentAt = item.createdAt;
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
						? markdownBubbles(item.text, (href) => this.#linkedSite(href))
						: item.text || !item.attachmentCount
							? this.#memberParts(item.text, item.quotes)
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
			this.#erases.map(({ what, erase, failure }) => [what, erase?.state, erase?.copies, failure]),
			this.#copyFailure,
		]);
		if (key === this.#statusKey) return;
		this.#statusKey = key;
		const children: (HTMLElement | null)[] = [];
		if (conversation.error) children.push(notice("danger", conversation.error));
		if (conversation.sendError) children.push(notice("danger", conversation.sendError));
		if (conversation.interactionError) children.push(notice("danger", conversation.interactionError));
		for (const line of this.#erases) children.push(this.#eraseNotice(line));
		if (this.#copyFailure) children.push(notice("danger", this.#copyFailure));
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
			children.push(
				notice(
					"neutral",
					company.team?.role === "viewer"
						? t("You're a spectator: you read along, and the founders write.")
						: t("You can read this conversation. Contributors and above can write."),
				),
			);
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
					"aria-label": t("{label}. Open the conversation", { label: name }),
					"aria-describedby": peerTimeId(link.id),
					onclick: (event: MouseEvent) =>
						this.#openPair(
							link.pairSessionId,
							[link.counterpartStaffId, own],
							event.currentTarget as HTMLElement,
						),
				},
				agentFigure(staff, name, { size: 16 }),
				compact ? null : h("span", null, name),
				peerTime(link.id, link.createdAt),
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

	/** The sessions still going sit in the pill above the composer, each a figure that
	 * works while its session works; the figures are kept across renders so their motion runs on. */
	#renderCodingSlots(sessions: readonly CodingSession[], agent: HostedStaffAgent | undefined): void {
		// The session open as its own thread takes the fresh listing too.
		const open = this.#codingThread && sessions.find((session) => session.workerId === this.#codingThread?.workerId);
		if (open) this.#codingThread?.view.update(open);
		const going = [...sessions].filter(codingSessionGoing).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		this.#coding.update(
			going,
			(session) => this.#company.staffById(session.agentId) ?? agent,
			this.#codingNames(agent?.displayName ?? t("Agent")),
		);
		this.#watchCodingSessions();
	}

	/** Re-reads the thread's coding sessions on a clock while one is still going, so
	 * the pill's figures follow them; stops once they all settled. A new session or
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
				read: (workerId: string, afterEvent: number, signal?: AbortSignal) =>
					company.readCodingSession(workerId, afterEvent, signal),
				answer: (workerId: string, text: string, clientRequestId: string) =>
					company.answerCodingSession(sessionId, workerId, text, clientRequestId),
				delegate: (workerId: string, clientRequestId: string) =>
					company.delegateCodingSession(sessionId, workerId, clientRequestId),
				archive: (workerId: string, clientRequestId: string) =>
					company.archiveCodingSession(sessionId, workerId, clientRequestId),
				logins: (workerId: string) => company.listCodingSessionLogins(workerId),
				chooseLogin: (workerId: string, connectionId: string) =>
					company.chooseCodingSessionLogin(sessionId, workerId, connectionId),
			},
			signal: this.#notificationSignal,
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
				// Back where the member opened it; the thread's line if the pill's line went away meanwhile.
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
		const readable = !this.#isRoom && !company.accessLost && company.team?.capabilities.read;
		const failed = readable ? this.#company.failedRunFor(session?.staffAgentId) : undefined;
		const waiting = readable ? this.#company.pausedRunFor(session?.staffAgentId) : undefined;
		if (waiting?.paused && (!failed || failed.earlier)) {
			this.#renderWaitingRun(session, waiting.runId, waiting.paused);
			return;
		}
		const runId = failed?.activity.runId;
		const hidden = !runId || dismissedRunNotifications.get(this.#company)?.has(runId);
		const proposalId = failed?.recovery?.proposalId;
		const review = failed?.activity.sourceKind === "proposal_review";
		const agentName = this.#company.staffById(session?.staffAgentId ?? "")?.displayName ?? t("The agent");
		// A failure from before the agent's newer work says so: what the agent does now shows above it.
		const title = proposalId
			? t("{name} stopped with changes to review", { name: agentName })
			: review
				? failed?.earlier
					? t("An earlier review did not finish")
					: t("A review did not finish")
				: failed?.earlier
					? t("An earlier run of {name} did not finish", { name: agentName })
					: t("{name} did not finish this run", { name: agentName });
		const recovery = failed?.recovery;
		// The member's own ChatGPT plan reached its limit: OpenAI's words and "Manage usage" (Sign in with ChatGPT).
		// Anyone else reads that the account paying for the work reached its limit.
		const ownPlanLimit =
			!proposalId &&
			recovery?.usageLimit === true &&
			recovery.paidByChatgptPlan === true &&
			recovery.requestedByUserId === this.#company.userId.toLowerCase();
		const payer = recovery ? this.#execution?.payer(recovery.sponsorBindingId) : undefined;
		const usageLimit =
			recovery !== undefined &&
			!proposalId &&
			!review &&
			classifyRunFailure(recovery.lastError, recovery.jobStatus, recovery.usageLimit) === "usage_limit";
		// The work never moves by itself: the member whose own login paid may continue it with another login of theirs
		// that can pay now, by their own pick here (never off a ChatGPT plan). Their next message here runs on it.
		const canWrite = company.team?.capabilities.write === true && !company.accessLost && session?.status === "open";
		const logins =
			usageLimit &&
			payer?.own === true &&
			recovery?.paidByChatgptPlan !== true &&
			canWrite &&
			this.#actions.sendMessage &&
			runId
				? (this.#execution?.continueLogins(recovery?.sponsorBindingId) ?? [])
				: [];
		// Anyone else reads who can: the member the run was started for, whose login pays for it.
		const payerId = recovery?.requestedByUserId?.toLowerCase();
		// Never for a ChatGPT plan: no other login continues its work (its member reads OpenAI's words).
		const payerName =
			usageLimit &&
			payer?.own !== true &&
			recovery?.paidByChatgptPlan !== true &&
			payerId &&
			payerId !== this.#company.userId.toLowerCase()
				? company.team?.members.find((member) => member.userId.toLowerCase() === payerId)?.displayName
				: undefined;
		const reason = proposalId
			? t("Its changes wait for your decision.")
			: ownPlanLimit
				? planUsageLimitReason()
				: recovery
					? runFailureReason(
							recovery.lastError,
							recovery.jobStatus,
							recovery.usageLimit,
							{
								...payer,
								...(logins.length ? { continuable: true } : {}),
								...(payerName ? { payerName } : {}),
							},
							recovery.rateLimited,
							(recovery.sourceKind === "session_turn" || recovery.sourceKind === "room_delivery") &&
								recovery.requestedByUserId === this.#company.userId.toLowerCase(),
							recovery.signInRefused,
						)
					: undefined;
		const continuing = this.#continuing?.runId === runId ? this.#continuing?.connectionId : undefined;
		const continueNote = this.#continueNote?.runId === runId ? this.#continueNote?.text : undefined;
		// Picks wait while the logins are read or a message is on its way.
		const continueWaiting = logins.length > 0 && this.#execution?.locked === true;
		const retryState = runId ? company.runRetries?.[runId] : undefined;
		// Try again is for an interrupted run; a refused one says what the member must do first.
		const canRetry =
			failed !== undefined &&
			!review &&
			this.#company.canRetryFailedRun(failed) &&
			recovery !== undefined &&
			runFailureInterrupted(
				recovery.lastError,
				recovery.jobStatus,
				recovery.usageLimit,
				recovery.rateLimited,
				recovery.signInRefused,
			);
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
			logins,
			continuing,
			continueNote,
			continueWaiting,
		]);
		if (key === this.#runNotificationKey) return;
		this.#runNotificationKey = key;
		const focused = this.#runNotification.contains(document.activeElement);
		const focusedAction = focused ? (document.activeElement as HTMLElement).dataset.action : undefined;
		// A "Continue with …" button keeps focus on its own login.
		const focusedLogin = focused ? (document.activeElement as HTMLElement).dataset.connectionId : undefined;
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
				if (!this.#company.signal.aborted) this.#company.store.notify();
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
						...(logins.length || continueNote
							? {
									continueWith: {
										logins,
										choose: (connectionId: string) => {
											if (runId) void this.#continueRun(runId, connectionId);
										},
										...(continuing ? { continuing } : {}),
										...(continueWaiting ? { waiting: true } : {}),
										...(continueNote ? { note: continueNote } : {}),
									},
								}
							: {}),
					}),
		);
		if (focused) this.#refocusRunNotification(Boolean(hidden), focusedAction, focusedLogin);
	}

	/** Focus stays on the card's line after a redraw: on the same button (the same login's "Continue with …"), else its
	 * first one; when the line went away, on what holds focus next. */
	#refocusRunNotification(hidden: boolean, focusedAction: string | undefined, focusedLogin: string | undefined): void {
		if (!hidden)
			(
				(focusedAction && focusedLogin
					? this.#runNotification.querySelector<HTMLElement>(
							`[data-action="${focusedAction}"][data-connection-id="${focusedLogin}"]`,
						)
					: null) ??
				(focusedAction
					? this.#runNotification.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`)
					: null) ??
				this.#runNotification.querySelector<HTMLElement>(".run-failure-primary, a, button")
			)?.focus({ preventScroll: true });
		else if (this.#conversationPane.inert || this.#panel?.el.classList.contains("is-entered")) this.#panel?.focus();
		else if (!this.#composer.disabled && !this.#composerWrap.hidden) this.#composer.focus({ preventScroll: true });
		else if (!this.#identity.disabled) this.#identity.focus({ preventScroll: true });
		else {
			this.el.tabIndex = -1;
			this.el.focus({ preventScroll: true });
		}
	}

	#renderWaitingRun(session: HostedSession | undefined, runId: string, paused: PausedRun): void {
		const company = this.#company.store.get();
		const agentName = this.#company.staffById(session?.staffAgentId ?? "")?.displayName ?? t("The agent");
		const payer = this.#execution?.payer(paused.sponsorBindingId);
		const canWrite = company.team?.capabilities.write === true && !company.accessLost && session?.status === "open";
		// Only where the cloud can make the move (qorpera_move_paused_run): never a routine's run or one that no longer
		// resumes, never onto or off a ChatGPT plan, and only onto a login that may work while its member is away when the
		// paying one may.
		const logins =
			payer?.own === true && paused.movable && !paused.rateLimited && !paused.paidByChatgptPlan && canWrite
				? (this.#execution?.continueLogins(
						paused.sponsorBindingId,
						(connection) =>
							!planLogin(connection) && (!paused.paidWhileAway || connection.allowAutonomous === true),
					) ?? [])
				: [];
		const payerId = paused.requestedByUserId?.toLowerCase();
		const payerName =
			payer?.own !== true && !paused.paidByChatgptPlan && payerId && payerId !== this.#company.userId.toLowerCase()
				? company.team?.members.find((member) => member.userId.toLowerCase() === payerId)?.displayName
				: undefined;
		const title = t("{name} is waiting to go on", { name: agentName });
		const reason = runWaitingReason(
			paused.until,
			{
				...payer,
				...(logins.length ? { continuable: true } : {}),
				...(payerName ? { payerName } : {}),
			},
			paused.rateLimited,
			paused.signInRefused,
		);
		const moving = this.#continuing?.runId === runId ? this.#continuing.connectionId : undefined;
		const note = this.#continueNote?.runId === runId ? this.#continueNote.text : undefined;
		const key = JSON.stringify(["waiting", runId, title, reason, logins, moving, note]);
		if (key === this.#runNotificationKey) return;
		this.#runNotificationKey = key;
		const focused = this.#runNotification.contains(document.activeElement);
		const focusedAction = focused ? (document.activeElement as HTMLElement).dataset.action : undefined;
		const focusedLogin = focused ? (document.activeElement as HTMLElement).dataset.connectionId : undefined;
		this.#runNotification.hidden = false;
		replace(
			this.#runNotification,
			runFailureCard({
				title,
				reason,
				...(logins.length || note
					? {
							continueWith: {
								logins,
								choose: (connectionId: string) => void this.#movePausedRun(runId, connectionId),
								...(moving ? { continuing: moving } : {}),
								...(note ? { note } : {}),
							},
						}
					: {}),
			}),
		);
		if (focused) this.#refocusRunNotification(false, focusedAction, focusedLogin);
	}

	/** "Continue with …" on a waiting run: the member's own move of it to that login, which the cloud checks is theirs and
	 * can pay. The run goes on there at once; the line goes with the next read of the agents' activity. */
	async #movePausedRun(runId: string, connectionId: string): Promise<void> {
		if (this.#continuing || this.#disposed) return;
		this.#continuing = { runId, connectionId };
		this.#continueNote = undefined;
		this.update();
		try {
			await this.#company.movePausedRun(runId, connectionId);
		} catch {
			if (!this.#disposed) this.#continueNote = { runId, text: t("The work could not be moved. Try again.") };
		} finally {
			this.#continuing = undefined;
			if (!this.#disposed) this.update();
		}
	}

	/** "Continue with …" on a run that stopped at its login's usage limit: the member's own pick of that login for this
	 * conversation, as the Login page picks it, then their message asking the agent to go on, which runs on that login
	 * (a member continues by sending a message, as in a coding session). A message the member has started here is never
	 * replaced: it stays for them to send, and the card says so. Nothing moves without this click. */
	async #continueRun(runId: string, connectionId: string): Promise<void> {
		const execution = this.#execution;
		const account = execution?.logins.find((login) => login.connectionId === connectionId)?.account;
		if (
			!execution ||
			!account ||
			this.#continuing ||
			this.#submitting ||
			this.#disposed ||
			!this.#actions.sendMessage
		)
			return;
		this.#continuing = { runId, connectionId };
		this.#continueNote = undefined;
		this.update();
		let moved = false;
		try {
			moved = await execution.continueWith(connectionId);
		} finally {
			this.#continuing = undefined;
		}
		if (this.#disposed) return;
		const conversation = this.#company.conversation(this.#sessionId).get();
		const started =
			Boolean(this.#composer.value.trim()) ||
			Boolean(conversation.draft?.trim()) ||
			Boolean(conversation.attachments?.length) ||
			Boolean(conversation.answering) ||
			conversation.sending ||
			Boolean(conversation.retrySend);
		if (!moved || started) {
			this.#continueNote = {
				runId,
				text: moved
					? t("Send your message to continue with {account}.", { account })
					: t("The login could not be chosen. Try again."),
			};
			this.update();
			if (moved && !this.#composer.disabled) this.#composer.focus({ preventScroll: true });
			return;
		}
		this.#edits.declare(0, this.#composer.value.length);
		this.#composer.value = t(
			"Your last run stopped because a login reached its usage limit. Please continue that work.",
		);
		this.#composer.dispatchEvent(new Event("input", { bubbles: true }));
		this.update();
		this.#submit({ runId, connectionId });
	}
}
