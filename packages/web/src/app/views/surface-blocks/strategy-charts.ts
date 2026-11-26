import { BarChart, EffectScatterChart, LineChart, SankeyChart, ScatterChart } from "echarts/charts";
import {
	GridComponent,
	MarkAreaComponent,
	MarkLineComponent,
	MarkPointComponent,
	TooltipComponent,
} from "echarts/components";
import { type ECharts, type EChartsCoreOption, graphic, init, use } from "echarts/core";
import { LabelLayout } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";

use([
	SankeyChart,
	BarChart,
	LineChart,
	ScatterChart,
	EffectScatterChart,
	GridComponent,
	TooltipComponent,
	MarkLineComponent,
	MarkAreaComponent,
	MarkPointComponent,
	LabelLayout,
	SVGRenderer,
]);

export interface ChartTheme {
	readonly text: string;
	readonly muted: string;
	readonly soft: string;
	readonly border: string;
	readonly bg: string;
	readonly pane: string;
	readonly accent: string;
	readonly good: string;
	readonly warn: string;
	readonly bad: string;
	readonly font: string;
	readonly dark: boolean;
}

export interface ChartSize {
	readonly width: number;
	readonly height: number;
}

export interface ChartHost {
	readonly chart: ECharts;
	readonly theme: () => ChartTheme;
	readonly paint: (build: (theme: ChartTheme) => EChartsCoreOption) => void;
	readonly disposed: () => boolean;
	readonly dispose: () => void;
}

export interface ChartMount<T> {
	readonly update: (data: T) => void;
	readonly disposed: () => boolean;
	readonly dispose: () => void;
}

type Option = EChartsCoreOption;
type Row = readonly [label: string, value: string, tone?: string];

const LIGHT: ChartTheme = {
	text: "#161615",
	muted: "#686866",
	soft: "#92928e",
	border: "rgba(18, 18, 17, 0.09)",
	bg: "#ffffff",
	pane: "#ffffff",
	accent: "#d76f45",
	good: "#0f7a55",
	warn: "#9a6300",
	bad: "#b33a2f",
	font: "system-ui, sans-serif",
	dark: false,
};
const DARK: ChartTheme = {
	...LIGHT,
	text: "#f4f3f0",
	muted: "#b8b7b2",
	soft: "#908f8a",
	border: "rgba(255, 255, 255, 0.09)",
	bg: "#1f2120",
	pane: "#1f2120",
	accent: "#e5835c",
	good: "#5ed6a9",
	warn: "#f2c35d",
	bad: "#ff9084",
	dark: true,
};
const DEFAULT_SIZE: ChartSize = { width: 720, height: 340 };

function isDark(): boolean {
	return document.documentElement.dataset.theme === "dark";
}

function readTheme(el: HTMLElement): ChartTheme {
	const style = getComputedStyle(el);
	const base = isDark() ? DARK : LIGHT;
	const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	return {
		text: pick("--text", base.text),
		muted: pick("--text-muted", base.muted),
		soft: pick("--text-soft", base.soft),
		border: pick("--border", base.border),
		bg: pick("--bg", base.bg),
		pane: pick("--pane", base.pane),
		accent: pick("--studio-accent", pick("--accent", base.accent)),
		good: pick("--studio-good", base.good),
		warn: pick("--studio-warn", base.warn),
		bad: pick("--studio-bad", base.bad),
		font: pick("--font-sans", base.font),
		dark: base.dark,
	};
}

function channels(color: string): [number, number, number, number] | null {
	const trimmed = color.trim();
	const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed);
	if (hex) {
		let body = hex[1]!;
		if (body.length === 3 || body.length === 4) body = [...body].map((char) => char + char).join("");
		if (body.length !== 6 && body.length !== 8) return null;
		const at = (index: number) => Number.parseInt(body.slice(index, index + 2), 16);
		return [at(0), at(2), at(4), body.length === 8 ? at(6) / 255 : 1];
	}
	const num = (part: string, scale: number) =>
		part.endsWith("%") ? (Number.parseFloat(part) / 100) * scale : Number.parseFloat(part);
	const fn = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
	if (fn) {
		const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean);
		if (parts.length < 3) return null;
		const rgb = [num(parts[0]!, 255), num(parts[1]!, 255), num(parts[2]!, 255)];
		const alpha = parts[3] === undefined ? 1 : num(parts[3], 1);
		if (![...rgb, alpha].every(Number.isFinite)) return null;
		return [rgb[0]!, rgb[1]!, rgb[2]!, alpha];
	}
	const hsl = /^hsla?\(([^)]+)\)$/i.exec(trimmed);
	if (!hsl) return null;
	const parts = hsl[1]!.split(/[\s,/]+/).filter(Boolean);
	if (parts.length < 3 || !parts[1]!.endsWith("%") || !parts[2]!.endsWith("%")) return null;
	const h = Number.parseFloat(parts[0]!);
	const s = Math.max(0, Math.min(100, Number.parseFloat(parts[1]!))) / 100;
	const l = Math.max(0, Math.min(100, Number.parseFloat(parts[2]!))) / 100;
	const alpha = parts[3] === undefined ? 1 : num(parts[3], 1);
	if (![h, s, l, alpha].every(Number.isFinite)) return null;
	const hue = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = l - c / 2;
	const [r1, g1, b1] =
		hue < 60
			? [c, x, 0]
			: hue < 120
				? [x, c, 0]
				: hue < 180
					? [0, c, x]
					: hue < 240
						? [0, x, c]
						: hue < 300
							? [x, 0, c]
							: [c, 0, x];
	return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255, alpha];
}

