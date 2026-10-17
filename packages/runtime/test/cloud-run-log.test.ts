import { createHash, createHmac, randomUUID } from "node:crypto";
import type {
	CloudCompanyFolderCommitResult,
	CloudCompanyFolderRelease,
	CloudCompanyFolderUnit,
	CloudCompanyFolderUnitResult,
} from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudNativeCaptureImages } from "@qorpera/runtime/cloud-native-capture-images";
import {
	type CloudNativeActionReview,
	type CloudNativeTool,
	CloudNativeToolBoundary,
	type CloudToolResult,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CLOUD_RUN_LOG_BLOCK_BYTES,
	CLOUD_RUN_LOG_FIELD_BYTES,
	CLOUD_RUN_LOG_PATHS,
	CLOUD_RUN_LOG_READS_BYTES,
	CLOUD_RUN_LOG_STEP_BYTES,
	CloudRunLog,
	type CloudRunLogCommitted,
	type CloudRunLogFolder,
	CloudRunLogGone,
	type CloudRunLogPreconditions,
	type CloudRunLogProtection,
	CloudRunLogUnavailable,
	type CloudRunTreeBlock,
	cloudRunLogPaths,
	cloudRunLogStepPaths,
	recordCloudRunLogRelease,
} from "@qorpera/runtime/cloud-run-log";
import { CloudRunLogRpcProtection } from "@qorpera/runtime/cloud-run-log-protection";
import { memoryBlockPath, memoryBlockText } from "@qorpera/runtime/memory-tree/tree";
import { afterEach, describe, expect, it, vi } from "vitest";

const companyId = randomUUID();
const conversationId = randomUUID();
const ROOT = `agents/scout/sessions/${conversationId}`;
const KEYS = [
	"j",
	"tool",
	"call",
	"args",
	"args_bytes",
	"args_hash",
	"result",
	"reads",
	"releases",
	"paths",
	"text",
	"at",
];

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Only the test platform holds this synthetic key; runtime production code holds no key. */
function keyed(runId: string, digest: string): string {
	return createHmac("sha256", "run-log-test-platform-key").update(`${runId}:${digest}`).digest("hex");
}

const protection: CloudRunLogProtection = {
	narrow: async () => ({ log: false, narrow: false }),
	hashes: async (runId, digests) => digests.map((digest) => keyed(runId, digest)),
};

function rpcProtection(runId: string, logNarrow: () => boolean = () => false): CloudRunLogRpcProtection {
	return new CloudRunLogRpcProtection({
		environmentId: randomUUID(),
		jobId: randomUUID(),
		runId,
		call: async (method, args) => {
			if (method === "qorpera_memory_step_hashes")
				return (args.p_digests as string[]).map((digest) => keyed(runId, digest));
			const paths = args.p_paths as string[];
			// PostgreSQL rejects these JSONB strings before the classification function can ignore non-paths.
			if (paths.some((path) => path.includes("\u0000")))
				throw new Error("22P05: unsupported Unicode escape sequence");
			if (paths.some((path) => !path.isWellFormed())) throw new Error("22P02: invalid input syntax for type json");
			return {
				log: logNarrow(),
				machine: false,
				restricted: paths.filter((path) => path.startsWith("restricted/")),
			};
		},
	});
}

function read(path: string, version = randomUUID()): CloudCompanyFolderRelease {
	return {
		path,
		version,
		authority: { resourceId: randomUUID(), resourceRevision: 1, grantId: null, grantRevision: null },
	};
}

function envelope(text: string): string {
	return JSON.stringify({ schema: "qorpera.cloud-tool-result/v1", status: "ok", content: { text } });
}

/** The folder as the memory commit keeps it: each unit applies whole or not at all, the `runLog` precondition refuses
 * every unit of a change set for a log that is gone or moved, and `runGenerations` every unit when the run's
 * generation moved. */
class Folder implements CloudRunLogFolder {
	readonly files = new Map<string, { version: string; text: string }>();
	readonly folders = new Set(["agents", "agents/scout", "agents/scout/sessions", ROOT]);
	readonly commits: {
		key: string;
		units: readonly CloudCompanyFolderUnit[];
		path: string;
		preconditions: CloudRunLogPreconditions;
	}[] = [];
	readonly runId: string;
	path: string;
	/** `qorpera_memory_run_generations.memory_generation`. */
	generation = 3;
	reads = 0;
	gone = false;
	refuse: string | null = null;
	throwing = 0;
	/** Runs before a commit applies: another writer's change lands first. */
	before?: () => void;

	constructor(runId: string) {
		this.runId = runId;
		this.path = `${ROOT}/runs/${runId}`;
	}

	async locate(runId: string): Promise<{
		path: string;
		exists: boolean;
		missing: string[];
		last: number | null;
		generation: number;
	}> {
		expect(runId).toBe(this.runId);
		if (this.gone) throw new CloudRunLogGone();
		const parts = this.path.split("/");
		const missing = parts
			.slice(0, -1)
			.map((_, index) => parts.slice(0, index + 1).join("/"))
			.filter((folder) => !this.folders.has(folder));
		const firsts = this.blocks().map((path) => Number(path.slice(-14, -6)));
		return {
			path: this.path,
			exists: this.folders.has(this.path),
			missing,
			last: firsts.length ? Math.max(...firsts) : null,
			generation: this.generation,
		};
	}

	async read(path: string): Promise<{ version: string; text: string } | null> {
		this.reads++;
		return this.files.get(path) ?? null;
	}

	async commit(
		key: string,
		units: readonly CloudCompanyFolderUnit[],
		preconditions: CloudRunLogPreconditions,
	): Promise<CloudCompanyFolderCommitResult> {
		const { runLog, runGenerations } = preconditions;
		expect(runLog.run).toBe(this.runId);
		for (const entry of runGenerations ?? []) expect(entry.runId).toBe(this.runId);
		this.commits.push({ key, units, path: runLog.path, preconditions });
		this.before?.();
		this.before = undefined;
		if (this.throwing > 0) {
			this.throwing--;
			throw new Error("PRIVATE_TRANSPORT_FAILURE");
		}
		const reason = this.gone
			? "memory_run_log_gone"
			: runLog.path !== this.path
				? "memory_run_log_moved"
				: runGenerations?.some((entry) => entry.generation !== this.generation)
					? "memory_generation_stale"
					: this.refuse;
		return {
			commitId: randomUUID(),
			seq: 1,
			replay: false,
			units: units.map((unit, index) =>
				reason ? this.#result(unit, index, "refused", reason) : this.#apply(unit, index),
			),
		};
	}

	/** The log's blocks, in step order. */
	blocks(): string[] {
		return [...this.files.keys()].filter((path) => path.startsWith(`${this.path}/log/`)).sort();
	}

	lines(path: string): Record<string, unknown>[] {
		return this.files
			.get(path)!
			.text.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	/** Every line of the log, in step order. */
	all(): Record<string, unknown>[] {
		return this.blocks().flatMap((path) => this.lines(path));
	}

	/** Another writer replaces a block, as a step erase does. */
	rewrite(path: string, edit: (lines: string[]) => string[]): void {
		const lines = this.files.get(path)!.text.split("\n").filter(Boolean);
		this.files.set(path, {
			version: randomUUID(),
			text: edit(lines)
				.map((line) => `${line}\n`)
				.join(""),
		});
	}

	/** The agent's folder renamed: the log moves with it. */
	move(to: string): void {
		const from = this.path;
		for (const [path, file] of [...this.files])
			if (path.startsWith(`${from}/`)) {
				this.files.delete(path);
				this.files.set(`${to}${path.slice(from.length)}`, file);
			}
		for (const folder of [...this.folders])
			if (folder === from || folder.startsWith(`${from}/`)) {
				this.folders.delete(folder);
				this.folders.add(`${to}${folder.slice(from.length)}`);
			}
		this.path = to;
	}

	#result(
		unit: CloudCompanyFolderUnit,
		index: number,
		outcome: CloudCompanyFolderUnitResult["outcome"],
		reason: string | null,
		version: string | null = null,
	): CloudCompanyFolderUnitResult {
		const path = unit.op === "move" || unit.op === "copy" ? unit.from : unit.path;
		return { unit: index, op: unit.op, path, to: null, version, outcome, reason, problems: [] };
	}

	#apply(unit: CloudCompanyFolderUnit, index: number): CloudCompanyFolderUnitResult {
		if (unit.op !== "mkdir" && unit.op !== "new_folder" && unit.op !== "write") throw new Error("Unexpected unit");
		const parent = unit.path.split("/").slice(0, -1).join("/");
		if (!this.folders.has(parent)) return this.#result(unit, index, "refused", "parent_missing");
		if (unit.op === "mkdir" || unit.op === "new_folder") {
			if (this.folders.has(unit.path) || this.files.has(unit.path))
				return this.#result(unit, index, "conflict", "exists");
			this.folders.add(unit.path);
			if (unit.op === "new_folder")
				for (const entry of unit.contents) {
					if (entry.kind === "folder") this.folders.add(`${unit.path}/${entry.path}`);
					else
						this.files.set(`${unit.path}/${entry.path}`, {
							version: randomUUID(),
							text: (entry.content as { text: string }).text,
						});
				}
			return this.#result(unit, index, "saved", null);
		}
		const file = this.files.get(unit.path);
		if (unit.expectedVersion === undefined ? file : file?.version !== unit.expectedVersion)
			return this.#result(unit, index, "conflict", file ? "version_changed" : "missing");
		const version = randomUUID();
		this.files.set(unit.path, { version, text: (unit.content as { text: string }).text });
		return this.#result(unit, index, "saved", null, version);
	}
}

const logs: CloudRunLog[] = [];
afterEach(async () => {
	for (const log of logs.splice(0)) await log.close(new AbortController().signal).catch(() => undefined);
});

function runLog(options: Partial<ConstructorParameters<typeof CloudRunLog>[0]> = {}) {
	const runId = options.runId ?? randomUUID();
	const folder = new Folder(runId);
	const abort = new AbortController();
	const log = new CloudRunLog({
		runId,
		conversationId,
		folder,
		protection,
		signal: abort.signal,
		now: () => new Date("2026-10-06T09:12:03.456Z"),
		...options,
	});
	logs.push(log);
	return { runId, folder, log, abort, signal: abort.signal };
}

let calls = 0;
function step(log: CloudRunLog, tool: string, args: unknown = { path: "sales/prices.md" }): number {
	const argumentsText = JSON.stringify(args);
	return log.step({ call: `call_${++calls}`, tool, argumentsText, argumentSha256: sha(argumentsText) });
}

