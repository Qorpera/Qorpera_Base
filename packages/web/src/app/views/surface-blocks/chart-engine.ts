import type {
	SurfaceChartDocument,
	SurfaceChartMarkLine,
	SurfaceChartPoint,
	SurfaceChartSeries,
} from "@qorpera/contracts";
import {
	BarChart,
	FunnelChart,
	HeatmapChart,
	LineChart,
	PieChart,
	RadarChart,
	SankeyChart,
	ScatterChart,
} from "echarts/charts";
import {
	GridComponent,
	LegendComponent,
	MarkLineComponent,
	RadarComponent,
	TooltipComponent,
	VisualMapComponent,
} from "echarts/components";
import { type EChartsCoreOption, graphic, use } from "echarts/core";
import { LabelLayout } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";
import { h } from "../../../ui/dom.ts";
import { type ChartMount, type ChartSize, type ChartTheme, createChartHost, tint } from "./strategy-charts.ts";

use([
	LineChart,
	BarChart,
	ScatterChart,
	PieChart,
	SankeyChart,
	RadarChart,
	FunnelChart,
	HeatmapChart,
	GridComponent,
	TooltipComponent,
	LegendComponent,
	MarkLineComponent,
	RadarComponent,
	VisualMapComponent,
	LabelLayout,
	SVGRenderer,
]);

type Option = EChartsCoreOption;

const PREFIX_UNITS = new Set(["$", "€", "£", "¥"]);
const DEFAULT_SIZE: ChartSize = { width: 720, height: 340 };

