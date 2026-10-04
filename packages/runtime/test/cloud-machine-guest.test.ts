import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
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
	const units = new Map<string, string>([
		["qorpera-control.slice", "ControlGroup=/qorpera.slice/qorpera-control.slice\n"],
		["lxd-agent.service", "ControlGroup=/system.slice/lxd-agent.service\n"],
	]);
	const files = new Map<string, string>([
		["/sys/fs/cgroup/qorpera.slice/qorpera-control.slice/cpu.stat", "usage_usec 200000\nuser_usec 100000\n"],
		["/sys/fs/cgroup/system.slice/lxd-agent.service/cpu.stat", "usage_usec 300000\n"],
	]);
	const system = vi.fn(async (executable: string, args: readonly string[]) => {
		if (executable === "/usr/bin/systemd-run") {
			const unit = String(args.find((arg) => arg.startsWith("--unit="))).slice("--unit=".length);
			units.set(
				unit,
				"LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\nExecMainStatus=0\n",
			);
		} else if (executable === "/usr/bin/systemctl" && args[0] === "show")
			return units.get(args[1]) ?? "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\n";
		// Stopping the commands' slice ends every command unit in it, and systemd forgets them.
		else if (executable === "/usr/bin/systemctl" && args[0] === "stop" && args[1] === "qorpera-machine.slice") {
			for (const unit of [...units.keys()]) if (unit.startsWith("qorpera-machine-command-")) units.delete(unit);
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
		// A kernel directory lists what the files under it name.
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
		/** A process: its cgroup, its arguments (NUL-ended) and its /proc io. */
		process: (pid: number, cgroup: string, cmdline: string, io: string) => {
			files.set(`/proc/${pid}/cgroup`, `0::${cgroup}\n`);
			files.set(`/proc/${pid}/cmdline`, cmdline);
			files.set(`/proc/${pid}/io`, io);
		},
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

	it("reports ended commands with their output tail, lost starts, and the whole machine's work apart from its own control", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const done = await m.request("true"),
			running = await m.request("sleep 1000");
		await startMachineCommand(done, m.ports);
		await startMachineCommand(running, m.ports);
		m.exit(done, 0);
		const never = randomUUID();
		const unit = `/qorpera.slice/qorpera-machine.slice/qorpera-machine-command-${running}.service`;
		// The command's shell counts; its relay only copies its output to the log. A container counts. The executor's
		// helper call under the LXD agent and the watchdog are the machine's own control. A kernel thread moves nothing.
		m.process(501, unit, "/bin/bash\0-l\0-c\0sleep 1000\0", "rchar: 4096\nwchar: 1024\nsyscr: 7\n");
		m.process(
			500,
			unit,
			`/usr/bin/node\0/opt/qorpera-machine/cloud-machine-guest.mjs\0execute\0${running}\0`,
			"rchar: 9000000\nwchar: 9000000\n",
		);
		m.process(600, `/system.slice/docker-${"c".repeat(64)}.scope`, "nginx\0", "rchar: 100000\nwchar: 0\n");
		m.process(700, "/system.slice/lxd-agent.service", "node\0helper\0observe\0", "rchar: 50000000\nwchar: 0\n");
		m.process(
			800,
			"/qorpera.slice/qorpera-control.slice/qorpera-machine-watchdog.service",
			"node\0helper\0watchdog\0",
			"rchar: 70000000\nwchar: 0\n",
		);
		m.files.set("/proc/2/cgroup", "0::/\n");
		const observed = await observeMachine([done, running, never], m.ports);
		expect(observed).toEqual({
			schema: "qorpera.machine-observation/v2",
			machineId: m.machineId,
			bootId: expect.any(String),
			at: 1_000_000,
			// /proc/stat in USER_HZ (100 a second): 150 ticks busy, 1.5 s, less the own units' 0.5 s.
			cpuUsec: 1_000_000,
			ioBytes: 5120 + 100000,
			ended: [
				{ commandId: done, state: "succeeded", exitCode: 0, outputTail: "" },
				{ commandId: never, state: "lost", exitCode: null, outputTail: "" },
			],
		});
		// An own unit whose cgroup systemd names outside the hierarchy, or not at all, is never read, nor is anything
		// left out for it.
		m.units.set("qorpera-control.slice", "ControlGroup=/qorpera.slice/../../etc\n");
		m.units.set("lxd-agent.service", "ControlGroup=\n");
		expect(await observeMachine([], m.ports)).toMatchObject({
			cpuUsec: 1_500_000,
			ioBytes: 5120 + 100000 + 50000000 + 70000000,
		});
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

	it("keeps the whole reply within the executor's 64 KiB: 64 ended commands whose tails JSON escapes", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		const ended: string[] = [];
		for (let n = 0; n < 64; n++) {
			const id = await m.request(`printf x; exit ${n + 100}`);
			await startMachineCommand(id, m.ports);
			m.exit(id, n + 100);
			ended.push(id);
		}
		// Every log ends in escape characters, which JSON writes as six bytes each.
		const ports: MachineGuestPorts = {
			...m.ports,
			readLog: async (options) => ({
				output: "".repeat(Math.min(2000, options.read.limit ?? 2000)),
				truncated: true,
				log: { offset: 0, nextOffset: 2000, totalBytes: 2000, limitBytes: 67108864, limitReached: false },
			}),
		};
		const nonce = randomUUID();
		expect(await runMachineGuestCli([nonce, "observe", ended.join(",")], ports)).toBe(0);
		const text = await readFile(join(m.root, "run", "replies", `${nonce}.json`), "utf8");
		const reply = JSON.parse(text);
		expect(reply.ended).toHaveLength(64);
		// 333 escapes (1998 bytes) a tail until the tails' 16 KiB is spent.
		expect(reply.ended[0].outputTail).toBe("".repeat(333));
		expect(
			reply.ended.reduce(
				(sum: number, item: { outputTail: string }) => sum + Buffer.byteLength(JSON.stringify(item.outputTail)) - 2,
				0,
			),
		).toBeLessThanOrEqual(16384);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
	});

	it("lists what runs right before a stop, oldest first, and whether Docker ran containers, then stops it", async () => {
		const m = await machine();
		await prepareMachineGuest(m.machineId, 1, m.ports);
		await refreshMachineLease(900000, m.ports);
		// An earlier boot's command is that boot's.
		const earlier = await m.request("sleep 1");
		await startMachineCommand(earlier, m.ports);
		m.reboot();
		await prepareMachineGuest(m.machineId, 2, m.ports);
		await refreshMachineLease(900000, m.ports);
		const ids: string[] = [];
		for (let n = 0; n < 34; n++) {
			const id = await m.request(`job ${n}`);
			await startMachineCommand(id, m.ports);
			ids.push(id);
		}
		// Started in the order of ids; the first one ended on its own.
		for (const [n, id] of ids.entries()) {
			const at = new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + n * 1000);
			await utimes(join(m.root, "var", "commands", id, "intent.json"), at, at);
		}
		m.exit(ids[0], 0);
		// A container runs, under systemd's cgroup driver.
		m.files.set(`/sys/fs/cgroup/system.slice/docker-${"d".repeat(64)}.scope/cgroup.procs`, "600\n");
		expect(await stopMachineCommands(m.ports)).toEqual({
			schema: "qorpera.machine-commands-stopped/v1",
			machineId: m.machineId,
			bootId: expect.any(String),
			commands: ids.slice(1, 33),
			containers: true,
		});
		expect(m.system).toHaveBeenCalledWith("/usr/bin/systemctl", [
			"stop",
			"qorpera-machine.slice",
			"docker.service",
			"containerd.service",
		]);
		expect(m.system).toHaveBeenCalledWith("/usr/bin/sync", []);
		expect((await stat(join(m.root, "var", "commands", ids[1], "intent.json"))).isFile()).toBe(true);
		// Stopped again: nothing runs. Under the cgroupfs driver a container is a group under docker/.
		m.files.delete(`/sys/fs/cgroup/system.slice/docker-${"d".repeat(64)}.scope/cgroup.procs`);
		m.files.set(`/sys/fs/cgroup/docker/${"e".repeat(64)}/cgroup.procs`, "700\n");
		expect(await stopMachineCommands(m.ports)).toMatchObject({ commands: [], containers: true });
		m.files.delete(`/sys/fs/cgroup/docker/${"e".repeat(64)}/cgroup.procs`);
		// The command line asks for it by name and takes nothing else.
		const nonce = randomUUID();
		expect(await runMachineGuestCli([nonce, "stop-commands"], m.ports)).toBe(0);
		expect(JSON.parse(await readFile(join(m.root, "run", "replies", `${nonce}.json`), "utf8"))).toMatchObject({
			schema: "qorpera.machine-commands-stopped/v1",
			commands: [],
			containers: false,
		});
		const refused = randomUUID();
		await runMachineGuestCli([refused, "stop-commands", "now"], m.ports);
		expect(JSON.parse(await readFile(join(m.root, "run", "replies", `${refused}.json`), "utf8"))).toMatchObject({
			code: "INVALID_MACHINE_GUEST_ARGUMENTS",
		});
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
