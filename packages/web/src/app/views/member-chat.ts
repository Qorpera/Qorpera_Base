import type { MemberMessage } from "../../cloud/member-chats.ts";
import { menuPoint, openContextMenu } from "../../ui/context-menu.ts";
import {
	conversationTimestampLabel,
	conversationTimestampTitle,
	needsConversationTimestamp,
	parseConversationTimestamp,
} from "../../ui/conversation-timestamps.ts";
import { button, confirmDialog, fmtTime, h, icon, notice, personAvatar, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { playOnce } from "../../ui/motion.ts";
import { presentationDay, presentationLocale, presentationTimeZone, t } from "../../ui/preferences.ts";
import { quietScroll } from "../../ui/quiet-scroll.ts";
import { uiScale } from "../../ui/scale.ts";
import { sentTimeHover } from "../../ui/sent-time-hover.ts";
import { messagesSkeleton } from "../../ui/skeleton.ts";
import type { CompanyController, CompanyState } from "../company.ts";
import type { MemberChatThread, OutgoingMemberMessage } from "../member-chats.ts";
import { lastOnline, personFace } from "./friends.ts";

/* A member's chat with another member of the company (Jonas, 10 Nov 2026): the thread an agent's chat is, with a
 * person on the other side. Bubbles, the times between them, a field and a send button, and nothing of an agent's
 * chat that a person does not need: no model, no login, no run. A message shows the moment it is sent; "Seen" stands
 * under the newest one once the other member has looked. */

/** Whether a member is online, and the words for it: in this company now (a tab of theirs is on its presence
 * channel) or online within the last minutes; else when they were last online, when the cloud knows. */
export function memberPresence(
	state: Pick<CompanyState, "here" | "memberChats">,
	userId: string,
	now = Date.now(),
): { online: boolean; text: string } | null {
	if (state.here?.some((member) => member.userId === userId && member.staffAgentId !== null))
		return { online: true, text: t("Online now") };
	return lastOnline(state.memberChats?.[userId]?.lastSeenAt, now);
}

const LINK = /https?:\/\/[^\s<>"']+/g;

/** A message's words, with the web addresses in them as links. Nothing else is read into a person's words. */
function linked(text: string): (string | HTMLElement)[] {
	const parts: (string | HTMLElement)[] = [];
	let at = 0;
	for (const match of text.matchAll(LINK)) {
		// A sentence's own punctuation after an address is not part of it.
		const address = match[0].replace(/[.,!?;:)\]}]+$/, "");
		let url: URL;
		try {
			url = new URL(address);
		} catch {
			continue;
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") continue;
		if (match.index > at) parts.push(text.slice(at, match.index));
		parts.push(h("a", { href: url.href, target: "_blank", rel: "noopener noreferrer" }, address));
		at = match.index + address.length;
	}
	if (at < text.length) parts.push(text.slice(at));
	return parts;
}

function place(parent: Element, children: readonly Node[]): void {
	const wanted = new Set(children);
	for (const child of [...parent.childNodes]) if (!wanted.has(child)) child.remove();
	let cursor = parent.firstChild;
	for (const node of children) {
		if (node !== cursor) parent.insertBefore(node, cursor);
		cursor = node.nextSibling;
	}
}

/** One drawn row of the chat: a message or a time between two. Kept while what it shows is the same. */
interface Row {
	readonly shown: string;
	readonly element: HTMLElement;
}

export class MemberChatView {
	readonly el: HTMLElement;
	readonly userId: string;
	readonly #company: CompanyController;
	readonly #lifetime = new AbortController();
	readonly #header = h("header", { class: "thread-header is-member" });
	readonly #identity = h("div", { class: "thread-identity member-identity" });
	readonly #navigation: HTMLButtonElement;
	readonly #messages = h("div", { class: "messages" });
	readonly #log = h("div", { class: "messages-log", role: "log", "aria-live": "polite" });
	readonly #earlier: HTMLElement;
	readonly #earlierButton: HTMLButtonElement;
	readonly #status = h("div", { class: "thread-status" });
	readonly #foot = h("div", { class: "thread-foot" });
	readonly #composer: HTMLTextAreaElement;
	readonly #send: HTMLButtonElement;
	readonly #shell: HTMLElement;
	readonly #pane: HTMLElement;
	readonly #refreshFade: () => void;
	readonly #sizes: ResizeObserver | undefined;
	readonly #timer: number;
	#rows = new Map<string, Row>();
	/** The newest message is in view: new ones keep it so. */
	#stick = true;
	#pinnedTop = -1;
	#settled = false;
	#identityShown = "";
	#statusShown = "";
	#disposed = false;

