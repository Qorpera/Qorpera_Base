import { SURFACE_MODULE_MAX_HEIGHT, SURFACE_MODULE_MIN_HEIGHT, type SurfaceModuleBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import type { StudioHtmlPages } from "./artifacts.ts";
import {
	isPlainRecord,
	readableName,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sectionHead,
} from "./context.ts";
import { expandButton, type StudioFullscreen } from "./fullscreen.ts";

export const MODULE_HEIGHT_MESSAGE = "qorpera-module-height";
const MODULE_INDEX = "index.html";
const FIT_SCRIPT = `<script>(()=>{const root=document.documentElement;const loose=(element)=>{if(!element)return;element.style.setProperty("height","auto","important");element.style.setProperty("min-height","0","important");};const post=()=>{loose(root);loose(document.body);parent.postMessage({type:"${MODULE_HEIGHT_MESSAGE}",height:Math.ceil(root.getBoundingClientRect().height)},"*");};loose(root);loose(document.body);new ResizeObserver(post).observe(root);addEventListener("load",post);})();</script>`;

export interface SurfaceModulePlace {
	readonly alone: boolean;
}

export function moduleFolder(block: SurfaceModuleBlock, ctx: SurfaceBlockContext): string | undefined {
	return ctx.companyPath(block.from);
}

function under<T>(files: Readonly<Record<string, T>>, prefix: string): Record<string, T> {
	return Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(prefix)));
}

function textsChanged(next: Readonly<Record<string, string>>, base: Readonly<Record<string, string>>): boolean {
	const paths = new Set([...Object.keys(next), ...Object.keys(base)]);
	return [...paths].some((path) => next[path] !== base[path]);
}

function binariesChanged(next: SurfaceBlockContext["binaries"], base: SurfaceBlockContext["baseBinaries"]): boolean {
	const paths = new Set([...Object.keys(next), ...Object.keys(base)]);
	return [...paths].some((path) => next[path]?.fileSha256 !== base[path]?.fileSha256);
}

function fittedHeight(height: number): number {
	return Math.min(SURFACE_MODULE_MAX_HEIGHT, Math.max(SURFACE_MODULE_MIN_HEIGHT, Math.ceil(height)));
}

export function prepareModule(
	block: SurfaceModuleBlock,
	ctx: SurfaceBlockContext,
	pages: StudioHtmlPages,
	fullscreen: StudioFullscreen,
	place: SurfaceModulePlace,
): SurfaceBlockPrepared {
	const folder = moduleFolder(block, ctx);
	const prefix = folder ? `${folder}/` : undefined;
	const files = prefix ? under(ctx.files, prefix) : {};
	const indexPath = `${folder}/${MODULE_INDEX}`;
	const html = files[indexPath];
	const filled = html !== undefined && html.trim() !== "";
	const changed =
		prefix !== undefined &&
		(textsChanged(files, under(ctx.baseFiles, prefix)) ||
			binariesChanged(under(ctx.binaries, prefix), under(ctx.baseBinaries, prefix)));
	const heading = block.heading ? ctx.words(block.heading) : "";
	const title = heading || readableName(block.from);
	const fits = !place.alone && block.height === "auto";
	const fixed = typeof block.height === "number" ? block.height : undefined;
	return {
		filled,
		pieces: [
			{
				heavy: filled,
				build: () => {
					let frame: HTMLElement;
					if (filled) {
						frame = pages.frame({
							html: fits ? `${html}${FIT_SCRIPT}` : html,
							path: indexPath,
							title,
							files,
							className: fits ? "studio-module-frame is-fitted" : "studio-module-frame",
							...(fits
								? {
										listen: (data: unknown) => {
											if (!isPlainRecord(data) || data.type !== MODULE_HEIGHT_MESSAGE) return;
											if (typeof data.height !== "number" || !Number.isFinite(data.height)) return;
											frame.style.setProperty("--studio-module-fit", `${fittedHeight(data.height)}px`);
										},
									}
								: {}),
						});
					} else {
						frame = h("div", { class: "studio-module-frame is-empty", "aria-hidden": "true" });
					}
					if (fixed !== undefined) frame.style.setProperty(place.alone ? "min-height" : "height", `${fixed}px`);
					const expand = filled
						? expandButton(title, () =>
								fullscreen.openContent(
									title,
									(onClose) =>
										pages.frame({
											html,
											path: indexPath,
											title,
											files,
											className: "studio-module-frame is-fullscreen",
											owned: onClose,
										}),
									"frame",
								),
							)
						: null;
					return h(
						"section",
						{
							class: `studio-section studio-module${place.alone ? " is-alone" : ""}${changed ? " is-changed" : ""}`,
							"data-block": "module",
							"data-module": block.from,
						},
						heading
							? sectionHead(heading, changed, expand)
							: expand
								? h("div", { class: "studio-section-head is-actions-only" }, expand)
								: null,
						frame,
					);
				},
			},
		],
	};
}
