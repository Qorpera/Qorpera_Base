import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CODE_BUNDLE_FOLDER, type CodeBundleRef, createCodeBundleStore } from "../src/code-bundle-store.ts";
import {
	CODE_IMPORT_PIECE_BYTES,
	type CodeImportAnswer,
	type CodeImportFetched,
	type CodeImportSink,
	CodeImportStop,
	type CodeImportTransport,
	codeImportBundleHeaderOf,
	codeImportBundleName,
	codeImportFetchRequest,
	codeImportLsRefsRequest,
	codeImportPktLine,
	codeImportRelayRefusals,
} from "../src/code-import.ts";
import { fetchGitHubImport } from "../src/code-import-fetch.ts";

// Step 6, part C2: the import's fetch, as the coding executor runs it: protocol v2 over smart HTTP, bytes only. The
// source is real `git upload-pack --stateless-rpc` (GIT_PROTOCOL=version=2) behind a loopback HTTP server, or a
// stand-in where a source must misbehave; the transport is a plain HTTP client, so the fetch is seen alone (the two
// real transports have their own test, packages/runtime/test/cloud-coding-repository-fetch.test.ts).

const GIT = "/usr/bin/git";
const PATH = "/usr/local/bin:/usr/bin:/bin";
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const REPOSITORY = { owner: "Acme", name: "Shop" };
/** What a source says in its own words; none of it may reach an error. */
const CANARY = "remote-words-CANARY-7f3a";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
afterAll(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function scratch() {
	const top = await realpath(await mkdtemp(join(tmpdir(), "code-import-fetch-")));
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
async function run(argv: string[], options: { env: Record<string, string>; input?: Uint8Array; cwd?: string }) {
	const child = spawn(argv[0] as string, argv.slice(1), { env: options.env, cwd: options.cwd });
	const out: Buffer[] = [],
		err: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
	child.stdin.on("error", () => {});
	child.stdin.end(options.input ?? Buffer.alloc(0));
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() };
}
let home = "";
async function git(dir: string, args: string[], input?: Uint8Array) {
	const result = await run([GIT, ...args], { env: gitEnv(home), cwd: dir, input });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

/** The test's sources, each a bare repository. */
const repos = { small: "", large: "", many: "", before: "", after: "" };
beforeAll(async () => {
	home = await scratch();
	const work = join(home, "work");
	await mkdir(work);
	await git(work, ["init", "--quiet", "--initial-branch=master"]);
	await writeFile(join(work, "a.txt"), "one\n");
	await git(work, ["add", "."]);
	await git(work, ["commit", "--quiet", "-m", "one"]);
	await git(work, ["tag", "v0"]);
	await writeFile(join(work, "b.txt"), "two\n");
	await git(work, ["add", "."]);
	await git(work, ["commit", "--quiet", "-m", "two"]);
	await git(work, ["tag", "-a", "v1", "-m", "release one"]);
	await git(work, ["branch", "feature", "HEAD~1"]);
	repos.small = join(home, "small.git");
	await git(home, ["clone", "--quiet", "--bare", work, repos.small]);

	// 2.5 MiB that no compression shrinks: a pack over two 1 MiB pieces.
	const big = join(home, "big");
	await mkdir(big);
	await git(big, ["init", "--quiet", "--initial-branch=main"]);
	await writeFile(join(big, "big.bin"), randomBytes(2.5 * MiB));
	await writeFile(join(big, "README"), "big\n");
	await git(big, ["add", "."]);
	await git(big, ["commit", "--quiet", "-m", "big"]);
	repos.large = join(home, "large.git");
	await git(home, ["clone", "--quiet", "--bare", big, repos.large]);

	// 20,000 tags beside main and HEAD: 20,002 lines, two more than the ref list takes.
	repos.many = join(home, "many.git");
	await git(home, ["clone", "--quiet", "--bare", work, repos.many]);
	const head = await git(repos.many, ["rev-parse", "master"]);
	const tags = Array.from({ length: 20_000 }, (_, n) => `${head} refs/tags/t${String(n).padStart(5, "0")}`);
	await writeFile(
		join(repos.many, "packed-refs"),
		`# pack-refs with: peeled fully-peeled sorted \n${[`${head} refs/heads/master`, ...tags].sort().join("\n")}\n`,
	);
	await rm(join(repos.many, "refs", "heads", "master"), { force: true });
	await rm(join(repos.many, "refs", "tags"), { recursive: true, force: true });

	// The same project before and after a force-push: what the first ref list names is gone from the second.
	for (const [key, text] of [
		["before", "before\n"],
		["after", "after\n"],
	] as const) {
		const dir = join(home, key);
		await mkdir(dir);
		await git(dir, ["init", "--quiet", "--initial-branch=main"]);
		await writeFile(join(dir, "f.txt"), text);
		await git(dir, ["add", "."]);
		await git(dir, ["commit", "--quiet", "-m", key]);
		repos[key] = join(home, `${key}.git`);
		await git(home, ["clone", "--quiet", "--bare", dir, repos[key]]);
	}
}, 120_000);

type Kind = "refs" | "ls-refs" | "fetch";
interface Seen {
	readonly kind: Kind;
	readonly method: string;
	readonly url: string;
	readonly headers: IncomingMessage["headers"];
	readonly body: Buffer;
}

/** A loopback smart HTTP server. Each request is answered by `answer` when it answers it, else by real git from the
 * repository `repository` names (by the request's kind and how many of that kind came before). */
async function serve(options: {
	repository?: (kind: Kind, count: number) => string;
	serviceLine?: boolean;
	answer?: (kind: Kind, reply: ServerResponse, count: number) => boolean;
}) {
	const seen: Seen[] = [];
	const counts: Record<Kind, number> = { refs: 0, "ls-refs": 0, fetch: 0 };
	const sockets = new Set<Socket>();
	const server = createServer((incoming, reply) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = Buffer.concat(chunks);
			const kind: Kind = incoming.method === "GET" ? "refs" : body.includes("command=ls-refs") ? "ls-refs" : "fetch";
			counts[kind] += 1;
			seen.push({ kind, method: incoming.method ?? "", url: incoming.url ?? "", headers: incoming.headers, body });
			if (options.answer?.(kind, reply, counts[kind])) return;
			const dir = options.repository?.(kind, counts[kind]) ?? repos.small;
			// One thread packs: the same objects give the same pack bytes every time.
			const env = {
				...gitEnv(home),
				GIT_PROTOCOL: "version=2",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "pack.threads",
				GIT_CONFIG_VALUE_0: "1",
			};
			const child =
				kind === "refs"
					? spawn(GIT, ["upload-pack", "--http-backend-info-refs", dir], { env })
					: spawn(GIT, ["upload-pack", "--stateless-rpc", dir], { env });
			child.stdin.on("error", () => {});
			child.stdin.end(kind === "refs" ? undefined : body);
			reply.on("close", () => child.kill());
			reply.writeHead(200, {
				"content-type": `application/x-git-upload-pack-${kind === "refs" ? "advertisement" : "result"}`,
			});
			if (kind === "refs" && options.serviceLine !== false) reply.write("001e# service=git-upload-pack\n0000");
			child.stdout.pipe(reply);
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return { port: (server.address() as AddressInfo).port, seen, sockets };
}

/** A plain HTTP client as the import's transport: its answers' bodies cut again into pieces of the sizes `size` gives,
 * whatever the socket gave, and the bytes it handed on counted. */
function transport(
	port: number,
	options: { size?: (n: number) => number; pulled?: { bytes: number } } = {},
): CodeImportTransport {
	async function* recut(answer: IncomingMessage): AsyncGenerator<Uint8Array, void, undefined> {
		let held: Buffer = Buffer.alloc(0),
			n = 0;
		const count = (piece: Uint8Array) => {
			if (options.pulled) options.pulled.bytes += piece.byteLength;
			return piece;
		};
		for await (const chunk of answer as AsyncIterable<Buffer>) {
			if (!options.size) {
				yield count(chunk);
				continue;
			}
			held = held.length ? Buffer.concat([held, chunk]) : chunk;
			for (let size = options.size(n); held.length >= size; size = options.size(n)) {
				yield count(held.subarray(0, size));
				held = held.subarray(size);
				n += 1;
			}
		}
		if (held.length) yield count(held);
	}
	const send = (
		method: "GET" | "POST",
		path: string,
		headers: Record<string, string>,
		body: Uint8Array | undefined,
		signal: AbortSignal,
	) =>
		new Promise<CodeImportAnswer>((resolve, reject) => {
			const outgoing = request({ host: "127.0.0.1", port, method, path, headers, agent: false, signal });
			outgoing.once("response", (answer) =>
				resolve({
					by: "source",
					status: answer.statusCode ?? 0,
					contentType: answer.headers["content-type"]?.split(";")[0] ?? null,
					body: recut(answer),
				}),
			);
			outgoing.once("error", reject);
			outgoing.end(body);
		});
	return {
		refs: (signal: AbortSignal) =>
			send(
				"GET",
				"/Acme/Shop.git/info/refs?service=git-upload-pack",
				{ "git-protocol": "version=2" },
				undefined,
				signal,
			),
		uploadPack: (body: Uint8Array, signal: AbortSignal) =>
			send(
				"POST",
				"/Acme/Shop.git/git-upload-pack",
				{
					"git-protocol": "version=2",
					"content-type": "application/x-git-upload-pack-request",
					"content-length": String(body.byteLength),
				},
				body,
				signal,
			),
	};
}

/** A sink that keeps every piece it was given. */
function memory(): CodeImportSink & { pieces: Buffer[]; bytes: () => Buffer } {
	const pieces: Buffer[] = [];
	return {
		pieces,
		bytes: () => Buffer.concat(pieces),
		write: async (chunk: Uint8Array) => {
			pieces.push(Buffer.from(chunk));
		},
	};
}

const fetchOf = (
	transportOf: CodeImportTransport,
	writer: CodeImportSink,
	extra: {
		maximumBytes?: number;
		branch?: string | null;
		signal?: AbortSignal;
		idleMs?: number;
		fetchMs?: number;
	} = {},
) =>
	fetchGitHubImport(
		{
			transport: transportOf,
			repository: REPOSITORY,
			branch: extra.branch ?? null,
			maximumBytes: extra.maximumBytes ?? GiB,
			signal: extra.signal ?? new AbortController().signal,
		},
		writer,
		{ idleMs: extra.idleMs, fetchMs: extra.fetchMs },
	);

/** How a fetch stopped: the stop's three facts, and that nothing of the source's words is in the error. */
async function stopped(work: Promise<unknown>) {
	const error = await work.then(
		() => null,
		(caught: unknown) => caught,
	);
	if (!(error instanceof CodeImportStop)) throw new Error(`not a stop: ${String(error)}`);
	expect(error.message).toBe(error.code);
	expect(error.cause).toBeUndefined();
	expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(CANARY);
	return { end: error.end, code: error.code, notOurRef: error.notOurRef };
}
const stop = (end: string, code: string, notOurRef = false) => ({ end, code, notOurRef });

/** The refs a bare repository has, as `for-each-ref` names them. */
async function refsOf(dir: string) {
	return (await git(dir, ["for-each-ref", "--format=%(objectname) %(objecttype) %(refname)"])).split("\n");
}

/** Writes a fetched first bundle into a real store's import writer, commits it, and proves it with git: `bundle
 * verify`, a strict fetch of every ref into a new repository and `fsck --full --strict`. */
async function proven(fetchIt: (writer: CodeImportSink) => Promise<CodeImportFetched>) {
	const top = await scratch();
	const store = createCodeBundleStore({ root: join(top, CODE_BUNDLE_FOLDER) });
	const target = { companyId: COMPANY, owner: "acme", name: "shop" };
	const writer = await store.begin(target, { kind: "import", maximumBytes: GiB });
	const fetched = await fetchIt(writer);
	const createdAt = "2026-11-12T16:00:00.000Z";
	const name = codeImportBundleName(createdAt, fetched.mainSha);
	const manifest = await writer.commit(name, {
		environmentId: ENVIRONMENT,
		createdAt,
		from: { github: "Acme/Shop" },
		defaultBranch: fetched.defaultBranch,
		mainSha: fetched.mainSha,
		refs: fetched.refs,
		leftOut: fetched.leftOut,
		sha256: fetched.sha256,
		bytes: fetched.bytes,
		executorOwner: "coding-node-1",
	});
	const read = await store.readImport(target, name);
	const pieces: Buffer[] = [];
	for await (const piece of read.pieces) pieces.push(Buffer.from(piece));
	const bundle = Buffer.concat(pieces);
	expect(createHash("sha256").update(bundle).digest("hex")).toBe(manifest.sha256);
	const file = join(top, "first.bundle");
	await writeFile(file, bundle);
	const proof = join(top, "proof.git");
	await git(top, ["init", "--quiet", "--bare", proof]);
	const verified = await run([GIT, `--git-dir=${proof}`, "bundle", "verify", file], { env: gitEnv(home) });
	expect(verified.code).toBe(0);
	expect(verified.stderr + verified.stdout.toString()).toContain("records a complete history");
	await git(top, [
		`--git-dir=${proof}`,
		"-c",
		"transfer.fsckObjects=true",
		"fetch",
		"--quiet",
		"--no-tags",
		"--no-write-fetch-head",
		file,
		"+refs/*:refs/*",
	]);
	await git(top, [`--git-dir=${proof}`, "fsck", "--full", "--strict", "--no-progress"]);
	return { fetched, manifest, bundle, proof };
}

describe("the import's fetch, against real git upload-pack", { timeout: 120_000 }, () => {
	it("brings a repository in as one bundle that git verifies and fetches strictly, from either form of the advertisement", async () => {
		const master = await git(repos.small, ["rev-parse", "master"]),
			feature = await git(repos.small, ["rev-parse", "feature"]),
			v1 = await git(repos.small, ["rev-parse", "v1"]);
		const header: CodeBundleRef[] = [
			{ name: "refs/heads/master", sha: master },
			{ name: "refs/heads/feature", sha: feature },
			{ name: "refs/tags/v0", sha: feature },
			{ name: "refs/tags/v1", sha: v1 },
		];
		for (const serviceLine of [true, false]) {
			const source = await serve({ serviceLine });
			const { fetched, manifest, bundle, proof } = await proven((writer) => fetchOf(transport(source.port), writer));
			expect(fetched).toEqual({
				sha256: manifest.sha256,
				bytes: bundle.length,
				defaultBranch: "master",
				mainSha: master,
				refs: header,
				leftOut: 0,
			});
			expect(codeImportBundleHeaderOf(bundle).refs).toEqual(header);
			expect(await refsOf(proof)).toEqual(await refsOf(repos.small));
			// One GET and two POSTs, each as protocol v2 asks.
			expect(source.seen.map(({ kind, method, url }) => [kind, method, url])).toEqual([
				["refs", "GET", "/Acme/Shop.git/info/refs?service=git-upload-pack"],
				["ls-refs", "POST", "/Acme/Shop.git/git-upload-pack"],
				["fetch", "POST", "/Acme/Shop.git/git-upload-pack"],
			]);
			expect(source.seen.every((one) => one.headers["git-protocol"] === "version=2")).toBe(true);
			expect(source.seen[1]?.body).toEqual(codeImportLsRefsRequest());
			expect(source.seen[2]?.body).toEqual(codeImportFetchRequest([master, feature, v1]));
			await vi.waitFor(() => expect(source.sockets.size).toBe(0));
		}
	});

	it("takes the branch it is asked for as the default, and refuses one the source has not", async () => {
		const feature = await git(repos.small, ["rev-parse", "feature"]);
		const source = await serve({});
		const sink = memory();
		const fetched = await fetchOf(transport(source.port), sink, { branch: "feature" });
		expect([fetched.defaultBranch, fetched.mainSha, fetched.refs[0]]).toEqual([
			"feature",
			feature,
			{ name: "refs/heads/feature", sha: feature },
		]);
		expect(await stopped(fetchOf(transport(source.port), memory(), { branch: "gone" }))).toEqual(
			stop("refused", "IMPORT_BRANCH_UNKNOWN"),
		);
		expect(await stopped(fetchOf(transport(source.port), memory(), { branch: "a..b" }))).toEqual(
			stop("refused", "IMPORT_BRANCH_NAME"),
		);
	});

	it("writes the same bundle in pieces of 1 MiB however the answers are cut", async () => {
		const source = await serve({ repository: () => repos.large });
		const first = memory();
		const fetched = await fetchOf(transport(source.port), first);
		expect(fetched.bytes).toBeGreaterThan(2.5 * MiB);
		const sizes = first.pieces.map((piece) => piece.length);
		expect(sizes.slice(0, -1).every((size) => size === CODE_IMPORT_PIECE_BYTES)).toBe(true);
		expect(sizes.reduce((a, b) => a + b, 0)).toBe(fetched.bytes);
		expect(createHash("sha256").update(first.bytes()).digest("hex")).toBe(fetched.sha256);
		// A cut at every place a pkt-line or a piece can begin: odd sizes about a pkt-line's, and random ones.
		let seed = 7;
		const random = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return 1 + (seed % 131_040);
		};
		for (const size of [() => 65_519, () => 65_520, () => 65_521, () => 100_003, random]) {
			const again = memory();
			await expect(fetchOf(transport(source.port, { size }), again)).resolves.toEqual(fetched);
			expect(again.bytes().equals(first.bytes())).toBe(true);
		}
		// And every small cut, down to one byte, of a small project's answers.
		const small = await serve({});
		const whole = await fetchOf(transport(small.port), memory());
		for (let size = 1; size <= 24; size++)
			await expect(fetchOf(transport(small.port, { size: () => size }), memory())).resolves.toEqual(whole);
	});

	it("refuses a ref list over 20,000 lines before any pack is asked for", async () => {
		const source = await serve({ repository: () => repos.many });
		const sink = memory();
		expect(await stopped(fetchOf(transport(source.port), sink))).toEqual(stop("refused", "IMPORT_TOO_MANY_REFS"));
		expect(source.seen.map((one) => one.kind)).toEqual(["refs", "ls-refs"]);
		expect(sink.pieces).toEqual([]);
	});

	it("refuses a bundle over its maximum before the piece with the byte too many, and the run's abort leaves nothing", async () => {
		const source = await serve({ repository: () => repos.large });
		const size = (await fetchOf(transport(source.port), memory())).bytes;
		const top = await scratch();
		const store = createCodeBundleStore({ root: join(top, CODE_BUNDLE_FOLDER) });
		const target = { companyId: COMPANY, owner: "acme", name: "shop" };
		const writer = await store.begin(target, { kind: "import", maximumBytes: size - 1 });
		const written: number[] = [];
		const counting: CodeImportSink = {
			write: async (chunk, signal) => {
				written.push(chunk.byteLength);
				await writer.write(chunk, signal);
			},
		};
		expect(await stopped(fetchOf(transport(source.port), counting, { maximumBytes: size - 1 }))).toEqual(
			stop("refused", "IMPORT_TOO_LARGE"),
		);
		// Only whole pieces went in, none with the byte too many.
		expect(written.every((bytes) => bytes === CODE_IMPORT_PIECE_BYTES)).toBe(true);
		expect(written.length).toBe(Math.floor((size - 1) / CODE_IMPORT_PIECE_BYTES));
		await writer.abort();
		await expect(store.names(target)).resolves.toEqual([]);
		expect(await readdir(join(top, CODE_BUNDLE_FOLDER, COMPANY, "acme", "shop"))).toEqual([]);
		// At its maximum exactly, it is in.
		await expect(fetchOf(transport(source.port), memory(), { maximumBytes: size })).resolves.toMatchObject({
			bytes: size,
		});
	});

	it("asks for the ref list once more after a want the source no longer has, and only once", async () => {
		const after = await git(repos.after, ["rev-parse", "main"]);
		// The first ref list is of the project before its force-push; the fetch, and the second list, of after.
		const moved = await serve({
			repository: (kind, count) => (kind === "ls-refs" && count === 1 ? repos.before : repos.after),
		});
		const { fetched, proof } = await proven((writer) => fetchOf(transport(moved.port), writer));
		expect([fetched.mainSha, fetched.refs]).toEqual([after, [{ name: "refs/heads/main", sha: after }]]);
		expect(await refsOf(proof)).toEqual(await refsOf(repos.after));
		expect(moved.seen.map((one) => one.kind)).toEqual(["refs", "ls-refs", "fetch", "ls-refs", "fetch"]);
		// A source whose lists keep naming what it no longer has: its own error, after the one new list.
		const stale = await serve({ repository: (kind) => (kind === "ls-refs" ? repos.before : repos.after) });
		const sink = memory();
		expect(await stopped(fetchOf(transport(stale.port), sink))).toEqual(stop("failed", "IMPORT_SOURCE_ERROR", true));
		expect(stale.seen.map((one) => one.kind)).toEqual(["refs", "ls-refs", "fetch", "ls-refs", "fetch"]);
		expect(sink.pieces).toEqual([]);
	});
});

// Stand-ins for a source that misbehaves -----------------------------------------------------------------------------

const MAIN = "a".repeat(40);
const pkt = (text: string | Buffer) => codeImportPktLine(text);
const FLUSH = "0000";
const ADVERTISEMENT = Buffer.concat([
	Buffer.from("001e# service=git-upload-pack\n0000"),
	pkt("version 2\n"),
	pkt("ls-refs=unborn\n"),
	pkt("fetch=shallow\n"),
	pkt("object-format=sha1\n"),
	Buffer.from(FLUSH),
]);
const REF_LIST = Buffer.concat([
	pkt(`${MAIN} HEAD symref-target:refs/heads/main\n`),
	pkt(`${MAIN} refs/heads/main\n`),
	Buffer.from(FLUSH),
]);
const band = (n: number, data: Buffer | string) => pkt(Buffer.concat([Buffer.from([n]), Buffer.from(data)]));
/** One full band-1 line of a pack: the pack's header in the first, then bytes no parser reads further. */
const PACK_HEAD = band(1, Buffer.concat([Buffer.from("PACK\0\0\0\x02\0\0\0\x01"), randomBytes(65_515 - 12)]));
const PACK_LINE = band(1, randomBytes(65_515));

/** A stand-in GitHub: the advertisement and the ref list as GitHub sends them, and `fetch` answering the fetch. */
function standIn(
	fetchAnswer: (reply: ServerResponse, count: number) => void,
	refs?: (reply: ServerResponse) => boolean,
) {
	return serve({
		answer: (kind, reply, count) => {
			if (kind === "refs") {
				if (refs?.(reply)) return true;
				reply.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
				reply.end(ADVERTISEMENT);
			} else if (kind === "ls-refs") {
				reply.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
				reply.end(REF_LIST);
			} else fetchAnswer(reply, count);
			return true;
		},
	});
}
const result = (reply: ServerResponse) =>
	reply.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });

/** A pack of `lines` full lines, written as fast as the reader takes it, counting what the reader's socket took. */
function streamPack(reply: ServerResponse, lines: number, sent: { bytes: number }) {
	result(reply);
	reply.write(pkt("packfile\n"));
	let n = 0;
	const more = () => {
		while (n < lines) {
			const line = n === 0 ? PACK_HEAD : PACK_LINE;
			n += 1;
			sent.bytes += line.length;
			if (!reply.write(line)) {
				reply.once("drain", more);
				return;
			}
		}
		reply.end(FLUSH);
	};
	more();
}

describe("the import's fetch, against a source that misbehaves", { timeout: 60_000 }, () => {
	it("says how a source's answers end: moved, refused, busy, not protocol v2", async () => {
		const cases: [number, string, string, ReturnType<typeof stop>][] = [
			[301, "text/html", "moved", stop("refused", "IMPORT_SOURCE_MOVED")],
			[302, "text/html", "moved", stop("refused", "IMPORT_SOURCE_MOVED")],
			[401, "text/plain", "refused", stop("refused", "IMPORT_SOURCE_REFUSED")],
			[403, "text/plain", "refused", stop("refused", "IMPORT_SOURCE_REFUSED")],
			[404, "text/plain", "Repository not found.", stop("refused", "IMPORT_SOURCE_REFUSED")],
			[429, "text/plain", "slow down", stop("busy", "IMPORT_SOURCE_BUSY")],
			[503, "text/plain", "unavailable", stop("busy", "IMPORT_SOURCE_BUSY")],
			[200, "text/html", "<html>", stop("failed", "IMPORT_SOURCE_PROTOCOL")],
			[410, "text/plain", "gone", stop("failed", "IMPORT_SOURCE_PROTOCOL")],
		];
		for (const [status, type, words, ended] of cases) {
			const answer = (reply: ServerResponse) => {
				reply.writeHead(status, { "content-type": type, location: "https://github.com/acme/elsewhere.git" });
				// A body that does not end: the fetch must let it go, not read it.
				reply.write(`${words} ${CANARY}\n`);
				return true;
			};
			// At the advertisement, and at the fetch.
			const atRefs = await standIn(() => undefined, answer);
			expect(await stopped(fetchOf(transport(atRefs.port), memory())), `${status} at refs`).toEqual(ended);
			expect(atRefs.seen.map((one) => one.kind)).toEqual(["refs"]);
			await vi.waitFor(() => expect(atRefs.sockets.size).toBe(0));
			const atFetch = await standIn((reply) => answer(reply));
			const sink = memory();
			expect(await stopped(fetchOf(transport(atFetch.port), sink)), `${status} at fetch`).toEqual(ended);
			expect(sink.pieces).toEqual([]);
			await vi.waitFor(() => expect(atFetch.sockets.size).toBe(0));
		}
	});

	it("takes side band 3 and an ERR line as the source's own error, in no words of its", async () => {
		const answers: [string, (reply: ServerResponse) => void, ReturnType<typeof stop>][] = [
			[
				"band 3 first",
				(reply) => {
					result(reply);
					reply.end(
						Buffer.concat([pkt("packfile\n"), band(2, "Counting objects\n"), band(3, `fatal ${CANARY}\n`)]),
					);
				},
				stop("failed", "IMPORT_SOURCE_ERROR"),
			],
			[
				"an ERR line for the answer",
				(reply) => {
					result(reply);
					reply.end(pkt(`ERR upload-pack: ${CANARY}\n`));
				},
				stop("failed", "IMPORT_SOURCE_ERROR"),
			],
			[
				"band 3 mid-pack, saying not our ref",
				(reply) => {
					result(reply);
					const lines = [pkt("packfile\n"), PACK_HEAD];
					for (let n = 0; n < 40; n++) lines.push(PACK_LINE);
					lines.push(band(3, `not our ref ${CANARY}\n`));
					reply.end(Buffer.concat(lines));
				},
				stop("failed", "IMPORT_SOURCE_ERROR", true),
			],
			[
				"no pack",
				(reply) => {
					result(reply);
					reply.end(Buffer.concat([pkt("acknowledgments\n"), Buffer.from(FLUSH)]));
				},
				stop("failed", "IMPORT_SOURCE_PROTOCOL"),
			],
		];
		for (const [label, answer, ended] of answers) {
			const source = await standIn((reply) => answer(reply));
			const sink = memory();
			expect(await stopped(fetchOf(transport(source.port), sink)), label).toEqual(ended);
			// Once bytes were written, not our ref is the source's error: no new list.
			expect(
				source.seen.map((one) => one.kind),
				label,
			).toEqual(["refs", "ls-refs", "fetch"]);
			if (label.startsWith("band 3 mid")) expect(sink.pieces.length).toBe(2);
			else expect(sink.pieces).toEqual([]);
		}
	});

	it("is a cut transfer when the source goes quiet before its answer, or within its body, or the connection breaks", async () => {
		const quietRefs = await standIn(
			() => undefined,
			() => true,
		);
		let started = Date.now();
		expect(await stopped(fetchOf(transport(quietRefs.port), memory(), { idleMs: 300 }))).toEqual(
			stop("busy", "IMPORT_TRANSFER_CUT"),
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(290);
		await vi.waitFor(() => expect(quietRefs.sockets.size).toBe(0));

		const quietPack = await standIn((reply) => {
			result(reply);
			reply.write(Buffer.concat([pkt("packfile\n"), PACK_HEAD, PACK_LINE]));
		});
		started = Date.now();
		expect(await stopped(fetchOf(transport(quietPack.port), memory(), { idleMs: 300 }))).toEqual(
			stop("busy", "IMPORT_TRANSFER_CUT"),
		);
		await vi.waitFor(() => expect(quietPack.sockets.size).toBe(0));

		const broken = await standIn((reply) => {
			result(reply);
			reply.write(Buffer.concat([pkt("packfile\n"), PACK_HEAD, PACK_LINE]), () => reply.socket?.destroy());
		});
		expect(await stopped(fetchOf(transport(broken.port), memory()))).toEqual(stop("busy", "IMPORT_TRANSFER_CUT"));

		// A transport that fails is a cut too; one that says how it stops is taken at its word.
		const failing: CodeImportTransport = {
			refs: async () => {
				throw new Error(`ECONNRESET ${CANARY}`);
			},
			uploadPack: async () => {
				throw new Error("unused");
			},
		};
		expect(await stopped(fetchOf(failing, memory()))).toEqual(stop("busy", "IMPORT_TRANSFER_CUT"));
		const saying: CodeImportTransport = {
			refs: async () => {
				throw new CodeImportStop("failed", "IMPORT_SOURCE_PROTOCOL");
			},
			uploadPack: failing.uploadPack,
		};
		expect(await stopped(fetchOf(saying, memory()))).toEqual(stop("failed", "IMPORT_SOURCE_PROTOCOL"));
		// An answer that is none: of the asked type but with no body, and with a status that is no number.
		for (const answer of [
			{ by: "source", status: 200, contentType: "application/x-git-upload-pack-advertisement", body: 7 },
			{ by: "source", status: "200", contentType: "application/x-git-upload-pack-advertisement", body: [] },
			{ by: "relay", status: 403, error: 7 },
		]) {
			const garbled = {
				refs: async () => answer as unknown as CodeImportAnswer,
				uploadPack: failing.uploadPack,
			};
			expect(await stopped(fetchOf(garbled, memory()))).toEqual(stop("failed", "IMPORT_SOURCE_PROTOCOL"));
		}
	});

	it("ends past its whole time even while the source keeps talking, and when the run stops", async () => {
		const trickle = await standIn((reply) => {
			result(reply);
			reply.write(Buffer.concat([pkt("packfile\n"), PACK_HEAD]));
			const timer = setInterval(() => reply.write(band(2, "Compressing objects\n")), 50);
			reply.on("close", () => clearInterval(timer));
		});
		const started = Date.now();
		expect(await stopped(fetchOf(transport(trickle.port), memory(), { idleMs: 300, fetchMs: 1_000 }))).toEqual(
			stop("failed", "IMPORT_FETCH_TIMEOUT"),
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(990);
		await vi.waitFor(() => expect(trickle.sockets.size).toBe(0));

		const run = new AbortController();
		const sink: CodeImportSink = {
			write: async () => {
				run.abort(new Error("the executor stops"));
			},
		};
		const endless = await standIn((reply) => streamPack(reply, 1_000_000, { bytes: 0 }));
		expect(await stopped(fetchOf(transport(endless.port), sink, { signal: run.signal }))).toEqual(
			stop("busy", "IMPORT_STOPPED"),
		);
		await vi.waitFor(() => expect(endless.sockets.size).toBe(0));
		// A write that does not end (a store that hangs) is given the run's end too.
		const stuck: CodeImportSink = {
			write: (_chunk, signal) =>
				new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		};
		const waiting = await standIn((reply) => streamPack(reply, 64, { bytes: 0 }));
		expect(await stopped(fetchOf(transport(waiting.port), stuck, { fetchMs: 1_000 }))).toEqual(
			stop("failed", "IMPORT_FETCH_TIMEOUT"),
		);
		// A run that stopped before it began asks nothing, not even of its transport.
		const before = await standIn(() => undefined);
		const asked: string[] = [];
		const plain = transport(before.port);
		const counted: CodeImportTransport = {
			refs: (signal) => {
				asked.push("refs");
				return plain.refs(signal);
			},
			uploadPack: (body, signal) => {
				asked.push("upload-pack");
				return plain.uploadPack(body, signal);
			},
		};
		expect(await stopped(fetchOf(counted, memory(), { signal: run.signal }))).toEqual(stop("busy", "IMPORT_STOPPED"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect([asked, before.seen]).toEqual([[], []]);
	});

	it("reads nothing more while a write waits: a slow writer holds the source back, in bounded memory", async () => {
		const sent = { bytes: 0 },
			pulled = { bytes: 0 };
		// 128 MiB the source would send at once, far more than the sockets between them hold.
		const source = await standIn((reply) => streamPack(reply, 2_048, sent));
		let written = 0;
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let holding = false;
		const sink: CodeImportSink = {
			write: async (chunk) => {
				written += chunk.byteLength;
				if (written >= 3 * MiB && !holding) {
					holding = true;
					await held;
				}
			},
		};
		const fetching = fetchOf(transport(source.port, { pulled }), sink, { idleMs: 60_000 });
		await vi.waitFor(() => expect(holding).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const atHold = { sent: sent.bytes, pulled: pulled.bytes };
		await new Promise((resolve) => setTimeout(resolve, 500));
		// Nothing more was taken from the transport while the write waited, and the source was held back.
		expect(pulled.bytes).toBe(atHold.pulled);
		expect(sent.bytes).toBe(atHold.sent);
		expect(pulled.bytes - written).toBeLessThanOrEqual(MiB + 4 * 65_520);
		expect(sent.bytes).toBeLessThan(64 * MiB);
		release();
		const fetched = await fetching;
		expect(fetched.bytes).toBe(written);
		expect(sent.bytes).toBe(2_048 * 65_520);
	});

	it("refuses options that are no fetch's", async () => {
		const source = await standIn(() => undefined);
		const good = {
			transport: transport(source.port),
			repository: REPOSITORY,
			branch: null,
			maximumBytes: GiB,
			signal: new AbortController().signal,
		};
		for (const options of [
			{ ...good, repository: { owner: "Acme", name: "Shop/x" } },
			{ ...good, repository: { owner: "-acme", name: "shop" } },
			{ ...good, maximumBytes: 0 },
			{ ...good, maximumBytes: 2 * GiB + 1 },
			{ ...good, maximumBytes: 1.5 },
			{ ...good, branch: 7 },
			{ ...good, signal: undefined },
			{ ...good, transport: { refs: good.transport.refs } },
		])
			await expect(fetchGitHubImport(options as never, memory())).rejects.toThrow("INVALID_CODE_IMPORT_FETCH");
		await expect(fetchGitHubImport(good, {} as CodeImportSink)).rejects.toThrow("INVALID_CODE_IMPORT_FETCH");
		for (const bounds of [{ idleMs: 0 }, { fetchMs: 60 * 60_000 + 1 }])
			await expect(fetchGitHubImport(good, memory(), bounds)).rejects.toThrow("INVALID_CODE_IMPORT_FETCH");
		expect(source.seen).toEqual([]);
	});
});

describe("the relay's own answers, as a transport hands them back", () => {
	const relay = (status: number, error: string | null): CodeImportTransport => ({
		refs: async () => ({ by: "relay", status, error }),
		uploadPack: async () => ({ by: "relay", status, error }),
	});

	it("are busy, refused only at the third 403 in a row, or an operator's failure", async () => {
		expect(await stopped(fetchOf(relay(403, "unavailable"), memory()))).toEqual(stop("busy", "IMPORT_RELAY_REFUSED"));
		expect(await stopped(fetchOf(relay(503, "busy"), memory()))).toEqual(stop("busy", "IMPORT_RELAY_BUSY"));
		expect(await stopped(fetchOf(relay(404, "not_found"), memory()))).toEqual(
			stop("failed", "IMPORT_RELAY_NOT_ROUTED"),
		);
		expect(await stopped(fetchOf(relay(400, null), memory()))).toEqual(stop("failed", "IMPORT_RELAY_FAILED"));
		// The run keeps the count (`relayRefused`) from claim to claim.
		let count = 0;
		const ends: string[] = [];
		for (let claim = 0; claim < 3; claim++) {
			const ended = await fetchOf(relay(403, "unavailable"), memory()).catch((error: unknown) => error);
			const next = codeImportRelayRefusals(count, ended as CodeImportStop);
			count = next.relayRefused;
			ends.push(`${next.stop?.end} ${next.stop?.code}`);
		}
		expect(ends).toEqual(["busy IMPORT_RELAY_REFUSED", "busy IMPORT_RELAY_REFUSED", "refused IMPORT_SOURCE_REFUSED"]);
	});
});
