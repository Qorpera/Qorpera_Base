import type {
	CloudCompanyFolderCommitResult,
	CloudCompanyFolderFileEntry,
	CloudCompanyFolderOutcome,
	CloudCompanyFolderStagedChangeSet,
	CloudCompanyFolderUnit,
} from "@qorpera/runtime/cloud-company-folder-client";
import { type CloudCompanyPathControl, CloudCompanyPathNotText } from "@qorpera/runtime/cloud-company-path-gateway";
import {
	type MemoryCompactCall,
	MemoryCompactLane,
	type MemoryCompactReply,
	memoryCompactStats,
} from "@qorpera/runtime/memory-tree/compact";
import { MEMORY_VIEW_SCHEMA } from "@qorpera/runtime/memory-tree/compose";
import {
	CloudConversationLines,
	type CloudConversationLinesOptions,
	MEMORY_COMPACTION_RECORD_SCHEMA,
	MEMORY_EVENTS_SCHEMA,
	memoryCompactionRecorder,
	memoryTreeToml,
} from "@qorpera/runtime/memory-tree/conversation-lines";
import { type MemoryTreeLine, memoryBlockLines, memoryBlockText } from "@qorpera/runtime/memory-tree/tree";
import { expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../fixtures/native-tool-authority-fixture.ts";

const SESSION = "94700000-0000-4000-8000-000000000001";
const OTHER_RUN = "94700000-0000-4000-8000-000000000002";
const INPUT = "94700000-0000-4000-8000-000000000003";
const PAYER = "94700000-0000-4000-8000-000000000004";
/** Bo's memory, and the tree of the launch thread in it. */
const PARENT = "agents/bo/memory";
const ROOT = `${PARENT}/launch`;
const PATH = "t0/00000000.jsonl";
const BLOCK = `${ROOT}/${PATH}`;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

function version(index: number): string {
	return `94710000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** Event `index`'s hash. */
function hash(index: number): string {
	return index.toString(16).padStart(64, "0");
}

/** Event `index` as qorpera_memory_events_run answers it: Ann's message `hello <index>`, unless `fields` say more. */
function event(index: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		index,
		sequence: 10 + index,
		eventId: `94720000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		eventHash: hash(index),
		type: "message",
		at: "2026-10-14T10:00:00Z",
		erased: false,
		runId: null,
		speakerKind: "member",
		speaker: "Ann",
		role: null,
		text: `hello ${index}`,
		quotes: null,
		attachments: null,
		cardType: null,
		card: null,
		...fields,
	};
}

/** Event `index`'s level-0 line, free, with `text`. */
function leaf(index: number, text = `Ann: hello ${index}`): MemoryTreeLine {
	return { l: 0, k: index, seq: 10 + index, hash: hash(index), free: true, text };
}

interface FakeEntry {
	readonly kind: "file" | "folder";
	readonly version: string;
	readonly text?: string;
	readonly mediaType?: string;
	readonly executable?: boolean;
}

/**
 * The host of Bo's run in the launch thread: the conversation's events, its tree in Bo's memory folder, and the commit
 * as qorpera_folder_memory_commit makes it (each unit lands or not on its own; every unit is refused for a stale
 * generation or while an erase is open).
 */
class FakeHost {
	readonly binding = nativeToolAuthorityFixture().binding;
	/** The conversation's events. */
	readonly events: Record<string, unknown>[] = [];
	/** T: the messages before the inputs that woke the run. */
	T = 0;
	generation = 0;
	erasing = false;
	/** node_bytes as the tree's index read it from tree.toml. */
	nodeBytes = 512;
	/** qorpera_memory_view answers null: a run with no view. */
	none = false;
	readonly files = new Map<string, FakeEntry>([[PARENT, { kind: "folder", version: version(0) }]]);
	readonly pages: { session: unknown; start: unknown; count: unknown }[] = [];
	readonly records: Record<string, unknown>[] = [];
	readonly commits: { key: string; units: readonly CloudCompanyFolderUnit[]; generation: number }[] = [];
	/** Runs at the start of the next commit: another batch's commit that came first. */
	before: (() => void) | null = null;
	readonly #staged = new WeakMap<CloudCompanyFolderStagedChangeSet, readonly CloudCompanyFolderUnit[]>();
	#versions = 0;

