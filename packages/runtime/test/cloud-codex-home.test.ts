import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLOUD_HOME_BUSY,
	CLOUD_HOME_LOST,
	CLOUD_HOME_NO_RECORD,
	CLOUD_HOME_NOT_RUNNING,
	CLOUD_HOME_REQUEST_INVALID,
	CLOUD_HOME_UNAVAILABLE,
	CloudCodexHome,
	type CloudCodexHomeAction,
	CloudCodexHomeSteps,
	type CloudCodexHomeStream,
	cloudHomeCommandAction,
	cloudHomeFileAction,
	cloudHomePatchAction,
	cloudHomeStdinAction,
	parseCloudCodexHomePatch,
} from "@qorpera/runtime/cloud-codex-home";
import { CloudHomeChannelRefused, cloudHomeChannelLines } from "@qorpera/runtime/cloud-home-channel";
import type { CloudRunLog } from "@qorpera/runtime/cloud-run-log";
import { describe, expect, it } from "vitest";

// The agent's home, the host's own rules (lanes/agent-box-20261113, slices 2 and 4; review round 1). What the channel
// and the machine do with them is proven end to end by scripts/prove-home-channel.mjs.

const MACHINE = { id: "11111111-2222-3333-4444-555555555555", name: "home-machine" } as const;
const OTHER = { id: "99999999-2222-3333-4444-555555555555", name: "other-machine" } as const;
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const start = (command: string, extra: Record<string, unknown> = {}) =>
	cloudHomeCommandAction(
		MACHINE,
		{ argv: ["/bin/bash", "-lc", command], cwd: "file:///company", processId: randomUUID(), ...extra },
		"call-1",
	);
const patchItem = (id: string, changes: { path: string; diff: string; type?: string }[]) => ({
	type: "fileChange",
	id,
	status: "inProgress",
	changes: changes.map((change) => ({ path: change.path, kind: { type: change.type ?? "add" }, diff: change.diff })),
});

