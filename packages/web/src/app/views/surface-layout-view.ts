import {
	readSurfaceLayout,
	resolveSurfaceColors,
	STUDIO_TOUR_PATH,
	type StudioBinaryRef,
	type StudioPatchOp,
	SURFACE_LAYOUT_PATH,
	type SurfaceArtifactsBlock,
	type SurfaceAskSource,
	type SurfaceJsonReader,
	type SurfaceLayoutRead,
	type SurfaceReadBlock,
	type SurfaceReadNode,
	type SurfaceStarterKind,
	type SurfaceSummary,
	type SurfaceTab,
	starterSurfaceLayout,
	surfaceColorsForDark,
} from "@qorpera/contracts";
import { h } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { SurfacesStore } from "../surfaces-store.ts";
import { prepareArtifacts, type StudioHtmlPages } from "./surface-blocks/artifacts.ts";
import { SurfacePictures } from "./surface-blocks/brand-mark.ts";
import { prepareCards } from "./surface-blocks/cards.ts";
import { prepareChart } from "./surface-blocks/chart.ts";
import { type ColorToken, prepareSwatchRow, readSwatches } from "./surface-blocks/colours.ts";
import {
	cleanFolderRoot,
	createBlockContext,
	folderRelative,
	isPlainRecord,
	type StudioSectionTask,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	type SurfaceFileLayer,
	type SurfacePageColors,
	sourceFile,
	surfaceGlobFinds,
} from "./surface-blocks/context.ts";
import { type EconomicsPick, prepareEconomics } from "./surface-blocks/economics.ts";
import { explainerClaimedPaths, SurfaceExplainers } from "./surface-blocks/explainer.ts";
import { prepareFacts } from "./surface-blocks/facts.ts";
import { StudioFullscreen } from "./surface-blocks/fullscreen.ts";
import { prepareHypotheses } from "./surface-blocks/hypotheses.ts";
import { prepareLandscape } from "./surface-blocks/landscape.ts";
import { SurfaceLibraries } from "./surface-blocks/library.ts";
import { SurfaceAsks, type SurfaceLiveHosts } from "./surface-blocks/live.ts";
import { moduleFolder, prepareModule } from "./surface-blocks/module.ts";
import { preparePalette } from "./surface-blocks/palette.ts";
import { SurfacePdfViewer } from "./surface-blocks/pdf.ts";
import { preparePlays } from "./surface-blocks/plays.ts";
import { reportFiles, SurfaceReports } from "./surface-blocks/report.ts";
import { prepareSpecList, prepareTable } from "./surface-blocks/specs.ts";
import { type LegacyStudioModel, SurfaceStages } from "./surface-blocks/stage.ts";
import { SurfaceTalks } from "./surface-blocks/talks.ts";
import { prepareTitle } from "./surface-blocks/title.ts";
import { prepareTypeSpecimen } from "./surface-blocks/type-specimen.ts";
import { prepareUnknown } from "./surface-blocks/unknown.ts";
import type { StudioBinaryReader } from "./surface-studio-stage.ts";

export interface SurfaceLayoutOptions {
	readonly store: SurfacesStore;
	readonly surface: SurfaceSummary;
	readonly signal: AbortSignal;
	readonly baseFiles: () => Readonly<Record<string, string>>;
	readonly patches?: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly readBinary?: StudioBinaryReader;
	readonly timeSlice?: boolean;
	readonly askSurface?: (prompt: string, title?: string) => Promise<void>;
	readonly live?: SurfaceLiveHosts;
	readonly reveal?: (path: string) => void;
}

export interface SurfaceLayoutInput {
	readonly surface: SurfaceSummary;
	readonly files: Readonly<Record<string, string>>;
	readonly baseFiles: Readonly<Record<string, string>>;
	readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
	readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
	readonly company: SurfaceFileLayer | undefined;
	readonly briefSummary: string;
	readonly starter: SurfaceStarterKind;
	readonly tab: string;
	readonly legacyModel: LegacyStudioModel | undefined;
	readonly htmlPages: StudioHtmlPages;
}

export interface SurfaceLayoutPlan {
	readonly tab: string;
	readonly tabBar: HTMLElement | null;
	readonly tasks: readonly StudioSectionTask[];
}

interface PreparedRow {
	readonly cells: readonly SurfaceBlockPrepared[];
}

type PreparedNode = SurfaceBlockPrepared | PreparedRow;

interface SwatchLink {
	readonly stage?: string;
	readonly values: readonly string[];
}

