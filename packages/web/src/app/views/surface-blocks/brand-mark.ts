import type { StudioBinaryRef, SurfaceBrandMarkBlock } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import type { StudioBinaryReader } from "../surface-studio-stage.ts";
import { SVG_FILE_RE, svgDataUrl } from "./artifacts.ts";
import { readableName, type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import { expandButton, type StudioFullscreen } from "./fullscreen.ts";

type Picture =
	| { readonly kind: "svg"; readonly src: string }
	| { readonly kind: "binary"; readonly ref: StudioBinaryRef }
	| undefined;

function svgText(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed && /<svg[\s>]/i.test(trimmed) ? trimmed : undefined;
}

function readPicture(
	source: string | undefined,
	ctx: SurfaceBlockContext,
): { readonly picture: Picture; readonly changed: boolean } {
	const path = source ? ctx.companyPath(source) : undefined;
	if (!path) return { picture: undefined, changed: false };
	const text = SVG_FILE_RE.test(path) ? ctx.text(path) : undefined;
	const svg = svgText(text?.value);
	const binary = ctx.binary(path);
	if (svg) return { picture: { kind: "svg", src: svgDataUrl(svg) }, changed: svg !== svgText(text?.base) };
	if (binary.value) {
		return {
			picture: { kind: "binary", ref: binary.value },
			changed: binary.value.fileSha256 !== binary.base?.fileSha256,
		};
	}
	return { picture: undefined, changed: Boolean(svgText(text?.base) || binary.base) };
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

	prepare(block: SurfaceBrandMarkBlock, ctx: SurfaceBlockContext, fullscreen: StudioFullscreen): SurfaceBlockPrepared {
		const light = readPicture(block.from, ctx);
		const dark = readPicture(block.dark, ctx);
		const pictureFor = (ground: SurfaceBrandMarkBlock["grounds"][number]): Picture =>
			ground === "dark" ? (dark.picture ?? light.picture) : light.picture;
		const hasAny = block.grounds.some((ground) => pictureFor(ground) !== undefined);
		const changed =
			(block.grounds.includes("light") && light.changed) ||
			(block.grounds.includes("dark") && (dark.changed || (!dark.picture && light.changed)));
		const heading = block.heading ? ctx.words(block.heading) : "";
		const name = heading || readableName(block.from);
		const renderGrounds = (className: string) => {
			const grounds = h(
				"div",
				{ class: `${className}${hasAny ? "" : " is-empty"}` },
				block.grounds.map((ground) => {
					const pic = pictureFor(ground);
					return h(
						"div",
						{ class: `studio-mark-ground is-${ground}`, "data-ground": ground },
						pic ? this.#image(pic, name) : null,
					);
				}),
			);
			grounds.style.setProperty("--studio-mark-grounds", String(block.grounds.length));
			return grounds;
		};
		return {
			filled: hasAny,
			pieces: [
				{
					build: () => {
						const expand = hasAny
							? expandButton(name, () =>
									fullscreen.openContent(
										name,
										() => renderGrounds("studio-mark-grounds is-fullscreen"),
										"mark",
									),
								)
							: null;
						return h(
							"section",
							{ class: `studio-section studio-mark${changed ? " is-changed" : ""}`, "data-block": "brand_mark" },
							heading
								? sectionHead(heading, changed, expand)
								: expand
									? h("div", { class: "studio-section-head is-actions-only" }, expand)
									: null,
							renderGrounds("studio-mark-grounds"),
						);
					},
				},
			],
		};
	}

	binaryImage(ref: StudioBinaryRef, alt: string, className: string): HTMLElement {
		const img = h("img", { class: className, alt });
		this.#url(ref).then(
			(url) => {
				if (!this.#signal.aborted) img.setAttribute("src", url);
			},
			() => undefined,
		);
		return img;
	}

	#image(picture: NonNullable<Picture>, name: string): HTMLElement {
		if (picture.kind === "svg") return h("img", { class: "studio-mark-img", src: picture.src, alt: name });
		return this.binaryImage(picture.ref, name, "studio-mark-img");
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
