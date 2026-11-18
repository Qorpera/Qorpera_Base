import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const executablePath = process.env.QORPERA_WEB_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_WEB_TEST_BROWSER to an existing Chromium executable");
const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));

const bundle = await build({
	stdin: {
		contents: `import { forgetKeptObjects, KeptObjects } from ${JSON.stringify(join(repository, "packages/web/src/cloud/kept-objects.ts"))};
import { CloudMemberFolderClient } from ${JSON.stringify(join(repository, "packages/cloud-client/src/cloud-member-folder.ts"))};
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
const filled = (size, seed) => Uint8Array.from({ length: size }, (_, at) => (at * 31 + seed) % 251);
const signal = new AbortController().signal;
const raw = () => new Promise((done, failed) => {
	const opening = indexedDB.open("qorpera-kept-objects");
	opening.onsuccess = () => done(opening.result);
	opening.onerror = () => failed(opening.error);
});
const names = async () => (await indexedDB.databases()).map((database) => database.name);
const seeded = (at) => "f".repeat(48) + at.toString(16).padStart(16, "0");

async function file(text, sizes) {
	const bytes = new TextEncoder().encode(text);
	const store = new Map();
	const chunks = [];
	let offset = 0;
	for (const size of sizes) {
		const chunk = bytes.slice(offset, offset + size);
		const hash = await sha(chunk);
		store.set(hash, chunk);
		chunks.push({ sha256: hash, bytes: chunk.length });
		offset += size;
	}
	const fileSha256 = await sha(bytes);
	const manifest = new TextEncoder().encode(JSON.stringify({ schema: "qorpera.cloud-file-manifest/v2", fileSha256, bytes: bytes.length, mediaType: "text/plain", executable: false, chunks }));
	const manifestSha256 = await sha(manifest);
	store.set(manifestSha256, manifest);
	return { store, reference: { manifestSha256, fileSha256, bytes: bytes.length, mediaType: "text/plain", executable: false } };
}

function reader(store, kept) {
	const asked = [];
	const folder = new CloudMemberFolderClient({
		environmentId: "63000000-0000-4000-8000-000000000020",
		supabaseUrl: "https://cloud.test/",
		objectGatewayUrl: "https://objects.test/",
		publishableKey: "sb_publishable_fixture",
		accessToken: async () => "member-token",
		kept,
		fetch: async (input) => {
			const hash = String(input).split("/").at(-1);
			asked.push(hash);
			const bytes = store.get(hash);
			return bytes
				? new Response(bytes, { headers: { "x-qorpera-access-mode": "live-path-authority", "content-length": String(bytes.length) } })
				: new Response(null, { status: 403 });
		},
	});
	return { folder, asked };
}

window.checks = {
	async keepsAcrossInstances(member) {
		const kept = new KeptObjects(member);
		const bytes = filled(70000, 3);
		const hash = await sha(bytes);
		kept.keep(hash, bytes);
		bytes.fill(0);
		await kept.settled();
		const again = new KeptObjects(member);
		const taken = await again.take(hash, signal);
		return { hash, same: taken !== undefined && (await sha(taken)) === hash, missing: (await again.take("0".repeat(64), signal)) === undefined };
	},
	async takes(member, hash) {
		const taken = await new KeptObjects(member).take(hash, signal);
		return taken === undefined ? null : await sha(taken);
	},
	async evicts() {
		let clock = 1000;
		const kept = new KeptObjects("member-evict", { maxBytes: 100000, now: () => clock++ });
		const hashes = [];
		for (let index = 0; index < 5; index++) {
			const bytes = filled(30000, index);
			hashes.push(await sha(bytes));
			kept.keep(hashes[index], bytes);
			await kept.settled();
		}
		const held = [];
		for (const hash of hashes) held.push((await kept.take(hash, signal)) !== undefined);
		const tooLarge = filled(8 * 1024 * 1024 + 1, 9);
		const largeHash = await sha(tooLarge);
		kept.keep(largeHash, tooLarge);
		await kept.settled();
		return { held, large: (await kept.take(largeHash, signal)) !== undefined };
	},
	async refusesMismatch(member) {
		const kept = new KeptObjects(member);
		const bytes = filled(5000, 5);
		const hash = await sha(bytes);
		kept.keep(hash, bytes);
		await kept.settled();
		const database = await raw();
		const transaction = database.transaction(["bytes"], "readwrite");
		transaction.objectStore("bytes").put(filled(4000, 6).buffer, hash);
		await new Promise((done) => { transaction.oncomplete = done; });
		database.close();
		return (await kept.take(hash, signal)) === undefined;
	},
	async staysQuickWhenFull(member, count) {
		const kept = new KeptObjects(member);
		await kept.take("0".repeat(64), signal);
		const database = await raw();
		const transaction = database.transaction(["bytes", "index", "owner"], "readwrite");
		const small = filled(300, 1).buffer;
		for (let at = 0; at < count; at++) {
			const name = seeded(at);
			transaction.objectStore("bytes").put(small, name);
			transaction.objectStore("index").put({ sha256: name, bytes: 300, used: at });
		}
		transaction.objectStore("owner").put(count * 300, "bytes");
		await new Promise((done) => { transaction.oncomplete = done; });
		database.close();
		const fresh = [];
		for (let at = 0; at < 200; at++) {
			const bytes = filled(2000, at);
			fresh.push([await sha(bytes), bytes]);
		}
		const started = performance.now();
		for (const [hash, bytes] of fresh) kept.keep(hash, bytes);
		const taken = await Promise.all(fresh.map(([hash]) => kept.take(hash, signal)));
		await kept.settled();
		const ms = Math.round(performance.now() - started);
		const after = await Promise.all(fresh.map(([hash]) => kept.take(hash, signal)));
		return { ms, early: taken.filter(Boolean).length, kept: after.filter(Boolean).length, old: (await kept.take(seeded(0), signal)) !== undefined };
	},
	async evictsInSteps(member, count) {
		const kept = new KeptObjects(member, { maxBytes: count * 30 });
		await kept.take("0".repeat(64), signal);
		const database = await raw();
		const seeding = database.transaction(["bytes", "index", "owner"], "readwrite");
		const small = filled(300, 1).buffer;
		for (let at = 0; at < count; at++) {
			const name = seeded(at);
			seeding.objectStore("bytes").put(small, name);
			seeding.objectStore("index").put({ sha256: name, bytes: 300, used: at });
		}
		seeding.objectStore("owner").put(count * 300, "bytes");
		await new Promise((done) => { seeding.oncomplete = done; });
		const bytes = filled(2000, 4);
		const hash = await sha(bytes);
		const started = performance.now();
		kept.keep(hash, bytes);
		let slowest = 0;
		let misses = 0;
		let takes = 0;
		let evicting = true;
		const taking = (async () => {
			await new Promise((done) => setTimeout(done, 20));
			while (evicting) {
				const started = performance.now();
				if ((await kept.take(hash, signal)) === undefined) misses++;
				slowest = Math.max(slowest, performance.now() - started);
				takes++;
			}
		})();
		await kept.settled();
		const ms = Math.round(performance.now() - started);
		evicting = false;
		await taking;
		const reading = database.transaction(["index", "owner"], "readonly");
		const [left, total] = await Promise.all([
			new Promise((done) => { const counting = reading.objectStore("index").count(); counting.onsuccess = () => done(counting.result); }),
			new Promise((done) => { const asking = reading.objectStore("owner").get("bytes"); asking.onsuccess = () => done(asking.result); }),
		]);
		database.close();
		return { ms, takes, misses, slowest: Math.round(slowest), left, total, limit: count * 30, still: (await kept.take(hash, signal)) !== undefined };
	},
	async givesUpOnAStore(member) {
		const never = { open: () => ({}), deleteDatabase: () => ({}) };
		const kept = new KeptObjects(member, { factory: never });
		const stop = new AbortController();
		const started = performance.now();
		const stopping = kept.take("1".repeat(64), stop.signal);
		stop.abort();
		const stopped = { value: await stopping, ms: Math.round(performance.now() - started) };
		const waited = performance.now();
		const first = await kept.take("1".repeat(64), signal);
		const late = Math.round(performance.now() - waited);
		const again = performance.now();
		const second = await kept.take("1".repeat(64), signal);
		return { stopped, first, late, second, skipped: Math.round(performance.now() - again) };
	},
	async forgets(member) {
		const kept = new KeptObjects(member);
		const bytes = filled(9000, 7);
		const hash = await sha(bytes);
		kept.keep(hash, bytes);
		await kept.settled();
		const before = await names();
		await kept.forget();
		const after = await names();
		kept.keep(hash, bytes);
		await kept.settled();
		return { before: before.includes("qorpera-kept-objects"), after: after.includes("qorpera-kept-objects"), taken: (await kept.take(hash, signal)) !== undefined, recreated: (await names()).includes("qorpera-kept-objects") };
	},
	async holdOpen(member) {
		window.held = new KeptObjects(member);
		const bytes = filled(2000, 8);
		window.heldHash = await sha(bytes);
		window.held.keep(window.heldHash, bytes);
		await window.held.settled();
		return (await window.held.take(window.heldHash, signal)) !== undefined;
	},
	async heldStill() {
		return (await window.held.take(window.heldHash, signal)) !== undefined;
	},
	async forgetAll() {
		const started = performance.now();
		await forgetKeptObjects();
		return { ms: Math.round(performance.now() - started), left: (await names()).includes("qorpera-kept-objects") };
	},
	async readsThroughTheClient(member) {
		const { store, reference } = await file("Bytes the browser keeps between visits.", [10, 29]);
		const first = reader(store, new KeptObjects(member));
		const read = new TextDecoder().decode(await first.folder.readFile(reference, signal, undefined, { cached: true }));
		await new Promise((done) => setTimeout(done, 50));
		const keptNow = new KeptObjects(member);
		await keptNow.settled();
		const second = reader(store, keptNow);
		const again = new TextDecoder().decode(await second.folder.readFile(reference, signal, undefined, { cached: true }));
		const pieces = [];
		await second.folder.readFilePieces(reference, signal, (piece) => pieces.push(new TextDecoder().decode(piece)), { cached: true });
		const listed = reader(store, keptNow);
		await listed.folder.readFile(reference, signal);
		const chunk = [...store.keys()].find((hash) => hash !== reference.manifestSha256);
		const database = await raw();
		const transaction = database.transaction(["bytes"], "readwrite");
		transaction.objectStore("bytes").put(new TextEncoder().encode("X".repeat(store.get(chunk).length)).buffer, chunk);
		await new Promise((done) => { transaction.oncomplete = done; });
		database.close();
		const third = reader(store, new KeptObjects(member));
		const repaired = new TextDecoder().decode(await third.folder.readFile(reference, signal, undefined, { cached: true }));
		return { read, firstAsked: first.asked.length, again, secondAsked: second.asked.length, pieces: pieces.join(""), listedAsked: listed.asked.length, repaired, thirdAsked: third.asked, chunk };
	},
};
`,
		resolveDir: repository,
		loader: "ts",
	},
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	target: "chrome120",
	logLevel: "silent",
});
const script = bundle.outputFiles[0].text;

