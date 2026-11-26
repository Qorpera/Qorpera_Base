export const SURFACE_CHART_KINDS = [
	"line",
	"bar",
	"area",
	"scatter",
	"pie",
	"sankey",
	"radar",
	"funnel",
	"heatmap",
] as const;

export type SurfaceChartKind = (typeof SURFACE_CHART_KINDS)[number];

export interface SurfaceChartPoint {
	readonly name?: string;
	readonly value: number | readonly [number, number] | readonly [number, number, number];
	readonly label?: string;
	readonly color?: string;
}

export interface SurfaceChartMarkLine {
	readonly value: number;
	readonly label?: string;
}

export interface SurfaceChartSeries {
	readonly name: string;
	readonly color?: string;
	readonly data: readonly (number | null | SurfaceChartPoint)[];
	readonly markLine?: readonly SurfaceChartMarkLine[];
}

export interface SurfaceChartSankeyNode {
	readonly name: string;
	readonly color?: string;
}

export interface SurfaceChartSankeyLink {
	readonly source: string;
	readonly target: string;
	readonly value: number;
}

export interface SurfaceChartRadarIndicator {
	readonly name: string;
	readonly max: number;
}

export interface SurfaceChartDocument {
	readonly kind: SurfaceChartKind;
	readonly title?: string;
	readonly subtitle?: string;
	readonly unit?: string;
	readonly note?: string;
	readonly stacked?: boolean;
	readonly horizontal?: boolean;
	readonly smooth?: boolean;
	readonly showLegend?: boolean;
	readonly donut?: boolean;
	readonly categories?: readonly string[];
	readonly xAxisLabel?: string;
	readonly yAxisLabel?: string;
	readonly xAxisMin?: number;
	readonly xAxisMax?: number;
	readonly yAxisMin?: number;
	readonly yAxisMax?: number;
	readonly series?: readonly SurfaceChartSeries[];
	readonly nodes?: readonly SurfaceChartSankeyNode[];
	readonly links?: readonly SurfaceChartSankeyLink[];
	readonly indicators?: readonly SurfaceChartRadarIndicator[];
	readonly xCategories?: readonly string[];
	readonly yCategories?: readonly string[];
	readonly cells?: readonly (readonly [number, number, number])[];
}

const MAX_SERIES = 16;
const MAX_CATEGORIES = 120;
const MAX_POINTS = 240;
const MAX_SANKEY_NODES = 80;
const MAX_SANKEY_LINKS = 200;
const MAX_RADAR_INDICATORS = 16;
const MAX_HEATMAP_AXIS = 40;
const MAX_HEATMAP_CELLS = 1600;
const MAX_MARK_LINES = 6;
const COLOR_PATTERN = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([0-9.,%\s/]+\)|var\(--[a-z0-9-]+\))$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanColor(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return COLOR_PATTERN.test(trimmed) ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanAxisBounds(rawMin: unknown, rawMax: unknown): { min?: number; max?: number } {
	const min = finiteNumber(rawMin);
	const max = finiteNumber(rawMax);
	if (min !== undefined && max !== undefined && min >= max) return {};
	return {
		...(min !== undefined ? { min } : {}),
		...(max !== undefined ? { max } : {}),
	};
}

function cleanCategories(value: unknown, max: number): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const entry of value) {
		if (out.length >= max) break;
		const text = typeof entry === "number" && Number.isFinite(entry) ? String(entry) : cleanText(entry, 64);
		if (text !== undefined) out.push(text);
	}
	return out.length > 0 ? out : undefined;
}

function cleanPointValue(
	value: unknown,
): number | readonly [number, number] | readonly [number, number, number] | undefined {
	const scalar = finiteNumber(value);
	if (scalar !== undefined) return scalar;
	if (!Array.isArray(value)) return undefined;
	if (value.length === 2) {
		const a = finiteNumber(value[0]);
		const b = finiteNumber(value[1]);
		if (a !== undefined && b !== undefined) return [a, b] as const;
	}
	if (value.length === 3) {
		const a = finiteNumber(value[0]);
		const b = finiteNumber(value[1]);
		const c = finiteNumber(value[2]);
		if (a !== undefined && b !== undefined && c !== undefined) return [a, b, c] as const;
	}
	return undefined;
}

