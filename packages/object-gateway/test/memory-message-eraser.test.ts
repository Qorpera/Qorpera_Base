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
const root = "agents/co-founder/memory/thread";
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
 * The database and the store as the eraser sees them: every call recorded, the queue answered from `due` (or what it
 * returns, when it is a function), each plan from `plans` (else the two blocks), and each step from `steps` (a state,
 * an error it throws, or the answer itself; else the state it moves the erase to).
 */
function database(
	options: {
		due?: unknown | (() => unknown);
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
					return (typeof options.due === "function" ? options.due() : options.due) ?? [];
				case "qorpera_memory_message_erase_plan":
					return plans.length > 0 ? plans.shift() : plan(args.p_erase_id as string);
				case "qorpera_memory_message_erase_open":
				case "qorpera_memory_message_erase_rewrite":
				case "qorpera_memory_message_erase_ask":
				case "qorpera_memory_message_erase_scrub": {
					const queued = steps.get(method) ?? [];
					const answer = queued.length > 0 ? queued.shift() : NEXT[method];
					if (answer instanceof Error) throw answer;
					return typeof answer === "string" ? reply(answer, args.p_erase_id as string) : answer;
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
	/** The eraser's own calls, by step: `due`, `open`, `plan`, `rewrite`, `ask` and `scrub`. */
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
		expect(calls).toEqual([{ method: "qorpera_memory_message_erase_due", args: { p_limit: 20 } }]);
	});

	it("asks the queue for at most its own bound, and for nothing below one", async () => {
		const large = database();
		await large.eraser.eraseDue(5000);
		expect(large.calls[0]?.args).toEqual({ p_limit: 1000 });
		const none = database();
		expect(await none.eraser.eraseDue(0)).toBe(0);
		expect(none.calls).toHaveLength(0);
	});

	it("carries a pending erase through its four steps to done", async () => {
		const run = database({ due: [due("pending")] });
		expect(await run.eraser.eraseDue(10)).toBe(1);
		expect(run.sequence()).toEqual(["due", "open", "plan", "rewrite", "ask", "scrub"]);
		const ids = { p_environment_id: environmentId, p_erase_id: eraseId };
		const steps = run.calls.filter((call) => call.method.startsWith(ERASE));
		expect(steps.map((call) => call.args)).toEqual([
			{ p_limit: 10 },
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
		["pending", "qorpera_memory_message_erase_open", ["due", "open"]],
		["open", "qorpera_memory_message_erase_rewrite", ["due", "plan", "rewrite"]],
		["rewritten", "qorpera_memory_message_erase_ask", ["due", "ask"]],
		["requested", "qorpera_memory_message_erase_scrub", ["due", "scrub"]],
	])("leaves a %s erase to the next pass when its step leaves it there", async (state, method, sequence) => {
		const run = database({ due: [due(state)], steps: { [method]: [state] } });
		expect(await run.eraser.eraseDue()).toBe(1);
		expect(run.sequence()).toEqual(sequence);
	});

	it("stops at refused", async () => {
		const run = database({ due: [due("pending")], steps: { qorpera_memory_message_erase_open: ["refused"] } });
		expect(await run.eraser.eraseDue()).toBe(1);
		expect(run.sequence()).toEqual(["due", "open"]);
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
		expect(run.sequence()).toEqual(["due", "plan", "rewrite", "plan", "rewrite", "ask", "scrub"]);
		expect(run.rewrites().map((args) => args.p_plan_sha256)).toEqual([plan().planSha256, shorter.planSha256]);
		expect(run.rewrites().map((args) => (args.p_files as unknown[]).length)).toEqual([2, 1]);
		const twice = database({
			due: [due("open")],
			steps: { qorpera_memory_message_erase_rewrite: [moved(), moved()] },
		});
		expect(await twice.eraser.eraseDue()).toBe(1);
		expect(twice.sequence()).toEqual(["due", "plan", "rewrite", "plan", "rewrite"]);
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
		expect(run.sequence()).toEqual(["due", "open", "open", "plan", "rewrite", "ask", "scrub"]);
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
		expect(run.sequence()).toEqual(["due", "open", "scrub"]);
	});

	it("rests an erase whose step failed for a minute, asking the queue for one more meanwhile", async () => {
		let queue = [due("pending"), due("pending", otherEraseId)];
		const run = database({
			due: () => queue,
			steps: { qorpera_memory_message_erase_open: [new ObjectDependencyError(404)] },
		});
		expect(await rejection(run.eraser.eraseDue(1))).toBe("refused");
		// The failed erase stays first in the queue: the next pass skips it and takes the one after.
		expect(await run.eraser.eraseDue(1)).toBe(1);
		const opened = () =>
			run.calls.filter((call) => call.method === `${ERASE}open`).map((call) => call.args.p_erase_id);
		expect(opened()).toEqual([eraseId, otherEraseId]);
		// The other one is done. Every erase due had its turn, so a new round begins, but the failed one still rests.
		queue = [due("pending")];
		expect(await run.eraser.eraseDue(1)).toBe(0);
		vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
		try {
			expect(await run.eraser.eraseDue(1)).toBe(1);
		} finally {
			vi.useRealTimers();
		}
		const dues = run.calls.filter((call) => call.method === `${ERASE}due`).map((call) => call.args);
		expect(dues).toEqual([{ p_limit: 1 }, { p_limit: 2 }, { p_limit: 3 }, { p_limit: 2 }]);
		expect(opened()).toEqual([eraseId, otherEraseId, eraseId]);
	});

	it("gives every erase due its turn before a pass takes one that failed again", async () => {
		// 130 erases each refused now (423), ahead of one that is fine: more than a minute of passes of ten.
		const backlog = Array.from(
			{ length: 130 },
			(_, n) => `96000000-0000-4000-8000-${(0x100 + n).toString(16).padStart(12, "0")}`,
		);
		let scrubbed = false;
		const opened: string[] = [];
		const authority = {
			async publisher(method: string, args: Record<string, unknown>) {
				if (method === `${ERASE}due`)
					return [
						...backlog.map((id) => due("pending", id)),
						...(scrubbed ? [] : [due("requested", otherEraseId)]),
					].slice(0, args.p_limit as number);
				if (method === `${ERASE}open`) {
					opened.push(args.p_erase_id as string);
					throw new ObjectDependencyError(423);
				}
				if (method === `${ERASE}scrub`) {
					scrubbed = true;
					return reply("done", otherEraseId);
				}
				throw new Error(`unexpected ${method}`);
			},
		};
		const start = Date.now();
		vi.useFakeTimers({ now: start, toFake: ["Date"] });
		try {
			const eraser = new MemoryMessageEraser({
				authority: authority as never,
				store: {} as never,
				replication: {} as never,
			});
			// The gateway's loop: ten erases every five seconds.
			let passes = 0;
			const pass = async () => {
				vi.setSystemTime(start + passes++ * 5_000);
				return eraser.eraseDue(10);
			};
			while (!scrubbed && passes < 40) await pass();
			// Each of the 130 had its one turn, then the one behind them, 65 seconds in.
			expect(passes).toBe(14);
			expect(opened).toEqual(backlog);
			// Then the next round, with the longest waiting first, as their minutes end.
			expect(await pass()).toBe(10);
			expect(opened.slice(130)).toEqual(backlog.slice(0, 10));
		} finally {
			vi.useRealTimers();
		}
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
				fetch: async (input) => {
					const method = new URL(String(input)).pathname.slice("/rest/v1/rpc/".length);
					asked.push(method.slice(ERASE.length));
					if (method === `${ERASE}due`) return Response.json([due("pending"), due("requested", otherEraseId)]);
					// The first erase's step runs past the statement timeout.
					if (method === `${ERASE}open`) return Response.json({ code: "57014" }, { status: 500 });
					if (method === `${ERASE}scrub`) return Response.json(reply("done", otherEraseId));
					throw new Error(`unexpected ${method}`);
				},
			});
			const eraser = new MemoryMessageEraser({ authority, store: {} as never, replication: {} as never });
			expect(await eraser.eraseDue(10)).toBe(1);
			expect(asked).toEqual(["due", "open"]);
			// While the circuit is open, a pass asks nothing at all.
			vi.setSystemTime(start + 1_000);
			await expect(eraser.eraseDue(10)).rejects.toMatchObject({ status: 503 });
			expect(asked).toEqual(["due", "open"]);
			// Once it is closed again, the next pass carries the other erase; the first one rests.
			vi.setSystemTime(start + 6_000);
			expect(await eraser.eraseDue(10)).toBe(1);
			expect(asked).toEqual(["due", "open", "due", "scrub"]);
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
		expect(run.sequence()).toEqual(["due", "plan"]);
	});

	it.each([
		["for another erase", plan(otherEraseId)],
		["with a field it does not know", { ...plan(), runs: [] }],
		["with a block's version that is no version", plan(eraseId, [{ ...blocks[0], expectedVersion: "v1" }])],
	])("stages nothing for a plan %s", async (_why, answer) => {
		const run = database({ due: [due("open")], plans: [answer] });
		expect(await rejection(run.eraser.eraseDue())).toBe("plan_invalid");
		expect(run.sequence()).toEqual(["due", "plan"]);
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
		expect(cut.sequence()).toEqual(["due", "open"]);
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
		expect(failed.sequence()).toEqual(["due", "open"]);
	});
});