interface TabScope {
	readonly ctx: SurfaceBlockContext;
	readonly input: SurfaceLayoutInput;
	readonly claimed: ReadonlySet<string>;
	readonly swatches: ReadonlyMap<string, readonly ColorToken[]>;
	readonly tinting: ReadonlyMap<string, string>;
	readonly stageIds: ReadonlyMap<string, string>;
}

function surfaceLayoutPath(folderRoot: string | null | undefined): string {
	const root = cleanFolderRoot(folderRoot);
	return root ? `${root}/${SURFACE_LAYOUT_PATH}` : SURFACE_LAYOUT_PATH;
}

const SOURCE_FIELDS = new Set(["from", "model", "tint", "name", "line"]);

function bindingsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function moduleFolders(layout: SurfaceLayoutRead, ctx: SurfaceBlockContext): string[] {
	return layout.tabs
		.flatMap((tab) => tab.blocks.flatMap((node) => (node.type === "row" ? node.blocks : [node])))
		.flatMap((block) => {
			const folder = block.type === "module" ? moduleFolder(block, ctx) : undefined;
			return folder ? [folder] : [];
		});
}

function claimedFiles(
	layout: SurfaceLayoutRead,
	ctx: SurfaceBlockContext,
	layoutPath: string,
	apart: readonly string[],
	libraries: SurfaceLibraries,
	talks: SurfaceTalks,
): Set<string> {
	const claimed = new Set([layoutPath]);
	const tourPath = ctx.companyPath(STUDIO_TOUR_PATH);
	if (tourPath) claimed.add(tourPath);
	const tourVoicePrefix = ctx.companyPath("voice") ? `${ctx.companyPath("voice")}/` : "voice/";
	for (const path of Object.keys(ctx.files)) if (path.startsWith(tourVoicePrefix)) claimed.add(path);
	for (const path of Object.keys(ctx.binaries)) if (path.startsWith(tourVoicePrefix)) claimed.add(path);
	const leaves = layout.tabs.flatMap((tab) =>
		tab.blocks.flatMap((node) => (node.type === "row" ? node.blocks : [node])),
	);
	for (const block of leaves) {
		if (block.type === "unknown" || block.type === "artifacts") continue;
		if (block.type === "report") {
			const { include } = reportFiles(block, ctx, apart);
			for (const path of Object.keys(ctx.files)) if (include(path)) claimed.add(path);
			for (const path of Object.keys(ctx.binaries)) if (include(path)) claimed.add(path);
			continue;
		}
		if (block.type === "explainer") {
			for (const path of explainerClaimedPaths(block, ctx)) claimed.add(path);
			continue;
		}
		if (block.type === "library") {
			for (const path of libraries.claimed(block, ctx, apart)) claimed.add(path);
		}
		if (block.type === "talks") {
			for (const path of talks.claimed(block, ctx)) claimed.add(path);
			continue;
		}
		if (block.type === "module") {
			const folder = moduleFolder(block, ctx);
			if (folder) {
				for (const path of Object.keys(ctx.files)) if (path.startsWith(`${folder}/`)) claimed.add(path);
				for (const path of Object.keys(ctx.binaries)) if (path.startsWith(`${folder}/`)) claimed.add(path);
			}
			continue;
		}
		const bindings = Object.entries(block).flatMap(([field, value]) =>
			field === "items" && Array.isArray(value)
				? value.flatMap((item: unknown) => (isPlainRecord(item) ? bindingsOf(item.from) : []))
				: SOURCE_FIELDS.has(field)
					? bindingsOf(value)
					: [],
		);
		for (const binding of bindings) {
			const file = sourceFile(binding);
			const path = file ? ctx.companyPath(file) : undefined;
			if (path) claimed.add(path);
		}
	}
	return claimed;
}

type PathTest = (path: string) => boolean;

function artifactsHold(block: SurfaceArtifactsBlock, ctx: SurfaceBlockContext): PathTest {
	return (path) => {
		const relative = folderRelative(ctx.folderRoot, path);
		const file = relative === undefined ? { path } : { path, relative };
		const listed =
			block.match === undefined ? relative !== undefined : block.match.some((glob) => surfaceGlobFinds(glob, file));
		return listed && !block.skip?.some((glob) => surfaceGlobFinds(glob, file));
	};
}

function pageColors(layout: SurfaceLayoutRead, readJson: SurfaceJsonReader): SurfacePageColors {
	const light = resolveSurfaceColors(layout.colors, readJson);
	return { light, dark: surfaceColorsForDark(light), own: layout.colors !== undefined };
}