describe("a run's work log", () => {
	it("extracts path needles at every depth from structured values and JSON text receipts", () => {
		const value = {
			nested: [{ path: "/company/restricted/a.md", children: { from: "a", to: "b", paths: ["c", 7, "d"] } }],
			note: "ordinary/path-text.md",
			path: 4,
		};
		expect(new Set(cloudRunLogPaths(value))).toEqual(new Set(["/company/restricted/a.md", "a", "b", "c", "d"]));
		expect(cloudRunLogPaths(JSON.stringify(value))).toEqual(cloudRunLogPaths(value));
		expect(cloudRunLogPaths("ordinary/path-text.md")).toEqual([]);
	});
	it("walks a large result path array without spreading it into function arguments", () => {
		expect(cloudRunLogPaths({ paths: Array(150_000).fill("restricted/a.md") })).toEqual(["restricted/a.md"]);
	});
	it.each(["path", "from", "to", "paths"])("classifies scalar and nested-array needles under %s", async (key) => {
		for (const value of ["restricted/a.md", ["restricted/a.md"], [[null, "restricted/a.md"]]]) {
			const args = { [key]: value };
			expect(cloudRunLogPaths(args)).toEqual(["restricted/a.md"]);
			const runId = randomUUID();
			const f = runLog({ runId, protection: rpcProtection(runId) });
			f.log.finish(step(f.log, "company_read", args), envelope("INVALID_ARGUMENTS"), []);
			await f.log.flush(f.signal);
			expect(f.folder.all()[0]).toMatchObject({ narrow: true, finished: true });
			expect(JSON.stringify(f.folder.commits)).not.toContain("restricted/a.md");
		}
	});

	it("keeps public earlier fills when a later pending narrow line raises SQL's log flag", async () => {
		const runId = randomUUID();
		let folder!: Folder;
		const f = runLog({
			runId,
			protection: rpcProtection(runId, () => folder.all().some((line) => line.narrow === true)),
		});
		folder = f.folder;
		const first = step(f.log, "company_write");
		await f.log.precommit(first, f.signal);
		f.log.finish(step(f.log, "company_read"), envelope("public earlier read"), []);
		f.log.finish(step(f.log, "company_read", { path: "restricted/a.md" }), envelope("private read"), []);
		const last = step(f.log, "company_write");
		await f.log.precommit(last, f.signal);
		expect(folder.all().map((line) => line.narrow === true)).toEqual([false, false, true, true]);
		f.log.finish(first, envelope("public earlier receipt"), []);
		f.log.finish(last, envelope("last receipt"), []);
		await f.log.flush(f.signal);
		expect(folder.all().map((line) => line.narrow === true)).toEqual([false, false, true, true]);
		expect(JSON.stringify(folder.all()[0])).toContain("public earlier receipt");
		expect(JSON.stringify(folder.all()[1])).toContain("public earlier read");
		expect(f.log.steps()[2]).toMatchObject({ args: JSON.stringify({ path: "restricted/a.md" }), narrow: true });
	});

	it("requires a trusted narrow start for a flagged log and honors inherited whole-log narrow", async () => {
		const runId = randomUUID();
		const trusted = rpcProtection(runId, () => true);
		const unknown = runLog({ runId, protection: trusted });
		await expect(unknown.log.precommit(step(unknown.log, "company_write"), unknown.signal)).rejects.toMatchObject({
			reason: "protection_narrow_start_unknown",
		});
		expect(unknown.folder.commits).toEqual([]);
		const inherited = runLog({ runId, protection: trusted, narrow: true });
		await inherited.log.precommit(step(inherited.log, "company_write"), inherited.signal);
		expect(inherited.folder.all()[0]).toMatchObject({ narrow: true, finished: false });
	});
	it("requires a trusted protection port even when the folder is available", () => {
		const folder = new Folder(randomUUID());
		expect(
			() =>
				new CloudRunLog({
					runId: folder.runId,
					conversationId,
					folder,
					signal: new AbortController().signal,
					protection: undefined as never,
				}),
		).toThrow("Invalid run log protection");
	});

	it("writes only the narrow shape, keeps its own full work in memory, and inherits its origin", async () => {
		const continues = randomUUID();
		const { runId, folder, log, signal } = runLog({ narrow: true, continues });
		const args = { path: "restricted/PRIVATE_PATH.md", text: "PRIVATE_ARGS".repeat(1000) };
		log.agentText("PRIVATE_AGENT_TEXT");
		const first = step(log, "company_write", args);
		await log.precommit(first, signal);
		const pending = folder.all()[0]!;
		expect(pending).toEqual({
			j: first,
			tool: "company_write",
			call: `call_${calls}`,
			at: "2026-10-06T09:12:03Z",
			finished: false,
			releases: [],
			args_hash: keyed(runId, sha(JSON.stringify(args))),
			narrow: true,
		});
		const releaseId = randomUUID();
		const result = envelope("PRIVATE_RESULT");
		log.finish(first, result, [{ releaseId, reads: [read("restricted/PRIVATE_PATH.md")] }]);
		await log.flush(signal);
		expect(folder.all()[0]).toEqual({
			...pending,
			finished: true,
			releases: [releaseId],
			result_hash: keyed(runId, sha(result)),
		});
		expect(JSON.stringify(folder.commits)).not.toContain("PRIVATE_");
		expect(log.steps()).toEqual([
			expect.objectContaining({
				j: first,
				args: JSON.stringify(args),
				result,
				text: "PRIVATE_AGENT_TEXT",
				narrow: true,
			}),
		]);
		expect(folder.files.get(`${folder.path}/run.toml`)?.text).toContain(
			`continues = "${continues}"\nnarrow = true\n`,
		);
	});

	it("classifies complete arguments and every release before fitting a public copy", async () => {
		const releaseId = randomUUID();
		const narrow = vi.fn<CloudRunLogProtection["narrow"]>(async (_run, input) => ({
			log: false,
			narrow: input.argumentsText.includes("restricted/PRIVATE_PATH.md") || input.releases.includes(releaseId),
		}));
		const args = { text: "x".repeat(20_000), path: "restricted/PRIVATE_PATH.md" };
		const first = runLog({ protection: { ...protection, narrow } });
		first.log.finish(step(first.log, "company_write", args), envelope("Written"), []);
		await first.log.flush(first.signal);
		expect(narrow.mock.calls[0]![1].argumentsText).toBe(JSON.stringify(args));
		expect(first.folder.all()[0]).toMatchObject({ narrow: true });
		expect(JSON.stringify(first.folder.commits)).not.toContain("PRIVATE_PATH");

		const second = runLog({ protection: { ...protection, narrow } });
		const released = Array.from({ length: 400 }, (_, index) => ({
			releaseId: randomUUID(),
			reads: [read(`sales/${index}.md`)],
		}));
		released.push({ releaseId, reads: [read("restricted/PRIVATE_READ.md")] });
		second.log.finish(step(second.log, "company_search", { query: "prices" }), envelope("PRIVATE_RESULT"), released);
		await second.log.flush(second.signal);
		expect(narrow.mock.calls.at(-1)![1].releases).toEqual(released.map((release) => release.releaseId));
		expect(narrow.mock.calls.at(-1)![1].readPaths).toContain("restricted/PRIVATE_READ.md");
		expect(second.folder.all()[0]).toMatchObject({
			narrow: true,
			releases: released.map((release) => release.releaseId),
		});
		expect(JSON.stringify(second.folder.commits)).not.toContain("PRIVATE_");
	});

	it("keys hashes per run and keeps the same arguments hash across pending, fill, and retries", async () => {
		const narrow: CloudRunLogProtection["narrow"] = async (_run, input) => ({
			log: false,
			narrow: input.result?.includes("PRIVATE_RESULT") ?? false,
		});
		const first = runLog({ protection: { ...protection, narrow } });
		const second = runLog({ narrow: true });
		const args = { path: "sales/a.md", text: "same words" };
		const j = step(first.log, "company_write", args);
		first.folder.throwing = 1;
		await expect(first.log.precommit(j, first.signal)).rejects.toThrow("PRIVATE_TRANSPORT_FAILURE");
		await first.log.precommit(j, first.signal);
		const hash = first.folder.all()[0]!.args_hash;
		expect(hash).toBe(keyed(first.runId, sha(JSON.stringify(args))));
		expect(hash).not.toBe(sha(JSON.stringify(args)));
		first.log.finish(j, envelope("PRIVATE_RESULT"), []);
		await first.log.flush(first.signal);
		expect(first.folder.all()[0]).toMatchObject({ args_hash: hash, narrow: true, finished: true });
		second.log.finish(step(second.log, "company_write", args), envelope("PRIVATE_RESULT"), []);
		await second.log.flush(second.signal);
		expect(second.folder.all()[0]!.args_hash).not.toBe(hash);
		expect(second.folder.all()[0]!.result_hash).not.toBe(first.folder.all()[0]!.result_hash);
	});

	it("holds later completed results until an earlier parallel effect's result is classified", async () => {
		const narrow: CloudRunLogProtection["narrow"] = async (_run, input) => ({
			log: false,
			narrow: input.result?.includes("PRIVATE_RESULT") ?? false,
		});
		const { folder, log, signal } = runLog({ protection: { ...protection, narrow } });
		const first = step(log, "company_write", { path: "sales/a.md" });
		await log.precommit(first, signal);
		const second = step(log, "company_write", { path: "sales/b.md" });
		await log.precommit(second, signal);
		log.finish(second, envelope("Public receipt"), []);
		await log.flush(signal);
		expect(folder.all().map((line) => line.result)).toEqual([null, null]);
		// A completed read between effects also remains pending; the third effect may still execute.
		const reading = step(log, "company_read");
		log.finish(reading, envelope("Public read"), []);
		const third = step(log, "company_write", { path: "sales/c.md" });
		await log.precommit(third, signal);
		expect(folder.all().map((line) => line.result)).toEqual([null, null, null, null]);
		log.finish(third, envelope("Another receipt"), []);
		log.finish(first, envelope("PRIVATE_RESULT"), []);
		await log.flush(signal);
		expect(folder.all().map((line) => [line.j, line.narrow, line.finished])).toEqual([
			[0, true, true],
			[1, true, true],
			[2, true, true],
			[3, true, true],
		]);
		expect(log.steps().every((entry) => entry.narrow && entry.result !== null)).toBe(true);
		expect(JSON.stringify(folder.commits)).not.toMatch(/PRIVATE_RESULT|Public receipt|Public read|Another receipt/);
	});

	it("keeps a batch's ordering fence when an earlier result arrives during protection", async () => {
		let entered!: () => void;
		const entering = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const narrow: CloudRunLogProtection["narrow"] = async (_run, input) => {
			if (input.j === 1) {
				entered();
				await held;
			}
			return { log: false, narrow: input.result?.includes("PRIVATE_RESULT") ?? false };
		};
		const { folder, log, signal } = runLog({ protection: { ...protection, narrow } });
		const first = step(log, "company_write");
		await log.precommit(first, signal);
		const readStep = step(log, "company_read");
		log.finish(readStep, envelope("Public read"), []);
		const next = step(log, "company_write");
		const committing = log.precommit(next, signal);
		await entering;
		log.finish(first, envelope("PRIVATE_RESULT"), []);
		release();
		await committing;
		expect(
			folder
				.all()
				.slice(0, 2)
				.every((line) => line.narrow === true && line.finished === true),
		).toBe(true);
		// The result was first written only after the preceding result's narrow decision, never broad in a prior batch.
		expect(JSON.stringify(folder.commits)).not.toContain("Public read");
	});

	it("stages nothing when protection fails anywhere in a batch", async () => {
		const { folder, log, signal } = runLog({
			protection: {
				...protection,
				narrow: async (_run, input) => {
					if (input.j === 1) throw new Error("classification unavailable");
					return { log: false, narrow: false };
				},
			},
		});
		log.finish(step(log, "company_read"), envelope("public"), []);
		log.finish(step(log, "company_read"), envelope("PRIVATE_RESULT"), []);
		await expect(log.flush(signal)).rejects.toThrow("classification unavailable");
		expect(folder.commits).toEqual([]);
	});

	it.each([
		{ hashes: [] },
		{ hashes: ["bad"] },
		{ hashes: ["a".repeat(64), "b".repeat(64)] },
		{ hashes: Array<string>(1) },
	])("refuses malformed keyed-hash results %j", async ({ hashes }) => {
		const { folder, log, signal } = runLog({ protection: { ...protection, hashes: async () => hashes } });
		const j = step(log, "company_write");
		await expect(log.precommit(j, signal)).rejects.toMatchObject({ reason: "protection_invalid" });
		expect(folder.commits).toEqual([]);
	});

	it("flushes with the supplied shutdown signal after the run signal stops", async () => {
		const signals: AbortSignal[] = [];
		const { log, abort, folder } = runLog({
			protection: {
				narrow: async (_run, _step, signal) => {
					signal.throwIfAborted();
					signals.push(signal);
					return { log: false, narrow: true };
				},
				hashes: async (runId, digests, signal) => {
					signal.throwIfAborted();
					signals.push(signal);
					return protection.hashes(runId, digests, signal);
				},
			},
		});
		log.finish(step(log, "company_read"), envelope("PRIVATE_RESULT"), []);
		abort.abort();
		const shutdown = new AbortController().signal;
		await log.close(shutdown);
		expect(signals).toEqual([shutdown, shutdown]);
		expect(folder.all()[0]).toMatchObject({ narrow: true, finished: true });
	});

	it("stops a timed batch still running when closing's signal stops, and waits for it no longer", async () => {
		const signals: AbortSignal[] = [];
		let answer: (value: { log: boolean; narrow: boolean }) => void = () => undefined;
		const { log, folder } = runLog({
			commitMs: 1,
			protection: {
				// The timed batch's answer never comes on its own: its transport ignores the signal.
				narrow: (runId, candidate, signal) => {
					signals.push(signal);
					if (signals.length > 1) return protection.narrow(runId, candidate, signal);
					return new Promise((resolve) => {
						answer = resolve;
					});
				},
				hashes: protection.hashes,
			},
		});
		log.finish(step(log, "company_read"), envelope("one"), []);
		await vi.waitFor(() => expect(signals).toHaveLength(1));
		expect(signals[0]!.aborted).toBe(false);
		const deadline = new AbortController();
		const closing = log.close(deadline.signal);
		deadline.abort(new Error("cleanup deadline"));
		await expect(closing).rejects.toThrow("cleanup deadline");
		expect(signals[0]!.aborted).toBe(true);
		expect(signals).toHaveLength(1);
		expect(folder.commits).toHaveLength(0);
		answer({ log: false, narrow: false });
	});

	it("recognizes a narrow pending line after a lost commit response and fills it once", async () => {
		const { folder, log, signal } = runLog({ narrow: true });
		const commit = folder.commit.bind(folder);
		folder.commit = async (key, units, preconditions) => {
			folder.commit = commit;
			await commit(key, units, preconditions);
			throw new Error("lost pending response");
		};
		const j = step(log, "company_write");
		await expect(log.precommit(j, signal)).rejects.toThrow("lost pending response");
		log.finish(j, envelope("PRIVATE_RESULT"), []);
		await log.flush(signal);
		expect(folder.all()).toEqual([
			expect.objectContaining({
				j,
				narrow: true,
				finished: true,
				result_hash: keyed(log.runId, sha(envelope("PRIVATE_RESULT"))),
			}),
		]);
		expect(log.steps()[0]).toMatchObject({ narrow: true, result: envelope("PRIVATE_RESULT") });
	});

	it("keeps narrow on an erased step and never resurrects its in-memory content", async () => {
		const { folder, log, signal } = runLog({ narrow: true });
		const j = step(log, "company_write", { path: "PRIVATE_PATH.md" });
		await log.precommit(j, signal);
		folder.rewrite(folder.blocks()[0]!, (lines) =>
			lines.map((line) => {
				const { j, tool, call, args_hash } = JSON.parse(line) as Record<string, unknown>;
				return JSON.stringify({ j, tool, call, args_hash, narrow: true, erased: true });
			}),
		);
		log.finish(j, envelope("PRIVATE_RESULT"), []);
		await log.flush(signal);
		expect(log.steps()[0]).toMatchObject({ narrow: true, erased: true, args: "", text: "", result: null });
		expect(folder.all()[0]).toMatchObject({ narrow: true, erased: true });
		expect(JSON.stringify([...folder.files.values()])).not.toContain("PRIVATE_");
	});

	it("cancels an origin's wait when the log closes, without holding up the closing flush", async () => {
		const { folder, log, signal } = runLog();
		const first = step(log, "company_write");
		await log.precommit(first, signal);
		const dispatch = step(log, "manage_worker", { action: "dispatch" });
		const waiting = log.precommit(dispatch, signal, { afterEarlierResults: true });
		const refused = expect(waiting).rejects.toMatchObject({ reason: "closed" });
		await log.close(new AbortController().signal);
		await refused;
		expect(folder.all().map((line) => line.j)).toEqual([first]);
	});

	it("creates the log under the conversation's tree root with its first batch", async () => {
		const parent = { runId: randomUUID(), step: 4 };
		const { runId, folder, log, signal } = runLog({ parent });
		log.agentText("Checking ");
		log.agentText("the prices.");
		const j = step(log, "company_read");
		const released = read("sales/prices.md");
		log.finish(j, envelope("Prices: 12 EUR"), [{ releaseId: randomUUID(), reads: [released] }]);
		expect(folder.commits).toHaveLength(0);
		await log.flush(signal);

		expect(folder.commits).toHaveLength(1);
		expect(folder.commits[0].key).toMatch(new RegExp(`^runlog:${runId}:[0-9a-f]{8}:1$`));
		expect(folder.commits[0].units.map((unit) => [unit.op, "path" in unit ? unit.path : null])).toEqual([
			["mkdir", `${ROOT}/runs`],
			["new_folder", folder.path],
			["write", `${folder.path}/log/00000000.jsonl`],
		]);
		// A worker's run names the run and step that dispatched it.
		expect(folder.files.get(`${folder.path}/run.toml`)?.text).toBe(
			`format = 1\nrun = "${runId}"\nconversation = "${conversationId}"\nparent = "${parent.runId}"\nstep = 4\n`,
		);
		expect(folder.folders.has(`${folder.path}/log`)).toBe(true);
		const [line] = folder.all();
		expect(Object.keys(line!)).toEqual(KEYS);
		expect(line).toEqual({
			j: 0,
			tool: "company_read",
			call: `call_${calls}`,
			args: JSON.stringify({ path: "sales/prices.md" }),
			args_bytes: Buffer.byteLength(JSON.stringify({ path: "sales/prices.md" })),
			args_hash: keyed(runId, sha(JSON.stringify({ path: "sales/prices.md" }))),
			result: JSON.parse(envelope("Prices: 12 EUR")),
			reads: [{ path: released.path, version: released.version }],
			releases: [expect.any(String)],
			// Its arguments' path: a read's path stays with the reads copy.
			paths: ["sales/prices.md"],
			text: "Checking the prices.",
			at: "2026-10-06T09:12:03Z",
		});
		expect(log.steps()).toEqual([expect.objectContaining({ j: 0, text: "Checking the prices.", hashOnly: false })]);
		expect(log.generation()).toBe(3);

		// The next step starts with no text of its own, and is appended to the same block.
		const next = step(log, "company_list", { path: "sales" });
		log.finish(next, envelope("prices.md"), []);
		await log.flush(signal);
		expect(folder.commits.at(-1)!.units).toEqual([
			expect.objectContaining({
				op: "write",
				path: `${folder.path}/log/00000000.jsonl`,
				expectedVersion: expect.any(String),
			}),
		]);
		expect(folder.all().map((line) => [line.j, line.text, line.releases])).toEqual([
			[0, "Checking the prices.", [expect.any(String)]],
			[1, "", []],
		]);
	});

	it("keeps a hook call's result without its addresses, and names no path of it", async () => {
		const narrow = vi.fn(protection.narrow);
		const { folder, log, signal } = runLog({ protection: { ...protection, narrow } });
		const hooks = {
			hooks: [
				{
					name: "orders",
					address: "PRIVATE_ADDRESS",
					path: "PRIVATE_PATH",
					deliveries: [{ url: "PRIVATE_URL", status: "delivered" }],
				},
			],
		};
		log.finish(step(log, "list_hooks", {}), envelope(JSON.stringify(hooks)), [], ["PRIVATE_PATH"]);
		// A result cut short is no JSON to take the addresses out of.
		const cut = step(log, "manage_hook", { name: "orders" });
		log.finish(cut, envelope(JSON.stringify(hooks).slice(0, 60)), [], ["PRIVATE_PATH"]);
		const refusal = JSON.stringify({ status: "denied", content: { text: "Only owners and admins manage hooks." } });
		log.finish(step(log, "manage_hook", { name: "orders" }), refusal, []);
		await log.flush(signal);

		expect(JSON.stringify(folder.commits)).not.toContain("PRIVATE_");
		expect(JSON.stringify(log.steps())).not.toContain("PRIVATE_");
		for (const [, checked] of narrow.mock.calls) expect(checked.resultPaths).toEqual([]);
		const text = (line: Record<string, unknown>) => (line.result as { content: { text: string } }).content.text;
		const [listed, cutShort, denied] = folder.all();
		expect(listed!.result).toMatchObject({ schema: "qorpera.cloud-tool-result/v1", status: "ok" });
		expect(JSON.parse(text(listed!))).toEqual({ hooks: [{ name: "orders", deliveries: [{ status: "delivered" }] }] });
		expect(text(cutShort!)).toBe(
			"(The work log leaves out this result: it held hook addresses. Call list_hooks again.)",
		);
		expect(text(denied!)).toBe("Only owners and admins manage hooks.");
		expect(folder.all().map((line) => line.paths)).toEqual([[], [], []]);
	});

	it("commits finished steps on the STEP_COMMIT timer and at 16 steps", async () => {
		const timed = runLog({ commitMs: 20 });
		timed.log.finish(step(timed.log, "company_read"), envelope("one"), []);
		expect(timed.folder.commits).toHaveLength(0);
		await vi.waitFor(() => expect(timed.folder.all()).toHaveLength(1));

		const counted = runLog();
		for (let index = 0; index < 15; index++) counted.log.finish(step(counted.log, "company_read"), envelope("x"), []);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(counted.folder.commits).toHaveLength(0);
		counted.log.finish(step(counted.log, "company_read"), envelope("x"), []);
		await vi.waitFor(() => expect(counted.folder.all()).toHaveLength(16));
	});

	it("keeps only hashes of a send's, a report's and a coding question's arguments", async () => {
		const { runId, folder, log, signal } = runLog();
		const text = JSON.stringify({ text: "PRIVATE_SEND_TEXT" });
		const hashOnly = [
			"send_message",
			"send_coworker_message",
			"ask_member",
			"send_mail",
			"report_work",
			"coding_finish",
			"coding_ask",
		];
		for (const tool of hashOnly) log.finish(step(log, tool, { text: "PRIVATE_SEND_TEXT" }), envelope("sent"), []);
		// A command is not one of them: its step keeps its line.
		const command = JSON.stringify({ command: "npm test" });
		log.finish(step(log, "coding_run_command", { command: "npm test" }), envelope("ran"), []);
		await log.flush(signal);
		const lines = folder.all();
		expect(lines.map((line) => line.tool)).toEqual([...hashOnly, "coding_run_command"]);
		for (const line of lines.slice(0, -1))
			expect(line).toMatchObject({
				args: "",
				args_bytes: Buffer.byteLength(text),
				args_hash: keyed(runId, sha(text)),
			});
		expect(lines.at(-1)).toMatchObject({
			args: command,
			args_bytes: Buffer.byteLength(command),
			args_hash: keyed(runId, sha(command)),
		});
		expect(log.steps().map((entry) => entry.hashOnly)).toEqual([...hashOnly.map(() => true), false]);
		expect(log.steps().every((entry) => entry.args === (entry.hashOnly ? "" : command))).toBe(true);
		expect(JSON.stringify([...folder.files.values()])).not.toContain("PRIVATE_SEND_TEXT");
	});

	it("keeps a result's reads up to 16 KiB, and marks a step whose reads were cut", async () => {
		const { folder, log, signal } = runLog();
		const reads = Array.from({ length: 400 }, (_, index) => read(`sales/${String(index).padStart(4, "0")}.md`));
		// A search released in two parts: the copy runs across both.
		log.finish(step(log, "company_search", { query: "prices" }), envelope("400 files"), [
			{ releaseId: randomUUID(), reads: reads.slice(0, 100) },
			{ releaseId: randomUUID(), reads: reads.slice(100) },
		]);
		log.finish(step(log, "company_read"), envelope("two files"), [
			{ releaseId: randomUUID(), reads: reads.slice(0, 2) },
		]);
		await log.flush(signal);

		const [search, small] = folder.all();
		const copy = (entries: CloudCompanyFolderRelease[]) =>
			entries.map((entry) => ({ path: entry.path, version: entry.version }));
		const kept = search!.reads as unknown[];
		expect(kept.length).toBeGreaterThan(100);
		expect(kept).toEqual(copy(reads.slice(0, kept.length)));
		expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(CLOUD_RUN_LOG_READS_BYTES);
		expect(Buffer.byteLength(JSON.stringify(copy(reads.slice(0, kept.length + 1))))).toBeGreaterThan(
			CLOUD_RUN_LOG_READS_BYTES,
		);
		expect(Object.keys(search!)).toEqual([...KEYS.slice(0, 8), "reads_cut", ...KEYS.slice(8)]);
		expect(search).toMatchObject({ reads_cut: true, releases: [expect.any(String), expect.any(String)] });
		expect(small).toMatchObject({ reads: copy(reads.slice(0, 2)) });
		expect(Object.keys(small!)).toEqual(KEYS);
	});

	it("fits a step with very many release parts into 49 KiB: the copies give way, never the release ids", async () => {
		const { folder, log, signal } = runLog();
		// Past qorpera_company_path_valid's 4,096 bytes: no company path, so the line names none.
		const args = { path: "p".repeat(9000) };
		const argumentsText = JSON.stringify(args);
		const reads = Array.from({ length: 400 }, (_, index) => read(`sales/${index}.md`));
		const parts = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ releaseId: randomUUID(), reads: index ? [] : reads }));
		const some = parts(300);
		const many = parts(1000);
		for (const releases of [some, many]) {
			log.agentText("t".repeat(9000));
			log.finish(step(log, "company_search", args), envelope("r".repeat(7900)), releases);
		}
		await log.flush(signal);

		for (const path of folder.blocks())
			for (const line of folder.files.get(path)!.text.split("\n").filter(Boolean))
				expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(CLOUD_RUN_LOG_STEP_BYTES);
		const [first, second] = folder.all();
		// The reads give way first; `text` and `args` stay whole.
		expect(first).toMatchObject({
			text: "t".repeat(CLOUD_RUN_LOG_FIELD_BYTES - 2),
			reads_cut: true,
			releases: some.map((release) => release.releaseId),
			args_bytes: Buffer.byteLength(argumentsText),
		});
		expect((first!.reads as unknown[]).length).toBeGreaterThan(0);
		expect(Buffer.byteLength(JSON.stringify(first!.args))).toBe(CLOUD_RUN_LOG_FIELD_BYTES);
		expect(argumentsText.startsWith(first!.args as string)).toBe(true);
		// Then `text`, then `args`.
		expect(second).toMatchObject({
			reads: [],
			reads_cut: true,
			text: "",
			releases: many.map((release) => release.releaseId),
			paths: [],
			result: JSON.parse(envelope("r".repeat(7900))),
		});
		expect((second!.args as string).length).toBeGreaterThan(0);
		expect(Buffer.byteLength(JSON.stringify(second!.args))).toBeLessThan(CLOUD_RUN_LOG_FIELD_BYTES);
		expect(argumentsText.startsWith(second!.args as string)).toBe(true);
		// The step lines see each step as its line stores it.
		expect(log.steps().map((entry) => [entry.args, entry.text])).toEqual([
			[first!.args, first!.text],
			[second!.args, ""],
		]);
	});

	it("names its arguments' paths on a pending line, adds its result's when finished, never its reads", async () => {
		const { folder, log, signal } = runLog();
		const j = step(log, "company_move", { from: "/company/sales/a.md", to: "sales/b.md", paths: ["sales/a.md", 7] });
		await log.precommit(j, signal);
		const pending = folder.all()[0]!;
		expect(pending).toMatchObject({ result: null, reads: [] });
		expect(new Set(pending.paths as string[])).toEqual(new Set(["sales/a.md", "sales/b.md"]));
		expect(pending.paths).toHaveLength(2);
		log.finish(
			j,
			envelope("Moved"),
			[{ releaseId: randomUUID(), reads: [read("sales/read.md")] }],
			["/company/sales/b.md", "sales/c.md"],
		);
		await log.flush(signal);
		const line = folder.all()[0]!;
		expect(line).toMatchObject({ reads: [expect.objectContaining({ path: "sales/read.md" })] });
		expect(new Set(line.paths as string[])).toEqual(new Set(["sales/a.md", "sales/b.md", "sales/c.md"]));
		expect(line.paths).toHaveLength(3);
	});

	it("strips /company/ from a step's paths, names each once, and leaves out strings no company path can be", () => {
		const nul = `a${String.fromCharCode(0)}b`;
		const lone = `a${String.fromCharCode(0xd800)}b`;
		const args = JSON.stringify({ path: "/company/a.md", paths: ["a.md", "", "/company/", nul, "x".repeat(4097)] });
		const paths = cloudRunLogStepPaths(args, ["b.md", "/company/a.md", lone, "é".repeat(2048)], ["c.md", "a.md"]);
		expect(new Set(paths)).toEqual(new Set(["a.md", "b.md", "é".repeat(2048), "c.md"]));
		expect(paths).toHaveLength(4);
		expect(cloudRunLogStepPaths(args, [], [])).toEqual(["a.md"]);
		expect(() => cloudRunLogStepPaths("{}", [7 as never], [])).toThrow("paths_invalid");
	});

	it("keeps up to 1,024 paths and 8 KiB of them on a public line", async () => {
		const many = Array.from({ length: CLOUD_RUN_LOG_PATHS }, (_, index) => `p/${index}`);
		const long = ["a".repeat(4096), "b".repeat(4089)];
		expect(Buffer.byteLength(JSON.stringify(long))).toBe(CLOUD_RUN_LOG_FIELD_BYTES);
		for (const [paths, narrow] of [
			[many, false],
			[[...many, "p/x"], true],
			[long, false],
			[[long[0]!, `${long[1]}b`], true],
		] as const) {
			const { folder, log, signal } = runLog();
			log.finish(step(log, "company_read", {}), envelope("x"), [], paths);
			await log.flush(signal);
			const [line] = folder.all();
			expect(line!.narrow === true).toBe(narrow);
			if (!narrow) expect(line!.paths).toEqual(paths);
		}
	});

	it.each([
		{
			by: "its arguments",
			args: { paths: Array.from({ length: 1025 }, (_, index) => `OVERFLOW/${index}.md`) },
			result: [],
		},
		{
			by: "its result",
			args: { path: "sales/a.md" },
			result: [`OVERFLOW/${"a".repeat(4087)}`, `OVERFLOW/${"b".repeat(4087)}`],
		},
	])("writes a step narrow when $by name too many paths, and every step after it", async ({ args, result }) => {
		const { folder, log, signal } = runLog();
		log.finish(step(log, "company_read"), envelope("before"), []);
		await log.flush(signal);
		const j = step(log, "company_write", args);
		await log.precommit(j, signal);
		// A pending line names only its arguments' paths: one whose result overflows is public until it is finished.
		expect(folder.all()[1]!.narrow === true).toBe(result.length === 0);
		log.finish(j, envelope("Written"), [], result);
		log.finish(step(log, "company_list", { path: "sales" }), envelope("AFTER"), []);
		await log.flush(signal);
		expect(folder.all().map((line) => line.narrow === true)).toEqual([false, true, true]);
		expect(JSON.stringify(folder.commits)).not.toMatch(/OVERFLOW|Written|AFTER/);
	});

	it("starts a new block at 16 steps, and before a block passes 64 KiB", async () => {
		const small = runLog();
		for (let index = 0; index < 17; index++) small.log.finish(step(small.log, "company_list"), envelope("x"), []);
		await small.log.flush(small.signal);
		expect(small.folder.blocks().map((path) => [path.slice(-14), small.folder.lines(path).length])).toEqual([
			["00000000.jsonl", 16],
			["00000016.jsonl", 1],
		]);
		// A run nothing dispatched names no parent.
		expect(small.folder.files.get(`${small.folder.path}/run.toml`)?.text).toBe(
			`format = 1\nrun = "${small.runId}"\nconversation = "${conversationId}"\n`,
		);

		// Full-size steps: about 24 KiB each, so a block closes at two.
		const full = runLog();
		for (let index = 0; index < 5; index++) {
			full.log.agentText("t".repeat(9000));
			full.log.finish(step(full.log, "company_read", { path: "p".repeat(9000) }), envelope("r".repeat(7000)), []);
		}
		await full.log.flush(full.signal);
		expect(full.folder.blocks().map((path) => path.slice(-14))).toEqual([
			"00000000.jsonl",
			"00000002.jsonl",
			"00000004.jsonl",
		]);
		for (const path of full.folder.blocks()) {
			expect(Buffer.byteLength(full.folder.files.get(path)!.text)).toBeLessThanOrEqual(CLOUD_RUN_LOG_BLOCK_BYTES);
			for (const line of full.folder.files.get(path)!.text.split("\n").filter(Boolean))
				expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(CLOUD_RUN_LOG_STEP_BYTES);
		}
		expect(full.folder.all()[0]).toMatchObject({ text: "t".repeat(8 * 1024 - 2) });
	});

	it("counts a pending step at its full size, so filling in results never passes 64 KiB", async () => {
		const { folder, log, signal } = runLog();
		log.finish(step(log, "company_read"), envelope("small"), []);
		const first = step(log, "company_write", { path: "a.md", text: "a" });
		await log.precommit(first, signal);
		const second = step(log, "company_write", { path: "b.md", text: "b" });
		await log.precommit(second, signal);
		// The first block holds a small step and one pending step: a second pending step starts a new block.
		expect(folder.blocks().map((path) => [path.slice(-14), folder.lines(path).map((line) => line.result)])).toEqual([
			["00000000.jsonl", [expect.any(Object), null]],
			["00000002.jsonl", [null]],
		]);
		log.finish(first, envelope("r".repeat(7900)), []);
		log.finish(second, envelope("r".repeat(7900)), []);
		await log.flush(signal);
		for (const path of folder.blocks())
			expect(Buffer.byteLength(folder.files.get(path)!.text)).toBeLessThanOrEqual(CLOUD_RUN_LOG_BLOCK_BYTES);
		expect(folder.all().map((line) => line.result === null)).toEqual([false, false, false]);
	});

	it("splits a batch that fills many pending results into change sets of at most 64 files", async () => {
		const { folder, log, signal } = runLog();
		const steps: number[] = [];
		for (let index = 0; index < 70; index++) {
			const j = step(log, "company_write", { path: `f${index}.md`, text: "x" });
			await log.precommit(j, signal);
			steps.push(j);
		}
		expect(folder.blocks()).toHaveLength(70);
		const before = folder.commits.length;
		for (const j of steps) log.finish(j, envelope(`done ${j}`), []);
		await log.flush(signal);
		const fills = folder.commits.slice(before);
		expect(fills.map((commit) => commit.units.length)).toEqual([64, 6]);
		expect(new Set(fills.map((commit) => commit.key)).size).toBe(2);
		expect(folder.all().map((line) => (line.result as { content: { text: string } }).content.text)).toEqual(
			steps.map((j) => `done ${j}`),
		);
	});

	it("never fills in a line marked erased, and keeps the lines it did not write", async () => {
		const { folder, log, signal } = runLog();
		log.finish(step(log, "company_read"), envelope("kept"), []);
		const acting = step(log, "company_write", { path: "a.md", text: "PRIVATE_ERASED_ARGS" });
		await log.precommit(acting, signal);
		const [block] = folder.blocks();
		// A step erase rewrites the block between the pre-commit and the fill.
		folder.rewrite(block!, (lines) =>
			lines.map((line) => {
				const record = JSON.parse(line) as Record<string, unknown>;
				if (record.j !== acting) return line;
				const { j, tool, call, args_bytes, args_hash } = record;
				return JSON.stringify({ j, tool, call, args_bytes, args_hash, erased: true });
			}),
		);
		log.finish(acting, envelope("PRIVATE_ERASED_RESULT"), []);
		log.finish(step(log, "company_list"), envelope("after"), []);
		await log.flush(signal);

		const lines = folder.all();
		expect(lines.map((line) => [line.j, line.erased === true])).toEqual([
			[0, false],
			[1, true],
			[2, false],
		]);
		expect(Object.keys(lines[1]!)).toEqual(["j", "tool", "call", "args_bytes", "args_hash", "erased"]);
		expect(JSON.stringify([...folder.files.values()])).not.toMatch(/PRIVATE_ERASED/);
		// The step lines keep the erased step in its place, with nothing but its number, call id and tool.
		const steps = log.steps();
		expect(steps.map((entry) => [entry.j, entry.erased === true])).toEqual([
			[0, false],
			[1, true],
			[2, false],
		]);
		expect(steps[1]).toEqual({
			j: 1,
			call: lines[1]!.call,
			tool: "company_write",
			hashOnly: false,
			args: "",
			result: null,
			text: "",
			at: "",
			erased: true,
		});
		expect(JSON.stringify(steps)).not.toMatch(/PRIVATE_ERASED/);
	});

	it("reads a block again after another writer's change, and keeps that writer's lines", async () => {
		const { folder, log, signal } = runLog();
		log.finish(step(log, "company_read"), envelope("one"), []);
		await log.flush(signal);
		const [block] = folder.blocks();
		folder.before = () => folder.rewrite(block!, (lines) => lines.map((line) => line.replace('"one"', '"ONE"')));
		log.finish(step(log, "company_read"), envelope("two"), []);
		await log.flush(signal);
		expect(folder.all().map((line) => (line.result as { content: { text: string } }).content.text)).toEqual([
			"ONE",
			"two",
		]);
	});

	it("finds its log by run id again after the agent's folder is renamed", async () => {
		const { folder, log, signal } = runLog();
		log.finish(step(log, "company_read"), envelope("one"), []);
		await log.flush(signal);
		const moved = `agents/scout-2/sessions/${conversationId}/runs/${folder.runId}`;
		folder.folders.add("agents/scout-2");
		folder.folders.add("agents/scout-2/sessions");
		folder.folders.add(`agents/scout-2/sessions/${conversationId}`);
		folder.move(moved);
		log.finish(step(log, "company_read"), envelope("two"), []);
		await log.flush(signal);
		expect(folder.commits.map((commit) => commit.path)).toEqual([
			`${ROOT}/runs/${folder.runId}`,
			`${ROOT}/runs/${folder.runId}`,
			moved,
		]);
		expect(folder.blocks()).toEqual([`${moved}/log/00000000.jsonl`]);
		expect(folder.all().map((line) => line.j)).toEqual([0, 1]);
		expect([...folder.files.keys()].some((path) => path.startsWith(ROOT))).toBe(false);
	});

	it("ends with a gone log: it writes nothing more, and no acting step is committed", async () => {
		const { folder, log, signal } = runLog();
		log.finish(step(log, "company_read"), envelope("one"), []);
		await log.flush(signal);
		folder.gone = true;
		const acting = step(log, "company_write", { path: "a.md", text: "a" });
		await expect(log.precommit(acting, signal)).rejects.toBeInstanceOf(CloudRunLogGone);
		expect(log.gone).toBe(true);
		const commits = folder.commits.length;
		const later = step(log, "company_write", { path: "b.md", text: "b" });
		await expect(log.precommit(later, signal)).rejects.toBeInstanceOf(CloudRunLogGone);
		await expect(log.flush(signal)).rejects.toBeInstanceOf(CloudRunLogGone);
		expect(folder.commits).toHaveLength(commits);
		expect(folder.all()).toHaveLength(1);

		// A log whose conversation folder was deleted before its first batch.
		const early = runLog();
		early.folder.gone = true;
		const first = step(early.log, "company_write", { path: "a.md", text: "a" });
		await expect(early.log.precommit(first, early.signal)).rejects.toBeInstanceOf(CloudRunLogGone);
		expect(early.folder.commits).toHaveLength(0);
	});

	it("fails a batch that meets an open step erase, and lands it once the erase is done", async () => {
		const { folder, log, signal } = runLog();
		folder.refuse = "memory_erase_open";
		const acting = step(log, "company_write", { path: "a.md", text: "a" });
		await expect(log.precommit(acting, signal)).rejects.toMatchObject({
			name: "CloudRunLogUnavailable",
			reason: "memory_erase_open",
		});
		expect(folder.blocks()).toHaveLength(0);
		folder.refuse = null;
		log.finish(acting, envelope("WORK_LOG_UNAVAILABLE"), []);
		await log.flush(signal);
		expect(folder.all()).toEqual([
			expect.objectContaining({ j: 0, result: JSON.parse(envelope("WORK_LOG_UNAVAILABLE")) }),
		]);
	});

	it("finds a batch whose answer was lost in the file, and does not write it twice", async () => {
		const { folder, log, signal } = runLog();
		log.finish(step(log, "company_read"), envelope("one"), []);
		await log.flush(signal);
		// The commit lands, then its answer is lost.
		const original = folder.commit.bind(folder);
		folder.commit = async (key, units, preconditions) => {
			folder.commit = original;
			await original(key, units, preconditions);
			throw new Error("PRIVATE_LOST_ANSWER");
		};
		log.finish(step(log, "company_read"), envelope("two"), []);
		await expect(log.flush(signal)).rejects.toThrow("PRIVATE_LOST_ANSWER");
		log.finish(step(log, "company_read"), envelope("three"), []);
		await log.flush(signal);
		expect(folder.all().map((line) => line.j)).toEqual([0, 1, 2]);
	});

	it("tells its listeners which steps each change set made final, and the blocks it saved", async () => {
		const { runId, folder, log, signal } = runLog();
		const blockPath = (first: number) => `${folder.path}/log/${String(first).padStart(8, "0")}.jsonl`;
		log.onCommitted(() => {
			throw new Error("PRIVATE_LISTENER_FAILURE");
		});
		const batches: CloudRunLogCommitted[] = [];
		const stop = log.onCommitted((batch) => batches.push(batch));
		log.finish(step(log, "company_read"), envelope("one"), []);
		const first = step(log, "company_write", { path: "a.md", text: "a" });
		await log.precommit(first, signal);
		expect(batches).toEqual([
			{ runId, steps: [0], blocks: [{ path: blockPath(0), version: expect.any(String) }], generation: 3 },
		]);
		// A change set of pending steps only makes nothing final.
		const second = step(log, "company_write", { path: "b.md", text: "b" });
		await log.precommit(second, signal);
		expect(batches).toHaveLength(1);
		log.finish(first, envelope("written"), []);
		log.finish(step(log, "company_read"), envelope("three"), []);
		await log.flush(signal);
		// Step 2 is still pending: step 3 cannot become immutable until its predecessor is classified.
		expect(batches.at(-1)).toEqual({
			runId,
			steps: [1],
			blocks: [{ path: blockPath(0), version: folder.files.get(blockPath(0))!.version }],
			generation: 3,
		});
		stop();
		log.finish(second, envelope("written"), []);
		await log.flush(signal);
		expect(batches).toHaveLength(2);
		expect(folder.all().map((line) => line.result === null)).toEqual([false, false, false, false]);
	});

	it("refuses a block it reads back that is not a run log", async () => {
		for (const text of ["not json\n", "[1]\n", '{"tool":"company_read"}\n', '{"j":-1}\n']) {
			// A resumed run, whose last block another writer left malformed.
			const { folder, log, signal } = runLog({ firstStep: 2 });
			folder.folders.add(folder.path);
			folder.folders.add(`${folder.path}/log`);
			folder.files.set(`${folder.path}/log/00000000.jsonl`, { version: randomUUID(), text });
			log.finish(step(log, "company_read"), envelope("one"), []);
			await expect(log.flush(signal)).rejects.toThrow("Invalid run log block");
			expect(folder.commits).toHaveLength(0);
		}
	});

	it("continues a resumed run's log in its last block, and keeps the lines before it as they are", async () => {
		const earlier = runLog();
		for (const text of ["one", "two"]) earlier.log.finish(step(earlier.log, "company_read"), envelope(text), []);
		await earlier.log.close(earlier.signal);
		const { folder } = earlier;
		const [block] = folder.blocks();
		const before = folder.files.get(block!)!;
		const { log, signal } = runLog({ runId: earlier.runId, folder, firstStep: 2 });
		log.finish(step(log, "company_read"), envelope("three"), []);
		await log.flush(signal);
		expect(folder.commits.at(-1)!.units).toEqual([
			expect.objectContaining({ op: "write", path: block, expectedVersion: before.version }),
		]);
		expect(folder.files.get(block!)!.text.startsWith(before.text)).toBe(true);
		expect(folder.all().map((line) => line.j)).toEqual([0, 1, 2]);
		expect(log.steps().map((entry) => entry.j)).toEqual([2]);
	});

	it("rejects a malformed run log", () => {
		const folder = new Folder(randomUUID());
		const signal = new AbortController().signal;
		expect(() => new CloudRunLog({ runId: "run", conversationId, folder, signal, protection })).toThrow(
			"Invalid run log",
		);
		expect(
			() => new CloudRunLog({ runId: folder.runId, conversationId, folder, signal, protection, firstStep: -1 }),
		).toThrow("Invalid run log");
		const log = new CloudRunLog({ runId: folder.runId, conversationId, folder, signal, protection });
		expect(() => log.step({ call: "c", tool: "company_read", argumentsText: "{}", argumentSha256: "x" })).toThrow(
			"Invalid run log step",
		);
	});
});

