import { parseSurfaceReportEvidence, type SurfaceReportEvidence } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";

export interface ReportMetric {
	readonly label: string;
	readonly value: string;
	readonly delta?: string;
}

interface ReportBarItem {
	readonly label: string;
	readonly value: number;
	readonly display?: string;
	readonly note?: string;
	readonly highlight?: boolean;
}

interface ReportLineSeries {
	readonly name: string;
	readonly color?: string;
	readonly values: readonly number[];
}

interface ReportFigurePanel {
	readonly label: string;
	readonly heading: string;
	readonly body: string;
	readonly accent?: string;
}

export type ReportBlock =
	| { readonly kind: "quote"; readonly text: string; readonly attribution?: string }
	| {
			readonly kind: "bar_chart";
			readonly heading: string;
			readonly subtitle?: string;
			readonly max?: number;
			readonly items: readonly ReportBarItem[];
	  }
	| {
			readonly kind: "line_chart";
			readonly heading: string;
			readonly subtitle?: string;
			readonly xLabels: readonly string[];
			readonly series: readonly ReportLineSeries[];
	  }
	| {
			readonly kind: "table";
			readonly heading: string;
			readonly caption?: string;
			readonly columns: readonly string[];
			readonly rows: readonly (readonly string[])[];
			readonly highlightRow?: number;
	  }
	| {
			readonly kind: "callout";
			readonly tone?: "thesis" | "decision" | "tradeoff" | "public_lens";
			readonly heading: string;
			readonly body: string;
			readonly bullets?: readonly string[];
	  }
	| {
			readonly kind: "figure";
			readonly heading: string;
			readonly caption?: string;
			readonly panels: readonly ReportFigurePanel[];
	  };

export interface ReportSection {
	readonly id: string;
	readonly kicker?: string;
	readonly heading: string;
	readonly paragraphs: readonly string[];
	readonly blocks?: readonly ReportBlock[];
}

export interface ReportDocument {
	readonly path: string;
	readonly slug: string;
	readonly category: string;
	readonly headline: string;
	readonly subtitle: string;
	readonly author: string;
	readonly date: string;
	readonly readingTime: string;
	readonly publicUrl?: string;
	readonly keyMetrics: readonly ReportMetric[];
	readonly sections: readonly ReportSection[];
	readonly evidence?: SurfaceReportEvidence;
	readonly changed: boolean;
	readonly base?: ReportDocument;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SERIES_COLORS = ["#4a55a2", "#c65d3b", "#2d6a57", "#d4950f"];

function svgEl<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number>,
	text?: string,
): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
	if (text !== undefined) node.textContent = text;
	return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function parseBlock(raw: unknown): ReportBlock | undefined {
	if (!isRecord(raw)) return undefined;
	const kind = str(raw.kind);
	const heading = str(raw.heading) || str(raw.title);
	if (kind === "quote") {
		const text = str(raw.text);
		if (!text) return undefined;
		const attribution = str(raw.attribution);
		return { kind: "quote", text, ...(attribution ? { attribution } : {}) };
	}
	if (kind === "bar_chart" && Array.isArray(raw.items)) {
		const items: ReportBarItem[] = raw.items.filter(isRecord).map((item) => ({
			label: str(item.label),
			value: typeof item.value === "number" ? item.value : Number(item.value) || 0,
			...(str(item.display) ? { display: str(item.display) } : {}),
			...(str(item.note) ? { note: str(item.note) } : {}),
			...(item.highlight === true ? { highlight: true } : {}),
		}));
		if (!items.length) return undefined;
		return {
			kind: "bar_chart",
			heading,
			...(str(raw.subtitle) ? { subtitle: str(raw.subtitle) } : {}),
			...(typeof raw.max === "number" ? { max: raw.max } : {}),
			items,
		};
	}
	if (kind === "line_chart" && Array.isArray(raw.series)) {
		const series: ReportLineSeries[] = raw.series
			.filter(isRecord)
			.map((entry) => ({
				name: str(entry.name),
				...(str(entry.color) ? { color: str(entry.color) } : {}),
				values: Array.isArray(entry.values)
					? entry.values.map((v) => (typeof v === "number" ? v : Number(v) || 0))
					: [],
			}))
			.filter((entry) => entry.values.length > 1);
		if (!series.length) return undefined;
		const xLabels = Array.isArray(raw.xLabels) ? raw.xLabels.map((v) => String(v)) : [];
		return {
			kind: "line_chart",
			heading,
			...(str(raw.subtitle) ? { subtitle: str(raw.subtitle) } : {}),
			xLabels,
			series,
		};
	}
	if (kind === "table" && Array.isArray(raw.columns) && Array.isArray(raw.rows)) {
		const columns = raw.columns.map((c) => String(c));
		const rows = raw.rows.filter(Array.isArray).map((row) => (row as unknown[]).map((cell) => String(cell ?? "")));
		if (!columns.length) return undefined;
		return {
			kind: "table",
			heading,
			...(str(raw.caption) ? { caption: str(raw.caption) } : {}),
			columns,
			rows,
			...(typeof raw.highlightRow === "number" ? { highlightRow: raw.highlightRow } : {}),
		};
	}
	if (kind === "callout") {
		const body = str(raw.body);
		if (!body && !heading) return undefined;
		const tone = raw.tone;
		const validTone =
			tone === "thesis" || tone === "decision" || tone === "tradeoff" || tone === "public_lens" ? tone : "thesis";
		const bullets = Array.isArray(raw.bullets) ? raw.bullets.map((b) => String(b)).filter(Boolean) : undefined;
		return {
			kind: "callout",
			tone: validTone,
			heading,
			body,
			...(bullets?.length ? { bullets } : {}),
		};
	}
	if (kind === "figure" && Array.isArray(raw.panels)) {
		const panels: ReportFigurePanel[] = raw.panels.filter(isRecord).map((panel) => ({
			label: str(panel.label),
			heading: str(panel.heading) || str(panel.title),
			body: str(panel.body),
			...(str(panel.accent) ? { accent: str(panel.accent) } : {}),
		}));
		if (!panels.length) return undefined;
		return {
			kind: "figure",
			heading,
			...(str(raw.caption) ? { caption: str(raw.caption) } : {}),
			panels,
		};
	}
	return undefined;
}

