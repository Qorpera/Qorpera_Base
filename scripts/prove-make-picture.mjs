import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// make_picture on a real node with a real Codex sign-in (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3b): the runtime's
// own Codex session (runCloudCodexToolSession) with its picture lane, the pinned patched Codex app-server and the
// sign-in's ChatGPT plan. The agent's only tool, picture_probe, makes two pictures through the run's lane (a plain one
// and a detailed one), then the agent is asked to call image_gen.imagegen itself, which its thread must not have.
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> QORPERA_PICTURE_AUTH=<a test Codex sign-in's auth.json> \
//     [QORPERA_NATIVE_ENTRY=<the guest package's root-owned native entry>] [QORPERA_PICTURE_MODEL=<model>] \
//     node scripts/prove-make-picture.mjs
//
// Phase 1 runs Codex through a tap that copies every line of the app-server protocol, each string past 512 characters
// replaced by its length, to tap.jsonl in the run's scratch folder: the picture thread's start, its items as Codex sends
// them, the file, what happens after the picture, and the agent's own attempt. No isolation, so no relay cut.
// Phase 2 (with QORPERA_NATIVE_ENTRY) runs the same session isolated, as production does, through the real egress relay
// and its long-wait window: a picture that takes more than 30 s comes back only through that window.
// A sign-in's picture limit, when it is hit, shows in the probe's lines (reason picture_limit and resetsAt) and in the
// tap (the item's `failure`). Not covered: the company folder's commit and the web's view of the file (PROOF.md, step 3).
// Prints one PASS line per check and FACT lines with what was measured; exits 1 on the first failure. Without the binary
// or the sign-in it prints NOT RUN and exits 0. The sign-in is copied into a private scratch root, never changed in place,
// and every copy is removed when the run ends, also a failed run's and also with QORPERA_PICTURE_KEEP=1 (which keeps the
// tap and the bundle alone).

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pass = (what) => process.stdout.write(`PASS ${what}\n`);
const fact = (what, value) => process.stdout.write(`FACT ${what}: ${JSON.stringify(value)}\n`);
const PLAIN = "A red apple on a plain white background, seen from the side, soft daylight.";
const DETAILED =
	"A photoreal living room at golden hour seen from the doorway: a green velvet sofa, a walnut coffee table with three ceramic cups, a tall fiddle-leaf fig by the window, sunlight across a wool rug, every texture sharp.";

/** Copies every protocol line between the session and Codex, unchanged, and logs each with long strings cut. */
const TAP = `const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const [log, binary, ...args] = process.argv.slice(2);
const cut = (value) => typeof value === "string" ? (value.length > 512 ? "<" + value.length + " characters>" : value)
	: Array.isArray(value) ? value.map(cut) : value && typeof value === "object"
	? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cut(item)])) : value;
const note = (way, line) => {
	let value;
	try { value = JSON.parse(line); } catch { value = "<not JSON: " + line.length + " characters>"; }
	appendFileSync(log, JSON.stringify({ at: Date.now(), way, bytes: Buffer.byteLength(line), message: cut(value) }) + "\\n");
};
const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"] });
createInterface({ input: process.stdin }).on("line", (line) => { note("in", line); child.stdin.write(line + "\\n"); });
process.stdin.on("end", () => child.stdin.end());
createInterface({ input: child.stdout }).on("line", (line) => { note("out", line); process.stdout.write(line + "\\n"); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
process.on("SIGTERM", () => child.kill("SIGTERM"));
`;

async function bundle(scratch) {
	const modulePath = join(scratch, "prove.mjs");
	await build({
		absWorkingDir: repositoryRoot,
		stdin: {
			resolveDir: repositoryRoot,
			contents: [
				'export {runCloudCodexToolSession} from "./packages/runtime/src/cloud-codex-tool-session.ts";',
				'export {CloudNativeToolBoundary} from "./packages/runtime/src/cloud-native-tool-boundary.ts";',
				'export {CloudPictureChannel, CLOUD_PICTURE_MAKER_RULE} from "./packages/runtime/src/cloud-picture-channel.ts";',
			].join("\n"),
		},
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: modulePath,
		logLevel: "silent",
	});
	return import(pathToFileURL(modulePath).href);
}