describe("what the review of a home action covers", () => {
	it("approves what the model chose, so the same command made again after a card is the same action", () => {
		const first = start("npm test", { env: { CODEX_THREAD_ID: "a" }, metadata: { toolCallId: "call-1" } });
		const again = start("npm test", { env: { CODEX_THREAD_ID: "b" }, metadata: { toolCallId: "call-9" } });
		expect(first?.tool).toBe("home_command");
		expect(first?.argumentSha256).toBe(again?.argumentSha256);
		expect(start("npm test", { cwd: "file:///company/app" })?.argumentSha256).not.toBe(first?.argumentSha256);
		expect(start("npm test", { tty: true })?.argumentSha256).not.toBe(first?.argumentSha256);
	});

	it("covers the whole command, not the words the card shows: two alike to 2,000 characters differ", () => {
		const filler = `echo ${"a".repeat(2_100)}`;
		const one = start(`${filler} > /company/one.txt`);
		const two = start(`${filler} > /company/two.txt`);
		expect(one?.summary).toBe(two?.summary);
		expect(one?.argumentSha256).not.toBe(two?.argumentSha256);
	});

	it("covers the machine: the same command on another machine is another action", () => {
		const other = cloudHomeCommandAction(OTHER, { argv: ["/bin/bash", "-lc", "ls"], cwd: "file:///company" }, "c");
		expect(other?.argumentSha256).not.toBe(start("ls")?.argumentSha256);
	});

	it("reviews what the model types into a running shell, with the shell it goes into, but not a poll", () => {
		const into = { command: "python3", cwd: "/company" };
		const typed = cloudHomeStdinAction(
			MACHINE,
			{ processId: 7, chunk: base64("import os; os.remove('x')\n") },
			into,
			"c2",
		);
		expect(typed?.tool).toBe("home_command");
		expect(typed?.summary).toBe("import os; os.remove('x')\n");
		expect(JSON.parse(typed?.argumentsText ?? "{}").into.command).toBe("python3");
		expect(typed?.step.tool).toBe("write_stdin");
		const elsewhere = cloudHomeStdinAction(
			MACHINE,
			{ processId: 8, chunk: base64("import os; os.remove('x')\n") },
			{ command: "node", cwd: "/company" },
			"c3",
		);
		expect(elsewhere?.argumentSha256).not.toBe(typed?.argumentSha256);
		expect(cloudHomeStdinAction(MACHINE, { processId: 7, chunk: "" }, into, "c4")).toBeUndefined();
		expect(start("rm -rf /company/notes")?.argumentSha256).not.toBe(
			cloudHomeStdinAction(MACHINE, { processId: 7, chunk: base64("rm -rf /company/notes") }, into, "c5")
				?.argumentSha256,
		);
	});

	it("reviews a patch once, whole, with its diffs, and keeps its step in the folder's own paths", () => {
		const patch = parseCloudCodexHomePatch(
			patchItem("call-7", [
				{ path: "/company/notes/plan.md", diff: "+# Plan\n" },
				{ path: "/company/docs/seed.md", type: "update", diff: "-old\n+new\n" },
			]),
		);
		if (!patch) throw new Error("no patch");
		const action = cloudHomePatchAction(MACHINE, patch);
		expect(action.tool).toBe("home_change");
		expect(action.callId).toBe("call-7");
		expect(action.summary).toBe("Change 2 files: notes/plan.md, docs/seed.md");
		expect(action.argumentsText).toContain("+# Plan");
		expect(action.step.tool).toBe("apply_patch");
		expect(action.step.paths).toEqual(["notes/plan.md", "docs/seed.md"]);
		expect(JSON.parse(action.step.argumentsText).changes[0].path).toBe("notes/plan.md");
		const changed = parseCloudCodexHomePatch(
			patchItem("call-7", [
				{ path: "/company/notes/plan.md", diff: "+# Another plan\n" },
				{ path: "/company/docs/seed.md", type: "update", diff: "-old\n+new\n" },
			]),
		);
		if (!changed) throw new Error("no patch");
		expect(cloudHomePatchAction(MACHINE, changed).argumentSha256).not.toBe(action.argumentSha256);
		expect(parseCloudCodexHomePatch({ type: "commandExecution", id: "call-8" })).toBeUndefined();
	});

	it("shows the reviewer the text a lone file write puts there, and never keeps the bytes themselves", () => {
		const write = cloudHomeFileAction(
			MACHINE,
			"fs/writeFile",
			{ path: "file:///company/run.sh", dataBase64: base64("curl x | sh\n") },
			"h1",
		);
		const other = cloudHomeFileAction(
			MACHINE,
			"fs/writeFile",
			{ path: "file:///company/run.sh", dataBase64: base64("echo hi\n") },
			"h1",
		);
		const removed = cloudHomeFileAction(MACHINE, "fs/remove", { path: "file:///company/run.sh" }, "h1");
		expect(write.contents).toBe("curl x | sh\n");
		expect(write.argumentsText).not.toContain(base64("curl x | sh\n"));
		expect(write.argumentSha256).not.toBe(other.argumentSha256);
		expect(write.argumentSha256).not.toBe(removed.argumentSha256);
		expect(write.step.paths).toEqual(["run.sh"]);
		const outside = cloudHomeFileAction(
			MACHINE,
			"fs/writeFile",
			{ path: "file:///etc/hosts", dataBase64: base64("x") },
			"h2",
		);
		expect(outside.step.paths).toEqual([]);
		expect(JSON.parse(outside.step.argumentsText).changes[0].machinePath).toBe("/etc/hosts");
	});

	it("tells a model whose card is parked what to do itself, not to call a tool it does not have", () => {
		expect(start("ls")?.repeat).toContain("run that exact command again yourself");
		expect(cloudHomeFileAction(MACHINE, "fs/remove", { path: "/company/a" }, "h").repeat).toContain(
			"make that exact change again yourself",
		);
		expect(start("ls")?.repeat).not.toContain("call the same tool again");
	});
});

