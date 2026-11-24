import { composeStudioPreview } from "@qorpera/cloud-client/surface-studio-patches";
import {
	type CompiledIdentityTokens,
	type StudioBinaryRef,
	type StudioPatchChange,
	type StudioPatchOp,
	type SurfacePreviewConflict,
	type SurfaceStarterKind,
	type SurfaceSummary,
	sharedAssetsConsumedBy,
	sharedAssetsProducedBy,
	surfaceFilesHaveModel,
	surfaceLegacyModelKey,
	surfaceStarterKind,
} from "@qorpera/contracts";
import { AppFrame } from "../../ui/app-frame.ts";
import { h } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { playOnce } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";
import { surfaceSkeleton } from "../../ui/skeleton.ts";
import { createFrameBudget, hasBrowserCompositor, yieldToMain } from "../../ui/time-slice.ts";
import {
	effectiveStudioBaseBinaries,
	effectiveStudioBaseFiles,
	formatConflictPaths,
	isLocalSurfaceId,
	isOpenChange,
	normalizeStudioPatchOps,
	type SurfacesStore,
	type SurfaceUpdatePhase,
} from "../surfaces-store.ts";
import {
	parseJsonObject,
	readableName,
	type StudioSectionTask,
	type SurfaceFileLayer,
} from "./surface-blocks/context.ts";
import {
	docPriority,
	HTML_FILE_RE,
	htmlDocumentTitle,
	MARKDOWN_FILE_RE,
	PROSE_TEXT_FILE_RE,
	renderPlainDoc,
	type StudioDoc,
	type StudioSvgAsset,
	SVG_FILE_RE,
	svgDataUrl,
} from "./surface-blocks/files.ts";
import { collectSpecs, type SpecEntry } from "./surface-blocks/specs.ts";
import type { LegacyStudioModel } from "./surface-blocks/stage.ts";
import { SurfaceLayoutView } from "./surface-layout-view.ts";
import { surfaceTile } from "./surface-rail.ts";
import { compiledTokensCssFrom, prepareStudioHtmlPreview, studioHtmlDependencyChanged } from "./surface-studio-html.ts";

export { prepareStudioHtmlPreview };

