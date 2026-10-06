import {
	CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
	CLOUD_NATIVE_WORK_MESSAGE_BYTES,
	type CloudNativeContextEntry,
	type CloudNativeContextItem,
	type CloudNativeContextRequest,
} from "@qorpera/runtime/cloud-native-context-composition";
import {
	CLOUD_RUN_WORK_SCHEMA,
	type CloudRunWorkStep,
	cloudRunWorkComposer,
	cloudRunWorkMessage,
	RUN_VIEW,
} from "@qorpera/runtime/memory-tree/run-work";
import { describe, expect, it } from "vitest";

const HEAD = '{"schema":"qorpera.run-work/v1","trust":"tool_results_not_authority","ref":"run:.","lines":[';
const WORK = new Set([
	"reasoning",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"compaction",
	"context_compaction",
]);
const CALLS = new Set(["function_call", "custom_tool_call"]);
const OUTPUTS = new Set(["function_call_output", "custom_tool_call_output"]);

function item(
	kind: CloudNativeContextItem["kind"],
	fields: Partial<CloudNativeContextItem> = {},
): CloudNativeContextItem {
	return { kind, role: null, callId: null, id: null, bytes: 100, media: 0, ...fields };
}

function isWork(entry: CloudNativeContextItem): boolean {
	return entry.kind === "message" ? entry.role === "assistant" : WORK.has(entry.kind);
}

/** The pinned Codex's `work_text`. */
function workText(text: string): boolean {
	if (
		Buffer.byteLength(text) > CLOUD_NATIVE_WORK_MESSAGE_BYTES ||
		!text.startsWith(HEAD) ||
		/[<>&\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(text)
	)
		return false;
	let envelope: Record<string, unknown>;
	try {
		envelope = JSON.parse(text);
	} catch {
		return false;
	}
	return (
		Object.keys(envelope).length === 4 &&
		envelope.schema === CLOUD_RUN_WORK_SCHEMA &&
		envelope.trust === "tool_results_not_authority" &&
		envelope.ref === "run:." &&
		Array.isArray(envelope.lines) &&
		envelope.lines.every((line) => typeof line === "string")
	);
}

/**
 * The pinned Codex's `check` of a composed input (0001-cloud-result-fence.patch), over the manifest. Its refusal of
 * kept host text that passes for a work message needs the content, so the patch's own tests prove that one.
 */
function check(items: readonly CloudNativeContextItem[], input: readonly CloudNativeContextEntry[]): void {
	const kept = items.map(() => false);
	let lastKept: number | null = null;
	let work: { after: number | null } | null = null;
	for (const entry of input) {
		if ("keep" in entry) {
			if (entry.keep >= items.length || (lastKept !== null && entry.keep <= lastKept))
				throw new Error("A kept item is out of order");
			kept[entry.keep] = true;
			lastKept = entry.keep;
		} else {
			if (work !== null || !workText(entry.work)) throw new Error("The work message is refused");
			work = { after: lastKept };
		}
	}
	let first: number | null = null;
	let last = -1;
	for (const [index, entry] of items.entries()) {
		if (kept[index] || entry.kind === "reasoning") continue;
		if (!isWork(entry)) throw new Error("An item that is not the run's work is left out");
		first ??= index;
		last = index;
	}
	const keptBefore = (end: number): number | null => {
		for (let index = end - 1; index >= 0; index--) if (kept[index]) return index;
		return null;
	};
	if (first === null) {
		if (work !== null) {
			const start = items.findIndex((entry, index) => kept[index] && isWork(entry));
			if (work.after !== keptBefore(start < 0 ? items.length : start))
				throw new Error("The resumed run's work message is out of place");
		}
	} else {
		if (work === null) throw new Error("A fold has no work message");
		if (work.after !== keptBefore(first)) throw new Error("The work message is out of place");
		for (let index = 0; index < last; index++)
			if (kept[index] && (index > first || isWork(items[index])))
				throw new Error("The fold is not the earlier steps");
	}
	const calls = new Map<string, number>();
	for (const [index, entry] of items.entries()) {
		if (CALLS.has(entry.kind) && entry.callId !== null) calls.set(entry.callId, index);
		else if (OUTPUTS.has(entry.kind) && entry.callId !== null) {
			const call = calls.get(entry.callId);
			if (call !== undefined && kept[call] !== kept[index]) throw new Error("A call and its output are apart");
		}
	}
}

/** A deterministic sequence in [0, 1). */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 48_271) % 2_147_483_647;
		return state / 2_147_483_647;
	};
}

