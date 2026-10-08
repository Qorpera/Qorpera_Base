import { CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA } from "@qorpera/runtime/cloud-native-context-composition";
import type { CloudRunLogCommitted, CloudRunTreeBlock } from "@qorpera/runtime/cloud-run-log";
import {
	type MemoryCompactCall,
	MemoryCompactLane,
	type MemoryCompactReply,
	type MemoryCompactStats,
	memoryCompactLeafPrompt,
} from "@qorpera/runtime/memory-tree/compact";
import { memoryRenderStep } from "@qorpera/runtime/memory-tree/render";
import { cloudRunWorkMessage } from "@qorpera/runtime/memory-tree/run-work";
import {
	CloudRunStepLines,
	type CloudRunStepLinesLog,
	type CloudRunStepLinesOptions,
	type CloudRunStepLinesStep,
	cloudRunStepText,
	cloudRunTreeBlockLines,
	RUN_STEP_OUTCOME_UNKNOWN,
} from "@qorpera/runtime/memory-tree/step-lines";
import {
	CLOSE_MS,
	type MemoryTreeLine,
	memoryBlockText,
	memoryFreeLeaf,
	PLACEHOLDER,
	RUN_VIEW,
	SETTLE_MS,
} from "@qorpera/runtime/memory-tree/tree";
import { expect, it, vi } from "vitest";

const RUN = "0f0e0d0c-0b0a-4908-8706-050403020100";
const PATH = "t0/00000000.jsonl";
const BUDGET = RUN_VIEW / 2;

/** A run's log as the writer uses it, with its tree's blocks in memory. */
class FakeLog implements CloudRunStepLinesLog {
	readonly runId = RUN;
	/** The generation as the log last found it, and as the database has it now. */
	found = 0;
	database = 0;
	/** This process's steps as committed, and a resumed run's earlier ones. */
	readonly own: CloudRunStepLinesStep[] = [];
	before: CloudRunStepLinesStep[] = [];
	readonly files = new Map<string, { version: string; text: string }>();
	readonly commits: { key: string; blocks: readonly CloudRunTreeBlock[]; generation: number }[] = [];
	/** What every commit answers, when set. */
	answer: "stale" | "gone" | null = null;
	#versions = 0;
	readonly #listeners = new Set<(batch: CloudRunLogCommitted) => void>();

