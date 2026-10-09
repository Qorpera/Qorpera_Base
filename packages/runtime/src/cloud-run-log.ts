import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { isUuid, type JsonValue, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { cloudActionEffect } from "./cloud-action-review.ts";
import type {
	CloudCompanyFolderCommitResult,
	CloudCompanyFolderRelease,
	CloudCompanyFolderUnit,
} from "./cloud-company-folder-client.ts";
import type { CloudNativeTool } from "./cloud-native-tool-boundary.ts";

/**
 * A run's work log (RUNTIME-AGENT-MEMORY-TREE.md §4.5, W1). Every tool call the model sees is one step record, one
 * JSON line, in blocks `<tree root>/runs/<run>/log/<first step>.jsonl` under the tree root of the conversation the run
 * answers. Steps are numbered in the order the calls came, and each keeps the answer the model got. The log is the
 * only copy of the run's work: context views keep digests only. Only the platform writes it.
 *
 * - Steps are committed in batches every STEP_COMMIT (16 steps or 30 seconds) and at run end. A batch only appends,
 *   and fills in the results of this run's own pending steps. It keeps every other line as the file has it, so it never
 *   brings back an erased step, and it never fills in a line marked erased.
 * - An effectful call (anything `cloudActionEffect` does not class as a read) is committed before it runs, as a step
 *   with no result yet, once no call before it is still waiting for its answer. The call runs only once that commit
 *   has landed. A denied call that closes what it stood for (P40b) is committed the same way before it closes it.
 * - A send, a card or a `send_mail` keeps no copy of its arguments: `args` is "", and `args_bytes` and `args_hash`
 *   stay. For now its `args_hash` is the boundary's plain digest of the call, as for every step, so a guess of its
 *   words can be checked against it. W1c-3 replaces it with the platform's keyed hash before any run is built with a
 *   log.
 * - Narrow steps, for folders not shared with every agent, are not built here: every step keeps its full line. W1c-3
 *   brings their line shape, with the platform's keyed hashes, before any run is built with a log.
 * - The run's tree, its step lines (§7.5), sits beside the log in `runs/<run>/t<n>/`. W2's step-line writer reads and
 *   commits its blocks through `treeRead` and `commitTree`, also after `close`, for the lines built at closing. Only
 *   its batches check the run's generation: they are derived, and are refused when it moved.
 */

export const CLOUD_RUN_LOG_BLOCK_STEPS = 16;
/** Core §5's bound on one structured file. */
export const CLOUD_RUN_LOG_BLOCK_BYTES = 64 * 1024;
/** The most a step record takes as stored, with its keys and newline. A pending step counts at this size, so filling
 * in its result never takes its block past CLOUD_RUN_LOG_BLOCK_BYTES. */
export const CLOUD_RUN_LOG_STEP_BYTES = 41 * 1024;
/** `args`, `text` and the result envelope, each as stored (JSON escaping and quotes included). */
export const CLOUD_RUN_LOG_FIELD_BYTES = 8 * 1024;
/** The copy of the result's read references, as stored. */
export const CLOUD_RUN_LOG_READS_BYTES = 16 * 1024;
/** STEP_COMMIT: a batch writes at most this many new steps, and waiting finished steps are committed at this count. */
export const CLOUD_RUN_LOG_COMMIT_STEPS = 16;
export const CLOUD_RUN_LOG_COMMIT_MS = 30_000;
/** Core §5's change set: a batch past either bound is committed as several change sets, in step order. */
const CHANGE_SET_BYTES = 1024 * 1024;
const CHANGE_SET_FILES = 64;
/** Tries of one batch: a conflict, a moved log or a missing parent is read again and done again. */
const ATTEMPTS = 4;
/** Calls whose words are already in the conversation, on a card or in the outbox row: their arguments are not copied. */
const HASH_ONLY_TOOLS = new Set(["send_message", "send_coworker_message", "ask_member", "send_mail"]);
/** A block of the run's tree under the log's folder, as `memoryBlockPath` names it: tier `t0` to `t14`, block
 * `<8 digits>`. */
const TREE_PATH = /^t(?:[0-9]|1[0-4])\/\d{8}\.jsonl$/;
/** A tree batch's operation key, with room for the try it is on (the folder's keys are 8 to 200 characters). */
const TREE_KEY = /^[A-Za-z0-9._:-]{8,190}$/;

/** The log's folder was deleted (`memory_run_log_gone`): its effectful calls can no longer be committed first, so they
 * do not run, and the run ends. */
export class CloudRunLogGone extends Error {
	constructor() {
		super("Run log gone");
		this.name = "CloudRunLogGone";
	}
}

/** A batch could not land now (for example `memory_erase_open`, or an unreachable database). It is tried again by the
 * next batch; an effectful call waiting on it does not run. */
export class CloudRunLogUnavailable extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`Run log unavailable: ${reason}`);
		this.name = "CloudRunLogUnavailable";
		this.reason = reason;
	}
}

/** Where a run's log is now. */
export interface CloudRunLogPlace {
	/** The log's folder, `<tree root>/runs/<run>`: the path `qorpera_memory_run_logs` gives the run now, or for a log not
	 * yet created, the tree root of the run's conversation at its owner's current path. */
	readonly path: string;
	/** Whether the log's folder exists (its first batch landed). */
	readonly exists: boolean;
	/** Folders above a new log's folder that do not exist yet, outermost first. Its first batch makes them. */
	readonly missing: readonly string[];
	/** The first step of the log's last block, null when it has none. */
	readonly last: number | null;
	/** `qorpera_memory_run_generations.memory_generation` (0 before the first batch). */
	readonly generation: number;
}