	constructor(company: CompanyController, userId: string, toggleNavigation?: () => void) {
		this.#company = company;
		this.userId = userId.toLowerCase();
		const chats = company.memberChats;
		this.#composer = h("textarea", {
			class: "composer-input",
			rows: 1,
			placeholder: t("Message…"),
			"aria-label": t("Message"),
			onkeydown: (event: KeyboardEvent) => {
				if (event.isComposing || !matchesKey(event, "accept") || event.shiftKey) return;
				event.preventDefault();
				this.#submit();
			},
			oninput: () => {
				chats.setDraft(this.userId, this.#composer.value);
				this.#autosize();
				this.#syncSend();
			},
		});
		this.#composer.value = chats.thread(this.userId).get().draft;
		this.#send = h(
			"button",
			{
				type: "button",
				class: "composer-send",
				"aria-label": t("Send message"),
				title: t("Send message"),
				onclick: () => this.#submit(),
			},
			icon("send"),
		);
		this.#shell = h("div", { class: "composer-shell" }, this.#composer, this.#send);
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
		this.#header.append(this.#navigation, this.#identity);
		this.#earlierButton = h(
			"button",
			{
				type: "button",
				class: "btn btn-small thread-earlier-button",
				onclick: () => void this.#showEarlier(),
			},
			t("Show earlier messages"),
		);
		this.#earlier = h("div", { class: "thread-earlier" }, this.#earlierButton);
		this.#messages.append(this.#log);
		sentTimeHover(this.#messages, this.#lifetime.signal);
		this.#refreshFade = quietScroll(this.#messages);
		this.#messages.addEventListener("scroll", () => {
			const { scrollTop, scrollHeight, clientHeight } = this.#messages;
			if (this.#stick && scrollTop === this.#pinnedTop) {
				this.#pinnedTop = -1;
				return;
			}
			this.#stick = scrollHeight - scrollTop - clientHeight < 48 * uiScale();
		});
		this.#messages.addEventListener("contextmenu", (event) => this.#openMenu(event));
		this.#foot.append(this.#status, h("footer", { class: "composer" }, this.#shell));
		this.#pane = h("div", { class: "thread-conversation" }, this.#header, this.#messages, this.#foot);
		this.el = h("section", { class: "thread member-thread" }, h("div", { class: "thread-body" }, this.#pane));
		if (typeof ResizeObserver !== "undefined") {
			this.#sizes = new ResizeObserver(() => {
				// The messages keep room under their last line for the foot laid over them.
				this.#pane.style.setProperty("--thread-foot", `${this.#foot.offsetHeight}px`);
				this.#pin();
			});
			this.#sizes.observe(this.#messages);
			this.#sizes.observe(this.#foot);
			this.#sizes.observe(this.#log);
		}
		playOnce(this.#messages, "is-entering");
		const signal = this.#lifetime.signal;
		signal.addEventListener(
			"abort",
			chats.thread(this.userId).subscribe(() => this.update()),
		);
		window.addEventListener("resize", () => this.#autosize(), { signal });
		window.addEventListener("qorpera-rail-resize", () => this.#autosize(), { signal });
		// WHY: Skip minute-tick redraws while hidden and refresh timestamps immediately on tab return.
		const again = () => this.update();
		this.#timer = window.setInterval(() => {
			if (document.hidden) return;
			this.update();
		}, 60_000);
		document.addEventListener(
			"visibilitychange",
			() => {
				if (!document.hidden) this.update();
			},
			{ signal },
		);
		window.addEventListener("focus", again, { signal });
		window.addEventListener("qorpera-language-change", again, { signal });
		window.addEventListener("qorpera-time-zone-change", again, { signal });
		chats.setOpen(this.userId);
		this.update();
		queueMicrotask(() => this.#autosize());
	}

	focus(): void {
		if (!this.#composer.disabled) this.#composer.focus({ preventScroll: true });
	}

	setNavigationOpen(open: boolean): void {
		this.#navigation.setAttribute("aria-expanded", String(open));
	}

	update(): void {
		if (this.#disposed) return;
		const state = this.#company.store.get();
		const thread = this.#company.memberChats.thread(this.userId).get();
		const member = state.team?.members.find((item) => item.userId === this.userId);
		// The name a member who left had is not kept: their chat is closed, and says so.
		const name = member?.displayName ?? t("Member");
		const presence = member ? memberPresence(state, this.userId) : null;
		const identity = JSON.stringify([name, presence]);
		if (identity !== this.#identityShown) {
			this.#identityShown = identity;
			replace(
				this.#identity,
				personFace(name, this.userId, presence?.online === true),
				h(
					"span",
					{ class: "member-identity-copy" },
					h("h1", null, name),
					presence ? h("small", null, presence.text) : null,
				),
			);
		}
		const gone = Boolean(state.team) && !member;
		const closed = gone || state.accessLost === true || state.memberChatsUnavailable === true;
		this.#drawStatus(thread, gone);
		this.#drawRows(thread, name);
		if (this.#composer.disabled !== closed) this.#composer.disabled = closed;
		this.#syncSend();
	}

	#syncSend(): void {
		this.#send.disabled = this.#composer.disabled || !this.#composer.value.trim();
	}

	#submit(): void {
		if (this.#composer.disabled) return;
		if (!this.#company.memberChats.send(this.userId, this.#composer.value)) return;
		this.#composer.value = "";
		this.#stick = true;
		this.#autosize();
		this.#syncSend();
		this.#composer.focus({ preventScroll: true });
	}

	#drawStatus(thread: MemberChatThread, gone: boolean): void {
		const lines = [
			gone ? t("This member is no longer in the company.") : undefined,
			thread.error,
			thread.notice,
		].filter((line): line is string => Boolean(line));
		const shown = JSON.stringify(lines);
		if (shown === this.#statusShown) return;
		this.#statusShown = shown;
		replace(this.#status, ...lines.map((line, index) => notice(index === 0 && gone ? "neutral" : "danger", line)));
	}

	#drawRows(thread: MemberChatThread, name: string): void {
		const me = this.#company.userId;
		if (!thread.loaded) {
			// The first read is on its way: grey shapes where the messages will stand. One that failed leaves the thread
			// empty; the line above the field says why.
			if (thread.error) {
				this.#rows = new Map();
				place(this.#log, []);
			} else if (!this.#rows.has("loading")) {
				const element = messagesSkeleton();
				this.#rows = new Map([["loading", { shown: "", element }]]);
				place(this.#log, [element]);
			}
			return;
		}
		const rows = new Map<string, Row>();
		const children: HTMLElement[] = [];
		const arriving: HTMLElement[] = [];
		const row = (key: string, shown: string, build: () => HTMLElement, arrives = false) => {
			const kept = this.#rows.get(key);
			const entry = kept?.shown === shown ? kept : { shown, element: build() };
			if (!kept && arrives && this.#settled) arriving.push(entry.element);
			// A message redrawn (sent, seen, taken back) keeps the keyboard if it had it.
			if (kept && entry !== kept && kept.element === document.activeElement) {
				entry.element.tabIndex = -1;
				queueMicrotask(() => entry.element.focus({ preventScroll: true }));
			}
			rows.set(key, entry);
			children.push(entry.element);
		};
		if (thread.hasMore) {
			this.#earlierButton.disabled = thread.loadingEarlier;
			children.push(this.#earlier);
		}
		const now = new Date();
		const clock = `${presentationLocale()} ${presentationTimeZone()} ${presentationDay(now)}`;
		let previous: Date | undefined;
		const time = (key: string, iso: string) => {
			const date = parseConversationTimestamp(iso);
			if (!date) return;
			if (needsConversationTimestamp(date, previous))
				row(`time:${key}`, `${iso} ${clock}`, () =>
					h(
						"time",
						{
							class: "conversation-timestamp",
							datetime: date.toISOString(),
							title: conversationTimestampTitle(date),
						},
						conversationTimestampLabel(date, now),
					),
				);
			previous = date;
		};
		const newest = thread.messages[thread.messages.length - 1];
		for (const message of thread.messages) {
			const mine = message.authorUserId === me;
			// "Seen" stands under this member's newest message, while nothing was written after it.
			const seen =
				mine &&
				message === newest &&
				!message.deleted &&
				!thread.outgoing.length &&
				thread.theirReadSeq >= message.seq;
			time(message.id, message.createdAt);
			row(
				`message:${message.id}`,
				JSON.stringify([message.text, message.deleted, mine, seen, mine ? "" : name]),
				() => this.#message(message, mine, mine ? t("You") : name, seen),
				!mine,
			);
		}
		for (const outgoing of thread.outgoing) {
			time(outgoing.clientMessageId, outgoing.createdAt);
			// Sent, and waiting for the chat's next read: the message itself, drawn as any other of this member's.
			const sent = outgoing.sent;
			row(
				`outgoing:${outgoing.clientMessageId}`,
				JSON.stringify([outgoing.text, outgoing.failed, sent?.id, sent?.deleted]),
				() => (sent ? this.#message(sent, true, t("You"), false) : this.#outgoing(outgoing)),
				true,
			);
		}
		if (!children.length)
			row("empty", name, () =>
				h(
					"div",
					{ class: "member-chat-empty" },
					personAvatar(name, this.userId),
					h("strong", null, name),
					h("p", null, t("Write the first message to {name}.", { name })),
				),
			);
		// Earlier messages come in above what is read: what is on screen stays where it is.
		const before = this.#messages.scrollHeight - this.#messages.scrollTop;
		const grewAbove =
			!this.#stick && thread.messages.length > 0 && !this.#rows.has(`message:${thread.messages[0]!.id}`);
		place(this.#log, children);
		this.#rows = rows;
		if (grewAbove) this.#messages.scrollTop = this.#messages.scrollHeight - before;
		for (const element of arriving) playOnce(element, "is-arriving");
		this.#settled = true;
		this.#pin();
		this.#refreshFade();
	}

	#message(message: MemberMessage, mine: boolean, author: string, seen: boolean): HTMLElement {
		const label = `${author} · ${fmtTime(message.createdAt)}`;
		return h(
			"article",
			{
				class: ["message", "from-member", mine && "mine", message.deleted && "message-erased"]
					.filter(Boolean)
					.join(" "),
				"aria-label": label,
				"data-message-id": message.id,
				"data-sent-at": message.createdAt,
			},
			h(
				"div",
				{ class: "bubble" },
				h("div", { class: "text" }, ...(message.deleted ? [t("Message deleted")] : linked(message.text ?? ""))),
			),
			seen ? h("div", { class: "message-caption" }, t("Seen")) : null,
		);
	}

	/** A message on its way (faded), or one that was not sent: why, and the two ways on. */
	#outgoing(outgoing: OutgoingMemberMessage): HTMLElement {
		const chats = this.#company.memberChats;
		return h(
			"article",
			{
				class: `message from-member mine ${outgoing.failed ? "pending-failed" : "pending-queued"}`,
				"aria-label": `${t("You")} · ${fmtTime(outgoing.createdAt)}`,
				"data-sent-at": outgoing.createdAt,
			},
			h("div", { class: "bubble" }, h("div", { class: "text" }, ...linked(outgoing.text))),
			outgoing.failed
				? h(
						"div",
						{ class: "message-caption member-chat-failed", role: "alert" },
						h("span", null, outgoing.failed),
						button(t("Try again"), () => chats.retry(this.userId, outgoing.clientMessageId), { small: true }),
						button(t("Delete"), () => chats.discard(this.userId, outgoing.clientMessageId), { small: true }),
					)
				: null,
		);
	}

	async #showEarlier(): Promise<void> {
		this.#stick = false;
		await this.#company.memberChats.loadEarlier(this.userId);
	}

	/** A message's own menu: taking back one of this member's own, and on a touch screen copying any. */
	#openMenu(event: MouseEvent): void {
		const target = event.target instanceof Element ? event.target : null;
		const element = target?.closest<HTMLElement>("article.message[data-message-id]") ?? null;
		const thread = this.#company.memberChats.thread(this.userId).get();
		// A message of the chat, or one this member sent that waits after them for the chat's next read.
		const message = element
			? (thread.messages.find((item) => item.id === element.dataset.messageId) ??
				thread.outgoing.find((item) => item.sent?.id === element.dataset.messageId)?.sent)
			: undefined;
		if (!target || !element || !message || message.deleted) return;
		const touch = (event as Partial<PointerEvent>).pointerType === "touch";
		const keyboard = !(event.clientX || event.clientY);
		// A link keeps the browser's own menu, and so does a selection made with a mouse.
		if (!keyboard && (target.closest("a[href]") || (!touch && !document.getSelection()?.isCollapsed))) return;
		const mine = message.authorUserId === this.#company.userId;
		const text = message.text ?? "";
		const copy = touch && navigator.clipboard && text.trim();
		if (!mine && !copy) return;
		event.preventDefault();
		const point = menuPoint(event, element);
		if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
		openContextMenu({
			label: t("Message"),
			x: point.x,
			y: point.y,
			items: [
				...(copy
					? [
							{
								label: t("Copy message"),
								icon: "copy",
								select: () => void navigator.clipboard.writeText(text).catch(() => {}),
							},
						]
					: []),
				...(mine
					? [
							{
								label: t("Delete message"),
								icon: "trash",
								danger: true,
								select: () => void this.#remove(message),
							},
						]
					: []),
			],
			opener: element,
			findOpener: () => this.#log.querySelector<HTMLElement>(`article.message[data-message-id="${message.id}"]`),
		});
	}

	async #remove(message: MemberMessage): Promise<void> {
		const yes = await confirmDialog(
			t("Delete this message? It is deleted for both of you."),
			t("Delete message"),
			true,
			undefined,
			this.#lifetime.signal,
		);
		if (yes && !this.#disposed) await this.#company.memberChats.remove(this.userId, message.id);
	}

	#pin(): void {
		if (this.#disposed || !this.#stick) return;
		const before = this.#messages.scrollTop;
		this.#messages.scrollTop = this.#messages.scrollHeight;
		const after = this.#messages.scrollTop;
		if (after !== before) this.#pinnedTop = after;
	}

	/** The field grows with its lines up to the stylesheet's tallest, as an agent's chat does. */
	#autosize(): void {
		if (this.#disposed) return;
		this.#shell.classList.remove("is-expanded");
		this.#composer.style.height = "auto";
		const field = getComputedStyle(this.#composer);
		const oneLine = Math.ceil(Number.parseFloat(field.minHeight) || 0);
		const tallest = Number.parseFloat(field.maxHeight) || Number.POSITIVE_INFINITY;
		this.#shell.classList.toggle("is-expanded", this.#composer.scrollHeight > oneLine);
		this.#composer.style.height = `${Math.min(this.#composer.scrollHeight, tallest)}px`;
		this.#composer.style.overflowY = this.#composer.scrollHeight > tallest ? "auto" : "hidden";
		const shell = getComputedStyle(this.#shell);
		const frame = [shell.paddingTop, shell.paddingBottom, shell.borderTopWidth, shell.borderBottomWidth].reduce(
			(sum, value) => sum + (Number.parseFloat(value) || 0),
			0,
		);
		this.#shell.style.height = `${this.#composer.getBoundingClientRect().height + frame}px`;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort();
		this.#sizes?.disconnect();
		window.clearInterval(this.#timer);
		if (this.#company.memberChats.open === this.userId) this.#company.memberChats.setOpen(undefined);
	}
}