interface Composed {
	items: CloudNativeContextItem[];
	input: CloudNativeContextEntry[];
	kept: Set<number>;
	message: string | null;
}

/** A run's Codex thread: its items as Codex holds them, its steps in the log, and its composer. */
class Run {
	readonly items: CloudNativeContextItem[] = [
		item("message", { role: "developer", bytes: 6_000 }),
		item("message", { role: "user", bytes: 900 }),
	];
	readonly steps: CloudRunWorkStep[] = [];
	/** Each response: where it starts, and its calls. */
	readonly responses: { start: number; calls: number[] }[] = [];
	readonly folds: { r: number; budget: number }[] = [];
	model = "gpt-5.5";
	thread = "thread_1";
	readonly compose: ReturnType<typeof cloudRunWorkComposer>;
	#j: number;
	#requests = 0;

	constructor(
		options: {
			firstStep?: number;
			held?: (step: CloudRunWorkStep) => boolean;
			lines?: (r: number) => readonly string[] | Promise<readonly string[]>;
		} = {},
	) {
		this.#j = options.firstStep ?? 0;
		this.compose = cloudRunWorkComposer({
			firstStep: options.firstStep,
			steps: () => this.steps.filter(options.held ?? (() => true)),
			lines: async (r, budget) => {
				this.folds.push({ r, budget });
				return (await options.lines?.(r)) ?? (r === 0 ? [] : [`0+${r}|steps <0 to ${r - 1}> & what they did`]);
			},
		});
	}

