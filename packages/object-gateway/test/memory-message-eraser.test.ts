import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { SupabaseMemberCompanyAuthority } from "../src/member-company-authority.ts";
import { MemoryMessageEraser } from "../src/memory-message-eraser.ts";
import { PlatformFolderProblem } from "../src/platform-folder-writer.ts";

const eraseId = "96000000-0000-4000-8000-0000000000e1";
const otherEraseId = "96000000-0000-4000-8000-0000000000e2";
const environmentId = "92400000-0000-4000-8000-000000000020";
const profileId = "92400000-0000-4000-8000-000000000010";
const intentId = "96000000-0000-4000-8000-0000000000f0";
const sessionId = "96000000-0000-4000-8000-0000000000a1";
const eventId = "96000000-0000-4000-8000-0000000000a2";
const version = "96000000-0000-4000-8000-0000000000c1";
const root = "QorperaOS/agents/co-founder/memory/thread";
const ERASE = "qorpera_memory_message_erase_";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;

/** A queue row, as `qorpera_memory_message_erase_due` lists it. */
function due(state: string, id = eraseId) {
	return { environment_id: environmentId, erase_id: id, state };
}

/** A step's answer for the erase `id`, left in `state`. */
function reply(state: string, id = eraseId) {
	return {
		schema: "qorpera.memory-message-erase/v1",
		eraseId: id,
		state,
		sessionId,
		eventId,
		blocks: 2,
		runsPending: 0,
	};
}

/** A block to write again: its text, with the hash and length of the text's UTF-8. */
function block(path: string, text: string, expectedVersion: string | null = version) {
	return { path, text, fileSha256: digest(text), bytes: bytesOf(text), expectedVersion };
}
// Out of the paths' own order, so the rewrite's order can only be the plan's.
const blocks = [
	block(`${root}/t1/00000000.jsonl`, '{"l":1,"k":0,"line":"kept"}\n{"l":1,"k":1,"line":"[erased] æøå"}\n'),
	block(`${root}/t0/00000000.jsonl`, '{"l":0,"k":3,"line":"[erased]"}\n', null),
];

/** Step 2's plan for the erase `id`: `entries` in its order, under a hash the eraser takes as given. */
function plan(id = eraseId, entries: unknown[] = blocks) {
	return {
		schema: "qorpera.memory-message-erase-plan/v1",
		eraseId: id,
		planSha256: digest(JSON.stringify(entries)),
		blocks: entries,
	};
}

/** The state each step leaves an erase in when the test says nothing else. */
const NEXT: Record<string, string> = {
	qorpera_memory_message_erase_open: "open",
	qorpera_memory_message_erase_rewrite: "rewritten",
	qorpera_memory_message_erase_ask: "requested",
	qorpera_memory_message_erase_scrub: "done",
};

/** The code the pass rejected with. */
async function rejection(pass: Promise<number>): Promise<string> {
	try {
		await pass;
	} catch (error) {
		expect(error).toBeInstanceOf(PlatformFolderProblem);
		return (error as PlatformFolderProblem).code;
	}
	throw new Error("The pass did not reject");
}

/**
 * The queue as the database keeps it (migrations 20260930441000 and 20260930443000): the longest waiting first, then
 * the smaller id, past the resting ones. Listing moves nothing; taking an erase moves it behind every other one, as a
 * step that moves it on does; a step that failed rolled back and moves nothing; a done or refused erase leaves the
 * queue. Each row waits a moment less than the one before it, unless it names its own time.
 */
class Queue {
	readonly #rows: { id: string; state: string; at: number }[];
	#clock: number;

	constructor(...rows: { id: string; state: string; at?: number }[]) {
		this.#rows = rows.map((row, n) => ({ ...row, at: row.at ?? n }));
		this.#clock = rows.length;
	}

	add(id: string, state: string): void {
		this.#rows.push({ id, state, at: this.#clock++ });
	}

	list(args: Record<string, unknown>): unknown[] {
		const resting = new Set(args.p_resting as string[]);
		return this.#rows
			.filter((row) => !resting.has(row.id))
			.sort((a, b) => a.at - b.at || Number(a.id > b.id) - Number(a.id < b.id))
			.slice(0, args.p_limit as number)
			.map((row) => due(row.state, row.id));
	}

	take(id: string): boolean {
		const row = this.#rows.find((entry) => entry.id === id);
		if (row) row.at = this.#clock++;
		return row !== undefined;
	}

