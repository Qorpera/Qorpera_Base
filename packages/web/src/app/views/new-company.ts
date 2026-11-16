import { FOUNDING_NAME_MAX_CHARACTERS } from "../../cloud/company-founding.ts";
import { figureElement } from "../../ui/avatar.ts";
import { button, h, icon, notice, personAvatar, spinner } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { IDEA_MAX_CHARACTERS } from "../router.ts";
import type { HubController } from "./hub.ts";

export interface Viewer {
	userId: string;
	name: string;
}

const KINDS = [
	{ id: "webshop", example: phrase("A webshop with ceramics") },
	{ id: "marketing", example: phrase("A marketing agency") },
	{ id: "cafe", example: phrase("A café with takeaway") },
	{ id: "radgivning", example: phrase("Sustainability consulting") },
	{ id: "handvaerk", example: phrase("A painting company in Aarhus") },
	{ id: "app", example: phrase("An app for dog walkers") },
] as const;

/** What qorpera.com's box handed over: the idea typed there, and the kind of company picked. */
export interface WebsiteHandoff {
	idea?: string;
	kind?: string;
}

/** Where qorpera.com's hand-off waits for the app: kept through a sign-in, read once. */
const WEBSITE_IDEA_KEY = "qorpera:website-idea";

/** Keeps what a qorpera.com link carried until the box takes it (a sign-in may come first). */
export function keepWebsiteIdea(handoff: WebsiteHandoff): void {
	const idea = handoff.idea?.trim().slice(0, IDEA_MAX_CHARACTERS);
	const kind = KINDS.find((each) => each.id === handoff.kind)?.id;
	if (!idea && !kind) return;
	try {
		sessionStorage.setItem(
			WEBSITE_IDEA_KEY,
			JSON.stringify({ ...(idea ? { idea } : {}), ...(kind ? { kind } : {}) }),
		);
	} catch {
		/* Without storage the idea is lost; the box is still there to type it. */
	}
}

function takeWebsiteIdea(): WebsiteHandoff | undefined {
	try {
		const saved: unknown = JSON.parse(sessionStorage.getItem(WEBSITE_IDEA_KEY) ?? "null");
		sessionStorage.removeItem(WEBSITE_IDEA_KEY);
		if (!saved || typeof saved !== "object") return undefined;
		const idea = "idea" in saved && typeof saved.idea === "string" ? saved.idea.trim() : "";
		const kind = "kind" in saved && typeof saved.kind === "string" ? saved.kind : "";
		return idea || kind ? { ...(idea ? { idea } : {}), ...(kind ? { kind } : {}) } : undefined;
	} catch {
		return undefined;
	}
}

/** The longest name a table opens with. */
const IDEA_NAME_MAX_CHARACTERS = 48;

/** A name to open the table with: the idea's first sentence in its own words, cut on a word boundary, with no
 * closing full stop ("A Danish webshop that sells silicone wristbands. We ship…" → "A Danish webshop that sells
 * silicone wristbands"). The founders can change it at the table. */
