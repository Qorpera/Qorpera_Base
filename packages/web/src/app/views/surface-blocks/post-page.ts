import type { SurfaceReportSource } from "@qorpera/contracts";
import { formatPresentationDate, h } from "../../../ui/dom.ts";
import { markdown } from "../../../ui/markdown.ts";
import { t } from "../../../ui/preferences.ts";
import { sameValue } from "./context.ts";
import { type ReportDocument, type ReportSection, renderReportBlock } from "./report-document.ts";

export type PostPageAttrs = Readonly<Record<string, string>>;

export interface PostPageRelated {
	readonly title: string;
	readonly meta: string;
	readonly attrs: PostPageAttrs;
}

export interface PostPageInput {
	readonly doc: ReportDocument;
	readonly signal: AbortSignal;
	readonly number?: string;
	readonly back?: { readonly label: string; readonly attrs: PostPageAttrs };
	readonly themeAttrs?: PostPageAttrs;
	readonly basis?: string;
	readonly related?: readonly PostPageRelated[];
}

export interface PostPage {
	readonly root: HTMLElement;
	readonly article: HTMLElement;
	readonly sectionTasks: readonly (() => HTMLElement)[];
}

interface PostPageState {
	readonly sources: ReadonlyMap<number, SurfaceReportSource>;
	readonly signal: AbortSignal;
	popover: AbortController | null;
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_MARK = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;
const SVG_NS = "http://www.w3.org/2000/svg";
const RELATED_NODES: readonly (readonly [number, number])[] = [
	[30, 22],
	[170, 30],
	[104, 96],
	[38, 88],
	[166, 86],
	[100, 12],
];
const pages = new WeakMap<HTMLElement, PostPageState>();

export function postDay(text: string): string {
	if (!CALENDAR_DAY.test(text)) return text;
	const date = new Date(`${text}T00:00:00Z`);
	return Number.isNaN(date.getTime()) ? text : formatPresentationDate(date, "full-date", undefined, "UTC");
}

export function sourcesLabel(count: number): string {
	return count === 1 ? t("1 source") : t("{count} sources", { count });
}

function changedPill(): HTMLElement {
	return h("span", { class: "studio-changed-pill" }, t("Updated"));
}

function linkSourceMarks(root: HTMLElement, known: ReadonlyMap<number, SurfaceReportSource>): void {
	if (known.size === 0) return;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const texts: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.parentElement?.closest("a, code, pre, button, svg, .po-srcs")) texts.push(node as Text);
	}
	for (const text of texts) {
		const parts: (string | HTMLElement)[] = [];
		let last = 0;
		for (const match of text.data.matchAll(SOURCE_MARK)) {
			const numbers = (match[1] as string).split(",").map((part) => Number(part.trim()));
			if (!numbers.every((n) => known.has(n))) continue;
			const before = text.data.slice(last, match.index).replace(/[ \t]+$/, "");
			if (before) parts.push(before);
			for (const n of numbers) {
				parts.push(
					h(
						"button",
						{
							type: "button",
							class: "po-src",
							"data-act": "post-source",
							"data-src": String(n),
							"aria-label": t("Source {n}", { n }),
						},
						String(n),
					),
				);
			}
			last = match.index + match[0].length;
		}
		if (parts.length === 0) continue;
		const after = text.data.slice(last);
		if (after) parts.push(after);
		text.replaceWith(...parts);
	}
}

function section(
	key: string,
	title: string,
	changed: boolean,
	extraClass: string,
	body: readonly Node[],
	kicker?: string,
): HTMLElement {
	return h(
		"section",
		{
			class: `po-sec${extraClass ? ` ${extraClass}` : ""}${changed ? " is-changed" : ""}`,
			"data-post-section": key,
		},
		kicker ? h("span", { class: "report-kicker" }, kicker) : null,
		h("h2", null, title, changed ? changedPill() : null),
		...body,
	);
}

function figure(block: NonNullable<ReportSection["blocks"]>[number]): HTMLElement {
	const drawn = renderReportBlock(block);
	if (block.kind === "quote" || block.kind === "callout") return drawn;
	const caption = [...drawn.children].find((child) => child.tagName === "FIGCAPTION");
	caption?.remove();
	return h(
		"figure",
		{ class: "po-fig" },
		h("div", { class: "po-tray" }, drawn),
		caption ? h("figcaption", null, [...caption.childNodes]) : null,
	);
}

