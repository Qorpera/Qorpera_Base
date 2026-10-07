import { createHash, randomUUID } from "node:crypto";
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
	CLOUD_RUN_LOG_READS_BYTES,
	CLOUD_RUN_LOG_STEP_BYTES,
	CloudRunLog,
	type CloudRunLogCommitted,
	type CloudRunLogFolder,
	CloudRunLogGone,
	recordCloudRunLogRelease,
} from "@qorpera/runtime/cloud-run-log";
import { afterEach, describe, expect, it, vi } from "vitest";

const companyId = randomUUID();
const conversationId = randomUUID();
const ROOT = `agents/scout/sessions/${conversationId}`;
const KEYS = ["j", "tool", "call", "args", "args_bytes", "args_hash", "result", "reads", "releases", "text", "at"];

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
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

/** The folder as the memory commit keeps it: each unit applies whole or not at all, and the `runLog` precondition
 * refuses every unit of a change set for a log that is gone or moved. */
class Folder implements CloudRunLogFolder {
	readonly files = new Map<string, { version: string; text: string }>();
	readonly folders = new Set(["agents", "agents/scout", "agents/scout/sessions", ROOT]);
	readonly commits: { key: string; units: readonly CloudCompanyFolderUnit[]; path: string }[] = [];
	readonly runId: string;
	path: string;
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
			generation: 3,
		};
	}

	async read(path: string): Promise<{ version: string; text: string } | null> {
		return this.files.get(path) ?? null;
	}

	async commit(
		key: string,
		units: readonly CloudCompanyFolderUnit[],
		runLog: { readonly run: string; readonly path: string },
	): Promise<CloudCompanyFolderCommitResult> {
		expect(runLog.run).toBe(this.runId);
		this.commits.push({ key, units, path: runLog.path });
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
			args_hash: sha(JSON.stringify({ path: "sales/prices.md" })),
			result: JSON.parse(envelope("Prices: 12 EUR")),
			reads: [{ path: released.path, version: released.version }],
			releases: [expect.any(String)],
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

	it("keeps only hashes of a send's arguments", async () => {
		const { folder, log, signal } = runLog();
		const text = JSON.stringify({ text: "PRIVATE_SEND_TEXT" });
		for (const tool of ["send_message", "send_coworker_message", "ask_member", "send_mail"])
			log.finish(step(log, tool, { text: "PRIVATE_SEND_TEXT" }), envelope("sent"), []);
		await log.flush(signal);
		for (const line of folder.all())
			expect(line).toMatchObject({ args: "", args_bytes: Buffer.byteLength(text), args_hash: sha(text) });
		expect(log.steps().every((entry) => entry.hashOnly && entry.args === "")).toBe(true);
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

	it("fits a step with very many release parts into 41 KiB: the copies give way, never the release ids", async () => {
		const { folder, log, signal } = runLog();
		const args = { path: "p".repeat(9000) };
		const argumentsText = JSON.stringify(args);
		const reads = Array.from({ length: 400 }, (_, index) => read(`sales/${index}.md`));
		const parts = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ releaseId: randomUUID(), reads: index ? [] : reads }));
		const some = parts(100);
		const many = parts(700);
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
			result: JSON.parse(envelope("r".repeat(7900))),
		});
		expect((second!.args as string).length).toBeGreaterThan(0);
		expect(Buffer.byteLength(JSON.stringify(second!.args))).toBeLessThan(CLOUD_RUN_LOG_FIELD_BYTES);
		expect(argumentsText.startsWith(second!.args as string)).toBe(true);
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
		expect(log.steps().map((entry) => entry.j)).toEqual([0, 2]);
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
		folder.commit = async (key, units, place) => {
			folder.commit = original;
			await original(key, units, place);
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
		expect(batches).toEqual([{ runId, steps: [0], blocks: [{ path: blockPath(0), version: expect.any(String) }] }]);
		// A change set of pending steps only makes nothing final.
		const second = step(log, "company_write", { path: "b.md", text: "b" });
		await log.precommit(second, signal);
		expect(batches).toHaveLength(1);
		log.finish(first, envelope("written"), []);
		log.finish(step(log, "company_read"), envelope("three"), []);
		await log.flush(signal);
		// Step 2 is still pending: the steps are listed, not a range.
		expect(batches.at(-1)).toEqual({
			runId,
			steps: [1, 3],
			blocks: [
				{ path: blockPath(0), version: folder.files.get(blockPath(0))!.version },
				{ path: blockPath(2), version: folder.files.get(blockPath(2))!.version },
			],
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
		expect(() => new CloudRunLog({ runId: "run", conversationId, folder, signal })).toThrow("Invalid run log");
		expect(() => new CloudRunLog({ runId: folder.runId, conversationId, folder, signal, firstStep: -1 })).toThrow(
			"Invalid run log",
		);
		const log = new CloudRunLog({ runId: folder.runId, conversationId, folder, signal });
		expect(() => log.step({ call: "c", tool: "company_read", argumentsText: "{}", argumentSha256: "x" })).toThrow(
			"Invalid run log step",
		);
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
		} = {},
	) {
		const { runId, folder, log, signal } = runLog(options.log);
		const order: string[] = [];
		const readTool: CloudNativeTool = {
			name: "company_read",
			description: "Read a file.",
			source: "company_file",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
			parseArguments: (value) => value,
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
		const boundary = new CloudNativeToolBoundary({
			companyId,
			runId,
			tools: [readTool, writeTool],
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
		return { folder, log, signal, boundary, call, readTool, writeTool, order };
	}

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
		// `args_hash` is the call's digest, as receipts have it.
		expect(lines[0]!.args_hash).toBe(
			sha(JSON.stringify(["qorpera", "company_read", JSON.stringify({ path: "sales/prices.md" })])),
		);
		// A release outside a logged call is not recorded anywhere.
		recordCloudRunLogRelease(randomUUID(), [read("sales/other.md")]);
	});

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
		expect(lines[1]!.args_hash).toBe(
			sha(JSON.stringify(["qorpera", "company_publish", JSON.stringify({ path: "a.md" })])),
		);
	});

	it("keeps the denial a call got when its answer was held back, never the answer", async () => {
		const f = fixture({
			// The run lost what it read after the call ran, before its answer goes back to the model.
			release: async () => {
				throw new Error("PRIVATE_UNREADABLE");
			},
		});
		vi.mocked(f.readTool.execute).mockImplementationOnce(async () => {
			recordCloudRunLogRelease(randomUUID(), [read("sales/PRIVATE_WITHHELD.md")]);
			return { kind: "text", value: "PRIVATE_WITHHELD_PRICES" } as const;
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
