import { performance } from "node:perf_hooks";
import {
	type CompanyComputerCommandFolderEvent,
	CompanyComputerCommandFolders,
} from "@qorpera/runtime/cloud-company-computer-command-folder";
import type {
	askCompanyComputerFolderHelper,
	CompanyComputerFolderAnswer,
	CompanyComputerFolderRequest,
	CompanyComputerFolderRunEvent,
	startCompanyComputerFolderRun,
} from "@qorpera/runtime/cloud-company-computer-folder-helper-client";
import { HttpCloudCompanyComputerRegistry } from "@qorpera/runtime/cloud-company-computer-registry-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerDeferred, computerId, computerScope } from "./fixtures/company-computer.ts";

const { environmentId } = computerScope();
const receipt = computerId(40);
const name = `command-${receipt}`;
const screenId = computerId(50);
const report = { commitId: "commit-1", seq: 7, paths: [] };
const refusal = (refused: string) => ({
	answer: "refused",
	report: { commitId: null, seq: null, paths: [], refused },
});
/** What a view refused for good keeps, as the service reports it: a path left waiting and those not published. */
const kept = [
	{ path: "draft.md", outcome: "waiting", reason: "open for writing", kept: true },
	{ path: "notes.md", outcome: "refused", reason: "unproven", kept: true },
];
const shut = (refused: string) => ({ answer: "refused", report: { commitId: null, seq: null, paths: kept, refused } });
const listed = kept.map(({ kept: _, ...entry }) => entry);

const START_UNMOUNTED = "The company folder could not be mounted for this command; start it again.";
const START_FAILED = "The command could not start in the company folder; start it again.";
const START_LOST = "The company folder stopped answering for this command; start it again.";
const UNANSWERED = "the company folder did not answer before the reply's deadline; read again";
const PAUSED = "the company is paused, so the company folder holds this output back";
const RUN_ENDED = "this run can no longer act in the company folder";
const REFUSED = "the company folder refused this command's view";
const STOPPED =
	"the company folder closed or refused this command's view, so the command was stopped and its output is held back; start it again";
const GONE = "the company folder no longer serves this command, so its output is held back; start it again";
const SAVING = "the command's last changes are still being saved; read again";
const NOT_TAKEN = "the company folder did not take this command's last changes";

afterEach(() => {
	vi.useRealTimers();
});

/** The core's folder views as `qorpera_folder_view_open` and `_close` answer them. */
function core() {
	const opened: Record<string, unknown>[] = [];
	const closed: unknown[] = [];
	const call = vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
		if (method === "qorpera_folder_view_open") {
			opened.push(args);
			return {
				schema: "qorpera.folder-view/v1",
				viewId: computerId(100 + opened.length),
				pass: `pass-${opened.length}`,
			};
		}
		if (method === "qorpera_folder_view_close") {
			closed.push(args);
			return {};
		}
		throw new Error(`Unexpected fixture RPC ${method}`);
	});
	const view = (n: number) => ({ environmentId, viewId: computerId(100 + n), pass: `pass-${n}` });
	return { call, opened, closed, view };
}

/** The folder helper: each request takes the next answer queued for its op (a function is called for it). */
function helper() {
	const asked: CompanyComputerFolderRequest[] = [];
	const options: unknown[] = [];
	const queued = new Map<string, unknown[]>();
	const ask = vi.fn(async (request: CompanyComputerFolderRequest, given: unknown) => {
		asked.push(request);
		options.push(given);
		const next = queued.get(request.op)?.shift();
		return typeof next === "function" ? next() : next;
	});
	return {
		asked,
		options,
		ask: ask as unknown as typeof askCompanyComputerFolderHelper,
		answer: (op: CompanyComputerFolderRequest["op"], ...answers: unknown[]) => {
			queued.set(op, [...(queued.get(op) ?? []), ...answers]);
		},
		ops: () => asked.map((request) => request.op),
	};
}

/** The helper's run connection: the test settles its answer and its close, and sends its events. */
function runner() {
	const runRequests: unknown[] = [];
	const runOptions: unknown[] = [];
	const runAnswer = computerDeferred<CompanyComputerFolderAnswer<"run"> | undefined>();
	const runClosed = computerDeferred<void>();
	const write = vi.fn();
	const stop = vi.fn();
	let onEvent: (event: CompanyComputerFolderRunEvent) => void = () => undefined;
	const run = vi.fn((request: unknown, events: (event: CompanyComputerFolderRunEvent) => void, given: unknown) => {
		runRequests.push(request);
		runOptions.push(given);
		onEvent = events;
		return { answer: runAnswer.promise, closed: runClosed.promise, write, stop, close: vi.fn() };
	});
	return {
		run,
		runRequests,
		runOptions,
		runAnswer,
		runClosed,
		write,
		stop,
		send: (event: CompanyComputerFolderRunEvent) => onEvent(event),
	};
}