describe("a resumed run's earlier steps", () => {
	it("reads the steps before its first step as their lines store them, an erased one kept in place", async () => {
		const first = runLog();
		first.log.agentText("Looking.");
		for (let index = 0; index < 18; index++)
			first.log.finish(step(first.log, "company_read", { path: `f${index}.md` }), envelope(`r${index}`), []);
		first.log.finish(step(first.log, "send_message", { text: "PRIVATE_SEND_TEXT" }), envelope("sent"), []);
		// The earlier process paused while this call ran.
		const acting = step(first.log, "company_write", { path: "a.md", text: "a" });
		await first.log.precommit(acting, first.signal);
		await first.log.close(first.signal);
		const committed = first.log.steps();
		const { folder } = first;
		expect(folder.blocks().map((path) => path.slice(-14))).toEqual(["00000000.jsonl", "00000016.jsonl"]);
		// Step 3 is erased, and the resume filled in the paused call's result (W5).
		folder.rewrite(folder.blocks()[0]!, (lines) =>
			lines.map((line) => {
				const record = JSON.parse(line) as Record<string, unknown>;
				if (record.j !== 3) return line;
				const { j, tool, call, args_bytes, args_hash } = record;
				return JSON.stringify({ j, tool, call, args_bytes, args_hash, erased: true });
			}),
		);
		folder.rewrite(folder.blocks()[1]!, (lines) =>
			lines.map((line) => line.replace('"result":null', `"result":${envelope("OUTCOME_UNKNOWN")}`)),
		);
		folder.generation = 4;

		const { log, signal } = runLog({ runId: first.runId, folder, firstStep: 20 });
		const earlier = await log.earlier(signal);
		expect(earlier.map((entry) => entry.j)).toEqual(Array.from({ length: 20 }, (_, j) => j));
		// The erase moved the run's generation, and finding the log read it.
		expect(log.generation()).toBe(4);
		expect(earlier[0]).toEqual({
			j: 0,
			call: committed[0]!.call,
			tool: "company_read",
			hashOnly: false,
			args: JSON.stringify({ path: "f0.md" }),
			result: envelope("r0"),
			text: "Looking.",
			at: "2026-10-06T09:12:03Z",
		});
		for (const j of [1, 2, ...Array.from({ length: 15 }, (_, index) => index + 4)])
			expect(earlier[j]).toEqual(committed[j]);
		expect(earlier[3]).toEqual({
			j: 3,
			call: committed[3]!.call,
			tool: "company_read",
			hashOnly: false,
			args: "",
			result: null,
			text: "",
			at: "",
			erased: true,
		});
		expect(earlier[18]).toMatchObject({ tool: "send_message", hashOnly: true, args: "" });
		expect(earlier[19]).toEqual({ ...committed[19], result: envelope("OUTCOME_UNKNOWN") });
		expect(JSON.stringify(earlier)).not.toContain("PRIVATE_SEND_TEXT");

		// They are read once, and the resumed run's own steps are not among them.
		log.finish(step(log, "company_read"), envelope("twenty"), []);
		await log.flush(signal);
		const reads = folder.reads;
		expect(await log.earlier(signal)).toBe(earlier);
		expect(folder.reads).toBe(reads);
		expect(log.steps().map((entry) => entry.j)).toEqual([20]);
		expect(folder.all().map((line) => line.j)).toEqual(Array.from({ length: 21 }, (_, j) => j));

		// A run that starts at step 0 has none, and reads nothing for them.
		const fresh = runLog();
		expect(await fresh.log.earlier(fresh.signal)).toEqual([]);
		expect(fresh.folder.reads).toBe(0);
	});

	it("refuses earlier steps the log does not hold", async () => {
		const missing = runLog({ firstStep: 2 });
		await expect(missing.log.earlier(missing.signal)).rejects.toMatchObject({
			name: "CloudRunLogUnavailable",
			reason: "no_log",
		});

		const first = runLog();
		for (const text of ["one", "two", "three"]) first.log.finish(step(first.log, "company_read"), envelope(text), []);
		await first.log.close(first.signal);
		const { folder } = first;
		const short = runLog({ runId: first.runId, folder, firstStep: 5 });
		await expect(short.log.earlier(short.signal)).rejects.toMatchObject({
			name: "CloudRunLogUnavailable",
			reason: "log_short",
		});

		// A block whose steps are not numbered in order is not a run log.
		folder.rewrite(folder.blocks()[0]!, (lines) => lines.filter((line) => !line.startsWith('{"j":1,')));
		const gap = runLog({ runId: first.runId, folder, firstStep: 3 });
		await expect(gap.log.earlier(gap.signal)).rejects.toThrow("Invalid run log block");

		folder.gone = true;
		const gone = runLog({ runId: first.runId, folder, firstStep: 3 });
		await expect(gone.log.earlier(gone.signal)).rejects.toBeInstanceOf(CloudRunLogGone);
		expect(gone.log.gone).toBe(true);
	});
});

