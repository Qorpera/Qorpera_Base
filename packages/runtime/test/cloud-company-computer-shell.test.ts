import { PassThrough } from "node:stream";
import {
	COMPANY_COMPUTER_SHELL_KEPT_OUTPUT,
	CompanyComputerLinuxShell,
	type CompanyComputerShellEnvironmentLauncher,
	CompanyComputerShellPressureGuard,
} from "@qorpera/runtime/cloud-company-computer-linux-shell";
import {
	type CompanyComputerShellHostEvent,
	parseCompanyComputerShellHostEvent,
	runCompanyComputerShellHost,
} from "@qorpera/runtime/cloud-company-computer-shell-host";
import { afterEach, describe, expect, it, vi } from "vitest";

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
				relayPath: "/nonexistent/egress.sock",
				port: 0,
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
		read((await shell.start({ key: `key-${keys++}`, command, signal })).sessionId, waitMs);
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
		const running = await f.start("echo started; sleep 0.4; echo later", 50);
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
		const first = await f.shell.start({ key: "receipt-1", command: "echo once", signal: f.signal });
		expect((await f.read(first.sessionId)).output).toBe("once\n");
		const again = await f.shell.start({ key: "receipt-1", command: "echo once", signal: f.signal });
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

	it("cancelling a wait stops nothing: the command keeps running", async () => {
		const f = fixture();
		const { sessionId } = await f.shell.start({ key: "long", command: "sleep 0.5; echo done", signal: f.signal });
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

describe("what a shell namespace reports is untrusted", () => {
	const signal = new AbortController().signal;

	it("ignores ids it never issued, output after an exit and a start never confirmed", async () => {
		const f = scripted();
		const { sessionId } = await f.shell.start({ key: "k", command: "true", signal });
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
		const { sessionId } = await f.shell.start({ key: "k", command: `echo ${"\u0007".repeat(500)}`, signal });
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
			await f.shell.start({ key: `k${index}`, command: `printf '${"\u0001".repeat(4000)}'`, signal });
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
				new Map(pids.map((pid) => [pid, entries[pid] ?? { memoryBytes: 0, tasks: 0 }])),
		);

	it("does nothing without pressure, then ends only the shell holding the most, with the reason", async () => {
		const light = scripted(101);
		const heavy = scripted(102);
		const idle = scripted(103);
		const lightStart = await light.shell.start({ key: "a", command: "sleep 600", signal });
		const heavyStart = await heavy.shell.start({ key: "b", command: "npm run build", signal });
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
		const { sessionId } = await small.shell.start({ key: "a", command: "npm run dev", signal });
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

	it("weighs tasks when the machine runs out of processes", async () => {
		const few = scripted(301);
		const many = scripted(302);
		await few.shell.start({ key: "a", command: "sleep 600", signal });
		const { sessionId } = await many.shell.start({ key: "b", command: "make -j64", signal });
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