function fixture(options: { socket?: string; registry?: Pick<HttpCloudCompanyComputerRegistry, "call"> } = {}) {
	const c = core();
	const h = helper();
	const r = runner();
	const logged: string[] = [];
	const folders = new CompanyComputerCommandFolders({
		registry: options.registry ?? { call: c.call },
		ask: h.ask,
		run: r.run as unknown as typeof startCompanyComputerFolderRun,
		log: (line) => logged.push(line),
		...(options.socket ? { socket: options.socket } : {}),
	});
	const folder = folders.command(receipt, screenId);
	const events: CompanyComputerCommandFolderEvent[] = [];
	const start = (still = () => true, signal = new AbortController().signal, network = false) =>
		folder.start(
			{ environmentId, shellPid: 802, network, command: "make test", still },
			(event) => events.push(event),
			signal,
		);
	const release = (until = performance.now() + 17000, signal = new AbortController().signal) =>
		folder.release(signal, until);
	/** The drain of the command's screen, as a drain request's 20 s, less a second, give it. */
	const drain = (until = performance.now() + 19000, signal = new AbortController().signal) =>
		folders.drain(screenId, signal, until);
	return { ...c, ...h, ...r, folders, folder, events, start, release, drain, logged };
}

/** A command whose run started: its view and mount were made and the helper answered `started`. */
async function running(options?: Parameters<typeof fixture>[0]) {
	const f = fixture(options);
	f.answer("mount", { answer: "mounted" });
	f.runAnswer.resolve({ answer: "started" });
	await expect(f.start()).resolves.toEqual({ ran: true });
	return f;
}

/** Lets the folder's queued work run up to its next wait (setImmediate is never faked here). */
async function settle(): Promise<void> {
	for (let round = 0; round < 10; round++) await new Promise((resolve) => setImmediate(resolve));
}