describe("the run's tree beside its log", () => {
	const T0 = memoryBlockPath(0, 0);
	const T1 = memoryBlockPath(4, 0);
	const block = (...texts: string[]) =>
		memoryBlockText(
			texts.map((text, k) => ({ l: 0, k, free: true, text })),
			"run",
		);

	const t0 = (version: string | null, ...texts: string[]): CloudRunTreeBlock[] => [
		{ path: T0, text: block(...texts), version },
	];
	const t1 = (version: string | null, ...texts: string[]): CloudRunTreeBlock[] => [
		{ path: T1, text: block(...texts), version },
	];

	async function landed() {
		const run = runLog();
		run.log.finish(step(run.log, "company_read"), envelope("one"), []);
		await run.log.flush(run.signal);
		return run;
	}

	it("reads and commits step lines under the log's folder, making the tier folders they need", async () => {
		const { folder, log, signal } = await landed();
		expect([T0, T1]).toEqual(["t0/00000000.jsonl", "t1/00000000.jsonl"]);
		expect(await log.treeRead(T0, signal)).toBeNull();
		expect(await log.commitTree("steplines:0001", t0(null, "read"), 3, signal)).toBe("landed");
		expect(folder.commits.at(-1)).toEqual({
			key: "steplines:0001",
			path: folder.path,
			preconditions: {
				runLog: { run: folder.runId, path: folder.path },
				runGenerations: [{ runId: folder.runId, generation: 3 }],
			},
			units: [
				{ op: "mkdir", path: `${folder.path}/t0` },
				{
					op: "write",
					path: `${folder.path}/${T0}`,
					content: { text: block("read"), mediaType: "application/jsonl" },
				},
			],
		});
		const file = await log.treeRead(T0, signal);
		expect(file).toEqual(folder.files.get(`${folder.path}/${T0}`));

		// The next batch writes the block at the version it read, and makes only the tier folder it lacks.
		const upper = memoryBlockText([{ l: 4, k: 0, free: true, text: "read and listed" }], "run");
		expect(
			await log.commitTree(
				"steplines:0002",
				[
					{ path: T0, text: block("read", "listed"), version: file!.version },
					{ path: T1, text: upper, version: null },
				],
				3,
				signal,
			),
		).toBe("landed");
		const shape = (unit: CloudCompanyFolderUnit) => [
			unit.op,
			"path" in unit ? unit.path : null,
			"expectedVersion" in unit ? unit.expectedVersion : null,
		];
		expect(folder.commits.at(-1)!.units.map(shape)).toEqual([
			["mkdir", `${folder.path}/t1`, null],
			["write", `${folder.path}/${T0}`, file!.version],
			["write", `${folder.path}/${T1}`, null],
		]);
		expect(folder.files.get(`${folder.path}/${T0}`)!.text).toBe(block("read", "listed"));
		expect(folder.files.get(`${folder.path}/${T1}`)!.text).toBe(upper);
		// The step batches go on beside the tree, which they never touch.
		log.finish(step(log, "company_read"), envelope("two"), []);
		await log.flush(signal);
		expect(folder.commits.at(-1)!.preconditions).toEqual({ runLog: { run: folder.runId, path: folder.path } });
		expect(folder.all().map((line) => line.j)).toEqual([0, 1]);
	});

	it("takes a tier folder another batch made, and makes one again that it took to exist", async () => {
		const { folder, log, signal } = await landed();
		folder.folders.add(`${folder.path}/t0`);
		expect(await log.commitTree("steplines:0001", t0(null, "a"), 3, signal)).toBe("landed");
		// The folder was there: the block lands in the same change set.
		expect(folder.commits.at(-1)!.units.map((unit) => unit.op)).toEqual(["mkdir", "write"]);
		expect(folder.files.get(`${folder.path}/${T0}`)!.text).toBe(block("a"));

		// A block read at a version whose tier folder is gone: the folder is made again, and the block found changed.
		const commits = folder.commits.length;
		expect(await log.commitTree("steplines:0002", t1("v1", "b"), 3, signal)).toBe("stale");
		expect(folder.commits.slice(commits).map((commit) => [commit.key, commit.units.map((unit) => unit.op)])).toEqual([
			["steplines:0002", ["write"]],
			["steplines:0002:2", ["mkdir", "write"]],
		]);
		expect(folder.folders.has(`${folder.path}/t1`)).toBe(true);
		expect(folder.files.has(`${folder.path}/${T1}`)).toBe(false);
	});

	it("refuses a batch when the run's generation moved or a step erase is open, and a block that changed", async () => {
		const { folder, log, signal } = await landed();
		folder.generation = 4;
		expect(await log.commitTree("steplines:0001", t0(null, "a"), 3, signal)).toBe("stale");
		folder.generation = 3;
		folder.refuse = "memory_erase_open";
		expect(await log.commitTree("steplines:0002", t0(null, "a"), 3, signal)).toBe("stale");
		folder.refuse = null;
		expect(folder.folders.has(`${folder.path}/t0`)).toBe(false);
		expect(folder.commits.slice(-2).map((commit) => commit.units.length)).toEqual([2, 2]);

		expect(await log.commitTree("steplines:0003", t0(null, "a"), 3, signal)).toBe("landed");
		// Another writer's block is there: a new block meets it, and so does a write at an older version.
		expect(await log.commitTree("steplines:0004", t0(null, "b"), 3, signal)).toBe("stale");
		const file = await log.treeRead(T0, signal);
		folder.rewrite(`${folder.path}/${T0}`, (lines) => lines);
		expect(await log.commitTree("steplines:0005", t0(file!.version, "c"), 3, signal)).toBe("stale");
		expect(folder.files.get(`${folder.path}/${T0}`)!.text).toBe(block("a"));

		// Each block lands or not on its own: the changed block is refused, and the new block beside it lands.
		const upper = memoryBlockText([{ l: 4, k: 0, free: true, text: "a" }], "run");
		const split = [...t0(file!.version, "c"), { path: T1, text: upper, version: null }];
		expect(await log.commitTree("steplines:0006", split, 3, signal)).toBe("stale");
		expect(folder.files.get(`${folder.path}/${T0}`)!.text).toBe(block("a"));
		expect(folder.files.get(`${folder.path}/${T1}`)!.text).toBe(upper);
		// Both are read again before the batch is built again.
		const [low, high] = [await log.treeRead(T0, signal), await log.treeRead(T1, signal)];
		const both = memoryBlockText([{ l: 4, k: 0, free: true, text: "a and c" }], "run");
		expect(
			await log.commitTree(
				"steplines:0007",
				[
					{ path: T0, text: block("a", "c"), version: low!.version },
					{ path: T1, text: both, version: high!.version },
				],
				3,
				signal,
			),
		).toBe("landed");
		expect(folder.files.get(`${folder.path}/${T1}`)!.text).toBe(both);

		// Step batches are never discarded: they name no generation.
		folder.generation = 9;
		log.finish(step(log, "company_read"), envelope("two"), []);
		await log.flush(signal);
		expect(folder.all().map((line) => line.j)).toEqual([0, 1]);
	});

	it("finds a moved log again, and stops once it is gone", async () => {
		const { folder, log, signal } = await landed();
		const old = folder.path;
		expect(await log.commitTree("steplines:0001", t0(null, "a"), 3, signal)).toBe("landed");
		const file = await log.treeRead(T0, signal);
		const rename = (agent: string) => {
			for (const folderPath of ["agents", `agents/${agent}`, `agents/${agent}/sessions`])
				folder.folders.add(folderPath);
			folder.folders.add(`agents/${agent}/sessions/${conversationId}`);
			const to = `agents/${agent}/sessions/${conversationId}/runs/${folder.runId}`;
			folder.move(to);
			return to;
		};
		const moved = rename("scout-2");
		expect(await log.commitTree("steplines:0002", t0(file!.version, "a", "b"), 3, signal)).toBe("landed");
		expect(folder.commits.slice(-2).map((commit) => [commit.key, commit.path])).toEqual([
			["steplines:0002", old],
			["steplines:0002:2", moved],
		]);
		expect(folder.files.get(`${moved}/${T0}`)!.text).toBe(block("a", "b"));
		expect((await log.treeRead(T0, signal))?.text).toBe(block("a", "b"));

		// A read at the place the log has just left finds nothing: the batch built on it is stale, and the next read
		// finds the block at the new place.
		const again = rename("scout-3");
		expect(await log.treeRead(T0, signal)).toBeNull();
		expect(await log.commitTree("steplines:0003", t0(null, "c"), 3, signal)).toBe("stale");
		expect(await log.treeRead(T0, signal)).toEqual(folder.files.get(`${again}/${T0}`));
		expect(folder.files.get(`${again}/${T0}`)!.text).toBe(block("a", "b"));

		folder.gone = true;
		expect(await log.commitTree("steplines:0004", t0(null, "d"), 3, signal)).toBe("gone");
		expect(log.gone).toBe(true);
		const commits = folder.commits.length;
		await expect(log.treeRead(T0, signal)).rejects.toBeInstanceOf(CloudRunLogGone);
		expect(await log.commitTree("steplines:0005", t0(null, "e"), 3, signal)).toBe("gone");
		expect(folder.commits).toHaveLength(commits);
	});

	it("commits a resumed run's step lines at the generation its log was found at", async () => {
		const first = await landed();
		await first.log.close(first.signal);
		// A step erase between the pause and the resume moved the generation.
		first.folder.generation = 5;
		const { folder } = first;
		const { log, signal } = runLog({ runId: first.runId, folder, firstStep: 1 });
		expect(log.generation()).toBe(0);
		expect(await log.treeRead(T0, signal)).toBeNull();
		expect(log.generation()).toBe(5);
		expect(await log.commitTree("steplines:0001", t0(null, "read"), log.generation(), signal)).toBe("landed");
		expect(folder.commits.at(-1)!.preconditions.runGenerations).toEqual([{ runId: first.runId, generation: 5 }]);
	});

	it("keeps reading and committing step lines after the log is closed, until the run ends", async () => {
		const { folder, log, signal } = runLog();
		log.finish(step(log, "company_read"), envelope("one"), []);
		await log.close(signal);
		expect(() => step(log, "company_read")).toThrow("Run log closed");
		expect(log.steps().map((entry) => entry.j)).toEqual([0]);
		expect(await log.treeRead(T0, signal)).toBeNull();
		expect(await log.commitTree("steplines-1", t0(null, "read"), 3, signal)).toBe("landed");
		const file = await log.treeRead(T0, signal);
		expect(file?.text).toBe(block("read"));
		expect(await log.commitTree("steplines-2", t0(file!.version, "read more"), 3, signal)).toBe("landed");
		expect(folder.files.get(`${folder.path}/${T0}`)!.text).toBe(block("read more"));
	});

	it("refuses tree reads and commits before the log's first batch, and malformed ones", async () => {
		const early = runLog();
		await expect(early.log.treeRead(T0, early.signal)).rejects.toMatchObject({
			name: "CloudRunLogUnavailable",
			reason: "no_log",
		});
		await expect(early.log.commitTree("steplines:0001", t0(null, "a"), 0, early.signal)).rejects.toBeInstanceOf(
			CloudRunLogUnavailable,
		);
		expect(early.folder.commits).toHaveLength(0);

		const { folder, log, signal } = await landed();
		for (const path of [
			"t0/0000000.jsonl",
			"t0/00000000.json",
			"t01/00000000.jsonl",
			"t15/00000000.jsonl",
			"t0/000000000.jsonl",
			"log/00000000.jsonl",
			"/t0/00000000.jsonl",
			"t0/../log/00000000.jsonl",
			"run.toml",
		])
			await expect(log.treeRead(path, signal)).rejects.toThrow("Invalid run tree path");
		const good: CloudRunTreeBlock = { path: T0, text: block("a"), version: null };
		const bad: [string, CloudRunTreeBlock[], number][] = [
			["short", [good], 3],
			["steplines 0001", [good], 3],
			["steplines:0001", [], 3],
			["steplines:0001", [good, { ...good }], 3],
			["steplines:0001", [{ ...good, path: "log/00000000.jsonl" }], 3],
			["steplines:0001", [good], -1],
			["steplines:0001", [good], 1.5],
			[
				"steplines:0001",
				Array.from({ length: 65 }, (_, index) => ({ ...good, path: memoryBlockPath(0, index * 16) })),
				3,
			],
			["steplines:0001", [{ ...good, text: "x".repeat(1024 * 1024 + 1) }], 3],
		];
		for (const [key, blocks, generation] of bad)
			await expect(log.commitTree(key, blocks, generation, signal)).rejects.toThrow("Invalid run tree batch");
		const commits = folder.commits.length;

		// A refusal of any other kind is not a stale batch.
		folder.refuse = "denied";
		await expect(log.commitTree("steplines:0002", [good], 3, signal)).rejects.toMatchObject({
			name: "CloudRunLogUnavailable",
			reason: "denied",
		});
		expect(folder.commits).toHaveLength(commits + 1);
	});
});

