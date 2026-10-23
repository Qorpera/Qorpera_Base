import { h, icon } from "./dom.ts";
import { t } from "./preferences.ts";

/* Loading placeholders. A screen whose content has not arrived yet shows grey
 * shapes where that content will stand, never a sentence about loading. Each
 * placeholder is one status element whose only text, what is loading, is
 * visually hidden: a screen reader reads it, the eye sees only the shapes. The
 * shapes breathe; reduced motion keeps them still (app.css). The thread and rail
 * shapes stand on the real geometry, so the header, messages, composer and rail
 * rows land where their placeholders stood. */

let breathing = false;

/** app.css's skeleton-breathe duration. */
const BREATH_MS = 1800;

/** Every shape breathes on the document's clock, so a shape that starts later
 * (built by a redraw, or shown when the phone's rail drawer opens) joins the
 * others mid-breath instead of starting over. A shape is built already in step
 * (its delay), and set in step again when its breath actually starts (a hidden
 * shape starts only when shown). */
function breatheTogether(): void {
	if (breathing) return;
	breathing = true;
	document.addEventListener("animationstart", (event) => {
		if (event.animationName !== "skeleton-breathe" || !(event.target instanceof Element)) return;
		for (const animation of event.target.getAnimations?.() ?? [])
			if ("animationName" in animation && animation.animationName === "skeleton-breathe") {
				// Its own delay already carries the phase it was built with; the start undoes it.
				const delay = Number(animation.effect?.getTiming().delay ?? 0);
				animation.startTime = delay ? -delay : 0;
			}
	});
}

function shape(...kinds: string[]): HTMLElement {
	breatheTogether();
	const element = h("span", { class: ["skeleton", ...kinds.map((kind) => `skeleton-${kind}`)].join(" ") });
	const now = Number(document.timeline?.currentTime ?? performance.now());
	element.style.animationDelay = `${-(now % BREATH_MS)}ms`;
	return element;
}

function placeholder(label: string, className: string, ...children: HTMLElement[]): HTMLElement {
	return h(
		"div",
		{ class: `skeleton-group ${className}`, role: "status" },
		h("span", { class: "visually-hidden" }, label),
		...children,
	);
}

/** Nothing to show yet, not even a shape: the app before it knows who is signed in. */
export function blankSkeleton(label: string): HTMLElement {
	return placeholder(label, "skeleton-blank");
}

/** A thread's messages: agent bubbles on the left, one of the member's on the right. */
export function messagesSkeleton(label = t("Loading conversation")): HTMLElement {
	const bubble = (side: "agent" | "mine", width: string) =>
		h("div", { class: `skeleton-message skeleton-message-${side} skeleton-w-${width}` }, shape("bubble"));
	return placeholder(
		label,
		"skeleton-messages",
		bubble("agent", "52"),
		bubble("agent", "34"),
		bubble("mine", "40"),
		bubble("agent", "62"),
		bubble("agent", "28"),
	);
}

/** The thread header's figure and name. */
export function threadIdentitySkeleton(): HTMLElement[] {
	return [shape("disc", "identity-figure"), shape("line", "identity-name")];
}

/** The composer's field, where a thread's composer will stand. */
export function composerSkeleton(): HTMLElement {
	return h("footer", { class: "composer skeleton-composer" }, shape("composer-field"));
}

/** A whole thread, for a company or conversation that is still opening. On a
 * phone its header carries the real button that opens the company's rail, as an
 * open conversation's does, so the rail is never out of reach while it loads. */
export function threadSkeleton(label: string, navigation?: { open: boolean; toggle: () => void }): HTMLElement {
	return h(
		"section",
		{ class: "thread thread-skeleton" },
		h(
			"div",
			{ class: "thread-body" },
			h(
				"div",
				{ class: "thread-conversation" },
				h(
					"header",
					{ class: "thread-header" },
					navigation
						? h(
								"button",
								{
									type: "button",
									class: "mobile-navigation-toggle icon-button",
									"aria-label": t("Company navigation"),
									"aria-controls": "company-navigation",
									"aria-expanded": String(navigation.open),
									onclick: navigation.toggle,
								},
								icon("navigation"),
							)
						: null,
					h("div", { class: "skeleton-identity" }, ...threadIdentitySkeleton()),
				),
				h("div", { class: "messages" }, messagesSkeleton(label)),
				composerSkeleton(),
			),
		),
	);
}

/** A figure beside a name and a detail line; `kind` picks the row's measures in app.css. */
function figureRow(kind: "rail" | "list", name: string, detail: string): HTMLElement {
	return h(
		"div",
		{ class: `skeleton-${kind}-row` },
		shape("disc", `${kind}-figure`),
		h("div", { class: "skeleton-stack" }, shape("line", `w-${name}`), shape("line", "small", `w-${detail}`)),
	);
}

/** The rail's list: the Co-Founder's tier, then agent rows. */
export function railListSkeleton(label = t("Loading agents")): HTMLElement {
	return placeholder(
		label,
		"skeleton-rail",
		h(
			"div",
			{ class: "skeleton-rail-cofounder" },
			shape("disc", "cofounder-figure"),
			shape("line", "cofounder-name"),
		),
		figureRow("rail", "40", "58"),
		figureRow("rail", "28", "46"),
		figureRow("rail", "46", "52"),
		figureRow("rail", "34", "40"),
		figureRow("rail", "52", "34"),
	);
}

/** The whole rail, before the company's own rail exists: search field, list and account. */
export function railSkeleton(label = t("Opening company")): HTMLElement[] {
	return [
		h("div", { class: "rail-toolbar" }, shape("rail-search")),
		h("div", { class: "rail-scroll" }, railListSkeleton(label)),
		h(
			"div",
			{ class: "rail-footer skeleton-rail-account" },
			shape("disc", "account-chip"),
			shape("line", "account-name"),
		),
	];
}

/** A list of people or items: a round figure beside a name and a detail line. */
export function listSkeleton(label: string, rows = 3): HTMLElement {
	const widths: [string, string][] = [
		["34", "52"],
		["46", "40"],
		["28", "58"],
		["40", "46"],
	];
	return placeholder(
		label,
		"skeleton-list",
		...Array.from({ length: rows }, (_, index) => {
			const [name, detail] = widths[index % widths.length]!;
			return figureRow("list", name, detail);
		}),
	);
}

/** Lines of text, for a block of a page that is still being read. */
export function linesSkeleton(label: string): HTMLElement {
	return placeholder(label, "skeleton-lines", shape("line", "w-92"), shape("line", "w-84"), shape("line", "w-62"));
}

/** A page: its title, a paragraph and a few cards. */
export function pageSkeleton(label: string): HTMLElement {
	return placeholder(
		label,
		"skeleton-page",
		shape("line", "title"),
		h("div", { class: "skeleton-stack" }, shape("line", "w-92"), shape("line", "w-84"), shape("line", "w-52")),
		shape("card"),
		shape("card"),
		shape("card"),
	);
}

/** The company list's tiles: a stage and a name each. */
export function companyCardsSkeleton(label = t("Loading companies"), count = 3): HTMLElement {
	return placeholder(
		label,
		"company-grid skeleton-companies",
		...Array.from({ length: count }, () =>
			h("div", { class: "skeleton-company-card" }, shape("company-stage"), shape("line", "company-name")),
		),
	);
}
