import { h } from "./dom.ts";

/* Loading placeholders. A screen whose content has not arrived yet shows grey
 * shapes where that content will stand, never a sentence about loading. Each
 * placeholder is one status element: a screen reader hears its label, the eye
 * sees only the shapes. The shapes breathe; reduced motion keeps them still
 * (app.css). The thread and rail shapes stand on the real geometry, so the
 * header, messages, composer and rail rows land where their placeholders stood. */

/** app.css's skeleton-breathe duration. */
const BREATH_MS = 1800;

function shape(...kinds: string[]): HTMLElement {
	const element = h("span", { class: ["skeleton", ...kinds.map((kind) => `skeleton-${kind}`)].join(" ") });
	// Every shape breathes on one clock, so a placeholder built later (a redraw
	// rebuilds them) joins the others mid-breath instead of starting over.
	element.style.animationDelay = `${-(performance.now() % BREATH_MS)}ms`;
	return element;
}

function placeholder(label: string, className: string, ...children: HTMLElement[]): HTMLElement {
	return h(
		"div",
		{ class: `skeleton-group ${className}`, role: "status", "aria-label": label, "aria-busy": "true" },
		...children,
	);
}

/** Nothing to show yet, not even a shape: the app before it knows who is signed in. */
export function blankSkeleton(label: string): HTMLElement {
	return placeholder(label, "skeleton-blank");
}

/** A thread's messages: agent bubbles on the left, one of the member's on the right. */
export function messagesSkeleton(label = "Loading conversation"): HTMLElement {
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

/** A whole thread, for a company or conversation that is still opening. */
export function threadSkeleton(label: string): HTMLElement {
	const messages = h("div", { class: "messages" }, messagesSkeleton(label));
	return h(
		"section",
		{ class: "thread" },
		h(
			"div",
			{ class: "thread-body" },
			h(
				"div",
				{ class: "thread-conversation" },
				h(
					"header",
					{ class: "thread-header" },
					h("div", { class: "skeleton-identity" }, ...threadIdentitySkeleton()),
				),
				messages,
				composerSkeleton(),
			),
		),
	);
}

/** The rail's list: the Co-Founder's tier, then agent rows. */
export function railListSkeleton(label = "Loading agents"): HTMLElement {
	const row = (name: string, detail: string) =>
		h(
			"div",
			{ class: "skeleton-rail-row" },
			shape("disc", "rail-figure"),
			h("div", { class: "skeleton-stack" }, shape("line", `w-${name}`), shape("line", "small", `w-${detail}`)),
		);
	return placeholder(
		label,
		"skeleton-rail",
		h(
			"div",
			{ class: "skeleton-rail-cofounder" },
			shape("disc", "cofounder-figure"),
			shape("line", "cofounder-name"),
		),
		row("40", "58"),
		row("28", "46"),
		row("46", "52"),
		row("34", "40"),
		row("52", "34"),
	);
}

/** The whole rail, before the company's own rail exists: search field, list and account. */
export function railSkeleton(label = "Opening company"): HTMLElement[] {
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
	const widths = [
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
			return h(
				"div",
				{ class: "skeleton-list-row" },
				shape("disc", "list-figure"),
				h("div", { class: "skeleton-stack" }, shape("line", `w-${name}`), shape("line", "small", `w-${detail}`)),
			);
		}),
	);
}

/** Lines of text, for a block of a page that is still being read. */
export function linesSkeleton(label: string): HTMLElement {
	return placeholder(label, "skeleton-lines", shape("line", "w-92"), shape("line", "w-84"), shape("line", "w-62"));
}

/** A column of cards, for a list of cards still being gathered. */
export function cardsSkeleton(label: string): HTMLElement {
	return placeholder(label, "skeleton-cards", shape("card"), shape("card"), shape("card"));
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

/** The company list's cards. */
export function companyCardsSkeleton(label = "Loading companies", count = 3): HTMLElement {
	return placeholder(
		label,
		"company-grid skeleton-companies",
		...Array.from({ length: count }, () =>
			h(
				"div",
				{ class: "skeleton-company-card" },
				shape("disc", "company-logo"),
				shape("line", "company-name"),
				shape("line", "small", "company-meta"),
			),
		),
	);
}