function isRow(node: PreparedNode): node is PreparedRow {
	return "cells" in node;
}

function nodeFilled(node: PreparedNode): boolean {
	return isRow(node) ? node.cells.some((cell) => cell.filled) : node.filled;
}

function heroSection(parts: readonly SurfaceBlockPrepared[]): HTMLElement {
	const section = h("section", { class: "studio-product" });
	let head: HTMLElement | undefined;
	for (const part of parts) {
		const built = part.pieces.map((piece) => piece.build());
		if (part.hero === "swatch") {
			if (head) head.append(...built);
			else section.append(h("div", { class: "studio-product-head" }, built));
			head = undefined;
			continue;
		}
		section.append(...built);
		head = part.hero === "title" ? built[0] : undefined;
	}
	return section;
}

function cellOf(cell: SurfaceBlockPrepared): HTMLElement {
	return h(
		"div",
		{ class: "studio-row-cell" },
		cell.hero ? heroSection([cell]) : cell.pieces.map((piece) => piece.build()),
	);
}

function nodeKey(block: SurfaceReadBlock, place: string): string {
	return block.type !== "unknown" && block.id ? `#${block.id}` : place;
}

export class SurfaceLayoutView {
	readonly #options: SurfaceLayoutOptions;
	readonly #fullscreen: StudioFullscreen;
	readonly #stages: SurfaceStages;
	readonly #reports: SurfaceReports;
	readonly #libraries: SurfaceLibraries;
	readonly #talks: SurfaceTalks;
	readonly #explainers: SurfaceExplainers;
	readonly #pictures: SurfacePictures;
	readonly #pdfs: SurfacePdfViewer;
	readonly #asks: SurfaceAsks;
	readonly #colorways = new Map<string, number>();
	readonly #economics = new Map<string, EconomicsPick>();
	#renderLife: AbortController | null = null;
	#swatches = new Map<string, SwatchLink>();
	#apart: readonly string[] = [];
	#postTabs: readonly {
		readonly id: string;
		readonly posts: PathTest;
		readonly library: PathTest;
		readonly modules: PathTest;
		readonly files: PathTest;
	}[] = [];

	constructor(options: SurfaceLayoutOptions) {
		this.#options = options;
		const read =
			options.readBinary ??
			((file: StudioBinaryRef, signal: AbortSignal) => options.store.readStudioBinary(file, signal));
		this.#fullscreen = new StudioFullscreen(options.signal);
		this.#stages = new SurfaceStages(read, options.signal, this.#fullscreen);
		this.#pictures = new SurfacePictures(read, options.signal);
		this.#pdfs = new SurfacePdfViewer(read, options.signal);
		this.#explainers = new SurfaceExplainers(read, options.signal, this.#fullscreen);
		this.#asks = new SurfaceAsks(options.live ?? {}, options.signal);
		this.#libraries = new SurfaceLibraries({
			store: options.store,
			pictures: this.#pictures,
			signal: options.signal,
		});
		this.#talks = new SurfaceTalks({
			companyName: options.store.companyName,
			pictures: this.#pictures,
			read,
			signal: options.signal,
			post: (path, ctx) => this.#libraries.post(path, ctx),
			openPost: (path) => options.reveal?.(path),
		});
		this.#reports = new SurfaceReports({
			store: options.store,
			surface: options.surface,
			signal: options.signal,
			baseFiles: options.baseFiles,
			...(options.patches ? { patches: options.patches } : {}),
			...(options.timeSlice !== undefined ? { timeSlice: options.timeSlice } : {}),
		});
	}

	#abortRender(): void {
		if (!this.#renderLife) return;
		this.#renderLife.abort();
		this.#renderLife = null;
	}

	plan(input: SurfaceLayoutInput): SurfaceLayoutPlan {
		this.#abortRender();
		const renderLife = new AbortController();
		this.#renderLife = renderLife;
		if (this.#options.signal.aborted) renderLife.abort();
		else
			this.#options.signal.addEventListener("abort", () => renderLife.abort(), {
				once: true,
				signal: renderLife.signal,
			});
		const layoutPath = surfaceLayoutPath(input.surface.folderRoot);
		const text = input.files[layoutPath];
		const read = text === undefined ? undefined : readSurfaceLayout(text);
		const own = read && "layout" in read ? read.layout : undefined;
		const layout: SurfaceLayoutRead = own ?? starterSurfaceLayout(input.starter);
		const asked = new Set<string>();
		const ctx = createBlockContext({
			surface: input.surface,
			files: input.files,
			baseFiles: input.baseFiles,
			binaries: input.binaries,
			baseBinaries: input.baseBinaries,
			company: input.company,
			briefSummary: input.briefSummary,
			signal: this.#options.signal,
			renderSignal: renderLife.signal,
			fromStarter: own === undefined,
			...(this.#options.askSurface ? { askSurface: this.#options.askSurface } : {}),
			colors: (readJson) => pageColors(layout, readJson),
			ask: (source: SurfaceAskSource) => {
				const handle = this.#asks.handle(source);
				asked.add(handle.key);
				return handle;
			},
			askAfter: (source: SurfaceAskSource, parent: string) => this.#asks.handle(source, parent),
		});
		this.#swatches = new Map();
		const stageKeys = new Set<string>();
		this.#apart = moduleFolders(layout, ctx);
		const claimed = claimedFiles(layout, ctx, layoutPath, this.#apart, this.#libraries, this.#talks);
		this.#postTabs = layout.tabs.map((tab) => {
			const blocks = tab.blocks.flatMap((node) => (node.type === "row" ? node.blocks : [node]));
			const posts = blocks.flatMap((block) =>
				block.type === "report" ? [reportFiles(block, ctx, this.#apart).include] : [],
			);
			const libraries = blocks.flatMap((block) =>
				block.type === "library" ? [this.#libraries.holds(block, ctx, this.#apart)] : [],
			);
			const files = blocks.flatMap((block) => (block.type === "artifacts" ? [artifactsHold(block, ctx)] : []));
			const folders = blocks.flatMap((block) => {
				const folder = block.type === "module" ? moduleFolder(block, ctx) : undefined;
				return folder ? [folder] : [];
			});
			return {
				id: tab.id,
				posts: (path: string) => posts.some((include) => include(path)),
				library: (path: string) => libraries.some((holds) => holds(path)),
				modules: (path: string) => folders.some((folder) => path.startsWith(`${folder}/`)),
				files: (path: string) => !claimed.has(path) && files.some((hold) => hold(path)),
			};
		});
		const tabs = layout.tabs.map((tab) => ({ tab, nodes: this.#prepareTab(tab, ctx, input, claimed, stageKeys) }));
		this.#stages.keep(stageKeys);
		this.#asks.keep(asked);
		const placed = new Set(
			layout.tabs.flatMap((tab) =>
				tab.blocks.flatMap((node, index) =>
					node.type === "row"
						? node.blocks.map((block, slot) => nodeKey(block, `${tab.id}/${index}.${slot}`))
						: [nodeKey(node, `${tab.id}/${index}`)],
				),
			),
		);
		this.#libraries.keep(placed);
		this.#talks.keep(placed);
		const current = tabs.find((item) => item.tab.id === input.tab) ?? tabs[0]!;
		const activeExplainers = new Set<string>();
		const activeTalks = new Set<string>();
		current.tab.blocks.forEach((node, index) => {
			if (node.type === "row") {
				node.blocks.forEach((block, slot) => {
					if (block.type === "explainer")
						activeExplainers.add(nodeKey(block, `${current.tab.id}/${index}.${slot}`));
					if (block.type === "talks") activeTalks.add(nodeKey(block, `${current.tab.id}/${index}.${slot}`));
				});
			} else if (node.type === "explainer") {
				activeExplainers.add(nodeKey(node, `${current.tab.id}/${index}`));
			} else if (node.type === "talks") {
				activeTalks.add(nodeKey(node, `${current.tab.id}/${index}`));
			}
		});
		this.#explainers.keep(activeExplainers);
		this.#talks.shown(activeTalks);
		const tabBar =
			tabs.length > 1
				? h(
						"div",
						{ class: "studio-tabs", role: "tablist", "aria-label": t("Studio views") },
						...tabs.map((item) =>
							h(
								"button",
								{
									type: "button",
									role: "tab",
									class: `studio-tab${item === current ? " is-on" : ""}${item.nodes.some(nodeFilled) ? "" : " is-empty"}`,
									"aria-selected": String(item === current),
									"data-act": "studio-tab",
									"data-tab": item.tab.id,
								},
								ctx.words(item.tab.title),
							),
						),
					)
				: null;
		return { tab: current.tab.id, tabBar, tasks: this.#tasks(current.nodes) };
	}

	#prepareTab(
		tab: SurfaceTab<SurfaceReadNode>,
		ctx: SurfaceBlockContext,
		input: SurfaceLayoutInput,
		claimed: ReadonlySet<string>,
		stageKeys: Set<string>,
	): PreparedNode[] {
		const places = tab.blocks.flatMap((node, index) =>
			node.type === "row"
				? node.blocks.map((block, slot) => ({ block, key: nodeKey(block, `${tab.id}/${index}.${slot}`) }))
				: [{ block: node, key: nodeKey(node, `${tab.id}/${index}`) }],
		);
		const swatches = new Map<string, readonly ColorToken[]>();
		const tinting = new Map<string, string>();
		const ids = new Map<string, string>();
		for (const { block, key } of places) {
			if (block.type === "stage_3d") {
				stageKeys.add(key);
				if (block.id) ids.set(block.id, key);
			}
			if (block.type === "swatch_row") {
				swatches.set(key, readSwatches(block, ctx));
				if (block.tints) tinting.set(block.tints, key);
			}
		}
		const scope: TabScope = { ctx, input, claimed, swatches, tinting, stageIds: ids };
		const alone = tab.blocks.length === 1;
		const nodes: PreparedNode[] = tab.blocks.map((node, index) =>
			node.type === "row"
				? {
						cells: node.blocks.map((block, slot) =>
							this.#prepareBlock(block, nodeKey(block, `${tab.id}/${index}.${slot}`), scope, false),
						),
					}
				: this.#prepareBlock(node, nodeKey(node, `${tab.id}/${index}`), scope, alone),
		);
		const hasPieces = nodes.some((node) =>
			isRow(node) ? node.cells.some((cell) => cell.pieces.length > 0) : node.pieces.length > 0,
		);
		if (!hasPieces && tab.blocks.length > 0) {
			const lead = tab.blocks[0]!;
			const leadBlock = lead.type === "row" ? lead.blocks[0] : lead;
			if (leadBlock) {
				const leadKey =
					lead.type === "row" ? nodeKey(leadBlock, `${tab.id}/0.0`) : nodeKey(leadBlock, `${tab.id}/0`);
				const fallback = this.#prepareBlock(leadBlock, leadKey, scope, true);
				if (fallback.pieces.length > 0) return [fallback];
			}
		}
		return nodes;
	}

	#selected(key: string, count: number): number {
		const index = this.#colorways.get(key) ?? 0;
		if (index < count) return index;
		this.#colorways.set(key, 0);
		return 0;
	}

	#prepareBlock(block: SurfaceReadBlock, key: string, scope: TabScope, alone: boolean): SurfaceBlockPrepared {
		const prepared = this.#prepareBlockInner(block, key, scope, alone);
		if (block.type === "unknown" || !block.id || prepared.pieces.length === 0) return prepared;
		const blockId = block.id;
		return {
			...prepared,
			pieces: prepared.pieces.map((piece) => ({
				...piece,
				build: () => {
					const el = piece.build();
					if (!el.hasAttribute("data-block-id")) el.dataset.blockId = blockId;
					return el;
				},
			})),
		};
	}

	#prepareBlockInner(block: SurfaceReadBlock, key: string, scope: TabScope, alone: boolean): SurfaceBlockPrepared {
		const { ctx } = scope;
		switch (block.type) {
			case "stage_3d": {
				const rowKey = block.id ? scope.tinting.get(block.id) : undefined;
				const colours = rowKey ? (scope.swatches.get(rowKey) ?? []) : undefined;
				return this.#stages.prepare(
					key,
					block,
					ctx,
					scope.input.legacyModel,
					rowKey && colours ? { colours, selected: this.#selected(rowKey, colours.length) } : undefined,
				);
			}
			case "title":
				return prepareTitle(block, ctx);
			case "swatch_row": {
				const colours = scope.swatches.get(key) ?? [];
				const stage = block.tints ? scope.stageIds.get(block.tints) : undefined;
				this.#swatches.set(key, { ...(stage ? { stage } : {}), values: colours.map((colour) => colour.value) });
				return prepareSwatchRow(key, colours, this.#selected(key, colours.length));
			}
			case "palette":
				return preparePalette(block, ctx);
			case "brand_mark":
				return this.#pictures.prepare(block, ctx, this.#fullscreen);
			case "type_specimen":
				return prepareTypeSpecimen(block, ctx);
			case "facts":
				return prepareFacts(block, ctx);
			case "spec_list":
				return prepareSpecList(block, ctx);
			case "table":
				return prepareTable(block, ctx, this.#fullscreen);
			case "cards":
				return prepareCards(block, ctx);
			case "report":
				return this.#reports.prepare(block, ctx, this.#apart, alone);
			case "library":
				return this.#libraries.prepare(key, block, ctx, this.#apart, alone);
			case "talks":
				return this.#talks.prepare(key, block, ctx, alone);
			case "explainer":
				return this.#explainers.prepare(key, block, ctx, alone);
			case "artifacts":
				return prepareArtifacts(
					block,
					ctx,
					scope.input.htmlPages,
					this.#pictures,
					this.#fullscreen,
					{ claimed: scope.claimed, alone },
					this.#pdfs,
				);
			case "module":
				return prepareModule(block, ctx, scope.input.htmlPages, this.#fullscreen, { alone });
			case "plays":
				return preparePlays(block, ctx);
			case "economics":
				return prepareEconomics(block, ctx, {
					get: () => this.#economics.get(key),
					set: (pick) => this.#economics.set(key, pick),
				});
			case "hypotheses":
				return prepareHypotheses(block, ctx);
			case "landscape":
				return prepareLandscape(block, ctx);
			case "chart":
				return prepareChart(block, ctx, this.#fullscreen);
			default:
				return prepareUnknown();
		}
	}

	#tasks(nodes: readonly PreparedNode[]): StudioSectionTask[] {
		const tasks: StudioSectionTask[] = [];
		let run: SurfaceBlockPrepared[] = [];
		const flush = () => {
			if (run.length === 0) return;
			const parts = run;
			tasks.push({ build: () => heroSection(parts) });
			run = [];
		};
		for (const node of nodes) {
			if (isRow(node)) {
				flush();
				tasks.push({
					heavy: node.cells.some((cell) => cell.pieces.some((piece) => piece.heavy)),
					build: () => {
						const row = h(
							"div",
							{ class: "studio-row" },
							h("div", { class: "studio-row-cells" }, node.cells.map(cellOf)),
						);
						row.style.setProperty("--studio-row-columns", String(node.cells.length));
						return row;
					},
				});
			} else if (node.hero) {
				run.push(node);
			} else {
				flush();
				tasks.push(...node.pieces);
			}
		}
		flush();
		return tasks;
	}

	placeOf(path: string): { readonly tab: string; readonly in: "posts" | "library" | "module" | "files" } | undefined {
		const posts = this.#postTabs.find((tab) => tab.posts(path) || tab.library(path));
		if (posts) return { tab: posts.id, in: posts.library(path) ? "library" : "posts" };
		const module = this.#postTabs.find((tab) => tab.modules(path));
		if (module) return { tab: module.id, in: "module" };
		const files = this.#postTabs.find((tab) => tab.files(path));
		return files ? { tab: files.id, in: "files" } : undefined;
	}

	showPost(path: string): void {
		this.#libraries.open(path);
	}

	click(target: HTMLElement, root: HTMLElement): boolean {
		if (target.dataset.act === "studio-explainer") {
			const key = target.dataset.block;
			const path = target.dataset.path;
			if (!key || !path) return false;
			return this.#explainers.select(key, path, root);
		}
		if (target.dataset.act !== "studio-colorway") return false;
		const key = target.dataset.block;
		const index = Number(target.dataset.index);
		if (!key || !Number.isInteger(index) || (this.#colorways.get(key) ?? 0) === index) return true;
		this.#colorways.set(key, index);
		for (const dot of root.querySelectorAll<HTMLElement>('[data-act="studio-colorway"]')) {
			if (dot.dataset.block !== key) continue;
			const on = dot === target;
			dot.classList.toggle("is-on", on);
			dot.setAttribute("aria-checked", String(on));
		}
		const link = this.#swatches.get(key);
		if (link?.stage) this.#stages.setColorway(link.stage, index, link.values[index]);
		return true;
	}

	deactivate(): void {
		this.#abortRender();
		this.#fullscreen.close(false);
		this.#reports.deactivate();
		this.#libraries.deactivate();
		this.#talks.deactivate();
		this.#explainers.deactivate();
	}

	dispose(): void {
		this.#abortRender();
		this.#fullscreen.close(false);
		this.#reports.dispose();
		this.#libraries.deactivate();
		this.#talks.deactivate();
		this.#explainers.dispose();
		this.#pdfs.dispose();
		this.#asks.dispose();
	}
}