function readEvidence(report: Record<string, unknown>, path: string): SurfaceReportEvidence | undefined {
	try {
		const evidence = parseSurfaceReportEvidence(report, { path });
		return Object.keys(evidence).length > 0 ? evidence : undefined;
	} catch {
		return undefined;
	}
}

export function parseReportJson(path: string, content: string): Omit<ReportDocument, "changed" | "base"> | undefined {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed)) return undefined;
		const headline = str(parsed.headline) || str(parsed.title);
		if (!headline) return undefined;
		const evidence = readEvidence(parsed, path);
		const keyMetrics: ReportMetric[] = Array.isArray(parsed.keyMetrics)
			? parsed.keyMetrics.filter(isRecord).map((metric) => ({
					label: str(metric.label),
					value: str(metric.value),
					...(str(metric.delta) ? { delta: str(metric.delta) } : {}),
				}))
			: [];
		const sections: ReportSection[] = Array.isArray(parsed.sections)
			? parsed.sections.filter(isRecord).map((sec, index) => ({
					id: str(sec.id) || `section-${index + 1}`,
					...(str(sec.kicker) ? { kicker: str(sec.kicker) } : {}),
					heading: str(sec.heading) || str(sec.title),
					paragraphs: Array.isArray(sec.paragraphs) ? sec.paragraphs.map((p) => String(p)) : [],
					blocks: Array.isArray(sec.blocks)
						? sec.blocks.map(parseBlock).filter((block): block is ReportBlock => Boolean(block))
						: [],
				}))
			: [];
		return {
			path,
			slug: str(parsed.slug) || path.replace(/^.*\//, "").replace(/\.report\.json$/i, ""),
			category: str(parsed.category),
			headline,
			subtitle: str(parsed.subtitle),
			author: str(parsed.author),
			date: str(parsed.date),
			readingTime: str(parsed.readingTime),
			...(str(parsed.publicUrl) ? { publicUrl: str(parsed.publicUrl) } : {}),
			keyMetrics,
			sections,
			...(evidence ? { evidence } : {}),
		};
	} catch {
		return undefined;
	}
}

