import { button, h, icon, notice, personAvatar, spinner } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { IDEA_MAX_CHARACTERS } from "../router.ts";
import { type CrownHandle, mountCrown } from "./crown.ts";
import type { HubController } from "./hub.ts";

/* Starting a company: qorpera.com's hero, inside the app (Jonas, 22 October 2026, hub round 3). One
 * headline, one box for the idea with the Co-Founder's crown looking over its edge, and the website's
 * kinds of company under it. The arrow opens a table and starts the company as soon as it can; "Invite
 * friends" opens the table first, so friends write the first message with you. The idea typed on
 * qorpera.com arrives in the box (`#/new?idea=…`).
 *
 * The view is built once per hub and kept: typing, the caret, an IME composition and focus survive
 * every refresh of the company list. */

/** Who is signed in, for the avatar in the box. */
export interface Viewer {
	userId: string;
	name: string;
}

/** The website's kinds of company (qorpera.com, landing/src/site/site.js), each with an idea to start from. */
const KINDS = [
	{ name: phrase("Webshop"), example: phrase("A webshop with ceramics"), icon: "shop" },
	{ name: phrase("Marketing agency"), example: phrase("A marketing agency"), icon: "megaphone" },
	{ name: phrase("Café and restaurant"), example: phrase("A café with takeaway"), icon: "cup" },
	{ name: phrase("Consulting"), example: phrase("Sustainability consulting"), icon: "briefcase" },
	{ name: phrase("Trades"), example: phrase("A painting company in Aarhus"), icon: "brush" },
	{ name: phrase("App or software"), example: phrase("An app for dog walkers"), icon: "code" },
] as const;

/** Where qorpera.com's idea waits for the app: kept through a sign-in, read once. */
const WEBSITE_IDEA_KEY = "qorpera:website-idea";

/** Keeps the idea a qorpera.com link carried until the box takes it (a sign-in may come first). */
export function keepWebsiteIdea(idea: string): void {
	try {
		sessionStorage.setItem(WEBSITE_IDEA_KEY, idea.slice(0, IDEA_MAX_CHARACTERS));
	} catch {
		/* Without storage the idea is lost; the box is still there to type it. */
	}
}

