import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { cloudActionEffect } from "./cloud-action-review.ts";
import type {
	CloudCompanyFolderCommitResult,
	CloudCompanyFolderRelease,
	CloudCompanyFolderUnit,
} from "./cloud-company-folder-client.ts";
import type { CloudNativeTool } from "./cloud-native-tool-boundary.ts";

/**
 * A run's work log (RUNTIME-AGENT-MEMORY-TREE.md §4.5, W1). Every tool call of a run is one step record, one JSON line,
 * in blocks `<tree root>/runs/<run>/log/<first step>.jsonl` under the tree root of the conversation the run answers.
 * The log is the only copy of the run's work: context views keep digests only. Only the platform writes it.
 *
 * - Steps are committed in batches every STEP_COMMIT (16 steps or 30 seconds) and at run end. A batch only appends,
 *   and fills in the results of this run's own pending steps. It keeps every other line as the file has it, so it never
 *   brings back an erased step, and it never fills in a line marked erased.
 * - An effectful call (anything `cloudActionEffect` does not class as a read) is committed before it runs, as a step with
 *   no result yet. The call runs only once that commit has landed.
 * - A send, a card or a `send_mail` keeps its arguments as a hash only. So does every step that names or reads a folder
 *   not shared with every agent, and every step of the run after the first such step (contract amendment of
 *   2026-10-06, item 6). The run itself still sees those steps in full: this log stores nowhere else.
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

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

/** The folder as a run log uses it. W1c-2 builds it on the folder client and the run-log index. */
export interface CloudRunLogFolder {
	/** Throws CloudRunLogGone when the log's index row, or for a new log its conversation owner's row, is retired or
	 * missing. */
	locate(runId: string, signal: AbortSignal): Promise<CloudRunLogPlace>;
	/** A file's committed text and version, or null when there is none. */
	read(path: string, signal: AbortSignal): Promise<{ readonly version: string; readonly text: string } | null>;
	/** Stages and commits one change set through the folder memory commit, with the precondition
	 * `runLog: { run, path }`. A refusal is a unit outcome (`memory_run_log_gone`, `memory_run_log_moved`,
	 * `memory_erase_open`), with nothing applied. */
	commit(
		operationKey: string,
		units: readonly CloudCompanyFolderUnit[],
		runLog: { readonly run: string; readonly path: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult>;
}

/** A release a tool made while it ran: its id, and the reads it recorded. */
export interface CloudRunLogRelease {
	readonly releaseId: string;
	readonly reads: readonly CloudCompanyFolderRelease[];
}

/** What the restricted-folder rule looks at: the call's arguments, and once it has run, its result and reads. */
export interface CloudRunLogCall {
	readonly tool: string;
	readonly argumentsText: string;
	readonly result?: string;
	readonly reads: readonly CloudCompanyFolderRelease[];
}

/** One step as committed, for the run's step lines (W2). A hashes-only step has `args` "". A restricted step also has
 * `result` and `text` "": its line may name neither the path nor what it held. */
export interface CloudRunLogStep {
	readonly j: number;
	readonly call: string;
	readonly tool: string;
	readonly args: string;
	/** The result envelope, or null while the step is pending. */
	readonly result: string | null;
	readonly text: string;
	readonly hashOnly: boolean;
	readonly restricted: boolean;
	readonly at: string;
}

/** Steps [from, to) made final by one batch, and the blocks it saved. */
export interface CloudRunLogCommitted {
	readonly runId: string;
	readonly from: number;
	readonly to: number;
	readonly blocks: readonly { readonly path: string; readonly version: string }[];
}

const RELEASES = new AsyncLocalStorage<CloudRunLogRelease[]>();

/** Runs a tool call so that every release it makes is recorded for its step. */
export function cloudRunLogReleases<T>(releases: CloudRunLogRelease[], operation: () => T): T {
	return RELEASES.run(releases, operation);
}

/** Called by the folder client once a release is recorded. Outside a logged tool call it does nothing. */
export function recordCloudRunLogRelease(releaseId: string, reads: readonly CloudCompanyFolderRelease[]): void {
	const releases = RELEASES.getStore();
	if (releases && !releases.some((release) => release.releaseId === releaseId)) releases.push({ releaseId, reads });
}

interface Step {
	readonly j: number;
	readonly call: string;
	readonly tool: string;
	readonly hashOnly: boolean;
	restricted: boolean;
	readonly argumentsText: string;
	readonly argsBytes: number;
	readonly argsHash: string;
	readonly text: string;
	readonly at: string;
	/** The envelope, once the call has its result. */
	result: string | null;
	reads: readonly CloudCompanyFolderRelease[];
	releases: readonly string[];
	/** As committed: not yet, pending (no result), or final. An erased line is final. */
	state: "new" | "pending" | "final";
	erased: boolean;
	block: number | null;
}

interface Line {
	readonly j: number;
	readonly text: string;
	readonly pending: boolean;
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
function fit(value: string, bytes: number): string {
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

export class CloudRunLog {
	readonly #runId: string;
	readonly #conversationId: string;
	readonly #parent?: { readonly runId: string; readonly step: number };
	readonly #folder: CloudRunLogFolder;
	readonly #effectful: (tool: Pick<CloudNativeTool, "name" | "source">, parsed: JsonValue) => boolean;
	readonly #restrictedCall?: (call: CloudRunLogCall) => boolean;
	readonly #signal: AbortSignal;
	readonly #now: () => Date;
	readonly #commitMs: number;
	readonly #nonce = randomBytes(4).toString("hex");
	readonly #steps: Step[] = [];
	readonly #first: number;
	readonly #blocks = new Map<number, Block>();
	readonly #listeners = new Set<(batch: CloudRunLogCommitted) => void>();
	#place: CloudRunLogPlace | null = null;
	#generation = 0;
	#commits = 0;
	#text = "";
	#restricted: boolean;
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
		/** Whether a call names or reads a folder not shared with every agent. */
		restricted?: (call: CloudRunLogCall) => boolean;
		/** A worker dispatched after its parent's first restricted step keeps every step as hashes. */
		restrictedFromStart?: boolean;
		/** The first step of this run's log: 0, or where a resumed run continues. */
		firstStep?: number;
		now?: () => Date;
		commitMs?: number;
	}) {
		if (
			!UUID.test(options.runId) ||
			!UUID.test(options.conversationId) ||
			(options.parent &&
				(!UUID.test(options.parent.runId) ||
					!Number.isSafeInteger(options.parent.step) ||
					options.parent.step < 0)) ||
			(options.firstStep !== undefined && (!Number.isSafeInteger(options.firstStep) || options.firstStep < 0))
		)
			throw new Error("Invalid run log");
		this.#runId = options.runId;
		this.#conversationId = options.conversationId;
		this.#parent = options.parent ? { ...options.parent } : undefined;
		this.#folder = options.folder;
		this.#effectful = options.effectful ?? ((tool, parsed) => cloudActionEffect(tool, parsed) !== "read");
		this.#restrictedCall = options.restricted;
		this.#restricted = options.restrictedFromStart === true;
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

	/** Whether the run has had a restricted step: a worker it dispatches from now on keeps every step as hashes. */
	restricted(): boolean {
		return this.#restricted;
	}

	/** The run's generation as its log's last placement read it. Step-line batches check it (`runGenerations`). */
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

	/** Starts a step for a call, and returns its number. */
	step(call: { call: string; tool: string; argumentsText: string; argumentSha256: string }): number {
		if (this.#closed) throw new Error("Run log closed");
		if (!SHA.test(call.argumentSha256)) throw new Error("Invalid run log step");
		const text = this.#text;
		this.#text = "";
		const hashOnly = HASH_ONLY_TOOLS.has(call.tool);
		if (!this.#restricted && this.#restrictedCall?.({ tool: call.tool, argumentsText: call.argumentsText, reads: [] }))
			this.#restricted = true;
		const j = this.#first + this.#steps.length;
		this.#steps.push({
			j,
			call: call.call,
			tool: call.tool,
			hashOnly,
			restricted: this.#restricted,
			argumentsText: call.argumentsText,
			argsBytes: Buffer.byteLength(call.argumentsText),
			argsHash: call.argumentSha256,
			text,
			at: this.#now().toISOString().replace(/\.\d{3}Z$/, "Z"),
			result: null,
			reads: [],
			releases: [],
			state: "new",
			erased: false,
			block: null,
		});
		return j;
	}

	/** Commits every step up to `j`, with `j` pending, before its effectful call runs. Throws when that cannot land:
	 * the call must not run. */
	async precommit(j: number, signal: AbortSignal): Promise<void> {
		const step = this.#step(j);
		if (step.result !== null || step.state !== "new") throw new Error("Invalid run log precommit");
		if (this.#gone) throw new CloudRunLogGone();
		await this.#enqueue(signal, j);
		if (this.#step(j).state === "new") throw new CloudRunLogUnavailable("not_committed");
	}

	/** The call's result, as the fence issued it, and the releases it made. */
	finish(j: number, envelope: string, releases: readonly CloudRunLogRelease[]): void {
		const step = this.#step(j);
		if (step.result !== null) throw new Error("Run log step already finished");
		const reads = releases.flatMap((release) => release.reads);
		if (
			!step.restricted &&
			this.#restrictedCall?.({ tool: step.tool, argumentsText: step.argumentsText, result: envelope, reads })
		) {
			step.restricted = true;
			this.#restricted = true;
		}
		step.result = envelope;
		step.reads = reads;
		step.releases = releases.map((release) => release.releaseId);
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

	/** The steps as committed, in step order. */
	steps(): readonly CloudRunLogStep[] {
		return this.#steps
			.filter((step) => step.state !== "new" && !step.erased)
			.map((step) =>
				Object.freeze({
					j: step.j,
					call: step.call,
					tool: step.tool,
					args: step.hashOnly || step.restricted ? "" : fit(step.argumentsText, CLOUD_RUN_LOG_FIELD_BYTES),
					result: step.state === "pending" ? null : step.restricted ? "" : step.result,
					text: step.restricted ? "" : fit(step.text, CLOUD_RUN_LOG_FIELD_BYTES),
					hashOnly: step.hashOnly,
					restricted: step.restricted,
					at: step.at,
				}),
			);
	}

	/** Called after each batch that made steps final. */
	onCommitted(listener: (batch: CloudRunLogCommitted) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#step(j: number): Step {
		const step = this.#steps[j - this.#first];
		if (!step) throw new Error("Unknown run log step");
		return step;
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

	/** Finds the log, and reads again what a failed batch left uncertain. */
	async #refresh(signal: AbortSignal): Promise<void> {
		if (!this.#place) {
			let place: CloudRunLogPlace;
			try {
				place = await this.#folder.locate(this.#runId, signal);
			} catch (error) {
				if (error instanceof CloudRunLogGone) this.#gone = true;
				throw error;
			}
			this.#place = place;
			this.#generation = place.generation;
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
			}
		}
	}

	#blockPath(first: number): string {
		return `${this.#place!.path}/log/${blockName(first)}`;
	}

	/** A step's line as stored, fitted so it never passes CLOUD_RUN_LOG_STEP_BYTES with its newline. */
	#line(step: Step, pending: boolean): string {
		const hashes = step.hashOnly || step.restricted;
		let reads = CLOUD_RUN_LOG_READS_BYTES;
		let text = CLOUD_RUN_LOG_FIELD_BYTES;
		let args = CLOUD_RUN_LOG_FIELD_BYTES;
		for (;;) {
			const line = this.#render(step, pending, hashes, { reads, text, args });
			const over = Buffer.byteLength(line) + 1 - CLOUD_RUN_LOG_STEP_BYTES;
			if (over <= 0) return line;
			// Only a result with very many release parts gets here: the copies give way, never the release ids.
			if (reads > 2) reads = Math.max(2, reads - over);
			else if (text > 2) text = Math.max(2, text - over);
			else if (args > 2) args = Math.max(2, args - over);
			else return line;
		}
	}

	#render(
		step: Step,
		pending: boolean,
		hashes: boolean,
		budget: { reads: number; text: number; args: number },
	): string {
		const head = [
			`"j":${step.j}`,
			`"tool":${JSON.stringify(step.tool)}`,
			`"call":${JSON.stringify(step.call)}`,
			`"args":${JSON.stringify(hashes ? "" : fit(step.argumentsText, budget.args))}`,
			`"args_bytes":${step.argsBytes}`,
			`"args_hash":${JSON.stringify(step.argsHash)}`,
		];
		const at = `"at":${JSON.stringify(step.at)}`;
		const releases = `"releases":${JSON.stringify(pending ? [] : step.releases)}`;
		if (step.restricted) {
			// Its line names neither the path nor what it held: hashes of the result, and no reads or text.
			const result = pending
				? [`"result":null`]
				: [
						`"result_bytes":${Buffer.byteLength(step.result!)}`,
						`"result_hash":${JSON.stringify(createHash("sha256").update(step.result!).digest("hex"))}`,
					];
			return `{${[...head, ...result, releases, at, `"hashes":true`].join(",")}}`;
		}
		const reads: string[] = [];
		let readBytes = 2;
		let cut = false;
		for (const read of pending ? [] : step.reads) {
			const entry = JSON.stringify({ path: read.path, version: read.version });
			const bytes = Buffer.byteLength(entry) + (reads.length ? 1 : 0);
			if (readBytes + bytes > budget.reads) {
				cut = true;
				break;
			}
			reads.push(entry);
			readBytes += bytes;
		}
		return `{${[
			...head,
			// The envelope is JSON with no line breaks, kept as a JSON value exactly as the fence issued it.
			`"result":${pending ? "null" : step.result}`,
			`"reads":[${reads.join(",")}]`,
			...(cut ? [`"reads_cut":true`] : []),
			releases,
			`"text":${JSON.stringify(fit(step.text, budget.text))}`,
			at,
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
				continue;
			}
			lines(step.block!)[index] = { j: step.j, text: this.#line(step, false), pending: false };
			placed.set(step.j, step.block!);
		}
		let last = Math.max(-1, ...this.#blocks.keys(), ...touched.keys());
		for (const step of ready) {
			const pending = step.result === null;
			const line: Line = { j: step.j, text: this.#line(step, pending), pending };
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
				result = await this.#folder.commit(key, set.units, { run: this.#runId, path: place.path }, signal);
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
				if (unit.op === "new_folder") this.#place = { ...place, exists: true, missing: [] };
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
						if (placed.get(line.j) === first && !line.pending) final.push(line.j);
					}
				}
			});
			if (final.length) {
				const batch: CloudRunLogCommitted = Object.freeze({
					runId: this.#runId,
					from: Math.min(...final),
					to: Math.max(...final) + 1,
					blocks: Object.freeze(saved),
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
				this.#place = null;
				for (const first of this.#blocks.keys()) this.#stale(first);
				return relocate;
			}
			if (conflict !== null) return conflict;
		}
		return "done";
	}

	#stale(first: number): void {
		const block = this.#blocks.get(first);
		if (block) block.stale = true;
		else this.#blocks.set(first, { first, version: null, lines: [], stale: true });
	}
}