function renderBarChart(block: Extract<ReportBlock, { kind: "bar_chart" }>): HTMLElement {
	let itemMax = 1;
	for (const item of block.items) {
		if (Number.isFinite(item.value) && item.value > itemMax) itemMax = item.value;
	}
	const max = typeof block.max === "number" && Number.isFinite(block.max) && block.max > 0 ? block.max : itemMax;
	return h(
		"figure",
		{ class: "report-visual report-bars" },
		h(
			"div",
			{ class: "report-visual-head" },
			h("h4", null, block.heading),
			block.subtitle ? h("p", null, block.subtitle) : null,
		),
		h(
			"div",
			{ class: "report-bar-list" },
			block.items.map((item) => {
				const safeVal = Number.isFinite(item.value) ? item.value : 0;
				const pct = Math.max(4, Math.min(100, Math.round((safeVal / max) * 100)));
				const fill = h("span", { class: "report-bar-fill" });
				fill.style.width = `${pct}%`;
				return h(
					"div",
					{ class: `report-bar-row${item.highlight ? " is-highlight" : ""}` },
					h(
						"div",
						{ class: "report-bar-meta" },
						h("strong", null, item.label),
						h("span", { class: "report-bar-val" }, item.display ?? String(item.value)),
					),
					h("div", { class: "report-bar-track", role: "presentation" }, fill),
					item.note ? h("small", { class: "report-bar-note" }, item.note) : null,
				);
			}),
		),
	);
}

