// A conversation's lines (design RUNTIME-AGENT-MEMORY-TREE.md §4.3, §5.4, §7.1, M1b-4b-3): the summary tree of the
// run's own conversation, built in the run's lane on its payer and stored in the conversation's tree folder. One writer
// serves one run attempt in one process, in a conversation of any kind (a thread, a group or a conversation; M4c).
// - `open` reads the run's conversation and its live tree (qorpera_memory_view) before any event or line, so every
//   line the writer builds and stores is at the erase generation read then (§4.3). A later read at another generation
//   drops what was built at the earlier one.
// - `settle` (§5.4) builds the lines `[0, T)` is missing within SETTLE_MS and stores them, before the run composes its
//   view. The view reads the tree again, so it shows only lines that were stored.
// - `close` (§7.1) builds, within CLOSE_MS, the level-0 nodes of the events the run caused (the inputs that woke it,
//   its own sends and cards) and every merge they complete, and stores them. What is left stays missing, for a settle.
// - Events come from qorpera_memory_events_run (M1b-4b-2), PAGE at a time, rendered as §4.1 shows them.
// - A node the compactor failed on, with its inputs at hand, stays missing for the rest of the run (§7.2). A stopped
//   lane, a deadline or an unreadable event is no failure.
// - Lines are committed through qorpera_folder_memory_commit with the conversation's generation and no run log, in
//   change sets within core §5's bounds. The first makes the tree's root, its tree.toml (§4.2: application/toml, never
//   executable) and the tier folders. A change set refused for the generation, or while an erase is open, is discarded
//   whole with every line not stored, and nothing more is stored at that generation. A block not at the version it was
//   read at is read again, its stored lines kept and this writer's duplicates dropped, up to READS times. A line over
//   LINE_BYTES as stored is never built (memoryCompact).
// - Each batch that built or tried a line is recorded once (memory_compaction, §13), through the run attempt's one
//   recorder (`memoryCompactionRecorder`).

import { isUuid, parseClosedRecord, parseInteger, parseSha256Hex, WireValueError } from "@qorpera/contracts";
import type { CloudCompanyFolderClient, CloudCompanyFolderUnit } from "../cloud-company-folder-client.ts";
import { type CloudCompanyPathControl, CloudCompanyPathNotText } from "../cloud-company-path-gateway.ts";
import { type CloudNativeToolBinding, cloudToolRequest } from "../cloud-native-tool-authority.ts";
import { cloudRuntimeErrorCategory } from "../cloud-runtime-observability.ts";
import {
	type MemoryCompactCall,
	type MemoryCompactEvent,
	type MemoryCompactLane,
	type MemoryCompactStats,
	memoryCompact,
	memoryWindowStart,
} from "./compact.ts";
import { type MemoryViewAnswer, type MemoryViewWait, memoryViewAnswer } from "./compose.ts";
import type { MemoryTreeBuilt } from "./fold.ts";
import { type MemoryQuote, memoryRenderEvent } from "./render.ts";
import {
	CLOSE_MS,
	type MemoryTreeLine,
	memoryBlockLines,
	memoryBlockPath,
	memoryBlockText,
	memoryNodeAddress,
	NODE,
	SETTLE_MS,
} from "./tree.ts";

/** qorpera_memory_events_run's answer schema. */
export const MEMORY_EVENTS_SCHEMA = "qorpera.memory-events/v1";
/** qorpera_memory_compaction_record's answer schema. */
export const MEMORY_COMPACTION_RECORD_SCHEMA = "qorpera.memory-compaction-record/v1";

