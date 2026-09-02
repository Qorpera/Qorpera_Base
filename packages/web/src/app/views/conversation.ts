import type { TranscriptItem } from "../../cloud/transcript.ts";
import type { HostedSession, JsonValue } from "../../cloud/types.ts";
import { badge, button, creatureImage, fmtTime, h, notice, replace, spinner } from "../../ui/dom.ts";
import type { CompanyController, ConversationState } from "../company.ts";

/* One conversation over the canonical transcript. Rendering follows
 * DECISIONS.md "Transcript projection rules": member inputs and agent sends
 * only. The composer is the single write path (qorpera_append_session_input). */

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
	#renderedKey = "";
	#stickToBottom = true;

	constructor(company: CompanyController, sessionId: string) {
		this.#company = company;
		this.#sessionId = sessionId;
		this.#composer = h("textarea", {
			class: "composer-input",
			rows: 1,
			placeholder: "Message…",
			"aria-label": "Message",
			onkeydown: (event: KeyboardEvent) => {
				if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					this.#submit();
				}
			},
			oninput: () => this.#autosize(),
		});
		this.#send = button("Send", () => this.#submit(), { primary: true });
		this.#composerWrap = h("footer", { class: "composer" }, this.#composer, this.#send);
		this.#messages.addEventListener("scroll", () => {
			const { scrollTop, scrollHeight, clientHeight } = this.#messages;
			this.#stickToBottom = scrollHeight - scrollTop - clientHeight < 48;
		});
		this.el = h("section", { class: "thread" }, this.#header, this.#messages, this.#status, this.#composerWrap);
		company.setOpenSession(sessionId);
		this.update();
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	focus(): void {
		this.#composer.focus();
	}

	#autosize(): void {
		this.#composer.style.height = "auto";
		this.#composer.style.height = `${Math.min(this.#composer.scrollHeight, 200)}px`;
	}

	#submit(): void {
		const text = this.#composer.value;
		if (!text.trim() || this.#send.disabled) return;
		this.#composer.value = "";
		this.#autosize();
		void this.#company.sendPrompt(this.#sessionId, text);
	}

	update(): void {
		const company = this.#company.store.get();
		const conversation = this.#company.conversation(this.#sessionId).get();
		const session = company.sessions.find((item) => item.sessionId === this.#sessionId);
		const agent = this.#company.staffById(session?.staffAgentId);
		const activity = this.#company.activityFor(session?.staffAgentId);
		const canWrite = company.team?.capabilities.write === true && session?.status !== "closed";
		this.#renderHeader(
			session,
			agent?.displayName,
			agent?.appearance.creature,
			agent?.appearance.color,
			activity?.activity,
		);
		this.#renderMessages(
			conversation,
			agent?.displayName ?? session?.title ?? "Agent",
			agent?.appearance.creature,
			agent?.appearance.color,
		);
		this.#renderStatus(conversation, activity?.activity, canWrite, session);
		this.#composer.disabled = !canWrite || conversation.sending;
		this.#send.disabled = !canWrite || conversation.sending;
		this.#composerWrap.hidden = !canWrite;
	}

	#renderHeader(
		session: HostedSession | undefined,
		agentName: string | undefined,
		creature: string | undefined,
		color: string | undefined,
		activity: string | undefined,
	): void {
		const title = agentName ?? session?.title ?? "Conversation";
		const audience =
			session?.audience.kind === "member_private"
				? badge("Private", "accent", "Only you and this agent see this conversation")
				: badge("Company", "neutral", "Every member of the company shares this conversation");
		const state =
			activity === "working"
				? badge("Working", "ok")
				: activity === "needs_attention"
					? badge("Needs attention", "warn")
					: session?.status === "closed"
						? badge("Archived", "neutral")
						: null;
		replace(
			this.#header,
			creatureImage(creature, title, color),
			h(
				"div",
				{ class: "thread-title" },
				h("h1", null, title),
				h(
					"div",
					{ class: "muted small" },
					session?.title && session.title !== title ? session.title : "",
					" ",
					audience,
					" ",
					state,
				),
			),
		);
	}

	#renderMessages(
		conversation: ConversationState,
		agentName: string,
		creature: string | undefined,
		color: string | undefined,
	): void {
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
		const key = `${items.map((item) => `${item.id}:${"pending" in item ? (item.pending ?? "") : ""}`).join("|")}#${conversation.projection.hiddenCount}#${conversation.loading}`;
		if (key === this.#renderedKey) return;
		this.#renderedKey = key;
		const nodes: HTMLElement[] = [];
		if (conversation.projection.hiddenCount > 0) {
			nodes.push(
				h(
					"div",
					{
						class: "hidden-note",
						title: "Provider output, receipts and orchestration events are private runtime data (runtime contract §6).",
					},
					`${conversation.projection.hiddenCount} transcript ${conversation.projection.hiddenCount === 1 ? "entry" : "entries"} not shown: only member inputs and agent send operations are public.`,
				),
			);
		}
		for (const item of items) {
			if (item.kind === "member" || item.kind === "agent") {
				const mine = item.kind === "member" && item.authorUserId === this.#company.userId;
				const author = item.kind === "agent" ? agentName : this.#company.memberName(item.authorUserId);
				nodes.push(
					h(
						"article",
						{
							class: [
								"message",
								item.kind === "agent" ? "from-agent" : "from-member",
								mine && "mine",
								item.pending && `pending-${item.pending}`,
							]
								.filter(Boolean)
								.join(" "),
						},
						item.kind === "agent"
							? creatureImage(creature, agentName, color)
							: h("span", { class: "avatar small" }, author.slice(0, 1).toUpperCase()),
						h(
							"div",
							{ class: "bubble" },
							h(
								"div",
								{ class: "meta" },
								h("span", { class: "author" }, author),
								item.phase === "progress"
									? badge("progress", "neutral", "A progress message; the agent's turn is not finished")
									: null,
								item.pending === "queued"
									? badge("queued", "neutral", "Waiting for the agent to pick this up")
									: null,
								item.pending === "processing" ? badge("processing", "ok") : null,
								item.pending === "failed" ? badge("failed", "danger", item.failureReason ?? "") : null,
								h("time", { datetime: item.createdAt }, fmtTime(item.createdAt)),
							),
							h("div", { class: "text" }, item.text || (item.attachmentCount ? "" : "(empty)")),
							item.attachmentCount
								? h(
										"div",
										{ class: "muted small" },
										`${item.attachmentCount} attachment${item.attachmentCount === 1 ? "" : "s"}`,
									)
								: null,
							item.pending === "failed" && item.failureReason
								? h("div", { class: "muted small" }, item.failureReason)
								: null,
						),
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
		if (activity === "working") children.push(h("div", { class: "typing" }, "The agent is working on the cloud…"));
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