function bodySection(key: string, part: ReportSection, base: ReportSection | undefined): HTMLElement {
	return section(
		key,
		part.heading,
		Boolean(base && !sameValue(base, part)),
		"",
		[
			...(part.paragraphs.length
				? [
						h(
							"div",
							{ class: "po-prose" },
							part.paragraphs.map((paragraph) => markdown(paragraph)),
						),
					]
				: []),
			...(part.blocks ?? []).map(figure),
		],
		part.kicker,
	);
}

function sourceLine(source: SurfaceReportSource): HTMLElement {
	return h(
		"li",
		{ "data-source": String(source.n) },
		h("span", null, String(source.n)),
		h(
			"div",
			null,
			h("b", null, `${source.publisher}.`),
			` ${source.title}. `,
			h(
				"em",
				null,
				source.kind
					? t("{kind}, opened {day}.", { kind: source.kind, day: postDay(source.opened) })
					: t("Opened {day}.", { day: postDay(source.opened) }),
			),
			h("a", { href: source.url, target: "_blank", rel: "noopener noreferrer" }, source.url),
		),
	);
}

function relatedGraph(count: number): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 200 112");
	svg.setAttribute("aria-hidden", "true");
	const nodes = RELATED_NODES.slice(0, count);
	for (const [x, y] of nodes) {
		const line = document.createElementNS(SVG_NS, "path");
		line.setAttribute("d", `M100 54L${x} ${y}`);
		line.setAttribute("class", "po-rel-line");
		svg.append(line);
	}
	for (const [x, y] of nodes) {
		const dot = document.createElementNS(SVG_NS, "circle");
		dot.setAttribute("cx", String(x));
		dot.setAttribute("cy", String(y));
		dot.setAttribute("r", "9");
		dot.setAttribute("class", "po-rel-dot");
		svg.append(dot);
	}
	const self = document.createElementNS(SVG_NS, "circle");
	self.setAttribute("cx", "100");
	self.setAttribute("cy", "54");
	self.setAttribute("r", "13");
	self.setAttribute("class", "po-rel-self");
	svg.append(self);
	return svg;
}

function watchContents(root: HTMLElement, signal: AbortSignal): void {
	if (typeof IntersectionObserver !== "function") return;
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const key = (entry.target as HTMLElement).dataset.postSection;
				for (const link of root.querySelectorAll<HTMLElement>(".po-toc button")) {
					link.classList.toggle("is-on", link.dataset.target === key);
				}
			}
		},
		{ rootMargin: "-10% 0px -70% 0px" },
	);
	signal.addEventListener("abort", () => observer.disconnect(), { once: true });
	const seen = new WeakSet<Element>();
	const watch = () => {
		for (const part of root.querySelectorAll("[data-post-section]")) {
			if (seen.has(part)) continue;
			seen.add(part);
			observer.observe(part);
		}
	};
	const added = new MutationObserver(watch);
	added.observe(root, { childList: true, subtree: true });
	signal.addEventListener("abort", () => added.disconnect(), { once: true });
	watch();
}

