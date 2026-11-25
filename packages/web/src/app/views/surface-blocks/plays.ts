import {
	parseStrategyPlaysDocument,
	type StrategyPlay,
	type StrategyPlayStatus,
	type SurfacePlaysBlock,
} from "@qorpera/contracts";
import { h, icon } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import { askButton, disclosure, kicker, panelId, strategyEmpty, tierMark } from "./strategy-kit.ts";

const STATUS_RANK: Readonly<Record<StrategyPlayStatus, number>> = {
	recommended: 0,
	active: 1,
	exploring: 2,
	parked: 3,
	rejected: 4,
};

function statusLabel(status: StrategyPlayStatus): string {
	switch (status) {
		case "recommended":
			return t("Recommended");
		case "active":
			return t("Active");
		case "exploring":
			return t("Exploring");
		case "parked":
			return t("Parked");
		default:
			return t("Rejected");
	}
}

function playChips(play: StrategyPlay): HTMLElement | null {
	const facts: [string, string, string | undefined][] = [
		["pays", t("Who pays"), play.whoPays],
		["margin", t("Unit margin"), play.unitMargin],
		["ceiling", t("Capacity ceiling"), play.capacityCeiling],
	];
	const shown = facts.filter((fact): fact is [string, string, string] => fact[2] !== undefined);
	if (shown.length === 0) return null;
	return h(
		"ul",
		{ class: "studio-play-chips" },
		shown.map(([key, label, value]) =>
			h(
				"li",
				{ class: `studio-play-chip is-${key}`, title: `${label}: ${value}` },
				h("span", { class: "studio-play-chip-label" }, label),
				" ",
				h("span", { class: "studio-play-chip-value" }, value),
			),
		),
	);
}

function playList(kind: "pros" | "cons", title: string, items: readonly string[] | undefined): HTMLElement | null {
	if (!items?.length) return null;
	return h(
		"div",
		{ class: `studio-play-list is-${kind}` },
		h("h4", null, title),
		h(
			"ul",
			null,
			items.map((item) => h("li", null, item)),
		),
	);
}

function stressTest(play: StrategyPlay) {
	const lines = [
		t("Stress-test the play “{name}”.", { name: play.name }),
		t("Thesis: {thesis}", { thesis: play.thesis }),
		play.killRisk ? t("Named kill risk: {risk}", { risk: play.killRisk }) : "",
		t(
			"Pressure-test its unit economics, the strongest rival's likely response and the kill risk, then say plainly whether it should keep its place.",
		),
	];
	return { prompt: lines.filter(Boolean).join("\n"), title: t("Stress-test {name}", { name: play.name }) };
}

function playDetails(play: StrategyPlay, ctx: SurfaceBlockContext): HTMLElement | null {
	const facts: [string, string | undefined][] = [
		[t("Revenue model"), play.revenueModel],
		[t("Moat"), play.moat],
	];
	const shown = facts.filter((fact): fact is [string, string] => fact[1] !== undefined);
	const pros = playList("pros", t("Pros"), play.pros);
	const cons = playList("cons", t("Cons"), play.cons);
	const ask = askButton(ctx, t("Stress-test"), () => stressTest(play));
	const parts = [
		shown.length
			? h(
					"dl",
					{ class: "studio-play-facts" },
					shown.map(([label, value]) =>
						h("div", { class: "studio-play-fact" }, h("dt", null, label), h("dd", null, value)),
					),
				)
			: null,
		pros || cons ? h("div", { class: "studio-play-pc" }, pros, cons) : null,
		play.nextMove
			? h("div", { class: "studio-play-next" }, kicker(t("Next move")), h("p", null, play.nextMove))
			: null,
		play.source ? h("p", { class: "studio-play-source" }, h("b", null, t("Source")), " ", play.source) : null,
		ask ? h("div", { class: "studio-play-foot" }, ask) : null,
	].filter((part) => part !== null);
	if (parts.length === 0) return null;
	return h("div", { class: "studio-play-details", id: panelId("studio-play-details"), hidden: true }, parts);
}

function playCard(play: StrategyPlay, ctx: SurfaceBlockContext): HTMLElement {
	const details = playDetails(play, ctx);
	const toggle = details
		? h(
				"button",
				{ type: "button", class: "studio-play-more", "aria-expanded": "false", "aria-controls": details.id },
				h("span", null, t("Details")),
				icon("chevron-down"),
			)
		: null;
	const card = h(
		"article",
		{ class: `studio-play is-${play.status}`, "data-play": play.id },
		h(
			"header",
			{ class: "studio-play-top" },
			h("span", { class: `studio-play-status is-${play.status}` }, statusLabel(play.status)),
			tierMark(play.tier, play.source),
		),
		h("h3", { class: "studio-play-name" }, play.name),
		h("p", { class: "studio-play-thesis" }, play.thesis),
		playChips(play),
		play.killRisk
			? h(
					"p",
					{ class: "studio-play-kill" },
					h("i", { class: "studio-play-kill-dot", "aria-hidden": "true" }),
					h("span", { class: "studio-play-kill-label" }, t("Kill risk")),
					" ",
					h("span", { class: "studio-play-kill-text", title: play.killRisk }, play.killRisk),
				)
			: null,
		toggle,
		details,
	);
	if (toggle && details) {
		toggle.addEventListener("click", () => {
			const open = details.hidden;
			disclosure(toggle, details, open);
			card.classList.toggle("is-open", open);
		});
	}
	return card;
}

export function preparePlays(block: SurfacePlaysBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const doc = read.found ? parseStrategyPlaysDocument(read.value) : null;
	const heading = block.heading ? ctx.words(block.heading) : t("Competing plays");
	if (!doc) {
		return {
			filled: false,
			pieces: [
				{
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-plays", "data-block": "plays" },
							sectionHead(heading, false),
							strategyEmpty(
								"plays",
								t("No plays on the board yet"),
								t(
									"Two to four competing ways to win, side by side: who pays, the margin, the moat and what would kill each one.",
								),
								askButton(ctx, t("Draft competing plays"), () => ({
									prompt: t(
										"Draft two to four genuinely competing plays for how this company wins. Research the real rivals first, compare who pays, unit margin, capacity ceiling, moat and kill risk, and recommend one.",
									),
									title: t("Draft competing plays"),
								})),
							),
						),
				},
			],
		};
	}
	const plays = doc.plays
		.map((play, index) => ({ play, index }))
		.sort((a, b) => STATUS_RANK[a.play.status] - STATUS_RANK[b.play.status] || a.index - b.index)
		.map(({ play }) => play);
	const lead = doc.verdict ?? doc.summary;
	return {
		filled: true,
		pieces: [
			{
				build: () =>
					h(
						"section",
						{ class: "studio-section studio-plays", "data-block": "plays" },
						sectionHead(heading, read.changed),
						lead ? h("p", { class: "studio-plays-verdict" }, lead) : null,
						h(
							"div",
							{ class: "studio-plays-grid" },
							plays.map((play) => playCard(play, ctx)),
						),
					),
			},
		],
	};
}
