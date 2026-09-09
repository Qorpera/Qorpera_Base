// Real Company File DOM, shared upload client and native selected-file reader.
// The preload, native dialogs and gateway replies are fixtures. SQL/HTTP
// authority is proved separately by test-member-company-file-upload.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = process.env.QORPERA_FILE_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_FILE_TEST_BROWSER to an installed Chromium executable");
const scratch = await mkdtemp(join(tmpdir(), "qorpera-file-upload-ui-"));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = Buffer.from([0, 255, 128, 13, 10, 1]), sha = value => createHash("sha256").update(value).digest("hex");
const sourcePath = join(scratch, "æble.bin"), calls = [], failures = [], uploads = [];
let browser, server, finishChoice, mode = "cancel", chosen = 0, lostReply = false, command, protectedFile = false, canWrite = true;
try {
	await writeFile(sourcePath, bytes);
	const modulePath = join(scratch, "upload.mjs");
	await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: 'export {MemberFileUploadSession} from "./packages/shell/src/member-file-upload.ts"; export {CloudMemberCompanyFileClient} from "./packages/cloud-client/src/cloud-member-company-editor.ts";' }, platform: "node", format: "esm", bundle: true, outfile: modulePath });
	const { MemberFileUploadSession, CloudMemberCompanyFileClient } = await import(pathToFileURL(modulePath).href);
	const client = new CloudMemberCompanyFileClient({ companyId: id(1), environmentId: id(2), supabaseUrl: "https://control.invalid", objectGatewayUrl: "https://gateway.invalid", publishableKey: "fixture", accessToken: async () => "member-token", fetch: async (url, init) => {
		assert.equal(String(url), `https://gateway.invalid/v1/member-company-file/${id(2)}/uploads`);
		const request = new Request(url, init), data = Buffer.from(await request.arrayBuffer());
		const metadata = JSON.parse(Buffer.from(request.headers.get("x-qorpera-company-upload"), "base64url").toString());
		assert.equal(sha(data), metadata.source.sha256); assert.deepEqual(data, bytes);
		uploads.push({ metadata, sha256: sha(data) });
		command = { commandId: id(3), companyId: id(1), environmentId: id(2), state: protectedFile ? "review_required" : "applied", expiresAt: "2099-01-01T00:00:00Z", planSha256: "b".repeat(64),
			plan: { schema: "qorpera.company-path-mutation/v1", operationKey: metadata.operationKey, path: metadata.path, expectedVersion: metadata.expectedVersion, entry: { path: metadata.path, kind: "file", executable: false, file: { manifestSha256: sha(JSON.stringify(metadata.manifest)), fileSha256: metadata.source.sha256, bytes: data.length, mediaType: "application/octet-stream" } } },
			result: protectedFile ? null : { state: "applied", path: metadata.path, operationKey: metadata.operationKey, version: id(4), snapshotId: id(5) } };
		if (lostReply) { lostReply = false; return new Response(null, { status: 503 }); }
		return Response.json(command);
	} });
	const session = new MemberFileUploadSession({ signal: new AbortController().signal, current: () => canWrite, upload: (input, signal) => client.upload(input, signal), chooseFile: async () => { chosen++; return mode === "cancel" ? new Promise(resolve => { finishChoice = resolve; }) : sourcePath; } });
	const files = new Map();
	for (const [name, mime] of [["company-file.html", "text/html"], ["company-file.js", "text/javascript"], ["company-file.css", "text/css"]]) files.set(`/${name}`, { bytes: await readFile(join(root, "packages/shell/userland", name)), mime });
	server = createServer((req, res) => { const file = files.get(req.url === "/" ? "/company-file.html" : req.url); if (!file) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": file.mime }); res.end(file.bytes); });
	await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
	browser = await chromium.launch({ executablePath, headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
	const page = await browser.newPage(); page.on("pageerror", error => failures.push(error.message));
	await page.exposeFunction("fixtureMemberRequest", async input => {
		calls.push(input);
		try {
			let result;
			if (input.method === "info") result = { title: "Upload fixture", canWrite };
			else if (input.method === "list") result = { snapshotId: id(5), hasMore: false, nextAfter: null, items: [] };
			else if (input.method === "reviews") result = { items: [], nextAfter: null };
			else if (input.method === "chooseUpload") result = await session.choose();
			else if (input.method === "describe") result = { path: input.path, version: input.path === "replace.bin" ? id(4) : null, entry: input.path === "replace.bin" ? { kind: "file", executable: false, file: { bytes: 123 } } : null };
			else if (input.method === "upload") result = await session.submit(input.intent);
			else if (input.method === "preview") result = { target: command, before: "Existing file", after: "Binary file: 6 bytes. Download the proposed file to inspect it." };
			else if (input.method === "downloadReview") { assert.equal(input.planSha256, command.planSha256); result = { saved: true, bytes: bytes.length, planSha256: command.planSha256 }; }
			else throw new Error(`Unexpected UI operation: ${input.method}`);
			assert(!JSON.stringify(result).includes(scratch));
			return { ok: true, result };
		} catch (error) { return { ok: false, error: error.message }; }
	});
	await page.addInitScript(() => { window.companyFile = { request: input => window.fixtureMemberRequest(input) }; });
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	await page.waitForFunction(() => !document.getElementById("chooseUpload").disabled);
	await page.locator("#chooseUpload").click(); await page.waitForFunction(() => document.getElementById("chooseUpload").disabled);
	assert(finishChoice); assert.equal(uploads.length, 0); finishChoice(null);
	await page.waitForFunction(() => document.getElementById("status").textContent === "Upload selection cancelled.");
	mode = "file"; await page.locator("#chooseUpload").click();
	await page.waitForFunction(() => !document.getElementById("uploadPanel").hidden);
	assert.equal(await page.locator("#uploadPath").inputValue(), "æble.bin");
	assert.equal(await page.locator("#submitUpload").isDisabled(), true);
	await page.locator("#checkUpload").click(); await page.waitForFunction(() => !document.getElementById("submitUpload").disabled);
	await page.locator("#uploadPath").fill("replace.bin"); assert.equal(await page.locator("#submitUpload").isDisabled(), true);
	await page.locator("#checkUpload").click(); await page.waitForFunction(() => document.getElementById("uploadDestination").textContent.includes("Replace replace.bin"));
	lostReply = true; await page.locator("#submitUpload").click();
	await page.waitForFunction(() => document.getElementById("submitUpload").textContent === "Retry this exact upload" && !document.getElementById("submitUpload").disabled);
	assert.equal(await page.locator("#uploadPath").isDisabled(), true); assert.equal(await page.locator("#chooseUpload").isDisabled(), true);
	await writeFile(sourcePath, "changed after selection");
	await page.locator("#submitUpload").click(); await page.waitForFunction(() => document.getElementById("status").textContent === "Uploaded to the live company.");
	assert.equal(chosen, 2); assert.equal(uploads.length, 2); assert.deepEqual(uploads[0], uploads[1]); assert.equal(uploads[0].metadata.expectedVersion, id(4));
	protectedFile = true; await writeFile(sourcePath, bytes);
	await page.locator("#chooseUpload").click(); await page.locator("#checkUpload").click(); await page.waitForFunction(() => !document.getElementById("submitUpload").disabled);
	await page.locator("#submitUpload").click(); await page.waitForFunction(() => !document.getElementById("reviewPanel").hidden);
	assert.equal(await page.locator("#downloadReview").isVisible(), true); assert.equal(calls.some(call => call.method === "review"), false);
	await page.locator("#downloadReview").click(); await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Downloaded the exact proposed file"));
	canWrite = false; await page.reload(); await page.waitForFunction(() => document.getElementById("status").textContent === "Connected with read-only company access.");
	assert.equal(await page.locator("#chooseUpload").isDisabled(), true);
	assert.deepEqual(failures, []); assert(!JSON.stringify(calls).includes(scratch)); assert(calls.filter(call => call.method === "upload").every(call => !Object.hasOwn(call.intent, "bytes")));
	console.log(JSON.stringify({ schema: "qorpera.member-file-upload-ui-proof/v1", browser: browser.version(), actualDom: true, actualNativeReader: true, actualSharedClient: true, binaryBytes: bytes.length, cancelledBeforeUpload: true, checkedDestination: true, lostReplyExactRetry: true, sourceChangeDoesNotAlterRetry: true, protectedReview: true, readOnlyRefused: true, rendererPaths: false, rendererBytes: false, preload: "fixture", chooser: "fixture", gateway: "fixture", hosted: false }));
} finally {
	await browser?.close();
	if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	await rm(scratch, { recursive: true, force: true });
}
