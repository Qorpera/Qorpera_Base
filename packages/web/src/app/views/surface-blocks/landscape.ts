import {
	parseStrategyLandscapeDocument,
	type StrategyLandscapeAxes,
	type StrategyLandscapeDocument,
	type StrategyRival,
	type SurfaceLandscapeBlock,
} from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import type * as StrategyCharts from "./strategy-charts.ts";
import type { LandscapeData, LandscapeMount } from "./strategy-charts.ts";
import { askButton, kicker, strategyEmpty, tierMark } from "./strategy-kit.ts";

interface KeyedRival extends StrategyRival {
	readonly key: string;
}

interface PlacedRival extends KeyedRival {
	readonly x: number;
	readonly y: number;
}

interface Focus {
	readonly hover: (key: string | null) => void;
	readonly pick: (key: string) => void;
}

let chartsLoading: Promise<typeof StrategyCharts> | undefined;

function loadCharts(): Promise<typeof StrategyCharts> {
	chartsLoading ??= import("./strategy-charts.ts").catch((error: unknown) => {
		chartsLoading = undefined;
		throw error;
	});
	return chartsLoading;
}

function safeUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return /^https?:\/\//i.test(url) ? url : undefined;
}

function research(players: readonly StrategyRival[]) {
	const names = players.filter((player) => !player.isUs).map((player) => player.name);
	const lines = [
		t(
			"Research the competitive landscape: verify each rival's current pricing, positioning and target customer from their own sites, add any serious rival or substitute we are missing, and sharpen our edge against each.",
		),
		names.length ? t("Rivals mapped so far: {names}.", { names: names.join(", ") }) : "",
	];
	return { prompt: lines.filter(Boolean).join("\n"), title: t("Research rivals") };
}

function mapData(axes: StrategyLandscapeAxes, placed: readonly PlacedRival[]): LandscapeData {
	return {
		axes,
		points: placed.map((player) => ({
			key: player.key,
			name: player.name,
			x: Math.min(100, Math.max(0, player.x)),
			y: Math.min(100, Math.max(0, player.y)),
			isUs: player.isUs === true,
			...(player.category ? { category: player.category } : {}),
			...(player.pricing ? { pricing: player.pricing } : {}),
			...(player.ourEdge ? { ourEdge: player.ourEdge } : {}),
		})),
	};
}

function positioningMap(
	axes: StrategyLandscapeAxes,
	placed: readonly PlacedRival[],
	steer: Focus,
	ctx: SurfaceBlockContext,
	active: () => string,
): { readonly el: HTMLElement; readonly setActive: (key: string) => void } {
	const host = h("div", {
		class: "studio-land-chart-host is-loading",
		role: "img",
		"aria-label": t("Positioning map: {x} against {y}", { x: axes.xLabel, y: axes.yLabel }),
	});
	let mount: LandscapeMount | null = null;
	const chartSignal = ctx.renderSignal ?? ctx.signal;
	loadCharts().then(
		(lib) => {
			if (chartSignal.aborted) return;
			host.classList.remove("is-loading");
			mount = lib.mountLandscapeChart(host, chartSignal, mapData(axes, placed), {
				active: active(),
				labels: { category: t("Category"), pricing: t("Pricing"), ourEdge: t("Our edge"), us: t("Us") },
				onHover: (key) => steer.hover(key),
				onPick: (key) => steer.pick(key),
			});
			host.dataset.chart = "landscape";
		},
		() => {
			if (chartSignal.aborted) return;
			host.classList.remove("is-loading");
			host.replaceChildren(h("p", { class: "studio-land-chart-note" }, t("The chart couldn't load.")));
		},
	);
	return {
		el: h("figure", { class: "studio-land-map", "data-tour-id": "landscape:map" }, host),
		setActive: (key) => mount?.setActive(key),
	};
}

function beat(kind: string, label: string, body: HTMLElement | string, extra: HTMLElement | null = null): HTMLElement {
	return h(
		"div",
		{ class: `studio-land-beat is-${kind}` },
		kicker(label),
		typeof body === "string" ? h("p", null, body) : body,
		extra,
	);
}