/** Core §5's change set. */
const CHANGE_SET_FILES = 64;
const CHANGE_SET_BYTES = 1024 * 1024;
/** Core §5's bound on one structured file: a block is read whole within it. */
const BLOCK_BYTES = 64 * 1024;
/** Times a batch reads its blocks and commits its lines while blocks change under it. */
const READS = 3;
/** Times one change set is committed while some of its units wait for a folder (`<key>:2` to `:4`). */
const ATTEMPTS = 4;
/** Events one call reads: the host call's most. */
const PAGE = 128;
/** The most a memory_compaction count holds. */
const COUNT = 999_999_999;
const MEMBER_QUOTE_SCHEMA = "qorpera.member-quote/v1";
const SPEAKERS = new Set(["member", "agent", "platform"]);
const EVENT_KEYS = [
	"index",
	"sequence",
	"eventId",
	"eventHash",
	"type",
	"at",
	"erased",
	"runId",
	"speakerKind",
	"speaker",
	"role",
	"text",
	"quotes",
	"attachments",
	"cardType",
	"card",
];

/** A conversation tree's tree.toml (§4.2): exactly its three lines. */
export function memoryTreeToml(sessionId: string): string {
	return `format = 1\nconversation = "${sessionId}"\nnode_bytes = ${NODE}\n`;
}

/** An event as its level-0 line sees it, and the run that wrote it. */
interface EventEntry {
	readonly event: MemoryCompactEvent;
	readonly runId: string | null;
}

function list(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new WireValueError(label);
	return value;
}

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || value === "") throw new WireValueError(label);
	return value;
}

/** The run that wrote an event, as the database prints its id (`isUuid`), or null. */
function runOf(value: unknown): string | null {
	if (value === null) return null;
	if (!isUuid(value)) throw new WireValueError("an event's run");
	return value;
}

/**
 * Event `index` of qorpera_memory_events_run's answer, as §4.1 renders it: a message is its speaker's words, its
 * attachments and its quotes' records; a card's speaker is `card`, its text the card's type and data; an erased event
 * keeps its speaker and shows `(erased)`. A WireValueError says what is wrong.
 */
function eventEntry(value: unknown, index: number): EventEntry {
	const read = parseClosedRecord(value, "an event", EVENT_KEYS);
	if (parseInteger(read.index, "an event's index", 0, Number.MAX_SAFE_INTEGER) !== index)
		throw new WireValueError("an event's index");
	const seq = parseInteger(read.sequence, "an event's sequence", 1, Number.MAX_SAFE_INTEGER);
	const hash = parseSha256Hex(read.eventHash, "an event's hash");
	// Not a uuid: a kickoff event's id is an md5 cast to uuid, of no RFC version.
	nonEmpty(read.eventId, "an event's id");
	nonEmpty(read.type, "an event's type");
	if (typeof read.at !== "string") throw new WireValueError("an event's time");
	if (typeof read.erased !== "boolean") throw new WireValueError("an event's erasure");
	const runId = runOf(read.runId);
	if (typeof read.speakerKind !== "string" || !SPEAKERS.has(read.speakerKind))
		throw new WireValueError("an event's speaker");
	if (read.role !== null && typeof read.role !== "string") throw new WireValueError("an event's role");
	const speaker = nonEmpty(read.speaker, "an event's speaker");
	const text = read.text;
	if (text !== null && typeof text !== "string") throw new WireValueError("an event's text");
	const cardType = read.cardType === null ? null : nonEmpty(read.cardType, "an event's card type");
	if (cardType === null && read.card !== null) throw new WireValueError("an event's card");
	if (read.erased) {
		if (text !== null || read.quotes !== null || read.attachments !== null || cardType !== null)
			throw new WireValueError("an erased event");
		return { event: { text: memoryRenderEvent({ speaker, text: "(erased)" }), seq, hash }, runId };
	}
	const attachments = (read.attachments === null ? [] : list(read.attachments, "an event's attachments")).map(
		(item) => {
			const attachment = parseClosedRecord(item, "an attachment", ["mediaType", "bytes"]);
			const { mediaType, bytes } = attachment;
			if (mediaType !== null && typeof mediaType !== "string") throw new WireValueError("an attachment");
			if (bytes !== null) parseInteger(bytes, "an attachment's size", 0, Number.MAX_SAFE_INTEGER);
			return `${mediaType || "file"}${bytes === null ? "" : ` (${bytes} bytes)`}`;
		},
	);
	const quotes = (read.quotes === null ? [] : list(read.quotes, "an event's quotes")).map(
		(item, position): MemoryQuote => {
			const quote = parseClosedRecord(item, "a quote", ["schema", "trust", "provenance", "text"]);
			const provenance = parseClosedRecord(quote.provenance, "a quote's provenance", [
				"inputId",
				"quote",
				"source",
				"ref",
			]);
			const { source, ref } = provenance;
			const words = quote.text;
			if (
				quote.schema !== MEMBER_QUOTE_SCHEMA ||
				quote.trust !== "untrusted_data" ||
				!isUuid(provenance.inputId) ||
				provenance.quote !== position + 1 ||
				typeof source !== "string" ||
				(ref !== null && typeof ref !== "string") ||
				typeof words !== "string"
			)
				throw new WireValueError("a quote");
			return { source, text: words };
		},
	);
	const card = cardType === null ? null : `${cardType}: ${JSON.stringify(read.card)}`;
	const body = [text, card].filter((part) => part !== null).join("\n");
	const rendered = memoryRenderEvent({
		speaker: card === null ? speaker : "card",
		text: body === "" ? "(no text shown)" : body,
		quotes,
		attachments,
	});
	return { event: { text: rendered, seq, hash }, runId };
}

