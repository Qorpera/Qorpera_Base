import { composeStudioPreview } from "@qorpera/cloud-client/surface-studio-patches";
import type { StudioPatchChange, StudioPatchOp, SurfacePreviewConflict, SurfaceSummary } from "@qorpera/contracts";
import { h, icon } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { markdown } from "../../ui/markdown.ts";
import { t } from "../../ui/preferences.ts";
import { formatConflictPaths, isOpenChange, type SurfacesStore } from "../surfaces-store.ts";
import { surfaceEmblem } from "./surface-rail.ts";

export interface SurfaceReportOptions {
	readonly store: SurfacesStore;
	readonly surface: SurfaceSummary;
	readonly signal: AbortSignal;
	readonly baseFiles?: Readonly<Record<string, string>>;
	readonly patches?: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly loadFiles?: (surface: SurfaceSummary, signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
}

interface ReportMetric {
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

type ReportBlock =
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

interface ReportSection {
	readonly id: string;
	readonly kicker?: string;
	readonly heading: string;
	readonly paragraphs: readonly string[];
	readonly blocks?: readonly ReportBlock[];
}

interface ReportDocument {
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
	readonly changed: boolean;
	readonly base?: ReportDocument;
}

type ReportLens = "internal" | "public";

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

function parseReportJson(path: string, content: string): Omit<ReportDocument, "changed" | "base"> | undefined {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed)) return undefined;
		const headline = str(parsed.headline) || str(parsed.title);
		if (!headline) return undefined;
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
		};
	} catch {
		return undefined;
	}
}