describe("a shell command's folder", () => {
	it("opens the command's own view as the platform, mounts it, and runs the command with `/company`", async () => {
		const f = await running({ socket: "/run/qorpera-folder/helper.sock" });
		expect(f.opened).toEqual([
			{
				p_environment_id: environmentId,
				p_opener: { kind: "platform" },
				p_kind: "computer_shell_command",
				p_anchor: { shellCommandId: receipt },
			},
		]);
		expect(f.asked).toEqual([{ op: "mount", name, view: f.view(1) }]);
		expect(f.options).toEqual([
			{ socket: "/run/qorpera-folder/helper.sock", timeoutMs: 40000, signal: expect.any(AbortSignal) },
		]);
		expect(f.runRequests).toEqual([{ op: "run", name, shellPid: 802, network: false, command: "make test" }]);
		expect(f.runOptions).toEqual([{ socket: "/run/qorpera-folder/helper.sock" }]);
		expect(f.folder.status).toBe("running");
		f.send({ t: "out", data: "b2s=" });
		f.send({ t: "exit", code: 0, signal: null });
		expect(f.events).toEqual([
			{ t: "out", data: "b2s=" },
			{ t: "exit", code: 0, signal: null },
		]);
		// One start per command.
		await expect(f.start()).resolves.toEqual({ note: START_FAILED });
		expect(f.run).toHaveBeenCalledTimes(1);
	});

	it("runs a networked command with the network", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		f.runAnswer.resolve({ answer: "started" });
		await expect(f.start(undefined, undefined, true)).resolves.toEqual({ ran: true });
		expect(f.runRequests).toEqual([{ op: "run", name, shellPid: 802, network: true, command: "make test" }]);
	});

	it("passes on the core's refusal of the command's view, and asks the helper nothing", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json(
				{ message: "Folder view command is not current", code: "42501", details: "secret" },
				{ status: 403 },
			),
		);
		const f = fixture({
			registry: new HttpCloudCompanyComputerRegistry({
				supabaseUrl: "https://control.example.test",
				serviceRoleKey: "sb_secret_fixture",
				fetch: fetcher,
			}),
		});
		await expect(f.start()).resolves.toEqual({
			note: "The command did not start (Folder view command is not current); start it again.",
		});
		expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
			p_environment_id: environmentId,
			p_opener: { kind: "platform" },
			p_kind: "computer_shell_command",
			p_anchor: { shellCommandId: receipt },
		});
		expect(f.asked).toEqual([]);
		expect(f.run).not.toHaveBeenCalled();
		expect(f.folder.status).toBe("none");
		await expect(f.release()).resolves.toEqual({ released: true, final: true });
	});

	it.each(["failed", "closed", "held", undefined])(
		"drops a mount the helper did not make (%s) and closes its view; nothing runs",
		async (mount) => {
			const f = fixture();
			f.answer("mount", mount === undefined ? undefined : { answer: mount });
			f.answer("drop", { answer: "dropped" });
			await expect(f.start()).resolves.toEqual({ note: START_UNMOUNTED });
			await settle();
			expect(f.asked.slice(1)).toEqual([{ op: "drop", name }]);
			expect(f.options[1]).toEqual({ timeoutMs: 60000 });
			expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
			expect(f.run).not.toHaveBeenCalled();
			await expect(f.release()).resolves.toEqual({ released: true, final: true });
		},
	);

	it("runs nothing for a session stopped while its mount was made, and the mount goes", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		f.answer("drop", { answer: "dropped" });
		await expect(f.start(() => false)).resolves.toEqual({ note: START_FAILED });
		await settle();
		expect(f.ops()).toEqual(["mount", "drop"]);
		expect(f.closed).toHaveLength(1);
		expect(f.run).not.toHaveBeenCalled();
	});

	it("stops with its caller before its view opens, and asks the helper nothing", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort(new Error("caller stopped"));
		await expect(f.start(undefined, controller.signal)).resolves.toEqual({ note: START_FAILED });
		await settle();
		expect(f.opened).toEqual([]);
		expect(f.asked).toEqual([]);
		expect(f.closed).toEqual([]);
		expect(f.folder.status).toBe("none");
	});

	it("ends a command the helper did not start: its mount goes, asked again until it does", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		f.answer("drop", { answer: "failed" }, undefined, { answer: "dropped" });
		f.runAnswer.resolve({ answer: "refused" });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await expect(f.start()).resolves.toEqual({ note: START_FAILED });
		await vi.advanceTimersByTimeAsync(15000);
		await settle();
		expect(f.ops()).toEqual(["mount", "drop", "drop", "drop"]);
		expect(f.closed).toHaveLength(1);
		expect(f.folder.status).toBe("none");
		// Nothing runs: input and stop go nowhere.
		expect(f.folder.stop()).toBe(false);
		expect(f.folder.write(Buffer.from("x"), true)).toBe(false);
		expect(f.stop).not.toHaveBeenCalled();
	});

	it("takes a run the helper did not answer as lost, and publishes its changes once the helper says it ended", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		f.answer("ended", { answer: "running" }, { answer: "ended" });
		f.answer("unmount", { answer: "saved", report, unmounted: true });
		f.runAnswer.resolve(undefined);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await expect(f.start()).resolves.toEqual({ note: START_LOST });
		expect(f.events).toEqual([{ t: "lost" }]);
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		expect(f.ops()).toEqual(["mount", "ended", "ended", "unmount"]);
		expect(f.asked[1]).toEqual({ op: "ended", name });
		expect(f.folder.status).toBe("released");
		expect(f.closed).toHaveLength(1);
	});

	it("takes a lost run the helper never knew of as one that ran nothing, and drops its mount", async () => {
		const f = fixture();
		f.answer("mount", { answer: "mounted" });
		f.answer("ended", { answer: "unknown" });
		f.answer("drop", { answer: "dropped" });
		f.runAnswer.resolve(undefined);
		await expect(f.start()).resolves.toEqual({ note: START_LOST });
		await settle();
		expect(f.ops()).toEqual(["mount", "ended", "drop"]);
		expect(f.closed).toHaveLength(1);
		await expect(f.release()).resolves.toEqual({ released: true, final: true });
	});

	it("passes the shell's input and stop to the run once its request was sent", async () => {
		const f = await running();
		expect(f.folder.write(Buffer.from("yes\n"), false)).toBe(true);
		expect(f.folder.write(Buffer.alloc(0), true)).toBe(true);
		expect(f.write.mock.calls).toEqual([
			[Buffer.from("yes\n"), false],
			[Buffer.alloc(0), true],
		]);
		expect(f.folder.stop()).toBe(true);
		expect(f.stop).toHaveBeenCalledTimes(1);
	});
});

