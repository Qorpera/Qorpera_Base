import { PassThrough } from "node:stream";
import { CompanyComputerActionFailedError } from "@qorpera/runtime/cloud-company-computer-leases";
import {
	COMPANY_COMPUTER_SHELL_KEPT_OUTPUT,
	CompanyComputerLinuxShell,
	type CompanyComputerShellEnvironmentLauncher,
	CompanyComputerShellPressureGuard,
	companyComputerProcessIoBytes,
	companyComputerShellBusy,
} from "@qorpera/runtime/cloud-company-computer-linux-shell";
import {
	type CompanyComputerShellHostEvent,
	parseCompanyComputerShellHostEvent,
	runCompanyComputerShellHost,
} from "@qorpera/runtime/cloud-company-computer-shell-host";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The run that starts the commands here. */
const SHELL_RUN = "00000000-0000-4000-8000-0000000000c1";

// The real shell host and bookkeeping over in-process pipes, with the local
// Bash. The Linux namespace itself has its own probe (--shell).
const shells: CompanyComputerLinuxShell[] = [];
afterEach(async () => {
	await Promise.all(shells.splice(0).map((shell) => shell.close()));
});

function fixture(processes = { count: 0 }) {
	const hosts: { stop(): Promise<void>; crash(): void }[] = [];
	const launch = vi.fn<CompanyComputerShellEnvironmentLauncher>(async (onEvent) => {
		const toHost = new PassThrough();
		const fromHost = new PassThrough();
		let buffer = "";
		fromHost.setEncoding("utf8");
		fromHost.on("data", (text: string) => {
			buffer += text;
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				onEvent(parseCompanyComputerShellHostEvent(buffer.slice(0, newline)));
				buffer = buffer.slice(newline + 1);
			}
		});
		let crashed: () => void = () => undefined;
		const exited = Promise.race([
			runCompanyComputerShellHost({
				input: toHost,
				output: fromHost,
				countProcesses: async () => processes.count,
				processIntervalMs: 50,
				bash: "/bin/bash",
			}),
			new Promise<void>((resolve) => {
				crashed = resolve;
			}),
		]);
		const stop = async (): Promise<void> => {
			toHost.end();
			await exited;
		};
		hosts.push({ stop, crash: () => crashed() });
		return {
			send: (request) => void toHost.write(`${JSON.stringify(request)}\n`),
			exited,
			stop,
		};
	});
	const shell = new CompanyComputerLinuxShell(launch);
	shells.push(shell);
	const signal = new AbortController().signal;
	let keys = 0;
	// Each model call is an effect (start, write, stop) and then a wait for its result.
	const read = (sessionId: string, waitMs = 5000) => shell.result({ sessionId, waitMs, signal });
	const start = async (command: string, waitMs = 5000) =>
		read((await shell.start({ runId: SHELL_RUN, key: `key-${keys++}`, command, signal })).sessionId, waitMs);
	const write = async (sessionId: string, text: string, endInput = false) =>
		read((await shell.write({ sessionId, text, endInput, signal })).sessionId);
	const stop = async (sessionId: string) => {
		await shell.stop({ sessionId, signal });
		return read(sessionId, 4000);
	};
	return { shell, launch, hosts, signal, start, read, write, stop, processes };
}