function renderLineChart(block: Extract<ReportBlock, { kind: "line_chart" }>): HTMLElement {
	let rawMax = 1;
	let rawMin = 0;
	let count = 2;
	for (const series of block.series) {
		if (series.values.length > count) count = series.values.length;
		for (const value of series.values) {
			if (!Number.isFinite(value)) continue;
			if (value > rawMax) rawMax = value;
			if (value < rawMin) rawMin = value;
		}
	}
	const span = Math.max(1, rawMax - rawMin);
	const padTop = rawMin >= 0 ? Math.min(rawMax * 1.08, rawMax + span * 0.12) : rawMax + span * 0.12;
	const padMin = rawMin >= 0 ? 0 : rawMin - span * 0.1;
	const range = Math.max(1, padTop - padMin);

	const width = 620;
	const height = 220;
	const left = 42;
	const right = 22;
	const top = 18;
	const bottom = 34;
	const plotW = width - left - right;
	const plotH = height - top - bottom;

	const svg = svgEl("svg", {
		class: "report-line-svg",
		viewBox: `0 0 ${width} ${height}`,
		role: "img",
		"aria-label": block.heading,
	});

	for (let step = 0; step <= 3; step++) {
		const ratio = step / 3;
		const y = top + plotH - ratio * plotH;
		const labelVal = Math.round(padMin + ratio * range);
		svg.append(
			svgEl("line", { x1: left, y1: y.toFixed(1), x2: width - right, y2: y.toFixed(1), class: "report-grid-line" }),
			svgEl(
				"text",
				{ x: left - 8, y: (y + 3.5).toFixed(1), "text-anchor": "end", class: "report-axis-text" },
				String(labelVal),
			),
		);
	}

	const xAt = (index: number) => left + (index / (count - 1)) * plotW;
	const yAt = (value: number) => {
		const safe = Number.isFinite(value) ? value : padMin;
		return top + plotH - ((safe - padMin) / range) * plotH;
	};

	for (let i = 0; i < block.xLabels.length; i++) {
		svg.append(
			svgEl(
				"text",
				{ x: xAt(i).toFixed(1), y: height - 10, "text-anchor": "middle", class: "report-axis-text" },
				block.xLabels[i]!,
			),
		);
	}

	block.series.forEach((series, seriesIndex) => {
		const color = series.color ?? SERIES_COLORS[seriesIndex % SERIES_COLORS.length]!;
		const pts = series.values.map((val, idx) => ({ x: xAt(idx), y: yAt(val), val }));
		const linePath = pts.map((pt, idx) => `${idx === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
		if (block.series.length === 1) {
			const areaPath = `${linePath} L${pts.at(-1)!.x.toFixed(1)},${(top + plotH).toFixed(1)} L${pts[0]!.x.toFixed(1)},${(top + plotH).toFixed(1)} Z`;
			svg.append(svgEl("path", { d: areaPath, fill: color, "fill-opacity": "0.11" }));
		}
		svg.append(
			svgEl("path", {
				d: linePath,
				fill: "none",
				stroke: color,
				"stroke-width": "2.6",
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
			}),
		);
		for (const pt of pts) {
			svg.append(
				svgEl("circle", { cx: pt.x.toFixed(1), cy: pt.y.toFixed(1), r: "4", fill: color, class: "report-point" }),
			);
		}
	});

	const legend =
		block.series.length > 1
			? h(
					"div",
					{ class: "report-legend" },
					block.series.map((series, index) => {
						const dot = h("span", { class: "report-legend-dot", "aria-hidden": "true" });
						dot.style.backgroundColor = series.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!;
						return h("span", { class: "report-legend-item" }, dot, series.name);
					}),
				)
			: null;

	return h(
		"figure",
		{ class: "report-visual report-chart" },
		h(
			"div",
			{ class: "report-visual-head" },
			h("h4", null, block.heading),
			block.subtitle ? h("p", null, block.subtitle) : null,
		),
		svg,
		legend,
	);
}

function renderTableBlock(block: Extract<ReportBlock, { kind: "table" }>): HTMLElement {
	return h(
		"figure",
		{ class: "report-visual report-table-card" },
		block.heading ? h("div", { class: "report-visual-head" }, h("h4", null, block.heading)) : null,
		h(
			"div",
			{ class: "report-table-scroll" },
			h(
				"table",
				{ class: "report-table" },
				h(
					"thead",
					null,
					h(
						"tr",
						null,
						block.columns.map((col) => h("th", null, col)),
					),
				),
				h(
					"tbody",
					null,
					block.rows.map((row, rowIndex) =>
						h(
							"tr",
							{ class: rowIndex === block.highlightRow ? "is-highlight" : "" },
							row.map((cell) => h("td", null, cell)),
						),
					),
				),
			),
		),
		block.caption ? h("figcaption", { class: "report-caption" }, block.caption) : null,
	);
}

function renderFigureBlock(block: Extract<ReportBlock, { kind: "figure" }>): HTMLElement {
	return h(
		"figure",
		{ class: "report-visual report-figure" },
		block.heading ? h("div", { class: "report-visual-head" }, h("h4", null, block.heading)) : null,
		h(
			"div",
			{ class: "report-figure-panels" },
			block.panels.map((panel) => {
				const card = h(
					"div",
					{ class: `report-figure-panel${panel.accent ? " is-accent" : ""}` },
					panel.label ? h("span", { class: "report-panel-label" }, panel.label) : null,
					panel.heading ? h("strong", null, panel.heading) : null,
					h("p", null, panel.body),
				);
				if (panel.accent) card.style.setProperty("--panel-accent", panel.accent);
				return card;
			}),
		),
		block.caption ? h("figcaption", { class: "report-caption" }, block.caption) : null,
	);
}

function renderCalloutBlock(block: Extract<ReportBlock, { kind: "callout" }>): HTMLElement {
	const toneLabel =
		block.tone === "public_lens"
			? t("External perspective")
			: block.tone === "decision"
				? t("Founder alignment")
				: block.tone === "tradeoff"
					? t("Trade-off")
					: t("Key takeaway");
	return h(
		"aside",
		{ class: `report-callout is-${block.tone ?? "thesis"}` },
		h("span", { class: "report-callout-tag" }, toneLabel),
		block.heading ? h("h4", null, block.heading) : null,
		block.body ? h("p", null, block.body) : null,
		block.bullets?.length
			? h(
					"ul",
					{ class: "report-callout-list" },
					block.bullets.map((item) => h("li", null, item)),
				)
			: null,
	);
}

export function renderReportBlock(block: ReportBlock): HTMLElement {
	switch (block.kind) {
		case "quote":
			return h(
				"blockquote",
				{ class: "report-quote" },
				h("p", null, block.text),
				block.attribution ? h("footer", null, block.attribution) : null,
			);
		case "bar_chart":
			return renderBarChart(block);
		case "line_chart":
			return renderLineChart(block);
		case "table":
			return renderTableBlock(block);
		case "figure":
			return renderFigureBlock(block);
		case "callout":
			return renderCalloutBlock(block);
	}
}
