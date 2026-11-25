import {
	parseStrategyPlaysDocument,
	type StrategyPlay,
	type StrategyPlayStatus,
	type SurfacePlaysBlock,
} from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import { askButton, kicker, strategyEmpty, tierBadge } from "./strategy-kit.ts";

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

function playFacts(play: StrategyPlay): HTMLElement | null {
	const rows: [string, string | undefined][] = [
		[t("Who pays"), play.whoPays],
		[t("Revenue model"), play.revenueModel],
		[t("Unit margin"), play.unitMargin],
		[t("Capacity ceiling"), play.capacityCeiling],
		[t("Moat"), play.moat],
	];
	const shown = rows.filter((row): row is [string, string] => row[1] !== undefined);
	if (shown.length === 0) return null;
	return h(
		"dl",
		{ class: "studio-play-facts" },
		shown.map(([label, value]) =>
			h("div", { class: "studio-play-fact" }, h("dt", null, label), h("dd", null, value)),
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

function playCard(play: StrategyPlay, ctx: SurfaceBlockContext): HTMLElement {
	const pros = playList("pros", t("Pros"), play.pros);
	const cons = playList("cons", t("Cons"), play.cons);
	const ask = askButton(ctx, t("Stress-test play"), () => stressTest(play));
	return h(
		"article",
		{ class: `studio-play is-${play.status}`, "data-play": play.id },
		h(
			"header",
			{ class: "studio-play-top" },
			h("span", { class: `studio-play-status is-${play.status}` }, statusLabel(play.status)),
			tierBadge(play.tier, play.source),
		),
		h("h3", { class: "studio-play-name" }, play.name),
		h("p", { class: "studio-play-thesis" }, play.thesis),
		playFacts(play),
		play.killRisk
			? h("div", { class: "studio-play-kill" }, kicker(t("Kill risk")), h("p", null, play.killRisk))
			: null,
		play.nextMove
			? h("div", { class: "studio-play-next" }, kicker(t("Next move")), h("p", null, play.nextMove))
			: null,
		pros || cons ? h("div", { class: "studio-play-pc" }, pros, cons) : null,
		ask ? h("footer", { class: "studio-play-foot" }, ask) : null,
	);
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
	return {
		filled: true,
		pieces: [
			{
				build: () =>
					h(
						"section",
						{ class: "studio-section studio-plays", "data-block": "plays" },
						sectionHead(heading, read.changed),
						doc.verdict || doc.summary
							? h(
									"div",
									{ class: "studio-plays-thesis" },
									doc.verdict
										? h(
												"div",
												{ class: "studio-plays-verdict" },
												kicker(t("Verdict")),
												h("p", null, doc.verdict),
											)
										: null,
									doc.summary ? h("p", { class: "studio-plays-summary" }, doc.summary) : null,
								)
							: null,
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
