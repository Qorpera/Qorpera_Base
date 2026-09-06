import type { TranscriptItem } from "../../cloud/transcript.ts";
import type { HostedSession, HostedStaffAgent, JsonValue } from "../../cloud/types.ts";
import { AttachmentTray } from "../../ui/attachments.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { badge, fmtTime, h, icon, notice, replace, spinner } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { markdownBubbles } from "../../ui/markdown.ts";
import type { CompanyController, ConversationState } from "../company.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import { AgentDetails } from "./agent-details.ts";
import { ComputerPanel } from "./computer.ts";

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
	readonly #composerWrap: HTMLElement;
	readonly #composerShell: HTMLElement;
	readonly #attachments: AttachmentTray;
	readonly #more: HTMLButtonElement;
	readonly #menu: HTMLElement;
	readonly #attach: HTMLButtonElement;
	readonly #identity: HTMLButtonElement;
	readonly #computer: HTMLButtonElement;
	readonly #body: HTMLElement;
	readonly #conversationPane: HTMLElement;
	readonly #lifetime = new AbortController();
	readonly #actions: WorkspaceActions;
	#details: AgentDetails | undefined;
	#panel: ComputerPanel | undefined;
	#headerKey = "";
	#renderedKey = "";
	#stickToBottom = true;
	readonly #unsubscribe: (() => void)[] = [];
	#disposed = false;

	constructor(company: CompanyController, sessionId: string, actions: WorkspaceActions = {}) {
		this.#company = company;
		this.#sessionId = sessionId;
		this.#actions = actions;
		this.#composer = h("textarea", {
			class: "composer-input",
			rows: 1,
			placeholder: "Message…",
			"aria-label": "Message",
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
				"aria-label": "Send message",
				title: "Send message",
				onclick: () => this.#submit(),
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
		const fileInput = h("input", { type: "file", multiple: true, hidden: true, "aria-label": "Attach files" });
		fileInput.onchange = () => {
			if (!this.#composer.disabled) this.#attachments.add([...(fileInput.files ?? [])]);
			fileInput.value = "";
		};
		this.#more = h(
			"button",
			{
				type: "button",
				class: "composer-more icon-button",
				title: "Chat settings and more",
				"aria-label": "Chat settings and more",
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
					fileInput.click();
				},
			},
			icon("attach"),
			"Attach files",
		);
		this.#menu = h(
			"div",
			{ class: "composer-menu", role: "menu", hidden: true, "aria-label": "Chat settings and more" },
			this.#attach,
		);
		this.#menu.addEventListener("keydown", (event) => {
			if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				this.#setMenu(false);
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
				this.#attachments.add(files);
			}
		});
		this.#composerShell.addEventListener("dragover", (event) => {
			if (!this.#composer.disabled && event.dataTransfer?.types.includes("Files")) {
				event.preventDefault();
				this.#composerShell.classList.add("is-dragging");
			}
		});
		this.#composerShell.addEventListener("dragleave", () => this.#composerShell.classList.remove("is-dragging"));
		this.#composerShell.addEventListener("drop", (event) => {
			event.preventDefault();
			this.#composerShell.classList.remove("is-dragging");
			if (!this.#composer.disabled) this.#attachments.add([...(event.dataTransfer?.files ?? [])]);
		});
		this.#composerWrap = h("footer", { class: "composer" }, this.#composerShell, this.#attachments.status);
		this.#identity = h("button", {
			type: "button",
			class: "thread-identity",
			"aria-label": "Open agent details",
			"aria-haspopup": "dialog",
			"aria-expanded": "false",
			onclick: () => this.#openDetails(),
		});
		this.#computer = h(
			"button",
			{
				type: "button",
				class: "icon-button thread-computer",
				title: "Open agent computer",
				"aria-label": "Open agent computer",
				"aria-expanded": "false",
				onclick: () => this.#toggleComputer(),
			},
			icon("computer"),
		);
		this.#header.append(this.#identity, this.#computer);
		this.#messages.addEventListener("scroll", () => {
			const { scrollTop, scrollHeight, clientHeight } = this.#messages;
			this.#stickToBottom = scrollHeight - scrollTop - clientHeight < 48;
		});
		this.#conversationPane = h(
			"div",
			{ class: "thread-conversation" },
			this.#messages,
			this.#status,
			this.#composerWrap,
		);
		this.#body = h("div", { class: "thread-body" }, this.#conversationPane);
		this.el = h("section", { class: "thread" }, this.#header, this.#body);
		window.addEventListener("resize", () => this.#syncPanelLayout(), { signal: this.#lifetime.signal });
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
		this.#details?.dispose();
		this.#panel?.dispose();
		this.#attachments.dispose();
		for (const unsubscribe of this.#unsubscribe) unsubscribe();
		this.#company.setOpenSession(undefined);
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	focus(): void {
		this.#autosize();
		this.#composer.focus();
	}

	#autosize(): void {
		// Start with compact geometry: collapsing after measuring an expanded
		// field changes its padding and can clip a two-line draft.
		this.#composerShell.classList.toggle("is-expanded", this.#attachments.count > 0);
		this.#composer.style.height = "auto";
		this.#composerShell.classList.toggle(
			"is-expanded",
			this.#composer.scrollHeight > 42 || this.#attachments.count > 0,
		);
		this.#composer.style.height = `${Math.min(this.#composer.scrollHeight, 200)}px`;
	}

	#setMenu(open: boolean, restoreFocus = true): void {
		this.#menu.hidden = !open;
		this.#more.setAttribute("aria-expanded", String(open));
		if (open) this.#attach.focus();
		else if (restoreFocus) this.#more.focus();
	}

	#openDetails(): void {
		const state = this.#company.store.get();
		const agent = this.#company.staffById(
			state.sessions.find((session) => session.sessionId === this.#sessionId)?.staffAgentId,
		);
		if (!agent || this.#details) return;
		this.#identity.setAttribute("aria-expanded", "true");
		this.#details = new AgentDetails(this.#company, agent, this.#actions, () => {
			this.#details = undefined;
			this.#identity.setAttribute("aria-expanded", "false");
		});
	}

	#toggleComputer(): void {
		if (this.#panel) {
			this.#panel.dispose();
			this.#panel = undefined;
			this.#syncPanelLayout();
			this.#computer.setAttribute("aria-expanded", "false");
			this.#computer.focus();
			return;
		}
		const state = this.#company.store.get();
		const agent = this.#company.staffById(
			state.sessions.find((session) => session.sessionId === this.#sessionId)?.staffAgentId,
		);
		if (!agent) return;
		this.#panel = new ComputerPanel(agent, () => this.#toggleComputer());
		this.#body.append(this.#panel.el);
		this.#panel.focus();
		this.#syncPanelLayout();
		this.#computer.setAttribute("aria-expanded", "true");
	}

	#syncPanelLayout(): void {
		const covered = Boolean(this.#panel) && window.innerWidth <= 1040;
		if (covered && this.#conversationPane.contains(document.activeElement)) this.#panel?.focus();
		this.#conversationPane.inert = covered;
		this.#autosize();
	}

	#submit(): void {
		const text = this.#composer.value;
		if (!text.trim() || this.#send.disabled || !this.#actions.sendMessage) return;
		void this.#actions.sendMessage(this.#sessionId, text, this.#lifetime.signal);
		this.update();
	}

	update(): void {
		if (this.#disposed) return;
		const company = this.#company.store.get();
		const conversation = this.#company.conversation(this.#sessionId).get();
		const session = company.sessions.find((item) => item.sessionId === this.#sessionId);
		const agent = this.#company.staffById(session?.staffAgentId);
		const activity = this.#company.activityFor(session?.staffAgentId);
		const canWrite = company.team?.capabilities.write === true && session?.status === "open";
		this.#renderHeader(session, agent);
		this.#renderMessages(conversation, agent?.displayName ?? session?.title ?? "Agent");
		this.#renderStatus(conversation, activity?.activity, canWrite, session);
		this.#composer.disabled = !canWrite || conversation.sending;
		this.#send.disabled =
			!this.#actions.sendMessage ||
			!canWrite ||
			conversation.sending ||
			!conversation.draft?.trim() ||
			this.#attachments.count > 0;
		this.#send.title = this.#actions.sendMessage ? "Send message" : "Sending messages is not available yet";
		this.#attach.disabled = this.#composer.disabled;
		this.#more.disabled = this.#composer.disabled;
		if (this.#composer.disabled && !this.#menu.hidden) this.#setMenu(false, false);
		this.#composerWrap.hidden = !canWrite;
		if (this.#composer.value !== (conversation.draft ?? "")) {
			this.#composer.value = conversation.draft ?? "";
			this.#autosize();
		}
	}

	#renderHeader(session: HostedSession | undefined, agent: HostedStaffAgent | undefined): void {
		const title = agent?.displayName ?? session?.title ?? "Conversation";
		const key = JSON.stringify([title, agent?.id, agent?.appearance]);
		this.#identity.disabled = !agent;
		this.#computer.hidden = !agent;
		this.#identity.title = title;
		if (key === this.#headerKey) return;
		this.#headerKey = key;
		if (this.#panel) {
			const focused = this.#panel.el.contains(document.activeElement);
			this.#panel.dispose();
			this.#panel = agent ? new ComputerPanel(agent, () => this.#toggleComputer()) : undefined;
			if (this.#panel) this.#body.append(this.#panel.el);
			if (focused) this.#panel ? this.#panel.focus() : this.#composer.focus();
			this.#computer.setAttribute("aria-expanded", String(Boolean(this.#panel)));
			this.#syncPanelLayout();
		}
		replace(this.#identity, agentFigure(agent, title, { size: 32 }), h("h1", null, title), icon("chevron"));
	}

	#renderMessages(conversation: ConversationState, agentName: string): void {
		const items: TranscriptItem[] = [
			...conversation.projection.items,
			...conversation.optimistic.map(
				(item): TranscriptItem => ({
					kind: "member",
					id: item.clientInputId,
					sequence: Number.MAX_SAFE_INTEGER,
					authorUserId: item.authorUserId,
					text: item.text,
					attachmentCount: 0,
					createdAt: item.createdAt,
					pending: "queued",
				}),
			),
		];
		const key = JSON.stringify([
			items,
			agentName,
			this.#company.store.get().team?.members,
			conversation.projection.hiddenCount,
			conversation.loading,
			conversation.error,
		]);
		if (key === this.#renderedKey) return;
		this.#renderedKey = key;
		const nodes: HTMLElement[] = [];
		for (const item of items) {
			if (item.kind === "member" || item.kind === "agent") {
				const mine = item.kind === "member" && item.authorUserId === this.#company.userId;
				const author = item.kind === "agent" ? agentName : this.#company.memberName(item.authorUserId);
				const bodies =
					item.kind === "agent"
						? markdownBubbles(item.text)
						: [h("div", { class: "text" }, item.text || (item.attachmentCount ? "" : "(empty)"))];
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
						item.kind === "member" && !mine ? h("div", { class: "message-author" }, author) : null,
						...bodies.map((body, index) =>
							h(
								"div",
								{ class: "bubble" },
								body,
								index === bodies.length - 1 && item.attachmentCount
									? h(
											"div",
											{ class: "muted small" },
											icon("file"),
											`${item.attachmentCount} attachment${item.attachmentCount === 1 ? "" : "s"} · preview unavailable`,
										)
									: null,
							),
						),
						item.phase === "progress"
							? h("div", { class: "message-caption", title: "The agent's turn is not finished" }, "Progress")
							: null,
						item.pending
							? h(
									"div",
									{ class: "message-caption" },
									item.pending === "failed"
										? `Failed${item.failureReason ? ` · ${item.failureReason}` : ""}`
										: item.pending === "processing"
											? "Processing"
											: "Queued",
								)
							: null,
					),
				);
			} else if (item.kind === "authorization_request" || item.kind === "authorization_decision") {
				nodes.push(
					renderAuthorizationCard(
						item.kind,
						item.body,
						item.createdAt,
						this.#company.memberName(item.actorUserId),
					),
				);
			}
		}
		if (conversation.loading && !items.length) nodes.push(spinner("Loading conversation"));
		if (!conversation.loading && !items.length && !conversation.error) {
			nodes.push(h("div", { class: "empty" }, "No messages yet."));
		}
		replace(this.#messages, ...nodes);
		if (this.#stickToBottom) this.#messages.scrollTop = this.#messages.scrollHeight;
	}

	#renderStatus(
		conversation: ConversationState,
		activity: string | undefined,
		canWrite: boolean,
		session: HostedSession | undefined,
	): void {
		const children: (HTMLElement | null)[] = [];
		if (conversation.error) children.push(notice("danger", conversation.error));
		if (conversation.sendError) children.push(notice("danger", conversation.sendError));
		if (canWrite && !this.#actions.sendMessage)
			children.push(
				h(
					"p",
					{ class: "surface-status", role: "status" },
					"Sending messages is not available yet. Your draft stays here.",
				),
			);
		if (activity === "working") children.push(h("div", { class: "typing", role: "status" }, "Working…"));
		if (activity === "needs_attention") children.push(notice("neutral", "This agent needs your attention."));
		if (!canWrite && session?.status === "closed") children.push(notice("neutral", "This conversation is archived."));
		else if (!canWrite)
			children.push(notice("neutral", "You can read this conversation. Contributors and above can write."));
		replace(this.#status, ...children);
	}
}

function describeValue(value: JsonValue): string {
	if (value === null) return "—";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

export function renderAuthorizationCard(
	kind: "authorization_request" | "authorization_decision",
	body: JsonValue,
	createdAt: string,
	actor: string,
): HTMLElement {
	const fields = body && typeof body === "object" && !Array.isArray(body) ? Object.entries(body) : [];
	return h(
		"article",
		{ class: `card auth-card ${kind}` },
		h(
			"div",
			{ class: "meta" },
			badge(
				kind === "authorization_request" ? "Approval requested" : "Decision",
				kind === "authorization_request" ? "warn" : "ok",
			),
			h("span", { class: "muted small" }, `${actor} · ${fmtTime(createdAt)}`),
		),
		fields.length
			? h(
					"dl",
					{ class: "kv" },
					...fields.flatMap(([key, value]) => [h("dt", null, key), h("dd", null, describeValue(value))]),
				)
			: h("div", { class: "muted" }, "No details."),
	);
}
