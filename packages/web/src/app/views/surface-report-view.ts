import { composeStudioPreview } from "@qorpera/cloud-client/surface-studio-patches";
import {
	type StudioBinaryRef,
	type StudioPatchChange,
	type StudioPatchOp,
	type SurfaceSummary,
	surfaceCompanyPath,
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
	isLocalSurfaceId,
	isOpenChange,
	isStandaloneHtmlDeliverablePath,
	normalizeStudioPatchOps,
	type SurfacesStore,
	type SurfaceUpdatePhase,
	surfaceDocSlug,
} from "../surfaces-store.ts";
import { htmlDocumentTitle, PDF_FILE_RE } from "./surface-blocks/artifacts.ts";
import { readableName } from "./surface-blocks/context.ts";
import { formatPdfBytes, SurfacePdfViewer } from "./surface-blocks/pdf.ts";
import { buildPostPage, postPageClick } from "./surface-blocks/post-page.ts";
import { parseReportJson, type ReportDocument, renderReportBlock } from "./surface-blocks/report-document.ts";
import { surfaceTile } from "./surface-rail.ts";
import {
	compiledTokensCssFrom,
	prepareStudioHtmlPreview,
	resolveStudioFrameAssetPath,
	studioAssetMimeType,
	studioFrameBase,
} from "./surface-studio-html.ts";

