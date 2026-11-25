import {
	parseStrategyHypothesesDocument,
	STRATEGY_HYPOTHESIS_STATUSES,
	type StrategyHypothesis,
	type StrategyHypothesisImpact,
	type StrategyHypothesisStatus,
	type SurfaceHypothesesBlock,
} from "@qorpera/contracts";
import { h, icon } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import { askButton, kicker, panelId, strategyEmpty, svgEl, tierMark } from "./strategy-kit.ts";

type HypothesisFilter = "all" | "fatal" | StrategyHypothesisStatus;

interface Row {
	readonly item: StrategyHypothesis;
	readonly el: HTMLElement;
	readonly head: HTMLButtonElement;
	readonly body: HTMLElement;
}

interface TrackNode {
	readonly id: string;
	readonly el: SVGGElement;
}

const IMPACT_RANK: Readonly<Record<StrategyHypothesisImpact, number>> = { fatal: 0, high: 1, medium: 2 };
const TRACK = { width: 760, height: 130, side: 54, y: 46, r: 13 } as const;

function impactLabel(impact: StrategyHypothesisImpact): string {
	switch (impact) {
		case "fatal":
			return t("Fatal");
		case "high":
			return t("High");
		default:
			return t("Medium");
	}
}

function statusLabel(status: StrategyHypothesisStatus): string {
	switch (status) {
		case "untested":
			return t("Untested");
		case "testing":
			return t("Testing");
		case "proven":
			return t("Proven");
		default:
			return t("Falsified");
	}
}

function filterLabel(filter: HypothesisFilter): string {
	if (filter === "all") return t("All");
	if (filter === "fatal") return t("Fatal");
	return statusLabel(filter);
}

function matches(filter: HypothesisFilter, item: StrategyHypothesis): boolean {
	if (filter === "all") return true;
	if (filter === "fatal") return item.impact === "fatal";
	return item.status === filter;
}

function betTag(index: number): string {
	return t("B{number}", { number: String(index + 1) });
}

function isOpen(item: StrategyHypothesis): boolean {
	return item.status === "untested" || item.status === "testing";
}

function designTest(item: StrategyHypothesis) {
	const lines = [
		t("Design the cheapest test for this bet: {bet}", { bet: item.bet }),
		item.killCriteria ? t("Kill criteria so far: {criteria}", { criteria: item.killCriteria }) : "",
		t("Give a test we can run within days, the exact signal to watch, and the result that would kill or confirm it."),
	];
	return { prompt: lines.filter(Boolean).join("\n"), title: t("Design test") };
}

function linkTone(from: StrategyHypothesis, to: StrategyHypothesis): string {
	if (to.status === "untested") return "is-fog";
	if (from.status === "proven") return "is-proven";
	if (from.status === "testing") return "is-testing";
	return "is-quiet";
}

function nodeMark(item: StrategyHypothesis, cx: number, cy: number): SVGElement[] {
	const r = TRACK.r;
	switch (item.status) {
		case "proven":
			return [
				svgEl("circle", { class: "studio-hyp-node-disc", cx, cy, r }),
				svgEl("path", {
					class: "studio-hyp-node-check",
					d: `M${cx - 5.5} ${cy + 0.5} L${cx - 1.5} ${cy + 4.5} L${cx + 6} ${cy - 4}`,
				}),
			];
		case "testing":
			return [
				svgEl("circle", { class: "studio-hyp-node-halo", cx, cy, r: r + 6 }),
				svgEl("circle", { class: "studio-hyp-node-disc", cx, cy, r }),
				svgEl("circle", { class: "studio-hyp-node-core", cx, cy, r: 5 }),
			];
		case "falsified":
			return [
				svgEl("circle", { class: "studio-hyp-node-disc", cx, cy, r }),
				svgEl("text", { class: "studio-hyp-node-glyph", x: cx, y: cy + 5, "text-anchor": "middle" }, "×"),
			];
		default:
			return [
				...(item.impact === "fatal"
					? [svgEl("circle", { class: "studio-hyp-node-danger", cx, cy, r: r + 6 })]
					: []),
				svgEl("circle", { class: "studio-hyp-node-disc", cx, cy, r }),
				svgEl("text", { class: "studio-hyp-node-glyph", x: cx, y: cy + 5, "text-anchor": "middle" }, "?"),
			];
	}
}

