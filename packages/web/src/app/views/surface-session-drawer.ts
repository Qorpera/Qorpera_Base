import type {
	SurfaceChangeUnit,
	SurfaceExplorationSet,
	SurfaceImageRef,
	SurfaceSession,
	SurfaceSessionMessage,
	SurfaceSummary,
	SurfaceWorkspace,
} from "@qorpera/contracts";
import { menuPoint, openContextMenu, pressToOpenMenu } from "../../ui/context-menu.ts";
import { confirmDialog, fmtTime, h, icon, personAvatar, replace } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { leadingMentions, type MentionTarget, matchTargets, mentionQuery } from "../../ui/mentions.ts";
import { t } from "../../ui/preferences.ts";
import { ReceivedAttachments } from "../../ui/received-attachments.ts";
import { uiScale } from "../../ui/scale.ts";
import type { SurfaceLook } from "../surface-kinds.ts";
import {
	changeDeliverables,
	groupSessionChanges,
	isOpenChange,
	isOpenVariant,
	isRunningSession,
	openExplorations,
	optionGroupId,
	reportsOwnedBy,
	type SurfaceChangeDeliverable,
	type SurfaceDeliverableKind,
	type SurfaceNote,
	type SurfaceReportSummary,
	type SurfacesStore,
	type SurfaceTeammate,
	sessionHeld,
} from "../surfaces-store.ts";
import { SurfaceComposerImages } from "./surface-composer-images.ts";
import { CrewFigures } from "./surface-crew.ts";
import { decorateSurfaceFigures } from "./surface-figure-row.ts";
import { openPublishSheet } from "./surface-publish-sheet.ts";
import { isActionChange } from "./surface-rail.ts";

const DRAWER_WIDTH_KEY = "qorpera.web.surface-drawer-width.v1";
const DRAWER_DEFAULT = 296;
const DRAWER_MIN = 260;
const DRAWER_MAX = 560;
const DRAWER_MAX_SHARE = 0.56;
const STAGED_NOTE = "Staged change: ";
const STAGED_OPTION_NOTE = "Staged option: ";
const DISCARDED_CHANGE_NOTE = "Discarded change: ";
const DISCARDED_OPTION_NOTE = "Discarded option: ";
const DISCARDED_OPTIONS_NOTE = "Discarded options: ";
const SELECTED_OPTION_NOTE = "Selected option: ";
const RESTORED_CHANGE_NOTE = "Restored change: ";
export const APPROVE_ARM_MS = 4_500;
const MARKDOWN_CACHE_MAX = 128;
// WHY: Reuse parsed markdown DOM trees across streaming ticks so unchanged turns never re-parse markdown.
const parsedMarkdownCache = new Map<string, HTMLElement>();

function cachedMarkdown(text: string): HTMLElement {
	const cached = parsedMarkdownCache.get(text);
	if (cached) {
		parsedMarkdownCache.delete(text);
		parsedMarkdownCache.set(text, cached);
		return cached.cloneNode(true) as HTMLElement;
	}
	const rendered = markdown(text, { surfaceRow: true });
	parsedMarkdownCache.set(text, rendered);
	while (parsedMarkdownCache.size > MARKDOWN_CACHE_MAX) {
		const oldest = parsedMarkdownCache.keys().next().value;
		if (oldest === undefined) break;
		parsedMarkdownCache.delete(oldest);
	}
	return rendered.cloneNode(true) as HTMLElement;
}

interface QuotedChangeRef {
	readonly sessionId: string;
	readonly changeId: string | undefined;
	readonly title: string;
}

function splitChangeReply(text: string): { readonly title: string; readonly body: string } | undefined {
	const match = text.match(/^Re:\s*\[([^\]]+)\]\s*\n([\s\S]*)$/);
	if (!match) return undefined;
	return { title: match[1]!.trim(), body: match[2]!.trim() };
}

function recipientOf(change: SurfaceChangeUnit): string | null {
	const address = change.affectedPaths.find((path) => path.startsWith("mailto:"))?.slice("mailto:".length);
	if (!address) return null;
	const name = address.split("@")[0] ?? address;
	return name ? name.charAt(0).toLocaleUpperCase() + name.slice(1) : address;
}

function approveFace(text: string, shown: boolean, confirm: boolean, glyph?: string): HTMLElement {
	return h(
		"span",
		{
			class: ["surface-approve-face", confirm && "is-confirm", !shown && "is-ghost"].filter(Boolean).join(" "),
			...(shown ? {} : { "aria-hidden": "true", "data-text": text }),
		},
		glyph ? icon(glyph) : null,
		shown ? text : null,
	);
}

function approveName(rest: string, armed: boolean): string {
	return armed ? t("Confirm") : rest;
}

export function approveLabel(rest: string, armed: boolean, glyph?: string): HTMLElement {
	return h(
		"span",
		{ class: "surface-approve-label" },
		approveFace(rest, !armed, false, glyph),
		approveFace(t("Confirm"), armed, true),
	);
}

function overviewDiscardButton(sessionId: string, changeId: string, armed: boolean, busy: boolean): HTMLElement {
	return h(
		"button",
		{
			type: "button",
			class: `surface-overview-act is-quiet surface-discard-btn${armed ? " is-confirming" : ""}`,
			disabled: busy,
			"data-act": "discard-change-armed",
			"data-session": sessionId,
			"data-change": changeId,
			...(armed ? { "data-armed": "true" } : {}),
		},
		approveLabel(t("Discard"), armed),
	);
}

function actionCard(
	change: SurfaceChangeUnit,
	look: SurfaceLook,
	single: boolean,
	busy: boolean,
	running: boolean,
	armed: boolean,
): HTMLElement {
	const inbox = look.kind === "inbox";
	const open = isOpenChange(change);
	const recipient = inbox ? recipientOf(change) : null;
	const done = change.status === "merged";
	return h(
		"article",
		{
			class: ["surface-action-card", inbox && "is-email", done && "is-done"].filter(Boolean).join(" "),
			"data-change": change.id,
		},
		h(
			"div",
			{ class: "surface-action-head" },
			h("span", { class: "surface-action-kind" }, inbox ? t("Email draft") : t("Ready for your approval")),
			done
				? h("span", { class: "surface-tag is-merged" }, icon("check"), inbox ? t("Sent") : t("Done"))
				: change.status === "discarded"
					? h("span", { class: "surface-tag" }, t("Discarded"))
					: null,
		),
		inbox
			? h(
					"dl",
					{ class: "surface-email-meta" },
					recipient ? [h("dt", null, t("To")), h("dd", null, recipient)] : null,
					h("dt", null, t("Subject")),
					h("dd", null, change.title),
				)
			: h("strong", { class: "surface-action-title" }, change.title),
		change.summary ? h("p", { class: "surface-action-body" }, change.summary) : null,
		open && !running
			? h(
					"div",
					{ class: "surface-action-buttons" },
					h(
						"button",
						{
							type: "button",
							class: `btn btn-small surface-approve-btn${armed ? " is-confirming" : ""}`,
							"data-act": "approve",
							"data-change": change.id,
							...(armed ? { "data-armed": "true" } : {}),
							disabled: busy,
						},
						approveLabel(inbox ? t("Send") : t("Approve"), armed, inbox ? "send" : undefined),
					),
					single
						? h("button", { type: "button", class: "btn btn-small", "data-act": "discard" }, t("Discard"))
						: null,
				)
			: null,
	);
}

function firstName(name: string): string {
	return name.split(/\s+/)[0] || name;
}

function memberBubble(
	text: string,
	extraClass = "",
	title?: string,
	author?: SurfaceTeammate,
	images?: HTMLElement | null,
	to?: readonly SurfaceTeammate[],
): HTMLElement {
	const reply = splitChangeReply(text);
	const noteLabel = to ? t("Note to {names}", { names: to.map((who) => firstName(who.name)).join(", ") }) : "";
	const className = ["surface-message", "is-member", to && "is-note", extraClass].filter(Boolean).join(" ");
	const hint = [noteLabel, title].filter(Boolean).join(" · ");
	const bubble = reply
		? h(
				"div",
				{ class: className, ...(hint ? { title: hint } : {}) },
				h("span", { class: "surface-message-ref" }, icon("link"), h("span", null, reply.title)),
				h("span", { class: "surface-message-text" }, reply.body),
			)
		: to
			? h(
					"p",
					{ class: className, title: hint },
					h("span", { class: "surface-message-text" }, text),
					h(
						"span",
						{ class: "surface-note-to" },
						...to.map((who) => personAvatar(who.name, who.userId)),
						h("span", { class: "visually-hidden" }, noteLabel),
					),
				)
			: h("p", { class: className, ...(hint ? { title: hint } : {}) }, text);
	if (!author && !images) return bubble;
	const face = author ? personAvatar(author.name, author.userId) : null;
	face?.classList.add("surface-message-face");
	return h(
		"div",
		{ class: `surface-message-group is-member${face ? " has-face" : ""}` },
		author ? h("span", { class: "surface-message-author" }, author.name) : null,
		images ?? null,
		bubble,
		face,
	);
}

function formatSystemMessage(text: string): { readonly text: string; readonly positive: boolean } {
	if (text.startsWith(DISCARDED_CHANGE_NOTE)) {
		return { text: t("Discarded “{title}”", { title: text.slice(DISCARDED_CHANGE_NOTE.length) }), positive: false };
	}
	if (text.startsWith(DISCARDED_OPTION_NOTE)) {
		return {
			text: t("Discarded option “{title}”", { title: text.slice(DISCARDED_OPTION_NOTE.length) }),
			positive: false,
		};
	}
	if (text.startsWith(DISCARDED_OPTIONS_NOTE)) {
		return {
			text: t("Discarded options: {titles}", { titles: text.slice(DISCARDED_OPTIONS_NOTE.length) }),
			positive: false,
		};
	}
	if (text.startsWith(SELECTED_OPTION_NOTE)) {
		return {
			text: t("Selected option: {title}", { title: text.slice(SELECTED_OPTION_NOTE.length) }),
			positive: true,
		};
	}
	if (text.startsWith(RESTORED_CHANGE_NOTE)) {
		return { text: t("Restored “{title}”", { title: text.slice(RESTORED_CHANGE_NOTE.length) }), positive: true };
	}
	const negative = /^(?:Discarded\b|Kasserede\b|Merge conflicted\b|Merge failed\b|Undo failed\b)/i.test(text);
	return { text, positive: !negative };
}

