// Offline Chromium proof of the shared presence library, with an in-memory
// private-channel/identity fixture. Does not claim live Supabase acceptance.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = process.env.QORPERA_PRESENCE_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_PRESENCE_TEST_BROWSER to an existing Chromium executable");
const bundled = await build({ absWorkingDir: root, entryPoints: ["packages/cloud-client/src/cloud-presence.ts"],
	bundle: true, write: false, platform: "browser", format: "iife", globalName: "QorperaPresence", target: "es2022" });
const script = bundled.outputFiles[0].text;
const server = createServer((req, res) => {
	if (req.url === "/presence.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(script); }
	else if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><script src="/presence.js"></script>'); }
	else { res.writeHead(404); res.end(); }
});
let browser;
try {
	await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
	const origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ executablePath, headless: true });
	const context = await browser.newContext();
	await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
	const page = await context.newPage();
	const errors = []; page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(origin);
	const result = await page.evaluate(async () => {
		if (typeof Buffer !== "undefined" || typeof process !== "undefined" || !crypto.subtle) throw new Error("Browser proof requires native Web Crypto without Node globals");
		const registry = new Map(), channels = [];
		let health = 0, typings = 0, activities = 0, observed = 0;
		class Channel {
			constructor(options) { this.id = options.config.presence.key; this.handlers = new Map(); this.tracked = null; this.closed = false; }
			on(kind, filter, handler) { this.handlers.set(`${kind}:${filter.event}`, handler); return this; }
			subscribe(handler) { queueMicrotask(() => handler("SUBSCRIBED")); return this; }
			presenceState() { return Object.fromEntries(channels.filter((c) => !c.closed && c.tracked).map((c) => [c.id, [c.tracked]])); }
			async track(value) { this.tracked = value; for (const c of channels) if (!c.closed) c.handlers.get("presence:sync")?.(); return "ok"; }
			async send(value) { for (const c of channels) if (c !== this && !c.closed) c.handlers.get(`broadcast:${value.event}`)?.({ payload: structuredClone(value.payload) }); return "ok"; }
		}
		const client = {
			channel(topic, options) {
				if (topic !== "qorpera-presence-10000000-0000-4000-8000-000000000001" || !options.config.private) throw new Error("Presence must use private membership channel");
				const c = new Channel(options); channels.push(c); return c;
			},
			async removeChannel(c) { c.closed = true; return "ok"; },
		};
		const primary = {
			async registerPresenceDevice(_profile, clientId, publicKey) {
				const entry = { clientId, publicKey, userId: crypto.randomUUID(), name: "Fixture member" };
				registry.set(clientId, entry); return entry;
			},
			async listPresenceDevices(_profile, ids) { return ids.flatMap((id) => registry.has(id) ? [registry.get(id)] : []); },
			async unregisterPresenceDevice(_profile, id) { registry.delete(id); },
		};
		const handles = [0, 1].map(() => new QorperaPresence.SupabaseCloudPresenceTransport(client, primary).join(
			"10000000-0000-4000-8000-000000000001", (members) => { observed += members.length; },
			() => { typings++; }, () => { activities++; }, (value) => { if (value.phase === "connected") health++; }));
		async function until(check) {
			const deadline = performance.now() + 5000;
			while (!check()) { if (performance.now() > deadline) throw new Error("Presence browser fixture timed out"); await new Promise((accept) => setTimeout(accept, 10)); }
		}
		try {
			await until(() => health === 2); handles[0].setOpenThread("legal-agent");
			handles[0].sendTyping("legal-agent"); handles[1].sendActivity("legal-agent", "working");
			await until(() => typings === 1 && activities === 1 && observed >= 1);
		} finally { await Promise.all(handles.map((handle) => handle.stop())); }
		return { typings, activities, observed, registered: registry.size, closed: channels.filter((c) => c.closed).length, nodeGlobals: false };
	});
	assert.deepEqual(errors, []); assert.equal(result.typings, 1); assert.equal(result.activities, 1);
	assert(result.observed >= 1); assert.equal(result.registered, 0); assert.equal(result.closed, 2);
	console.log(JSON.stringify({ schema: "qorpera.presence-browser-proof/v1", browser: browser.version(), ...result }));
} finally {
	await browser?.close();
	await new Promise((accept) => server.close(accept));
}