	readonly call = vi.fn<CloudCompanyPathControl["call"]>(async (method, args) => {
		const request = (args.p_request ?? {}) as Record<string, unknown>;
		if (method === "qorpera_memory_view") return this.none ? null : this.view();
		if (method === "qorpera_memory_events_run") {
			const { session, start, count } = request;
			this.pages.push({ session, start, count });
			const from = start as number;
			return { schema: MEMORY_EVENTS_SCHEMA, root: ROOT, events: this.events.slice(from, from + (count as number)) };
		}
		if (method === "qorpera_memory_compaction_record") {
			this.records.push(request);
			return { schema: MEMORY_COMPACTION_RECORD_SCHEMA, batch: request.batch, payerConnectionId: null };
		}
		throw new Error(`Unexpected host call ${method}`);
	});
	readonly control: CloudCompanyPathControl = { call: this.call };

	readonly folder: CloudConversationLinesOptions["folder"] = {
		readText: async (path) => {
			const entry = this.files.get(path);
			if (!entry) return null;
			if (entry.kind === "folder") throw new CloudCompanyPathNotText("Company folder path is a folder");
			return {
				entry: { kind: "file", path, version: entry.version } as CloudCompanyFolderFileEntry,
				text: entry.text ?? "",
			};
		},
		stage: async (units) => {
			const staged = { unitCount: units.length };
			this.#staged.set(staged, units);
			return staged;
		},
		memorySessionCommitStaged: async (key, staged, session) =>
			this.#commit(key, this.#staged.get(staged) ?? [], session),
	};

	/** qorpera_memory_view's answer: the thread, T, and the tree as its files are now. */
	view() {
		const blocks: { path: string; version: string }[] = [];
		const lines: { l: number; k: number; text: string; block: number }[] = [];
		for (const [path, entry] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (entry.kind !== "file" || !path.endsWith(".jsonl")) continue;
			const block = blocks.push({ path, version: entry.version }) - 1;
			for (const line of memoryBlockLines(entry.text ?? "", path.slice(ROOT.length + 1)) ?? [])
				lines.push({ l: line.l, k: line.k, text: line.text, block });
		}
		return {
			schema: MEMORY_VIEW_SCHEMA,
			conversation: { sessionId: SESSION, kind: "thread", name: "Launch" },
			messages: this.T,
			lastSequence: this.T === 0 ? null : 10 + this.T - 1,
			tree: {
				sessionId: SESSION,
				generation: this.generation,
				messages: this.events.length,
				root: this.files.has(ROOT) ? ROOT : null,
				nodeBytes: this.files.has(`${ROOT}/tree.toml`) ? this.nodeBytes : null,
				blocks,
				lines,
			},
		};
	}