function cleanMarkLines(value: unknown): SurfaceChartMarkLine[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: SurfaceChartMarkLine[] = [];
	for (const entry of value) {
		if (out.length >= MAX_MARK_LINES) break;
		if (!isRecord(entry)) continue;
		const num = finiteNumber(entry.value);
		if (num === undefined) continue;
		const label = cleanText(entry.label, 64);
		out.push({ value: num, ...(label ? { label } : {}) });
	}
	return out.length > 0 ? out : undefined;
}

function cleanSeries(value: unknown, isRadar: boolean): SurfaceChartSeries[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: SurfaceChartSeries[] = [];
	for (const entry of value) {
		if (out.length >= MAX_SERIES) break;
		if (!isRecord(entry) || !Array.isArray(entry.data)) continue;
		const name = cleanText(entry.name, 80) ?? `Series ${out.length + 1}`;
		const color = cleanColor(entry.color);
		const data: (number | null | SurfaceChartPoint)[] = [];
		for (const item of entry.data) {
			if (data.length >= MAX_POINTS) break;
			if (item === null && !isRadar) {
				data.push(null);
				continue;
			}
			const num = finiteNumber(item);
			if (num !== undefined) {
				data.push(num);
				continue;
			}
			if (Array.isArray(item)) {
				const tuple = cleanPointValue(item);
				if (tuple !== undefined) data.push({ value: tuple });
				continue;
			}
			if (isRecord(item)) {
				const val = cleanPointValue(item.value);
				if (val === undefined) continue;
				const itemName = cleanText(item.name, 80);
				const label = cleanText(item.label, 80);
				const itemColor = cleanColor(item.color);
				data.push({
					value: val,
					...(itemName ? { name: itemName } : {}),
					...(label ? { label } : {}),
					...(itemColor ? { color: itemColor } : {}),
				});
			}
		}
		if (data.length === 0) continue;
		const markLine = cleanMarkLines(entry.markLine);
		out.push({
			name,
			...(color ? { color } : {}),
			data,
			...(markLine ? { markLine } : {}),
		});
	}
	return out.length > 0 ? out : undefined;
}