	settle(id: string, state: string): void {
		const at = this.#rows.findIndex((row) => row.id === id);
		if (at < 0) return;
		if (state === "done" || state === "refused") this.#rows.splice(at, 1);
		else this.#rows[at] = { id, state, at: this.#clock++ };
	}
}

/** Erase ids from `from` on, `count` of them. */
const eraseIds = (count: number, from: number) =>
	Array.from({ length: count }, (_, n) => `96000000-0000-4000-8000-${(from + n).toString(16).padStart(12, "0")}`);

/**
 * The database and the store as the eraser sees them: every call recorded, the queue answered from `queue` (else
 * `due`), each plan from `plans` (else the two blocks), each step from `steps` (a state, an error it throws, or the
 * answer itself; else the state it moves the erase to), and each take from `steps` too (an error it throws, or the
 * answer; else the queue's, or true).
 */
function database(
	options: {
		due?: unknown;
		queue?: Queue;
		plans?: unknown[];
		steps?: Record<string, unknown[]>;
		onCall?: (method: string) => void;
	} = {},
) {
	const objects = new Map<string, Uint8Array>();
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const plans = [...(options.plans ?? [])];
	const steps = new Map<string, unknown[]>();
	for (const [method, answers] of Object.entries(options.steps ?? {})) steps.set(method, [...answers]);
	let manifest = "";
	const authority = {
		async publisher(method: string, args: Record<string, unknown>) {
			calls.push({ method, args });
			options.onCall?.(method);
			switch (method) {
				case "qorpera_memory_message_erase_due":
					return options.queue?.list(args) ?? options.due ?? [];
				case "qorpera_memory_message_erase_take": {
					const queued = steps.get(method) ?? [];
					const answer =
						queued.length > 0 ? queued.shift() : (options.queue?.take(args.p_erase_id as string) ?? true);
					if (answer instanceof Error) throw answer;
					return answer;
				}
				case "qorpera_memory_message_erase_plan":
					return plans.length > 0 ? plans.shift() : plan(args.p_erase_id as string);
				case "qorpera_memory_message_erase_open":
				case "qorpera_memory_message_erase_rewrite":
				case "qorpera_memory_message_erase_ask":
				case "qorpera_memory_message_erase_scrub": {
					const queued = steps.get(method) ?? [];
					const answer = queued.length > 0 ? queued.shift() : NEXT[method];
					if (answer instanceof Error) throw answer;
					if (typeof answer !== "string") return answer;
					options.queue?.settle(args.p_erase_id as string, answer);
					return reply(answer, args.p_erase_id as string);
				}
				case "qorpera_folder_open_upload":
					manifest = args.p_manifest as string;
					return {
						schema: "qorpera.folder-upload/v1",
						intentId,
						manifestSha256: digest(manifest),
						expiresAt: "x",
						present: [],
					};
				case "qorpera_folder_authorize_object_upload":
					return { schema: "qorpera.folder-object-upload/v1", profileId };
				case "qorpera_folder_confirm_object":
					return { schema: "qorpera.folder-object/v1", sha256: args.p_sha256, bytes: args.p_bytes };
				case "qorpera_folder_seal_upload": {
					const sealed = JSON.parse(manifest);
					return {
						schema: "qorpera.folder-seal/v1",
						state: "sealed",
						intentId,
						file: {
							manifestSha256: digest(manifest),
							fileSha256: sealed.fileSha256,
							bytes: sealed.bytes,
							mediaType: sealed.mediaType,
							executable: sealed.executable,
						},
					};
				}
			}
			throw new Error(`unexpected ${method}`);
		},
	};
	const store = {
		async get(): Promise<Uint8Array> {
			throw new Error("Object not found");
		},
	};
	const replication = {
		async uploadWithAuthority(
			profile: string,
			hash: string,
			bytes: Uint8Array,
			callbacks: { authorize(): Promise<void>; confirm(): Promise<void> },
		) {
			expect(profile).toBe(profileId);
			expect(digest(bytes)).toBe(hash);
			await callbacks.authorize();
			objects.set(hash, bytes);
			await callbacks.confirm();
			return "stored" as const;
		},
	};
	const eraser = new MemoryMessageEraser({ authority: authority as never, store, replication });
	/** The eraser's own calls, by step: `due`, `take`, `open`, `plan`, `rewrite`, `ask` and `scrub`. */
	const sequence = () =>
		calls.filter((call) => call.method.startsWith(ERASE)).map((call) => call.method.slice(ERASE.length));
	const rewrites = () => calls.filter((call) => call.method === `${ERASE}rewrite`).map((call) => call.args);
	const staged = (fileSha256: string) => new TextDecoder().decode(objects.get(fileSha256));
	return { eraser, calls, sequence, rewrites, staged };
}

