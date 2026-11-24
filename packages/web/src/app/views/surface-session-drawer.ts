import type {
	SurfaceChangeUnit,
	SurfaceExplorationSet,
	SurfaceImageRef,
	SurfaceSession,
	SurfaceSessionMessage,
	SurfaceSummary,
	SurfaceWorkspace,
} from "@qorpera/contracts";
import { fmtTime, h, icon, personAvatar, replace } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { leadingMentions, type MentionTarget, matchTargets, mentionQuery } from "../../ui/mentions.ts";
import { t } from "../../ui/preferences.ts";
import { ReceivedAttachments } from "../../ui/received-attachments.ts";
import { uiScale } from "../../ui/scale.ts";
import type { SurfaceLook } from "../surface-kinds.ts";
import {
	formatConflictPaths,
	hasConflictedChange,
	isOpenChange,
	isOpenVariant,
	isRunningSession,
	openExplorations,
	reportsOwnedBy,
	type SurfaceNote,
	type SurfaceReportSummary,
	type SurfacesStore,
	type SurfaceTeammate,
	sessionHeld,
} from "../surfaces-store.ts";
import { SurfaceComposerImages } from "./surface-composer-images.ts";
import { CrewFigures } from "./surface-crew.ts";
import { openPublishSheet } from "./surface-publish-sheet.ts";
import { isActionChange } from "./surface-rail.ts";

const DRAWER_WIDTH_KEY = "qorpera.web.surface-drawer-width.v1";
const DRAWER_DEFAULT = 296;
const DRAWER_MIN = 260;
const DRAWER_MAX = 560;
const DRAWER_MAX_SHARE = 0.56;
export const APPROVE_ARM_MS = 4_500;

