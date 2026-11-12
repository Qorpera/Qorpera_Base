import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
	CODE_BUNDLE_MAXIMUM_BYTES,
	CODE_BUNDLE_NAME,
	CODE_BUNDLE_SCHEMA,
	type CodeBundleFacts,
	type CodeBundleManifest,
	type CodeBundleRef,
	type CodeBundleTarget,
	codeBundleName,
} from "../src/code-bundle-store.ts";
import {
	type CodeHostCommand,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	codeRefsSha256,
} from "../src/code-host-jobs.ts";
import type { CodeHostJobs } from "../src/code-host-views.ts";
import {
	CODE_IMPORT_FILE_MAXIMUM_BYTES,
	CODE_IMPORT_IMPORTED_HEADS,
	CODE_IMPORT_MAXIMUM_BYTES,
	CODE_IMPORT_RENEW_MS,
	type CodeImportBundleFacts,
	type CodeImportBundleManifest,
	type CodeImportFetch,
	type CodeImportFetched,
	type CodeImportFetchOptions,
	type CodeImportJobs,
	type CodeImportLooked,
	type CodeImportLookFacts,
	type CodeImportLookValue,
	type CodeImportOutcome,
	type CodeImportReadValue,
	type CodeImportRequest,
	type CodeImportSink,
	CodeImportStop,
	type CodeImportTransport,
	codeImportBundleName,
	codeImportLook,
	codeImportRequestOf,
} from "../src/code-import.ts";
import {
	CODE_IMPORT_RESTORE_JOBS,
	CODE_IMPORT_RUN_RPCS,
	CodeImport,
	type CodeImportRestoreJobs,
	codeImportSnapshotBinds,
} from "../src/code-import-run.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile),
	roots: string[] = [];
afterAll(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const GIT = "/usr/bin/git";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const OWNER = "coding-node-1";
const MACHINE = "d".repeat(64);
const SCHEMA = "qorpera.code-request-outcome/v1";
/** The place the import brings the code to, and its store folder. */
const place = { host: "qorpera" as const, owner: "acme", name: "app", baseBranch: "main" };
const TARGET: CodeBundleTarget = { companyId: COMPANY, owner: "acme", name: "app" };
const AREA = "code/acme/app";
/** The executor's clock: it stands still. Its milliseconds are not in any name. */
const NOW = Date.UTC(2026, 10, 12, 16, 30, 15, 250);
const AT = "20261112T163015Z";
const ASIDE = `code/_set-aside/acme/at-${AT}/app`;
const FILE = "code/_incoming/drop/shop.bundle";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);
const gc: CodeHostGcBlock = { begin: async () => ({ state: "blocking", held: 0 }), end: async () => {} };

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-import-run-")));
	roots.push(root);
	const companyRoot = join(root, "folder"),
		scratchRoot = join(root, "scratch");
	for (const dir of [companyRoot, scratchRoot]) await mkdir(dir);
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const git = async (cwd: string, ...args: string[]) => (await exec(GIT, args, { cwd, env })).stdout.trim();
	const job: CodeHostJob = {
		shell: localShell([]),
		layout: { companyRoot, scratchRoot, git: GIT },
		signal: new AbortController().signal,
	};
	const code = join(companyRoot, AREA);
	return { root, companyRoot, git, job, code, repo: join(code, "repo.git"), mark: join(code, "restoring.json") };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Everything under a folder, each with its kind and, for a file, its size. */
const listing = async (folder: string) =>
	(await exists(folder))
		? (
				await exec("/usr/bin/find", [
					folder,
					"-mindepth",
					"1",
					"(",
					"-type",
					"f",
					"-printf",
					"f %s %P\\n",
					")",
					"-o",
					"-printf",
					"%y %P\\n",
				])
			).stdout
				.split("\n")
				.filter(Boolean)
				.sort()
		: [];

/** The code as the look makes it ready: the restore-shaped bundle the look job hands out, as the refs plan shapes it
 * (main and the mark at the default branch `master`, a tag, a branch kept under `refs/qorpera/imported/heads/`), made
 * once with real git; and the first bundle's facts, whose header had `master`, the tag and the branch. */
const SOURCE = (async () => {
	const f = await fixture();
	const work = join(f.root, "shop"),
		kept = join(f.root, "kept.git"),
		file = join(f.root, "kept.bundle");
	await mkdir(work);
	await f.git(work, "init", "--quiet", "--initial-branch=master");
	await writeFile(join(work, "index.html"), "<p>shop</p>\n");
	await f.git(work, "add", "--all");
	await f.git(work, "commit", "--quiet", "-m", "shop");
	await f.git(work, "tag", "v1");
	await f.git(work, "checkout", "--quiet", "-b", "dev");
	await writeFile(join(work, "dev.txt"), "dev\n");
	await f.git(work, "add", "--all");
	await f.git(work, "commit", "--quiet", "-m", "dev");
	await f.git(work, "checkout", "--quiet", "master");
	const mainSha = await f.git(work, "rev-parse", "master"),
		devSha = await f.git(work, "rev-parse", "dev");
	await f.git(f.root, "init", "--quiet", "--bare", "--initial-branch=main", kept);
	await f.git(
		kept,
		"--git-dir=.",
		"fetch",
		"--quiet",
		work,
		"+refs/heads/master:refs/heads/main",
		"+refs/heads/master:refs/qorpera/kept-here",
		"+refs/tags/v1:refs/tags/v1",
		`+refs/heads/dev:${CODE_IMPORT_IMPORTED_HEADS}dev`,
	);
	await f.git(kept, "--git-dir=.", "bundle", "create", "--quiet", file, "--all");
	const bytes = await readFile(file);
	const refs = (await f.git(kept, "--git-dir=.", "for-each-ref", "--format=%(refname) %(objectname)"))
		.split("\n")
		.map((line) => ({ name: line.split(" ")[0] as string, sha: line.split(" ")[1] as string }));
	/** The first bundle: bytes the fetch hands the store, which only the look reads. */
	const raw = Buffer.from(`# v2 git bundle\n${mainSha} refs/heads/master\n\n${"pack ".repeat(700)}`);
	return {
		kept: bytes,
		bundle: {
			sha256: digest(bytes),
			bytes: bytes.length,
			gitVersion: (await f.git(f.root, "version")).replace(/^git version /, ""),
			refs,
			refsSha256: codeRefsSha256(refs),
			mainSha,
		},
		raw,
		mainSha,
		devSha,
		rawName: codeImportBundleName(new Date(NOW).toISOString(), mainSha),
		keptName: codeBundleName(new Date(Math.floor(NOW / 1000) * 1000).toISOString(), mainSha),
		fetched: {
			sha256: digest(raw),
			bytes: raw.length,
			defaultBranch: "master",
			mainSha,
			refs: [
				{ name: "refs/heads/master", sha: mainSha },
				{ name: "refs/tags/v1", sha: mainSha },
				{ name: "refs/heads/dev", sha: devSha },
			],
			leftOut: 0,
		} as CodeImportFetched,
	};
})();
type Source = Awaited<typeof SOURCE>;

const lookFacts = (s: Source, more: Partial<CodeImportLookFacts> = {}): CodeImportLookFacts => ({
	bytes: s.raw.length,
	defaultBranch: "master",
	mainSha: s.mainSha,
	commits: 2,
	firstAt: "2026-11-01T10:00:00Z",
	lastAt: "2026-11-12T10:00:00Z",
	authors30d: 1,
	tags: { seen: 1, kept: 1 },
	branches: { seen: 1, kept: 1 },
	leftOut: 0,
	files: 1,
	entries: 1,
	biggest: { path: "index.html", bytes: 12 },
	lfsPointers: 0,
	submodules: 0,
	refused: null,
	secrets: [],
	scan: { blobs: 2, bytes: 40, all: true },
	why: null,
	...more,
});

