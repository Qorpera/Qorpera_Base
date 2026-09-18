// Real Company File DOM and desktop save implementation, with fixture preload,
// native chooser and cloud download authority. No running Electron or hosted API.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = process.env.QORPERA_FILE_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_FILE_TEST_BROWSER to an installed Chromium executable");
const scratch = await mkdtemp(join(tmpdir(), "qorpera-file-download-ui-"));
const version = "00000000-0000-4000-8000-000000000001", companyPath = "documents/æble.bin";
const bytes = Buffer.from([0, 255, 128, 13, 10, 1]);
const source = { realm: "company_file", path: companyPath, version, companyId: version, environmentId: version,
	sha256: createHash("sha256").update(bytes).digest("hex"), manifestSha256: "a".repeat(64) };
const destination = join(scratch, "selected.bin"), calls = [], failures = [];
let browser, server, finishChoice, mode = "cancel", stale = false, downloads = 0;
try {
	const modulePath = join(scratch, "save.mjs");
	await build({ absWorkingDir: root, entryPoints: ["packages/shell/src/member-file-download.ts"], platform: "node", format: "esm", bundle: true, outfile: modulePath });
	const { saveSelectedMemberFile } = await import(pathToFileURL(modulePath).href);
	const files = new Map();
	for (const [name, mime] of [["company-file.html", "text/html"], ["company-file.js", "text/javascript"], ["company-file.css", "text/css"]])
		files.set(`/${name}`, { bytes: await readFile(join(root, "packages/shell/userland", name)), mime });
	server = createServer((req, res) => {
		const file = files.get(req.url === "/" ? "/company-file.html" : req.url);
		if (!file) { res.writeHead(404); res.end(); return; }
		res.writeHead(200, { "content-type": file.mime }); res.end(file.bytes);
	});
	await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
	const origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ executablePath, headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
	const page = await browser.newPage(); page.on("pageerror", error => failures.push(error.message));
	await page.exposeFunction("fixtureMemberRequest", async input => {
		calls.push(input);
		try {
			let result;
			if (input.method === "info") result = { title: "Download fixture", canWrite: false };
			else if (input.method === "list") result = { snapshotId: version, hasMore: false, nextAfter: null,
				items: [{ path: companyPath, version, kind: "file", bytes: bytes.length }, { path: "folder", version, kind: "directory", bytes: null }] };
			else if (input.method === "reviews") result = { items: [], nextAfter: null };
			else if (input.method === "download") result = await saveSelectedMemberFile({
				selection: input.selection, signal: new AbortController().signal, current: () => true,
				chooseDestination: async name => { assert.equal(name, "æble.bin"); return mode === "cancel" ? new Promise(accept => { finishChoice = accept; }) : destination; },
				download: async selection => { downloads++; assert.deepEqual(selection, { realm: "company_file", path: companyPath, version }); if (stale) throw new Error("Selected Company File version changed"); return { bytes, source, mediaType: "application/octet-stream" }; },
			});
			else throw new Error(`Unexpected UI operation: ${input.method}`);
			return { ok: true, result };
		} catch (error) { return { ok: false, error: error.message }; }
	});
	await page.addInitScript(() => { window.companyFile = { request: input => window.fixtureMemberRequest(input) }; });
	await page.goto(origin);
	const button = page.getByRole("button", { name: `Download ${companyPath}`, exact: true });
	await page.waitForFunction(() => document.getElementById("status").textContent === "Connected with read-only company access.");
	assert.equal(await button.count(), 1); assert.equal(await button.isEnabled(), true);
	assert.equal(await page.locator("#save").isDisabled(), true);
	await button.click(); await page.waitForFunction(() => document.querySelector(".download").disabled);
	assert(finishChoice); assert.equal(downloads, 0); finishChoice(null);
	await page.waitForFunction(() => document.getElementById("status").textContent === "Download cancelled.");
	assert.equal((await readdir(scratch)).includes("selected.bin"), false);
	mode = "save"; await button.click();
	await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Downloaded "));
	assert.deepEqual(await readFile(destination), bytes); assert.equal(downloads, 1);
	assert(!calls.some(call => call.method === "read" || call.method === "edit"));
	stale = true; await button.click();
	await page.waitForFunction(() => document.getElementById("status").textContent === "Selected Company File version changed");
	assert.equal(await page.locator("#status.error").count(), 1); assert.deepEqual(await readFile(destination), bytes);
	assert.equal((await readdir(scratch)).some(name => name.startsWith(".qorpera-download-")), false);
	assert.deepEqual(failures, []);
	console.log(JSON.stringify({ schema: "qorpera.member-file-download-ui-proof/v1", browser: browser.version(), actualDom: true, actualSave: true,
		binaryBytes: bytes.length, exactVersion: true, readOnlyMember: true, cancelledBeforeFetch: true, staleDestinationPreserved: true,
		noTextPreview: true, rendererLocalPaths: false, rendererBytes: false, preload: "fixture", nativeChooser: "fixture", cloudAuthority: "fixture", hosted: false }));
} finally {
	await browser?.close();
	if (server) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
	await rm(scratch, { recursive: true, force: true });
}
