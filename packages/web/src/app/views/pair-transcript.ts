import type { TranscriptMessage, TranscriptNote } from "../../cloud/transcript.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import {
	conversationTimestampLabel,
	conversationTimestampTitle,
	needsConversationTimestamp,
	parseConversationTimestamp,
} from "../../ui/conversation-timestamps.ts";
import { fmtTime, h, icon, replace } from "../../ui/dom.ts";
import { markdownBubbles } from "../../ui/markdown.ts";
import { quietScroll } from "../../ui/quiet-scroll.ts";
import { messagesSkeleton } from "../../ui/skeleton.ts";
import type { CompanyController } from "../company.ts";

/** What the panel needs from the company: the pair session's events and the agents' names. */
export type PairTranscriptHost = Pick<
	CompanyController,
	"conversation" | "conversations" | "loadConversation" | "staffById" | "signal"
>;

const REFRESH_MS = 5_000;

/** The view-only transcript of two agents' messages to each other (contract
 * 14.6). Opened from a chip in either agent's thread and laid over it, as the
 * reference product does: both figures and names in the header, each message
 * as a bubble under the speaking agent's name, the coworker on the left and
 * the thread's own agent on the right, a lock line and one Close button.
 * Nothing here can send: members steer by writing in either agent's thread. */
export class PairTranscriptView {
	readonly el: HTMLElement;
	readonly #host: PairTranscriptHost;
	readonly #sessionId: string;
	readonly #agentIds: readonly [string, string];
	readonly #header = h("header", { class: "thread-header pair-header" });
	readonly #messages = h("div", { class: "messages pair-messages", role: "log", "aria-live": "polite" });
	readonly #close: HTMLButtonElement;
	readonly #lifetime = new AbortController();
	readonly #timer: number;
	/** The messages' placeholder, one per load, so the log does not read it out again on each redraw. */
	#placeholder: HTMLElement | undefined;
	#renderedKey = "";
	#disposed = false;