/** One batch's events `[0, T)`, read PAGE at a time, one call after another, as the compactor asks for them. */
interface EventReader {
	/** The events read, by index. */
	readonly read: ReadonlySet<number>;
	entry(i: number, signal: AbortSignal): Promise<EventEntry>;
	event(i: number, signal: AbortSignal): Promise<MemoryCompactEvent>;
}

/** A block of lines to write, with the lines it adds. */
interface BlockWrite {
	readonly path: string;
	readonly text: string;
	/** The version it was read at; null for a block that does not exist yet. */
	readonly version: string | null;
	readonly keys: readonly string[];
}

/** What a change set's unit makes: the tree's root, its tree.toml, a tier folder or a block. */
type Target =
	| { readonly kind: "root" }
	| { readonly kind: "toml" }
	| { readonly kind: "tier"; readonly tier: string }
	| { readonly kind: "block"; readonly write: BlockWrite };

export interface CloudConversationLinesOptions {
	readonly control: CloudCompanyPathControl;
	readonly binding: CloudNativeToolBinding;
	/** The run's folder client: blocks are read and committed through it. */
	readonly folder: Pick<CloudCompanyFolderClient, "readText" | "stage" | "memorySessionCommitStaged">;
	/** Opens a compactor thread on the run's payer (§7.2). */
	readonly call: MemoryCompactCall;
	/** The run's lane, shared with every tree of the run. */
	readonly lane: MemoryCompactLane;
	/** Records a batch's counts (memoryCompactionRecorder); never throws. */
	readonly record?: (stats: MemoryCompactStats, signal: AbortSignal) => Promise<void>;
}

const nodeKey = (l: number, k: number): string => `${l}:${k}`;
const tierOf = (path: string): string => path.slice(0, path.indexOf("/"));

export class CloudConversationLines {
	readonly #control: CloudCompanyPathControl;
	readonly #binding: CloudNativeToolBinding;
	readonly #folder: CloudConversationLinesOptions["folder"];
	readonly #call: MemoryCompactCall;
	readonly #lane: MemoryCompactLane;
	readonly #record?: (stats: MemoryCompactStats, signal: AbortSignal) => Promise<void>;
	readonly #nonce = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
	/** Lines built by this writer or found stored when it read their block, by `l:k`, at the view's generation. */
	readonly #known = new Map<string, string>();
	/** Lines built and not stored yet. */
	readonly #unstored = new Map<string, MemoryTreeLine>();
	/** Nodes the compactor failed on: missing for the rest of the run. */
	readonly #failed = new Set<string>();
	/** Tier folders known to exist, `t<n>`. */
	readonly #tiers = new Set<string>();
	/** The tree as last read. */
	#view: MemoryViewAnswer | null = null;
	/** The run's conversation at `open`: T, and its messages then (from T on, the inputs that woke the run). */
	#opening: { readonly sessionId: string; readonly T: number; readonly start: number } | null = null;
	/** The tree's root as the events call names it: where the first change set makes the tree. */
	#root: string | null = null;
	/** Whether the root folder and tree.toml exist. */
	#made = false;
	#toml = false;
	/** True once a commit was refused for the generation, or while an erase was open: nothing more is stored at it. */
	#stale = false;
	#commits = 0;