export function tint(color: string, alpha: number): string {
	const rgb = channels(color);
	if (!rgb) return color;
	const a = Math.round(Math.max(0, Math.min(1, rgb[3] * alpha)) * 1000) / 1000;
	return `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${a})`;
}

function rose(theme: ChartTheme): string {
	return theme.dark ? "#e3a296" : "#c4806f";
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function still(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function motion(): Option {
	const calm = still();
	return {
		animation: !calm,
		animationDuration: 700,
		animationDurationUpdate: 420,
		animationEasing: "cubicOut",
		animationEasingUpdate: "cubicInOut",
	};
}

function vertical(top: string, bottom: string) {
	return new graphic.LinearGradient(0, 0, 0, 1, [
		{ offset: 0, color: top },
		{ offset: 1, color: bottom },
	]);
}

function tooltipBase(theme: ChartTheme): Option {
	const shadow = theme.dark ? "rgba(0, 0, 0, 0.5)" : "rgba(18, 18, 17, 0.14)";
	return {
		confine: true,
		appendTo: "body",
		transitionDuration: still() ? 0 : 0.18,
		backgroundColor: tint(theme.pane, theme.dark ? 0.9 : 0.94),
		borderColor: tint(theme.text, theme.dark ? 0.16 : 0.1),
		borderWidth: 1,
		padding: [10, 13],
		textStyle: { color: theme.text, fontFamily: theme.font, fontSize: 12.5 },
		extraCssText: `border-radius: 12px; box-shadow: 0 14px 36px ${shadow}; backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4); max-width: 280px; white-space: normal;`,
	};
}

function tipHtml(theme: ChartTheme, heading: string, rows: readonly Row[], accent?: string): string {
	const dot = accent ? `<i style="width:8px;height:8px;border-radius:50%;background:${accent};flex:none"></i>` : "";
	const gap = rows.length ? 7 : 0;
	const head = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:${gap}px;font-weight:700;font-size:13px;color:${theme.text}">${dot}<span>${escapeHtml(heading)}</span></div>`;
	const body = rows
		.map(([label, value, tone]) => {
			const figure = `<b style="font-variant-numeric:tabular-nums;font-weight:680;color:${tone ?? theme.text}">${escapeHtml(value)}</b>`;
			if (!label) return `<div style="line-height:1.55">${figure}</div>`;
			return `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:18px;line-height:1.55"><span style="color:${theme.muted}">${escapeHtml(label)}</span>${figure}</div>`;
		})
		.join("");
	return head + body;
}

export function createChartHost(
	container: HTMLElement,
	signal: AbortSignal,
	fallback: ChartSize = DEFAULT_SIZE,
): ChartHost {
	const size = (): ChartSize => ({
		width: container.clientWidth || fallback.width,
		height: container.clientHeight || fallback.height,
	});
	const chart = init(container, null, { renderer: "svg", ...size() });
	let theme = readTheme(container);
	let build: ((theme: ChartTheme) => Option) | null = null;
	let gone = false;
	let seen = container.isConnected;
	let last = size();
	const life = new AbortController();
	const themeWatch =
		typeof MutationObserver === "function"
			? new MutationObserver(() => {
					if (!alive()) return;
					theme = readTheme(container);
					if (build) chart.setOption(build(theme), true);
				})
			: null;
	const sizeWatch =
		typeof ResizeObserver === "function"
			? new ResizeObserver(() => {
					if (!alive()) return;
					const next = size();
					if (next.width === last.width && next.height === last.height) return;
					last = next;
					theme = readTheme(container);
					chart.resize(next);
					if (build) chart.setOption(build(theme), true);
				})
			: null;
	function dispose(): void {
		if (gone) return;
		gone = true;
		life.abort();
		themeWatch?.disconnect();
		sizeWatch?.disconnect();
		chart.dispose();
	}
	function alive(): boolean {
		if (gone) return false;
		if (container.isConnected) {
			seen = true;
			return true;
		}
		if (seen) dispose();
		return !gone;
	}
	themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	sizeWatch?.observe(container);
	signal.addEventListener("abort", dispose, { once: true, signal: life.signal });
	if (signal.aborted) dispose();
	return {
		chart,
		theme: () => theme,
		paint: (next) => {
			build = next;
			if (gone) return;
			theme = readTheme(container);
			chart.setOption(next(theme), true);
		},
		disposed: () => gone,
		dispose,
	};
}

export type FlowKind = "income" | "cost" | "total" | "shortfall";

export interface FlowStream {
	readonly id: string;
	readonly label: string;
	readonly kind: FlowKind;
	readonly size: number;
	readonly signed: number;
}

export interface MoneyFlowData {
	readonly left: readonly FlowStream[];
	readonly right: readonly FlowStream[];
	readonly revenue: number;
}

export interface MoneyFlowOptions {
	readonly hub: string;
	readonly money: (value: number) => string;
	readonly percent: (ratio: number) => string;
	readonly share: (ratio: number) => string;
	readonly onHover?: (stream: FlowStream | null) => void;
	readonly onPick?: (stream: FlowStream) => void;
}

interface FlowDatum {
	readonly stream?: FlowStream;
}

const HUB = "__hub__";

function streamColor(theme: ChartTheme, kind: FlowKind): string {
	if (kind === "income") return theme.accent;
	if (kind === "cost") return rose(theme);
	if (kind === "total") return theme.good;
	return theme.bad;
}

function datumStream(params: unknown): FlowStream | null {
	const data = (params as { data?: FlowDatum } | null)?.data;
	return data?.stream ?? null;
}

export function mountMoneyFlowChart(
	container: HTMLElement,
	signal: AbortSignal,
	initial: MoneyFlowData,
	options: MoneyFlowOptions,
): ChartMount<MoneyFlowData> {
	const host = createChartHost(container, signal);
	let data = initial;
	const figure = (stream: FlowStream, revenue: number) => {
		const money = options.money(stream.signed);
		if (stream.kind === "income" || revenue <= 0) return money;
		return `${money} · ${options.percent(stream.size / revenue)}`;
	};
	const build = (theme: ChartTheme): Option => {
		const useHub = data.left.length > 1;
		const leftKeys = data.left.map((_, index) => `L:${index}`);
		const rightKeys = data.right.map((_, index) => `R:${index}`);
		const nodeOf = (stream: FlowStream, side: "left" | "right", key: string) => {
			const color = streamColor(theme, stream.kind);
			return {
				name: key,
				stream,
				depth: side === "left" ? 0 : useHub ? 2 : 1,
				itemStyle: { color, borderColor: color, borderWidth: 0, borderRadius: 3 },
				label: {
					position: side === "left" ? "left" : "right",
					formatter: `{name|${stream.label.replace(/[{}|]/g, "")}}\n{amount|${figure(stream, data.revenue).replace(/[{}|]/g, "")}}`,
					rich: {
						name: {
							color: stream.kind === "shortfall" ? theme.bad : theme.text,
							fontSize: 13,
							fontWeight: 650,
							lineHeight: 18,
							fontFamily: theme.font,
						},
						amount: {
							color:
								stream.kind === "total" ? theme.good : stream.kind === "shortfall" ? theme.bad : theme.muted,
							fontSize: 12,
							fontWeight: stream.kind === "total" ? 700 : 560,
							lineHeight: 16,
							fontFamily: theme.font,
						},
					},
				},
			};
		};
		const nodes: object[] = [
			...data.left.map((stream, index) => nodeOf(stream, "left", leftKeys[index]!)),
			...data.right.map((stream, index) => nodeOf(stream, "right", rightKeys[index]!)),
		];
		const links: object[] = [];
		if (useHub) {
			const total = data.left.reduce((sum, item) => sum + item.size, 0);
			nodes.splice(data.left.length, 0, {
				name: HUB,
				depth: 1,
				tooltip: { show: false },
				itemStyle: { color: tint(theme.text, 0.82), borderRadius: 3 },
				label: {
					position: "top",
					distance: 8,
					formatter: `{amount|${options.hub.replace(/[{}|]/g, "")} · ${options.money(total).replace(/[{}|]/g, "")}}`,
					rich: { amount: { color: theme.muted, fontSize: 11.5, fontWeight: 650, fontFamily: theme.font } },
				},
			});
			for (let index = 0; index < data.left.length; index++) {
				const stream = data.left[index]!;
				links.push({ source: leftKeys[index]!, target: HUB, value: stream.size, stream });
			}
			for (let index = 0; index < data.right.length; index++) {
				const stream = data.right[index]!;
				links.push({ source: HUB, target: rightKeys[index]!, value: stream.size, stream });
			}
		} else {
			const sourceKey = leftKeys[0];
			if (sourceKey) {
				for (let index = 0; index < data.right.length; index++) {
					const stream = data.right[index]!;
					links.push({ source: sourceKey, target: rightKeys[index]!, value: stream.size, stream });
				}
			}
		}
		return {
			...motion(),
			tooltip: {
				...tooltipBase(theme),
				trigger: "item",
				formatter: (params: unknown) => {
					const stream = datumStream(params);
					if (!stream) return "";
					const tone = streamColor(theme, stream.kind);
					const rows: Row[] = [["", options.money(stream.signed), tone]];
					if (data.revenue > 0 && stream.kind !== "income") {
						rows.push(["", options.share(stream.size / data.revenue), theme.muted]);
					}
					return tipHtml(theme, stream.label, rows, tone);
				},
			},
			series: [
				{
					type: "sankey",
					animation: false,
					left: "22%",
					right: "22%",
					top: 18,
					bottom: 18,
					nodeWidth: 12,
					nodeGap: 22,
					nodeAlign: "justify",
					layoutIterations: 0,
					draggable: false,
					emphasis: { focus: "adjacency", lineStyle: { opacity: 0.68 } },
					blur: { lineStyle: { opacity: 0.08 }, itemStyle: { opacity: 0.35 }, label: { opacity: 0.45 } },
					lineStyle: { color: "gradient", opacity: 0.42, curveness: 0.48 },
					label: { show: true, distance: 10, fontFamily: theme.font },
					labelLayout: { moveOverlap: "shiftY" },
					data: nodes,
					links,
				},
			],
		};
	};
	host.chart.on("mouseover", (params: unknown) => options.onHover?.(datumStream(params)));
	host.chart.on("mouseout", () => options.onHover?.(null));
	host.chart.on("click", (params: unknown) => {
		const stream = datumStream(params);
		if (stream) options.onPick?.(stream);
	});
	host.paint(build);
	return {
		update: (next) => {
			data = next;
			host.paint(build);
		},
		disposed: host.disposed,
		dispose: host.dispose,
	};
}

export interface WaterfallStep {
	readonly id: string;
	readonly label: string;
	readonly kind: "income" | "cost" | "total";
	readonly size: number;
	readonly signed: number;
}

export interface WaterfallData {
	readonly steps: readonly WaterfallStep[];
	readonly revenue: number;
}

export interface WaterfallOptions {
	readonly money: (value: number) => string;
	readonly axisMoney: (value: number) => string;
	readonly share: (ratio: number) => string;
}

interface Span {
	readonly lo: number;
	readonly hi: number;
}

function spans(steps: readonly WaterfallStep[]): Span[] {
	let run = 0;
	return steps.map((step) => {
		if (step.kind === "total") return { lo: Math.min(0, step.signed), hi: Math.max(0, step.signed) };
		if (step.kind === "income") {
			const span = { lo: run, hi: run + step.size };
			run = span.hi;
			return span;
		}
		const span = { lo: run - step.size, hi: run };
		run = span.lo;
		return span;
	});
}

function stepColor(theme: ChartTheme, step: WaterfallStep): string {
	if (step.kind === "income") return theme.good;
	if (step.kind === "cost") return rose(theme);
	return step.signed < 0 ? theme.bad : theme.good;
}

export function mountWaterfallChart(
	container: HTMLElement,
	signal: AbortSignal,
	initial: WaterfallData,
	options: WaterfallOptions,
): ChartMount<WaterfallData> {
	const host = createChartHost(container, signal);
	let data = initial;
	const signedText = (step: WaterfallStep) =>
		step.kind === "income"
			? `+${options.money(step.size)}`
			: options.money(step.kind === "cost" ? -step.size : step.signed);
	const build = (theme: ChartTheme): Option => {
		const ranges = spans(data.steps);
		const assist: (number | string)[] = [];
		const up: (object | string)[] = [];
		const down: (object | string)[] = [];
		for (const [index, step] of data.steps.entries()) {
			const { lo, hi } = ranges[index]!;
			const color = stepColor(theme, step);
			const fill = vertical(color, tint(color, step.kind === "total" ? 0.82 : 0.72));
			const outerUp = hi > 0 && (lo >= 0 || step.signed >= 0);
			const label = (show: boolean, position: "top" | "bottom") => ({
				show,
				position,
				distance: 6,
				formatter: signedText(step),
				color: step.kind === "total" ? color : theme.text,
				fontFamily: theme.font,
				fontSize: 12,
				fontWeight: step.kind === "total" ? 750 : 650,
			});
			const piece = (value: number, radius: number[], show: boolean, position: "top" | "bottom") => ({
				value,
				itemStyle: { color: fill, borderRadius: radius },
				label: label(show, position),
			});
			if (lo >= 0) {
				assist.push(lo || "-");
				up.push(piece(hi - lo, [6, 6, 0, 0], true, "top"));
				down.push("-");
			} else if (hi <= 0) {
				assist.push(hi || "-");
				up.push("-");
				down.push(piece(lo - hi, [0, 0, 6, 6], true, "bottom"));
			} else {
				assist.push("-");
				up.push(piece(hi, [6, 6, 0, 0], outerUp, "top"));
				down.push(piece(lo, [0, 0, 6, 6], !outerUp, "bottom"));
			}
		}
		const axisText = { color: theme.muted, fontFamily: theme.font, fontSize: 12, fontWeight: 600 };
		return {
			...motion(),
			grid: { left: 64, right: 20, top: 34, bottom: 40 },
			tooltip: {
				...tooltipBase(theme),
				trigger: "axis",
				axisPointer: { type: "shadow", shadowStyle: { color: tint(theme.text, theme.dark ? 0.06 : 0.04) } },
				formatter: (params: unknown) => {
					const first = Array.isArray(params) ? params[0] : params;
					const index = (first as { dataIndex?: number } | undefined)?.dataIndex ?? -1;
					const step = data.steps[index];
					if (!step) return "";
					const tone = stepColor(theme, step);
					const rows: Row[] = [["", signedText(step), tone]];
					if (step.kind === "cost" && data.revenue > 0) {
						rows.push(["", options.share(step.size / data.revenue), theme.muted]);
					}
					return tipHtml(theme, step.label, rows, tone);
				},
			},
			xAxis: {
				type: "category",
				data: data.steps.map((step) => step.label),
				axisTick: { show: false },
				axisLine: { show: false },
				axisLabel: { ...axisText, interval: 0, width: 104, overflow: "break", lineHeight: 15 },
			},
			yAxis: {
				type: "value",
				splitNumber: 4,
				axisLabel: { color: theme.soft, fontFamily: theme.font, fontSize: 11.5, formatter: options.axisMoney },
				splitLine: { lineStyle: { color: tint(theme.text, theme.dark ? 0.08 : 0.06), type: [3, 4] } },
			},
			series: [
				{
					name: "assist",
					type: "bar",
					stack: "bridge",
					silent: true,
					itemStyle: { color: "transparent", borderColor: "transparent" },
					emphasis: { disabled: true },
					tooltip: { show: false },
					data: assist,
				},
				{
					name: "up",
					type: "bar",
					stack: "bridge",
					barMaxWidth: 68,
					barCategoryGap: "34%",
					emphasis: { focus: "none", itemStyle: { shadowBlur: 14, shadowColor: tint(theme.text, 0.16) } },
					data: up,
					markLine: {
						silent: true,
						symbol: "none",
						label: { show: false },
						lineStyle: { color: tint(theme.text, 0.42), width: 1.25, type: "solid" },
						data: [{ yAxis: 0 }],
					},
				},
				{
					name: "down",
					type: "bar",
					stack: "bridge",
					barMaxWidth: 68,
					emphasis: { focus: "none", itemStyle: { shadowBlur: 14, shadowColor: tint(theme.text, 0.16) } },
					data: down,
				},
			],
		};
	};
	host.paint(build);
	return {
		update: (next) => {
			data = next;
			host.paint(build);
		},
		disposed: host.disposed,
		dispose: host.dispose,
	};
}

export interface BreakEvenData {
	readonly points: readonly { readonly x: number; readonly y: number | null }[];
	readonly breakEvenX: number | null;
	readonly capacityX: number | null;
	readonly currentX: number;
	readonly currentY: number | null;
	readonly zeroLine: boolean;
}

export interface BreakEvenOptions {
	readonly xText: (value: number) => string;
	readonly yText: (value: number) => string;
	readonly xTitle: string;
	readonly capacityLabel: string;
	readonly breakEvenLabel: (x: number) => string;
}

export function mountBreakEvenChart(
	container: HTMLElement,
	signal: AbortSignal,
	initial: BreakEvenData,
	options: BreakEvenOptions,
): ChartMount<BreakEvenData> {
	const host = createChartHost(container, signal);
	let data = initial;
	const build = (theme: ChartTheme): Option => {
		const xMin = data.points[0]?.x ?? 0;
		const xMax = data.points.at(-1)?.x ?? 1;
		const capacity = data.capacityX !== null && data.capacityX < xMax ? Math.max(data.capacityX, xMin) : null;
		const impossible = data.breakEvenX !== null && data.capacityX !== null && data.breakEvenX > data.capacityX;
		const lines: object[] = [];
		if (data.zeroLine) {
			lines.push({ yAxis: 0, lineStyle: { color: tint(theme.text, 0.45), width: 1.25, type: "solid" } });
		}
		if (capacity !== null) {
			lines.push({
				xAxis: capacity,
				lineStyle: { color: theme.bad, width: 1.5, type: [5, 4] },
				label: { show: false },
			});
		}
		const points: object[] = [];
		if (data.breakEvenX !== null) {
			const tone = impossible ? theme.bad : theme.text;
			points.push({
				name: options.breakEvenLabel(data.breakEvenX),
				coord: [data.breakEvenX, 0],
				symbol: "pin",
				symbolSize: [34, 42],
				itemStyle: { color: tone, borderColor: theme.bg, borderWidth: 1.5 },
				label: {
					show: true,
					position: "top",
					distance: 2,
					formatter: options.breakEvenLabel(data.breakEvenX),
					color: tone,
					fontFamily: theme.font,
					fontSize: 12,
					fontWeight: 720,
					backgroundColor: tint(theme.pane, 0.92),
					borderRadius: 6,
					padding: [3, 7],
				},
			});
		}
		if (data.currentY !== null) {
			const tone = data.currentY < 0 ? theme.bad : theme.accent;
			points.push({
				name: "now",
				coord: [Math.min(xMax, Math.max(xMin, data.currentX)), data.currentY],
				symbol: "circle",
				symbolSize: 12,
				itemStyle: {
					color: tone,
					borderColor: theme.bg,
					borderWidth: 2.5,
					shadowBlur: 10,
					shadowColor: tint(tone, 0.45),
				},
				label: { show: false },
			});
		}
		const areas: object[] =
			capacity !== null && data.capacityX !== null
				? [
						[
							{
								xAxis: capacity,
								itemStyle: { color: tint(theme.bad, theme.dark ? 0.14 : 0.08) },
								label: {
									show: true,
									position: "insideTop",
									distance: 8,
									formatter: `${options.capacityLabel} · ${options.xText(data.capacityX)}`,
									color: theme.bad,
									fontFamily: theme.font,
									fontSize: 12,
									fontWeight: 700,
								},
							},
							{ xAxis: xMax },
						],
					]
				: [];
		const axisText = { color: theme.soft, fontFamily: theme.font, fontSize: 11.5 };
		return {
			...motion(),
			grid: { left: 70, right: 26, top: 40, bottom: 52 },
			tooltip: {
				...tooltipBase(theme),
				trigger: "axis",
				axisPointer: {
					type: "cross",
					crossStyle: { color: tint(theme.text, 0.32) },
					lineStyle: { color: tint(theme.text, 0.32), type: [3, 3] },
					label: { backgroundColor: theme.text, color: theme.bg, fontFamily: theme.font, fontSize: 11 },
				},
				formatter: (params: unknown) => {
					const first = (Array.isArray(params) ? params[0] : params) as { value?: unknown } | undefined;
					const value = Array.isArray(first?.value) ? (first.value as unknown[]) : [];
					const x = typeof value[0] === "number" ? value[0] : null;
					const y = typeof value[1] === "number" ? value[1] : null;
					if (x === null || y === null) return "";
					const beyond = data.capacityX !== null && x > data.capacityX;
					const rows: Row[] = [["", options.yText(y), y < 0 ? theme.bad : theme.good]];
					if (beyond) rows.push(["", options.capacityLabel, theme.bad]);
					return tipHtml(theme, `${options.xTitle} ${options.xText(x)}`, rows, beyond ? theme.bad : theme.accent);
				},
			},
			xAxis: {
				type: "value",
				min: xMin,
				max: xMax,
				name: options.xTitle,
				nameLocation: "middle",
				nameGap: 32,
				nameTextStyle: { color: theme.muted, fontFamily: theme.font, fontSize: 12, fontWeight: 640 },
				axisLine: { lineStyle: { color: tint(theme.text, 0.14) } },
				axisTick: { show: false },
				splitLine: { show: false },
				axisLabel: { ...axisText, formatter: options.xText, hideOverlap: true },
			},
			yAxis: {
				type: "value",
				splitNumber: 4,
				axisLabel: { ...axisText, formatter: options.yText },
				splitLine: { lineStyle: { color: tint(theme.text, theme.dark ? 0.08 : 0.06), type: [3, 4] } },
			},
			series: [
				{
					type: "line",
					smooth: 0.25,
					showSymbol: false,
					symbol: "circle",
					symbolSize: 8,
					connectNulls: false,
					lineStyle: { width: 2.75, color: theme.accent, cap: "round", join: "round" },
					itemStyle: { color: theme.accent },
					areaStyle: { color: vertical(tint(theme.accent, 0.3), tint(theme.accent, 0.02)) },
					emphasis: { focus: "none" },
					data: data.points.map((point) => [point.x, point.y === null ? "-" : point.y]),
					markLine: { silent: true, symbol: "none", label: { show: false }, data: lines },
					markPoint: { silent: true, data: points },
					markArea: { silent: true, data: areas },
				},
			],
		};
	};
	host.paint(build);
	return {
		update: (next) => {
			data = next;
			host.paint(build);
		},
		disposed: host.disposed,
		dispose: host.dispose,
	};
}

export interface LandscapePoint {
	readonly key: string;
	readonly name: string;
	readonly x: number;
	readonly y: number;
	readonly isUs: boolean;
	readonly category?: string;
	readonly pricing?: string;
	readonly ourEdge?: string;
}

export interface LandscapeAxes {
	readonly xLabel: string;
	readonly yLabel: string;
	readonly xLow?: string;
	readonly xHigh?: string;
	readonly yLow?: string;
	readonly yHigh?: string;
}

export interface LandscapeData {
	readonly points: readonly LandscapePoint[];
	readonly axes: LandscapeAxes;
}

export interface LandscapeLabels {
	readonly category: string;
	readonly pricing: string;
	readonly ourEdge: string;
	readonly us: string;
}

export interface LandscapeOptions {
	readonly labels: LandscapeLabels;
	readonly active?: string | null;
	readonly onHover?: (key: string | null) => void;
	readonly onPick?: (key: string) => void;
}

export interface LandscapeMount extends ChartMount<LandscapeData> {
	readonly setActive: (key: string | null) => void;
}

interface PointDatum {
	readonly key?: string;
	readonly point?: LandscapePoint;
}

function datumKey(params: unknown): string | null {
	const data = (params as { data?: PointDatum } | null)?.data;
	return data?.key ?? null;
}

function quadrant(points: readonly LandscapePoint[]): [number, number, number, number] {
	const us = points.find((point) => point.isUs);
	const right = us ? us.x >= 50 : true;
	const top = us ? us.y >= 50 : true;
	return [right ? 50 : 0, top ? 50 : 0, right ? 100 : 50, top ? 100 : 50];
}

export function mountLandscapeChart(
	container: HTMLElement,
	signal: AbortSignal,
	initial: LandscapeData,
	options: LandscapeOptions,
): LandscapeMount {
	const host = createChartHost(container, signal, { width: 640, height: 390 });
	let data = initial;
	let active = options.active ?? null;
	const build = (theme: ChartTheme): Option => {
		const calm = still();
		const label = (point: LandscapePoint, on: boolean) => ({
			show: true,
			formatter: "{b}",
			position: point.x > 65 ? "left" : "right",
			distance: point.isUs ? 12 : 10,
			color: point.isUs ? theme.accent : on ? theme.text : theme.muted,
			fontFamily: theme.font,
			fontSize: point.isUs || on ? 13 : 12.5,
			fontWeight: point.isUs || on ? 720 : 600,
			textBorderColor: theme.bg,
			textBorderWidth: 3,
		});
		const rivals = data.points
			.filter((point) => !point.isUs)
			.map((point) => {
				const on = point.key === active;
				return {
					name: point.name,
					key: point.key,
					point,
					value: [point.x, point.y],
					symbolSize: on ? 21 : 16,
					itemStyle: {
						color: on ? theme.text : tint(theme.text, theme.dark ? 0.55 : 0.5),
						borderColor: on ? theme.accent : theme.bg,
						borderWidth: on ? 3 : 2,
						shadowBlur: on ? 16 : 8,
						shadowColor: tint(theme.text, theme.dark ? 0.45 : 0.18),
					},
					label: label(point, on),
				};
			});
		const ours = data.points
			.filter((point) => point.isUs)
			.map((point) => {
				const on = point.key === active;
				return {
					name: point.name,
					key: point.key,
					point,
					value: [point.x, point.y],
					symbolSize: on ? 22 : 18,
					itemStyle: {
						color: theme.accent,
						borderColor: on ? theme.text : theme.bg,
						borderWidth: on ? 3 : 2,
						shadowBlur: 18,
						shadowColor: tint(theme.accent, 0.55),
					},
					label: label(point, on),
				};
			});
		const [x0, y0, x1, y1] = quadrant(data.points);
		const ends =
			(low: string | undefined, high: string | undefined, lowArrow: string, highArrow: string) =>
			(value: number) => {
				if (value <= 0 && low) return `${lowArrow} ${low}`;
				if (value >= 100 && high) return `${high} ${highArrow}`;
				return "";
			};
		const axisName = { color: theme.muted, fontFamily: theme.font, fontSize: 12.5, fontWeight: 660 };
		const axisEnds = { color: theme.soft, fontFamily: theme.font, fontSize: 11.5, fontWeight: 560 };
		const axisLine = { lineStyle: { color: tint(theme.text, 0.14) } };
		const axes = data.axes;
		return {
			...motion(),
			grid: { left: 44, right: 28, top: 26, bottom: 54 },
			tooltip: {
				...tooltipBase(theme),
				trigger: "item",
				formatter: (params: unknown) => {
					const point = (params as { data?: PointDatum } | null)?.data?.point;
					if (!point) return "";
					const rows: Row[] = [];
					if (point.isUs) rows.push([options.labels.us, "", theme.accent]);
					if (point.category) rows.push([options.labels.category, point.category]);
					if (point.pricing) rows.push([options.labels.pricing, point.pricing]);
					if (point.ourEdge) rows.push([options.labels.ourEdge, point.ourEdge, theme.accent]);
					return tipHtml(theme, point.name, rows, point.isUs ? theme.accent : theme.text);
				},
			},
			xAxis: {
				type: "value",
				min: 0,
				max: 100,
				interval: 50,
				name: axes.xLabel,
				nameLocation: "middle",
				nameGap: 30,
				nameTextStyle: axisName,
				axisLine,
				axisTick: { show: false },
				splitLine: { show: false },
				axisLabel: {
					...axisEnds,
					formatter: ends(axes.xLow, axes.xHigh, "←", "→"),
					alignMinLabel: "left",
					alignMaxLabel: "right",
				},
			},
			yAxis: {
				type: "value",
				min: 0,
				max: 100,
				interval: 50,
				name: axes.yLabel,
				nameLocation: "middle",
				nameGap: 18,
				nameRotate: 90,
				nameTextStyle: axisName,
				axisLine,
				axisTick: { show: false },
				splitLine: { show: false },
				axisLabel: {
					...axisEnds,
					inside: true,
					margin: 10,
					formatter: (value: number) => {
						if (value <= 0 && axes.yLow) return `↓ ${axes.yLow}`;
						if (value >= 100 && axes.yHigh) return `↑ ${axes.yHigh}`;
						return "";
					},
					verticalAlignMinLabel: "bottom",
					verticalAlignMaxLabel: "top",
				},
			},
			series: [
				{
					type: "scatter",
					name: "rivals",
					symbol: "circle",
					cursor: "default",
					labelLayout: { moveOverlap: "shiftY", hideOverlap: false },
					emphasis: {
						scale: 1.25,
						focus: "none",
						itemStyle: { color: theme.text, borderColor: theme.accent, borderWidth: 3 },
						label: { color: theme.text, fontWeight: 720 },
					},
					data: rivals,
					markArea: {
						silent: true,
						itemStyle: {
							color: vertical(tint(theme.accent, theme.dark ? 0.12 : 0.08), tint(theme.accent, 0.02)),
						},
						label: { show: false },
						data: [
							[
								{ xAxis: x0, yAxis: y0 },
								{ xAxis: x1, yAxis: y1 },
							],
						],
					},
					markLine: {
						silent: true,
						symbol: "none",
						label: { show: false },
						lineStyle: { color: tint(theme.text, theme.dark ? 0.22 : 0.16), type: [4, 5], width: 1 },
						data: [{ xAxis: 50 }, { yAxis: 50 }],
					},
				},
				{
					type: "effectScatter",
					name: "us",
					cursor: "default",
					showEffectOn: calm ? "emphasis" : "render",
					rippleEffect: { scale: 3.4, brushType: "stroke", period: 3.6, color: tint(theme.accent, 0.7) },
					labelLayout: { moveOverlap: "shiftY", hideOverlap: false },
					emphasis: { scale: 1.2, focus: "none" },
					z: 4,
					data: ours,
				},
			],
		};
	};
	host.chart.on("mouseover", (params: unknown) => {
		const key = datumKey(params);
		if (key) options.onHover?.(key);
	});
	host.chart.on("mouseout", () => options.onHover?.(null));
	host.chart.on("click", (params: unknown) => {
		const key = datumKey(params);
		if (key) options.onPick?.(key);
	});
	host.paint(build);
	return {
		update: (next) => {
			data = next;
			host.paint(build);
		},
		setActive: (key) => {
			if (key === active) return;
			active = key;
			host.paint(build);
		},
		disposed: host.disposed,
		dispose: host.dispose,
	};
}