describe("an agent's long-running Company Computer shell", () => {
	it("replies when a short command ends, with its exit code and output", async () => {
		const f = fixture();
		const result = await f.start("echo hello; echo oops >&2; exit 3");
		expect(result).toMatchObject({ state: "exited", exitCode: 3 });
		expect(result.output).toContain("hello\n");
		expect(result.output).toContain("oops\n");
		expect(f.shell.busy).toBe(false);
	});

	it("keeps a command running past its wait, with no time limit, until it ends or is stopped", async () => {
		const f = fixture();
		const running = await f.start("echo started; sleep 2; echo later", 1000);
		expect(running).toMatchObject({ state: "running", output: "started\n" });
		expect(running.exitCode).toBeUndefined();
		expect(f.shell.busy).toBe(true);
		const later = await f.read(running.sessionId);
		expect(later).toMatchObject({ state: "exited", exitCode: 0, output: "later\n" });
		const sleeper = await f.start("sleep 30 & sleep 30", 50);
		expect(sleeper.state).toBe("running");
		const stopped = await f.stop(sleeper.sessionId);
		expect(stopped).toMatchObject({ sessionId: sleeper.sessionId, state: "stopped" });
		expect(f.shell.busy).toBe(false);
	});

	it("writes input to a running command and closes it on request", async () => {
		const f = fixture();
		const asking = await f.start('read -r answer; echo "got:$answer"', 50);
		expect(asking.state).toBe("running");
		expect(await f.write(asking.sessionId, "yes\n")).toMatchObject({ state: "exited", output: "got:yes\n" });
		const cat = await f.start("cat", 50);
		expect(await f.write(cat.sessionId, "last", true)).toMatchObject({
			state: "exited",
			exitCode: 0,
			output: "last",
		});
		await expect(f.write(cat.sessionId, "x")).rejects.toThrow("OFFICE_SHELL_INPUT_ENDED");
		await expect(f.write(asking.sessionId, "x")).rejects.toThrow("OFFICE_SHELL_SESSION_ENDED");
	});

	it("shows the head and tail of long output, counts what it leaves out, and keeps only the newest bytes", async () => {
		const f = fixture();
		const long = await f.start("head -c 200000 /dev/zero | tr '\\0' a; echo; echo END");
		expect(long.state).toBe("exited");
		expect(long.output).toMatch(/^a{4096}\n\[\d+ bytes not shown\]\na+\nEND\n$/);
		expect(long.skippedBytes).toBe(200000 + 1 + 4 - 16384);
		expect(Buffer.byteLength(JSON.stringify(long.output))).toBeLessThan(21000);
		// Control bytes grow in JSON: the reply shrinks until it fits its envelope.
		const binary = await f.start("head -c 50000 /dev/zero | tr '\\0' '\\001'");
		expect(Buffer.byteLength(JSON.stringify(binary.output))).toBeLessThanOrEqual(16384 + 4096);
		const flood = await f.start(
			`head -c ${COMPANY_COMPUTER_SHELL_KEPT_OUTPUT + 5000} /dev/zero | tr '\\0' b; sleep 0.2`,
			0,
		);
		const drained = await f.read(flood.sessionId);
		expect(drained.state).toBe("exited");
		expect(drained.output).toMatch(/^\[\d+ earlier bytes not kept\]\n/);
	});

	it("shares one shell between commands and returns the same command for a repeated delivery", async () => {
		const f = fixture();
		await f.start("echo shared > /tmp/qorpera-shell-test-$PPID");
		const first = await f.shell.start({ runId: SHELL_RUN, key: "receipt-1", command: "echo once", signal: f.signal });
		expect((await f.read(first.sessionId)).output).toBe("once\n");
		const again = await f.shell.start({ runId: SHELL_RUN, key: "receipt-1", command: "echo once", signal: f.signal });
		expect(again.sessionId).toBe(first.sessionId);
		expect((await f.read(again.sessionId)).output).toBe("");
		expect(f.launch).toHaveBeenCalledTimes(1);
		const listed = f.shell.list();
		expect(listed.commands.map((entry) => entry.command)).toEqual([
			"echo once",
			"echo shared > /tmp/qorpera-shell-test-$PPID",
		]);
		expect(listed.commands[0]).toMatchObject({
			sessionId: first.sessionId,
			state: "exited",
			exitCode: 0,
			unreadBytes: 0,
		});
	});

	it("counts processes a command left behind as running, and ends everything on a stop without a session", async () => {
		const f = fixture();
		await f.start("true");
		expect(f.shell.busy).toBe(false);
		f.processes.count = 2;
		await vi.waitFor(() => expect(f.shell.busy).toBe(true));
		expect(f.shell.list().processes).toBe(2);
		const sleeper = await f.start("sleep 30", 50);
		expect(await f.shell.stop({ signal: f.signal })).toEqual({ stopped: 1 });
		expect((await f.read(sleeper.sessionId, 0)).state).toBe("stopped");
		expect(f.shell.busy).toBe(false);
		// The next command opens a fresh shell.
		f.processes.count = 0;
		expect(await f.start("echo fresh")).toMatchObject({ state: "exited", output: "fresh\n" });
		expect(f.launch).toHaveBeenCalledTimes(2);
	});

	it("reports commands as stopped when the shell itself ends", async () => {
		const f = fixture();
		const sleeper = await f.start("sleep 30", 50);
		f.hosts[0].crash();
		const ended = await f.read(sleeper.sessionId);
		expect(ended.state).toBe("stopped");
		await f.hosts[0].stop();
	});

	it("ends every command, with the reason, when the company is paused, and the next start opens a fresh shell", async () => {
		const f = fixture();
		const sleeper = await f.start("sleep 600 & sleep 600", 50);
		expect(f.shell.busy).toBe(true);
		await f.shell.pause("Stopped because the company was paused; start the command again when work resumes.");
		expect(await f.read(sleeper.sessionId, 0)).toMatchObject({
			state: "stopped",
			note: "Stopped because the company was paused; start the command again when work resumes.",
		});
		expect(f.shell.busy).toBe(false);
		expect(await f.start("echo back")).toMatchObject({ state: "exited", exitCode: 0, output: "back\n" });
		expect(f.launch).toHaveBeenCalledTimes(2);
	});

	it("cancelling a wait stops nothing: the command keeps running", async () => {
		const f = fixture();
		const { sessionId } = await f.shell.start({
			runId: SHELL_RUN,
			key: "long",
			command: "sleep 0.5; echo done",
			signal: f.signal,
		});
		const cancel = new AbortController();
		const waiting = f.shell.result({ sessionId, waitMs: 5000, signal: cancel.signal });
		cancel.abort();
		await expect(waiting).rejects.toThrow("OFFICE_SHELL_WAIT_CANCELLED");
		expect(await f.read(sessionId)).toMatchObject({ state: "exited", output: "done\n" });
	});

	it("refuses unknown sessions and ends every command when the screen closes", async () => {
		const f = fixture();
		expect(f.shell.known("00000000-0000-4000-8000-000000000001")).toBe(false);
		await expect(f.read("00000000-0000-4000-8000-000000000001", 0)).rejects.toThrow("OFFICE_SHELL_SESSION_UNKNOWN");
		await expect(
			f.shell.stop({ sessionId: "00000000-0000-4000-8000-000000000001", signal: f.signal }),
		).rejects.toThrow("OFFICE_SHELL_SESSION_UNKNOWN");
		const sleeper = await f.start("sleep 30", 50);
		await f.shell.close();
		expect((await f.read(sleeper.sessionId, 0)).state).toBe("stopped");
		await expect(f.start("echo after")).rejects.toThrow();
	});
});