function messageRow(
	message: SurfaceSessionMessage,
	author?: SurfaceTeammate,
	images?: HTMLElement | null,
	to?: readonly SurfaceTeammate[],
): HTMLElement {
	if (message.authorKind === "system") {
		const formatted = formatSystemMessage(message.text);
		return h(
			"div",
			{ class: "surface-message-group is-system" },
			h("time", { class: "surface-message-time", datetime: message.createdAt }, fmtTime(message.createdAt)),
			h(
				"div",
				{
					class: "surface-message is-system",
					...(message.changeId ? { "data-change-id": message.changeId } : {}),
				},
				message.changeId && formatted.positive
					? h("span", { class: "surface-system-mark", "aria-hidden": "true" }, icon("check"))
					: h("span", { class: "surface-system-dot", "aria-hidden": "true" }),
				h("span", { class: "surface-system-text" }, formatted.text),
			),
		);
	}
	if (message.authorKind === "session")
		return h(
			"div",
			{ class: "surface-message is-session", title: fmtTime(message.createdAt) },
			cachedMarkdown(message.text),
		);
	if (message.authorKind === "agent") {
		const label = message.authorLabel?.trim() || "Co-Founder";
		return h(
			"div",
			{ class: "surface-message-group is-agent" },
			h("span", { class: "surface-message-author" }, label),
			h("p", { class: "surface-message is-member is-agent", title: fmtTime(message.createdAt) }, message.text),
		);
	}
	return memberBubble(message.text, "", fmtTime(message.createdAt), author, images, to);
}

function changeTag(change: SurfaceChangeUnit): HTMLElement | null {
	if (change.status === "merged") return h("span", { class: "surface-tag is-merged" }, icon("check"), t("Merged"));
	if (change.status === "discarded") return h("span", { class: "surface-tag" }, t("Discarded"));
	if (change.status === "reverted") return h("span", { class: "surface-tag" }, t("Reverted"));
	if (change.status === "merging") return h("span", { class: "surface-tag" }, t("Merging"));
	return null;
}

function isActionSession(session: SurfaceSession, surface: SurfaceSummary): boolean {
	const listed = session.changes.filter((change) => change.status !== "discarded");
	return (
		surface.archetype === "ops" || (listed.length > 0 && listed.every((change) => isActionChange(change, surface)))
	);
}

function agentStatusLine(session: SurfaceSession): string | null {
	if (session.state === "needs_input") return t("Paused");
	if (session.state === "failed") return t("Failed");
	if (isRunningSession(session)) return t("Working");
	return null;
}

function failedSessionDetail(session: SurfaceSession): string {
	const detail = [...session.messages]
		.reverse()
		.find((message) => (message.authorKind === "system" || message.authorKind === "session") && message.text.trim())
		?.text.trim();
	return detail || t("This session failed. Retry to try again.");
}

function rankSessions(sessions: readonly SurfaceSession[]): SurfaceSession[] {
	const score = (session: SurfaceSession): number =>
		session.state === "needs_input"
			? 0
			: session.state === "failed"
				? 1
				: isRunningSession(session)
					? 2
					: session.changes.some(isOpenChange)
						? 3
						: 4;
	return [...sessions].sort((a, b) => score(a) - score(b));
}

function drawerCap(): number {
	const scale = uiScale();
	return Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, Math.floor((window.innerWidth * DRAWER_MAX_SHARE) / scale)));
}

function deliverableKindLabel(kind: SurfaceDeliverableKind): string {
	if (kind === "html") return t("HTML");
	if (kind === "pdf") return t("PDF");
	return t("Article");
}

function sameDeps(prev: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
	if (!prev || prev.length !== next.length) return false;
	for (let i = 0; i < next.length; i++) {
		if (!Object.is(prev[i], next[i])) return false;
	}
	return true;
}