function takeWebsiteIdea(): string | undefined {
	try {
		const idea = sessionStorage.getItem(WEBSITE_IDEA_KEY) ?? undefined;
		sessionStorage.removeItem(WEBSITE_IDEA_KEY);
		return idea?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** A name to open the table with, from the idea's first line; the founders can change it at the table. */
export function companyNameFromIdea(idea: string): string {
	const line = (idea.trim().split(/\r?\n/, 1)[0] ?? "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.replace(/^(?:an?|the|en|et)\s+/i, "")
		.replace(/[\s.!?…:;,]+$/u, "");
	if (!line) return t("New company");
	let name = line;
	if (name.length > 48) {
		const cut = name.slice(0, 48);
		const space = cut.lastIndexOf(" ");
		name = space > 20 ? cut.slice(0, space) : cut;
	}
	return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

class NewCompanyView {
	readonly el: HTMLElement;
	readonly #hub: HubController;
	readonly #idea: HTMLTextAreaElement;
	readonly #from: HTMLElement;
	readonly #go: HTMLButtonElement;
	readonly #invite: HTMLButtonElement;
	readonly #inviteFace = h("span", { class: "hero-invite-face" });
	readonly #kinds: HTMLButtonElement[];
	readonly #status = h("div", { class: "hero-status" });
	readonly #invitations = h("div", { class: "hero-invitations" });
	readonly #crownStage = h("span", { class: "hero-crown", "aria-hidden": "true" });
	#crown: CrownHandle | undefined;
	/** qorpera.com's idea, while the box still holds it. */
	#carried: string | undefined;
	#viewerKey = "";
	#statusKey = "";
	#typing: ReturnType<typeof setTimeout> | undefined;

	constructor(hub: HubController) {
		this.#hub = hub;
		this.#idea = h("textarea", {
			id: "newCompanyIdea",
			class: "hero-idea",
			rows: 1,
			maxlength: IDEA_MAX_CHARACTERS,
			"aria-label": t("Your idea"),
			oninput: () => this.#changed(),
			onfocus: () => this.#placeholder(),
			onblur: () => this.#placeholder(),
			onkeydown: (event: KeyboardEvent) => {
				// Enter sends, as on qorpera.com; Shift+Enter is a new line, and Enter that ends an IME composition is neither.
				if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
				event.preventDefault();
				this.#start();
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
		this.#kinds = KINDS.map((kind) =>
			h(
				"button",
				{
					type: "button",
					class: "hero-kind",
					"aria-pressed": "false",
					onclick: (event: MouseEvent) => this.#pick(kind.example, event.currentTarget as HTMLButtonElement),
				},
				icon(kind.icon),
				t(kind.name),
			),
		);
		this.el = h(
			"div",
			{ class: "hero" },
			h("h1", { class: "hero-title" }, t("From idea to company.")),
			h("p", { class: "hero-sub" }, t("Tell your Co-Founder the idea. Friends can write it with you.")),
			h(
				"div",
				{ class: "hero-ask" },
				this.#crownStage,
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
					this.#idea,
					h("div", { class: "hero-row" }, this.#invite, this.#go),
				),
			),
			h("div", { class: "hero-kinds", role: "group", "aria-label": t("What kind of company?") }, ...this.#kinds),
			this.#status,
			this.#invitations,
		);
		this.#placeholder();
	}

	/** Places the view in the container (once), with a live crown. */
	mount(container: HTMLElement, wrapperClass: string): void {
		const wrapper = this.el.parentElement;
		if (wrapper?.parentElement === container && wrapper.className === wrapperClass) return;
		container.replaceChildren(h("section", { class: wrapperClass, "data-form-owner": "new-company" }, this.el));
		// The crown stops when it leaves the page; a new one looks over the box each time it comes back.
		this.#crown?.dispose();
		this.#crownStage.replaceChildren();
		this.#crown = mountCrown(this.#crownStage, { mirrored: false });
		this.#placeholder();
	}

	/** qorpera.com's idea goes into an empty box; whatever you typed here stays. */
	carry(idea: string): void {
		if (this.#idea.value.trim()) return;
		this.#idea.value = idea;
		this.#carried = idea;
		this.#changed();
	}

	update(viewer: Viewer | undefined, invitations: HTMLElement[]): void {
		const state = this.#hub.store.get();
		const busy = Boolean(state.creating);
		const paused = state.foundingAvailable === false;
		this.#idea.disabled = busy;
		this.#go.disabled = busy || paused;
		this.#invite.disabled = busy || paused;
		for (const kind of this.#kinds) kind.disabled = busy;
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
			if (busy) parts.push(spinner(t("Opening a table for {name}", { name: state.creating!.name })));
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

	#changed(): void {
		// The box grows with the idea, as the website's does.
		this.#idea.style.height = "auto";
		this.#idea.style.height = `${this.#idea.scrollHeight}px`;
		if (this.#carried !== undefined && this.#idea.value.trim() !== this.#carried.trim()) this.#carried = undefined;
		this.#from.hidden = this.#carried === undefined;
		this.#placeholder();
	}

	#pick(example: string, pressed: HTMLButtonElement): void {
		for (const kind of this.#kinds) kind.setAttribute("aria-pressed", String(kind === pressed));
		const current = this.#idea.value.trim();
		if (!current || KINDS.some((kind) => t(kind.example) === current)) {
			this.#idea.value = t(example);
			this.#changed();
		}
		this.#idea.focus();
		this.#idea.setSelectionRange(this.#idea.value.length, this.#idea.value.length);
	}

	#start(): void {
		const idea = this.#idea.value.trim();
		if (!idea) {
			this.#idea.focus();
			return;
		}
		void this.#hub.startFromIdea(idea, "start");
	}

	#withFriends(): void {
		void this.#hub.startFromIdea(this.#idea.value.trim(), "friends");
	}

	/** An empty box writes out example ideas, as qorpera.com does, until you type or it has focus. It goes
	 * through them twice, then rests on the first. */
	#placeholder(): void {
		clearTimeout(this.#typing);
		const examples = KINDS.map((kind) => t(kind.example));
		this.#idea.placeholder = examples[0]!;
		const still =
			window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true ||
			document.activeElement === this.#idea ||
			this.#idea.value !== "" ||
			!this.el.isConnected;
		if (still) return;
		let shown = 0,
			length = 0,
			erasing = false;
		const step = () => {
			if (!this.el.isConnected || document.activeElement === this.#idea || this.#idea.value !== "") {
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

const views = new WeakMap<HubController, NewCompanyView>();

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
	const idea = takeWebsiteIdea();
	if (idea) view.carry(idea);
	view.update(viewer, options.invitations ?? []);
}
