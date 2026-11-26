import { parseSurfaceChartDocument, type SurfaceChartBlock, type SurfaceChartDocument } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import type * as ChartEngine from "./chart-engine.ts";
import { homeEmpty, type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import { expandButton, type StudioFullscreen } from "./fullscreen.ts";

let engineLoading: Promise<typeof ChartEngine> | undefined;

function loadChartEngine(): Promise<typeof ChartEngine> {
	engineLoading ??= import("./chart-engine.ts").catch((error: unknown) => {
		engineLoading = undefined;
		throw error;
	});
	return engineLoading;
}

function mountChartInto(
	host: HTMLElement,
	doc: SurfaceChartDocument,
	signal: AbortSignal,
	fallback: { readonly width: number; readonly height: number },
): void {
	loadChartEngine().then(
		(lib) => {
			if (signal.aborted) return;
			host.classList.remove("is-loading");
			lib.mountSurfaceChart(host, signal, doc, fallback);
			host.dataset.chart = doc.kind;
		},
		() => {
			if (signal.aborted) return;
			host.classList.remove("is-loading");
			host.replaceChildren(h("p", { class: "studio-chart-note" }, t("The chart couldn't load.")));
		},
	);
}

function filledChart(
	heading: string,
	changed: boolean,
	doc: SurfaceChartDocument,
	block: SurfaceChartBlock,
	ctx: SurfaceBlockContext,
	fullscreen: StudioFullscreen,
): HTMLElement {
	const chartSignal = ctx.renderSignal ?? ctx.signal;
	const height = typeof block.height === "number" ? block.height : 340;
	const host = h("div", {
		class: "studio-chart-host is-loading",
		role: "img",
		"aria-label": heading,
	});
	host.style.height = `${height}px`;
	mountChartInto(host, doc, chartSignal, { width: 720, height });

	const caption = block.caption ? ctx.words(block.caption) : doc.note;
	const openLarge = () => {
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
				mountChartInto(wideHost, doc, dialogLife.signal, { width: 960, height: 540 });
				return h(
					"div",
					{ class: "studio-chart-wide" },
					doc.subtitle ? h("p", { class: "studio-chart-subtitle" }, doc.subtitle) : null,
					wideHost,
					caption ? h("p", { class: "studio-chart-caption" }, caption) : null,
				);
			},
			"wide",
		);
	};

	return h(
		"section",
		{ class: "studio-section studio-chart", "data-block": "chart", "data-chart-kind": doc.kind },
		sectionHead(heading, changed, expandButton(heading, openLarge)),
		doc.subtitle ? h("p", { class: "studio-chart-subtitle" }, doc.subtitle) : null,
		h("figure", { class: "studio-chart-frame" }, host),
		caption ? h("p", { class: "studio-chart-caption" }, caption) : null,
	);
}

export function prepareChart(
	block: SurfaceChartBlock,
	ctx: SurfaceBlockContext,
	fullscreen: StudioFullscreen,
): SurfaceBlockPrepared {
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
	return {
		filled: true,
		pieces: [{ heavy: true, build: () => filledChart(heading, read.changed, doc, block, ctx, fullscreen) }],
	};
}
