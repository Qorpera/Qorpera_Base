import type { StudioBinaryRef } from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import type { StudioBinaryReader } from "../surface-studio-stage.ts";
import { expandButton, type StudioFullscreen } from "./fullscreen.ts";

export const PDF_PREVIEW_URL = "./pdf-preview/";
export const PDF_PREVIEW_READY = "qorpera-pdf-preview-ready";
export const PDF_PREVIEW_DATA = "qorpera-pdf-preview-data";

export interface SurfacePdfCardOptions {
	readonly path: string;
	readonly title: string;
	readonly ref: StudioBinaryRef;
	readonly changed: boolean;
	readonly slug?: string;
	readonly fullscreen?: StudioFullscreen;
}

interface LoadedPdf {
	readonly bytes: Uint8Array;
	readonly url: string;
}

interface PendingPdfFrame {
	readonly bytes: Uint8Array;
	readonly title: string;
	sentWindow: Window | null;
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
	readonly #lifetime = new AbortController();
	readonly #entries = new Map<string, Promise<LoadedPdf>>();
	readonly #pendingFrames = new Map<HTMLIFrameElement, PendingPdfFrame>();

	constructor(read: StudioBinaryReader, signal: AbortSignal) {
		this.#read = read;
		this.#signal = signal;
		if (signal.aborted) {
			this.dispose();
			return;
		}
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		window.addEventListener(
			"message",
			(event) => {
				const data = event.data as { type?: unknown } | null;
				if (event.origin !== location.origin || data?.type !== PDF_PREVIEW_READY) return;
				for (const [frame, pending] of this.#pendingFrames) {
					if (!frame.isConnected) continue;
					const target = frame.contentWindow;
					if (!target || event.source !== target) continue;
					if (pending.sentWindow === target) return;
					pending.sentWindow = target;
					target.postMessage(
						{ type: PDF_PREVIEW_DATA, bytes: pending.bytes, title: pending.title },
						location.origin,
					);
					return;
				}
			},
			{ signal: this.#lifetime.signal },
		);
	}

	renderCard(options: SurfacePdfCardOptions): HTMLElement {
		const { path, title, ref, changed, slug, fullscreen } = options;
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
		const expand = fullscreen
			? expandButton(title, () =>
					fullscreen.openContent(
						title,
						(onClose) => this.#mountStage(ref, title, "studio-pdf-frame is-fullscreen", onClose),
						"frame",
					),
				)
			: null;
		const stage = this.#mountStage(ref, title, "studio-pdf-frame", undefined, (url) => {
			openLink.setAttribute("href", url);
			openLink.removeAttribute("aria-disabled");
			downloadLink.setAttribute("href", url);
			downloadLink.removeAttribute("aria-disabled");
		});
		return h(
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
				sizeText ? h("span", { class: "studio-pdf-size" }, sizeText) : null,
				changed ? h("span", { class: "studio-changed-pill" }, t("Updated")) : null,
				h("div", { class: "studio-pdf-actions" }, openLink, downloadLink, expand),
			),
			stage,
		);
	}

	#mountStage(
		ref: StudioBinaryRef,
		title: string,
		frameClass: string,
		onClose?: (cleanup: () => void) => void,
		onUrl?: (url: string) => void,
	): HTMLElement {
		const stage = h("div", { class: "studio-pdf-stage" }, h("p", { class: "studio-pdf-state" }, t("Loading PDF…")));
		let closed = false;
		let mountedFrame: HTMLIFrameElement | undefined;
		onClose?.(() => {
			closed = true;
			if (mountedFrame) this.#pendingFrames.delete(mountedFrame);
		});
		this.#load(ref).then(
			({ bytes, url }) => {
				if (closed || this.#signal.aborted || this.#lifetime.signal.aborted) return;
				onUrl?.(url);
				const frame = h("iframe", {
					class: frameClass,
					src: PDF_PREVIEW_URL,
					referrerpolicy: "no-referrer",
					title,
				});
				mountedFrame = frame;
				this.#pendingFrames.set(frame, { bytes, title, sentWindow: null });
				stage.replaceChildren(frame);
			},
			() => {
				if (closed || this.#signal.aborted || this.#lifetime.signal.aborted) return;
				stage.replaceChildren(h("p", { class: "studio-pdf-state is-error" }, t("This PDF can't be loaded.")));
			},
		);
		return stage;
	}

	#load(ref: StudioBinaryRef): Promise<LoadedPdf> {
		let entry = this.#entries.get(ref.fileSha256);
		if (!entry) {
			// WHY: Pin the Blob MIME type to application/pdf so an untrusted mediaType can never open as active HTML.
			entry = this.#read(ref, this.#signal).then((bytes) => {
				if (this.#signal.aborted || this.#lifetime.signal.aborted) {
					throw this.#signal.reason ?? new Error("Aborted");
				}
				const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
				return { bytes, url };
			});
			entry.catch(() => {
				if (this.#entries.get(ref.fileSha256) === entry) this.#entries.delete(ref.fileSha256);
			});
			this.#entries.set(ref.fileSha256, entry);
		}
		return entry;
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#pendingFrames.clear();
		for (const pending of this.#entries.values()) {
			pending.then(
				({ url }) => URL.revokeObjectURL(url),
				() => {},
			);
		}
		this.#entries.clear();
	}
}