export function companyNameFromIdea(idea: string): string {
	const line = (idea.trim().split(/\r?\n/, 1)[0] ?? "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	// A stop, a space and a capital letter end the sentence; "e.g. ceramics" does not, and a sentence is at least two
	// words, so "Dr. Hansen's clinic" keeps its "Dr.".
	const sentences = line.split(/(?<=[.!?…])\s+(?=\p{Lu})/u);
	let name = sentences[0] ?? "";
	for (let next = 1; next < sentences.length && !name.includes(" "); next++) name = `${name} ${sentences[next]}`;
	if (name.length > IDEA_NAME_MAX_CHARACTERS) {
		// One character more, so a word that ends exactly at the limit stays whole.
		const space = name.slice(0, IDEA_NAME_MAX_CHARACTERS + 1).lastIndexOf(" ");
		name = name.slice(0, space > 20 ? space : IDEA_NAME_MAX_CHARACTERS);
	}
	// Last, so a cut that ends on a comma or a stop loses it too.
	name = name.replace(/[\s.!?…:;,\-–—]+$/u, "");
	if (!name) return t("New company");
	return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

class NewCompanyView {
	readonly el: HTMLElement;
	readonly #hub: HubController;
	readonly #idea: HTMLTextAreaElement;
	readonly #name: HTMLInputElement;
	readonly #from: HTMLElement;
	readonly #go: HTMLButtonElement;
	readonly #invite: HTMLButtonElement;
	readonly #inviteFace = h("span", { class: "hero-invite-face" });
	readonly #nameNote = h(
		"p",
		{ class: "hero-name-note", hidden: true },
		t("Named after your idea until you change it"),
	);
	readonly #status = h("div", { class: "hero-status" });
	readonly #invitations = h("div", { class: "hero-invitations" });
	readonly #figureStage = h("span", { class: "hero-figure" });
	/** qorpera.com's idea, while the box still holds it. */
	#carried: string | undefined;
	#viewerKey = "";
	#statusKey = "";
	#typing: ReturnType<typeof setTimeout> | undefined;
	/** The founder has been in the box: the example ideas stop writing themselves for good. */
	#touched = false;
	/** Where the caret stood when the box lost focus to a move or a new language, to put it back. */
	#caret: { start: number; end: number; direction: "forward" | "backward" | "none" } | undefined;
	/** The box had focus when an opening started, so it gets it back if the opening fails. */
	#refocus = false;

	constructor(hub: HubController) {
		this.#hub = hub;
		// The newest box is the one on the page (a new language builds another).
		hub.onTableOpened = (idea) => this.#opened(idea);
		this.#idea = h("textarea", {
			id: "newCompanyIdea",
			class: "hero-idea",
			rows: 1,
			maxlength: IDEA_MAX_CHARACTERS,
			oninput: () => {
				this.#touch();
				this.#changed();
			},
			onfocus: () => this.#touch(),
			onpointerdown: () => this.#touch(),
			oncompositionstart: () => this.#touch(),
			onkeydown: (event: KeyboardEvent) => {
				this.#touch();
				// Enter sends, as on qorpera.com; Shift+Enter is a new line, and Enter that ends an IME composition is neither.
				if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
				event.preventDefault();
				this.#start();
			},
		});
		this.#name = h("input", {
			id: "newCompanyName",
			class: "hero-name",
			type: "text",
			maxlength: FOUNDING_NAME_MAX_CHARACTERS,
			autocomplete: "organization",
			placeholder: t("Named after your idea"),
			oninput: () => this.#changed(),
			onkeydown: (event: KeyboardEvent) => {
				// Enter goes on to the idea; Enter that ends an IME composition stays.
				if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
				event.preventDefault();
				this.#idea.focus();
			},
		});
		this.#from = h("span", { class: "hero-from", hidden: true }, icon("globe"), t("Your idea from qorpera.com"));
		this.#go = h(
			"button",
			{ type: "submit", class: "hero-go", "aria-label": t("Start"), title: t("Start") },
			icon("arrow_up"),
		);
		this.#invite = h(
			"button",
			{ type: "button", class: "hero-invite", onclick: () => this.#withFriends() },
			this.#inviteFace,
			h("span", { class: "hero-plus", "aria-hidden": "true" }, icon("plus")),
			t("Invite friends"),
		);
		this.el = h(
			"div",
			{ class: "hero" },
			this.#figureStage,
			h("h1", { class: "hero-title" }, t("What do you want to build?")),
			h(
				"div",
				{ class: "hero-name-field" },
				h("label", { for: "newCompanyName", class: "hero-name-label" }, t("Company name")),
				h("div", { class: "hero-name-box" }, this.#name, icon("edit")),
				this.#nameNote,
			),
			h(
				"form",
				{
					class: "hero-box",
					onsubmit: (event: Event) => {
						event.preventDefault();
						this.#start();
					},
				},
				this.#from,
				h(
					"div",
					{ class: "hero-idea-row" },
					h("label", { for: "newCompanyIdea", class: "hero-idea-label" }, t("The idea")),
					this.#idea,
				),
				h("div", { class: "hero-row" }, this.#invite, this.#go),
			),
			this.#status,
			this.#invitations,
		);
		this.#placeholder();
	}

	mount(container: HTMLElement, wrapperClass: string): void {
		const wrapper = this.el.parentElement;
		if (wrapper?.parentElement === container && wrapper.className === wrapperClass) return;
		if (document.activeElement === this.#idea) this.#caret = caretOf(this.#idea);
		container.replaceChildren(h("section", { class: wrapperClass, "data-form-owner": "new-company" }, this.el));
		this.#restoreCaret();
		this.#figureStage.replaceChildren(
			figureElement("crown", undefined, { size: 128, activity: "Working", identity: "new-company" }),
		);
		this.#resize();
		this.#placeholder();
	}

	carry(handoff: WebsiteHandoff): void {
		if (this.#idea.value.trim()) return;
		const kind = KINDS.find((each) => each.id === handoff.kind);
		const idea = handoff.idea ?? (kind ? t(kind.example) : "");
		if (!idea) return;
		this.#idea.value = idea;
		this.#carried = handoff.idea;
		this.#changed();
	}

	adopt(other: NewCompanyView): void {
		this.#idea.value = other.#idea.value;
		this.#name.value = other.#name.value;
		this.#carried = other.#carried;
		this.#touched = other.#touched;
		if (document.activeElement === other.#idea) this.#caret = caretOf(other.#idea);
		this.#changed();
	}

	update(viewer: Viewer | undefined, invitations: HTMLElement[]): void {
		const state = this.#hub.store.get();
		const busy = Boolean(state.creating);
		const paused = state.foundingAvailable === false;
		if (busy && document.activeElement === this.#idea) this.#refocus = true;
		this.#idea.disabled = busy;
		this.#name.disabled = busy;
		if (!busy && this.#refocus) {
			// An opening that failed hands the box back to the founder, caret at the end.
			this.#refocus = false;
			// Only when focus went nowhere: a founder who moved on meanwhile keeps their place.
			const lost = document.activeElement === null || document.activeElement === document.body;
			if (this.el.isConnected && lost && (state.error || state.creationRetry)) {
				this.#idea.focus();
				this.#idea.setSelectionRange(this.#idea.value.length, this.#idea.value.length);
			}
		}
		this.#go.disabled = busy || paused;
		this.#invite.disabled = busy || paused;
		const viewerKey = viewer ? `${viewer.userId}\n${viewer.name}` : "";
		if (viewerKey !== this.#viewerKey) {
			this.#viewerKey = viewerKey;
			this.#inviteFace.replaceChildren(...(viewer ? [personAvatar(viewer.name, viewer.userId)] : []));
		}
		const statusKey = [
			state.creating?.name ?? "",
			busy,
			paused,
			state.error ?? "",
			state.creationRetry?.name ?? "",
		].join("\n");
		if (statusKey !== this.#statusKey) {
			this.#statusKey = statusKey;
			const parts: HTMLElement[] = [];
			if (busy)
				parts.push(
					spinner(
						state.creating!.intent === "start"
							? t("Starting {name}", { name: state.creating!.name })
							: t("Opening a table for {name}", { name: state.creating!.name }),
					),
				);
			else if (paused) parts.push(notice("warn", t("Creating a company is paused. Try again later.")));
			if (state.error) parts.push(notice("danger", state.error));
			if (state.creationRetry && !busy) {
				const retry = state.creationRetry;
				parts.push(
					button(
						t("Resume creating {name}", { name: retry.name }),
						() => void this.#hub.createCompany(retry.name, retry),
					),
				);
			}
			this.#status.replaceChildren(...parts);
		}
		this.#invitations.replaceChildren(...invitations);
		this.#invitations.hidden = invitations.length === 0;
	}

	/** The box grows with the idea, as the website's does. */
	#resize(): void {
		this.#idea.style.height = "auto";
		if (this.#idea.scrollHeight > 0) this.#idea.style.height = `${this.#idea.scrollHeight}px`;
	}

	#changed(): void {
		this.#resize();
		const idea = this.#idea.value.trim();
		this.#name.placeholder = idea ? companyNameFromIdea(idea) : t("Named after your idea");
		this.#nameNote.hidden = !idea || this.#name.value.trim() !== "";
		if (this.#carried !== undefined && this.#idea.value.trim() !== this.#carried.trim()) this.#carried = undefined;
		this.#from.hidden = this.#carried === undefined;
		this.#placeholder();
	}

	#start(): void {
		const idea = this.#idea.value.trim();
		if (!idea) {
			this.#idea.focus();
			return;
		}
		void this.#hub.startFromIdea(idea, "start", this.#name.value);
	}

	#withFriends(): void {
		void this.#hub.startFromIdea(this.#idea.value.trim(), "friends", this.#name.value);
	}

	/** A table opened with this idea (from the arrow, Invite friends or Resume): the box starts empty, so the next
	 * company's idea is never written after this one's. */
	#opened(idea: string): void {
		if (this.#idea.value.trim() !== idea.trim()) return;
		this.#refocus = false;
		this.#idea.value = "";
		this.#name.value = "";
		this.#carried = undefined;
		this.#changed();
	}

	#touch(): void {
		if (this.#touched) return;
		this.#touched = true;
		this.#placeholder();
	}

	#restoreCaret(): void {
		const caret = this.#caret;
		this.#caret = undefined;
		if (!caret || !this.el.isConnected || this.#idea.disabled) return;
		this.#idea.focus({ preventScroll: true });
		this.#idea.setSelectionRange(caret.start, caret.end, caret.direction);
	}

	/** An empty box writes out example ideas, as qorpera.com does, in its placeholder only (never its text), until
	 * the founder first focuses it, presses in it or types: from then on it rests on the first example. It goes
	 * through them twice, then rests on the first. */
	#placeholder(): void {
		clearTimeout(this.#typing);
		const examples = KINDS.map((kind) => t(kind.example));
		this.#idea.placeholder = examples[0]!;
		const still =
			window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true ||
			this.#touched ||
			document.activeElement === this.#idea ||
			this.#idea.value !== "" ||
			!this.el.isConnected;
		if (still) return;
		let shown = 0,
			length = 0,
			erasing = false;
		const step = () => {
			if (
				!this.el.isConnected ||
				this.#touched ||
				document.activeElement === this.#idea ||
				this.#idea.value !== ""
			) {
				this.#idea.placeholder = examples[0]!;
				return;
			}
			const text = examples[shown % examples.length]!;
			if (!erasing) {
				length++;
				if (length >= text.length) erasing = true;
			} else {
				length -= 2;
				if (length <= 0) {
					erasing = false;
					length = 0;
					shown++;
				}
			}
			this.#idea.placeholder = text.slice(0, Math.max(0, length));
			if (shown >= examples.length * 2) {
				this.#idea.placeholder = examples[0]!;
				return;
			}
			this.#typing = setTimeout(step, !erasing ? 70 : length >= text.length ? 2200 : 28);
		};
		this.#typing = setTimeout(step, 600);
	}
}

/** The caret of a box, to put back where it was. */
function caretOf(box: HTMLTextAreaElement): { start: number; end: number; direction: "forward" | "backward" | "none" } {
	return {
		start: box.selectionStart,
		end: box.selectionEnd,
		direction:
			box.selectionDirection === "backward" ? "backward" : box.selectionDirection === "forward" ? "forward" : "none",
	};
}

const views = new WeakMap<HubController, NewCompanyView>();

export function relabelNewCompany(hub: HubController): void {
	const old = views.get(hub);
	if (!old) return;
	const view = new NewCompanyView(hub);
	view.adopt(old);
	views.set(hub, view);
}

/** qorpera.com's hand-off waits to be shown: the hub sends the member to the new-company box first (a sign-in
 * returns to the app's root, not to `#/new`). */
export function hasWebsiteIdea(): boolean {
	try {
		return sessionStorage.getItem(WEBSITE_IDEA_KEY) !== null;
	} catch {
		return false;
	}
}

function viewFor(hub: HubController): NewCompanyView {
	let view = views.get(hub);
	if (!view) {
		view = new NewCompanyView(hub);
		views.set(hub, view);
	}
	return view;
}

/** The new-company page (`#/new`), or the hub itself for a member with no company yet (`welcome`). */
export function renderNewCompany(
	hub: HubController,
	container: HTMLElement,
	viewer: Viewer | undefined,
	options: { welcome?: boolean; invitations?: HTMLElement[] } = {},
): void {
	const view = viewFor(hub);
	view.mount(container, options.welcome ? "hub hub-welcome" : "hub hub-new");
	const handoff = takeWebsiteIdea();
	if (handoff) view.carry(handoff);
	view.update(viewer, options.invitations ?? []);
}