export class SurfaceSessionDrawer {
	readonly el = h("aside", { class: "surface-drawer", "aria-hidden": "true" });
	readonly #resizer = h("div", {
		class: "surface-drawer-resizer",
		role: "separator",
		tabindex: "0",
		"aria-label": t("Resize preview panel"),
		"aria-orientation": "vertical",
		"aria-valuemin": String(DRAWER_MIN),
	});
	readonly #head = h("div", { class: "surface-drawer-head" });
	readonly #pinned = h("div", { class: "surface-drawer-pinned", hidden: true });
	readonly #body = h("div", { class: "surface-drawer-body" });
	readonly #replyTitle = h("span", { class: "surface-drawer-reply-title" });
	readonly #replyStrip = h(
		"div",
		{ class: "surface-drawer-reply", hidden: true },
		h(
			"div",
			{ class: "surface-drawer-reply-copy" },
			h("span", { class: "surface-drawer-reply-label" }, icon("link"), h("span", null, t("Change"))),
			this.#replyTitle,
		),
		h(
			"button",
			{
				type: "button",
				class: "icon-button surface-drawer-reply-clear",
				"aria-label": t("Remove change reference"),
				"data-act": "clear-change-quote",
			},
			icon("close"),
		),
	);
	readonly #input = h("input", { class: "surface-drawer-input", autocomplete: "off" });
	readonly #send = h("button", { type: "submit", class: "surface-send is-ready" }, icon("send"));
	readonly #compose = h("div", { class: "surface-drawer-compose" }, this.#input, this.#send);
	readonly #picker = h("div", {
		class: "mention-picker",
		role: "listbox",
		id: "surface-mention-picker",
		hidden: true,
		"aria-label": t("Teammates to write to"),
	});
	readonly #form = h("form", { class: "surface-drawer-foot" }, this.#picker, this.#replyStrip, this.#compose);
	readonly #images: SurfaceComposerImages;
	readonly #sentImages = new Map<string, ReceivedAttachments>();
	readonly #localImageUrls = new Map<File, string>();
	readonly #store: SurfacesStore;
	readonly #crew = new CrewFigures();
	#preferredWidth: number | undefined;
	#width = DRAWER_DEFAULT;
	#dragging = false;
	#dragged = false;
	#surfaceId = "";
	#shown: readonly unknown[] | undefined;
	#focusedHeadDeps: readonly unknown[] | undefined;
	#focusedPinnedDeps: readonly unknown[] | undefined;
	#bodyMode: "none" | "overview" | "thread" = "none";
	readonly #renderedThread = new Map<string, { readonly key: string; readonly el: HTMLElement }>();
	#sessionId = "";
	#messages = 0;
	#quotedChange: QuotedChangeRef | undefined;
	#armedApprove: string | undefined;
	#unfolded: string | undefined;
	#openChange: string | undefined;
	#approvable: readonly { readonly sessionId: string; readonly changeIds: readonly string[] }[] = [];
	#armTimer: ReturnType<typeof setTimeout> | undefined;
	#mention: { options: MentionTarget[]; active: number } | undefined;
	readonly #signal: AbortSignal;

	constructor(store: SurfacesStore, signal: AbortSignal) {
		this.#store = store;
		this.#signal = signal;
		try {
			const stored = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
			if (Number.isFinite(stored) && stored >= DRAWER_MIN) this.#preferredWidth = stored;
		} catch {
			/* WHY: Local browser storage is optional in private/sandboxed contexts. */
		}
		this.#images = new SurfaceComposerImages(this.#form, signal, () => {
			this.#send.classList.toggle("is-ready", !this.#images.problem);
			this.#syncNoteMode();
		});
		this.#compose.insertBefore(this.#images.button, this.#input);
		this.#form.insertBefore(this.#images.tray.el, this.#compose);
		this.#form.append(this.#images.tray.status);
		this.#images.setAvailable(store.canAttachImages);
		signal.addEventListener(
			"abort",
			() => {
				for (const view of this.#sentImages.values()) view.dispose();
				this.#sentImages.clear();
				for (const url of this.#localImageUrls.values()) URL.revokeObjectURL(url);
				this.#localImageUrls.clear();
			},
			{ once: true },
		);
		this.el.append(
			this.#resizer,
			h("div", { class: "surface-drawer-inner" }, this.#head, this.#pinned, this.#body, this.#form),
		);
		this.#wireResizer(signal);
		this.#applyWidth();
		signal.addEventListener("abort", () => this.#disarm(false), { once: true });
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (!this.#armedApprove) return;
				const target = event.target instanceof Element ? event.target.closest("[data-armed='true']") : null;
				if (!target) this.#disarm(true);
			},
			{ signal },
		);
		window.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Escape" && this.#armedApprove) this.#disarm(true);
			},
			{ signal },
		);
		this.#form.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				const sessionId = store.state.drawer?.sessionId;
				const text = this.#input.value.trim();
				if (!sessionId || !text) return;
				const quoted = this.#quotedChange?.sessionId === sessionId ? this.#quotedChange : undefined;
				const to = this.#noteTo(quoted);
				if (to.length) {
					this.#input.value = "";
					this.#syncNoteMode();
					void store
						.noteTo(
							sessionId,
							text,
							to.map((target) => target.id),
						)
						.then((ok) => {
							if (!ok && !this.#input.value) {
								this.#input.value = text;
								this.#syncNoteMode();
							}
						});
					return;
				}
				if (this.#images.problem) return;
				const payload = quoted ? `Re: [${quoted.title}]\n${text}` : text;
				const files = this.#images.files;
				const targetChangeId = quoted?.changeId;
				this.#input.value = "";
				this.#images.set([]);
				this.#setQuotedChange(undefined);
				void store.reply(sessionId, payload, files, targetChangeId).then((ok) => {
					if (!ok && !this.#input.value) {
						this.#input.value = text;
						if (quoted) this.#setQuotedChange(quoted);
					}
					if (!ok && files.length && !this.#images.files.length) this.#images.set(files);
				});
			},
			{ signal },
		);
		this.#input.addEventListener(
			"input",
			() => {
				this.#syncNoteMode();
				this.#updateMention();
			},
			{ signal },
		);
		this.#input.addEventListener("click", () => this.#updateMention(), { signal });
		this.#input.addEventListener("blur", () => this.#closeMention(), { signal });
		this.#input.addEventListener(
			"keydown",
			(event) => {
				if (this.#mentionKey(event)) return;
				if (event.key === "Escape" && this.#quotedChange) {
					event.preventDefault();
					this.#setQuotedChange(undefined);
				}
			},
			{ signal },
		);
		this.el.addEventListener("click", (event) => this.#click(event), { signal });
		this.el.addEventListener("contextmenu", (event) => this.#cardMenu(event), { signal });
		pressToOpenMenu(this.el, signal, (event) => this.#cardMenu(event));
	}

	#cardMenu(event: MouseEvent): void {
		if (event.shiftKey && (event.clientX || event.clientY)) return;
		const card = (event.target as Element | null)?.closest<HTMLElement>(".surface-overview-card.is-agent");
		const sessionId = card?.dataset.session;
		const session = sessionId ? this.#store.session(sessionId) : undefined;
		if (!card || !session) return;
		event.preventDefault();
		openContextMenu({
			label: session.title,
			...menuPoint(event, card),
			opener: card,
			findOpener: () =>
				[...this.el.querySelectorAll<HTMLElement>(".surface-overview-card.is-agent")].find(
					(item) => item.dataset.session === session.id,
				) ?? null,
			items: [
				{ label: t("Copy ID"), icon: "copy", select: () => void this.#copyId(session.id) },
				{ kind: "separator" },
				{ label: t("Remove"), icon: "trash", danger: true, select: () => void this.#remove(session.id) },
			],
		});
	}

	async #copyId(id: string): Promise<void> {
		try {
			if (!navigator.clipboard) throw new Error("No clipboard");
			await navigator.clipboard.writeText(id);
		} catch {
			if (!this.#signal.aborted) this.#store.store.set({ error: t("The ID could not be copied.") });
		}
	}

	async #remove(sessionId: string): Promise<void> {
		const session = this.#store.session(sessionId);
		if (!session) return;
		const running = isRunningSession(session);
		const open = session.changes.some(isOpenChange);
		if (running || open) {
			const question = running
				? t("Remove {title}? The agent stops and its unapproved changes are dropped.", { title: session.title })
				: t("Remove {title}? Its unapproved changes are dropped.", { title: session.title });
			if (!(await confirmDialog(question, t("Remove"), true, undefined, this.#signal))) return;
		}
		await this.#store.discardSession(sessionId);
	}

	#teammates(): MentionTarget[] {
		return this.#store.teammates().map((member) => ({ kind: "member", id: member.userId, name: member.name }));
	}

	#noteTo(quoted: QuotedChangeRef | undefined): MentionTarget[] {
		return quoted || this.#images.files.length ? [] : leadingMentions(this.#input.value, this.#teammates());
	}

	#syncNoteMode(): void {
		const sessionId = this.#store.state.drawer?.sessionId;
		const note =
			this.#noteTo(this.#quotedChange?.sessionId === sessionId ? this.#quotedChange : undefined).length > 0;
		this.#form.classList.toggle("is-note", note);
		this.#images.button.hidden = note || !this.#store.canAttachImages;
	}

	#updateMention(): void {
		const input = this.#input;
		const caret = input.selectionStart ?? input.value.length;
		const targets = input.selectionStart === input.selectionEnd ? this.#teammates() : [];
		const query = targets.length ? mentionQuery(input.value, caret) : undefined;
		const options = query ? matchTargets(query.query, targets) : [];
		if (!query || !options.length) {
			this.#closeMention();
			return;
		}
		const chosen = this.#mention?.options[this.#mention.active]?.id;
		this.#mention = {
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
		const optionId = (index: number) => `${this.#picker.id}-${index}`;
		replace(
			this.#picker,
			...mention.options.map((option, index) =>
				h(
					"div",
					{
						class: "mention-option",
						role: "option",
						id: optionId(index),
						"aria-selected": String(index === mention.active),
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
					personAvatar(option.name, option.id),
					h("span", { class: "mention-name" }, option.name),
					h("small", null, t("Member")),
				),
			),
		);
		this.#picker.hidden = false;
		this.#input.setAttribute("aria-autocomplete", "list");
		this.#input.setAttribute("aria-controls", this.#picker.id);
		this.#input.setAttribute("aria-activedescendant", optionId(mention.active));
	}

	#closeMention(): void {
		if (!this.#mention && this.#picker.hidden) return;
		this.#mention = undefined;
		this.#picker.hidden = true;
		replace(this.#picker);
		for (const name of ["aria-activedescendant", "aria-controls", "aria-autocomplete"])
			this.#input.removeAttribute(name);
	}

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
		if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
			event.preventDefault();
			this.#chooseMention(mention.active);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.#closeMention();
			return true;
		}
		return false;
	}

	#chooseMention(index: number): void {
		const option = this.#mention?.options[index];
		const input = this.#input;
		const end = input.selectionStart ?? input.value.length;
		const query = option && input.selectionEnd === end ? mentionQuery(input.value, end) : undefined;
		if (!option || !query) {
			this.#closeMention();
			return;
		}
		const name = `@${option.name} `;
		input.value = input.value.slice(0, query.start) + name + input.value.slice(end);
		const caret = query.start + name.length;
		input.focus();
		input.setSelectionRange(caret, caret);
		this.#closeMention();
		this.#syncNoteMode();
	}

	#wireResizer(signal: AbortSignal): void {
		this.#resizer.addEventListener(
			"pointerdown",
			(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				this.#dragging = true;
				this.#dragged = false;
				this.#resizer.setPointerCapture?.(event.pointerId);
				this.el.classList.add("is-resizing");
				this.el.parentElement?.classList.add("is-resizing");
			},
			{ signal },
		);
		this.#resizer.addEventListener(
			"pointermove",
			(event) => {
				if (!this.#dragging) return;
				const right = this.el.getBoundingClientRect().right;
				const next = (right - event.clientX) / uiScale();
				this.#dragged = true;
				this.#setWidth(next, false);
			},
			{ signal },
		);
		const finish = () => {
			if (!this.#dragging) return;
			this.#dragging = false;
			this.el.classList.remove("is-resizing");
			this.el.parentElement?.classList.remove("is-resizing");
			if (this.#dragged) this.#persistWidth();
		};
		this.#resizer.addEventListener("pointerup", finish, { signal });
		this.#resizer.addEventListener("pointercancel", finish, { signal });
		this.#resizer.addEventListener("lostpointercapture", finish, { signal });
		this.#resizer.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					this.#setWidth(this.#width + 16, true);
				} else if (event.key === "ArrowRight") {
					event.preventDefault();
					this.#setWidth(this.#width - 16, true);
				}
			},
			{ signal },
		);
		window.addEventListener(
			"resize",
			() => {
				if (this.el.isConnected) this.#applyWidth();
			},
			{ signal },
		);
	}

	#setWidth(width: number, persist: boolean): void {
		const clamped = Math.round(Math.max(DRAWER_MIN, Math.min(drawerCap(), width)));
		if (clamped === this.#width && this.#preferredWidth === clamped) return;
		this.#preferredWidth = clamped;
		this.#applyWidth();
		if (persist) this.#persistWidth();
	}

	#persistWidth(): void {
		try {
			if (this.#preferredWidth === undefined) localStorage.removeItem(DRAWER_WIDTH_KEY);
			else localStorage.setItem(DRAWER_WIDTH_KEY, String(this.#preferredWidth));
		} catch {
			/* WHY: Local browser storage is optional in private/sandboxed contexts. */
		}
	}

	#applyWidth(): void {
		const max = drawerCap();
		const width = Math.max(DRAWER_MIN, Math.min(this.#preferredWidth ?? DRAWER_DEFAULT, max));
		this.#width = width;
		const scale = uiScale();
		this.el.style.setProperty("--drawer-width", `${Math.round(width * scale)}px`);
		this.#resizer.setAttribute("aria-valuemax", String(max));
		this.#resizer.setAttribute("aria-valuenow", String(width));
	}

	#setQuotedChange(ref: QuotedChangeRef | undefined): void {
		this.#quotedChange = ref;
		this.#syncNoteMode();
		if (!ref) {
			this.#replyStrip.hidden = true;
			this.#replyTitle.textContent = "";
			return;
		}
		this.#replyTitle.textContent = ref.title;
		this.#replyStrip.hidden = false;
	}

	#redraw(): void {
		this.#shown = undefined;
		this.#focusedHeadDeps = undefined;
		this.#focusedPinnedDeps = undefined;
		const current = this.#store.state.surfaces.find(
			(item) => item.id === (this.#store.state.drawer?.surfaceId ?? this.#surfaceId),
		);
		this.update(current);
	}

	#arm(key: string): void {
		if (this.#armTimer) clearTimeout(this.#armTimer);
		this.#armedApprove = key;
		this.#armTimer = setTimeout(() => this.#disarm(true), APPROVE_ARM_MS);
		this.#redraw();
	}

	#disarm(redraw: boolean): void {
		if (this.#armTimer) {
			clearTimeout(this.#armTimer);
			this.#armTimer = undefined;
		}
		if (!this.#armedApprove) return;
		this.#armedApprove = undefined;
		if (redraw) this.#redraw();
	}

	#confirmOrArm(key: string): boolean {
		if (this.#armedApprove === key) {
			this.#disarm(false);
			return true;
		}
		this.#arm(key);
		return false;
	}

	#isDeliverableOpen(look: SurfaceLook | undefined, changeId: string, slug: string): boolean {
		const state = this.#store.state;
		if (!this.#store.isChangeShown(changeId)) return false;
		if (look?.kind === "report") return state.mode !== "live" && state.activeReportSlug === slug;
		return (state.mode === "report" || state.mode === "preview") && state.activeReportSlug === slug;
	}

	#overviewDeliverablePill(
		look: SurfaceLook | undefined,
		change: SurfaceChangeUnit,
		item: SurfaceChangeDeliverable,
		showTitle: boolean,
	): HTMLElement {
		const open = this.#isDeliverableOpen(look, change.id, item.slug);
		const label = showTitle ? item.title : open ? t("Open") : deliverableKindLabel(item.kind);
		return h(
			"button",
			{
				type: "button",
				class: `surface-overview-deliverable${open ? " is-open" : ""}`,
				"aria-pressed": String(open),
				"aria-label": t("Open {title}", { title: item.title }),
				title: item.title,
				"data-act": "open-deliverable",
				"data-change": change.id,
				"data-report": item.slug,
				"data-path": item.path,
			},
			icon("file"),
			h("span", null, label),
		);
	}

	#focusedDeliverableButtons(
		look: SurfaceLook | undefined,
		change: SurfaceChangeUnit,
		deliverables: readonly SurfaceChangeDeliverable[],
	): HTMLElement | null {
		if (!deliverables.length) return null;
		return h(
			"div",
			{ class: "surface-drawer-change-deliverables" },
			...deliverables.map((item) => {
				const open = this.#isDeliverableOpen(look, change.id, item.slug);
				const meta = [deliverableKindLabel(item.kind), item.readingTime].filter(Boolean).join(" · ");
				return h(
					"button",
					{
						type: "button",
						class: `surface-drawer-deliverable${open ? " is-open" : ""}`,
						"aria-pressed": String(open),
						"data-act": "open-deliverable",
						"data-change": change.id,
						"data-report": item.slug,
						"data-path": item.path,
					},
					h("span", { class: "surface-agent-note-icon", "aria-hidden": "true" }, icon("file")),
					h("span", { class: "surface-agent-note-copy" }, h("small", null, meta), h("strong", null, item.title)),
					open
						? h("span", { class: "surface-agent-note-active" }, t("Open"))
						: h("span", { class: "surface-agent-note-go", "aria-hidden": "true" }, icon("chevron")),
				);
			}),
		);
	}

	#noteButtons(reports: readonly SurfaceReportSummary[]): HTMLElement[] {
		if (!reports.length) return [];
		const state = this.#store.state;
		return reports.map((report) => {
			const open =
				state.mode === "report" &&
				(!state.activeReportSlug || state.activeReportSlug === report.slug || reports.length === 1);
			const meta = [t("Notes"), report.readingTime].filter(Boolean).join(" · ");
			return h(
				"button",
				{
					type: "button",
					class: `surface-agent-note${open ? " is-open" : ""}`,
					"aria-pressed": String(open),
					"data-act": "open-report",
					"data-report": report.slug,
				},
				h("span", { class: "surface-agent-note-icon", "aria-hidden": "true" }, icon("file")),
				h("span", { class: "surface-agent-note-copy" }, h("small", null, meta), h("strong", null, report.title)),
				open
					? h("span", { class: "surface-agent-note-active" }, t("Open"))
					: h("span", { class: "surface-agent-note-go", "aria-hidden": "true" }, icon("chevron")),
			);
		});
	}

	update(surface?: SurfaceSummary): void {
		this.#draw(surface);
		decorateSurfaceFigures(this.el, this.#store);
	}

	#draw(surface?: SurfaceSummary): void {
		const store = this.#store;
		const state = store.state;
		const targetSurface =
			surface ?? (state.drawer ? state.surfaces.find((item) => item.id === state.drawer?.surfaceId) : undefined);
		this.#surfaceId = targetSurface?.id ?? "";
		const focusedExploration =
			state.drawer?.explorationId && (!targetSurface || state.drawer.surfaceId === targetSurface.id)
				? store
						.workspace(state.drawer.surfaceId)
						?.explorations.find((item) => item.id === state.drawer?.explorationId && item.status === "open")
				: undefined;
		const focusedSession =
			!focusedExploration && state.drawer && (!targetSurface || state.drawer.surfaceId === targetSurface.id)
				? store.session(state.drawer.sessionId)
				: undefined;
		const overviewOpen = Boolean(
			!focusedExploration && !focusedSession && targetSurface && store.isPreviewPanelOpen(targetSurface.id),
		);
		const open = Boolean(focusedExploration || focusedSession) || overviewOpen;
		this.el.classList.toggle("is-open", open);
		this.el.classList.toggle("is-overview", overviewOpen);
		this.el.setAttribute("aria-hidden", String(!open));
		this.el.inert = !open;
		if (!open) {
			this.#shown = undefined;
			this.#focusedHeadDeps = undefined;
			this.#focusedPinnedDeps = undefined;
			this.#bodyMode = "none";
			this.#renderedThread.clear();
			this.#sessionId = "";
			this.#messages = 0;
			this.#disarm(false);
			this.#setQuotedChange(undefined);
			return;
		}
		if (focusedExploration) {
			if (this.#quotedChange && this.#quotedChange.sessionId !== state.drawer?.sessionId)
				this.#setQuotedChange(undefined);
			this.#form.hidden = false;
			this.#renderFocusedExploration(focusedExploration, targetSurface);
			return;
		}
		if (focusedSession) {
			if (this.#quotedChange && this.#quotedChange.sessionId !== focusedSession.id) this.#setQuotedChange(undefined);
			this.#form.hidden = false;
			this.#renderFocused(focusedSession, targetSurface);
			return;
		}
		if (targetSurface) {
			this.#setQuotedChange(undefined);
			this.#form.hidden = true;
			this.#renderOverview(targetSurface);
		}
	}

	#renderOverview(surface: SurfaceSummary): void {
		const store = this.#store;
		const state = store.state;
		const workspace = state.workspaces[surface.id];
		const look = store.lookOf(surface);
		const deps: readonly unknown[] = [
			"overview",
			surface,
			look.kind,
			look.accent,
			state.mode,
			state.activeReportSlug,
			state.hiddenChanges,
			state.optionPick,
			state.variantPick,
			state.busy,
			this.#armedApprove,
			state.localStudioBase[surface.id],
			state.cloudSurfaceFiles[surface.id],
			state.localStudioBinaries[surface.id],
			state.cloudSurfaceBinaries[surface.id],
			state.studioPatches,
			workspace,
		];
		if (sameDeps(this.#shown, deps)) return;
		this.#shown = deps;
		this.#focusedHeadDeps = undefined;
		this.#focusedPinnedDeps = undefined;
		this.#bodyMode = "overview";
		this.#renderedThread.clear();
		const explorations = openExplorations(workspace);
		const plainSessions = rankSessions(
			(workspace?.activeSessions ?? []).filter((session) => !isOpenVariant(session, workspace)),
		);
		this.#sessionId = "";
		this.#messages = 0;

		const approvable = plainSessions
			.filter((session) => !isRunningSession(session) && !isActionSession(session, surface))
			.map((session) => ({
				sessionId: session.id,
				changeIds: groupSessionChanges(session.changes.filter(isOpenChange))
					.filter(
						(entry): entry is { readonly kind: "change"; readonly change: SurfaceChangeUnit } =>
							entry.kind === "change",
					)
					.map((entry) => entry.change)
					.filter(
						(change) => change.status === "staged" && store.isChangeShown(change.id) && !this.#isApplying(change),
					)
					.map((change) => change.id),
			}))
			.filter((group) => group.changeIds.length > 0);
		const approvableCount = approvable.reduce((sum, group) => sum + group.changeIds.length, 0);
		const armedAll = this.#armedApprove === `approve-shown:${surface.id}`;
		this.#head.className = "surface-drawer-head is-overview";
		this.#head.replaceChildren(
			h("div", { class: "surface-drawer-title" }, h("h2", null, t("Changes"))),
			...(approvableCount > 0
				? [
						h(
							"button",
							{
								type: "button",
								class: `surface-overview-act surface-approve-btn surface-approve-all${armedAll ? " is-confirming" : ""}`,
								"aria-label": approveName(
									t("Approve all {count}", { count: approvableCount }),
									armedAll,
								),
								"data-act": "approve-shown",
								...(armedAll ? { "data-armed": "true" } : {}),
							},
							approveLabel(t("Approve all {count}", { count: approvableCount }), armedAll),
						),
					]
				: []),
		);
		this.#approvable = approvable;

		const parts: HTMLElement[] = [];
		if (workspace) {
			for (const exploration of explorations) {
				parts.push(this.#explorationCard(exploration, workspace, surface));
			}
		}
		for (const session of plainSessions) {
			const card = this.#agentCard(session, surface, look);
			if (card) parts.push(card);
		}
		if (parts.length === 0) {
			parts.push(
				h(
					"p",
					{ class: "surface-overview-empty" },
					t("No open changes yet. Describe a change below to start an agent."),
				),
			);
		}
		this.#crew.settle();
		this.#setPinned([]);
		this.#body.replaceChildren(...parts);
	}

	#explorationCard(
		exploration: SurfaceExplorationSet,
		workspace: SurfaceWorkspace,
		surface: SurfaceSummary,
	): HTMLElement {
		const store = this.#store;
		const state = store.state;
		const variants = exploration.variantSessionIds
			.map((id) => workspace.activeSessions.find((session) => session.id === id))
			.filter((session): session is SurfaceSession => Boolean(session));
		const pickedId = store.pickedVariant(exploration);
		const picked = variants.find((item) => item.id === pickedId) ?? variants[0];
		const busy = Boolean(state.busy[`exploration:${exploration.id}`]);
		const running = variants.some(isRunningSession);
		const ownedNotes = reportsOwnedBy(state, surface.id, { kind: "exploration", id: exploration.id });
		const noteNodes = this.#noteButtons(ownedNotes);
		return h(
			"section",
			{
				class: "surface-overview-card is-agent is-exploration",
				"data-act": "focus-exploration",
				"data-exploration": exploration.id,
			},
			h(
				"button",
				{
					type: "button",
					class: "surface-overview-agent-head",
					"data-act": "focus-exploration",
					"data-exploration": exploration.id,
					title: t("View responses"),
				},
				this.#crew.takeExploration(exploration, variants, 36),
				h(
					"span",
					{ class: "surface-overview-agent-copy" },
					h("strong", null, exploration.title),
					running ? h("span", null, t("Working")) : null,
				),
				h("span", { class: "surface-overview-agent-go", "aria-hidden": "true" }, icon("chevron")),
			),
			...noteNodes,
			h(
				"div",
				{ class: "surface-overview-options", role: "radiogroup", "aria-label": exploration.title },
				...variants.map((variant) => {
					const label = variant.explorationVariantLabel ?? variant.title;
					const checked = variant.id === picked?.id;
					const line = variant.changes.find(isOpenChange)?.summary.trim() ?? "";
					return h(
						"button",
						{
							type: "button",
							class: `surface-overview-option${checked ? " is-picked" : ""}`,
							role: "radio",
							"aria-checked": String(checked),
							"data-act": "pick-variant",
							"data-exploration": exploration.id,
							"data-session": variant.id,
						},
						h("span", { class: "surface-radio", "aria-hidden": "true" }),
						h(
							"span",
							{ class: "surface-overview-option-copy" },
							h("span", { class: "surface-overview-option-label" }, label),
							line ? h("span", { class: "surface-overview-option-line" }, line) : null,
						),
					);
				}),
			),
			picked
				? h(
						"div",
						{ class: "surface-overview-card-foot is-options" },
						h(
							"button",
							{
								type: "button",
								class: "surface-overview-act is-primary",
								disabled: busy,
								"data-act": "choose-variant",
								"data-exploration": exploration.id,
								"data-session": picked.id,
							},
							t("Use this one"),
						),
						h(
							"button",
							{
								type: "button",
								class: "surface-overview-act is-quiet",
								disabled: busy,
								"data-act": "instead-of",
								"data-exploration": exploration.id,
							},
							t("None of these"),
						),
					)
				: null,
		);
	}

	#isApplying(change: SurfaceChangeUnit): boolean {
		return change.status === "merging" || Boolean(this.#store.state.busy[`change:${change.id}`]);
	}

	#agentCard(session: SurfaceSession, surface: SurfaceSummary, look: SurfaceLook): HTMLElement | null {
		const store = this.#store;
		const state = store.state;
		const running = isRunningSession(session);
		const canDiscard = !running || session.state === "needs_input";
		const listed = session.changes.filter((change) => change.status !== "discarded");
		const allOpen = listed.filter(isOpenChange);
		const openChanges = allOpen.filter((change) => !this.#isApplying(change));
		const actionSession = isActionSession(session, surface);
		const failed = session.state === "failed";
		if (allOpen.length > 0 && openChanges.length === 0 && !running && !failed && !session.question) return null;
		const deliverablesByChange = new Map<string, readonly SurfaceChangeDeliverable[]>();
		const claimedPaths = new Set<string>();
		for (const change of openChanges) {
			const items = changeDeliverables(state, surface.id, change);
			if (items.length > 0) {
				deliverablesByChange.set(change.id, items);
				for (const item of items) claimedPaths.add(item.path);
			}
		}
		const ownedNotes = reportsOwnedBy(state, surface.id, { kind: "session", id: session.id }).filter(
			(note) => !claimedPaths.has(note.path),
		);
		const noteNodes = this.#noteButtons(ownedNotes);
		const statusLine = agentStatusLine(session);

		const head = h(
			"button",
			{
				type: "button",
				class: "surface-overview-agent-head",
				"data-act": "focus-session",
				"data-session": session.id,
				title: t("View responses"),
			},
			this.#crew.take(session, 36, "", this.#store.turnHolder(session)),
			h(
				"span",
				{ class: "surface-overview-agent-copy" },
				h("strong", null, session.title),
				statusLine ? h("span", null, statusLine) : null,
			),
			h("span", { class: "surface-overview-agent-go", "aria-hidden": "true" }, icon("chevron")),
		);

		const bodyItems: HTMLElement[] = [...noteNodes];
		if (failed) {
			bodyItems.push(
				h(
					"div",
					{ class: "surface-failed is-compact", role: "alert" },
					h("p", null, failedSessionDetail(session)),
					h(
						"button",
						{
							type: "button",
							class: "surface-overview-act is-danger",
							disabled: Boolean(state.busy[`reply:${session.id}`]),
							"data-act": "retry-session",
							"data-session": session.id,
						},
						t("Retry"),
					),
				),
			);
		}
		if (session.question) {
			bodyItems.push(
				h(
					"div",
					{ class: "surface-question is-compact" },
					h("div", { class: "surface-question-text" }, cachedMarkdown(session.question.text)),
					h(
						"div",
						{ class: "surface-question-options" },
						session.question.options.map((option) =>
							h(
								"button",
								{
									type: "button",
									class: "btn btn-small",
									"data-act": "answer",
									"data-session": session.id,
									"data-answer": option,
								},
								option,
							),
						),
					),
				),
			);
		}
		if (actionSession && openChanges.length > 0) {
			const inbox = look.kind === "inbox";
			bodyItems.push(
				h(
					"div",
					{ class: "surface-overview-changes" },
					...openChanges.map((change) => {
						const armed = this.#armedApprove === `approve:${session.id}:${change.id}`;
						const busyChange = Boolean(state.busy[`change:${change.id}`]);
						return h(
							"div",
							{ class: "surface-overview-change" },
							h(
								"div",
								{ class: "surface-overview-change-row" },
								h("span", { class: "surface-overview-change-title" }, change.title),
								canDiscard
									? overviewDiscardButton(
											session.id,
											change.id,
											this.#armedApprove === `discard:${session.id}:${change.id}`,
											busyChange,
										)
									: null,
								!running
									? h(
											"button",
											{
												type: "button",
												class: `surface-overview-act surface-approve-btn${armed ? " is-confirming" : ""}`,
												disabled: Boolean(state.busy[`change:${change.id}`]),
												"data-act": "approve",
												"data-session": session.id,
												"data-change": change.id,
												...(armed ? { "data-armed": "true" } : {}),
											},
											approveLabel(inbox ? t("Send") : t("Approve"), armed),
										)
									: null,
							),
						);
					}),
				),
			);
		} else if (!actionSession && openChanges.length > 0) {
			const entries = groupSessionChanges(openChanges);
			const grouped: HTMLElement[] = [];
			for (const entry of entries) {
				if (entry.kind === "option_group") {
					const { group } = entry;
					const pickedId = store.pickedOption(session, group.key);
					const busyGroup = Boolean(state.busy[`option-group:${optionGroupId(session.id, group.key)}`]);
					const discardArmed = this.#armedApprove === `discard-group:${session.id}:${group.key}`;
					const groupHeading =
						group.title && group.title.toLowerCase() !== session.title.trim().toLowerCase() ? group.title : null;
					grouped.push(
						h(
							"div",
							{ class: "surface-overview-option-group", "data-option-group": group.key },
							groupHeading ? h("div", { class: "surface-overview-option-group-title" }, groupHeading) : null,
							h(
								"div",
								{
									class: "surface-overview-options",
									role: "group",
									"aria-label": group.title ?? session.title,
								},
								...group.options.map((option) => {
									const checked = option.id === pickedId;
									const line = option.summary.trim();
									return h(
										"button",
										{
											type: "button",
											class: `surface-overview-option${checked ? " is-picked" : ""}`,
											"aria-pressed": String(checked),
											title: checked ? t("Click again to unselect") : t("Preview this option"),
											"data-act": "pick-option",
											"data-session": session.id,
											"data-option-group": group.key,
											"data-change": option.id,
										},
										h("span", { class: "surface-radio", "aria-hidden": "true" }),
										h(
											"span",
											{ class: "surface-overview-option-copy" },
											h("span", { class: "surface-overview-option-label" }, option.title),
											line ? h("span", { class: "surface-overview-option-line" }, line) : null,
										),
									);
								}),
							),
							h(
								"div",
								{ class: "surface-overview-card-foot is-options" },
								h(
									"button",
									{
										type: "button",
										class: "surface-overview-act is-primary",
										disabled: busyGroup || running || !pickedId,
										"data-act": "choose-option",
										"data-session": session.id,
										...(pickedId ? { "data-change": pickedId } : {}),
									},
									t("Use this one"),
								),
								canDiscard
									? h(
											"button",
											{
												type: "button",
												class: `surface-overview-act is-quiet${discardArmed ? " is-danger" : ""}`,
												disabled: busyGroup,
												"data-act": "discard-option-group-armed",
												"data-session": session.id,
												"data-option-group": group.key,
												...(discardArmed ? { "data-armed": "true" } : {}),
											},
											discardArmed ? t("Confirm") : t("Discard"),
										)
									: null,
							),
						),
					);
					continue;
				}
				const { change } = entry;
				const shown = store.isChangeShown(change.id);
				const armed = this.#armedApprove === `approve:${session.id}:${change.id}`;
				const deliverables = deliverablesByChange.get(change.id) ?? [];
				const busyChange = Boolean(state.busy[`change:${change.id}`]);
				grouped.push(
					h(
						"div",
						{ class: "surface-overview-change" },
						h(
							"div",
							{ class: "surface-overview-change-row" },
							h("button", {
								type: "button",
								class: "surface-switch",
								role: "switch",
								"aria-checked": String(shown),
								"aria-label": t("Show {title} in the preview", { title: change.title }),
								"data-act": "toggle",
								"data-change": change.id,
							}),
							h("span", { class: "surface-overview-change-title" }, change.title),
							canDiscard
								? overviewDiscardButton(
										session.id,
										change.id,
										this.#armedApprove === `discard:${session.id}:${change.id}`,
										busyChange,
									)
								: null,
							!running
								? h(
										"button",
										{
											type: "button",
											class: `surface-overview-act surface-approve-btn${armed ? " is-confirming" : ""}`,
											disabled: Boolean(state.busy[`change:${change.id}`]),
											"data-act": "approve",
											"data-session": session.id,
											"data-change": change.id,
											...(armed ? { "data-armed": "true" } : {}),
										},
										approveLabel(t("Approve"), armed),
									)
								: null,
						),
						deliverables.length > 0
							? h(
									"div",
									{ class: "surface-overview-change-deliverables" },
									...deliverables.map((item) =>
										this.#overviewDeliverablePill(look, change, item, deliverables.length > 1),
									),
								)
							: null,
					),
				);
			}
			bodyItems.push(h("div", { class: "surface-overview-changes" }, ...grouped));
		}

		return h(
			"section",
			{
				class: ["surface-overview-card", "is-agent", failed && "is-failed"].filter(Boolean).join(" "),
				"data-act": "focus-session",
				"data-session": session.id,
			},
			head,
			...bodyItems,
		);
	}

	#renderFocusedExploration(exploration: SurfaceExplorationSet, surface: SurfaceSummary | undefined): void {
		const store = this.#store;
		const state = store.state;
		const workspace = store.workspace(exploration.surfaceId);
		const variants = exploration.variantSessionIds
			.map((id) => workspace?.activeSessions.find((session) => session.id === id))
			.filter((session): session is SurfaceSession => Boolean(session));
		const pickedId = store.pickedVariant(exploration);
		const picked = variants.find((item) => item.id === pickedId) ?? variants[0];
		const notes = picked ? state.notes.filter((note) => note.sessionId === picked.id) : [];
		const resolvedSurface = surface ?? state.surfaces.find((item) => item.id === exploration.surfaceId);
		const ownedNotes = resolvedSurface
			? reportsOwnedBy(state, resolvedSurface.id, { kind: "exploration", id: exploration.id })
			: [];
		const busy = Boolean(state.busy[`exploration:${exploration.id}`]);
		const deps: readonly unknown[] = [
			"focused-exploration",
			exploration,
			workspace,
			picked?.id,
			state.notes,
			picked ? state.sessionImages[picked.id] : undefined,
			state.mode,
			state.activeReportSlug,
			state.busy,
			this.#armedApprove,
			ownedNotes,
		];
		if (picked && state.unseenNotes[picked.id]) store.seeNotes(picked.id);
		if (sameDeps(this.#shown, deps)) return;
		this.#shown = deps;
		this.#focusedHeadDeps = undefined;
		this.#focusedPinnedDeps = undefined;
		this.#input.placeholder = t("Steer this session…");
		this.#input.setAttribute("aria-label", t("Steer this session…"));
		this.#send.setAttribute("aria-label", t("Send"));

		this.#head.className = "surface-drawer-head";
		this.#head.replaceChildren(
			h(
				"button",
				{
					type: "button",
					class: "icon-button surface-drawer-back",
					"aria-label": t("All changes"),
					title: t("All changes"),
					"data-act": "back-overview",
				},
				icon("back"),
			),
			this.#crew.takeExploration(exploration, variants, 43, "is-large"),
			h("div", { class: "surface-drawer-title" }, h("h2", null, exploration.title)),
		);
		this.#crew.settle();

		const pinned: HTMLElement[] = [];
		if (resolvedSurface) pinned.push(...this.#noteButtons(ownedNotes));
		if (variants.length > 0)
			pinned.push(
				h(
					"div",
					{ class: "surface-drawer-changes is-options", role: "radiogroup", "aria-label": exploration.title },
					...variants.map((variant) => {
						const label = variant.explorationVariantLabel ?? variant.title;
						const checked = variant.id === picked?.id;
						const primaryChange = variant.changes[0];
						return h(
							"div",
							{ class: `surface-drawer-change is-option${checked ? " is-picked" : ""}` },
							h(
								"button",
								{
									type: "button",
									class: "surface-drawer-option-row",
									role: "radio",
									"aria-checked": String(checked),
									"data-act": "pick-variant",
									"data-exploration": exploration.id,
									"data-session": variant.id,
								},
								h("span", { class: "surface-radio", "aria-hidden": "true" }),
								h("span", { class: "surface-drawer-change-title" }, label),
							),
							checked
								? h(
										"div",
										{ class: "surface-drawer-change-acts" },
										h(
											"button",
											{
												type: "button",
												class: "surface-change-btn is-approve surface-approve-btn",
												disabled: busy,
												"data-act": "choose-variant",
												"data-exploration": exploration.id,
												"data-session": variant.id,
											},
											t("Use this one"),
										),
										h(
											"button",
											{
												type: "button",
												class: "surface-change-btn",
												"data-act": "quote-change",
												"data-session": variant.id,
												...(primaryChange ? { "data-change": primaryChange.id } : {}),
												"data-change-title": label,
											},
											t("Change"),
										),
										h(
											"button",
											{
												type: "button",
												class: "surface-change-btn is-muted",
												disabled: busy,
												"data-act": "discard-exploration",
												"data-exploration": exploration.id,
											},
											t("Discard"),
										),
									)
								: null,
						);
					}),
				),
			);
		this.#setPinned(pinned);
		if (picked) {
			this.#reconcileThread(picked, notes);
		} else {
			this.#bodyMode = "thread";
			this.#renderedThread.clear();
			this.#body.replaceChildren();
		}
		const activeId = picked?.id ?? exploration.id;
		const count = (picked ? picked.messages.length || (picked.prompt ? 1 : 0) : 0) + notes.length;
		if (activeId !== this.#sessionId || count !== this.#messages) {
			this.#sessionId = activeId;
			this.#messages = count;
			this.#body.scrollTop = this.#body.scrollHeight;
		}
	}

	#renderFocused(session: SurfaceSession, surface: SurfaceSummary | undefined): void {
		const store = this.#store;
		const state = store.state;
		const notes = state.notes.filter((note) => note.sessionId === session.id);
		const resolvedSurface = surface ?? state.surfaces.find((item) => item.id === session.surfaceId);
		const look = resolvedSurface ? store.lookOf(resolvedSurface) : undefined;
		const ownedNotes = resolvedSurface
			? reportsOwnedBy(state, resolvedSurface.id, { kind: "session", id: session.id })
			: [];
		const deps: readonly unknown[] = [
			"focused",
			session,
			resolvedSurface,
			state.notes,
			state.sessionImages[session.id],
			state.mode,
			state.activeReportSlug,
			state.hiddenChanges,
			state.optionPick,
			state.busy,
			state.studioPatches,
			resolvedSurface ? state.localStudioBase[resolvedSurface.id] : undefined,
			resolvedSurface ? state.cloudSurfaceFiles[resolvedSurface.id] : undefined,
			resolvedSurface ? state.localStudioBinaries[resolvedSurface.id] : undefined,
			resolvedSurface ? state.cloudSurfaceBinaries[resolvedSurface.id] : undefined,
			look?.kind,
			look?.accent,
			this.#armedApprove,
			this.#unfolded,
			this.#openChange,
			ownedNotes,
		];
		if (state.unseenNotes[session.id]) store.seeNotes(session.id);
		if (sameDeps(this.#shown, deps)) return;
		this.#shown = deps;
		this.#input.placeholder = t("Steer this session…");
		this.#input.setAttribute("aria-label", t("Steer this session…"));
		this.#send.setAttribute("aria-label", t("Send"));
		const turnHolder = store.turnHolder(session);
		const headDeps: readonly unknown[] = [
			session.id,
			session.title,
			session.state,
			session.workerId,
			session.changes.length,
			turnHolder?.userId,
			turnHolder?.name,
		];
		if (!sameDeps(this.#focusedHeadDeps, headDeps)) {
			this.#focusedHeadDeps = headDeps;
			this.#head.className = "surface-drawer-head";
			this.#head.replaceChildren(
				h(
					"button",
					{
						type: "button",
						class: "icon-button surface-drawer-back",
						"aria-label": t("All changes"),
						title: t("All changes"),
						"data-act": "back-overview",
					},
					icon("back"),
				),
				this.#crew.take(session, 43, "is-large", turnHolder),
				h("div", { class: "surface-drawer-title" }, h("h2", null, session.title)),
			);
			this.#crew.settle();
		}
		const pinnedDeps: readonly unknown[] = [
			session.id,
			session.state,
			session.changes,
			session.question,
			resolvedSurface,
			state.mode,
			state.activeReportSlug,
			state.hiddenChanges,
			state.optionPick,
			state.busy,
			state.studioPatches,
			resolvedSurface ? state.localStudioBase[resolvedSurface.id] : undefined,
			resolvedSurface ? state.cloudSurfaceFiles[resolvedSurface.id] : undefined,
			resolvedSurface ? state.localStudioBinaries[resolvedSurface.id] : undefined,
			resolvedSurface ? state.cloudSurfaceBinaries[resolvedSurface.id] : undefined,
			look?.kind,
			look?.accent,
			this.#armedApprove,
			this.#unfolded,
			this.#openChange,
			ownedNotes,
		];
		if (!sameDeps(this.#focusedPinnedDeps, pinnedDeps)) {
			this.#focusedPinnedDeps = pinnedDeps;
			this.#setPinned(this.#content(session, resolvedSurface, look, ownedNotes));
		}
		this.#reconcileThread(session, notes);
		const count = (session.messages.length || (session.prompt ? 1 : 0)) + notes.length;
		if (session.id !== this.#sessionId || count !== this.#messages) {
			this.#sessionId = session.id;
			this.#messages = count;
			this.#body.scrollTop = this.#body.scrollHeight;
		}
	}

	#content(
		session: SurfaceSession,
		surface: SurfaceSummary | undefined,
		look: SurfaceLook | undefined,
		ownedNotes: readonly SurfaceReportSummary[],
	): HTMLElement[] {
		const store = this.#store;
		const parts: HTMLElement[] = [];
		const listed = session.changes.filter((change) => change.status !== "discarded");
		const deliverablesByChange = new Map<string, readonly SurfaceChangeDeliverable[]>();
		const claimedPaths = new Set<string>();
		if (surface) {
			for (const change of listed) {
				const items = changeDeliverables(store.state, surface.id, change);
				if (items.length > 0) {
					deliverablesByChange.set(change.id, items);
					for (const item of items) claimedPaths.add(item.path);
				}
			}
		}
		const standaloneNotes = ownedNotes.filter((note) => !claimedPaths.has(note.path));
		const actionSession = Boolean(
			surface &&
				(surface.archetype === "ops" ||
					(listed.length > 0 && listed.every((change) => isActionChange(change, surface)))),
		);
		if (surface && standaloneNotes.length > 0) parts.push(...this.#noteButtons(standaloneNotes));
		if (isRunningSession(session) && session.state !== "needs_input")
			parts.push(
				h(
					"p",
					{ class: "surface-drawer-working" },
					actionSession
						? t("On it — you'll review everything here before anything goes out.")
						: t("Working — changes appear in Preview when they are ready."),
				),
			);
		if (sessionHeld(session))
			parts.push(
				h(
					"div",
					{ class: "surface-done" },
					h("span", { class: "surface-done-mark" }, icon("check")),
					h("strong", null, actionSession ? t("All done") : t("All changes merged")),
					h(
						"p",
						null,
						actionSession
							? t("Nothing else waits on you here.")
							: t("They are in Base. Publish when you're ready."),
					),
					h(
						"div",
						{ class: "surface-done-acts" },
						!actionSession && surface && surface.archetype !== "ops" && surface.unpublishedChangeCount > 0
							? h(
									"button",
									{ type: "button", class: "btn btn-primary btn-small", "data-act": "open-publish" },
									t("Review & publish"),
								)
							: null,
						h(
							"button",
							{
								type: "button",
								class: `btn btn-small${actionSession || !surface || surface.unpublishedChangeCount === 0 ? " btn-primary" : ""}`,
								"data-act": "close",
							},
							t("Close"),
						),
					),
				),
			);
		if (session.state === "failed")
			parts.push(
				h(
					"div",
					{ class: "surface-failed", role: "alert" },
					h("p", null, failedSessionDetail(session)),
					h(
						"button",
						{
							type: "button",
							class: "btn btn-small",
							disabled: Boolean(store.state.busy[`reply:${session.id}`]),
							"data-act": "retry-session",
							"data-session": session.id,
						},
						t("Retry"),
					),
				),
			);
		if (session.question)
			parts.push(
				h(
					"div",
					{ class: "surface-question" },
					h("div", { class: "surface-question-text" }, cachedMarkdown(session.question.text)),
					h(
						"div",
						{ class: "surface-question-options" },
						session.question.options.map((option) =>
							h(
								"button",
								{ type: "button", class: "btn btn-small", "data-act": "answer", "data-answer": option },
								option,
							),
						),
					),
				),
			);
		if (actionSession && look && listed.length && !sessionHeld(session)) {
			const openActions = listed.filter(isOpenChange);
			const armedAll = this.#armedApprove === `approve-all:${session.id}`;
			for (const change of listed)
				parts.push(
					actionCard(
						change,
						look,
						openActions.length <= 1,
						Boolean(store.state.busy[`change:${change.id}`]),
						isRunningSession(session),
						this.#armedApprove === `approve:${session.id}:${change.id}`,
					),
				);
			if (openActions.length > 1 && !isRunningSession(session))
				parts.push(
					h(
						"div",
						{ class: "surface-drawer-actions" },
						h(
							"button",
							{
								type: "button",
								class: `btn btn-small surface-approve-btn${armedAll ? " is-confirming" : ""}`,
								"aria-label": approveName(
									look.kind === "inbox"
										? t("Send all {count}", { count: openActions.length })
										: t("Approve all {count}", { count: openActions.length }),
									armedAll,
								),
								"data-act": "approve-all",
								...(armedAll ? { "data-armed": "true" } : {}),
							},
							approveLabel(
								look.kind === "inbox"
									? t("Send all {count}", { count: openActions.length })
									: t("Approve all {count}", { count: openActions.length }),
								armedAll,
							),
						),
						h("button", { type: "button", class: "btn btn-small", "data-act": "discard" }, t("Discard")),
					),
				);
		} else if (listed.length && !sessionHeld(session)) {
			const running = isRunningSession(session);
			const entries = groupSessionChanges(listed);
			const optionGroups = entries.flatMap((entry) => (entry.kind === "option_group" ? [entry.group] : []));
			const regularChanges = entries.flatMap((entry) => (entry.kind === "change" ? [entry.change] : []));
			const hasOpenOptionGroup = optionGroups.length > 0;
			for (const group of optionGroups) {
				const pickedId = store.pickedOption(session, group.key);
				const busyGroup = Boolean(store.state.busy[`option-group:${optionGroupId(session.id, group.key)}`]);
				const discardArmed = this.#armedApprove === `discard-group:${session.id}:${group.key}`;
				parts.push(
					h(
						"div",
						{
							class: "surface-drawer-changes is-options",
							role: "group",
							"aria-label": group.title ?? session.title,
							"data-option-group": group.key,
						},
						group.title ? h("div", { class: "surface-drawer-option-group-title" }, group.title) : null,
						...group.options.map((option) => {
							const checked = option.id === pickedId;
							const line = option.summary.trim();
							return h(
								"div",
								{
									class: `surface-drawer-change is-option${checked ? " is-picked" : ""}`,
									"data-change": option.id,
								},
								h(
									"button",
									{
										type: "button",
										class: "surface-drawer-option-row",
										"aria-pressed": String(checked),
										title: checked ? t("Click again to unselect") : t("Preview this option"),
										"data-act": "pick-option",
										"data-session": session.id,
										"data-option-group": group.key,
										"data-change": option.id,
									},
									h("span", { class: "surface-radio", "aria-hidden": "true" }),
									h(
										"span",
										{ class: "surface-overview-option-copy" },
										h("span", { class: "surface-drawer-change-title" }, option.title),
										line ? h("span", { class: "surface-overview-option-line" }, line) : null,
									),
								),
								checked && !running
									? h(
											"div",
											{ class: "surface-drawer-change-acts" },
											h(
												"button",
												{
													type: "button",
													class: "surface-change-btn is-approve surface-approve-btn",
													disabled: busyGroup,
													"data-act": "choose-option",
													"data-session": session.id,
													"data-change": option.id,
												},
												t("Use this one"),
											),
											h(
												"button",
												{
													type: "button",
													class: "surface-change-btn",
													"data-act": "quote-change",
													"data-session": session.id,
													"data-change": option.id,
													"data-change-title": option.title,
												},
												t("Change"),
											),
											h(
												"button",
												{
													type: "button",
													class: `surface-change-btn is-muted${discardArmed ? " is-danger" : ""}`,
													disabled: busyGroup,
													"data-act": "discard-option-group-armed",
													"data-session": session.id,
													"data-option-group": group.key,
													...(discardArmed ? { "data-armed": "true" } : {}),
												},
												discardArmed ? t("Confirm") : t("Discard"),
											),
										)
									: null,
							);
						}),
						!pickedId && !running
							? h(
									"div",
									{ class: "surface-drawer-change-acts surface-drawer-option-foot" },
									h(
										"button",
										{
											type: "button",
											class: `surface-change-btn is-muted${discardArmed ? " is-danger" : ""}`,
											disabled: busyGroup,
											"data-act": "discard-option-group-armed",
											"data-session": session.id,
											"data-option-group": group.key,
											...(discardArmed ? { "data-armed": "true" } : {}),
										},
										discardArmed ? t("Confirm") : t("Discard"),
									),
								)
							: null,
					),
				);
			}
			if (regularChanges.length > 0)
				parts.push(this.#changesBox(session, regularChanges, look, deliverablesByChange, hasOpenOptionGroup));
		}
		return parts;
	}

	#changesBox(
		session: SurfaceSession,
		listed: readonly SurfaceChangeUnit[],
		look: SurfaceLook | undefined,
		deliverablesByChange: ReadonlyMap<string, readonly SurfaceChangeDeliverable[]>,
		hasOpenOptionGroup: boolean,
	): HTMLElement {
		const running = isRunningSession(session);
		const unfolded = this.#unfolded === session.id;
		const open = listed.filter(isOpenChange).length;
		const armedAll = this.#armedApprove === `approve-all:${session.id}`;
		const label =
			open === 1
				? t("1 change ready")
				: open > 1
					? t("{count} changes ready", { count: open })
					: listed.length === 1
						? t("1 change")
						: t("{count} changes", { count: listed.length });
		const single = listed.length === 1;
		return h(
			"div",
			{ class: `surface-changes${unfolded ? " is-open" : ""}` },
			h(
				"div",
				{ class: "surface-changes-head" },
				h(
					"button",
					{
						type: "button",
						class: "surface-changes-toggle",
						"aria-expanded": String(unfolded),
						"data-act": "fold-changes",
					},
					label,
				),
				unfolded && !running && open > 1 && !hasOpenOptionGroup
					? h(
							"button",
							{
								type: "button",
								class: `surface-changes-approve surface-approve-btn${armedAll ? " is-confirming" : ""}`,
								"aria-label": approveName(t("Approve all"), armedAll),
								"data-act": "approve-all",
								...(armedAll ? { "data-armed": "true" } : {}),
							},
							approveLabel(t("Approve all"), armedAll),
						)
					: null,
				h(
					"button",
					{
						type: "button",
						class: "icon-button surface-changes-fold",
						"aria-label": unfolded ? t("Hide the changes") : t("Show the changes"),
						"aria-expanded": String(unfolded),
						"data-act": "fold-changes",
					},
					icon("chevron-down"),
				),
			),
			...(unfolded
				? listed.map((change) =>
						this.#changeRow(
							session,
							change,
							look,
							deliverablesByChange.get(change.id) ?? [],
							single || this.#openChange === change.id,
							single,
							running,
						),
					)
				: []),
		);
	}

	#changeRow(
		session: SurfaceSession,
		change: SurfaceChangeUnit,
		look: SurfaceLook | undefined,
		deliverables: readonly SurfaceChangeDeliverable[],
		expanded: boolean,
		single: boolean,
		running: boolean,
	): HTMLElement {
		const store = this.#store;
		const open = isOpenChange(change);
		const busyChange = Boolean(store.state.busy[`change:${change.id}`]);
		const armed = this.#armedApprove === `approve:${session.id}:${change.id}`;
		const summaryText = change.summary.trim();
		const showSummary = expanded && summaryText.length > 0 && summaryText !== change.title.trim();
		const title = h("span", { class: "surface-drawer-change-title" }, change.title);
		return h(
			"div",
			{
				class: `surface-drawer-change${open ? "" : " is-closed"}${expanded ? " is-expanded" : ""}`,
				"data-change": change.id,
			},
			h(
				"div",
				{ class: "surface-drawer-change-top" },
				open
					? h("button", {
							type: "button",
							class: "surface-switch",
							role: "switch",
							"aria-checked": String(store.isChangeShown(change.id)),
							"aria-label": t("Show {title} in the preview", { title: change.title }),
							"data-act": "toggle",
							"data-change": change.id,
						})
					: h("span", { class: "surface-change-mark" }, icon("check")),
				single
					? h("div", { class: "surface-drawer-change-row" }, title, open ? null : changeTag(change))
					: h(
							"button",
							{
								type: "button",
								class: "surface-drawer-change-row",
								"aria-expanded": String(expanded),
								"data-act": "open-change",
								"data-change": change.id,
							},
							title,
							open ? null : changeTag(change),
							h("span", { class: "surface-drawer-change-arrow", "aria-hidden": "true" }, icon("chevron-down")),
						),
			),
			showSummary ? h("p", { class: "surface-drawer-change-summary" }, summaryText) : null,
			expanded ? this.#focusedDeliverableButtons(look, change, deliverables) : null,
			expanded && open && !running
				? h(
						"div",
						{ class: "surface-drawer-change-acts" },
						h(
							"button",
							{
								type: "button",
								class: `surface-change-btn is-approve surface-approve-btn${armed ? " is-confirming" : ""}`,
								"data-act": "approve",
								"data-change": change.id,
								...(armed ? { "data-armed": "true" } : {}),
								disabled: busyChange,
							},
							approveLabel(t("Approve"), armed),
						),
						h(
							"button",
							{
								type: "button",
								class: "surface-change-btn is-quiet",
								"data-act": "quote-change",
								"data-session": session.id,
								"data-change": change.id,
								"data-change-title": change.title,
							},
							t("Change"),
						),
						h(
							"button",
							{
								type: "button",
								class: "surface-change-btn is-quiet is-muted",
								"data-act": "discard-change",
								"data-change": change.id,
								disabled: busyChange,
							},
							t("Discard"),
						),
					)
				: null,
		);
	}

	#setPinned(parts: readonly HTMLElement[]): void {
		this.#pinned.replaceChildren(...parts);
		this.#pinned.hidden = parts.length === 0;
	}

	// WHY: Reconcile thread turns in place by message id so streaming updates never tear down or re-parse unchanged turns.
	#reconcileThread(session: SurfaceSession, notes: readonly SurfaceNote[]): void {
		if (this.#bodyMode !== "thread") {
			this.#bodyMode = "thread";
			this.#renderedThread.clear();
		}
		const store = this.#store;
		store.ensureSessionImages(session);
		const sent = store.state.sessionImages[session.id]?.messages ?? [];
		const keepImages = new Set<string>();
		const activeIds = new Set<string>();
		const parts: HTMLElement[] = [];
		const take = (id: string, key: string, build: () => HTMLElement): HTMLElement => {
			activeIds.add(id);
			const existing = this.#renderedThread.get(id);
			if (existing && existing.key === key) return existing.el;
			const el = build();
			this.#renderedThread.set(id, { key, el });
			return el;
		};
		if (session.messages.length > 0) {
			for (const message of session.messages) {
				if (
					message.authorKind === "system" &&
					message.changeId &&
					(message.text.startsWith(STAGED_NOTE) || message.text.startsWith(STAGED_OPTION_NOTE))
				)
					continue;
				const attached =
					message.authorKind === "member" ? sent.find((item) => item.messageId === message.id) : undefined;
				let imgKey = "";
				let images: HTMLElement | undefined;
				if (attached?.images.length) {
					const key = `${session.id}:${attached.clientInputId}`;
					keepImages.add(key);
					imgKey = `${key}:${attached.images.length}`;
					images = this.#sentImageView(key, session.id, attached).el;
				}
				const author = this.#person(message.authorUserId);
				const to =
					message.authorKind === "note"
						? (message.noteTo ?? []).flatMap((userId) => this.#person(userId) ?? [])
						: undefined;
				const id = `msg:${session.id}:${message.id}`;
				const contentKey = JSON.stringify([
					message.authorKind,
					message.authorLabel ?? "",
					message.text,
					message.createdAt,
					message.changeId ?? "",
					author?.userId ?? "",
					author?.name ?? "",
					imgKey,
					to?.map((who) => `${who.userId}:${who.name}`) ?? null,
				]);
				parts.push(take(id, contentKey, () => messageRow(message, author, images, to)));
			}
		} else if (session.prompt) {
			const creator = this.#person(session.createdByUserId);
			parts.push(
				take(
					`prompt:${session.id}`,
					JSON.stringify([session.prompt, creator?.userId ?? "", creator?.name ?? ""]),
					() => memberBubble(session.prompt, "", undefined, creator),
				),
			);
		}
		for (const [key, view] of this.#sentImages)
			if (!keepImages.has(key)) {
				view.dispose();
				this.#sentImages.delete(key);
			}
		const sending = new Set<File>();
		for (const note of notes) {
			for (const file of note.files ?? []) sending.add(file);
			const to = note.to?.flatMap((userId) => this.#person(userId) ?? []);
			const fileKey = (note.files ?? []).map((file) => `${file.name}:${file.size}:${file.lastModified}`);
			parts.push(
				take(
					`note:${note.id}`,
					JSON.stringify([note.text, to?.map((who) => `${who.userId}:${who.name}`) ?? null, fileKey]),
					() => memberBubble(note.text, "is-pending", undefined, undefined, this.#localImages(note.files), to),
				),
			);
		}
		for (const [file, url] of this.#localImageUrls)
			if (!sending.has(file)) {
				URL.revokeObjectURL(url);
				this.#localImageUrls.delete(file);
			}
		for (const id of [...this.#renderedThread.keys()]) {
			if (!activeIds.has(id)) this.#renderedThread.delete(id);
		}
		const kept = new Set<Element>(parts);
		for (const child of [...this.#body.children]) {
			if (!kept.has(child)) child.remove();
		}
		for (let i = 0; i < parts.length; i++) {
			const node = parts[i]!;
			if (this.#body.children[i] !== node) {
				this.#body.insertBefore(node, this.#body.children[i] ?? null);
			}
		}
	}

	#person(userId: string | null | undefined): SurfaceTeammate | undefined {
		const name = this.#store.memberName(userId);
		return userId && name ? { userId, name } : undefined;
	}

	#sentImageView(
		key: string,
		sessionId: string,
		attached: { readonly clientInputId: string; readonly images: readonly SurfaceImageRef[] },
	): ReceivedAttachments {
		const known = this.#sentImages.get(key);
		if (known) return known;
		const images = attached.images;
		const view = new ReceivedAttachments(
			{
				id: attached.clientInputId,
				attachmentCount: images.length,
				attachments: images.map((image, index) => ({
					kind: "image" as const,
					name: images.length > 1 ? t("Image {n}", { n: index + 1 }) : t("Image"),
					mediaType: image.mediaType,
					bytes: image.bytes,
					reference: { sha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType },
				})),
			},
			(_id, index, signal) => {
				const image = images[index];
				return image
					? this.#store.readSessionImage(sessionId, attached.clientInputId, image, signal)
					: Promise.reject(new Error(t("This image is not available.")));
			},
		);
		view.el.classList.add("surface-message-images");
		this.#sentImages.set(key, view);
		return view;
	}

	#localImages(files: readonly File[] | undefined): HTMLElement | null {
		if (!files?.length) return null;
		return h(
			"div",
			{ class: "surface-message-images is-sending" },
			...files.map((file) => {
				let url = this.#localImageUrls.get(file);
				if (!url) {
					url = URL.createObjectURL(file);
					this.#localImageUrls.set(file, url);
				}
				return h("img", { src: url, alt: file.name });
			}),
		);
	}

	#click(event: MouseEvent): void {
		const hit = event.target as Element;
		const target = hit.closest<HTMLElement>("[data-act]");
		if (!target) return;
		const link = hit.closest("a");
		if (link && link !== target && target.contains(link)) return;
		const store = this.#store;
		const drawer = store.state.drawer;
		const surfaceId = drawer?.surfaceId ?? this.#surfaceId;
		if (!surfaceId) return;
		const { act, change, changeTitle, answer, session, exploration, report, optionGroup } = target.dataset;
		const sessionId = session ?? drawer?.sessionId;
		switch (act) {
			case "close":
			case "close-panel":
				store.closePanel(surfaceId);
				return;
			case "back-overview":
				store.returnToOverview(surfaceId);
				return;
			case "open-report":
				store.openReport(surfaceId, report);
				return;
			case "open-deliverable":
				if (change && report) void store.openChangeDeliverable(surfaceId, change, report, target.dataset.path);
				return;
			case "focus-session":
				if (session) store.openDrawer(surfaceId, session);
				return;
			case "focus-exploration":
				if (exploration) store.openExplorationDrawer(surfaceId, exploration);
				return;
			case "pick-variant":
				if (exploration && session) void store.pickVariant(surfaceId, exploration, session);
				return;
			case "choose-variant": {
				const workspace = store.workspace(surfaceId);
				const set = workspace?.explorations.find((item) => item.id === exploration);
				if (set && session) void store.chooseVariant(set, session);
				return;
			}
			case "instead-of":
				if (exploration) store.askInstead(surfaceId, exploration);
				return;
			case "discard-exploration": {
				const workspace = store.workspace(surfaceId);
				const set = workspace?.explorations.find((item) => item.id === exploration);
				if (set) void store.discardExploration(set);
				return;
			}
			case "pick-option":
				if (sessionId && optionGroup && change) void store.pickOption(surfaceId, sessionId, optionGroup, change);
				return;
			case "choose-option":
				if (sessionId && change) void store.chooseOption(sessionId, change);
				return;
			case "discard-option-group-armed":
				if (sessionId && optionGroup && this.#confirmOrArm(`discard-group:${sessionId}:${optionGroup}`)) {
					void store.discardOptionGroup(sessionId, optionGroup);
				}
				return;
			case "toggle":
				if (change) void store.toggleChange(surfaceId, change);
				return;
			case "approve":
				if (sessionId && change && this.#confirmOrArm(`approve:${sessionId}:${change}`))
					void store.approveChange(sessionId, change);
				return;
			case "approve-all":
				if (sessionId && this.#confirmOrArm(`approve-all:${sessionId}`)) void store.approveAll(sessionId);
				return;
			case "fold-changes":
				this.#unfolded = this.#unfolded === sessionId ? undefined : sessionId;
				this.#redraw();
				this.#pinned
					.querySelector<HTMLElement>(
						target.classList.contains("surface-changes-fold")
							? ".surface-changes-fold"
							: ".surface-changes-toggle",
					)
					?.focus({ preventScroll: true });
				return;
			case "open-change":
				this.#openChange = this.#openChange === change ? undefined : change;
				this.#redraw();
				[...this.#pinned.querySelectorAll<HTMLElement>('[data-act="open-change"]')]
					.find((row) => row.dataset.change === change)
					?.focus({ preventScroll: true });
				return;
			case "approve-shown":
				if (surfaceId && this.#confirmOrArm(`approve-shown:${surfaceId}`))
					void store.approveChanges(surfaceId, this.#approvable);
				return;
			case "open-publish": {
				const targetSurface = store.state.surfaces.find((item) => item.id === surfaceId);
				if (targetSurface) openPublishSheet(store, targetSurface);
				return;
			}
			case "retry-session":
				if (sessionId) void store.retrySession(sessionId);
				return;
			case "quote-change": {
				if (sessionId && changeTitle) {
					this.#setQuotedChange({ sessionId, changeId: change || undefined, title: changeTitle });
					this.#input.focus({ preventScroll: true });
				}
				return;
			}
			case "clear-change-quote":
				this.#setQuotedChange(undefined);
				this.#input.focus({ preventScroll: true });
				return;
			case "discard-change":
				if (sessionId && change) {
					if (this.#quotedChange?.changeId === change) this.#setQuotedChange(undefined);
					void store.discardChange(sessionId, change);
				}
				return;
			case "discard-change-armed":
				if (sessionId && change && this.#confirmOrArm(`discard:${sessionId}:${change}`)) {
					if (this.#quotedChange?.changeId === change) this.#setQuotedChange(undefined);
					void store.discardChange(sessionId, change);
				}
				return;
			case "discard":
				if (sessionId) void store.discardSession(sessionId);
				return;
			case "answer":
				if (sessionId && answer) void store.reply(sessionId, answer);
				return;
		}
	}
}
