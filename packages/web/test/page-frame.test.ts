// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { framePage, PAGE_CONTENT, PAGE_ESCAPE, PAGE_FRAME_URL, PAGE_READY, PageFrames } from "../src/ui/page-frame.ts";

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
		// A frame made before another is put in keeps its page; one that had its page and left is forgotten.
		const three = frames.frame("<p>Three</p>", "Page: three.html", "files-page-frame");
		const four = frames.frame("<p>Four</p>", "Page: four.html", "files-page-frame");
		document.body.append(three, four);
		const toThree = vi.spyOn(three.contentWindow!, "postMessage");
		ready(three.contentWindow);
		expect(toThree).toHaveBeenCalledExactlyOnceWith({ type: PAGE_CONTENT, html: "<p>Three</p>" }, "*");
		// After the view ends, nothing is answered.
		stop.abort();
		ready(two.contentWindow);
		expect(toTwo).toHaveBeenCalledOnce();
	});

	it("hands a page over without the link hints the browser would act on whatever the policy says", () => {
		// A page without them goes exactly as written.
		const plain = '<!doctype html><title>Plan</title><link rel="stylesheet" href="data:text/css,p{}"><p>Hi';
		expect(framePage(plain)).toBe(plain);
		const page = `<!DOCTYPE html><html lang="da"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="DNS-Prefetch" href="//cdn.example">
<link rel="stylesheet preconnect" href="https://x.example"><link rel="icon" href="data:,"></head>
<body><p>Sales</p><script>const a = "<link rel=preconnect>";</script></body></html>`;
		const handed = framePage(page)!;
		expect(handed).not.toMatch(/fonts\.googleapis|cdn\.example|x\.example/);
		expect(handed.startsWith('<!DOCTYPE html><html lang="da">')).toBe(true);
		expect(handed).toContain('<link rel="icon" href="data:,">');
		expect(handed).toContain('<p>Sales</p><script>const a = "<link rel=preconnect>";</script>');
		// A frame is handed the page it was made with.
		const stop = new AbortController();
		const frame = new PageFrames(stop.signal).frame(handed, "Page: sales.html", "files-page-frame");
		document.body.append(frame);
		const send = vi.spyOn(frame.contentWindow!, "postMessage");
		ready(frame.contentWindow);
		expect(send).toHaveBeenCalledExactlyOnceWith({ type: PAGE_CONTENT, html: handed }, "*");
		stop.abort();
	});

	it("hands a page over with its declarative shadow roots left as plain templates, in templates too", () => {
		const page = `<!doctype html><body><div><template shadowrootmode="closed"><p>In</p></template></div>
<template id="outer"><section><template SHADOWROOTMODE="open" shadowrootdelegatesfocus><b>Deep</b></template></section></template>
<template shadowroot="open"><i>Old</i></template><template id="plain"><u>Plain</u></template></body>`;
		const handed = framePage(page)!;
		expect(handed).not.toMatch(/shadowroot(mode)?=/i);
		expect(handed).toContain("<div><template><p>In</p></template></div>");
		expect(handed).toContain(
			'<template id="outer"><section><template shadowrootdelegatesfocus=""><b>Deep</b></template></section></template>',
		);
		expect(handed).toContain('<template id="plain"><u>Plain</u></template>');
		// An SVG element named template has no contents to look into; its attribute goes all the same.
		const drawing = framePage('<!doctype html><svg><template shadowrootmode="open"/></svg><p>Chart</p>')!;
		expect(drawing).not.toMatch(/shadowroot/i);
		expect(drawing).toContain("<p>Chart</p>");
	});

	it("hands a page over without noscript, whose content the frame would parse differently", () => {
		// The frame parses with scripting on (noscript's content is text), this check with it off (markup): a comment
		// opened inside noscript hides a declarative root from the check that the frame would make.
		const hidden = `<!doctype html><body><p>Before</p><noscript><!--</noscript><div><template shadowrootmode="open"><iframe srcdoc="x"></iframe></template></div>--></noscript><p>After</p></body>`;
		const handed = framePage(hidden)!;
		expect(handed).not.toMatch(/noscript|shadowroot/i);
		expect(handed).toContain("<p>Before</p>");
		const plain = framePage("<!doctype html><noscript><p>Turn scripts on</p></noscript><p>Hi</p>")!;
		expect(plain).not.toContain("noscript");
		expect(plain).toContain("<p>Hi</p>");
		// Inside a template too.
		expect(framePage("<template><noscript><b>x</b></noscript></template><p>y</p>")).not.toContain("noscript");
	});

	it("shows nothing live when the page, written out and parsed again, would still bring something unfit", () => {
		const parse = DOMParser.prototype.parseFromString;
		let parses = 0;
		vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(function (this: DOMParser, text, type) {
			parses++;
			return Reflect.apply(parse, this, [parses === 2 ? "<noscript></noscript>" : text, type]) as Document;
		});
		expect(framePage('<!doctype html><link rel="preconnect" href="https://x.example"><p>Hi</p>')).toBeNull();
		expect(parses).toBe(2);
	});

	it("hears Escape pressed in its own frames' pages as Escape pressed on the frame, and nothing else", () => {
		const stop = new AbortController();
		const frames = new PageFrames(stop.signal);
		const one = frames.frame("<p>One</p>", "Page: one.html", "files-page-frame");
		const stranger = document.createElement("iframe");
		document.body.append(one, stranger);
		const keys: string[] = [];
		document.body.addEventListener("keydown", (event) => {
			keys.push(`${(event.target as HTMLElement).className || "stranger"} ${event.key} ${event.cancelable}`);
		});
		ready(stranger.contentWindow, { type: PAGE_ESCAPE });
		ready(null, { type: PAGE_ESCAPE });
		ready(one.contentWindow, PAGE_ESCAPE);
		expect(keys).toEqual([]);
		ready(one.contentWindow, { type: PAGE_ESCAPE });
		expect(keys).toEqual(["files-page-frame Escape true"]);
		// The frame's page is not handed over again for it.
		const toOne = vi.spyOn(one.contentWindow!, "postMessage");
		ready(one.contentWindow, { type: PAGE_ESCAPE });
		expect(toOne).not.toHaveBeenCalled();
		// A view that ended hears nothing.
		stop.abort();
		ready(one.contentWindow, { type: PAGE_ESCAPE });
		expect(keys).toHaveLength(2);
	});

	it("passes Escape on from the page once it is written, unless the page took it or an IME is composing", () => {
		const script = frameDocument.slice(frameDocument.indexOf("<script>"), frameDocument.indexOf("</script>"));
		// Taken before the page runs, so the page can't change them.
		for (const taken of [
			"const listen = EventTarget.prototype.addEventListener;",
			'const keyOf = getter(KeyboardEvent.prototype, "key");',
			'const composing = getter(KeyboardEvent.prototype, "isComposing");',
			'const prevented = getter(Event.prototype, "defaultPrevented");',
			"const later = setTimeout;",
		]) {
			expect(script, taken).toContain(taken);
			expect(script.indexOf(taken), taken).toBeLessThan(script.indexOf('addEventListener("message"'));
		}
		// Listened for after the page is written: opening the document drops the window's listeners.
		const listened = script.indexOf('apply(listen, window, [\n\t\t\t"keydown",');
		expect(listened).toBeGreaterThan(script.indexOf("apply(close, document, []);"));
		expect(script.slice(listened)).toContain(
			'if (apply(keyOf, pressed, []) !== "Escape" || apply(composing, pressed, [])) return;',
		);
		// Asked only once every handler of the page has had the key, also one the page adds after the frame's.
		const after = script.indexOf("apply(later, window, [", listened);
		expect(after).toBeGreaterThan(listened);
		expect(script.slice(after)).toContain(
			`if (!apply(prevented, pressed, [])) app.postMessage({ type: "${PAGE_ESCAPE}" }, "*");`,
		);
	});

	it("follows no link itself: a click on one is stopped, and only the member's own goes to the app, over the port", () => {
		const script = frameDocument.slice(frameDocument.indexOf("<script>"), frameDocument.indexOf("</script>"));
		// Taken, and put in place, before the page runs, so the page can't change them.
		for (const taken of [
			"const prevent = Event.prototype.preventDefault;",
			"const composedPath = Event.prototype.composedPath;",
			"const stop = Event.prototype.stopPropagation;",
			"const stopNow = Event.prototype.stopImmediatePropagation;",
			'const bubble = Object.getOwnPropertyDescriptor(Event.prototype, "cancelBubble");',
			"const unlisten = EventTarget.prototype.removeEventListener;",
			"const soon = queueMicrotask;",
			"const attribute = Element.prototype.getAttribute;",
			"const codeAt = String.prototype.charCodeAt;",
			"const clicked = new WeakMap();",
			"const settled = new WeakSet();",
			'const links = "a[*|href], area[href]";',
			"Event.prototype.stopPropagation = function stopPropagation() {",
			"Event.prototype.stopImmediatePropagation = function stopImmediatePropagation() {",
			'Object.defineProperty(Event.prototype, "cancelBubble", {',
		]) {
			expect(script, taken).toContain(taken);
			expect(script.indexOf(taken), taken).toBeLessThan(script.indexOf('addEventListener("message"'));
		}
		// Only for a page handed a port: without one, nothing is noted, so nothing is stopped or sent.
		expect(script).toContain("const noteLink = (click) => {\n\t\tif (!follow) return;");
		expect(script).toContain('if (live) {\n\t\t\tdefine(window, "qorpera", live.page);');
		// The link is noted on the click's way down, before any handler of the page: at the window, listened for once
		// the document is opened (which drops the window's listeners) and before the page is written, and at each
		// shadow tree's root. It is the innermost link on the click's whole path, a slot's surroundings included.
		const heard = script.indexOf('apply(listen, window, ["click", hear, true]);');
		expect(heard).toBeGreaterThan(script.indexOf("apply(open, document, []);"));
		expect(heard).toBeLessThan(script.indexOf("apply(write, document, [data.html]);"));
		expect(script).toContain('watch(root);\n\t\tapply(listen, root, ["click", noteLink, true]);');
		expect(script).toContain(
			"const path = apply(composedPath, click, []);\n\t\t\tfor (let index = 0; index < path.length && !link; index++) if (isLink(path[index])) link = path[index];",
		);
		// The click is settled last at the window: the listener is put there again at every click, behind every
		// handler the page has added since.
		expect(script).toContain(
			'noteLink(click);\n\t\tapply(unlisten, window, ["click", settle]);\n\t\tapply(listen, window, ["click", settle]);',
		);
		const settle = script.slice(
			script.indexOf("const settle = (click) => {"),
			script.indexOf("const hear = (click) => {"),
		);
		const steps = [
			// Once for each click.
			"if (!link || apply(isSettled, settled, [click])) return;",
			"apply(markSettled, settled, [click]);",
			// A click the page took for itself is the page's.
			"if (apply(prevented, click, [])) return;",
			// So is a jump inside the page.
			"if (href === null) return;",
			// Every other click on a link is stopped, whoever made it: the frame never leaves its page.
			"apply(prevent, click, []);",
			// Only a click the member made goes on.
			"if (click.isTrusted === true && href.length <= 2048) follow(href);",
		];
		for (const step of steps) expect(settle, step).toContain(step);
		expect(steps.map((step) => settle.indexOf(step))).toEqual(
			steps.map((step) => settle.indexOf(step)).sort((a, b) => a - b),
		);
		// A click a script made need not travel to the window at all: it is stopped where it is noted.
		expect(script).toContain("if (click.isTrusted !== true && placeOf(link) !== null) apply(prevent, click, []);");
		// A handler that stops a link's click from travelling on does not keep it from being settled: it is settled
		// when that handler returns, or at once for a click a script made.
		expect(script).toContain(
			"if (event.isTrusted === true) apply(soon, window, [() => settle(event)]);\n\t\telse settle(event);",
		);
		for (const way of [
			"stopping(this);\n\t\tapply(stop, this, []);",
			"stopping(this);\n\t\tapply(stopNow, this, []);",
			"if (value) stopping(this);\n\t\t\tapply(bubble.set, this, [value]);",
		])
			expect(script, way).toContain(way);
		// It goes out as a call on the port this document keeps: never on a window message, and by no call of the
		// page's `qorpera` object.
		expect(script).toContain(
			'apply(send, port, [{ type: "qorpera-app-call", id: ++next, method: "open", params: { href } }]);',
		);
		const api = script.slice(script.indexOf("const page = freeze({"), script.indexOf("// Sent as a call"));
		expect(api).toContain('read: freeze((path) => call("read", { path: String(path) })),');
		expect(api).not.toMatch(/open|follow|href/);
		expect(script.match(/app\.postMessage\(/g)).toHaveLength(2);

		// What stays the page's own, as the browser reads an address.
		const source = /const ownLink = (\(href\) => \{[\s\S]*?\n\t\});/.exec(script)?.[1];
		expect(source).toBeDefined();
		const ownLink = new Function("apply", "codeAt", `return ${source};`)(
			Reflect.apply,
			String.prototype.charCodeAt,
		) as (href: string) => boolean;
		for (const own of ["#", "#top", "  #top", "\t\n#a", "javascript:void(0)", "JavaScript:show(2)", " javascript:x"])
			expect(ownLink(own), own).toBe(true);
		for (const place of [
			"",
			" ",
			"app:sales",
			"folder:plan.md",
			"https://example.com/#top",
			"other.html#top",
			"javascript",
			"javascripts:x",
			"java\tscript:x",
			"javascript\u001a",
			"x#top",
		])
			expect(ownLink(place), JSON.stringify(place)).toBe(false);
	});

	it("takes WebRTC, frames and the ways to hide them away before the page runs", () => {
		const script = frameDocument.slice(frameDocument.indexOf("<script>"), frameDocument.indexOf("</script>"));
		const guarded = (text: string) => {
			expect(script, text).toContain(text);
			expect(script.indexOf(text), text).toBeLessThan(script.indexOf('addEventListener("message"'));
		};
		// Every RTC interface goes for good.
		guarded("if (/^(?:webkit|moz)?RTC/.test(name)) define(window, name, undefined);");
		guarded("Object.defineProperty(target, name, { value, writable: false, configurable: false })");
		// Frames go as they are put into the document or any shadow root the page makes, never cloned along.
		guarded('const frames = "iframe, frame, object, embed, portal, fencedframe";');
		guarded("watch(document);");
		guarded('define(Element.prototype, "attachShadow", function attachShadowWatched(init) {');
		// Options the browser reads have no prototype, so nothing the page puts on Object.prototype counts.
		guarded("const watching = create(null);");
		guarded("const options = create(null);");
		guarded("const root = apply(attachShadow, this, [options]);");
		// No markup makes a shadow root the frame doesn't watch.
		guarded('[Element.prototype, "setHTMLUnsafe"],');
		guarded('[Document, "parseHTMLUnsafe"],');
		guarded('define(Document.prototype, "write", function writeRefused() {});');
		guarded('define(Document.prototype, "writeln", function writelnRefused() {});');
		guarded('define(Document.prototype, "open", function openRefused() {');
	});

	it("keeps the frame document's policy and the site's rule for it in step, and locked down", () => {
		const frameRule = rule("/page-preview/*");
		// Pages applies /* first: this rule takes its policy and its framing refusal off before setting its own.
		expect(frameRule.slice(0, 3)).toEqual(["! Content-Security-Policy", "! X-Frame-Options", "! Permissions-Policy"]);
		expect(frameRule).toContain("X-Frame-Options: SAMEORIGIN");
		// A Company File page gets no microphone, camera or other device, though the app has the microphone for dictation.
		expect(frameRule).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()");
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
		expect(site).toContain("Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
		expect(policy(site)).toContain("frame-ancestors 'none'");
		expect(policy(site)).toMatch(/^default-src 'self';/);
		expect(policy(site)).not.toMatch(/frame-src|child-src/);
	});
});