function renderBarChart(block: Extract<ReportBlock, { kind: "bar_chart" }>): HTMLElement {
	const max = block.max ?? Math.max(1, ...block.items.map((item) => item.value));
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
				const pct = Math.max(4, Math.min(100, Math.round((item.value / max) * 100)));
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
	const allValues = block.series.flatMap((series) => series.values);
	const rawMax = Math.max(...allValues, 1);
	const rawMin = Math.min(...allValues, 0);
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

	const count = Math.max(2, ...block.series.map((s) => s.values.length));
	const xAt = (index: number) => left + (index / (count - 1)) * plotW;
	const yAt = (value: number) => top + plotH - ((value - padMin) / range) * plotH;

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

function renderCalloutBlock(block: Extract<ReportBlock, { kind: "callout" }>, lens: ReportLens): HTMLElement | null {
	if (lens === "public" && (block.tone === "decision" || block.tone === "tradeoff")) return null;
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

function renderBlock(block: ReportBlock, lens: ReportLens): HTMLElement | null {
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
			return renderCalloutBlock(block, lens);
	}
}

export class SurfaceReportView {
	readonly el = h("div", { class: "surface-report" });
	readonly #options: SurfaceReportOptions;
	readonly #lifetime = new AbortController();
	#baseFiles: Readonly<Record<string, string>>;
	#loading = false;
	#lastConflict: SurfacePreviewConflict | null = null;
	#activeSlug = "";
	#lens: ReportLens = "internal";
	#shown = "";

	constructor(options: SurfaceReportOptions) {
		this.#options = options;
		this.#baseFiles = options.baseFiles ? { ...options.baseFiles } : {};
		options.signal.addEventListener("abort", () => this.dispose(), { once: true });
		this.el.addEventListener("click", (event) => this.#click(event), { signal: this.#lifetime.signal });
		if (options.loadFiles && !options.baseFiles) void this.#load();
		this.update();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	async #load(): Promise<void> {
		const loadFiles = this.#options.loadFiles;
		if (!loadFiles) return;
		this.#loading = true;
		this.update();
		try {
			const loaded = await loadFiles(this.#options.surface, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#baseFiles = { ...loaded };
		} catch {
			/* WHY: An empty or unreadable reports folder falls back to the calm starter empty state. */
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#loading = false;
				this.update();
			}
		}
	}

	#orderedChanges(): StudioPatchChange[] {
		const store = this.#options.store;
		const state = store.state;
		if (state.mode === "live") return [];
		const workspace = store.workspace(this.#options.surface.id);
		const ordered: StudioPatchChange[] = [];
		for (const session of workspace?.activeSessions ?? []) {
			for (const change of session.changes) {
				if (change.kind !== "folder_patch" || !isOpenChange(change) || !store.isChangeShown(change.id)) continue;
				const ops = this.#options.patches?.[change.id] ?? state.studioPatches[change.id];
				if (ops?.length) ordered.push({ changeId: change.id, ops });
			}
		}
		return ordered;
	}

	#effectiveBaseFiles(surfaceId: string): Readonly<Record<string, string>> {
		const localBase = this.#options.store.state.localStudioBase[surfaceId];
		if (!localBase) return this.#baseFiles;
		return Object.keys(this.#baseFiles).length > 0 ? { ...this.#baseFiles, ...localBase } : localBase;
	}

	update(): void {
		const store = this.#options.store;
		const state = store.state;
		const surface = state.surfaces.find((item) => item.id === this.#options.surface.id) ?? this.#options.surface;
		const baseFiles = this.#effectiveBaseFiles(surface.id);
		const workspace = store.workspace(surface.id);
		const ordered = this.#orderedChanges();
		const busyReconcile = Boolean(state.busy[`reconcile:${surface.id}`]);
		const key = JSON.stringify([
			this.#loading,
			state.mode,
			this.#activeSlug,
			this.#lens,
			baseFiles,
			ordered,
			surface.title,
			workspace?.briefSummary,
			busyReconcile,
		]);
		if (key === this.#shown) return;
		this.#shown = key;

		const composition = composeStudioPreview(baseFiles, ordered);
		this.#lastConflict = composition.status === "conflicted" ? composition.conflictReport : null;
		const files = composition.files;
		const filePaths = Object.keys(files).sort();

		const reports: ReportDocument[] = [];
		const markdownDocs: { readonly path: string; readonly content: string; readonly changed: boolean }[] = [];
		for (const path of filePaths) {
			const content = files[path] ?? "";
			const baseContent = baseFiles[path];
			const changed = baseContent !== content;
			if (/\.report\.json$/i.test(path)) {
				const parsed = parseReportJson(path, content);
				if (parsed) {
					const parsedBase = baseContent ? parseReportJson(path, baseContent) : undefined;
					reports.push({
						...parsed,
						changed,
						...(parsedBase ? { base: { ...parsedBase, changed: false } } : {}),
					});
					continue;
				}
			}
			if (/\.(?:md|markdown)$/i.test(path)) markdownDocs.push({ path, content, changed });
		}

		if (reports.length && !reports.some((item) => item.slug === this.#activeSlug)) {
			this.#activeSlug = reports[0]!.slug;
		}
		const activeReport = reports.find((item) => item.slug === this.#activeSlug) ?? reports[0];

		const badgeText =
			composition.status === "conflicted"
				? t("Conflict")
				: composition.appliedChangeIds.length === 1
					? t("1 live change applied")
					: composition.appliedChangeIds.length > 1
						? t("{count} live changes applied", { count: composition.appliedChangeIds.length })
						: t("Base");
		const badgeClass =
			composition.status === "conflicted"
				? "studio-badge is-conflict"
				: composition.appliedChangeIds.length > 0
					? "studio-badge is-live"
					: "studio-badge";

		const chrome = h(
			"div",
			{ class: "report-chrome" },
			h(
				"div",
				{ class: "report-switcher", role: "tablist", "aria-label": t("Articles & reports") },
				reports.map((report) =>
					h(
						"button",
						{
							type: "button",
							role: "tab",
							class: `report-switch-pill${report.slug === activeReport?.slug ? " is-on" : ""}`,
							"aria-selected": String(report.slug === activeReport?.slug),
							"data-act": "report-select",
							"data-slug": report.slug,
						},
						report.changed ? h("span", { class: "report-changed-dot", "aria-hidden": "true" }) : null,
						report.headline,
					),
				),
			),
			h(
				"div",
				{ class: "report-chrome-tools" },
				this.#lens === "internal" ? h("span", { class: badgeClass }, badgeText) : null,
				h(
					"div",
					{ class: "surface-seg report-lens-seg", role: "group", "aria-label": t("Reading perspective") },
					h(
						"button",
						{
							type: "button",
							class: this.#lens === "internal" ? "is-on" : "",
							"aria-pressed": String(this.#lens === "internal"),
							"data-act": "report-lens",
							"data-lens": "internal",
						},
						t("Internal brief"),
					),
					h(
						"button",
						{
							type: "button",
							class: this.#lens === "public" ? "is-on" : "",
							"aria-pressed": String(this.#lens === "public"),
							"data-act": "report-lens",
							"data-lens": "public",
						},
						t("Public post"),
					),
				),
			),
		);

		const children: HTMLElement[] = [chrome];

		if (composition.status === "conflicted") {
			const paths = formatConflictPaths(composition.conflictReport.paths);
			children.push(
				h(
					"div",
					{ class: "studio-conflict report-conflict", role: "alert" },
					h("span", { class: "surface-state is-conflicted", "aria-hidden": "true" }),
					h(
						"span",
						{ title: composition.conflictReport.paths.join(", ") },
						t("Studio changes conflict in {paths}", { paths }),
					),
					h(
						"button",
						{
							type: "button",
							class: "btn btn-primary btn-small",
							"data-act": "report-reconcile",
							disabled: busyReconcile || composition.conflictReport.changeIds.length === 0,
						},
						t("Reconcile"),
					),
				),
			);
		}

		if (state.mode === "compare") {
			children.push(this.#renderCompare(reports));
			this.el.classList.toggle("is-public-lens", this.#lens === "public");
			this.el.replaceChildren(...children);
			return;
		}

		if (!activeReport && markdownDocs.length === 0) {
			children.push(
				h(
					"div",
					{ class: "studio-empty" },
					this.#loading
						? [h("span", { class: "surface-state is-running" }), h("p", null, t("Opening studio…"))]
						: [
								interfaceEmblem(surfaceEmblem(surface), 42),
								h("h2", null, surface.title),
								workspace?.briefSummary ? h("p", { class: "studio-brief" }, workspace.briefSummary) : null,
								h(
									"p",
									null,
									t("No reports yet. Describe an analysis, vendor comparison, or design essay below."),
								),
							],
				),
			);
			this.el.classList.toggle("is-public-lens", this.#lens === "public");
			this.el.replaceChildren(...children);
			return;
		}

		if (activeReport) {
			const subtitleChanged = Boolean(activeReport.base && activeReport.base.subtitle !== activeReport.subtitle);
			const metricsChanged = Boolean(
				activeReport.base &&
					JSON.stringify(activeReport.base.keyMetrics) !== JSON.stringify(activeReport.keyMetrics),
			);
			const metaParts = [activeReport.author, activeReport.date, activeReport.readingTime].filter(Boolean);
			const article = h(
				"article",
				{ class: "report-article", "data-report-slug": activeReport.slug },
				this.#lens === "public"
					? h(
							"div",
							{ class: "report-public-banner" },
							icon("globe"),
							h(
								"span",
								null,
								activeReport.publicUrl
									? `${activeReport.publicUrl} · ${t("External reader preview")}`
									: t("External reader preview"),
							),
						)
					: null,
				h(
					"header",
					{ class: "report-hero" },
					activeReport.category ? h("span", { class: "report-category" }, activeReport.category) : null,
					h("h1", { class: "report-headline" }, activeReport.headline),
					activeReport.subtitle
						? h(
								"p",
								{ class: `report-dek${subtitleChanged && this.#lens === "internal" ? " is-changed" : ""}` },
								activeReport.subtitle,
								subtitleChanged && this.#lens === "internal"
									? h("span", { class: "studio-changed-pill" }, t("Updated"))
									: null,
							)
						: null,
					metaParts.length ? h("div", { class: "report-byline" }, metaParts.join(" · ")) : null,
				),
				activeReport.keyMetrics.length
					? h(
							"div",
							{ class: `report-metrics${metricsChanged && this.#lens === "internal" ? " is-changed" : ""}` },
							activeReport.keyMetrics.map((metric, idx) => {
								const prevMetric = activeReport.base?.keyMetrics[idx];
								const changedMetric = Boolean(
									this.#lens === "internal" &&
										prevMetric &&
										(prevMetric.value !== metric.value || prevMetric.delta !== metric.delta),
								);
								return h(
									"div",
									{ class: `report-metric${changedMetric ? " is-changed" : ""}` },
									h("small", null, metric.label),
									h("strong", null, metric.value),
									metric.delta ? h("span", null, metric.delta) : null,
								);
							}),
						)
					: null,
				...activeReport.sections.map((section, idx) => {
					const baseSection = activeReport.base?.sections[idx];
					const sectionChanged = Boolean(
						this.#lens === "internal" && baseSection && JSON.stringify(baseSection) !== JSON.stringify(section),
					);
					return h(
						"section",
						{
							class: `report-section${sectionChanged ? " is-changed" : ""}`,
							"data-section-id": section.id,
						},
						section.kicker ? h("span", { class: "report-kicker" }, section.kicker) : null,
						h(
							"div",
							{ class: "report-section-head" },
							h("h2", null, section.heading),
							sectionChanged ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
						),
						...section.paragraphs.map((paragraph) => h("div", { class: "report-prose" }, markdown(paragraph))),
						...(section.blocks ?? []).map((block) => renderBlock(block, this.#lens)),
					);
				}),
			);

			const toc =
				activeReport.sections.length >= 2
					? h(
							"aside",
							{ class: "report-toc", "aria-label": t("In this report") },
							h("span", { class: "report-toc-title" }, t("In this report")),
							h(
								"nav",
								null,
								activeReport.sections.map((section) =>
									h(
										"button",
										{
											type: "button",
											class: "report-toc-link",
											"data-act": "report-jump",
											"data-target": section.id,
										},
										section.heading,
									),
								),
							),
						)
					: null;

			children.push(h("div", { class: "report-layout" }, article, toc));
		} else {
			children.push(
				h(
					"div",
					{ class: "report-layout" },
					h(
						"article",
						{ class: "report-article" },
						markdownDocs.map((doc) =>
							h(
								"section",
								{ class: "report-section" },
								h("div", { class: "report-prose" }, markdown(doc.content)),
							),
						),
					),
				),
			);
		}

		this.el.classList.toggle("is-public-lens", this.#lens === "public");
		this.el.replaceChildren(...children);
	}

	#renderCompare(reports: readonly ReportDocument[]): HTMLElement {
		const changed = reports.filter((report) => report.changed && report.base);
		if (!changed.length) {
			return h(
				"div",
				{ class: "report-compare-wrap" },
				h("div", { class: "studio-compare-empty" }, h("p", null, t("No open changes to compare against Base."))),
			);
		}
		return h(
			"div",
			{ class: "report-compare-wrap" },
			changed.map((report) => {
				const base = report.base!;
				const rows: HTMLElement[] = [];
				if (base.subtitle !== report.subtitle) {
					rows.push(
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, t("Subtitle")),
							h("span", null, base.subtitle),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, t("Subtitle")),
							h("strong", null, report.subtitle),
						),
					);
				}
				report.keyMetrics.forEach((metric, index) => {
					const prev = base.keyMetrics[index];
					if (prev && prev.value === metric.value && prev.delta === metric.delta) return;
					rows.push(
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, metric.label),
							h("span", null, prev ? `${prev.value}${prev.delta ? ` · ${prev.delta}` : ""}` : t("Not set")),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, metric.label),
							h("strong", null, `${metric.value}${metric.delta ? ` · ${metric.delta}` : ""}`),
						),
					);
				});
				report.sections.forEach((sec, index) => {
					const prev = base.sections[index];
					if (prev && JSON.stringify(prev) === JSON.stringify(sec)) return;
					rows.push(
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, sec.heading),
							h("span", null, prev ? prev.paragraphs.join(" ") : t("Not in Base")),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, sec.heading),
							h("strong", null, sec.paragraphs.join(" ")),
						),
					);
				});
				return h(
					"section",
					{ class: "studio-section studio-compare-card", "data-compare-file": report.path },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, report.headline),
						h("code", { class: "studio-file-tag" }, report.path),
					),
					h(
						"div",
						{ class: "studio-compare-grid" },
						h("div", { class: "studio-compare-col-head" }, t("Base")),
						h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
						...rows,
					),
				);
			}),
		);
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		const { act } = target.dataset;
		if (act === "report-select" && target.dataset.slug) {
			if (target.dataset.slug !== this.#activeSlug) {
				this.#activeSlug = target.dataset.slug;
				this.update();
			}
			return;
		}
		if (act === "report-lens") {
			const next: ReportLens = target.dataset.lens === "public" ? "public" : "internal";
			if (next !== this.#lens) {
				this.#lens = next;
				this.update();
			}
			return;
		}
		if (act === "report-jump" && target.dataset.target) {
			const node = this.el.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(target.dataset.target)}"]`);
			node?.scrollIntoView({ behavior: "smooth", block: "start" });
			return;
		}
		if (act === "report-reconcile") {
			const ids = this.#lastConflict?.changeIds ?? [];
			if (ids.length) void this.#options.store.reconcileChanges(this.#options.surface.id, ids);
		}
	}
}