/** A PNG's size in pixels, from its header. */
const pngSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** One agent run with the picture lane: the probe's two pictures, then the agent's own attempt at Codex's image tool. */
async function session(runtime, options) {
	const pictures = new runtime.CloudPictureChannel();
	const made = [];
	const frames = [];
	const probe = {
		name: "picture_probe",
		source: "runtime",
		// A company run shows images (company_read): its Codex carries 12 MiB lines, as here.
		images: true,
		description: "Makes two test pictures through the run's picture lane and says what came back. Takes no arguments.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		parseArguments: () => ({}),
		async execute(_value, context) {
			for (const prompt of [PLAIN, DETAILED]) {
				const started = performance.now();
				try {
					const picture = await pictures.make({ prompt }, context.signal);
					made.push({
						prompt: prompt === PLAIN ? "plain" : "detailed",
						ms: Math.round(performance.now() - started),
						bytes: picture.png.length,
						sha256: sha256(picture.png),
						...pngSize(picture.png),
						revisedPrompt: picture.revisedPrompt === prompt ? "(the call's own)" : picture.revisedPrompt,
						transparent: picture.transparent,
					});
				} catch (error) {
					made.push({
						prompt: prompt === PLAIN ? "plain" : "detailed",
						ms: Math.round(performance.now() - started),
						error: error.name,
						reason: error.reason,
						resetsAt: error.resetsAt,
						message: error.message,
					});
				}
			}
			return { kind: "json", value: { pictures: made.map(({ sha256: _sha, ...rest }) => rest) } };
		},
	};
	const boundary = new runtime.CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: new AbortController().signal,
		assertActive: async () => undefined,
		tools: [probe],
	});
	const result = await runtime.runCloudCodexToolSession({
		command: options.command,
		binarySha256: options.binarySha256,
		boundary,
		model: process.env.QORPERA_PICTURE_MODEL ?? "provider-default",
		prompt:
			"This is a test of the platform. Call qorpera.picture_probe once and wait for its answer. Then call image_gen.imagegen once with the prompt 'a blue cube'; if you have no such tool, say so. Then answer with the one word DONE.",
		identityRoot: options.identityRoot,
		...(options.isolation ? { isolation: options.isolation } : {}),
		pictures,
		recordContextView: async (frame) => {
			frames.push(frame);
		},
		signal: AbortSignal.timeout(20 * 60_000),
	});
	return { result, made, frames };
}

