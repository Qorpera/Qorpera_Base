// An HTML page from the Company File, run in real Chromium the way the web app runs it: the app's own frame code
// (packages/web/src/ui/page-frame.ts) in a page under the site's policy, the frame document
// (packages/web/public/page-preview/index.html) under its rule from packages/web/public/_headers. Checks that the page's
// own inline styles and scripts run and that nothing it tries reaches the network: requests, a WebSocket, WebRTC (also
// from a frame inside the page, in a shadow tree made by script, cloned or declared in any way markup can) and the
// link hints in its markup. Each attempt aims at a listener here (HTTP, a STUN
// port on UDP, a TCP port), and Chrome's net log shows every host name it looked up.
// Usage: QORPERA_WEB_TEST_BROWSER=<Chromium> node scripts/test-web-page-frame-browser.mjs
// PAGE_FRAME_DOCUMENT=<file> serves another frame document (to see a weaker one fail).
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const executablePath = process.env.QORPERA_WEB_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_WEB_TEST_BROWSER to an existing Chromium executable");
const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const web = join(repository, "packages/web");
const frameDocument = await readFile(process.env.PAGE_FRAME_DOCUMENT ?? join(web, "public/page-preview/index.html"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The site's headers for a path, as Pages applies public/_headers: matching rules in order, `! Name` detaches. The
 * connect-src marker is the build's; upgrade-insecure-requests and HSTS mean nothing on plain http here. */
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

// The app's side: the frame code as the web app ships it, in a page that hands the frame the variant's page.
const parent = await build({
	stdin: {
		contents: `import { PageFrames } from ${JSON.stringify(join(web, "src/ui/page-frame.ts"))};
window.reports = [];
addEventListener("message", (event) => { if (event.data && typeof event.data.probe === "string") window.reports.push(event.data.probe); });
const variant = new URLSearchParams(location.search).get("v");
const { page } = await (await fetch("/variant/" + variant)).json();
document.body.append(new PageFrames(new AbortController().signal).frame(page, "Page", "page"));`,
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

const hits = [];
const udp = createSocket("udp4");
let stunPackets = 0;
udp.on("message", () => stunPackets++);
await new Promise((done) => udp.bind(0, "127.0.0.1", done));
let tcpConnections = 0;
const tcp = createTcpServer((socket) => {
	tcpConnections++;
	socket.destroy();
});
await new Promise((done) => tcp.listen(0, "127.0.0.1", done));
const stun = udp.address().port;
const hint = tcp.address().port;

const say = (value) => `top.postMessage({ probe: ${value} }, "*")`;
const peer = (tag) => `(async () => {
	const Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
	if (typeof Peer !== "function") return ${say('"no WebRTC"')};
	const connection = new Peer({ iceServers: [{ urls: "stun:127.0.0.1:${stun}" }, { urls: "stun:rtc-${tag}.leak.invalid:3478" }] });
	connection.createDataChannel("out");
	await connection.setLocalDescription(await connection.createOffer());
	${say('"WebRTC on"')};
})().catch((error) => ${say('"WebRTC refused: " + error.name')});`;
/** A frame whose own page says it ran and then tries WebRTC: the attribute escaped, so it can go anywhere. */
const childFrame = (tag) =>
	`<iframe srcdoc="${`<script>${say('"frame ran"')}; ${peer(tag)}</script>`
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")}"></iframe>`;
const variants = {
	runs: (origin) =>
		`<!doctype html><style>p { color: rgb(1, 2, 3) }</style><p>Inline</p><script>
const parts = ["ran", getComputedStyle(document.querySelector("p")).color];
try { localStorage.length; parts.push("storage"); } catch { parts.push("no storage"); }
try { document.cookie = "probe=1"; parts.push(document.cookie ? "cookies" : "no cookies"); } catch { parts.push("no cookies"); }
${say('parts.join(", ")')};</script>`,
	requests: (origin) =>
		`<!doctype html><link rel="stylesheet" href="${origin}/probe/css"><img src="${origin}/probe/img"><script src="${origin}/probe/script"></script>
<script>
const origin = ${JSON.stringify(origin)};
fetch(origin + "/probe/fetch").catch(() => {});
const request = new XMLHttpRequest(); try { request.open("GET", origin + "/probe/xhr"); request.send(); } catch {}
try { new WebSocket(origin.replace("http", "ws") + "/probe/ws"); } catch {}
try { navigator.sendBeacon(origin + "/probe/beacon", "x"); } catch {}
try { new EventSource(origin + "/probe/events"); } catch {}
new Image().src = origin + "/probe/image";
${say('"tried"')};</script>`,
	webrtc: () => `<!doctype html><script>${peer("direct")}</script>`,
	"webrtc from a frame made by script": () =>
		`<!doctype html><body><script>const child = document.createElement("iframe");
child.srcdoc = "<script>" + ${JSON.stringify(`${say('"frame ran"')}; ${peer("script")}`)} + "<\\/script>";
document.body.append(child); ${say('"frame added"')};</script></body>`,
	"webrtc from a frame in the markup": () =>
		`<!doctype html><body><iframe srcdoc="<script>${`${say("'frame ran'")}; ${peer("markup")}`.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}</script>"></iframe><script>${say('"markup written"')}</script></body>`,
	"webrtc from a frame in a closed shadow root": () =>
		`<!doctype html><body><script>const host = document.createElement("div");
const root = host.attachShadow({ mode: "closed" });
root.innerHTML = ${JSON.stringify(childFrame("closed"))};
document.body.append(host); ${say('"shadow added"')};</script></body>`,
	"webrtc from a frame in a cloned shadow root": () =>
		`<!doctype html><body><script>const host = document.createElement("div");
const root = host.attachShadow({ mode: "open", clonable: true, serializable: true });
root.innerHTML = ${JSON.stringify(childFrame("clone"))};
document.body.append(host.cloneNode(true)); ${say('"clone added"')};</script></body>`,
	"webrtc from a frame in a declarative shadow root": () =>
		`<!doctype html><body><div><template shadowrootmode="closed">${childFrame("declared")}</template></div><script>${say('"declared"')}</script></body>`,
	"webrtc from a declarative shadow root in a template": () =>
		`<!doctype html><body><template id="kept"><div><template shadowrootmode="open">${childFrame("kept")}</template></div></template>
<script>document.body.append(document.getElementById("kept").content); ${say('"template added"')};</script></body>`,
	"webrtc from a declarative shadow root written during the parse": () =>
		`<!doctype html><body><script>document.write(${JSON.stringify(`<div><template shadowrootmode="open">${childFrame("written")}</template></div>`)}); ${say('"written"')};</script></body>`,
	"webrtc from a declarative shadow root by setHTMLUnsafe": () =>
		`<!doctype html><body><div id="target"></div><script>try { document.getElementById("target").setHTMLUnsafe(${JSON.stringify(`<template shadowrootmode="open">${childFrame("unsafe")}</template>`)}); ${say('"set"')}; } catch (error) { ${say('"refused " + error.name')}; }</script></body>`,
	"link hints in the markup": () =>
		`<!doctype html><head><link rel="preconnect" href="http://127.0.0.1:${hint}/"><link rel="dns-prefetch" href="//dns-hint.leak.invalid">
<link rel="preconnect" href="https://preconnect-hint.leak.invalid"></head><body><script>${say('"hinted"')}</script></body>`,
};
const expected = {
	runs: ["ran, rgb(1, 2, 3), no storage, no cookies"],
	requests: ["tried"],
	webrtc: ["no WebRTC"],
	"webrtc from a frame made by script": ["frame added"],
	"webrtc from a frame in the markup": ["markup written"],
	"webrtc from a frame in a closed shadow root": ["shadow added"],
	"webrtc from a frame in a cloned shadow root": ["clone added"],
	"webrtc from a frame in a declarative shadow root": ["declared"],
	"webrtc from a declarative shadow root in a template": ["template added"],
	"webrtc from a declarative shadow root written during the parse": ["written"],
	"webrtc from a declarative shadow root by setHTMLUnsafe": ["refused TypeError"],
	"link hints in the markup": ["hinted"],
};

let origin;
const server = createServer((request, response) => {
	const path = new URL(request.url, "http://x").pathname;
	if (path.startsWith("/probe/")) {
		hits.push(path);
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("");
		return;
	}
	const send = (type, body) => {
		response.writeHead(200, { ...headersFor(path), "content-type": type, "cache-control": "no-store" });
		response.end(body);
	};
	if (path === "/") send("text/html", '<!doctype html><meta charset="utf-8"><title>App</title><script type="module" src="/parent.js"></script>');
	else if (path === "/parent.js") send("text/javascript", parent.outputFiles[0].contents);
	else if (path.startsWith("/variant/")) send("application/json", JSON.stringify({ page: variants[decodeURIComponent(path.slice(9))](origin) }));
	else if (path === "/page-preview/") send("text/html", frameDocument);
	else {
		response.writeHead(404);
		response.end();
	}
});
server.on("upgrade", (request, socket) => {
	hits.push(new URL(request.url, "http://x").pathname);
	socket.destroy();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${server.address().port}`;

const scratch = await mkdtemp(join(tmpdir(), "qorpera-page-frame-browser-"));
const netLog = join(scratch, "net-log.json");
const failures = [];
let browser;
try {
	browser = await chromium.launch({ executablePath, args: [`--log-net-log=${netLog}`, "--net-log-capture-mode=Everything"] });
	const page = await browser.newPage();
	for (const name of Object.keys(variants)) {
		hits.length = 0;
		stunPackets = 0;
		tcpConnections = 0;
		await page.goto(`${origin}/?v=${encodeURIComponent(name)}`);
		await sleep(3500);
		const reports = await page.evaluate(() => window.reports);
		const seen = { reports, requests: [...hits], stunPackets, tcpConnections };
		console.log(`${name}: ${JSON.stringify(seen)}`);
		try {
			assert.deepEqual(seen, { reports: expected[name], requests: [], stunPackets: 0, tcpConnections: 0 });
		} catch (error) {
			failures.push(`${name}: ${error.message.split("\n")[0]} ${JSON.stringify(seen)}`);
		}
	}
	await browser.close();
	browser = undefined;
	const lookedUp = [...new Set((await readFile(netLog, "utf8")).match(/[a-z]+-[a-z]+\.leak\.invalid/g) ?? [])];
	console.log(`host names looked up: ${JSON.stringify(lookedUp)}`);
	if (lookedUp.length) failures.push(`names looked up: ${lookedUp.join(", ")}`);
} finally {
	await browser?.close();
	server.close();
	tcp.close();
	udp.close();
	await rm(scratch, { recursive: true, force: true });
}
if (failures.length) {
	console.log(`FAILED:\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`page frame browser checks passed (${Object.keys(variants).length} pages)`);