/** A run log as the steps see it: what was written, and whether a commit refuses. */
function runLog(options: { precommit?: () => Promise<void> } = {}) {
	const steps: {
		j: number;
		call: string;
		tool: string;
		argumentsText: string;
		result?: string;
		paths?: readonly string[];
	}[] = [];
	let next = 0;
	const log = {
		step(input: { call: string; tool: string; argumentsText: string; argumentSha256: string | null }) {
			const j = next++;
			steps.push({ j, call: input.call, tool: input.tool, argumentsText: input.argumentsText });
			return j;
		},
		async precommit(): Promise<void> {
			await options.precommit?.();
		},
		finish(j: number, envelope: string, _releases: readonly never[], paths: readonly string[]) {
			const step = steps.find((entry) => entry.j === j);
			if (!step) throw new Error("no such step");
			step.result = envelope;
			step.paths = paths;
		},
	};
	return { steps, log: log as unknown as CloudRunLog };
}

describe("the record the run keeps of what its home did", () => {
	it("writes the step before the action runs, and finishes it with the envelope the model was shown", async () => {
		const { steps, log } = runLog();
		const native = new CloudCodexHomeSteps(log);
		const command = start("touch /company/one.txt");
		if (!command) throw new Error("no action");
		await native.open(command, AbortSignal.timeout(1_000));
		expect(steps).toHaveLength(1);
		expect(steps[0]?.tool).toBe("exec_command");
		expect(JSON.parse(steps[0]?.argumentsText ?? "{}").command).toBe("touch /company/one.txt");
		expect(steps[0]?.result).toBeUndefined();
		native.finish(command.callId, '{"status":"ok"}');
		expect(steps[0]?.result).toBe('{"status":"ok"}');
		// A later word of the same call writes nothing more.
		native.finish(command.callId, '{"status":"ok"}');
		expect(native.finished).toBe(1);
	});

	it("keeps a call that never acted (refused, or failed before the machine) as a step of its own", () => {
		const { steps, log } = runLog();
		const native = new CloudCodexHomeSteps(log);
		native.finish("call-x", '{"status":"error"}', {
			tool: "exec_command",
			argumentsText: '{"command":"rm x"}',
			paths: [],
		});
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ call: "call-x", tool: "exec_command", result: '{"status":"error"}' });
		// Without word of what it was, nothing is invented.
		native.finish("call-y", '{"status":"ok"}');
		expect(steps).toHaveLength(1);
	});

	it("refuses the action when the run cannot keep the record: an effect with no record must not happen", async () => {
		const { log } = runLog({
			precommit: async () => {
				throw new Error("the run log is gone");
			},
		});
		const native = new CloudCodexHomeSteps(log);
		const command = start("touch /company/one.txt");
		if (!command) throw new Error("no action");
		await expect(native.open(command, AbortSignal.timeout(1_000))).rejects.toThrow("the run log is gone");
		expect(CLOUD_HOME_NO_RECORD).toContain("did not happen on the machine");
	});
});

describe("the channel's own reader", () => {
	it("keeps a character that arrives in two pieces whole", async () => {
		const danish = Buffer.from("echo 'på maskinen'\n", "utf8");
		const split = danish.indexOf(Buffer.from("å", "utf8")) + 1;
		async function* chunks(): AsyncGenerator<Buffer> {
			yield danish.subarray(0, split);
			yield danish.subarray(split);
		}
		const lines: string[] = [];
		for await (const line of cloudHomeChannelLines(chunks())) lines.push(line);
		expect(lines).toEqual(["echo 'på maskinen'"]);
	});
});

