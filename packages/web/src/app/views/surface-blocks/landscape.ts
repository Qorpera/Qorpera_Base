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
import { askButton, kicker, strategyEmpty, svgEl, tierBadge } from "./strategy-kit.ts";

interface KeyedRival extends StrategyRival {
	readonly key: string;
}

interface PlacedRival extends KeyedRival {
	readonly x: number;
	readonly y: number;
}

interface Matrix {
	readonly wrap: HTMLElement;
	readonly rows: ReadonlyMap<string, HTMLTableRowElement>;
}

const MAP = { width: 600, height: 400, left: 44, right: 584, top: 18, bottom: 352 } as const;
const LABEL_CHARS = 22;

function safeUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return /^https?:\/\//i.test(url) ? url : undefined;
}

function short(text: string): string {
	return text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text;
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

function positioningMap(
	axes: StrategyLandscapeAxes,
	placed: readonly PlacedRival[],
	hover: (key: string | null) => void,
	pin: (key: string) => void,
): SVGSVGElement {
	const px = (x: number) => MAP.left + (x / 100) * (MAP.right - MAP.left);
	const py = (y: number) => MAP.bottom - (y / 100) * (MAP.bottom - MAP.top);
	const midX = px(50);
	const midY = py(50);
	const svg = svgEl("svg", {
		class: "studio-land-svg",
		viewBox: `0 0 ${MAP.width} ${MAP.height}`,
		role: "img",
		"aria-label": t("Positioning map: {x} against {y}", { x: axes.xLabel, y: axes.yLabel }),
	});
	svg.append(
		svgEl("rect", {
			class: "studio-land-plot",
			x: MAP.left,
			y: MAP.top,
			width: MAP.right - MAP.left,
			height: MAP.bottom - MAP.top,
			rx: 12,
		}),
		svgEl("line", { class: "studio-land-quad", x1: midX, x2: midX, y1: MAP.top, y2: MAP.bottom }),
		svgEl("line", { class: "studio-land-quad", x1: MAP.left, x2: MAP.right, y1: midY, y2: midY }),
		svgEl("text", { class: "studio-land-axis", x: midX, y: MAP.height - 12, "text-anchor": "middle" }, axes.xLabel),
		svgEl(
			"text",
			{
				class: "studio-land-axis",
				x: 0,
				y: 0,
				"text-anchor": "middle",
				transform: `translate(16 ${midY}) rotate(-90)`,
			},
			axes.yLabel,
		),
	);
	const ends: [string | undefined, number, number, "start" | "end"][] = [
		[axes.xLow, MAP.left + 2, MAP.bottom + 18, "start"],
		[axes.xHigh, MAP.right - 2, MAP.bottom + 18, "end"],
		[axes.yHigh, MAP.left + 10, MAP.top + 16, "start"],
		[axes.yLow, MAP.left + 10, MAP.bottom - 10, "start"],
	];
	for (const [label, x, y, anchor] of ends) {
		if (label) svg.append(svgEl("text", { class: "studio-land-end", x, y, "text-anchor": anchor }, label));
	}
	const ordered = [...placed].sort((a, b) => Number(a.isUs === true) - Number(b.isUs === true));
	for (const player of ordered) {
		const cx = px(player.x);
		const cy = py(player.y);
		const flip = player.x > 72;
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
			player.isUs ? svgEl("circle", { class: "studio-land-halo", cx, cy, r: 16 }) : null,
			svgEl("circle", { class: "studio-land-dot", cx, cy, r: player.isUs ? 8 : 6.5 }),
			svgEl(
				"text",
				{
					class: "studio-land-name",
					x: flip ? cx - 13 : cx + 13,
					y: cy + 4,
					"text-anchor": flip ? "end" : "start",
				},
				short(player.name),
			),
		);
		point.addEventListener("mouseenter", () => hover(player.key));
		point.addEventListener("mouseleave", () => hover(null));
		point.addEventListener("focus", () => hover(player.key));
		point.addEventListener("blur", () => hover(null));
		point.addEventListener("click", () => pin(player.key));
		point.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			pin(player.key);
		});
		svg.append(point);
	}
	return svg;
}

function cell(text: string | undefined, extra = ""): HTMLTableCellElement {
	return h("td", { class: extra || null }, text ?? "–");
}

