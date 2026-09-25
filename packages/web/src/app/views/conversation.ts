import type { CodingSession } from "../../cloud/coding-session.ts";
import type { EmailDraftAction, EmailDraftContent } from "../../cloud/email-drafts.ts";
import { sessionAttachmentProblem } from "../../cloud/session-attachments.ts";
import type { TranscriptCard, TranscriptItem } from "../../cloud/transcript.ts";
import type { HostedSession, HostedStaffAgent, JsonValue } from "../../cloud/types.ts";
import { AGENT_LOOK, activityCaption, syncCaption } from "../../ui/agent-activity.ts";
import { AttachmentTray, attachmentProblemText } from "../../ui/attachments.ts";
import { authorizationRequestId, renderAuthorizationCard } from "../../ui/authorization-card.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { CodingSessionElement } from "../../ui/coding-session.ts";
import { CodingSessionThreadView } from "../../ui/coding-session-thread.ts";
import {
	conversationTimestampLabel,
	conversationTimestampTitle,
	needsConversationTimestamp,
	parseConversationTimestamp,
} from "../../ui/conversation-timestamps.ts";
import { fmtTime, h, icon, notice, replace } from "../../ui/dom.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import { renderInteractionCard } from "../../ui/interaction-card.ts";
import { matchesKey } from "../../ui/keys.ts";
import { markdownBubbles } from "../../ui/markdown.ts";
import { t } from "../../ui/preferences.ts";
import { quietScroll } from "../../ui/quiet-scroll.ts";
import { ReceivedAttachments } from "../../ui/received-attachments.ts";
import { runFailureCard, runFailureInterrupted, runFailureReason } from "../../ui/run-failure.ts";
import { uiScale } from "../../ui/scale.ts";
import { composerSkeleton, messagesSkeleton, threadIdentitySkeleton } from "../../ui/skeleton.ts";
import { type AgentState, answersInteraction, type CompanyController, type ConversationState } from "../company.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import { AgentDetails } from "./agent-details.ts";
import { ComposerModels } from "./composer-models.ts";
import { type ComputerPanel, ComputerPanels } from "./computer.ts";
import { GroupDetails } from "./group-details.ts";
import { PairTranscriptView } from "./pair-transcript.ts";
import { SessionExecutionView } from "./session-execution.ts";
import { SessionRunView } from "./session-run.ts";

// Popup dismissal lasts for this company controller, including conversation navigation.
// It does not settle or discard work whose outcome still needs review.
const dismissedRunNotifications = new WeakMap<CompanyController, Set<string>>();

export { renderAuthorizationCard } from "../../ui/authorization-card.ts";

/* One conversation over the canonical transcript. Rendering follows
 * DECISIONS.md "Transcript projection rules": member inputs and agent sends
 * only. Composer drafts remain local until a message adapter is supplied. */