/** A machine's side of the channel this test drives by hand: what was written to it, answers, and its end. */
function fakeMachine() {
	const written: string[] = [];
	const queue: string[] = [];
	let wake: (() => void) | undefined;
	let ended = false;
	const stream: CloudCodexHomeStream = {
		write: (line) => {
			written.push(line);
		},
		lines: (async function* lines() {
			for (;;) {
				const line = queue.shift();
				if (line !== undefined) {
					yield line;
					continue;
				}
				if (ended) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		})(),
		close: async () => {
			ended = true;
			wake?.();
		},
	};
	return {
		written,
		stream,
		answer: (line: string) => {
			queue.push(line);
			wake?.();
		},
		end: () => {
			ended = true;
			wake?.();
		},
	};
}

/** Codex's side: connect to the home's socket, send lines, read the lines it answers with. */
function slotSide(path: string) {
	const socket = createConnection(path);
	const lines: string[] = [];
	let rest = "";
	socket.on("data", (chunk) => {
		rest += chunk.toString("utf8");
		let at = rest.indexOf("\n");
		while (at >= 0) {
			lines.push(rest.slice(0, at));
			rest = rest.slice(at + 1);
			at = rest.indexOf("\n");
		}
	});
	socket.on("error", () => undefined);
	const ready = new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	const send = (value: unknown): void => {
		socket.write(`${JSON.stringify(value)}\n`);
	};
	const next = async (): Promise<Record<string, unknown>> => {
		for (let waited = 0; waited < 200; waited++) {
			const line = lines.shift();
			if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
			await new Promise((done) => setTimeout(done, 25));
		}
		throw new Error("the home answered nothing");
	};
	return { socket, ready, send, next };
}

async function until(condition: () => boolean): Promise<void> {
	for (let waited = 0; waited < 200 && !condition(); waited++) await new Promise((done) => setTimeout(done, 25));
}

async function withHome(
	options: Omit<ConstructorParameters<typeof CloudCodexHome>[0], "sessionId" | "machine" | "signal">,
	body: (home: CloudCodexHome, slot: ReturnType<typeof slotSide>) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "home-test-"));
	const home = new CloudCodexHome({
		...options,
		sessionId: randomUUID(),
		machine: MACHINE,
		signal: new AbortController().signal,
	});
	try {
		await home.listen(root);
		const slot = slotSide(home.socketPath);
		await slot.ready;
		await body(home, slot);
		slot.socket.destroy();
	} finally {
		await home.close();
		await rm(root, { recursive: true, force: true });
	}
}

