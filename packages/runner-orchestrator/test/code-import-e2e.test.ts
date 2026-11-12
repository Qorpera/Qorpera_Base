import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODE_BUNDLE_FOLDER, createCodeBundleStore } from "../src/code-bundle-store.ts";
import { CODE_HOST_IMPORT_JOBS } from "../src/code-host-import.ts";
import type { CodeHostGcBlock, CodeHostJob } from "../src/code-host-jobs.ts";
import { CodeHostRequests } from "../src/code-host-requests.ts";
import type { CodeHostJobs } from "../src/code-host-views.ts";
import {
	type CodeImportAnswer,
	type CodeImportTransport,
	type CodeImportTransports,
	codeImportProgressOf,
	codeImportRequestOf,
} from "../src/code-import.ts";
import { fetchGitHubImport } from "../src/code-import-fetch.ts";
import { CODE_IMPORT_RUN_RPCS, CodeImport } from "../src/code-import-run.ts";
import { localShell } from "./helpers/code-host-shell.ts";

// Step 6 from end to end, in the merged tree (the cross-check's second pass): an import claimed by part Q's request
// loop and run by part C3's CodeImport, with the real parts in between (C2's fetch over protocol v2 and its bundle
// store; B's read, look and tidy jobs and restore's own close, set-aside, build and open, with real git on a local disk
// as the code host). Only the outside world is stood in: GitHub is real `git upload-pack --stateless-rpc` behind a
// loopback HTTP server, the broker's relay is that server behind the kernel's fetch authority, and the kernel is a small
// in-memory one that keeps A2's rules (20260930736000) and refuses, as SQL would, any call not of A2's shapes.

const GIT = "/usr/bin/git";
const PATH = "/usr/local/bin:/usr/bin:/bin";
const OWNER = "coding-node-1";
const MACHINE = "d".repeat(64);
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const MiB = 1024 ** 2;
/** A key in the source's history only (an AWS key id's form): the look names its kind, never its value. */
const KEY = "AKIAQZXWVUTSRQPONMLK";
const gc: CodeHostGcBlock = { begin: async () => ({ state: "blocking", held: 0 }), end: async () => {} };
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const roots: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function scratch(name: string) {
	const top = await realpath(await mkdtemp(join(tmpdir(), name)));
	roots.push(top);
	return top;
}