/** The memory commit's preconditions for a change set of a run log's folder. */
export interface CloudRunLogPreconditions {
	/** The log's folder as the change set found it: `memory_run_log_moved` when the index has it elsewhere now, and
	 * `memory_run_log_gone` when its row is retired. */
	readonly runLog: { readonly run: string; readonly path: string };
	/** For a batch of the run's tree only: the run's generation as the batch read it, `memory_generation_stale` when it
	 * moved. A step batch names none (§4.5). */
	readonly runGenerations?: readonly { readonly runId: string; readonly generation: number }[];
}

/** The folder as a run log uses it. W1c-3 builds it on the folder client and the run-log index. */
export interface CloudRunLogFolder {
	/** Throws CloudRunLogGone when the log's index row, or for a new log its conversation owner's row, is retired or
	 * missing. */
	locate(runId: string, signal: AbortSignal): Promise<CloudRunLogPlace>;
	/** A file's committed text and version, or null when there is none. */
	read(path: string, signal: AbortSignal): Promise<{ readonly version: string; readonly text: string } | null>;
	/** Stages and commits one change set through the folder memory commit. A refusal is a unit outcome
	 * (`memory_run_log_gone`, `memory_run_log_moved`, `memory_erase_open`, `memory_generation_stale`), with nothing
	 * applied. */
	commit(
		operationKey: string,
		units: readonly CloudCompanyFolderUnit[],
		preconditions: CloudRunLogPreconditions,
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult>;
}

/** A release a tool made while it ran: its id, and the reads it recorded, a folder release's or zoom's platform read
 * of tree blocks (M1b-3). Its line keeps only their paths and versions. */
export interface CloudRunLogRelease {
	readonly releaseId: string;
	readonly reads: readonly Pick<CloudCompanyFolderRelease, "path" | "version">[];
}

/** One step as its line stores it, for the run's step lines (W2). A hashes-only step has `args` "". */
export interface CloudRunLogStep {
	readonly j: number;
	readonly call: string;
	readonly tool: string;
	readonly args: string;
	/** The result envelope, or null while the step is pending. */
	readonly result: string | null;
	readonly text: string;
	readonly hashOnly: boolean;
	/** "" for an erased step. */
	readonly at: string;
	/** An erased step (§10.1) keeps only its number, call id and tool: `args` and `text` are "", `result` is null. */
	readonly erased?: true;
}

/** The steps one change set made final, in step order, and the blocks it saved. */
export interface CloudRunLogCommitted {
	readonly runId: string;
	readonly steps: readonly number[];
	readonly blocks: readonly { readonly path: string; readonly version: string }[];
	/** The run's generation as the log found it: a batch of step lines built from these steps commits at it. */
	readonly generation: number;
}

/** A block of the run's tree as a batch of step lines writes it: its path under the log's folder (`memoryBlockPath`),
 * its text, and the version it was read at, null for a new block. */
export interface CloudRunTreeBlock {
	readonly path: string;
	readonly text: string;
	readonly version: string | null;
}

const RELEASES = new AsyncLocalStorage<CloudRunLogRelease[]>();

/** Runs a tool call so that every release it makes is recorded for its step. */
export function cloudRunLogReleases<T>(releases: CloudRunLogRelease[], operation: () => T): T {
	return RELEASES.run(releases, operation);
}

/** Called by the folder client, or by zoom, once a release is recorded. Outside a logged tool call it does nothing. */
export function recordCloudRunLogRelease(releaseId: string, reads: CloudRunLogRelease["reads"]): void {
	const releases = RELEASES.getStore();
	if (releases && !releases.some((release) => release.releaseId === releaseId)) releases.push({ releaseId, reads });
}

interface Step {
	readonly j: number;
	readonly call: string;
	readonly tool: string;
	readonly hashOnly: boolean;
	/** The arguments as far as `args` can store them. */
	readonly argumentsText: string;
	readonly argsBytes: number;
	/** Null for arguments the boundary could not read, as its envelope has it. */
	readonly argsHash: string | null;
	readonly text: string;
	readonly at: string;
	/** The envelope, once the call has its result. */
	result: string | null;
	/** The result's read references as stored, as far as CLOUD_RUN_LOG_READS_BYTES holds them; dropped once its line is
	 * final. */
	reads: readonly string[];
	readsCut: boolean;
	releases: readonly string[];
	/** As committed: not yet, pending (no result), or final. An erased line is final. */
	state: "new" | "pending" | "final";
	erased: boolean;
	block: number | null;
	/** `args` and `text` as its committed line stores them. */
	stored: Stored | null;
}

interface Stored {
	readonly args: string;
	readonly text: string;
}

interface Line {
	readonly j: number;
	readonly text: string;
	readonly pending: boolean;
	/** Its `args` and `text`, where the line has them as strings. */
	readonly stored?: Stored;
}

interface Block {
	readonly first: number;
	version: string | null;
	lines: Line[];
	/** Read again before the next batch uses it. */
	stale: boolean;
}

/** Bytes a string takes as stored in a JSON line, quotes included. */
function stored(value: string): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/** The longest prefix of `value`, cut at a code point, that takes at most `bytes` as stored. */
function clip(value: string, bytes: number): string {
	if (stored(value) <= bytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (stored(value.slice(0, middle)) <= bytes) low = middle;
		else high = middle - 1;
	}
	const code = value.charCodeAt(low - 1);
	return value.slice(0, code >= 0xd800 && code <= 0xdbff ? low - 1 : low);
}

function blockName(first: number): string {
	return `${String(first).padStart(8, "0")}.jsonl`;
}

/** The tier folder of a tree block's path under the log's folder, `t<n>`. */
function tierOf(path: string): string {
	return path.split("/")[0]!;
}

function lineBytes(line: Line): number {
	return line.pending ? CLOUD_RUN_LOG_STEP_BYTES : Buffer.byteLength(line.text) + 1;
}

function blockText(lines: readonly Line[]): string {
	return lines.map((line) => `${line.text}\n`).join("");
}

/** A committed block's lines, as the file has them. A line this run cannot read is kept as it is. */
function parseBlock(text: string): Line[] {
	const lines: Line[] = [];
	for (const raw of text.split("\n")) {
		if (!raw) continue;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new Error("Invalid run log block");
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid run log block");
		const record = value as Record<string, unknown>;
		if (!Number.isSafeInteger(record.j) || (record.j as number) < 0) throw new Error("Invalid run log block");
		lines.push({
			j: record.j as number,
			text: raw,
			pending: record.erased !== true && record.result === null,
			...(typeof record.args === "string" && typeof record.text === "string"
				? { stored: { args: record.args, text: record.text } }
				: {}),
		});
	}
	return lines;
}

function erasedLine(text: string): boolean {
	try {
		return (JSON.parse(text) as Record<string, unknown>).erased === true;
	} catch {
		return false;
	}
}

/** An erased step as the run's step lines see it (§10.1): its number, call id and tool only. */
function erasedStep(step: Pick<CloudRunLogStep, "j" | "call" | "tool" | "hashOnly">): CloudRunLogStep {
	return Object.freeze({ ...step, args: "", result: null, text: "", at: "", erased: true as const });
}

/** A step of an earlier process of the run, as its line stores it. */
function loggedStep(line: Line): CloudRunLogStep {
	const record = JSON.parse(line.text) as Record<string, unknown>;
	if (typeof record.tool !== "string" || typeof record.call !== "string") throw new Error("Invalid run log block");
	const hashOnly = HASH_ONLY_TOOLS.has(record.tool) || record.narrow === true;
	const step = { j: line.j, call: record.call, tool: record.tool, hashOnly };
	if (record.erased === true) return erasedStep(step);
	const result = record.result;
	return Object.freeze({
		...step,
		args: line.stored?.args ?? "",
		result: result && typeof result === "object" && !Array.isArray(result) ? JSON.stringify(result) : null,
		text: line.stored?.text ?? "",
		at: typeof record.at === "string" ? record.at : "",
	});
}

export class CloudRunLog {
	readonly #runId: string;
	readonly #conversationId: string;
	readonly #parent?: { readonly runId: string; readonly step: number };
	readonly #folder: CloudRunLogFolder;
	readonly #effectful: (tool: Pick<CloudNativeTool, "name" | "source">, parsed: JsonValue) => boolean;
	readonly #signal: AbortSignal;
	readonly #now: () => Date;
	readonly #commitMs: number;
	readonly #nonce = randomBytes(4).toString("hex");
	readonly #steps: Step[] = [];
	readonly #first: number;
	readonly #blocks = new Map<number, Block>();
	readonly #listeners = new Set<(batch: CloudRunLogCommitted) => void>();
	/** Pre-commits waiting for the steps before theirs. */
	readonly #waiters = new Set<() => void>();
	#place: CloudRunLogPlace | null = null;
	/** The log's folder as it was last found to exist, for the run's tree. */
	#root: string | null = null;
	/** The tree's tier folders known to exist. */
	readonly #tiers = new Set<string>();
	#earlier: readonly CloudRunLogStep[] | null = null;
	#generation = 0;
	#commits = 0;
	#text = "";
	#gone = false;
	#closed = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#queue: Promise<void> = Promise.resolve();

