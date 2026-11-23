import type { SurfaceStage3dBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { type Studio3DConfig, Studio3DViewer } from "../surface-studio-3d.ts";
import { joinStudioPath, parseStudioObject, pickStudioModel, type StudioModelSource } from "../surface-studio-model.ts";
import { type StudioBinaryReader, StudioModelStage } from "../surface-studio-stage.ts";
import type { ColorToken } from "./colours.ts";
import {
	formatScalar,
	isPlainRecord,
	type SurfaceBlockContext,
	type SurfaceBlockPrepared,
	sameValue,
	sourceFile,
} from "./context.ts";

export interface LegacyStudioModel {
	readonly value: unknown;
	readonly base: unknown;
}

export interface StageTint {
	readonly colours: readonly ColorToken[];
	readonly selected: number;
}

const GLB_FILE = /\.glb$/i;

export function legacyModelConfig(
	model: LegacyStudioModel,
	title: string,
	colours: readonly ColorToken[],
): Studio3DConfig | undefined {
	const value = model.value;
	if (!isPlainRecord(value)) return undefined;
	return {
		kind: value.kind === "headband" ? "headband" : "device",
		title,
		dimensions: typeof value.dimensions === "string" ? value.dimensions : "",
		colorways: colours.length
			? colours.map((colour) => ({ name: colour.label, hex: colour.value }))
			: [{ name: "Sandstone", hex: "#e6dfd3" }],
		layers: Array.isArray(value.layers) ? value.layers.map(formatScalar) : [],
		changed: !sameValue(model.base, value),
	};
}

function stageModel(block: SurfaceStage3dBlock, ctx: SurfaceBlockContext): StudioModelSource | undefined {
	const read = ctx.read(block.model);
	if (read.found && isPlainRecord(read.value)) {
		const object = parseStudioObject(JSON.stringify(read.value));
		const file = sourceFile(block.model);
		const objectPath = file ? ctx.companyPath(file) : undefined;
		const folder = objectPath ? objectPath.slice(0, Math.max(0, objectPath.lastIndexOf("/"))) : ctx.folderRoot;
		if (object?.model && GLB_FILE.test(object.model)) {
			const path = joinStudioPath(folder, object.model);
			const ref = path ? ctx.binaries[path] : undefined;
			if (path && ref) return { path, ref, object };
		}
	}
	return pickStudioModel(ctx.files, ctx.binaries, ctx.folderRoot);
}

export class SurfaceStages {
	readonly #read: StudioBinaryReader;
	readonly #signal: AbortSignal;
	readonly #stages = new Map<string, StudioModelStage>();
	readonly #viewers = new Map<string, Studio3DViewer>();
	readonly #lifetimes = new Map<string, AbortController>();

	constructor(read: StudioBinaryReader, signal: AbortSignal) {
		this.#read = read;
		this.#signal = signal;
	}

	prepare(
		key: string,
		block: SurfaceStage3dBlock,
		ctx: SurfaceBlockContext,
		legacy: LegacyStudioModel | undefined,
		tint: StageTint | undefined,
	): SurfaceBlockPrepared {
		const model = stageModel(block, ctx);
		const config = model || !legacy ? undefined : legacyModelConfig(legacy, ctx.surface.title, tint?.colours ?? []);
		const filled = Boolean(model || config);
		const ownTint = tint ? undefined : ctx.read(block.tint);
		const tintValue = tint
			? tint.colours[tint.selected]?.value
			: ownTint?.found && typeof ownTint.value === "string"
				? ownTint.value
				: undefined;
		return {
			filled,
			hero: "stage",
			pieces: [
				{
					build: () => {
						let shown: HTMLElement;
						if (model) {
							let stage = this.#stages.get(key);
							if (!stage) {
								stage = new StudioModelStage(this.#read, this.#lifetime(key));
								this.#stages.set(key, stage);
							}
							stage.update(model);
							stage.setColorway(tintValue);
							shown = stage.el;
						} else if (config) {
							let viewer = this.#viewers.get(key);
							if (!viewer) {
								viewer = new Studio3DViewer(config, this.#lifetime(key));
								this.#viewers.set(key, viewer);
							} else {
								viewer.update(config);
							}
							viewer.setColorway(tint?.selected ?? 0);
							shown = viewer.el;
						} else {
							shown = h("div", { class: "studio-stage-floor", "aria-hidden": "true" });
						}
						return h("div", { class: filled ? "studio-stage" : "studio-stage is-empty" }, shown);
					},
				},
			],
		};
	}

	keep(keys: ReadonlySet<string>): void {
		for (const [key, lifetime] of this.#lifetimes) {
			if (keys.has(key)) continue;
			lifetime.abort();
			this.#lifetimes.delete(key);
			this.#stages.delete(key);
			this.#viewers.delete(key);
		}
	}

	#lifetime(key: string): AbortSignal {
		let lifetime = this.#lifetimes.get(key);
		if (!lifetime) {
			lifetime = new AbortController();
			this.#lifetimes.set(key, lifetime);
			const end = lifetime;
			this.#signal.addEventListener("abort", () => end.abort(), { once: true, signal: end.signal });
		}
		return lifetime.signal;
	}

	setColorway(key: string, index: number, value: string | undefined): void {
		this.#stages.get(key)?.setColorway(value);
		this.#viewers.get(key)?.setColorway(index);
	}
}