describe("what the model is told when its home is not there", () => {
	it("answers every request in words when the channel cannot be opened, instead of a dead turn", async () => {
		await withHome(
			{
				channel: {
					open: async () => {
						throw new Error("the ingress did not answer");
					},
				},
			},
			async (home, slot) => {
				slot.send({ id: 1, method: "initialize", params: {} });
				expect(await slot.next()).toEqual({ id: 1, error: { code: -32010, message: CLOUD_HOME_UNAVAILABLE } });
				slot.send({ id: 2, method: "fs/readFile", params: {} });
				expect((await slot.next()).error).toEqual({ code: -32010, message: CLOUD_HOME_UNAVAILABLE });
				expect(home.failure).toBe(CLOUD_HOME_UNAVAILABLE);
			},
		);
	});

	it("says which it is when the ingress gives a reason: not running, or busy with another run's work", async () => {
		for (const [reason, words] of [
			["MACHINE_NOT_RUNNING", CLOUD_HOME_NOT_RUNNING],
			["MACHINE_BUSY_WITH_OTHER_WORK", CLOUD_HOME_BUSY],
		] as const)
			await withHome(
				{
					channel: {
						open: async () => {
							throw new CloudHomeChannelRefused(reason);
						},
					},
				},
				async (_home, slot) => {
					slot.send({ id: 1, method: "initialize", params: {} });
					expect(((await slot.next()).error as { message: string }).message).toBe(words);
				},
			);
	});

	it("tells the model its machine was lost mid-command, and that part of it may have happened", async () => {
		const machine = fakeMachine();
		let opens = 0;
		await withHome(
			{
				channel: {
					open: async () => {
						opens++;
						if (opens === 1) return machine.stream;
						throw new CloudHomeChannelRefused("MACHINE_NOT_RUNNING");
					},
				},
			},
			async (home, slot) => {
				slot.send({
					id: 7,
					method: "process/start",
					params: {
						processId: "1",
						argv: ["/bin/bash", "-lc", "make"],
						cwd: "file:///company",
						metadata: { toolCallId: "call-m" },
					},
				});
				await until(() => machine.written.length === 1);
				machine.end();
				expect(await slot.next()).toEqual({ id: 7, error: { code: -32010, message: CLOUD_HOME_LOST } });
				expect(home.counts.lost).toBe(1);
				// The call's own output is shown the same words first, whatever Codex makes of the error.
				expect(home.noteFor("call-m")).toBe(CLOUD_HOME_LOST);
				// Asked again, the home is tried again; a machine that is not running is said as such, and nothing is
				// forwarded. A call that never reached the machine is told so in its output too.
				slot.send({ id: 8, method: "fs/readFile", params: { path: "file:///company/a" } });
				expect(((await slot.next()).error as { message: string }).message).toBe(CLOUD_HOME_NOT_RUNNING);
				expect(machine.written).toHaveLength(1);
				expect(home.noteFor("call-never-reached")).toBe(CLOUD_HOME_NOT_RUNNING);
				expect(home.noteFor("call-m")).toBeUndefined();
			},
		);
	});

	it("opens the channel again for the next call, and tells the new machine Codex's own handshake", async () => {
		const first = fakeMachine();
		const second = fakeMachine();
		const machines = [first, second];
		await withHome({ channel: { open: async () => (machines.shift() ?? second).stream } }, async (home, slot) => {
			slot.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientName: "codex" } });
			await until(() => first.written.length === 1);
			first.answer(JSON.stringify({ id: 1, result: { sessionId: "s" } }));
			expect(await slot.next()).toEqual({ id: 1, result: { sessionId: "s" } });
			slot.send({ jsonrpc: "2.0", method: "initialized" });
			slot.send({ id: 2, method: "fs/readFile", params: { path: "file:///company/a" } });
			await until(() => first.written.length === 3);
			first.end();
			expect(((await slot.next()).error as { message: string }).message).toBe(CLOUD_HOME_LOST);
			// The next call: a new channel, told the handshake again (its answer is the host's), then the call itself.
			slot.send({ id: 3, method: "fs/readFile", params: { path: "file:///company/b" } });
			await until(() => second.written.length === 1);
			const again = JSON.parse(second.written[0] ?? "{}") as { id: string; method: string; params: unknown };
			expect(again.method).toBe("initialize");
			expect(again.params).toEqual({ clientName: "codex" });
			second.answer(JSON.stringify({ id: again.id, result: { sessionId: "t" } }));
			await until(() => second.written.length === 3);
			expect(JSON.parse(second.written[1] ?? "{}").method).toBe("initialized");
			expect(JSON.parse(second.written[2] ?? "{}").id).toBe(3);
			second.answer(JSON.stringify({ id: 3, result: { dataBase64: "" } }));
			expect(await slot.next()).toEqual({ id: 3, result: { dataBase64: "" } });
			expect(home.noteFor("any-call")).toBeUndefined();
		});
	});

	it("tells nothing of the kind when the machine answered first", async () => {
		const machine = fakeMachine();
		await withHome({ channel: { open: async () => machine.stream } }, async (home, slot) => {
			slot.send({ id: 7, method: "fs/readFile", params: { path: "file:///company/a" } });
			await until(() => machine.written.length === 1);
			machine.answer(JSON.stringify({ result: { dataBase64: "" }, id: 7 }));
			expect(await slot.next()).toEqual({ result: { dataBase64: "" }, id: 7 });
			machine.end();
			await new Promise((done) => setTimeout(done, 100));
			expect(home.counts.lost).toBe(0);
		});
	});
});

describe("a line typed into a running shell, whose request names no call", () => {
	it("is kept under the host's own id with the machine's answer, and a refused one is kept and told at once", async () => {
		const machine = fakeMachine();
		const { steps, log } = runLog();
		await withHome(
			{
				channel: { open: async () => machine.stream },
				steps: new CloudCodexHomeSteps(log),
				review: {
					check: async (action) =>
						action.summary.startsWith("bad")
							? { run: false, text: "REVIEW_DENIED: not this line." }
							: { run: true },
				},
			},
			async (home, slot) => {
				slot.send({
					id: 1,
					method: "process/start",
					params: {
						processId: "5",
						argv: ["/bin/bash", "-lc", "cat"],
						cwd: "file:///company",
						metadata: { toolCallId: "call-s" },
					},
				});
				await until(() => machine.written.length === 1);
				slot.send({ id: 2, method: "process/write", params: { processId: "5", chunk: base64("good\n") } });
				await until(() => machine.written.length === 2);
				machine.answer(JSON.stringify({ id: 2, result: { accepted: true } }));
				expect(await slot.next()).toEqual({ id: 2, result: { accepted: true } });
				const typed = steps.find((step) => step.tool === "write_stdin");
				expect(typed?.call.startsWith("home:")).toBe(true);
				expect(typed?.result).toBe(JSON.stringify({ id: 2, result: { accepted: true } }));
				expect(JSON.parse(typed?.argumentsText ?? "{}")).toEqual({ chars: "good\n", into: "cat" });
				slot.send({ id: 3, method: "process/write", params: { processId: "5", chunk: base64("bad\n") } });
				expect(((await slot.next()).error as { message: string }).message).toBe("REVIEW_DENIED: not this line.");
				const refused = steps.filter((step) => step.tool === "write_stdin")[1];
				expect(JSON.parse(refused?.result ?? "{}")).toEqual({
					status: "refused",
					text: "REVIEW_DENIED: not this line.",
				});
				expect(machine.written).toHaveLength(2);
				// No guess: a release of a call the host has no word of takes no typed line's step.
				home.released("call-w", "env-w", true);
				expect(steps).toHaveLength(3);
			},
		);
	});
});

