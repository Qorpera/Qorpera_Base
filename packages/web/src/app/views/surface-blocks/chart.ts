import {
	isSurfaceAskSource,
	liftSurfaceColorForDark,
	parseSurfaceChartDocument,
	resolveSurfaceChartColor,
	SURFACE_CHART_COLOR_JOBS,
	type SurfaceAskSource,
	type SurfaceChartBlock,
	type SurfaceChartDocument,
	type SurfaceResolvedColors,
} from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import type * as ChartEngine from "./chart-engine.ts";
import {
	homeEmpty,
	homeLocked,
	homeUnknown,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sectionHead,
} from "./context.ts";
import { expandButton, type StudioFullscreen } from "./fullscreen.ts";
import {
	answerAge,
	answerChart,
	previousSource,
	type SurfaceAskChart,
	type SurfaceAskState,
	withPrevious,
} from "./live.ts";

let engineLoading: Promise<typeof ChartEngine> | undefined;

function loadChartEngine(): Promise<typeof ChartEngine> {
	engineLoading ??= import("./chart-engine.ts").catch((error: unknown) => {
		engineLoading = undefined;
		throw error;
	});
	return engineLoading;
}

interface ChartPaint {
	readonly doc: SurfaceChartDocument;
	readonly paints: ChartEngine.SurfaceChartPaints | undefined;
}

interface DrawnChart {
	readonly show: (chart: ChartPaint) => void;
}

type FollowChart = (show: (chart: ChartPaint) => void, signal: AbortSignal) => void;

function mountChartInto(
	host: HTMLElement,
	chart: ChartPaint,
	signal: AbortSignal,
	fallback: { readonly width: number; readonly height: number },
): DrawnChart {
	let latest = chart;
	let mounted: ChartEngine.SurfaceChartMount | undefined;
	loadChartEngine().then(
		(lib) => {
			if (signal.aborted) return;
			host.classList.remove("is-loading");
			mounted = lib.mountSurfaceChart(host, signal, latest.doc, fallback, latest.paints);
			host.dataset.chart = latest.doc.kind;
		},
		() => {
			if (signal.aborted) return;
			host.classList.remove("is-loading");
			host.replaceChildren(h("p", { class: "studio-chart-note" }, t("The chart couldn't load.")));
		},
	);
	return {
		show: (next) => {
			latest = next;
			if (!mounted || signal.aborted) return;
			mounted.repaint(next.doc, next.paints);
			host.dataset.chart = next.doc.kind;
		},
	};
}

function isJob(value: string): boolean {
	return (SURFACE_CHART_COLOR_JOBS as readonly string[]).includes(value);
}

function paintOf(
	colors: SurfaceResolvedColors,
	own: boolean,
	named: Readonly<Record<string, string>>,
): ChartEngine.SurfaceChartPaint {
	return {
		...(own ? { palette: colors.series, main: colors.main } : {}),
		...(Object.keys(named).length > 0 ? { named } : {}),
	};
}

export function chartPaints(
	block: SurfaceChartBlock,
	ctx: SurfaceBlockContext,
	doc: SurfaceChartDocument,
	keys?: readonly string[],
	compared?: string,
): ChartEngine.SurfaceChartPaints | undefined {
	const colors = ctx.colors;
	if (!colors) return undefined;
	const light: Record<string, string> = {};
	const dark: Record<string, string> = {};
	const name = (shown: string, key: string | undefined) => {
		const value = (key !== undefined ? block.colors?.[key] : undefined) ?? block.colors?.[shown];
		if (value === undefined) return;
		const lit = resolveSurfaceChartColor(value, colors.light, ctx.readJson);
		if (lit === undefined) return;
		light[shown] = lit;
		dark[shown] = isJob(value)
			? (resolveSurfaceChartColor(value, colors.dark, ctx.readJson) ?? liftSurfaceColorForDark(lit))
			: liftSurfaceColorForDark(lit);
	};
	if (block.colors) {
		(doc.series ?? []).forEach((series, index) => {
			name(series.name, keys?.[index]);
		});
		if (doc.kind === "pie" || doc.kind === "funnel") {
			const points = doc.series?.[0]?.data ?? [];
			points.forEach((point, index) => {
				const shown = (point && typeof point === "object" && point.name) || doc.categories?.[index];
				if (shown) name(shown, undefined);
			});
		}
		for (const node of doc.nodes ?? []) name(node.name, undefined);
	}
	if (compared !== undefined) {
		light[compared] = colors.light.compare;
		dark[compared] = colors.dark.compare;
	}
	if (!colors.own && Object.keys(light).length === 0) return undefined;
	return { light: paintOf(colors.light, colors.own, light), dark: paintOf(colors.dark, colors.own, dark) };
}