describe("what the platform hears of a shell", () => {
	it("reports open commands with their run and when the agent last worked with them, and each end once", async () => {
		const f = fixture();
		const sleeper = await f.start("cat", 50);
		const quick = await f.start("echo hi");
		const report = f.shell.report();
		expect(report.open).toEqual([
			{
				id: sleeper.sessionId,
				runId: SHELL_RUN,
				// The start's key: on the computer, its effect receipt.
				receiptId: "key-0",
				command: "cat",
				startedAt: expect.any(String),
				workedAt: expect.any(String),
			},
		]);
		expect(report.ended).toEqual([
			{
				id: quick.sessionId,
				runId: SHELL_RUN,
				receiptId: "key-1",
				command: "echo hi",
				startedAt: expect.any(String),
				reason: "exited",
				endedAt: expect.any(String),
			},
		]);
		f.shell.reported([quick.sessionId]);
		expect(f.shell.report().ended).toEqual([]);
		// Typing into a command is working with it.
		await new Promise((resolve) => setTimeout(resolve, 5));
		await f.write(sleeper.sessionId, "x\n");
		expect(f.shell.report().open[0].workedAt > report.open[0].workedAt).toBe(true);
		await f.stop(sleeper.sessionId);
		expect(f.shell.report()).toEqual({
			open: [],
			ended: [expect.objectContaining({ id: sleeper.sessionId, reason: "stopped" })],
		});
	});

	it("gives each platform stop its own reason", async () => {
		const f = fixture();
		const paused = await f.start("sleep 600", 50);
		await f.shell.pause("Stopped because the company was paused; start the command again when work resumes.");
		const relieved = await f.start("sleep 600", 50);
		await f.shell.relieve("Stopped: the machine was running out of memory.");
		const all = await f.start("sleep 600", 50);
		await f.shell.stop({ signal: f.signal });
		const closed = await f.start("sleep 600", 50);
		await f.shell.close();
		const reasons = Object.fromEntries(f.shell.report().ended.map((ended) => [ended.id, ended.reason]));
		expect(reasons).toEqual({
			[paused.sessionId]: "paused",
			[relieved.sessionId]: "pressure",
			[all.sessionId]: "stopped",
			[closed.sessionId]: "closed",
		});
	});

	it("keeps a command's head whole: at most 300 characters, never half of one", async () => {
		const f = fixture();
		const command = `: ${"😀".repeat(400)}`;
		await f.start(command, 50);
		const reported = f.shell.report().ended[0]?.command ?? f.shell.report().open[0].command;
		expect(Array.from(reported)).toHaveLength(300);
		expect(reported).toBe(Array.from(command).slice(0, 300).join(""));
		// No lone surrogate: it survives UTF-8 unchanged.
		expect(Buffer.from(reported).toString()).toBe(reported);
	});

	it("is busy above 5% of one core, or 512 KiB moved, in a 30-second sample", () => {
		const before = { cpuTicks: 1000, ioBytes: 1_000_000, at: 0 };
		const after = (cpuTicks: number, ioBytes: number, at = 30000) => ({ cpuTicks, ioBytes, at });
		// 30 seconds: 1.5 processor-seconds (150 ticks) is busy, a tick less is not.
		expect(companyComputerShellBusy(before, after(1150, 1_000_000))).toBe(true);
		expect(companyComputerShellBusy(before, after(1149, 1_000_000))).toBe(false);
		// A slow download: little processor, 512 KiB moved is busy, a byte less is not.
		expect(companyComputerShellBusy(before, after(1002, 1_000_000 + 512 * 1024))).toBe(true);
		expect(companyComputerShellBusy(before, after(1002, 1_000_000 + 512 * 1024 - 1))).toBe(false);
		// A waiting server: a few ticks and a few bytes.
		expect(companyComputerShellBusy(before, after(1003, 1_000_100))).toBe(false);
		// No time passed, or time ran backwards, or counters fell (a process left the tree): never busy.
		expect(companyComputerShellBusy(before, after(5000, 9_000_000, 0))).toBe(false);
		expect(companyComputerShellBusy(before, after(5000, 9_000_000, -1))).toBe(false);
		expect(companyComputerShellBusy(before, after(10, 10))).toBe(false);
	});

	it("reads the bytes a process read and wrote, and nothing from what it cannot read", () => {
		expect(
			companyComputerProcessIoBytes(
				"rchar: 4096\nwchar: 1024\nsyscr: 7\nsyscw: 3\nread_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n",
			),
		).toBe(5120);
		expect(companyComputerProcessIoBytes("")).toBe(0);
		expect(companyComputerProcessIoBytes("rchar: 12\n")).toBe(12);
	});
});