describe("what never reaches the machine", () => {
	it("drops what the host cannot read, and answers a request it cannot read in words", async () => {
		const machine = fakeMachine();
		await withHome({ channel: { open: async () => machine.stream } }, async (home, slot) => {
			slot.socket.write("this is not JSON\n");
			slot.send({ method: "anything/else", params: {} });
			slot.send({ id: null, method: "process/start", params: { argv: ["/bin/bash", "-lc", "ls"] } });
			slot.send({ id: 4, method: "process/start", params: { argv: "ls", cwd: "file:///company" } });
			expect(await slot.next()).toEqual({ id: 4, error: { code: -32600, message: CLOUD_HOME_REQUEST_INVALID } });
			slot.send({ id: 5, method: "process/write", params: { processId: "1", chunk: 7 } });
			expect(((await slot.next()).error as { message: string }).message).toBe(CLOUD_HOME_REQUEST_INVALID);
			// A method nobody named as needing no review is refused, so a later Codex's new acting method never slips by.
			slot.send({ id: 6, method: "network/fetch", params: { url: "https://example.invalid" } });
			expect(((await slot.next()).error as { message: string }).message).toBe(CLOUD_HOME_REQUEST_INVALID);
			slot.send({ id: 7, method: "process/signal", params: { processId: "1", signal: 9 } });
			expect(((await slot.next()).error as { message: string }).message).toBe(CLOUD_HOME_REQUEST_INVALID);
			slot.send({ jsonrpc: "2.0", method: "initialized" });
			slot.send({ id: 8, method: "environmentConfig/read", params: {} });
			await until(() => machine.written.length === 2);
			expect(machine.written.map((line) => JSON.parse(line).method)).toEqual([
				"initialized",
				"environmentConfig/read",
			]);
			expect(home.counts.dropped).toBe(3);
		});
	});
});

describe("a file change no patch accounts for", () => {
	it("is reviewed on its own with its text, and its step is finished with the machine's answer", async () => {
		const machine = fakeMachine();
		const { steps, log } = runLog();
		const reviewed: CloudCodexHomeAction[] = [];
		await withHome(
			{
				channel: { open: async () => machine.stream },
				steps: new CloudCodexHomeSteps(log),
				review: {
					check: async (action) => {
						reviewed.push(action);
						return { run: true };
					},
				},
			},
			async (_home, slot) => {
				slot.send({
					id: 9,
					method: "fs/writeFile",
					params: { path: "file:///company/loose.txt", dataBase64: base64("by hand\n") },
				});
				await until(() => machine.written.length === 1);
				expect(reviewed[0]?.contents).toBe("by hand\n");
				expect(steps[0]?.call.startsWith("home:")).toBe(true);
				expect(steps[0]?.result).toBeUndefined();
				machine.answer(JSON.stringify({ id: 9, result: {} }));
				expect(await slot.next()).toEqual({ id: 9, result: {} });
				expect(steps[0]?.result).toBe(JSON.stringify({ id: 9, result: {} }));
			},
		);
	});
});

