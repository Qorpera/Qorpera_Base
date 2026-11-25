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
import { askButton, kicker, strategyEmpty, svgEl, tierMark } from "./strategy-kit.ts";

interface KeyedRival extends StrategyRival {
	readonly key: string;
}

interface PlacedRival extends KeyedRival {
	readonly x: number;
	readonly y: number;
}

interface LabelSpot {
	readonly x: number;
	readonly y: number;
	readonly anchor: "start" | "end";
}

interface Focus {
	readonly hover: (key: string | null) => void;
	readonly pick: (key: string) => void;
}

const MAP = { width: 680, height: 420, left: 56, right: 648, top: 24, bottom: 368, dot: 14, char: 6.9 } as const;
const FLIP_AT = 64;
const NEAR_Y = 26;
const NEAR_X = 120;

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

const px = (x: number) => MAP.left + (x / 100) * (MAP.right - MAP.left);
const py = (y: number) => MAP.bottom - (y / 100) * (MAP.bottom - MAP.top);

function labelSpots(placed: readonly PlacedRival[]): Map<string, LabelSpot> {
	const spots = new Map<string, LabelSpot>();
	const lift = new Map<string, number>();
	const byHeight = [...placed].sort((a, b) => py(a.y) - py(b.y));
	for (let i = 0; i < byHeight.length; i += 1) {
		for (let j = i + 1; j < byHeight.length; j += 1) {
			const upper = byHeight[i]!;
			const lower = byHeight[j]!;
			const dy = py(lower.y) - py(upper.y);
			if (dy >= NEAR_Y || Math.abs(px(lower.x) - px(upper.x)) >= NEAR_X) continue;
			if (!lift.has(upper.key)) lift.set(upper.key, -1);
			if (!lift.has(lower.key) || lift.get(lower.key) === -1) lift.set(lower.key, 1);
		}
	}
	for (const player of placed) {
		const cx = px(player.x);
		const cy = py(player.y);
		const wide = player.name.length * MAP.char;
		const roomRight = MAP.width - (cx + MAP.dot) - 6;
		const roomLeft = cx - MAP.dot - 6;
		let left = player.x > FLIP_AT;
		if (left && wide > roomLeft && roomRight > roomLeft) left = false;
		if (!left && wide > roomRight && roomLeft > roomRight) left = true;
		const shift = lift.get(player.key) ?? 0;
		const y = shift < 0 ? cy - 12 : shift > 0 ? cy + 20 : cy + 4;
		spots.set(player.key, {
			x: left ? cx - MAP.dot : cx + MAP.dot,
			y: Math.min(MAP.height - 6, Math.max(14, y)),
			anchor: left ? "end" : "start",
		});
	}
	return spots;
}

function positioningMap(axes: StrategyLandscapeAxes, placed: readonly PlacedRival[], steer: Focus): SVGSVGElement {
	const midX = px(50);
	const midY = py(50);
	const svg = svgEl("svg", {
		class: "studio-land-svg",
		viewBox: `0 0 ${MAP.width} ${MAP.height}`,
		role: "group",
		"aria-label": t("Positioning map: {x} against {y}", { x: axes.xLabel, y: axes.yLabel }),
	});
	svg.append(
		svgEl("rect", {
			class: "studio-land-plot",
			x: MAP.left,
			y: MAP.top,
			width: MAP.right - MAP.left,
			height: MAP.bottom - MAP.top,
			rx: 14,
		}),
		svgEl("line", { class: "studio-land-quad", x1: midX, x2: midX, y1: MAP.top + 10, y2: MAP.bottom - 10 }),
		svgEl("line", { class: "studio-land-quad", x1: MAP.left + 10, x2: MAP.right - 10, y1: midY, y2: midY }),
		svgEl("text", { class: "studio-land-axis", x: midX, y: MAP.height - 10, "text-anchor": "middle" }, axes.xLabel),
		svgEl(
			"text",
			{
				class: "studio-land-axis",
				x: 0,
				y: 0,
				"text-anchor": "middle",
				transform: `translate(22 ${midY}) rotate(-90)`,
			},
			axes.yLabel,
		),
	);
	const ends: [string | undefined, number, number, "start" | "end"][] = [
		[axes.xLow ? `← ${axes.xLow}` : undefined, MAP.left + 2, MAP.bottom + 22, "start"],
		[axes.xHigh ? `${axes.xHigh} →` : undefined, MAP.right - 2, MAP.bottom + 22, "end"],
		[axes.yHigh ? `↑ ${axes.yHigh}` : undefined, MAP.left + 14, MAP.top + 20, "start"],
		[axes.yLow ? `↓ ${axes.yLow}` : undefined, MAP.left + 14, MAP.bottom - 12, "start"],
	];
	for (const [label, x, y, anchor] of ends) {
		if (label) svg.append(svgEl("text", { class: "studio-land-end", x, y, "text-anchor": anchor }, label));
	}
	const spots = labelSpots(placed);
	const ordered = [...placed].sort((a, b) => Number(a.isUs === true) - Number(b.isUs === true));
	for (const player of ordered) {
		const cx = px(player.x);
		const cy = py(player.y);
		const spot = spots.get(player.key)!;
		const point = svgEl(
			"g",
			{
				class: `studio-land-point${player.isUs ? " is-us" : ""}`,
				"data-player": player.key,
				tabindex: 0,
				role: "button",
				"aria-label": player.name,
			},
			svgEl("title", {}, player.name),
			player.isUs ? svgEl("circle", { class: "studio-land-halo", cx, cy, r: 26 }) : null,
			svgEl("circle", { class: "studio-land-ring", cx, cy, r: player.isUs ? 13 : 11 }),
			svgEl("circle", { class: "studio-land-dot", cx, cy, r: player.isUs ? 8 : 6.5 }),
			svgEl("text", { class: "studio-land-name", x: spot.x, y: spot.y, "text-anchor": spot.anchor }, player.name),
		);
		point.addEventListener("mouseenter", () => steer.hover(player.key));
		point.addEventListener("mouseleave", () => steer.hover(null));
		point.addEventListener("focus", () => steer.hover(player.key));
		point.addEventListener("blur", () => steer.hover(null));
		point.addEventListener("click", () => steer.pick(player.key));
		point.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			steer.pick(player.key);
		});
		svg.append(point);
	}
	return svg;
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
			card.classList.toggle("is-us", player.isUs === true);
			view.replaceChildren(...inspector(player));
		}
		for (const point of section.querySelectorAll<SVGGElement>(".studio-land-point")) {
			point.classList.toggle("is-active", point.dataset.player === active);
			point.setAttribute("aria-pressed", String(point.dataset.player === picked));
		}
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
		doc.axes && placed.length >= 2
			? h("figure", { class: "studio-land-map" }, positioningMap(doc.axes, placed, steer))
			: null;
	const lead =
		doc.wedge || doc.summary
			? h(
					"div",
					{ class: "studio-land-lead" },
					doc.wedge
						? h("p", { class: "studio-land-wedge" }, kicker(t("Our wedge")), " ", h("span", null, doc.wedge))
						: null,
					doc.summary ? h("p", { class: "studio-land-summary" }, doc.summary) : null,
				)
			: null;
	const section = h(
		"section",
		{ class: "studio-section studio-land", "data-block": "landscape" },
		sectionHead(heading, changed),
		lead,
		h("div", { class: `studio-land-split${map ? "" : " is-single"}` }, map, card),
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
