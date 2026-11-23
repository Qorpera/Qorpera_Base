import type { StudioPatchOp, SurfaceReportBlock, SurfaceSummary } from "@qorpera/contracts";
import { t } from "../../../ui/preferences.ts";
import type { SurfacesStore } from "../../surfaces-store.ts";
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

export interface SurfaceReportsOptions {
	readonly store: SurfacesStore;
	readonly surface: SurfaceSummary;
	readonly signal: AbortSignal;
	readonly baseFiles: () => Readonly<Record<string, string>>;
	readonly patches?: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly timeSlice?: boolean;
}

export class SurfaceReports {
	readonly #options: SurfaceReportsOptions;
	readonly #views = new Map<string, SurfaceReportView>();

	constructor(options: SurfaceReportsOptions) {
		this.#options = options;
	}

	prepare(block: SurfaceReportBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
		const root = ctx.folderRoot;
		let signature: string;
		let include: (path: string) => boolean;
		if ("match" in block) {
			const glob = block.match;
			signature = `match:${glob}`;
			include = (path) => {
				const relative = folderRelative(root, path);
				return (
					REPORT_FILE_RE.test(path) &&
					surfaceGlobFinds(glob, relative === undefined ? { path } : { path, relative })
				);
			};
		} else {
			const file = ctx.companyPath(block.from);
			signature = `from:${file ?? ""}`;
			include = (path) => path === file;
		}
		const filled = Object.keys(ctx.files).some(include);
		const pieces: StudioSectionTask[] = [];
		if (block.heading) {
			const heading = ctx.words(block.heading);
			pieces.push({ build: () => sectionHead(heading, false) });
		}
		pieces.push({
			build: () => (filled ? this.#view(signature, include) : homeEmpty(t("Reports and posts about the product."))),
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
