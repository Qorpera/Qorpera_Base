import type { StudioBinaryRef, SurfaceBrandMarkBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import type { StudioBinaryReader } from "../surface-studio-stage.ts";
import { readableName, type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import { SVG_FILE_RE, svgDataUrl } from "./files.ts";

type Picture =
	| { readonly kind: "svg"; readonly src: string }
	| { readonly kind: "binary"; readonly ref: StudioBinaryRef }
	| undefined;

function svgText(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed && /<svg[\s>]/i.test(trimmed) ? trimmed : undefined;
}

export class SurfacePictures {
	readonly #read: StudioBinaryReader;
	readonly #signal: AbortSignal;
	readonly #urls = new Map<string, Promise<string>>();

	constructor(read: StudioBinaryReader, signal: AbortSignal) {
		this.#read = read;
		this.#signal = signal;
		signal.addEventListener("abort", () => this.#revoke(), { once: true });
	}

	prepare(block: SurfaceBrandMarkBlock, ctx: SurfaceBlockContext): SurfaceBlockPrepared {
		const path = ctx.companyPath(block.from);
		let picture: Picture;
		let changed = false;
		if (path) {
			const text = SVG_FILE_RE.test(path) ? ctx.text(path) : undefined;
			const svg = svgText(text?.value);
			const binary = ctx.binary(path);
			if (svg) {
				picture = { kind: "svg", src: svgDataUrl(svg) };
				changed = svg !== svgText(text?.base);
			} else if (binary.value) {
				picture = { kind: "binary", ref: binary.value };
				changed = binary.value.fileSha256 !== binary.base?.fileSha256;
			} else {
				changed = Boolean(svgText(text?.base) || binary.base);
			}
		}
		const heading = block.heading ? ctx.words(block.heading) : "";
		const name = heading || readableName(block.from);
		return {
			filled: picture !== undefined,
			pieces: [
				{
					build: () => {
						const grounds = h(
							"div",
							{ class: `studio-mark-grounds${picture ? "" : " is-empty"}` },
							block.grounds.map((ground) =>
								h(
									"div",
									{ class: `studio-mark-ground is-${ground}`, "data-ground": ground },
									picture ? this.#image(picture, name) : null,
								),
							),
						);
						grounds.style.setProperty("--studio-mark-grounds", String(block.grounds.length));
						return h(
							"section",
							{ class: `studio-section studio-mark${changed ? " is-changed" : ""}`, "data-block": "brand_mark" },
							heading ? sectionHead(heading, changed) : null,
							grounds,
						);
					},
				},
			],
		};
	}

	#image(picture: NonNullable<Picture>, name: string): HTMLElement {
		if (picture.kind === "svg") return h("img", { class: "studio-mark-img", src: picture.src, alt: name });
		const img = h("img", { class: "studio-mark-img", alt: name });
		this.#url(picture.ref).then(
			(url) => {
				if (!this.#signal.aborted) img.setAttribute("src", url);
			},
			() => undefined,
		);
		return img;
	}

	#url(ref: StudioBinaryRef): Promise<string> {
		let url = this.#urls.get(ref.fileSha256);
		if (!url) {
			url = this.#read(ref, this.#signal).then((bytes) =>
				URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: ref.mediaType })),
			);
			url.catch(() => this.#urls.delete(ref.fileSha256));
			this.#urls.set(ref.fileSha256, url);
		}
		return url;
	}

	#revoke(): void {
		for (const url of this.#urls.values())
			url.then(
				(value) => URL.revokeObjectURL(value),
				() => undefined,
			);
		this.#urls.clear();
	}
}