	constructor(options: {
		runId: string;
		/** The session the run answers in: its tree root holds the log. */
		conversationId: string;
		/** The dispatching step of a worker's run. */
		parent?: { runId: string; step: number };
		folder: CloudRunLogFolder;
		/** The run's own signal: timed batches stop with it. */
		signal: AbortSignal;
		/** The run's classification of its calls: `cloudActionEffect` with its connectors' effects. */
		effectful?: (tool: Pick<CloudNativeTool, "name" | "source">, parsed: JsonValue) => boolean;
		/** The first step of this run's log: 0, or where a resumed run continues. */
		firstStep?: number;
		now?: () => Date;
		commitMs?: number;
	}) {
		if (
			!isUuid(options.runId) ||
			!isUuid(options.conversationId) ||
			(options.parent &&
				(!isUuid(options.parent.runId) || !Number.isSafeInteger(options.parent.step) || options.parent.step < 0)) ||
			(options.firstStep !== undefined && (!Number.isSafeInteger(options.firstStep) || options.firstStep < 0))
		)
			throw new Error("Invalid run log");
		this.#runId = options.runId;
		this.#conversationId = options.conversationId;
		this.#parent = options.parent ? { ...options.parent } : undefined;
		this.#folder = options.folder;
		this.#effectful = options.effectful ?? ((tool, parsed) => cloudActionEffect(tool, parsed) !== "read");
		this.#signal = options.signal;
		this.#now = options.now ?? (() => new Date());
		this.#commitMs = options.commitMs ?? CLOUD_RUN_LOG_COMMIT_MS;
		this.#first = options.firstStep ?? 0;
	}

	get runId(): string {
		return this.#runId;
	}

	/** True once the log's folder was deleted: no effectful call of the run may run. */
	get gone(): boolean {
		return this.#gone;
	}