describe("the tool boundary with a work log", () => {
	function fixture(
		options: {
			log?: Partial<ConstructorParameters<typeof CloudRunLog>[0]>;
			/** The release check a call's answer passes before it goes back to the model. */
			release?: () => Promise<void>;
			/** The automatic review every call passes before it runs. */
			review?: CloudNativeActionReview;
			parseRead?: CloudNativeTool["parseArguments"];
		} = {},
	) {
		const { runId, folder, log, signal, abort } = runLog(options.log);
		const order: string[] = [];
		const readTool: CloudNativeTool = {
			name: "company_read",
			description: "Read a file.",
			source: "company_file",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
			parseArguments: options.parseRead ?? ((value) => value),
			execute: vi.fn(async () => {
				order.push("read");
				recordCloudRunLogRelease("70700000-0000-4000-8000-0000000000a1", [read("sales/prices.md")]);
				recordCloudRunLogRelease("70700000-0000-4000-8000-0000000000a2", [read("sales/plan.md")]);
				recordCloudRunLogRelease("70700000-0000-4000-8000-0000000000a1", [read("sales/prices.md")]);
				return { kind: "text", value: "Prices" } as const;
			}),
		};
		const writeTool: CloudNativeTool = {
			name: "company_write",
			description: "Write a file.",
			source: "company_file",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" }, text: { type: "string" } },
				additionalProperties: false,
			},
			parseArguments: (value) => value,
			execute: vi.fn(async () => {
				order.push("write");
				// The step is in the log, with no result yet, before the call runs.
				const lines = folder.all();
				expect(lines.at(-1)).toMatchObject({ tool: "company_write", result: null, releases: [] });
				return { kind: "text", value: "Written" } as const;
			}),
			// What the call stood for is closed after a denial (P40b), once its step is in the log with no result yet.
			denied: vi.fn(async () => {
				order.push("denied");
				expect(folder.all().at(-1)).toMatchObject({ tool: "company_write", result: null, releases: [] });
				return "Closed.";
			}),
		};
		const workerTool: CloudNativeTool = {
			name: "manage_worker",
			description: "Dispatch a worker.",
			source: "runtime",
			inputSchema: { type: "object", properties: { action: { type: "string" } }, additionalProperties: false },
			parseArguments: (value) => value,
			execute: vi.fn(async () => {
				order.push("worker");
				expect(folder.all().at(-1)).toMatchObject({ tool: "manage_worker", narrow: true, finished: false });
				return { kind: "text", value: "Worker started" } as const;
			}),
		};
		const boundary = new CloudNativeToolBoundary({
			companyId,
			runId,
			tools: [readTool, writeTool, workerTool],
			assertActive: async () => undefined,
			signal,
			runLog: log,
			...(options.review ? { review: options.review } : {}),
			// Only the capture images' release check is used here.
			...(options.release
				? { captures: { assertReadable: options.release } as unknown as CloudNativeCaptureImages }
				: {}),
		});
		const call = async (callId: string, tool: string, args: unknown) => {
			const response = await boundary.invoke(callId, "qorpera", tool, args);
			return {
				text: response.contentItems[0].text,
				result: JSON.parse(response.contentItems[0].text) as CloudToolResult,
			};
		};
		return { folder, log, signal, abort, boundary, call, readTool, writeTool, workerTool, order };
	}

	it.each(["arguments", "result"])(
		"a non-path oversized string in %s does not block later effects",
		async (source) => {
			const runId = randomUUID();
			const f = fixture({
				log: { runId, protection: rpcProtection(runId) },
				...(source === "arguments"
					? {
							parseRead: () => {
								throw new Error("invalid path");
							},
						}
					: {}),
			});
			const long = "x".repeat(5000);
			if (source === "result")
				vi.mocked(f.readTool.execute).mockResolvedValueOnce({ kind: "json", value: { path: long } });
			const reading = await f.call("long_path", "company_read", {
				path: source === "arguments" ? long : "sales/a.md",
			});
			expect(reading.result.status).toBe(source === "arguments" ? "denied" : "ok");
			const writing = await f.call("later_effect", "company_write", { path: "sales/b.md", text: "written" });
			expect(writing.result.status).toBe("ok");
			expect(f.writeTool.execute).toHaveBeenCalledOnce();
			await f.log.close(f.signal);
			expect(f.folder.all().map((line) => line.j)).toEqual([0, 1]);
			expect(f.folder.all().every((line) => line.result !== null)).toBe(true);
		},
	);

	it.each([
		{ source: "arguments", path: "a\u0000b", kind: "NUL" },
		{ source: "arguments", path: "a\ud800b", kind: "lone high surrogate" },
		{ source: "arguments", path: "a\udc00b", kind: "lone low surrogate" },
		{ source: "JSON text result", path: "a\u0000b", kind: "NUL" },
		{ source: "JSON text result", path: "a\ud800b", kind: "lone high surrogate" },
		{ source: "JSON text result", path: "a\udc00b", kind: "lone low surrogate" },
	])("a $kind needle in $source does not block a later write or closing the log", async ({ source, path }) => {
		const runId = randomUUID();
		const f = fixture({
			log: { runId, protection: rpcProtection(runId) },
			...(source === "arguments"
				? {
						parseRead: () => {
							throw new Error("invalid path");
						},
					}
				: {}),
		});
		if (source === "JSON text result")
			vi.mocked(f.readTool.execute).mockResolvedValueOnce({ kind: "text", value: JSON.stringify({ path }) });
		const reading = await f.call("invalid_unicode", "company_read", {
			path: source === "arguments" ? path : "sales/a.md",
		});
		expect(reading.result.status).toBe(source === "arguments" ? "denied" : "ok");
		const writing = await f.call("later_effect", "company_write", { path: "sales/b.md", text: "written" });
		expect(writing.result.status).toBe("ok");
		expect(f.writeTool.execute).toHaveBeenCalledOnce();
		await f.log.close(f.signal);
		expect(f.folder.all().map((line) => [line.j, line.result])).toEqual([
			[0, reading.result],
			[1, writing.result],
		]);
		if (source === "arguments") expect(f.folder.all()[0]!.args).toBe(JSON.stringify({ path }));
		else expect(reading.result.content.text).toBe(JSON.stringify({ path }));
	});

	it("logs every call with the envelope it got and every release it made", async () => {
		const f = fixture();
		expect(f.boundary.runLog).toBe(f.log);
		const reading = await f.call("call_r1", "company_read", { path: "sales/prices.md" });
		expect(f.folder.commits).toHaveLength(0);
		const writing = await f.call("call_w1", "company_write", { path: "a.md", text: "a" });
		expect(writing.result.status).toBe("ok");
		expect(f.order).toEqual(["read", "write"]);
		await f.log.flush(f.signal);
		const lines = f.folder.all();
		expect(lines).toEqual([
			expect.objectContaining({
				j: 0,
				call: "call_r1",
				result: JSON.parse(reading.text),
				reads: [
					expect.objectContaining({ path: "sales/prices.md" }),
					expect.objectContaining({ path: "sales/plan.md" }),
				],
				releases: ["70700000-0000-4000-8000-0000000000a1", "70700000-0000-4000-8000-0000000000a2"],
			}),
			expect.objectContaining({ j: 1, call: "call_w1", result: JSON.parse(writing.text), releases: [] }),
		]);
		// The log keys the complete argument text's digest, not the boundary's namespace/tool digest.
		expect(lines[0]!.args_hash).toBe(keyed(f.log.runId, sha(JSON.stringify({ path: "sales/prices.md" }))));
		// A release outside a logged call is not recorded anywhere.
		recordCloudRunLogRelease(randomUUID(), [read("sales/other.md")]);
	});

	it.each(["json", "text"] as const)(
		"classifies the complete %s result's paths beyond the envelope cut",
		async (kind) => {
			const narrow = vi.fn<CloudRunLogProtection["narrow"]>(async (_run, input) => ({
				log: false,
				narrow: input.resultPaths.includes("restricted/PRIVATE_PATH.md"),
			}));
			const f = fixture({ log: { protection: { ...protection, narrow } } });
			const value = { a: "PRIVATE_CONTENT".repeat(1500), z: { path: "restricted/PRIVATE_PATH.md" } };
			vi.mocked(f.readTool.execute).mockResolvedValueOnce(
				kind === "json" ? { kind: "json", value } : { kind: "text", value: JSON.stringify(value) },
			);
			const response = await f.call("raw_paths", "company_read", { path: "sales/index.md" });
			expect(response.result.content.truncated).toBe(true);
			expect(response.text).not.toContain("PRIVATE_PATH");
			await f.log.flush(f.signal);
			expect(narrow.mock.calls[0]![1].resultPaths).toEqual(["restricted/PRIVATE_PATH.md"]);
			expect(f.folder.all()[0]).toMatchObject({ narrow: true, finished: true });
			expect(JSON.stringify(f.folder.commits)).not.toContain("PRIVATE_");
			// The own-work view still gets only the delivered envelope, never the larger raw tool result.
			expect(f.log.steps()[0]!.result).toBe(response.text);
			expect(f.log.steps()[0]!.result).not.toContain("PRIVATE_PATH");
		},
	);

	it("does not run an acting call whose pre-commit cannot land", async () => {
		const f = fixture();
		f.folder.refuse = "memory_erase_open";
		const refused = await f.call("call_w1", "company_write", { path: "a.md", text: "a" });
		expect(refused.result).toMatchObject({
			status: "denied",
			content: { text: expect.stringMatching(/^WORK_LOG_UNAVAILABLE:/) },
		});
		expect(f.writeTool.execute).not.toHaveBeenCalled();
		// A read is not held by the log.
		expect((await f.call("call_r1", "company_read", { path: "sales/prices.md" })).result.status).toBe("ok");

		f.folder.refuse = null;
		f.folder.throwing = 1;
		const lost = await f.call("call_w2", "company_write", { path: "a.md", text: "a" });
		expect(lost.result.content.text).toMatch(/^WORK_LOG_UNAVAILABLE:/);
		expect(f.writeTool.execute).not.toHaveBeenCalled();

		expect((await f.call("call_w3", "company_write", { path: "a.md", text: "a" })).result.status).toBe("ok");
		expect(f.writeTool.execute).toHaveBeenCalledOnce();
		await f.log.flush(f.signal);
		// The refused calls are steps too, with the denial they got.
		expect(f.folder.all().map((line) => [line.call, (line.result as CloudToolResult).status])).toEqual([
			["call_w1", "denied"],
			["call_r1", "ok"],
			["call_w2", "denied"],
			["call_w3", "ok"],
		]);
	});

	it("runs no effect when the trusted classification or keyed-hash service is unavailable", async () => {
		for (const failed of ["narrow", "hashes"] as const) {
			const f = fixture({
				log: {
					protection: {
						...protection,
						[failed]: async () => {
							throw new Error("PRIVATE_PROTECTION_FAILURE");
						},
					},
				},
			});
			const refused = await f.call("call_w1", "company_write", { path: "a.md", text: "PRIVATE_ARGS" });
			expect(refused.result.content.text).toMatch(/^WORK_LOG_UNAVAILABLE:/);
			expect(f.writeTool.execute).not.toHaveBeenCalled();
			expect(f.folder.commits).toEqual([]);
			expect(refused.text).not.toContain("PRIVATE_PROTECTION_FAILURE");
		}
	});

	it.each(["dispatch", "followup"])(
		"waits for earlier narrow results before executing a worker %s",
		async (action) => {
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let checks = 0;
			const f = fixture({
				release: () => (++checks === 1 ? held : Promise.resolve()),
				log: {
					protection: {
						...protection,
						narrow: async (_run, input) => ({
							log: false,
							narrow: input.result?.includes("PRIVATE_RESULT") ?? false,
						}),
					},
				},
			});
			vi.mocked(f.writeTool.execute).mockImplementationOnce(async () => {
				f.order.push("first");
				return { kind: "text", value: "PRIVATE_RESULT" };
			});
			const earlier = f.call("first", "company_write", { path: "a.md", text: "a" });
			await vi.waitFor(() => expect(checks).toBe(1));
			// Execution is ordered by the boundary, but an ordinary effect need not wait for the earlier release.
			expect((await f.call("ordinary", "company_write", { path: "b.md", text: "b" })).result.status).toBe("ok");
			expect(f.order).toEqual(["first", "write"]);
			const precommit = vi.spyOn(f.log, "precommit");
			const dispatch = f.call("worker", "manage_worker", { action });
			await vi.waitFor(() =>
				expect(precommit).toHaveBeenCalledWith(2, expect.any(AbortSignal), { afterEarlierResults: true }),
			);
			expect(f.workerTool.execute).not.toHaveBeenCalled();
			expect(f.folder.all().map((line) => line.j)).toEqual([0, 1]);
			release();
			await earlier;
			expect((await dispatch).result.status).toBe("ok");
			expect(f.workerTool.execute).toHaveBeenCalledOnce();
			expect(f.folder.all().at(-1)).toMatchObject({ narrow: true, finished: false });
			await f.log.flush(f.signal);
			expect(f.folder.all().every((line) => line.narrow === true)).toBe(true);
		},
	);

	it.each(["abort", "boundary-close"])("never executes an origin whose wait ends by %s", async (stop) => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let checks = 0;
		const f = fixture({ release: () => (++checks === 1 ? held : Promise.resolve()) });
		const earlier = f.call("first", "company_write", { path: "a.md", text: "a" });
		await vi.waitFor(() => expect(checks).toBe(1));
		const precommit = vi.spyOn(f.log, "precommit");
		const dispatch = f.call("worker", "manage_worker", { action: "dispatch" });
		await vi.waitFor(() =>
			expect(precommit).toHaveBeenCalledWith(1, expect.any(AbortSignal), { afterEarlierResults: true }),
		);
		if (stop === "abort") f.abort.abort();
		else f.boundary.close();
		const results = await Promise.all([earlier, dispatch]);
		release();
		expect(results[1]!.result.status).toBe("denied");
		expect(f.workerTool.execute).not.toHaveBeenCalled();
		expect(f.folder.all().map((line) => line.j)).toEqual([0]);
	});

	it("runs no call of a run whose log is gone", async () => {
		const f = fixture();
		f.folder.gone = true;
		const gone = await f.call("call_w1", "company_write", { path: "a.md", text: "a" });
		expect(gone.result.content.text).toMatch(/^WORK_LOG_GONE:/);
		expect(f.log.gone).toBe(true);
		const after = await f.call("call_r1", "company_read", { path: "sales/prices.md" });
		expect(after.result).toMatchObject({
			status: "denied",
			content: { text: expect.stringMatching(/^WORK_LOG_GONE:/) },
		});
		expect(f.writeTool.execute).not.toHaveBeenCalled();
		expect(f.readTool.execute).not.toHaveBeenCalled();
		expect(f.folder.files.size).toBe(0);
	});

	it("commits a denied call before its denial closes what it stood for, else closes nothing", async () => {
		const DENIAL = "DENIED: The member said no.";
		const f = fixture({
			review: {
				check: async ({ tool }) =>
					tool.name === "company_write"
						? { run: false, text: DENIAL, deniedReviewId: randomUUID() }
						: { run: true },
			},
		});
		const closed = await f.call("call_w1", "company_write", { path: "a.md", text: "a" });
		expect(closed.result).toMatchObject({ status: "denied", content: { text: `${DENIAL} Closed.` } });
		expect(f.order).toEqual(["denied"]);
		expect(f.folder.commits).toHaveLength(1);

		// A pre-commit that cannot land closes nothing: the denial stands as it is.
		f.folder.refuse = "memory_erase_open";
		const refused = await f.call("call_w2", "company_write", { path: "a.md", text: "b" });
		expect(refused.result).toMatchObject({ status: "denied", content: { text: DENIAL } });
		f.folder.refuse = null;
		f.folder.gone = true;
		const gone = await f.call("call_w3", "company_write", { path: "a.md", text: "c" });
		expect(gone.result).toMatchObject({ status: "denied", content: { text: DENIAL } });
		expect(f.log.gone).toBe(true);
		expect(f.writeTool.denied).toHaveBeenCalledOnce();
		expect(f.writeTool.execute).not.toHaveBeenCalled();
		// Only the step whose pre-commit landed is in the log; the log was gone before its answer was filled in.
		expect(f.folder.all()).toEqual([expect.objectContaining({ j: 0, call: "call_w1", result: null })]);
	});

	it("keeps a step for every call the model sees, also one refused before it runs", async () => {
		const f = fixture();
		const big = { path: "a.md", text: "x".repeat(70 * 1024) };
		const oversized = await f.call("call_big", "company_write", big);
		expect(oversized.result).toMatchObject({ status: "denied", content: { text: "INVALID_ARGUMENTS" } });
		expect(oversized.result.provenance.argumentSha256).toBeNull();
		const unknown = await f.call("call_unknown", "company_publish", { path: "a.md" });
		expect(unknown.result.content.text).toBe("TOOL_UNAVAILABLE");
		const first = await f.call("call_r1", "company_read", { path: "sales/prices.md" });
		const reused = await f.call("call_r1", "company_read", { path: "sales/plan.md" });
		expect(reused.result.content.text).toBe("CALL_ID_REUSED");
		// An exact repeat is the step it repeats.
		expect((await f.call("call_r1", "company_read", { path: "sales/prices.md" })).text).toBe(first.text);
		expect(f.readTool.execute).toHaveBeenCalledOnce();
		expect(f.writeTool.execute).not.toHaveBeenCalled();
		await f.log.flush(f.signal);

		const lines = f.folder.all();
		const answer = (line: Record<string, unknown>) => (line.result as CloudToolResult).content.text;
		expect(lines.map((line) => [line.j, line.call, line.tool, answer(line)])).toEqual([
			[0, "call_big", "company_write", "INVALID_ARGUMENTS"],
			[1, "call_unknown", "company_publish", "TOOL_UNAVAILABLE"],
			[2, "call_r1", "company_read", "Prices"],
			[3, "call_r1", "company_read", "CALL_ID_REUSED"],
		]);
		expect(lines.map((line) => line.result)).toEqual([oversized, unknown, first, reused].map((call) => call.result));
		// Arguments the boundary refused are kept as far as `args` stores them, with no digest, as their envelope has it.
		expect(lines[0]).toMatchObject({ args_bytes: Buffer.byteLength(JSON.stringify(big)), args_hash: null });
		expect(Buffer.byteLength(JSON.stringify(lines[0]!.args))).toBe(CLOUD_RUN_LOG_FIELD_BYTES);
		expect(JSON.stringify(big).startsWith(lines[0]!.args as string)).toBe(true);
		expect(lines[1]!.args_hash).toBe(keyed(f.log.runId, sha(JSON.stringify({ path: "a.md" }))));
	});

	it("keeps the denial a call got when its answer was held back, never the answer", async () => {
		const narrow = vi.fn<CloudRunLogProtection["narrow"]>(async () => ({ log: false, narrow: false }));
		const f = fixture({
			log: { protection: { ...protection, narrow } },
			// The run lost what it read after the call ran, before its answer goes back to the model.
			release: async () => {
				throw new Error("PRIVATE_UNREADABLE");
			},
		});
		vi.mocked(f.readTool.execute).mockImplementationOnce(async () => {
			recordCloudRunLogRelease(randomUUID(), [read("sales/PRIVATE_WITHHELD.md")]);
			return {
				kind: "json",
				value: { path: "restricted/PRIVATE_WITHHELD.md", text: "PRIVATE_WITHHELD_PRICES" },
			} as const;
		});
		const denied = await f.call("call_r1", "company_read", { path: "sales/prices.md" });
		expect(denied.result).toMatchObject({ status: "denied", content: { text: "AUTHORITY_UNAVAILABLE" } });
		expect(f.readTool.execute).toHaveBeenCalledOnce();
		await f.log.flush(f.signal);
		expect(f.folder.all()).toEqual([
			expect.objectContaining({ call: "call_r1", result: JSON.parse(denied.text), reads: [], releases: [] }),
		]);
		expect(JSON.stringify([...f.folder.files.values()])).not.toContain("PRIVATE_WITHHELD");
		expect(f.log.steps()).toEqual([expect.objectContaining({ j: 0, result: denied.text })]);
		expect(narrow.mock.calls[0]![1]).toMatchObject({ readPaths: [], resultPaths: [], releases: [] });
	});

	it("keeps a call that threw as unconfirmed, as its turn ended", async () => {
		let fail = true;
		const f = fixture({
			log: {
				effectful: (tool) => {
					if (tool.name === "company_write" && fail) {
						fail = false;
						throw new Error("PRIVATE_CLASSIFIER_FAILURE");
					}
					return tool.name !== "company_read";
				},
			},
		});
		const thrown = f.call("call_w1", "company_write", { path: "a.md", text: "a" });
		await expect(thrown).rejects.toThrow("PRIVATE_CLASSIFIER_FAILURE");
		expect((await f.call("call_w2", "company_write", { path: "a.md", text: "a" })).result.status).toBe("ok");
		expect(f.writeTool.execute).toHaveBeenCalledOnce();
		await f.log.flush(f.signal);
		const lines = f.folder.all().map((line) => {
			const result = line.result as CloudToolResult;
			return [line.call, result.status, result.content.text, line.releases];
		});
		expect(lines).toEqual([
			["call_w1", "unconfirmed", "TOOL_OUTCOME_UNCONFIRMED", []],
			["call_w2", "ok", "Written", []],
		]);
		expect(JSON.stringify([...f.folder.files.values()])).not.toContain("PRIVATE_CLASSIFIER");
	});

	it("commits an acting call only once the call before it has its answer", async () => {
		let open!: () => void;
		const held = new Promise<void>((resolve) => {
			open = resolve;
		});
		let checks = 0;
		// The read's release check waits, while the write behind it runs up to its pre-commit.
		const f = fixture({ release: () => (++checks === 1 ? held : Promise.resolve()) });
		const reading = f.call("call_r1", "company_read", { path: "sales/prices.md" });
		const writing = f.call("call_w1", "company_write", { path: "a.md", text: "a" });
		await vi.waitFor(() => expect(checks).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(f.writeTool.execute).not.toHaveBeenCalled();
		expect(f.folder.commits).toHaveLength(0);
		open();
		expect((await reading).result.status).toBe("ok");
		expect((await writing).result.status).toBe("ok");
		expect(f.order).toEqual(["read", "write"]);
		await f.log.flush(f.signal);
		expect(f.folder.all().map((line) => [line.j, line.call, (line.result as CloudToolResult).status])).toEqual([
			[0, "call_r1", "ok"],
			[1, "call_w1", "ok"],
		]);
	});

	it("refuses a work log of another run", () => {
		const { log, signal } = runLog();
		expect(
			() =>
				new CloudNativeToolBoundary({
					companyId,
					runId: randomUUID(),
					tools: [],
					assertActive: async () => undefined,
					signal,
					runLog: log,
				}),
		).toThrow("Invalid cloud tool boundary");
	});
});