const server = createServer((request, response) => {
	if (request.url === "/kept.js") {
		response.writeHead(200, { "content-type": "text/javascript" });
		response.end(script);
		return;
	}
	response.writeHead(200, { "content-type": "text/html" });
	response.end('<!doctype html><meta charset="utf-8"><title>kept objects</title><script src="/kept.js"></script>');
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({ executablePath });
const passed = [];
try {
	const context = await browser.newContext();
	const page = await context.newPage();
	const run = (target, name, ...args) => target.evaluate(([check, values]) => window.checks[check](...values), [name, args]);
	await page.goto(origin);

	const kept = await run(page, "keepsAcrossInstances", "member-a");
	assert.deepEqual({ same: kept.same, missing: kept.missing }, { same: true, missing: true });
	passed.push("an object kept is taken again by a later store of the same member, a copy of what was kept");

	await page.reload();
	assert.equal(await run(page, "takes", "member-a", kept.hash), kept.hash);
	passed.push("it is still there after the page is loaded again");

	assert.equal(await run(page, "takes", "member-b", kept.hash), null);
	assert.equal(await run(page, "takes", "member-a", kept.hash), null);
	passed.push("another member's store starts empty, and the first member's bytes are gone with it");

	assert.deepEqual(await run(page, "evicts"), { held: [false, false, true, true, true], large: false });
	passed.push("past its size the least recently used go first, and an object over 8 MiB is not kept");

	assert.equal(await run(page, "refusesMismatch", "member-c"), true);
	passed.push("bytes that are not the size their record says are not handed out");

	const full = await run(page, "staysQuickWhenFull", "member-g", 50000);
	assert.deepEqual({ kept: full.kept, old: full.old }, { kept: 200, old: true });
	assert.ok(full.ms < 4000, `200 keeps and takes beside 50,000 kept objects took ${full.ms} ms`);
	passed.push(`keeping and taking stay quick beside 50,000 kept objects (200 of each in ${full.ms} ms)`);

	const steps = await run(page, "evictsInSteps", "member-i", 5000);
	assert.equal(steps.misses, 0);
	assert.ok(steps.takes >= 20, `only ${steps.takes} reads ran beside the eviction`);
	assert.ok(steps.slowest < 4000, `a read beside an eviction waited ${steps.slowest} ms`);
	assert.equal(steps.still, true);
	assert.equal(steps.total, (steps.left - 1) * 300 + 2000);
	assert.ok(steps.total <= steps.limit * 0.9 && steps.total > steps.limit * 0.9 - 2000, `kept ${steps.total} of ${steps.limit}`);
	passed.push(`an eviction of ${5001 - steps.left} objects runs in steps (${steps.ms} ms): ${steps.takes} reads beside it all answered, the slowest in ${steps.slowest} ms`);

	const hung = await run(page, "givesUpOnAStore", "member-h");
	assert.equal(hung.stopped.value, undefined);
	assert.ok(hung.stopped.ms < 1000, `a stopped read waited ${hung.stopped.ms} ms`);
	assert.equal(hung.first, undefined);
	assert.ok(hung.late >= 3500 && hung.late < 6000, `the first read waited ${hung.late} ms`);
	assert.equal(hung.second, undefined);
	assert.ok(hung.skipped < 100, `a later read waited ${hung.skipped} ms`);
	passed.push("a database that never opens costs one read its bound, a stopped read nothing, and later reads skip it");

	const client = await run(page, "readsThroughTheClient", "member-d");
	assert.equal(client.read, "Bytes the browser keeps between visits.");
	assert.equal(client.firstAsked, 3);
	assert.equal(client.again, client.read);
	assert.equal(client.secondAsked, 0);
	assert.equal(client.pieces, client.read);
	assert.equal(client.listedAsked, 3);
	assert.equal(client.repaired, client.read);
	assert.deepEqual(client.thirdAsked, [client.chunk]);
	passed.push("the folder client reads a file again with no request, whole and in pieces; a read that did not read the entry live still asks; kept bytes that fail their hash are asked for again");

	assert.deepEqual(await run(page, "forgets", "member-e"), { before: true, after: false, taken: false, recreated: false });
	passed.push("forgetting deletes the database, and a store that was forgotten keeps and hands out nothing");

	const other = await context.newPage();
	await other.goto(origin);
	assert.equal(await run(other, "holdOpen", "member-f"), true);
	const forgotten = await run(page, "forgetAll");
	assert.equal(forgotten.left, false);
	assert.ok(forgotten.ms < 5000, `forgetting waited ${forgotten.ms} ms for another tab`);
	assert.equal(await run(other, "heldStill"), false);
	passed.push("forgetting in one tab is not held up by another tab's open store, which hands out nothing afterwards");
} finally {
	await browser.close();
	server.close();
}
for (const line of passed) console.log(`ok: ${line}`);
console.log(`kept objects browser checks passed (${passed.length})`);