function still(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function tipElement(
	heading: string,
	rows: readonly { readonly label?: string; readonly value: string; readonly color?: string }[],
	headingColor?: string,
): HTMLElement {
	const dot = headingColor ? h("i", { class: "studio-chart-tip-dot" }) : null;
	if (dot && headingColor) dot.style.backgroundColor = headingColor;
	const head = heading
		? h("div", { class: `studio-chart-tip-head${rows.length ? "" : " is-solo"}` }, dot, h("span", null, heading))
		: null;
	const body = rows.map((row) => {
		const rowDot = row.color ? h("i", { class: "studio-chart-tip-dot" }) : null;
		if (rowDot && row.color) rowDot.style.backgroundColor = row.color;
		const val = h("b", { class: "studio-chart-tip-val" }, row.value);
		if (!row.label) return h("div", { class: "studio-chart-tip-row is-plain" }, rowDot, val);
		return h(
			"div",
			{ class: "studio-chart-tip-row" },
			h("span", { class: "studio-chart-tip-label" }, rowDot, rowDot ? " " : null, row.label),
			val,
		);
	});
	return h("div", { class: "studio-chart-tip" }, head, ...body);
}

export interface SurfaceChartPaint {
	readonly palette?: readonly string[];
	readonly main?: string;
	readonly named?: Readonly<Record<string, string>>;
}

export interface SurfaceChartPaints {
	readonly light: SurfaceChartPaint;
	readonly dark: SurfaceChartPaint;
}

function palette(theme: ChartTheme, paint?: SurfaceChartPaint): readonly string[] {
	if (paint?.palette && paint.palette.length > 0) return paint.palette;
	return theme.dark
		? [theme.accent, "#5ed6a9", "#6aa8ff", "#f2c35d", "#d49bff", "#ff9084", "#70d6e8", "#f3a3c7"]
		: [theme.accent, "#0f7a55", "#2b6cb0", "#b7791f", "#7c4dff", "#b33a2f", "#0e8599", "#c24b7c"];
}

function fillOf(colors: readonly string[], paint: SurfaceChartPaint | undefined) {
	return (name: string | undefined, index: number): string =>
		(name !== undefined ? paint?.named?.[name] : undefined) ?? colors[index % colors.length]!;
}

function resolveColor(raw: string | undefined, container: HTMLElement, fallback: string): string {
	if (!raw) return fallback;
	const cssVar = /^var\((--[a-z0-9-]+)\)$/i.exec(raw.trim());
	if (!cssVar) return raw;
	const resolved = getComputedStyle(container).getPropertyValue(cssVar[1]!).trim();
	return resolved || fallback;
}

export function formatChartValue(value: number, unit?: string): string {
	if (!Number.isFinite(value)) return "–";
	const abs = Math.abs(value);
	const formatted =
		abs >= 1_000_000
			? `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
			: abs >= 10_000
				? `${(value / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`
				: Number.isInteger(value)
					? value.toLocaleString()
					: value.toLocaleString(undefined, { maximumFractionDigits: 2 });
	if (!unit) return formatted;
	if (PREFIX_UNITS.has(unit)) return `${unit}${formatted}`;
	if (unit === "%") return `${formatted}%`;
	return `${formatted} ${unit}`;
}

function verticalGradient(top: string, bottom: string) {
	return new graphic.LinearGradient(0, 0, 0, 1, [
		{ offset: 0, color: top },
		{ offset: 1, color: bottom },
	]);
}

function tooltipStyle(theme: ChartTheme): Option {
	const shadow = theme.dark ? "rgba(0, 0, 0, 0.5)" : "rgba(18, 18, 17, 0.14)";
	return {
		confine: true,
		appendTo: "body",
		transitionDuration: still() ? 0 : 0.16,
		backgroundColor: tint(theme.pane, theme.dark ? 0.92 : 0.95),
		borderColor: tint(theme.text, theme.dark ? 0.16 : 0.1),
		borderWidth: 1,
		padding: [10, 13],
		textStyle: { color: theme.text, fontFamily: theme.font, fontSize: 12.5 },
		extraCssText: `border-radius: 12px; box-shadow: 0 14px 36px ${shadow}; backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4); max-width: 280px; white-space: normal;`,
	};
}

function legendOption(theme: ChartTheme, show: boolean): Option {
	if (!show) return { show: false };
	return {
		show: true,
		top: 0,
		left: 0,
		itemWidth: 10,
		itemHeight: 10,
		itemGap: 16,
		icon: "circle",
		textStyle: { color: theme.muted, fontFamily: theme.font, fontSize: 12, fontWeight: 560 },
	};
}

function markLinesOf(
	lines: readonly SurfaceChartMarkLine[] | undefined,
	horizontal: boolean,
	theme: ChartTheme,
	unit?: string,
): Option | undefined {
	if (!lines || lines.length === 0) return undefined;
	return {
		silent: true,
		symbol: "none",
		lineStyle: { color: tint(theme.text, 0.42), width: 1.25, type: [4, 4] },
		label: {
			show: true,
			position: horizontal ? "insideEndTop" : "insideEndTop",
			color: theme.muted,
			fontFamily: theme.font,
			fontSize: 11,
			fontWeight: 620,
		},
		data: lines.map((line) => ({
			...(horizontal ? { xAxis: line.value } : { yAxis: line.value }),
			label: {
				formatter: line.label
					? `${line.label} · ${formatChartValue(line.value, unit)}`
					: formatChartValue(line.value, unit),
			},
		})),
	};
}

function pointNumber(item: number | null | SurfaceChartPoint): number | null {
	if (item === null) return null;
	if (typeof item === "number") return item;
	return typeof item.value === "number" ? item.value : item.value[1];
}

function buildCartesianOption(
	doc: SurfaceChartDocument,
	theme: ChartTheme,
	container: HTMLElement,
	paint: SurfaceChartPaint | undefined,
): Option {
	const colors = palette(theme, paint);
	const fill = fillOf(colors, paint);
	const seriesList = doc.series ?? [];
	const horizontal = doc.kind === "bar" && doc.horizontal === true;
	const showLegend = doc.showLegend ?? seriesList.length > 1;
	const categories =
		doc.categories ??
		(doc.kind !== "scatter"
			? Array.from({ length: Math.max(...seriesList.map((entry) => entry.data.length), 0) }, (_, index) => {
					const firstPoint = seriesList[0]?.data[index];
					if (firstPoint && typeof firstPoint === "object" && firstPoint.name) return firstPoint.name;
					return String(index + 1);
				})
			: undefined);
	const axisText = { color: theme.soft, fontFamily: theme.font, fontSize: 11.5 };
	const splitLine = { lineStyle: { color: tint(theme.text, theme.dark ? 0.08 : 0.06), type: [3, 4] } };
	const axisLine = { lineStyle: { color: tint(theme.text, 0.14) } };
	const nameStyle = { color: theme.muted, fontFamily: theme.font, fontSize: 12, fontWeight: 620 };
	const categoryAxis: Option = {
		type: "category",
		data: categories ?? [],
		name: horizontal ? doc.yAxisLabel : doc.xAxisLabel,
		nameLocation: "middle",
		nameGap: horizontal ? 56 : 30,
		nameTextStyle: nameStyle,
		axisTick: { show: false },
		axisLine,
		axisLabel: { ...axisText, color: theme.muted, hideOverlap: true },
	};
	const valueMin = horizontal ? (doc.xAxisMin ?? doc.yAxisMin) : doc.yAxisMin;
	const valueMax = horizontal ? (doc.xAxisMax ?? doc.yAxisMax) : doc.yAxisMax;
	const valueAxis: Option = {
		type: "value",
		splitNumber: 4,
		...(valueMin !== undefined ? { min: valueMin } : {}),
		...(valueMax !== undefined ? { max: valueMax } : {}),
		name: horizontal ? doc.xAxisLabel : doc.yAxisLabel,
		nameLocation: "middle",
		nameGap: horizontal ? 32 : 52,
		nameTextStyle: nameStyle,
		axisTick: { show: false },
		axisLine: doc.kind === "scatter" ? axisLine : { show: false },
		splitLine,
		axisLabel: {
			...axisText,
			formatter: (value: number) => formatChartValue(value, doc.unit),
		},
	};
	const scatterXAxis: Option = {
		type: "value",
		splitNumber: 4,
		...(doc.xAxisMin !== undefined ? { min: doc.xAxisMin } : {}),
		...(doc.xAxisMax !== undefined ? { max: doc.xAxisMax } : {}),
		name: doc.xAxisLabel,
		nameLocation: "middle",
		nameGap: 30,
		nameTextStyle: nameStyle,
		axisTick: { show: false },
		axisLine,
		splitLine,
		axisLabel: axisText,
	};

	let maxBubble = 0;
	if (doc.kind === "scatter") {
		for (const series of seriesList) {
			for (const entry of series.data) {
				if (entry && typeof entry === "object" && Array.isArray(entry.value) && entry.value.length === 3) {
					maxBubble = Math.max(maxBubble, Math.abs(entry.value[2]));
				}
			}
		}
	}

	const echartsSeries = seriesList.map((series: SurfaceChartSeries, index: number) => {
		const color = resolveColor(series.color, container, fill(series.name, index));
		const markLine = markLinesOf(series.markLine, horizontal, theme, doc.unit);
		if (doc.kind === "bar") {
			const barRadius = doc.stacked ? 0 : horizontal ? [0, 5, 5, 0] : [5, 5, 0, 0];
			return {
				name: series.name,
				type: "bar",
				...(doc.stacked ? { stack: "total" } : {}),
				barMaxWidth: 44,
				itemStyle: {
					color,
					borderRadius: barRadius,
				},
				emphasis: { focus: "series" },
				data: series.data.map((entry) => {
					if (entry === null || typeof entry === "number") return entry;
					const itemColor = entry.color ? resolveColor(entry.color, container, color) : undefined;
					return {
						value: pointNumber(entry),
						...(entry.name ? { name: entry.name } : {}),
						...(itemColor ? { itemStyle: { color: itemColor, borderRadius: barRadius } } : {}),
					};
				}),
				...(markLine ? { markLine } : {}),
			};
		}
		if (doc.kind === "scatter") {
			return {
				name: series.name,
				type: "scatter",
				symbolSize: (value: unknown) => {
					if (Array.isArray(value) && typeof value[2] === "number" && maxBubble > 0) {
						return Math.round(9 + Math.sqrt(Math.abs(value[2]) / maxBubble) * 24);
					}
					return 11;
				},
				itemStyle: { color: tint(color, 0.85), borderColor: theme.bg, borderWidth: 1.5 },
				emphasis: { scale: 1.25 },
				data: series.data.flatMap((entry, pointIndex) => {
					if (entry === null) return [];
					if (typeof entry === "number") return [{ value: [pointIndex, entry] }];
					const tuple = Array.isArray(entry.value) ? [...entry.value] : [pointIndex, entry.value];
					const itemColor = entry.color ? resolveColor(entry.color, container, color) : undefined;
					return [
						{
							value: tuple,
							...(entry.name ? { name: entry.name } : {}),
							...(entry.label
								? {
										label: {
											show: true,
											formatter: entry.label,
											position: "top",
											color: theme.muted,
											fontSize: 11,
										},
									}
								: {}),
							...(itemColor
								? { itemStyle: { color: tint(itemColor, 0.85), borderColor: theme.bg, borderWidth: 1.5 } }
								: {}),
						},
					];
				}),
				...(markLine ? { markLine } : {}),
			};
		}
		const isArea = doc.kind === "area";
		return {
			name: series.name,
			type: "line",
			...(doc.stacked ? { stack: "total" } : {}),
			smooth: doc.smooth ? 0.32 : false,
			showSymbol: series.data.length <= 24,
			symbol: "circle",
			symbolSize: 7,
			lineStyle: { width: 2.5, color, cap: "round", join: "round" },
			itemStyle: { color, borderColor: theme.bg, borderWidth: 1.5 },
			...(isArea
				? {
						areaStyle: {
							color: verticalGradient(tint(color, theme.dark ? 0.34 : 0.28), tint(color, 0.02)),
						},
					}
				: {}),
			emphasis: { focus: "series" },
			data: series.data.map((entry) => {
				if (entry === null || typeof entry === "number") return entry;
				const itemColor = entry.color ? resolveColor(entry.color, container, color) : undefined;
				if (!entry.name && !itemColor) return pointNumber(entry);
				return {
					value: pointNumber(entry),
					...(entry.name ? { name: entry.name } : {}),
					...(itemColor ? { itemStyle: { color: itemColor, borderColor: theme.bg, borderWidth: 1.5 } } : {}),
				};
			}),
			...(markLine ? { markLine } : {}),
		};
	});

	return {
		animation: !still(),
		animationDuration: 520,
		legend: legendOption(theme, showLegend),
		grid: {
			left: horizontal ? 110 : doc.yAxisLabel ? 76 : 60,
			right: 24,
			top: showLegend ? 42 : 20,
			bottom: doc.xAxisLabel ? 52 : 34,
		},
		tooltip: {
			...tooltipStyle(theme),
			trigger: doc.kind === "scatter" ? "item" : "axis",
			...(doc.kind === "scatter"
				? {
						formatter: (params: unknown) => {
							const item = params as { seriesName?: string; name?: string; value?: unknown; color?: string };
							const vals = Array.isArray(item.value) ? item.value : [];
							const x = typeof vals[0] === "number" ? formatChartValue(vals[0]) : "";
							const y = typeof vals[1] === "number" ? formatChartValue(vals[1], doc.unit) : "";
							const z = typeof vals[2] === "number" ? ` · ${formatChartValue(vals[2])}` : "";
							const heading = item.name || item.seriesName || "";
							return tipElement(heading, [{ label: x, value: `${y}${z}` }], String(item.color ?? theme.accent));
						},
					}
				: {
						axisPointer: {
							type: doc.kind === "bar" ? "shadow" : "line",
							lineStyle: { color: tint(theme.text, 0.28), type: [3, 3] },
							shadowStyle: { color: tint(theme.text, theme.dark ? 0.06 : 0.04) },
						},
						formatter: (params: unknown) => {
							const entries = (Array.isArray(params) ? params : [params]) as {
								axisValueLabel?: string;
								name?: string;
								seriesName?: string;
								value?: unknown;
								color?: unknown;
							}[];
							const first = entries[0];
							if (!first) return "";
							const heading = String(first.axisValueLabel ?? first.name ?? "");
							const rows = entries.map((entry) => {
								const rawVal = Array.isArray(entry.value) ? entry.value[1] : entry.value;
								const valueText = typeof rawVal === "number" ? formatChartValue(rawVal, doc.unit) : "–";
								const color = typeof entry.color === "string" ? entry.color : theme.accent;
								return {
									...(entry.seriesName ? { label: entry.seriesName } : {}),
									value: valueText,
									color,
								};
							});
							return tipElement(heading, rows);
						},
					}),
		},
		xAxis: doc.kind === "scatter" ? scatterXAxis : horizontal ? valueAxis : categoryAxis,
		yAxis: horizontal ? categoryAxis : valueAxis,
		series: echartsSeries,
	};
}

function buildPieOption(
	doc: SurfaceChartDocument,
	theme: ChartTheme,
	container: HTMLElement,
	paint: SurfaceChartPaint | undefined,
): Option {
	const colors = palette(theme, paint);
	const fill = fillOf(colors, paint);
	const primary = doc.series?.[0];
	const showLegend = doc.showLegend ?? true;
	const slices = (primary?.data ?? []).flatMap((entry, index) => {
		const value = pointNumber(entry);
		if (value === null || value < 0) return [];
		const name = (entry && typeof entry === "object" && entry.name) || doc.categories?.[index] || `Item ${index + 1}`;
		const rawColor = entry && typeof entry === "object" ? entry.color : undefined;
		const color = resolveColor(rawColor, container, fill(name, index));
		return [{ name, value, itemStyle: { color } }];
	});
	return {
		animation: !still(),
		animationDuration: 520,
		legend: showLegend
			? {
					show: true,
					bottom: 0,
					left: "center",
					itemWidth: 10,
					itemHeight: 10,
					icon: "circle",
					textStyle: { color: theme.muted, fontFamily: theme.font, fontSize: 12 },
				}
			: { show: false },
		tooltip: {
			...tooltipStyle(theme),
			trigger: "item",
			formatter: (params: unknown) => {
				const item = params as { name?: string; value?: number; percent?: number; color?: string };
				const valueText = typeof item.value === "number" ? formatChartValue(item.value, doc.unit) : "–";
				const pct = typeof item.percent === "number" ? ` (${item.percent}%)` : "";
				return tipElement(item.name ?? "", [{ value: `${valueText}${pct}` }], String(item.color ?? theme.accent));
			},
		},
		series: [
			{
				name: primary?.name ?? doc.title ?? "Share",
				type: "pie",
				radius: doc.donut ? ["48%", "74%"] : ["0%", "74%"],
				center: ["50%", showLegend ? "45%" : "50%"],
				itemStyle: { borderRadius: 6, borderColor: theme.bg, borderWidth: 2 },
				label: {
					show: slices.length <= 8,
					color: theme.text,
					fontFamily: theme.font,
					fontSize: 12,
					formatter: "{b}: {d}%",
				},
				labelLine: { lineStyle: { color: tint(theme.text, 0.25) } },
				data: slices,
			},
		],
	};
}

function buildSankeyOption(
	doc: SurfaceChartDocument,
	theme: ChartTheme,
	container: HTMLElement,
	paint: SurfaceChartPaint | undefined,
): Option {
	const colors = palette(theme, paint);
	const fill = fillOf(colors, paint);
	const nodes = (doc.nodes ?? []).map((node, index) => ({
		name: node.name,
		itemStyle: {
			color: resolveColor(node.color, container, fill(node.name, index)),
			borderRadius: 3,
			borderWidth: 0,
		},
	}));
	return {
		animation: false,
		tooltip: {
			...tooltipStyle(theme),
			trigger: "item",
			formatter: (params: unknown) => {
				const item = params as {
					dataType?: string;
					name?: string;
					value?: number;
					data?: { source?: string; target?: string; value?: number };
				};
				if (item.dataType === "edge" && item.data) {
					const val = typeof item.data.value === "number" ? formatChartValue(item.data.value, doc.unit) : "";
					return tipElement(`${item.data.source ?? ""} → ${item.data.target ?? ""}`, [{ value: val }]);
				}
				const val = typeof item.value === "number" ? formatChartValue(item.value, doc.unit) : "";
				return tipElement(item.name ?? "", [{ value: val }]);
			},
		},
		series: [
			{
				type: "sankey",
				left: "12%",
				right: "16%",
				top: 16,
				bottom: 16,
				nodeWidth: 12,
				nodeGap: 18,
				draggable: false,
				emphasis: { focus: "adjacency" },
				lineStyle: { color: "gradient", opacity: 0.42, curveness: 0.48 },
				label: { color: theme.text, fontFamily: theme.font, fontSize: 12.5, fontWeight: 560 },
				labelLayout: { moveOverlap: "shiftY" },
				data: nodes,
				links: doc.links ?? [],
			},
		],
	};
}

function buildRadarOption(
	doc: SurfaceChartDocument,
	theme: ChartTheme,
	container: HTMLElement,
	paint: SurfaceChartPaint | undefined,
): Option {
	const colors = palette(theme, paint);
	const fill = fillOf(colors, paint);
	const seriesList = doc.series ?? [];
	const showLegend = doc.showLegend ?? seriesList.length > 1;
	return {
		animation: !still(),
		animationDuration: 520,
		legend: legendOption(theme, showLegend),
		tooltip: {
			...tooltipStyle(theme),
			trigger: "item",
			formatter: (params: unknown) => {
				const item = params as { name?: string; value?: readonly number[]; color?: string };
				const indicators = doc.indicators ?? [];
				const values = Array.isArray(item.value) ? item.value : [];
				const rows = indicators.map((indicator, idx) => ({
					label: indicator.name,
					value: typeof values[idx] === "number" ? formatChartValue(values[idx], doc.unit) : "–",
				}));
				return tipElement(item.name ?? "", rows, typeof item.color === "string" ? item.color : theme.accent);
			},
		},
		radar: {
			center: ["50%", showLegend ? "54%" : "50%"],
			radius: "66%",
			indicator: (doc.indicators ?? []).map((item) => ({ name: item.name, max: item.max })),
			axisName: { color: theme.muted, fontFamily: theme.font, fontSize: 12, fontWeight: 560 },
			splitArea: { areaStyle: { color: [tint(theme.text, 0.02), tint(theme.text, 0.04)] } },
			splitLine: { lineStyle: { color: tint(theme.text, 0.12) } },
			axisLine: { lineStyle: { color: tint(theme.text, 0.14) } },
		},
		series: [
			{
				type: "radar",
				data: seriesList.map((series, index) => {
					const color = resolveColor(series.color, container, fill(series.name, index));
					const values = (doc.indicators ?? []).map((_, idx) => pointNumber(series.data[idx] ?? 0) ?? 0);
					return {
						name: series.name,
						value: values,
						lineStyle: { color, width: 2.2 },
						itemStyle: { color },
						areaStyle: { color: tint(color, theme.dark ? 0.24 : 0.18) },
					};
				}),
			},
		],
	};
}

function buildFunnelOption(
	doc: SurfaceChartDocument,
	theme: ChartTheme,
	container: HTMLElement,
	paint: SurfaceChartPaint | undefined,
): Option {
	const colors = palette(theme, paint);
	const fill = fillOf(colors, paint);
	const primary = doc.series?.[0];
	const stages = (primary?.data ?? []).flatMap((entry, index) => {
		const value = pointNumber(entry);
		if (value === null || value < 0) return [];
		const name =
			(entry && typeof entry === "object" && entry.name) || doc.categories?.[index] || `Stage ${index + 1}`;
		const rawColor = entry && typeof entry === "object" ? entry.color : undefined;
		const color = resolveColor(rawColor, container, fill(name, index));
		return [{ name, value, itemStyle: { color } }];
	});
	return {
		animation: !still(),
		animationDuration: 520,
		tooltip: {
			...tooltipStyle(theme),
			trigger: "item",
			formatter: (params: unknown) => {
				const item = params as { name?: string; value?: number; color?: string };
				const valueText = typeof item.value === "number" ? formatChartValue(item.value, doc.unit) : "–";
				return tipElement(item.name ?? "", [{ value: valueText }], String(item.color ?? theme.accent));
			},
		},
		series: [
			{
				name: primary?.name ?? doc.title ?? "Funnel",
				type: "funnel",
				left: "14%",
				right: "14%",
				top: 18,
				bottom: 18,
				minSize: "18%",
				maxSize: "100%",
				sort: "none",
				gap: 4,
				itemStyle: { borderColor: theme.bg, borderWidth: 2, borderRadius: 4 },
				label: {
					show: true,
					position: "inside",
					color: "#ffffff",
					fontFamily: theme.font,
					fontSize: 12.5,
					fontWeight: 650,
					formatter: (params: unknown) => {
						const item = params as { name?: string; value?: number };
						return `${item.name ?? ""} · ${typeof item.value === "number" ? formatChartValue(item.value, doc.unit) : ""}`;
					},
				},
				data: stages,
			},
		],
	};
}

function buildHeatmapOption(
	doc: SurfaceChartDocument,
	theme: ChartTheme,
	paint: SurfaceChartPaint | undefined,
): Option {
	const main = paint?.main ?? theme.accent;
	const cells = doc.cells ?? [];
	const values = cells.map((cell) => cell[2]);
	const min = values.length > 0 ? Math.min(...values) : 0;
	const max = values.length > 0 ? Math.max(...values) : 1;
	const xCats = doc.xCategories ?? [];
	const yCats = doc.yCategories ?? [];
	const rotateX = xCats.length > 6 ? 30 : 0;
	const axisText = { color: theme.muted, fontFamily: theme.font, fontSize: 11.5 };
	return {
		animation: !still(),
		animationDuration: 420,
		grid: { left: 96, right: 24, top: 18, bottom: rotateX ? 88 : 56 },
		tooltip: {
			...tooltipStyle(theme),
			position: "top",
			formatter: (params: unknown) => {
				const item = params as { value?: readonly [number, number, number] };
				const cell = item.value;
				if (!cell) return "";
				const x = xCats[cell[0]] ?? String(cell[0]);
				const y = yCats[cell[1]] ?? String(cell[1]);
				return tipElement(`${y} × ${x}`, [{ value: formatChartValue(cell[2], doc.unit) }]);
			},
		},
		xAxis: {
			type: "category",
			data: xCats,
			axisTick: { show: false },
			axisLine: { show: false },
			axisLabel: { ...axisText, interval: 0, rotate: rotateX, overflow: "truncate", width: 88 },
			splitArea: { show: true, areaStyle: { color: [tint(theme.text, 0.015), "transparent"] } },
		},
		yAxis: {
			type: "category",
			data: yCats,
			axisTick: { show: false },
			axisLine: { show: false },
			axisLabel: axisText,
			splitArea: { show: true, areaStyle: { color: [tint(theme.text, 0.015), "transparent"] } },
		},
		visualMap: {
			min,
			max: max === min ? min + 1 : max,
			calculable: false,
			orient: "horizontal",
			left: "center",
			bottom: 2,
			itemWidth: 12,
			itemHeight: 110,
			textStyle: { color: theme.soft, fontFamily: theme.font, fontSize: 11 },
			inRange: {
				color: [tint(main, theme.dark ? 0.14 : 0.08), tint(main, 0.45), main],
			},
		},
		series: [
			{
				type: "heatmap",
				data: cells.map(([x, y, v]) => [x, y, v]),
				label: {
					show: cells.length <= 100,
					color: theme.text,
					fontFamily: theme.font,
					fontSize: 11,
					fontWeight: 620,
					formatter: (params: unknown) => {
						const cell = (params as { value?: readonly [number, number, number] }).value;
						return cell ? formatChartValue(cell[2], doc.unit) : "";
					},
				},
				itemStyle: { borderColor: theme.bg, borderWidth: 2, borderRadius: 4 },
				emphasis: { itemStyle: { shadowBlur: 10, shadowColor: tint(theme.text, 0.25) } },
			},
		],
	};
}

function buildSurfaceChartOption(
	doc: SurfaceChartDocument,
	theme: ChartTheme,
	container: HTMLElement,
	paints: SurfaceChartPaints | undefined,
): Option {
	const paint = paints ? (theme.dark ? paints.dark : paints.light) : undefined;
	switch (doc.kind) {
		case "pie":
			return buildPieOption(doc, theme, container, paint);
		case "sankey":
			return buildSankeyOption(doc, theme, container, paint);
		case "radar":
			return buildRadarOption(doc, theme, container, paint);
		case "funnel":
			return buildFunnelOption(doc, theme, container, paint);
		case "heatmap":
			return buildHeatmapOption(doc, theme, paint);
		default:
			return buildCartesianOption(doc, theme, container, paint);
	}
}

export function mountSurfaceChart(
	container: HTMLElement,
	signal: AbortSignal,
	initial: SurfaceChartDocument,
	fallback: ChartSize = DEFAULT_SIZE,
	paints?: SurfaceChartPaints,
): ChartMount<SurfaceChartDocument> {
	const host = createChartHost(container, signal, fallback);
	let data = initial;
	const paint = (theme: ChartTheme) => buildSurfaceChartOption(data, theme, container, paints);
	host.paint(paint);
	return {
		update: (next) => {
			data = next;
			host.paint(paint);
		},
		disposed: host.disposed,
		dispose: host.dispose,
	};
}