const gitEnv = (home: string): Record<string, string> => ({
	PATH,
	HOME: home,
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
});
let home = "";
async function git(cwd: string, ...args: string[]): Promise<string> {
	const child = spawn(GIT, args, { cwd, env: gitEnv(home) });
	const out: Buffer[] = [],
		err: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${Buffer.concat(err).toString()}`);
	return Buffer.concat(out).toString().trim();
}

/** The sources: a GitHub project (bare, its default branch master, a tag, a branch, a key once in its history) and an
 * agent's project made into a bundle. */
const source = { bare: "", master: "", notes: "", notesMain: "" };
beforeAll(async () => {
	home = await scratch("code-import-e2e-");
	const work = join(home, "shop");
	await mkdir(join(work, "src"), { recursive: true });
	await git(work, "init", "--quiet", "--initial-branch=master");
	await writeFile(join(work, "README.md"), "# Shop\n");
	await writeFile(join(work, "src", "config.js"), `export const key = "${KEY}";\n`);
	await git(work, "add", ".");
	await git(work, "commit", "--quiet", "-m", "one");
	await writeFile(join(work, "src", "config.js"), "export const key = process.env.KEY;\n");
	await git(work, "add", ".");
	await git(work, "commit", "--quiet", "-m", "two");
	await git(work, "tag", "-a", "v1", "-m", "release one");
	await git(work, "branch", "feature");
	await writeFile(join(work, "src", "app.js"), "console.log('shop');\n");
	await git(work, "add", ".");
	await git(work, "commit", "--quiet", "-m", "three");
	source.master = await git(work, "rev-parse", "master");
	source.bare = join(home, "shop.git");
	await git(home, "clone", "--quiet", "--bare", work, source.bare);
	const notes = join(home, "notes");
	await mkdir(notes);
	await git(notes, "init", "--quiet", "--initial-branch=main");
	await writeFile(join(notes, "notes.md"), "notes\n");
	await git(notes, "add", ".");
	await git(notes, "commit", "--quiet", "-m", "notes");
	source.notesMain = await git(notes, "rev-parse", "main");
	source.notes = notes;
}, 120_000);

/** GitHub: real `git upload-pack` over smart HTTP (protocol v2) for the one project, every request seen. */
async function github() {
	const seen: string[] = [];
	const server = createServer((incoming, reply) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = Buffer.concat(chunks);
			const kind = incoming.method === "GET" ? "refs" : body.includes("command=ls-refs") ? "ls-refs" : "fetch";
			seen.push(kind);
			const env = { ...gitEnv(home), GIT_PROTOCOL: "version=2" };
			const child =
				kind === "refs"
					? spawn(GIT, ["upload-pack", "--http-backend-info-refs", source.bare], { env })
					: spawn(GIT, ["upload-pack", "--stateless-rpc", source.bare], { env });
			child.stdin.on("error", () => {});
			child.stdin.end(kind === "refs" ? undefined : body);
			reply.on("close", () => child.kill());
			reply.writeHead(200, {
				"content-type": `application/x-git-upload-pack-${kind === "refs" ? "advertisement" : "result"}`,
			});
			if (kind === "refs") reply.write("001e# service=git-upload-pack\n0000");
			child.stdout.pipe(reply);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	/** A plain HTTP client to it, as the public transport is to github.com. */
	const transport = (): CodeImportTransport => {
		const send = (
			method: "GET" | "POST",
			path: string,
			headers: Record<string, string>,
			body: Uint8Array | undefined,
			signal: AbortSignal,
		) =>
			new Promise<CodeImportAnswer>((resolve, reject) => {
				const outgoing = request({ host: "127.0.0.1", port, method, path, headers, agent: false, signal });
				outgoing.once("response", (answer: IncomingMessage) =>
					resolve({
						by: "source",
						status: answer.statusCode ?? 0,
						contentType: answer.headers["content-type"]?.split(";")[0] ?? null,
						body: answer as AsyncIterable<Uint8Array>,
					}),
				);
				outgoing.once("error", reject);
				outgoing.end(body);
			});
		return {
			refs: (signal) =>
				send("GET", "/info/refs?service=git-upload-pack", { "git-protocol": "version=2" }, undefined, signal),
			uploadPack: (body, signal) =>
				send(
					"POST",
					"/git-upload-pack",
					{
						"git-protocol": "version=2",
						"content-type": "application/x-git-upload-pack-request",
						"content-length": String(body.byteLength),
					},
					body,
					signal,
				),
		};
	};
	return { seen, transport };
}

// The kernel, as A2 built it -------------------------------------------------------------------------------------------

const BUNDLE = /^\d{8}T\d{6}Z-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const count = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && String(value).length <= 15;
const textIs = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value);
const textOrNull = (value: unknown, pattern: RegExp) => value === null || textIs(value, pattern);
/** `p - array[keys] = '{}'`: no key but these (a key left out fails its own check). */
const only = (value: unknown, keys: string[]) =>
	isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
const pathOk = (value: unknown) =>
	value === null || (typeof value === "string" && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= 200);
const CODE = /^(IMPORT|CODE_HOST)_[A-Z0-9_]{1,100}$/;
const AT = /^\d{4}-\d{2}-\d{2}T[0-9:.]{8,15}(Z|[+-]\d{2}:?\d{2})$/;

/** qorpera_code_import_look_valid, key by key. */
function lookValid(look: unknown): boolean {
	const of = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
	const pair = (value: unknown) =>
		only(value, ["seen", "kept"]) && count(of(value, "seen")) && count(of(value, "kept"));
	const refused = of(look, "refused"),
		secrets = of(look, "secrets"),
		scan = of(secrets, "scan"),
		paths = of(refused, "paths"),
		shown = of(secrets, "shown"),
		branch = of(look, "defaultBranch");
	return (
		only(look, [
			"schema",
			"bytes",
			"defaultBranch",
			"mainSha",
			"commits",
			"firstAt",
			"lastAt",
			"authors30d",
			"tags",
			"branches",
			"leftOut",
			"files",
			"entries",
			"biggest",
			"lfs",
			"submodules",
			"refused",
			"secrets",
			"fits",
			"why",
		]) &&
		of(look, "schema") === "qorpera.code-import-look/v1" &&
		["bytes", "commits", "authors30d", "leftOut", "files", "entries", "submodules"].every((key) =>
			count(of(look, key)),
		) &&
		(branch === null ||
			(typeof branch === "string" && Buffer.byteLength(branch) >= 1 && Buffer.byteLength(branch) <= 200)) &&
		textOrNull(of(look, "mainSha"), SHA) &&
		textOrNull(of(look, "firstAt"), AT) &&
		textOrNull(of(look, "lastAt"), AT) &&
		pair(of(look, "tags")) &&
		pair(of(look, "branches")) &&
		only(of(look, "biggest"), ["path", "bytes"]) &&
		pathOk(of(of(look, "biggest"), "path")) &&
		count(of(of(look, "biggest"), "bytes")) &&
		only(of(look, "lfs"), ["pointers"]) &&
		count(of(of(look, "lfs"), "pointers")) &&
		only(refused, ["code", "paths", "more"]) &&
		textOrNull(of(refused, "code"), CODE) &&
		count(of(refused, "more")) &&
		Array.isArray(paths) &&
		paths.length <= 10 &&
		paths.every(pathOk) &&
		only(secrets, ["found", "shown", "scan"]) &&
		count(of(secrets, "found")) &&
		Array.isArray(shown) &&
		shown.length <= 30 &&
		shown.every(
			(hit: unknown) =>
				only(hit, ["kind", "path", "inMain"]) &&
				textIs(of(hit, "kind"), /^[a-z][a-z0-9_-]{0,39}$/) &&
				pathOk(of(hit, "path")) &&
				typeof of(hit, "inMain") === "boolean",
		) &&
		only(scan, ["blobs", "bytes", "all"]) &&
		count(of(scan, "blobs")) &&
		count(of(scan, "bytes")) &&
		typeof of(scan, "all") === "boolean" &&
		typeof of(look, "fits") === "boolean" &&
		(of(look, "why") === null || textIs(of(look, "why"), CODE))
	);
}

/** qorpera_code_request_outcome_valid('import', …). */
function outcomeValid(outcome: unknown): boolean {
	if (!isRecord(outcome) || outcome.schema !== "qorpera.code-request-outcome/v1") return false;
	if (outcome.state === "busy") return only(outcome, ["schema", "state"]);
	if (outcome.state === "failed")
		return only(outcome, ["schema", "state", "code"]) && textIs(outcome.code, /^[A-Z0-9_:]{1,120}$/);
	if (outcome.state === "refused") return only(outcome, ["schema", "state", "code"]) && textIs(outcome.code, CODE);
	if (outcome.state !== "done") return false;
	if (outcome.result === "looked") return only(outcome, ["schema", "state", "result"]);
	return (
		outcome.result === "imported" &&
		only(outcome, ["schema", "state", "result", "change", "mainSha", "bundle", "rawBundle", "setAside"]) &&
		outcome.change === 1 &&
		textIs(outcome.mainSha, SHA) &&
		textIs(outcome.bundle, BUNDLE) &&
		textOrNull(outcome.rawBundle, /^import-\d{8}T\d{6}Z-[0-9a-f]{12}$/) &&
		textOrNull(outcome.setAside, /^code\/_set-aside\/./) &&
		Buffer.byteLength(String(outcome.setAside ?? "")) <= 1024
	);
}

interface Row {
	id: string;
	owner: string;
	name: string;
	input: Record<string, unknown>;
	state: "queued" | "running" | "done" | "refused" | "failed";
	token: string | null;
	attempts: number;
	progress: Record<string, unknown> | null;
	look: unknown;
	outcome: Record<string, unknown> | null;
}

/** The kernel's calls of the executor, by A2's rules. A call SQL would refuse with an error throws (the control then
 * says `CODING_CONTROL_UNCONFIRMED`), and is kept in `raised`: none may be. */
function kernel() {
	const k = {
		rows: [] as Row[],
		registry: new Map<string, { mainSha: string; importedFrom: Record<string, unknown> }>(),
		changes: [] as Record<string, unknown>[],
		raised: [] as string[],
		quiet: true,
		/** The broker's fetch authority refuses (the connection cannot see the project, or a database blip). */
		deny: false,
		/** What the broker's fetch authority answered, each time the relay asked. */
		authorized: [] as boolean[],
		/** Told of every step the kernel let go, with the progress it now keeps. */
		onStep: (_row: Row) => {},
		ask(
			owner: string,
			name: string,
			from: Record<string, unknown>,
			options: { look?: boolean; via?: string; fileSha256?: string } = {},
		) {
			const row: Row = {
				id: randomUUID(),
				owner,
				name,
				input: {
					from,
					via: options.via ?? ("file" in from ? "file" : "public"),
					look: options.look === true,
					maximumBytes: 64 * MiB,
					...(options.fileSha256 ? { fileSha256: options.fileSha256 } : {}),
				},
				state: "queued",
				token: null,
				attempts: 0,
				progress: null,
				look: null,
				outcome: null,
			};
			k.rows.push(row);
			return row;
		},
		raise(code: string, why: string): never {
			k.raised.push(`${code} ${why}`);
			throw new Error("CODING_CONTROL_UNCONFIRMED");
		},
		/** The broker's fetch authority for an import (`qorpera_authorize_code_import_fetch`): only while it fetches. */
		authorize(scope: { requestId: string; leaseToken: string }, repository: { owner: string; name: string }) {
			const row = k.rows.find((each) => each.id === scope.requestId);
			const ok =
				!k.deny &&
				row !== undefined &&
				row.state === "running" &&
				row.token === scope.leaseToken &&
				row.input.via === "connection" &&
				String((row.input.from as Record<string, unknown>).github).toLowerCase() ===
					`${repository.owner}/${repository.name}`.toLowerCase() &&
				row.progress?.step === "fetch" &&
				!("raw" in (row.progress ?? {})) &&
				row.look === null &&
				!k.registry.has(`${row.owner}/${row.name}`);
			k.authorized.push(ok);
			return ok;
		},
		item(row: Row) {
			return {
				requestId: row.id,
				token: row.token,
				leaseUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
				companyId: COMPANY,
				environmentId: ENVIRONMENT,
				owner: row.owner,
				name: row.name,
				kind: "import",
				input: structuredClone(row.input),
				progress: row.progress === null ? null : structuredClone(row.progress),
				looked: row.look === null ? null : structuredClone(row.look),
			};
		},
		async call(method: string, args: Record<string, unknown>): Promise<unknown> {
			if (args.p_owner !== OWNER || args.p_machine_id_sha256 !== MACHINE)
				return k.raise("42501", "Coding machine custody required");
			if (method === "qorpera_code_requests_claim") {
				const kinds = args.p_kinds;
				if (
					!Array.isArray(kinds) ||
					!kinds.length ||
					!kinds.every((kind) => ["undo", "download", "restore", "import"].includes(kind)) ||
					!Number.isSafeInteger(args.p_limit)
				)
					return k.raise("22023", "Code request kinds invalid");
				const requests: unknown[] = [];
				if (kinds.includes("import"))
					for (const row of k.rows) {
						if (row.state !== "queued") continue;
						// An import whose bytes are in and whose look is not waits for quiet, and counts no claim.
						if (row.progress && "raw" in row.progress && row.look === null && !k.quiet) {
							row.progress = { ...row.progress, waiting: "SESSIONS_BUSY" };
							continue;
						}
						if (row.attempts >= 5) {
							row.state = "failed";
							row.outcome = {
								schema: "qorpera.code-request-outcome/v1",
								state: "failed",
								code: "DID_NOT_FINISH",
							};
							continue;
						}
						row.state = "running";
						row.token = randomUUID();
						row.attempts += 1;
						if (row.progress) {
							const { waiting: _waiting, ...rest } = row.progress;
							row.progress = Object.keys(rest).length ? rest : null;
						}
						requests.push(k.item(row));
						break;
					}
				return { schema: "qorpera.code-requests/v1", requests };
			}
			if (!CODE_IMPORT_RUN_RPCS.includes(method as never) && method !== "qorpera_code_request_finish")
				return k.raise("PGRST202", method);
			const row = k.rows.find((each) => each.id === args.p_request_id);
			const leased = row !== undefined && row.state === "running" && args.p_token === row.token;
			if (method === "qorpera_code_request_step") {
				const progress = args.p_progress;
				if (!isRecord(progress) || Buffer.byteLength(JSON.stringify(progress)) > 3072)
					return k.raise("22023", "Code request progress invalid");
				if (!leased || !row) return { schema: "qorpera.code-request-step/v1", state: "lost" };
				// Only the executor's own keys come (C1's codeImportProgressValue), never the kernel's words.
				let readable = false;
				try {
					readable = isDeepStrictEqual(codeImportProgressOf(progress), progress);
				} catch {
					readable = false;
				}
				if (!readable || "recorded" in progress || "waiting" in progress)
					return k.raise("22023", "Code request progress not the executor's");
				const kept = row.progress ?? {};
				const next: Record<string, unknown> = {
					...progress,
					...(kept.raw ? { raw: kept.raw } : {}),
					...(kept.kept ? { kept: kept.kept } : {}),
					...(kept.recorded ? { recorded: kept.recorded } : {}),
				};
				delete next.waiting;
				if (progress.step === "look" && kept.step !== "look" && row.look === null && !k.quiet) {
					// The step that first names the look waits for quiet: back in the queue with what it brings, the
					// row's step and the word, its claim given back.
					row.progress = { ...next, step: kept.step, waiting: "SESSIONS_BUSY" };
					if (kept.step === undefined) delete row.progress.step;
					row.state = "queued";
					row.token = null;
					row.attempts = Math.max(row.attempts - 1, 0);
					return { schema: "qorpera.code-request-step/v1", state: "busy" };
				}
				row.progress = next;
				k.onStep(row);
				return {
					schema: "qorpera.code-request-step/v1",
					state: "go",
					leaseUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
				};
			}
			if (method === "qorpera_code_import_looked") {
				if (!lookValid(args.p_look) || Buffer.byteLength(JSON.stringify(args.p_look)) > 16_000)
					return k.raise("22023", "Code import look invalid");
				if (!leased || !row) return { schema: "qorpera.code-import-looked/v1", state: "lost" };
				if (row.look !== null && JSON.stringify(row.look) !== JSON.stringify(args.p_look))
					return k.raise("22023", "Code import look invalid (another)");
				row.look = structuredClone(args.p_look);
				return { schema: "qorpera.code-import-looked/v1", state: "recorded" };
			}
			if (method === "qorpera_code_import_record") {
				const imported = args.p_imported;
				if (
					!only(imported, ["schema", "bundle", "mainSha", "files"]) ||
					(imported as Record<string, unknown>).schema !== "qorpera.code-import-record/v1" ||
					!textIs((imported as Record<string, unknown>).bundle, BUNDLE) ||
					!textIs((imported as Record<string, unknown>).mainSha, SHA) ||
					!count((imported as Record<string, unknown>).files)
				)
					return k.raise("22023", "Code import record invalid");
				const { bundle, mainSha, files } = imported as { bundle: string; mainSha: string; files: number };
				if (!leased || !row) return { schema: "qorpera.code-import-recorded/v1", state: "lost" };
				const kept = (row.progress?.kept ?? {}) as Record<string, unknown>;
				if (row.input.look !== false || row.look === null || kept.name !== bundle || kept.mainSha !== mainSha)
					return k.raise("22023", "Code import record invalid (look, kept)");
				if (row.progress?.recorded)
					return { schema: "qorpera.code-import-recorded/v1", state: "recorded", change: 1 };
				const place = `${row.owner}/${row.name}`;
				if (k.registry.has(place)) return k.raise("55000", "A repository is kept at that place already");
				const from = row.input.from as Record<string, unknown>;
				const look = row.look as Record<string, unknown>;
				const importedFrom = {
					...(from.github
						? { kind: "github", repository: from.github, via: row.input.via }
						: { kind: "file", name: String(from.file).replace(/^.*\//, ""), sha256: row.input.fileSha256 }),
					branch: look.defaultBranch,
					commit: mainSha,
					commits: look.commits,
				};
				k.registry.set(place, { mainSha, importedFrom });
				k.changes.push({
					place,
					n: 1,
					kind: "import",
					state: "landed",
					mainBefore: null,
					mainAfter: mainSha,
					requestId: row.id,
					title: from.github
						? `Brought in from GitHub: ${from.github}`
						: `Brought in from ${String(from.file).replace(/^.*\//, "")}`,
					checksState: "not_run",
					filesChanged: files,
				});
				row.progress = { ...row.progress, recorded: { change: 1, bundle, mainSha } };
				return { schema: "qorpera.code-import-recorded/v1", state: "recorded", change: 1 };
			}
			// The finish.
			const outcome = args.p_outcome as Record<string, unknown>;
			if (!outcomeValid(outcome)) return k.raise("22023", "Code request outcome invalid");
			if (!leased || !row) return { schema: "qorpera.code-request-finish/v1", state: "lost" };
			const recorded = row.progress?.recorded as Record<string, unknown> | undefined;
			if (recorded && outcome.state !== "busy" && outcome.result !== "imported")
				return k.raise("55000", "Code import is recorded");
			if (
				outcome.result === "imported" &&
				(recorded?.bundle !== outcome.bundle || recorded?.mainSha !== outcome.mainSha)
			)
				return k.raise("55000", "Code import is not recorded");
			if (outcome.result === "looked" && (row.input.look !== true || row.look === null))
				return k.raise("22023", "Code request outcome invalid (looked)");
			row.token = null;
			if (outcome.state === "busy") {
				row.state = "queued";
				return { schema: "qorpera.code-request-finish/v1", state: "recorded", change: null };
			}
			row.state = outcome.state as Row["state"];
			row.outcome = outcome.result === "imported" ? { ...outcome, change: 1 } : outcome;
			return {
				schema: "qorpera.code-request-finish/v1",
				state: "recorded",
				change: outcome.result === "imported" ? 1 : null,
			};
		},
	};
	return k;
}

