// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_CONTENT, PAGE_FRAME_URL, PAGE_READY, PageFrames } from "../src/ui/page-frame.ts";

// Read from the package root, where the tests run.
const headers = readFileSync(resolve("public/_headers"), "utf8");
const frameDocument = readFileSync(resolve("public/page-preview/index.html"), "utf8");

/** A rule's lines in public/_headers, as Pages reads them. */
function rule(path: string): string[] {
	const lines = headers.split("\n").map((line) => line.trim());
	const start = lines.indexOf(path);
	expect(start, path).toBeGreaterThanOrEqual(0);
	const end = lines.findIndex((line, index) => index > start && line.startsWith("/"));
	return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line && !line.startsWith("#"));
}
function policy(lines: string[]): string {
	return lines
		.find((line) => line.startsWith("Content-Security-Policy:"))!
		.slice("Content-Security-Policy:".length)
		.trim();
}
function ready(source: Window | null, data: unknown = { type: PAGE_READY }) {
	const event = new MessageEvent("message", { data });
	Object.defineProperty(event, "source", { value: source });
	window.dispatchEvent(event);
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("an HTML page's frame", () => {
	it("runs scripts with no origin, sends no referrer, and loads the frame document", () => {
		const stop = new AbortController();
		const frame = new PageFrames(stop.signal).frame("<p>Hi</p>", "Page: hi.html", "files-page-frame");
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(frame.getAttribute("src")).toBe(PAGE_FRAME_URL);
		expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(frame.title).toBe("Page: hi.html");
		expect(frame.className).toBe("files-page-frame");
		stop.abort();
	});

	it("hands each frame its own page when it is ready, and nothing to anyone else", () => {
		const stop = new AbortController();
		const frames = new PageFrames(stop.signal);
		const one = frames.frame("<p>One</p>", "Page: one.html", "files-page-frame");
		const two = frames.frame("<p>Two</p>", "Page: two.html", "files-page-frame");
		const stranger = document.createElement("iframe");
		document.body.append(one, two, stranger);
		const toOne = vi.spyOn(one.contentWindow!, "postMessage");
		const toTwo = vi.spyOn(two.contentWindow!, "postMessage");
		const toStranger = vi.spyOn(stranger.contentWindow!, "postMessage");
		ready(two.contentWindow);
		expect(toTwo).toHaveBeenCalledExactlyOnceWith({ type: PAGE_CONTENT, html: "<p>Two</p>" }, "*");
		expect(toOne).not.toHaveBeenCalled();
		// Another frame, another kind of message, or no window at all gets nothing.
		ready(stranger.contentWindow);
		ready(one.contentWindow, { type: PAGE_CONTENT, html: "<p>Mine</p>" });
		ready(one.contentWindow, "qorpera-page-ready");
		ready(null);
		expect(toStranger).not.toHaveBeenCalled();
		expect(toOne).not.toHaveBeenCalled();
		// A page that reloads itself asks again, and gets its page again.
		ready(one.contentWindow);
		ready(one.contentWindow);
		expect(toOne).toHaveBeenCalledTimes(2);
		// After the view ends, nothing is answered.
		stop.abort();
		ready(two.contentWindow);
		expect(toTwo).toHaveBeenCalledOnce();
	});

	it("keeps the frame document's policy and the site's rule for it in step, and locked down", () => {
		const frameRule = rule("/page-preview/*");
		// Pages applies /* first: this rule takes its policy and its framing refusal off before setting its own.
		expect(frameRule.slice(0, 2)).toEqual(["! Content-Security-Policy", "! X-Frame-Options"]);
		expect(frameRule).toContain("X-Frame-Options: SAMEORIGIN");
		const header = policy(frameRule);
		const directives = header.split(";").map((part) => part.trim());
		expect(directives[0]).toBe("sandbox allow-scripts");
		expect(directives).toContain("default-src 'none'");
		expect(directives).toContain("frame-ancestors 'self'");
		expect(directives).toContain("form-action 'none'");
		expect(directives).toContain("base-uri 'none'");
		// No origin, no window, no network: nothing names this site, another site or a connection.
		expect(header).not.toMatch(/allow-same-origin|allow-popups|allow-forms|allow-top-navigation|allow-modals/);
		expect(header).not.toMatch(/connect-src|frame-src|child-src|worker-src|https?:|\*/);
		expect(header.replace("frame-ancestors 'self'", "")).not.toContain("'self'");
		// The document carries the same policy itself (a meta tag can't sandbox or limit framing), first in its head.
		const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(frameDocument)?.[1];
		expect(meta).toBe(header.replace("sandbox allow-scripts; ", "").replace("; frame-ancestors 'self'", ""));
		expect(frameDocument.indexOf("Content-Security-Policy")).toBeLessThan(frameDocument.indexOf("<script>"));
		// It shows a page only inside a frame, only the one its own app hands it, in the messages the app speaks.
		expect(frameDocument).toContain("if (window.parent === window) return;");
		expect(frameDocument).toContain("event.source !== app");
		expect(frameDocument).toContain(`data.type !== "${PAGE_CONTENT}"`);
		expect(frameDocument).toContain(`app.postMessage({ type: "${PAGE_READY}" }, "*")`);
		// Every other page of the site keeps refusing to be framed, and the app frames nothing but this site.
		const site = rule("/*");
		expect(site).toContain("X-Frame-Options: DENY");
		expect(policy(site)).toContain("frame-ancestors 'none'");
		expect(policy(site)).toMatch(/^default-src 'self';/);
		expect(policy(site)).not.toMatch(/frame-src|child-src/);
	});
});
