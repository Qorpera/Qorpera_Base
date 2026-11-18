// An interface app's links, run in real Chromium the way the web app runs an app: the app's own frame code
// (packages/web/src/ui/app-frame.ts) in a page under the site's policy, the frame document
// (packages/web/public/page-preview/index.html) under its rule from packages/web/public/_headers. Clicks are the
// browser's own (trusted), which no unit test can make. Checks, for each kind of link a page can write: which clicks
// reach the app as an `open` call on the port and with what address, that a click a script made reaches nothing, that
// what is the page's own stays the page's (a jump inside the page, a click a handler of the page took, wherever and
// whenever that handler was added), that a click a handler stops from travelling on is still heard, and sent only if
// no handler that still runs takes it (and a passive one cannot), that clicks on anything but a link are as they
// were, and that the frame never leaves the page it was handed, whatever was clicked
// (deploy/first-node/RUNTIME-INTERFACE-APPS.md §4). Also that a note to the app's owner (`qorpera.tell`, §5) leaves the
// frame as one call with its parts as plain values.
// Usage: QORPERA_WEB_TEST_BROWSER=<Chromium> node scripts/test-web-app-frame-browser.mjs
// APP_FRAME_DOCUMENT=<file> serves another frame document (to see a weaker one fail); ONLY=<name> runs one page.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { OBJECT_THREE_VERSION } from "./build-object-kit-three.mjs";

const executablePath = process.env.QORPERA_WEB_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_WEB_TEST_BROWSER to an existing Chromium executable");
const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const web = join(repository, "packages/web");
const frameDocument = await readFile(process.env.APP_FRAME_DOCUMENT ?? join(web, "public/page-preview/index.html"));