// The world: the company's folder and scratch on a local disk, the store beside them, and the executor ---------------

async function world() {
	const root = await scratch("code-import-e2e-world-");
	const companyRoot = join(root, "folder"),
		scratchRoot = join(root, "scratch");
	for (const dir of [companyRoot, scratchRoot, join(root, "control")]) await mkdir(dir);
	const store = createCodeBundleStore({ root: join(root, "control", CODE_BUNDLE_FOLDER) });
	const k = kernel();
	const gh = await github();
	/** The broker's relay to that GitHub: each call asks the kernel's fetch authority first, as the broker does. */
	const transports: CodeImportTransports = {
		connection: (scope, repository) => {
			const inner = gh.transport();
			const refused: CodeImportAnswer = { by: "relay", status: 403, error: "refused" };
			return {
				refs: async (signal) => (k.authorize(scope, repository) ? inner.refs(signal) : refused),
				uploadPack: async (body, signal) =>
					k.authorize(scope, repository) ? inner.uploadPack(body, signal) : refused,
			};
		},
		public: () => gh.transport(),
	};
	const hosts: Pick<CodeHostJobs, "run"> = {
		run: (async (_companyId, _environmentId, signal, job) => {
			signal.throwIfAborted();
			const host: CodeHostJob = { shell: localShell([]), layout: { companyRoot, scratchRoot, git: GIT }, signal };
			return await job(host, gc);
		}) as Pick<CodeHostJobs, "run">["run"],
	};
	const events: Record<string, unknown>[] = [];
	/** One executor: its CodeImport, handed to its request loop as Q's `imports`. */
	const executor = () => {
		const imports = new CodeImport({
			control: k,
			hosts,
			bundles: store,
			imports: store,
			transports,
			fetch: fetchGitHubImport,
			jobs: CODE_HOST_IMPORT_JOBS,
			owner: OWNER,
			machineIdSha256: MACHINE,
			report: (event) => events.push(event),
		});
		const refuse = async () => {
			throw new Error("no undo or download here");
		};
		return new CodeHostRequests({
			control: k,
			hosts,
			jobs: { undo: refuse, archive: refuse, removeDownloads: refuse },
			records: { inJob: refuse },
			imports,
			owner: OWNER,
			machineIdSha256: MACHINE,
			report: (event) => events.push(event),
		});
	};
	/** One pass of an executor and everything it started, to their ends. */
	const pass = async (requests = executor(), signal = new AbortController().signal) => {
		await requests.pass(signal);
		await requests.settled();
	};
	const place = (owner: string, name: string) => join(companyRoot, "code", owner, name);
	const refs = async (owner: string, name: string) =>
		(await git(join(place(owner, name), "repo.git"), "for-each-ref", "--format=%(refname) %(objectname)"))
			.split("\n")
			.sort();
	return { root, companyRoot, store, k, gh, events, executor, pass, place, refs };
}