function proofTrack(
	items: readonly StrategyHypothesis[],
	pick: (id: string) => void,
): { svg: SVGSVGElement; nodes: TrackNode[] } {
	const { width, height, side, y } = TRACK;
	const step = items.length > 1 ? (width - side * 2) / (items.length - 1) : 0;
	const xAt = (index: number) => (items.length > 1 ? side + step * index : width / 2);
	const svg = svgEl("svg", {
		class: "studio-hyp-track-svg",
		viewBox: `0 0 ${width} ${height}`,
		role: "group",
		"aria-label": t("Proof track"),
	});
	for (let index = 0; index + 1 < items.length; index += 1) {
		svg.append(
			svgEl("line", {
				class: `studio-hyp-link ${linkTone(items[index]!, items[index + 1]!)}`,
				x1: xAt(index) + TRACK.r + 4,
				x2: xAt(index + 1) - TRACK.r - 4,
				y1: y,
				y2: y,
			}),
		);
	}
	const nodes = items.map((item, index): TrackNode => {
		const cx = xAt(index);
		const words = `${betTag(index)} · ${impactLabel(item.impact)}`;
		const el = svgEl(
			"g",
			{
				class: `studio-hyp-node is-${item.status} is-${item.impact}`,
				"data-hypothesis": item.id,
				tabindex: 0,
				role: "button",
				"aria-label": `${words}, ${statusLabel(item.status)}: ${item.bet}`,
			},
			svgEl("title", {}, item.bet),
			svgEl("circle", { class: "studio-hyp-node-pick", cx, cy: y, r: TRACK.r + 10 }),
			...nodeMark(item, cx, y),
			svgEl("text", { class: "studio-hyp-node-label", x: cx, y: y + 44, "text-anchor": "middle" }, words),
			svgEl(
				"text",
				{ class: `studio-hyp-node-status is-${item.status}`, x: cx, y: y + 62, "text-anchor": "middle" },
				statusLabel(item.status),
			),
		);
		el.addEventListener("click", () => pick(item.id));
		el.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			pick(item.id);
		});
		svg.append(el);
		return { id: item.id, el };
	});
	return { svg, nodes };
}

function betRow(item: StrategyHypothesis, index: number, ctx: SurfaceBlockContext): Row {
	const meta = [
		h("span", null, h("b", null, t("Status")), " ", statusLabel(item.status)),
		item.evidence ? h("span", null, h("b", null, t("Evidence")), " ", item.evidence) : null,
		item.source ? h("span", null, h("b", null, t("Source")), " ", item.source) : null,
		item.owner ? h("span", null, h("b", null, t("Owner")), " ", item.owner) : null,
	].filter((part): part is HTMLElement => part !== null);
	const ask = askButton(ctx, t("Design test"), () => designTest(item));
	const body = h(
		"div",
		{ class: "studio-hyp-body", id: panelId("studio-hyp-body"), hidden: true },
		h("p", { class: "studio-hyp-bet-full" }, item.bet),
		item.cheapestTest || item.killCriteria
			? h(
					"div",
					{ class: "studio-hyp-tests" },
					item.cheapestTest
						? h(
								"div",
								{ class: "studio-hyp-test is-test" },
								kicker(t("Cheapest test")),
								h("p", null, item.cheapestTest),
							)
						: null,
					item.killCriteria
						? h(
								"div",
								{ class: "studio-hyp-test is-kill" },
								kicker(t("Kill criteria")),
								h("p", null, item.killCriteria),
							)
						: null,
				)
			: null,
		h("div", { class: "studio-hyp-foot" }, h("div", { class: "studio-hyp-meta" }, meta), ask),
	);
	const head = h(
		"button",
		{
			type: "button",
			class: "studio-hyp-row studio-hyp-head",
			"aria-expanded": "false",
			"aria-controls": body.id,
			"data-hypothesis-toggle": item.id,
		},
		h("i", { class: `studio-hyp-dot is-${item.status}`, "aria-hidden": "true" }),
		h("span", { class: "studio-hyp-index" }, betTag(index)),
		h("span", { class: `studio-hyp-impact is-${item.impact}` }, impactLabel(item.impact)),
		h("span", { class: "studio-hyp-bet" }, item.bet),
		tierMark(item.tier, item.source),
		icon("chevron-down"),
	);
	const el = h(
		"li",
		{
			class: `studio-hyp is-${item.impact} is-${item.status}`,
			"data-hypothesis": item.id,
			"data-tour-id": `hypothesis:${item.id}`,
			"data-impact": item.impact,
			"data-status": item.status,
		},
		head,
		body,
	);
	return { item, el, head, body };
}