/** The site's headers for a path, as Pages applies public/_headers (scripts/test-web-page-frame-browser.mjs). */
const rules = [];
for (const line of (await readFile(join(web, "public/_headers"), "utf8")).split("\n").map((text) => text.trim())) {
	if (!line || line.startsWith("#")) continue;
	if (line.startsWith("/")) rules.push({ pattern: line, unset: [], set: [] });
	else if (line.startsWith("!")) rules.at(-1).unset.push(line.slice(1).trim().toLowerCase());
	else rules.at(-1).set.push([line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]);
}
function headersFor(path) {
	const headers = new Map();
	for (const rule of rules) {
		if (!new RegExp(`^${rule.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(path)) continue;
		for (const name of rule.unset) headers.delete(name);
		for (const [name, value] of rule.set) headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
	}
	const policy = headers.get("content-security-policy");
	if (policy)
		headers.set("content-security-policy", policy.replace(" __QORPERA_WEB_CONNECT_SRC__", "").replace("; upgrade-insecure-requests", ""));
	headers.delete("strict-transport-security");
	return Object.fromEntries(headers);
}

// The app's side: the frame code as the web app ships it. Every call the page's frame sends is kept, and answered.
const parent = await build({
	stdin: {
		contents: `import { AppFrame } from ${JSON.stringify(join(web, "src/ui/app-frame.ts"))};
window.calls = [];
window.left = 0;
const variant = new URLSearchParams(location.search).get("v");
const { page, handed = {} } = await (await fetch("/variant/" + encodeURIComponent(variant))).json();
const fileOf = async (path) => {
	const answer = await fetch("/file/" + path);
	return answer.ok ? new Blob([await answer.arrayBuffer()], { type: answer.headers.get("content-type") }) : null;
};
const files = await Promise.all(Object.entries(handed).map(async ([token, path]) => [token, await fileOf(path)]));
const frame = new AppFrame({ html: page, files, base: "" }, "App", "app", async (call) => {
	if (call.method === "file") {
		const path = (call.params.base ? call.params.base + "/" : "") + call.params.path.replace(/^\\.\\//, "");
		if (path === "counter.txt") {
			window.counted = (window.counted ?? 0) + 1;
			return { ok: true, value: new Blob([String(window.counted)]) };
		}
		if (path === "flaky.txt") {
			window.flaky = (window.flaky ?? 0) + 1;
			return window.flaky === 1 ? { ok: false, error: "flaky.txt could not be read now" } : { ok: true, value: new Blob(["steady"]) };
		}
		const blob = /^[a-z0-9.-]+$/.test(path) ? await fileOf(path) : null;
		return blob ? { ok: true, value: blob } : { ok: false, error: path + " is not in the page's folder" };
	}
	window.calls.push(
		call.method === "open"
			? "open " + call.params.href
			: call.method === "tell"
				? "tell " + JSON.stringify(call.params)
				: call.method + " " + call.params.path,
	);
	return { ok: true, value: "" };
}, () => { window.left++; });
frame.frame.style.cssText = "width: 800px; height: 600px; border: 0";
document.body.append(frame.frame);`,
		resolveDir: repository,
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	write: false,
	logLevel: "silent",
});

/** A page says something to the test through the one way a page has: a read, which the app keeps. In single quotes,
 * so it also fits in an attribute. */
const say = (text) => `qorpera.read('${text}')`;
const style = "<style>a, .box { display: block; height: 30px; } svg { display: block; }</style>";
const WORKER_SOURCE = `const OUT = "OUTSIDE";
const ways = {};
const tried = (name, attempt) =>
	Promise.race([attempt(), new Promise((_, no) => setTimeout(no, 1500))]).then(() => { ways[name] = "reached"; }, () => { ways[name] = "closed"; });
Promise.all([
	tried("fetch", () => fetch(OUT + "/w-fetch")),
	tried("xhr", () => new Promise((yes, no) => { const x = new XMLHttpRequest(); x.open("GET", OUT + "/w-xhr"); x.onload = yes; x.onerror = no; x.send(); })),
	tried("websocket", () => new Promise((yes, no) => { const w = new WebSocket(OUT.replace("http", "ws") + "/w-ws"); w.onopen = yes; w.onerror = no; })),
	tried("eventsource", () => new Promise((yes, no) => { const e = new EventSource(OUT + "/w-es"); e.onopen = yes; e.onerror = () => { e.close(); no(); }; })),
	tried("importScripts", async () => importScripts(OUT + "/w-script.js")),
	tried("worker", () => new Promise((yes, no) => { try { const w = new Worker(OUT + "/w-worker.js"); w.onerror = (event) => { event.preventDefault(); no(); }; w.onmessage = yes; } catch (error) { no(error); } })),
]).then(async () => {
	const rtc = (scope) => Object.getOwnPropertyNames(scope).filter((name) => /RTC/.test(name) && scope[name] !== undefined).sort();
	const inner = new Worker(URL.createObjectURL(new Blob(["postMessage(Object.getOwnPropertyNames(self).filter((name) => /RTC/.test(name) && self[name] !== undefined))"])));
	const nested = await new Promise((done) => { inner.onmessage = (event) => done(event.data); inner.onerror = () => done("failed"); });
	postMessage({ ways, rtc: rtc(self), nested });
});
`;
const SHARED_PROBE = `const OUT = "OUTSIDE";
const ways = {};
const tried = (name, attempt) =>
	Promise.race([attempt(), new Promise((_, no) => setTimeout(no, 1500))]).then(() => { ways[name] = "reached"; }, () => { ways[name] = "closed"; });
const ready = Promise.all([
	tried("fetch", () => fetch(OUT + "/s-fetch")),
	tried("websocket", () => new Promise((yes, no) => { const w = new WebSocket(OUT.replace("http", "ws") + "/s-ws"); w.onopen = yes; w.onerror = no; })),
	tried("importScripts", async () => importScripts(OUT + "/s-script.js")),
]);
onconnect = (event) => ready.then(() => event.ports[0].postMessage({ ways, rtc: Object.getOwnPropertyNames(self).filter((name) => /RTC/.test(name) && self[name] !== undefined) }));
`;
const WORKLET_PROBE = `registerProcessor("probe", class extends AudioWorkletProcessor {
	constructor() {
		super();
		this.port.postMessage({
			reaches: ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker", "navigator"].filter((name) => typeof globalThis[name] !== "undefined"),
			rtc: Object.getOwnPropertyNames(globalThis).filter((name) => /RTC/.test(name)),
		});
	}
	process() { return false; }
});
`;
const PAST_GUARD = `const blob = (text) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
const REPORT = "postMessage(Object.getOwnPropertyNames(self).filter((name) => /RTC/.test(name) && self[name] !== undefined))";
const ask = (make) => new Promise((done) => {
	try {
		const worker = make(blob(REPORT));
		worker.onmessage = (event) => done(event.data);
		worker.onerror = (event) => { event.preventDefault(); done("failed"); };
	} catch (error) {
		done("refused: " + error.name);
	}
});
const tryAll = async () => {
	const first = new Worker(blob("postMessage(1)"));
	return {
		viaPrototype: await ask((address) => new Worker.prototype.constructor(address)),
		viaInstance: await ask((address) => new (Object.getPrototypeOf(first).constructor)(address)),
		viaReflect: await ask((address) => Reflect.construct(Worker, [address], function Other() {})),
		viaApply: await ask((address) => Reflect.construct(first.constructor, [address])),
	};
};
`;
const sorted = (value) =>
	value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(
				Object.keys(value)
					.sort()
					.map((key) => [key, sorted(value[key])]),
			)
		: value;
const variants = {
	"the links a page writes": {
		page: `<!doctype html>${style}<a id="app" href="app:sales">Sales</a><a id="file" href="folder:strategy/plan%202027.md">Plan</a>
<a id="web" href="https://example.com/pricing?plan=team" target="_blank">Site</a><a id="spaced" href="  app:hiring ">Hiring</a>
<a id="other" href="details.html">Details</a><a id="empty" href="">Again</a><a id="mail" href="mailto:a@example.com">Mail</a>
<a id="inner" href="app:deep"><b><i id="deep">Deep</i></b></a>
<a id="rewritten" href="app:before" onclick="this.setAttribute('href', 'app:after')">Rewritten</a>`,
		clicks: ["#app", "#file", "#web", "#spaced", "#other", "#empty", "#mail", "#deep", "#rewritten"],
		calls: [
			"open app:sales",
			"open folder:strategy/plan%202027.md",
			"open https://example.com/pricing?plan=team",
			"open   app:hiring ",
			"open details.html",
			"open ",
			"open mailto:a@example.com",
			"open app:deep",
			// Where the link leads once the page's handlers have had the click, as the browser would follow it.
			"open app:after",
		],
	},
	"a link followed from the keyboard": {
		page: `<!doctype html>${style}<a id="app" href="app:sales">Sales</a>`,
		keys: ["#app", "Enter"],
		calls: ["open app:sales"],
	},
	"what stays the page's own": {
		page: `<!doctype html>${style}<a id="jump" href="#bottom">Down</a><a id="script" href="javascript:void ${say("script ran")}">Run</a>
<a id="taken" href="app:sales" onclick="event.preventDefault(); ${say("page took it")}">Tab</a>
<a id="answered" href="app:sales" onclick="${say("handler answered false")}; return false">Tab</a>
<a id="late" href="app:hiring">Late</a><a id="later" href="app:hiring">Later</a>
<a id="stopped" href="app:sales" onclick="event.stopPropagation(); event.preventDefault(); ${say("stopped and took it")}">Menu</a>
<a id="plain" name="bottom">No address</a><p id="text">Text</p>
<script>document.addEventListener("click", (event) => { if (event.target.id === "late") { event.preventDefault(); ${say("document took it")}; } });
// A handler at the window that the page adds long after the frame's own.
addEventListener("load", () => setTimeout(() => addEventListener("click", (event) => {
	if (event.target.id === "later") { event.preventDefault(); ${say("a later window handler took it")}; }
}), 50));</script>`,
		clicks: ["#jump", "#script", "#taken", "#answered", "#late", "#later", "#stopped", "#plain", "#text"],
		// The javascript: address is left to the browser, as before, and Chromium runs none in this frame: nothing is
		// sent for it, and nothing runs.
		calls: [
			"read page took it",
			"read handler answered false",
			"read document took it",
			"read a later window handler took it",
			"read stopped and took it",
		],
	},
	"a click a handler stops from travelling on": {
		page: `<!doctype html>${style}<a id="stopped" href="app:stopped" onclick="event.stopPropagation()">Stopped</a>
<a id="at-once" href="app:stopped-at-once">At once</a><a id="bubble" href="app:cancel-bubble" onclick="event.cancelBubble = true">Old way</a>
<a id="down" href="app:stopped-on-the-way-down">Down</a><a id="at-window" href="app:stopped-at-the-window">At the window</a>
<a id="other" href="details.html" onclick="event.stopPropagation()">Details</a>
<div id="host" class="box"></div>
<script>
const on = (id, handler, options) => document.getElementById(id).addEventListener("click", handler, options);
on("at-once", (event) => event.stopImmediatePropagation());
document.addEventListener("click", (event) => { if (event.target.id === "down") event.stopPropagation(); }, true);
addEventListener("click", (event) => { if (event.target.id === "at-window") event.stopPropagation(); }, true);
const host = document.getElementById("host");
host.attachShadow({ mode: "closed" }).innerHTML = '<a href="app:closed-and-stopped" style="display:block;height:30px">Closed</a>';
host.addEventListener("click", (event) => event.stopPropagation());
</script>`,
		clicks: ["#stopped", "#at-once", "#bubble", "#down", "#at-window", "#other", "#host"],
		calls: [
			"open app:stopped",
			"open app:stopped-at-once",
			"open app:cancel-bubble",
			"open app:stopped-on-the-way-down",
			"open app:stopped-at-the-window",
			"open details.html",
			"open app:closed-and-stopped",
		],
	},
	"a click a passive handler stops, which nobody can take": {
		page: `<!doctype html>${style}<a id="at-once" href="more.html">More</a><a id="at-window" href="less.html">Less</a>
<svg width="120" height="40" xmlns:xlink="http://www.w3.org/1999/xlink"><a id="drawn" href="drawn.html" xlink:href="older.html"><rect width="120" height="40"></rect></a></svg>
<button id="report">Report</button>
<script>
const passive = { passive: true };
document.getElementById("at-once").addEventListener("click", (event) => event.stopImmediatePropagation(), passive);
document.getElementById("drawn").addEventListener("click", (event) => event.stopImmediatePropagation(), passive);
addEventListener("click", (event) => { if (event.target.id === "at-window") event.stopPropagation(); }, { capture: true, passive: true });
// Each link has its address again once its click is over.
document.getElementById("report").addEventListener("click", () => {
	const drawn = document.getElementById("drawn");
	qorpera.read("addresses: " + [document.getElementById("at-once").getAttribute("href"), document.getElementById("at-window").getAttribute("href"),
		drawn.getAttribute("href"), drawn.getAttributeNS("http://www.w3.org/1999/xlink", "href")].join(", "));
});
</script>`,
		clicks: ["#at-once", "#at-window", "#drawn rect", "#report"],
		calls: ["open more.html", "open less.html", "open drawn.html", "read addresses: more.html, less.html, drawn.html, older.html"],
	},
	"a click one handler stops and another one, on the same link, has after it": {
		page: `<!doctype html>${style}<a id="taken" href="app:stopped-then-taken">Taken</a><a id="refused" href="app:stopped-then-refused">Refused</a>
<a id="answered" href="app:stopped-then-answered-false">Answered false</a><a id="late" href="app:stopped-then-taken-by-a-late-handler">Late</a>
<a id="passive" href="app:stopped-then-a-passive-handler">Passive</a><a id="seen" href="app:stopped-then-left-alone">Left alone</a>
<script>
const on = (id, handler, options) => document.getElementById(id).addEventListener("click", handler, options);
for (const id of ["taken", "refused", "answered", "late", "passive", "seen"]) on(id, (event) => event.stopPropagation());
// The handler that still runs takes the click, each in a way of its own: the link is the page's, and nothing is sent.
on("taken", (event) => { event.preventDefault(); ${say("the next handler took it")}; });
on("refused", (event) => { event.returnValue = false; ${say("the next handler refused it")}; });
document.getElementById("answered").onclick = () => { ${say("the next handler answered false")}; return false; };
addEventListener("load", () => setTimeout(() => on("late", (event) => { event.preventDefault(); ${say("a handler added later took it")}; }), 50));
// A passive handler cannot take a click, whatever it calls: the browser would follow the link, so it is sent.
on("passive", (event) => { event.preventDefault(); ${say("a passive handler tried")}; }, { passive: true });
// And one that leaves the click alone sees a click nobody took, as it would without the frame.
on("seen", (event) => qorpera.read("the next handler sees taken: " + event.defaultPrevented + ", " + !event.returnValue));
</script>`,
		clicks: ["#taken", "#refused", "#answered", "#late", "#passive", "#seen"],
		calls: [
			"read the next handler took it",
			"read the next handler refused it",
			"read the next handler answered false",
			"read a handler added later took it",
			"read a passive handler tried",
			"open app:stopped-then-a-passive-handler",
			"read the next handler sees taken: false, false",
			"open app:stopped-then-left-alone",
		],
	},
	"a click a script made": {
		page: `<!doctype html>${style}<a id="app" href="app:sales">Sales</a><a id="web" href="https://example.com/">Site</a><a id="other" href="details.html">Details</a>
<a id="stopped" href="more.html" onclick="event.stopPropagation()">More</a>
<script>addEventListener("load", () => {
	// A click a script made is stopped on its way down: a handler of the page's reads it as taken already.
	document.getElementById("app").addEventListener("click", (event) => qorpera.read("a handler sees taken: " + event.defaultPrevented));
	for (const id of ["app", "web", "other", "stopped"]) {
		document.getElementById(id).click();
		document.getElementById(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
		// One that does not travel up to the window at all.
		document.getElementById(id).dispatchEvent(new MouseEvent("click", { cancelable: true }));
	}
	qorpera.read("open is " + typeof qorpera.open + ", and the page has " + Object.keys(qorpera).sort().join(","));
	setTimeout(() => ${say("still here")}, 300);
});</script>`,
		clicks: [],
		calls: [
			"read a handler sees taken: true",
			"read a handler sees taken: true",
			"read a handler sees taken: true",
			"read open is undefined, and the page has addRow,agents,answer,bytes,file,list,onChange,query,questions,read,reading,setRow,table,tell,todos,watch",
			"read still here",
		],
	},
	// A note to the app's owner (§5 "tell"): the frame document sends what it is about, the thing and the draft as plain
	// values, and nothing else the page puts on the object; the page cannot take the call away.
	"a note to the app's owner": {
		page: `<!doctype html><p>Orders</p><script>
qorpera.tell({ about: "Lund, A", at: 1043, text: "Get a quote", to: "someone else" });
qorpera.tell({ about: "Lund" });
try { qorpera.tell = () => null; } catch {}
qorpera.read("tell is still the frame's own: " + (qorpera.tell.toString().includes("call(") ? "yes" : "no"));
</script>`,
		clicks: [],
		calls: [
			'tell {"about":"Lund, A","at":"1043","text":"Get a quote"}',
			'tell {"about":"Lund","at":null,"text":null}',
			"read tell is still the frame's own: yes",
		],
	},
	"the page's other clicks are as they were": {
		page: `<!doctype html><input type="checkbox" id="kept"><input type="checkbox" id="free"><button id="quiet">Quiet</button><button id="loud">Loud</button>
<script>
document.getElementById("kept").addEventListener("click", (event) => event.preventDefault());
document.getElementById("quiet").addEventListener("click", (event) => { event.cancelBubble = true; });
document.addEventListener("click", (event) => {
	const id = event.target.id;
	if (id === "kept" || id === "free")
		setTimeout(() => qorpera.read(id + " box: taken " + event.defaultPrevented + ", answer " + event.returnValue + ", checked " + event.target.checked), 0);
	else qorpera.read(id + " reached the document");
});
</script>`,
		clicks: ["#kept", "#free", "#quiet", "#loud"],
		calls: [
			"read kept box: taken true, answer false, checked false",
			"read free box: taken false, answer true, checked true",
			"read loud reached the document",
		],
	},
	"a link in a shadow tree": {
		page: `<!doctype html>${style}<div id="host" class="box"></div><div id="open"></div><a id="around" href="app:around"><span id="inside-link"></span></a>
<div id="slot-open"><span id="in-open-slot" class="box">In an open tree's slot</span></div>
<div id="slot-closed"><span id="in-closed-slot" class="box">In a closed tree's slot</span></div>
<script>
document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = '<a href="app:closed" style="display:block;height:30px">Closed</a>';
document.getElementById("open").attachShadow({ mode: "open" }).innerHTML = '<a id="inside" href="app:open" style="display:block;height:30px">Open</a>';
document.getElementById("inside-link").attachShadow({ mode: "closed" }).innerHTML = '<b style="display:block;height:30px">Around</b>';
// The link is in the shadow tree, around a slot; what is clicked is the page's own node, put into that slot.
document.getElementById("slot-open").attachShadow({ mode: "open" }).innerHTML = '<a href="app:around-an-open-slot"><slot></slot></a>';
document.getElementById("slot-closed").attachShadow({ mode: "closed" }).innerHTML = '<a href="app:around-a-closed-slot"><slot></slot></a>';
</script>`,
		clicks: ["#host", "#inside", "#inside-link", "#in-open-slot", "#in-closed-slot"],
		calls: [
			"open app:closed",
			"open app:open",
			"open app:around",
			"open app:around-an-open-slot",
			"open app:around-a-closed-slot",
		],
	},
	"a link in a drawing": {
		page: `<!doctype html><svg width="300" height="120" xmlns:xlink="http://www.w3.org/1999/xlink">
<a href="app:chart"><rect id="bar" x="0" y="0" width="100" height="50"></rect></a>
<a xlink:href="app:older"><rect id="old" x="0" y="60" width="100" height="50"></rect></a></svg>
<map name="m"><area id="area" shape="rect" coords="0,0,100,40" href="folder:maps/route.md"></map>
<img usemap="#m" width="100" height="40" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='40'/%3E">`,
		clicks: ["#bar", "#old", "img"],
		calls: ["open app:chart", "open app:older", "open folder:maps/route.md"],
	},
	"the network stays closed, in the page and in its worker": {
		page: `<!doctype html><p>Closed</p><script>
const OUT = "OUTSIDE";
const ways = {};
const tried = (name, attempt) =>
	Promise.race([attempt(), new Promise((_, no) => setTimeout(no, 1500))]).then(() => { ways[name] = "reached"; }, () => { ways[name] = "closed"; });
const loads = (tag, attributes) => () => new Promise((yes, no) => {
	const element = document.createElement(tag);
	Object.assign(element, attributes);
	element.onload = yes;
	element.onerror = no;
	document.body.append(element);
});
const WORKER = ${JSON.stringify(WORKER_SOURCE)};
(async () => {
	await Promise.all([
	tried("fetch", () => fetch(OUT + "/fetch")),
	tried("fetch of the frame's own site", () => fetch("/page-preview/").then((answer) => answer.text())),
	tried("xhr", () => new Promise((yes, no) => { const x = new XMLHttpRequest(); x.open("GET", OUT + "/xhr"); x.onload = yes; x.onerror = no; x.send(); })),
	tried("websocket", () => new Promise((yes, no) => { const w = new WebSocket(OUT.replace("http", "ws") + "/ws"); w.onopen = yes; w.onerror = no; })),
	tried("eventsource", () => new Promise((yes, no) => { const e = new EventSource(OUT + "/es"); e.onopen = yes; e.onerror = () => { e.close(); no(); }; })),
	tried("img", loads("img", { src: OUT + "/img.png" })),
	tried("img https", loads("img", { src: "https://example.com/img.png" })),
	tried("link", loads("link", { rel: "stylesheet", href: OUT + "/style.css" })),
	tried("script", loads("script", { src: OUT + "/script.js" })),
	tried("script https", loads("script", { src: "https://example.com/script.js" })),
	tried("iframe", loads("iframe", { src: OUT + "/frame.html" })),
	tried("worker from the network", () => new Promise((yes, no) => { try { const w = new Worker(OUT + "/worker.js"); w.onerror = no; w.onmessage = yes; } catch (error) { no(error); } })),
	]);
	navigator.sendBeacon(OUT + "/beacon", "x");
	ways.rtc = Object.getOwnPropertyNames(window).filter((name) => /RTC/.test(name) && window[name] !== undefined).sort();
	const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
	ways.inWorker = await new Promise((done) => { worker.onmessage = (event) => done(event.data); worker.onerror = (event) => done("worker failed: " + event.message); setTimeout(() => done("worker silent"), 8000); });
	const sorted = (value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
	qorpera.read("network " + JSON.stringify(sorted(ways)));
})();
</script>`,
		clicks: [],
		wait: 6000,
		calls: [
			`read network ${JSON.stringify(sorted({
				fetch: "closed",
				"fetch of the frame's own site": "closed",
				xhr: "closed",
				websocket: "closed",
				eventsource: "closed",
				img: "closed",
				"img https": "closed",
				link: "closed",
				script: "closed",
				"script https": "closed",
				iframe: "closed",
				"worker from the network": "closed",
				rtc: [],
				inWorker: {
					ways: {
						fetch: "closed",
						xhr: "closed",
						websocket: "closed",
						eventsource: "closed",
						importScripts: "closed",
						worker: "closed",
					},
					rtc: [],
					nested: [],
				},
			}))}`,
		],
	},
	"other workers: a shared worker, a service worker and an audio worklet": {
		page: `<!doctype html><p>Workers</p><script>
const OUT = "OUTSIDE";
const seen = {};
const blob = (text) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
const PROBE = ${JSON.stringify(SHARED_PROBE)};
(async () => {
	seen.sharedWorker = await new Promise((done) => {
		try {
			const shared = new SharedWorker(blob(PROBE));
			shared.onerror = (event) => done("failed: " + (event.message || "error"));
			shared.port.onmessage = (event) => done(event.data);
			shared.port.start();
			setTimeout(() => done("silent"), 8000);
		} catch (error) {
			done("refused: " + error.name);
		}
	});
	seen.sharedWorkerName = typeof SharedWorker;
	seen.serviceWorker = await (async () => {
		try {
			if (!navigator.serviceWorker) return "absent";
			await navigator.serviceWorker.register(blob("self.onfetch = () => {};"));
			return "registered";
		} catch (error) {
			return "refused: " + error.name;
		}
	})();
	seen.audioWorklet = await (async () => {
		try {
			const context = new OfflineAudioContext(1, 128, 8000);
			await context.audioWorklet.addModule(blob(${JSON.stringify(WORKLET_PROBE)}));
			const node = new AudioWorkletNode(context, "probe");
			const said = new Promise((done) => (node.port.onmessage = (event) => done(event.data)));
			node.connect(context.destination);
			context.startRendering();
			return await Promise.race([said, new Promise((done) => setTimeout(() => done("silent"), 5000))]);
		} catch (error) {
			return "refused: " + error.name;
		}
	})();
	qorpera.read("other workers " + JSON.stringify(seen));
})();
</script>`,
		clicks: [],
		wait: 3000,
		calls: [
			`read other workers ${JSON.stringify({
				sharedWorker: "refused: TypeError",
				sharedWorkerName: "undefined",
				serviceWorker: "refused: SecurityError",
				audioWorklet: { reaches: [], rtc: [] },
			})}`,
		],
	},
	"a worker started past the guard, in the page and in a worker": {
		page: `<!doctype html><p>Past</p><script>
const PAST = ${JSON.stringify(PAST_GUARD)};
(async () => {
	const seen = await new Function(PAST + "return tryAll;")()();
	const outer = new Worker(URL.createObjectURL(new Blob([PAST + "tryAll().then(postMessage);"], { type: "text/javascript" })));
	seen.inWorker = await new Promise((done) => { outer.onmessage = (event) => done(event.data); outer.onerror = (event) => done("failed: " + event.message); });
	qorpera.read("past the guard " + JSON.stringify(seen));
})();
</script>`,
		clicks: [],
		wait: 2000,
		calls: [
			`read past the guard ${JSON.stringify({
				viaPrototype: [],
				viaInstance: [],
				viaReflect: [],
				viaApply: [],
				inWorker: { viaPrototype: [], viaInstance: [], viaReflect: [], viaApply: [] },
			})}`,
		],
	},
	"a page's own files: a font, a sound, a model, a worker and wasm": {
		page: `<!doctype html><style>@font-face { font-family: Brand; src: url("qorpera-file-${"a".repeat(32)}-ttf"); }</style>
<p style="font-family: Brand">Brand</p><img id="later" data-qorpera-src="dot.png" alt="">
<script>
const seen = {};
(async () => {
	seen.font = (await document.fonts.load("20px Brand")).length;
	const sound = new Audio("click.wav");
	seen.sound = await new Promise((done) => { sound.addEventListener("loadedmetadata", () => done(sound.duration > 0)); sound.addEventListener("error", () => done("failed")); });
	const decoded = await new OfflineAudioContext(1, 8000, 8000).decodeAudioData(await (await fetch("click.wav")).arrayBuffer());
	seen.decoded = decoded.duration > 0;
	const read = await (await fetch(new Request("model.glb", { headers: {} }))).arrayBuffer();
	seen.fetched = new TextDecoder().decode(new Uint8Array(read, 0, 4));
	seen.loaded = await new Promise((done) => {
		const request = new XMLHttpRequest();
		request.open("GET", "./model.glb", true);
		request.responseType = "arraybuffer";
		request.setRequestHeader("Accept", "*/*");
		request.onload = () => done(request.status + " " + new TextDecoder().decode(new Uint8Array(request.response, 0, 4)));
		request.onerror = () => done("failed");
		request.send(null);
	});
	seen.bytes = (await qorpera.bytes("model.glb")).byteLength;
	seen.address = (await qorpera.file("model.glb")).startsWith("blob:");
	const worker = new Worker(await qorpera.file("worker.js"));
	seen.worker = await new Promise((done) => { worker.onmessage = (event) => done(event.data); worker.onerror = () => done("failed"); });
	const { instance } = await WebAssembly.instantiateStreaming(fetch("add.wasm"));
	seen.wasm = instance.exports.add(2, 3);
	seen.missing = (await fetch("missing.bin")).status;
	seen.fresh = [await (await fetch("counter.txt")).text(), await (await fetch("counter.txt")).text()].join(",");
	seen.retried = await qorpera.file("flaky.txt").then(() => "first", () => qorpera.file("flaky.txt").then(() => "second", () => "never"));
	const later = document.getElementById("later");
	seen.later = await new Promise((done) => {
		if (later.complete && later.naturalWidth) done(later.naturalWidth);
		later.onload = () => done(later.naturalWidth);
		later.onerror = () => done("failed");
	});
	qorpera.read("files " + JSON.stringify(seen));
})();
</script>`,
		handed: { [`qorpera-file-${"a".repeat(32)}-ttf`]: "brand.ttf" },
		clicks: [],
		wait: 3000,
		calls: [
			`read files ${JSON.stringify({ font: 1, sound: true, decoded: true, fetched: "glTF", loaded: "200 glTF", bytes: 24, address: true, worker: "from a worker", wasm: 5, missing: 404, fresh: "1,2", retried: "second", later: 1 })}`,
		],
		console: ["Qorpera: missing.bin could not be loaded: missing.bin is not in the page's folder"],
	},
};

async function systemFont() {
	for (const folder of ["/usr/share/fonts", "/usr/local/share/fonts", "/System/Library/Fonts/Supplemental"]) {
		const found = await readdir(folder, { recursive: true }).catch(() => []);
		const font = found.find((name) => /\.ttf$/i.test(name));
		if (font) return readFile(join(folder, font));
	}
	throw new Error("No .ttf font found on this machine");
}
const wav = (() => {
	const samples = 1600;
	const bytes = Buffer.alloc(44 + samples * 2);
	bytes.write("RIFF", 0);
	bytes.writeUInt32LE(36 + samples * 2, 4);
	bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(8000, 24);
	bytes.writeUInt32LE(16000, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	bytes.writeUInt32LE(samples * 2, 40);
	for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / 4) * 8000), 44 + index * 2);
	return bytes;
})();
const glb = Buffer.concat([Buffer.from("glTF"), Buffer.from([2, 0, 0, 0, 28, 0, 0, 0, 8, 0, 0, 0]), Buffer.from("JSON{}  ")]);
const FILES = {
	"brand.ttf": ["font/ttf", await systemFont()],
	"click.wav": ["audio/wav", wav],
	"model.glb": ["model/gltf-binary", glb],
	"worker.js": ["text/javascript", Buffer.from('postMessage("from a worker");')],
	"add.wasm": [
		"application/wasm",
		Buffer.from("0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b", "hex"),
	],
	"dot.png": [
		"image/png",
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		),
	],
};

const folderParent = await build({
	stdin: {
		contents: `import { assembleApp, PageFiles } from ${JSON.stringify(join(web, "src/app/interface-apps.ts"))};
import { AppFrame } from ${JSON.stringify(join(web, "src/ui/app-frame.ts"))};
window.calls = [];
window.left = 0;
window.at = {};
const t0 = performance.now();
const tree = await (await fetch("/tree/" + encodeURIComponent(new URLSearchParams(location.search).get("m")))).json();
const wait = () => new Promise((done) => setTimeout(done, tree.delay));
const entryOf = (path) => {
	const file = tree.files[path];
	return file
		? { path, kind: "file", version: "00000000-0000-4000-8000-000000000001", seq: 1, updatedAt: "2026-11-18T00:00:00Z", target: null,
			file: { manifestSha256: file.manifest, fileSha256: file.sha, bytes: file.bytes, mediaType: "application/octet-stream", executable: false } }
		: null;
};
const folder = {
	read: async (path) => { await wait(); return { asOfSeq: 1, entry: entryOf(path) }; },
	readMany: async (paths) => { await wait(); return paths.map((path) => ({ asOfSeq: 1, entry: entryOf(path) })); },
	list: async () => ({ asOfSeq: 1, entries: [], next: null }),
	readFile: async (file) => { await wait(); return new Uint8Array(await (await fetch("/bytes/" + file.fileSha256)).arrayBuffer()); },
};
const signal = new AbortController().signal;
const assembled = await assembleApp(folder, { path: tree.root, entry: "index.html" }, signal);
window.assembledAt = Math.round(performance.now() - t0);
if (!assembled.ok) window.calls.push("not live " + assembled.message);
else {
	const files = new PageFiles(folder, tree.root, signal);
	const frame = new AppFrame(assembled.framed, "App", tree.alone ? "page" : "app", async (call) => {
		if (call.method === "file") return files.answer(call);
		window.calls.push(call.method + " " + call.params.path);
		window.at[call.params.path] = Math.round(performance.now() - t0);
		return { ok: true, value: "" };
	}, () => { window.left++; }, { again: tree.alone });
	frame.frame.style.cssText = "width: 800px; height: 600px; border: 0";
	document.body.append(frame.frame);
}`,
		resolveDir: repository,
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	write: false,
	logLevel: "silent",
});

let unpacked = null;
let three = process.env.THREE_PACKAGE;
if (!three) {
	unpacked = await mkdtemp(join(tmpdir(), "three-"));
	execFileSync("npm", ["pack", `three@${OBJECT_THREE_VERSION}`, "--pack-destination", unpacked, "--silent"]);
	execFileSync("tar", ["xzf", join(unpacked, `three-${OBJECT_THREE_VERSION}.tgz`), "-C", unpacked]);
	three = join(unpacked, "package");
}
assert.equal(JSON.parse(await readFile(join(three, "package.json"), "utf8")).version, OBJECT_THREE_VERSION);
const stock = (path) => readFile(join(three, path));

const redBox = (() => {
	const corners = [-0.6, 0.6];
	const positions = [];
	for (const axis of [0, 1, 2])
		for (const side of corners) {
			const square = [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]];
			for (const [u, v] of side > 0 ? square : square.reverse()) {
				const point = [0, 0, 0];
				point[axis] = side;
				point[(axis + 1) % 3] = u;
				point[(axis + 2) % 3] = v;
				positions.push(...point);
			}
		}
	const bin = Buffer.from(new Float32Array(positions).buffer);
	const json = Buffer.from(
		JSON.stringify({
			asset: { version: "2.0" },
			extensionsUsed: ["KHR_materials_unlit"],
			buffers: [{ byteLength: bin.length }],
			bufferViews: [{ buffer: 0, byteLength: bin.length, target: 34962 }],
			accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min: [-0.6, -0.6, -0.6], max: [0.6, 0.6, 0.6] }],
			materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] }, doubleSided: true, extensions: { KHR_materials_unlit: {} } }],
			meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
			nodes: [{ mesh: 0, rotation: [0.2, 0.3, 0, 0.933] }],
			scenes: [{ nodes: [0] }],
			scene: 0,
		}),
	);
	const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
	const part = (type, data) => {
		const head = Buffer.alloc(8);
		head.writeUInt32LE(data.length, 0);
		head.writeUInt32LE(type, 4);
		return Buffer.concat([head, data]);
	};
	const head = Buffer.alloc(12);
	head.write("glTF", 0);
	head.writeUInt32LE(2, 4);
	head.writeUInt32LE(12 + 8 + padded.length + 8 + bin.length, 8);
	return Buffer.concat([head, part(0x4e4f534a, padded), part(0x004e4942, bin)]);
})();
const sky = Buffer.concat([Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n"), Buffer.from(Array(4).fill([128, 128, 128, 129]).flat())]);
const DRAW = `const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
renderer.setSize(320, 240, false);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 320 / 240, 0.1, 100);
camera.position.set(0, 0, 4);
const drawn = (gltf, sky) => {
	sky.mapping = THREE.EquirectangularReflectionMapping;
	scene.environment = sky;
	scene.add(gltf.scene);
	renderer.render(scene, camera);
	const gl = renderer.getContext();
	const pixel = new Uint8Array(4);
	gl.readPixels(160, 120, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
	document.getElementById("state").remove();
	return (pixel[0] > 200 && pixel[1] < 40 && pixel[2] < 40 ? "red" : pixel.join(",")) + " sky " + sky.image.width + "x" + sky.image.height;
};`;
const KLOKKESTEN = {
	"index.html": `<!doctype html><html lang="da"><head><meta charset="utf-8"><title>Klokkesten</title>
<script type="importmap">{ "imports": { "three": "./vendor/three.module.js" } }</script>
<style>body { margin: 0; background: #111; color: #eee } canvas { display: block }</style></head>
<body><p id="state">Åbner modellen …</p><script type="module" src="./viewer.js"></script></body></html>`,
	"viewer.js": `import * as THREE from 'three';
import {GLTFLoader} from './vendor/GLTFLoader.js';
import {RGBELoader} from './vendor/RGBELoader.js';
qorpera.read("ran");
${DRAW}
const meta = import.meta.url.replace(new URL("./", location.href).href, "./");
Promise.all([
	new Promise((done, failed) => new GLTFLoader().load("./model.glb", done, undefined, failed)),
	new Promise((done, failed) => new RGBELoader().load(new URL("./sky.hdr", import.meta.url).href, done, undefined, failed)),
]).then(([gltf, sky]) => qorpera.read("drawn " + drawn(gltf, sky) + " three " + THREE.REVISION + " meta " + meta), (error) => qorpera.read("failed " + error.message));
`,
	"vendor/three.module.js": () => stock("build/three.module.js"),
	"vendor/three.core.js": () => stock("build/three.core.js"),
	"vendor/GLTFLoader.js": () => stock("examples/jsm/loaders/GLTFLoader.js"),
	"vendor/RGBELoader.js": () => stock("examples/jsm/loaders/RGBELoader.js"),
	"vendor/HDRLoader.js": () => stock("examples/jsm/loaders/HDRLoader.js"),
	"vendor/BufferGeometryUtils.js": () => stock("examples/jsm/utils/BufferGeometryUtils.js"),
	"utils/BufferGeometryUtils.js": () => stock("examples/jsm/utils/BufferGeometryUtils.js"),
	"utils/SkeletonUtils.js": () => stock("examples/jsm/utils/SkeletonUtils.js"),
	"model.glb": redBox,
	"sky.hdr": sky,
};
const DRAWN = /^read drawn red sky 2x2 three 186 meta \.\/viewer\.js$/;
const MODULE_WORKER = `const ask = (address) => new Promise((done) => {
	const worker = new Worker(address, { type: "module" });
	worker.onmessage = (event) => done(event.data);
	worker.onerror = (event) => { event.preventDefault(); done("failed"); };
	setTimeout(() => done("silent"), 4000);
});`;
const folderVariants = {
	"a page in the shape of Klokkesten's 3D page, as an app": { root: "apps/klokkesten-i-haanden", files: KLOKKESTEN, calls: ["read ran", DRAWN] },
	"the same page opened by itself": { root: "marketing/klokkesten", alone: true, files: KLOKKESTEN, calls: ["read ran", DRAWN] },
	"the same page with the kit's classic three.js": {
		root: "apps/klokkesten-classic",
		files: {
			"index.html": `<!doctype html><html lang="da"><head><meta charset="utf-8"><title>Klokkesten</title>
<style>body { margin: 0; background: #111; color: #eee } canvas { display: block }</style></head>
<body><p id="state">Åbner modellen …</p><script src="three.js"></script><script>
qorpera.read("ran");
const THREE = QORPERA_THREE;
${DRAW}
Promise.all([
	new Promise((done, failed) => new THREE.GLTFLoader().load("./model.glb", done, undefined, failed)),
	new Promise((done, failed) => new THREE.HDRLoader().load("./sky.hdr", done, undefined, failed)),
]).then(([gltf, sky]) => qorpera.read("drawn " + drawn(gltf, sky) + " three " + THREE.REVISION + " meta ./viewer.js"), (error) => qorpera.read("failed " + error.message));
</script></body></html>`,
			"three.js": () => readFile(join(repository, "packages/runtime/kits/object/vendor/three.js")),
			"model.glb": redBox,
			"sky.hdr": sky,
		},
		calls: ["read ran", DRAWN],
	},
	"module imports: nested, cyclic, dynamic, mapped, workers and refusals": {
		root: "apps/modules",
		beside: { "apps/secret.js": 'qorpera.read("secret ran");' },
		files: {
			"index.html": `<!doctype html><meta charset="utf-8"><p>Modules</p>
<script type="importmap">{ "imports": { "util": "./lib/util.js", "lib/": "./lib/", "@/": "./" } }</script>
<script type="module" src="./main.js"></script>
<script type="module">import "OUTSIDE/m-static.js"; qorpera.read("https ran");</script>
<script type="module">import "lodash"; qorpera.read("lodash ran");</script>
<script type="module">import "../secret.js"; qorpera.read("outside ran");</script>
<script type="module">import "./gone.js"; qorpera.read("gone ran");</script>
<script type="module">import notes from "./notes.txt" with { type: "text" }; qorpera.read("text ran");</script>
<script type="module">import { a } from "./a.js"; qorpera.read("inline " + a + " " + globalThis.order.filter((name) => name === "a").length);</script>`,
			"main.js": `import { a, fromB } from "./a.js";
import { deep } from "./n1.js";
import { u } from "util";
import { p } from "lib/prefixed.js";
import "./side.js";
import { again } from "./again.js";
import { deep as viaRoot } from "@/sub/n3.js";
import config from "./config.json" with { type: "json" };
import sheet from "./look.css" with { type: "css" };
import { odd } from "./two%20words/m%C3%B8de%20%26%20co.js";
${MODULE_WORKER}
document.adoptedStyleSheets = [sheet];
const more = await import("./more.json", { with: { type: "json" } });
const dyn = await import("./dyn.js");
const plain = await import(await qorpera.file("plain.js"));
let stack;
try {
	(await import("./thrower.js")).boom();
} catch (error) {
	stack = String(error.stack).split("\\n").find((line) => line.includes("thrower"));
}
const seen = {
	order: globalThis.order.join(","),
	cycle: a + fromB() + globalThis.seesA(),
	deep, u, again, data: await p, dyn: dyn.dyn, plain: plain.plain,
	meta: globalThis.meta,
	stack: stack.trim(),
	worker: await ask(await qorpera.file("worker-plain.js")),
	workerImports: await ask(await qorpera.file("worker-imports.js")),
	bigWorker: await ask(await qorpera.file("worker-big.js")),
	hugeWorker: await ask(await qorpera.file("worker-huge.js")),
	root: viaRoot,
	json: config.name + " " + more.default.count,
	css: getComputedStyle(document.querySelector("p")).color,
	odd: await odd,
};
qorpera.read("cases " + JSON.stringify(seen));
`,
			"a.js": `import { b, seesA } from "./deep/b.js";
(globalThis.order ??= []).push("a");
globalThis.seesA = seesA;
export const a = "a";
export const fromB = () => b;
`,
			"deep/b.js": `import { a } from "../a.js";
(globalThis.order ??= []).push("b");
export const b = "b";
export const seesA = () => a;
`,
			"n1.js": `export { deep } from "./sub/n2.js";\n(globalThis.order ??= []).push("n1");\n`,
			"sub/n2.js": `import { deep } from "./n3.js";\n(globalThis.order ??= []).push("n2");\nexport { deep };\n`,
			"sub/n3.js": `(globalThis.order ??= []).push("n3");\nexport const deep = "n3";\n`,
			"lib/util.js": `(globalThis.order ??= []).push("util");\nglobalThis.meta = import.meta.url.replace(new URL("./", location.href).href, "./");\nexport const u = "util";\n`,
			"lib/prefixed.js": `import { u } from "lib/util.js";
(globalThis.order ??= []).push("prefixed");
export const p = fetch(new URL("./data.txt", import.meta.url)).then((answer) => answer.text()).then((text) => text + " " + u);
`,
			"lib/data.txt": "beside lib",
			"side.js": `(globalThis.order ??= []).push("side");\n`,
			"again.js": `export { u as again } from "util";\n(globalThis.order ??= []).push("again");\n`,
			"dyn.js": `(globalThis.order ??= []).push("dyn");\nexport const dyn = "dyn";\n`,
			"plain.js": `export const plain = "plain";\n`,
			"thrower.js": `export function boom() {\n\tthrow new Error("boom");\n}\n`,
			"worker-plain.js": `postMessage(["plain", Object.getOwnPropertyNames(self).filter((name) => /RTC/.test(name) && self[name] !== undefined)]);\n`,
			"worker-imports.js": `import { dep } from "./worker-dep.js";\npostMessage(["imports", dep]);\n`,
			"worker-dep.js": `export const dep = "dep";\n`,
			"worker-big.js": `postMessage("big");\n//${"é".repeat(700_000)}\n`,
			"worker-huge.js": `postMessage("huge");\n//${"x".repeat(2_500_000)}\n`,
			"config.json": `{ "name": "klokkesten" }\n`,
			"more.json": `{ "count": 3 }`,
			"look.css": "p { color: rgb(1, 2, 3); }",
			"notes.txt": "notes",
			"two words/møde & co.js": `export const odd = fetch(new URL("./near.txt", import.meta.url)).then((answer) => answer.text()).then((text) => text + " " + import.meta.url.replace(new URL("./", location.href).href, "./"));\n`,
			"two words/near.txt": "near",
		},
		calls: [
			"read inline a 1",
			`read cases ${JSON.stringify({
				order: "b,a,n3,n2,n1,util,prefixed,side,again,dyn",
				cycle: "aba",
				deep: "n3",
				u: "util",
				again: "util",
				data: "beside lib util",
				dyn: "dyn",
				plain: "plain",
				meta: "./lib/util.js",
				stack: "at Module.boom (qorpera-module:/thrower.js:2:8)",
				worker: ["plain", []],
				workerImports: "failed",
				bigWorker: "big",
				hugeWorker: "failed",
				root: "n3",
				json: "klokkesten 3",
				css: "rgb(1, 2, 3)",
				odd: "near ./two%20words/m%C3%B8de%20%26%20co.js",
			})}`,
		],
		console: [
			"Qorpera: the page imports OUTSIDE/m-static.js, which is not a file of the page's folder",
			"Qorpera: the page imports lodash, which the page's import map does not name",
			"Qorpera: the page imports ../secret.js, which is outside the page's folder",
			"Qorpera: the page imports ./gone.js, which is not in the page's folder",
			"Qorpera: the page imports ./notes.txt as text, which a page can't import",
			/^Qorpera: a module worker of 24\d\d KiB is too large to start here \(at most 1,532 KiB\)$/,
		],
	},
	"a module page and a module worker stay off the network": {
		root: "apps/module-network",
		files: {
			"index.html": `<!doctype html><meta charset="utf-8"><p>Network</p><script type="module">
${MODULE_WORKER}
const OUT = "OUTSIDE";
const ways = {};
const tried = (name, attempt) =>
	Promise.race([attempt(), new Promise((_, no) => setTimeout(no, 1500))]).then(() => { ways[name] = "reached"; }, () => { ways[name] = "closed"; });
await Promise.all([
	tried("dynamic import", () => import(OUT + "/m-dynamic.js")),
	tried("fetch", () => fetch(OUT + "/m-fetch")),
	tried("import of a mapped name", () => import("outside")),
]);
const seen = {
	ways: Object.fromEntries(Object.entries(ways).sort()),
	rtc: Object.getOwnPropertyNames(window).filter((name) => /RTC/.test(name) && window[name] !== undefined),
	worker: await ask(await qorpera.file("probe.js")),
	staticWorker: await ask(await qorpera.file("static.js")),
};
qorpera.read("network " + JSON.stringify(seen));
</script>
<script type="importmap">{ "imports": { "outside": "OUTSIDE/m-mapped.js" } }</script>
<script type="module">import "OUTSIDE/m-static.js"; qorpera.read("static ran");</script>`,
			"probe.js": `const OUT = "OUTSIDE";
const ways = {};
const tried = (name, attempt) =>
	Promise.race([attempt(), new Promise((_, no) => setTimeout(no, 1500))]).then(() => { ways[name] = "reached"; }, () => { ways[name] = "closed"; });
await Promise.all([
	tried("dynamic import", () => import(OUT + "/w-dynamic.js")),
	tried("fetch", () => fetch(OUT + "/w-fetch")),
	tried("websocket", () => new Promise((yes, no) => { const w = new WebSocket(OUT.replace("http", "ws") + "/w-ws"); w.onopen = yes; w.onerror = no; })),
]);
postMessage({ ways: Object.fromEntries(Object.entries(ways).sort()), rtc: Object.getOwnPropertyNames(self).filter((name) => /RTC/.test(name) && self[name] !== undefined) });
`,
			"static.js": `import "OUTSIDE/w-static.js";\npostMessage("ran");\n`,
		},
		calls: [
			`read network ${JSON.stringify({
				ways: { "dynamic import": "closed", fetch: "closed", "import of a mapped name": "closed" },
				rtc: [],
				worker: { ways: { "dynamic import": "closed", fetch: "closed", websocket: "closed" }, rtc: [] },
				staticWorker: "failed",
			})}`,
		],
		console: [
			"Qorpera: the page imports outside, which the page's import map names outside its folder",
			"Qorpera: the page imports OUTSIDE/m-static.js, which is not a file of the page's folder",
		],
	},
};
const FOLDER_DELAY_MS = Number(process.env.FOLDER_DELAY_MS ?? 0);
const folderBytes = new Map();
async function treeOf(name) {
	const variant = folderVariants[name];
	const files = {};
	for (const [path, made] of Object.entries(variant.files)) {
		const value = typeof made === "function" ? await made() : made;
		const bytes = typeof value === "string" ? Buffer.from(value.replaceAll("OUTSIDE", OUTSIDE)) : value;
		const sha = createHash("sha256").update(bytes).digest("hex");
		folderBytes.set(sha, bytes);
		const full = `${variant.root}/${path}`;
		files[full] = { sha, manifest: createHash("sha256").update(full).digest("hex"), bytes: bytes.length };
	}
	for (const [full, text] of Object.entries(variant.beside ?? {})) {
		const bytes = Buffer.from(text);
		const sha = createHash("sha256").update(bytes).digest("hex");
		folderBytes.set(sha, bytes);
		files[full] = { sha, manifest: createHash("sha256").update(full).digest("hex"), bytes: bytes.length };
	}
	return { root: variant.root, alone: variant.alone === true, delay: FOLDER_DELAY_MS, files };
}
function sameCalls(made, expected) {
	const left = [...made];
	for (const one of expected) {
		const at = left.findIndex((call) => (one instanceof RegExp ? one.test(call) : call === one));
		if (at === -1) return false;
		left.splice(at, 1);
	}
	return left.length === 0;
}

const outsideHits = [];
const outside = createServer((request, response) => {
	outsideHits.push(request.url);
	response.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
	response.end("reached");
});
outside.on("upgrade", (request, socket) => {
	outsideHits.push(`upgrade ${request.url}`);
	socket.destroy();
});
await new Promise((done) => outside.listen(0, "127.0.0.1", done));
const OUTSIDE = `http://127.0.0.1:${outside.address().port}`;

let origin;
const server = createServer((request, response) => {
	const path = new URL(request.url, "http://x").pathname;
	const send = (type, body) => {
		response.writeHead(200, { ...headersFor(path), "content-type": type, "cache-control": "no-store" });
		response.end(body);
	};
	if (path === "/") {
		const script = new URL(request.url, "http://x").searchParams.has("m") ? "/folder-parent.js" : "/parent.js";
		send("text/html", `<!doctype html><meta charset="utf-8"><title>App</title><script type="module" src="${script}"></script>`);
	} else if (path === "/parent.js") send("text/javascript", parent.outputFiles[0].contents);
	else if (path === "/folder-parent.js") send("text/javascript", folderParent.outputFiles[0].contents);
	else if (path.startsWith("/tree/"))
		treeOf(decodeURIComponent(path.slice(6))).then((tree) => send("application/json", JSON.stringify(tree)));
	else if (path.startsWith("/bytes/") && folderBytes.has(path.slice(7)))
		send("application/octet-stream", folderBytes.get(path.slice(7)));
	else if (path.startsWith("/variant/")) {
		const variant = variants[decodeURIComponent(path.slice(9))];
		send("application/json", JSON.stringify({ page: variant.page.replaceAll("OUTSIDE", OUTSIDE), handed: variant.handed }));
	} else if (path.startsWith("/file/") && FILES[path.slice(6)]) send(...FILES[path.slice(6)]);
	else if (path === "/page-preview/") send("text/html", frameDocument);
	else {
		response.writeHead(404);
		response.end();
	}
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const pages = [
	...Object.entries(variants).map(([name, variant]) => [name, variant, `?v=${encodeURIComponent(name)}`]),
	...Object.entries(folderVariants).map(([name, variant]) => [
		name,
		{
			...variant,
			wait: 1000,
			console: (variant.console ?? []).map((line) => (typeof line === "string" ? line.replaceAll("OUTSIDE", OUTSIDE) : line)),
		},
		`?m=${encodeURIComponent(name)}`,
	]),
];
const failures = [];
let browser;
try {
	browser = await chromium.launch({ executablePath, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
	const context = await browser.newContext();
	const page = await context.newPage();
	// A tab the page opened, or a place the frame went, would show here.
	let tabs = 0;
	context.on("page", () => tabs++);
	const elsewhere = [];
	context.on("requestfinished", (request) => {
		if (!request.url().startsWith(`${origin}/`)) elsewhere.push(request.url());
	});
	const said = [];
	page.on("console", (message) => said.push(message.text()));
	for (const [name, variant, query] of pages) {
		if (process.env.ONLY && process.env.ONLY !== name) continue;
		elsewhere.length = 0;
		const loads = [];
		const loaded = (frame) => {
			if (frame !== page.mainFrame()) loads.push(frame.url());
		};
		page.on("framenavigated", loaded);
		await page.goto(`${origin}/${query}`);
		const frame = page.frameLocator("iframe");
		let lost = null;
		try {
			await frame.locator("body").waitFor({ timeout: 5000 });
			await sleep(300);
			for (const target of variant.clicks ?? []) {
				// Where the element is, whatever is hit there: a link inside a closed shadow tree, an image map's area.
				await frame.locator(target).click({ timeout: 5000, force: true });
				await sleep(150);
			}
			if (variant.keys) {
				await frame.locator(variant.keys[0]).focus();
				await page.keyboard.press(variant.keys[1]);
			}
		} catch (error) {
			// The page is gone from the frame: what was to be clicked is not there.
			lost = error.message.split("\n")[0];
		}
		await sleep(variant.wait ?? 700);
		if (variant.wait)
			await page
				.waitForFunction((count) => window.calls.length >= count, variant.calls.length, { timeout: 60_000 })
				.catch(() => {});
		const made = await page.evaluate(() => window.calls);
		const folder = query.startsWith("?m=");
		if (folder) console.log(`${name}: timing ${JSON.stringify(await page.evaluate(() => ({ assembled: window.assembledAt, ...window.at })))}`);
		const seen = {
			lost,
			calls: folder && sameCalls(made, variant.calls) ? variant.calls : made,
			left: await page.evaluate(() => window.left),
			// The frame document and nowhere else: the page is written into it, and a jump inside the page stays in it.
			places: [...new Set(loads.map((url) => new URL(url).pathname))],
			tabs,
			outside: [...outsideHits],
			elsewhere: elsewhere.filter((url) => !/^(?:blob|data):/.test(url)),
			told: (variant.console ?? []).filter((line) => !said.some((one) => (line instanceof RegExp ? line.test(one) : one === line))),
		};
		page.off("framenavigated", loaded);
		console.log(`${name}: ${JSON.stringify(seen)}`);
		try {
			assert.deepEqual(seen, {
				lost: null,
				calls: variant.calls,
				left: 0,
				places: ["/page-preview/"],
				tabs: 0,
				outside: [],
				elsewhere: [],
				told: [],
			});
		} catch (error) {
			failures.push(`${name}: ${error.message.split("\n")[0]} ${JSON.stringify(seen)} console ${JSON.stringify(said.slice(-12))}`);
		}
	}
} finally {
	await browser?.close();
	server.close();
	outside.close();
	if (unpacked) await rm(unpacked, { recursive: true, force: true });
}
if (failures.length) {
	console.log(`FAILED:\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`app frame browser checks passed (${process.env.ONLY ? 1 : pages.length} pages)`);