	constructor(options: CloudConversationLinesOptions) {
		this.#control = options.control;
		this.#binding = options.binding;
		this.#folder = options.folder;
		this.#call = options.call;
		this.#lane = options.lane;
		this.#record = options.record;
	}

	/** The lines built so far: by this writer, or stored in the tree as last read. */
	readonly built: MemoryTreeBuilt = (l, k) =>
		this.#known.get(nodeKey(l, k)) ?? this.#view?.tree.lines.get(memoryNodeAddress(l, k))?.text;

	/**
	 * Reads the run's conversation and its tree, before any event or line. False for a run that has none (§5.3), or
	 * when the read failed: the run then composes without a view.
	 */
	async open(signal: AbortSignal): Promise<boolean> {
		let view: MemoryViewAnswer | null;
		try {
			view = await this.#read(signal);
		} catch (error) {
			signal.throwIfAborted();
			console.error(`Memory tree was not read (${cloudRuntimeErrorCategory(error, signal)})`);
			return false;
		}
		if (!view) return false;
		this.#adopt(view);
		this.#opening = { sessionId: view.sessionId, T: view.messages, start: view.tree.messages };
		return true;
	}

	/**
	 * At run start (§5.4): builds the lines `[0, T)` is missing, waiting at most SETTLE_MS, and stores them. Answers the
	 * time it took and the lines it built, for the run's memory_view record (§13). Only an abort of `signal` throws.
	 */
	async settle(signal: AbortSignal): Promise<MemoryViewWait> {
		const opening = this.#opening;
		if (!opening || !this.#writable()) return { waitMs: 0, waitedLines: 0 };
		const started = Date.now();
		let waitedLines = 0;
		try {
			const build = AbortSignal.any([signal, AbortSignal.timeout(SETTLE_MS)]);
			const reader = this.#reader(opening.sessionId, opening.T);
			const leaves = Array.from({ length: opening.T }, (_, i) => i);
			waitedLines = await this.#batch(opening.T, leaves, reader, build, signal);
			await this.#commit(signal);
		} catch (error) {
			signal.throwIfAborted();
			console.error(`Memory tree lines were not settled (${cloudRuntimeErrorCategory(error, signal)})`);
		}
		return { waitMs: Date.now() - started, waitedLines };
	}

	/**
	 * Closing (§7.1), after the agent's turn: reads the tree again, then builds within CLOSE_MS the level-0 nodes of the
	 * events the run caused, and every merge they complete, in one batch, and stores them. Never throws.
	 */
	async close(signal: AbortSignal): Promise<void> {
		const opening = this.#opening;
		if (!opening) return;
		try {
			const view = await this.#read(signal);
			if (!view || view.sessionId !== opening.sessionId) return;
			this.#adopt(view);
			if (!this.#writable()) return;
			const T = view.tree.messages;
			const build = AbortSignal.any([signal, AbortSignal.timeout(CLOSE_MS)]);
			const reader = this.#reader(view.sessionId, T);
			// The inputs that woke the run, then its own sends and cards.
			const caused: number[] = [];
			for (let i = opening.T; i < Math.min(opening.start, T); i++) caused.push(i);
			for (let i = opening.start; i < T; i++) {
				const entry = await reader.entry(i, build).catch(() => null);
				if (entry?.runId === this.#binding.runId) caused.push(i);
			}
			await this.#batch(T, caused, reader, build, signal);
			await this.#commit(signal);
		} catch (error) {
			if (!signal.aborted)
				console.error(`Memory tree lines were not closed (${cloudRuntimeErrorCategory(error, signal)})`);
		}
	}

	async #read(signal: AbortSignal): Promise<MemoryViewAnswer | null> {
		return memoryViewAnswer(
			await cloudToolRequest(
				(requestSignal) => this.#control.call("qorpera_memory_view", { p_binding: this.#binding }, requestSignal),
				signal,
			),
		);
	}

	/** Takes `view` as the tree: at another generation, or another conversation's, what was built before is dropped. */
	#adopt(view: MemoryViewAnswer): void {
		const before = this.#view;
		if (before && (before.sessionId !== view.sessionId || before.tree.generation !== view.tree.generation)) {
			this.#known.clear();
			this.#unstored.clear();
			this.#failed.clear();
			this.#tiers.clear();
			this.#made = this.#toml = this.#stale = false;
		}
		this.#view = view;
		const { root, nodeBytes, lines } = view.tree;
		if (root !== null) {
			this.#made = true;
			for (const { block } of lines.values())
				if (block.path.startsWith(`${root}/`)) this.#tiers.add(tierOf(block.path.slice(root.length + 1)));
		}
		if (nodeBytes !== null) this.#toml = true;
	}

	/** Whether lines may be stored in the tree as read: one with no tree.toml yet, or one of NODE-byte lines. */
	#writable(): boolean {
		const nodeBytes = this.#view?.tree.nodeBytes;
		return nodeBytes === null || nodeBytes === NODE;
	}