function openWide(
	fullscreen: StudioFullscreen,
	heading: string,
	chart: ChartPaint,
	chartSignal: AbortSignal,
	caption: string | undefined,
	follow?: FollowChart,
): void {
	fullscreen.openContent(
		heading,
		(onClose) => {
			const dialogLife = new AbortController();
			const stop = () => dialogLife.abort();
			onClose(stop);
			if (chartSignal.aborted) stop();
			else chartSignal.addEventListener("abort", stop, { once: true, signal: dialogLife.signal });
			const wideHost = h("div", {
				class: "studio-chart-host is-loading is-fullscreen",
				role: "img",
				"aria-label": heading,
			});
			const wide = mountChartInto(wideHost, chart, dialogLife.signal, { width: 960, height: 540 });
			follow?.(wide.show, dialogLife.signal);
			return h(
				"div",
				{ class: "studio-chart-wide" },
				chart.doc.subtitle ? h("p", { class: "studio-chart-subtitle" }, chart.doc.subtitle) : null,
				wideHost,
				caption ? h("p", { class: "studio-chart-caption" }, caption) : null,
			);
		},
		"wide",
	);
}

function chartHost(heading: string, height: number): HTMLElement {
	const host = h("div", {
		class: "studio-chart-host is-loading",
		role: "img",
		"aria-label": heading,
	});
	host.style.height = `${height}px`;
	return host;
}

function filledChart(
	heading: string,
	changed: boolean,
	chart: ChartPaint,
	block: SurfaceChartBlock,
	ctx: SurfaceBlockContext,
	fullscreen: StudioFullscreen,
): HTMLElement {
	const chartSignal = ctx.renderSignal ?? ctx.signal;
	const height = typeof block.height === "number" ? block.height : 340;
	const host = chartHost(heading, height);
	mountChartInto(host, chart, chartSignal, { width: 720, height });
	const caption = block.caption ? ctx.words(block.caption) : chart.doc.note;
	const openLarge = () => openWide(fullscreen, heading, chart, chartSignal, caption);
	return h(
		"section",
		{ class: "studio-section studio-chart", "data-block": "chart", "data-chart-kind": chart.doc.kind },
		sectionHead(heading, changed, expandButton(heading, openLarge)),
		chart.doc.subtitle ? h("p", { class: "studio-chart-subtitle" }, chart.doc.subtitle) : null,
		h("figure", { class: "studio-chart-frame" }, host),
		caption ? h("p", { class: "studio-chart-caption" }, caption) : null,
	);
}