describe("MemoryMessageEraser", () => {
	it("does nothing when nothing is due", async () => {
		const { eraser, calls } = database();
		expect(await eraser.eraseDue()).toBe(0);
		expect(calls).toEqual([{ method: "qorpera_memory_message_erase_due", args: { p_limit: 20, p_resting: [] } }]);
	});

	it("asks the queue for at most its own bound, and for nothing below one", async () => {
		const large = database();
		await large.eraser.eraseDue(5000);
		expect(large.calls[0]?.args).toEqual({ p_limit: 1000, p_resting: [] });
		const none = database();
		expect(await none.eraser.eraseDue(0)).toBe(0);
		expect(none.calls).toHaveLength(0);
	});

	it("carries a pending erase through its four steps to done", async () => {
		const run = database({ due: [due("pending")] });
		expect(await run.eraser.eraseDue(10)).toBe(1);
		expect(run.sequence()).toEqual(["due", "take", "open", "plan", "rewrite", "ask", "scrub"]);
		const ids = { p_environment_id: environmentId, p_erase_id: eraseId };
		const steps = run.calls.filter((call) => call.method.startsWith(ERASE));
		expect(steps.map((call) => call.args)).toEqual([
			{ p_limit: 10, p_resting: [] },
			{ p_erase_id: eraseId },
			ids,
			ids,
			{ ...ids, p_plan_sha256: plan().planSha256, p_files: expect.any(Array) },
			ids,
			ids,
		]);
	});

	it("stages each block as application/jsonl, not executable, and rewrites them in the plan's order", async () => {
		const run = database({ due: [due("open")] });
		expect(await run.eraser.eraseDue()).toBe(1);
		const files = run.rewrites()[0]?.p_files as { path: string; file: Record<string, unknown> }[];
		expect(files.map((entry) => entry.path)).toEqual(blocks.map((entry) => entry.path));
		for (const [index, entry] of files.entries()) {
			expect(Object.keys(entry)).toEqual(["path", "file"]);
			expect(entry.file).toEqual({
				manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				fileSha256: blocks[index]?.fileSha256,
				bytes: blocks[index]?.bytes,
				mediaType: "application/jsonl",
				executable: false,
			});
			expect(run.staged(entry.file.fileSha256 as string)).toBe(blocks[index]?.text);
		}
		for (const call of run.calls.filter((entry) => entry.method.startsWith("qorpera_folder_")))
			expect(call.args.p_actor).toEqual({ kind: "platform" });
	});

	it("rewrites an empty plan with no files", async () => {
		const run = database({ due: [due("open")], plans: [plan(eraseId, [])] });
		await run.eraser.eraseDue();
		expect(run.rewrites()).toEqual([
			{
				p_environment_id: environmentId,
				p_erase_id: eraseId,
				p_plan_sha256: plan(eraseId, []).planSha256,
				p_files: [],
			},
		]);
		expect(run.calls.some((call) => call.method.startsWith("qorpera_folder_"))).toBe(false);
	});

	it.each([
		["pending", "qorpera_memory_message_erase_open", ["due", "take", "open"]],
		["open", "qorpera_memory_message_erase_rewrite", ["due", "take", "plan", "rewrite"]],
		["rewritten", "qorpera_memory_message_erase_ask", ["due", "take", "ask"]],
		["requested", "qorpera_memory_message_erase_scrub", ["due", "take", "scrub"]],
	])("leaves a %s erase to the next pass when its step leaves it there", async (state, method, sequence) => {
		const run = database({ due: [due(state)], steps: { [method]: [state] } });
		expect(await run.eraser.eraseDue()).toBe(1);
		expect(run.sequence()).toEqual(sequence);
	});

	it("stops at refused", async () => {
		const run = database({ due: [due("pending")], steps: { qorpera_memory_message_erase_open: ["refused"] } });
		expect(await run.eraser.eraseDue()).toBe(1);
		expect(run.sequence()).toEqual(["due", "take", "open"]);
	});

	it("plans again when the plan moved before the rewrite took it (423), and rests it a second time", async () => {
		const moved = () => new ObjectDependencyError(423);
		const shorter = plan(eraseId, [blocks[1]]);
		const run = database({
			due: [due("open")],
			plans: [plan(), shorter],
			steps: { qorpera_memory_message_erase_rewrite: [moved()] },
		});
		expect(await run.eraser.eraseDue()).toBe(1);
		expect(run.sequence()).toEqual(["due", "take", "plan", "rewrite", "plan", "rewrite", "ask", "scrub"]);
		expect(run.rewrites().map((args) => args.p_plan_sha256)).toEqual([plan().planSha256, shorter.planSha256]);
		expect(run.rewrites().map((args) => (args.p_files as unknown[]).length)).toEqual([2, 1]);
		const twice = database({
			due: [due("open")],
			steps: { qorpera_memory_message_erase_rewrite: [moved(), moved()] },
		});
		expect(await twice.eraser.eraseDue()).toBe(1);
		expect(twice.sequence()).toEqual(["due", "take", "plan", "rewrite", "plan", "rewrite"]);
	});

	it.each([
		["a lock conflict", new ObjectDependencyError(409, true)],
		["a state that refuses the call now", new ObjectDependencyError(423)],
	])("leaves an erase whose step meets %s, and carries the next", async (_failure, error) => {
		const run = database({
			due: [due("pending"), due("pending", otherEraseId)],
			steps: { qorpera_memory_message_erase_open: [error] },
		});
		expect(await run.eraser.eraseDue()).toBe(2);
		expect(run.sequence()).toEqual(["due", "take", "open", "take", "open", "plan", "rewrite", "ask", "scrub"]);
		const opened = run.calls.filter((call) => call.method === `${ERASE}open`);
		expect(opened.map((call) => call.args.p_erase_id)).toEqual([eraseId, otherEraseId]);
	});

	it.each([
		["refused", new ObjectDependencyError(404)],
		["writer_failed", new Error("boom")],
		["reply_invalid", { ok: true }],
		["reply_invalid", reply("open", otherEraseId)],
		["reply_invalid", { ...reply("open"), state: "closed" }],
	])("carries the other erases, then surfaces %s", async (code, answer) => {
		const run = database({
			due: [due("pending"), due("requested", otherEraseId)],
			steps: { qorpera_memory_message_erase_open: [answer] },
		});
		expect(await rejection(run.eraser.eraseDue())).toBe(code);
		expect(run.sequence()).toEqual(["due", "take", "open", "take", "scrub"]);
	});

	it("leaves an erase it cannot take now (a step holds it, or it ended meanwhile), and takes the next", async () => {
		const run = database({
			due: [due("pending"), due("requested", otherEraseId)],
			steps: { qorpera_memory_message_erase_take: [false] },
		});
		expect(await run.eraser.eraseDue(10)).toBe(1);
		expect(run.sequence()).toEqual(["due", "take", "take", "scrub"]);
		const invalid = database({
			due: [due("pending"), due("requested", otherEraseId)],
			steps: { qorpera_memory_message_erase_take: ["yes"] },
		});
		expect(await rejection(invalid.eraser.eraseDue(10))).toBe("take_invalid");
		expect(invalid.sequence()).toEqual(["due", "take", "take", "scrub"]);
	});

	it("lists first in the next pass the erase due with one whose staging the deadline cut off", async () => {
		// Two erases due at the same time, so the smaller id comes first, as in the database. Each pass's deadline comes
		// while the first one's blocks are being staged, before its rewrite.
		const queue = new Queue({ id: otherEraseId, state: "requested", at: 0 }, { id: eraseId, state: "open", at: 0 });
		let deadline = new AbortController();
		const run = database({
			queue,
			onCall: (method) => {
				if (method !== "qorpera_folder_open_upload") return;
				deadline.abort();
				throw new Error("This operation was aborted");
			},
		});
		expect(await run.eraser.eraseDue(10, deadline.signal)).toBe(1);
		deadline = new AbortController();
		expect(await run.eraser.eraseDue(10, deadline.signal)).toBe(2);
		expect(run.sequence()).toEqual(["due", "take", "plan", "due", "take", "scrub", "take", "plan"]);
		const taken = run.calls.filter((call) => call.method === `${ERASE}take`).map((call) => call.args.p_erase_id);
		expect(taken).toEqual([eraseId, otherEraseId, eraseId]);
	});

	it("rests an erase whose step failed for a minute, naming it for the queue to pass over", async () => {
		const queue = new Queue({ id: eraseId, state: "pending" }, { id: otherEraseId, state: "pending" });
		const run = database({ queue, steps: { qorpera_memory_message_erase_open: [new ObjectDependencyError(404)] } });
		expect(await rejection(run.eraser.eraseDue(1))).toBe("refused");
		// The next pass takes the one after it, which ends done; then nothing else is due while it rests.
		expect(await run.eraser.eraseDue(1)).toBe(1);
		expect(await run.eraser.eraseDue(1)).toBe(0);
		vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
		try {
			expect(await run.eraser.eraseDue(1)).toBe(1);
		} finally {
			vi.useRealTimers();
		}
		const dues = run.calls.filter((call) => call.method === `${ERASE}due`).map((call) => call.args);
		expect(dues).toEqual([
			{ p_limit: 1, p_resting: [] },
			{ p_limit: 1, p_resting: [eraseId] },
			{ p_limit: 1, p_resting: [eraseId] },
			{ p_limit: 1, p_resting: [] },
		]);
		const opened = run.calls.filter((call) => call.method === `${ERASE}open`).map((call) => call.args.p_erase_id);
		expect(opened).toEqual([eraseId, otherEraseId, eraseId]);
	});

	it("reaches an erase behind more failing ones than the queue lists at once", async () => {
		// 1,001 erases each refused now (423), ahead of one that is fine; the queue lists at most 1,000 at once.
		const backlog = eraseIds(1001, 0x1000);
		const queue = new Queue(...backlog.map((id) => ({ id, state: "pending" })), {
			id: otherEraseId,
			state: "requested",
		});
		const refusals = Array.from({ length: 2000 }, () => new ObjectDependencyError(423));
		const run = database({ queue, steps: { qorpera_memory_message_erase_open: refusals } });
		const called = (step: string) =>
			run.calls.filter((call) => call.method === `${ERASE}${step}`).map((call) => call.args);
		const start = Date.now();
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			// The gateway's loop: ten erases every five seconds.
			let passes = 0;
			while (called("scrub").length === 0 && passes < 200) {
				vi.setSystemTime(start + passes++ * 5_000);
				expect(await run.eraser.eraseDue(10)).toBe(10);
			}
			// Each of the 1,001 had its one turn, then the one behind them: each pass took ten that no pass had taken yet.
			expect(passes).toBe(101);
			expect(
				called("open")
					.slice(0, 1001)
					.map((args) => args.p_erase_id),
			).toEqual(backlog);
			expect(called("scrub").map((args) => args.p_erase_id)).toEqual([otherEraseId]);
			// The queue passed over the ones that failed in the last minute: eleven passes of ten.
			const resting = called("due").map((args) => (args.p_resting as string[]).length);
			expect(Math.max(...resting)).toBe(110);
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes an unfinished erase again in each pass while new ones keep arriving", async () => {
		// The first erase asks for one block's history per call (step 3), with blocks left after each.
		const queue = new Queue({ id: eraseId, state: "rewritten" });
		const run = database({
			queue,
			steps: { qorpera_memory_message_erase_ask: Array.from({ length: 5 }, () => "rewritten") },
		});
		for (const id of eraseIds(5, 0x2000)) {
			// A new erase arrives before each pass, one step from done.
			queue.add(id, "requested");
			expect(await run.eraser.eraseDue(10)).toBe(2);
		}
		const asked = run.calls.filter((call) => call.method === `${ERASE}ask`).map((call) => call.args.p_erase_id);
		expect(asked).toEqual(Array.from({ length: 5 }, () => eraseId));
		expect(run.sequence().filter((step) => step === "scrub")).toHaveLength(5);
	});

	it("names at most a thousand resting erases, ending the oldest rest first", async () => {
		const backlog = eraseIds(1001, 0x3000);
		const queue = new Queue(...backlog.map((id) => ({ id, state: "pending" })));
		const refusals = Array.from({ length: 1001 }, () => new ObjectDependencyError(423));
		const run = database({ queue, steps: { qorpera_memory_message_erase_open: refusals } });
		expect(await run.eraser.eraseDue(1000)).toBe(1000);
		expect(await run.eraser.eraseDue(1000)).toBe(1);
		// The 1,001st rest ended the first one's: the queue lists it again, and its step now goes through.
		expect(await run.eraser.eraseDue(1000)).toBe(1);
		const resting = run.calls.filter((call) => call.method === `${ERASE}due`).map((call) => call.args.p_resting);
		expect(resting).toEqual([[], backlog.slice(0, 1000), backlog.slice(1)]);
		expect(run.sequence().at(-1)).toBe("scrub");
	});

	it("ends the pass at an outage, so the circuit it opened refuses no other erase's step", async () => {
		const asked: string[] = [];
		const start = Date.now();
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			// The real database client, whose one circuit every step shares.
			const authority = new SupabaseMemberCompanyAuthority({
				projectUrl: "https://cloud.test",
				publishableKey: "public",
				secretKey: "secret",
				fetch: async (input, init) => {
					const method = new URL(String(input)).pathname.slice("/rest/v1/rpc/".length);
					asked.push(method.slice(ERASE.length));
					if (method === `${ERASE}take`) return Response.json(true);
					if (method === `${ERASE}due`) {
						const resting = JSON.parse(String(init?.body)).p_resting as string[];
						const queue = [due("pending"), due("requested", otherEraseId)];
						return Response.json(queue.filter((row) => !resting.includes(row.erase_id)));
					}
					// The first erase's step runs past the statement timeout.
					if (method === `${ERASE}open`) return Response.json({ code: "57014" }, { status: 500 });
					if (method === `${ERASE}scrub`) return Response.json(reply("done", otherEraseId));
					throw new Error(`unexpected ${method}`);
				},
			});
			const eraser = new MemoryMessageEraser({ authority, store: {} as never, replication: {} as never });
			expect(await eraser.eraseDue(10)).toBe(1);
			expect(asked).toEqual(["due", "take", "open"]);
			// While the circuit is open, a pass asks nothing at all.
			vi.setSystemTime(start + 1_000);
			await expect(eraser.eraseDue(10)).rejects.toMatchObject({ status: 503 });
			expect(asked).toEqual(["due", "take", "open"]);
			// Once it is closed again, the next pass carries the other erase; the queue passes over the resting first one.
			vi.setSystemTime(start + 6_000);
			expect(await eraser.eraseDue(10)).toBe(1);
			expect(asked).toEqual(["due", "take", "open", "due", "take", "scrub"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["a staged hash", { ...blocks[0], fileSha256: "0".repeat(64) }],
		["a staged length", { ...blocks[0], bytes: 1 }],
	])("rewrites nothing when %s is not the plan's", async (_field, entry) => {
		const run = database({ due: [due("open")], plans: [plan(eraseId, [entry])] });
		expect(await rejection(run.eraser.eraseDue())).toBe("plan_invalid");
		expect(run.sequence()).toEqual(["due", "take", "plan"]);
	});

	it.each([
		["for another erase", plan(otherEraseId)],
		["with a field it does not know", { ...plan(), runs: [] }],
		["with a block's version that is no version", plan(eraseId, [{ ...blocks[0], expectedVersion: "v1" }])],
	])("stages nothing for a plan %s", async (_why, answer) => {
		const run = database({ due: [due("open")], plans: [answer] });
		expect(await rejection(run.eraser.eraseDue())).toBe("plan_invalid");
		expect(run.sequence()).toEqual(["due", "take", "plan"]);
		expect(run.calls.some((call) => call.method.startsWith("qorpera_folder_"))).toBe(false);
	});

	it.each([
		["no list", { rows: [] }],
		["a done erase", [due("done")]],
		["an erase with no id", [due("pending", "nope")]],
	])("refuses a queue with %s, taking no step", async (_why, answer) => {
		const run = database({ due: answer });
		expect(await rejection(run.eraser.eraseDue())).toBe("due_invalid");
		expect(run.sequence()).toEqual(["due"]);
	});

	it("takes no step once its deadline has passed", async () => {
		const late = database({ due: [due("pending")] });
		const controller = new AbortController();
		controller.abort();
		expect(await late.eraser.eraseDue(10, controller.signal)).toBe(0);
		expect(late.calls).toHaveLength(0);
		const deadline = new AbortController();
		const cut = database({
			due: [due("pending"), due("pending", otherEraseId)],
			onCall: (method) => {
				if (method === "qorpera_memory_message_erase_open") deadline.abort();
			},
		});
		expect(await cut.eraser.eraseDue(10, deadline.signal)).toBe(1);
		expect(cut.sequence()).toEqual(["due", "take", "open"]);
		// A step the deadline cut off says nothing about its erase: the pass ends quietly.
		const ended = new AbortController();
		const failed = database({
			due: [due("pending"), due("pending", otherEraseId)],
			steps: { qorpera_memory_message_erase_open: [new Error("This operation was aborted")] },
			onCall: (method) => {
				if (method === "qorpera_memory_message_erase_open") ended.abort();
			},
		});
		expect(await failed.eraser.eraseDue(10, ended.signal)).toBe(1);
		expect(failed.sequence()).toEqual(["due", "take", "open"]);
	});
});