export function parseSurfaceChartDocument(raw: unknown): SurfaceChartDocument | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.kind !== "string" || !(SURFACE_CHART_KINDS as readonly string[]).includes(raw.kind)) {
		return null;
	}
	const kind = raw.kind as SurfaceChartKind;
	const title = cleanText(raw.title, 120);
	const subtitle = cleanText(raw.subtitle, 240);
	const unit = cleanText(raw.unit, 24);
	const note = cleanText(raw.note, 320);
	const xAxisLabel = cleanText(raw.xAxisLabel, 64);
	const yAxisLabel = cleanText(raw.yAxisLabel, 64);
	const xBounds = cleanAxisBounds(raw.xAxisMin, raw.xAxisMax);
	const yBounds = cleanAxisBounds(raw.yAxisMin, raw.yAxisMax);
	const categories = cleanCategories(raw.categories, MAX_CATEGORIES);
	const common = {
		kind,
		...(title ? { title } : {}),
		...(subtitle ? { subtitle } : {}),
		...(unit ? { unit } : {}),
		...(note ? { note } : {}),
		...(raw.stacked === true ? { stacked: true } : {}),
		...(raw.horizontal === true ? { horizontal: true } : {}),
		...(raw.smooth === true ? { smooth: true } : {}),
		...(typeof raw.showLegend === "boolean" ? { showLegend: raw.showLegend } : {}),
		...(raw.donut === true ? { donut: true } : {}),
		...(categories ? { categories } : {}),
		...(xAxisLabel ? { xAxisLabel } : {}),
		...(yAxisLabel ? { yAxisLabel } : {}),
		...(xBounds.min !== undefined ? { xAxisMin: xBounds.min } : {}),
		...(xBounds.max !== undefined ? { xAxisMax: xBounds.max } : {}),
		...(yBounds.min !== undefined ? { yAxisMin: yBounds.min } : {}),
		...(yBounds.max !== undefined ? { yAxisMax: yBounds.max } : {}),
	};

	if (kind === "sankey") {
		if (!Array.isArray(raw.links)) return null;
		const links: SurfaceChartSankeyLink[] = [];
		const names = new Set<string>();
		for (const item of raw.links) {
			if (links.length >= MAX_SANKEY_LINKS) break;
			if (!isRecord(item)) continue;
			const source = cleanText(item.source, 80);
			const target = cleanText(item.target, 80);
			const val = finiteNumber(item.value);
			if (!source || !target || source === target || val === undefined || val <= 0) continue;
			links.push({ source, target, value: val });
			names.add(source);
			names.add(target);
		}
		if (links.length === 0) return null;
		const explicitNodes = new Map<string, SurfaceChartSankeyNode>();
		if (Array.isArray(raw.nodes)) {
			for (const entry of raw.nodes) {
				if (explicitNodes.size >= MAX_SANKEY_NODES) break;
				if (typeof entry === "string") {
					const name = cleanText(entry, 80);
					if (name) explicitNodes.set(name, { name });
				} else if (isRecord(entry)) {
					const name = cleanText(entry.name, 80);
					if (!name) continue;
					const color = cleanColor(entry.color);
					explicitNodes.set(name, { name, ...(color ? { color } : {}) });
				}
			}
		}
		for (const name of names) {
			if (explicitNodes.size >= MAX_SANKEY_NODES) break;
			if (!explicitNodes.has(name)) explicitNodes.set(name, { name });
		}
		const nodes = [...explicitNodes.values()];
		const validNames = new Set(nodes.map((node) => node.name));
		const boundedLinks = links.filter((link) => validNames.has(link.source) && validNames.has(link.target));
		if (boundedLinks.length === 0) return null;
		return { ...common, nodes, links: boundedLinks };
	}

	if (kind === "heatmap") {
		const xCategories = cleanCategories(raw.xCategories ?? raw.categories, MAX_HEATMAP_AXIS);
		const yCategories = cleanCategories(raw.yCategories, MAX_HEATMAP_AXIS);
		if (!xCategories || !yCategories || !Array.isArray(raw.cells)) return null;
		const cells: [number, number, number][] = [];
		for (const entry of raw.cells) {
			if (cells.length >= MAX_HEATMAP_CELLS) break;
			if (!Array.isArray(entry) || entry.length < 3) continue;
			const x = finiteNumber(entry[0]);
			const y = finiteNumber(entry[1]);
			const v = finiteNumber(entry[2]);
			if (
				x === undefined ||
				y === undefined ||
				v === undefined ||
				!Number.isInteger(x) ||
				!Number.isInteger(y) ||
				x < 0 ||
				x >= xCategories.length ||
				y < 0 ||
				y >= yCategories.length
			) {
				continue;
			}
			cells.push([x, y, v]);
		}
		if (cells.length === 0) return null;
		return { ...common, xCategories, yCategories, cells };
	}

	if (kind === "radar") {
		if (!Array.isArray(raw.indicators)) return null;
		const indicators: SurfaceChartRadarIndicator[] = [];
		for (const entry of raw.indicators) {
			if (indicators.length >= MAX_RADAR_INDICATORS) break;
			if (!isRecord(entry)) continue;
			const name = cleanText(entry.name, 64);
			const max = finiteNumber(entry.max);
			if (!name || max === undefined || max <= 0) continue;
			indicators.push({ name, max });
		}
		const series = cleanSeries(raw.series, true);
		if (indicators.length < 3 || !series) return null;
		return { ...common, indicators, series };
	}

	const series = cleanSeries(raw.series, false);
	if (!series) return null;
	return { ...common, series };
}