export interface SurfaceStudioOptions {
	readonly store: SurfacesStore;
	readonly surface: SurfaceSummary;
	readonly signal: AbortSignal;
	readonly baseFiles?: Readonly<Record<string, string>>;
	readonly patches?: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly loadFiles?: (surface: SurfaceSummary, signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
	readonly timeSlice?: boolean;
}

interface SpecSection {
	readonly path: string;
	readonly title: string;
	readonly changed: boolean;
	readonly entries: readonly SpecEntry[];
}

interface StudioHtmlPage {
	readonly path: string;
	readonly title: string;
	readonly html: string;
	readonly baseHtml?: string;
	readonly changed: boolean;
}

const OBJECT_JSON_RE = /(?:^|\/)object\.json$/i;
const REPORT_JSON_RE = /\.report\.json$/i;

function updatingLabel(phase: SurfaceUpdatePhase): string {
	if (phase === "publishing") return t("Publishing…");
	if (phase === "merging") return t("Applying…");
	return t("Updating…");
}

function sameDeps(prev: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
	if (!prev || prev.length !== next.length) return false;
	for (let i = 0; i < next.length; i++) {
		if (!Object.is(prev[i], next[i])) return false;
	}
	return true;
}

function sameOrderedChanges(
	prev: readonly StudioPatchChange[] | undefined,
	next: readonly StudioPatchChange[],
): boolean {
	if (!prev || prev.length !== next.length) return false;
	for (let i = 0; i < next.length; i++) {
		if (prev[i]!.changeId !== next[i]!.changeId || prev[i]!.ops !== next[i]!.ops) return false;
	}
	return true;
}

interface ParsedStudioFiles {
	readonly specs: SpecSection[];
	readonly docs: StudioDoc[];
	readonly htmlPages: StudioHtmlPage[];
	readonly svgs: StudioSvgAsset[];
	legacyModel: LegacyStudioModel | undefined;
}

function emptyParsedStudioFiles(): ParsedStudioFiles {
	return { specs: [], docs: [], htmlPages: [], svgs: [], legacyModel: undefined };
}

function parseSingleStudioFile(
	path: string,
	files: Readonly<Record<string, string>>,
	baseFiles: Readonly<Record<string, string>>,
	previewTokensCss: string,
	baseTokensCss: string,
	compare: boolean,
	out: ParsedStudioFiles,
): void {
	if (OBJECT_JSON_RE.test(path) || REPORT_JSON_RE.test(path)) return;
	const content = files[path] ?? "";
	const baseContent = baseFiles[path];
	const changed = baseContent !== content;
	if (path.toLowerCase().endsWith(".json")) {
		const parsed = parseJsonObject(content);
		if (!parsed) return;
		const baseParsed = parseJsonObject(baseContent);
		if (!out.legacyModel) {
			const key = surfaceLegacyModelKey(parsed);
			if (key) out.legacyModel = { value: parsed[key], base: baseParsed?.[key] };
		}
		if (!compare) return;
		const entries: SpecEntry[] = [];
		collectSpecs(parsed, baseParsed, [], entries, []);
		if (entries.length) out.specs.push({ path, title: readableName(path), changed, entries });
		return;
	}
	if (!compare) return;
	if (HTML_FILE_RE.test(path)) {
		out.htmlPages.push({
			path,
			title: htmlDocumentTitle(content, path),
			html: content,
			...(baseContent !== undefined ? { baseHtml: baseContent } : {}),
			changed:
				changed || studioHtmlDependencyChanged(content, path, files, baseFiles, previewTokensCss, baseTokensCss),
		});
		return;
	}
	if (SVG_FILE_RE.test(path)) {
		const trimmed = content.trim();
		if (/<svg[\s>]/i.test(trimmed)) {
			const baseTrimmed = baseContent?.trim();
			out.svgs.push({
				path,
				title: readableName(path),
				svg: trimmed,
				...(baseTrimmed && /<svg[\s>]/i.test(baseTrimmed) ? { baseSvg: baseTrimmed } : {}),
				changed,
			});
		}
		return;
	}
	if (MARKDOWN_FILE_RE.test(path) || PROSE_TEXT_FILE_RE.test(path)) {
		out.docs.push({
			path,
			title: readableName(path),
			content,
			...(baseContent !== undefined ? { baseContent } : {}),
			isMarkdown: MARKDOWN_FILE_RE.test(path),
			changed,
		});
	}
}

function reconcileChildren(parent: HTMLElement, next: readonly HTMLElement[]): void {
	const keep = new Set<ChildNode>(next);
	for (let child = parent.firstChild; child; ) {
		const sibling = child.nextSibling;
		if (!keep.has(child)) child.remove();
		child = sibling;
	}
	let cursor = parent.firstChild;
	for (const node of next) {
		if (node === cursor) {
			cursor = cursor.nextSibling;
			continue;
		}
		parent.insertBefore(node, cursor);
	}
}

export class SurfaceStudioView {
	readonly el = h("div", { class: "surface-studio" });
	readonly #options: SurfaceStudioOptions;
	readonly #lifetime = new AbortController();
	#baseFiles: Readonly<Record<string, string>>;
	#loading = false;
	#showingSkeleton = false;
	#renderSeq = 0;
	#lastConflict: SurfacePreviewConflict | null = null;
	#layout: SurfaceLayoutView | undefined;
	readonly #htmlFrames: AppFrame[] = [];
	#tab = "overview";
	#renderedTab: string | null = null;
	#renderedGrid: HTMLElement | null = null;
	#shownDeps: readonly unknown[] | undefined;
	#shownOrdered: readonly StudioPatchChange[] | undefined;
	#appliedIdentityVars: string[] = [];
	#wasUpdating = false;
	#settleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: SurfaceStudioOptions) {
		this.#options = options;
		this.#baseFiles = options.baseFiles ? { ...options.baseFiles } : {};
		options.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.el.addEventListener("click", (event) => this.#click(event), { signal: this.#lifetime.signal });
		if (!options.baseFiles) {
			const cloudManaged =
				options.store.canLoadCloudFiles &&
				!isLocalSurfaceId(options.surface.id) &&
				options.store.state.source === "cloud";
			if (cloudManaged) {
				if (
					!options.store.state.cloudSurfaceFiles[options.surface.id] &&
					!options.store.isCloudFilesLoading(options.surface.id)
				) {
					void options.store.refreshCloudFiles(options.surface);
				}
			} else if (options.loadFiles) {
				void this.#load();
			}
		}
		this.update();
	}

	deactivate(): void {
		this.#renderSeq++;
		this.#renderedTab = null;
		this.#renderedGrid = null;
		this.#layout?.deactivate();
	}