describe("the review at the host", () => {
	it("reviews a patch once for all its files and forwards them after it, and stops a command it declines", async () => {
		const machine = fakeMachine();
		const reviewed: CloudCodexHomeAction[] = [];
		await withHome(
			{
				channel: { open: async () => machine.stream },
				review: {
					check: async (action) => {
						reviewed.push(action);
						return action.summary.includes("forbidden")
							? { run: false, text: "REVIEW_DENIED: not this one." }
							: { run: true };
					},
				},
			},
			async (home, slot) => {
				home.noteItem("item/started", {
					item: patchItem("call-p", [
						{ path: "/company/notes/a.md", diff: "+a\n" },
						{ path: "/company/notes/b.md", diff: "+b\n" },
					]),
				});
				slot.send({
					id: 1,
					method: "fs/createDirectory",
					params: { path: "file:///company/notes", recursive: true },
				});
				slot.send({
					id: 2,
					method: "fs/writeFile",
					params: { path: "file:///company/notes/a.md", dataBase64: base64("a\n") },
				});
				slot.send({
					id: 3,
					method: "fs/writeFile",
					params: { path: "file:///company/notes/b.md", dataBase64: base64("b\n") },
				});
				await until(() => machine.written.length === 3);
				expect(machine.written.map((line) => JSON.parse(line).id)).toEqual([1, 2, 3]);
				expect(reviewed.map((action) => action.callId)).toEqual(["call-p"]);
				slot.send({
					id: 4,
					method: "process/start",
					params: {
						processId: "9",
						argv: ["/bin/bash", "-lc", "echo forbidden"],
						cwd: "file:///company",
						metadata: { toolCallId: "call-c" },
					},
				});
				expect(await slot.next()).toEqual({
					id: 4,
					error: { code: -32600, message: "REVIEW_DENIED: not this one." },
				});
				expect(machine.written).toHaveLength(3);
				expect(home.counts.declined).toBe(1);
			},
		);
	});

	it("returns an error and finishes unnamed steps if the home channel drops during review", async () => {
		const machine = fakeMachine();
		const { steps, log } = runLog();
		let releaseReview: (() => void) | undefined;
		await withHome(
			{
				channel: { open: async () => machine.stream },
				steps: new CloudCodexHomeSteps(log),
				review: {
					check: async (action) => {
						if (action.step.tool === "write_stdin") {
							await new Promise<void>((resolve) => {
								releaseReview = resolve;
							});
						}
						return { run: true };
					},
				},
			},
			async (_home, slot) => {
				slot.send({
					id: 1,
					method: "process/start",
					params: {
						processId: "5",
						argv: ["/bin/bash", "-lc", "cat"],
						cwd: "file:///company",
						metadata: { toolCallId: "call-s" },
					},
				});
				await until(() => machine.written.length === 1);
				machine.answer(JSON.stringify({ id: 1, result: {} }));
				expect(await slot.next()).toEqual({ id: 1, result: {} });
				slot.send({ id: 2, method: "process/write", params: { processId: "5", chunk: base64("after-drop\n") } });
				await until(() => releaseReview !== undefined);
				machine.end();
				await new Promise((resolve) => setTimeout(resolve, 30));
				releaseReview?.();
				const reply = await slot.next();
				expect(reply).toMatchObject({ id: 2, error: { code: -32010 } });
				const typed = steps.find((step) => step.tool === "write_stdin");
				expect(typed?.result).toBeDefined();
				expect(machine.written).toHaveLength(1);
			},
		);
	});

	it("fails replay promptly when the reconnected machine stream closes mid-handshake", async () => {
		const first = fakeMachine();
		const second = fakeMachine();
		let opens = 0;
		await withHome(
			{
				channel: {
					open: async () => {
						opens += 1;
						if (opens === 1) return first.stream;
						return second.stream;
					},
				},
			},
			async (_home, slot) => {
				slot.send({ id: 1, method: "initialize", params: { clientName: "codex" } });
				await until(() => first.written.length === 1);
				first.answer(JSON.stringify({ id: 1, result: { sessionId: "s" } }));
				expect(await slot.next()).toEqual({ id: 1, result: { sessionId: "s" } });
				first.end();
				await new Promise((resolve) => setTimeout(resolve, 30));
				const startedAt = Date.now();
				slot.send({ id: 2, method: "fs/readFile", params: { path: "file:///company/a" } });
				await until(() => second.written.length === 1);
				second.end();
				const reply = await slot.next();
				expect(Date.now() - startedAt).toBeLessThan(3_000);
				expect(reply).toMatchObject({ id: 2, error: { code: -32010 } });
			},
		);
	});
});