interface QuotedChangeRef {
	readonly sessionId: string;
	readonly changeId: string;
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

export function approveLabel(rest: string, armed: boolean, glyph?: string): HTMLElement {
	return h(
		"span",
		{ class: "surface-approve-label" },
		approveFace(rest, !armed, false, glyph),
		approveFace(t("Confirm"), armed, true),
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

function messageRow(
	message: SurfaceSessionMessage,
	author?: SurfaceTeammate,
	images?: HTMLElement | null,
	to?: readonly SurfaceTeammate[],
): HTMLElement {
	if (message.authorKind === "system")
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
				message.changeId
					? h("span", { class: "surface-system-mark", "aria-hidden": "true" }, icon("check"))
					: h("span", { class: "surface-system-dot", "aria-hidden": "true" }),
				h("span", { class: "surface-system-text" }, message.text),
			),
		);
	if (message.authorKind === "session")
		return h(
			"div",
			{ class: "surface-message is-session", title: fmtTime(message.createdAt) },
			markdown(message.text),
		);
	return memberBubble(message.text, "", fmtTime(message.createdAt), author, images, to);
}

function changeTag(change: SurfaceChangeUnit): HTMLElement | null {
	if (change.status === "merged") return h("span", { class: "surface-tag is-merged" }, icon("check"), t("Merged"));
	if (change.status === "conflicted") return h("span", { class: "surface-tag is-conflicted" }, t("Conflict"));
	if (change.status === "discarded") return h("span", { class: "surface-tag" }, t("Discarded"));
	if (change.status === "reverted") return h("span", { class: "surface-tag" }, t("Reverted"));
	if (change.status === "merging") return h("span", { class: "surface-tag" }, t("Merging"));
	return null;
}

function agentStatusLine(session: SurfaceSession): string | null {
	if (session.state === "needs_input") return t("Needs you");
	if (session.state === "failed") return t("Failed");
	if (isRunningSession(session)) return t("Working");
	if (hasConflictedChange(session)) return t("Conflict");
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
				: hasConflictedChange(session)
					? 2
					: isRunningSession(session)
						? 3
						: session.changes.some(isOpenChange)
							? 4
							: 5;
	return [...sessions].sort((a, b) => score(a) - score(b));
}

function drawerCap(): number {
	const scale = uiScale();
	return Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, Math.floor((window.innerWidth * DRAWER_MAX_SHARE) / scale)));
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
	#sessionId = "";
	#messages = 0;
	#quotedChange: QuotedChangeRef | undefined;
	#armedApprove: string | undefined;
	#armTimer: ReturnType<typeof setTimeout> | undefined;
	#mention: { options: MentionTarget[]; active: number } | undefined;

	constructor(store: SurfacesStore, signal: AbortSignal) {
		this.#store = store;
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
		this.el.append(this.#resizer, h("div", { class: "surface-drawer-inner" }, this.#head, this.#body, this.#form));
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
				this.#input.value = "";
				this.#images.set([]);
				this.#setQuotedChange(undefined);
				void store.reply(sessionId, payload, files).then((ok) => {
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
		window.addEventListener("resize", () => this.#applyWidth(), { signal });
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
			state.variantPick,
			state.busy,
			this.#armedApprove,
			state.localStudioBase[surface.id],
			state.cloudSurfaceFiles[surface.id],
			state.studioPatches,
			workspace,
		];
		if (sameDeps(this.#shown, deps)) return;
		this.#shown = deps;
		const explorations = openExplorations(workspace);
		const plainSessions = rankSessions(
			(workspace?.activeSessions ?? []).filter((session) => !isOpenVariant(session, workspace)),
		);
		this.#sessionId = "";
		this.#messages = 0;

		this.#head.className = "surface-drawer-head is-overview";
		this.#head.replaceChildren(h("div", { class: "surface-drawer-title" }, h("h2", null, t("Changes"))));

		const parts: HTMLElement[] = [];
		if (workspace) {
			for (const exploration of explorations) {
				parts.push(this.#explorationCard(exploration, workspace, surface));
			}
		}
		for (const session of plainSessions) {
			parts.push(this.#agentCard(session, surface, look));
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
		const attention = variants.some((v) => v.state === "needs_input" || hasConflictedChange(v));
		const ownedNotes = reportsOwnedBy(state, surface.id, { kind: "exploration", id: exploration.id });
		const noteNodes = this.#noteButtons(ownedNotes);
		return h(
			"section",
			{
				class: ["surface-overview-card", "is-agent", "is-exploration", attention && "is-attention"]
					.filter(Boolean)
					.join(" "),
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
				this.#crew.takeExploration(exploration, variants, 30),
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

	#agentCard(session: SurfaceSession, surface: SurfaceSummary, look: SurfaceLook): HTMLElement {
		const store = this.#store;
		const state = store.state;
		const running = isRunningSession(session);
		const listed = session.changes.filter((change) => change.status !== "discarded");
		const openChanges = listed.filter(isOpenChange);
		const actionSession =
			surface.archetype === "ops" ||
			(listed.length > 0 && listed.every((change) => isActionChange(change, surface)));
		const busyReconcile = Boolean(state.busy[`reconcile:${surface.id}`]);
		const failed = session.state === "failed";
		const attention = session.state === "needs_input" || hasConflictedChange(session) || failed;
		const ownedNotes = reportsOwnedBy(state, surface.id, { kind: "session", id: session.id });
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
			this.#crew.take(session, 30, "", this.#store.turnHolder(session)),
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
					h("div", { class: "surface-question-text" }, markdown(session.question.text)),
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
						return h(
							"div",
							{ class: "surface-overview-change" },
							h(
								"div",
								{ class: "surface-overview-change-row" },
								h("span", { class: "surface-overview-change-title" }, change.title),
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
			bodyItems.push(
				h(
					"div",
					{ class: "surface-overview-changes" },
					...openChanges.map((change) => {
						const conflicted = change.status === "conflicted";
						const shown = store.isChangeShown(change.id);
						const armed = this.#armedApprove === `approve:${session.id}:${change.id}`;
						return h(
							"div",
							{ class: `surface-overview-change${conflicted ? " is-conflicted" : ""}` },
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
								conflicted && !running
									? h(
											"button",
											{
												type: "button",
												class: "surface-overview-act is-danger",
												disabled: busyReconcile,
												"data-act": "reconcile",
												"data-change": change.id,
											},
											t("Reconcile"),
										)
									: !running
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
						);
					}),
				),
			);
		}

		return h(
			"section",
			{
				class: ["surface-overview-card", "is-agent", attention && "is-attention", failed && "is-failed"]
					.filter(Boolean)
					.join(" "),
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
			this.#crew.takeExploration(exploration, variants, 36, "is-large"),
			h("div", { class: "surface-drawer-title" }, h("h2", null, exploration.title)),
		);
		this.#crew.settle();

		const parts: HTMLElement[] = [];
		if (resolvedSurface) parts.push(...this.#noteButtons(ownedNotes));
		parts.push(
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
											"data-change": primaryChange?.id ?? variant.id,
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
		if (picked) parts.push(...this.#thread(picked, notes));
		this.#body.replaceChildren(...parts);
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
			state.busy,
			look?.kind,
			look?.accent,
			this.#armedApprove,
			ownedNotes,
		];
		if (state.unseenNotes[session.id]) store.seeNotes(session.id);
		if (sameDeps(this.#shown, deps)) return;
		this.#shown = deps;
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
			this.#crew.take(session, 36, "is-large", store.turnHolder(session)),
			h("div", { class: "surface-drawer-title" }, h("h2", null, session.title)),
		);
		this.#crew.settle();
		this.#body.replaceChildren(...this.#content(session, notes, resolvedSurface, look, ownedNotes));
		const count = (session.messages.length || (session.prompt ? 1 : 0)) + notes.length;
		if (session.id !== this.#sessionId || count !== this.#messages) {
			this.#sessionId = session.id;
			this.#messages = count;
			this.#body.scrollTop = this.#body.scrollHeight;
		}
	}

	#content(
		session: SurfaceSession,
		notes: readonly SurfaceNote[],
		surface: SurfaceSummary | undefined,
		look: SurfaceLook | undefined,
		ownedNotes: readonly SurfaceReportSummary[],
	): HTMLElement[] {
		const store = this.#store;
		const parts: HTMLElement[] = [];
		const listed = session.changes.filter((change) => change.status !== "discarded");
		const actionSession = Boolean(
			surface &&
				(surface.archetype === "ops" ||
					(listed.length > 0 && listed.every((change) => isActionChange(change, surface)))),
		);
		if (surface && ownedNotes.length > 0) parts.push(...this.#noteButtons(ownedNotes));
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
					h("div", { class: "surface-question-text" }, markdown(session.question.text)),
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
			const busyReconcile = Boolean(store.state.busy[`reconcile:${session.surfaceId}`]);
			const running = isRunningSession(session);
			const changeRows: HTMLElement[] = [];
			for (const change of listed) {
				const open = isOpenChange(change);
				const conflicted = change.status === "conflicted";
				const shown = store.isChangeShown(change.id);
				const busyChange = Boolean(store.state.busy[`change:${change.id}`]);
				const armed = this.#armedApprove === `approve:${session.id}:${change.id}`;
				const conflictPaths = change.conflictPaths?.length ? formatConflictPaths(change.conflictPaths) : "";
				changeRows.push(
					h(
						"div",
						{
							class: `surface-drawer-change${open ? "" : " is-closed"}${conflicted ? " is-conflicted" : ""}`,
							"data-change": change.id,
						},
						h(
							"div",
							{ class: "surface-drawer-change-top" },
							open ? null : h("span", { class: "surface-change-mark" }, icon("check")),
							h(
								"div",
								{ class: "surface-drawer-change-copy" },
								conflicted
									? h(
											"div",
											{ class: "surface-drawer-change-head" },
											h("span", { class: "surface-drawer-change-title" }, change.title),
											changeTag(change),
										)
									: h("span", { class: "surface-drawer-change-title" }, change.title),
								conflicted && conflictPaths
									? h(
											"small",
											{ class: "surface-conflict-paths", title: change.conflictPaths?.join(", ") },
											t("Conflicts in {paths}", { paths: conflictPaths }),
										)
									: null,
							),
							!open ? changeTag(change) : null,
						),
						open
							? h(
									"div",
									{ class: "surface-drawer-change-acts" },
									h("button", {
										type: "button",
										class: "surface-switch",
										role: "switch",
										"aria-checked": String(shown),
										"aria-label": t("Show {title} in the preview", { title: change.title }),
										"data-act": "toggle",
										"data-change": change.id,
									}),
									...(running
										? []
										: [
												conflicted
													? h(
															"button",
															{
																type: "button",
																class: "surface-change-btn is-danger",
																"data-act": "reconcile",
																"data-change": change.id,
																disabled: busyReconcile,
															},
															t("Reconcile"),
														)
													: h(
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
														class: "surface-change-btn",
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
														class: "surface-change-btn is-muted",
														"data-act": "discard-change",
														"data-change": change.id,
														disabled: busyChange,
													},
													t("Discard"),
												),
											]),
								)
							: null,
					),
				);
			}
			parts.push(h("div", { class: "surface-drawer-changes" }, ...changeRows));
			const open = session.changes.filter(isOpenChange).length;
			const conflictedCount = session.changes.filter((change) => change.status === "conflicted").length;
			const armedAll = this.#armedApprove === `approve-all:${session.id}`;
			if (!running && (conflictedCount > 1 || open > 1))
				parts.push(
					h(
						"div",
						{ class: "surface-drawer-actions" },
						conflictedCount > 1
							? h(
									"button",
									{
										type: "button",
										class: "btn btn-primary btn-small",
										"data-act": "reconcile-all",
										disabled: busyReconcile,
									},
									t("Reconcile all"),
								)
							: open > 1 && conflictedCount === 0
								? h(
										"button",
										{
											type: "button",
											class: `btn btn-small surface-approve-btn${armedAll ? " is-confirming" : ""}`,
											"data-act": "approve-all",
											...(armedAll ? { "data-armed": "true" } : {}),
										},
										approveLabel(t("Approve all {count}", { count: open }), armedAll),
									)
								: null,
						open > 1
							? h("button", { type: "button", class: "btn btn-small", "data-act": "discard" }, t("Discard all"))
							: null,
					),
				);
		}
		parts.push(...this.#thread(session, notes));
		return parts;
	}

	#thread(session: SurfaceSession, notes: readonly SurfaceNote[]): HTMLElement[] {
		const store = this.#store;
		store.ensureSessionImages(session);
		const sent = store.state.sessionImages[session.id]?.messages ?? [];
		const keep = new Set<string>();
		const parts: HTMLElement[] = [];
		if (session.messages.length > 0) {
			for (const message of session.messages) {
				const attached =
					message.authorKind === "member" ? sent.find((item) => item.messageId === message.id) : undefined;
				let images: HTMLElement | undefined;
				if (attached?.images.length) {
					const key = `${session.id}:${attached.clientInputId}`;
					keep.add(key);
					images = this.#sentImageView(key, session.id, attached).el;
				}
				const to =
					message.authorKind === "note"
						? (message.noteTo ?? []).flatMap((userId) => this.#person(userId) ?? [])
						: undefined;
				parts.push(messageRow(message, this.#person(message.authorUserId), images, to));
			}
		} else if (session.prompt) {
			parts.push(memberBubble(session.prompt, "", undefined, this.#person(session.createdByUserId)));
		}
		for (const [key, view] of this.#sentImages)
			if (!keep.has(key)) {
				view.dispose();
				this.#sentImages.delete(key);
			}
		const sending = new Set<File>();
		for (const note of notes) {
			for (const file of note.files ?? []) sending.add(file);
			parts.push(
				memberBubble(
					note.text,
					"is-pending",
					undefined,
					undefined,
					this.#localImages(note.files),
					note.to?.flatMap((userId) => this.#person(userId) ?? []),
				),
			);
		}
		for (const [file, url] of this.#localImageUrls)
			if (!sending.has(file)) {
				URL.revokeObjectURL(url);
				this.#localImageUrls.delete(file);
			}
		return parts;
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
		const { act, change, changeTitle, answer, session, exploration, report } = target.dataset;
		const sessionId = session ?? drawer?.sessionId;
		switch (act) {
			case "close":
			case "close-panel":
				store.closePanel();
				return;
			case "back-overview":
				store.openPreviewPanel();
				return;
			case "open-report":
				store.openReport(surfaceId, report);
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
			case "open-publish": {
				const targetSurface = store.state.surfaces.find((item) => item.id === surfaceId);
				if (targetSurface) openPublishSheet(store, targetSurface);
				return;
			}
			case "reconcile":
				if (change) void store.reconcileChanges(surfaceId, [change]);
				return;
			case "reconcile-all": {
				const current = sessionId ? store.session(sessionId) : undefined;
				const ids = current?.changes.filter((item) => item.status === "conflicted").map((item) => item.id) ?? [];
				if (ids.length) void store.reconcileChanges(surfaceId, ids);
				return;
			}
			case "retry-session":
				if (sessionId) void store.retrySession(sessionId);
				return;
			case "quote-change": {
				if (sessionId && change && changeTitle) {
					this.#setQuotedChange({ sessionId, changeId: change, title: changeTitle });
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
			case "discard":
				if (sessionId) void store.discardSession(sessionId);
				return;
			case "answer":
				if (sessionId && answer) void store.reply(sessionId, answer);
				return;
		}
	}
}
