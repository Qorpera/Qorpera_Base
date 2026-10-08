// A run's step lines (design RUNTIME-AGENT-MEMORY-TREE.md §7.5, W2c): the summary tree of its own log, built in the
// run's lane as its steps commit, stored beside the log in `runs/<run>/t<n>/`, and folded into the run's work message
// (§5.7). One writer serves one run in one process.
// - Each batch of steps the log commits starts a pass: it builds every line `[0, T)` is missing, leaves and the merges
//   above them (`memoryCompact`), and commits them through the log's `commitTree`. Passes run one at a time; a pass
//   asked for while one runs follows it.
// - A resumed run's earlier steps are this run's too: their missing lines are built like the others, and the windows
//   of its first steps reach back into them (`CloudRunLog.earlier`).
// - A node the compactor failed on, with its inputs at hand, stays missing for the rest of the run (§7.2): the next
//   run builds it. A stopped lane, an abort or an unreadable step is no failure.
// - Lines are derived, so they are stored only at the run's generation as the writer read it before its first step or
//   line (§4.3). Once a commit comes back `stale`, or the generation moved, the batch is discarded whole and nothing
//   more is stored in the run: what was built serves this run's own view, and the next run builds it again.
// - This process's narrow steps are in full in its own view, and no line over them is stored (§4.5). An earlier
//   process's narrow steps are their tool's name, as their records are, and are stored like the others.
// - A request whose fold needs lines not built yet waits up to SETTLE for them, then shows placeholders (§5.4, §5.7).
//   At run end, `finish` builds what is left within CLOSE (§7.1).

import type { CloudNativeContextComposition, CloudNativeContextRequest } from "../cloud-native-context-composition.ts";
import { type CloudRunLog, CloudRunLogGone, type CloudRunLogStep, type CloudRunTreeBlock } from "../cloud-run-log.ts";
import {
	type MemoryCompactCall,
	type MemoryCompactLane,
	type MemoryCompactStats,
	memoryCompact,
	memoryWindowStart,
} from "./compact.ts";
import { type MemoryTreeBuilt, memoryPartRow, memoryView } from "./fold.ts";
import { memoryRenderStep } from "./render.ts";
import { cloudRunWorkComposer } from "./run-work.ts";
import {
	CLOSE_MS,
	type MemoryTreeLine,
	memoryBlockPath,
	memoryBlockText,
	memoryLineProblem,
	SETTLE_MS,
} from "./tree.ts";

/** What a step committed with no result shows: its call may have run (§12). */
export const RUN_STEP_OUTCOME_UNKNOWN = "outcome unknown: check before you repeat it";

/** Core §5's change set, as the log's `commitTree` takes it. */
const CHANGE_SET_FILES = 64;
const CHANGE_SET_BYTES = 1024 * 1024;
/** A tier's block: levels 4t to 4t + 3, 16 + 8 + 4 + 2 lines at most (§4.2). */
const BLOCK_LINES = 30;
/** Times a pass reads its steps and blocks while the log is found anew under them. */
const READS = 3;

/** A step as the log gives it. `narrow` comes with W1c-3's narrow steps (§4.5). */
export type CloudRunStepLinesStep = CloudRunLogStep & { readonly narrow?: true };

/**
 * A step as its level-0 line sees it (§7.5), or null while it cannot be rendered: a step of this process still
 * waiting for its result.
 * - A narrow step an earlier process left is its tool's name, exactly: its record holds nothing else, and its line,
 *   and every line over it, names nothing else (§4.5). This process's own narrow steps are in full.
 * - An erased step is its tool and `(erased)` (§10.1), as zoom shows it.
 * - A step an earlier process of the run left with no result is shown as its outcome unknown (§12).
 */
export function cloudRunStepText(step: CloudRunStepLinesStep, earlier: boolean): string | null {
	if (step.narrow && earlier) return step.tool;
	if (step.erased) return `${step.tool}: (erased)`;
	const result = step.result ?? (earlier ? RUN_STEP_OUTCOME_UNKNOWN : null);
	if (result === null) return null;
	return memoryRenderStep({ tool: step.tool, args: step.args, result, text: step.text });
}