function pieces(bytes: Uint8Array, size = 1000, signal?: AbortSignal): AsyncIterable<Uint8Array> {
	return (async function* () {
		for (let offset = 0; offset < bytes.length; offset += size) {
			signal?.throwIfAborted();
			yield bytes.subarray(offset, offset + size);
		}
	})();
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const taken: Buffer[] = [];
	for await (const chunk of source) taken.push(Buffer.from(chunk));
	return Buffer.concat(taken);
}
async function until(done: () => boolean, what: string): Promise<void> {
	for (let waited = 0; !done(); waited += 5) {
		if (waited > 20_000) throw new Error(`waited too long for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

type Input = Record<string, unknown>;
const INPUT: Record<"connection" | "public" | "file", (s: Source) => Input> = {
	connection: () => ({
		from: { github: "Acme/Shop" },
		via: "connection",
		look: false,
		maximumBytes: CODE_IMPORT_MAXIMUM_BYTES,
	}),
	public: () => ({
		from: { github: "Acme/Shop" },
		via: "public",
		look: false,
		maximumBytes: CODE_IMPORT_MAXIMUM_BYTES,
	}),
	file: (s) => ({
		from: { file: FILE },
		via: "file",
		look: false,
		maximumBytes: CODE_IMPORT_MAXIMUM_BYTES,
		fileSha256: digest(s.raw),
	}),
};

interface Stored {
	kind: "import" | "bundle";
	bytes: Buffer;
	/** Null: a bundle whose manifest never came (a write that died), which `names` still lists. */
	manifest: Record<string, unknown> | null;
}

/** The store as part C2 builds it, in memory: ordinary bundles and first bundles side by side, by name. */
function memoryStore(tick: (label: string) => void) {
	const stored = new Map<string, Stored>();
	const writers: {
		kind: "import" | "bundle";
		options: unknown;
		chunks: Buffer[];
		committed: string | null;
		aborted: boolean;
	}[] = [];
	const key = (target: CodeBundleTarget, name: string) => `${target.companyId}/${target.owner}/${target.name}/${name}`;
	const of = (target: CodeBundleTarget, name: string, kind: "import" | "bundle") => {
		const entry = stored.get(key(target, name));
		return entry?.kind === kind ? entry : undefined;
	};
	const store = {
		stored,
		writers,
		async begin(
			target: CodeBundleTarget,
			options: { kind?: "import"; expectedBytes?: number; maximumBytes?: number },
			signal?: AbortSignal,
		) {
			signal?.throwIfAborted();
			const writer = {
				kind: options?.kind === "import" ? ("import" as const) : ("bundle" as const),
				options,
				chunks: [] as Buffer[],
				committed: null as string | null,
				aborted: false,
			};
			writers.push(writer);
			const ended = () => writer.committed !== null || writer.aborted;
			return {
				async write(chunk: Uint8Array, signal?: AbortSignal) {
					if (ended()) throw new Error("CODE_BUNDLE_WRITER_ENDED");
					signal?.throwIfAborted();
					writer.chunks.push(Buffer.from(chunk));
				},
				async commit(name: string, facts: CodeBundleFacts & CodeImportBundleFacts, signal?: AbortSignal) {
					if (ended()) throw new Error("CODE_BUNDLE_WRITER_ENDED");
					signal?.throwIfAborted();
					const bytes = Buffer.concat(writer.chunks);
					expect(
						(writer.kind === "import" ? /^import-\d{8}T\d{6}Z-[0-9a-f]{12}$/ : CODE_BUNDLE_NAME).test(name),
					).toBe(true);
					expect(name.slice(-12)).toBe(facts.mainSha.slice(0, 12));
					if (digest(bytes) !== facts.sha256 || bytes.length !== facts.bytes)
						throw new Error("CODE_BUNDLE_DIFFERS");
					if (stored.has(key(target, name))) throw new Error("CODE_BUNDLE_EXISTS");
					const manifest: Record<string, unknown> =
						writer.kind === "import"
							? {
									schema: "qorpera.code-import-bundle/v1",
									companyId: target.companyId,
									environmentId: facts.environmentId,
									repository: { host: "qorpera", owner: target.owner, name: target.name },
									createdAt: facts.createdAt,
									from: facts.from,
									defaultBranch: facts.defaultBranch,
									mainSha: facts.mainSha,
									refs: facts.refs,
									refsCount: facts.refs.length,
									leftOut: facts.leftOut,
									sha256: facts.sha256,
									bytes: facts.bytes,
									executorOwner: facts.executorOwner,
								}
							: {
									schema: CODE_BUNDLE_SCHEMA,
									companyId: target.companyId,
									environmentId: facts.environmentId,
									repository: { host: "qorpera", owner: target.owner, name: target.name, baseBranch: "main" },
									createdAt: facts.createdAt,
									gitVersion: facts.gitVersion,
									mainSha: facts.mainSha,
									refsSha256: facts.refsSha256,
									refs: facts.refs,
									refsCount: facts.refs.length,
									sha256: facts.sha256,
									bytes: facts.bytes,
									verified: true,
									executorOwner: facts.executorOwner,
								};
					stored.set(key(target, name), { kind: writer.kind, bytes, manifest });
					writer.committed = name;
					tick(`commit ${writer.kind}`);
					return manifest;
				},
				async abort() {
					if (writer.committed === null) writer.aborted = true;
				},
			};
		},
		async read(target: CodeBundleTarget, name: string, signal?: AbortSignal) {
			signal?.throwIfAborted();
			const entry = of(target, name, "bundle");
			if (!entry?.manifest) throw new Error("CODE_BUNDLE_MISSING");
			return { manifest: entry.manifest, pieces: pieces(entry.bytes, 4096, signal) };
		},
		async find(target: CodeBundleTarget, name: string) {
			return of(target, name, "bundle")?.manifest ?? null;
		},
		async readImport(target: CodeBundleTarget, name: string, signal?: AbortSignal) {
			signal?.throwIfAborted();
			const entry = of(target, name, "import");
			if (!entry?.manifest) throw new Error("CODE_BUNDLE_MISSING");
			return { manifest: entry.manifest, pieces: pieces(entry.bytes, 4096, signal) };
		},
		async names(target: CodeBundleTarget, signal?: AbortSignal) {
			signal?.throwIfAborted();
			const prefix = key(target, "");
			return [...stored.keys()]
				.filter((name) => name.startsWith(prefix))
				.map((name) => name.slice(prefix.length))
				.sort();
		},
		async remove(target: CodeBundleTarget, name: string, signal?: AbortSignal) {
			signal?.throwIfAborted();
			return stored.delete(key(target, name));
		},
		/** Puts a bundle in as care or an earlier import left it. */
		put(name: string, entry: Stored) {
			stored.set(key(TARGET, name), entry);
		},
	};
	return store;
}

/** The executor's side of one import request with the code host's own restore jobs on a local disk, part C1's
 * interfaces stood in, and a kernel that keeps the request's row as part A's functions do. */
async function world(
	more: {
		input?: keyof typeof INPUT;
		look?: boolean;
		copy?: boolean;
		f?: Fixture;
		store?: ReturnType<typeof memoryStore>;
	} = {},
) {
	const s = await SOURCE;
	const f = more.f ?? (await fixture());
	if (more.copy) {
		// A GitHub copy at the place: a repository and a session's worktree with a file not committed.
		await mkdir(join(f.code, "repo.git"), { recursive: true });
		await writeFile(join(f.code, "repo.git", "HEAD"), "ref: refs/heads/main\n");
		await mkdir(join(f.code, "worktrees", "w1"), { recursive: true });
		await writeFile(join(f.code, "worktrees", "w1", "notes.txt"), "not committed\n");
	}
	/** Every event that changed something, in order; a cut stops the executor right after the n-th. */
	const w = {
		ticks: 0,
		trace: [] as string[],
		cutAt: undefined as number | undefined,
		stopping: new AbortController(),
	};
	const tick = (label: string) => {
		w.trace.push(label);
		w.ticks += 1;
		if (w.cutAt === w.ticks) w.stopping.abort(new Error("the executor stopped"));
	};
	const store = more.store ?? memoryStore(tick);
	const input: Input = { ...INPUT[more.input ?? "connection"](s), ...(more.look ? { look: true } : {}) };
	const kernel = {
		requestId: randomUUID(),
		token: "",
		leased: false,
		/** The request's progress as its row keeps it, and its look. */
		row: {} as Record<string, unknown>,
		look: null as unknown,
		claims: 0,
		/** Whether the company is quiet, for the step that first names the look. */
		quiet: true,
		/** A test's own answer to a call: a state, or an error (a kernel that was not heard). */
		answer: (_method: string, _args: Record<string, unknown>): "go" | "busy" | "lost" | Error | undefined =>
			undefined,
		/** What a call waits for before the kernel takes it up (a slow database). */
		hold: async (_method: string, _args: Record<string, unknown>): Promise<void> => undefined,
		asked: [] as string[],
		steps: [] as Record<string, unknown>[],
		looks: [] as unknown[],
		records: [] as { args: Record<string, unknown>; closed: boolean }[],
		relay: [] as { step: unknown; raw: boolean; look: boolean }[],
		claim(): CodeImportRequest {
			kernel.token = randomUUID();
			kernel.leased = true;
			kernel.claims += 1;
			return codeImportRequestOf({
				requestId: kernel.requestId,
				token: kernel.token,
				leaseUntil: "2026-11-12T16:45:15Z",
				companyId: COMPANY,
				environmentId: ENVIRONMENT,
				owner: "acme",
				name: "app",
				kind: "import",
				input,
				progress: Object.keys(kernel.row).length ? structuredClone(kernel.row) : null,
				looked: kernel.look === null ? null : structuredClone(kernel.look),
			});
		},
	};
	const control = {
		async call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
			expect(args).toMatchObject({ p_owner: OWNER, p_machine_id_sha256: MACHINE, p_request_id: kernel.requestId });
			expect(CODE_IMPORT_RUN_RPCS).toContain(method);
			// A stopping executor's call never lands.
			signal.throwIfAborted();
			await kernel.hold(method, args);
			const forced = kernel.answer(method, args);
			if (forced instanceof Error) throw forced;
			const lost = forced === "lost" || !kernel.leased || args.p_token !== kernel.token;
			if (method === "qorpera_code_request_step") {
				const progress = structuredClone(args.p_progress) as Record<string, unknown>;
				// The kernel's own words are never sent back.
				expect(progress).not.toHaveProperty("recorded");
				expect(progress).not.toHaveProperty("waiting");
				let state = lost ? "lost" : (forced ?? "go");
				if (
					state === "go" &&
					progress.step === "look" &&
					kernel.row.step !== "look" &&
					kernel.look === null &&
					!kernel.quiet
				) {
					// The step that first names the look waits for quiet: the import goes back in the queue with what it
					// brought and the row's step, and its lease ends.
					kernel.row = {
						...progress,
						step: kernel.row.step,
						...(kernel.row.raw ? { raw: kernel.row.raw } : {}),
						waiting: "SESSIONS_BUSY",
					};
					kernel.leased = false;
					state = "busy";
				} else if (state === "go") {
					kernel.row = {
						...progress,
						...(kernel.row.raw ? { raw: kernel.row.raw } : {}),
						...(kernel.row.kept ? { kept: kernel.row.kept } : {}),
						...(kernel.row.recorded ? { recorded: kernel.row.recorded } : {}),
					};
					kernel.steps.push(progress);
				}
				kernel.asked.push(`${String(progress.step)}: ${state}`);
				if (state === "go")
					tick(`step ${String(progress.step)}${progress.raw ? " +raw" : ""}${progress.kept ? " +kept" : ""}`);
				return { schema: "qorpera.code-request-step/v1", state };
			}
			if (method === "qorpera_code_import_looked") {
				kernel.asked.push(`looked: ${lost ? "lost" : "recorded"}`);
				if (lost) return { schema: "qorpera.code-import-looked/v1", state: "lost" };
				// Written once; the same again is fine, another is 22023.
				if (kernel.look !== null && !isDeepStrictEqual(kernel.look, args.p_look)) throw new Error("22023");
				if (kernel.look === null) {
					kernel.look = structuredClone(args.p_look);
					kernel.looks.push(kernel.look);
					tick("looked");
				}
				return { schema: "qorpera.code-import-looked/v1", state: "recorded" };
			}
			expect(method).toBe("qorpera_code_import_record");
			kernel.asked.push(`record: ${lost ? "lost" : "recorded"}`);
			if (lost) return { schema: "qorpera.code-import-recorded/v1", state: "lost" };
			const imported = args.p_imported as Record<string, unknown>;
			// The look must be in, and the bundle the progress's.
			expect(kernel.look).not.toBeNull();
			expect(imported.bundle).toBe((kernel.row.kept as Record<string, unknown>).name);
			if (!kernel.row.recorded) {
				kernel.records.push({ args: structuredClone(args), closed: await exists(f.mark) });
				kernel.row.recorded = { change: 1, bundle: imported.bundle, mainSha: imported.mainSha };
				tick("record");
			}
			return { schema: "qorpera.code-import-recorded/v1", state: "recorded", change: 1 };
		},
	};
	const hosts = {
		yields: [] as boolean[],
		host: (): CodeHostJob => f.job,
		/** After a job's steps, before it answers: a test may make it fail there (its save did not come back). */
		after: async (_answer: unknown): Promise<void> => undefined,
		/** How a job gets its turn in the company's line: at once, unless a test keeps the line. */
		enter: async (): Promise<void> => undefined,
		run: (async (companyId, environmentId, signal, job, options) => {
			expect([companyId, environmentId]).toEqual([COMPANY, ENVIRONMENT]);
			hosts.yields.push(options?.yields === true);
			await hosts.enter();
			// A stopping executor runs no job.
			signal.throwIfAborted();
			const answer = await job({ ...hosts.host(), signal }, gc);
			await hosts.after(answer);
			tick("job");
			return answer;
		}) as Pick<CodeHostJobs, "run">["run"],
	};
	/** The relay as the broker's authority answers it: only while the row names the fetch and has no raw and no look. */
	const relay = (by: "connection" | "public"): CodeImportTransport => ({
		async refs() {
			if (by === "connection")
				kernel.relay.push({ step: kernel.row.step, raw: "raw" in kernel.row, look: kernel.look !== null });
			return {
				by: "source",
				status: 200,
				contentType: "application/x-git-upload-pack-advertisement",
				body: pieces(Buffer.alloc(0)),
			};
		},
		async uploadPack() {
			return {
				by: "source",
				status: 200,
				contentType: "application/x-git-upload-pack-result",
				body: pieces(Buffer.alloc(0)),
			};
		},
	});
	const transports = {
		made: [] as string[],
		connection(
			scope: { companyId: string; requestId: string; leaseToken: string },
			repository: { owner: string; name: string },
		) {
			transports.made.push(`connection ${JSON.stringify(scope)} ${repository.owner}/${repository.name}`);
			return relay("connection");
		},
		public(repository: { owner: string; name: string }) {
			transports.made.push(`public ${repository.owner}/${repository.name}`);
			return relay("public");
		},
	};
	const fetching = {
		calls: 0,
		options: [] as Omit<CodeImportFetchOptions, "transport" | "signal">[],
		/** What the fetch writes after its first relay call: by default the first bundle. */
		writes: async (_options: CodeImportFetchOptions, writer: CodeImportSink) => {
			for await (const piece of pieces(s.raw, 777)) await writer.write(piece);
			return s.fetched;
		},
	};
	const fetch: CodeImportFetch = async (options, writer) => {
		fetching.calls += 1;
		const { transport: _transport, signal: _signal, ...rest } = options;
		fetching.options.push(rest);
		await options.transport.refs(options.signal);
		const fetched = await fetching.writes(options, writer);
		tick("fetch");
		return fetched;
	};
	const b = {
		looks: [] as { look: boolean; now: number }[],
		reads: [] as CodeImportReadValue[],
		/** The look job's answer: the look alone, or the restore-shaped bundle with it. */
		look: async (
			value: CodeImportLookValue,
			sink: { write(chunk: Uint8Array): Promise<void> },
		): Promise<CodeImportLooked> => {
			const look = codeImportLook(lookFacts(s));
			if (value.look) return { state: "looked", look };
			for await (const piece of pieces(s.kept, 4096)) await sink.write(piece);
			return { state: "kept", look, bundle: s.bundle };
		},
		read: async (_value: CodeImportReadValue, sink: { write(chunk: Uint8Array): Promise<void> }) => {
			for await (const piece of pieces(s.raw, 512)) await sink.write(piece);
			return s.fetched;
		},
	};
	const jobs: CodeImportJobs = {
		read: async (_job, value, sink) => {
			b.reads.push(value);
			expect(value.repository).toEqual(place);
			return await b.read(value, sink);
		},
		look: async (_job, value, source, sink) => {
			b.looks.push({ look: value.look, now: value.now });
			expect(value.repository).toEqual(place);
			// The first bundle as the store keeps it, and as the progress says.
			expect(value.raw).toEqual({
				name: expect.stringMatching(/^import-\d{8}T\d{6}Z-[0-9a-f]{12}$/),
				sha256: digest(s.raw),
				bytes: s.raw.length,
				defaultBranch: "master",
				mainSha: s.mainSha,
				refs: 3,
				leftOut: 0,
			});
			expect(digest(await collect(source))).toBe(value.raw.sha256);
			return await b.look(value, sink);
		},
	};
	/** Restore's own jobs, each call written down with what the run gave it. */
	const restore = {
		calls: [] as string[],
		...CODE_IMPORT_RESTORE_JOBS,
	} as CodeImportRestoreJobs & { calls: string[] };
	const real = CODE_IMPORT_RESTORE_JOBS;
	Object.assign(restore, {
		mark: (job, value) => {
			restore.calls.push("mark");
			return real.mark(job, value);
		},
		close: (job, value, source, options) => {
			restore.calls.push(`close fresh=${value.fresh} proven=${options.proven}`);
			return real.close(job, value, source, options);
		},
		setAside: (job, value) => {
			restore.calls.push("set-aside");
			return real.setAside(job, value);
		},
		build: (job, value, source, options) => {
			restore.calls.push(`build proven=${options.proven}`);
			return real.build(job, value, source, options);
		},
		open: (job, value, record) => {
			restore.calls.push(`open sessions=${value.sessions.length}`);
			return real.open(job, value, record);
		},
		reopen: (job, value) => {
			restore.calls.push("reopen");
			return real.reopen(job, value);
		},
	} satisfies CodeImportRestoreJobs);
	const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
	const events: Record<string, unknown>[] = [];
	const clock = { now: NOW };
	const options = {
		control,
		hosts,
		bundles: store as never,
		imports: store as never,
		transports,
		fetch,
		jobs,
		restoreJobs: restore,
		owner: OWNER,
		machineIdSha256: MACHINE,
		report: (event: Record<string, unknown>) => events.push(event),
		now: () => clock.now,
		timer: (ms: number, fire: () => void) => {
			const timer = { ms, fire, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	};
	const importer = new CodeImport(options);
	const run = (request = kernel.claim()): Promise<CodeImportOutcome> => {
		w.stopping = new AbortController();
		return importer.run(request, w.stopping.signal);
	};
	/** The armed renewal timers, neither cancelled nor fired. */
	const armed = () => timers.filter((timer) => !timer.cancelled);
	/** Five minutes pass: the armed renewal fires. */
	const fire = () => {
		const timer = armed().at(-1);
		if (!timer) throw new Error("no renewal is armed");
		timer.cancelled = true;
		timer.fire();
	};
	const errors = () => events.filter((event) => event.event === "code-import-error").map((event) => event.code);
	return {
		s,
		f,
		w,
		store,
		kernel,
		hosts,
		transports,
		fetching,
		b,
		restore,
		timers,
		armed,
		fire,
		events,
		errors,
		clock,
		options,
		run,
		input,
	};
}
type World = Awaited<ReturnType<typeof world>>;

/** The place holds the code brought in, whole: `repo.git` with the bundle's refs, and `main/` at main. */
async function expectBuilt(x: World) {
	const { f, s } = x;
	expect((await readdir(f.code)).sort()).toEqual(["main", "repo.git"]);
	const refs = (await f.git(f.repo, "--git-dir=.", "for-each-ref", "--format=%(refname) %(objectname)"))
		.split("\n")
		.filter(Boolean)
		.map((line) => ({ name: line.split(" ")[0] as string, sha: line.split(" ")[1] as string }));
	expect(codeRefsSha256(refs)).toBe(s.bundle.refsSha256);
	expect(await f.git(f.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(s.mainSha);
	expect(await readFile(join(f.code, "main", "index.html"), "utf8")).toBe("<p>shop</p>\n");
}
/** A place an earlier import closed, set its copy aside and built in part, and did not finish (its build's save did not
 * come back, so the claims ran out): the mark names the restore-shaped bundle, which the store keeps with the first
 * bundle it was made from. */
async function halfDone(more: { input?: keyof typeof INPUT } = {}) {
	const first = await world({ copy: true, ...more });
	const build = first.restore.build;
	first.restore.build = async (job, value, source, options) => {
		const built = await build(job, value, source, options);
		throw new CodeHostJobFailure("CODE_HOST_PUBLISH_FAILED", String(built.refs));
	};
	expect(await first.run()).toEqual({ schema: SCHEMA, state: "busy" });
	expect(await exists(first.f.mark)).toBe(true);
	return first;
}
/** What a run leaves that a later one could tell from another: the place, the set-aside copy, the store, the row. */
async function endState(x: World) {
	const { f } = x;
	return {
		place: (await exists(f.code)) ? (await readdir(f.code)).sort() : null,
		refs: (await exists(f.repo))
			? await f.git(f.repo, "--git-dir=.", "for-each-ref", "--format=%(refname) %(objectname)")
			: null,
		main: await listing(join(f.code, "main")).then((lines) => lines.filter((line) => !line.includes(".git"))),
		aside: await listing(join(f.companyRoot, ASIDE)),
		names: await x.store.names(TARGET),
		row: x.kernel.row,
		look: x.kernel.look,
	};
}
const COPY = ["d repo.git", "d worktrees", "d worktrees/w1", "f 14 worktrees/w1/notes.txt", "f 21 repo.git/HEAD"];

describe("CodeImport: one import request, from its claim to its outcome", () => {
	it("from GitHub through the company's connection: every step in order, step fetch saved before the relay's first call, the record made inside the open while the place is still closed", async () => {
		const x = await world({ copy: true });
		const { s } = x;
		expect(await x.run()).toEqual({
			schema: SCHEMA,
			state: "done",
			result: "imported",
			change: 1,
			mainSha: s.mainSha,
			bundle: s.keptName,
			rawBundle: s.rawName,
			setAside: ASIDE,
		});
		expect(x.kernel.asked).toEqual([
			"fetch: go",
			"fetch: go",
			"look: go",
			"look: go",
			"looked: recorded",
			"close: go",
			"set-aside: go",
			"set-aside: go",
			"build: go",
			"open: go",
			"record: recorded",
		]);
		// The fetch went through the connection, as the request's own lease, only after step fetch was saved.
		expect(x.transports.made).toEqual([
			`connection ${JSON.stringify({ companyId: COMPANY, requestId: x.kernel.requestId, leaseToken: x.kernel.token })} Acme/Shop`,
		]);
		expect(x.kernel.relay).toEqual([{ step: "fetch", raw: false, look: false }]);
		expect(x.fetching.options).toEqual([
			{ repository: { owner: "Acme", name: "Shop" }, branch: null, maximumBytes: CODE_IMPORT_MAXIMUM_BYTES },
		]);
		// What each step saved: the first bundle, then the restore-shaped one, before the look was recorded.
		const raw = {
			name: s.rawName,
			sha256: digest(s.raw),
			bytes: s.raw.length,
			defaultBranch: "master",
			mainSha: s.mainSha,
			refs: 3,
			leftOut: 0,
		};
		const kept = {
			name: s.keptName,
			sha256: s.bundle.sha256,
			bytes: s.bundle.bytes,
			refsSha256: s.bundle.refsSha256,
			mainSha: s.mainSha,
			refs: s.bundle.refs.length,
		};
		expect(x.kernel.steps).toEqual([
			{ step: "fetch" },
			{ step: "fetch", raw },
			{ step: "look", raw },
			{ step: "look", raw, kept },
			{ step: "close", raw, kept },
			{ step: "set-aside", raw, kept, at: AT },
			{ step: "set-aside", raw, kept, at: AT },
			{ step: "build", raw, kept, at: AT, setAside: ASIDE },
			{ step: "open", raw, kept, at: AT, setAside: ASIDE, built: true },
		]);
		expect(x.b.looks).toEqual([{ look: false, now: Math.floor(NOW / 1000) * 1000 }]);
		// Restore's jobs on the restore-shaped bundle: proven by the look, no sessions.
		expect(x.restore.calls).toEqual([
			"mark",
			"close fresh=false proven=true",
			"set-aside",
			"set-aside",
			"build proven=true",
			"open sessions=0",
		]);
		expect(x.hosts.yields).toEqual([true, false, false, false, false, false, false]);
		expect(x.kernel.records).toEqual([
			{
				args: expect.objectContaining({
					p_token: x.kernel.token,
					p_imported: {
						schema: "qorpera.code-import-record/v1",
						bundle: s.keptName,
						mainSha: s.mainSha,
						files: 1,
					},
				}),
				closed: true,
			},
		]);
		await expectBuilt(x);
		// The GitHub copy is aside whole, its session's file that was not committed too.
		expect(await listing(join(x.f.companyRoot, ASIDE))).toEqual(COPY);
		// Both bundles stay: the first with the repository, the restore-shaped one as an ordinary bundle.
		expect(await x.store.names(TARGET)).toEqual([s.keptName, s.rawName].sort());
		expect(x.store.stored.get(`${COMPANY}/acme/app/${s.rawName}`)?.manifest).toMatchObject({
			schema: "qorpera.code-import-bundle/v1",
			from: { github: "Acme/Shop" },
			defaultBranch: "master",
			executorOwner: OWNER,
		});
		expect(x.store.stored.get(`${COMPANY}/acme/app/${s.keptName}`)?.manifest).toMatchObject({
			schema: CODE_BUNDLE_SCHEMA,
			createdAt: new Date(Math.floor(NOW / 1000) * 1000).toISOString(),
			refsSha256: s.bundle.refsSha256,
			gitVersion: s.bundle.gitVersion,
			executorOwner: OWNER,
		});
		expect(x.store.writers.map((writer) => [writer.kind, writer.committed, writer.aborted])).toEqual([
			["import", s.rawName, false],
			["bundle", s.keptName, false],
		]);
		// The import writer is begun for the largest first bundle (the store wants twice that free), the other for the
		// first bundle's size, under the store's own cap.
		expect(x.store.writers.map((writer) => writer.options)).toEqual([
			{ kind: "import", expectedBytes: CODE_IMPORT_MAXIMUM_BYTES, maximumBytes: CODE_IMPORT_MAXIMUM_BYTES },
			{ expectedBytes: s.raw.length, maximumBytes: CODE_BUNDLE_MAXIMUM_BYTES },
		]);
		expect(x.errors()).toEqual([]);
		// The log holds codes, counts and names the import checked: no byte of the source and no path from it.
		const said = JSON.stringify(x.events);
		for (const word of ["index.html", "pack pack", "Acme/Shop", s.raw.subarray(0, 40).toString("latin1")])
			expect(said).not.toContain(word);
		// Every renewal waited five minutes, and none is left.
		expect(x.timers.length).toBeGreaterThan(0);
		expect(x.timers.every((timer) => timer.ms === CODE_IMPORT_RENEW_MS)).toBe(true);
		expect(x.armed()).toEqual([]);
	});

	it("a public project: the public transport, with nothing at the place to set aside", async () => {
		const x = await world({ input: "public" });
		(x.input.from as Record<string, unknown>).branch = "trunk";
		expect(await x.run()).toMatchObject({ state: "done", result: "imported", setAside: null, bundle: x.s.keptName });
		expect(x.transports.made).toEqual(["public Acme/Shop"]);
		expect(x.fetching.options.map((options) => options.branch)).toEqual(["trunk"]);
		expect(x.kernel.relay).toEqual([]);
		expect(x.kernel.asked).toEqual([
			"fetch: go",
			"fetch: go",
			"look: go",
			"look: go",
			"looked: recorded",
			"close: go",
			"set-aside: go",
			"build: go",
			"open: go",
			"record: recorded",
		]);
		expect(await exists(join(x.f.companyRoot, "code/_set-aside"))).toBe(false);
		await expectBuilt(x);
	});

	it("a file: read by the code host's job, which gives way to a turn's; the run ends at the open and leaves the file where it is", async () => {
		const x = await world({ input: "file", copy: true });
		expect(await x.run()).toMatchObject({ state: "done", result: "imported", setAside: ASIDE });
		expect(x.transports.made).toEqual([]);
		expect(x.fetching.calls).toBe(0);
		expect(x.b.reads).toEqual([
			{
				repository: place,
				path: FILE,
				sha256: digest(x.s.raw),
				branch: null,
				maximumBytes: CODE_IMPORT_FILE_MAXIMUM_BYTES,
			},
		]);
		expect(x.kernel.asked).toEqual([
			"read: go",
			"read: go",
			"read: go",
			"look: go",
			"look: go",
			"looked: recorded",
			"close: go",
			"set-aside: go",
			"set-aside: go",
			"build: go",
			"open: go",
			"record: recorded",
		]);
		// The mark's read and the file's read give way; from the look on, no job does.
		// Eight jobs, the open the last: no job comes after it for the file.
		expect(x.hosts.yields).toEqual([true, true, false, false, false, false, false, false]);
		expect(x.store.stored.get(`${COMPANY}/acme/app/${x.s.rawName}`)?.manifest).toMatchObject({
			from: { file: FILE },
		});
		await expectBuilt(x);
	});

	it("a look alone: ends looked, with the look recorded and its bundle removed; nothing at the place is touched, and a claim that comes with the look does not look again", async () => {
		const x = await world({ look: true, copy: true });
		const before = await listing(x.f.companyRoot);
		expect(await x.run()).toEqual({ schema: SCHEMA, state: "done", result: "looked" });
		expect(x.kernel.asked).toEqual(["fetch: go", "fetch: go", "look: go", "looked: recorded"]);
		expect(x.b.looks).toEqual([{ look: true, now: Math.floor(NOW / 1000) * 1000 }]);
		expect(x.kernel.look).toEqual(codeImportLook(lookFacts(x.s)));
		expect(await x.store.names(TARGET)).toEqual([]);
		expect(x.store.writers.map((writer) => writer.kind)).toEqual(["import"]);
		expect(await listing(x.f.companyRoot)).toEqual(before);
		// Nothing of the place is touched: the mark is only read, as its bundle goes, so no snapshot's ever does.
		expect(x.restore.calls).toEqual(["mark"]);
		// Claimed again with the look (its finish was not heard): looked, and no second fetch or look.
		expect(await x.run()).toEqual({ schema: SCHEMA, state: "done", result: "looked" });
		expect([x.fetching.calls, x.b.looks.length, x.kernel.looks.length]).toEqual([1, 1, 1]);
	});

	it("each refusal or failure before the close leaves the place as it was and removes the import's bundles", async () => {
		const cases: {
			name: string;
			input?: keyof typeof INPUT;
			set: (x: World) => void;
			outcome: Record<string, unknown>;
			looked?: boolean;
		}[] = [
			{
				name: "GitHub refused",
				set: (x) => {
					x.fetching.writes = async () => {
						throw new CodeImportStop("refused", "IMPORT_SOURCE_REFUSED");
					};
				},
				outcome: { state: "refused", code: "IMPORT_SOURCE_REFUSED" },
			},
			{
				name: "too large, after some of it was written",
				set: (x) => {
					x.fetching.writes = async (_options, writer) => {
						await writer.write(x.s.raw.subarray(0, 100));
						throw new CodeImportStop("refused", "IMPORT_TOO_LARGE");
					};
				},
				outcome: { state: "refused", code: "IMPORT_TOO_LARGE" },
			},
			{
				name: "not git's protocol",
				set: (x) => {
					x.fetching.writes = async () => {
						throw new CodeImportStop("failed", "IMPORT_SOURCE_PROTOCOL");
					};
				},
				outcome: { state: "failed", code: "IMPORT_SOURCE_PROTOCOL" },
			},
			{
				name: "a default branch that looks like a key",
				set: (x) => {
					x.fetching.writes = async (_options, writer) => {
						for await (const piece of pieces(x.s.raw)) await writer.write(piece);
						return { ...x.s.fetched, defaultBranch: `sk-ant-api03-${"A".repeat(30)}` };
					};
				},
				outcome: { state: "refused", code: "IMPORT_BRANCH_NAME" },
			},
			{
				name: "a file that is not the one asked for",
				input: "file",
				set: (x) => {
					x.b.read = async () => {
						throw new CodeHostRefusal("IMPORT_FILE_CHANGED", [FILE]);
					};
				},
				outcome: { state: "refused", code: "IMPORT_FILE_CHANGED" },
			},
			{
				name: "the look refuses main's large files",
				set: (x) => {
					x.b.look = async () => {
						throw new CodeHostRefusal("IMPORT_USES_LFS", ["assets/big-secret-file.psd"]);
					};
				},
				outcome: { state: "refused", code: "IMPORT_USES_LFS" },
			},
			{
				name: "the look finds what stops it",
				set: (x) => {
					x.b.look = async () => ({
						state: "looked",
						look: codeImportLook(
							lookFacts(x.s, {
								refused: { code: "IMPORT_TOO_MANY_FILES", paths: ["assets/big-secret-file.psd"] },
								why: "IMPORT_TOO_MANY_FILES",
							}),
						),
					});
				},
				outcome: { state: "refused", code: "IMPORT_TOO_MANY_FILES" },
				looked: true,
			},
			{
				name: "the code host's scratch is too small",
				set: (x) => {
					x.b.look = async () => {
						throw new CodeHostJobFailure("IMPORT_NO_SPACE", "5368709120 bytes needed");
					};
				},
				outcome: { state: "failed", code: "IMPORT_NO_SPACE" },
			},
			{
				name: "a look of another commit",
				set: (x) => {
					x.b.look = async (_value, sink) => {
						await sink.write(x.s.kept);
						return {
							state: "kept",
							look: codeImportLook(lookFacts(x.s, { mainSha: "e".repeat(40) })),
							bundle: x.s.bundle,
						};
					};
				},
				outcome: { state: "failed", code: "IMPORT_LOOK_ANSWER_INVALID" },
			},
			{
				name: "no restore-shaped bundle for code that fits",
				set: (x) => {
					x.b.look = async () => ({ state: "looked", look: codeImportLook(lookFacts(x.s)) });
				},
				outcome: { state: "failed", code: "IMPORT_LOOK_ANSWER_INVALID" },
			},
			{
				name: "a bundle whose refs are not its fingerprint",
				set: (x) => {
					x.b.look = async (_value, sink) => {
						await sink.write(x.s.kept);
						return {
							state: "kept",
							look: codeImportLook(lookFacts(x.s)),
							bundle: { ...x.s.bundle, refsSha256: "f".repeat(64) },
						};
					};
				},
				outcome: { state: "failed", code: "IMPORT_LOOK_ANSWER_INVALID" },
			},
			{
				name: "a stored bundle that is not the one the progress names",
				set: (x) => {
					const read = x.store.read;
					x.store.read = async (target, name, signal) => {
						const stored = await read(target, name, signal);
						return { ...stored, manifest: { ...stored.manifest, sha256: "f".repeat(64) } };
					};
				},
				outcome: { state: "failed", code: "IMPORT_KEPT_DIFFERS" },
				looked: true,
			},
		];
		for (const test of cases) {
			const x = await world({ input: test.input, copy: true });
			test.set(x);
			const before = await listing(x.f.companyRoot);
			expect({ name: test.name, outcome: await x.run() }).toEqual({
				name: test.name,
				outcome: { schema: SCHEMA, ...test.outcome },
			});
			expect({ name: test.name, place: await listing(x.f.companyRoot) }).toEqual({ name: test.name, place: before });
			expect({ name: test.name, names: await x.store.names(TARGET) }).toEqual({ name: test.name, names: [] });
			// No writer is left open, and nothing is committed that stays.
			expect(x.store.writers.every((writer) => writer.aborted || writer.committed !== null)).toBe(true);
			expect(x.restore.calls.filter((call) => call !== "mark")).toEqual([]);
			expect(x.kernel.look !== null).toBe(test.looked === true);
			expect(JSON.stringify(x.events)).not.toContain("big-secret-file");
		}
	});

	it("a failure after the close and before the set-aside was let go opens the place again: failed …:PLACE_AS_BEFORE, its bundles removed; a place that cannot be opened again stays closed, with them", async () => {
		// The close's answer did not come back after its job saved the mark.
		const x = await world({ copy: true });
		const before = await listing(x.f.companyRoot);
		x.hosts.after = async () => {
			if (x.restore.calls.at(-1)?.startsWith("close"))
				throw new CodeHostJobFailure("CODE_HOST_PUBLISH_FAILED", `the folder did not answer for ${AREA}/main`);
		};
		expect(await x.run()).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "CODE_HOST_PUBLISH_FAILED:PLACE_AS_BEFORE",
		});
		expect(x.restore.calls.slice(-2)).toEqual(["close fresh=false proven=true", "reopen"]);
		expect(await listing(x.f.companyRoot)).toEqual(before);
		expect(await x.store.names(TARGET)).toEqual([]);
		expect(x.kernel.asked.at(-1)).toBe("close: go");
		// The close's own proof refuses the stored bytes: nothing was written, and the place is as it was.
		const y = await world({ copy: true });
		const proof = y.store.read;
		y.store.read = async (target, name, signal) => {
			const read = await proof(target, name, signal);
			return { ...read, pieces: pieces(Buffer.from(y.s.kept).fill(7, 100, 120), 4096) };
		};
		expect(await y.run()).toEqual({
			schema: SCHEMA,
			state: "failed",
			code: "CODE_HOST_RESTORE_BUNDLE_DIFFERS:PLACE_AS_BEFORE",
		});
		expect(await listing(y.f.companyRoot)).toEqual(before);
		expect(await y.store.names(TARGET)).toEqual([]);
		// The reopen fails too: the place stays closed by the mark, and the bundles stay with it.
		const z = await world({ copy: true });
		z.hosts.after = async () => {
			if (z.restore.calls.at(-1)?.startsWith("close")) throw new CodeHostJobFailure("CODE_HOST_PUBLISH_FAILED");
		};
		z.restore.reopen = async () => {
			throw new CodeHostJobFailure("CODE_HOST_RESTORE_FAILED", "rm");
		};
		expect(await z.run()).toEqual({ schema: SCHEMA, state: "failed", code: "CODE_HOST_PUBLISH_FAILED:PLACE_CLOSED" });
		expect(z.errors()).toEqual(["CODE_HOST_PUBLISH_FAILED", "CODE_HOST_RESTORE_FAILED"]);
		expect(JSON.parse(await readFile(z.f.mark, "utf8"))).toMatchObject({ step: "closed", bundle: z.s.keptName });
		expect(await z.store.names(TARGET)).toEqual([z.s.keptName, z.s.rawName].sort());
	});

	it("once the set-aside was let go the run only ends busy, and the next claim goes on from the mark", async () => {
		// The set-aside's save did not come back after it moved the copy.
		const x = await world({ copy: true });
		x.hosts.after = async (answer) => {
			if ((answer as { state?: string })?.state === "moved")
				throw new CodeHostJobFailure("CODE_HOST_PUBLISH_FAILED");
		};
		expect(await x.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(x.restore.calls).not.toContain("reopen");
		expect(await exists(x.f.mark)).toBe(true);
		expect(await x.store.names(TARGET)).toEqual([x.s.keptName, x.s.rawName].sort());
		expect(x.kernel.row.step).toBe("set-aside");
		x.hosts.after = async () => undefined;
		const calls = x.restore.calls.length;
		expect(await x.run()).toMatchObject({ state: "done", result: "imported", setAside: ASIDE });
		// It neither fetched, looked nor closed again: the set-aside job read the mark itself.
		expect(x.restore.calls.slice(calls)).toEqual(["set-aside", "build proven=true", "open sessions=0"]);
		expect([x.fetching.calls, x.b.looks.length]).toEqual([1, 1]);
		await expectBuilt(x);
		expect(await listing(join(x.f.companyRoot, ASIDE))).toEqual(COPY);
		// A folder that does not keep the move: the job after it still finds the copy there. Put off, not failed.
		const m = await world({ copy: true });
		let back = 2;
		m.hosts.after = async (answer) => {
			if ((answer as { state?: string })?.state !== "moved" || back-- <= 0) return;
			for (const entry of await readdir(join(m.f.companyRoot, ASIDE)))
				await rename(join(m.f.companyRoot, ASIDE, entry), join(m.f.code, entry));
		};
		expect(await m.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(m.errors()).toContain("RESTORE_SET_ASIDE_NOT_KEPT");
		expect(await m.run()).toMatchObject({ state: "done", result: "imported", setAside: ASIDE });
		// A build that answers another repository is not taken as built.
		const v = await world();
		v.restore.build = async () => ({ mainSha: v.s.mainSha, refsSha256: "f".repeat(64), refs: 3 });
		expect(await v.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(v.kernel.row).not.toHaveProperty("built");
		expect(v.errors()).toContain("IMPORT_BUILD_ANSWER_INVALID");
		// A set-aside job that was let go and refused, and a build that failed: put off, never failed or opened again.
		for (const [job, error] of [
			["setAside", new CodeHostRefusal("CODE_HOST_RESTORE_SET_ASIDE_IN_THE_WAY", [`${ASIDE}/repo.git`])],
			["build", new CodeHostJobFailure("CODE_HOST_RESTORE_FAILED", "index-pack")],
		] as const) {
			const y = await world({ copy: true });
			const kept = y.restore[job];
			y.restore[job] = async () => {
				throw error;
			};
			expect(await y.run()).toEqual({ schema: SCHEMA, state: "busy" });
			expect(y.restore.calls).not.toContain("reopen");
			expect(await exists(y.f.mark)).toBe(true);
			expect(await y.store.names(TARGET)).toHaveLength(2);
			expect(y.errors()).toContain(error.code);
			(y.restore as unknown as Record<string, unknown>)[job] = kept;
			expect(await y.run()).toMatchObject({ state: "done", result: "imported" });
			await expectBuilt(y);
		}
	});

	it("the record: made once inside the open job; after it the run ends only done or busy, and a claim that comes with it records nothing again", async () => {
		// The open's removal of the mark fails after the record.
		const x = await world({ copy: true });
		const { shell } = x.f.job;
		x.hosts.host = () => ({
			...x.f.job,
			shell: {
				run: (command: CodeHostCommand, signal: AbortSignal) =>
					command.argv[0] === "/usr/bin/rm" && command.argv.at(-1) === x.f.mark
						? Promise.reject(new Error("the code host went away"))
						: shell.run(command, signal),
			},
		});
		expect(await x.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(x.kernel.records).toHaveLength(1);
		expect(x.kernel.records[0]?.closed).toBe(true);
		expect(await exists(x.f.mark)).toBe(true);
		x.hosts.host = () => x.f.job;
		// The claim that comes with the record and the mark still there finishes the open, records nothing, and is done
		// only once the mark is gone (the kernel ends a recorded import by this finish alone).
		let asked = x.kernel.asked.length;
		const opened = x.restore.open;
		let markAtDone: boolean | undefined;
		x.restore.open = async (job, value, record) => {
			const answer = await opened(job, value, record);
			markAtDone = await exists(x.f.mark);
			return answer;
		};
		expect(await x.run()).toMatchObject({ state: "done", result: "imported", bundle: x.s.keptName });
		expect(markAtDone).toBe(false);
		expect(x.kernel.asked.slice(asked)).toEqual(["open: go"]);
		expect(x.kernel.asked.filter((each) => each.startsWith("record"))).toEqual(["record: recorded"]);
		expect(await exists(x.f.mark)).toBe(false);
		await expectBuilt(x);
		// Claimed again once more (its finish was not heard): the mark is gone, the open finds the place open, and the run
		// is done with nothing recorded again.
		asked = x.kernel.asked.length;
		expect(await x.run()).toMatchObject({ state: "done", result: "imported" });
		expect(x.kernel.asked.slice(asked)).toEqual(["open: go"]);
		expect(x.kernel.records).toHaveLength(1);
		// A record not heard is asked once more; not heard twice, the place stays closed and the run is put off.
		const y = await world();
		let unheard = 2;
		y.kernel.answer = (method) =>
			method === "qorpera_code_import_record" && unheard-- > 0 ? new Error("CODING_CONTROL_UNCONFIRMED") : undefined;
		expect(await y.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(await exists(y.f.mark)).toBe(true);
		expect(await y.run()).toMatchObject({ state: "done", result: "imported" });
		expect(y.kernel.records).toHaveLength(1);
		const z = await world();
		unheard = 1;
		z.kernel.answer = (method) =>
			method === "qorpera_code_import_record" && unheard-- > 0 ? new Error("CODING_CONTROL_UNCONFIRMED") : undefined;
		expect(await z.run()).toMatchObject({ state: "done", result: "imported" });
		// The lease gone at the record, or after it: put off, never failed.
		const lost = await world();
		lost.kernel.answer = (method) => (method === "qorpera_code_import_record" ? "lost" : undefined);
		expect(await lost.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(await exists(lost.f.mark)).toBe(true);
		expect(lost.events.filter((event) => event.step === "recorded")).toEqual([]);
	});

	it("renews the lease every five minutes with the step the kernel last took, and a lease found gone stops the run cold", async () => {
		const x = await world({ copy: true });
		// The fetch stands: a renewal names step fetch, with nothing more.
		let release: () => void = () => undefined;
		x.fetching.writes = async (options, writer) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			for await (const piece of pieces(x.s.raw, 777)) await writer.write(piece, options.signal);
			return x.s.fetched;
		};
		let started = false,
			open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const look = x.b.look;
		x.b.look = async (value, sink) => {
			started = true;
			await gate;
			return await look(value, sink);
		};
		const running = x.run();
		await until(() => x.fetching.calls === 1, "the fetch");
		expect(x.armed().map((timer) => timer.ms)).toEqual([CODE_IMPORT_RENEW_MS]);
		x.fire();
		await until(() => x.kernel.asked.length === 2 && x.armed().length === 1, "a renewal");
		expect(x.kernel.steps.at(-1)).toEqual({ step: "fetch" });
		// The look waits in the company's line: a renewal names the step the kernel took, never the look before its job.
		let entered = false,
			letIn: () => void = () => undefined;
		const line = new Promise<void>((resolve) => {
			letIn = resolve;
		});
		x.hosts.enter = async () => {
			if (x.hosts.yields.length !== 2) return;
			entered = true;
			await line;
		};
		release();
		await until(() => entered && x.armed().length === 1, "the look in line");
		let asked = x.kernel.asked.length;
		x.fire();
		await until(() => x.kernel.asked.length === asked + 1 && x.armed().length === 1, "a renewal");
		expect(x.kernel.asked.at(-1)).toBe("fetch: go");
		expect(x.kernel.steps.at(-1)).toMatchObject({ step: "fetch", raw: { name: x.s.rawName } });
		// A renewal that comes while the look's own step is being answered goes after it, and names the look then.
		let holding = false,
			letGo: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		x.kernel.hold = async (_method, args) => {
			if ((args.p_progress as Record<string, unknown> | undefined)?.step !== "look" || holding) return;
			holding = true;
			await held;
		};
		asked = x.kernel.asked.length;
		letIn();
		await until(() => holding, "the look's step");
		x.fire();
		letGo();
		await until(() => x.kernel.asked.length === asked + 2, "the look's step and the renewal");
		expect(x.kernel.asked.slice(-2)).toEqual(["look: go", "look: go"]);
		expect(x.kernel.steps.slice(-2).map((step) => step.step)).toEqual(["look", "look"]);
		// The look stands, an hour long: each renewal names the look with what the progress holds.
		await until(() => started, "the look");
		for (let renewals = 0; renewals < 3; renewals += 1) {
			const asked = x.kernel.asked.length;
			await until(() => x.armed().length === 1, "the renewal armed");
			x.fire();
			await until(() => x.kernel.asked.length === asked + 1, "a renewal");
			expect(x.kernel.asked.at(-1)).toBe("look: go");
			expect(x.kernel.steps.at(-1)).toMatchObject({ step: "look", raw: { name: x.s.rawName } });
		}
		// A renewal not heard is tried again five minutes later.
		await until(() => x.armed().length === 1, "the renewal armed");
		x.kernel.answer = () => new Error("CODING_CONTROL_UNCONFIRMED");
		const fired = x.timers.length;
		x.fire();
		await until(() => x.timers.length === fired + 1 && x.armed().length === 1, "the next renewal");
		// The lease is found gone: the look job is ended, and nothing more is asked, written or removed.
		x.kernel.answer = (method) => (method === "qorpera_code_request_step" ? "lost" : undefined);
		asked = x.kernel.asked.length + 1;
		x.fire();
		await until(() => x.kernel.asked.length === asked, "the lost answer");
		open();
		expect(await running).toEqual({ schema: SCHEMA, state: "busy" });
		expect(x.kernel.asked.length).toBe(asked);
		expect(x.kernel.asked.at(-1)).toBe("look: lost");
		expect(x.kernel.look).toBeNull();
		expect(await x.store.names(TARGET)).toEqual([x.s.rawName]);
		// The restore-shaped bundle's writer was given up; the place was never touched.
		expect(x.store.writers.map((writer) => [writer.kind, writer.committed, writer.aborted])).toEqual([
			["import", x.s.rawName, false],
			["bundle", null, true],
		]);
		expect(x.restore.calls).toEqual(["mark"]);
		expect(await listing(x.f.code)).toEqual(COPY);
		expect(x.armed()).toEqual([]);
		expect(x.timers.every((timer) => timer.ms === CODE_IMPORT_RENEW_MS)).toBe(true);
		// A step call answered lost in the middle of the run stops it the same way, before its job does anything.
		const y = await world({ copy: true });
		y.kernel.answer = (_method, args) =>
			(args.p_progress as Record<string, unknown> | undefined)?.step === "build" ? "lost" : undefined;
		expect(await y.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(y.kernel.asked.at(-1)).toBe("build: lost");
		expect(y.restore.calls.at(-1)).toBe("set-aside");
		expect(await y.store.names(TARGET)).toHaveLength(2);
		// So does a look the kernel answers lost: nothing is closed, and nothing removed.
		const z = await world({ copy: true });
		z.kernel.answer = (method) => (method === "qorpera_code_import_looked" ? "lost" : undefined);
		expect(await z.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(z.kernel.asked.at(-1)).toBe("looked: lost");
		expect(z.restore.calls).toEqual(["mark"]);
		expect(await z.store.names(TARGET)).toEqual([z.s.keptName, z.s.rawName].sort());
	});

	it("a run cut after every single step and claimed again ends the same as an uncut one: no second fetch once raw is saved, no second look once it is recorded, no second record", async () => {
		const whole = await world({ copy: true });
		const done = await whole.run();
		expect(done).toMatchObject({ state: "done", result: "imported" });
		const end = await endState(whole),
			trace = [...whole.w.trace];
		const rawSaved = trace.findIndex((label) => label.includes("+raw")) + 1,
			looked = trace.indexOf("looked") + 1;
		expect(rawSaved).toBeGreaterThan(0);
		expect(looked).toBeGreaterThan(rawSaved);
		expect(trace).toHaveLength(whole.w.ticks);
		for (let cut = 1; cut <= trace.length; cut += 1) {
			const x = await world({ copy: true });
			x.w.cutAt = cut;
			const outcomes = [await x.run()];
			x.w.cutAt = undefined;
			while ((outcomes.at(-1) as CodeImportOutcome).state === "busy" && outcomes.length < 6)
				outcomes.push(await x.run());
			expect({ cut, at: trace[cut - 1], outcome: outcomes.at(-1) }).toEqual({
				cut,
				at: trace[cut - 1],
				outcome: done,
			});
			expect({ cut, end: await endState(x) }).toEqual({ cut, end });
			expect({ cut, records: x.kernel.records.length, looks: x.kernel.looks.length }).toEqual({
				cut,
				records: 1,
				looks: 1,
			});
			if (cut >= rawSaved) expect({ cut, fetches: x.fetching.calls }).toEqual({ cut, fetches: 1 });
			if (cut >= looked) expect({ cut, looks: x.b.looks.length }).toEqual({ cut, looks: 1 });
			// A claim that comes with the restore-shaped bundle and no look runs the look alone, at the bundle's time.
			expect(x.b.looks.every((look) => look.now === Math.floor(NOW / 1000) * 1000)).toBe(true);
		}
		// Claimed again an hour after the restore-shaped bundle was saved and the look was not: the look alone, at the
		// bundle's own time, whatever the clock says now.
		const late = await world({ copy: true });
		late.w.cutAt = trace.findIndex((label) => label.includes("+kept")) + 1;
		expect((await late.run()).state).toBe("busy");
		late.w.cutAt = undefined;
		late.clock.now = NOW + 3_600_000;
		expect(await late.run()).toMatchObject({ state: "done", result: "imported", bundle: late.s.keptName });
		expect(late.b.looks).toEqual([
			{ look: false, now: Math.floor(NOW / 1000) * 1000 },
			{ look: true, now: Math.floor(NOW / 1000) * 1000 },
		]);
	}, 170_000);

	it("the kernel's busy at the look step: the run ends busy and asks nothing more; the next claim goes on from raw", async () => {
		const x = await world({ copy: true });
		x.kernel.quiet = false;
		expect(await x.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(x.kernel.asked).toEqual(["fetch: go", "fetch: go", "look: busy"]);
		expect(x.kernel.row).toMatchObject({ step: "fetch", raw: { name: x.s.rawName }, waiting: "SESSIONS_BUSY" });
		expect(await x.store.names(TARGET)).toEqual([x.s.rawName]);
		expect(x.store.writers.map((writer) => [writer.kind, writer.aborted])).toEqual([
			["import", false],
			["bundle", true],
		]);
		expect(x.b.looks).toEqual([]);
		expect(x.armed()).toEqual([]);
		x.kernel.quiet = true;
		// A claim that comes again is renewed from its start, with the step the kernel kept, even while its first job
		// waits in the company's line.
		let letIn: () => void = () => undefined;
		const line = new Promise<void>((resolve) => {
			letIn = resolve;
		});
		x.hosts.enter = () => line;
		const again = x.run();
		await until(() => x.armed().length === 1, "a renewal armed at the claim");
		const asked = x.kernel.asked.length;
		x.fire();
		await until(() => x.kernel.asked.length === asked + 1, "the renewal");
		expect(x.kernel.asked.at(-1)).toBe("fetch: go");
		x.hosts.enter = async () => undefined;
		letIn();
		expect(await again).toMatchObject({ state: "done", result: "imported" });
		expect([x.fetching.calls, x.b.looks.length]).toEqual([1, 1]);
		// A look step whose answer was not heard (the kernel may have put it back): put off, nothing removed.
		const y = await world();
		y.kernel.answer = (_method, args) =>
			(args.p_progress as Record<string, unknown> | undefined)?.step === "look" ? new Error("timeout") : undefined;
		expect(await y.run()).toEqual({ schema: SCHEMA, state: "busy" });
		expect(await y.store.names(TARGET)).toEqual([y.s.rawName]);
		expect(y.kernel.asked).toEqual(["fetch: go", "fetch: go"]);
	});

	it("the relay's own 403: busy twice, then refused; any other end starts the count again", async () => {
		const refused = () => {
			throw new CodeImportStop("busy", "IMPORT_RELAY_REFUSED");
		};
		const x = await world();
		x.fetching.writes = async () => refused();
		const counts: unknown[] = [];
		for (let claim = 0; claim < 3; claim += 1) {
			counts.push([(await x.run()).state, x.kernel.row.relayRefused ?? 0]);
		}
		expect(counts).toEqual([
			["busy", 1],
			["busy", 2],
			["refused", 2],
		]);
		expect(x.kernel.row.step).toBe("fetch");
		const y = await world();
		const ends = [
			() => refused(),
			() => {
				throw new CodeImportStop("busy", "IMPORT_TRANSFER_CUT");
			},
			() => refused(),
			() => refused(),
		];
		y.fetching.writes = async () => (ends.shift() as () => never)();
		const states: unknown[] = [];
		for (let claim = 0; claim < 4; claim += 1) {
			const outcome = await y.run();
			states.push([outcome.state, y.kernel.row.relayRefused ?? 0]);
		}
		expect(states).toEqual([
			["busy", 1],
			["busy", 0],
			["busy", 1],
			["busy", 2],
		]);
		// A fetch that goes through after a refusal starts it again too.
		const z = await world();
		const once = [() => refused()];
		const writes = z.fetching.writes;
		z.fetching.writes = async (options, writer) =>
			once.length ? (once.shift() as () => never)() : writes(options, writer);
		expect((await z.run()).state).toBe("busy");
		expect(await z.run()).toMatchObject({ state: "done", result: "imported" });
		expect(z.kernel.row).not.toHaveProperty("relayRefused");
	});

	it("a half-done snapshot at a place: the same project, whose head moved since, is finished from the snapshot's own bundles with no fetch, and what is recorded is of the code installed", async () => {
		const first = await halfDone();
		expect(JSON.parse(await readFile(first.f.mark, "utf8"))).toMatchObject({
			step: "emptied",
			bundle: first.s.keptName,
		});
		expect((await readdir(first.f.code)).sort()).toEqual(["main", "repo.git", "restoring.json"]);
		// What else the place's store folder holds: a first bundle of another import, and an ordinary bundle.
		first.store.put("import-20261101T000000Z-aaaaaaaaaaaa", {
			kind: "import",
			bytes: Buffer.from("old"),
			manifest: {},
		});
		first.store.put("20261101T000000Z-bbbbbbbbbbbb", { kind: "bundle", bytes: Buffer.from("old"), manifest: {} });
		// And a first bundle whose write died before its manifest, newer than the snapshot's: passed over, then removed.
		first.store.put(codeImportBundleName(new Date(NOW + 60_000).toISOString(), first.s.mainSha), {
			kind: "import",
			bytes: Buffer.from("half"),
			manifest: null,
		});
		const writers = first.store.writers.length;
		// A new request for the same project (spelled another way), an hour later, through the connection; GitHub's head
		// has moved, so a fetch now would bring other code.
		const x = await world({ f: first.f, store: first.store });
		x.input.from = { github: "acme/SHOP" };
		x.clock.now = NOW + 3_600_000;
		x.fetching.writes = async (_options, writer) => {
			await writer.write(Buffer.from("moved"));
			return { ...x.s.fetched, mainSha: "e".repeat(40) };
		};
		expect(await x.run()).toEqual({
			schema: SCHEMA,
			state: "done",
			result: "imported",
			change: 1,
			mainSha: x.s.mainSha,
			bundle: x.s.keptName,
			rawBundle: x.s.rawName,
			setAside: ASIDE,
		});
		expect([x.fetching.calls, x.transports.made.length, x.b.reads.length]).toEqual([0, 0, 0]);
		expect(x.store.writers).toHaveLength(writers);
		// Both bundles taken with their own facts, saved before anything else; the look made alone of that first bundle,
		// at the restore-shaped bundle's time: the same look the snapshot was made with.
		expect(x.kernel.steps.slice(0, 2)).toEqual([
			{ step: "fetch" },
			{
				step: "fetch",
				raw: (first.kernel.row as Record<string, unknown>).raw,
				kept: (first.kernel.row as Record<string, unknown>).kept,
			},
		]);
		expect(x.b.looks).toEqual([{ look: true, now: Math.floor(NOW / 1000) * 1000 }]);
		expect(x.kernel.look).toEqual(first.kernel.look);
		expect(x.kernel.records[0]?.args.p_imported).toEqual({
			schema: "qorpera.code-import-record/v1",
			bundle: x.s.keptName,
			mainSha: x.s.mainSha,
			files: 1,
		});
		// The close found the snapshot's mark, emptied: nothing was set aside again.
		expect(x.restore.calls).toEqual([
			"mark",
			"close fresh=false proven=true",
			"build proven=true",
			"open sessions=0",
		]);
		expect(await x.store.names(TARGET)).toEqual([x.s.keptName, x.s.rawName].sort());
		await expectBuilt(x);
		expect(await listing(join(x.f.companyRoot, ASIDE))).toEqual(COPY);
		expect(x.errors()).toEqual([]);
		// A file source the same way: the same file's bytes at another path, with no read.
		const file = await halfDone({ input: "file" });
		const y = await world({ f: file.f, store: file.store, input: "file" });
		y.input.from = { file: "code/_incoming/again/shop.bundle" };
		y.clock.now = NOW + 3_600_000;
		expect(await y.run()).toMatchObject({ state: "done", result: "imported", rawBundle: y.s.rawName });
		expect([y.b.reads.length, y.fetching.calls]).toEqual([0, 0]);
		await expectBuilt(y);
	});

	it("a half-done snapshot at a place: another source, another branch, or a snapshot whose bundles are gone or do not bind is refused before anything is fetched or touched", async () => {
		const cases: { name: string; input?: keyof typeof INPUT; first?: keyof typeof INPUT; set: (x: World) => void }[] =
			[
				{
					name: "another project",
					set: (x) => {
						x.input.from = { github: "Acme/Other" };
					},
				},
				{
					name: "the same project, another branch",
					set: (x) => {
						x.input.from = { github: "Acme/Shop", branch: "dev" };
					},
				},
				{ name: "a file where GitHub was", input: "file", set: () => undefined },
				{
					name: "another file",
					input: "file",
					first: "file",
					set: (x) => {
						x.input.fileSha256 = "f".repeat(64);
					},
				},
				{
					name: "the first bundle gone",
					set: (x) => {
						x.store.stored.delete(`${COMPANY}/acme/app/${x.s.rawName}`);
					},
				},
				{
					name: "the restore-shaped bundle gone",
					set: (x) => {
						x.store.stored.delete(`${COMPANY}/acme/app/${x.s.keptName}`);
					},
				},
				{
					name: "a first bundle of other code under its name",
					set: (x) => {
						const stored = x.store.stored.get(`${COMPANY}/acme/app/${x.s.rawName}`) as Stored;
						const refs = ((stored.manifest as Record<string, unknown>).refs as CodeBundleRef[]).map((ref) =>
							ref.name === "refs/tags/v1" ? { ...ref, sha: x.s.devSha } : ref,
						);
						stored.manifest = { ...stored.manifest, refs };
					},
				},
			];
		for (const test of cases) {
			const first = await halfDone({ input: test.first });
			const x = await world({ f: first.f, store: first.store, input: test.input });
			x.clock.now = NOW + 3_600_000;
			test.set(x);
			const before = { place: await listing(x.f.companyRoot), names: await x.store.names(TARGET) };
			expect({ name: test.name, outcome: await x.run() }).toEqual({
				name: test.name,
				outcome: { schema: SCHEMA, state: "refused", code: "IMPORT_PLACE_HALF_DONE" },
			});
			expect({ name: test.name, place: await listing(x.f.companyRoot), names: await x.store.names(TARGET) }).toEqual(
				{
					name: test.name,
					...before,
				},
			);
			expect({
				name: test.name,
				fetched: x.fetching.calls,
				read: x.b.reads.length,
				looked: x.b.looks.length,
				asked: x.kernel.asked,
				restore: x.restore.calls,
			}).toEqual({
				name: test.name,
				fetched: 0,
				read: 0,
				looked: 0,
				asked: [`${test.input === "file" ? "read" : "fetch"}: go`],
				restore: ["mark"],
			});
		}
	});

	it("a half-done snapshot at a place: a look alone there takes its own source and removes only its own bundle; a snapshot's look that does not keep what its bundle holds, or that stops it, or a failure before the close, leaves both its bundles", async () => {
		const first = await halfDone();
		const mark = await readFile(first.f.mark, "utf8");
		const before = await listing(first.f.companyRoot);
		const x = await world({ f: first.f, store: first.store, look: true });
		x.clock.now = NOW + 3_600_000;
		expect(await x.run()).toEqual({ schema: SCHEMA, state: "done", result: "looked" });
		expect([x.fetching.calls, x.b.looks.length]).toEqual([1, 1]);
		expect(x.restore.calls).toEqual(["mark"]);
		expect(await x.store.names(TARGET)).toEqual([x.s.keptName, x.s.rawName].sort());
		expect(await readFile(first.f.mark, "utf8")).toBe(mark);
		expect(await listing(first.f.companyRoot)).toEqual(before);
		// The snapshot's look made alone keeps another number of tags than its bundle holds: not the code there.
		const y = await world({ f: first.f, store: first.store });
		y.clock.now = NOW + 3_600_000;
		y.b.look = async () => ({
			state: "looked",
			look: codeImportLook(lookFacts(y.s, { tags: { seen: 2, kept: 2 } })),
		});
		expect(await y.run()).toEqual({ schema: SCHEMA, state: "refused", code: "IMPORT_PLACE_HALF_DONE" });
		expect(y.kernel.look).toBeNull();
		expect(await y.store.names(TARGET)).toEqual([y.s.keptName, y.s.rawName].sort());
		// Another number of other branches, the same.
		const z = await world({ f: first.f, store: first.store });
		z.b.look = async () => ({
			state: "looked",
			look: codeImportLook(lookFacts(z.s, { branches: { seen: 1, kept: 0 } })),
		});
		expect(await z.run()).toEqual({ schema: SCHEMA, state: "refused", code: "IMPORT_PLACE_HALF_DONE" });
		expect(await z.store.names(TARGET)).toEqual([z.s.keptName, z.s.rawName].sort());
		// A look that stops it: refused with its code; the snapshot and its mark stay.
		const v = await world({ f: first.f, store: first.store });
		v.b.look = async () => ({
			state: "looked",
			look: codeImportLook(
				lookFacts(v.s, { why: "IMPORT_TOO_MANY_FILES", refused: { code: "IMPORT_TOO_MANY_FILES", paths: [] } }),
			),
		});
		expect(await v.run()).toEqual({ schema: SCHEMA, state: "refused", code: "IMPORT_TOO_MANY_FILES" });
		expect(v.kernel.row).toMatchObject({ kept: { name: v.s.keptName }, raw: { name: v.s.rawName } });
		expect(await v.store.names(TARGET)).toEqual([v.s.keptName, v.s.rawName].sort());
		expect(await readFile(first.f.mark, "utf8")).toBe(mark);
		// A failure before the close: both stay too.
		const u = await world({ f: first.f, store: first.store });
		const read = u.store.read;
		u.store.read = async () => {
			throw new Error("CODE_BUNDLE_STORE_BROKEN");
		};
		expect(await u.run()).toEqual({ schema: SCHEMA, state: "failed", code: "CODE_BUNDLE_STORE_BROKEN" });
		u.store.read = read;
		expect(await u.store.names(TARGET)).toEqual([u.s.keptName, u.s.rawName].sort());
		expect(await readFile(first.f.mark, "utf8")).toBe(mark);
		// A mark that cannot be read as the bundles would be removed: they stay.
		const t = await world({ f: first.f, store: first.store });
		let marks = 0;
		t.restore.mark = async () => {
			marks += 1;
			throw new CodeHostJobFailure("CODE_HOST_READ_FAILED", "head");
		};
		t.store.read = async () => {
			throw new Error("CODE_BUNDLE_STORE_BROKEN");
		};
		// (The claim comes with the snapshot taken, so the mark is read only as the bundles would go.)
		t.kernel.row = structuredClone(u.kernel.row);
		t.kernel.look = structuredClone(u.kernel.look);
		expect(await t.run()).toEqual({ schema: SCHEMA, state: "failed", code: "CODE_BUNDLE_STORE_BROKEN" });
		t.store.read = read;
		expect(marks).toBe(1);
		expect(await t.store.names(TARGET)).toEqual([t.s.keptName, t.s.rawName].sort());
		// A claim that comes with a first bundle and no restore-shaped one, at a place a mark closed since: refused.
		const late = await world({ f: first.f, store: first.store });
		late.kernel.row = { step: "fetch", raw: structuredClone((first.kernel.row as Record<string, unknown>).raw) };
		expect(await late.run()).toEqual({ schema: SCHEMA, state: "refused", code: "IMPORT_PLACE_HALF_DONE" });
		expect(late.b.looks).toEqual([]);
		expect(await late.store.names(TARGET)).toEqual([late.s.keptName, late.s.rawName].sort());
		expect(await readFile(first.f.mark, "utf8")).toBe(mark);
		// An import of its own whose look made alone again does not keep what its own bundle holds (no mark at its place):
		// no answer, and its bundles go.
		const own = await world({ copy: true });
		let unheard = true;
		own.kernel.answer = (method) =>
			method === "qorpera_code_import_looked" && unheard ? new Error("CODING_CONTROL_UNCONFIRMED") : undefined;
		expect(await own.run()).toEqual({ schema: SCHEMA, state: "busy" });
		unheard = false;
		own.b.look = async () => ({
			state: "looked",
			look: codeImportLook(lookFacts(own.s, { tags: { seen: 2, kept: 2 } })),
		});
		expect(await own.run()).toEqual({ schema: SCHEMA, state: "failed", code: "IMPORT_LOOK_ANSWER_INVALID" });
		expect(await own.store.names(TARGET)).toEqual([]);
		// And the snapshot is still there to finish.
		const done = await world({ f: first.f, store: first.store });
		expect(await done.run()).toMatchObject({ state: "done", result: "imported", rawBundle: done.s.rawName });
		await expectBuilt(done);
	});

	it("a half-done snapshot gone on from, cut after every single step and claimed again, ends the same as one not cut, with no fetch", async () => {
		const whole = await halfDone();
		const wx = await world({ f: whole.f, store: whole.store });
		wx.clock.now = NOW + 3_600_000;
		const done = await wx.run();
		expect(done).toMatchObject({ state: "done", result: "imported", rawBundle: wx.s.rawName });
		const end = await endState(wx),
			trace = [...wx.w.trace];
		expect(trace.length).toBeGreaterThan(8);
		for (let cut = 1; cut <= trace.length; cut += 1) {
			const first = await halfDone();
			const x = await world({ f: first.f, store: first.store });
			x.clock.now = NOW + 3_600_000;
			x.w.cutAt = cut;
			const outcomes = [await x.run()];
			x.w.cutAt = undefined;
			while ((outcomes.at(-1) as CodeImportOutcome).state === "busy" && outcomes.length < 6)
				outcomes.push(await x.run());
			expect({ cut, at: trace[cut - 1], outcome: outcomes.at(-1) }).toEqual({
				cut,
				at: trace[cut - 1],
				outcome: done,
			});
			expect({ cut, end: await endState(x) }).toEqual({ cut, end });
			expect({
				cut,
				records: x.kernel.records.length,
				looks: x.kernel.looks.length,
				fetched: x.fetching.calls,
			}).toEqual({
				cut,
				records: 1,
				looks: 1,
				fetched: 0,
			});
			expect(x.b.looks.every((look) => look.look && look.now === Math.floor(NOW / 1000) * 1000)).toBe(true);
		}
	}, 170_000);

	it("binds a restore-shaped bundle to the first bundle it was made from by their manifests alone, and nothing else", async () => {
		const s = await SOURCE;
		const repository = { host: "qorpera" as const, owner: "acme", name: "app" };
		const first: CodeImportBundleManifest = {
			schema: "qorpera.code-import-bundle/v1",
			companyId: COMPANY,
			environmentId: ENVIRONMENT,
			repository,
			createdAt: new Date(NOW).toISOString(),
			from: { github: "Acme/Shop" },
			defaultBranch: "master",
			mainSha: s.mainSha,
			refs: s.fetched.refs,
			refsCount: s.fetched.refs.length,
			leftOut: 0,
			sha256: digest(s.raw),
			bytes: s.raw.length,
			executorOwner: OWNER,
		};
		const made: CodeBundleManifest = {
			schema: CODE_BUNDLE_SCHEMA,
			companyId: COMPANY,
			environmentId: ENVIRONMENT,
			repository: { ...repository, baseBranch: "main" },
			createdAt: new Date(Math.floor(NOW / 1000) * 1000).toISOString(),
			gitVersion: s.bundle.gitVersion,
			mainSha: s.mainSha,
			refsSha256: s.bundle.refsSha256,
			refs: s.bundle.refs,
			refsCount: s.bundle.refs.length,
			sha256: s.bundle.sha256,
			bytes: s.bundle.bytes,
			verified: true,
			executorOwner: OWNER,
		};
		const other = "e".repeat(40);
		const binds = (
			more: { first?: Partial<CodeImportBundleManifest>; made?: Partial<CodeBundleManifest> } = {},
			names: { first?: string; made?: string; environment?: string } = {},
		) =>
			codeImportSnapshotBinds(
				{ name: names.first ?? s.rawName, manifest: { ...first, ...more.first } },
				{ name: names.made ?? s.keptName, manifest: { ...made, ...more.made } },
				names.environment ?? ENVIRONMENT,
			);
		/** The restore-shaped bundle's refs with one changed, its fingerprint kept true to them. */
		const keptRefs = (refs: CodeBundleRef[]) => ({ refs, refsCount: refs.length, refsSha256: codeRefsSha256(refs) });
		const swap = (name: string, ref: CodeBundleRef | null) =>
			keptRefs(s.bundle.refs.flatMap((each) => (each.name === name ? (ref ? [ref] : []) : [each])));
		expect(binds()).toBe(true);
		const environment = "44444444-4444-4444-8444-444444444444";
		const cases: [string, boolean][] = [
			["the first of another environment", binds({ first: { environmentId: environment } })],
			["the restore-shaped of another environment", binds({ made: { environmentId: environment } })],
			["another request's environment", binds({}, { environment })],
			[
				"a first bundle of another main, named and headed so",
				binds(
					{
						first: {
							mainSha: other,
							refs: s.fetched.refs.map((ref) =>
								ref.name === "refs/heads/master" ? { ...ref, sha: other } : ref,
							),
						},
					},
					{ first: codeImportBundleName(new Date(NOW).toISOString(), other) },
				),
			],
			[
				"a first bundle's name of another main",
				binds({}, { first: codeImportBundleName(new Date(NOW).toISOString(), other) }),
			],
			[
				"a restore-shaped name of another main",
				binds({}, { made: codeBundleName(new Date(NOW).toISOString(), other) }),
			],
			[
				"made before the first",
				binds({}, { first: codeImportBundleName(new Date(NOW + 1000).toISOString(), s.mainSha) }),
			],
			[
				"a restore-shaped manifest that lists part of its refs",
				binds({ made: { refsCount: s.bundle.refs.length + 1 } }),
			],
			["a fingerprint not its refs'", binds({ made: { refsSha256: "f".repeat(64) } })],
			["no main", binds({ made: swap("refs/heads/main", null) })],
			[
				"main at another commit",
				binds({ made: swap("refs/heads/main", { name: "refs/heads/main", sha: s.devSha }) }),
			],
			["no mark", binds({ made: swap("refs/qorpera/kept-here", null) })],
			[
				"the mark at another commit",
				binds({ made: swap("refs/qorpera/kept-here", { name: "refs/qorpera/kept-here", sha: s.devSha }) }),
			],
			["a tag at another object", binds({ made: swap("refs/tags/v1", { name: "refs/tags/v1", sha: s.devSha }) })],
			[
				"a tag the first did not have",
				binds({ made: swap("refs/tags/v1", { name: "refs/tags/v2", sha: s.mainSha }) }),
			],
			[
				"a branch at another object",
				binds({
					made: swap(`${CODE_IMPORT_IMPORTED_HEADS}dev`, {
						name: `${CODE_IMPORT_IMPORTED_HEADS}dev`,
						sha: s.mainSha,
					}),
				}),
			],
			[
				"a branch the first did not have",
				binds({
					made: swap(`${CODE_IMPORT_IMPORTED_HEADS}dev`, {
						name: `${CODE_IMPORT_IMPORTED_HEADS}other`,
						sha: s.devSha,
					}),
				}),
			],
			[
				"a ref the plan never makes",
				binds({ made: swap(`${CODE_IMPORT_IMPORTED_HEADS}dev`, { name: "refs/heads/dev", sha: s.devSha }) }),
			],
			[
				"the first's default branch at another commit",
				binds({
					first: {
						refs: s.fetched.refs.map((ref) =>
							ref.name === "refs/heads/master" ? { ...ref, sha: s.devSha } : ref,
						),
					},
				}),
			],
		];
		expect(cases.filter(([, bound]) => bound).map(([name]) => name)).toEqual([]);
		// A first bundle whose manifest lists part of its refs: a ref it does not list is not held against it; one it
		// lists at another object is.
		const cutList = { refs: s.fetched.refs.filter((ref) => ref.name !== "refs/tags/v1"), refsCount: 2_400 };
		expect(binds({ first: cutList })).toBe(true);
		expect(
			binds({
				first: {
					...cutList,
					refs: s.fetched.refs
						.filter((ref) => ref.name !== "refs/tags/v1")
						.map((ref) => (ref.name === "refs/heads/dev" ? { ...ref, sha: s.mainSha } : ref)),
				},
			}),
		).toBe(false);
		// One that lists every ref it has, and not the tag: the tag was not the first bundle's.
		expect(
			binds({ first: { refs: s.fetched.refs.filter((ref) => ref.name !== "refs/tags/v1"), refsCount: 2 } }),
		).toBe(false);
	});

	it("the executor stopping in the middle of the fetch: the writer is given up, nothing is committed, nothing more is asked", async () => {
		const x = await world({ copy: true });
		x.fetching.writes = async (options, writer) => {
			await writer.write(x.s.raw.subarray(0, 100));
			await writer.write(x.s.raw.subarray(100, 200));
			await new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			return x.s.fetched;
		};
		const running = x.run();
		await until(() => (x.store.writers[0]?.chunks.length ?? 0) === 2, "two pieces");
		x.w.stopping.abort(new Error("SIGTERM"));
		expect(await running).toEqual({ schema: SCHEMA, state: "busy" });
		expect(x.store.writers.map((writer) => [writer.kind, writer.committed, writer.aborted])).toEqual([
			["import", null, true],
		]);
		expect(await x.store.names(TARGET)).toEqual([]);
		expect(x.kernel.asked).toEqual(["fetch: go"]);
		expect(x.armed()).toEqual([]);
		expect(await listing(x.f.code)).toEqual(COPY);
	});

	it("takes only an import it can read, and is made only whole", async () => {
		const x = await world();
		const request = x.kernel.claim();
		for (const bad of [
			{ ...request, kind: "restore" },
			{ ...request, token: "token" },
			{ ...request, owner: "Acme" },
			{ ...request, input: { ...request.input, via: "file" } },
			null,
		])
			expect(await x.run(bad as never)).toEqual({ schema: SCHEMA, state: "failed", code: "IMPORT_REQUEST_INVALID" });
		expect(x.kernel.asked).toEqual([]);
		for (const bad of [
			{ owner: "" },
			{ machineIdSha256: "d" },
			{ fsckMs: 0 },
			{ fetch: undefined },
			{ jobs: { ...x.options.jobs, look: undefined } },
			{ restoreJobs: { ...x.restore, reopen: undefined } },
		])
			expect(() => new CodeImport({ ...x.options, ...(bad as object) } as never)).toThrow("INVALID_CODE_IMPORT");
		// A kernel that answers something else is not heard: put off.
		const y = await world();
		const call = y.options.control.call;
		y.options.control.call = async (method, args, signal) =>
			method === "qorpera_code_request_step" && (args.p_progress as Record<string, unknown>).step === "look"
				? { schema: "qorpera.code-request-step/v1", state: "maybe" }
				: call(method, args, signal);
		expect(await new CodeImport(y.options).run(y.kernel.claim(), new AbortController().signal)).toEqual({
			schema: SCHEMA,
			state: "busy",
		});
		expect(y.errors()).toContain("CODE_IMPORT_STEP_UNCONFIRMED");
		expect(await y.store.names(TARGET)).toEqual([y.s.rawName]);
	});
});