/** A namespace that is only a script of events: what anything inside a shell could send. */
function scripted(pid = 4242) {
	let emit: (event: CompanyComputerShellHostEvent) => void = () => undefined;
	const sent: unknown[] = [];
	const ended: { resolve: () => void } = { resolve: () => undefined };
	const exited = new Promise<void>((resolve) => {
		ended.resolve = resolve;
	});
	const shell = new CompanyComputerLinuxShell(async (onEvent) => {
		emit = onEvent;
		return { send: (request) => void sent.push(request), exited, stop: async () => ended.resolve(), pid };
	});
	shells.push(shell);
	return { shell, emit: (event: CompanyComputerShellHostEvent) => emit(event), sent };
}

describe("a shell that is slow to start", () => {
	const signal = new AbortController().signal;
	function slow() {
		let emit: (event: CompanyComputerShellHostEvent) => void = () => undefined;
		const sent: { t: string; id: string }[] = [];
		const stopped = vi.fn(async () => undefined);
		const launch: { resolve(): void; reject(error: Error): void; cancelled: boolean } = {
			resolve: () => undefined,
			reject: () => undefined,
			cancelled: false,
		};
		const shell = new CompanyComputerLinuxShell(
			(onEvent, lifetime) =>
				new Promise((resolve, reject) => {
					// Like the real launcher: a cancelled start is confirmed gone and fails as its own.
					lifetime.addEventListener(
						"abort",
						() => {
							launch.cancelled = true;
							reject(new CompanyComputerActionFailedError(new Error("OFFICE_SHELL_CANCELLED")));
						},
						{ once: true },
					);
					emit = onEvent;
					launch.resolve = () =>
						resolve({
							send: (request) => void sent.push(request as { t: string; id: string }),
							exited: new Promise<void>(() => undefined),
							stop: stopped,
							pid: 601,
						});
					launch.reject = reject;
				}),
		);
		shells.push(shell);
		return { shell, launch, sent, stopped, emit: (event: CompanyComputerShellHostEvent) => emit(event) };
	}

	it("answers at once and sends the command when the shell is ready", async () => {
		const f = slow();
		const { sessionId } = await f.shell.start({ runId: SHELL_RUN, key: "a", command: "npm ci", signal });
		expect(await f.shell.result({ sessionId, waitMs: 0, signal })).toMatchObject({ state: "running", output: "" });
		expect(f.shell.busy).toBe(true);
		await expect(f.shell.write({ sessionId, text: "y\n", endInput: false, signal })).rejects.toThrow(
			"OFFICE_SHELL_STARTING",
		);
		f.launch.resolve();
		await vi.waitFor(() => expect(f.sent).toEqual([{ t: "start", id: sessionId, command: "npm ci" }]));
		expect(f.shell.namespacePid).toBe(601);
	});

	it("never sends a command stopped while its shell starts", async () => {
		const f = slow();
		const { sessionId } = await f.shell.start({ runId: SHELL_RUN, key: "a", command: "rm -rf build", signal });
		await f.shell.stop({ sessionId, signal });
		expect((await f.shell.result({ sessionId, waitMs: 0, signal })).state).toBe("stopped");
		f.launch.resolve();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(f.sent).toEqual([]);
	});

	it("ends its commands with a fixed reason when the shell cannot start, and the next start tries again", async () => {
		const f = slow();
		const { sessionId } = await f.shell.start({ runId: SHELL_RUN, key: "a", command: "make", signal });
		f.launch.reject(
			new CompanyComputerActionFailedError(new Error("OFFICE_PROCESS_GATE_TIMEOUT /run/office-screens/x")),
		);
		const ended = await f.shell.result({ sessionId, waitMs: 5000, signal });
		expect(ended).toMatchObject({ state: "stopped", note: "The shell could not start; start the command again." });
		expect(f.shell.busy).toBe(false);
		await f.shell.start({ runId: SHELL_RUN, key: "b", command: "make", signal });
		expect(f.shell.busy).toBe(true);
	});

	it("cancels a start when everything is stopped, and closing waits for it", async () => {
		const f = slow();
		const { sessionId } = await f.shell.start({ runId: SHELL_RUN, key: "a", command: "sleep 600", signal });
		expect(await f.shell.stop({ signal })).toEqual({ stopped: 1 });
		expect(f.launch.cancelled).toBe(true);
		expect((await f.shell.result({ sessionId, waitMs: 0, signal })).state).toBe("stopped");
		await f.shell.close();
		expect(f.sent).toEqual([]);
	});

	it("a pause also ends a shell still starting, and nothing is sent", async () => {
		const f = slow();
		const { sessionId } = await f.shell.start({ runId: SHELL_RUN, key: "a", command: "npm ci", signal });
		await f.shell.pause("Stopped because the company was paused; start the command again when work resumes.");
		expect(f.launch.cancelled).toBe(true);
		expect(await f.shell.result({ sessionId, waitMs: 0, signal })).toMatchObject({
			state: "stopped",
			note: "Stopped because the company was paused; start the command again when work resumes.",
		});
		await f.shell.close();
		expect(f.sent).toEqual([]);
	});

	it("stops a start that finished just as everything was stopped, before closing reports it gone", async () => {
		const f = slow();
		await f.shell.start({ runId: SHELL_RUN, key: "a", command: "sleep 600", signal });
		f.launch.resolve();
		// The launch has resolved but its handlers have not run yet.
		expect(await f.shell.stop({ signal })).toEqual({ stopped: 1 });
		await f.shell.close();
		expect(f.stopped).toHaveBeenCalled();
	});

	it("reports a start whose namespace could not be confirmed gone when closing", async () => {
		const f = slow();
		const { sessionId } = await f.shell.start({ runId: SHELL_RUN, key: "a", command: "make", signal });
		f.launch.reject(new Error("OFFICE_SHELL_DRAIN_UNCONFIRMED"));
		expect((await f.shell.result({ sessionId, waitMs: 5000, signal })).state).toBe("stopped");
		// It does not keep the machine on: powering off ends it.
		expect(f.shell.busy).toBe(false);
		shells.splice(shells.indexOf(f.shell), 1);
		await expect(f.shell.close()).rejects.toThrow("OFFICE_SHELL_DRAIN_UNCONFIRMED");
	});

	it("gives no restart reason to commands ended by closing", async () => {
		const f = slow();
		const { sessionId } = await f.shell.start({ runId: SHELL_RUN, key: "a", command: "make", signal });
		await f.shell.close();
		const ended = await f.shell.result({ sessionId, waitMs: 0, signal });
		expect(ended.state).toBe("stopped");
		expect(ended.note).toBeUndefined();
	});
});

