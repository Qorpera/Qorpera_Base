// An interface app's links, run in real Chromium the way the web app runs an app: the app's own frame code
// (packages/web/src/ui/app-frame.ts) in a page under the site's policy, the frame document
// (packages/web/public/page-preview/index.html) under its rule from packages/web/public/_headers. Clicks are the
// browser's own (trusted), which no unit test can make. Checks, for each kind of link a page can write: which clicks
// reach the app as an `open` call on the port and with what address, that a click a script made reaches nothing, that
// what is the page's own stays the page's (a jump inside the page, its own script, a click its handler took), and that
// the frame never leaves the page it was handed, whatever was clicked (deploy/first-node/RUNTIME-INTERFACE-APPS.md §4).
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
const style = "<style>a, #host { display: block; height: 30px; } svg { display: block; }</style>";
const variants = {
	"the links a page writes": {
		page: `<!doctype html>${style}<a id="app" href="app:sales">Sales</a><a id="file" href="folder:strategy/plan%202027.md">Plan</a>
<a id="web" href="https://example.com/pricing?plan=team" target="_blank">Site</a><a id="spaced" href="  app:hiring ">Hiring</a>
<a id="other" href="details.html">Details</a><a id="empty" href="">Again</a><a id="mail" href="mailto:a@example.com">Mail</a>
<a id="inner" href="app:deep"><b><i id="deep">Deep</i></b></a>`,
		clicks: ["#app", "#file", "#web", "#spaced", "#other", "#empty", "#mail", "#deep"],
		calls: [
			"open app:sales",
			"open folder:strategy/plan%202027.md",
			"open https://example.com/pricing?plan=team",
			"open   app:hiring ",
			"open details.html",
			"open ",
			"open mailto:a@example.com",
			"open app:deep",
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
<a id="late" href="app:hiring">Late</a><a id="plain" name="bottom">No address</a><p id="text">Text</p>
<script>document.addEventListener("click", (event) => { if (event.target.id === "late") { event.preventDefault(); ${say("document took it")}; } });</script>`,
		clicks: ["#jump", "#script", "#taken", "#late", "#plain", "#text"],
		// The javascript: address is left to the browser, as before, and Chromium runs none in this frame: nothing is
		// sent for it, and nothing runs.
		calls: ["read page took it", "read document took it"],
	},
	"a click a script made": {
		page: `<!doctype html>${style}<a id="app" href="app:sales">Sales</a><a id="web" href="https://example.com/">Site</a><a id="other" href="details.html">Details</a>
<script>addEventListener("load", () => {
	for (const id of ["app", "web", "other"]) {
		document.getElementById(id).click();
		document.getElementById(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
	}
	qorpera.read("open is " + typeof qorpera.open + ", and the page has " + Object.keys(qorpera).sort().join(","));
	setTimeout(() => ${say("still here")}, 300);
});</script>`,
		clicks: [],
		calls: ["read open is undefined, and the page has agents,list,onChange,read,table,todos", "read still here"],
	},
	"a link in a shadow tree": {
		page: `<!doctype html>${style}<div id="host"></div><div id="open"></div><a id="around" href="app:around"><span id="slot"></span></a>
<script>
document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = '<a href="app:closed" style="display:block;height:30px">Closed</a>';
document.getElementById("open").attachShadow({ mode: "open" }).innerHTML = '<a id="inside" href="app:open" style="display:block;height:30px">Open</a>';
document.getElementById("slot").attachShadow({ mode: "closed" }).innerHTML = '<b style="display:block;height:30px">Around</b>';
</script>`,
		clicks: ["#host", "#inside", "#slot"],
		calls: ["open app:closed", "open app:open", "open app:around"],
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
