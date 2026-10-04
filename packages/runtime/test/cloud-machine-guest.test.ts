import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCloudMachineCommandReceipt } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cancelMachineCommand,
	executeMachineCommand,
	type MachineGuestPorts,
	observeMachine,
	prepareMachineGuest,
	readMachineCommand,
	refreshMachineLease,
	runMachineGuestCli,
	runMachineWatchdog,
	startMachineCommand,
	stopMachineCommands,
} from "../src/cloud-machine-guest.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A machine's disk and /run in temporary folders, with systemd simulated:
 * `units` holds what `systemctl show` answers for each unit, and `files` the
 * kernel's files (cgroups and /proc) the guest reads. */
async function machine() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "machine-guest-")));
	roots.push(root);
	const home = join(root, "home");
	await mkdir(home);
	let boot = randomUUID();
	let now = 1_000_000;
	/** Command units a stop of the whole commands' slice does not end (it did not reach them), and ones it leaves failed
	 * (the others it ends cleanly, and systemd forgets them). */
	const survivors = new Set<string>();
	const failing = new Set<string>();
	const units = new Map<string, string>([
		["qorpera.slice", "ControlGroup=/qorpera.slice\nMainPID=0\n"],
		["lxd-agent.service", "ControlGroup=/system.slice/lxd-agent.service\nMainPID=90\n"],
	]);
	const files = new Map<string, string>([
		["/sys/fs/cgroup/qorpera.slice/cpu.stat", "usage_usec 7000000\nuser_usec 5000000\n"],
		["/sys/fs/cgroup/system.slice/lxd-agent.service/cpu.stat", "usage_usec 3000000\n"],
	]);
	const system = vi.fn(async (executable: string, args: readonly string[]) => {
		if (executable === "/usr/bin/systemd-run") {
			const unit = String(args.find((arg) => arg.startsWith("--unit="))).slice("--unit=".length);
			units.set(
				unit,
				`LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\nExecMainStatus=0\nControlGroup=/qorpera.slice/qorpera-machine.slice/${unit}\nMainPID=500\n`,
			);
		} else if (executable === "/usr/bin/systemctl" && args[0] === "show")
			// One block a unit, as systemd shows several.
			return args
				.slice(1)
				.filter((arg) => !arg.startsWith("--"))
				.map(
					(unit) =>
						units.get(unit) ?? "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\n",
				)
				.join("\n");
		else if (executable === "/usr/bin/systemctl" && args[0] === "stop" && args.includes("qorpera-machine.slice")) {
			for (const unit of [...units.keys()])
				if (unit.startsWith("qorpera-machine-command-") && !survivors.has(unit)) {
					if (failing.has(unit))
						units.set(
							unit,
							"LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=signal\nExecMainCode=2\nExecMainStatus=15\n",
						);
					else units.delete(unit);
				}
		} else if (executable === "/usr/bin/systemctl" && args[0] === "stop" && units.has(args[1]))
			units.set(
				args[1],
				"LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=signal\nExecMainCode=2\nExecMainStatus=15\n",
			);
		return "";
	});
	const ports: MachineGuestPorts = {
		stateRoot: join(root, "var"),
		runtimeRoot: join(root, "run"),
		helper: "/opt/qorpera-machine/cloud-machine-guest.mjs",
		nowMs: async () => now,
		bootId: async () => boot,
		system,
		readCpu: async () => "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3\n",
		readSystemFile: async (path: string) => {
			const contents = files.get(path);
			if (contents === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return contents;
		},
		// A cgroup directory lists what the kernel files under it name.
		listSystemDirectory: async (path: string) => [
			...new Set(
				[...files.keys()].flatMap((file) =>
					file.startsWith(`${path}/`) ? [file.slice(path.length + 1).split("/")[0]] : [],
				),
			),
		],
		home,
		requireRoot: false,
	};
	const machineId = randomUUID();
	const request = async (command: string, timeoutMs: number | null = null) => {
		const commandId = randomUUID();
		await writeFile(
			join(root, "var", "inbox", `${commandId}.json`),
			JSON.stringify({
				schema: "qorpera.machine-command-request/v1",
				machineId,
				commandId,
				inputSha256: "a".repeat(64),
				command,
				timeoutMs,
			}),
		);
		return commandId;
	};
	return {
		root,
		ports,
		system,
		units,
		files,
		survive: (commandId: string) => survivors.add(`qorpera-machine-command-${commandId}.service`),
		failOnStop: (commandId: string) => failing.add(`qorpera-machine-command-${commandId}.service`),
		machineId,
		request,
		reboot: () => {
			boot = randomUUID();
		},
		tick: (ms: number) => {
			now += ms;
		},
		exit: (commandId: string, code: number) =>
			units.set(
				`qorpera-machine-command-${commandId}.service`,
				`LoadState=loaded\nActiveState=${code ? "failed" : "active"}\nSubState=exited\nResult=${code ? "exit-code" : "success"}\nExecMainCode=1\nExecMainStatus=${code}\n`,
			),
	};
}

