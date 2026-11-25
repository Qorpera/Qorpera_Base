import type { StudioPatchOp, SurfaceReportBlock, SurfaceSummary } from "@qorpera/contracts";
import { t } from "../../../ui/preferences.ts";
import { isStandaloneHtmlDeliverablePath, type SurfacesStore } from "../../surfaces-store.ts";
import { SurfaceReportView } from "../surface-report-view.ts";
import {
	folderRelative,
	homeEmpty,
	type StudioSectionTask,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sectionHead,
	surfaceGlobFinds,
} from "./context.ts";

const REPORT_FILE_RE = /\.report\.json$/i;
const PDF_POST_RE = /\.pdf$/i;

function isPost(path: string, folderRoot: string): boolean {
	return REPORT_FILE_RE.test(path) || PDF_POST_RE.test(path) || isStandaloneHtmlDeliverablePath(path, folderRoot);
}

export interface SurfaceReportsOptions {
	readonly store: SurfacesStore;
	readonly surface: SurfaceSummary;
	readonly signal: AbortSignal;
	readonly baseFiles: () => Readonly<Record<string, string>>;
	readonly patches?: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly timeSlice?: boolean;
}

export function reportFiles(
	block: SurfaceReportBlock,
	ctx: SurfaceBlockContext,
	apart: readonly string[] = [],
): { readonly signature: string; readonly include: (path: string) => boolean } {
	const own = postFiles(block, ctx);
	if (!apart.length) return own;
	return {
		signature: `${own.signature}|apart:${apart.join(",")}`,
		include: (path) => own.include(path) && !apart.some((folder) => path.startsWith(`${folder}/`)),
	};
}

function postFiles(
	block: SurfaceReportBlock,
	ctx: SurfaceBlockContext,
): { readonly signature: string; readonly include: (path: string) => boolean } {
	if ("match" in block) {
		const glob = block.match;
		const root = ctx.folderRoot;
		return {
			signature: `match:${glob}`,
			include: (path) => {
				const relative = folderRelative(root, path);
				return isPost(path, root) && surfaceGlobFinds(glob, relative === undefined ? { path } : { path, relative });
			},
		};
	}
	const file = ctx.companyPath(block.from);
	return { signature: `from:${file ?? ""}`, include: (path) => path === file };
}

export class SurfaceReports {
	readonly #options: SurfaceReportsOptions;
	readonly #views = new Map<string, SurfaceReportView>();

	constructor(options: SurfaceReportsOptions) {
		this.#options = options;
	}

	prepare(
		block: SurfaceReportBlock,
		ctx: SurfaceBlockContext,
		apart: readonly string[],
		alone = true,
	): SurfaceBlockPrepared {
		const { signature, include } = reportFiles(block, ctx, apart);
		const filled = Object.keys(ctx.files).some(include) || Object.keys(ctx.binaries).some(include);
		if (!filled && !alone) return { filled: false, pieces: [] };
		const pieces: StudioSectionTask[] = [];
		if (block.heading) {
			const heading = ctx.words(block.heading);
			pieces.push({ build: () => sectionHead(heading, false) });
		}
		pieces.push({
			build: () => (filled ? this.#view(signature, include) : homeEmpty(t("Reports and posts live here."))),
		});
		return { filled, pieces };
	}

	#view(signature: string, include: (path: string) => boolean): HTMLElement {
		const options = this.#options;
		let view = this.#views.get(signature);
		if (!view) {
			view = new SurfaceReportView({
				store: options.store,
				surface: options.surface,
				signal: options.signal,
				baseFiles: options.baseFiles(),
				patches: options.patches,
				embedded: true,
				include,
				...(options.timeSlice !== undefined ? { timeSlice: options.timeSlice } : {}),
			});
			this.#views.set(signature, view);
		} else {
			view.setBaseFiles(options.baseFiles());
		}
		view.update();
		return view.el;
	}

	deactivate(): void {
		for (const view of this.#views.values()) view.deactivate();
	}

	dispose(): void {
		for (const view of this.#views.values()) view.dispose();
		this.#views.clear();
	}
}
