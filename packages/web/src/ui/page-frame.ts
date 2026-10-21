/* An HTML page from the Company File (an agent's prototype: one file with its styles and scripts inline), shown live
 * and locked down. Each frame loads public/page-preview/, a fixed document under a policy of its own (its meta tag and
 * public/_headers), and the page is handed to it once it is ready:
 * - the sandbox lets scripts run but gives the frame no origin, so the page reaches none of this app's cookies,
 *   storage or sign-in; it can't open windows or dialogs, send forms, start downloads or move this app's page;
 * - its policy lets inline styles and scripts and data: and blob: pictures and fonts in, and nothing from the network:
 *   no request, connection or frame of another site;
 * - no browser lets a policy stop WebRTC, so the frame document takes its interfaces away before the page runs, and
 *   takes out any frame put into the page before it loads (a frame would be a window of its own, with them);
 *   A frame in a shadow tree counts too: the frame document watches every shadow root the page's scripts make, and
 *   a page is handed over only once it is checked to declare none (framePage);
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

function isHint(link: Element): boolean {
	return (link.getAttribute("rel") ?? "")
		.toLowerCase()
		.split(/[\t\n\f\r ]+/)
		.some((token) => NETWORK_HINTS.has(token));
}

/** What the page may not bring into the frame: a declarative shadow root (the frame document watches only the roots
 * the page's scripts make), a dns-prefetch or preconnect link, and noscript. The frame parses the page with scripting
 * on, this check with it off, and noscript is the only thing that differs between the two (a noscript's content is
 * text there, markup here): with none, the frame's parse is the one checked here. Template contents count, as
 * scripts can bring them in. */
function unfit(page: Document): Element[] {
	const found: Element[] = [];
	const scopes: ParentNode[] = [page];
	for (let index = 0; index < scopes.length; index++)
		for (const element of scopes[index]!.querySelectorAll("noscript, template, link[rel]")) {
			if (element instanceof HTMLTemplateElement) scopes.push(element.content);
			if (
				element.localName === "noscript" ||
				(element.localName === "template" && DECLARATIVE_SHADOW_ROOT.some((name) => element.hasAttribute(name))) ||
				(element.localName === "link" && isHint(element))
			)
				found.push(element);
		}
	return found;
}

/** The page as the frame is handed it, or null when it can't be shown live. A page with nothing unfit is handed over
 * exactly as written. Otherwise it is handed over as this check parsed it, with its noscript and hint links taken
 * out and its declarative shadow roots left as plain templates, but only if that text, parsed again, has nothing
 * unfit either (writing a parsed page out and parsing it again need not give the same page). */
export function framePage(html: string): string | null {
	const parse = (text: string) => new DOMParser().parseFromString(text, "text/html");
	const page = parse(html);
	const found = unfit(page);
	if (found.length === 0) return html;
	for (const element of found)
		if (element.localName === "template") for (const name of DECLARATIVE_SHADOW_ROOT) element.removeAttribute(name);
		else element.remove();
	const handed = `${page.doctype ? new XMLSerializer().serializeToString(page.doctype) : ""}${page.documentElement.outerHTML}`;
	return unfit(parse(handed)).length === 0 ? handed : null;
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

	/** A frame that shows `page` (what framePage handed over) once it is in the page; `title` names it for assistive
	 * technology. The pages of frames
	 * that had theirs and are gone from the page go first, so a view that shows page after page keeps only the pages
	 * still shown (a frame made but not yet put in keeps its own). */
	frame(page: string, title: string, className: string): HTMLIFrameElement {
		for (const done of this.#pages.keys()) if (this.#shown.has(done) && !done.isConnected) this.#pages.delete(done);
		const frame = document.createElement("iframe");
		frame.className = className;
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.setAttribute("src", PAGE_FRAME_URL);
		frame.title = title;
		this.#pages.set(frame, page);
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