describe("a command's output before it reaches the run", () => {
	it("is released at once while nothing runs yet", async () => {
		const f = fixture();
		await expect(f.release()).resolves.toEqual({ released: true });
		expect(f.folder.stop()).toBe(false);
		expect(f.folder.write(Buffer.from("x"), false)).toBe(false);
		expect(f.asked).toEqual([]);
	});

	it("waits for a boundary within the reply's deadline, and is released once the command's reads are", async () => {
		const f = await running();
		f.answer(
			"boundary",
			{ answer: "saved", report },
			{ answer: "refused", report: { ...report, paths: [{ path: "a", outcome: "refused" }] } },
			{ answer: "saved", report },
		);
		await expect(f.release()).resolves.toEqual({ released: true });
		expect(f.asked[1]).toMatchObject({ op: "boundary", name, final: false });
		const { timeoutMs } = f.asked[1] as { timeoutMs: number };
		expect(timeoutMs).toBeGreaterThan(15000);
		expect(timeoutMs).toBeLessThanOrEqual(16000);
		expect(f.options[1]).toEqual({ timeoutMs: timeoutMs + 1000, signal: expect.any(AbortSignal) });
		// Refused for some paths only: the reads were released all the same.
		await expect(f.release()).resolves.toEqual({ released: true, notSaved: [{ path: "a", outcome: "refused" }] });
		// Far from its deadline, a boundary takes at most the helper's own 30 s.
		await expect(f.release(performance.now() + 60000)).resolves.toEqual({ released: true });
		expect((f.asked[3] as { timeoutMs: number }).timeoutMs).toBe(30000);
		expect(f.folder.status).toBe("running");
	});

	it.each([
		["no answer", undefined, UNANSWERED],
		["an invalid answer", { answer: "invalid" }, UNANSWERED],
		["one too late", { answer: "unanswered" }, UNANSWERED],
		["a paused company", refusal("stopped"), PAUSED],
		["the run check", refusal("run_ended"), RUN_ENDED],
		["a refusal", refusal("denied"), REFUSED],
	])("is held back past %s, and the command goes on", async (_, answer, heldBack) => {
		const f = await running();
		f.answer("boundary", answer, { answer: "saved", report });
		await expect(f.release()).resolves.toEqual({ released: false, heldBack });
		expect(f.stop).not.toHaveBeenCalled();
		await expect(f.release()).resolves.toEqual({ released: true });
	});

	it.each([
		["its view closed", { answer: "closed" }, STOPPED, {}],
		["its view unreadable", shut("unreadable"), STOPPED, { notSaved: listed }],
		["its view unproven", shut("unproven"), STOPPED, { notSaved: listed }],
		["its mount unknown to the helper", { answer: "unknown" }, GONE, {}],
	])(
		"is held back for good with %s: the command stops, and its mount goes without a boundary once it ended",
		async (_, answer, heldBack, shown) => {
			const f = await running();
			f.answer("boundary", answer);
			f.answer("drop", { answer: "dropped" });
			// Every path it kept is listed, since no boundary comes after it.
			await expect(f.release()).resolves.toEqual({ released: false, heldBack, ...shown });
			expect(f.stop).toHaveBeenCalledTimes(1);
			expect(f.folder.status).toBe("held");
			await expect(f.release()).resolves.toEqual({ released: false, heldBack });
			f.send({ t: "ended" });
			await settle();
			expect(f.ops()).toEqual(["mount", "boundary", "drop"]);
			expect(f.closed).toHaveLength(1);
			await expect(f.release()).resolves.toEqual({ released: false, heldBack });
		},
	);

	it("lists once the paths a boundary settled without saving them, but not those it keeps for a later one", async () => {
		const f = await running();
		f.answer(
			"boundary",
			{
				answer: "refused",
				report: {
					commitId: null,
					seq: null,
					paths: [
						{ path: "docs/a.md", outcome: "conflict", receipt: "r-1" },
						{ path: "docs/b.md", outcome: "saved" },
						{ path: "docs/c.md", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
					],
				},
			},
			{
				answer: "refused",
				report: {
					commitId: null,
					seq: null,
					refused: "denied",
					paths: [
						{ path: "docs/d.md", outcome: "refused", reason: "it changed meanwhile" },
						{ path: "docs/c.md", outcome: "refused", reason: "denied", kept: true },
					],
				},
			},
			{ answer: "saved", report },
		);
		await expect(f.release()).resolves.toEqual({
			released: true,
			notSaved: [{ path: "docs/a.md", outcome: "conflict" }],
		});
		await expect(f.release()).resolves.toEqual({
			released: false,
			heldBack: REFUSED,
			notSaved: [{ path: "docs/d.md", outcome: "refused", reason: "it changed meanwhile" }],
		});
		await expect(f.release()).resolves.toEqual({ released: true });
		// The final's report is empty: what the boundaries settled came with their releases.
		f.answer("unmount", { answer: "saved", report: { ...report, closed: true }, unmounted: true });
		f.send({ t: "ended" });
		await expect(f.release()).resolves.toEqual({ released: true, final: true });
	});

	it("is held back without asking when the reply's deadline is too near", async () => {
		const f = await running();
		await expect(f.release(performance.now() + 1500)).resolves.toEqual({ released: false, heldBack: UNANSWERED });
		expect(f.ops()).toEqual(["mount"]);
	});

	it("is held back at the reply's deadline, and the next read's boundary waits its turn", async () => {
		const f = await running();
		const late = computerDeferred<unknown>();
		f.answer("boundary", () => late.promise, { answer: "saved", report });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const held = f.release(performance.now() + 5000);
		await vi.advanceTimersByTimeAsync(5000);
		await expect(held).resolves.toEqual({ released: false, heldBack: UNANSWERED });
		const next = f.release(performance.now() + 5000);
		await settle();
		expect(f.ops()).toEqual(["mount", "boundary"]);
		late.resolve({ answer: "saved", report });
		await expect(next).resolves.toEqual({ released: true });
		expect(f.ops()).toEqual(["mount", "boundary", "boundary"]);
	});

	it("stops with its caller", async () => {
		const f = await running();
		const stopped = new AbortController();
		stopped.abort(new Error("caller stopped"));
		await expect(f.release(undefined, stopped.signal)).rejects.toThrow("caller stopped");
		const pending = computerDeferred<unknown>();
		f.answer("boundary", () => pending.promise);
		const controller = new AbortController();
		const read = f.release(undefined, controller.signal);
		await settle();
		controller.abort(new Error("caller stopped"));
		await expect(read).rejects.toThrow("caller stopped");
	});
});

describe("a command's end", () => {
	it("publishes the command's last changes once no process of it is left; then its mount goes and its view closes", async () => {
		const f = await running();
		f.answer("unmount", {
			answer: "saved",
			report: {
				...report,
				paths: [
					{ path: "docs/plan.md", outcome: "saved" },
					{ path: "docs/old.md", outcome: "refused", reason: "it changed meanwhile" },
					{ path: "docs/new.md", outcome: "conflict", receipt: "r-1", kept: true },
				],
			},
			unmounted: true,
		});
		f.send({ t: "exit", code: 0, signal: null });
		f.send({ t: "ended" });
		await expect(f.release()).resolves.toEqual({
			released: true,
			final: true,
			notSaved: [
				{ path: "docs/old.md", outcome: "refused", reason: "it changed meanwhile" },
				{ path: "docs/new.md", outcome: "conflict" },
			],
		});
		expect(f.asked[1]).toEqual({ op: "unmount", name, final: true, timeoutMs: 30000 });
		expect(f.options[1]).toEqual({});
		expect(f.closed).toEqual([{ p_view_id: computerId(101), p_pass: "pass-1" }]);
		expect(f.events).toEqual([{ t: "exit", code: 0, signal: null }]);
		// The paths not saved come once.
		await expect(f.release()).resolves.toEqual({ released: true, final: true });
		expect(f.ops()).toEqual(["mount", "unmount"]);
		expect(f.logged).toEqual([]);
		// The connection closing after the end loses nothing.
		f.runClosed.resolve();
		await settle();
		expect(f.events).toEqual([{ t: "exit", code: 0, signal: null }]);
		expect(f.ops()).toEqual(["mount", "unmount"]);
	});

	it("holds output back while the final boundary is asked, until the reply's deadline", async () => {
		const f = await running();
		const pending = computerDeferred<unknown>();
		f.answer("unmount", () => pending.promise);
		f.send({ t: "ended" });
		expect(f.folder.status).toBe("ending");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const held = f.release(performance.now() + 1000);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(held).resolves.toEqual({ released: false, heldBack: SAVING });
		pending.resolve({ answer: "saved", report, unmounted: true });
		await expect(f.release()).resolves.toEqual({ released: true, final: true });
	});

	it("asks the final boundary again past no answer, an invalid one, one too late, the run check and a pause", async () => {
		const f = await running();
		f.answer(
			"unmount",
			undefined,
			{ answer: "invalid" },
			{ answer: "unanswered", unmounted: false },
			{ ...refusal("run_ended"), unmounted: false },
			{ ...refusal("stopped"), unmounted: false },
			{ answer: "saved", report, unmounted: true },
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		f.send({ t: "ended" });
		// Asked at 0, 5, 15 and 35 s: meanwhile the last answer says why output is held back.
		await vi.advanceTimersByTimeAsync(36000);
		await settle();
		expect(f.ops()).toEqual(["mount", "unmount", "unmount", "unmount", "unmount"]);
		const held = f.release(performance.now());
		await vi.advanceTimersByTimeAsync(0);
		await expect(held).resolves.toEqual({ released: false, heldBack: RUN_ENDED });
		await vi.advanceTimersByTimeAsync(120000);
		await settle();
		expect(f.ops()).toEqual(["mount", "unmount", "unmount", "unmount", "unmount", "unmount", "unmount"]);
		expect(f.logged).toEqual(
			["no answer", "invalid", "unanswered", "refused run_ended", "refused stopped"].map(
				(word) => `office-folder: command ${name}: final boundary asked again (${word})`,
			),
		);
		expect(f.folder.status).toBe("released");
		expect(f.closed).toHaveLength(1);
	});

	it("asks the final boundary again while the core has not answered it or a change still waits, and the view stays open", async () => {
		const f = await running();
		const notYet = {
			path: "docs/end.md",
			outcome: "not_applied",
			reason: "the save did not get through yet",
			kept: true,
		};
		f.answer(
			"unmount",
			// The core did not answer the final's change set, but the settling of an earlier one did.
			{
				answer: "refused",
				report: {
					commitId: null,
					seq: null,
					paths: [{ path: "docs/old.md", outcome: "conflict", receipt: "r-1" }, notYet],
				},
				unmounted: false,
			},
			{
				answer: "refused",
				report: {
					commitId: null,
					seq: null,
					paths: [
						{ path: "docs/big.bin", outcome: "waiting", reason: "it is still being written", kept: true },
						{ ...notYet, reason: "the final waits until every change can go" },
					],
				},
				unmounted: false,
			},
			{
				answer: "refused",
				report: {
					commitId: "commit-2",
					seq: 8,
					paths: [
						{ path: "docs/end.md", outcome: "saved" },
						{ path: "docs/big.bin", outcome: "conflict", receipt: "r-2" },
					],
					closed: true,
				},
				unmounted: false,
			},
		);
		f.answer("drop", { answer: "dropped" });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		f.send({ t: "ended" });
		await settle();
		const held = f.release(performance.now());
		await vi.advanceTimersByTimeAsync(0);
		await expect(held).resolves.toEqual({
			released: false,
			heldBack: SAVING,
			notSaved: [{ path: "docs/old.md", outcome: "conflict" }],
		});
		expect(f.closed).toEqual([]);
		// Asked at 0, 5 and 15 s.
		await vi.advanceTimersByTimeAsync(16000);
		await settle();
		expect(f.ops()).toEqual(["mount", "unmount", "unmount", "unmount", "drop"]);
		expect(f.logged).toEqual([
			`office-folder: command ${name}: final boundary asked again (refused)`,
			`office-folder: command ${name}: final boundary asked again (refused)`,
		]);
		expect(f.folder.status).toBe("released");
		expect(f.closed).toHaveLength(1);
		await expect(f.release()).resolves.toEqual({
			released: true,
			final: true,
			notSaved: [{ path: "docs/big.bin", outcome: "conflict" }],
		});
	});

	it.each([
		["its view closed", { answer: "closed" }, STOPPED],
		["its view unreadable", refusal("unreadable"), STOPPED],
		["its view unproven", refusal("unproven"), STOPPED],
		["its mount unknown to the helper", { answer: "unknown" }, GONE],
	])(
		"drops the mount without a final boundary when a boundary in flight as the command ended found %s",
		async (_, answer, heldBack) => {
			const f = await running();
			const pending = computerDeferred<unknown>();
			f.answer("boundary", () => pending.promise);
			f.answer("drop", { answer: "dropped" });
			const read = f.release();
			await settle();
			f.send({ t: "ended" });
			expect(f.folder.status).toBe("ending");
			pending.resolve(answer);
			await expect(read).resolves.toEqual({ released: false, heldBack });
			await settle();
			expect(f.ops()).toEqual(["mount", "boundary", "drop"]);
			expect(f.closed).toHaveLength(1);
			expect(f.folder.status).toBe("held");
			await expect(f.release()).resolves.toEqual({ released: false, heldBack });
		},
	);

	it("holds output back for good when the final boundary was not taken, and drops the mount it left", async () => {
		const f = await running();
		f.answer("unmount", {
			answer: "refused",
			report: {
				commitId: null,
				seq: null,
				paths: [{ path: "docs/a.md", outcome: "refused", reason: "denied" }],
				refused: "denied",
			},
			unmounted: false,
		});
		f.answer("drop", { answer: "dropped" });
		f.send({ t: "ended" });
		await expect(f.release()).resolves.toEqual({
			released: false,
			heldBack: NOT_TAKEN,
			notSaved: [{ path: "docs/a.md", outcome: "refused", reason: "denied" }],
		});
		expect(f.ops()).toEqual(["mount", "unmount", "drop"]);
		expect(f.closed).toHaveLength(1);
		await expect(f.release()).resolves.toEqual({ released: false, heldBack: NOT_TAKEN });
	});

	it("takes a final boundary the helper no longer knows of as gone", async () => {
		const f = await running();
		f.answer("unmount", { answer: "unknown" });
		f.send({ t: "ended" });
		await expect(f.release()).resolves.toEqual({ released: false, heldBack: GONE });
		expect(f.ops()).toEqual(["mount", "unmount"]);
		expect(f.closed).toHaveLength(1);
	});

	it("lists at most twenty paths not saved, each cut short, within its byte budget", async () => {
		const f = await running();
		const paths = Array.from({ length: 25 }, (_, index) => ({ path: `docs/${index}.md`, outcome: "refused" }));
		f.answer("unmount", { answer: "saved", report: { ...report, paths }, unmounted: true });
		f.send({ t: "ended" });
		const few = await f.release();
		expect(few).toMatchObject({ released: true, final: true, moreNotSaved: 5 });
		expect(few.notSaved).toEqual(paths.slice(0, 20));

		const g = await running();
		const long = Array.from({ length: 25 }, (_, index) => ({
			path: `${index}/${"a".repeat(400)}`,
			outcome: "refused",
			reason: "r".repeat(300),
		}));
		g.answer("unmount", { answer: "refused", report: { ...report, paths: long, closed: true }, unmounted: true });
		g.send({ t: "ended" });
		const cut = await g.release();
		// 300 characters of path and 200 of reason each: 14 of them fit in 8 KiB.
		expect(cut).toMatchObject({ released: true, final: true, moreNotSaved: 11 });
		expect(cut.notSaved).toHaveLength(14);
		expect(cut.notSaved?.[0]).toEqual({
			path: `0/${"a".repeat(298)}…`,
			outcome: "refused",
			reason: `${"r".repeat(200)}…`,
		});
	});
});

describe("a lost command", () => {
	it("tells its session when the helper went before the command's end, and asks the helper when it ended", async () => {
		const f = await running();
		f.answer("ended", { answer: "running" }, undefined, { answer: "ended" });
		f.answer("unmount", { answer: "saved", report, unmounted: true });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		f.runClosed.resolve();
		await settle();
		expect(f.events).toEqual([{ t: "lost" }]);
		expect(f.ops()).toEqual(["mount", "ended"]);
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(f.ops()).toEqual(["mount", "ended", "ended", "ended", "unmount"]);
		expect(f.folder.status).toBe("released");
		expect(f.closed).toHaveLength(1);
		await expect(f.release()).resolves.toEqual({ released: true, final: true });
	});

	it("holds output back for good when the helper no longer knows of a command whose output came", async () => {
		const f = await running();
		f.answer("ended", { answer: "unknown" });
		f.answer("drop", { answer: "dropped" });
		f.send({ t: "out", data: "aGk=" });
		f.runClosed.resolve();
		await settle();
		expect(f.events).toEqual([{ t: "out", data: "aGk=" }, { t: "lost" }]);
		expect(f.ops()).toEqual(["mount", "ended", "drop"]);
		expect(f.closed).toHaveLength(1);
		await expect(f.release()).resolves.toEqual({ released: false, heldBack: GONE });
	});
});

describe("a screen's drain", () => {
	it("answers once a command's final boundary has its answer and its mount went, the pause's refusal as final", async () => {
		const f = await running();
		f.answer("unmount", { ...refusal("stopped"), unmounted: false });
		f.answer("drop", { answer: "dropped" });
		let drained = false;
		const draining = f.drain().then(() => {
			drained = true;
		});
		await settle();
		// The shell closed the command; its end is still to come.
		expect(drained).toBe(false);
		f.send({ t: "ended" });
		await draining;
		expect(f.ops()).toEqual(["mount", "unmount", "drop"]);
		// Each asked within the drain's deadline.
		const { timeoutMs } = f.asked[1] as { timeoutMs: number };
		expect(timeoutMs).toBeGreaterThan(17000);
		expect(timeoutMs).toBeLessThanOrEqual(18000);
		expect(f.options[1]).toEqual({ timeoutMs: timeoutMs + 1000 });
		expect((f.options[2] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(19000);
		expect(f.logged).toEqual([
			`office-folder: drain ${name}: {"answer":"refused","unmounted":false,"refused":"stopped","commitId":null,"seq":null,"outcomes":{}}`,
		]);
		expect(f.closed).toHaveLength(1);
		await expect(f.release()).resolves.toEqual({ released: false, heldBack: NOT_TAKEN });
		// Nothing of it is left for the next drain.
		await f.drain();
		expect(f.ops()).toEqual(["mount", "unmount", "drop"]);
	});

	it("asks the final boundary again each second past no answer, QRC01 and the run check, the first time at once", async () => {
		const f = await running();
		f.answer(
			"unmount",
			undefined,
			{ answer: "unanswered", unmounted: false },
			{ ...refusal("run_ended"), unmounted: false },
			{ answer: "saved", report, unmounted: true },
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		f.send({ t: "ended" });
		await settle();
		// No answer: asked again in 5 s, or once a drain begins.
		expect(f.ops()).toEqual(["mount", "unmount"]);
		let drained = false;
		const draining = f.drain(performance.now() + 19000).then(() => {
			drained = true;
		});
		await settle();
		expect(f.ops()).toEqual(["mount", "unmount", "unmount"]);
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		expect(f.ops()).toEqual(["mount", "unmount", "unmount", "unmount"]);
		expect(drained).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		await draining;
		expect(f.ops()).toEqual(["mount", "unmount", "unmount", "unmount", "unmount"]);
		expect(f.asked[1]).toEqual({ op: "unmount", name, final: true, timeoutMs: 30000 });
		expect(f.asked[2]).toMatchObject({ op: "unmount", name, final: true });
		expect((f.asked[2] as { timeoutMs: number }).timeoutMs).toBeLessThan(18000);
		expect(f.logged).toEqual([
			...["no answer", "unanswered", "refused run_ended"].map(
				(word) => `office-folder: command ${name}: final boundary asked again (${word})`,
			),
			`office-folder: drain ${name}: {"answer":"saved","unmounted":true,"refused":null,"commitId":"commit-1","seq":7,"outcomes":{}}`,
		]);
		expect(f.folder.status).toBe("released");
		expect(f.closed).toHaveLength(1);
	});

	it.each([
		[
			"saved",
			{ answer: "saved", report, unmounted: true },
			'{"answer":"saved","unmounted":true,"refused":null,"commitId":"commit-1","seq":7,"outcomes":{}}',
			{ released: true, final: true },
		],
		[
			"the pause's refusal",
			{ ...refusal("stopped"), unmounted: true },
			'{"answer":"refused","unmounted":true,"refused":"stopped","commitId":null,"seq":null,"outcomes":{}}',
			{ released: false, heldBack: NOT_TAKEN },
		],
	])(
		"takes as its own the answer of a final boundary asked before it began: %s",
		async (_, answer, logged, released) => {
			const f = await running();
			const late = computerDeferred<unknown>();
			f.answer("unmount", () => late.promise);
			f.send({ t: "ended" });
			await settle();
			expect(f.ops()).toEqual(["mount", "unmount"]);
			const draining = f.drain();
			await settle();
			late.resolve(answer);
			await draining;
			expect(f.ops()).toEqual(["mount", "unmount"]);
			expect(f.logged).toEqual([`office-folder: drain ${name}: ${logged}`]);
			expect(f.closed).toHaveLength(1);
			await expect(f.release()).resolves.toEqual(released);
		},
	);

	it("fails once its deadline passes with no final answer, and the command's own final boundary goes on", async () => {
		const f = await running();
		const late = computerDeferred<unknown>();
		f.answer("unmount", () => late.promise);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const failed = expect(f.drain(performance.now() + 19000)).rejects.toThrow("OFFICE_FOLDER_DRAIN_UNANSWERED");
		f.send({ t: "ended" });
		await vi.advanceTimersByTimeAsync(19000);
		await failed;
		expect(f.logged).toEqual([`office-folder: drain ${name}: no final answer by the drain's deadline`]);
		late.resolve({ answer: "saved", report, unmounted: true });
		await settle();
		expect(f.folder.status).toBe("released");
		expect(f.closed).toHaveLength(1);
		await expect(f.release()).resolves.toEqual({ released: true, final: true });
	});

	it("asks a mount's drop again each second while a drain waits for it", async () => {
		const f = fixture();
		f.answer("mount", { answer: "failed" });
		f.answer("drop", { answer: "failed" }, { answer: "failed" }, { answer: "dropped" });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await expect(f.start()).resolves.toEqual({ note: START_UNMOUNTED });
		await settle();
		expect(f.ops()).toEqual(["mount", "drop"]);
		const draining = f.drain(performance.now() + 19000);
		await settle();
		expect(f.ops()).toEqual(["mount", "drop", "drop"]);
		expect((f.options[2] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(19000);
		await vi.advanceTimersByTimeAsync(1000);
		await draining;
		expect(f.ops()).toEqual(["mount", "drop", "drop", "drop"]);
		expect(f.closed).toHaveLength(1);
	});

	it("waits for no command that made no mount, nor for another screen's", async () => {
		const f = fixture();
		await f.drain();
		const controller = new AbortController();
		controller.abort(new Error("caller stopped"));
		await expect(f.start(undefined, controller.signal)).resolves.toEqual({ note: START_FAILED });
		await f.drain();
		const g = await running();
		await g.folders.drain(computerId(51), new AbortController().signal, performance.now() + 19000);
		expect(g.ops()).toEqual(["mount"]);
		expect(g.logged).toEqual([]);
	});
});