	/** Events `[0, T)` of the run's conversation. A page that failed fails its events; the next page is still read. */
	#reader(sessionId: string, T: number): EventReader {
		const read = new Set<number>();
		const pages = new Map<number, Promise<Map<number, EventEntry>>>();
		let last: Promise<unknown> = Promise.resolve();
		const entry = async (i: number, signal: AbortSignal): Promise<EventEntry> => {
			if (!Number.isSafeInteger(i) || i < 0 || i >= T) throw new Error("Memory event out of range");
			const start = i - (i % PAGE);
			let page = pages.get(start);
			if (!page) {
				page = last
					.catch(() => undefined)
					.then(() => this.#page(sessionId, start, Math.min(PAGE, T - start), signal));
				page.then(
					(events) => {
						for (const index of events.keys()) read.add(index);
					},
					() => undefined,
				);
				pages.set(start, page);
				last = page;
			}
			const found = (await page).get(i);
			if (!found) throw new Error("Memory event not shown");
			return found;
		};
		return { read, entry, event: async (i, signal) => (await entry(i, signal)).event };
	}

	/** Events `[start, start + count)` from qorpera_memory_events_run, by index. */
	async #page(sessionId: string, start: number, count: number, signal: AbortSignal): Promise<Map<number, EventEntry>> {
		const value = await cloudToolRequest(
			(requestSignal) =>
				this.#control.call(
					"qorpera_memory_events_run",
					{ p_binding: this.#binding, p_request: { session: sessionId, start, count } },
					requestSignal,
				),
			signal,
		);
		try {
			const answer = parseClosedRecord(value, "the answer", ["schema", "root", "events"]);
			if (answer.schema !== MEMORY_EVENTS_SCHEMA) throw new WireValueError("its schema");
			const root = nonEmpty(answer.root, "its root");
			const events = list(answer.events, "its events");
			if (events.length > count) throw new WireValueError("its events");
			const entries = new Map(
				events.map((item, position) => [start + position, eventEntry(item, start + position)]),
			);
			this.#root = root;
			return entries;
		} catch (error) {
			if (error instanceof WireValueError) {
				throw new Error(`Invalid memory events answer: ${error.message}`, { cause: error });
			}
			throw error;
		}
	}

	/**
	 * The candidate leaves whose path up the tree has a node missing and none the compactor failed on, and those paths'
	 * nodes: a failed node is not tried again in the run, nor any node over it.
	 */
	#scope(T: number, candidates: readonly number[]): { leaves: number[]; nodes: [number, number][] } {
		const leaves: number[] = [];
		const nodes = new Map<string, [number, number]>();
		for (const i of new Set(candidates)) {
			if (!Number.isSafeInteger(i) || i < 0 || i >= T) continue;
			const path: [number, number][] = [];
			for (let l = 0; (Math.floor(i / 2 ** l) + 1) * 2 ** l <= T; l++) path.push([l, Math.floor(i / 2 ** l)]);
			if (path.some(([l, k]) => this.#failed.has(nodeKey(l, k)))) continue;
			if (path.every(([l, k]) => this.built(l, k) !== undefined)) continue;
			leaves.push(i);
			for (const [l, k] of path) nodes.set(nodeKey(l, k), [l, k]);
		}
		return { leaves, nodes: [...nodes.values()] };
	}

	/**
	 * One batch (memoryCompact): the candidates' missing lines in `[0, T)` until `build` ends, recorded once, and the
	 * nodes it failed on marked. Answers how many lines it built.
	 */
	async #batch(
		T: number,
		candidates: readonly number[],
		reader: EventReader,
		build: AbortSignal,
		signal: AbortSignal,
	): Promise<number> {
		const scope = this.#scope(T, candidates);
		if (!scope.leaves.length) return 0;
		const { lines, stats } = await memoryCompact(
			{ kind: "conversation", T, built: this.built, leaves: scope.leaves, event: reader.event },
			this.#call,
			{ lane: this.#lane, signal: build },
		);
		let added = 0;
		for (const line of lines) {
			if (this.built(line.l, line.k) !== undefined) continue;
			const key = nodeKey(line.l, line.k);
			this.#known.set(key, line.text);
			if (!this.#stale) this.#unstored.set(key, line);
			added += 1;
		}
		if (stats.calls || stats.free || stats.failures) {
			try {
				await this.#record?.(stats, signal);
			} catch {
				// The record is the recorder's own.
			}
		}
		// A deadline or a stopped lane leaves nodes missing that did not fail.
		if (build.aborted || this.#lane.stopped) return added;
		for (const [l, k] of scope.nodes) {
			if (this.built(l, k) !== undefined) continue;
			let inputs = true;
			if (l > 0) inputs = this.built(l - 1, 2 * k) !== undefined && this.built(l - 1, 2 * k + 1) !== undefined;
			else for (let i = memoryWindowStart(k); i <= k; i++) inputs &&= reader.read.has(i);
			if (inputs) this.#failed.add(nodeKey(l, k));
		}
		return added;
	}

	/**
	 * Stores the lines not stored yet. A change set refused because a block is not at the version it was read at is read
	 * and committed again, up to READS times; what is left stays missing.
	 */
	async #commit(signal: AbortSignal): Promise<void> {
		for (let attempt = 1; attempt <= READS; attempt++) if (await this.#store(signal)) return;
	}

	/**
	 * Commits the lines not stored yet, each block read again and its stored lines kept, in change sets within core §5's
	 * bounds. False when a block changed under a change set, which is then to be read again.
	 */
	async #store(signal: AbortSignal): Promise<boolean> {
		const view = this.#view;
		const root = this.#root ?? view?.tree.root ?? null;
		if (this.#stale || !view || root === null || !this.#unstored.size) {
			this.#unstored.clear();
			return true;
		}
		const byPath = new Map<string, MemoryTreeLine[]>();
		for (const line of this.#unstored.values()) {
			const path = memoryBlockPath(line.l, line.k);
			byPath.set(path, [...(byPath.get(path) ?? []), line]);
		}
		const writes: BlockWrite[] = [];
		for (const [path, lines] of [...byPath].sort(([a], [b]) => (a < b ? -1 : 1))) {
			const keys = lines.map((line) => nodeKey(line.l, line.k));
			const stored = await this.#folder.readText(`${root}/${path}`, BLOCK_BYTES, signal).catch((error) => {
				if (error instanceof CloudCompanyPathNotText) return undefined;
				throw error;
			});
			const kept = stored === undefined ? null : stored ? memoryBlockLines(stored.text, path) : [];
			if (kept === null) {
				// A block this writer cannot read is left as it is.
				for (const key of keys) this.#unstored.delete(key);
				continue;
			}
			if (stored) this.#tiers.add(tierOf(path));
			const merged = new Map(kept.map((line) => [nodeKey(line.l, line.k), line]));
			const adding: string[] = [];
			for (const [index, line] of lines.entries()) {
				const have = merged.get(keys[index]);
				if (have) {
					// The stored line is kept, and this writer's dropped.
					this.#known.set(keys[index], have.text);
					this.#unstored.delete(keys[index]);
				} else {
					merged.set(keys[index], line);
					adding.push(keys[index]);
				}
			}
			if (!adding.length) continue;
			const text = memoryBlockText([...merged.values()]);
			writes.push({ path, text, version: stored?.entry.version ?? null, keys: adding });
		}
		// The first change set makes tree.toml too, which counts toward its bounds.
		const sets: BlockWrite[][] = [];
		let set: BlockWrite[] = [];
		let files = this.#toml ? 0 : 1;
		let bytes = this.#toml ? 0 : Buffer.byteLength(memoryTreeToml(view.sessionId));
		for (const write of writes) {
			const size = Buffer.byteLength(write.text);
			if (set.length && (files >= CHANGE_SET_FILES || bytes + size > CHANGE_SET_BYTES)) {
				sets.push(set);
				set = [];
				files = 0;
				bytes = 0;
			}
			set.push(write);
			files += 1;
			bytes += size;
		}
		if (set.length) sets.push(set);
		for (const writes of sets) {
			const outcome = await this.#land(view, root, writes, signal);
			if (outcome === "stale") {
				// Refused for its generation, or while an erase is open, the change set landed nothing: it is discarded
				// whole, with every line not stored, and nothing more is stored at this generation (§4.3).
				this.#stale = true;
				this.#unstored.clear();
				return true;
			}
			if (outcome === "changed") return false;
		}
		return true;
	}

	/**
	 * Commits one change set at the view's generation, after the root, tree.toml and the tier folders it needs. Each
	 * unit lands or not on its own (core §3), so the blocks that did not land for want of a folder are tried again, with
	 * it, under `<key>:2` to `:4`. "stale" when the generation moved or an erase is open; "changed" when a block is not
	 * at the version it was read at, for every block to be read again. Any other refusal throws.
	 */
	async #land(
		view: MemoryViewAnswer,
		root: string,
		writes: readonly BlockWrite[],
		signal: AbortSignal,
	): Promise<"landed" | "stale" | "changed"> {
		this.#commits += 1;
		const key = `conversation-lines.${this.#binding.runId}.${this.#nonce}.${this.#commits}`;
		let left = [...writes];
		for (let attempt = 1; ; attempt++) {
			const units: CloudCompanyFolderUnit[] = [];
			const targets: Target[] = [];
			if (!this.#made) {
				units.push({ op: "mkdir", path: root });
				targets.push({ kind: "root" });
			}
			if (!this.#toml) {
				// Its media type is given, never the folder client's guess from the name (§4.3).
				const content = { text: memoryTreeToml(view.sessionId), mediaType: "application/toml", executable: false };
				units.push({ op: "write", path: `${root}/tree.toml`, content });
				targets.push({ kind: "toml" });
			}
			const tiers = [...new Set(left.map((write) => tierOf(write.path)))].filter((tier) => !this.#tiers.has(tier));
			for (const tier of tiers.sort()) {
				units.push({ op: "mkdir", path: `${root}/${tier}` });
				targets.push({ kind: "tier", tier });
			}
			for (const write of left) {
				units.push({
					op: "write",
					path: `${root}/${write.path}`,
					content: { text: write.text, mediaType: "application/jsonl" },
					...(write.version !== null ? { expectedVersion: write.version } : {}),
				});
				targets.push({ kind: "block", write });
			}
			const result = await this.#folder.memorySessionCommitStaged(
				attempt === 1 ? key : `${key}:${attempt}`,
				await this.#folder.stage(units, signal),
				{ sessionId: view.sessionId, generation: view.tree.generation },
				signal,
			);
			const landed = new Set<BlockWrite>();
			let stale = false;
			let changed = false;
			let refused: string | null = null;
			for (const [index, unit] of result.units.entries()) {
				const target = targets[index];
				const reason = unit.reason ?? unit.outcome;
				if (unit.outcome === "saved" || (unit.outcome === "conflict" && target.kind !== "block")) {
					// Saved, or a folder or tree.toml another batch made.
					if (target.kind === "root") this.#made = true;
					else if (target.kind === "toml") this.#made = this.#toml = true;
					else if (target.kind === "tier") this.#tiers.add(target.tier);
					else landed.add(target.write);
				} else if (reason === "memory_generation_stale" || reason === "memory_erase_open") stale = true;
				else if (reason === "parent_missing" && target.kind !== "root") {
					// A folder this writer took to exist does not: a block's tier, or the root under the others.
					if (target.kind === "block") this.#tiers.delete(tierOf(target.write.path));
					else {
						this.#made = this.#toml = false;
						this.#tiers.clear();
					}
				} else if (unit.outcome === "conflict") changed = true;
				else refused ??= reason;
			}
			if (stale) return "stale";
			if (refused !== null) throw new Error(`Memory tree batch refused (${refused})`);
			for (const write of landed) for (const key of write.keys) this.#unstored.delete(key);
			left = left.filter((write) => !landed.has(write));
			if (changed) return "changed";
			if (!left.length) return "landed";
			if (attempt >= ATTEMPTS) throw new Error("Memory tree batch did not land");
		}
	}
}

