import {
	parseStrategyHypothesesDocument,
	STRATEGY_HYPOTHESIS_STATUSES,
	type StrategyHypothesis,
	type StrategyHypothesisImpact,
	type StrategyHypothesisStatus,
	type SurfaceHypothesesBlock,
} from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import { askButton, kicker, strategyEmpty, tierBadge } from "./strategy-kit.ts";

type HypothesisFilter = "all" | "fatal" | StrategyHypothesisStatus;

const IMPACT_RANK: Readonly<Record<StrategyHypothesisImpact, number>> = { fatal: 0, high: 1, medium: 2 };

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

function designTest(item: StrategyHypothesis) {
	const lines = [
		t("Design the cheapest test for this bet: {bet}", { bet: item.bet }),
		item.killCriteria ? t("Kill criteria so far: {criteria}", { criteria: item.killCriteria }) : "",
		t("Give a test we can run within days, the exact signal to watch, and the result that would kill or confirm it."),
	];
	return { prompt: lines.filter(Boolean).join("\n"), title: t("Design test") };
}

function ledgerItem(item: StrategyHypothesis, ctx: SurfaceBlockContext): HTMLElement {
	const meta = [
		item.evidence ? h("span", null, h("b", null, t("Evidence")), item.evidence) : null,
		item.source ? h("span", null, h("b", null, t("Source")), item.source) : null,
		item.owner ? h("span", null, h("b", null, t("Owner")), item.owner) : null,
	].filter((part): part is HTMLElement => part !== null);
	const ask = askButton(ctx, t("Design test"), () => designTest(item));
	return h(
		"li",
		{
			class: `studio-hyp is-${item.impact} is-${item.status}`,
			"data-hypothesis": item.id,
			"data-impact": item.impact,
			"data-status": item.status,
		},
		h(
			"div",
			{ class: "studio-hyp-tags" },
			h("span", { class: `studio-hyp-impact is-${item.impact}` }, impactLabel(item.impact)),
			h("span", { class: `studio-hyp-status is-${item.status}` }, statusLabel(item.status)),
			tierBadge(item.tier, item.source),
		),
		h("p", { class: "studio-hyp-bet" }, item.bet),
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
		meta.length || ask
			? h("div", { class: "studio-hyp-foot" }, h("div", { class: "studio-hyp-meta" }, meta), ask)
			: null,
	);
}

function ledger(items: readonly StrategyHypothesis[], ctx: SurfaceBlockContext): HTMLElement[] {
	const filters: HypothesisFilter[] = [
		"all",
		...(items.some((item) => item.impact === "fatal") ? (["fatal"] as const) : []),
		...STRATEGY_HYPOTHESIS_STATUSES.filter((status) => items.some((item) => item.status === status)),
	];
	const rows = items.map((item) => ({ item, el: ledgerItem(item, ctx) }));
	let current: HypothesisFilter = "all";
	const pills: HTMLButtonElement[] = filters.map((filter) =>
		h(
			"button",
			{
				type: "button",
				class: `studio-hyp-filter is-${filter}${filter === "all" ? " is-on" : ""}`,
				"data-filter": filter,
				"aria-pressed": String(filter === "all"),
				onclick: () => {
					current = current === filter ? "all" : filter;
					for (const pill of pills) {
						const on = pill.dataset.filter === current;
						pill.classList.toggle("is-on", on);
						pill.setAttribute("aria-pressed", String(on));
					}
					for (const row of rows) row.el.hidden = !matches(current, row.item);
				},
			},
			h("span", null, filterLabel(filter)),
			h("span", { class: "studio-hyp-count" }, String(items.filter((item) => matches(filter, item)).length)),
		),
	);
	return [
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
		.sort((a, b) => IMPACT_RANK[a.item.impact] - IMPACT_RANK[b.item.impact] || a.index - b.index)
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
