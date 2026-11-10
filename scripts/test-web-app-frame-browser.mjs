// An interface app's links, run in real Chromium the way the web app runs an app: the app's own frame code
// (packages/web/src/ui/app-frame.ts) in a page under the site's policy, the frame document
// (packages/web/public/page-preview/index.html) under its rule from packages/web/public/_headers. Clicks are the
// browser's own (trusted), which no unit test can make. Checks, for each kind of link a page can write: which clicks
// reach the app as an `open` call on the port and with what address, that a click a script made reaches nothing, that
// what is the page's own stays the page's (a jump inside the page, a click a handler of the page took, wherever and
// whenever that handler was added), that a click a handler stops from travelling on is still heard, and sent only if
// no handler that still runs takes it (and a passive one cannot), that clicks on anything but a link are as they
// were, and that the frame never leaves the page it was handed, whatever was clicked
// (deploy/first-node/RUNTIME-INTERFACE-APPS.md §4).
// Usage: QORPERA_WEB_TEST_BROWSER=<Chromium> node scripts/test-web-app-frame-browser.mjs
// APP_FRAME_DOCUMENT=<file> serves another frame document (to see a weaker one fail); ONLY=<name> runs one page.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

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
const { page } = await (await fetch("/variant/" + new URLSearchParams(location.search).get("v"))).json();
const frame = new AppFrame(page, "App", "app", async (call) => {
	window.calls.push(call.method === "open" ? "open " + call.params.href : call.method + " " + call.params.path);
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
			"read open is undefined, and the page has agents,list,onChange,read,table,todos",
			"read still here",
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
};

let origin;
const server = createServer((request, response) => {
	const path = new URL(request.url, "http://x").pathname;
	const send = (type, body) => {
		response.writeHead(200, { ...headersFor(path), "content-type": type, "cache-control": "no-store" });
		response.end(body);
	};
	if (path === "/") send("text/html", '<!doctype html><meta charset="utf-8"><title>App</title><script type="module" src="/parent.js"></script>');
	else if (path === "/parent.js") send("text/javascript", parent.outputFiles[0].contents);
	else if (path.startsWith("/variant/")) send("application/json", JSON.stringify({ page: variants[decodeURIComponent(path.slice(9))].page }));
	else if (path === "/page-preview/") send("text/html", frameDocument);
	else {
		response.writeHead(404);
		response.end();
	}
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const failures = [];
let browser;
try {
	browser = await chromium.launch({ executablePath });
	const context = await browser.newContext();
	const page = await context.newPage();
	// A tab the page opened, or a place the frame went, would show here.
	let tabs = 0;
	context.on("page", () => tabs++);
	for (const [name, variant] of Object.entries(variants)) {
		if (process.env.ONLY && process.env.ONLY !== name) continue;
		const loads = [];
		const loaded = (frame) => {
			if (frame !== page.mainFrame()) loads.push(frame.url());
		};
		page.on("framenavigated", loaded);
		await page.goto(`${origin}/?v=${encodeURIComponent(name)}`);
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
		await sleep(700);
		const seen = {
			lost,
			calls: await page.evaluate(() => window.calls),
			left: await page.evaluate(() => window.left),
			// The frame document and nowhere else: the page is written into it, and a jump inside the page stays in it.
			places: [...new Set(loads.map((url) => new URL(url).pathname))],
			tabs,
		};
		page.off("framenavigated", loaded);
		console.log(`${name}: ${JSON.stringify(seen)}`);
		try {
			assert.deepEqual(seen, { lost: null, calls: variant.calls, left: 0, places: ["/page-preview/"], tabs: 0 });
		} catch (error) {
			failures.push(`${name}: ${error.message.split("\n")[0]} ${JSON.stringify(seen)}`);
		}
	}
} finally {
	await browser?.close();
	server.close();
}
if (failures.length) {
	console.log(`FAILED:\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`app frame browser checks passed (${process.env.ONLY ? 1 : Object.keys(variants).length} pages)`);