/** A block's lines, or null when it is not one block of a run's tree as the commit stores it. */
export function cloudRunTreeBlockLines(text: string, path: string): MemoryTreeLine[] | null {
	const rows = text.split("\n");
	if (rows.pop() !== "" || rows.length < 1 || rows.length > BLOCK_LINES) return null;
	const lines: MemoryTreeLine[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		let value: unknown;
		try {
			value = JSON.parse(row);
		} catch {
			return null;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const { l, k, free, text: lineText, tries, ...rest } = value as Record<string, unknown>;
		if (Object.keys(rest).length || typeof free !== "boolean" || typeof lineText !== "string") return null;
		const line = { l, k, free, text: lineText, ...(tries !== undefined ? { tries } : {}) } as MemoryTreeLine;
		if (memoryLineProblem(line, "run") !== null || memoryBlockPath(line.l, line.k) !== path) return null;
		if (seen.has(`${line.l}:${line.k}`)) return null;
		seen.add(`${line.l}:${line.k}`);
		lines.push(line);
	}
	return lines;
}

/** The run's log, as its step lines use it. */
export type CloudRunStepLinesLog = Pick<
	CloudRunLog,
	"runId" | "generation" | "steps" | "earlier" | "flush" | "treeRead" | "commitTree" | "onCommitted"
>;

export interface CloudRunStepLinesOptions {
	readonly log: CloudRunStepLinesLog;
	/** Opens a compactor thread on the run's payer (§7.2). */
	readonly call: MemoryCompactCall;
	/** The run's lane, shared with its conversation's tree. */
	readonly lane: MemoryCompactLane;
	/** The run's own signal: lines stop building with it until `finish`. */
	readonly signal: AbortSignal;
	/** The first step this process makes: 0, or the step a resumed run continues at. */
	readonly firstStep?: number;
	/** Each pass's counts, for its `memory_compaction` record (§13). */
	readonly observe?: (stats: MemoryCompactStats) => void;
}

interface Waiter {
	readonly pass: number;
	readonly wake: () => void;
}

const nodeKey = (l: number, k: number): string => `${l}:${k}`;

export class CloudRunStepLines {
	readonly #log: CloudRunStepLinesLog;
	readonly #call: MemoryCompactCall;
	readonly #lane: MemoryCompactLane;
	readonly #signal: AbortSignal;
	readonly #first: number;
	readonly #observe?: (stats: MemoryCompactStats) => void;
	readonly #nonce = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
	/** Lines built, stored or not, by `l:k`. */
	readonly #known = new Map<string, string>();
	/** Lines built for this run's view only, never stored: those over a narrow step of this process (§4.5). */
	readonly #viewOnly = new Set<string>();
	/** Lines built and not stored yet. */
	readonly #unstored = new Map<string, MemoryTreeLine>();
	/** Nodes the compactor failed on: missing for the rest of the run. */
	readonly #failed = new Set<string>();
	/** Blocks read into `#known`. */
	readonly #loaded = new Set<string>();
	readonly #waiters = new Set<Waiter>();
	/** Aborts the building at `finish`'s deadline. */
	readonly #close = new AbortController();
	readonly #unsubscribe: () => void;
	#finishing: AbortSignal | null = null;
	/** The run's generation as the writer read it before its first step or line: every line it stores is at it. */
	#generation: number | null = null;
	/** True once a commit came back `stale` or the generation moved: nothing more is stored in the run (§4.3). */
	#stale = false;
	#done = false;
	#gone = false;
	#commits = 0;
	#wanted = 0;
	#started = 0;
	#passes = 0;
	#looping = false;

	constructor(options: CloudRunStepLinesOptions) {
		const first = options.firstStep ?? 0;
		if (!Number.isSafeInteger(first) || first < 0) throw new Error("Invalid run step lines");
		this.#log = options.log;
		this.#call = options.call;
		this.#lane = options.lane;
		this.#signal = options.signal;
		this.#first = first;
		this.#observe = options.observe;
		this.#unsubscribe = this.#log.onCommitted(() => {
			this.#want();
		});
	}

	/** The lines built so far: `node(l, k)`'s text, stored or not. */
	readonly built: MemoryTreeBuilt = (l, k) => this.#known.get(nodeKey(l, k));

	/** The steps this process made, once the log has committed every finished one (`CloudRunWorkOptions.steps`). */
	async steps(signal: AbortSignal): Promise<readonly CloudRunLogStep[]> {
		await this.#log.flush(signal);
		return this.#log.steps();
	}

	/**
	 * The rows `start+size|text` that fold steps `[0, r)` within `budget` (§5.7), after waiting up to SETTLE for the
	 * level-0 lines not built yet (§5.4).
	 */
	async lines(r: number, budget: number, signal: AbortSignal): Promise<readonly string[]> {
		if (!Number.isSafeInteger(r) || r < 0) throw new Error("Invalid run step lines");
		const pass = this.#want();
		if (!this.#ready(r)) await this.#until(pass, SETTLE_MS, signal);
		return memoryView(r, this.built, budget).map(memoryPartRow);
	}

	/**
	 * At run end, after the log's `close`: builds what is left within CLOSE (§7.1) and commits it under `signal`. A
	 * line built after CLOSE is not waited for. Lines no pass could store stay missing for the next run.
	 */
	async finish(signal: AbortSignal): Promise<void> {
		if (this.#done) return;
		this.#finishing = signal;
		const close = () => this.#close.abort();
		const timer = setTimeout(close, CLOSE_MS);
		timer.unref?.();
		signal.addEventListener("abort", close, { once: true });
		try {
			await this.#until(this.#want(), null, signal);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", close);
			// A pass asked for before now builds nothing after it.
			this.#close.abort();
			this.#done = true;
			this.#unsubscribe();
		}
	}

	/** The run's `composeContext`: its work message folds these lines (§5.7). */
	composeContext(): (
		request: CloudNativeContextRequest,
		signal: AbortSignal,
	) => Promise<CloudNativeContextComposition> {
		return cloudRunWorkComposer({
			firstStep: this.#first,
			steps: (signal) => this.steps(signal),
			lines: (r, budget, signal) => this.lines(r, budget, signal),
		});
	}

	/** Whether every level-0 line of `[0, r)` is built, or will not be in this run. */
	#ready(r: number): boolean {
		if (this.#gone || this.#done) return true;
		for (let j = 0; j < r; j++) if (!this.#known.has(nodeKey(0, j)) && !this.#failed.has(nodeKey(0, j))) return false;
		return true;
	}

	/** Asks for a pass, and returns the number of the first pass to start after now. */
	#want(): number {
		if (this.#done) return this.#passes;
		const pass = this.#started + 1;
		if (this.#wanted < pass) this.#wanted = pass;
		if (!this.#looping) {
			this.#looping = true;
			queueMicrotask(() => void this.#loop());
		}
		return pass;
	}

	async #loop(): Promise<void> {
		try {
			while (this.#started < this.#wanted) {
				this.#started += 1;
				await this.#pass();
				this.#passes = this.#started;
				for (const waiter of [...this.#waiters]) if (waiter.pass <= this.#passes) waiter.wake();
			}
		} finally {
			this.#looping = false;
		}
	}

	/** Resolves once pass `pass` is done, or after `ms`; rejects when `signal` aborts first. */
	#until(pass: number, ms: number | null, signal: AbortSignal): Promise<void> {
		if (this.#passes >= pass) return Promise.resolve();
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const end = () => {
				if (timer) clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.#waiters.delete(waiter);
			};
			const waiter: Waiter = {
				pass,
				wake: () => {
					end();
					resolve();
				},
			};
			const abort = () => {
				end();
				reject(signal.reason);
			};
			this.#waiters.add(waiter);
			signal.addEventListener("abort", abort, { once: true });
			if (ms !== null) {
				timer = setTimeout(waiter.wake, ms);
				timer.unref?.();
			}
		});
	}

	/** One pass: reads the steps and the blocks, builds the missing lines, and commits them. Never throws. */
	async #pass(): Promise<void> {
		if (this.#gone) return;
		const finishing = this.#finishing;
		// Reads and commits stop with the run, or at closing with `finish`'s signal; building also at CLOSE.
		const io = finishing ?? this.#signal;
		if (io.aborted) return;
		const build = finishing ? this.#close.signal : AbortSignal.any([this.#signal, this.#close.signal]);
		try {
			const read = await this.#read(io);
			// Before the run's first step there is nothing to read; a log that kept moving is read by the next pass.
			if (!read?.T) return;
			const { generation, T, texts, narrow } = read;
			this.#generation ??= generation;
			// What was read at one generation is never stored at another (§4.3).
			if (generation !== this.#generation) this.#stale = true;
			const scope = this.#scope(T);
			if (scope.leaves.length && !build.aborted) await this.#build(T, texts, narrow, scope, build);
			await this.#commit(this.#generation, io);
		} catch (error) {
			// What was built stays, and the next pass tries again; a gone log ends the writer.
			if (error instanceof CloudRunLogGone) this.#gone = true;
		}
	}

	/**
	 * The run's generation, then the steps `[0, T)` and the blocks not read yet, read after it (§4.3). Reads that found
	 * the log anew (a resumed run's first, or after a move) may straddle it, so they are read again at the generation
	 * it found. Null when it moved under every read.
	 */
	async #read(
		signal: AbortSignal,
	): Promise<{ generation: number; T: number; texts: (string | null)[]; narrow: boolean[] } | null> {
		for (let attempt = 1; attempt <= READS; attempt++) {
			const generation = this.#log.generation();
			const { T, texts, narrow } = await this.#texts(signal);
			const blocks = await this.#blocks(T, signal);
			if (this.#log.generation() !== generation) continue;
			for (const [path, lines] of blocks) {
				for (const line of lines)
					if (!this.#known.has(nodeKey(line.l, line.k))) this.#known.set(nodeKey(line.l, line.k), line.text);
				this.#loaded.add(path);
			}
			return { generation, T, texts, narrow };
		}
		return null;
	}

	/**
	 * Every step `[0, T)` as its line sees it: the earlier process's, then this one's in order as committed; and which
	 * of them are this process's narrow steps.
	 */
	async #texts(signal: AbortSignal): Promise<{ T: number; texts: (string | null)[]; narrow: boolean[] }> {
		const own = this.#log.steps() as readonly CloudRunStepLinesStep[];
		let T = this.#first;
		for (const step of own) {
			if (step.j !== T) break;
			T += 1;
		}
		const texts = new Array<string | null>(T).fill(null);
		const narrow = new Array<boolean>(T).fill(false);
		if (this.#first > 0) {
			try {
				for (const step of (await this.#log.earlier(signal)) as readonly CloudRunStepLinesStep[])
					if (step.j < this.#first) texts[step.j] = cloudRunStepText(step, true);
			} catch (error) {
				// Without them, only their stored lines serve.
				if (error instanceof CloudRunLogGone) throw error;
			}
		}
		for (const step of own) {
			if (step.j >= T) continue;
			texts[step.j] = cloudRunStepText(step, false);
			narrow[step.j] = step.narrow === true;
		}
		return { T, texts, narrow };
	}

	/**
	 * The stored lines of each block `[0, T)` has nodes in, of those not read yet. A block that does not parse is read
	 * as empty.
	 */
	async #blocks(T: number, signal: AbortSignal): Promise<Map<string, MemoryTreeLine[]>> {
		const blocks = new Map<string, MemoryTreeLine[]>();
		for (let tier = 0; 2 ** (4 * tier) <= T; tier++) {
			const span = 16 ** (tier + 1);
			for (let block = 0; block * span + 2 ** (4 * tier) <= T; block++) {
				const path = memoryBlockPath(4 * tier, block * 16);
				if (this.#loaded.has(path)) continue;
				const stored = await this.#log.treeRead(path, signal);
				blocks.set(path, (stored && cloudRunTreeBlockLines(stored.text, path)) ?? []);
			}
		}
		return blocks;
	}

	/**
	 * The steps whose path up the tree has a node missing and none the compactor failed on, and those paths' nodes: so
	 * a failed node is never built again, and a node over it is tried without a call.
	 */
	#scope(T: number): { leaves: number[]; nodes: [number, number][] } {
		const leaves: number[] = [];
		const nodes = new Map<string, [number, number]>();
		for (let j = 0; j < T; j++) {
			const path: [number, number][] = [];
			for (let l = 0; (Math.floor(j / 2 ** l) + 1) * 2 ** l <= T; l++) path.push([l, Math.floor(j / 2 ** l)]);
			if (path.some(([l, k]) => this.#failed.has(nodeKey(l, k)))) continue;
			if (!path.some(([l, k]) => !this.#known.has(nodeKey(l, k)))) continue;
			leaves.push(j);
			for (const [l, k] of path) nodes.set(nodeKey(l, k), [l, k]);
		}
		return { leaves, nodes: [...nodes.values()] };
	}

	async #build(
		T: number,
		texts: readonly (string | null)[],
		narrow: readonly boolean[],
		scope: { leaves: number[]; nodes: [number, number][] },
		signal: AbortSignal,
	): Promise<void> {
		const { lines, stats } = await memoryCompact(
			{
				kind: "run",
				T,
				built: this.built,
				leaves: scope.leaves,
				event: async (i) => {
					const text = texts[i];
					if (text === null || text === undefined) throw new Error("Step not readable");
					return { text };
				},
			},
			this.#call,
			{ lane: this.#lane, signal },
		);
		// Children first: a leaf whose step or window holds a narrow step of this process, and a merge over a line for
		// the view only, are for the view only too.
		for (const line of lines) {
			const key = nodeKey(line.l, line.k);
			if (this.#known.has(key)) continue;
			this.#known.set(key, line.text);
			const viewOnly =
				line.l === 0
					? narrow.slice(memoryWindowStart(line.k), line.k + 1).includes(true)
					: this.#viewOnly.has(nodeKey(line.l - 1, 2 * line.k)) ||
						this.#viewOnly.has(nodeKey(line.l - 1, 2 * line.k + 1));
			if (viewOnly) this.#viewOnly.add(key);
			else if (!this.#stale) this.#unstored.set(key, line);
		}
		if (stats.calls || stats.free || stats.failures) {
			try {
				this.#observe?.(stats);
			} catch {
				// The record is the observer's own.
			}
		}
		// A deadline or a stopped lane leaves nodes missing that did not fail.
		if (signal.aborted || this.#lane.stopped) return;
		const readable = (i: number) => texts[i] !== null && texts[i] !== undefined;
		for (const [l, k] of scope.nodes) {
			if (this.#known.has(nodeKey(l, k))) continue;
			const inputs =
				l === 0
					? readable(k) && texts.slice(memoryWindowStart(k), k).every((text) => text !== null)
					: this.#known.has(nodeKey(l - 1, 2 * k)) && this.#known.has(nodeKey(l - 1, 2 * k + 1));
			if (inputs) this.#failed.add(nodeKey(l, k));
		}
	}

	/**
	 * Commits the lines not stored yet at `generation`, the writer's: each block read again, its stored lines kept, in
	 * change sets within core §5's bounds.
	 */
	async #commit(generation: number, signal: AbortSignal): Promise<void> {
		if (this.#stale) {
			this.#unstored.clear();
			return;
		}
		const byPath = new Map<string, MemoryTreeLine[]>();
		for (const line of this.#unstored.values()) {
			const path = memoryBlockPath(line.l, line.k);
			byPath.set(path, [...(byPath.get(path) ?? []), line]);
		}
		const writes: { readonly block: CloudRunTreeBlock; readonly keys: readonly string[] }[] = [];
		for (const [path, lines] of [...byPath].sort(([a], [b]) => (a < b ? -1 : 1))) {
			const stored = await this.#log.treeRead(path, signal);
			const kept = stored ? cloudRunTreeBlockLines(stored.text, path) : [];
			const keys = lines.map((line) => nodeKey(line.l, line.k));
			if (kept === null) {
				// A block this writer cannot read is left as it is.
				for (const key of keys) this.#unstored.delete(key);
				continue;
			}
			const merged = new Map(kept.map((line) => [nodeKey(line.l, line.k), line]));
			const adding: string[] = [];
			for (const [index, line] of lines.entries()) {
				const have = merged.get(keys[index]);
				if (have) {
					this.#known.set(keys[index], have.text);
					this.#unstored.delete(keys[index]);
				} else {
					merged.set(keys[index], line);
					adding.push(keys[index]);
				}
			}
			if (!adding.length) continue;
			const text = memoryBlockText([...merged.values()], "run");
			writes.push({ block: { path, text, version: stored?.version ?? null }, keys: adding });
		}
		let set: typeof writes = [];
		let bytes = 0;
		const sets: (typeof writes)[] = [];
		for (const write of writes) {
			const size = Buffer.byteLength(write.block.text);
			if (set.length && (set.length >= CHANGE_SET_FILES || bytes + size > CHANGE_SET_BYTES)) {
				sets.push(set);
				set = [];
				bytes = 0;
			}
			set.push(write);
			bytes += size;
		}
		if (set.length) sets.push(set);
		for (const writes of sets) {
			this.#commits += 1;
			const key = `step-lines.${this.#log.runId}.${this.#nonce}.${this.#commits}`;
			const outcome = await this.#log.commitTree(
				key,
				writes.map((write) => write.block),
				generation,
				signal,
			);
			if (outcome === "gone") throw new CloudRunLogGone();
			if (outcome === "stale") {
				// Discarded whole, with every line over it: nothing more is stored in this run (§4.3).
				this.#stale = true;
				this.#unstored.clear();
				return;
			}
			for (const write of writes) for (const key of write.keys) this.#unstored.delete(key);
		}
	}
}
