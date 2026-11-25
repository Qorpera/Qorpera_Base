import {
	readSurfaceLayout,
	STUDIO_TOUR_PATH,
	type StudioBinaryRef,
	type StudioPatchOp,
	SURFACE_LAYOUT_PATH,
	type SurfaceLayoutRead,
	type SurfaceReadBlock,
	type SurfaceReadNode,
	type SurfaceStarterKind,
	type SurfaceSummary,
	type SurfaceTab,
	starterSurfaceLayout,
} from "@qorpera/contracts";
import { h } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { SurfacesStore } from "../surfaces-store.ts";
import { prepareArtifacts, type StudioHtmlPages } from "./surface-blocks/artifacts.ts";
import { SurfacePictures } from "./surface-blocks/brand-mark.ts";
import { prepareCards } from "./surface-blocks/cards.ts";
import { type ColorToken, prepareSwatchRow, readSwatches } from "./surface-blocks/colours.ts";
import {
	cleanFolderRoot,
	createBlockContext,
	isPlainRecord,
	type StudioSectionTask,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	type SurfaceFileLayer,
	sourceFile,
} from "./surface-blocks/context.ts";
import { type EconomicsPick, prepareEconomics } from "./surface-blocks/economics.ts";
import { explainerClaimedPaths, SurfaceExplainers } from "./surface-blocks/explainer.ts";
import { prepareFacts } from "./surface-blocks/facts.ts";
import { StudioFullscreen } from "./surface-blocks/fullscreen.ts";
import { prepareHypotheses } from "./surface-blocks/hypotheses.ts";
import { prepareLandscape } from "./surface-blocks/landscape.ts";
import { moduleFolder, prepareModule } from "./surface-blocks/module.ts";
import { preparePalette } from "./surface-blocks/palette.ts";
import { SurfacePdfViewer } from "./surface-blocks/pdf.ts";
import { preparePlays } from "./surface-blocks/plays.ts";
import { reportFiles, SurfaceReports } from "./surface-blocks/report.ts";
import { prepareSpecList, prepareTable } from "./surface-blocks/specs.ts";
import { type LegacyStudioModel, SurfaceStages } from "./surface-blocks/stage.ts";
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

function claimedFiles(layout: SurfaceLayoutRead, ctx: SurfaceBlockContext, layoutPath: string): Set<string> {
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
			const { include } = reportFiles(block, ctx);
			for (const path of Object.keys(ctx.files)) if (include(path)) claimed.add(path);
			continue;
		}
		if (block.type === "explainer") {
			for (const path of explainerClaimedPaths(block, ctx)) claimed.add(path);
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
	readonly #explainers: SurfaceExplainers;
	readonly #pictures: SurfacePictures;
	readonly #pdfs: SurfacePdfViewer;
	readonly #colorways = new Map<string, number>();
	readonly #economics = new Map<string, EconomicsPick>();
	#swatches = new Map<string, SwatchLink>();

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
		this.#reports = new SurfaceReports({
			store: options.store,
			surface: options.surface,
			signal: options.signal,
			baseFiles: options.baseFiles,
			...(options.patches ? { patches: options.patches } : {}),
			...(options.timeSlice !== undefined ? { timeSlice: options.timeSlice } : {}),
		});
	}

	plan(input: SurfaceLayoutInput): SurfaceLayoutPlan {
		const layoutPath = surfaceLayoutPath(input.surface.folderRoot);
		const text = input.files[layoutPath];
		const read = text === undefined ? undefined : readSurfaceLayout(text);
		const own = read && "layout" in read ? read.layout : undefined;
		const layout: SurfaceLayoutRead = own ?? starterSurfaceLayout(input.starter);
		const ctx = createBlockContext({
			surface: input.surface,
			files: input.files,
			baseFiles: input.baseFiles,
			binaries: input.binaries,
			baseBinaries: input.baseBinaries,
			company: input.company,
			briefSummary: input.briefSummary,
			signal: this.#options.signal,
			fromStarter: own === undefined,
			...(this.#options.askSurface ? { askSurface: this.#options.askSurface } : {}),
		});
		this.#swatches = new Map();
		const stageKeys = new Set<string>();
		const claimed = claimedFiles(layout, ctx, layoutPath);
		const tabs = layout.tabs.map((tab) => ({ tab, nodes: this.#prepareTab(tab, ctx, input, claimed, stageKeys) }));
		this.#stages.keep(stageKeys);
		const current = tabs.find((item) => item.tab.id === input.tab) ?? tabs[0]!;
		const activeExplainers = new Set<string>();
		current.tab.blocks.forEach((node, index) => {
			if (node.type === "row") {
				node.blocks.forEach((block, slot) => {
					if (block.type === "explainer")
						activeExplainers.add(nodeKey(block, `${current.tab.id}/${index}.${slot}`));
				});
			} else if (node.type === "explainer") {
				activeExplainers.add(nodeKey(node, `${current.tab.id}/${index}`));
			}
		});
		this.#explainers.keep(activeExplainers);
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
		return tab.blocks.map((node, index) =>
			node.type === "row"
				? {
						cells: node.blocks.map((block, slot) =>
							this.#prepareBlock(block, nodeKey(block, `${tab.id}/${index}.${slot}`), scope, false),
						),
					}
				: this.#prepareBlock(node, nodeKey(node, `${tab.id}/${index}`), scope, alone),
		);
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
				return this.#reports.prepare(block, ctx, alone);
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
		this.#fullscreen.close(false);
		this.#reports.deactivate();
		this.#explainers.deactivate();
	}

	dispose(): void {
		this.#fullscreen.close(false);
		this.#reports.dispose();
		this.#explainers.dispose();
		this.#pdfs.dispose();
	}
}