function ledger(items: readonly StrategyHypothesis[], ctx: SurfaceBlockContext): HTMLElement[] {
	const filters: HypothesisFilter[] = [
		"all",
		...(items.some((item) => item.impact === "fatal") ? (["fatal"] as const) : []),
		...STRATEGY_HYPOTHESIS_STATUSES.filter((status) => items.some((item) => item.status === status)),
	];
	const rows = items.map((item, index) => betRow(item, index, ctx));
	let current: HypothesisFilter = "all";
	let expanded: string | null =
		(items.find((item) => item.impact === "fatal" && isOpen(item)) ?? items[0])?.id ?? null;
	const paint = () => {
		for (const pill of pills) {
			const on = pill.dataset.filter === current;
			pill.classList.toggle("is-on", on);
			pill.setAttribute("aria-pressed", String(on));
		}
		for (const row of rows) {
			const open = row.item.id === expanded;
			row.el.hidden = !matches(current, row.item);
			row.el.classList.toggle("is-expanded", open);
			row.head.setAttribute("aria-expanded", String(open));
			row.body.hidden = !open;
		}
		for (const node of track.nodes) {
			const item = items.find((entry) => entry.id === node.id)!;
			node.el.classList.toggle("is-selected", node.id === expanded);
			node.el.classList.toggle("is-muted", !matches(current, item));
			node.el.setAttribute("aria-pressed", String(node.id === expanded));
		}
	};
	const select = (id: string) => {
		const row = rows.find((entry) => entry.item.id === id);
		if (row && !matches(current, row.item)) current = "all";
		expanded = id;
		paint();
	};
	const track = proofTrack(items, select);
	for (const row of rows) {
		row.head.addEventListener("click", () => {
			expanded = expanded === row.item.id ? null : row.item.id;
			paint();
		});
	}
	const pills: HTMLButtonElement[] = filters.map((filter) =>
		h(
			"button",
			{
				type: "button",
				class: `studio-hyp-filter is-${filter}`,
				"data-filter": filter,
				onclick: () => {
					current = current === filter ? "all" : filter;
					paint();
				},
			},
			h("span", null, filterLabel(filter)),
			h("span", { class: "studio-hyp-count" }, String(items.filter((item) => matches(filter, item)).length)),
		),
	);
	paint();
	return [
		h("figure", { class: "studio-hyp-track", "data-tour-id": "hypotheses:track" }, track.svg),
		h("div", { class: "studio-hyp-filters", role: "group", "aria-label": t("Filter bets") }, pills),
		h(
			"ol",
			{ class: "studio-hyp-list" },
			rows.map((row) => row.el),
		),
	];
}

export function prepareHypotheses(block: SurfaceHypothesesBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const doc = read.found ? parseStrategyHypothesesDocument(read.value) : null;
	const heading = block.heading ? ctx.words(block.heading) : t("Hypotheses");
	const section = (changed: boolean, ...body: (HTMLElement | null)[]) =>
		h(
			"section",
			{ class: "studio-section studio-hyp-block", "data-block": "hypotheses" },
			sectionHead(heading, changed),
			body,
		);
	if (!doc) {
		return {
			filled: false,
			pieces: [
				{
					build: () =>
						section(
							false,
							strategyEmpty(
								"hypotheses",
								t("No bets on the ledger yet"),
								t(
									"Every load-bearing assumption, how bad it is if wrong, the cheapest test and the result that kills it.",
								),
								askButton(ctx, t("List the riskiest bets"), () => ({
									prompt: t(
										"List the load-bearing assumptions behind our plan, rank how fatal each would be if wrong, and give each a cheapest test and explicit kill criteria.",
									),
									title: t("List the riskiest bets"),
								})),
							),
						),
				},
			],
		};
	}
	const items = doc.hypotheses
		.map((item, index) => ({ item, index }))
		.sort(
			(a, b) =>
				IMPACT_RANK[a.item.impact] - IMPACT_RANK[b.item.impact] ||
				Number(!isOpen(a.item)) - Number(!isOpen(b.item)) ||
				a.index - b.index,
		)
		.map(({ item }) => item);
	return {
		filled: true,
		pieces: [
			{
				build: () =>
					section(
						read.changed,
						doc.summary ? h("p", { class: "studio-hyp-summary" }, doc.summary) : null,
						...ledger(items, ctx),
					),
			},
		],
	};
}
