import { describeError } from "../../cloud/client.ts";
import { sessionAttachmentIssue } from "../../cloud/session-attachments.ts";
import type { TranscriptCard, TranscriptItem } from "../../cloud/transcript.ts";
import type { HostedSession, HostedStaffAgent } from "../../cloud/types.ts";
import { AttachmentTray } from "../../ui/attachments.ts";
import { authorizationRequestId, renderAuthorizationCard } from "../../ui/authorization-card.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { button, fmtTime, h, icon, notice, replace, spinner } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { markdownBubbles } from "../../ui/markdown.ts";
import { ReceivedAttachments } from "../../ui/received-attachments.ts";
import type { CompanyController, ConversationState, FailedRun } from "../company.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import { AgentDetails } from "./agent-details.ts";
import { ComputerPanel } from "./computer.ts";
import { SessionExecutionView } from "./session-execution.ts";
import { SessionRunView } from "./session-run.ts";

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
	#working = false;
	#activityKey = "";
	readonly #composerWrap: HTMLElement;
	readonly #composerShell: HTMLElement;
	readonly #attachments: AttachmentTray;
	readonly #more: HTMLButtonElement;
	readonly #menu: HTMLElement;
	readonly #attach: HTMLButtonElement;
	readonly #identity: HTMLButtonElement;
	readonly #computer: HTMLButtonElement;
	readonly #navigation: HTMLButtonElement;
	readonly #body: HTMLElement;
	readonly #conversationPane: HTMLElement;
	readonly #lifetime = new AbortController();
	readonly #actions: WorkspaceActions;
	readonly #run: SessionRunView | undefined;
	readonly #execution: SessionExecutionView | undefined;
	#details: AgentDetails | undefined;
	#panel: ComputerPanel | undefined;
	#headerKey = "";
	#renderedKey = "";
	#stickToBottom = true;
	readonly #unsubscribe: (() => void)[] = [];
	#disposed = false;
	#dismissing: string | undefined;
	#dismissError: { runId: string; message: string } | undefined;
	#receivedAttachments: ReceivedAttachments[] = [];

	constructor(
		company: CompanyController,
		sessionId: string,
		actions: WorkspaceActions = {},
		toggleNavigation?: () => void,
	) {
		this.#company = company;
		this.#sessionId = sessionId;
		this.#actions = actions;
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
		const fileInput = h("input", { type: "file", multiple: true, hidden: true, "aria-label": "Attach files" });
		fileInput.onchange = () => {
			if (!this.#composer.disabled && !this.#isRoom) this.#attachments.add([...(fileInput.files ?? [])]);
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
					if (!this.#isRoom) fileInput.click();
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
		this.#navigation = h(
			"button",
			{
				type: "button",
				class: "mobile-navigation-toggle icon-button",
				"aria-label": "Company navigation",
				"aria-controls": "company-navigation",
				"aria-expanded": "false",
				hidden: !toggleNavigation,
				onclick: toggleNavigation,
			},
			icon("navigation"),
		);
		this.#header.append(this.#navigation, this.#identity, this.#computer);
		this.#messages.addEventListener("scroll", () => {
			const { scrollTop, scrollHeight, clientHeight } = this.#messages;
			this.#stickToBottom = scrollHeight - scrollTop - clientHeight < 48;
		});
		this.#conversationPane = h(
			"div",
			{ class: "thread-conversation" },
			this.#header,
			this.#messages,
			this.#status,
			this.#composerWrap,
		);
		this.#body = h("div", { class: "thread-body" }, this.#conversationPane);
		this.el = h("section", { class: "thread" }, this.#body);
		window.addEventListener("resize", () => this.#syncPanelLayout(), { signal: this.#lifetime.signal });
		window.addEventListener("qorpera-rail-resize", () => this.#autosize(), { signal: this.#lifetime.signal });
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
		for (const attachments of this.#receivedAttachments) attachments.dispose();
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
		return typeof session?.executionScope?.roomId === "string" && !session.staffAgentId;
	}

	focus(): void {
		this.#autosize();
		this.#composer.focus();
	}
	setNavigationOpen(open: boolean): void {
		this.#navigation.setAttribute("aria-expanded", String(open));
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
		this.#composer.style.height = `${Math.min(this.#composer.scrollHeight, 112)}px`;
		this.#composer.style.overflowY = this.#composer.scrollHeight > 112 ? "auto" : "hidden";
		const expanded = this.#composerShell.classList.contains("is-expanded");
		this.#composerShell.style.height = `${this.#composer.getBoundingClientRect().height + (expanded ? 44 : 2) + this.#attachments.el.getBoundingClientRect().height}px`;
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
		if (this.#details) {
			this.#details.dialog.close();
			return;
		}
		if (!agent) return;
		this.#identity.setAttribute("aria-expanded", "true");
		this.#details = new AgentDetails(
			this.#company,
			agent,
			this.#actions,
			() => {
				this.#details = undefined;
				this.#identity.setAttribute("aria-expanded", "false");
			},
			this.#identity,
		);
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
		this.#panel = new ComputerPanel(
			agent,
			() => this.#toggleComputer(),
			this.#actions.computer,
			this.#company.signal,
		);
		this.#body.append(this.#panel.el);
		this.#panel.focus();
		this.#syncPanelLayout();
		this.#computer.setAttribute("aria-expanded", "true");
	}

	#syncPanelLayout(): void {
		// The overlay width in conversation.css: default rail + panel + a usable conversation.
		const covered = Boolean(this.#panel) && window.innerWidth <= 1192;
		if (covered && this.#conversationPane.contains(document.activeElement)) this.#panel?.focus();
		this.#conversationPane.inert = covered;
		this.#autosize();
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
			? "Stop"
			: this.#actions.sendMessage
				? "Send message"
				: "Sending messages is not available yet";
		this.#send.title = label;
		this.#send.setAttribute("aria-label", stop ? "Stop" : "Send message");
		this.#send.disabled = stop ? this.#run?.stopping === true : this.#cannotSend;
	}

	#submit(): void {
		const text = this.#composer.value;
		if ((!text.trim() && !this.#attachments.count) || this.#send.disabled || !this.#actions.sendMessage) return;
		void this.#actions.sendMessage(this.#sessionId, text, this.#lifetime.signal).then((sent) => {
			if (sent && !this.#disposed) {
				if (!this.#isRoom) this.#run?.messageSent();
				void this.#execution?.refresh();
			}
		});
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
		this.#execution?.update();
		this.#run?.update(
			room || company.accessLost || !company.team?.capabilities.read ? undefined : session?.staffAgentId,
			canWrite,
		);
		const attachmentIssue =
			room && conversation.attachments?.length
				? "Images are not supported in team rooms. Use Company File."
				: sessionAttachmentIssue(conversation.attachments ?? []);
		this.#attachments.sync(
			conversation.attachments ?? [],
			!canWrite || conversation.sending,
			room
				? "Images are not supported in team rooms. Use Company File."
				: this.#actions.sendMessage
					? attachmentIssue
						? `Attachments stay on this device. ${attachmentIssue}`
						: conversation.sending
							? "Uploading images and sending message…"
							: "Images stay on this device until you send. Up to 5 images, 8 MiB total."
					: undefined,
		);
		// The agent's run is watched quietly; a change in who is working re-reads it.
		const activity = room ? undefined : this.#company.activityFor(session?.staffAgentId);
		const working = activity !== undefined && activity.activity !== "needs_attention";
		const activityKey = `${activity?.runId ?? ""}:${activity?.activity ?? ""}`;
		if (activityKey !== this.#activityKey) {
			this.#activityKey = activityKey;
			void this.#run?.refresh();
		}
		this.#working = working || (conversation.sending && !room);
		this.#renderHeader(session, agent);
		this.#renderMessages(conversation, room ? "Agent reply" : (agent?.displayName ?? session?.title ?? "Agent"));
		this.#renderStatus(conversation, canWrite, session);
		this.#composer.disabled = !canWrite || conversation.sending;
		this.#cannotSend =
			!this.#actions.sendMessage ||
			(this.#execution !== undefined && !this.#execution.canSend) ||
			!canWrite ||
			conversation.sending ||
			(!conversation.draft?.trim() && !this.#attachments.count) ||
			Boolean(attachmentIssue);
		this.#syncSend();
		this.#attach.disabled = this.#composer.disabled || room;
		this.#more.hidden = room;
		this.#more.disabled = this.#composer.disabled;
		if ((this.#composer.disabled || room) && !this.#menu.hidden) this.#setMenu(false, false);
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
			this.#panel = agent
				? new ComputerPanel(agent, () => this.#toggleComputer(), this.#actions.computer, this.#company.signal)
				: undefined;
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
					attachmentCount: item.attachmentCount ?? 0,
					createdAt: item.createdAt,
					pending: "queued",
				}),
			),
		];
		const key = JSON.stringify([
			items,
			agentName,
			this.#isRoom,
			this.#company.store.get().team?.members,
			conversation.projection.hiddenCount,
			conversation.loading,
			conversation.error,
			this.#working,
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
		for (const item of items) {
			if (item.kind === "member" || item.kind === "agent") {
				const mine = item.kind === "member" && item.authorUserId === this.#company.userId;
				const author =
					item.kind === "agent"
						? this.#isRoom
							? (item.staffSpeaker?.displayName ??
								(item.staffSpeaker
									? `Agent ${item.staffSpeaker.staffAgentId}`
									: "Agent reply · speaker unavailable"))
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
							? [h("div", { class: "text" }, item.text || "(empty)")]
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
						item.kind === "authorization_request" ? decisions.get(item.id.toLowerCase())?.body : undefined,
					),
				);
			}
		}
		if (conversation.loading && !items.length) nodes.push(spinner("Loading conversation"));
		if (!conversation.loading && !items.length && !conversation.error && !this.#working) {
			nodes.push(h("div", { class: "empty" }, "No messages yet."));
		}
		if (this.#working && !conversation.loading)
			nodes.push(
				h(
					"div",
					{ class: "message from-agent typing", role: "status", "aria-label": `${agentName} is working` },
					h("span", null),
					h("span", null),
					h("span", null),
				),
			);
		replace(this.#messages, ...nodes);
		if (this.#stickToBottom) this.#messages.scrollTop = this.#messages.scrollHeight;
	}

	#renderStatus(conversation: ConversationState, canWrite: boolean, session: HostedSession | undefined): void {
		const children: (HTMLElement | null)[] = [];
		if (conversation.error) children.push(notice("danger", conversation.error));
		if (conversation.sendError) children.push(notice("danger", conversation.sendError));
		const failed = this.#isRoom ? undefined : this.#company.failedRunFor(session?.staffAgentId);
		if (failed) children.push(this.#failedRunCard(failed, canWrite));
		if (canWrite && !this.#actions.sendMessage)
			children.push(
				h(
					"p",
					{ class: "surface-status", role: "status" },
					"Sending messages is not available yet. Your draft stays here.",
				),
			);
		if (this.#isRoom)
			children.push(
				notice(
					"neutral",
					"Multiple agents can respond in this room. Follow their replies here. Images are not supported in team rooms. Use Company File." +
						(["owner", "admin"].includes(this.#company.store.get().team?.role ?? "")
							? " Company-wide execution pause is available in Settings → Company."
							: ""),
				),
			);
		if (this.#execution) children.push(this.#execution.el);
		if (!canWrite && session?.status === "closed") children.push(notice("neutral", "This conversation is archived."));
		else if (
			!canWrite &&
			session &&
			!conversation.loading &&
			!conversation.error &&
			!this.#company.store.get().accessLost &&
			this.#company.store.get().team?.capabilities.read === true
		)
			children.push(notice("neutral", "You can read this conversation. Contributors and above can write."));
		replace(this.#status, ...children);
	}

	/** The card behind the rail's red disc (shell spec §11.1). A run that left Company
	 * File changes is settled by deciding them; any other failed run can be dismissed,
	 * unless some of its work still has an unknown outcome. */
	#failedRunCard({ activity, recovery }: FailedRun, canWrite: boolean): HTMLElement {
		if (recovery?.proposalId)
			return notice(
				"warn",
				"A run stopped after changing Company File. ",
				h(
					"a",
					{ href: `#/c/${this.#company.profile.profileId}/proposal/${recovery.proposalId}` },
					"Review the changes",
				),
				" to keep or discard them.",
			);
		const unsettled = (recovery?.unsettledOperations ?? 0) > 0;
		const dismissing = this.#dismissing === activity.runId;
		const error = this.#dismissError?.runId === activity.runId ? this.#dismissError.message : undefined;
		return notice(
			"warn",
			h("p", null, recovery?.lastError ? `A run did not finish: ${recovery.lastError}` : "A run did not finish."),
			unsettled ? h("p", null, "Part of its work is still being checked, so it cannot be dismissed yet.") : null,
			error ? h("p", null, error) : null,
			canWrite && !unsettled && activity.sourceKind !== "proposal_review"
				? button(dismissing ? "Dismissing…" : "Dismiss", () => void this.#dismiss(activity.runId), {
						small: true,
						disabled: dismissing,
					})
				: null,
		);
	}

	async #dismiss(runId: string): Promise<void> {
		if (this.#dismissing) return;
		this.#dismissing = runId;
		this.#dismissError = undefined;
		this.update();
		try {
			await this.#company.dismissFailedRun(runId);
		} catch (error) {
			this.#dismissError = { runId, message: describeError(error) };
		} finally {
			this.#dismissing = undefined;
			this.update();
		}
	}
}