function liveChart(
	heading: string,
	source: SurfaceAskSource,
	block: SurfaceChartBlock,
	ctx: SurfaceBlockContext,
	fullscreen: StudioFullscreen,
): HTMLElement {
	const handle = ctx.ask?.(source);
	const chartSignal = ctx.renderSignal ?? ctx.signal;
	const height = typeof block.height === "number" ? block.height : 340;
	const caption = block.caption ? ctx.words(block.caption) : undefined;
	const head = sectionHead(heading, false);
	const body = h("div", { class: "studio-chart-body" });
	const section = h(
		"section",
		{ class: "studio-section studio-chart", "data-block": "chart", "data-live": "loading" },
		head,
		body,
		caption ? h("p", { class: "studio-chart-caption" }, caption) : null,
	);
	let life: AbortController | undefined;
	let drawn: DrawnChart | undefined;
	let expand: HTMLElement | undefined;
	let current: SurfaceAskChart | null = null;
	let earlier: SurfaceAskChart | null = null;
	let following: string | undefined;
	let shown: ChartPaint | undefined;
	const wide = new Set<(chart: ChartPaint) => void>();
	const follow: FollowChart = (show, signal) => {
		wide.add(show);
		signal.addEventListener("abort", () => wide.delete(show), { once: true });
	};
	const clear = () => {
		life?.abort();
		life = undefined;
		drawn = undefined;
		expand?.remove();
		expand = undefined;
	};
	const mount = () => {
		if (!current) return;
		const compared = earlier && current.days ? t("Previous {count} days", { count: current.days.count }) : undefined;
		const doc = compared ? withPrevious(current, earlier, compared) : current.doc;
		const chart: ChartPaint = {
			doc,
			paints: chartPaints(block, ctx, doc, current.keys, doc === current.doc ? undefined : compared),
		};
		section.dataset.chartKind = doc.kind;
		shown = chart;
		for (const show of wide) show(chart);
		if (drawn && life) {
			drawn.show(chart);
			return;
		}
		const lives = new AbortController();
		life = lives;
		chartSignal.addEventListener("abort", () => lives.abort(), { once: true, signal: lives.signal });
		const host = chartHost(heading, height);
		body.replaceChildren(h("figure", { class: "studio-chart-frame" }, host));
		drawn = mountChartInto(host, chart, lives.signal, { width: 720, height });
		expand = expandButton(heading, () => {
			if (shown) openWide(fullscreen, heading, shown, chartSignal, caption, follow);
		});
		head.append(expand);
	};
	const compare = (shaped: SurfaceAskChart) => {
		const previous = previousSource(source, shaped.days);
		if (!previous || !handle || !ctx.askAfter) return;
		const other = ctx.askAfter(previous, handle.key);
		if (other.key === following) return;
		following = other.key;
		earlier = null;
		other.follow((state) => {
			if (following !== other.key) return;
			const next = state.state === "answered" ? answerChart(state.answer, previous) : null;
			if (next === earlier) return;
			earlier = next;
			if (next) mount();
		}, chartSignal);
	};
	const draw = (state: SurfaceAskState) => {
		section.dataset.live = state.state;
		if (state.state === "loading") {
			if (!life) body.replaceChildren(h("figure", { class: "studio-chart-frame" }, chartHost(heading, height)));
			return;
		}
		section.removeAttribute("title");
		const shaped = state.state === "answered" ? answerChart(state.answer, source) : null;
		current = shaped;
		if (!shaped) clear();
		if (state.state === "refused") {
			body.replaceChildren(homeLocked());
			return;
		}
		if (state.state === "unavailable") {
			body.replaceChildren(homeUnknown());
			return;
		}
		if (!shaped) {
			body.replaceChildren(homeEmpty(t("No chart data yet")));
			return;
		}
		const age = answerAge(state.answer);
		if (age) section.title = age;
		mount();
		compare(shaped);
	};
	if (handle) handle.follow(draw, chartSignal);
	else draw({ state: "unavailable" });
	return section;
}

export function prepareChart(
	block: SurfaceChartBlock,
	ctx: SurfaceBlockContext,
	fullscreen: StudioFullscreen,
): SurfaceBlockPrepared {
	if (isSurfaceAskSource(block.from)) {
		const source = block.from;
		const heading = block.heading ? ctx.words(block.heading) : t("Chart");
		ctx.ask?.(source);
		return {
			filled: true,
			pieces: [{ heavy: true, build: () => liveChart(heading, source, block, ctx, fullscreen) }],
		};
	}
	const read = ctx.read(block.from);
	const doc = read.found ? parseSurfaceChartDocument(read.value) : null;
	const heading = block.heading ? ctx.words(block.heading) : (doc?.title ?? t("Chart"));
	if (!doc) {
		return {
			filled: false,
			pieces: [
				{
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-chart", "data-block": "chart" },
							sectionHead(heading, false),
							homeEmpty(t("No chart data yet")),
						),
				},
			],
		};
	}
	const chart: ChartPaint = { doc, paints: chartPaints(block, ctx, doc) };
	return {
		filled: true,
		pieces: [{ heavy: true, build: () => filledChart(heading, read.changed, chart, block, ctx, fullscreen) }],
	};
}