function inspector(player: KeyedRival): HTMLElement[] {
	const url = safeUrl(player.url);
	const name = url
		? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "studio-land-name-link" }, player.name)
		: h("strong", { class: "studio-land-focus-name" }, player.name);
	const tag = player.isUs
		? h("span", { class: "studio-land-us" }, t("Us"))
		: player.category
			? h("span", { class: "studio-land-category" }, player.category)
			: null;
	const price = player.pricing ? h("span", { class: "studio-land-price" }, player.pricing) : null;
	const target = player.target ? h("span", { class: "studio-land-target" }, player.target) : null;
	const where =
		player.positioning || price || target
			? beat(
					"position",
					t("Positioning"),
					player.positioning ?? "",
					price || target ? h("div", { class: "studio-land-meta" }, price, target) : null,
				)
			: null;
	const contrast =
		player.strength || player.weakness
			? h(
					"ul",
					{ class: "studio-land-contrast" },
					player.strength
						? h(
								"li",
								{ class: "is-strength" },
								h("span", { class: "studio-land-contrast-label" }, t("Strength")),
								" ",
								h("span", null, player.strength),
							)
						: null,
					player.weakness
						? h(
								"li",
								{ class: "is-weakness" },
								h("span", { class: "studio-land-contrast-label" }, t("Weakness")),
								" ",
								h("span", null, player.weakness),
							)
						: null,
				)
			: null;
	const edge = player.ourEdge ? beat("edge", t("Our edge"), player.ourEdge) : null;
	const body = [where, contrast, edge].filter((part): part is HTMLElement => part !== null);
	return [
		h("header", { class: "studio-land-focus-head" }, name, tag, tierMark(player.tier, player.source)),
		body.length
			? h("div", { class: "studio-land-focus-body" }, body)
			: h("p", { class: "studio-land-focus-empty" }, t("Nothing known about {name} yet.", { name: player.name })),
	];
}

function filledLandscape(
	heading: string,
	changed: boolean,
	doc: StrategyLandscapeDocument,
	ctx: SurfaceBlockContext,
): HTMLElement {
	const players: KeyedRival[] = doc.players.map((player, index) => ({
		...player,
		key: player.id ?? `rival-${index + 1}`,
	}));
	const placed = players.filter(
		(player): player is PlacedRival => typeof player.x === "number" && typeof player.y === "number",
	);
	let picked = (players.find((player) => player.isUs) ?? players[0])!.key;
	let hovered: string | null = null;
	const view = h("div", { class: "studio-land-focus-view", "aria-live": "polite" });
	const ask = askButton(ctx, t("Research rivals"), () => research(doc.players));
	const card = h(
		"article",
		{ class: "studio-land-focus" },
		view,
		ask ? h("footer", { class: "studio-land-focus-foot" }, ask) : null,
	);
	const chips = players.map((player) =>
		h(
			"button",
			{
				type: "button",
				class: `studio-land-chip${player.isUs ? " is-us" : ""}`,
				"data-player": player.key,
				onclick: () => steer.pick(player.key),
				onmouseenter: () => steer.hover(player.key),
				onmouseleave: () => steer.hover(null),
			},
			h("span", { class: "studio-land-chip-name" }, player.name),
			player.isUs ? h("span", { class: "studio-land-chip-us" }, t("Us")) : null,
			player.pricing ? h("span", { class: "studio-land-chip-price" }, player.pricing) : null,
		),
	);
	let shownKey = "";
	const paint = () => {
		const active = hovered ?? picked;
		const player = players.find((item) => item.key === active);
		if (player && shownKey !== active) {
			shownKey = active;
			card.dataset.player = active;
			card.dataset.tourId = `rival:${active}`;
			card.classList.toggle("is-us", player.isUs === true);
			view.replaceChildren(...inspector(player));
		}
		map?.setActive(active);
		for (const chip of chips) {
			chip.classList.toggle("is-active", chip.dataset.player === active);
			chip.setAttribute("aria-pressed", String(chip.dataset.player === picked));
		}
	};
	const steer: Focus = {
		hover: (key) => {
			hovered = key;
			paint();
		},
		pick: (key) => {
			picked = key;
			hovered = null;
			paint();
		},
	};
	const map =
		doc.axes && placed.length >= 2 ? positioningMap(doc.axes, placed, steer, ctx, () => hovered ?? picked) : null;
	const lead =
		doc.wedge || doc.summary
			? h(
					"div",
					{ class: "studio-land-lead" },
					doc.wedge
						? h(
								"p",
								{ class: "studio-land-wedge", "data-tour-id": "landscape:wedge" },
								kicker(t("Our wedge")),
								" ",
								h("span", null, doc.wedge),
							)
						: null,
					doc.summary ? h("p", { class: "studio-land-summary" }, doc.summary) : null,
				)
			: null;
	const section = h(
		"section",
		{ class: "studio-section studio-land", "data-block": "landscape" },
		sectionHead(heading, changed),
		lead,
		h("div", { class: `studio-land-split${map ? "" : " is-single"}` }, map?.el ?? null, card),
		h("div", { class: "studio-land-strip", role: "group", "aria-label": t("Players") }, chips),
	);
	paint();
	return section;
}

export function prepareLandscape(block: SurfaceLandscapeBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const doc = read.found ? parseStrategyLandscapeDocument(read.value) : null;
	const heading = block.heading ? ctx.words(block.heading) : t("Competitive landscape");
	if (!doc) {
		return {
			filled: false,
			pieces: [
				{
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-land", "data-block": "landscape" },
							sectionHead(heading, false),
							strategyEmpty(
								"landscape",
								t("No rivals mapped yet"),
								t(
									"The real incumbents, rivals and substitutes: what they charge, who they serve, where they are weak and where we win.",
								),
								askButton(ctx, t("Research rivals"), () => research([])),
							),
						),
				},
			],
		};
	}
	return { filled: true, pieces: [{ build: () => filledLandscape(heading, read.changed, doc, ctx) }] };
}