export interface SurfaceReportOptions {
	readonly store: SurfacesStore;
	readonly surface: SurfaceSummary;
	readonly signal: AbortSignal;
	readonly baseFiles?: Readonly<Record<string, string>>;
	readonly baseBinaries?: Readonly<Record<string, StudioBinaryRef>>;
	readonly patches?: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly loadFiles?: (surface: SurfaceSummary, signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
	readonly embedded?: boolean;
	readonly timeSlice?: boolean;
	readonly include?: (path: string) => boolean;
}

function updatingLabel(phase: SurfaceUpdatePhase): string {
	if (phase === "publishing") return t("Publishing…");
	if (phase === "merging") return t("Applying…");
	return t("Updating…");
}

interface ReportMarkdownDoc {
	readonly path: string;
	readonly slug: string;
	readonly title: string;
	readonly content: string;
	readonly baseContent?: string;
	readonly changed: boolean;
}

interface ReportHtmlDoc {
	readonly path: string;
	readonly slug: string;
	readonly title: string;
	readonly html: string;
	readonly baseHtml?: string;
	readonly changed: boolean;
}

interface ReportPdfDoc {
	readonly path: string;
	readonly slug: string;
	readonly title: string;
	readonly ref: StudioBinaryRef;
	readonly baseRef?: StudioBinaryRef;
	readonly changed: boolean;
}

type ReportSwitcherItem =
	| {
			readonly kind: "report";
			readonly slug: string;
			readonly title: string;
			readonly changed: boolean;
			readonly doc: ReportDocument;
	  }
	| {
			readonly kind: "html";
			readonly slug: string;
			readonly title: string;
			readonly changed: boolean;
			readonly doc: ReportHtmlDoc;
	  }
	| {
			readonly kind: "pdf";
			readonly slug: string;
			readonly title: string;
			readonly changed: boolean;
			readonly doc: ReportPdfDoc;
	  }
	| {
			readonly kind: "markdown";
			readonly slug: string;
			readonly title: string;
			readonly changed: boolean;
			readonly doc: ReportMarkdownDoc;
	  };

interface ReportRenderParams {
	readonly seq: number;
	readonly surface: SurfaceSummary;
	readonly workspace: ReturnType<SurfacesStore["workspace"]>;
	readonly baseFiles: Readonly<Record<string, string>>;
	readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
	readonly ordered: readonly StudioPatchChange[];
	readonly initialLoading: boolean;
	readonly updatingPhase: SurfaceUpdatePhase | null;
	readonly mode: SurfacesStore["state"]["mode"];
	readonly activeReportSlug: string | undefined;
}

function collectPdfDocs(
	binaries: Readonly<Record<string, StudioBinaryRef>>,
	baseBinaries: Readonly<Record<string, StudioBinaryRef>>,
	include: ((path: string) => boolean) | undefined,
): ReportPdfDoc[] {
	const results: ReportPdfDoc[] = [];
	for (const path of Object.keys(binaries).sort()) {
		if (include && !include(path)) continue;
		if (!PDF_FILE_RE.test(path)) continue;
		const ref = binaries[path];
		if (!ref) continue;
		const baseRef = baseBinaries[path];
		results.push({
			path,
			slug: surfaceDocSlug(path),
			title: readableName(path),
			ref,
			...(baseRef ? { baseRef } : {}),
			changed: ref.fileSha256 !== baseRef?.fileSha256,
		});
	}
	return results;
}

function markdownDocTitle(content: string, path: string): string {
	const match = content.match(/^\s*#\s+(.+?)\s*$/m);
	const heading = match?.[1]?.replace(/[*_`[\]]/g, "").trim();
	return heading && heading.length <= 100 ? heading : readableName(path);
}

function parseSingleReportFile(
	path: string,
	files: Readonly<Record<string, string>>,
	baseFiles: Readonly<Record<string, string>>,
	folderRoot: string | null | undefined,
	reports: ReportDocument[],
	htmlDocs: ReportHtmlDoc[],
	markdownDocs: ReportMarkdownDoc[],
): void {
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
			return;
		}
	}
	if (isStandaloneHtmlDeliverablePath(path, folderRoot)) {
		htmlDocs.push({
			path,
			slug: surfaceDocSlug(path),
			title: htmlDocumentTitle(content, path),
			html: content,
			...(baseContent !== undefined ? { baseHtml: baseContent } : {}),
			changed,
		});
		return;
	}
	if (/\.(?:md|markdown)$/i.test(path)) {
		markdownDocs.push({
			path,
			slug: surfaceDocSlug(path),
			title: markdownDocTitle(content, path),
			content,
			...(baseContent !== undefined ? { baseContent } : {}),
			changed,
		});
	}
}

export class SurfaceReportView {
	readonly el = h("div", { class: "surface-report" });
	readonly #options: SurfaceReportOptions;
	readonly #lifetime = new AbortController();
	#baseFiles: Readonly<Record<string, string>>;
	#loading = false;
	#showingSkeleton = false;
	#pendingRetryTarget: { readonly changeIds: readonly string[]; readonly paths: readonly string[] } | null = null;
	#activeSlug = "";
	#lastStoreSlug: string | undefined;
	#shownDeps: readonly unknown[] | undefined;
	#shownOrdered: readonly StudioPatchChange[] | undefined;
	#wasUpdating = false;
	#settleTimer: ReturnType<typeof setTimeout> | undefined;
	#renderSeq = 0;
	readonly #htmlFrames: AppFrame[] = [];
	readonly #pdfs: SurfacePdfViewer;
	#postPage: AbortController | null = null;

	constructor(options: SurfaceReportOptions) {
		this.#options = options;
		if (options.embedded) this.el.classList.add("is-embedded");
		this.#baseFiles = options.baseFiles ? { ...options.baseFiles } : {};
		this.#pdfs = new SurfacePdfViewer(
			(file, signal) => options.store.readStudioBinary(file, signal),
			this.#lifetime.signal,
		);
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

	setBaseFiles(files: Readonly<Record<string, string>>): void {
		if (files === this.#baseFiles) return;
		this.#baseFiles = files;
	}

	#disposeLiveParts(): void {
		for (const frame of this.#htmlFrames) frame.dispose();
		this.#htmlFrames.length = 0;
		this.#postPage?.abort();
		this.#postPage = null;
	}

	#createHtmlFrame(
		html: string,
		htmlPath: string,
		title: string,
		files: Readonly<Record<string, string>>,
		binaries: Readonly<Record<string, StudioBinaryRef>>,
		compiledTokensCss: string,
		folderRoot: string | null | undefined,
	): HTMLElement {
		const live = prepareStudioHtmlPreview(html, htmlPath, files, compiledTokensCss, binaries, folderRoot);
		if (live === null) {
			return h("p", { class: "studio-html-fallback" }, t("This page can't be shown live."));
		}
		const base = studioFrameBase(htmlPath, folderRoot);
		const frame: AppFrame = new AppFrame(
			{ html: live, base },
			t("Page: {name}", { name: title }),
			"report-html-frame studio-html-frame",
			async (call) => {
				if (call.method !== "file") return { ok: false, error: t("This page can't be shown here.") };
				const rawPath = typeof call.params.path === "string" ? call.params.path : "";
				const rawBase = typeof call.params.base === "string" ? call.params.base : "";
				const key = resolveStudioFrameAssetPath(folderRoot, rawBase, rawPath);
				if (!key) return { ok: false, error: t("This file isn't available.") };
				if (Object.hasOwn(binaries, key)) {
					const ref = binaries[key]!;
					try {
						const bytes = await this.#options.store.readStudioBinary(ref, frame.signal);
						if (frame.signal.aborted) return { ok: false, error: t("This file isn't available.") };
						return { ok: true, value: new Blob([new Uint8Array(bytes)], { type: ref.mediaType }) };
					} catch {
						return { ok: false, error: t("This file isn't available.") };
					}
				}
				if (Object.hasOwn(files, key)) {
					return { ok: true, value: new Blob([files[key]!], { type: studioAssetMimeType(key) }) };
				}
				return { ok: false, error: t("This file isn't available.") };
			},
			() => undefined,
			{ again: true },
		);
		this.#htmlFrames.push(frame);
		return frame.frame;
	}

	deactivate(): void {
		this.#renderSeq++;
		this.#disposeLiveParts();
	}

	dispose(): void {
		this.#renderSeq++;
		this.#disposeLiveParts();
		this.#pdfs.dispose();
		if (this.#settleTimer) {
			clearTimeout(this.#settleTimer);
			this.#settleTimer = undefined;
		}
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

	#effectiveBaseBinaries(surfaceId: string): Readonly<Record<string, StudioBinaryRef>> {
		const storeBase = effectiveStudioBaseBinaries(this.#options.store.state, surfaceId);
		return this.#options.baseBinaries ? { ...this.#options.baseBinaries, ...storeBase } : storeBase;
	}

	update(): void {
		if (this.#lifetime.signal.aborted) return;
		const store = this.#options.store;
		const state = store.state;
		const surface = state.surfaces.find((item) => item.id === this.#options.surface.id) ?? this.#options.surface;
		const baseFiles = this.#effectiveBaseFiles(surface.id);
		const baseBinaries = this.#effectiveBaseBinaries(surface.id);
		const workspace = store.workspace(surface.id);
		const ordered = this.#orderedChanges(surface.folderRoot);
		const updatingPhase = this.#options.embedded ? null : store.surfaceUpdatePhase(surface.id);
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
		const deps: readonly unknown[] = [
			initialLoading,
			updatingPhase,
			state.mode,
			state.activeReportSlug,
			this.#activeSlug,
			this.#baseFiles,
			this.#options.baseBinaries,
			state.cloudSurfaceFiles[surface.id],
			state.cloudSurfaceBinaries[surface.id],
			state.pendingStudioPatches[surface.id],
			state.localStudioBase[surface.id],
			state.localStudioBinaries[surface.id],
			surface.title,
			surface.folderRoot,
			workspace?.briefSummary ?? "",
			workspace?.reconciliations,
			state.reconciliationRequests,
		];
		const sameDeps =
			this.#shownDeps !== undefined &&
			this.#shownDeps.length === deps.length &&
			deps.every((value, index) => Object.is(this.#shownDeps![index], value));
		const sameOrdered =
			this.#shownOrdered !== undefined &&
			this.#shownOrdered.length === ordered.length &&
			ordered.every(
				(item, index) =>
					this.#shownOrdered![index]!.changeId === item.changeId &&
					this.#shownOrdered![index]!.ops === item.ops &&
					this.#shownOrdered![index]!.baseFiles === item.baseFiles &&
					this.#shownOrdered![index]!.previewBaseChangeIds === item.previewBaseChangeIds,
			);
		if (sameDeps && sameOrdered) return;
		this.#shownDeps = deps;
		this.#shownOrdered = ordered;
		const seq = ++this.#renderSeq;

		const sliced = this.#options.timeSlice ?? hasBrowserCompositor();
		if (
			initialLoading &&
			Object.keys(baseFiles).length === 0 &&
			Object.keys(baseBinaries).length === 0 &&
			ordered.length === 0 &&
			state.mode !== "compare"
		) {
			this.#showingSkeleton = true;
			this.el.replaceChildren(surfaceSkeleton(t("Opening studio…"), "report"));
			return;
		}

		const params: ReportRenderParams = {
			seq,
			surface,
			workspace,
			baseFiles,
			baseBinaries,
			ordered,
			initialLoading,
			updatingPhase,
			mode: state.mode,
			activeReportSlug: state.activeReportSlug,
		};
		if (sliced) {
			if (this.el.childElementCount === 0 || this.#showingSkeleton) {
				this.#showingSkeleton = true;
				if (!this.el.querySelector(".skeleton-surface-report")) {
					this.el.replaceChildren(surfaceSkeleton(t("Opening studio…"), "report"));
				}
			}
			void this.#renderSliced(params);
			return;
		}
		this.#renderSync(params);
	}

	#isRenderActive(seq: number): boolean {
		return seq === this.#renderSeq && !this.#lifetime.signal.aborted;
	}

	async #renderSliced(params: ReportRenderParams): Promise<void> {
		const signal = this.#lifetime.signal;
		const budget = createFrameBudget(6);
		if (!(await yieldToMain(signal).then(() => this.#isRenderActive(params.seq)))) return;
		budget.reset();

		const composition = composeStudioPreview(
			params.baseFiles,
			params.ordered,
			params.surface.folderRoot,
			params.baseBinaries,
			{
				reconciliations: params.workspace?.reconciliations,
			},
		);
		const files = composition.files;
		const include = this.#options.include;
		const filePaths = Object.keys(files)
			.filter((path) => !include || include(path))
			.sort();

		const reports: ReportDocument[] = [];
		const htmlDocs: ReportHtmlDoc[] = [];
		const markdownDocs: ReportMarkdownDoc[] = [];
		for (const path of filePaths) {
			parseSingleReportFile(
				path,
				files,
				params.baseFiles,
				params.surface.folderRoot,
				reports,
				htmlDocs,
				markdownDocs,
			);
			if (!(await budget.yieldIfNeeded(signal)) || !this.#isRenderActive(params.seq)) return;
		}
		const pdfDocs = collectPdfDocs(composition.binaries, params.baseBinaries, include);

		const plan = this.#buildRenderPlan(params, composition, reports, htmlDocs, pdfDocs, markdownDocs);
		if (!this.#isRenderActive(params.seq)) return;
		if (!plan.article || !plan.sectionTasks) {
			this.el.replaceChildren(...plan.children);
			if (plan.leavingSkeleton) playOnce(this.el, "is-entering");
			return;
		}
		const tasks = plan.sectionTasks;
		if (tasks[0]) plan.article.append(tasks[0]());
		this.el.replaceChildren(...plan.children);
		if (plan.leavingSkeleton) playOnce(this.el, "is-entering");
		budget.reset();
		for (let i = 1; i < tasks.length; i++) {
			if (!(await budget.yieldIfNeeded(signal)) || !this.#isRenderActive(params.seq)) return;
			plan.article.append(tasks[i]!());
		}
	}

	#renderSync(params: ReportRenderParams): void {
		const composition = composeStudioPreview(
			params.baseFiles,
			params.ordered,
			params.surface.folderRoot,
			params.baseBinaries,
			{
				reconciliations: params.workspace?.reconciliations,
			},
		);
		const files = composition.files;
		const include = this.#options.include;
		const filePaths = Object.keys(files)
			.filter((path) => !include || include(path))
			.sort();

		const reports: ReportDocument[] = [];
		const htmlDocs: ReportHtmlDoc[] = [];
		const markdownDocs: ReportMarkdownDoc[] = [];
		for (const path of filePaths) {
			parseSingleReportFile(
				path,
				files,
				params.baseFiles,
				params.surface.folderRoot,
				reports,
				htmlDocs,
				markdownDocs,
			);
		}
		const pdfDocs = collectPdfDocs(composition.binaries, params.baseBinaries, include);
		const plan = this.#buildRenderPlan(params, composition, reports, htmlDocs, pdfDocs, markdownDocs);
		if (plan.article && plan.sectionTasks) {
			for (const task of plan.sectionTasks) plan.article.append(task());
		}
		this.el.replaceChildren(...plan.children);
		if (plan.leavingSkeleton) playOnce(this.el, "is-entering");
	}

	#buildRenderPlan(
		params: ReportRenderParams,
		composition: ReturnType<typeof composeStudioPreview>,
		reports: readonly ReportDocument[],
		htmlDocs: readonly ReportHtmlDoc[],
		pdfDocs: readonly ReportPdfDoc[],
		markdownDocs: readonly ReportMarkdownDoc[],
	): {
		readonly children: HTMLElement[];
		readonly article?: HTMLElement;
		readonly sectionTasks?: readonly (() => HTMLElement)[];
		readonly leavingSkeleton: boolean;
	} {
		this.#disposeLiveParts();
		const { surface, workspace, initialLoading, updatingPhase, mode, activeReportSlug } = params;
		const structuredItems: ReportSwitcherItem[] = [
			...reports.map((doc) => ({
				kind: "report" as const,
				slug: doc.slug,
				title: doc.headline,
				changed: doc.changed,
				doc,
			})),
			...htmlDocs.map((doc) => ({
				kind: "html" as const,
				slug: doc.slug,
				title: doc.title,
				changed: doc.changed,
				doc,
			})),
		];
		const pdfItems: ReportSwitcherItem[] = pdfDocs.map((doc) => ({
			kind: "pdf" as const,
			slug: doc.slug,
			title: doc.title,
			changed: doc.changed,
			doc,
		}));
		const fallbackMarkdownItems: ReportSwitcherItem[] = markdownDocs.map((doc) => ({
			kind: "markdown" as const,
			slug: doc.slug,
			title: doc.title,
			changed: doc.changed,
			doc,
		}));
		const items =
			structuredItems.length > 0 ? [...structuredItems, ...pdfItems] : [...fallbackMarkdownItems, ...pdfItems];

		const storeSlugListed = Boolean(activeReportSlug && items.some((item) => item.slug === activeReportSlug));
		if (activeReportSlug !== this.#lastStoreSlug && (!activeReportSlug || storeSlugListed)) {
			this.#lastStoreSlug = activeReportSlug;
			if (activeReportSlug) this.#activeSlug = activeReportSlug;
		}
		if (items.length && !items.some((item) => item.slug === this.#activeSlug)) {
			this.#activeSlug =
				activeReportSlug && items.some((item) => item.slug === activeReportSlug)
					? activeReportSlug
					: items[0]!.slug;
		}
		const activeItem = items.find((item) => item.slug === this.#activeSlug) ?? items[0];

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
				}
				this.#pendingRetryTarget = null;
			}
		}

		const effectiveUpdatingPhase = updatingPhase ?? (reconcilingPreview ? "updating" : null);
		const updatingText =
			updatingPhase !== null ? updatingLabel(updatingPhase) : reconcilingPreview ? t("Updating preview…") : null;

		const showChrome = items.length > 1 || !this.#options.embedded;
		const chrome = showChrome
			? h(
					"div",
					{ class: "report-chrome" },
					items.length > 1
						? h(
								"div",
								{ class: "report-switcher", role: "tablist", "aria-label": t("Articles & reports") },
								items.map((item) =>
									h(
										"button",
										{
											type: "button",
											role: "tab",
											class: `report-switch-pill${item.slug === activeItem?.slug ? " is-on" : ""}`,
											"aria-selected": String(item.slug === activeItem?.slug),
											"data-act": "report-select",
											"data-slug": item.slug,
										},
										item.changed ? h("span", { class: "report-changed-dot", "aria-hidden": "true" }) : null,
										item.title,
									),
								),
							)
						: h("span", { class: "report-chrome-spacer" }),
					!this.#options.embedded
						? h(
								"div",
								{ class: "report-chrome-tools" },
								effectiveUpdatingPhase && updatingText
									? h(
											"span",
											{
												class: "studio-updating-pill",
												role: "status",
												"aria-live": "polite",
												"data-updating-phase": effectiveUpdatingPhase,
											},
											h("span", { class: "surface-state is-running", "aria-hidden": "true" }),
											h("span", null, updatingText),
										)
									: null,
							)
						: null,
				)
			: null;

		const children: HTMLElement[] = chrome ? [chrome] : [];

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
							"data-act": "report-retry-preview",
						},
						t("Retry"),
					),
				),
			);
		}

		if (mode === "compare") {
			const leavingSkeleton = this.#showingSkeleton;
			this.#showingSkeleton = false;
			children.push(this.#renderCompare(reports, htmlDocs, pdfDocs, markdownDocs));
			return { children, leavingSkeleton };
		}

		if (!activeItem) {
			if (initialLoading) {
				this.#showingSkeleton = true;
				return { children: [surfaceSkeleton(t("Opening studio…"), "report")], leavingSkeleton: false };
			}
			const leavingSkeleton = this.#showingSkeleton;
			this.#showingSkeleton = false;
			children.push(
				h(
					"div",
					{ class: "studio-empty" },
					surfaceTile(surface, this.#options.store.lookOf(surface), "is-hero"),
					h("h2", null, surface.title),
					workspace?.briefSummary ? h("p", { class: "studio-brief" }, workspace.briefSummary) : null,
					h("p", null, t("No reports yet. Describe an analysis, vendor comparison, or design essay below.")),
				),
			);
			return { children, leavingSkeleton };
		}

		const leavingSkeleton = this.#showingSkeleton;
		this.#showingSkeleton = false;

		if (activeItem.kind === "report" && activeItem.doc.evidence?.question !== undefined) {
			const life = new AbortController();
			this.#postPage = life;
			const folderRoot = surface.folderRoot?.replace(/^\/+|\/+$/g, "") ?? "";
			const page = buildPostPage({
				doc: activeItem.doc,
				signal: life.signal,
				related: (activeItem.doc.evidence.related ?? []).flatMap((path) => {
					let resolved: string | undefined;
					try {
						resolved = folderRoot ? surfaceCompanyPath(folderRoot, path) : path.replace(/^\/+/, "");
					} catch {
						resolved = undefined;
					}
					const other = reports.find((report) => report.path === resolved);
					if (!other) return [];
					return [
						{
							title: other.headline,
							meta: other.evidence?.theme ?? other.category,
							attrs: { "data-act": "report-select", "data-slug": other.slug },
						},
					];
				}),
			});
			children.push(h("div", { class: "report-layout is-post" }, page.root));
			return { children, article: page.article, sectionTasks: page.sectionTasks, leavingSkeleton };
		}

		if (activeItem.kind === "report") {
			const activeReport = activeItem.doc;
			const subtitleChanged = Boolean(activeReport.base && activeReport.base.subtitle !== activeReport.subtitle);
			const metricsChanged = Boolean(
				activeReport.base &&
					JSON.stringify(activeReport.base.keyMetrics) !== JSON.stringify(activeReport.keyMetrics),
			);
			const metaParts = [activeReport.author, activeReport.date, activeReport.readingTime].filter(Boolean);
			const article = h(
				"article",
				{ class: "report-article", "data-report-slug": activeReport.slug },
				h(
					"header",
					{ class: "report-hero" },
					activeReport.category ? h("span", { class: "report-category" }, activeReport.category) : null,
					h("h1", { class: "report-headline" }, activeReport.headline),
					activeReport.subtitle
						? h(
								"p",
								{ class: `report-dek${subtitleChanged ? " is-changed" : ""}` },
								activeReport.subtitle,
								subtitleChanged ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
							)
						: null,
					metaParts.length ? h("div", { class: "report-byline" }, metaParts.join(" · ")) : null,
				),
				activeReport.keyMetrics.length
					? h(
							"div",
							{ class: `report-metrics${metricsChanged ? " is-changed" : ""}` },
							activeReport.keyMetrics.map((metric, idx) => {
								const prevMetric = activeReport.base?.keyMetrics[idx];
								const changedMetric = Boolean(
									prevMetric && (prevMetric.value !== metric.value || prevMetric.delta !== metric.delta),
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
			);

			const sectionTasks = activeReport.sections.map((section, idx) => () => {
				const baseSection = activeReport.base?.sections[idx];
				const sectionChanged = Boolean(baseSection && JSON.stringify(baseSection) !== JSON.stringify(section));
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
					...(section.blocks ?? []).map((block) => renderReportBlock(block)),
				);
			});

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
			return { children, article, sectionTasks, leavingSkeleton };
		}

		if (activeItem.kind === "html") {
			const htmlDoc = activeItem.doc;
			const fallbackCss = this.#options.store.companyIdentityTokens()?.css ?? "";
			const compiledTokensCss = compiledTokensCssFrom(composition.files, surface.folderRoot, fallbackCss);
			const card = h(
				"section",
				{
					class: `studio-section studio-html-card report-html-card${htmlDoc.changed ? " is-changed" : ""}`,
					"data-report-slug": htmlDoc.slug,
					"data-file": htmlDoc.path,
				},
				h(
					"div",
					{ class: "studio-section-head" },
					h("h2", null, htmlDoc.title),
					htmlDoc.changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
				),
				this.#createHtmlFrame(
					htmlDoc.html,
					htmlDoc.path,
					htmlDoc.title,
					composition.files,
					composition.binaries,
					compiledTokensCss,
					surface.folderRoot,
				),
			);
			children.push(h("div", { class: "report-layout is-html" }, card));
			return { children, leavingSkeleton };
		}

		if (activeItem.kind === "pdf") {
			const pdfDoc = activeItem.doc;
			const card = this.#pdfs.renderCard({
				path: pdfDoc.path,
				title: pdfDoc.title,
				ref: pdfDoc.ref,
				changed: pdfDoc.changed,
				slug: pdfDoc.slug,
			});
			children.push(h("div", { class: "report-layout is-pdf" }, card));
			return { children, leavingSkeleton };
		}

		const activeDoc = activeItem.doc;
		const article = h("article", { class: "report-article", "data-report-slug": activeDoc.slug });
		const sectionTasks = [
			() =>
				h(
					"section",
					{ class: `report-section${activeDoc.changed ? " is-changed" : ""}` },
					h("div", { class: "report-prose" }, markdown(activeDoc.content)),
				),
		];
		children.push(h("div", { class: "report-layout" }, article));
		return { children, article, sectionTasks, leavingSkeleton };
	}

	#renderCompare(
		reports: readonly ReportDocument[],
		htmlDocs: readonly ReportHtmlDoc[],
		pdfDocs: readonly ReportPdfDoc[],
		markdownDocs: readonly ReportMarkdownDoc[],
	): HTMLElement {
		const changedReports = reports.filter((report) => report.changed);
		const changedHtml = htmlDocs.filter((doc) => doc.changed);
		const changedPdf = pdfDocs.filter((doc) => doc.changed);
		const changedMarkdown =
			changedReports.length === 0 && changedHtml.length === 0 ? markdownDocs.filter((doc) => doc.changed) : [];
		if (!changedReports.length && !changedHtml.length && !changedPdf.length && !changedMarkdown.length) {
			return h(
				"div",
				{ class: "report-compare-wrap" },
				h("div", { class: "studio-compare-empty" }, h("p", null, t("No open changes to compare against Base."))),
			);
		}
		const cards: HTMLElement[] = [];
		for (const report of changedReports) {
			const base = report.base;
			const rows: HTMLElement[] = [];
			if (!base) {
				if (report.subtitle) {
					rows.push(
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, t("Subtitle")),
							h("span", null, t("Not in Base")),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, t("Subtitle")),
							h("strong", null, report.subtitle),
						),
					);
				}
				for (const metric of report.keyMetrics) {
					rows.push(
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, metric.label),
							h("span", null, t("Not in Base")),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, metric.label),
							h("strong", null, `${metric.value}${metric.delta ? ` · ${metric.delta}` : ""}`),
						),
					);
				}
				for (const sec of report.sections) {
					rows.push(
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, sec.heading),
							h("span", null, t("Not in Base")),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, sec.heading),
							h("strong", null, sec.paragraphs.join(" ") || sec.heading),
						),
					);
				}
				if (rows.length === 0) {
					rows.push(
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, t("Article")),
							h("span", null, t("Not in Base")),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, t("Article")),
							h("strong", null, report.headline),
						),
					);
				}
			} else {
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
			}
			cards.push(
				h(
					"section",
					{ class: "studio-section studio-compare-card", "data-compare-file": report.path },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, report.headline),
						!base ? h("span", { class: "studio-changed-pill" }, t("Added")) : null,
					),
					h(
						"div",
						{ class: "studio-compare-grid" },
						h("div", { class: "studio-compare-col-head" }, t("Base")),
						h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
						...rows,
					),
				),
			);
		}
		for (const doc of changedHtml) {
			cards.push(
				h(
					"section",
					{ class: "studio-section studio-compare-card", "data-compare-file": doc.path },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, doc.title),
						doc.baseHtml === undefined ? h("span", { class: "studio-changed-pill" }, t("Added")) : null,
					),
					h(
						"div",
						{ class: "studio-compare-grid" },
						h("div", { class: "studio-compare-col-head" }, t("Base")),
						h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, t("HTML")),
							h(
								"span",
								null,
								doc.baseHtml === undefined ? t("Not in Base") : htmlDocumentTitle(doc.baseHtml, doc.path),
							),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, t("HTML")),
							h("strong", null, doc.title),
						),
					),
				),
			);
		}
		for (const doc of changedPdf) {
			cards.push(
				h(
					"section",
					{ class: "studio-section studio-compare-card", "data-compare-file": doc.path },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, doc.title),
						!doc.baseRef ? h("span", { class: "studio-changed-pill" }, t("Added")) : null,
					),
					h(
						"div",
						{ class: "studio-compare-grid" },
						h("div", { class: "studio-compare-col-head" }, t("Base")),
						h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, t("PDF")),
							h("span", null, doc.baseRef ? formatPdfBytes(doc.baseRef.bytes) : t("Not in Base")),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, t("PDF")),
							h("strong", null, `${doc.title} (${formatPdfBytes(doc.ref.bytes)})`),
						),
					),
				),
			);
		}
		for (const doc of changedMarkdown) {
			cards.push(
				h(
					"section",
					{ class: "studio-section studio-compare-card", "data-compare-file": doc.path },
					h(
						"div",
						{ class: "studio-section-head" },
						h("h2", null, doc.title),
						doc.baseContent === undefined ? h("span", { class: "studio-changed-pill" }, t("Added")) : null,
					),
					h(
						"div",
						{ class: "studio-compare-grid" },
						h("div", { class: "studio-compare-col-head" }, t("Base")),
						h("div", { class: "studio-compare-col-head is-preview" }, t("Preview")),
						h(
							"div",
							{ class: "studio-compare-cell is-base" },
							h("small", null, t("Notes")),
							h("span", null, doc.baseContent === undefined ? t("Not in Base") : doc.baseContent.slice(0, 240)),
						),
						h(
							"div",
							{ class: "studio-compare-cell is-preview" },
							h("small", null, t("Notes")),
							h("strong", null, doc.content.slice(0, 240)),
						),
					),
				),
			);
		}
		return h("div", { class: "report-compare-wrap" }, ...cards);
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		if (postPageClick(target, this.el)) return;
		const { act } = target.dataset;
		if (act === "report-select" && target.dataset.slug) {
			const slug = target.dataset.slug;
			if (slug !== this.#activeSlug) {
				this.#activeSlug = slug;
				this.#lastStoreSlug = slug;
				this.#options.store.selectReport(slug);
				this.update();
			}
			return;
		}
		if (act === "report-jump" && target.dataset.target) {
			const node = this.el.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(target.dataset.target)}"]`);
			node?.scrollIntoView({ behavior: "smooth", block: "start" });
			return;
		}
		if (act === "report-retry-preview") {
			const target = this.#pendingRetryTarget;
			if (target && target.changeIds.length > 0) {
				void this.#options.store.ensureReconciliation(
					this.#options.surface.id,
					target.changeIds,
					target.paths,
					true,
				);
			}
		}
	}
}
