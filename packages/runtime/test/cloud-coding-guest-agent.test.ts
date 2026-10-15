import { randomUUID } from "node:crypto";
import {
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { CODING_GUEST, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodingGuestAgentPorts, runCodingGuestAgent } from "../src/cloud-coding-guest-agent.ts";

interface Unit {
	ActiveState: string;
	Result: string;
	ExecMainCode: string;
	ExecMainStatus: string;
}
interface MachineState {
	boot: string;
	skewMs: number;
	folderInMemory: boolean;
	/** What the folder program does once started: mounts, exits 3 (the node closed the view), or stays silent. */
	folder: "mount" | "close" | "silent";
	/** What a command's unit does: runs the real relay, holds, or systemd-run refuses it. */
	command: "relay" | "hold" | "refuse";
	stuckMount: boolean;
	/** Units a stop leaves running. */
	stubborn: Set<string>;
	/** Runs while `systemctl show` reads a unit, before it answers. */
	onShow?: (unit: string) => Promise<void>;
	processUid: number;
	terminateAtOnce: boolean;
	realSleep: boolean;
	useraddGate: Promise<void>;
}

const UID = 200001;
const GID = 200001;
const VIEW = { environmentId: "env-1", viewId: "view-1", pass: "pass-secret-1" };
const INACTIVE: Unit = { ActiveState: "inactive", Result: "success", ExecMainCode: "0", ExecMainStatus: "0" };
const ACTIVE: Unit = { ...INACTIVE, ActiveState: "active" };
const TIMED_OUT: Unit = { ActiveState: "failed", Result: "timeout", ExecMainCode: "2", ExecMainStatus: "15" };
const PROPERTIES = "--property=LoadState,ActiveState,Result,ExecMainCode,ExecMainStatus";
/** 17 bytes on both streams, then exit 3. */
const HELLO = "printf 'hello world\\n'; printf 'oops\\n' >&2; exit 3";
/** Ten 9-byte lines: 90 bytes. */
const TEN_LINES = "for i in 1 2 3 4 5 6 7 8 9 10; do printf 'line %03d\\n' $i; done";
const LINES = Array.from({ length: 10 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}\n`).join("");
const EXIT_0 = JSON.stringify({ code: 0, signal: null });

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function failure(status: number): Error {
	return Object.assign(new Error("CODING_GUEST_SYSTEM_UNCONFIRMED"), { status });
}
function collector() {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk: Buffer, _encoding, done) {
			chunks.push(Buffer.from(chunk));
			done();
		},
	});
	return { stream, bytes: () => Buffer.concat(chunks) };
}

/** A coding machine whose tools are only recorded: the passwd files, units and mounts live in maps. */
async function machine() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-guest-agent-")));
	roots.push(root);
	const stateRoot = join(root, "state");
	const runRoot = join(root, "run");
	const folderRoot = join(root, "folder");
	const systemdRoot = join(root, "systemd");
	const subuid = join(root, "subuid");
	const subgid = join(root, "subgid");
	const resolv = join(root, "resolv.conf");
	const work = join(root, "work");
	await mkdir(work);
	await writeFile(resolv, "nameserver 192.0.2.53\n");
	const calls: string[][] = [];
	const chowns: [string, number, number][] = [];
	const sleeps: number[] = [];
	const units = new Map<string, Unit>();
	const mounts = new Map<string, string>();
	const passwd = new Map<number, string>();
	const groups = new Map<number, string>();
	const relays: (() => Promise<void>)[] = [];
	const state: MachineState = {
		boot: randomUUID(),
		skewMs: 0,
		folderInMemory: true,
		folder: "mount",
		command: "relay",
		stuckMount: false,
		stubborn: new Set(),
		processUid: UID,
		terminateAtOnce: false,
		realSleep: false,
		useraddGate: Promise.resolve(),
	};
	function systemctl(args: readonly string[]): string {
		const [action, ...names] = args;
		if (action === "show") {
			const unit = units.get(names[0]) ?? INACTIVE;
			return `LoadState=loaded\nActiveState=${unit.ActiveState}\nResult=${unit.Result}\nExecMainCode=${unit.ExecMainCode}\nExecMainStatus=${unit.ExecMainStatus}`;
		}
		if (action === "stop") {
			const slice = /^qorpera-coding-([0-9a-f]{32})\.slice$/.exec(names[0]);
			const stopping = [
				names[0],
				...(slice ? [...units.keys()].filter((unit) => unit.startsWith(`qorpera-coding-${slice[1]}-`)) : []),
			];
			for (const unit of stopping) if (!state.stubborn.has(unit)) units.set(unit, { ...INACTIVE });
			const folder = /^qorpera-folder-([0-9a-f]{32})\.service$/.exec(names[0]);
			if (folder && !state.stuckMount) mounts.delete(join(folderRoot, "mounts", folder[1]));
		}
		if (action === "reset-failed")
			for (const unit of names) if (units.get(unit)?.ActiveState === "failed") units.set(unit, { ...INACTIVE });
		return "";
	}
	async function systemdRun(args: readonly string[]): Promise<string> {
		const unit = (args.find((arg) => arg.startsWith("--unit=")) ?? "").slice("--unit=".length);
		if (unit.startsWith("qorpera-folder-")) {
			units.set(
				unit,
				state.folder === "close"
					? { ActiveState: "failed", Result: "exit-code", ExecMainCode: "1", ExecMainStatus: "3" }
					: { ...ACTIVE },
			);
			if (state.folder === "mount")
				mounts.set(args[args.indexOf("--mountpoint") + 1], "fuse.qorpera qorpera-company");
			return "";
		}
		if (state.command === "refuse") throw failure(1);
		units.set(unit, { ...ACTIVE });
		if (state.command === "relay") {
			const file = (args.find((arg) => arg.startsWith("StandardInput=file:")) ?? "").slice(
				"StandardInput=file:".length,
			);
			// systemd opens the input as the unit starts; the agent removes it right after.
			const input = await readFile(file);
			const [worker, command] = args.slice(-2);
			relays.push(async () => {
				const code = await runCodingGuestAgent(
					["relay", worker, command],
					Readable.from([input]),
					collector().stream,
					ports,
				);
				units.set(
					unit,
					code === 0
						? { ...INACTIVE }
						: { ActiveState: "failed", Result: "exit-code", ExecMainCode: "1", ExecMainStatus: String(code) },
				);
			});
		}
		return "";
	}
	const ports: CodingGuestAgentPorts = {
		stateRoot,
		runtimeRoot: runRoot,
		folderRoot,
		systemdRoot,
		subidFiles: { uid: subuid, gid: subgid },
		resolvConf: resolv,
		system: async (executable, args) => {
			const tool = basename(executable);
			calls.push([tool, ...args]);
			if (tool === "getent") {
				const entry = (args[0] === "passwd" ? passwd : groups).get(Number(args[1]));
				if (entry === undefined) throw failure(2);
				return `${entry}\n`;
			}
			if (tool === "groupadd") groups.set(Number(args[1]), `${args[2]}:x:${args[1]}:`);
			if (tool === "useradd") {
				await state.useraddGate;
				const name = args[args.length - 1];
				passwd.set(Number(args[1]), `${name}:x:${args[1]}:${args[3]}::/home/${name}:/bin/bash`);
			}
			if (tool === "usermod")
				for (const [flag, file] of [
					["--add-subuids", subuid],
					["--add-subgids", subgid],
				]) {
					const at = args.indexOf(flag);
					if (at < 0) continue;
					const [first, last] = args[at + 1].split("-").map(Number);
					await appendFile(file, `${args[args.length - 1]}:${first}:${last - first + 1}\n`);
				}
			if (tool === "umount" && !state.stuckMount) mounts.delete(args[args.length - 1]);
			if (tool === "systemctl" && args[0] === "show") await state.onShow?.(args[1]);
			if (tool === "systemctl") return systemctl(args);
			if (tool === "systemd-run") return systemdRun(args);
			return "";
		},
		bootId: async () => state.boot,
		nowMs: () => Date.now() + state.skewMs,
		sleep: async (ms) => {
			sleeps.push(ms);
			await delay(state.realSleep ? ms : 1);
		},
		readMountinfo: async () =>
			`${[
				"22 1 8:1 / / rw shared:1 - ext4 /dev/sda1 rw",
				...(state.folderInMemory ? [`30 22 0:30 / ${folderRoot} rw,nosuid shared:5 - tmpfs tmpfs rw`] : []),
				...[...mounts].map(
					([point, what], index) =>
						`${40 + index} 30 0:${40 + index} / ${point} rw shared:${6 + index} - ${what} rw`,
				),
			].join("\n")}\n`,
		chown: async (path, uid, gid) => {
			chowns.push([path, uid, gid]);
		},
		lockWaitSeconds: 1,
		ring: { segmentBytes: 16, segments: 3 },
		requireRoot: false,
		processUid: () => state.processUid,
		onTerminate: (listener) => {
			if (state.terminateAtOnce) listener();
			return () => undefined;
		},
	};
	return {
		root,
		stateRoot,
		runRoot,
		folderRoot,
		systemdRoot,
		subuid,
		subgid,
		resolv,
		work,
		calls,
		chowns,
		sleeps,
		units,
		mounts,
		passwd,
		groups,
		state,
		ports,
		/** Runs the relays the command units started, to their ends. */
		settle: async () => {
			while (relays.length > 0) await Promise.all(relays.splice(0).map((start) => start()));
		},
	};
}
type Machine = Awaited<ReturnType<typeof machine>>;

const compact = (id: string) => id.replaceAll("-", "");
function sessionAt(m: Machine, workerId: string) {
	const w = compact(workerId);
	return {
		w,
		session: join(m.stateRoot, "sessions", w),
		user: join(m.stateRoot, "sessions", w, "user.json"),
		view: join(m.folderRoot, "views", `${w}.json`),
		folderState: join(m.folderRoot, "state", w),
		mountpoint: join(m.folderRoot, "mounts", w),
		folderUnit: `qorpera-folder-${w}.service`,
		slice: `qorpera-coding-${w}.slice`,
		namespace: `qorpera-${w}`,
	};
}
function commandAt(m: Machine, workerId: string, commandId: string) {
	const w = compact(workerId);
	const c = compact(commandId);
	const directory = join(m.stateRoot, "sessions", w, "commands", c);
	return {
		commandId,
		c,
		directory,
		intent: join(directory, "intent.json"),
		cancel: join(directory, "cancel.json"),
		outcome: join(directory, "outcome.json"),
		output: join(directory, "output"),
		input: join(m.runRoot, "inputs", `${w}-${c}.json`),
		unit: `qorpera-coding-${w}-${c}.service`,
	};
}

function mountRequest(workerId: string, view = VIEW, uid = UID) {
	return { schema: "qorpera.coding-guest-mount/v1", workerId, uid, gid: uid, view };
}
function runRequest(
	m: Machine,
	workerId: string,
	commandId: string,
	command: string,
	environment: Record<string, string> = { PATH: "/usr/bin:/bin" },
) {
	return {
		schema: "qorpera.coding-guest-run/v1",
		workerId,
		commandId,
		uid: UID,
		gid: GID,
		command,
		cwd: m.work,
		environment,
		timeoutMs: 60000,
	};
}
function outputRequest(workerId: string, commandId: string, offset: number, maxBytes = 4096, waitMs = 0) {
	return { schema: "qorpera.coding-guest-output/v1", workerId, commandId, offset, maxBytes, waitMs };
}
function sessionRequest(workerId: string) {
	return { schema: "qorpera.coding-guest-session/v1", workerId };
}
const refusal = (code: string) => ({ schema: "qorpera.coding-guest-refusal/v1", code });
const show = (unit: string) => ["systemctl", "show", unit, PROPERTIES];
/** A call list with each systemd-run cut to its unit. */
const brief = (calls: string[][]) => calls.map((entry) => (entry[0] === "systemd-run" ? entry.slice(0, 3) : entry));
const mode = async (path: string) => (await lstat(path)).mode & 0o777;
const gone = (path: string) => expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });

/** One verb through the agent's entry: its exit code, its answer line and the bytes after it. */
async function call(m: Machine, verb: string, request: unknown, argv: string[] = [verb]) {
	const sink = collector();
	const text = typeof request === "string" ? request : JSON.stringify(request);
	const code = await runCodingGuestAgent(argv, Readable.from([Buffer.from(text)]), sink.stream, m.ports);
	const raw = sink.bytes();
	const newline = raw.indexOf("\n");
	return { code, line: JSON.parse(raw.subarray(0, newline).toString("utf8")), bytes: raw.subarray(newline + 1), raw };
}
async function mounted(m: Machine, workerId = randomUUID()): Promise<string> {
	expect((await call(m, "mount", mountRequest(workerId))).line.mount).toBe("mounted");
	m.calls.length = 0;
	return workerId;
}
async function ringText(output: string): Promise<string> {
	const names = (await readdir(output)).filter((name) => name.endsWith(".out")).sort();
	return (await Promise.all(names.map((name) => readFile(join(output, name), "utf8")))).join("");
}
const readJsonFile = async (path: string) => JSON.parse(await readFile(path, "utf8"));
/** Starts a command and runs its relay to its end. */
async function ran(m: Machine, workerId: string, command: string, commandId = randomUUID()) {
	const answer = await call(m, "run", runRequest(m, workerId, commandId, command));
	expect(answer.line).toMatchObject({ commandId, state: "running" });
	await m.settle();
	return commandAt(m, workerId, commandId);
}
/** The relay as its unit runs it: no answer line, only its exit code. */
async function relay(m: Machine, request: unknown, argv: string[]) {
	const sink = collector();
	const code = await runCodingGuestAgent(
		["relay", ...argv],
		Readable.from([Buffer.from(typeof request === "string" ? request : JSON.stringify(request))]),
		sink.stream,
		m.ports,
	);
	expect(sink.bytes()).toHaveLength(0);
	return code;
}
async function relayed(
	m: Machine,
	command: string,
	change: { cwd?: string; environment?: Record<string, string> } = {},
) {
	const request = { ...runRequest(m, randomUUID(), randomUUID(), command), ...change };
	const x = commandAt(m, request.workerId, request.commandId);
	await mkdir(x.output, { recursive: true });
	return { x, code: await relay(m, request, [compact(request.workerId), x.c]) };
}
/** A command's records as an earlier run left them. */
async function plant(
	m: Machine,
	workerId: string,
	options: { boot?: string; exit?: string; cancel?: boolean; unit?: Unit; inputAgeMs?: number } = {},
) {
	const x = commandAt(m, workerId, randomUUID());
	await mkdir(x.output, { recursive: true });
	await writeFile(
		x.intent,
		JSON.stringify({
			schema: "qorpera.coding-guest-intent/v1",
			commandId: x.commandId,
			digest: "a".repeat(64),
			bootId: options.boot ?? m.state.boot,
		}),
	);
	if (options.exit !== undefined) await writeFile(join(x.output, "exit.json"), options.exit);
	if (options.cancel)
		await writeFile(x.cancel, JSON.stringify({ schema: "qorpera.coding-guest-cancel/v1", commandId: x.commandId }));
	if (options.unit) m.units.set(x.unit, options.unit);
	if (options.inputAgeMs !== undefined) {
		await mkdir(dirname(x.input), { recursive: true });
		await writeFile(x.input, "{}");
		const at = (Date.now() - options.inputAgeMs) / 1000;
		await utimes(x.input, at, at);
	}
	return x;
}
/** The session's commands by id, as status reads them. */
async function seen(m: Machine, workerId: string) {
	const answer = await call(m, "status", sessionRequest(workerId));
	expect(answer.line).toMatchObject({ schema: "qorpera.coding-guest-status/v1", workerId });
	return new Map(
		answer.line.commands.map((command: { commandId: string }) => [command.commandId, command] as const),
	) as Map<string, unknown>;
}
const NAT_RULES = [
	"table inet qorpera_guest",
	"delete table inet qorpera_guest",
	"table inet qorpera_guest {",
	"\tchain postrouting {",
	"\t\ttype nat hook postrouting priority srcnat; policy accept;",
	'\t\tip saddr 10.253.0.0/16 oifname != "qgh*" masquerade',
	"\t}",
	"\tchain forward {",
	"\t\ttype filter hook forward priority filter; policy accept;",
	'\t\tiifname "qgh*" oifname "qgh*" drop',
	"\t}",
	"}",
	"",
].join("\n");

describe("the coding guest agent's entry", () => {
	it("refuses an unknown verb or extra arguments, exiting 0", async () => {
		const m = await machine();
		for (const argv of [["exec"], ["status", "extra"], []]) {
			const answer = await call(m, "status", sessionRequest(randomUUID()), argv);
			expect(answer.code).toBe(0);
			expect(answer.line).toEqual(refusal("CODING_GUEST_ARGUMENTS_INVALID"));
			expect(answer.bytes).toHaveLength(0);
		}
		expect(m.calls).toEqual([]);
	});
	it("refuses an invalid or oversize request without quoting it", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const request = mountRequest(workerId);
		const oversize = runRequest(m, workerId, randomUUID(), "true", {
			A: "x".repeat(32768),
			B: "x".repeat(32768),
			PASS: "pass-secret-1",
		});
		for (const [verb, input] of [
			["mount", JSON.stringify({ ...request, extra: 1 })],
			["mount", JSON.stringify({ ...request, view: { ...VIEW, pass: "pass-secret-1 x" } })],
			["mount", "not json pass-secret-1"],
			["run", JSON.stringify(oversize)],
		]) {
			const answer = await call(m, verb, input);
			expect(answer.code).toBe(0);
			expect(answer.line).toEqual(refusal("CODING_GUEST_REQUEST_INVALID"));
			expect(answer.raw.toString()).not.toContain("pass-secret-1");
		}
		expect(m.calls).toEqual([]);
	});
	it.runIf(process.getuid?.() !== 0)("requires root unless its ports say otherwise", async () => {
		const m = await machine();
		m.ports.requireRoot = true;
		const answer = await call(m, "status", sessionRequest(randomUUID()));
		expect(answer).toMatchObject({ code: 0, line: refusal("CODING_GUEST_REQUIRES_ROOT") });
	});
});

describe("mounting a session", () => {
	it("makes the session's user, sub-ids and network, shows its view and points its user manager at it", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const s = sessionAt(m, workerId);
		const ns = s.namespace;
		const answer = await call(m, "mount", mountRequest(workerId));
		expect(answer.code).toBe(0);
		expect(answer.line).toEqual({
			schema: "qorpera.coding-guest-mounted/v1",
			workerId,
			viewId: "view-1",
			mount: "mounted",
		});
		expect(answer.bytes).toHaveLength(0);
		expect(answer.raw.toString()).not.toContain("pass-secret-1");
		expect(brief(m.calls)).toEqual([
			["getent", "passwd", "200001"],
			["getent", "group", "200001"],
			["groupadd", "--gid", "200001", "qorpera-200001"],
			[
				"useradd",
				"--uid",
				"200001",
				"--gid",
				"200001",
				"--groups",
				"qorpera-coding",
				"--create-home",
				"--home-dir",
				"/home/qorpera-200001",
				"--shell",
				"/bin/bash",
				"-K",
				"SUB_UID_COUNT=0",
				"-K",
				"SUB_GID_COUNT=0",
				"qorpera-200001",
			],
			["chmod", "0700", "/home/qorpera-200001"],
			["usermod", "--add-subuids", "1048576-1114111", "--add-subgids", "1048576-1114111", "qorpera-200001"],
			["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"],
			["nft", "-f", join(m.runRoot, "networks", "rules.nft")],
			["ip", "netns", "delete", ns],
			["ip", "link", "delete", "qgh0"],
			["ip", "netns", "add", ns],
			["ip", "link", "add", "qgh0", "type", "veth", "peer", "name", "qgn0", "netns", ns],
			["ip", "address", "add", "10.253.0.1/30", "dev", "qgh0"],
			["ip", "link", "set", "qgh0", "up"],
			["ip", "-n", ns, "link", "set", "lo", "up"],
			["ip", "-n", ns, "address", "add", "10.253.0.2/30", "dev", "qgn0"],
			["ip", "-n", ns, "link", "set", "qgn0", "up"],
			["ip", "-n", ns, "route", "add", "default", "via", "10.253.0.1"],
			["systemctl", "stop", s.folderUnit],
			show(s.folderUnit),
			show(s.folderUnit),
			["systemd-run", "--quiet", `--unit=${s.folderUnit}`],
			show(s.folderUnit),
			["systemctl", "daemon-reload"],
			["systemctl", "try-restart", "user@200001.service"],
			["loginctl", "enable-linger", "qorpera-200001"],
		]);
		expect(m.calls.find(([tool]) => tool === "systemd-run")).toEqual([
			"systemd-run",
			"--quiet",
			`--unit=${s.folderUnit}`,
			...[
				"Type=exec",
				"StartLimitIntervalSec=0",
				"Restart=always",
				"RestartSec=2s",
				"RestartPreventExitStatus=3",
				`ExecStopPost=-/usr/bin/umount -l ${s.mountpoint}`,
				"KillMode=mixed",
				"TimeoutStopSec=20s",
				"LimitCORE=0",
				"NoNewPrivileges=yes",
				"CapabilityBoundingSet=CAP_SYS_ADMIN",
				"DevicePolicy=closed",
				"DeviceAllow=/dev/fuse rw",
				"RestrictAddressFamilies=AF_UNIX AF_VSOCK",
				"RestrictSUIDSGID=yes",
				"RestrictRealtime=yes",
				"LockPersonality=yes",
				"MemoryDenyWriteExecute=yes",
				"SystemCallArchitectures=native",
				"MemoryMax=512M",
				"MemorySwapMax=0",
			].flatMap((property) => ["--property", property]),
			CODING_GUEST.folderProgram,
			"mount",
			"--view-file",
			s.view,
			"--mountpoint",
			s.mountpoint,
			"--state-dir",
			s.folderState,
			"--allow-other",
			"yes",
			"--owner-uid",
			"200001",
			"--owner-gid",
			"200001",
		]);
		expect(await readJsonFile(s.view)).toEqual(VIEW);
		expect(await mode(s.view)).toBe(0o600);
		expect(await mode(s.folderState)).toBe(0o700);
		expect(await readJsonFile(s.user)).toEqual({
			schema: "qorpera.coding-guest-session-user/v1",
			uid: UID,
			gid: GID,
		});
		expect(await readFile(join(m.runRoot, "networks", "rules.nft"), "utf8")).toBe(NAT_RULES);
		expect(await readFile(join(m.runRoot, "networks", "0"), "utf8")).toBe(s.w);
		for (const ready of ["nat.ready", "0.ready"])
			expect((await lstat(join(m.runRoot, "networks", ready))).isFile()).toBe(true);
		const dropIn = join(m.systemdRoot, "user@200001.service.d", "qorpera-company.conf");
		expect(await readFile(dropIn, "utf8")).toBe(
			[
				"[Service]",
				`BindPaths=${s.mountpoint}:/company`,
				`NetworkNamespacePath=/run/netns/${ns}`,
				`BindReadOnlyPaths=${m.resolv}:/etc/resolv.conf`,
				"",
			].join("\n"),
		);
		expect(await mode(dropIn)).toBe(0o644);
	});
	it("mounts the same view again without restarting anything", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		expect((await call(m, "mount", mountRequest(workerId))).line.mount).toBe("mounted");
		expect(m.calls).toEqual([
			["getent", "passwd", "200001"],
			["chmod", "0700", "/home/qorpera-200001"],
			show(s.folderUnit),
			show(s.folderUnit),
			["loginctl", "enable-linger", "qorpera-200001"],
		]);
	});
	it("shows another view on fresh state: the program stops first and the user manager restarts", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		await writeFile(join(s.folderState, "cache"), "old");
		const answer = await call(m, "mount", mountRequest(workerId, { ...VIEW, viewId: "view-2" }));
		expect(answer.line).toMatchObject({ viewId: "view-2", mount: "mounted" });
		expect(brief(m.calls)).toEqual([
			["getent", "passwd", "200001"],
			["chmod", "0700", "/home/qorpera-200001"],
			["systemctl", "stop", s.folderUnit],
			show(s.folderUnit),
			show(s.folderUnit),
			["systemd-run", "--quiet", `--unit=${s.folderUnit}`],
			show(s.folderUnit),
			["systemctl", "try-restart", "user@200001.service"],
			["loginctl", "enable-linger", "qorpera-200001"],
		]);
		await gone(join(s.folderState, "cache"));
		expect(await readJsonFile(s.view)).toEqual({ ...VIEW, viewId: "view-2" });
	});
	it("starts a failed program again and restarts the user manager", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		m.units.set(s.folderUnit, { ActiveState: "failed", Result: "exit-code", ExecMainCode: "1", ExecMainStatus: "1" });
		m.mounts.delete(s.mountpoint);
		expect((await call(m, "mount", mountRequest(workerId))).line.mount).toBe("mounted");
		expect(brief(m.calls)).toEqual([
			["getent", "passwd", "200001"],
			["chmod", "0700", "/home/qorpera-200001"],
			show(s.folderUnit),
			["systemctl", "reset-failed", s.folderUnit],
			show(s.folderUnit),
			["systemd-run", "--quiet", `--unit=${s.folderUnit}`],
			show(s.folderUnit),
			["systemctl", "try-restart", "user@200001.service"],
			["loginctl", "enable-linger", "qorpera-200001"],
		]);
	});
	it("answers closed when the node closed the view, and unanswered when the program never mounted", async () => {
		const m = await machine();
		m.state.folder = "close";
		const workerId = randomUUID();
		const s = sessionAt(m, workerId);
		expect((await call(m, "mount", mountRequest(workerId))).line.mount).toBe("closed");
		expect(brief(m.calls).slice(-5)).toEqual([
			["systemctl", "stop", s.folderUnit],
			show(s.folderUnit),
			show(s.folderUnit),
			["systemd-run", "--quiet", `--unit=${s.folderUnit}`],
			show(s.folderUnit),
		]);
		expect(m.sleeps).toEqual([]);
		await gone(join(m.systemdRoot, "user@200001.service.d"));
		const silent = await machine();
		silent.state.folder = "silent";
		expect((await call(silent, "mount", mountRequest(randomUUID()))).line.mount).toBe("unanswered");
		expect(silent.calls.filter((entry) => entry[1] === "show")).toHaveLength(102);
		expect(silent.sleeps).toEqual(Array.from({ length: 99 }, () => 200));
		expect(silent.calls.some(([tool]) => tool === "loginctl")).toBe(false);
	});
	it("refuses a folder root that is not in memory, before anything else", async () => {
		const m = await machine();
		m.state.folderInMemory = false;
		expect((await call(m, "mount", mountRequest(randomUUID()))).line).toEqual(
			refusal("CODING_GUEST_FOLDER_NOT_IN_MEMORY"),
		);
		expect(m.calls).toEqual([]);
		for (const path of [m.stateRoot, m.runRoot, m.folderRoot]) await gone(path);
	});
	it("refuses another user for a mounted session", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		expect((await call(m, "mount", mountRequest(workerId, VIEW, 200002))).line).toEqual(
			refusal("CODING_GUEST_SESSION_USER_CHANGED"),
		);
		expect(m.calls).toEqual([]);
	});
	it("refuses a passwd entry or group it did not make", async () => {
		const cases: [string | undefined, string | undefined, string[][]][] = [
			["someone:x:200001:200001::/home/someone:/bin/bash", undefined, [["getent", "passwd", "200001"]]],
			["qorpera-200001:x:200001:100::/home/qorpera-200001:/bin/bash", undefined, [["getent", "passwd", "200001"]]],
			[
				undefined,
				"staff:x:200001:",
				[
					["getent", "passwd", "200001"],
					["getent", "group", "200001"],
				],
			],
		];
		for (const [passwd, group, calls] of cases) {
			const m = await machine();
			if (passwd) m.passwd.set(UID, passwd);
			if (group) m.groups.set(GID, group);
			const workerId = randomUUID();
			expect((await call(m, "mount", mountRequest(workerId))).line).toEqual(
				refusal("CODING_GUEST_SESSION_USER_CONFLICT"),
			);
			expect(m.calls).toEqual(calls);
			await gone(sessionAt(m, workerId).session);
		}
	});
	it("gives the user the lowest sub-id range neither file overlaps, only in a file that lacks one", async () => {
		const m = await machine();
		m.passwd.set(UID, "qorpera-200001:x:200001:200001::/home/qorpera-200001:/bin/bash");
		await writeFile(m.subuid, "other:1048576:65536\n");
		await writeFile(m.subgid, "x:1114112:1\n200001:2000000:65536\n");
		expect((await call(m, "mount", mountRequest(randomUUID()))).line.mount).toBe("mounted");
		expect(m.calls.slice(0, 4)).toEqual([
			["getent", "passwd", "200001"],
			["chmod", "0700", "/home/qorpera-200001"],
			["usermod", "--add-subuids", "1179648-1245183", "qorpera-200001"],
			["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"],
		]);
	});
	it("refuses sub-id files it cannot read, and a machine with no range left", async () => {
		for (const [text, code] of [
			["broken line\n", "CODING_GUEST_SUBIDS_INVALID"],
			["other:01:5\n", "CODING_GUEST_SUBIDS_INVALID"],
			["other:0:4294967295\n", "CODING_GUEST_SUBIDS_EXHAUSTED"],
		]) {
			const m = await machine();
			await writeFile(m.subuid, text);
			expect((await call(m, "mount", mountRequest(randomUUID()))).line).toEqual(refusal(code));
			expect(m.calls.some(([tool]) => tool === "usermod")).toBe(false);
		}
	});
	it("sets the machine's NAT up once, gives each session its own network, and makes them again after a restart", async () => {
		const m = await machine();
		await mounted(m);
		const workerId = randomUUID();
		const s = sessionAt(m, workerId);
		const ns = s.namespace;
		expect((await call(m, "mount", mountRequest(workerId))).line.mount).toBe("mounted");
		expect(m.calls.filter(([tool]) => tool === "sysctl" || tool === "nft" || tool === "ip")).toEqual([
			["ip", "netns", "delete", ns],
			["ip", "link", "delete", "qgh1"],
			["ip", "netns", "add", ns],
			["ip", "link", "add", "qgh1", "type", "veth", "peer", "name", "qgn1", "netns", ns],
			["ip", "address", "add", "10.253.0.5/30", "dev", "qgh1"],
			["ip", "link", "set", "qgh1", "up"],
			["ip", "-n", ns, "link", "set", "lo", "up"],
			["ip", "-n", ns, "address", "add", "10.253.0.6/30", "dev", "qgn1"],
			["ip", "-n", ns, "link", "set", "qgn1", "up"],
			["ip", "-n", ns, "route", "add", "default", "via", "10.253.0.5"],
		]);
		expect(await readFile(join(m.runRoot, "networks", "1"), "utf8")).toBe(s.w);
		// The networks' records live in memory: a restarted machine has none.
		await rm(join(m.runRoot, "networks"), { recursive: true });
		m.calls.length = 0;
		expect((await call(m, "mount", mountRequest(workerId))).line.mount).toBe("mounted");
		expect(m.calls.filter(([tool]) => tool === "sysctl" || tool === "nft")).toEqual([
			["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"],
			["nft", "-f", join(m.runRoot, "networks", "rules.nft")],
		]);
		expect(m.calls).toContainEqual(["ip", "address", "add", "10.253.0.1/30", "dev", "qgh0"]);
	});
	it("refuses another view while something is still mounted where it goes, keeping the old one", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		m.state.stuckMount = true;
		expect((await call(m, "mount", mountRequest(workerId, { ...VIEW, viewId: "view-2" }))).line).toEqual(
			refusal("CODING_GUEST_FOLDER_STILL_MOUNTED"),
		);
		expect(m.calls.slice(-2)).toEqual([["systemctl", "stop", s.folderUnit], show(s.folderUnit)]);
		expect(await readJsonFile(s.view)).toEqual(VIEW);
	});
	it("refuses another view while the program outlived its stop, not mounted yet, keeping its state and view", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		await writeFile(join(s.folderState, "journal"), "live");
		// Still starting: active, with nothing mounted.
		m.mounts.delete(s.mountpoint);
		m.state.stubborn.add(s.folderUnit);
		const other = { ...VIEW, viewId: "view-2", pass: "pass-secret-2" };
		expect((await call(m, "mount", mountRequest(workerId, other))).line).toEqual(
			refusal("CODING_GUEST_FOLDER_STILL_RUNNING"),
		);
		expect(m.calls.slice(-2)).toEqual([["systemctl", "stop", s.folderUnit], show(s.folderUnit)]);
		expect(await readJsonFile(s.view)).toEqual(VIEW);
		expect(await readFile(join(s.folderState, "journal"), "utf8")).toBe("live");
		expect(m.calls.some(([tool]) => tool === "systemd-run")).toBe(false);
	});
	it("refuses a session or the machine while another request holds it", async () => {
		const m = await machine();
		let open: () => void = () => undefined;
		m.state.useraddGate = new Promise<void>((done) => {
			open = done;
		});
		const workerId = randomUUID();
		const first = call(m, "mount", mountRequest(workerId));
		await vi.waitFor(() => expect(m.calls.some(([tool]) => tool === "useradd")).toBe(true), { timeout: 10000 });
		expect((await call(m, "mount", mountRequest(workerId))).line).toEqual(refusal("CODING_GUEST_SESSION_BUSY"));
		expect((await call(m, "mount", mountRequest(randomUUID(), VIEW, 200002))).line).toEqual(
			refusal("CODING_GUEST_MACHINE_BUSY"),
		);
		open();
		expect((await first).line.mount).toBe("mounted");
	});
});

describe("running a command", () => {
	it("starts it once in its own unit as the session's user, its request in memory only until the unit took it", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		const commandId = randomUUID();
		const x = commandAt(m, workerId, commandId);
		const request = runRequest(m, workerId, commandId, HELLO);
		expect((await call(m, "run", request)).line).toEqual({
			schema: "qorpera.coding-guest-command/v1",
			workerId,
			commandId,
			state: "running",
			exit: null,
			end: 0,
		});
		expect(brief(m.calls)).toEqual([
			show(s.folderUnit),
			["systemd-run", "--quiet", `--unit=${x.unit}`],
			show(x.unit),
		]);
		expect(m.calls[1]).toEqual([
			"systemd-run",
			"--quiet",
			`--unit=${x.unit}`,
			`--slice=${s.slice}`,
			"--uid=200001",
			"--gid=200001",
			...[
				"Type=exec",
				"ExitType=cgroup",
				"KillMode=control-group",
				"TimeoutStopSec=5",
				"RuntimeMaxSec=60",
				"ProtectProc=invisible",
				"PrivateIPC=yes",
				`NetworkNamespacePath=/run/netns/${s.namespace}`,
				`BindPaths=${s.mountpoint}:/company`,
				`BindReadOnlyPaths=${m.resolv}:/etc/resolv.conf`,
				`StandardInput=file:${x.input}`,
				"StandardOutput=null",
				"StandardError=journal",
			].flatMap((property) => ["--property", property]),
			"/usr/bin/env",
			"-i",
			"PATH=/usr/bin:/bin",
			"LANG=C.UTF-8",
			CODING_GUEST.node,
			CODING_GUEST.agent,
			"relay",
			s.w,
			x.c,
		]);
		await gone(x.input);
		expect(await readJsonFile(x.intent)).toEqual({
			schema: "qorpera.coding-guest-intent/v1",
			commandId,
			digest: expect.stringMatching(SHA256_HEX_PATTERN),
			bootId: m.state.boot,
		});
		expect(await mode(x.intent)).toBe(0o400);
		expect(await mode(x.output)).toBe(0o700);
		expect(m.chowns).toEqual([[x.output, UID, GID]]);
		await m.settle();
		m.calls.length = 0;
		const read = await call(m, "output", outputRequest(workerId, commandId, 0));
		expect(read.line).toEqual({
			schema: "qorpera.coding-guest-output/v1",
			workerId,
			commandId,
			state: "exited",
			exit: { code: 3, signal: null },
			end: 17,
			offset: 0,
			bytes: 17,
			gap: 0,
		});
		// Both streams, each line whole; which pipe the relay read first is the kernel's.
		expect(read.bytes.toString().split("\n").sort()).toEqual(["", "hello world", "oops"]);
		expect(m.calls).toEqual([show(x.unit), ["systemctl", "reset-failed", x.unit]]);
		expect(await readJsonFile(x.outcome)).toEqual({
			schema: "qorpera.coding-guest-outcome/v1",
			state: "exited",
			exit: { code: 3, signal: null },
			end: 17,
		});
		expect(await mode(x.outcome)).toBe(0o400);
		m.calls.length = 0;
		expect((await call(m, "run", request)).line).toEqual({
			schema: "qorpera.coding-guest-command/v1",
			workerId,
			commandId,
			state: "exited",
			exit: { code: 3, signal: null },
			end: 17,
		});
		expect(m.calls).toEqual([]);
	});
	it("refuses the same commandId for another request", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const commandId = randomUUID();
		m.state.command = "hold";
		await call(m, "run", runRequest(m, workerId, commandId, "true"));
		m.calls.length = 0;
		for (const request of [
			runRequest(m, workerId, commandId, "false"),
			runRequest(m, workerId, commandId, "true", { PATH: "/bin" }),
			{ ...runRequest(m, workerId, commandId, "true"), timeoutMs: null },
		])
			expect((await call(m, "run", request)).line).toEqual(refusal("CODING_GUEST_COMMAND_CONFLICT"));
		expect(m.calls).toEqual([]);
	});
	it("refuses a session never mounted, another user and a folder that is down, starting nothing", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const commandId = randomUUID();
		const s = sessionAt(m, workerId);
		const request = runRequest(m, workerId, commandId, "true");
		expect((await call(m, "run", request)).line).toEqual(refusal("CODING_GUEST_SESSION_UNMOUNTED"));
		await mounted(m, workerId);
		expect((await call(m, "run", { ...request, uid: 200002, gid: 200002 })).line).toEqual(
			refusal("CODING_GUEST_SESSION_USER_CHANGED"),
		);
		m.mounts.delete(s.mountpoint);
		expect((await call(m, "run", request)).line).toEqual(refusal("CODING_GUEST_FOLDER_UNMOUNTED"));
		expect(m.calls).toEqual([show(s.folderUnit)]);
		await gone(commandAt(m, workerId, commandId).directory);
	});
	it("refuses a command systemd would not start, which then reads as lost", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const commandId = randomUUID();
		const x = commandAt(m, workerId, commandId);
		m.state.command = "refuse";
		const request = runRequest(m, workerId, commandId, "true");
		expect((await call(m, "run", request)).line).toEqual(refusal("CODING_GUEST_SYSTEM_UNCONFIRMED"));
		await gone(x.input);
		m.calls.length = 0;
		expect((await call(m, "run", request)).line).toMatchObject({ commandId, state: "lost", exit: null, end: 0 });
		expect(m.calls).toEqual([show(x.unit), ["systemctl", "reset-failed", x.unit]]);
	});
	it("leaves resolv.conf and the deadline out when the machine has none and the request sets none", async () => {
		const m = await machine();
		await rm(m.resolv);
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		expect(await readFile(join(m.systemdRoot, "user@200001.service.d", "qorpera-company.conf"), "utf8")).toBe(
			["[Service]", `BindPaths=${s.mountpoint}:/company`, `NetworkNamespacePath=/run/netns/${s.namespace}`, ""].join(
				"\n",
			),
		);
		m.state.command = "hold";
		await call(m, "run", { ...runRequest(m, workerId, randomUUID(), "true"), timeoutMs: null });
		const args = m.calls.find(([tool]) => tool === "systemd-run") ?? [];
		expect(args.filter((arg) => arg.startsWith("BindReadOnlyPaths=") || arg.startsWith("RuntimeMaxSec="))).toEqual(
			[],
		);
		expect(args).toContain(`BindPaths=${s.mountpoint}:/company`);
	});
	it("drops an ended command's output after an hour, keeping its intent and outcome, and the session's old inputs", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		const done = await ran(m, workerId, HELLO);
		expect((await call(m, "output", outputRequest(workerId, done.commandId, 0))).line).toMatchObject({
			state: "exited",
			end: 17,
		});
		const inputs = join(m.runRoot, "inputs");
		const stale = join(inputs, `${s.w}-${"f".repeat(32)}.json`);
		const others = join(inputs, `${compact(randomUUID())}-${"f".repeat(32)}.json`);
		await writeFile(stale, "{}");
		await writeFile(others, "{}");
		m.state.skewMs = 2 * 3600000;
		await ran(m, workerId, "true");
		await gone(done.output);
		await gone(stale);
		for (const path of [others, done.intent, done.outcome]) expect((await lstat(path)).isFile()).toBe(true);
		expect((await call(m, "output", outputRequest(workerId, done.commandId, 0))).line).toMatchObject({
			state: "exited",
			exit: { code: 3, signal: null },
			end: 17,
			offset: 17,
			bytes: 0,
			gap: 17,
		});
	});
});

describe("the relay inside a command's unit", () => {
	it("runs bash in the request's folder with exactly its environment", async () => {
		const m = await machine();
		m.ports.ring = { segmentBytes: 4096, segments: 3 };
		const { x, code } = await relayed(m, 'printf \'%s\\n\' "$PWD" "$GREETING" "$VITEST"', {
			environment: { GREETING: "hej" },
		});
		expect(code).toBe(0);
		expect(await ringText(x.output)).toBe(`${m.work}\nhej\n\n`);
		expect(await readJsonFile(join(x.output, "exit.json"))).toEqual({ code: 0, signal: null });
	});
	it("keeps the newest segments of its ring", async () => {
		const m = await machine();
		const { x, code } = await relayed(m, TEN_LINES);
		expect(code).toBe(0);
		expect((await readdir(x.output)).sort()).toEqual([
			"0000000000000048.out",
			"0000000000000064.out",
			"0000000000000080.out",
			"exit.json",
		]);
		expect(await ringText(x.output)).toBe(LINES.slice(48));
		for (const name of ["0000000000000048.out", "exit.json"]) expect(await mode(join(x.output, name))).toBe(0o600);
	});
	it("records a signal, exiting 128 and its number", async () => {
		const { x, code } = await relayed(await machine(), "kill -KILL $$");
		expect(code).toBe(137);
		expect(await readJsonFile(join(x.output, "exit.json"))).toEqual({ code: null, signal: "SIGKILL" });
	});
	it("says in its ring that bash did not start, exiting 127", async () => {
		const m = await machine();
		const { x, code } = await relayed(m, "true", { cwd: join(m.work, "missing") });
		expect(code).toBe(127);
		expect(await ringText(x.output)).toBe("qorpera: the command did not start (ENOENT)\n");
		expect(await readJsonFile(join(x.output, "exit.json"))).toEqual({ code: 127, signal: null });
	});
	it("leaves no exit record when systemd stops it", async () => {
		const m = await machine();
		m.state.terminateAtOnce = true;
		const { x, code } = await relayed(m, "printf 'bye\\n'");
		expect(code).toBe(143);
		expect(await ringText(x.output)).toBe("bye\n");
		await gone(join(x.output, "exit.json"));
	});
	it("kills bash and refuses when its ring cannot be written", async () => {
		const m = await machine();
		const request = runRequest(m, randomUUID(), randomUUID(), "printf '%040d' 0; exec sleep 20");
		const x = commandAt(m, request.workerId, request.commandId);
		await mkdir(x.output, { recursive: true });
		await writeFile(join(x.output, "0000000000000016.out"), "");
		const started = Date.now();
		expect(await relay(m, request, [compact(request.workerId), x.c])).toBe(125);
		expect(Date.now() - started).toBeLessThan(10000);
		await gone(join(x.output, "exit.json"));
	});
	it("runs nothing for a command cancelled before its unit started", async () => {
		const m = await machine();
		const marker = join(m.root, "ran");
		const request = runRequest(m, randomUUID(), randomUUID(), `touch ${marker}`);
		const x = commandAt(m, request.workerId, request.commandId);
		await mkdir(x.output, { recursive: true });
		await writeFile(x.cancel, "{}");
		expect(await relay(m, request, [compact(request.workerId), x.c])).toBe(0);
		await gone(marker);
		expect(await readdir(x.output)).toEqual([]);
	});
	it("refuses, on stderr only, a request that is not its own, and runs nothing", async () => {
		const m = await machine();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const marker = join(m.root, "ran");
		const request = runRequest(m, randomUUID(), randomUUID(), `touch ${marker}`);
		const x = commandAt(m, request.workerId, request.commandId);
		const argv = [compact(request.workerId), x.c];
		expect(await relay(m, request, argv)).toBe(125);
		await mkdir(x.output, { recursive: true });
		expect(await relay(m, request, [argv[0], compact(randomUUID())])).toBe(125);
		expect(await relay(m, request, [...argv, "extra"])).toBe(125);
		expect(await relay(m, request, [request.workerId, x.c])).toBe(125);
		expect(await relay(m, '{"pass":"pass-secret-1"}', argv)).toBe(125);
		const filed = runRequest(m, request.workerId, randomUUID(), `touch ${marker}`);
		const y = commandAt(m, filed.workerId, filed.commandId);
		await mkdir(y.directory);
		await writeFile(y.output, "");
		expect(await relay(m, filed, [argv[0], y.c])).toBe(125);
		m.state.processUid = 200002;
		expect(await relay(m, request, argv)).toBe(125);
		expect(stderr.mock.calls.map(([text]) => text)).toEqual([
			"CODING_GUEST_RELAY_REFUSED ERRNO:ENOENT\n",
			"CODING_GUEST_RELAY_REFUSED CODING_GUEST_REQUEST_INVALID\n",
			"CODING_GUEST_RELAY_REFUSED CODING_GUEST_ARGUMENTS_INVALID\n",
			"CODING_GUEST_RELAY_REFUSED CODING_GUEST_ARGUMENTS_INVALID\n",
			"CODING_GUEST_RELAY_REFUSED CODING_GUEST_REQUEST_INVALID\n",
			"CODING_GUEST_RELAY_REFUSED CODING_GUEST_OUTPUT_INVALID\n",
			"CODING_GUEST_RELAY_REFUSED CODING_GUEST_RELAY_USER_INVALID\n",
		]);
		await gone(marker);
		expect(await readdir(x.output)).toEqual([]);
	});
});

describe("reading a command's state", () => {
	const reads = (x: { commandId: string }, state: string, exit: unknown = null) => ({
		commandId: x.commandId,
		state,
		exit,
		end: 0,
	});
	it("tells from its unit, records and boot how each command ended, and keeps the first outcome seen", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const boot = randomUUID();
		const SIGTERM = JSON.stringify({ code: null, signal: "SIGTERM" });
		const p = {
			running: await plant(m, workerId, { unit: ACTIVE }),
			starting: await plant(m, workerId, { inputAgeMs: 0 }),
			cancelled: await plant(m, workerId, { cancel: true, exit: EXIT_0 }),
			timedOut: await plant(m, workerId, { unit: TIMED_OUT }),
			timedOutBySignal: await plant(m, workerId, { unit: TIMED_OUT, exit: SIGTERM }),
			// bash exited, and what it left running met the deadline.
			exitedBeforeTimeout: await plant(m, workerId, { unit: TIMED_OUT, exit: EXIT_0 }),
			exited: await plant(m, workerId, { exit: JSON.stringify({ code: 1, signal: null }) }),
			lost: await plant(m, workerId, { inputAgeMs: 120000 }),
			forged: await plant(m, workerId, { exit: JSON.stringify({ code: 256, signal: null }) }),
			extraKey: await plant(m, workerId, { exit: JSON.stringify({ code: 0, signal: null, pid: 1 }) }),
			otherBootCancelled: await plant(m, workerId, { boot, cancel: true, unit: ACTIVE }),
			otherBootExited: await plant(m, workerId, { boot, exit: JSON.stringify({ code: null, signal: "SIGKILL" }) }),
			otherBootLost: await plant(m, workerId, { boot, unit: ACTIVE }),
		};
		const states = await seen(m, workerId);
		expect(Object.fromEntries(Object.entries(p).map(([name, x]) => [name, states.get(x.commandId)]))).toEqual({
			running: reads(p.running, "running"),
			starting: reads(p.starting, "running"),
			cancelled: reads(p.cancelled, "cancelled", { code: 0, signal: null }),
			timedOut: reads(p.timedOut, "timed_out"),
			timedOutBySignal: reads(p.timedOutBySignal, "timed_out", { code: null, signal: "SIGTERM" }),
			exitedBeforeTimeout: reads(p.exitedBeforeTimeout, "timed_out", { code: 0, signal: null }),
			exited: reads(p.exited, "exited", { code: 1, signal: null }),
			lost: reads(p.lost, "lost"),
			forged: reads(p.forged, "lost"),
			extraKey: reads(p.extraKey, "lost"),
			otherBootCancelled: reads(p.otherBootCancelled, "cancelled"),
			otherBootExited: reads(p.otherBootExited, "exited", { code: null, signal: "SIGKILL" }),
			otherBootLost: reads(p.otherBootLost, "lost"),
		});
		const otherBoot = [p.otherBootCancelled, p.otherBootExited, p.otherBootLost].map((x) => x.unit);
		expect(m.calls.filter((entry) => otherBoot.includes(entry[2]))).toEqual([]);
		expect(
			m.calls
				.filter((entry) => entry[1] === "reset-failed")
				.map((entry) => entry[2])
				.sort(),
		).toEqual(
			[p.cancelled, p.timedOut, p.timedOutBySignal, p.exitedBeforeTimeout, p.exited, p.lost, p.forged, p.extraKey]
				.map((x) => x.unit)
				.sort(),
		);
		for (const x of [p.running, p.starting]) await gone(x.outcome);
		expect(await readJsonFile(p.timedOutBySignal.outcome)).toEqual({
			schema: "qorpera.coding-guest-outcome/v1",
			state: "timed_out",
			exit: { code: null, signal: "SIGTERM" },
			end: 0,
		});
		expect(await mode(p.otherBootLost.outcome)).toBe(0o400);
		await writeFile(join(p.exited.output, "exit.json"), JSON.stringify({ code: 9, signal: null }));
		m.units.set(p.running.unit, INACTIVE);
		await writeFile(join(p.running.output, "exit.json"), EXIT_0);
		m.calls.length = 0;
		const again = await seen(m, workerId);
		expect(again.get(p.exited.commandId)).toEqual(reads(p.exited, "exited", { code: 1, signal: null }));
		expect(again.get(p.running.commandId)).toEqual(reads(p.running, "exited", { code: 0, signal: null }));
		expect(again.get(p.starting.commandId)).toEqual(reads(p.starting, "running"));
		expect(m.calls.map((entry) => entry.join(" ")).sort()).toEqual(
			[show(p.running.unit), ["systemctl", "reset-failed", p.running.unit], show(p.starting.unit)]
				.map((entry) => entry.join(" "))
				.sort(),
		);
	});
	it("reads the records a command wrote while its unit was read", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const exited = await plant(m, workerId, { unit: ACTIVE });
		const cancelled = await plant(m, workerId, { unit: ACTIVE });
		// One's relay writes its exit and ends, and a cancel stops the other, as systemctl reads their units.
		m.state.onShow = async (unit) => {
			if (unit === exited.unit) await writeFile(join(exited.output, "exit.json"), EXIT_0);
			if (unit === cancelled.unit)
				await writeFile(
					cancelled.cancel,
					JSON.stringify({ schema: "qorpera.coding-guest-cancel/v1", commandId: cancelled.commandId }),
				);
			m.units.set(unit, { ...INACTIVE });
		};
		const states = await seen(m, workerId);
		expect(states.get(exited.commandId)).toEqual(reads(exited, "exited", { code: 0, signal: null }));
		expect(states.get(cancelled.commandId)).toEqual(reads(cancelled, "cancelled"));
		expect((await readJsonFile(exited.outcome)).state).toBe("exited");
		expect((await readJsonFile(cancelled.outcome)).state).toBe("cancelled");
	});
	it("publishes each record whole, passing over one a crash left half-written under a name of its own", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const x = await ran(m, workerId, HELLO);
		const crashedId = randomUUID();
		const crashed = commandAt(m, workerId, crashedId);
		await mkdir(crashed.directory, { recursive: true });
		const halves = [`${x.outcome}.${randomUUID()}.tmp`, `${crashed.intent}.${randomUUID()}.tmp`];
		for (const half of halves) await writeFile(half, '{"schema":"qorpera.coding-guest-');
		const states = await seen(m, workerId);
		expect([...states.keys()]).toEqual([x.commandId]);
		expect(states.get(x.commandId)).toMatchObject({ state: "exited", exit: { code: 3, signal: null }, end: 17 });
		expect(await readJsonFile(x.outcome)).toMatchObject({ state: "exited", end: 17 });
		expect(await mode(x.outcome)).toBe(0o400);
		// Nothing of its own is left aside: only the crash's halves are.
		expect((await readdir(x.directory)).sort()).toEqual(
			["intent.json", "outcome.json", "output", basename(halves[0])].sort(),
		);
		expect((await call(m, "output", outputRequest(workerId, crashed.commandId, 0))).line).toEqual(
			refusal("CODING_GUEST_COMMAND_UNKNOWN"),
		);
		const again = await ran(m, workerId, "true", crashedId);
		expect((await seen(m, workerId)).get(again.commandId)).toMatchObject({ state: "exited", exit: { code: 0 } });
	});
	it("refuses a command it never started, and records it did not write", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const commandId = randomUUID();
		expect((await call(m, "output", outputRequest(workerId, commandId, 0))).line).toEqual(
			refusal("CODING_GUEST_COMMAND_UNKNOWN"),
		);
		expect((await call(m, "cancel", { schema: "qorpera.coding-guest-cancel/v1", workerId, commandId })).line).toEqual(
			refusal("CODING_GUEST_COMMAND_UNKNOWN"),
		);
		const x = await plant(m, workerId);
		const intent = await readJsonFile(x.intent);
		for (const forged of [
			{ ...intent, schema: "qorpera.coding-guest-intent/v2" },
			{ ...intent, commandId },
		]) {
			await writeFile(x.intent, JSON.stringify(forged));
			expect((await call(m, "status", sessionRequest(workerId))).line).toEqual(
				refusal("CODING_GUEST_STATE_INVALID"),
			);
		}
		expect(m.calls).toEqual([]);
	});
});

describe("reading a command's output", () => {
	it("pages its ring from an offset, past what the ring dropped", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const x = await ran(m, workerId, TEN_LINES);
		const page = (offset: number, maxBytes?: number) =>
			call(m, "output", outputRequest(workerId, x.commandId, offset, maxBytes));
		const first = await page(0);
		expect(first.line).toEqual({
			schema: "qorpera.coding-guest-output/v1",
			workerId,
			commandId: x.commandId,
			state: "exited",
			exit: { code: 0, signal: null },
			end: 90,
			offset: 48,
			bytes: 42,
			gap: 48,
		});
		expect(first.bytes.toString()).toBe(LINES.slice(48));
		const middle = await page(60, 10);
		expect(middle.line).toMatchObject({ end: 90, offset: 60, bytes: 10, gap: 0 });
		expect(middle.bytes.toString()).toBe(LINES.slice(60, 70));
		const last = await page(90);
		expect(last.line).toMatchObject({ end: 90, offset: 90, bytes: 0, gap: 0 });
		expect(last.bytes).toHaveLength(0);
		expect((await page(91)).line).toEqual(refusal("CODING_GUEST_OUTPUT_OFFSET_INVALID"));
	});
	it("waits up to waitMs for new bytes while the command runs", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		m.state.command = "hold";
		const commandId = randomUUID();
		await call(m, "run", runRequest(m, workerId, commandId, "true"));
		expect((await call(m, "output", outputRequest(workerId, commandId, 0, 4096, 0))).line).toMatchObject({
			state: "running",
			exit: null,
			end: 0,
			offset: 0,
			bytes: 0,
			gap: 0,
		});
		expect(m.sleeps).toEqual([]);
		await call(m, "output", outputRequest(workerId, commandId, 0, 4096, 1000));
		expect(m.sleeps).toEqual([200, 200, 200, 200]);
	});
	it("answers as soon as new bytes come", async () => {
		const m = await machine();
		m.state.realSleep = true;
		const workerId = await mounted(m);
		const commandId = randomUUID();
		await call(m, "run", runRequest(m, workerId, commandId, "printf 'first\\n'; sleep 1; printf 'second\\n'"));
		const [early] = await Promise.all([
			call(m, "output", outputRequest(workerId, commandId, 0, 4096, 5000)),
			m.settle(),
		]);
		expect(early.line).toMatchObject({ state: "running", exit: null, end: 6, offset: 0, bytes: 6, gap: 0 });
		expect(early.bytes.toString()).toBe("first\n");
		expect(m.sleeps.length).toBeLessThan(25);
		const rest = await call(m, "output", outputRequest(workerId, commandId, 6));
		expect(rest.line).toMatchObject({
			state: "exited",
			exit: { code: 0, signal: null },
			end: 13,
			offset: 6,
			bytes: 7,
		});
		expect(rest.bytes.toString()).toBe("second\n");
	});
});

describe("cancelling a command", () => {
	const cancelRequest = (workerId: string, commandId: string) => ({
		schema: "qorpera.coding-guest-cancel/v1",
		workerId,
		commandId,
	});
	it("records a running command cancelled and stops its unit", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		m.state.command = "hold";
		const commandId = randomUUID();
		const x = commandAt(m, workerId, commandId);
		await call(m, "run", runRequest(m, workerId, commandId, "sleep 60"));
		m.calls.length = 0;
		expect((await call(m, "cancel", cancelRequest(workerId, commandId))).line).toEqual({
			schema: "qorpera.coding-guest-command/v1",
			workerId,
			commandId,
			state: "cancelled",
			exit: null,
			end: 0,
		});
		expect(m.calls).toEqual([
			show(x.unit),
			["systemctl", "stop", x.unit],
			show(x.unit),
			["systemctl", "reset-failed", x.unit],
		]);
		expect(await readJsonFile(x.cancel)).toEqual({ schema: "qorpera.coding-guest-cancel/v1", commandId });
		expect(await mode(x.cancel)).toBe(0o400);
	});
	it("only reads a command that ended", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const x = await ran(m, workerId, HELLO);
		m.calls.length = 0;
		expect((await call(m, "cancel", cancelRequest(workerId, x.commandId))).line).toMatchObject({
			state: "exited",
			exit: { code: 3, signal: null },
			end: 17,
		});
		expect(m.calls).toEqual([show(x.unit), ["systemctl", "reset-failed", x.unit]]);
		await gone(x.cancel);
	});
	it("reads a unit that outlived its stop as running, then cancelled with the exit it wrote", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		m.state.command = "hold";
		const commandId = randomUUID();
		const x = commandAt(m, workerId, commandId);
		await call(m, "run", runRequest(m, workerId, commandId, "sleep 60"));
		m.state.stubborn.add(x.unit);
		expect((await call(m, "cancel", cancelRequest(workerId, commandId))).line).toMatchObject({
			state: "running",
			exit: null,
		});
		expect((await lstat(x.cancel)).isFile()).toBe(true);
		m.units.set(x.unit, INACTIVE);
		await writeFile(join(x.output, "exit.json"), EXIT_0);
		m.calls.length = 0;
		expect((await call(m, "cancel", cancelRequest(workerId, commandId))).line).toMatchObject({
			state: "cancelled",
			exit: { code: 0, signal: null },
		});
		expect(m.calls).toEqual([show(x.unit), ["systemctl", "reset-failed", x.unit]]);
	});
});

describe("a session's status", () => {
	it("lists its commands newest first, skipping what is not one", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const boot = randomUUID();
		const older = await plant(m, workerId, { boot });
		const newer = await plant(m, workerId, { boot });
		const tied = [await plant(m, workerId, { boot }), await plant(m, workerId, { boot })].sort((a, b) =>
			a.c < b.c ? -1 : 1,
		);
		for (const [x, seconds] of [
			[older, 1000],
			[newer, 3000],
			[tied[0], 2000],
			[tied[1], 2000],
		] as const)
			await utimes(x.intent, seconds, seconds);
		const commands = join(m.stateRoot, "sessions", compact(workerId), "commands");
		for (const name of ["0".repeat(32), "A".repeat(32)]) {
			await mkdir(join(commands, name));
			await writeFile(join(commands, name, "intent.json"), "{}");
		}
		await mkdir(join(commands, compact(randomUUID())));
		await mkdir(join(commands, compact(randomUUID()), "intent.json"), { recursive: true });
		await writeFile(join(commands, "notes"), "");
		expect((await call(m, "status", sessionRequest(workerId))).line).toEqual({
			schema: "qorpera.coding-guest-status/v1",
			workerId,
			commands: [newer, ...tied, older].map((x) => ({ commandId: x.commandId, state: "lost", exit: null, end: 0 })),
		});
		expect(m.calls).toEqual([]);
		expect((await call(m, "status", sessionRequest(randomUUID()))).line.commands).toEqual([]);
	});
	it("lists at most the newest 256", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const boot = randomUUID();
		const oldest = await plant(m, workerId, { boot });
		await utimes(oldest.intent, 1000, 1000);
		for (let i = 0; i < CODING_GUEST.maxStatusCommands; i++) await plant(m, workerId, { boot });
		const listed = await seen(m, workerId);
		expect(listed.size).toBe(256);
		expect(listed.has(oldest.commandId)).toBe(false);
	});
});

describe("stopping a session", () => {
	const stopped = (workerId: string) => ({ schema: "qorpera.coding-guest-session-stopped/v1", workerId });
	it("ends everything it runs, then removes its view, mount, network and files, keeping its user", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		m.state.command = "hold";
		const x = commandAt(m, workerId, randomUUID());
		await call(m, "run", runRequest(m, workerId, x.commandId, "sleep 60"));
		const inputs = join(m.runRoot, "inputs");
		const own = join(inputs, `${s.w}-${"f".repeat(32)}.json`);
		const others = join(inputs, `${compact(randomUUID())}-${"f".repeat(32)}.json`);
		await writeFile(own, "{}");
		await writeFile(others, "{}");
		m.calls.length = 0;
		expect((await call(m, "stop-session", sessionRequest(workerId))).line).toEqual(stopped(workerId));
		expect(m.calls).toEqual([
			["systemctl", "stop", s.slice],
			["loginctl", "disable-linger", "qorpera-200001"],
			["systemctl", "stop", "user@200001.service"],
			["systemctl", "stop", s.folderUnit],
			show(s.slice),
			show("user@200001.service"),
			show(s.folderUnit),
			["systemctl", "reset-failed", s.folderUnit, `qorpera-coding-${s.w}-*.service`],
			["umount", "-l", s.mountpoint],
			["systemctl", "daemon-reload"],
			["ip", "netns", "delete", s.namespace],
			["ip", "link", "delete", "qgh0"],
		]);
		expect(m.units.get(x.unit)?.ActiveState).toBe("inactive");
		for (const path of [
			s.session,
			s.view,
			s.folderState,
			s.mountpoint,
			join(m.systemdRoot, "user@200001.service.d"),
			join(m.runRoot, "networks", "0"),
			join(m.runRoot, "networks", "0.ready"),
			own,
		])
			await gone(path);
		for (const path of [others, join(m.runRoot, "networks", "nat.ready")])
			expect((await lstat(path)).isFile()).toBe(true);
		expect(m.passwd.has(UID)).toBe(true);
	});
	it("stops a session never mounted and one already stopped, which mounts again", async () => {
		const m = await machine();
		const workerId = randomUUID();
		const s = sessionAt(m, workerId);
		const calls = [
			["systemctl", "stop", s.slice],
			["systemctl", "stop", s.folderUnit],
			show(s.slice),
			show(s.folderUnit),
			["systemctl", "reset-failed", s.folderUnit, `qorpera-coding-${s.w}-*.service`],
			["umount", "-l", s.mountpoint],
			["ip", "netns", "delete", s.namespace],
		];
		expect((await call(m, "stop-session", sessionRequest(workerId))).line).toEqual(stopped(workerId));
		expect(m.calls).toEqual(calls);
		await mounted(m, workerId);
		expect((await call(m, "stop-session", sessionRequest(workerId))).line).toEqual(stopped(workerId));
		m.calls.length = 0;
		expect((await call(m, "stop-session", sessionRequest(workerId))).line).toEqual(stopped(workerId));
		expect(m.calls).toEqual(calls);
		expect((await call(m, "mount", mountRequest(workerId))).line.mount).toBe("mounted");
	});
	it("refuses while anything of the session still runs, removing nothing", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		m.units.set(s.slice, ACTIVE);
		m.state.stubborn.add(s.slice);
		expect((await call(m, "stop-session", sessionRequest(workerId))).line).toEqual(
			refusal("CODING_GUEST_SESSION_STILL_RUNNING"),
		);
		expect(m.calls).toEqual([
			["systemctl", "stop", s.slice],
			["loginctl", "disable-linger", "qorpera-200001"],
			["systemctl", "stop", "user@200001.service"],
			["systemctl", "stop", s.folderUnit],
			show(s.slice),
		]);
		for (const path of [s.user, s.view]) expect((await lstat(path)).isFile()).toBe(true);
	});
	it("refuses while the folder is still mounted, keeping its user manager's drop-in and network", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		m.state.stuckMount = true;
		expect((await call(m, "stop-session", sessionRequest(workerId))).line).toEqual(
			refusal("CODING_GUEST_FOLDER_STILL_MOUNTED"),
		);
		expect(m.calls.at(-1)).toEqual(["umount", "-l", s.mountpoint]);
		for (const path of [
			join(m.systemdRoot, "user@200001.service.d", "qorpera-company.conf"),
			join(m.runRoot, "networks", "0"),
			s.user,
		])
			expect((await lstat(path)).isFile()).toBe(true);
	});
	it("refuses to remove a mountpoint something was left in", async () => {
		const m = await machine();
		const workerId = await mounted(m);
		const s = sessionAt(m, workerId);
		await writeFile(join(s.mountpoint, "left"), "");
		expect((await call(m, "stop-session", sessionRequest(workerId))).line).toEqual(
			refusal("CODING_GUEST_MOUNTPOINT_NOT_EMPTY"),
		);
		for (const path of [join(s.mountpoint, "left"), s.user]) expect((await lstat(path)).isFile()).toBe(true);
		await gone(join(m.runRoot, "networks", "0"));
	});
});