/**
 * The run attempt's memory_compaction recorder (§13): each batch's counts through qorpera_memory_compaction_record,
 * numbered from 0 in the order recorded. Records are keyed by run, assignment and batch, so one recorder serves every
 * tree of the attempt. A failed record is logged, and the run goes on: it never throws.
 */
export function memoryCompactionRecorder(
	control: CloudCompanyPathControl,
	binding: CloudNativeToolBinding,
): (stats: MemoryCompactStats, signal: AbortSignal) => Promise<void> {
	let batches = 0;
	return async (stats, signal) => {
		const batch = batches++;
		if (batch > COUNT) return;
		const count = (value: number) => Math.min(Math.max(Math.floor(value) || 0, 0), COUNT);
		const request = {
			batch,
			kind: stats.kind,
			calls: count(stats.calls),
			free: count(stats.free),
			input: count(stats.input),
			cached: count(stats.cached),
			output: count(stats.output),
			overshoots: count(stats.overshoots),
			failures: count(stats.failures),
			stopped: stats.stopped,
		};
		try {
			const value = await cloudToolRequest(
				(requestSignal) =>
					control.call(
						"qorpera_memory_compaction_record",
						{ p_binding: binding, p_request: request },
						requestSignal,
					),
				signal,
			);
			const answer = parseClosedRecord(value, "the answer", ["schema", "batch", "payerConnectionId"]);
			if (answer.schema !== MEMORY_COMPACTION_RECORD_SCHEMA || answer.batch !== batch)
				throw new WireValueError("its batch");
			if (answer.payerConnectionId !== null && !isUuid(answer.payerConnectionId))
				throw new WireValueError("its payer");
		} catch (error) {
			console.error(`Memory compaction was not recorded (${cloudRuntimeErrorCategory(error, signal)})`);
		}
	};
}