function playerCell(player: StrategyRival): HTMLTableCellElement {
	const url = safeUrl(player.url);
	return h(
		"th",
		{ scope: "row", class: "studio-land-player" },
		h(
			"div",
			{ class: "studio-land-who" },
			url
				? h(
						"a",
						{ href: url, target: "_blank", rel: "noopener noreferrer", class: "studio-land-name-link" },
						player.name,
					)
				: h("strong", null, player.name),
			player.isUs ? h("span", { class: "studio-land-us" }, t("Us")) : null,
		),
		player.category || player.tier
			? h(
					"div",
					{ class: "studio-land-tags" },
					player.category ? h("span", { class: "studio-land-category" }, player.category) : null,
					tierBadge(player.tier, player.source),
				)
			: null,
	);
}

function matrix(players: readonly KeyedRival[]): Matrix {
	const rows = new Map<string, HTMLTableRowElement>();
	const body = h(
		"tbody",
		null,
		players.map((player) => {
			const row = h(
				"tr",
				{ class: player.isUs ? "is-us" : null, "data-player": player.key },
				playerCell(player),
				cell(player.positioning),
				cell(player.pricing, "is-num"),
				cell(player.target),
				cell(player.strength),
				cell(player.weakness),
				cell(player.ourEdge, "studio-land-edge"),
			);
			rows.set(player.key, row);
			return row;
		}),
	);
	const head = h(
		"tr",
		null,
		h("th", { scope: "col" }, t("Player")),
		h("th", { scope: "col" }, t("Positioning")),
		h("th", { scope: "col" }, t("Pricing")),
		h("th", { scope: "col" }, t("Target")),
		h("th", { scope: "col" }, t("Strength")),
		h("th", { scope: "col" }, t("Weakness")),
		h("th", { scope: "col", class: "studio-land-edge" }, t("Our edge")),
	);
	const table = h("table", { class: "studio-land-table" }, h("thead", null, head), body);
	return { wrap: h("div", { class: "studio-land-table-wrap" }, table), rows };
}

function filledLandscape(
	heading: string,
	changed: boolean,
	doc: StrategyLandscapeDocument,
	ctx: SurfaceBlockContext,
): HTMLElement {
	const players = doc.players.map((player, index) => ({ ...player, key: player.id ?? `rival-${index + 1}` }));
	const placed = players.filter(
		(player): player is PlacedRival => typeof player.x === "number" && typeof player.y === "number",
	);
	const { wrap, rows } = matrix(players);
	let pinned: string | null = null;
	let hovered: string | null = null;
	const paint = () => {
		const active = hovered ?? pinned;
		section.classList.toggle("has-active", active !== null);
		for (const [key, row] of rows) row.classList.toggle("is-active", key === active);
		for (const point of section.querySelectorAll<SVGGElement>(".studio-land-point")) {
			point.classList.toggle("is-active", point.dataset.player === active);
		}
	};
	const hover = (key: string | null) => {
		hovered = key;
		paint();
	};
	const pin = (key: string) => {
		pinned = pinned === key ? null : key;
		paint();
	};
	for (const [key, row] of rows) {
		row.addEventListener("mouseenter", () => hover(key));
		row.addEventListener("mouseleave", () => hover(null));
		row.addEventListener("click", (event) => {
			if (event.target instanceof Element && event.target.closest("a")) return;
			pin(key);
		});
	}
	const map =
		doc.axes && placed.length >= 2
			? h("figure", { class: "studio-land-map" }, positioningMap(doc.axes, placed, hover, pin))
			: null;
	const ask = askButton(ctx, t("Research rivals"), () => research(doc.players));
	const section = h(
		"section",
		{ class: "studio-section studio-land", "data-block": "landscape" },
		sectionHead(heading, changed),
		doc.wedge || doc.summary
			? h(
					"div",
					{ class: "studio-land-lead" },
					doc.wedge
						? h("div", { class: "studio-land-wedge" }, kicker(t("Our wedge")), h("p", null, doc.wedge))
						: null,
					doc.summary ? h("p", { class: "studio-land-summary" }, doc.summary) : null,
				)
			: null,
		map,
		wrap,
		ask ? h("div", { class: "studio-strategy-foot" }, ask) : null,
	);
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