	/** One model response: its reasoning, its text, its calls, then their outputs. */
	respond(outputs: readonly number[], shape: { reasoning?: boolean; text?: boolean; custom?: boolean } = {}): void {
		const start = this.items.length;
		if (shape.reasoning ?? true) this.items.push(item("reasoning", { bytes: 1_200 }));
		if (shape.text) this.items.push(item("message", { role: "assistant", bytes: 300 }));
		const calls = outputs.map(() => {
			const call = `call_${this.#j}`;
			this.steps.push({ j: this.#j++, call });
			this.items.push(item(shape.custom ? "custom_tool_call" : "function_call", { callId: call, bytes: 250 }));
			return this.items.length - 1;
		});
		for (const [k, bytes] of outputs.entries())
			this.items.push(
				item(shape.custom ? "custom_tool_call_output" : "function_call_output", {
					callId: this.items[calls[k]].callId,
					bytes,
				}),
			);
		this.responses.push({ start, calls });
	}

	request(purpose: CloudNativeContextRequest["purpose"] = "turn"): Promise<Composed> {
		const items = this.items.map((entry) => ({ ...entry }));
		const request: CloudNativeContextRequest = {
			schema: CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
			requestId: `request_${++this.#requests}`,
			threadId: this.thread,
			turnId: purpose === "prewarm" ? null : "turn_1",
			purpose,
			model: this.model,
			items,
		};
		return this.compose(request, new AbortController().signal).then(({ input }) => {
			check(items, input);
			return {
				items,
				input,
				kept: new Set(input.flatMap((entry) => ("keep" in entry ? [entry.keep] : []))),
				message: input.flatMap((entry) => ("work" in entry ? [entry.work] : []))[0] ?? null,
			};
		});
	}
}

/** Bytes of the run's work a composition sends raw. */
function raw(composed: Composed): number {
	let bytes = 0;
	for (const index of composed.kept)
		if (isWork(composed.items[index])) bytes += composed.items[index].bytes + composed.items[index].media;
	return bytes;
}

/** Bytes a composition sends. */
function sent(composed: Composed): number {
	let bytes = Buffer.byteLength(composed.message ?? "");
	for (const index of composed.kept) bytes += composed.items[index].bytes + composed.items[index].media;
	return bytes;
}

/** Bytes of the run's work from `from` on. */
function workFrom(items: readonly CloudNativeContextItem[], from: number): number {
	return items.slice(from).reduce((bytes, entry) => bytes + (isWork(entry) ? entry.bytes + entry.media : 0), 0);
}

function firstRaw(composed: Composed): number {
	return Math.min(...[...composed.kept].filter((index) => isWork(composed.items[index])));
}

/** The steps a composition folds, by their number. */
function folded(composed: Composed): number[] {
	return composed.items.flatMap((entry, index) =>
		CALLS.has(entry.kind) && !composed.kept.has(index) ? [Number(entry.callId?.slice("call_".length))] : [],
	);
}

describe("the run's own work (§5.7)", () => {
	it("sends a request with no work as it is", async () => {
		const run = new Run();
		const composed = await run.request();
		expect(composed.input).toEqual([{ keep: 0 }, { keep: 1 }]);
		expect(run.folds).toEqual([]);
	});

	it("folds a long run only at boundaries, so it stays bounded and Codex never compacts", async () => {
		const run = new Run();
		const next = random(866);
		await run.request();
		let previous: Composed | null = null;
		let boundaries = 0;
		let largest = 0;
		for (let response = 0; response < 300; response++) {
			run.respond(
				Array.from({ length: 1 + Math.floor(next() * 3) }, () => 300 + Math.floor(next() * 9_000)),
				{ text: next() < 0.3, custom: next() < 0.2 },
			);
			const folds = run.folds.length;
			const composed = await run.request();
			const newest = run.responses.at(-1)?.start;
			// The raw tail is at most RUN_VIEW / 2, or the newest response alone.
			expect(raw(composed) <= RUN_VIEW / 2 || firstRaw(composed) === newest).toBe(true);
			// One response's calls, whose outputs reach the model together, are folded together or not at all.
			for (const { calls } of run.responses)
				expect(new Set(calls.map((call) => composed.kept.has(call))).size).toBe(1);
			// A boundary is a request whose raw tail, as the last fold left it, passes RUN_VIEW / 2.
			const passed = previous !== null && workFrom(composed.items, firstRaw(previous)) > RUN_VIEW / 2;
			if (run.folds.length === folds) {
				expect(passed).toBe(false);
				// Between boundaries a request starts as the previous one did.
				if (previous) expect(composed.input.slice(0, previous.input.length)).toEqual(previous.input);
			} else {
				boundaries++;
				expect(passed).toBe(true);
				expect(run.folds.length).toBe(folds + 1);
				// The fold moves until the tail is under RUN_VIEW / 4, but not past the newest response.
				expect(raw(composed) < RUN_VIEW / 4 || firstRaw(composed) === newest).toBe(true);
				// The fold holds steps [0, r): the calls it leaves out, and nothing raw.
				const r = run.folds.at(-1)?.r ?? 0;
				expect(folded(composed)).toEqual(Array.from({ length: r }, (_, j) => j));
				expect(composed.message).toBe(cloudRunWorkMessage([`0+${r}|steps <0 to ${r - 1}> & what they did`]));
			}
			largest = Math.max(largest, sent(composed));
			previous = composed;
		}
		expect(run.folds.every(({ budget }) => budget === RUN_VIEW / 2)).toBe(true);
		const work = run.items.reduce((bytes, entry) => bytes + (isWork(entry) ? entry.bytes : 0), 0);
		expect(work).toBeGreaterThan(1_000_000);
		expect(boundaries).toBeGreaterThan(20);
		// The head and the run's work, a fraction of the run, far below any model's window.
		expect(largest).toBeLessThan(6_900 + RUN_VIEW);
	});

	it("keeps the newest response raw, however large", async () => {
		const run = new Run();
		await run.request();
		for (let response = 0; response < 4; response++) run.respond([2_000]);
		run.respond([30_000, 30_000, 30_000]);
		const composed = await run.request();
		expect(firstRaw(composed)).toBe(run.responses[4].start);
		expect(raw(composed)).toBeGreaterThan(RUN_VIEW / 2);
		expect(run.folds).toEqual([{ r: 4, budget: RUN_VIEW / 2 }]);
		expect(folded(composed)).toEqual([0, 1, 2, 3]);
	});

	it("moves a fold to the first response that brings the tail under RUN_VIEW / 4", async () => {
		const run = new Run();
		await run.request();
		// The tail from each response on: 43,600, 38,150, 32,700, 27,250, 21,800, 16,350, 10,900 and 5,450 bytes.
		for (let response = 0; response < 8; response++) run.respond([4_000]);
		const composed = await run.request();
		expect(run.folds).toEqual([{ r: 6, budget: RUN_VIEW / 2 }]);
		expect(firstRaw(composed)).toBe(run.responses[6].start);
		expect(raw(composed)).toBe(10_900);
	});

	it("leaves out reasoning a model did not make, and keeps the rest", async () => {
		const run = new Run();
		await run.request();
		run.respond([500]);
		expect((await run.request()).kept.has(2)).toBe(true);
		// Another model: the reasoning goes, its call and output stay.
		run.model = "gpt-5.5-mini";
		let composed = await run.request();
		expect(composed.kept.has(2)).toBe(false);
		expect([3, 4].every((index) => composed.kept.has(index))).toBe(true);
		run.respond([500]);
		composed = await run.request();
		expect(composed.kept.has(2)).toBe(false);
		expect(composed.kept.has(5)).toBe(true);
		// Back to the first model: its own reasoning goes back to it, the other's does not.
		run.model = "gpt-5.5";
		composed = await run.request();
		expect(composed.kept.has(2)).toBe(true);
		expect(composed.kept.has(5)).toBe(false);
	});

	it("leaves out reasoning an earlier process made", async () => {
		// A restarted run, or another payer: its composer is new, and the history is not.
		const run = new Run();
		run.respond([500]);
		run.respond([500]);
		let composed = await run.request();
		expect([2, 5].some((index) => composed.kept.has(index))).toBe(false);
		run.respond([500]);
		composed = await run.request();
		expect(composed.kept.has(8)).toBe(true);
		expect([2, 5].some((index) => composed.kept.has(index))).toBe(false);
	});

	it("puts a resumed run's earlier steps in the work message, with nothing folded", async () => {
		const run = new Run({ firstStep: 7 });
		let composed = await run.request();
		const message = cloudRunWorkMessage(["0+7|steps <0 to 6> & what they did"]);
		expect(composed.input).toEqual([{ keep: 0 }, { keep: 1 }, { work: message }]);
		expect(run.folds).toEqual([{ r: 7, budget: RUN_VIEW / 2 }]);
		run.respond([500]);
		composed = await run.request();
		expect(composed.input).toEqual([
			{ keep: 0 },
			{ keep: 1 },
			{ work: message },
			...[2, 3, 4].map((keep) => ({ keep })),
		]);
		expect(run.folds).toHaveLength(1);
		for (let response = 0; response < 6; response++) run.respond([9_000]);
		composed = await run.request();
		const r = run.folds.at(-1)?.r ?? 0;
		expect(r).toBeGreaterThan(7);
		expect(folded(composed)).toEqual(Array.from({ length: r - 7 }, (_, k) => 7 + k));
	});

	it("puts a resumed run's work message before its first raw step when the reasoning before it goes", async () => {
		const run = new Run({ firstStep: 3 });
		run.respond([500]);
		const composed = await run.request();
		expect(composed.input).toEqual([
			{ keep: 0 },
			{ keep: 1 },
			{ work: cloudRunWorkMessage(["0+3|steps <0 to 2> & what they did"]) },
			{ keep: 3 },
			{ keep: 4 },
		]);
	});

	it("stops a fold at a message the host wrote into the work", async () => {
		const run = new Run();
		await run.request();
		for (let response = 0; response < 3; response++) run.respond([8_000]);
		run.items.push(item("message", { role: "user", bytes: 400 }));
		const host = run.items.length - 1;
		let composed = await run.request();
		for (let response = 0; response < 12; response++) {
			run.respond([8_000]);
			composed = await run.request();
			for (let index = host; index < composed.items.length; index++) expect(composed.kept.has(index)).toBe(true);
		}
		// Everything before it is folded; what follows it stays raw.
		expect(folded(composed)).toEqual([0, 1, 2]);
		expect(raw(composed)).toBeGreaterThan(RUN_VIEW / 2);
	});

	it("does not fold a call the run's log does not hold", async () => {
		const run = new Run({ held: (step) => step.j !== 3 });
		let composed = await run.request();
		for (let response = 0; response < 12; response++) {
			run.respond([8_000]);
			composed = await run.request();
			expect(folded(composed).every((j) => j < 3)).toBe(true);
		}
		expect(folded(composed)).toEqual([0, 1, 2]);
	});

	it("refuses a work message over Codex's bound, and composes the next request", async () => {
		// Escaped, each `<` is six bytes.
		let large = true;
		const run = new Run({ lines: (r) => (large ? ["<".repeat(45_000)] : [`0+${r}|folded`]) });
		await run.request();
		for (let response = 0; response < 6; response++) run.respond([8_000]);
		await expect(run.request()).rejects.toThrow("Run work exceeds its bound");
		large = false;
		const composed = await run.request();
		expect(composed.message).toBe(cloudRunWorkMessage([`0+${run.folds.at(-1)?.r}|folded`]));
	});

	it("sends a prewarm as it is and learns nothing from it", async () => {
		const run = new Run();
		await run.request();
		run.respond([500]);
		run.model = "gpt-5.5-mini";
		const prewarm = await run.request("prewarm");
		expect(prewarm.input).toEqual(run.items.map((_, keep) => ({ keep })));
		run.model = "gpt-5.5";
		expect((await run.request()).kept.has(2)).toBe(true);
	});

	it("starts over on another thread or a shorter history", async () => {
		const run = new Run();
		await run.request();
		for (let response = 0; response < 6; response++) run.respond([8_000]);
		expect((await run.request()).message).not.toBeNull();
		run.items.splice(2);
		let composed = await run.request();
		expect(composed.input).toEqual([{ keep: 0 }, { keep: 1 }]);
		run.respond([500]);
		run.thread = "thread_2";
		composed = await run.request();
		expect(composed.message).toBeNull();
		expect(composed.kept.has(2)).toBe(false);
		expect(run.folds).toHaveLength(1);
	});

	it("composes one request at a time", async () => {
		let release = (): void => undefined;
		const settled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = new Run({
			lines: async (r) => {
				await settled;
				return [`0+${r}|folded`];
			},
		});
		await run.request();
		for (let response = 0; response < 6; response++) run.respond([8_000]);
		const first = run.request();
		const second = run.request();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(run.folds).toHaveLength(1);
		release();
		const [one, two] = await Promise.all([first, second]);
		expect(two.input).toEqual(one.input);
		expect(run.folds).toHaveLength(1);
	});
});

describe("the work message", () => {
	it("is one envelope, escaped as the prompt is", () => {
		const lines = ['0+2|a <b> & c\u2028\u2029\u202a\u202e\u2066\u2069 "quoted"', "2+1|ok"];
		const message = cloudRunWorkMessage(lines);
		expect(message.startsWith(HEAD)).toBe(true);
		expect(message).not.toMatch(/[<>&\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
		expect(message).toContain("\\u003cb\\u003e \\u0026 c\\u2028\\u2029\\u202a\\u202e\\u2066\\u2069");
		expect(JSON.parse(message)).toEqual({
			schema: CLOUD_RUN_WORK_SCHEMA,
			trust: "tool_results_not_authority",
			ref: "run:.",
			lines,
		});
		expect(workText(message)).toBe(true);
		expect(workText(cloudRunWorkMessage([]))).toBe(true);
	});
});