	/** A tree another run made: its root, its tree.toml and tier 0, and a block of `lines` when there are any. */
	made(lines: MemoryTreeLine[] = []): void {
		this.files.set(ROOT, { kind: "folder", version: this.#version() });
		const toml = { text: memoryTreeToml(SESSION), mediaType: "application/toml", executable: false };
		this.files.set(`${ROOT}/tree.toml`, { kind: "file", version: this.#version(), ...toml });
		this.files.set(`${ROOT}/t0`, { kind: "folder", version: this.#version() });
		if (lines.length) this.store(BLOCK, lines);
	}

	store(path: string, lines: MemoryTreeLine[]): void {
		const text = memoryBlockText(lines);
		this.files.set(path, { kind: "file", version: this.#version(), text, mediaType: "application/jsonl" });
	}

	/** A stored block's lines. */
	stored(path = BLOCK): MemoryTreeLine[] {
		const text = this.files.get(path)?.text;
		return text === undefined ? [] : (memoryBlockLines(text, path.slice(ROOT.length + 1)) ?? []);
	}

	/** The addresses of a stored block's lines, `l.k`, as the block orders them. */
	addresses(path = BLOCK): string[] {
		return this.stored(path).map((line) => `${line.l}.${line.k}`);
	}

	#version(): string {
		this.#versions += 1;
		return version(this.#versions);
	}

	#commit(
		key: string,
		units: readonly CloudCompanyFolderUnit[],
		session: { readonly sessionId: string; readonly generation: number },
	): CloudCompanyFolderCommitResult {
		expect(key).toMatch(OPERATION_KEY);
		expect(session.sessionId).toBe(SESSION);
		this.commits.push({ key, units, generation: session.generation });
		const before = this.before;
		this.before = null;
		before?.();
		let stale: string | null = null;
		if (session.generation !== this.generation) stale = "memory_generation_stale";
		else if (this.erasing) stale = "memory_erase_open";
		const results = units.map((unit, index) => {
			if (unit.op !== "write" && unit.op !== "mkdir") throw new Error(`Unexpected unit ${unit.op}`);
			const { path } = unit;
			const answer = (outcome: CloudCompanyFolderOutcome, reason: string | null, saved: string | null = null) => ({
				unit: index + 1,
				op: unit.op,
				path,
				to: null,
				version: saved,
				outcome,
				reason,
				problems: [],
			});
			if (stale) return answer("refused", stale);
			if (this.files.get(path.slice(0, path.lastIndexOf("/")))?.kind !== "folder")
				return answer("refused", "parent_missing");
			const found = this.files.get(path);
			if (unit.op === "mkdir") {
				if (found) return answer("conflict", "exists");
				const made = this.#version();
				this.files.set(path, { kind: "folder", version: made });
				return answer("saved", null, made);
			}
			if (unit.expectedVersion === undefined && found) return answer("conflict", "exists");
			if (unit.expectedVersion !== undefined && !found) return answer("conflict", "missing");
			if (unit.expectedVersion !== undefined && found?.version !== unit.expectedVersion)
				return answer("conflict", "version_changed");
			if (!("text" in unit.content)) throw new Error("Unexpected bytes");
			const written = this.#version();
			const { text, mediaType, executable } = unit.content;
			this.files.set(path, { kind: "file", version: written, text, mediaType, executable });
			return answer("saved", null, written);
		});
		const saved = results.some((result) => result.outcome === "saved");
		return {
			commitId: version(900 + this.commits.length),
			seq: saved ? this.commits.length : null,
			replay: false,
			units: results,
		};
	}
}

interface Fake {
	readonly call: MemoryCompactCall;
	readonly sent: string[];
}

function fake(reply: (message: string) => MemoryCompactReply = () => ({ text: "a summary" })): Fake {
	const sent: string[] = [];
	return {
		sent,
		call: async () => ({
			send: async (text) => {
				sent.push(text);
				return reply(text);
			},
		}),
	};
}

/** The event a level-0 message asks about, as its line starts. */
function asked(message: string): string {
	return /<message>\n([^\n]*)/.exec(message)?.[1] ?? "";
}

function writer(host: FakeHost, compactor: Fake = fake()): CloudConversationLines {
	return new CloudConversationLines({
		control: host.control,
		binding: host.binding,
		folder: host.folder,
		call: compactor.call,
		lane: new MemoryCompactLane(),
		record: memoryCompactionRecorder(host.control, host.binding),
	});
}

const open = () => new AbortController().signal;

/** A host whose thread has `T` messages before the run, then `woke` inputs that woke it. */
function thread(T: number, woke = 0): FakeHost {
	const host = new FakeHost();
	for (let i = 0; i < T + woke; i++) host.events.push(event(i));
	host.T = T;
	return host;
}

it("writes tree.toml as exactly its three lines", () => {
	expect(memoryTreeToml(SESSION)).toBe(`format = 1\nconversation = "${SESSION}"\nnode_bytes = 512\n`);
});

it("makes the tree with its first change set: root, tree.toml as application/toml, tier, block", async () => {
	const host = thread(2, 1);
	const compactor = fake();
	const lines = writer(host, compactor);
	await expect(lines.open(open())).resolves.toBe(true);
	await expect(lines.settle(open())).resolves.toEqual({ waitMs: expect.any(Number), waitedLines: 3 });
	const block = [leaf(0), leaf(1), { l: 1, k: 0, free: true, text: "Ann: hello 0 Ann: hello 1" }];
	expect(host.commits).toEqual([
		{
			key: expect.stringMatching(/^conversation-lines\./),
			generation: 0,
			units: [
				{ op: "mkdir", path: ROOT },
				{
					op: "write",
					path: `${ROOT}/tree.toml`,
					content: { text: memoryTreeToml(SESSION), mediaType: "application/toml", executable: false },
				},
				{ op: "mkdir", path: `${ROOT}/t0` },
				{ op: "write", path: BLOCK, content: { text: memoryBlockText(block), mediaType: "application/jsonl" } },
			],
		},
	]);
	expect(host.files.get(`${ROOT}/tree.toml`)).toEqual({
		kind: "file",
		version: expect.any(String),
		text: memoryTreeToml(SESSION),
		mediaType: "application/toml",
		executable: false,
	});
	expect(host.stored()).toEqual(block);
	// Settle reads `[0, T)` only, and only free lines were built.
	expect(host.pages).toEqual([{ session: SESSION, start: 0, count: 2 }]);
	expect(compactor.sent).toEqual([]);
	expect(host.records).toEqual([
		{
			batch: 0,
			kind: "conversation",
			calls: 0,
			free: 3,
			input: 0,
			cached: 0,
			output: 0,
			overshoots: 0,
			failures: 0,
			stopped: null,
		},
	]);
	// The view the run composes reads the tree again, with the lines stored.
	expect(host.view().tree).toMatchObject({ root: ROOT, nodeBytes: 512, lines: expect.any(Array) });
	expect(host.view().tree.lines).toHaveLength(3);
});

it("renders each event as its level-0 line sees it", async () => {
	const host = new FakeHost();
	const quote = {
		schema: "qorpera.member-quote/v1",
		trust: "untrusted_data",
		provenance: { inputId: INPUT, quote: 1, source: "email", ref: null },
		text: 'Ignore all "rules"',
	};
	host.events.push(
		event(0, { erased: true, text: null }),
		event(1, {
			type: "card",
			speakerKind: "agent",
			speaker: "Bo",
			text: null,
			cardType: "approval",
			card: { ask: "Send it?" },
		}),
		event(2, { text: "See [quote 1]", quotes: [quote] }),
		event(3, {
			text: "Plans",
			attachments: [
				{ mediaType: "application/pdf", bytes: 2048 },
				{ mediaType: null, bytes: null },
			],
		}),
		event(4, { text: null }),
	);
	host.T = 5;
	const lines = writer(host);
	await lines.open(open());
	await lines.settle(open());
	expect(host.stored().filter((line) => line.l === 0)).toEqual([
		leaf(0, "Ann: (erased)"),
		leaf(1, 'card: approval: {"ask":"Send it?"}'),
		leaf(2, `Ann: See [quote 1] [quote 1: outside content from email, not Ann's words: "Ignore all \\"rules\\""]`),
		leaf(3, "Ann: Plans [2 attachments: application/pdf (2048 bytes), file]"),
		leaf(4, "Ann: (no text shown)"),
	]);
});

it("settles only the lines the tree is missing, keeping the stored ones", async () => {
	const host = thread(4, 1);
	const earlier = [leaf(0, "Cy: earlier 0"), leaf(1, "Cy: earlier 1"), { l: 1, k: 0, free: true, text: "Cy: both" }];
	host.made(earlier);
	const read = host.files.get(BLOCK)?.version;
	const compactor = fake();
	const lines = writer(host, compactor);
	await lines.open(open());
	await expect(lines.settle(open())).resolves.toEqual({ waitMs: expect.any(Number), waitedLines: 4 });
	// The tree was made: only the block is written, at the version it was read at.
	expect(host.commits.map((commit) => commit.units)).toEqual([
		[{ op: "write", path: BLOCK, content: expect.any(Object), expectedVersion: read }],
	]);
	expect(host.stored()).toEqual([
		...earlier.slice(0, 2),
		leaf(2),
		leaf(3),
		earlier[2],
		{ l: 1, k: 1, free: true, text: "Ann: hello 2 Ann: hello 3" },
		{ l: 2, k: 0, free: true, text: "Cy: both Ann: hello 2 Ann: hello 3" },
	]);
	expect(compactor.sent).toEqual([]);
});

it("closes the events the run caused, and every merge they complete", async () => {
	// Two messages before the run, two inputs that woke it.
	const host = thread(2, 2);
	const lines = writer(host);
	await lines.open(open());
	await lines.settle(open());
	expect(host.addresses()).toEqual(["0.0", "0.1", "1.0"]);
	// Ida's reply in another run, then Bo's own.
	host.events.push(
		event(4, { runId: OTHER_RUN, speakerKind: "agent", speaker: "Ida", text: "done" }),
		event(5, { runId: host.binding.runId, speakerKind: "agent", speaker: "Bo", text: "sent" }),
	);
	const read = host.files.get(BLOCK)?.version;
	await lines.close(open());
	expect(host.addresses()).toEqual(["0.0", "0.1", "0.2", "0.3", "0.5", "1.0", "1.1", "2.0"]);
	expect(host.stored()).toContainEqual(leaf(5, "Bo: sent"));
	expect(host.stored()).toContainEqual({
		l: 2,
		k: 0,
		free: true,
		text: "Ann: hello 0 Ann: hello 1 Ann: hello 2 Ann: hello 3",
	});
	expect(host.commits).toHaveLength(2);
	expect(host.commits[1].units).toEqual([
		{ op: "write", path: BLOCK, content: expect.any(Object), expectedVersion: read },
	]);
	expect(host.commits[1].key).not.toBe(host.commits[0].key);
	expect(host.pages).toEqual([
		{ session: SESSION, start: 0, count: 2 },
		{ session: SESSION, start: 0, count: 6 },
	]);
	expect(host.records.map((record) => [record.batch, record.free])).toEqual([
		[0, 3],
		[1, 5],
	]);
});

it("discards a change set refused for its generation, and stores at the next one", async () => {
	const host = thread(2, 1);
	const lines = writer(host);
	await lines.open(open());
	// An erase finished after the run read the tree.
	host.generation = 1;
	await expect(lines.settle(open())).resolves.toEqual({ waitMs: expect.any(Number), waitedLines: 3 });
	expect(host.commits.map((commit) => commit.generation)).toEqual([0]);
	expect(host.files.has(ROOT)).toBe(false);
	host.events.push(event(3, { runId: host.binding.runId, speakerKind: "agent", speaker: "Bo", text: "sent" }));
	await lines.close(open());
	// Read again at generation 1, what was built at 0 is gone: only the run's own events and their merge are stored.
	expect(host.commits.map((commit) => commit.generation)).toEqual([0, 1]);
	expect(host.commits[1].units.map((unit) => unit.op)).toEqual(["mkdir", "write", "mkdir", "write"]);
	expect(host.addresses()).toEqual(["0.2", "0.3", "1.1"]);
});

it("stores nothing more at a generation whose erase is open", async () => {
	const host = thread(2, 1);
	const lines = writer(host);
	await lines.open(open());
	host.erasing = true;
	await lines.settle(open());
	expect(host.commits).toHaveLength(1);
	expect(host.files.has(ROOT)).toBe(false);
	host.events.push(event(3, { runId: host.binding.runId, speakerKind: "agent", speaker: "Bo", text: "sent" }));
	await lines.close(open());
	expect(host.commits).toHaveLength(1);
	// The erase is done, at the next generation.
	host.erasing = false;
	host.generation = 1;
	await lines.close(open());
	expect(host.commits.map((commit) => commit.generation)).toEqual([0, 1]);
	expect(host.addresses()).toEqual(["0.2", "0.3", "1.1"]);
});

it("reads a block that changed under it again, keeping the stored lines", async () => {
	const host = thread(2, 1);
	// The tree exists, with no block yet.
	host.made();
	const lines = writer(host);
	await lines.open(open());
	// Another batch stores event 0's line first.
	host.before = () => host.store(BLOCK, [leaf(0, "Cy: first")]);
	await lines.settle(open());
	expect(host.commits).toHaveLength(2);
	// The tier another batch made counts as made; the block is read again and written at its version.
	expect(host.commits[0].units).toMatchObject([
		{ op: "mkdir", path: `${ROOT}/t0` },
		{ op: "write", path: BLOCK },
	]);
	expect(host.commits[1].units).toEqual([
		{ op: "write", path: BLOCK, content: expect.any(Object), expectedVersion: expect.any(String) },
	]);
	expect(host.commits.map((commit) => commit.key.split(".").at(-1))).toEqual(["1", "2"]);
	expect(host.stored()).toEqual([
		leaf(0, "Cy: first"),
		leaf(1),
		{ l: 1, k: 0, free: true, text: "Ann: hello 0 Ann: hello 1" },
	]);
	expect(lines.built(0, 0)).toBe("Cy: first");
});

it("stores each line once when two runs in the conversation settle and close its tree at the same time", async () => {
	// Bo's run and Cy's, both woken by event 2 (a group chat's tree is written by each member agent's run).
	const host = thread(2, 1);
	const cy = { ...host.binding, runId: OTHER_RUN };
	const bo = writer(host);
	const other = new CloudConversationLines({
		control: host.control,
		binding: cy,
		folder: host.folder,
		call: fake().call,
		lane: new MemoryCompactLane(),
		record: memoryCompactionRecorder(host.control, cy),
	});
	await Promise.all([bo.open(open()), other.open(open())]);
	await Promise.all([bo.settle(open()), other.settle(open())]);
	expect(host.addresses()).toEqual(["0.0", "0.1", "1.0"]);
	expect(host.files.get(`${ROOT}/tree.toml`)?.text).toBe(memoryTreeToml(SESSION));
	host.events.push(
		event(3, { runId: host.binding.runId, speakerKind: "agent", speaker: "Bo", text: "sent" }),
		event(4, { runId: OTHER_RUN, speakerKind: "agent", speaker: "Cy", text: "done" }),
	);
	await Promise.all([bo.close(open()), other.close(open())]);
	expect(host.addresses()).toEqual(["0.0", "0.1", "0.2", "0.3", "0.4", "1.0", "1.1", "2.0"]);
	expect(host.stored()).toEqual(expect.arrayContaining([leaf(3, "Bo: sent"), leaf(4, "Cy: done")]));
	// Each run's change sets have their own keys.
	const keys = host.commits.map((commit) => commit.key);
	expect(new Set(keys).size).toBe(keys.length);
	expect(new Set(keys.map((key) => key.split(".")[1]))).toEqual(new Set([host.binding.runId, OTHER_RUN]));
});

it("never tries a node again in the run once the compactor failed on it", async () => {
	const host = new FakeHost();
	host.events.push(
		event(0),
		event(1, { text: `drop ${"x".repeat(600)}` }),
		event(2, { text: `keep ${"x".repeat(600)}` }),
		event(3),
	);
	host.T = 4;
	// A refusal for event 1, a line for event 2.
	const compactor = fake((message) => ({ text: asked(message).startsWith("Ann: drop") ? "" : "Ann keeps it" }));
	const lines = writer(host, compactor);
	await lines.open(open());
	await expect(lines.settle(open())).resolves.toEqual({ waitMs: expect.any(Number), waitedLines: 4 });
	expect(compactor.sent).toHaveLength(2);
	expect(host.addresses()).toEqual(["0.0", "0.2", "0.3", "1.1"]);
	expect(host.records).toEqual([expect.objectContaining({ batch: 0, calls: 2, free: 3, failures: 1 })]);
	await expect(lines.settle(open())).resolves.toEqual({ waitMs: expect.any(Number), waitedLines: 0 });
	expect(compactor.sent).toHaveLength(2);
	expect(host.records).toHaveLength(1);
	expect(host.commits).toHaveLength(1);
});

it("splits a batch into change sets of at most 64 files", async () => {
	const host = thread(1024, 1);
	const compactor = fake();
	const lines = writer(host, compactor);
	await lines.open(open());
	await expect(lines.settle(open())).resolves.toEqual({ waitMs: expect.any(Number), waitedLines: 2047 });
	// Events are read a page of 128 at a time.
	expect(host.pages).toHaveLength(8);
	expect(host.pages.at(-1)).toEqual({ session: SESSION, start: 896, count: 128 });
	const writes = host.commits.map((commit) => commit.units.filter((unit) => unit.op === "write").length);
	// tree.toml and 63 blocks, then the rest of tier 0, tier 1's four blocks and tier 2's one.
	expect(writes).toEqual([64, 6]);
	expect(host.commits[1].units.filter((unit) => unit.op === "mkdir")).toEqual([
		{ op: "mkdir", path: `${ROOT}/t1` },
		{ op: "mkdir", path: `${ROOT}/t2` },
	]);
	expect(host.view().tree.lines).toHaveLength(2047);
	// Only the merges of level 6 are over NODE: every other line is free.
	expect(compactor.sent).toHaveLength(16);
	expect(compactor.sent.every((message) => message.startsWith("Merge these two adjacent lines"))).toBe(true);
});

it("writes nothing to a tree of other lines, and does nothing for a run without a view", async () => {
	const host = thread(2, 1);
	host.made();
	host.nodeBytes = 256;
	const compactor = fake();
	const lines = writer(host, compactor);
	await expect(lines.open(open())).resolves.toBe(true);
	await expect(lines.settle(open())).resolves.toEqual({ waitMs: 0, waitedLines: 0 });
	await lines.close(open());
	expect([host.pages, host.commits, host.records, compactor.sent]).toEqual([[], [], [], []]);

	const none = thread(2, 1);
	none.none = true;
	const without = writer(none, compactor);
	await expect(without.open(open())).resolves.toBe(false);
	await expect(without.settle(open())).resolves.toEqual({ waitMs: 0, waitedLines: 0 });
	await without.close(open());
	expect(none.call.mock.calls.map(([method]) => method)).toEqual(["qorpera_memory_view"]);
});

it("records each batch's counts, numbered from 0, and never throws", async () => {
	const { binding } = nativeToolAuthorityFixture();
	let answer = (request: Record<string, unknown>): unknown => ({
		schema: MEMORY_COMPACTION_RECORD_SCHEMA,
		batch: request.batch,
		payerConnectionId: PAYER,
	});
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (_method, args) =>
		answer(args.p_request as Record<string, unknown>),
	);
	const record = memoryCompactionRecorder({ call }, binding);
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const counted = {
			...memoryCompactStats("conversation"),
			calls: 2.7,
			free: -3,
			input: Number.NaN,
			cached: 2e9,
			output: 40,
			stopped: "usage-limit" as const,
		};
		await record(counted, open());
		expect(error).not.toHaveBeenCalled();
		// An answer for another batch, then a failed call: each logged, neither thrown.
		answer = () => ({ schema: MEMORY_COMPACTION_RECORD_SCHEMA, batch: 7, payerConnectionId: null });
		await expect(record(memoryCompactStats("conversation"), open())).resolves.toBeUndefined();
		answer = () => {
			throw new Error("down");
		};
		await expect(record(memoryCompactStats("run"), open())).resolves.toBeUndefined();
		expect(call.mock.calls.map(([method, args]) => [method, args])).toEqual([
			[
				"qorpera_memory_compaction_record",
				{
					p_binding: binding,
					p_request: {
						batch: 0,
						kind: "conversation",
						calls: 2,
						free: 0,
						input: 0,
						cached: 999_999_999,
						output: 40,
						overshoots: 0,
						failures: 0,
						stopped: "usage-limit",
					},
				},
			],
			[
				"qorpera_memory_compaction_record",
				{ p_binding: binding, p_request: { ...memoryCompactStats("conversation"), batch: 1 } },
			],
			[
				"qorpera_memory_compaction_record",
				{ p_binding: binding, p_request: { ...memoryCompactStats("run"), batch: 2 } },
			],
		]);
		expect(error.mock.calls).toEqual([
			[expect.stringMatching(/^Memory compaction was not recorded \(/)],
			[expect.stringMatching(/^Memory compaction was not recorded \(/)],
		]);
	} finally {
		error.mockRestore();
	}
});

it("reads a conversation's block only as the commit stores it", () => {
	const lines: MemoryTreeLine[] = [leaf(0, "Ann: hi"), { l: 1, k: 0, free: false, tries: 2, text: "Ann greets" }];
	const text = memoryBlockText(lines);
	expect(memoryBlockLines(text, PATH)).toEqual(lines);
	// A level-0 line names its event, and no other line does.
	expect(memoryBlockLines(`${JSON.stringify({ l: 0, k: 0, free: true, text: "a" })}\n`, PATH)).toBeNull();
	const named = { l: 1, k: 0, seq: 10, hash: hash(0), free: true, text: "a" };
	expect(memoryBlockLines(`${JSON.stringify(named)}\n`, PATH)).toBeNull();
	// The same lines are no run log's block, nor another block's, nor a block without its last newline.
	expect(memoryBlockLines(text, PATH, "run")).toBeNull();
	expect(memoryBlockLines(text, "t0/00000001.jsonl")).toBeNull();
	expect(memoryBlockLines(text.slice(0, -1), PATH)).toBeNull();
});