export function buildPostPage(input: PostPageInput): PostPage {
	const { doc } = input;
	const evidence = doc.evidence;
	const base = doc.base?.evidence;
	const sources = new Map((evidence?.sources ?? []).map((source) => [source.n, source]));
	const parts: { readonly key: string; readonly title: string; readonly build: () => HTMLElement }[] = [];
	const linked = (build: () => HTMLElement) => () => {
		const built = build();
		linkSourceMarks(built, sources);
		return built;
	};

	const shortAnswer = evidence?.shortAnswer;
	if (shortAnswer?.length) {
		parts.push({
			key: "short",
			title: t("The short answer"),
			build: linked(() =>
				section(
					"short",
					t("The short answer"),
					Boolean(doc.base && !sameValue(base?.shortAnswer, shortAnswer)),
					"po-answer",
					[
						h(
							"ul",
							{ class: "po-short" },
							shortAnswer.map((claim) => h("li", null, claim)),
						),
					],
				),
			),
		});
	}
	doc.sections.forEach((part, index) => {
		const key = `s-${index}`;
		parts.push({
			key,
			title: part.heading,
			build: linked(() => bodySection(key, part, doc.base?.sections[index])),
		});
	});
	const changes = evidence?.changes;
	if (changes?.length) {
		parts.push({
			key: "changes",
			title: t("What this changes for us"),
			build: linked(() =>
				section(
					"changes",
					t("What this changes for us"),
					Boolean(doc.base && !sameValue(base?.changes, changes)),
					"",
					[
						h(
							"div",
							{ class: "po-change" },
							changes.map((change) => h("div", null, h("small", null, change.page), h("p", null, change.now))),
						),
					],
				),
			),
		});
	}
	const method = evidence?.method;
	if (method?.length) {
		parts.push({
			key: "method",
			title: t("How we found this"),
			build: linked(() =>
				section("method", t("How we found this"), Boolean(doc.base && !sameValue(base?.method, method)), "", [
					h(
						"div",
						{ class: "po-prose" },
						method.map((paragraph) => markdown(paragraph)),
					),
				]),
			),
		});
	}
	const notFound = evidence?.notFound;
	if (notFound?.length) {
		parts.push({
			key: "missing",
			title: t("What we could not find"),
			build: linked(() =>
				section(
					"missing",
					t("What we could not find"),
					Boolean(doc.base && !sameValue(base?.notFound, notFound)),
					"",
					[
						h(
							"ul",
							{ class: "po-miss" },
							notFound.map((item) =>
								h("li", null, h("b", null, item.what), item.note ? h("span", null, item.note) : null),
							),
						),
					],
				),
			),
		});
	}
	if (evidence?.sources?.length) {
		const listed = evidence.sources;
		parts.push({
			key: "sources",
			title: t("Sources"),
			build: () =>
				section("sources", t("Sources"), Boolean(doc.base && !sameValue(base?.sources, listed)), "", [
					h("ol", { class: "po-srcs" }, listed.map(sourceLine)),
				]),
		});
	}

	const themeName = evidence?.theme;
	const subtitleChanged = Boolean(doc.base && doc.base.subtitle !== doc.subtitle);
	const kick = [
		themeName
			? input.themeAttrs
				? h("button", { type: "button", class: "po-kick-theme", ...input.themeAttrs }, themeName)
				: h("span", { class: "po-kick-theme" }, themeName)
			: doc.category
				? h("span", { class: "po-kick-theme" }, doc.category)
				: null,
		input.number ? h("span", null, t("Post {n}", { n: input.number })) : null,
		doc.date ? h("span", null, postDay(doc.date)) : null,
		doc.readingTime ? h("span", null, doc.readingTime) : null,
		doc.changed ? changedPill() : null,
	];
	const article = h(
		"article",
		{ class: "po-main", "data-report-slug": doc.slug },
		h("div", { class: "po-kick" }, kick),
		h("h1", { class: "po-title" }, doc.headline),
		doc.subtitle ? h("p", { class: `po-dek${subtitleChanged ? " is-changed" : ""}` }, doc.subtitle) : null,
		doc.keyMetrics.length
			? h(
					"div",
					{ class: "report-metrics" },
					doc.keyMetrics.map((metric, index) => {
						const before = doc.base?.keyMetrics[index];
						const changed = Boolean(before && (before.value !== metric.value || before.delta !== metric.delta));
						return h(
							"div",
							{ class: `report-metric${changed ? " is-changed" : ""}` },
							h("small", null, metric.label),
							h("strong", null, metric.value),
							metric.delta ? h("span", null, metric.delta) : null,
						);
					}),
				)
			: null,
	);

	const checked = [...sources.values()].reduce(
		(latest, source) => (source.checked > latest ? source.checked : latest),
		"",
	);
	const about: (readonly [string, string])[] = [];
	if (doc.date) about.push([t("Published"), postDay(doc.date)]);
	if (themeName) about.push([t("Theme"), themeName]);
	else if (doc.author) about.push([t("Written by"), doc.author]);
	if (sources.size > 0) about.push([t("Sources"), String(sources.size)]);
	if (input.basis) about.push([t("Rests on"), input.basis]);
	if (checked) about.push([t("Checked"), postDay(checked)]);
	const related = input.related ?? [];
	const rail = h(
		"aside",
		{ class: "po-rail" },
		parts.length >= 2
			? h(
					"div",
					{ class: "po-tocwrap" },
					h("h4", null, t("In this post")),
					h(
						"nav",
						{ class: "po-toc" },
						parts.map((part, index) =>
							h(
								"button",
								{
									type: "button",
									class: index === 0 ? "is-on" : "",
									"data-act": "post-jump",
									"data-target": part.key,
								},
								h("i", null, String(index + 1).padStart(2, "0")),
								h("span", null, part.title),
							),
						),
					),
				)
			: null,
		about.length
			? h(
					"div",
					null,
					h("h4", null, t("About")),
					h(
						"dl",
						{ class: "po-meta" },
						about.map(([label, value]) => h("div", null, h("dt", null, label), h("dd", null, value))),
					),
				)
			: null,
		related.length
			? h(
					"div",
					{ class: "po-rel" },
					h("h4", null, t("Related posts")),
					relatedGraph(related.length),
					related.map((post) =>
						h(
							"button",
							{ type: "button", class: "po-rel-card", ...post.attrs },
							h("small", null, post.meta),
							h("span", null, post.title),
						),
					),
				)
			: null,
	);
	const hasRail = rail.childElementCount > 0;
	const root = h(
		"div",
		{ class: "po-page" },
		input.back ? h("button", { type: "button", class: "lib-back", ...input.back.attrs }, input.back.label) : null,
		h("div", { class: `po${hasRail ? "" : " is-plain"}` }, article, hasRail ? rail : null),
	);
	pages.set(root, { sources, signal: input.signal, popover: null });
	if (parts.length >= 2) watchContents(root, input.signal);
	return { root, article, sectionTasks: parts.map((part) => part.build) };
}