	/** @param agentIds the coworker (shown on the left) and the thread's own agent (on the right). */
	constructor(host: PairTranscriptHost, sessionId: string, agentIds: readonly [string, string], onClose: () => void) {
		this.#host = host;
		this.#sessionId = sessionId;
		this.#agentIds = agentIds;
		this.#close = h(
			"button",
			{ type: "button", class: "pair-close", onclick: () => onClose() },
			"Close Chat",
		) as HTMLButtonElement;
		this.el = h(
			"section",
			{
				class: "pair-transcript",
				role: "dialog",
				"aria-modal": "false",
				"aria-label": "Conversation between two agents",
				tabindex: "-1",
			},
			this.#header,
			this.#messages,
			h(
				"footer",
				{ class: "pair-footer" },
				h("span", { class: "pair-readonly" }, icon("lock"), h("span", null, "This chat is view-only")),
				this.#close,
			),
		);
		this.el.addEventListener(
			"keydown",
			(event: KeyboardEvent) => {
				if (event.key === "Escape") {
					event.preventDefault();
					onClose();
				}
			},
			{ signal: this.#lifetime.signal },
		);
		quietScroll(this.#messages);
		// A new store loads itself; a transcript opened before is read again now,
		// not when the timer next fires.
		const existed = host.conversations.has(sessionId);
		const store = host.conversation(sessionId);
		const unsubscribe = store.subscribe(() => this.update());
		if (existed) void host.loadConversation(sessionId);
		this.#lifetime.signal.addEventListener("abort", unsubscribe, { once: true });
		// A reply that arrives while the member watches shows in place; a hidden tab
		// does not poll, and catches up the moment it is shown again.
		const refresh = () => {
			if (this.#disposed || host.signal.aborted || document.hidden) return;
			void host.loadConversation(sessionId);
		};
		this.#timer = window.setInterval(refresh, REFRESH_MS);
		document.addEventListener("visibilitychange", refresh, { signal: this.#lifetime.signal });
		this.update();
	}

	focus(): void {
		this.#close.focus({ preventScroll: true });
	}

	#agent(id: string): { agent: HostedStaffAgent | undefined; name: string } {
		const agent = this.#host.staffById(id);
		return { agent, name: agent?.displayName ?? "Agent" };
	}

	update(): void {
		if (this.#disposed) return;
		const conversation = this.#host.conversation(this.#sessionId, false).get();
		const first = this.#agent(this.#agentIds[0]);
		const second = this.#agent(this.#agentIds[1]);
		const items = conversation.projection.items.filter(
			(item): item is TranscriptMessage | TranscriptNote => item.kind === "agent" || item.kind === "note",
		);
		const key = JSON.stringify([
			items,
			conversation.loading,
			conversation.error,
			first.name,
			second.name,
			first.agent?.appearance,
			second.agent?.appearance,
		]);
		if (key === this.#renderedKey) return;
		this.#renderedKey = key;
		replace(
			this.#header,
			// The header names this thread's own agent first, as the reference product does.
			h(
				"div",
				{ class: "pair-identity" },
				agentFigure(second.agent, second.name, { size: 24 }),
				h("span", { class: "pair-name" }, second.name),
				h("span", { class: "pair-glyph", "aria-label": "and" }, "⇄"),
				agentFigure(first.agent, first.name, { size: 24 }),
				h("span", { class: "pair-name" }, first.name),
			),
		);
		const nodes: HTMLElement[] = [];
		let previous: Date | undefined;
		for (const item of items) {
			const date = parseConversationTimestamp(item.createdAt);
			if (date && needsConversationTimestamp(date, previous)) {
				nodes.push(
					h(
						"time",
						{
							class: "conversation-timestamp",
							datetime: date.toISOString(),
							title: conversationTimestampTitle(date),
						},
						conversationTimestampLabel(date),
					),
				);
			}
			if (date) previous = date;
			if (item.kind === "note") {
				nodes.push(h("div", { class: "conversation-note", role: "note" }, item.text));
			} else if (item.kind === "agent") {
				const speaker = this.#agent(item.staffSpeaker?.staffAgentId ?? "");
				const name = item.staffSpeaker?.displayName ?? speaker.name;
				// The thread's own agent speaks from the right, the coworker from the left.
				const right = item.staffSpeaker?.staffAgentId === this.#agentIds[1];
				const other = this.#agent(right ? this.#agentIds[0] : this.#agentIds[1]);
				nodes.push(
					h(
						"div",
						{ class: right ? "pair-row pair-row-right" : "pair-row" },
						agentFigure(speaker.agent, name, { size: 28 }),
						h(
							"article",
							{
								class: right ? "message from-agent pair-right" : "message from-agent",
								"aria-label": `${name} · ${fmtTime(item.createdAt)}`,
								title: `${name} · ${fmtTime(item.createdAt)}`,
								dataset: { messageId: item.id },
							},
							h("div", { class: "message-author" }, name),
							...markdownBubbles(item.text).map((body) => h("div", { class: "bubble" }, body)),
							item.held
								? h(
										"div",
										{ class: "message-caption", title: "Sent without waking the coworker" },
										`Left for ${other.name}'s next turn`,
									)
								: null,
						),
					),
				);
			}
		}
		if (conversation.loading && !items.length) {
			this.#placeholder ??= messagesSkeleton();
			nodes.push(this.#placeholder);
		} else this.#placeholder = undefined;
		if (!conversation.loading && !items.length && !conversation.error)
			nodes.push(h("div", { class: "empty" }, "No messages yet."));
		if (conversation.error) nodes.push(h("div", { class: "empty" }, conversation.error));
		// Nodes already in place stay put: a live log re-reads what is taken out and put back.
		const kept = this.#messages.childNodes;
		if (nodes.length !== kept.length || nodes.some((node, index) => node !== kept[index]))
			replace(this.#messages, ...nodes);
		this.#messages.scrollTop = this.#messages.scrollHeight;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort();
		window.clearInterval(this.#timer);
		this.el.remove();
	}
}