const target = (owner: string, name: string) => ({ companyId: COMPANY, owner, name });
/** Nothing an import logs holds a byte of the source: a path in it, the key, git's words. */
const quiet = (events: Record<string, unknown>[]) => {
	const said = JSON.stringify(events);
	for (const word of [KEY, "config.js", "src/", "README", "notes.md", "fatal", "error:"])
		expect(said).not.toContain(word);
	expect(events.filter((event) => event.event === "code-request-error")).toEqual([]);
};

describe("an import from end to end, with every part as merged", { timeout: 240_000 }, () => {
	it("looks at a public GitHub project alone, then brings it in over a GitHub copy at its place", async () => {
		const w = await world();
		// The GitHub copy at the place: a repository and a session's worktree with a file not committed.
		await mkdir(join(w.place("acme", "shop"), "repo.git"), { recursive: true });
		await writeFile(join(w.place("acme", "shop"), "repo.git", "HEAD"), "ref: refs/heads/main\n");
		await mkdir(join(w.place("acme", "shop"), "worktrees", "w1"), { recursive: true });
		await writeFile(join(w.place("acme", "shop"), "worktrees", "w1", "notes.txt"), "not committed\n");

		const looking = w.k.ask("acme", "shop", { github: "Acme/Shop" }, { look: true });
		await w.pass();
		expect(w.k.raised).toEqual([]);
		expect(looking).toMatchObject({ state: "done", outcome: { state: "done", result: "looked" } });
		expect(w.k.registry.size).toBe(0);
		const look = looking.look as Record<string, unknown>;
		expect(look).toMatchObject({
			defaultBranch: "master",
			mainSha: source.master,
			commits: 3,
			authors30d: 1,
			tags: { seen: 1, kept: 1 },
			branches: { seen: 1, kept: 1 },
			fits: true,
			why: null,
			lfs: { pointers: 0 },
			submodules: 0,
		});
		// The key only in history: its kind and the file it was in, never its value; not in main.
		expect((look.secrets as Record<string, unknown>).shown).toEqual([
			{ kind: "aws", path: "src/config.js", inMain: false },
		]);
		expect(JSON.stringify(look)).not.toContain(KEY);
		// A look alone leaves the place as it was and the store empty.
		expect(await readFile(join(w.place("acme", "shop"), "repo.git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
		expect(await w.store.names(target("acme", "shop"))).toEqual([]);

		const bringing = w.k.ask("acme", "shop", { github: "Acme/Shop" });
		await w.pass();
		expect(w.k.raised).toEqual([]);
		expect(bringing.state).toBe("done");
		const outcome = bringing.outcome as Record<string, unknown>;
		expect(outcome).toMatchObject({ state: "done", result: "imported", change: 1, mainSha: source.master });
		expect(outcome.setAside).toMatch(/^code\/_set-aside\/acme\/at-\d{8}T\d{6}Z\/shop$/);
		// The kernel's record: the registry row and change 1.
		expect(w.k.registry.get("acme/shop")).toEqual({
			mainSha: source.master,
			importedFrom: {
				kind: "github",
				repository: "Acme/Shop",
				via: "public",
				branch: "master",
				commit: source.master,
				commits: 3,
			},
		});
		expect(w.k.changes).toEqual([
			expect.objectContaining({
				place: "acme/shop",
				n: 1,
				kind: "import",
				mainBefore: null,
				mainAfter: source.master,
				title: "Brought in from GitHub: Acme/Shop",
				checksState: "not_run",
				filesChanged: 3,
			}),
		]);
		// The place: master as main and the mark, the tag, the other branch kept read-only, main/ checked out, the
		// place open; the GitHub copy aside whole.
		const v1 = await git(source.bare, "rev-parse", "v1");
		const feature = await git(source.bare, "rev-parse", "feature");
		expect(await w.refs("acme", "shop")).toEqual(
			[
				`refs/heads/main ${source.master}`,
				`refs/qorpera/imported/heads/feature ${feature}`,
				`refs/qorpera/kept-here ${source.master}`,
				`refs/tags/v1 ${v1}`,
			].sort(),
		);
		expect(await readFile(join(w.place("acme", "shop"), "main", "src", "app.js"), "utf8")).toBe(
			"console.log('shop');\n",
		);
		expect(await exists(join(w.place("acme", "shop"), "restoring.json"))).toBe(false);
		expect(
			await readFile(join(w.companyRoot, String(outcome.setAside), "worktrees", "w1", "notes.txt"), "utf8"),
		).toBe("not committed\n");
		// The store keeps the first bundle with the repository, and the restore-shaped one as an ordinary bundle.
		expect(await w.store.names(target("acme", "shop"))).toEqual([outcome.bundle, outcome.rawBundle]);
		expect(await w.store.find(target("acme", "shop"), String(outcome.bundle))).toMatchObject({
			mainSha: source.master,
		});
		quiet(w.events);
	});

	it("brings in a file source an agent made into a bundle, and tidies the file away", async () => {
		const w = await world();
		const path = "code/_incoming/drop/notes.bundle";
		await mkdir(dirname(join(w.companyRoot, path)), { recursive: true });
		await git(source.notes, "bundle", "create", join(w.companyRoot, path), "--all");
		const sha256 = createHash("sha256")
			.update(await readFile(join(w.companyRoot, path)))
			.digest("hex");
		const row = w.k.ask("acme", "notes", { file: path }, { fileSha256: sha256 });
		await w.pass();
		expect(w.k.raised).toEqual([]);
		expect(row.outcome).toMatchObject({
			state: "done",
			result: "imported",
			mainSha: source.notesMain,
			setAside: null,
		});
		expect(w.k.registry.get("acme/notes")?.importedFrom).toEqual({
			kind: "file",
			name: "notes.bundle",
			sha256,
			branch: "main",
			commit: source.notesMain,
			commits: 1,
		});
		expect(w.k.changes[0]).toMatchObject({ title: "Brought in from notes.bundle", filesChanged: 1 });
		expect(await w.refs("acme", "notes")).toEqual(
			[`refs/heads/main ${source.notesMain}`, `refs/qorpera/kept-here ${source.notesMain}`].sort(),
		);
		expect(await readFile(join(w.place("acme", "notes"), "main", "notes.md"), "utf8")).toBe("notes\n");
		// The file and its folder, emptied, are gone.
		expect(await exists(join(w.companyRoot, path))).toBe(false);
		expect(await exists(join(w.companyRoot, "code/_incoming/drop"))).toBe(false);
		// Nothing went to GitHub.
		expect(w.gh.seen).toEqual([]);
		quiet(w.events);
	});

	it("fetches through the connection only in the fetch's window, and a run cut after the fetch goes on without fetching again", async () => {
		const w = await world();
		const row = w.k.ask("acme", "web", { github: "Acme/Shop" }, { via: "connection" });
		// The executor stops right after the kernel kept the first bundle.
		const stopping = new AbortController();
		w.k.onStep = (stepped) => {
			if (stepped.progress && "raw" in stepped.progress && !stopping.signal.aborted)
				stopping.abort(new Error("the executor stopped"));
		};
		await w.pass(w.executor(), stopping.signal);
		expect(w.k.raised).toEqual([]);
		expect(row).toMatchObject({ state: "queued", attempts: 1, look: null });
		expect(row.progress).toMatchObject({ step: "fetch", raw: { mainSha: source.master } });
		expect(w.gh.seen).toEqual(["refs", "ls-refs", "fetch"]);
		// Every relay call came while the import fetched: step fetch, no first bundle, no look.
		expect(w.k.authorized).toEqual([true, true, true]);
		const raw = (row.progress?.raw as Record<string, unknown>).name;
		expect(await w.store.names(target("acme", "web"))).toEqual([raw]);

		// A new executor claims it again: it looks at the bundle the kernel kept, and brings it in.
		w.k.onStep = () => {};
		await w.pass();
		expect(w.k.raised).toEqual([]);
		expect(row).toMatchObject({
			state: "done",
			attempts: 2,
			outcome: { result: "imported", rawBundle: raw, mainSha: source.master },
		});
		expect(w.gh.seen).toEqual(["refs", "ls-refs", "fetch"]);
		expect(w.k.authorized).toEqual([true, true, true]);
		expect(w.k.registry.get("acme/web")?.importedFrom).toMatchObject({
			kind: "github",
			repository: "Acme/Shop",
			via: "connection",
		});
		expect(await w.refs("acme", "web")).toContain(`refs/heads/main ${source.master}`);
		quiet(w.events);
		// What the relay would say after the window: the kernel's authority refuses (the record is in).
		expect(w.k.authorize({ requestId: row.id, leaseToken: "x" }, { owner: "Acme", name: "Shop" })).toBe(false);
	});

	it("puts an import off twice when the relay refuses it, and refuses it the third time, leaving nothing", async () => {
		const w = await world();
		w.k.deny = true;
		const row = w.k.ask("acme", "private", { github: "Acme/Shop" }, { via: "connection" });
		for (const refused of [1, 2]) {
			await w.pass();
			expect(w.k.raised).toEqual([]);
			expect(row).toMatchObject({
				state: "queued",
				attempts: refused,
				progress: { step: "fetch", relayRefused: refused },
			});
		}
		await w.pass();
		expect(w.k.raised).toEqual([]);
		expect(row).toMatchObject({
			state: "refused",
			attempts: 3,
			outcome: { schema: "qorpera.code-request-outcome/v1", state: "refused", code: "IMPORT_SOURCE_REFUSED" },
		});
		expect(w.k.authorized).toEqual([false, false, false]);
		expect(w.gh.seen).toEqual([]);
		expect(await w.store.names(target("acme", "private"))).toEqual([]);
		expect(await exists(w.place("acme", "private"))).toBe(false);
		quiet(w.events);
	});

	it("waits at the look for quiet as the kernel says, without a lost finish logged, and goes on when it is quiet", async () => {
		const w = await world();
		const row = w.k.ask("acme", "later", { github: "Acme/Shop" });
		w.k.quiet = false;
		await w.pass();
		expect(w.k.raised).toEqual([]);
		// Back in the queue with its bytes and the word, its claim given back; the request loop's own quiet line.
		expect(row).toMatchObject({
			state: "queued",
			attempts: 0,
			look: null,
			progress: { step: "fetch", waiting: "SESSIONS_BUSY" },
		});
		expect(w.events.filter((event) => event.event === "code-import-waiting")).toEqual([
			{ event: "code-import-waiting", requestId: row.id },
		]);
		// Not quiet yet: the claim leaves it waiting.
		await w.pass();
		expect(row).toMatchObject({ state: "queued", attempts: 0 });
		w.k.quiet = true;
		await w.pass();
		expect(w.k.raised).toEqual([]);
		expect(row).toMatchObject({
			state: "done",
			attempts: 1,
			outcome: { result: "imported", mainSha: source.master },
		});
		expect(w.gh.seen.filter((kind) => kind === "fetch")).toHaveLength(1);
		quiet(w.events);
		expect(codeImportRequestOf(w.k.item({ ...row, state: "running", token: randomUUID() }))).toMatchObject({
			kind: "import",
		});
	});
});
