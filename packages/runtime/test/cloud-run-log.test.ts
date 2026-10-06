import { createHash, randomUUID } from "node:crypto";
import type {
	CloudCompanyFolderCommitResult,
	CloudCompanyFolderRelease,
	CloudCompanyFolderUnit,
	CloudCompanyFolderUnitResult,
} from "@qorpera/runtime/cloud-company-folder-client";
import {
	type CloudNativeTool,
	CloudNativeToolBoundary,
	type CloudToolResult,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	CLOUD_RUN_LOG_BLOCK_BYTES,
	CLOUD_RUN_LOG_STEP_BYTES,
	CloudRunLog,
	type CloudRunLogCall,
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
	path: string;
	gone = false;
	refuse: string | null = null;
	throwing = 0;
	/** Runs before a commit applies: another writer's change lands first. */
	before?: () => void;

	constructor(readonly runId: string) {
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
			units: units.map((unit, index) => (reason ? this.#result(unit, index, "refused", reason) : this.#apply(unit, index))),
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
		this.files.set(path, { version: randomUUID(), text: edit(lines).map((line) => `${line}\n`).join("") });
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
		const { runId, folder, log, signal } = runLog({ parent: { runId: randomUUID(), step: 4 } });
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
		expect(folder.files.get(`${folder.path}/run.toml`)?.text).toContain(`conversation = "${conversationId}"`);
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
			expect.objectContaining({ op: "write", path: `${folder.path}/log/00000000.jsonl`, expectedVersion: expect.any(String) }),
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

	it("keeps a restricted step, and every step after it, as hashes only", async () => {
		const restricted = (call: CloudRunLogCall) =>
			call.argumentsText.includes("members/") || call.reads.some((entry) => entry.path.startsWith("members/"));
		const { folder, log, signal } = runLog({ restricted });
		log.finish(step(log, "company_read", { path: "sales/prices.md" }), envelope("PUBLIC"), []);
		log.agentText("PRIVATE_AGENT_TEXT");
		const secret = step(log, "company_search", { query: "salary" });
		const outcome = envelope("PRIVATE_RESULT_TEXT");
		log.finish(secret, outcome, [
			{ releaseId: randomUUID(), reads: [read("members/70700000-0000-4000-8000-000000000002/private/pay.md")] },
		]);
		expect(log.restricted()).toBe(true);
		log.finish(step(log, "company_read", { path: "sales/plan.md" }), envelope("PRIVATE_LATER_RESULT"), []);
		await log.flush(signal);

		const [open, closed, later] = folder.all();
		expect(open).toMatchObject({ args: JSON.stringify({ path: "sales/prices.md" }), result: JSON.parse(envelope("PUBLIC")) });
		expect(closed).toEqual({
			j: 1,
			tool: "company_search",
			call: expect.any(String),
			args: "",
			args_bytes: Buffer.byteLength(JSON.stringify({ query: "salary" })),
			args_hash: sha(JSON.stringify({ query: "salary" })),
			result_bytes: Buffer.byteLength(outcome),
			result_hash: sha(outcome),
			releases: [expect.any(String)],
			at: "2026-10-06T09:12:03Z",
			hashes: true,
		});
		expect(later).toMatchObject({ args: "", hashes: true });
		expect(later).not.toHaveProperty("result");
		const stored = JSON.stringify([...folder.files.values()]);
		for (const canary of ["members/", "PRIVATE_RESULT_TEXT", "PRIVATE_AGENT_TEXT", "PRIVATE_LATER_RESULT", "sales/plan.md"])
			expect(stored).not.toContain(canary);
		expect(log.steps().slice(1)).toEqual([
			expect.objectContaining({ args: "", result: "", text: "", restricted: true }),
			expect.objectContaining({ args: "", result: "", text: "", restricted: true }),
		]);

		// A worker dispatched after that step keeps every step as hashes from its first.
		const worker = runLog({ restrictedFromStart: true });
		worker.log.finish(step(worker.log, "company_read"), envelope("PRIVATE_WORKER_RESULT"), []);
		await worker.log.flush(worker.signal);
		expect(worker.folder.all()[0]).toMatchObject({ args: "", hashes: true });
	});

	it("starts a new block at 16 steps, and before a block passes 64 KiB", async () => {
		const small = runLog();
		for (let index = 0; index < 17; index++) small.log.finish(step(small.log, "company_list"), envelope("x"), []);
		await small.log.flush(small.signal);
		expect(small.folder.blocks().map((path) => [path.slice(-14), small.folder.lines(path).length])).toEqual([
			["00000000.jsonl", 16],
			["00000016.jsonl", 1],
		]);

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
		expect(folder.all()).toEqual([expect.objectContaining({ j: 0, result: JSON.parse(envelope("WORK_LOG_UNAVAILABLE")) })]);
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

	it("rejects a malformed run log", () => {
		const folder = new Folder(randomUUID());
		const signal = new AbortController().signal;
		expect(() => new CloudRunLog({ runId: "run", conversationId, folder, signal })).toThrow("Invalid run log");
		expect(
			() => new CloudRunLog({ runId: folder.runId, conversationId, folder, signal, firstStep: -1 }),
		).toThrow("Invalid run log");
		const log = new CloudRunLog({ runId: folder.runId, conversationId, folder, signal });
		expect(() => log.step({ call: "c", tool: "company_read", argumentsText: "{}", argumentSha256: "x" })).toThrow(
			"Invalid run log step",
		);
	});
});

describe("the tool boundary with a work log", () => {
	function fixture(options: { restricted?: (call: CloudRunLogCall) => boolean } = {}) {
		const { runId, folder, log, signal } = runLog(options);
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
		};
		const boundary = new CloudNativeToolBoundary({
			companyId,
			runId,
			tools: [readTool, writeTool],
			assertActive: async () => undefined,
			signal,
			runLog: log,
		});
		const call = async (callId: string, tool: string, args: unknown) => {
			const response = await boundary.invoke(callId, "qorpera", tool, args);
			return { text: response.contentItems[0].text, result: JSON.parse(response.contentItems[0].text) as CloudToolResult };
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
				reads: [expect.objectContaining({ path: "sales/prices.md" }), expect.objectContaining({ path: "sales/plan.md" })],
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
		expect(refused.result).toMatchObject({ status: "denied", content: { text: expect.stringMatching(/^WORK_LOG_UNAVAILABLE:/) } });
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
		expect(after.result).toMatchObject({ status: "denied", content: { text: expect.stringMatching(/^WORK_LOG_GONE:/) } });
		expect(f.writeTool.execute).not.toHaveBeenCalled();
		expect(f.readTool.execute).not.toHaveBeenCalled();
		expect(f.folder.files.size).toBe(0);
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