/** The tap's lines, parsed. */
async function tapped(log) {
	return (await readFile(log, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function main() {
	const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
	const auth = process.env.QORPERA_PICTURE_AUTH;
	if (!binary || !auth) {
		process.stdout.write(
			"NOT RUN: set QORPERA_CODEX_FENCE_BINARY to the patched Codex this tree pins and QORPERA_PICTURE_AUTH to a test Codex sign-in's auth.json (a paid ChatGPT plan)\n",
		);
		return;
	}
	const binarySha256 = sha256(readFileSync(binary));
	fact("codex", { binary, sha256: binarySha256 });
	const scratch = await realpath(await mkdtemp(join(tmpdir(), "qorpera-make-picture-")));
	await chmod(scratch, 0o700);
	const runtime = await bundle(scratch);
	// Every identity root holds a copy of the sign-in: each is removed when the run ends, kept scratch or not.
	const identities = [];
	const identity = async (name) => {
		const root = join(scratch, name);
		identities.push(root);
		await mkdir(join(root, "codex"), { recursive: true, mode: 0o700 });
		await copyFile(auth, join(root, "codex", "auth.json"));
		await chmod(join(root, "codex", "auth.json"), 0o600);
		return root;
	};
	try {
		// Phase 1: through the tap, without isolation.
		const log = join(scratch, "tap.jsonl");
		const tap = join(scratch, "tap.cjs");
		await writeFile(tap, TAP);
		const identityRoot = await identity("identity-1");
		const first = await session(runtime, {
			command: [process.execPath, tap, log, binary],
			binarySha256: sha256(readFileSync(process.execPath)),
			identityRoot,
		});
		fact("phase 1 pictures", first.made);
		assert.equal(first.made.length, 2, "the probe made its two calls");
		const lines = await tapped(log);
		const sent = lines.filter((line) => line.way === "in").map((line) => line.message);
		const said = lines.filter((line) => line.way === "out").map((line) => line.message);
		const starts = sent.filter((message) => message.method === "thread/start");
		const agent = starts.find((message) => message.params.dynamicTools?.length === 1);
		const side = starts.filter((message) => message.params.config);
		assert.ok(agent, "the agent's thread started");
		assert.equal(agent.params.config, undefined, "the agent's thread has no thread config");
		assert.equal(side.length, 2, "each picture had its own thread");
		for (const start of side)
			assert.deepEqual(start.params.config, {
				"features.image_generation": true,
				"features.omit_app_server_notification_media": true,
			});
		pass("the agent's thread starts with the process's configuration; each picture thread alone turns the image tool on");
		const config = said.find((message) => message.result?.config)?.result.config;
		assert.equal(config?.features?.image_generation, false, "config/read: the process keeps image_generation off");
		pass("config/read: image_generation is false for the process");
		const items = said.filter(
			(message) =>
				(message.method === "item/started" || message.method === "item/completed") &&
				message.params?.item?.type === "imageGeneration",
		);
		fact(
			"picture items as Codex sends them (long strings cut)",
			items.map((message) => ({ method: message.method, item: message.params.item })),
		);
		fact(
			"largest protocol line in bytes",
			Math.max(...lines.map((line) => line.bytes)),
		);
		for (const message of items.filter((item) => item.method === "item/completed"))
			assert.equal(message.params.item.result, "", "a picture item reaches the host without its base64");
		pass("no picture item carries its base64 (omit_app_server_notification_media)");
		const pictureThreads = new Set(items.map((message) => message.params.threadId));
		for (const threadId of pictureThreads) {
			const timeline = said
				.filter((message) => message.params?.threadId === threadId && message.method)
				.map((message) => message.method);
			fact(`picture thread ${threadId}: its notifications in order`, timeline);
			const ended = said.find((message) => message.method === "turn/completed" && message.params.threadId === threadId);
			fact(`picture thread ${threadId}: how its turn ended`, ended?.params.turn);
		}
		const started = new Map(
			lines
				.filter((line) => line.way === "out" && line.message.method === "item/started" && line.message.params?.item?.type === "imageGeneration")
				.map((line) => [line.message.params.item.id, line.at]),
		);
		fact(
			"generation time, item/started to item/completed (ms)",
			lines
				.filter((line) => line.way === "out" && line.message.method === "item/completed" && line.message.params?.item?.type === "imageGeneration")
				.map((line) => line.at - (started.get(line.message.params.item.id) ?? line.at)),
		);
		const home = join(identityRoot, "codex");
		assert.equal(existsSync(join(home, "generated_images")), false, "the generated_images folder is gone");
		fact("Codex home after the run", await readdir(home));
		pass("every picture file was removed from the Codex home");
		// The agent's own attempt at Codex's image tool: Codex answers a call of a tool it has not registered itself, and
		// that answer reaches the fence with the agent's next request. Only the agent's requests are recorded as context.
		const agentThread = said.find((message) => message.id === agent.id)?.result?.thread?.id;
		assert.ok(agentThread, "the agent's thread has its id");
		const own = first.frames
			.flatMap((frame) => frame.outputs)
			.filter((output) => !JSON.stringify(output.output).includes("qorpera.cloud-tool-result/v1"));
		fact("outputs of the agent's requests that the host did not issue (Codex's own answers)", own);
		assert.equal(
			items.filter((message) => message.params.threadId === agentThread).length,
			0,
			"no picture item on the agent's thread",
		);
		pass("the agent's thread made no picture");
		fact("the run's result", first.result);

		// Phase 2: isolated, through the real egress relay and its long-wait window.
		const entryPoint = process.env.QORPERA_NATIVE_ENTRY;
		if (!entryPoint) {
			process.stdout.write("NOT RUN phase 2: set QORPERA_NATIVE_ENTRY to the guest package's native entry\n");
			return;
		}
		const second = await session(runtime, {
			command: [binary],
			binarySha256,
			identityRoot: await identity("identity-2"),
			isolation: { entryPoint },
		});
		fact("phase 2 pictures (isolated, through the relay)", second.made);
		assert.ok(
			second.made.every((picture) => picture.bytes > 0),
			"both pictures came back through the relay",
		);
		const slowest = Math.max(...second.made.map((picture) => picture.ms));
		pass(
			`both pictures came back isolated, the slower in ${slowest} ms${slowest > 30_000 ? ", past the relay's 30 s: the long-wait window carried it" : " (under 30 s: the window was not needed this time)"}`,
		);
	} finally {
		// The copies of the sign-in go first and always, also when the run failed and also with QORPERA_PICTURE_KEEP: a
		// kept scratch folder holds the tap and the bundle, never a sign-in (13 November 2026: a kept folder of a failed
		// run left two copies on a shared test machine).
		for (const root of identities) await rm(root, { recursive: true, force: true });
		if (!process.env.QORPERA_PICTURE_KEEP) await rm(scratch, { recursive: true, force: true });
		else process.stdout.write(`Kept ${scratch} (the tap and the bundle; the sign-in copies are removed)\n`);
	}
}

await main().catch((error) => {
	process.stdout.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
