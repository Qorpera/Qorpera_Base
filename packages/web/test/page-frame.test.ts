// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFrame } from "../src/ui/app-frame.ts";
import {
	framePage,
	frameParsedPage,
	PAGE_CONTENT,
	PAGE_ESCAPE,
	PAGE_FRAME_URL,
	PAGE_READY,
	parseHtmlInert,
	serializeHtmlInert,
} from "../src/ui/page-frame.ts";

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

const standAlone = (html: string, title: string) =>
	new AppFrame(
		{ html },
		title,
		"files-page-frame",
		async () => ({ ok: false, error: "Only an app in apps/ reads the company's data" }),
		() => {},
		{ again: true },
	);
const loaded = (frame: AppFrame) => frame.frame.dispatchEvent(new Event("load"));
const handedAs = (html: string) => [
	{ type: PAGE_CONTENT, html, files: [], missing: [], base: "" },
	"*",
	[expect.any(MessagePort)],
];

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("an HTML page's frame", () => {
	it("runs scripts with no origin, sends no referrer, and loads the frame document", () => {
		const frame = standAlone("<p>Hi</p>", "Page: hi.html").frame;
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(frame.getAttribute("src")).toBe(PAGE_FRAME_URL);
		expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(frame.title).toBe("Page: hi.html");
		expect(frame.className).toBe("files-page-frame");
	});

	it("hands each frame its own page when it is ready, and nothing to anyone else", () => {
		const one = standAlone("<p>One</p>", "Page: one.html");
		const two = standAlone("<p>Two</p>", "Page: two.html");
		const stranger = document.createElement("iframe");
		document.body.append(one.frame, two.frame, stranger);
		const toOne = vi.spyOn(one.frame.contentWindow!, "postMessage");
		const toTwo = vi.spyOn(two.frame.contentWindow!, "postMessage");
		const toStranger = vi.spyOn(stranger.contentWindow!, "postMessage");
		ready(two.frame.contentWindow);
		expect(toTwo).toHaveBeenCalledExactlyOnceWith(...handedAs("<p>Two</p>"));
		expect(toOne).not.toHaveBeenCalled();
		ready(stranger.contentWindow);
		ready(one.frame.contentWindow, { type: PAGE_CONTENT, html: "<p>Mine</p>" });
		ready(one.frame.contentWindow, "qorpera-page-ready");
		ready(null);
		expect(toStranger).not.toHaveBeenCalled();
		expect(toOne).not.toHaveBeenCalled();
		two.dispose();
		ready(two.frame.contentWindow);
		loaded(two);
		expect(toTwo).toHaveBeenCalledOnce();
		one.dispose();
	});

	it("hands a page opened by itself over again when it reloads, whatever the order of ready and load", async () => {
		const ports = (spy: { mock: { calls: unknown[][] } }) =>
			spy.mock.calls.map((call) => (call[2] as MessagePort[])[0]);
		const first = standAlone("<p>First</p>", "Page: first.html");
		const second = standAlone("<p>Second</p>", "Page: second.html");
		document.body.append(first.frame, second.frame);
		const toFirst = vi.spyOn(first.frame.contentWindow!, "postMessage");
		const toSecond = vi.spyOn(second.frame.contentWindow!, "postMessage");
		ready(first.frame.contentWindow);
		loaded(first);
		expect(toFirst).toHaveBeenCalledExactlyOnceWith(...handedAs("<p>First</p>"));
		loaded(second);
		expect(toSecond).not.toHaveBeenCalled();
		ready(second.frame.contentWindow);
		expect(toSecond).toHaveBeenCalledExactlyOnceWith(...handedAs("<p>Second</p>"));
		loaded(first);
		loaded(first);
		ready(first.frame.contentWindow);
		ready(first.frame.contentWindow);
		loaded(first);
		loaded(first);
		expect(toFirst).toHaveBeenCalledTimes(3);
		expect(new Set(ports(toFirst)).size).toBe(3);
		for (const call of toFirst.mock.calls) expect(call).toEqual(handedAs("<p>First</p>"));
		expect(first.signal.aborted).toBe(false);
		let give: (page: { html: string }) => void = () => {};
		const pending = new AppFrame(
			new Promise((resolve) => {
				give = resolve;
			}),
			"Page: later.html",
			"files-page-frame",
			async () => ({ ok: false, error: "no" }),
			() => {},
			{ again: true },
		);
		document.body.append(pending.frame);
		const toPending = vi.spyOn(pending.frame.contentWindow!, "postMessage");
		ready(pending.frame.contentWindow);
		loaded(pending);
		ready(pending.frame.contentWindow);
		expect(toPending).not.toHaveBeenCalled();
		give({ html: "<p>Later</p>" });
		await Promise.resolve();
		await Promise.resolve();
		expect(toPending).toHaveBeenCalledExactlyOnceWith(...handedAs("<p>Later</p>"));
		let late: (page: { html: string }) => void = () => {};
		const ended = new AppFrame(
			new Promise((resolve) => {
				late = resolve;
			}),
			"Page: ended.html",
			"files-page-frame",
			async () => ({ ok: false, error: "no" }),
			() => {},
			{ again: true },
		);
		document.body.append(ended.frame);
		const toEnded = vi.spyOn(ended.frame.contentWindow!, "postMessage");
		ready(ended.frame.contentWindow);
		ended.dispose();
		late({ html: "<p>Ended</p>" });
		await Promise.resolve();
		await Promise.resolve();
		ready(ended.frame.contentWindow);
		loaded(ended);
		expect(toEnded).not.toHaveBeenCalled();
		first.dispose();
		ready(first.frame.contentWindow);
		expect(toFirst).toHaveBeenCalledTimes(3);
		second.dispose();
		pending.dispose();
	});

	it("stops an app's frame whose page reloads itself, as before", () => {
		let left = 0;
		const app = new AppFrame(
			{ html: "<p>App</p>" },
			"App: shop",
			"side-panel-frame",
			async () => ({ ok: true, value: null }),
			() => {
				left++;
			},
		);
		document.body.append(app.frame);
		const toApp = vi.spyOn(app.frame.contentWindow!, "postMessage");
		ready(app.frame.contentWindow);
		expect(toApp).not.toHaveBeenCalled();
		loaded(app);
		expect(toApp).toHaveBeenCalledOnce();
		loaded(app);
		ready(app.frame.contentWindow);
		expect(left).toBe(1);
		expect(app.signal.aborted).toBe(true);
		const reloaded = new AppFrame(
			{ html: "<p>App</p>" },
			"App: shop",
			"side-panel-frame",
			async () => ({ ok: true, value: null }),
			() => {
				left++;
			},
		);
		document.body.append(reloaded.frame);
		loaded(reloaded);
		ready(reloaded.frame.contentWindow);
		loaded(reloaded);
		loaded(reloaded);
		expect(left).toBe(2);
	});

	it("handles a rejected page promise cleanly via left without unhandled rejections", async () => {
		let left = 0;
		const failing = new AppFrame(
			Promise.reject(new Error("failed to assemble")),
			"App: broken",
			"side-panel-frame",
			async () => ({ ok: true, value: null }),
			() => {
				left++;
			},
		);
		document.body.append(failing.frame);
		await Promise.resolve();
		await Promise.resolve();
		expect(left).toBe(1);
		expect(failing.signal.aborted).toBe(true);
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
		const frame = standAlone(handed, "Page: sales.html");
		document.body.append(frame.frame);
		const send = vi.spyOn(frame.frame.contentWindow!, "postMessage");
		ready(frame.frame.contentWindow);
		expect(send).toHaveBeenCalledExactlyOnceWith(...handedAs(handed));
		frame.dispose();
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

	it("skips DOMParser on clean pages without unfit constructs and runs the real parser when preconnect or declarative shadow roots appear inside svg style", () => {
		const parse = DOMParser.prototype.parseFromString;
		const parsedInputs: string[] = [];
		vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(function (this: DOMParser, text, type) {
			parsedInputs.push(text);
			return Reflect.apply(parse, this, [text, type]) as Document;
		});

		const clean =
			'<!doctype html><html><head><style>.a{color:red}</style></head><body><div style="padding:8px">Hi</div></body></html>';
		expect(framePage(clean)).toBe(clean);
		expect(parsedInputs).toHaveLength(0);

		const svgPreconnect =
			"<svg><style><p><noframes></noframes><link rel=preconnect href=https://evil.example></style></svg>";
		const cleanedPreconnect = framePage(svgPreconnect);
		expect(cleanedPreconnect).not.toBeNull();
		expect(cleanedPreconnect).not.toMatch(/preconnect/i);

		const svgShadow =
			'<svg><style><p><noframes></noframes><template shadowrootmode="open"><iframe srcdoc="x"></iframe></template></style></svg>';
		const cleanedShadow = framePage(svgShadow);
		expect(cleanedShadow).not.toBeNull();
		expect(cleanedShadow).not.toMatch(/shadowroot/i);

		const entityPreconnect = '<!doctype html><link rel="&#112;reconnect" href="https://evil.example"><p>Hi</p>';
		const cleanedEntity = framePage(entityPreconnect);
		expect(cleanedEntity).not.toBeNull();
		expect(cleanedEntity).not.toMatch(/<link/i);
		expect(cleanedEntity).toContain("<p>Hi</p>");

		const inertSvg = parseHtmlInert(svgPreconnect);
		const cleanedInertSvg = frameParsedPage(inertSvg.doc, undefined, inertSvg);
		expect(cleanedInertSvg).not.toBeNull();
		expect(cleanedInertSvg).not.toMatch(/preconnect/i);

		const inertSvgShadow = parseHtmlInert(svgShadow);
		const cleanedInertShadow = frameParsedPage(inertSvgShadow.doc, undefined, inertSvgShadow);
		expect(cleanedInertShadow).not.toBeNull();
		expect(cleanedInertShadow).not.toMatch(/shadowroot/i);

		const svgCss = "<!doctype html><html><body><svg><style>.a > .b { fill: red; }</style></svg></body></html>";
		const inertCss = parseHtmlInert(svgCss);
		const restoredCss = frameParsedPage(inertCss.doc, undefined, inertCss)!;
		const parsedRestored = new DOMParser().parseFromString(restoredCss, "text/html");
		expect(parsedRestored.querySelector("svg style")?.textContent).toBe(".a > .b { fill: red; }");
	});

	it("preserves literal data-qorpera-style text inside inlined scripts when serializing an inert parse", () => {
		const html =
			'<!doctype html><html><head><style>.a{color:red}/*</noframes>*/</style></head><body><div style="padding:8px">Hi</div></body></html>';
		const parsed = parseHtmlInert(html);
		const script = parsed.doc.createElement("script");
		script.textContent = 'const s = "data-qorpera-style=1 __qorpera_endnf__";';
		parsed.doc.body.append(script);
		const out = serializeHtmlInert(parsed.doc, parsed);
		expect(out).toContain("<style>.a{color:red}/*</noframes>*/</style>");
		expect(out).toContain('style="padding:8px"');
		expect(out).toContain('const s = "data-qorpera-style=1 __qorpera_endnf__";');
	});

	it("hears Escape pressed in its own frames' pages as Escape pressed on the frame, and nothing else", () => {
		const one = standAlone("<p>One</p>", "Page: one.html");
		const stranger = document.createElement("iframe");
		document.body.append(one.frame, stranger);
		const keys: string[] = [];
		document.body.addEventListener("keydown", (event) => {
			keys.push(`${(event.target as HTMLElement).className || "stranger"} ${event.key} ${event.cancelable}`);
		});
		ready(stranger.contentWindow, { type: PAGE_ESCAPE });
		ready(null, { type: PAGE_ESCAPE });
		ready(one.frame.contentWindow, PAGE_ESCAPE);
		expect(keys).toEqual([]);
		ready(one.frame.contentWindow, { type: PAGE_ESCAPE });
		expect(keys).toEqual(["files-page-frame Escape true"]);
		const toOne = vi.spyOn(one.frame.contentWindow!, "postMessage");
		ready(one.frame.contentWindow, { type: PAGE_ESCAPE });
		expect(toOne).not.toHaveBeenCalled();
		one.dispose();
		ready(one.frame.contentWindow, { type: PAGE_ESCAPE });
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
			'const currentOf = getter(Event.prototype, "currentTarget");',
			'const phaseOf = getter(Event.prototype, "eventPhase");',
			'const modeOf = getter(ShadowRoot.prototype, "mode");',
			"const unlisten = EventTarget.prototype.removeEventListener;",
			"const soon = queueMicrotask;",
			"const attribute = Element.prototype.getAttribute;",
			"const codeAt = String.prototype.charCodeAt;",
			"const clicked = new WeakMap();",
			"const settled = new WeakSet();",
			"const closed = new WeakSet();",
			'const links = "a[*|href], area[href]";',
			"Event.prototype.stopPropagation = function stopPropagation() {",
			"Event.prototype.stopImmediatePropagation = function stopImmediatePropagation() {",
			'Object.defineProperty(Event.prototype, "cancelBubble", {',
		]) {
			expect(script, taken).toContain(taken);
			expect(script.indexOf(taken), taken).toBeLessThan(script.indexOf('addEventListener("message"'));
		}
		// What a page reads and says of a click's cancelling is the browser's own: nothing stands in for it.
		expect(script).not.toMatch(/Event\.prototype\.preventDefault = |"defaultPrevented", \{|"returnValue"/);
		// Only for a page handed a port: without one, nothing is noted, so nothing is stopped or sent.
		expect(script).toContain("const noteLink = (click) => {\n\t\tif (!follow) return;");
		expect(script).toContain(
			'if (live) {\n\t\t\tseenFiles = ownFiles(live, base);\n\t\t\tdefine(window, "qorpera", live.page);',
		);
		// The link is noted on the click's way down, before any handler of the page: at the window, listened for once
		// the document is opened (which drops the window's listeners) and before the page is written, and at each
		// shadow tree's root. It is the innermost link on the click's whole path, a slot's surroundings included.
		const heard = script.indexOf('apply(listen, window, ["click", hear, true]);');
		expect(heard).toBeGreaterThan(script.indexOf("apply(open, document, []);"));
		expect(heard).toBeLessThan(script.indexOf("apply(write, document, [html]);"));
		expect(script).toContain(
			'if (apply(modeOf, root, []) === "closed") apply(addTo, closed, [root]);\n\t\tapply(listen, root, ["click", noteLink, true]);',
		);
		expect(script).toContain(
			"path = apply(composedPath, click, []);\n\t\t\tfor (let index = 0; index < path.length && !link; index++) if (isLink(path[index])) link = path[index];",
		);
		// The frame is heard behind the page's handlers, put last again at every click: at the window for a click that
		// travels all the way, and on every node of the click's path, each way, for one a handler stops there. Not
		// on the node that is hearing the note itself on the way down, where a listener put now is not heard.
		expect(script).toContain(
			'const last = (node, listener, down) => {\n\t\tapply(unlisten, node, ["click", listener, down]);\n\t\tapply(listen, node, ["click", listener, down]);',
		);
		expect(script).toContain("noteLink(click);\n\t\tif (click.isTrusted === true) last(window, settle, false);");
		expect(script).toContain(
			"if (path[index] !== here) last(path[index], settleStopped, true);\n\t\t\t\tlast(path[index], settleStopped, false);",
		);
		expect(script).toContain(
			"if (apply(inSet, stops, [click]) || (bubble && apply(bubble.get, click, []) === true)) settle(click);",
		);
		const settle = script.slice(
			script.indexOf("const settle = (click) => {"),
			script.indexOf("const settleStopped = (click) => {"),
		);
		const steps = [
			// Once for each click.
			"if (!link || apply(inSet, settled, [click])) return;",
			"apply(addTo, settled, [click]);",
			// A click the page took, as the browser itself says, is the page's; so is a jump inside the page.
			"const href = apply(prevented, click, []) ? null : placeOf(link);",
			"if (href === null) return;",
			// Every other click on a link is stopped, whoever made it: the frame never leaves its page.
			"apply(prevent, click, []);",
			// A click that a passive handler has cannot be stopped: then the link is kept from leading anywhere.
			"if (!apply(prevented, click, [])) park(link);",
			// Only a click the member made goes on, once the click is over, to where the link led when it was settled.
			"if (click.isTrusted === true && href.length <= 2048) apply(later, window, [() => follow(href), 0]);",
		];
		for (const step of steps) expect(settle, step).toContain(step);
		expect(steps.map((step) => settle.indexOf(step))).toEqual(
			steps.map((step) => settle.indexOf(step)).sort((a, b) => a - b),
		);
		// Parked, a link has no address for as long as the click lasts: both spellings of it go, and each comes back
		// once the click is over unless the page has written one meanwhile.
		for (const part of [
			'if (plain !== null) apply(removeAttribute, link, ["href"]);',
			'if (drawn !== null) apply(removeAttributeNS, link, [older, "href"]);',
			'if (plain !== null && apply(attribute, link, ["href"]) === null) apply(setAttribute, link, ["href", plain]);',
			'if (drawn !== null && apply(attributeNS, link, [older, "href"]) === null)\n\t\t\t\t\tapply(setAttributeNS, link, [older, "xlink:href", drawn]);',
		])
			expect(script, part).toContain(part);
		// A click a script made is stopped where it is noted, and no listener is moved for it.
		expect(script).toContain(
			"if (click.isTrusted !== true) {\n\t\t\tif (placeOf(link) !== null) apply(prevent, click, []);\n\t\t\treturn;\n\t\t}",
		);
		// A handler that stops a click at once, or in one of the two places where the frame is not behind the page's
		// handlers in time (the window and a closed tree's root, on the way down), does not keep the click from
		// being settled: it is settled when that handler returns, or at once for a click a script made.
		expect(script).toContain(
			"apply(phaseOf, event, []) === 1 &&\n\t\t(apply(currentOf, event, []) === window || apply(inSet, closed, [apply(currentOf, event, [])]));",
		);
		expect(script).toContain(
			"apply(addTo, stops, [event]);\n\t\tif (!atOnce && !unheard(event)) return;\n\t\tif (event.isTrusted === true) apply(soon, window, [() => settle(event)]);\n\t\telse settle(event);",
		);
		for (const way of [
			"stopping(this, false);\n\t\tapply(stop, this, []);",
			"stopping(this, true);\n\t\tapply(stopNow, this, []);",
			"if (value) stopping(this, false);\n\t\t\t\tapply(bubble.set, this, [value]);",
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

	it("asks the company's databases over the port, and hands each watch's answers to its own listener only", async () => {
		const script = frameDocument.slice(frameDocument.indexOf("<script>"), frameDocument.indexOf("</script>"));
		// The bridge as the document makes it, over a port that notes what is sent.
		const body = script.slice(
			script.indexOf("const send = MessagePort.prototype.postMessage;"),
			script.indexOf('addEventListener("message", function take'),
		);
		const sent: Record<string, unknown>[] = [];
		let hear: (event: { data: unknown }) => void = () => {};
		const make = new Function(
			"MessagePort",
			"MessageEvent",
			"getter",
			"apply",
			"listen",
			`${body}\nreturn bridge;`,
		) as (...parts: unknown[]) => (port: object) => { page: Record<string, (...args: unknown[]) => unknown> };
		const { page } = make(
			{ prototype: { postMessage: (message: Record<string, unknown>) => sent.push(message), start: () => {} } },
			{ prototype: {} },
			() =>
				function data(this: { data: unknown }) {
					return this.data;
				},
			Reflect.apply,
			(_type: string, listener: typeof hear) => {
				hear = listener;
			},
		)({});
		const answer = (id: unknown, value: unknown) =>
			hear({ data: { type: "qorpera-app-answer", id, ok: true, value } });
		const data = (watch: unknown, value: unknown) => hear({ data: { type: "qorpera-app-data", watch, value } });
		expect(Object.isFrozen(page)).toBe(true);
		expect(Object.isFrozen(page.query)).toBe(true);
		expect(Object.isFrozen(page.watch)).toBe(true);

		const asked = page.query!("shop/sales", { since: "2026-11-01" }) as Promise<unknown>;
		expect(sent.at(-1)).toEqual({
			type: "qorpera-app-call",
			id: 1,
			method: "query",
			params: { name: "shop/sales", params: { since: "2026-11-01" } },
		});
		answer(1, { columns: ["orders"], rows: [{ orders: 3 }], more: false, asOf: "x" });
		expect(await asked).toEqual({ columns: ["orders"], rows: [{ orders: 3 }], more: false, asOf: "x" });
		page.query!("shop/sales");
		expect(sent.at(-1)?.params).toEqual({ name: "shop/sales", params: {} });

		// A watch: its first answer, then each one sent for its id, and nothing sent for another.
		const seen: unknown[] = [];
		const stop = page.watch!("shop/sales", undefined, (value: unknown) => seen.push(value)) as () => void;
		expect(Object.isFrozen(stop)).toBe(true);
		expect(sent.at(-1)).toEqual({
			type: "qorpera-app-call",
			id: 3,
			method: "watch",
			params: { name: "shop/sales", params: {} },
		});
		answer(3, { watch: 7, answer: "first" });
		data(7, "second");
		data(8, "another's");
		hear({ data: { type: "qorpera-app-data", watch: "7", value: "odd" } });
		expect(seen).toEqual(["first", "second"]);
		// A listener that throws is passed by, and the next answer still reaches it.
		const thrown: unknown[] = [];
		page.watch!("shop/by-status", { open: true }, (value: unknown) => {
			thrown.push(value);
			throw new Error("the page's own");
		});
		answer(4, { watch: 9, answer: "a" });
		expect(() => data(9, "b")).not.toThrow();
		expect(thrown).toEqual(["a", "b"]);
		// Stopped: the app is told once, and nothing more reaches the listener.
		stop();
		expect(sent.at(-1)).toEqual({ type: "qorpera-app-call", id: 5, method: "unwatch", params: { watch: 7 } });
		stop();
		expect(sent).toHaveLength(5);
		data(7, "late");
		expect(seen).toEqual(["first", "second"]);
		// Stopped before its first answer: the listener is never called, and the watch the app started is ended.
		const never: unknown[] = [];
		const early = page.watch!("shop/sales", {}, (value: unknown) => never.push(value)) as () => void;
		early();
		expect(sent).toHaveLength(6);
		answer(6, { watch: 10, answer: "first" });
		expect(sent.at(-1)).toEqual({ type: "qorpera-app-call", id: 7, method: "unwatch", params: { watch: 10 } });
		data(10, "late");
		expect(never).toEqual([]);
		// No listener, no watch.
		page.watch!("shop/sales", {});
		expect(sent).toHaveLength(7);

		// A watch the app refuses to start: `failed` is called once with the app's words, and its stop does nothing.
		const refuse = (id: unknown, error: unknown) =>
			hear({ data: { type: "qorpera-app-answer", id, ok: false, error } });
		const failures: unknown[] = [];
		const refused = page.watch!(
			"shop/missing",
			{},
			() => failures.push("listener"),
			(error: unknown) => failures.push(error),
		) as () => void;
		refuse(8, "No question shop/missing that you may read");
		refuse(8, "again");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(Error);
		expect((failures[0] as Error).message).toBe("No question shop/missing that you may read");
		refused();
		expect(sent).toHaveLength(8);
		// A watch that started never calls it, also when it stops; one that throws is passed by.
		const unfailed: unknown[] = [];
		const fine = page.watch!(
			"shop/sales",
			{},
			() => {},
			(error: unknown) => unfailed.push(error),
		) as () => void;
		answer(9, { watch: 11, answer: "first" });
		fine();
		expect(unfailed).toEqual([]);
		page.watch!(
			"shop/sales",
			{},
			() => {},
			() => {
				throw new Error("the page's own");
			},
		);
		expect(() => refuse(11, 'Add "data" to reads in app.toml to ask the company\'s databases')).not.toThrow();
		// Without `failed`, a refusal is as before: nothing.
		page.watch!("shop/sales", {}, () => {});
		expect(() => refuse(12, "refused")).not.toThrow();
	});

	it("hands an app's page a note to its owner as one more call that only asks, its parts as plain values", () => {
		const script = frameDocument.slice(frameDocument.indexOf("<script>"), frameDocument.indexOf("</script>"));
		const api = script.slice(script.indexOf("const page = freeze({"), script.indexOf("// Sent as a call"));
		const source = /\n\t\t\ttell: (freeze\(\(note\) => \{[\s\S]*?\n\t\t\t\}\)),\n/.exec(api)?.[1];
		expect(source).toBeDefined();
		const calls: [string, unknown][] = [];
		const tell = new Function("freeze", "call", `return ${source};`)(
			Object.freeze,
			(method: string, params: unknown) => {
				calls.push([method, params]);
				return Promise.resolve();
			},
		) as (note?: unknown) => Promise<unknown>;
		void tell({ about: "Lund, A", at: 1043, text: "Get a quote", to: "someone else" });
		void tell({ about: "Lund" });
		void tell("Lund");
		void tell(null);
		expect(calls).toEqual([
			["tell", { about: "Lund, A", at: "1043", text: "Get a quote" }],
			["tell", { about: "Lund", at: null, text: null }],
			["tell", { about: "", at: null, text: null }],
			["tell", { about: "", at: null, text: null }],
		]);
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
		expect(header).not.toMatch(/frame-src|child-src|https?:|wss?:|\*/);
		const sources = Object.fromEntries(directives.map((part) => [part.split(" ")[0], part.split(" ").slice(1)]));
		for (const name of ["img-src", "font-src", "media-src", "connect-src", "worker-src"])
			for (const source of sources[name] ?? []) expect(["data:", "blob:"], name).toContain(source);
		expect(sources["script-src"]).toEqual(["'unsafe-inline'", "'unsafe-eval'", "blob:"]);
		expect(sources["style-src"]).toEqual(["'unsafe-inline'", "data:"]);
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
		expect(site).toContain("Origin-Agent-Cluster: ?1");
		expect(site).toContain("Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
		expect(policy(site)).toContain("frame-ancestors 'none'");
		expect(policy(site)).toMatch(/^default-src 'self';/);
		expect(policy(site)).not.toMatch(/frame-src|child-src/);
	});
});