export class ConversationView {
	readonly el: HTMLElement;
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #header = h("header", { class: "thread-header" });
	readonly #messages = h("div", { class: "messages", role: "log", "aria-live": "polite" });
	readonly #status = h("div", { class: "thread-status" });
	readonly #composer: HTMLTextAreaElement;
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
	readonly #attachments: AttachmentTray;
	readonly #more: HTMLButtonElement;
	readonly #menu: HTMLElement;
	readonly #menuMain: HTMLElement;
	readonly #models: ComposerModels;
	readonly #attach: HTMLButtonElement;
	readonly #attachNote: HTMLElement;
	readonly #identity: HTMLButtonElement;
	readonly #computer: HTMLButtonElement;
	readonly #navigation: HTMLButtonElement;
	readonly #body: HTMLElement;
	readonly #conversationPane: HTMLElement;
	readonly #lifetime = new AbortController();
	readonly #notificationSignal: AbortSignal;
	readonly #actions: WorkspaceActions;
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
	#receivedAttachments: ReceivedAttachments[] = [];
	/** The coding sessions shown in this thread, one element per session, kept
	 * across renders so each keeps its stream, its cursor and its open state. */
	readonly #codingElements = new Map<string, CodingSessionElement>();
	readonly #emailCards = new Map<string, { key: string; element: HTMLElement }>();
	/** A coding session opened as its own thread over this one, from its chip. */
	#codingThread: { workerId: string; view: CodingSessionThreadView } | undefined;
	readonly #timestampTimer: number;
	#timestampRows: { date: Date; node: HTMLElement; separator?: HTMLTimeElement }[] = [];

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
				if (matchesKey(event, "accept") && !event.shiftKey) {
					event.preventDefault();
					this.#submit();
				}
			},
			oninput: () => {
				this.#autosize();
				company.conversation(sessionId).set({ draft: this.#composer.value });
			},
		});
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
			if (!this.#composer.disabled && !this.#isRoom) this.#attachments.add([...(fileInput.files ?? [])]);
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
					if (!this.#isRoom) fileInput.click();
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
			this.#composer,
			this.#more,
			this.#send,
			fileInput,
			this.#menu,
		);
		this.#composerShell.addEventListener("paste", (event) => {
			if (this.#composer.disabled) return;
			const files = [...(event.clipboardData?.files ?? [])];
			if (files.length) {
				event.preventDefault();
				if (!this.#isRoom) this.#attachments.add(files);
			}
		});
		this.#composerShell.addEventListener("dragover", (event) => {
			if (!this.#composer.disabled && event.dataTransfer?.types.includes("Files")) {
				event.preventDefault();
				if (!this.#isRoom) this.#composerShell.classList.add("is-dragging");
			}
		});
		this.#composerShell.addEventListener("dragleave", () => this.#composerShell.classList.remove("is-dragging"));
		this.#composerShell.addEventListener("drop", (event) => {
			event.preventDefault();
			this.#composerShell.classList.remove("is-dragging");
			if (!this.#composer.disabled && !this.#isRoom) this.#attachments.add([...(event.dataTransfer?.files ?? [])]);
		});
		this.#composerWrap = h("footer", { class: "composer" }, this.#composerShell, this.#attachments.status);
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
		this.#header.append(this.#navigation, this.#identity, this.#computer);
		this.#refreshFade = quietScroll(this.#messages);
		this.#messages.addEventListener("scroll", () => {
			const { scrollTop, scrollHeight, clientHeight } = this.#messages;
			if (this.#stickToBottom && scrollTop === this.#pinnedTop) {
				this.#pinnedTop = -1;
				return;
			}
			this.#stickToBottom = scrollHeight - scrollTop - clientHeight < 48 * uiScale();
		});
		if (typeof ResizeObserver !== "undefined") {
			this.#sizes = new ResizeObserver(() => this.#pinToBottom());
			this.#sizes.observe(this.#messages);
		} else queueMicrotask(() => this.#pinToBottom()); // The application mounts the view right after construction.
		this.#conversationPane = h(
			"div",
			{ class: "thread-conversation" },
			this.#header,
			this.#messages,
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
		for (const attachments of this.#receivedAttachments) attachments.dispose();
		this.#closeCodingSession();
		for (const element of this.#codingElements.values()) element.dispose();
		this.#codingElements.clear();
		this.#emailCards.clear();
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
		const messageId = opener?.closest<HTMLElement>(".peer-link")?.dataset.messageId;
		const target =
			opener?.isConnected && this.#messages.contains(opener)
				? opener
				: (this.#messages.querySelector<HTMLElement>(
						messageId ? `.peer-link[data-message-id="${messageId}"] .peer-chip` : ".peer-chip",
					) ?? this.#messages.querySelector<HTMLElement>(".peer-chip"));
		target?.focus({ preventScroll: true });
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
		this.#models.update(
			Boolean(agent) && !room,
			!canWrite || conversation.sending || this.#submitting || Boolean(conversation.retrySend),
		);
		this.#execution?.update();
		this.#run?.update(
			room || company.accessLost || !company.team?.capabilities.read ? undefined : session?.staffAgentId,
			canWrite,
		);
		const problem = sessionAttachmentProblem(conversation.attachments ?? []);
		const attachmentIssue =
			room && conversation.attachments?.length
				? t("Images are not supported in group chats. Use Company File.")
				: problem && attachmentProblemText(problem);
		this.#attachments.sync(
			conversation.attachments ?? [],
			!canWrite || conversation.sending,
			room
				? t("Images are not supported in group chats. Use Company File.")
				: this.#actions.sendMessage
					? attachmentIssue
						? t("Attachments stay on this device. {issue}", { issue: attachmentIssue })
						: conversation.sending
							? t("Uploading images and sending message…")
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
		this.#renderMessages(
			conversation,
			room ? t("Agent reply") : (agent?.displayName ?? session?.title ?? t("Agent")),
			agent,
		);
		this.#renderStatus(conversation, canWrite, session);
		this.#composer.disabled = !canWrite || conversation.sending;
		this.#cannotSend =
			!this.#actions.sendMessage ||
			this.#models.pending ||
			(this.#execution !== undefined && !this.#execution.canSend) ||
			!canWrite ||
			conversation.sending ||
			(!conversation.draft?.trim() && !this.#attachments.count) ||
			Boolean(attachmentIssue);
		this.#syncSend();
		this.#attach.disabled = this.#composer.disabled || room;
		this.#attachNote.hidden = !room;
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
			this.#composer.value = conversation.draft ?? "";
			this.#autosize();
		}
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

	#refreshTimestamps(preserveScroll = true): void {
		if (this.#disposed) return;
		const now = new Date();
		let previousDate: Date | undefined;
		const groups = this.#timestampRows.map((row) => {
			const separated = needsConversationTimestamp(row.date, previousDate);
			previousDate = row.date;
			return { row, separated };
		});
		const regroup = preserveScroll && groups.some(({ row, separated }) => Boolean(row.separator) !== separated);
		const scrollTop = this.#messages.scrollTop;
		const viewportTop = regroup && !this.#stickToBottom ? this.#messages.getBoundingClientRect().top : 0;
		const anchor =
			regroup && !this.#stickToBottom
				? this.#timestampRows.find(({ node }) => node.getBoundingClientRect().bottom > viewportTop)?.node
				: undefined;
		const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
		// Reconcile local-day boundaries too: travel can add or remove a midnight
		// between adjacent messages. Keep the message and attachment nodes intact.
		for (const { row, separated } of groups) {
			if (!separated) {
				row.separator?.remove();
				row.separator = undefined;
				continue;
			}
			const { date } = row;
			if (!row.separator) {
				row.separator = h("time", { class: "conversation-timestamp", datetime: date.toISOString() });
				row.node.before(row.separator);
			}
			const time = row.separator;
			const label = conversationTimestampLabel(date, now);
			const title = conversationTimestampTitle(date);
			if (time.textContent !== label) time.textContent = label;
			if (time.title !== title) {
				time.title = title;
				time.setAttribute("aria-label", title);
			}
		}
		if (regroup) {
			if (this.#stickToBottom) this.#pinToBottom();
			else if (anchor) this.#messages.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
			else this.#messages.scrollTop = scrollTop;
		}
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
					attachmentCount: item.attachmentCount ?? 0,
					createdAt: item.createdAt,
					pending: "queued",
				}),
			),
		];
		const session = this.#company.store.get().sessions.find((item) => item.sessionId === this.#sessionId);
		// Group chats carry no cards; elsewhere the kernel's answerer, per card.
		const canWrite = this.#company.store.get().team?.capabilities.write === true && !this.#isRoom;
		const role = this.#company.store.get().team?.role ?? "";
		const canAnswer = (actorUserId: string) =>
			canWrite && !!session && answersInteraction(session, actorUserId, this.#company.userId);
		const canDecide = (actorUserId: string) => canAnswer(actorUserId) && ["owner", "admin"].includes(role);
		const answerable = items.flatMap((item) =>
			item.kind === "interaction" || item.kind === "authorization_request" ? [canAnswer(item.actorUserId)] : [],
		);
		const codingSessions = [...(conversation.codingSessions ?? [])].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		);
		const key = JSON.stringify([
			items,
			codingSessions,
			agentName,
			this.#isRoom,
			answerable,
			items.flatMap((item) =>
				item.kind === "interaction" && item.request.expiresAt
					? [Date.parse(item.request.expiresAt) <= Date.now()]
					: [],
			),
			role,
			conversation.interactionAnswers,
			conversation.interactionError,
			this.#company.store.get().team?.members,
			conversation.projection.hiddenCount,
			conversation.loading,
			conversation.error,
			this.#agentState,
			agent?.id,
			agent?.appearance,
			agent?.templateId,
		]);
		if (key === this.#renderedKey) return;
		this.#renderedKey = key;
		for (const attachments of this.#receivedAttachments) attachments.dispose();
		this.#receivedAttachments = [];
		const decisions = new Map<string, TranscriptCard>();
		for (const item of items)
			if (item.kind === "authorization_decision") {
				const request = authorizationRequestId(item.body);
				if (request) decisions.set(request, item);
			}
		const nodes: HTMLElement[] = [];
		this.#timestampRows = [];
		// A coding session stands where the agent started it: before the first
		// message written after it. Its element is reused, so the stream it
		// follows and the body the member opened survive every re-render.
		let nextSession = 0;
		const placeSessions = (before: string | undefined) => {
			while (nextSession < codingSessions.length) {
				const candidate = codingSessions[nextSession]!;
				if (before !== undefined && candidate.createdAt.localeCompare(before) > 0) break;
				nextSession += 1;
				const element = this.#codingElement(candidate, agent, agentName);
				if (this.#codingThread?.workerId === candidate.workerId) this.#codingThread.view.update(candidate);
				nodes.push(element.el);
				const date = parseConversationTimestamp(candidate.createdAt);
				if (date) this.#timestampRows.push({ date, node: element.el });
			}
		};
		for (const item of items) {
			placeSessions(item.createdAt);
			if (item.kind === "member" || item.kind === "agent") {
				const mine = item.kind === "member" && item.authorUserId === this.#company.userId;
				const author =
					item.kind === "agent"
						? this.#isRoom
							? (item.staffSpeaker?.displayName ??
								(item.staffSpeaker
									? t("Agent {id}", { id: item.staffSpeaker.staffAgentId })
									: t("Agent reply · speaker unavailable")))
							: agentName
						: this.#company.memberName(item.authorUserId);
				const attachments = item.attachmentCount
					? new ReceivedAttachments(item, this.#actions.previewAttachment)
					: undefined;
				if (attachments) this.#receivedAttachments.push(attachments);
				const bodies =
					item.kind === "agent"
						? markdownBubbles(item.text)
						: item.text || !item.attachmentCount
							? [h("div", { class: "text" }, item.text || t("(empty)"))]
							: [];
				nodes.push(
					h(
						"article",
						{
							class: [
								"message",
								item.kind === "agent" ? "from-agent" : "from-member",
								mine && "mine",
								item.phase === "progress" && "message-progress",
								item.pending && `pending-${item.pending}`,
							]
								.filter(Boolean)
								.join(" "),
							"aria-label": `${author} · ${fmtTime(item.createdAt)}`,
							title: `${author} · ${fmtTime(item.createdAt)}`,
							dataset: { messageId: item.id },
						},
						item.kind === "agent" && this.#isRoom
							? h("div", { class: "message-author" }, author)
							: item.kind === "member" && !mine
								? h("div", { class: "message-author" }, author)
								: null,
						...bodies.map((body) => h("div", { class: "bubble" }, body)),
						attachments?.el,
						item.pending
							? h(
									"div",
									{ class: "message-caption" },
									item.pending === "failed"
										? item.failureReason
											? t("Failed · {reason}", { reason: item.failureReason })
											: t("Failed")
										: item.pending === "processing"
											? t("Processing")
											: t("Queued"),
								)
							: null,
					),
				);
			} else if (item.kind === "peer_link") {
				// A message between this agent and a coworker: one centered line, the coworker's
				// figure before its name, no text; the transcript is behind it.
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
				const own = agent?.id ?? "";
				nodes.push(
					h(
						"div",
						{ class: "peer-link", dataset: { messageId: item.id } },
						h(
							"button",
							{
								type: "button",
								class: "peer-chip",
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
					),
				);
			} else if (item.kind === "note") {
				nodes.push(h("div", { class: "conversation-note", role: "note" }, item.text));
			} else if (item.kind === "authorization_request" || item.kind === "authorization_decision") {
				const optimistic =
					item.kind === "authorization_request"
						? conversation.interactionAnswers?.[item.id.toLowerCase()]
						: undefined;
				nodes.push(
					renderAuthorizationCard(
						item.kind,
						item.body,
						item.createdAt,
						this.#company.memberName(item.actorUserId),
						item.kind === "authorization_request"
							? (decisions.get(item.id.toLowerCase())?.body ??
									(optimistic ? { decision: optimistic.outcome, requestEventId: item.id } : undefined))
							: undefined,
						item.kind === "authorization_request" && canDecide(item.actorUserId)
							? (decision) => void this.#answerInteraction(item.id, decision)
							: undefined,
					),
				);
			} else if (item.kind === "interaction") {
				const email =
					item.request.surface === "draft" &&
					item.request.payload.platform === "email" &&
					item.request.payload.connectorId === "gmail";
				const answer = item.answer ?? conversation.interactionAnswers?.[item.id.toLowerCase()];
				const cardKey = JSON.stringify([
					item.request,
					answer,
					canAnswer(item.actorUserId),
					item.answerFailed,
					item.request.expiresAt ? Date.parse(item.request.expiresAt) <= Date.now() : false,
				]);
				const cached = email ? this.#emailCards.get(item.id) : undefined;
				const element =
					cached?.key === cardKey
						? cached.element
						: renderInteractionCard(
								{ ...item, answer },
								{
									agentName,
									memberName: (userId) => this.#company.memberName(userId),
									canAnswer: canAnswer(item.actorUserId),
									answer: (outcome, answer) => this.#answerInteraction(item.id, outcome, answer),
									...(email
										? {
												emailDraft: this.#company.emailDraftEditor(item.id),
												loadEmailDraft: () => this.#company.loadEmailDraft(this.#sessionId, item.id),
											}
										: {}),
									...(email && canAnswer(item.actorUserId)
										? {
												actEmailDraft: (action: EmailDraftAction, content: EmailDraftContent) =>
													this.#company.actEmailDraft(this.#sessionId, item.id, action, content),
											}
										: {}),
									...(agent && item.request.surface === "takeover"
										? { takeOver: () => this.#takeOver(agent) }
										: {}),
									...(item.request.surface === "secret" && canAnswer(item.actorUserId)
										? {
												provideSecret: (value: string) =>
													this.#company.provideSecret(this.#sessionId, item.id, item.request, value),
											}
										: {}),
								},
							);
				if (email) this.#emailCards.set(item.id, { key: cardKey, element });
				nodes.push(element);
			}
			const date = parseConversationTimestamp(item.createdAt);
			const node = nodes[nodes.length - 1];
			if (date && node) this.#timestampRows.push({ date, node });
		}
		placeSessions(undefined);
		for (const id of this.#emailCards.keys())
			if (!items.some((item) => item.kind === "interaction" && item.id === id)) this.#emailCards.delete(id);
		for (const [workerId, element] of this.#codingElements) {
			if (!codingSessions.some((session) => session.workerId === workerId)) {
				element.dispose();
				this.#codingElements.delete(workerId);
			}
		}
		if (conversation.loading && !items.length) {
			this.#messagesPlaceholder ??= messagesSkeleton();
			nodes.push(this.#messagesPlaceholder);
		} else this.#messagesPlaceholder = undefined;
		if (!conversation.loading && !items.length && !codingSessions.length && !conversation.error && !this.#working) {
			nodes.push(h("div", { class: "empty" }, t("No messages yet.")));
		}
		if (this.#working && !conversation.loading) {
			// As on the desktop: the figure works or writes, and "Nova is writing"
			// shows beside it on hover or focus, never as a bubble.
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
			nodes.push(row);
		}
		const rowFocus = document.activeElement?.classList.contains("thread-activity") ?? false;
		// Nodes already in place stay put: a live log re-reads what is taken out and put back.
		const kept = this.#messages.childNodes;
		if (nodes.length !== kept.length || nodes.some((node, index) => node !== kept[index])) {
			// Keep existing editors attached: replaceChildren removes even retained
			// nodes and loses keyboard focus, selection and an in-progress IME edit.
			const desired = new Set(nodes);
			for (const child of [...this.#messages.children]) if (!desired.has(child as HTMLElement)) child.remove();
			let cursor = this.#messages.firstChild;
			for (const node of nodes) {
				if (node !== cursor) this.#messages.insertBefore(node, cursor);
				cursor = node.nextSibling;
			}
		}
		// A keyboard user reading the row keeps it through a state change or a new message.
		if (rowFocus) this.#messages.querySelector<HTMLElement>(".thread-activity")?.focus({ preventScroll: true });
		this.#refreshTimestamps(false);
		this.#pinToBottom();
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
		]);
		if (key === this.#statusKey) return;
		this.#statusKey = key;
		const children: (HTMLElement | null)[] = [];
		if (conversation.error) children.push(notice("danger", conversation.error));
		if (conversation.sendError) children.push(notice("danger", conversation.sendError));
		if (conversation.interactionError) children.push(notice("danger", conversation.interactionError));
		if (canWrite && !this.#actions.sendMessage)
			children.push(
				h(
					"p",
					{ class: "surface-status", role: "status" },
					t("Sending messages is not available yet. Your draft stays here."),
				),
			);
		if (this.#execution) children.push(this.#execution.el);
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

	#codingElement(
		session: CodingSession,
		agent: HostedStaffAgent | undefined,
		agentName: string,
	): CodingSessionElement {
		const existing = this.#codingElements.get(session.workerId);
		if (existing && !existing.disposed) {
			existing.update(session);
			return existing;
		}
		const element = new CodingSessionElement(session, {
			...this.#codingOptions(agent, agentName),
			open: () => this.#openCodingSession(session.workerId),
		});
		this.#codingElements.set(session.workerId, element);
		return element;
	}

	/** What both the chip and the session's own thread need to render and act. */
	#codingOptions(agent: HostedStaffAgent | undefined, agentName: string) {
		const sessionId = this.#sessionId;
		const company = this.#company;
		return {
			agent,
			names: (current: CodingSession) => {
				const ownerIsViewer = current.ownerUserId === company.userId;
				return {
					agent: company.staffById(current.agentId)?.displayName ?? agentName,
					owner: ownerIsViewer ? t("you") : company.memberName(current.ownerUserId),
					ownerIsViewer,
				};
			},
			viewerOwns: (current: CodingSession) => current.ownerUserId === company.userId,
			api: {
				read: (workerId: string, afterEvent: number) => company.readCodingSession(workerId, afterEvent),
				answer: (workerId: string, text: string, clientRequestId: string) =>
					company.answerCodingSession(sessionId, workerId, text, clientRequestId),
				delegate: (workerId: string, clientRequestId: string) =>
					company.delegateCodingSession(sessionId, workerId, clientRequestId),
			},
			signal: AbortSignal.any([this.#lifetime.signal, company.signal]),
			changed: () => this.#pinToBottom(),
			askAgent: this.#actions.sendMessage
				? (text: string) => {
						this.#closeCodingSession();
						this.#composer.value = text;
						this.#composer.dispatchEvent(new Event("input", { bubbles: true }));
						this.#composer.focus();
					}
				: undefined,
		};
	}

	/** Open a coding session as its own thread over this one, as a bot's message to
	 * another bot opens; the chip stays in the conversation. */
	#openCodingSession(workerId: string): void {
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
				this.#codingElements.get(workerId)?.el.querySelector<HTMLButtonElement>(".coding-chip")?.focus();
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
		const reason = proposalId
			? t("Its changes wait for your decision.")
			: recovery
				? runFailureReason(recovery.lastError, recovery.jobStatus)
				: undefined;
		const retryState = runId ? company.runRetries?.[runId] : undefined;
		// Try again is for an interrupted run; a refused one says what the member must do first.
		const canRetry =
			failed !== undefined &&
			!review &&
			this.#company.canRetryFailedRun(failed) &&
			recovery !== undefined &&
			runFailureInterrupted(recovery.lastError, recovery.jobStatus);
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
		const action =
			proposalId || review
				? h(
						"a",
						{
							class: "btn btn-small",
							href: `#/c/${profileId}/${proposalId ? `proposal/${proposalId}` : "file"}`,
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