function closeSource(root: HTMLElement, state: PostPageState): void {
	state.popover?.abort();
	state.popover = null;
	root.querySelector(".po-srcpop")?.remove();
	for (const mark of root.querySelectorAll(".po-src.is-on")) mark.classList.remove("is-on");
}

function openSource(root: HTMLElement, state: PostPageState, mark: HTMLElement): void {
	const wasOpen = mark.classList.contains("is-on");
	closeSource(root, state);
	const source = state.sources.get(Number(mark.dataset.src));
	if (wasOpen || !source) return;
	mark.classList.add("is-on");
	const popover = h(
		"div",
		{ class: "po-srcpop", role: "note" },
		h(
			"small",
			null,
			source.kind ? t("Source {n} · {kind}", { n: source.n, kind: source.kind }) : t("Source {n}", { n: source.n }),
		),
		h("b", null, `${source.publisher} · ${source.title}`),
		h("p", null, source.backs),
		h("p", null, t("Opened {day}", { day: postDay(source.opened) })),
		h("a", { href: source.url, target: "_blank", rel: "noopener noreferrer" }, source.url),
	);
	root.append(popover);
	const frame = root.getBoundingClientRect();
	const at = mark.getBoundingClientRect();
	const left = Math.max(0, Math.min(at.left - frame.left - 20, frame.width - popover.offsetWidth));
	popover.style.left = `${left}px`;
	popover.style.top = `${at.bottom - frame.top + 8}px`;
	const life = new AbortController();
	state.popover = life;
	const close = () => closeSource(root, state);
	state.signal.addEventListener("abort", close, { once: true, signal: life.signal });
	document.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Escape") close();
		},
		{ signal: life.signal },
	);
	document.addEventListener(
		"click",
		(event) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target?.closest(".po-srcpop, .po-src")) close();
		},
		{ capture: true, signal: life.signal },
	);
	window.addEventListener("resize", close, { signal: life.signal });
}

export function postPageClick(target: HTMLElement, within: HTMLElement): boolean {
	const root = target.closest<HTMLElement>(".po-page");
	const state = root ? pages.get(root) : undefined;
	if (!root || !state || !within.contains(root)) return false;
	if (target.dataset.act === "post-source") {
		openSource(root, state, target);
		return true;
	}
	if (target.dataset.act === "post-jump" && target.dataset.target) {
		const part = [...root.querySelectorAll<HTMLElement>("[data-post-section]")].find(
			(item) => item.dataset.postSection === target.dataset.target,
		);
		part?.scrollIntoView?.({ behavior: "smooth", block: "start" });
		return true;
	}
	return false;
}