	dispose(): void {
		this.#renderSeq += 1;
		this.#disposeHtmlFrames();
		if (this.#settleTimer) {
			clearTimeout(this.#settleTimer);
			this.#settleTimer = undefined;
		}
		this.#layout?.dispose();
		this.#lifetime.abort();
	}

	#disposeHtmlFrames(): void {
		for (const frame of this.#htmlFrames) frame.dispose();
		this.#htmlFrames.length = 0;
	}

	#createHtmlFrame(
		html: string,
		htmlPath: string,
		title: string,
		files: Readonly<Record<string, string>>,
		compiledTokensCss: string,
		className: string,
		listen?: (data: unknown) => void,
	): HTMLElement {
		const live = prepareStudioHtmlPreview(html, htmlPath, files, compiledTokensCss);
		if (live === null) {
			return h("p", { class: "studio-html-fallback" }, t("This page can't be shown live."));
		}
		const frame = new AppFrame(
			{ html: live },
			t("Page: {name}", { name: title }),
			className,
			async () => ({ ok: false, error: t("This page can't be shown here.") }),
			() => undefined,
			{ again: true },
		);
		this.#htmlFrames.push(frame);
		if (listen) {
			window.addEventListener(
				"message",
				(event) => {
					if (event.source !== null && event.source === frame.frame.contentWindow) listen(event.data);
				},
				{ signal: frame.signal },
			);
		}
		return frame.frame;
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
			/* WHY: An empty or unreadable studio folder renders the calm starter baseline instead of blocking the surface. */
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#loading = false;
				this.update();
			}
		}
	}

	#orderedChanges(folderRoot: string | null | undefined): StudioPatchChange[] {
		const store = this.#options.store;
		const state = store.state;
		if (state.mode === "live") return [];
		const ordered: StudioPatchChange[] = [];
		for (const session of store.activePreviewSessions(this.#options.surface.id)) {
			for (const change of session.changes) {
				if (change.kind !== "folder_patch" || !isOpenChange(change) || !store.isChangeShown(change.id)) continue;
				const ops = this.#options.patches?.[change.id] ?? state.studioPatches[change.id];
				if (ops?.length) ordered.push({ changeId: change.id, ops: normalizeStudioPatchOps(ops, folderRoot) });
			}
		}
		return ordered;
	}

	#effectiveBaseFiles(surfaceId: string): Readonly<Record<string, string>> {
		const state = this.#options.store.state;
		const storeBase = effectiveStudioBaseFiles(state, surfaceId);
		if (!storeBase) return this.#baseFiles;
		return this.#options.baseFiles ? { ...this.#baseFiles, ...storeBase } : storeBase;
	}

	#applyIdentityVars(isIdentity: boolean, tokens: CompiledIdentityTokens | null): void {
		const nextVars = !isIdentity && tokens ? tokens.vars : {};
		const nextKeys = Object.keys(nextVars);
		const nextSet = new Set(nextKeys);
		for (const prop of this.#appliedIdentityVars) {
			if (!nextSet.has(prop)) this.el.style.removeProperty(prop);
		}
		for (const prop of nextKeys) {
			const value = nextVars[prop];
			if (value) this.el.style.setProperty(prop, value);
		}
		this.#appliedIdentityVars = nextKeys;
		this.el.classList.toggle("has-identity-tokens", nextKeys.length > 0);
	}

	update(): void {
		if (this.#lifetime.signal.aborted) return;
		const store = this.#options.store;
		const state = store.state;
		const surface = state.surfaces.find((item) => item.id === this.#options.surface.id) ?? this.#options.surface;
		const baseFiles = this.#effectiveBaseFiles(surface.id);
		const look = store.lookOf(surface);
		const lookKind = look.kind;
		const isIdentitySurface =
			surfaceStarterKind({
				lookKind,
				slug: surface.slug,
				isGlobal: surface.isGlobal === true,
				paths: Object.keys(baseFiles),
				hasModel: false,
			}) === "identity";
		const identityTokens = store.companyIdentityTokens();
		this.#applyIdentityVars(isIdentitySurface, identityTokens);
		const workspace = store.workspace(surface.id);
		const ordered = this.#orderedChanges(surface.folderRoot);
		const busyReconcile = Boolean(state.busy[`reconcile:${surface.id}`]);
		const updatingPhase = store.surfaceUpdatePhase(surface.id);
		const updating = updatingPhase !== null;
		const initialLoading =
			this.#loading || (!state.cloudSurfaceFiles[surface.id] && store.isCloudFilesLoading(surface.id));
		this.el.classList.toggle("is-updating", updating);
		this.el.setAttribute("aria-busy", String(updating));
		if (updating) {
			if (this.#settleTimer) {
				clearTimeout(this.#settleTimer);
				this.#settleTimer = undefined;
			}
			this.el.classList.remove("is-settled");
		} else if (this.#wasUpdating) {
			this.el.classList.add("is-settled");
			if (this.#settleTimer) clearTimeout(this.#settleTimer);
			this.#settleTimer = setTimeout(() => {
				this.#settleTimer = undefined;
				this.el.classList.remove("is-settled");
			}, 600);
		}
		this.#wasUpdating = updating;
		const activeOtherSurfaces = state.surfaces.filter((item) => item.status === "active" && item.id !== surface.id);
		const identityFiles = store.companyIdentityFiles();
		const companyFiles = identityFiles && identityFiles.surfaceId !== surface.id ? identityFiles : undefined;
		const linkedSurfacesKey = JSON.stringify(
			activeOtherSurfaces.map((item) => {
				const itemLook = store.lookOf(item);
				return [
					item.id,
					item.slug,
					item.title,
					item.group,
					item.isGlobal === true,
					item.icon,
					itemLook.kind,
					itemLook.accent ?? "",
				];
			}),
		);
		const deps: readonly unknown[] = [
			initialLoading,
			updatingPhase,
			state.mode,
			this.#tab,
			this.#baseFiles,
			state.cloudSurfaceFiles[surface.id],
			state.pendingStudioPatches[surface.id],
			state.localStudioBase[surface.id],
			state.cloudSurfaceBinaries[surface.id],
			state.localStudioBinaries[surface.id],
			surface.id,
			surface.slug,
			surface.title,
			surface.folderRoot,
			surface.isGlobal === true,
			surface.icon,
			lookKind,
			look.accent ?? "",
			identityTokens?.css ?? "",
			companyFiles,
			workspace?.briefSummary ?? "",
			linkedSurfacesKey,
			busyReconcile,
		];
		if (sameDeps(this.#shownDeps, deps) && sameOrderedChanges(this.#shownOrdered, ordered)) return;
		this.#shownDeps = deps;
		this.#shownOrdered = ordered;
		const seq = ++this.#renderSeq;

		const sliced = this.#options.timeSlice ?? hasBrowserCompositor();
		if (initialLoading && Object.keys(baseFiles).length === 0 && ordered.length === 0 && state.mode !== "compare") {
			this.#disposeHtmlFrames();
			this.#renderedTab = null;
			this.#renderedGrid = null;
			this.#showingSkeleton = true;
			this.el.replaceChildren(surfaceSkeleton(t("Opening studio…"), "studio"));
			return;
		}

		const renderParams = {
			seq,
			sliced,
			surface,
			look,
			lookKind,
			identityTokens,
			workspace,
			baseFiles,
			baseBinaries: effectiveStudioBaseBinaries(state, surface.id),
			ordered,
			initialLoading,
			updatingPhase,
			busyReconcile,
			activeOtherSurfaces,
			companyFiles,
			mode: state.mode,
		};
		if (sliced) {
			if (this.el.childElementCount === 0 || this.#showingSkeleton) {
				this.#showingSkeleton = true;
				if (!this.el.querySelector(".skeleton-surface-studio")) {
					this.el.replaceChildren(surfaceSkeleton(t("Opening studio…"), "studio"));
				}
			}
			void this.#renderSliced(renderParams);
			return;
		}
		this.#renderSync(renderParams);
	}

	#isRenderActive(seq: number): boolean {
		return seq === this.#renderSeq && !this.#lifetime.signal.aborted;
	}

	async #renderSliced(params: {
		readonly seq: number;
		readonly sliced: boolean;
		readonly surface: SurfaceSummary;
		readonly look: ReturnType<SurfacesStore["lookOf"]>;
		readonly lookKind: ReturnType<SurfacesStore["lookOf"]>["kind"];
		readonly identityTokens: CompiledIdentityTokens | null;
		readonly workspace: ReturnType<SurfacesStore["workspace"]>;
		readonly baseFiles: Readonly<Record<string, string>>;
		readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
		readonly ordered: readonly StudioPatchChange[];
		readonly initialLoading: boolean;
		readonly updatingPhase: SurfaceUpdatePhase | null;
		readonly busyReconcile: boolean;
		readonly activeOtherSurfaces: readonly SurfaceSummary[];
		readonly companyFiles: SurfaceFileLayer | undefined;
		readonly mode: SurfacesStore["state"]["mode"];
	}): Promise<void> {
		const signal = this.#lifetime.signal;
		const budget = createFrameBudget(6);
		if (!(await yieldToMain(signal).then(() => this.#isRenderActive(params.seq)))) return;
		budget.reset();

		const composition = composeStudioPreview(
			params.baseFiles,
			params.ordered,
			params.surface.folderRoot,
			params.baseBinaries,
		);
		this.#lastConflict = composition.status === "conflicted" ? composition.conflictReport : null;
		const files = composition.files;
		const filePaths = Object.keys(files).sort();
		const previewTokensCss = compiledTokensCssFrom(
			files,
			params.surface.folderRoot,
			params.identityTokens?.css ?? "",
		);
		const baseTokensCss = compiledTokensCssFrom(
			params.baseFiles,
			params.surface.folderRoot,
			params.identityTokens?.css ?? "",
		);
		const compare = params.mode === "compare";
		const parsed = emptyParsedStudioFiles();
		for (const path of filePaths) {
			parseSingleStudioFile(path, files, params.baseFiles, previewTokensCss, baseTokensCss, compare, parsed);
			if (!(await budget.yieldIfNeeded(signal)) || !this.#isRenderActive(params.seq)) return;
		}
		parsed.docs.sort((a, b) => docPriority(a.path) - docPriority(b.path) || a.path.localeCompare(b.path));
		const plan = this.#buildRenderPlan(
			params,
			composition,
			files,
			filePaths,
			previewTokensCss,
			baseTokensCss,
			parsed,
		);
		if (!this.#isRenderActive(params.seq)) return;
		this.#disposeHtmlFrames();
		if (!plan.gridTasks) {
			this.#renderedTab = null;
			this.#renderedGrid = null;
			this.el.replaceChildren(...plan.children);
			if (plan.leavingSkeleton) playOnce(this.el, "is-entering");
			return;
		}
		const reuseGrid = this.#renderedTab === this.#tab && this.#renderedGrid?.parentElement === this.el;
		const grid = reuseGrid ? this.#renderedGrid! : h("div", { class: "studio-grid" });
		this.#renderedTab = this.#tab;
		this.#renderedGrid = grid;
		const tasks = plan.gridTasks;
		if (reuseGrid) {
			reconcileChildren(this.el, [...plan.children, grid]);
			const built: HTMLElement[] = [];
			budget.reset();
			for (let i = 0; i < tasks.length; i++) {
				const task = tasks[i]!;
				if (task.heavy) {
					await yieldToMain(signal);
					if (!this.#isRenderActive(params.seq)) return;
					budget.reset();
				} else if (i > 0 && (!(await budget.yieldIfNeeded(signal)) || !this.#isRenderActive(params.seq))) {
					return;
				}
				built.push(task.build());
			}
			reconcileChildren(grid, built);
			return;
		}
		let start = 0;
		if (tasks[0] && !tasks[0].heavy) {
			grid.append(tasks[0].build());
			start = 1;
		}
		this.el.replaceChildren(...plan.children, grid);
		if (plan.leavingSkeleton) playOnce(this.el, "is-entering");
		budget.reset();
		for (let i = start; i < tasks.length; i++) {
			const task = tasks[i]!;
			if (task.heavy) {
				await yieldToMain(signal);
				if (!this.#isRenderActive(params.seq)) return;
				budget.reset();
			} else if (!(await budget.yieldIfNeeded(signal)) || !this.#isRenderActive(params.seq)) {
				return;
			}
			grid.append(task.build());
		}
	}

	#renderSync(params: {
		readonly seq: number;
		readonly sliced: boolean;
		readonly surface: SurfaceSummary;
		readonly look: ReturnType<SurfacesStore["lookOf"]>;
		readonly lookKind: ReturnType<SurfacesStore["lookOf"]>["kind"];
		readonly identityTokens: CompiledIdentityTokens | null;
		readonly workspace: ReturnType<SurfacesStore["workspace"]>;
		readonly baseFiles: Readonly<Record<string, string>>;
		readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
		readonly ordered: readonly StudioPatchChange[];
		readonly initialLoading: boolean;
		readonly updatingPhase: SurfaceUpdatePhase | null;
		readonly busyReconcile: boolean;
		readonly activeOtherSurfaces: readonly SurfaceSummary[];
		readonly companyFiles: SurfaceFileLayer | undefined;
		readonly mode: SurfacesStore["state"]["mode"];
	}): void {
		const composition = composeStudioPreview(
			params.baseFiles,
			params.ordered,
			params.surface.folderRoot,
			params.baseBinaries,
		);
		this.#lastConflict = composition.status === "conflicted" ? composition.conflictReport : null;
		const files = composition.files;
		const filePaths = Object.keys(files).sort();
		const previewTokensCss = compiledTokensCssFrom(
			files,
			params.surface.folderRoot,
			params.identityTokens?.css ?? "",
		);
		const baseTokensCss = compiledTokensCssFrom(
			params.baseFiles,
			params.surface.folderRoot,
			params.identityTokens?.css ?? "",
		);
		const compare = params.mode === "compare";
		const parsed = emptyParsedStudioFiles();
		for (const path of filePaths) {
			parseSingleStudioFile(path, files, params.baseFiles, previewTokensCss, baseTokensCss, compare, parsed);
		}
		parsed.docs.sort((a, b) => docPriority(a.path) - docPriority(b.path) || a.path.localeCompare(b.path));
		const plan = this.#buildRenderPlan(
			params,
			composition,
			files,
			filePaths,
			previewTokensCss,
			baseTokensCss,
			parsed,
		);
		this.#disposeHtmlFrames();
		if (!plan.gridTasks) {
			this.#renderedTab = null;
			this.#renderedGrid = null;
			this.el.replaceChildren(...plan.children);
			if (plan.leavingSkeleton) playOnce(this.el, "is-entering");
			return;
		}
		const reuseGrid = this.#renderedTab === this.#tab && this.#renderedGrid?.parentElement === this.el;
		const grid = reuseGrid ? this.#renderedGrid! : h("div", { class: "studio-grid" });
		this.#renderedTab = this.#tab;
		this.#renderedGrid = grid;
		if (reuseGrid) {
			const built = plan.gridTasks.map((task) => task.build());
			reconcileChildren(this.el, [...plan.children, grid]);
			reconcileChildren(grid, built);
			return;
		}
		for (const task of plan.gridTasks) grid.append(task.build());
		this.el.replaceChildren(...plan.children, grid);
		if (plan.leavingSkeleton) playOnce(this.el, "is-entering");
	}

	#buildRenderPlan(
		params: {
			readonly surface: SurfaceSummary;
			readonly look: ReturnType<SurfacesStore["lookOf"]>;
			readonly lookKind: ReturnType<SurfacesStore["lookOf"]>["kind"];
			readonly identityTokens: CompiledIdentityTokens | null;
			readonly workspace: ReturnType<SurfacesStore["workspace"]>;
			readonly baseFiles: Readonly<Record<string, string>>;
			readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
			readonly initialLoading: boolean;
			readonly updatingPhase: SurfaceUpdatePhase | null;
			readonly busyReconcile: boolean;
			readonly activeOtherSurfaces: readonly SurfaceSummary[];
			readonly companyFiles: SurfaceFileLayer | undefined;
			readonly mode: SurfacesStore["state"]["mode"];
		},
		composition: ReturnType<typeof composeStudioPreview>,
		files: Readonly<Record<string, string>>,
		filePaths: readonly string[],
		previewTokensCss: string,
		baseTokensCss: string,
		parsed: ParsedStudioFiles,
	): {
		readonly children: HTMLElement[];
		readonly gridTasks?: readonly StudioSectionTask[];
		readonly leavingSkeleton: boolean;
	} {
		const {
			surface,
			look,
			lookKind,
			identityTokens,
			workspace,
			baseFiles,
			initialLoading,
			updatingPhase,
			busyReconcile,
			mode,
		} = params;
		const { specs, docs, htmlPages, svgs, legacyModel } = parsed;

		const badgeText =
			composition.status === "conflicted"
				? t("Conflict")
				: composition.appliedChangeIds.length === 1
					? t("1 live change applied")
					: composition.appliedChangeIds.length > 1
						? t("{count} live changes applied", { count: composition.appliedChangeIds.length })
						: null;
		const badgeClass = composition.status === "conflicted" ? "studio-badge is-conflict" : "studio-badge is-live";

		const children: HTMLElement[] = [];
		if (badgeText || updatingPhase) {
			children.push(
				h(
					"div",
					{ class: "studio-head" },
					badgeText ? h("span", { class: badgeClass }, badgeText) : h("span"),
					updatingPhase
						? h(
								"span",
								{
									class: "studio-updating-pill",
									role: "status",
									"aria-live": "polite",
									"data-updating-phase": updatingPhase,
								},
								h("span", { class: "surface-state is-running", "aria-hidden": "true" }),
								h("span", null, updatingLabel(updatingPhase)),
							)
						: null,
				),
			);
		}

		if (composition.status === "conflicted") {
			const paths = formatConflictPaths(composition.conflictReport.paths);
			children.push(
				h(
					"div",
					{ class: "studio-conflict", role: "alert" },
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
							"data-act": "studio-reconcile",
							disabled: busyReconcile || composition.conflictReport.changeIds.length === 0,
						},
						t("Reconcile"),
					),
				),
			);
		}

		const allChangedPaths = [...new Set([...Object.keys(baseFiles), ...filePaths])]
			.sort()
			.filter((path) => baseFiles[path] !== files[path]);
		const starter = surfaceStarterKind({
			lookKind,
			slug: surface.slug,
			isGlobal: surface.isGlobal === true,
			paths: [...Object.keys(baseFiles), ...filePaths],
			hasModel: surfaceFilesHaveModel(files, Object.keys(composition.binaries)),
		});
		const isIdentity = starter === "identity";

		if (filePaths.length === 0 && (mode !== "compare" || allChangedPaths.length === 0)) {
			if (initialLoading) {
				this.#showingSkeleton = true;
				return { children: [surfaceSkeleton(t("Opening studio…"), "studio")], leavingSkeleton: false };
			}
			if (mode === "compare") {
				const leavingSkeleton = this.#showingSkeleton;
				this.#showingSkeleton = false;
				children.push(
					h(
						"div",
						{ class: "studio-empty" },
						surfaceTile(surface, look, "is-hero"),
						h("h2", null, surface.title),
						workspace?.briefSummary ? h("p", { class: "studio-brief" }, workspace.briefSummary) : null,
						h(
							"p",
							null,
							t("No studio files yet. Describe a change below to create tokens, specs, or guidelines."),
						),
					),
				);
				return { children, leavingSkeleton };
			}
		}

		const signal = this.#lifetime.signal;
		const gridTasks: StudioSectionTask[] = [];

		if (mode === "compare") {
			const changedSpecs = specs.filter((spec) => spec.changed);
			const changedDocs = docs.filter((doc) => doc.changed);
			const changedSvgs = svgs.filter((asset) => asset.changed);
			const changedHtmlPages = htmlPages.filter((page) => page.changed);
			const renderedPaths = new Set<string>();
			for (const spec of changedSpecs) {
				const diffs = spec.entries.filter((entry) => entry.changed);
				if (!diffs.length) continue;
				renderedPaths.add(spec.path);
				gridTasks.push({
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-compare-card", "data-compare-file": spec.path },
							h(
								"div",
								{ class: "studio-section-head" },
								h("h2", null, spec.title),
								h("code", { class: "studio-file-tag" }, spec.path),
							),
							h(
								"div",
								{ class: "studio-compare-grid" },
								h("div", { class: "studio-compare-col-head" }, t("Base")),
								h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
								...diffs.flatMap((entry) => [
									h(
										"div",
										{ class: "studio-compare-cell is-base" },
										h("small", null, entry.key),
										h("span", null, entry.prev ?? t("Not set")),
									),
									h(
										"div",
										{ class: "studio-compare-cell is-preview" },
										h("small", null, entry.key),
										h("strong", null, entry.value),
									),
								]),
							),
						),
				});
			}
			for (const asset of changedSvgs) {
				renderedPaths.add(asset.path);
				gridTasks.push({
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-compare-card", "data-compare-file": asset.path },
							h(
								"div",
								{ class: "studio-section-head" },
								h("h2", null, asset.title),
								h("code", { class: "studio-file-tag" }, asset.path),
							),
							h(
								"div",
								{ class: "studio-compare-grid" },
								h("div", { class: "studio-compare-col-head" }, t("Base")),
								h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
								h(
									"div",
									{ class: "studio-compare-cell is-base studio-svg-stage" },
									asset.baseSvg
										? h("img", { class: "studio-svg-img", src: svgDataUrl(asset.baseSvg), alt: asset.title })
										: h("em", null, t("Not in Base")),
								),
								h(
									"div",
									{ class: "studio-compare-cell is-preview studio-svg-stage" },
									h("img", { class: "studio-svg-img", src: svgDataUrl(asset.svg), alt: asset.title }),
								),
							),
						),
				});
			}
			for (const doc of changedDocs) {
				renderedPaths.add(doc.path);
				gridTasks.push({
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-compare-card", "data-compare-file": doc.path },
							h(
								"div",
								{ class: "studio-section-head" },
								h("h2", null, doc.title),
								h("code", { class: "studio-file-tag" }, doc.path),
							),
							h(
								"div",
								{ class: "studio-compare-grid" },
								h("div", { class: "studio-compare-col-head" }, t("Base")),
								h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
								h(
									"div",
									{ class: "studio-compare-cell is-base studio-doc-body" },
									...(doc.baseContent
										? doc.isMarkdown
											? [markdown(doc.baseContent)]
											: renderPlainDoc(doc.baseContent, "studio-plain-text", signal)
										: [h("em", null, t("Not in Base"))]),
								),
								h(
									"div",
									{ class: "studio-compare-cell is-preview studio-doc-body" },
									...(doc.isMarkdown
										? [markdown(doc.content)]
										: renderPlainDoc(doc.content, "studio-plain-text", signal)),
								),
							),
						),
				});
			}
			for (const page of changedHtmlPages) {
				renderedPaths.add(page.path);
				gridTasks.push({
					heavy: true,
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-compare-card", "data-compare-file": page.path },
							h(
								"div",
								{ class: "studio-section-head" },
								h("h2", null, page.title),
								h("code", { class: "studio-file-tag" }, page.path),
							),
							h(
								"div",
								{ class: "studio-compare-grid" },
								h("div", { class: "studio-compare-col-head" }, t("Base")),
								h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
								h(
									"div",
									{ class: "studio-compare-cell is-base" },
									page.baseHtml
										? this.#createHtmlFrame(
												page.baseHtml,
												page.path,
												page.title,
												baseFiles,
												baseTokensCss,
												"studio-html-frame is-compare",
											)
										: h("em", null, t("Not in Base")),
								),
								h(
									"div",
									{ class: "studio-compare-cell is-preview" },
									this.#createHtmlFrame(
										page.html,
										page.path,
										page.title,
										files,
										previewTokensCss,
										"studio-html-frame is-compare",
									),
								),
							),
						),
				});
			}
			const otherChangedPaths = allChangedPaths.filter((path) => !renderedPaths.has(path));
			if (otherChangedPaths.length > 0) {
				gridTasks.push({
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-compare-card", "data-compare-other": "true" },
							h("div", { class: "studio-section-head" }, h("h2", null, t("Other changed files"))),
							h(
								"ul",
								{ class: "studio-changed-paths" },
								otherChangedPaths.map((path) =>
									h(
										"li",
										{ "data-compare-file": path },
										h("code", { class: "studio-file-tag" }, path),
										h(
											"span",
											{ class: "studio-changed-pill" },
											files[path] === undefined ? t("Removed") : t("Updated"),
										),
									),
								),
							),
						),
				});
			}
			if (gridTasks.length === 0) {
				gridTasks.push({
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-compare-empty" },
							h("p", null, t("No open changes to compare against Base.")),
						),
				});
			}
			const leavingSkeleton = this.#showingSkeleton;
			this.#showingSkeleton = false;
			return { children, gridTasks, leavingSkeleton };
		}

		this.#applyIdentityVars(isIdentity, identityTokens);
		return this.#layoutPlan(params, children, files, composition.binaries, {
			starter,
			legacyModel,
			previewTokensCss,
			baseTokensCss,
		});
	}

	#sharedLinks(
		surface: SurfaceSummary,
		lookKind: ReturnType<SurfacesStore["lookOf"]>["kind"],
		activeOtherSurfaces: readonly SurfaceSummary[],
	): HTMLElement | null {
		const store = this.#options.store;
		const consumed = sharedAssetsConsumedBy(lookKind);
		const produced = sharedAssetsProducedBy(lookKind);
		const builtOn = new Map<string, (typeof activeOtherSurfaces)[number]>();
		const seenIncomingProducers = new Set<string>();
		for (const link of consumed) {
			if (link.liveSyncMode === "prompt_context" && link.producedBy.every((k) => seenIncomingProducers.has(k))) {
				continue;
			}
			const producers = activeOtherSurfaces.filter((item) => {
				const targetKind = store.lookOf(item).kind;
				return (
					link.producedBy.includes(targetKind) || (link.producedBy.includes("identity") && item.isGlobal === true)
				);
			});
			if (!producers.length) continue;
			for (const k of link.producedBy) seenIncomingProducers.add(k);
			for (const target of producers) builtOn.set(target.slug, target);
		}
		const cleanFolderRoot = surface.folderRoot?.replace(/^\/+|\/+$/g, "") ?? "";
		const primaryProductRoot = store.state.surfaces
			.filter(
				(item) =>
					item.status === "active" &&
					item.archetype === "studio" &&
					store.lookOf(item).kind === "product" &&
					Boolean(item.folderRoot?.replace(/^\/+|\/+$/g, "")),
			)
			.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || a.sortOrder - b.sortOrder)
			.at(0)
			?.folderRoot?.replace(/^\/+|\/+$/g, "");
		const usedBy = new Map<string, (typeof activeOtherSurfaces)[number]>();
		for (const link of produced) {
			if (link.id === "product-catalog" && primaryProductRoot && primaryProductRoot !== cleanFolderRoot) {
				continue;
			}
			const consumers = activeOtherSurfaces
				.filter((item) => link.consumedBy.includes(store.lookOf(item).kind))
				.sort((a, b) => (a.group === "products" ? 0 : 1) - (b.group === "products" ? 0 : 1));
			for (const target of consumers) usedBy.set(target.slug, target);
		}
		if (builtOn.size === 0 && usedBy.size === 0) return null;
		const group = (dir: "in" | "out", label: string, targets: Map<string, (typeof activeOtherSurfaces)[number]>) =>
			targets.size === 0
				? null
				: h(
						"span",
						{ class: "studio-reach-group", "data-link-dir": dir },
						h("span", { class: "studio-reach-label" }, label),
						[...targets.values()].map((target) =>
							h(
								"button",
								{
									type: "button",
									class: "studio-reach-chip",
									"data-act": "studio-open-surface",
									"data-slug": target.slug,
								},
								surfaceTile(target, store.lookOf(target), "is-tiny"),
								h("span", null, target.title),
							),
						),
					);
		return h(
			"section",
			{ class: "studio-reach", "data-live-linked": "true" },
			group("in", t("Builds on"), builtOn),
			group("out", t("Used by"), usedBy),
		);
	}

	#layoutPlan(
		params: {
			readonly surface: SurfaceSummary;
			readonly lookKind: ReturnType<SurfacesStore["lookOf"]>["kind"];
			readonly workspace: ReturnType<SurfacesStore["workspace"]>;
			readonly baseFiles: Readonly<Record<string, string>>;
			readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
			readonly activeOtherSurfaces: readonly SurfaceSummary[];
			readonly companyFiles: SurfaceFileLayer | undefined;
		},
		children: HTMLElement[],
		files: Readonly<Record<string, string>>,
		binaries: Readonly<Record<string, StudioBinaryRef>>,
		page: {
			readonly starter: SurfaceStarterKind;
			readonly legacyModel: LegacyStudioModel | undefined;
			readonly previewTokensCss: string;
			readonly baseTokensCss: string;
		},
	): {
		readonly children: HTMLElement[];
		readonly gridTasks: readonly StudioSectionTask[];
		readonly leavingSkeleton: boolean;
	} {
		this.#layout ??= new SurfaceLayoutView({
			store: this.#options.store,
			surface: this.#options.surface,
			signal: this.#lifetime.signal,
			baseFiles: () => this.#baseFiles,
			...(this.#options.patches ? { patches: this.#options.patches } : {}),
			...(this.#options.timeSlice !== undefined ? { timeSlice: this.#options.timeSlice } : {}),
		});
		const plan = this.#layout.plan({
			surface: params.surface,
			files,
			baseFiles: params.baseFiles,
			binaries,
			baseBinaries: params.baseBinaries,
			company: params.companyFiles,
			briefSummary: params.workspace?.briefSummary ?? "",
			starter: page.starter,
			tab: this.#tab,
			legacyModel: page.legacyModel,
			htmlPages: {
				frame: (frame) =>
					this.#createHtmlFrame(
						frame.html,
						frame.path,
						frame.title,
						frame.files,
						page.previewTokensCss,
						frame.className,
						frame.listen,
					),
				linksChanged: (html, path) =>
					studioHtmlDependencyChanged(
						html,
						path,
						files,
						params.baseFiles,
						page.previewTokensCss,
						page.baseTokensCss,
					),
			},
		});
		this.#tab = plan.tab;
		if (plan.tabBar) children.push(plan.tabBar);
		const gridTasks: StudioSectionTask[] = [];
		if (plan.firstTab) {
			const links = this.#sharedLinks(params.surface, params.lookKind, params.activeOtherSurfaces);
			if (links) gridTasks.push({ build: () => links });
		}
		gridTasks.push(...plan.tasks);
		const leavingSkeleton = this.#showingSkeleton;
		this.#showingSkeleton = false;
		return { children, gridTasks, leavingSkeleton };
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		const { act } = target.dataset;
		if (this.#layout?.click(target, this.el)) return;
		if (act === "studio-tab") {
			const next = target.dataset.tab;
			if (next && next !== this.#tab) {
				this.#tab = next;
				this.update();
			}
			return;
		}
		if (act === "studio-open-surface" && target.dataset.slug) {
			this.#options.store.navigateSurface(target.dataset.slug);
			return;
		}
		if (act === "studio-reconcile") {
			const ids = this.#lastConflict?.changeIds ?? [];
			if (ids.length) void this.#options.store.reconcileChanges(this.#options.surface.id, ids);
			return;
		}
	}
}
