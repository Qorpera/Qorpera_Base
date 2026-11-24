import type { StudioBinaryRef } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import type { StudioBinaryReader } from "../surface-studio-stage.ts";

export interface SurfacePdfCardOptions {
	readonly path: string;
	readonly title: string;
	readonly ref: StudioBinaryRef;
	readonly changed: boolean;
	readonly slug?: string;
}

export function formatPdfBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pdfDownloadName(path: string): string {
	const name = path.split("/").at(-1)?.trim();
	return name && /\.pdf$/i.test(name) ? name : "document.pdf";
}

export class SurfacePdfViewer {
	readonly #read: StudioBinaryReader;
	readonly #signal: AbortSignal;
	readonly #urls = new Map<string, Promise<string>>();

	constructor(read: StudioBinaryReader, signal: AbortSignal) {
		this.#read = read;
		this.#signal = signal;
		signal.addEventListener("abort", () => this.dispose(), { once: true });
	}

	renderCard(options: SurfacePdfCardOptions): HTMLElement {
		const { path, title, ref, changed, slug } = options;
		const sizeText = formatPdfBytes(ref.bytes);
		const openLink = h(
			"a",
			{
				class: "btn btn-small studio-pdf-link",
				target: "_blank",
				rel: "noopener noreferrer",
				"aria-disabled": "true",
			},
			t("Open PDF"),
		);
		const downloadLink = h(
			"a",
			{
				class: "btn btn-small studio-pdf-link",
				download: pdfDownloadName(path),
				"aria-disabled": "true",
			},
			t("Download"),
		);
		const stage = h("div", { class: "studio-pdf-stage" }, h("p", { class: "studio-pdf-state" }, t("Loading PDF…")));
		const card = h(
			"section",
			{
				class: `studio-section studio-pdf-card${changed ? " is-changed" : ""}`,
				"data-file": path,
				...(slug ? { "data-report-slug": slug } : {}),
			},
			h(
				"div",
				{ class: "studio-section-head studio-pdf-head" },
				h("h2", null, title),
				h("code", { class: "studio-file-tag" }, path),
				sizeText ? h("span", { class: "studio-pdf-size" }, sizeText) : null,
				changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
				h("div", { class: "studio-pdf-actions" }, openLink, downloadLink),
			),
			stage,
		);
		this.#url(ref).then(
			(url) => {
				if (this.#signal.aborted) return;
				openLink.setAttribute("href", url);
				openLink.removeAttribute("aria-disabled");
				downloadLink.setAttribute("href", url);
				downloadLink.removeAttribute("aria-disabled");
				stage.replaceChildren(h("iframe", { class: "studio-pdf-frame", src: url, title }));
			},
			() => {
				if (this.#signal.aborted) return;
				stage.replaceChildren(h("p", { class: "studio-pdf-state is-error" }, t("This PDF can't be loaded.")));
			},
		);
		return card;
	}

	#url(ref: StudioBinaryRef): Promise<string> {
		let url = this.#urls.get(ref.fileSha256);
		if (!url) {
			// WHY: Pin the Blob MIME type to application/pdf so an untrusted mediaType can never open as active HTML.
			url = this.#read(ref, this.#signal).then((bytes) => {
				if (this.#signal.aborted) throw this.#signal.reason ?? new Error("Aborted");
				return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
			});
			url.catch(() => this.#urls.delete(ref.fileSha256));
			this.#urls.set(ref.fileSha256, url);
		}
		return url;
	}

	dispose(): void {
		for (const url of this.#urls.values()) {
			url.then(
				(value) => URL.revokeObjectURL(value),
				() => undefined,
			);
		}
		this.#urls.clear();
	}
}