	generation(): number {
		return this.found;
	}
	steps(): readonly CloudRunStepLinesStep[] {
		return [...this.own];
	}
	async earlier(): Promise<readonly CloudRunStepLinesStep[]> {
		return this.before;
	}
	async flush(): Promise<void> {}
	async treeRead(path: string): Promise<{ version: string; text: string } | null> {
		return this.files.get(path) ?? null;
	}
	async commitTree(
		key: string,
		blocks: readonly CloudRunTreeBlock[],
		generation: number,
	): Promise<"landed" | "stale" | "gone"> {
		this.commits.push({ key, blocks, generation });
		if (this.answer) return this.answer;
		if (
			generation !== this.database ||
			blocks.some((block) => (this.files.get(block.path)?.version ?? null) !== block.version)
		)
			return "stale";
		for (const block of blocks) this.files.set(block.path, { version: `v${++this.#versions}`, text: block.text });
		return "landed";
	}
	onCommitted(listener: (batch: CloudRunLogCommitted) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Commits steps as a batch of the log does, and tells its listeners. */
	commit(...steps: CloudRunStepLinesStep[]): void {
		this.own.push(...steps);
		const batch = { runId: RUN, steps: steps.map((step) => step.j), blocks: [], generation: this.found };
		for (const listener of this.#listeners) listener(batch);
	}

	/** A stored block's lines. */
	lines(path = PATH): MemoryTreeLine[] {
		const file = this.files.get(path);
		return file ? (cloudRunTreeBlockLines(file.text, path) ?? []) : [];
	}
}

function step(j: number, text: string, fields: Partial<CloudRunStepLinesStep> = {}): CloudRunStepLinesStep {
	return {
		j,
		call: `call_${j}`,
		tool: "company_read",
		args: "{}",
		result: '{"ok":true}',
		text,
		hashOnly: false,
		at: "2026-10-09T10:00:00Z",
		...fields,
	};
}

/** Agent text too long for its step to be a free node, named by its first word. */
function long(name: string): string {
	return `${name} ${"x".repeat(600)}`;
}

function rendered(text: string): string {
	return memoryRenderStep({ tool: "company_read", args: "{}", result: '{"ok":true}', text });
}

interface Fake {
	readonly call: MemoryCompactCall;
	readonly sent: string[];
}

function fake(reply: (message: string) => MemoryCompactReply): Fake {
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

/** What a message asks about: block 2's step by its first word, or the two lines' names joined by `+`. */
function subject(message: string): string {
	const merged = [...message.matchAll(/<line>(\S+)/g)].map((match) => match[1]);
	if (merged.length > 0) return merged.join("+");
	return /<step>\n(\S+)/.exec(message)?.[1] ?? "?";
}

/** A reply too long for two to join into a free parent. */
function named(message: string): MemoryCompactReply {
	return { text: `${subject(message)} ${".".repeat(300)}` };
}

function writer(log: FakeLog, call: MemoryCompactCall, options: Partial<CloudRunStepLinesOptions> = {}) {
	return new CloudRunStepLines({
		log,
		call,
		lane: new MemoryCompactLane(),
		signal: new AbortController().signal,
		...options,
	});
}

const open = () => new AbortController().signal;

it("renders a step as its level-0 line sees it", () => {
	expect(cloudRunStepText(step(0, "Reading it."), false)).toBe(rendered("Reading it."));
	expect(cloudRunStepText(step(0, "", { args: "", result: null, at: "", erased: true }), true)).toBe(
		"company_read: (erased)",
	);
	// A narrow step's line names its tool only, whatever its record held.
	expect(cloudRunStepText(step(0, "the secret plan", { narrow: true }), false)).toBe("company_read");
	expect(cloudRunStepText(step(0, "", { narrow: true, erased: true, result: null }), true)).toBe("company_read");
	// A step an earlier process left with no result, and one of this process still waiting for it.
	expect(cloudRunStepText(step(0, "Sending.", { result: null }), true)).toBe(
		memoryRenderStep({ tool: "company_read", args: "{}", result: RUN_STEP_OUTCOME_UNKNOWN, text: "Sending." }),
	);
	expect(cloudRunStepText(step(0, "Sending.", { result: null }), false)).toBeNull();
});

it("reads a block only as the commit stores it", () => {
	const lines: MemoryTreeLine[] = [
		{ l: 0, k: 0, free: true, text: "a" },
		{ l: 1, k: 0, free: false, tries: 2, text: "a and b" },
	];
	const text = memoryBlockText(lines, "run");
	expect(cloudRunTreeBlockLines(text, PATH)).toEqual(lines);
	expect(cloudRunTreeBlockLines(text, "t0/00000001.jsonl")).toBeNull();
	expect(cloudRunTreeBlockLines(text.trimEnd(), PATH)).toBeNull();
	expect(cloudRunTreeBlockLines("", PATH)).toBeNull();
	expect(cloudRunTreeBlockLines(`${text}${text}`, PATH)).toBeNull();
	expect(cloudRunTreeBlockLines('{"l":0,"k":0,"free":true,"text":"a","seq":1}\n', PATH)).toBeNull();
	expect(cloudRunTreeBlockLines('{"l":0,"k":0,"free":true,"text":"a","more":1}\n', PATH)).toBeNull();
	expect(cloudRunTreeBlockLines('{"l":0,"k":0,"free":false,"text":"a"}\n', PATH)).toBeNull();
	expect(cloudRunTreeBlockLines("{not json}\n", PATH)).toBeNull();
});

it("builds a committed batch's free lines and stores them beside the log", async () => {
	const log = new FakeLog();
	const compactor = fake(named);
	const lines = writer(log, compactor.call);
	log.commit(step(0, "a"), step(1, "b"), step(2, "c"));
	await vi.waitFor(() => expect(log.commits).toHaveLength(1));
	const [a, b, c] = ["a", "b", "c"].map((text) => memoryFreeLeaf(rendered(text)) as string);
	expect(log.lines()).toEqual([
		{ l: 0, k: 0, free: true, text: a },
		{ l: 0, k: 1, free: true, text: b },
		{ l: 0, k: 2, free: true, text: c },
		{ l: 1, k: 0, free: true, text: `${a} ${b}` },
	]);
	expect(log.commits[0]).toMatchObject({ generation: 0, blocks: [{ path: PATH, version: null }] });
	expect(compactor.sent).toEqual([]);
	expect(await lines.lines(3, BUDGET, open())).toEqual([`0+1|${a}`, `1+1|${b}`, `2+1|${c}`]);
});

it("builds a resumed run's lines with windows that reach into its earlier steps", async () => {
	const log = new FakeLog();
	log.before = [step(0, long("s0")), step(1, long("s1"))];
	const compactor = fake(named);
	const stats: MemoryCompactStats[] = [];
	const lines = writer(log, compactor.call, { firstStep: 2, observe: (batch) => stats.push({ ...batch }) });
	log.commit(step(2, long("s2")));
	const rows = await lines.lines(3, BUDGET, open());
	expect(compactor.sent).toContain(
		memoryCompactLeafPrompt("run", [rendered(long("s0")), rendered(long("s1"))], rendered(long("s2"))),
	);
	expect(compactor.sent.map(subject).sort()).toEqual(["s0", "s0+s1", "s1", "s2"]);
	expect(log.lines().map(({ l, k, free, tries }) => ({ l, k, free, tries }))).toEqual([
		{ l: 0, k: 0, free: false, tries: 1 },
		{ l: 0, k: 1, free: false, tries: 1 },
		{ l: 0, k: 2, free: false, tries: 1 },
		{ l: 1, k: 0, free: false, tries: 1 },
	]);
	expect(rows).toHaveLength(3);
	expect(stats).toEqual([expect.objectContaining({ kind: "run", calls: 4, free: 0, failures: 0 })]);
});

it("uses a resumed run's stored lines and builds only what is missing", async () => {
	const log = new FakeLog();
	log.before = [step(0, long("s0")), step(1, long("s1"))];
	const stored: MemoryTreeLine[] = [
		{ l: 0, k: 0, free: false, tries: 1, text: "stored zero" },
		{ l: 0, k: 1, free: false, tries: 2, text: "stored one" },
	];
	log.files.set(PATH, { version: "v0", text: memoryBlockText(stored, "run") });
	const compactor = fake(named);
	const lines = writer(log, compactor.call, { firstStep: 2 });
	expect(await lines.lines(2, BUDGET, open())).toEqual(["0+1|stored zero", "1+1|stored one"]);
	// The merge over them is free, and commits over the stored block.
	expect(log.commits).toHaveLength(1);
	expect(log.commits[0].blocks[0].version).toBe("v0");
	log.commit(step(2, "c"));
	await vi.waitFor(() => expect(log.commits).toHaveLength(2));
	expect(log.commits[1].blocks[0].version).toBe("v1");
	expect(compactor.sent).toEqual([]);
	expect(log.lines()).toEqual([
		...stored,
		{ l: 0, k: 2, free: true, text: memoryFreeLeaf(rendered("c")) },
		{ l: 1, k: 0, free: true, text: "stored zero stored one" },
	]);
});

it("builds a step that waited for its result once it has one", async () => {
	const log = new FakeLog();
	const compactor = fake(named);
	const lines = writer(log, compactor.call);
	log.commit(step(0, "a", { result: null }), step(1, "b"));
	await vi.waitFor(() => expect(log.commits).toHaveLength(1));
	expect(log.lines().map(({ l, k }) => [l, k])).toEqual([[0, 1]]);
	log.own[0] = step(0, "a");
	log.commit(step(2, "c"));
	await vi.waitFor(() => expect(log.commits).toHaveLength(2));
	expect(log.lines().map(({ l, k }) => [l, k])).toEqual([
		[0, 0],
		[0, 1],
		[0, 2],
		[1, 0],
	]);
	expect(await lines.lines(3, BUDGET, open())).toHaveLength(3);
});

it("never builds a failed node again in the run", async () => {
	const log = new FakeLog();
	const compactor = fake((message) => (subject(message) === "s0" ? { text: "" } : named(message)));
	const lines = writer(log, compactor.call);
	log.commit(step(0, long("s0")));
	expect(await lines.lines(1, BUDGET, open())).toEqual([`0+1|${PLACEHOLDER}`]);
	log.commit(step(1, long("s1")));
	const rows = await lines.lines(2, BUDGET, open());
	expect(rows[0]).toBe(`0+1|${PLACEHOLDER}`);
	expect(rows[1]).toMatch(/^1\+1\|s1 /);
	// The merge over it waits without a call: the next run builds both.
	expect(compactor.sent.map(subject)).toEqual(["s0", "s1"]);
	expect(log.lines().map(({ l, k }) => [l, k])).toEqual([[0, 1]]);
});

it("discards a stale batch whole, and keeps its lines for this run's view only", async () => {
	const log = new FakeLog();
	log.database = 1;
	const compactor = fake(named);
	const lines = writer(log, compactor.call);
	log.commit(step(0, long("s0")));
	const rows = await lines.lines(1, BUDGET, open());
	expect(rows[0]).toMatch(/^0\+1\|s0 /);
	expect(log.files.size).toBe(0);
	log.found = 1;
	log.commit(step(1, long("s1")));
	await vi.waitFor(() => expect(log.commits).toHaveLength(2));
	expect(log.commits.map((commit) => commit.generation)).toEqual([0, 1]);
	expect(log.lines().map(({ l, k }) => [l, k])).toEqual([
		[0, 1],
		[1, 0],
	]);
	expect(compactor.sent.map(subject)).toEqual(["s0", "s1", "s0+s1"]);
});

it("stops once the log is gone", async () => {
	const log = new FakeLog();
	log.answer = "gone";
	const compactor = fake(named);
	const lines = writer(log, compactor.call);
	log.commit(step(0, "a"));
	await vi.waitFor(() => expect(log.commits).toHaveLength(1));
	log.commit(step(1, long("s1")));
	expect(await lines.lines(2, BUDGET, open())).toEqual([`0+1|${memoryFreeLeaf(rendered("a"))}`, `1+1|${PLACEHOLDER}`]);
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(log.commits).toHaveLength(1);
	expect(compactor.sent).toEqual([]);
});

it("waits up to SETTLE for a missing line, and finishes within CLOSE", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const log = new FakeLog();
		const lines = writer(log, () => new Promise<never>(() => {}));
		log.commit(step(0, long("s0")));
		let rows: readonly string[] | null = null;
		const view = lines.lines(1, BUDGET, open()).then((value) => {
			rows = value;
		});
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
		expect(rows).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		await view;
		expect(rows).toEqual([`0+1|${PLACEHOLDER}`]);
		let finished = false;
		const finish = lines.finish(open()).then(() => {
			finished = true;
		});
		await vi.advanceTimersByTimeAsync(CLOSE_MS - 1);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await finish;
		expect(log.commits).toEqual([]);
	} finally {
		vi.useRealTimers();
	}
});

it("stops waiting when the request is aborted", async () => {
	const log = new FakeLog();
	const lines = writer(log, () => new Promise<never>(() => {}));
	log.commit(step(0, long("s0")));
	const request = new AbortController();
	const view = lines.lines(1, BUDGET, request.signal);
	request.abort(new Error("request ended"));
	await expect(view).rejects.toThrow("request ended");
});

it("finishes after the run's signal ended, and builds nothing after", async () => {
	const log = new FakeLog();
	const compactor = fake(named);
	const run = new AbortController();
	const lines = writer(log, compactor.call, { signal: run.signal });
	// The log's close commits the last steps after the run's signal ended.
	run.abort();
	log.commit(step(0, long("s0")), step(1, "b"));
	await lines.finish(open());
	expect(log.commits).toHaveLength(1);
	expect(log.lines().map(({ l, k, free }) => [l, k, free])).toEqual([
		[0, 0, false],
		[0, 1, true],
		[1, 0, true],
	]);
	log.commit(step(2, "c"));
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(log.commits).toHaveLength(1);
});

it("commits within core §5's change set, under keys the log can try again", async () => {
	const log = new FakeLog();
	const compactor = fake(() => ({ text: "y".repeat(2_000) }));
	const lines = writer(log, compactor.call, { lane: new MemoryCompactLane(64) });
	const T = 288;
	log.commit(...Array.from({ length: T }, (_, j) => step(j, long(`s${j}`))));
	await lines.lines(T, BUDGET, open());
	expect(log.commits.length).toBeGreaterThan(1);
	for (const commit of log.commits) {
		expect(commit.blocks.length).toBeLessThanOrEqual(64);
		expect(commit.blocks.reduce((total, block) => total + Buffer.byteLength(block.text), 0)).toBeLessThanOrEqual(
			1024 * 1024,
		);
		expect(commit.key).toMatch(/^[A-Za-z0-9._:-]{8,190}$/);
		expect(commit.key).not.toMatch(/:[2-4]$/);
	}
	expect(new Set(log.commits.map((commit) => commit.key)).size).toBe(log.commits.length);
	// Every node of [0, 288): 288 + 144 + 72 + 36 + 18 + 9 + 4 + 2 + 1.
	const stored = [...log.files.keys()].flatMap((path) => log.lines(path));
	expect(stored).toHaveLength(574);
});

it("composes a resumed run's requests with its lines", async () => {
	const log = new FakeLog();
	log.before = [step(0, "a"), step(1, "b")];
	const lines = writer(log, fake(named).call, { firstStep: 2 });
	const composed = await lines.composeContext()(
		{
			schema: CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
			requestId: "request_1",
			threadId: "thread_1",
			turnId: "turn_1",
			purpose: "turn",
			model: "gpt-6",
			items: [],
		},
		open(),
	);
	const [a, b] = ["a", "b"].map((text) => memoryFreeLeaf(rendered(text)));
	expect(composed).toEqual({ input: [{ work: cloudRunWorkMessage([`0+1|${a}`, `1+1|${b}`]) }] });
});
