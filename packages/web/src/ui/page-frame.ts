import { h } from "./dom.ts";

/* An HTML page from the Company File (an agent's prototype: one file with its styles and scripts inline), shown live
 * and locked down. Each frame loads public/page-preview/, a fixed document under a policy of its own (its meta tag and
 * public/_headers), and the page is handed to it once it is ready:
 * - the sandbox lets scripts run but gives the frame no origin, so the page reaches none of this app's cookies,
 *   storage or sign-in; it can't open windows or dialogs, send forms, start downloads or move this app's page;
 * - its policy lets inline styles and scripts and data: and blob: pictures and fonts in, and nothing from the network:
 *   no request, connection or other frame;
 * - this app's own policy (default-src 'self', so frame-src 'self') keeps the frame on this site, and every page of
 *   this site but the frame document refuses to be framed (frame-ancestors 'none').
 * The app's policy also governs a srcdoc or blob: frame, whose inline styles and scripts it would block: that is why
 * the frame is a document of its own. */

/** The frame document, beside index.html. */
export const PAGE_FRAME_URL = "./page-preview/";
/** The frame's word that it is ready, and this app's answer carrying the page (public/page-preview/index.html). */
export const PAGE_READY = "qorpera-page-ready";
export const PAGE_CONTENT = "qorpera-page";

function isReady(data: unknown): boolean {
	return typeof data === "object" && data !== null && (data as { type?: unknown }).type === PAGE_READY;
}

/** The pages of one view's frames. Only a frame made here is answered, with its own page, each time it is ready (a
 * page that reloads itself is handed its page again); a frame gone from the page is forgotten. */
export class PageFrames {
	readonly #pages = new Map<HTMLIFrameElement, string>();

	constructor(signal: AbortSignal) {
		window.addEventListener("message", (event) => this.#answer(event), { signal });
		signal.addEventListener("abort", () => this.#pages.clear(), { once: true });
	}

	/** A frame that shows `html` once it is in the page; `title` names it for assistive technology. */
	frame(html: string, title: string, className: string): HTMLIFrameElement {
		const frame = h("iframe", {
			class: className,
			src: PAGE_FRAME_URL,
			sandbox: "allow-scripts",
			referrerpolicy: "no-referrer",
			title,
		});
		this.#pages.set(frame, html);
		return frame;
	}

	#answer(event: MessageEvent): void {
		if (!isReady(event.data) || event.source === null) return;
		for (const [frame, html] of this.#pages) {
			if (!frame.isConnected) this.#pages.delete(frame);
			// The frame has no origin, so its window is the only thing that tells it apart.
			else if (frame.contentWindow === event.source)
				frame.contentWindow.postMessage({ type: PAGE_CONTENT, html }, "*");
		}
	}
}