describe("what a shell namespace reports is untrusted", () => {
	const signal = new AbortController().signal;

	it("ignores ids it never issued, output after an exit and a start never confirmed", async () => {
		const f = scripted();
		const { sessionId } = await f.shell.start({ runId: SHELL_RUN, key: "k", command: "true", signal });
		f.emit({ t: "out", id: "00000000-0000-4000-8000-000000000099", data: Buffer.from("forged").toString("base64") });
		f.emit({ t: "exit", id: "00000000-0000-4000-8000-000000000099", code: 0, signal: null });
		f.emit({ t: "out", id: sessionId, data: Buffer.from("real\n").toString("base64") });
		f.emit({ t: "exit", id: sessionId, code: 0, signal: null });
		f.emit({ t: "out", id: sessionId, data: Buffer.from("late").toString("base64") });
		f.emit({ t: "exit", id: sessionId, code: 9, signal: null });
		expect(await f.shell.result({ sessionId, waitMs: 0, signal })).toEqual({
			sessionId,
			state: "exited",
			exitCode: 0,
			output: "real\n",
		});
		expect(f.shell.known("00000000-0000-4000-8000-000000000099")).toBe(false);
	});

	it.each([
		'{"t":"out","id":"00000000-0000-4000-8000-000000000001","data":"not base64!"}',
		'{"t":"exit","id":"00000000-0000-4000-8000-000000000001","code":256,"signal":null}',
		'{"t":"exit","id":"00000000-0000-4000-8000-000000000001","code":null,"signal":"KILL"}',
		'{"t":"procs","count":-1}',
		'{"t":"started","id":"../etc"}',
		'{"t":"ready","extra":1}',
		`{"t":"out","id":"00000000-0000-4000-8000-000000000001","data":"${"A".repeat(90004)}"}`,
		`${" ".repeat(262145)}`,
	])("refuses a malformed or oversized event: %#", (line) => {
		expect(() => parseCompanyComputerShellHostEvent(line)).toThrow();
	});

	it("keeps a character split between two chunks whole, and bounds the list whatever the commands hold", async () => {
		const f = scripted();
		const { sessionId } = await f.shell.start({
			runId: SHELL_RUN,
			key: "k",
			command: `echo ${"\u0007".repeat(500)}`,
			signal,
		});
		f.emit({ t: "started", id: sessionId });
		const euro = Buffer.from("€");
		f.emit({
			t: "out",
			id: sessionId,
			data: Buffer.concat([Buffer.from("price "), euro.subarray(0, 1)]).toString("base64"),
		});
		expect((await f.shell.result({ sessionId, waitMs: 0, signal })).output).toBe("price ");
		f.emit({ t: "out", id: sessionId, data: euro.subarray(1).toString("base64") });
		expect((await f.shell.result({ sessionId, waitMs: 0, signal })).output).toBe("€");
		for (let index = 0; index < 60; index++)
			await f.shell.start({
				runId: SHELL_RUN,
				key: `k${index}`,
				command: `printf '${"\u0001".repeat(4000)}'`,
				signal,
			});
		const listed = f.shell.list();
		expect(listed.commands.length).toBeGreaterThan(0);
		expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(20 * 1024);
		expect(listed.commands.every((entry) => !/[\x00-\x1f]/.test(entry.command))).toBe(true);
	});
});

