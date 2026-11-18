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
