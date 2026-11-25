import { composeStudioPreview } from "@qorpera/cloud-client/surface-studio-patches";
import {
	type CompiledIdentityTokens,
	type StudioBinaryRef,
	type StudioPatchChange,
	type StudioPatchOp,
	type SurfaceStarterKind,
	type SurfaceSummary,
	surfaceCompanyPath,
	surfaceFilesHaveModel,
	surfaceLegacyModelKey,
	surfaceStarterKind,
} from "@qorpera/contracts";
import { type AppAnswer, type AppCall, AppFrame } from "../../ui/app-frame.ts";
import { h } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { playOnce } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";
import { surfaceSkeleton } from "../../ui/skeleton.ts";
import { createFrameBudget, hasBrowserCompositor, yieldToMain } from "../../ui/time-slice.ts";
import {
	effectiveStudioBaseBinaries,
	effectiveStudioBaseFiles,
	isLocalSurfaceId,
	isOpenChange,
	normalizeStudioPatchOps,
	type SurfacesStore,
	type SurfaceUpdatePhase,
} from "../surfaces-store.ts";
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
} from "./surface-blocks/artifacts.ts";
import {
	parseJsonObject,
	readableName,
	type StudioSectionTask,
	type SurfaceFileLayer,
} from "./surface-blocks/context.ts";
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
		if (
			prev[i]!.changeId !== next[i]!.changeId ||
			prev[i]!.ops !== next[i]!.ops ||
			prev[i]!.baseFiles !== next[i]!.baseFiles ||
			prev[i]!.previewBaseChangeIds !== next[i]!.previewBaseChangeIds
		)
			return false;
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
	#pendingRetryTarget: { readonly changeIds: readonly string[]; readonly paths: readonly string[] } | null = null;
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

	async #askSurface(prompt: string, title?: string): Promise<void> {
		const trimmed = prompt.trim();
		if (!trimmed) return;
		const session = await this.#options.store.startSession(this.#options.surface.id, trimmed, {
			originKind: "member",
			...(title?.trim() ? { originLabel: title.trim().slice(0, 160) } : {}),
		});
		if (session) this.#options.store.openDrawer(this.#options.surface.id, session.id);
	}

	async #handleModuleCall(
		call: AppCall,
		files: Readonly<Record<string, string>>,
		folderRoot: string,
	): Promise<AppAnswer> {
		if (call.method === "read") {
			const rawPath = typeof call.params.path === "string" ? call.params.path.trim() : "";
			if (!rawPath || rawPath.length > 512) return { ok: false, error: t("This file isn't available.") };
			let resolved: string;
			try {
				resolved = folderRoot ? surfaceCompanyPath(folderRoot, rawPath) : rawPath.replace(/^\/+/, "");
			} catch {
				return { ok: false, error: t("This file isn't available.") };
			}
			const ownText = files[resolved];
			if (ownText !== undefined) return { ok: true, value: ownText };
			const identityFiles = this.#options.store.companyIdentityFiles();
			const sharedText = identityFiles?.files[resolved];
			if (sharedText !== undefined) return { ok: true, value: sharedText };
			return { ok: false, error: t("This file isn't available.") };
		}
		if (call.method === "list") {
			const prefix =
				typeof call.params.prefix === "string" ? call.params.prefix.trim().replace(/^\/+|\/+$/g, "") : "";
			const rootPrefix = folderRoot ? `${folderRoot.replace(/^\/+|\/+$/g, "")}/` : "";
			const entries = Object.keys(files)
				.filter((path) => !rootPrefix || path.startsWith(rootPrefix))
				.map((path) => (rootPrefix ? path.slice(rootPrefix.length) : path))
				.filter((rel) => !prefix || rel === prefix || rel.startsWith(`${prefix}/`))
				.sort();
			return { ok: true, value: entries };
		}
		if (call.method === "tell") {
			const text = typeof call.params.text === "string" ? call.params.text.trim() : "";
			const about = typeof call.params.about === "string" ? call.params.about.trim() : undefined;
			if (!text || text.length > 4000) return { ok: false, error: t("Write a short note first.") };
			await this.#askSurface(text, about);
			return { ok: true, value: { sent: true } };
		}
		return { ok: false, error: t("This page can't be shown here.") };
	}

	#createHtmlFrame(
		html: string,
		htmlPath: string,
		title: string,
		files: Readonly<Record<string, string>>,
		compiledTokensCss: string,
		className: string,
		listen?: (data: unknown) => void,
		owned?: (dispose: () => void) => void,
		allFiles?: Readonly<Record<string, string>>,
	): HTMLElement {
		const live = prepareStudioHtmlPreview(html, htmlPath, files, compiledTokensCss);
		if (live === null) {
			return h("p", { class: "studio-html-fallback" }, t("This page can't be shown live."));
		}
		const folderRoot = this.#options.surface.folderRoot?.replace(/^\/+|\/+$/g, "") ?? "";
		const readable = allFiles ?? files;
		const frame = new AppFrame(
			{ html: live },
			t("Page: {name}", { name: title }),
			className,
			(call) => this.#handleModuleCall(call, readable, folderRoot),
			() => undefined,
			{ again: true },
		);
		if (owned) owned(() => frame.dispose());
		else this.#htmlFrames.push(frame);
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
				if (ops?.length)
					ordered.push({
						changeId: change.id,
						ops: normalizeStudioPatchOps(ops, folderRoot),
						...(change.baseFiles ? { baseFiles: change.baseFiles } : {}),
						...(change.previewBaseChangeIds?.length ? { previewBaseChangeIds: change.previewBaseChangeIds } : {}),
					});
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
		const requestedTab = store.consumeRequestedStudioTab(surface.slug);
		if (requestedTab) this.#tab = requestedTab;
		const identityFiles = store.companyIdentityFiles();
		const companyFiles = identityFiles && identityFiles.surfaceId !== surface.id ? identityFiles : undefined;
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
			workspace?.reconciliations,
			state.reconciliationRequests,
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
			{ reconciliations: params.workspace?.reconciliations },
		);
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
		readonly companyFiles: SurfaceFileLayer | undefined;
		readonly mode: SurfacesStore["state"]["mode"];
	}): void {
		const composition = composeStudioPreview(
			params.baseFiles,
			params.ordered,
			params.surface.folderRoot,
			params.baseBinaries,
			{ reconciliations: params.workspace?.reconciliations },
		);
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
			readonly ordered: readonly StudioPatchChange[];
			readonly initialLoading: boolean;
			readonly updatingPhase: SurfaceUpdatePhase | null;
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
		const { surface, look, lookKind, identityTokens, workspace, baseFiles, initialLoading, updatingPhase, mode } =
			params;
		const { specs, docs, htmlPages, svgs, legacyModel } = parsed;

		let reconciliationFailed = false;
		let reconcilingPreview = false;
		if (composition.status === "conflicted") {
			const conflictIds = composition.conflictReport.changeIds;
			const conflictPaths = composition.conflictReport.paths;
			const existingRec = this.#options.store.reconciliationFor(surface.id, conflictIds);
			const reqState = this.#options.store.reconciliationRequestState(surface.id, conflictIds);
			if (reqState === "pending" || existingRec?.status === "queued" || existingRec?.status === "running") {
				reconcilingPreview = true;
				this.#pendingRetryTarget = null;
			} else if (existingRec?.status === "failed" || existingRec?.status === "ready" || reqState === "failed") {
				reconciliationFailed = true;
				this.#pendingRetryTarget = { changeIds: conflictIds, paths: conflictPaths };
			} else if (!existingRec && this.#options.store.canEnsureReconciliation(surface.id)) {
				void this.#options.store.ensureReconciliation(surface.id, conflictIds, conflictPaths);
				reconcilingPreview = true;
				this.#pendingRetryTarget = null;
			} else {
				this.#pendingRetryTarget = null;
			}
		} else {
			const selectedIds = params.ordered.map((item) => item.changeId);
			const lineageTarget = this.#options.store.lineageReconciliationTarget(surface.id, selectedIds);
			if (lineageTarget) {
				const existingRec = this.#options.store.reconciliationFor(surface.id, lineageTarget.changeIds);
				const reqState = this.#options.store.reconciliationRequestState(surface.id, lineageTarget.changeIds);
				if (reqState === "pending" || existingRec?.status === "queued" || existingRec?.status === "running") {
					reconcilingPreview = true;
					this.#pendingRetryTarget = null;
				} else if (existingRec?.status === "failed" || (!existingRec && reqState === "failed")) {
					reconciliationFailed = true;
					this.#pendingRetryTarget = {
						changeIds: lineageTarget.changeIds,
						paths: lineageTarget.conflictPaths,
					};
				} else if (!existingRec && reqState === undefined) {
					if (this.#options.store.canEnsureReconciliation(surface.id)) {
						void this.#options.store.ensureReconciliation(
							surface.id,
							lineageTarget.changeIds,
							lineageTarget.conflictPaths,
						);
						reconcilingPreview = true;
					}
					this.#pendingRetryTarget = null;
				} else {
					this.#pendingRetryTarget = null;
				}
			} else {
				const activeRec = this.#options.store.activeReconciliationFor(surface.id, selectedIds);
				if (activeRec?.status === "queued" || activeRec?.status === "running") {
					reconcilingPreview = true;
					this.#pendingRetryTarget = null;
				} else if (activeRec?.status === "failed") {
					reconciliationFailed = true;
					this.#pendingRetryTarget = {
						changeIds: activeRec.selectedChangeIds,
						paths: activeRec.conflictPaths ?? [],
					};
				} else {
					this.#pendingRetryTarget = null;
				}
			}
		}

		const effectiveUpdatingPhase = updatingPhase ?? (reconcilingPreview ? "updating" : null);
		const updatingText =
			updatingPhase !== null ? updatingLabel(updatingPhase) : reconcilingPreview ? t("Updating preview…") : null;

		const children: HTMLElement[] = [];
		if (effectiveUpdatingPhase && updatingText) {
			children.push(
				h(
					"div",
					{ class: "studio-head" },
					h("span"),
					h(
						"span",
						{
							class: "studio-updating-pill",
							role: "status",
							"aria-live": "polite",
							"data-updating-phase": effectiveUpdatingPhase,
						},
						h("span", { class: "surface-state is-running", "aria-hidden": "true" }),
						h("span", null, updatingText),
					),
				),
			);
		}

		if (reconciliationFailed && this.#pendingRetryTarget) {
			children.push(
				h(
					"div",
					{ class: "studio-reconcile-retry", role: "status" },
					h("span", null, t("Couldn't update preview")),
					h(
						"button",
						{
							type: "button",
							class: "btn btn-small",
							"data-act": "studio-retry-preview",
						},
						t("Retry"),
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
							h("div", { class: "studio-section-head" }, h("h2", null, spec.title)),
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
							h("div", { class: "studio-section-head" }, h("h2", null, asset.title)),
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
							h("div", { class: "studio-section-head" }, h("h2", null, doc.title)),
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
							h("div", { class: "studio-section-head" }, h("h2", null, page.title)),
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

	#layoutPlan(
		params: {
			readonly surface: SurfaceSummary;
			readonly workspace: ReturnType<SurfacesStore["workspace"]>;
			readonly baseFiles: Readonly<Record<string, string>>;
			readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
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
			askSurface: (prompt, title) => this.#askSurface(prompt, title),
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
						frame.owned,
						files,
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
		const leavingSkeleton = this.#showingSkeleton;
		this.#showingSkeleton = false;
		return { children, gridTasks: plan.tasks, leavingSkeleton };
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
		if (act === "studio-retry-preview") {
			const target = this.#pendingRetryTarget;
			if (target && target.changeIds.length > 0) {
				void this.#options.store.ensureReconciliation(
					this.#options.surface.id,
					target.changeIds,
					target.paths,
					true,
				);
			}
			return;
		}
	}
}