describe("the machine's memory and task safety", () => {
	const signal = new AbortController().signal;
	const GiB = 1024 ** 3;
	const pressure =
		(memoryBytes: number, tasks = 10) =>
		async () => ({
			memoryBytes,
			memoryMax: 4 * GiB,
			tasks,
			tasksMax: 512,
		});
	const usage = (entries: Record<number, { memoryBytes: number; tasks: number }>) =>
		vi.fn(
			async (pids: readonly number[]) =>
				new Map(
					pids.map((pid) => [pid, { cpuTicks: 0, ioBytes: 0, ...(entries[pid] ?? { memoryBytes: 0, tasks: 0 }) }]),
				),
		);

	it("does nothing without pressure, then ends only the shell holding the most, with the reason", async () => {
		const light = scripted(101);
		const heavy = scripted(102);
		const idle = scripted(103);
		const lightStart = await light.shell.start({ runId: SHELL_RUN, key: "a", command: "sleep 600", signal });
		const heavyStart = await heavy.shell.start({ runId: SHELL_RUN, key: "b", command: "npm run build", signal });
		const measured = usage({
			101: { memoryBytes: 100 * 1024 ** 2, tasks: 5 },
			102: { memoryBytes: 2 * GiB, tasks: 40 },
		});
		const calm = new CompanyComputerShellPressureGuard({
			shells: () => [light.shell, heavy.shell, idle.shell],
			intervalMs: 3_600_000,
			pressure: pressure(2 * GiB),
			usage: measured,
		});
		expect(await calm.check()).toBeUndefined();
		calm.close();
		expect(measured).not.toHaveBeenCalled();
		const guard = new CompanyComputerShellPressureGuard({
			shells: () => [light.shell, heavy.shell, idle.shell],
			intervalMs: 3_600_000,
			pressure: pressure(3.8 * GiB),
			usage: measured,
		});
		expect(await guard.check()).toBe(heavy.shell);
		guard.close();
		// One pass for all open shells; the idle shell has no namespace and is never weighed.
		expect(measured.mock.calls).toEqual([[[101, 102]]]);
		expect(await heavy.shell.result({ sessionId: heavyStart.sessionId, waitMs: 0, signal })).toMatchObject({
			state: "stopped",
			note: "Stopped because the machine was running out of memory; this shell used the most.",
		});
		expect((await light.shell.result({ sessionId: lightStart.sessionId, waitMs: 0, signal })).state).toBe("running");
	});

	it("never ends a small shell for pressure that comes from elsewhere", async () => {
		const small = scripted(201);
		const { sessionId } = await small.shell.start({ runId: SHELL_RUN, key: "a", command: "npm run dev", signal });
		const guard = new CompanyComputerShellPressureGuard({
			shells: () => [small.shell],
			intervalMs: 3_600_000,
			// Browsers and desktops hold the memory and the tasks; the shell holds 50 MB and 12 tasks.
			pressure: async () => ({ memoryBytes: 3.9 * GiB, memoryMax: 4 * GiB, tasks: 500, tasksMax: 512 }),
			usage: usage({ 201: { memoryBytes: 50 * 1024 ** 2, tasks: 12 } }),
		});
		expect(await guard.check()).toBeUndefined();
		guard.close();
		expect((await small.shell.result({ sessionId, waitMs: 0, signal })).state).toBe("running");
	});

	it("weighs tasks too when no shell holds a real share of the memory", async () => {
		const forks = scripted(401);
		const { sessionId } = await forks.shell.start({ runId: SHELL_RUN, key: "a", command: "make -j64", signal });
		const guard = new CompanyComputerShellPressureGuard({
			shells: () => [forks.shell],
			intervalMs: 3_600_000,
			pressure: async () => ({ memoryBytes: 3.9 * GiB, memoryMax: 4 * GiB, tasks: 500, tasksMax: 512 }),
			usage: usage({ 401: { memoryBytes: 20 * 1024 ** 2, tasks: 400 } }),
		});
		expect(await guard.check()).toBe(forks.shell);
		guard.close();
		expect((await forks.shell.result({ sessionId, waitMs: 0, signal })).note).toMatch(/running out of processes/);
	});

	it("refuses a start while the machine is ending the shell, then opens a fresh one", async () => {
		let finish: (() => void) | undefined;
		const launches: number[] = [];
		const shell = new CompanyComputerLinuxShell(async () => {
			launches.push(launches.length);
			let ended: () => void = () => undefined;
			const exited = new Promise<void>((resolve) => {
				ended = resolve;
			});
			return {
				send: () => undefined,
				exited,
				stop: () =>
					new Promise<void>((resolve) => {
						finish = () => {
							ended();
							resolve();
						};
					}),
				pid: 501,
			};
		});
		shells.push(shell);
		const first = await shell.start({ runId: SHELL_RUN, key: "a", command: "sleep 600", signal });
		const relieving = shell.relieve(
			"Stopped because the machine was running out of memory; this shell used the most.",
		);
		await vi.waitFor(() => expect(finish).toBeDefined());
		await expect(shell.start({ runId: SHELL_RUN, key: "b", command: "echo hi", signal })).rejects.toThrow(
			"OFFICE_SHELL_RESTARTING",
		);
		finish?.();
		finish = undefined;
		await relieving;
		expect((await shell.result({ sessionId: first.sessionId, waitMs: 0, signal })).note).toMatch(/out of memory/);
		await shell.start({ runId: SHELL_RUN, key: "c", command: "echo hi", signal });
		expect(launches).toEqual([0, 1]);
		const closing = shell.close();
		await vi.waitFor(() => expect(finish).toBeDefined());
		(finish as (() => void) | undefined)?.();
		await closing;
	});

	it("refuses a start while everything is being stopped", async () => {
		let finish: (() => void) | undefined;
		const shell = new CompanyComputerLinuxShell(async () => ({
			send: () => undefined,
			exited: new Promise<void>(() => undefined),
			stop: () =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
			pid: 701,
		}));
		shells.push(shell);
		await shell.start({ runId: SHELL_RUN, key: "a", command: "sleep 600", signal });
		const stopping = shell.stop({ signal });
		await vi.waitFor(() => expect(finish).toBeDefined());
		await expect(shell.start({ runId: SHELL_RUN, key: "b", command: "echo hi", signal })).rejects.toThrow(
			"OFFICE_SHELL_RESTARTING",
		);
		(finish as (() => void) | undefined)?.();
		await stopping;
		shells.splice(shells.indexOf(shell), 1);
	});

	it("weighs tasks when the machine runs out of processes", async () => {
		const few = scripted(301);
		const many = scripted(302);
		await few.shell.start({ runId: SHELL_RUN, key: "a", command: "sleep 600", signal });
		const { sessionId } = await many.shell.start({ runId: SHELL_RUN, key: "b", command: "make -j64", signal });
		const guard = new CompanyComputerShellPressureGuard({
			shells: () => [few.shell, many.shell],
			intervalMs: 3_600_000,
			pressure: pressure(0, 480),
			usage: usage({ 301: { memoryBytes: 3 * GiB, tasks: 3 }, 302: { memoryBytes: 10, tasks: 300 } }),
		});
		expect(await guard.check()).toBe(many.shell);
		guard.close();
		expect((await many.shell.result({ sessionId, waitMs: 0, signal })).note).toMatch(/running out of processes/);
	});
});