describe("machine command guest", () => {
	it("starts a command once, as root with no sandbox and no deadline, and reports how it ends", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const commandId = await m.request("docker compose up -d && npm test");
		const started = await startMachineCommand(commandId, m.ports);
		expect(started).toMatchObject({
			schema: "qorpera.machine-command-result/v1",
			machineId: m.machineId,
			commandId,
			state: "running",
		});
		const run = m.system.mock.calls.find(([executable]) => executable === "/usr/bin/systemd-run")?.[1] ?? [];
		expect(run).toContain(`--unit=qorpera-machine-command-${commandId}.service`);
		expect(run).toContain("--property=Slice=qorpera-machine.slice");
		expect(run).toContain("--property=KillMode=control-group");
		// A machine is the job's own VM: no uid switch, no sandbox and no deadline unless asked.
		expect(
			run.some((arg) =>
				/--uid|NoNewPrivileges|RestrictNamespaces|CapabilityBoundingSet|ProtectSystem|RuntimeMaxSec/.test(arg),
			),
		).toBe(false);
		expect(run.slice(-3)).toEqual(["/opt/qorpera-machine/cloud-machine-guest.mjs", "execute", commandId]);
		// Starting again with the same handle never runs it twice.
		await startMachineCommand(commandId, m.ports);
		expect(m.system.mock.calls.filter(([executable]) => executable === "/usr/bin/systemd-run")).toHaveLength(1);
		m.exit(commandId, 3);
		const ended = await readMachineCommand(commandId, {}, m.ports);
		expect(ended).toMatchObject({ state: "failed", exitCode: 3 });
		expect(parseCloudMachineCommandReceipt(ended)).toEqual(ended);
		// The end is kept: systemd may forget the unit.
		m.units.clear();
		expect(await readMachineCommand(commandId, {}, m.ports)).toMatchObject({ state: "failed", exitCode: 3 });
	});

	it("sets a deadline only when the agent chose one", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const commandId = await m.request("sleep 100", 90500);
		await startMachineCommand(commandId, m.ports);
		expect(m.system.mock.calls.find(([executable]) => executable === "/usr/bin/systemd-run")?.[1]).toContain(
			"--property=RuntimeMaxSec=91",
		);
	});

	it("starts nothing without a live lease, and the watchdog stops every command when the lease runs out", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		const commandId = await m.request("true");
		await expect(startMachineCommand(commandId, m.ports)).rejects.toThrow("MACHINE_GUEST_LEASE_UNAVAILABLE");
		await refreshMachineLease(10000, m.ports);
		expect(await runMachineWatchdog(m.ports)).toBe("live");
		m.tick(10001);
		expect(await runMachineWatchdog(m.ports)).toBe("stopped");
		expect(m.system).toHaveBeenLastCalledWith("/usr/bin/systemctl", ["stop", "qorpera-machine.slice"]);
		await expect(refreshMachineLease(5000, m.ports)).rejects.toThrow("MACHINE_GUEST_LEASE_INVALID");
	});

	it("loses the commands of an earlier boot and keeps the machine its own", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const commandId = await m.request("npm run dev");
		await startMachineCommand(commandId, m.ports);
		m.reboot();
		// A new boot must be claimed before anything is read.
		await expect(readMachineCommand(commandId, {}, m.ports)).rejects.toThrow("MACHINE_GUEST_BOOT_CHANGED");
		await prepareMachineGuest(m.machineId, 2, m.ports);
		expect(await readMachineCommand(commandId, {}, m.ports)).toMatchObject({ state: "lost", exitCode: null });
		await expect(prepareMachineGuest(randomUUID(), 3, m.ports)).rejects.toThrow(
			"MACHINE_GUEST_BELONGS_TO_ANOTHER_MACHINE",
		);
	});

	it("cancels a running command and says so", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const commandId = await m.request("sleep 1000");
		await startMachineCommand(commandId, m.ports);
		expect(await cancelMachineCommand(commandId, m.ports)).toMatchObject({ state: "cancelled", exitCode: null });
	});

	it("runs the command in a login shell and keeps its output with its exit status", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const commandId = await m.request("echo hello from $HOME; echo oops >&2; exit 3");
		await startMachineCommand(commandId, m.ports);
		expect(await executeMachineCommand(commandId, m.ports)).toBe(3);
		const log = await readFile(join(m.root, "var", "commands", commandId, "output.log"), "utf8");
		expect(log).toContain(`hello from ${m.ports.home}`);
		expect(log).toContain("oops");
		m.exit(commandId, 3);
		expect(await readMachineCommand(commandId, { tail: true, limit: 4096 }, m.ports)).toMatchObject({
			state: "failed",
			exitCode: 3,
		});
	});

	it("refuses to execute without its retained intent or lease, and says why in the log", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const commandId = await m.request("echo never");
		await startMachineCommand(commandId, m.ports);
		m.tick(900001);
		expect(await executeMachineCommand(commandId, m.ports)).toBe(125);
		expect(await readFile(join(m.root, "var", "commands", commandId, "output.log"), "utf8")).toBe(
			"MACHINE_GUEST_LEASE_UNAVAILABLE\n",
		);
	});

	it("reports ended commands with their output tail, lost starts and processor time for the executor", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const done = await m.request("true"),
			running = await m.request("sleep 1000"),
			unread = await m.request("npm run dev");
		await startMachineCommand(done, m.ports);
		await startMachineCommand(running, m.ports);
		await startMachineCommand(unread, m.ports);
		m.exit(done, 0);
		// The running command's unit in the commands' slice: its processor time, and its processes; 500 is the unit's
		// relay (this helper's execute step), which copies the output.
		const slice = "/sys/fs/cgroup/qorpera.slice/qorpera-machine.slice";
		const group = `${slice}/qorpera-machine-command-${running}.service`;
		m.files.set(`${group}/cpu.stat`, "usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\n");
		m.files.set(`${group}/cgroup.procs`, "500\n501\n502\n");
		m.files.set(
			"/proc/500/cmdline",
			// As Linux shows it: every argument ends with a NUL.
			`/usr/bin/node\0/opt/qorpera-machine/cloud-machine-guest.mjs\0execute\0${running}\0`,
		);
		m.files.set("/proc/500/io", "rchar: 9000000\nwchar: 9000000\n");
		m.files.set("/proc/501/cmdline", "/bin/bash\0-l\0-c\0sleep 1000\0");
		m.files.set("/proc/501/io", "rchar: 4096\nwchar: 1024\nsyscr: 7\n");
		m.files.set("/proc/502/io", "rchar: 100\nwchar: 0\n");
		// The other running command's unit has no readable processor time: left out, not busy. Something in the slice
		// that is no command unit is never measured.
		m.files.set(`${slice}/qorpera-machine-command-${unread}.service/cgroup.procs`, "");
		m.files.set(`${slice}/something-else.service/cpu.stat`, "usage_usec 99\n");
		const never = randomUUID();
		const observed = await observeMachine([done, running, unread, never], m.ports);
		expect(observed).toEqual({
			schema: "qorpera.machine-observation/v2",
			machineId: m.machineId,
			bootId: expect.any(String),
			at: 1_000_000,
			// /proc/stat in USER_HZ (100 a second): 150 of 1000 ticks busy; the own units' cgroups, in microseconds.
			cpu: { busyUsec: 1_500_000, totalUsec: 10_000_000, ownUsec: 10_000_000 },
			running: [{ commandId: running, cpuUsec: 2_500_000, ioBytes: 5220 }],
			next: null,
			ended: [
				{ commandId: done, state: "succeeded", exitCode: 0, outputTail: "" },
				{ commandId: never, state: "lost", exitCode: null, outputTail: "" },
			],
			// No stop in this boot yet.
			stopId: null,
		});
		// Own units whose cgroup systemd names outside the hierarchy, or not at all, are never read.
		m.units.set("qorpera.slice", "ControlGroup=/qorpera.slice/../../etc\n");
		m.units.set("lxd-agent.service", "ControlGroup=\n");
		expect(await observeMachine([], m.ports)).toMatchObject({ cpu: { ownUsec: 0 } });
	});

	it("marks what the machine's stop ends as the stop's, and nothing it did not end", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const killed = await m.request("npm run dev"),
			failed = await m.request("python crawl.py"),
			survivor = await m.request("sleep 1000"),
			done = await m.request("true");
		for (const id of [killed, failed, survivor, done]) await startMachineCommand(id, m.ports);
		m.exit(done, 0);
		m.survive(survivor);
		// The stop ends one cleanly (systemd then forgets its unit) and leaves the other failed.
		m.failOnStop(failed);
		const reply = await stopMachineCommands(m.ports);
		expect(reply).toEqual({
			schema: "qorpera.machine-commands-stopped/v1",
			machineId: m.machineId,
			bootId: expect.any(String),
			stopId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			stopped: expect.arrayContaining([killed, failed]),
		});
		expect(reply.stopped).toHaveLength(2);
		expect(m.system).toHaveBeenCalledWith("/usr/bin/systemctl", [
			"stop",
			"qorpera-machine.slice",
			"docker.service",
			"containerd.service",
		]);
		expect(m.system).toHaveBeenCalledWith("/usr/bin/sync", []);
		// The stopped ones end as lost by the stop, their units gone or failed; the one that ended before keeps its own end;
		// the one still running runs. Every look of this boot reports the stop.
		const observed = await observeMachine([killed, failed, survivor, done], m.ports);
		expect(observed.ended).toEqual([
			{ commandId: killed, state: "lost", exitCode: null, outputTail: "", stopped: true },
			{ commandId: failed, state: "lost", exitCode: null, outputTail: "", stopped: true },
			{ commandId: done, state: "succeeded", exitCode: 0, outputTail: "" },
		]);
		expect(observed.stopId).toBe(reply.stopId);
		// Seen again (or after a wake), the stopped one is still the stop's.
		expect(await observeMachine([killed], m.ports)).toMatchObject({
			ended: [{ commandId: killed, state: "lost", exitCode: null, outputTail: "", stopped: true }],
			stopId: reply.stopId,
		});
		// The command line asks for it by name and takes nothing else; each stop has an id of its own.
		const nonce = randomUUID();
		expect(await runMachineGuestCli([nonce, "stop-commands"], m.ports)).toBe(0);
		const again = JSON.parse(await readFile(join(m.root, "run", "replies", `${nonce}.json`), "utf8"));
		expect(again).toMatchObject({ schema: "qorpera.machine-commands-stopped/v1", stopped: [] });
		expect(again.stopId).not.toBe(reply.stopId);
		expect((await observeMachine([], m.ports)).stopId).toBe(again.stopId);
		// Another boot reports no stop.
		m.reboot();
		await prepareMachineGuest(m.machineId, 2, m.ports);
		expect((await observeMachine([], m.ports)).stopId).toBeNull();
	});

	it("keeps no stop while what it stops still shows active", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		// Docker does not stop.
		m.units.set("docker.service", "LoadState=loaded\nActiveState=deactivating\nSubState=stop-sigterm\n");
		expect(await stopMachineCommands(m.ports)).toMatchObject({ stopId: null, stopped: [] });
		expect((await observeMachine([], m.ports)).stopId).toBeNull();
		// Nor when systemd cannot be asked.
		m.units.delete("docker.service");
		m.system
			.mockImplementationOnce(async () => "")
			.mockImplementationOnce(async () => {
				throw new Error("MACHINE_GUEST_SERVICE_UNCONFIRMED");
			});
		expect(await stopMachineCommands(m.ports)).toMatchObject({ stopId: null });
	});

	it("measures every running command, also the ones beyond the executor's list, a page of 256 a look", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		const slice = "/sys/fs/cgroup/qorpera.slice/qorpera-machine.slice";
		const ids = Array.from({ length: 300 }, () => randomUUID()).sort();
		for (const [n, id] of ids.entries())
			m.files.set(`${slice}/qorpera-machine-command-${id}.service/cpu.stat`, `usage_usec ${n}\n`);
		// The executor lists none of them: SQL's list holds only the oldest 64 open commands.
		const first = await observeMachine([], m.ports);
		expect(first.running.map((item) => item.commandId)).toEqual(ids.slice(0, 256));
		expect(first.running[70]).toEqual({ commandId: ids[70], cpuUsec: 70, ioBytes: 0 });
		expect(first.next).toBe(ids[255]);
		// The next look carries on after it, and says it reached the end: the one after starts over.
		const second = await observeMachine([], m.ports, first.next);
		expect(second.running.map((item) => item.commandId)).toEqual(ids.slice(256));
		expect(second.next).toBeNull();
		await expect(observeMachine([], m.ports, "not-a-cursor")).rejects.toThrow("MACHINE_GUEST_OBSERVATION_INVALID");
	});

	it("keeps the ended commands' output tails within one reply", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const ended: string[] = [];
		for (let n = 0; n < 12; n++) {
			const id = await m.request(`echo ${n}`);
			await startMachineCommand(id, m.ports);
			m.exit(id, 0);
			ended.push(id);
		}
		// Each log holds 5000 bytes; a tail read gives its last `limit` of them.
		const observed = await observeMachine(ended, {
			...m.ports,
			readLog: async (options) => ({
				output: "x".repeat(Math.min(5000, options.read.limit ?? 5000)),
				truncated: true,
				log: { offset: 0, nextOffset: 5000, totalBytes: 5000, limitBytes: 67108864, limitReached: false },
			}),
		});
		const tails = observed.ended.map((item) => Buffer.byteLength(item.outputTail));
		expect(tails.slice(0, 8)).toEqual(Array(8).fill(2000));
		expect(tails.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(16384);
		expect(tails.at(-1)).toBe(0);
	});

	it("answers every command-line call in its own reply file, a refusal only by its code", async () => {
		const m = await machine();
		const nonce = randomUUID();
		expect(await runMachineGuestCli([nonce, "prepare", m.machineId, "7"], m.ports)).toBe(0);
		expect(JSON.parse(await readFile(join(m.root, "run", "replies", `${nonce}.json`), "utf8"))).toMatchObject({
			schema: "qorpera.machine-guest/v1",
			machineId: m.machineId,
			generation: 7,
		});
		const refused = randomUUID();
		await runMachineGuestCli([refused, "start", "not-a-command-id"], m.ports);
		expect(JSON.parse(await readFile(join(m.root, "run", "replies", `${refused}.json`), "utf8"))).toEqual({
			schema: "qorpera.machine-guest-refusal/v1",
			code: "INVALID_MACHINE_GUEST_ID",
		});
		await expect(runMachineGuestCli(["../escape", "prepare"], m.ports)).rejects.toThrow("INVALID_MACHINE_GUEST_ID");
	});
});
