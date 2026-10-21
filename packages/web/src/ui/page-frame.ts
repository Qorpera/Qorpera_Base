/* An HTML page from the Company File (an agent's prototype: one file with its styles and scripts inline), shown live
 * and locked down. Each frame loads public/page-preview/, a fixed document under a policy of its own (its meta tag and
 * public/_headers), and the page is handed to it once it is ready:
 * - the sandbox lets scripts run but gives the frame no origin, so the page reaches none of this app's cookies,
 *   storage or sign-in; it can't open windows or dialogs, send forms, start downloads or move this app's page;
 * - its policy lets inline styles and scripts and data: and blob: pictures and fonts in, and nothing from the network:
 *   no request, connection or frame of another site;
 * - no browser lets a policy stop WebRTC, so the frame document takes its interfaces away before the page runs, and
 *   takes out any frame put into the page before it loads (a frame would be a window of its own, with them);
 *   A frame in a shadow tree counts too: the frame document watches every shadow root the page makes, and the
 *   page's own declarative shadow roots are taken out before it is handed over (framePage);
 * - link hints that make the browser look up a name or open a connection (dns-prefetch, preconnect) obey no policy
 *   either: the page's own are taken out before it is handed over (framePage). A hint the page's script adds while
 *   it runs still reaches the network: nothing in a page can stop the browser acting on it. What it can carry out is
 *   what the frame holds: the page itself and what the member types into it, nothing of the app;
 * - this app's own policy (default-src 'self', so frame-src 'self') keeps the frame on this site, and every page of
 *   this site but the frame document refuses to be framed (frame-ancestors 'none').
 * The app's policy also governs a srcdoc or blob: frame, whose inline styles and scripts it would block: that is why
 * the frame is a document of its own. Proven in Chromium with the site's headers by scripts/test-web-page-frame-browser.mjs. */

/** The frame document, beside index.html. */
export const PAGE_FRAME_URL = "./page-preview/";
/** The frame's word that it is ready, and this app's answer carrying the page (public/page-preview/index.html). */
export const PAGE_READY = "qorpera-page-ready";
export const PAGE_CONTENT = "qorpera-page";
/** Link hints the browser acts on without asking the page's policy. */
const NETWORK_HINTS = new Set(["dns-prefetch", "preconnect"]);

function isReady(data: unknown): boolean {
	return typeof data === "object" && data !== null && (data as { type?: unknown }).type === PAGE_READY;
}

/** Template attributes that make the parser attach a shadow root (the second is the older spelling). */
const DECLARATIVE_SHADOW_ROOT = ["shadowrootmode", "shadowroot"];

/** The page as the frame is handed it: without its dns-prefetch and preconnect links, and with its declarative shadow
 * roots left as plain templates (in templates too), so no shadow tree is made that the frame document doesn't watch.
 * A page with none of them is handed over exactly as written; one with some, as the browser parsed it, without them. */
export function framePage(html: string): string {
	const page = new DOMParser().parseFromString(html, "text/html");
	let changed = false;
	const scopes: ParentNode[] = [page];
	for (let index = 0; index < scopes.length; index++) {
		const scope = scopes[index]!;
		// Only an HTML template has contents and makes shadow roots (an SVG element may be named template too).
		for (const template of scope.querySelectorAll("template")) {
			if (!(template instanceof HTMLTemplateElement)) continue;
			scopes.push(template.content);
			for (const name of DECLARATIVE_SHADOW_ROOT)
				if (template.hasAttribute(name)) {
					template.removeAttribute(name);
					changed = true;
				}
		}
		for (const link of scope.querySelectorAll("link[rel]"))
			if (
				(link.getAttribute("rel") ?? "")
					.toLowerCase()
					.split(/[\t\n\f\r ]+/)
					.some((token) => NETWORK_HINTS.has(token))
			) {
				link.remove();
				changed = true;
			}
	}
	if (!changed) return html;
	return `${page.doctype ? new XMLSerializer().serializeToString(page.doctype) : ""}${page.documentElement.outerHTML}`;
}

/** The pages of one view's frames. Only a frame made here is answered, with its own page, each time it is ready (a
 * page that reloads itself is handed its page again); a frame gone from the page is forgotten. */
export class PageFrames {
	readonly #pages = new Map<HTMLIFrameElement, string>();
	/** Frames that have had their page: once out of the page, they are done. */
	readonly #shown = new WeakSet<HTMLIFrameElement>();

	constructor(signal: AbortSignal) {
		window.addEventListener("message", (event) => this.#answer(event), { signal });
		signal.addEventListener("abort", () => this.#pages.clear(), { once: true });
	}

	/** A frame that shows `html` once it is in the page; `title` names it for assistive technology. The pages of frames
	 * that had theirs and are gone from the page go first, so a view that shows page after page keeps only the pages
	 * still shown (a frame made but not yet put in keeps its own). */
	frame(html: string, title: string, className: string): HTMLIFrameElement {
		for (const done of this.#pages.keys()) if (this.#shown.has(done) && !done.isConnected) this.#pages.delete(done);
		const frame = document.createElement("iframe");
		frame.className = className;
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.setAttribute("src", PAGE_FRAME_URL);
		frame.title = title;
		this.#pages.set(frame, framePage(html));
		return frame;
	}

	#answer(event: MessageEvent): void {
		if (!isReady(event.data) || event.source === null) return;
		for (const [frame, html] of this.#pages) {
			if (!frame.isConnected) this.#pages.delete(frame);
			// The frame has no origin, so its window is the only thing that tells it apart.
			else if (frame.contentWindow === event.source) {
				frame.contentWindow.postMessage({ type: PAGE_CONTENT, html }, "*");
				this.#shown.add(frame);
			}
		}
	}
}