	/** The run's generation as the log was last found, by a step batch, `earlier` or a tree read or commit. Step-line
	 * batches check it (`runGenerations`). */
	generation(): number {
		return this.#generation;
	}

	effectful(tool: Pick<CloudNativeTool, "name" | "source">, parsed: JsonValue): boolean {
		return this.#effectful(tool, parsed);
	}

	/** The agent's own words as they stream; the next step keeps those since the step before. Never reasoning. */
	agentText(delta: string): void {
		if (this.#closed || typeof delta !== "string") return;
		// Nothing past what `text` can store is kept: a code unit is at least one byte as stored.
		if (this.#text.length < CLOUD_RUN_LOG_FIELD_BYTES)
			this.#text = (this.#text + delta).slice(0, CLOUD_RUN_LOG_FIELD_BYTES);
	}

	/** Starts a step for a call the model sees, in the order the calls came, and returns its number. `argumentSha256` is
	 * null for arguments the boundary could not read. */
	step(call: { call: string; tool: string; argumentsText: string; argumentSha256: string | null }): number {
		if (this.#closed) throw new Error("Run log closed");
		if (call.argumentSha256 !== null && !SHA256_HEX_PATTERN.test(call.argumentSha256))
			throw new Error("Invalid run log step");
		const text = this.#text;
		this.#text = "";
		const j = this.#first + this.#steps.length;
		this.#steps.push({
			j,
			call: call.call,
			tool: call.tool,
			hashOnly: HASH_ONLY_TOOLS.has(call.tool),
			argumentsText: clip(call.argumentsText, CLOUD_RUN_LOG_FIELD_BYTES),
			argsBytes: Buffer.byteLength(call.argumentsText),
			argsHash: call.argumentSha256,
			text,
			at: this.#now()
				.toISOString()
				.replace(/\.\d{3}Z$/, "Z"),
			result: null,
			reads: [],
			readsCut: false,
			releases: [],
			state: "new",
			erased: false,
			block: null,
			stored: null,
		});
		return j;
	}

	/** Commits every step up to `j`, with `j` pending, before its effectful call runs. A step before it that has neither
	 * its result nor a committed line (a call still in its release check) is waited for. Throws when that cannot land:
	 * the call must not run. */
	async precommit(j: number, signal: AbortSignal): Promise<void> {
		const step = this.#step(j);
		if (step.result !== null || step.state !== "new") throw new Error("Invalid run log precommit");
		while (!this.#gone && this.#waiting(j)) await this.#wait(signal);
		if (this.#gone) throw new CloudRunLogGone();
		await this.#enqueue(signal, j);
		if (this.#step(j).state === "new") throw new CloudRunLogUnavailable("not_committed");
	}

	/** The call's result, the envelope the model got, and the releases it made. */
	finish(j: number, envelope: string, releases: readonly CloudRunLogRelease[]): void {
		const step = this.#step(j);
		if (step.result !== null) throw new Error("Run log step already finished");
		// Only what its line stores is kept: a search can record many thousands of reads.
		const reads: string[] = [];
		let bytes = 2;
		for (const read of releases.flatMap((release) => release.reads)) {
			const entry = JSON.stringify({ path: read.path, version: read.version });
			bytes += Buffer.byteLength(entry) + (reads.length ? 1 : 0);
			if (bytes > CLOUD_RUN_LOG_READS_BYTES) {
				step.readsCut = true;
				break;
			}
			reads.push(entry);
		}
		step.result = envelope;
		// A line marked erased while its call ran is never filled in.
		step.reads = step.state === "final" ? [] : reads;
		step.releases = releases.map((release) => release.releaseId);
		this.#wake();
		if (this.#closed) return;
		const waiting = this.#steps.filter((candidate) => candidate.result !== null && candidate.state !== "final");
		if (waiting.length >= CLOUD_RUN_LOG_COMMIT_STEPS) void this.#background();
		else if (!this.#timer) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				void this.#background();
			}, this.#commitMs);
			this.#timer.unref?.();
		}
	}

	/** Commits every finished step now. */
	async flush(signal: AbortSignal): Promise<void> {
		await this.#enqueue(signal);
	}

	/** At run end: no more steps, and every finished step is committed. */
	async close(signal: AbortSignal): Promise<void> {
		this.#closed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#enqueue(signal);
	}

	/** This process's steps as committed, in step order, as their lines store them. */
	steps(): readonly CloudRunLogStep[] {
		return this.#steps
			.filter((step) => step.state !== "new")
			.map((step) => {
				const base = { j: step.j, call: step.call, tool: step.tool, hashOnly: step.hashOnly };
				if (step.erased) return erasedStep(base);
				return Object.freeze({
					...base,
					args: step.stored?.args ?? (step.hashOnly ? "" : step.argumentsText),
					result: step.state === "pending" ? null : step.result,
					text: step.stored?.text ?? clip(step.text, CLOUD_RUN_LOG_FIELD_BYTES),
					at: step.at,
				});
			});
	}

	/**
	 * The steps before this run's first step, in step order, as the log holds them: a resumed run's earlier work, for
	 * its work message and the step lines whose windows reach back before its first step (§7.5). An erased step is kept
	 * as its line is. A step its earlier process left pending has the result its line has: the one the resume filled
	 * in (W5), or none. [] for a run that starts at step 0. Throws CloudRunLogUnavailable when the log does not hold
	 * them all.
	 */
	async earlier(signal: AbortSignal): Promise<readonly CloudRunLogStep[]> {
		if (this.#first === 0) return [];
		if (this.#earlier) return this.#earlier;
		// No erase changes a live run's log (§4.5), so they are read once.
		for (let attempt = 1; ; attempt++) {
			if (this.#gone) throw new CloudRunLogGone();
			const place = await this.#locate(signal);
			if (!place.exists) throw new CloudRunLogUnavailable("no_log");
			const steps: CloudRunLogStep[] = [];
			// Each block is named by the step after the last one in the block before it.
			while (steps.length < this.#first) {
				const file = await this.#folder.read(`${place.path}/log/${blockName(steps.length)}`, signal);
				if (!file) break;
				const lines = parseBlock(file.text);
				if (!lines.length) throw new Error("Invalid run log block");
				for (const line of lines) {
					if (line.j !== steps.length) throw new Error("Invalid run log block");
					if (line.j === this.#first) break;
					steps.push(loggedStep(line));
				}
			}
			if (steps.length === this.#first) {
				this.#earlier = Object.freeze(steps);
				return this.#earlier;
			}
			// A block is missing: the log moved while it was read, or it does not hold every step before this run's.
			if (attempt >= ATTEMPTS) throw new CloudRunLogUnavailable("log_short");
		}
	}

	/**
	 * A block of the run's tree (§7.5), by its path under the log's folder (`memoryBlockPath`): its committed text and
	 * version, or null when there is none. Throws CloudRunLogGone once the log is gone, and CloudRunLogUnavailable
	 * ("no_log") before its first batch has landed. A read at a place the log has just left finds nothing; the commit
	 * built on it is refused as moved and then as `stale`, so the writer reads again at the new place.
	 */
	async treeRead(
		path: string,
		signal: AbortSignal,
	): Promise<{ readonly version: string; readonly text: string } | null> {
		if (typeof path !== "string" || !TREE_PATH.test(path)) throw new Error("Invalid run tree path");
		const file = await this.#folder.read(`${await this.#treeRoot(signal)}/${path}`, signal);
		if (file) this.#tiers.add(tierOf(path));
		return file;
	}

	/**
	 * Commits blocks of the run's tree (§7.5) as a change set, with the run's generation as the batch read it, and
	 * makes the tier folders they need. Each block lands or not on its own (core §3: a unit applies whole or not at
	 * all), so a batch that did not land whole may still have landed some of its blocks: before a caller builds the
	 * batch again, it reads every block of it again. "stale" when the generation moved or a step erase is open (that
	 * change set landed nothing), or when a block is not at the version it was read at (that block was refused, and
	 * the others may have landed). "gone" once the log is gone. A moved log is found again and the blocks that did not
	 * land are tried again, under `<operationKey>:2` to `:4`, so a batch's key never ends in one of those. Any other
	 * refusal throws CloudRunLogUnavailable, and a failed call throws as it failed.
	 */
	async commitTree(
		operationKey: string,
		blocks: readonly CloudRunTreeBlock[],
		generation: number,
		signal: AbortSignal,
	): Promise<"landed" | "stale" | "gone"> {
		if (
			typeof operationKey !== "string" ||
			!TREE_KEY.test(operationKey) ||
			!Number.isSafeInteger(generation) ||
			generation < 0 ||
			!Array.isArray(blocks) ||
			blocks.length < 1 ||
			blocks.length > CHANGE_SET_FILES ||
			blocks.some(
				(block) =>
					typeof block.path !== "string" ||
					!TREE_PATH.test(block.path) ||
					typeof block.text !== "string" ||
					(block.version !== null && typeof block.version !== "string"),
			) ||
			new Set(blocks.map((block) => block.path)).size !== blocks.length ||
			blocks.reduce((total, block) => total + Buffer.byteLength(block.text), 0) > CHANGE_SET_BYTES
		)
			throw new Error("Invalid run tree batch");
		// A block read at a version is in a tier folder that exists.
		for (const block of blocks) if (block.version !== null) this.#tiers.add(tierOf(block.path));
		let left = [...blocks];
		let root: string;
		try {
			root = await this.#treeRoot(signal);
		} catch (error) {
			if (error instanceof CloudRunLogGone) return "gone";
			throw error;
		}
		for (let attempt = 1; ; attempt++) {
			const tiers = [...new Set(left.map((block) => tierOf(block.path)))].filter((tier) => !this.#tiers.has(tier));
			const units: Extract<CloudCompanyFolderUnit, { op: "mkdir" | "write" }>[] = [
				...tiers.sort().map((tier) => ({ op: "mkdir" as const, path: `${root}/${tier}` })),
				...left.map((block) => ({
					op: "write" as const,
					path: `${root}/${block.path}`,
					content: { text: block.text, mediaType: "application/jsonl" },
					...(block.version !== null ? { expectedVersion: block.version } : {}),
				})),
			];
			const result = await this.#folder.commit(
				attempt === 1 ? operationKey : `${operationKey}:${attempt}`,
				units,
				{ runLog: { run: this.#runId, path: root }, runGenerations: [{ runId: this.#runId, generation }] },
				signal,
			);
			const landed = new Set<string>();
			let gone = false;
			let stale = false;
			let relocate: string | null = null;
			let refused: string | null = null;
			result.units.forEach((outcome, index) => {
				const unit = units[index]!;
				const tier = tierOf(unit.path.slice(root.length + 1));
				if (outcome.outcome === "saved") {
					if (unit.op === "mkdir") this.#tiers.add(tier);
					else landed.add(unit.path);
					return;
				}
				const reason = outcome.reason ?? outcome.outcome;
				if (reason === "memory_run_log_gone") gone = true;
				else if (reason === "memory_generation_stale" || reason === "memory_erase_open") stale = true;
				else if (reason === "memory_run_log_moved") relocate ??= reason;
				else if (reason === "parent_missing") {
					// The log moved, or a tier folder this run took to exist does not.
					this.#tiers.delete(tier);
					relocate ??= reason;
				} else if (outcome.outcome === "conflict") {
					// A tier folder another batch made, or a block another writer changed.
					if (unit.op === "mkdir") this.#tiers.add(tier);
					else stale = true;
				} else refused ??= reason;
			});
			if (gone) {
				this.#gone = true;
				this.#wake();
				return "gone";
			}
			if (stale) return "stale";
			if (refused !== null) throw new CloudRunLogUnavailable(refused);
			left = left.filter((block) => !landed.has(`${root}/${block.path}`));
			if (!left.length) return "landed";
			if (attempt >= ATTEMPTS) throw new CloudRunLogUnavailable(relocate ?? "not_landed");
			if (relocate !== null) {
				try {
					root = await this.#treeRoot(signal, true);
				} catch (error) {
					if (error instanceof CloudRunLogGone) return "gone";
					throw error;
				}
			}
		}
	}

	/** Called after each change set that made steps final. */
	onCommitted(listener: (batch: CloudRunLogCommitted) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#step(j: number): Step {
		const step = this.#steps[j - this.#first];
		if (!step) throw new Error("Unknown run log step");
		return step;
	}

	/** Whether a step before `j` is still in its call and not committed: a pre-commit of `j` waits for it, as a batch
	 * appends steps only in order. */
	#waiting(j: number): boolean {
		for (let index = j - this.#first - 1; index >= 0; index--) {
			const step = this.#steps[index]!;
			if (step.result === null && step.state === "new") return true;
		}
		return false;
	}

	#wake(): void {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const wake of waiters) wake();
	}

	/** Resolves once a step finishes or a change set lands; rejects when `signal` stops first. */
	#wait(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const abort = (): void => {
				this.#waiters.delete(wake);
				reject(signal.reason);
			};
			const wake = (): void => {
				signal.removeEventListener("abort", abort);
				resolve();
			};
			this.#waiters.add(wake);
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	async #background(): Promise<void> {
		if (this.#signal.aborted) return;
		try {
			await this.#enqueue(this.#signal);
		} catch {
			// The next batch tries again; a gone log is remembered.
		}
	}

	#enqueue(signal: AbortSignal, precommit?: number): Promise<void> {
		const run = this.#queue.then(() => this.#batches(signal, precommit));
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #batches(signal: AbortSignal, precommit?: number): Promise<void> {
		for (;;) {
			signal.throwIfAborted();
			if (this.#gone) throw new CloudRunLogGone();
			if (!this.#ready(precommit).length && !this.#fills().length) return;
			await this.#batch(signal, precommit);
		}
	}

	/** New steps the next batch may append, in step order: finished ones, and the step being committed first. */
	#ready(precommit?: number): Step[] {
		const ready: Step[] = [];
		for (const step of this.#steps) {
			if (step.state !== "new") continue;
			if (step.result === null && step.j !== precommit) break;
			ready.push(step);
			if (ready.length === CLOUD_RUN_LOG_COMMIT_STEPS) break;
		}
		return ready;
	}

	/** This run's pending steps whose results are in. */
	#fills(): Step[] {
		return this.#steps.filter((step) => step.state === "pending" && step.result !== null);
	}

	async #batch(signal: AbortSignal, precommit?: number): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			await this.#refresh(signal);
			const outcome = await this.#attempt(signal, precommit);
			if (outcome === "done") return;
			if (attempt >= ATTEMPTS) throw new CloudRunLogUnavailable(outcome);
		}
	}

	/** Finds the log by its run id. A gone log is remembered. */
	async #locate(signal: AbortSignal): Promise<CloudRunLogPlace> {
		let place: CloudRunLogPlace;
		try {
			place = await this.#folder.locate(this.#runId, signal);
		} catch (error) {
			if (error instanceof CloudRunLogGone) {
				this.#gone = true;
				this.#wake();
			}
			throw error;
		}
		if (place.exists) this.#root = place.path;
		this.#generation = place.generation;
		return place;
	}

	/** The log's folder for the run's tree: where it was last found, or found again. */
	async #treeRoot(signal: AbortSignal, again = false): Promise<string> {
		if (this.#gone) throw new CloudRunLogGone();
		if (again || this.#root === null) {
			const place = await this.#locate(signal);
			if (!place.exists) throw new CloudRunLogUnavailable("no_log");
		}
		return this.#root!;
	}

	/** Finds the log, and reads again what a failed batch left uncertain. */
	async #refresh(signal: AbortSignal): Promise<void> {
		if (!this.#place) {
			const place = await this.#locate(signal);
			this.#place = place;
			if (place.exists && place.last !== null && !this.#blocks.has(place.last))
				this.#blocks.set(place.last, { first: place.last, version: null, lines: [], stale: true });
		}
		for (const block of [...this.#blocks.values()]) {
			if (!block.stale) continue;
			const file = await this.#folder.read(this.#blockPath(block.first), signal);
			for (const line of block.lines) {
				const step = this.#steps[line.j - this.#first];
				if (step && step.block === block.first) {
					step.state = "new";
					step.block = null;
				}
			}
			if (!file) {
				this.#blocks.delete(block.first);
				continue;
			}
			block.version = file.version;
			block.lines = parseBlock(file.text);
			block.stale = false;
			for (const line of block.lines) {
				const step = this.#steps[line.j - this.#first];
				if (!step || step.j !== line.j) continue;
				step.block = block.first;
				step.erased = erasedLine(line.text);
				step.state = step.erased || !line.pending ? "final" : "pending";
				step.stored = line.stored ?? null;
				if (step.state === "final") step.reads = [];
			}
		}
	}

	#blockPath(first: number): string {
		return `${this.#place!.path}/log/${blockName(first)}`;
	}

	/** A step's line as stored, fitted so it never passes CLOUD_RUN_LOG_STEP_BYTES with its newline. */
	#line(step: Step, pending: boolean): Line {
		let reads = CLOUD_RUN_LOG_READS_BYTES;
		let text = CLOUD_RUN_LOG_FIELD_BYTES;
		let args = CLOUD_RUN_LOG_FIELD_BYTES;
		for (;;) {
			const stored = { args: step.hashOnly ? "" : clip(step.argumentsText, args), text: clip(step.text, text) };
			const line = this.#render(step, pending, reads, stored);
			const over = Buffer.byteLength(line) + 1 - CLOUD_RUN_LOG_STEP_BYTES;
			// Only a result with very many release parts gets past it: the copies give way, never the release ids.
			if (over > 0 && reads > 2) reads = Math.max(2, reads - over);
			else if (over > 0 && text > 2) text = Math.max(2, text - over);
			else if (over > 0 && args > 2) args = Math.max(2, args - over);
			else return { j: step.j, text: line, pending, stored };
		}
	}

	#render(step: Step, pending: boolean, budget: number, stored: Stored): string {
		const reads: string[] = [];
		let readBytes = 2;
		// Reads past CLOUD_RUN_LOG_READS_BYTES were not kept: the copy is cut short either way.
		let cut = !pending && step.readsCut;
		for (const entry of pending ? [] : step.reads) {
			const bytes = Buffer.byteLength(entry) + (reads.length ? 1 : 0);
			if (readBytes + bytes > budget) {
				cut = true;
				break;
			}
			reads.push(entry);
			readBytes += bytes;
		}
		return `{${[
			`"j":${step.j}`,
			`"tool":${JSON.stringify(step.tool)}`,
			`"call":${JSON.stringify(step.call)}`,
			`"args":${JSON.stringify(stored.args)}`,
			`"args_bytes":${step.argsBytes}`,
			`"args_hash":${JSON.stringify(step.argsHash)}`,
			// The envelope is JSON with no line breaks, kept as a JSON value exactly as the fence issued it.
			`"result":${pending ? "null" : step.result}`,
			`"reads":[${reads.join(",")}]`,
			...(cut ? [`"reads_cut":true`] : []),
			`"releases":${JSON.stringify(pending ? [] : step.releases)}`,
			`"text":${JSON.stringify(stored.text)}`,
			`"at":${JSON.stringify(step.at)}`,
		].join(",")}}`;
	}

	#runToml(): string {
		return [
			"format = 1",
			`run = "${this.#runId}"`,
			`conversation = "${this.#conversationId}"`,
			...(this.#parent ? [`parent = "${this.#parent.runId}"`, `step = ${this.#parent.step}`] : []),
			"",
		].join("\n");
	}

	/** One batch: lays out its blocks, commits them as change sets in step order, and records what landed. Returns
	 * "done", or why it must be read again and done again. */
	async #attempt(signal: AbortSignal, precommit?: number): Promise<"done" | string> {
		const place = this.#place!;
		const ready = this.#ready(precommit);
		const fills = this.#fills();
		// Each touched block's new lines, starting from the lines the file has.
		const touched = new Map<number, Line[]>();
		const lines = (first: number): Line[] => {
			let next = touched.get(first);
			if (!next) {
				next = [...(this.#blocks.get(first)?.lines ?? [])];
				touched.set(first, next);
			}
			return next;
		};
		const placed = new Map<number, number>();
		for (const step of fills) {
			const read = touched.get(step.block!) ?? this.#blocks.get(step.block!)?.lines ?? [];
			const index = read.findIndex((line) => line.j === step.j);
			if (index < 0) {
				// No longer in its block as read: appended again by the next batch.
				step.state = "new";
				step.block = null;
				continue;
			}
			// A line marked erased is never filled in: that result is dropped.
			if (erasedLine(read[index]!.text) || !read[index]!.pending) {
				step.erased = erasedLine(read[index]!.text);
				step.state = "final";
				step.reads = [];
				continue;
			}
			lines(step.block!)[index] = this.#line(step, false);
			placed.set(step.j, step.block!);
		}
		let last = Math.max(-1, ...this.#blocks.keys(), ...touched.keys());
		for (const step of ready) {
			const line = this.#line(step, step.result === null);
			// A new step joins the last block only if the block, a pending step counted at its full size, still fits.
			const block = last >= 0 ? (touched.get(last) ?? this.#blocks.get(last)?.lines) : undefined;
			const counted = block?.reduce((total, current) => total + lineBytes(current), 0) ?? 0;
			if (
				!block ||
				block.length >= CLOUD_RUN_LOG_BLOCK_STEPS ||
				counted + lineBytes(line) > CLOUD_RUN_LOG_BLOCK_BYTES ||
				block.some((current) => current.j >= step.j)
			) {
				last = step.j;
				const fresh = lines(last);
				if (fresh.some((current) => current.j === step.j)) throw new CloudRunLogUnavailable("block_mismatch");
				fresh.push(line);
			} else lines(last).push(line);
			placed.set(step.j, last);
		}
		if (!touched.size) return "done";

		// Change sets in step order, each within core §5's bounds. The first batch makes the log's folder, then writes
		// its blocks into it: units apply in order, so each finds its parent.
		// Each unit's block, null for a folder.
		const sets: { units: CloudCompanyFolderUnit[]; blocks: (number | null)[]; bytes: number; files: number }[] = [];
		const into = (bytes: number): (typeof sets)[number] => {
			const last = sets.at(-1);
			if (last && last.bytes + bytes <= CHANGE_SET_BYTES && last.files + 1 <= CHANGE_SET_FILES) {
				last.bytes += bytes;
				last.files += 1;
				return last;
			}
			const next: (typeof sets)[number] = { units: [], blocks: [], bytes, files: 1 };
			sets.push(next);
			return next;
		};
		if (!place.exists) {
			const toml = this.#runToml();
			const set = into(Buffer.byteLength(toml));
			for (const folder of place.missing) {
				set.units.push({ op: "mkdir", path: folder });
				set.blocks.push(null);
			}
			set.units.push({
				op: "new_folder",
				path: place.path,
				contents: [
					{ path: "run.toml", kind: "file", content: { text: toml, mediaType: "application/toml" } },
					{ path: "log", kind: "folder" },
				],
			});
			set.blocks.push(null);
		}
		for (const first of [...touched.keys()].sort((a, b) => a - b)) {
			const text = blockText(touched.get(first)!);
			const set = into(Buffer.byteLength(text));
			const known = this.#blocks.get(first);
			set.units.push({
				op: "write",
				path: this.#blockPath(first),
				content: { text, mediaType: "application/jsonl" },
				...(known?.version ? { expectedVersion: known.version } : {}),
			});
			set.blocks.push(first);
		}

		for (const set of sets) {
			const key = `runlog:${this.#runId}:${this.#nonce}:${++this.#commits}`;
			let result: CloudCompanyFolderCommitResult;
			try {
				result = await this.#folder.commit(
					key,
					set.units,
					{ runLog: { run: this.#runId, path: place.path } },
					signal,
				);
			} catch (error) {
				// The outcome is unknown: find the log and read its blocks again before the next batch. A batch that
				// landed is then found in the file and not written twice.
				if (set.units.some((unit) => unit.op !== "write")) this.#place = null;
				for (const first of set.blocks) if (first !== null) this.#stale(first);
				throw error;
			}
			const saved: { path: string; version: string }[] = [];
			const final: number[] = [];
			let relocate: string | null = null;
			let conflict: string | null = null;
			let refused: string | null = null;
			result.units.forEach((unit, index) => {
				const first = set.blocks[index];
				if (unit.outcome !== "saved") {
					const reason = unit.reason ?? unit.outcome;
					if (reason === "memory_run_log_gone") this.#gone = true;
					else if (
						reason === "memory_run_log_moved" ||
						reason === "parent_missing" ||
						(first === null && unit.outcome === "conflict")
					)
						relocate ??= reason;
					else if (first !== null && first !== undefined && unit.outcome === "conflict") {
						conflict ??= reason;
						this.#stale(first);
					} else refused ??= reason;
					return;
				}
				if (unit.op === "new_folder") {
					this.#place = { ...place, exists: true, missing: [] };
					this.#root = place.path;
				}
				if (first === null || first === undefined || !unit.version) return;
				const next = touched.get(first)!;
				this.#blocks.set(first, { first, version: unit.version, lines: next, stale: false });
				saved.push({ path: this.#blockPath(first), version: unit.version });
				for (const line of next) {
					const step = this.#steps[line.j - this.#first];
					if (!step || step.j !== line.j) continue;
					if (placed.get(line.j) === first || step.block === first) {
						step.block = first;
						step.erased = erasedLine(line.text);
						step.state = step.erased || !line.pending ? "final" : "pending";
						step.stored = line.stored ?? null;
						// Its line is stored: the copy of its reads is no longer needed.
						if (step.state === "final") step.reads = [];
						if (placed.get(line.j) === first && !line.pending) final.push(line.j);
					}
				}
			});
			this.#prune();
			this.#wake();
			if (final.length) {
				const batch: CloudRunLogCommitted = Object.freeze({
					runId: this.#runId,
					steps: Object.freeze(final.sort((a, b) => a - b)),
					blocks: Object.freeze(saved),
					generation: this.#generation,
				});
				for (const listener of this.#listeners) {
					try {
						listener(batch);
					} catch {
						// A listener's failure is its own.
					}
				}
			}
			if (this.#gone) throw new CloudRunLogGone();
			if (refused !== null) throw new CloudRunLogUnavailable(refused);
			if (relocate !== null) {
				// Only the blocks the run can still write are read again at the new place.
				this.#place = null;
				for (const first of this.#blocks.keys()) this.#stale(first);
				return relocate;
			}
			if (conflict !== null) return conflict;
		}
		return "done";
	}

	/** Forgets the lines of every block the run never writes again: all but the last block and the blocks that hold a
	 * pending step of this run. Within a run nothing erases its own log (§10.1), so they are only appended to or filled
	 * in. */
	#prune(): void {
		const last = Math.max(...this.#blocks.keys());
		const pending = new Set<number | null>();
		for (const step of this.#steps) if (step.state === "pending") pending.add(step.block);
		for (const first of [...this.#blocks.keys()]) {
			if (first !== last && !pending.has(first)) this.#blocks.delete(first);
		}
	}

	#stale(first: number): void {
		const block = this.#blocks.get(first);
		if (block) block.stale = true;
		else this.#blocks.set(first, { first, version: null, lines: [], stale: true });
	}
}
