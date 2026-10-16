import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, unlinkSync, writeSync } from "node:fs";
import {
	chown,
	type FileHandle,
	link,
	lstat,
	mkdir,
	open,
	opendir,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	unlink,
} from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	CODING_GUEST,
	CODING_GUEST_VERBS,
	type CodingGuestCancelRequest,
	type CodingGuestCommand,
	type CodingGuestCommandAnswer,
	type CodingGuestCommandState,
	type CodingGuestExit,
	type CodingGuestMountAnswer,
	type CodingGuestMountRequest,
	type CodingGuestOutputAnswer,
	type CodingGuestOutputRequest,
	type CodingGuestRequests,
	type CodingGuestRunRequest,
	type CodingGuestSessionQuiescedAnswer,
	type CodingGuestSessionRequest,
	type CodingGuestSessionStoppedAnswer,
	type CodingGuestStatusAnswer,
	type CodingGuestVerb,
	type CodingGuestView,
	isUuid,
	parseClosedRecord,
	parseCodingGuestRequest,
	SHA256_HEX_PATTERN,
} from "@qorpera/contracts";
import { codingErrorCode } from "./cloud-coding-error-code.ts";

// The agent inside a member's coding machine (F3 step 5g-2b; RUNTIME-FOLDER-CODING-MACHINES.md "The guest agent").
// The executor pushes this file to /opt/qorpera-guest/agent.mjs at each start and runs one verb per LXD exec as root,
// with the request on stdin and one answer line on stdout (contracts' cloud-coding-guest). Each session gets its own
// Linux user (passwd files, never deleted), its own network namespace behind the machine's NAT, its own folder view
// at /run/qorpera-folder/mounts/<worker32> and a user manager that sees it at /company. Each command runs in its own
// transient unit as the session's user, through `agent.mjs relay`, which writes its output into a ring of files and
// its exit into exit.json. The machine's disk keeps each command's intent and outcome; nothing here is the truth the
// executor keeps in SQL, only what this machine saw.

const executeFile = promisify(execFile);
const COMPACT = /^[0-9a-f]{32}$/;
const SEGMENT = /^[0-9]{16}\.out$/;
const SIGNAL = /^SIG[A-Z0-9]{2,12}$/;
const ENDED = new Set<string>(["exited", "cancelled", "timed_out", "lost"]);
const SUBID_BASE = 1048576;
const SUBID_COUNT = 65536;
/** One past the highest sub-id a range may hold ((uid_t)-1 is no id). */
const SUBID_LIMIT = 4294967295;
const NETWORKS = 16384;
const FOLDER_POLLS = 100;
const POLL_MS = 200;
const USER_SCHEMA = "qorpera.coding-guest-session-user/v1";
const INTENT_SCHEMA = "qorpera.coding-guest-intent/v1";
const OUTCOME_SCHEMA = "qorpera.coding-guest-outcome/v1";
const INPUT_GRACE_MS = 60000;
const OUTCOME_KEEP_MS = 3600000;
const RING_ENTRIES = 64;
const RELAY_REFUSED = 125;
const TOOLS = Object.freeze({
	systemctl: "/usr/bin/systemctl",
	systemdRun: "/usr/bin/systemd-run",
	loginctl: "/usr/bin/loginctl",
	ip: "/usr/sbin/ip",
	nft: "/usr/sbin/nft",
	sysctl: "/usr/sbin/sysctl",
	useradd: "/usr/sbin/useradd",
	groupadd: "/usr/sbin/groupadd",
	usermod: "/usr/sbin/usermod",
	getent: "/usr/bin/getent",
	chmod: "/usr/bin/chmod",
	umount: "/usr/bin/umount",
});

export interface CodingGuestAgentPorts {
	stateRoot?: string;
	runtimeRoot?: string;
	folderRoot?: string;
	/** Where the user managers' drop-ins go. */
	systemdRoot?: string;
	subidFiles?: { uid: string; gid: string };
	/** systemd-resolved's upstream list, bound over a session's /etc/resolv.conf (the stub is not in its netns). */
	resolvConf?: string;
	agent?: string;
	/** Runs a tool; throws CODING_GUEST_SYSTEM_UNCONFIRMED with the exit status (null when it did not exit). */
	system?: (executable: string, args: readonly string[]) => Promise<string>;
	bootId?: () => Promise<string>;
	nowMs?: () => number;
	sleep?: (ms: number) => Promise<void>;
	readMountinfo?: () => Promise<string>;
	chown?: (path: string, uid: number, gid: number) => Promise<void>;
	lockWaitSeconds?: number;
	ring?: { segmentBytes: number; segments: number };
	requireRoot?: boolean;
	/** The uid the relay runs as, which its request must name. */
	processUid?: () => number;
	/** Calls the listener when systemd stops the relay's unit (SIGTERM); returns the unsubscribe. */
	onTerminate?: (listener: () => void) => () => void;
}
type Agent = Required<CodingGuestAgentPorts>;

function settle(ports: CodingGuestAgentPorts): Agent {
	return {
		stateRoot: ports.stateRoot ?? CODING_GUEST.state,
		runtimeRoot: ports.runtimeRoot ?? CODING_GUEST.runtime,
		folderRoot: ports.folderRoot ?? CODING_GUEST.folder,
		systemdRoot: ports.systemdRoot ?? "/run/systemd/system",
		subidFiles: ports.subidFiles ?? { uid: "/etc/subuid", gid: "/etc/subgid" },
		resolvConf: ports.resolvConf ?? "/run/systemd/resolve/resolv.conf",
		agent: ports.agent ?? CODING_GUEST.agent,
		system: ports.system ?? system,
		bootId: ports.bootId ?? currentBoot,
		nowMs: ports.nowMs ?? Date.now,
		sleep: ports.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms))),
		readMountinfo: ports.readMountinfo ?? (() => readFile("/proc/self/mountinfo", "utf8")),
		chown: ports.chown ?? chown,
		lockWaitSeconds: ports.lockWaitSeconds ?? 60,
		ring: ports.ring ?? { segmentBytes: CODING_GUEST.segmentBytes, segments: CODING_GUEST.segments },
		requireRoot: ports.requireRoot ?? true,
		processUid: ports.processUid ?? (() => process.getuid?.() ?? -1),
		onTerminate:
			ports.onTerminate ??
			((listener: () => void) => {
				process.on("SIGTERM", listener);
				return () => process.off("SIGTERM", listener);
			}),
	};
}

async function system(executable: string, args: readonly string[]): Promise<string> {
	try {
		return (
			await executeFile(executable, [...args], {
				env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
				// Above the folder unit's TimeoutStopSec, so a stop is seen to its end.
				timeout: 30000,
				maxBuffer: 65536,
			})
		).stdout;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		throw Object.assign(new Error("CODING_GUEST_SYSTEM_UNCONFIRMED"), {
			status: typeof code === "number" ? code : null,
		});
	}
}
function exitStatus(error: unknown): number | null {
	const status = (error as { status?: unknown } | undefined)?.status;
	return typeof status === "number" ? status : null;
}
async function ignore(work: Promise<unknown>): Promise<void> {
	await work.then(
		() => undefined,
		() => undefined,
	);
}
async function currentBoot(): Promise<string> {
	const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	if (!isUuid(boot)) throw new Error("CODING_GUEST_BOOT_UNAVAILABLE");
	return boot;
}
function requireRoot(at: Agent): void {
	if (at.requireRoot && process.getuid?.() !== 0) throw new Error("CODING_GUEST_REQUIRES_ROOT");
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		if (!(await handle.stat()).isFile()) throw new Error("CODING_GUEST_FILE_INVALID");
		// Bounded as read, not as stat'd: some of these files are the session user's, who may grow them meanwhile.
		const buffer = Buffer.alloc(maxBytes + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
			if (bytesRead === 0) break;
			size += bytesRead;
		}
		if (size > maxBytes) throw new Error("CODING_GUEST_FILE_INVALID");
		return JSON.parse(buffer.subarray(0, size).toString("utf8"));
	} finally {
		await handle.close();
	}
}
async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
	await writeText(path, JSON.stringify(value), mode);
}
/** Written whole, synced, then renamed into place. */
async function writeText(path: string, text: string, mode: number): Promise<void> {
	await rename(await writtenAside(path, text, mode), path);
	await syncDirectory(dirname(path));
}
/** Created once, whole: written and synced under a name of its own, then linked to its own name, which fails when a
 * record is there. So no reader sees part of one, and an existing record is never replaced. */
async function retain(path: string, value: unknown): Promise<boolean> {
	const temporary = await writtenAside(path, JSON.stringify(value), 0o400);
	try {
		await link(temporary, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		await rm(temporary, { force: true });
	}
	await syncDirectory(dirname(path));
	return true;
}
/** The text in a new synced file next to `path`, named `<name>.<uuid>.tmp`: no reader takes such a name, so one a crash
 * left behind is passed over. */
async function writtenAside(path: string, text: string, mode: number): Promise<string> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const handle = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode,
	);
	try {
		await handle.writeFile(text);
		await handle.sync();
	} catch (error) {
		await handle.close();
		await rm(temporary, { force: true });
		throw error;
	}
	await handle.close();
	return temporary;
}
/** A folder's names synced, so one just made there outlives a crash. */
async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function missing<T>(read: () => Promise<T>): Promise<T | undefined> {
	try {
		return await read();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
async function exists(path: string): Promise<boolean> {
	return (await missing(() => lstat(path))) !== undefined;
}

/** An id's 32 hex digits, for names and paths. */
function compact(id: string): string {
	if (!isUuid(id)) throw new Error("CODING_GUEST_REQUEST_INVALID");
	return id.replaceAll("-", "").toLowerCase();
}
function dashed(hex: string): string {
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function places(at: Agent, workerId: string) {
	const worker = compact(workerId);
	const session = join(at.stateRoot, "sessions", worker);
	return {
		worker,
		session,
		/** The session's user, kept so a later request for another uid is refused. */
		user: join(session, "user.json"),
		commands: join(session, "commands"),
		lock: join(at.runtimeRoot, "locks", worker),
		view: join(at.folderRoot, "views", `${worker}.json`),
		folderState: join(at.folderRoot, "state", worker),
		/** The program's local folder, on the machine's disk: the session's own git files and its cache folders. It
		 * outlives a new view (the program keeps what is still the session's) and goes with the session. */
		folderLocal: join(session, "folder-local"),
		mountpoint: join(at.folderRoot, "mounts", worker),
		folderUnit: `qorpera-folder-${worker}.service`,
		slice: `qorpera-coding-${worker}.slice`,
		namespace: `qorpera-${worker}`,
	};
}
type Places = ReturnType<typeof places>;
function commandPlaces(at: Agent, session: Places, commandId: string) {
	const command = compact(commandId);
	const directory = join(session.commands, command);
	return {
		command,
		directory,
		intent: join(directory, "intent.json"),
		cancel: join(directory, "cancel.json"),
		outcome: join(directory, "outcome.json"),
		/** The session user's: the relay writes the ring and exit.json here. */
		output: join(directory, "output"),
		/** The whole request, secrets included, in memory until systemd has opened it as the relay's stdin. */
		input: join(at.runtimeRoot, "inputs", `${session.worker}-${command}.json`),
		unit: `qorpera-coding-${session.worker}-${command}.service`,
	};
}
type CommandPlaces = ReturnType<typeof commandPlaces>;
/** The machine's lock, for its users, sub-ids and networks; always taken inside a session's lock, never around one. */
function machineLock(at: Agent): string {
	return join(at.runtimeRoot, "locks", "machine");
}

/** The top mount a path is on, from mountinfo. */
function mountOf(mountinfo: string, path: string): { mountpoint: string; fstype: string; source: string } | undefined {
	const decode = (field: string) =>
		field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
	let top: { mountpoint: string; fstype: string; source: string } | undefined;
	for (const line of mountinfo.split("\n").filter(Boolean)) {
		const fields = line.split(" ");
		const dash = fields.indexOf("-", 6);
		if (dash < 0 || fields.length < dash + 3) throw new Error("CODING_GUEST_MOUNTS_UNCONFIRMED");
		const mountpoint = decode(fields[4]);
		if (path !== mountpoint && !path.startsWith(mountpoint === "/" ? "/" : `${mountpoint}/`)) continue;
		if (!top || mountpoint.length >= top.mountpoint.length)
			top = { mountpoint, fstype: fields[dash + 1], source: decode(fields[dash + 2]) };
	}
	return top;
}

/** Takes a lock: util-linux flock locks the open file it shares with the agent, so the lock outlives flock and goes
 * when the agent closes the file or dies. False when another holds it past the wait. */
function lockOpenFile(fd: number, waitSeconds: number): Promise<boolean> {
	return new Promise((done, fail) => {
		// The open file is the child's fd 3; flock exits 75 when the wait runs out.
		const args = ["--exclusive", "--wait", String(waitSeconds), "--conflict-exit-code", "75", "3"];
		const child = spawn("/usr/bin/flock", args, {
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
			stdio: ["ignore", "ignore", "ignore", fd],
		});
		child.once("error", () => fail(new Error("CODING_GUEST_LOCK_FAILED")));
		child.once("exit", (code) => {
			if (code === 0) done(true);
			else if (code === 75) done(false);
			else fail(new Error("CODING_GUEST_LOCK_FAILED"));
		});
	});
}
async function locked<T>(at: Agent, path: string, busy: string, work: () => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
	try {
		if (!(await lockOpenFile(handle.fd, at.lockWaitSeconds))) throw new Error(busy);
		return await work();
	} finally {
		await handle.close();
	}
}
/** A record this agent wrote, read back. */
function stored(value: unknown, keys: readonly string[]): Record<string, unknown> {
	try {
		return parseClosedRecord(value, "coding guest state", keys);
	} catch {
		throw new Error("CODING_GUEST_STATE_INVALID");
	}
}
async function makeDirectory(path: string, mode: number): Promise<void> {
	try {
		await mkdir(path, { mode });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/** A passwd or group entry's fields by id; undefined when there is none (getent exits 2). */
async function lookup(at: Agent, database: "passwd" | "group", id: number): Promise<string[] | undefined> {
	try {
		return (await at.system(TOOLS.getent, [database, String(id)])).trim().split(":");
	} catch (error) {
		if (exitStatus(error) === 2) return undefined;
		throw error;
	}
}
/** The session's user, in the passwd files: made once and never deleted, so its files keep their owner. The image
 * ships the qorpera-coding group and its sudo rule; useradd adds no sub-ids, they come explicitly next. */
async function ensureUser(at: Agent, uid: number, gid: number): Promise<string> {
	const name = `qorpera-${uid}`;
	const user = await lookup(at, "passwd", uid);
	if (user) {
		if (user[0] !== name || user[3] !== String(gid)) throw new Error("CODING_GUEST_SESSION_USER_CONFLICT");
	} else {
		const group = await lookup(at, "group", gid);
		if (!group) await at.system(TOOLS.groupadd, ["--gid", String(gid), `qorpera-${gid}`]);
		else if (group[0] !== `qorpera-${gid}`) throw new Error("CODING_GUEST_SESSION_USER_CONFLICT");
		await at.system(TOOLS.useradd, [
			"--uid",
			String(uid),
			"--gid",
			String(gid),
			"--groups",
			"qorpera-coding",
			"--create-home",
			"--home-dir",
			`/home/${name}`,
			"--shell",
			"/bin/bash",
			"-K",
			"SUB_UID_COUNT=0",
			"-K",
			"SUB_GID_COUNT=0",
			name,
		]);
	}
	await at.system(TOOLS.chmod, ["0700", `/home/${name}`]);
	await ensureSubids(at, name, uid);
	return name;
}

interface SubidRange {
	owner: string;
	start: number;
	count: number;
}
function parseSubids(text: string): SubidRange[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const fields = line.split(":");
			if (
				fields.length !== 3 ||
				!fields[0] ||
				!/^(0|[1-9][0-9]{0,9})$/.test(fields[1]) ||
				!/^[1-9][0-9]{0,9}$/.test(fields[2])
			)
				throw new Error("CODING_GUEST_SUBIDS_INVALID");
			return { owner: fields[0], start: Number(fields[1]), count: Number(fields[2]) };
		});
}
/** The user's own 65536 sub-ids for rootless containers: the lowest aligned range from 1048576 that no line of either
 * file overlaps, never shared with another user. */
async function ensureSubids(at: Agent, name: string, uid: number): Promise<void> {
	const read = async (path: string) => parseSubids((await missing(() => readFile(path, "utf8"))) ?? "");
	const uids = await read(at.subidFiles.uid);
	const gids = await read(at.subidFiles.gid);
	const owns = (ranges: SubidRange[]) => ranges.some((range) => range.owner === name || range.owner === String(uid));
	const lacksUids = !owns(uids);
	const lacksGids = !owns(gids);
	if (!lacksUids && !lacksGids) return;
	const taken = [...uids, ...gids];
	let start = SUBID_BASE;
	while (
		start + SUBID_COUNT <= SUBID_LIMIT &&
		taken.some((range) => range.start < start + SUBID_COUNT && start < range.start + range.count)
	)
		start += SUBID_COUNT;
	if (start + SUBID_COUNT > SUBID_LIMIT) throw new Error("CODING_GUEST_SUBIDS_EXHAUSTED");
	const span = `${start}-${start + SUBID_COUNT - 1}`;
	await at.system(TOOLS.usermod, [
		...(lacksUids ? ["--add-subuids", span] : []),
		...(lacksGids ? ["--add-subgids", span] : []),
		name,
	]);
}

/** The machine's NAT for the sessions' namespaces, which may reach out but not each other. Replaced whole. */
const NAT_RULES = `table inet qorpera_guest
delete table inet qorpera_guest
table inet qorpera_guest {
	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		ip saddr 10.253.0.0/16 oifname != "qgh*" masquerade
	}
	chain forward {
		type filter hook forward priority filter; policy accept;
		iifname "qgh*" oifname "qgh*" drop
	}
}
`;
/** A network's /30: .1 on the machine's side (end 1), .2 inside (end 2). */
function address(index: number, end: 1 | 2): string {
	const n = 4 * index + end;
	return `10.253.${n >> 8}.${n & 255}`;
}
/** The session's network namespace behind the machine's NAT. Its index and readiness live in memory, so a restarted
 * machine makes them again. */
async function ensureNetwork(at: Agent, session: Places): Promise<void> {
	await locked(at, machineLock(at), "CODING_GUEST_MACHINE_BUSY", async () => {
		const networks = join(at.runtimeRoot, "networks");
		await mkdir(networks, { recursive: true, mode: 0o700 });
		if (!(await exists(join(networks, "nat.ready")))) {
			await at.system(TOOLS.sysctl, ["-q", "-w", "net.ipv4.ip_forward=1"]);
			const rules = join(networks, "rules.nft");
			await writeText(rules, NAT_RULES, 0o600);
			await at.system(TOOLS.nft, ["-f", rules]);
			await writeText(join(networks, "nat.ready"), "", 0o600);
		}
		const index = await networkIndex(networks, session.worker);
		const ready = join(networks, `${index}.ready`);
		if (await exists(ready)) return;
		const host = `qgh${index}`;
		const inside = `qgn${index}`;
		const ns = session.namespace;
		await ignore(at.system(TOOLS.ip, ["netns", "delete", ns]));
		await ignore(at.system(TOOLS.ip, ["link", "delete", host]));
		await at.system(TOOLS.ip, ["netns", "add", ns]);
		await at.system(TOOLS.ip, ["link", "add", host, "type", "veth", "peer", "name", inside, "netns", ns]);
		await at.system(TOOLS.ip, ["address", "add", `${address(index, 1)}/30`, "dev", host]);
		await at.system(TOOLS.ip, ["link", "set", host, "up"]);
		await at.system(TOOLS.ip, ["-n", ns, "link", "set", "lo", "up"]);
		await at.system(TOOLS.ip, ["-n", ns, "address", "add", `${address(index, 2)}/30`, "dev", inside]);
		await at.system(TOOLS.ip, ["-n", ns, "link", "set", inside, "up"]);
		await at.system(TOOLS.ip, ["-n", ns, "route", "add", "default", "via", address(index, 1)]);
		await writeText(ready, "", 0o600);
	});
}
/** The session's network index: the file named by it holds the session's worker; the lowest free one otherwise. */
async function networkIndex(networks: string, worker: string): Promise<number> {
	const taken = new Set<number>();
	for (const name of await readdir(networks)) {
		if (!/^(0|[1-9][0-9]{0,4})$/.test(name)) continue;
		if ((await readFile(join(networks, name), "utf8")) === worker) return Number(name);
		taken.add(Number(name));
	}
	for (let index = 0; index < NETWORKS; index++) {
		if (taken.has(index)) continue;
		await writeText(join(networks, String(index)), worker, 0o600);
		return index;
	}
	throw new Error("CODING_GUEST_NETWORKS_EXHAUSTED");
}
/** The network a session holds, if any. */
async function heldNetwork(networks: string, worker: string): Promise<number | undefined> {
	for (const name of (await missing(() => readdir(networks))) ?? []) {
		if (/^(0|[1-9][0-9]{0,4})$/.test(name) && (await readFile(join(networks, name), "utf8")) === worker)
			return Number(name);
	}
	return undefined;
}

interface UnitState {
	active: string;
	result: string;
	mainCode: string;
	mainStatus: string;
}
const LIVE = new Set(["active", "activating", "deactivating", "reloading"]);
async function unitState(at: Agent, unit: string): Promise<UnitState> {
	const text = await at.system(TOOLS.systemctl, [
		"show",
		unit,
		"--property=LoadState,ActiveState,Result,ExecMainCode,ExecMainStatus",
	]);
	const fields = new Map<string, string>();
	for (const line of text.split("\n")) {
		const equals = line.indexOf("=");
		if (equals > 0) fields.set(line.slice(0, equals), line.slice(equals + 1));
	}
	return {
		active: fields.get("ActiveState") ?? "",
		result: fields.get("Result") ?? "",
		mainCode: fields.get("ExecMainCode") ?? "",
		mainStatus: fields.get("ExecMainStatus") ?? "",
	};
}
/** Whether the folder program's own mount is the top one at the session's mountpoint. The program mounts directly as
 * root, so the kernel lists it as `fuse qorpera-company` (cloud-machine-guest.ts reads it the same way); `fuse.qorpera`
 * is a mount made through fusermount. The source names the program either way. */
async function folderMountedAt(at: Agent, mountpoint: string): Promise<boolean> {
	const top = mountOf(await at.readMountinfo(), mountpoint);
	return (
		top?.mountpoint === mountpoint &&
		(top.fstype === "fuse" || top.fstype === "fuse.qorpera") &&
		top.source === "qorpera-company"
	);
}
async function folderMounted(at: Agent, session: Places): Promise<boolean> {
	return (
		(await unitState(at, session.folderUnit)).active === "active" && (await folderMountedAt(at, session.mountpoint))
	);
}
async function anythingMountedAt(at: Agent, mountpoint: string): Promise<boolean> {
	return mountOf(await at.readMountinfo(), mountpoint)?.mountpoint === mountpoint;
}

function folderArgs(session: Places, uid: number, gid: number): string[] {
	const properties = [
		"Type=exec",
		"StartLimitIntervalSec=0",
		"Restart=always",
		"RestartSec=2s",
		// The program exits 3 when the node closed or refused the view: a new view is needed, not a restart.
		"RestartPreventExitStatus=3",
		`ExecStopPost=-${TOOLS.umount} -l ${session.mountpoint}`,
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
	];
	return [
		"--quiet",
		`--unit=${session.folderUnit}`,
		...properties.flatMap((property) => ["--property", property]),
		CODING_GUEST.folderProgram,
		"mount",
		"--view-file",
		session.view,
		"--mountpoint",
		session.mountpoint,
		"--state-dir",
		session.folderState,
		"--local-dir",
		session.folderLocal,
		"--allow-other",
		"yes",
		"--owner-uid",
		String(uid),
		"--owner-gid",
		String(gid),
	];
}
/** Shows the request's view. Another view stops the program first and, once it ended, starts it on fresh state; a
 * stopped or failed program starts again. Then waits until it mounted, the node closed the view, or the wait ran out. */
async function showView(
	at: Agent,
	session: Places,
	view: CodingGuestView,
	uid: number,
	gid: number,
): Promise<{ mount: CodingGuestMountAnswer["mount"]; restarted: boolean }> {
	await mkdir(join(at.folderRoot, "views"), { recursive: true, mode: 0o700 });
	await mkdir(join(at.folderRoot, "state"), { recursive: true, mode: 0o700 });
	await mkdir(join(at.folderRoot, "mounts"), { recursive: true, mode: 0o755 });
	const wanted = JSON.stringify(view);
	const held = await readJson(session.view, 4096).catch(() => undefined);
	if (held === undefined || JSON.stringify(held) !== wanted) {
		await ignore(at.system(TOOLS.systemctl, ["stop", session.folderUnit]));
		const stopped = (await unitState(at, session.folderUnit)).active;
		// A program that outlived its stop, mounted or still starting, may yet use its state and its view's pass.
		if (stopped !== "inactive" && stopped !== "failed") throw new Error("CODING_GUEST_FOLDER_STILL_RUNNING");
		if (stopped === "failed") await ignore(at.system(TOOLS.systemctl, ["reset-failed", session.folderUnit]));
		if (await anythingMountedAt(at, session.mountpoint)) throw new Error("CODING_GUEST_FOLDER_STILL_MOUNTED");
		await rm(session.folderState, { recursive: true, force: true });
		await mkdir(session.folderState, { mode: 0o700 });
		await writeText(session.view, wanted, 0o600);
	}
	await makeDirectory(session.mountpoint, 0o755);
	let state = await unitState(at, session.folderUnit);
	if (state.active === "failed") {
		await ignore(at.system(TOOLS.systemctl, ["reset-failed", session.folderUnit]));
		state = await unitState(at, session.folderUnit);
	}
	let restarted = false;
	if (!LIVE.has(state.active)) {
		await at.system(TOOLS.systemdRun, folderArgs(session, uid, gid));
		restarted = true;
	}
	for (let poll = 1; ; poll++) {
		const now = await unitState(at, session.folderUnit);
		if (now.active === "active" && (await folderMountedAt(at, session.mountpoint)))
			return { mount: "mounted", restarted };
		if (now.active === "failed" && now.result === "exit-code" && now.mainCode === "1" && now.mainStatus === "3")
			return { mount: "closed", restarted };
		if (poll >= FOLDER_POLLS) return { mount: "unanswered", restarted };
		await at.sleep(POLL_MS);
	}
}
function userManagerDropIn(at: Agent, uid: number): { directory: string; file: string } {
	const directory = join(at.systemdRoot, `user@${uid}.service.d`);
	return { directory, file: join(directory, "qorpera-company.conf") };
}
/** The session's user manager (its shells, editors and containers) sees the folder at /company and lives in the
 * session's namespace; it restarts when that changed or the folder program started again, and lingers. */
async function ensureUserManager(
	at: Agent,
	session: Places,
	uid: number,
	name: string,
	restarted: boolean,
): Promise<void> {
	const resolv = await exists(at.resolvConf);
	const text = [
		"[Service]",
		`BindPaths=${session.mountpoint}:/company`,
		`NetworkNamespacePath=/run/netns/${session.namespace}`,
		...(resolv ? [`BindReadOnlyPaths=${at.resolvConf}:/etc/resolv.conf`] : []),
		"",
	].join("\n");
	const dropIn = userManagerDropIn(at, uid);
	const changed = (await readFile(dropIn.file, "utf8").catch(() => undefined)) !== text;
	if (changed) {
		await mkdir(dropIn.directory, { recursive: true, mode: 0o755 });
		await writeText(dropIn.file, text, 0o644);
		await at.system(TOOLS.systemctl, ["daemon-reload"]);
	}
	if (changed || restarted) await at.system(TOOLS.systemctl, ["try-restart", `user@${uid}.service`]);
	await at.system(TOOLS.loginctl, ["enable-linger", name]);
}

async function readSessionUser(session: Places): Promise<{ uid: number; gid: number } | undefined> {
	const held = await missing(() => readJson(session.user, 4096));
	if (held === undefined) return undefined;
	const user = stored(held, ["gid", "schema", "uid"]);
	if (user.schema !== USER_SCHEMA || !Number.isSafeInteger(user.uid) || !Number.isSafeInteger(user.gid))
		throw new Error("CODING_GUEST_STATE_INVALID");
	return { uid: user.uid as number, gid: user.gid as number };
}

/** `mount`: the session's user, network and view; then its user manager once the folder is up. */
export async function mountCodingGuestSession(
	request: CodingGuestMountRequest,
	ports: CodingGuestAgentPorts = {},
): Promise<CodingGuestMountAnswer> {
	const at = settle(ports);
	const session = places(at, request.workerId);
	// The view's pass and the program's state must never reach the machine's disk.
	if (mountOf(await at.readMountinfo(), at.folderRoot)?.fstype !== "tmpfs")
		throw new Error("CODING_GUEST_FOLDER_NOT_IN_MEMORY");
	const mount = await locked(at, session.lock, "CODING_GUEST_SESSION_BUSY", async () => {
		const held = await readSessionUser(session);
		if (held && (held.uid !== request.uid || held.gid !== request.gid))
			throw new Error("CODING_GUEST_SESSION_USER_CHANGED");
		const name = await locked(at, machineLock(at), "CODING_GUEST_MACHINE_BUSY", () =>
			ensureUser(at, request.uid, request.gid),
		);
		await mkdir(session.session, { recursive: true, mode: 0o755 });
		if (!held) await writeJson(session.user, { schema: USER_SCHEMA, uid: request.uid, gid: request.gid });
		await ensureNetwork(at, session);
		const shown = await showView(at, session, request.view, request.uid, request.gid);
		if (shown.mount === "mounted") await ensureUserManager(at, session, request.uid, name, shown.restarted);
		return shown.mount;
	});
	return Object.freeze({
		schema: "qorpera.coding-guest-mounted/v1",
		workerId: request.workerId,
		viewId: request.view.viewId,
		mount,
	});
}

/** What a run request asks for, without keeping any of it: the same commandId with the same digest is the same run. */
function runDigest(request: CodingGuestRunRequest): string {
	const environment = Object.entries(request.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return createHash("sha256")
		.update(JSON.stringify([request.uid, request.gid, request.command, request.cwd, environment, request.timeoutMs]))
		.digest("hex");
}
async function readIntent(command: CommandPlaces): Promise<{ digest: string; bootId: string } | undefined> {
	const held = await missing(() => readJson(command.intent, 4096));
	if (held === undefined) return undefined;
	const intent = stored(held, ["bootId", "commandId", "digest", "schema"]);
	if (
		intent.schema !== INTENT_SCHEMA ||
		!isUuid(intent.commandId) ||
		compact(intent.commandId) !== command.command ||
		typeof intent.digest !== "string" ||
		!SHA256_HEX_PATTERN.test(intent.digest) ||
		!isUuid(intent.bootId)
	)
		throw new Error("CODING_GUEST_STATE_INVALID");
	return { digest: intent.digest, bootId: intent.bootId };
}
/** How bash ended, as the relay wrote it; undefined when there is no such record or it is not one. */
function parseExit(value: unknown): CodingGuestExit | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "code,signal"
	)
		return undefined;
	const { code, signal } = value as { code: unknown; signal: unknown };
	if (code === null && typeof signal === "string" && SIGNAL.test(signal)) return { code: null, signal };
	if (signal === null && typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255)
		return { code, signal: null };
	return undefined;
}
/** The relay's record, in the session user's folder: read as untrusted data. */
async function readExit(command: CommandPlaces): Promise<CodingGuestExit | undefined> {
	return parseExit(await readJson(join(command.output, "exit.json"), 4096).catch(() => undefined));
}
async function readOutcome(command: CommandPlaces, commandId: string): Promise<CodingGuestCommand | undefined> {
	const held = await missing(() => readJson(command.outcome, 4096));
	if (held === undefined) return undefined;
	const outcome = stored(held, ["end", "exit", "schema", "state"]);
	const ended = outcome.exit === null ? null : parseExit(outcome.exit);
	const state = outcome.state as CodingGuestCommandState;
	if (
		outcome.schema !== OUTCOME_SCHEMA ||
		!ENDED.has(state) ||
		ended === undefined ||
		(state === "exited" && ended === null) ||
		(state === "lost" && ended !== null) ||
		!Number.isSafeInteger(outcome.end) ||
		(outcome.end as number) < 0
	)
		throw new Error("CODING_GUEST_STATE_INVALID");
	return { commandId, state, exit: ended, end: outcome.end as number };
}

interface Segment {
	start: number;
	size: number;
	handle: FileHandle;
}
/** The command's output ring, its segments open: at most RING_ENTRIES names, each a regular file, end to end. A segment
 * the relay dropped while it was listed is listed again. No ring is an empty one. */
async function openRing(output: string): Promise<Segment[]> {
	for (let attempt = 1; ; attempt++) {
		const names: string[] = [];
		try {
			const directory = await opendir(output);
			try {
				for await (const entry of directory) {
					names.push(entry.name);
					if (names.length > RING_ENTRIES) throw new Error("CODING_GUEST_OUTPUT_INVALID");
				}
			} finally {
				await directory.close().catch(() => undefined);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const starts = names
			.filter((name) => SEGMENT.test(name))
			.map((name) => Number(name.slice(0, 16)))
			.sort((a, b) => a - b);
		const segments: Segment[] = [];
		try {
			for (const start of starts) {
				if (!Number.isSafeInteger(start)) throw new Error("CODING_GUEST_OUTPUT_INVALID");
				const handle = await open(
					join(output, `${String(start).padStart(16, "0")}.out`),
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				segments.push({ start, size: 0, handle });
				const stat = await handle.stat();
				if (!stat.isFile()) throw new Error("CODING_GUEST_OUTPUT_INVALID");
				segments[segments.length - 1].size = stat.size;
			}
			for (let index = 1; index < segments.length; index++)
				if (segments[index - 1].start + segments[index - 1].size !== segments[index].start)
					throw new Error("CODING_GUEST_OUTPUT_INVALID");
			const last = segments.at(-1);
			if (last && !Number.isSafeInteger(last.start + last.size)) throw new Error("CODING_GUEST_OUTPUT_INVALID");
			return segments;
		} catch (error) {
			await closeRing(segments);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 5) throw error;
		}
	}
}
async function closeRing(segments: readonly Segment[]): Promise<void> {
	for (const segment of segments) await segment.handle.close().catch(() => undefined);
}
/** Up to `length` bytes from `from`, within the sizes the ring was opened with; stops at a segment that ends early. */
async function readPage(segments: readonly Segment[], from: number, length: number): Promise<Buffer> {
	const page = Buffer.alloc(length);
	let filled = 0;
	for (const segment of segments) {
		if (filled >= length) break;
		const at = from + filled;
		if (at >= segment.start + segment.size || at < segment.start) continue;
		const want = Math.min(length - filled, segment.start + segment.size - at);
		let got = 0;
		while (got < want) {
			const { bytesRead } = await segment.handle.read(page, filled + got, want - got, at - segment.start + got);
			if (bytesRead === 0) break;
			got += bytesRead;
		}
		filled += got;
		if (got < want) break;
	}
	return page.subarray(0, filled);
}
async function ringEnd(output: string): Promise<number> {
	const segments = await openRing(output);
	await closeRing(segments);
	const last = segments.at(-1);
	return last ? last.start + last.size : 0;
}

/** A command's state now. An ended command's outcome is kept once, with its last byte; the relay's exit record says how
 * bash ended, the cancel record and the unit's timeout what ended it. */
async function observe(at: Agent, command: CommandPlaces, commandId: string): Promise<CodingGuestCommand> {
	const held = await readOutcome(command, commandId);
	if (held) return held;
	const intent = await readIntent(command);
	if (!intent) throw new Error("CODING_GUEST_COMMAND_UNKNOWN");
	const sameBoot = intent.bootId === (await at.bootId());
	// In this order: a run removes the input only once its unit started, the relay writes its exit record before its
	// unit ends, and a cancel writes its record before it stops the unit. So an input that is gone means the unit state
	// read next is the started unit's, and records read after a unit that is not live are all it will write.
	const starting = sameBoot && (await young(at, command.input));
	const unit = sameBoot ? await unitState(at, command.unit) : undefined;
	let state: CodingGuestCommandState;
	let exit: CodingGuestExit | undefined;
	if (unit && LIVE.has(unit.active)) state = "running";
	else {
		const cancelled = await exists(command.cancel);
		exit = await readExit(command);
		if (cancelled) state = "cancelled";
		// The deadline ended what was left, even after bash itself exited (ExitType=cgroup).
		else if (unit?.result === "timeout") state = "timed_out";
		else if (exit) state = "exited";
		// The run that wrote the input may not have started its unit yet.
		else if (starting) state = "running";
		else state = "lost";
	}
	const end = await ringEnd(command.output);
	if (state === "running") return { commandId, state, exit: null, end };
	const ended = state === "lost" ? null : (exit ?? null);
	if (!(await retain(command.outcome, { schema: OUTCOME_SCHEMA, state, exit: ended, end }))) {
		const kept = await readOutcome(command, commandId);
		if (!kept) throw new Error("CODING_GUEST_STATE_INVALID");
		return kept;
	}
	if (sameBoot) await ignore(at.system(TOOLS.systemctl, ["reset-failed", command.unit]));
	return { commandId, state, exit: ended, end };
}
async function young(at: Agent, path: string): Promise<boolean> {
	const stat = await missing(() => lstat(path));
	return stat !== undefined && at.nowMs() - stat.mtimeMs < INPUT_GRACE_MS;
}

function runArgs(at: Agent, session: Places, command: CommandPlaces, request: CodingGuestRunRequest, resolv: boolean) {
	const properties = [
		"Type=exec",
		// The command runs until everything it started ended, and a stop ends all of it.
		"ExitType=cgroup",
		"KillMode=control-group",
		"TimeoutStopSec=5",
		...(request.timeoutMs === null ? [] : [`RuntimeMaxSec=${Math.ceil(request.timeoutMs / 1000)}`]),
		"ProtectProc=invisible",
		"PrivateIPC=yes",
		`NetworkNamespacePath=/run/netns/${session.namespace}`,
		`BindPaths=${session.mountpoint}:/company`,
		...(resolv ? [`BindReadOnlyPaths=${at.resolvConf}:/etc/resolv.conf`] : []),
		// systemd opens the input as root and hands it over as stdin; the relay never sees its path.
		`StandardInput=file:${command.input}`,
		"StandardOutput=null",
		"StandardError=journal",
	];
	return [
		"--quiet",
		`--unit=${command.unit}`,
		`--slice=${session.slice}`,
		`--uid=${request.uid}`,
		`--gid=${request.gid}`,
		...properties.flatMap((property) => ["--property", property]),
		"/usr/bin/env",
		"-i",
		"PATH=/usr/bin:/bin",
		"LANG=C.UTF-8",
		CODING_GUEST.node,
		at.agent,
		"relay",
		session.worker,
		command.command,
	];
}
/** Drops the output of commands that ended over an hour ago (their intent and outcome stay, so the same commandId is
 * never run again) and this session's inputs no run is still starting. The output folder is the session user's: only
 * its files are unlinked, never followed into. */
async function pruneEnded(at: Agent, session: Places): Promise<void> {
	const now = at.nowMs();
	for (const name of (await missing(() => readdir(session.commands))) ?? []) {
		if (!COMPACT.test(name)) continue;
		const directory = join(session.commands, name);
		const outcome = await missing(() => lstat(join(directory, "outcome.json")));
		if (!outcome?.isFile() || now - outcome.mtimeMs <= OUTCOME_KEEP_MS) continue;
		const output = join(directory, "output");
		for (const entry of (await missing(() => readdir(output))) ?? []) await ignore(unlink(join(output, entry)));
		await ignore(rmdir(output));
	}
	const inputs = join(at.runtimeRoot, "inputs");
	for (const name of (await missing(() => readdir(inputs))) ?? []) {
		if (name.startsWith(`${session.worker}-`) && !(await young(at, join(inputs, name))))
			await rm(join(inputs, name), { force: true });
	}
}
async function knownRun(
	at: Agent,
	command: CommandPlaces,
	commandId: string,
	digest: string,
): Promise<CodingGuestCommand | undefined> {
	const intent = await readIntent(command);
	if (!intent) return undefined;
	if (intent.digest !== digest) throw new Error("CODING_GUEST_COMMAND_CONFLICT");
	return observe(at, command, commandId);
}

/** `run`: starts the command once; the same request again reads its state. */
export async function runCodingGuestCommand(
	request: CodingGuestRunRequest,
	ports: CodingGuestAgentPorts = {},
): Promise<CodingGuestCommandAnswer> {
	const at = settle(ports);
	const session = places(at, request.workerId);
	const command = commandPlaces(at, session, request.commandId);
	const digest = runDigest(request);
	const now =
		(await knownRun(at, command, request.commandId, digest)) ??
		(await locked(at, session.lock, "CODING_GUEST_SESSION_BUSY", async () => {
			const seen = await knownRun(at, command, request.commandId, digest);
			if (seen) return seen;
			const user = await readSessionUser(session);
			if (!user) throw new Error("CODING_GUEST_SESSION_UNMOUNTED");
			if (user.uid !== request.uid || user.gid !== request.gid) throw new Error("CODING_GUEST_SESSION_USER_CHANGED");
			if (!(await folderMounted(at, session))) throw new Error("CODING_GUEST_FOLDER_UNMOUNTED");
			await pruneEnded(at, session);
			await ensureNetwork(at, session);
			await mkdir(session.commands, { recursive: true, mode: 0o755 });
			await makeDirectory(command.directory, 0o755);
			await makeDirectory(command.output, 0o700);
			await at.chown(command.output, request.uid, request.gid);
			await mkdir(dirname(command.input), { recursive: true, mode: 0o700 });
			// The input before the intent: whoever sees the intent sees the input until the run is over.
			await writeJson(command.input, request);
			try {
				const bootId = await at.bootId();
				await retain(command.intent, { schema: INTENT_SCHEMA, commandId: request.commandId, digest, bootId });
				// On a failure here the command may or may not have started: a read shows which.
				await at.system(TOOLS.systemdRun, runArgs(at, session, command, request, await exists(at.resolvConf)));
			} finally {
				await rm(command.input, { force: true });
			}
			return observe(at, command, request.commandId);
		}));
	return Object.freeze({ schema: "qorpera.coding-guest-command/v1", workerId: request.workerId, ...now });
}

/** `output`: the command's bytes from `offset`, after waiting up to `waitMs` for new ones while it runs. */
export async function readCodingGuestOutput(
	request: CodingGuestOutputRequest,
	ports: CodingGuestAgentPorts = {},
): Promise<{ answer: CodingGuestOutputAnswer; bytes: Buffer }> {
	const at = settle(ports);
	const command = commandPlaces(at, places(at, request.workerId), request.commandId);
	const polls = Math.max(1, Math.ceil(request.waitMs / POLL_MS));
	for (let poll = 1; ; poll++) {
		const now = await observe(at, command, request.commandId);
		const segments = await openRing(command.output);
		try {
			const last = segments.at(-1);
			// An ended command's last byte is its outcome's, even once its ring was dropped.
			const end = now.state === "running" ? (last ? last.start + last.size : 0) : now.end;
			if (request.offset > end) throw new Error("CODING_GUEST_OUTPUT_OFFSET_INVALID");
			// The ring is the session user's: a first segment past the end shows nothing.
			const gap = Math.max(0, Math.min(segments[0]?.start ?? end, end) - request.offset);
			const from = request.offset + gap;
			if (from < end || now.state !== "running" || poll >= polls) {
				const bytes = await readPage(segments, from, Math.min(request.maxBytes, end - from));
				const answer: CodingGuestOutputAnswer = Object.freeze({
					schema: "qorpera.coding-guest-output/v1",
					workerId: request.workerId,
					...now,
					end,
					offset: from,
					bytes: bytes.length,
					gap,
				});
				return { answer, bytes };
			}
		} finally {
			await closeRing(segments);
		}
		await at.sleep(POLL_MS);
	}
}

/** `cancel`: a running command is recorded as cancelled and its unit stopped; an ended one is only read. */
export async function cancelCodingGuestCommand(
	request: CodingGuestCancelRequest,
	ports: CodingGuestAgentPorts = {},
): Promise<CodingGuestCommandAnswer> {
	const at = settle(ports);
	const command = commandPlaces(at, places(at, request.workerId), request.commandId);
	let now = await observe(at, command, request.commandId);
	if (now.state === "running") {
		await retain(command.cancel, { schema: "qorpera.coding-guest-cancel/v1", commandId: request.commandId });
		await ignore(at.system(TOOLS.systemctl, ["stop", command.unit]));
		now = await observe(at, command, request.commandId);
	}
	return Object.freeze({ schema: "qorpera.coding-guest-command/v1", workerId: request.workerId, ...now });
}

/** `status`: every command of the session that still runs, then the newest of the rest, at most maxStatusCommands.
 * Each command without an outcome is observed, however old, so none that runs is left out; more running than one
 * answer holds is refused. */
export async function readCodingGuestStatus(
	request: CodingGuestSessionRequest,
	ports: CodingGuestAgentPorts = {},
): Promise<CodingGuestStatusAnswer> {
	const at = settle(ports);
	const session = places(at, request.workerId);
	const open: { name: string; mtimeMs: number }[] = [];
	const ended: { name: string; mtimeMs: number; seen?: CodingGuestCommand }[] = [];
	for (const name of (await missing(() => readdir(session.commands))) ?? []) {
		if (!COMPACT.test(name) || !isUuid(dashed(name))) continue;
		const intent = await missing(() => lstat(join(session.commands, name, "intent.json")));
		if (!intent?.isFile()) continue;
		const outcome = await missing(() => lstat(join(session.commands, name, "outcome.json")));
		(outcome?.isFile() ? ended : open).push({ name, mtimeMs: intent.mtimeMs });
	}
	const newest = (a: { name: string; mtimeMs: number }, b: { name: string; mtimeMs: number }) =>
		b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const commands: CodingGuestCommand[] = [];
	for (const entry of open.sort(newest)) {
		const commandId = dashed(entry.name);
		const seen = Object.freeze(await observe(at, commandPlaces(at, session, commandId), commandId));
		if (seen.state === "running") commands.push(seen);
		else ended.push({ ...entry, seen });
	}
	if (commands.length > CODING_GUEST.maxStatusCommands) throw new Error("CODING_GUEST_STATUS_OVERFLOW");
	for (const { name, seen } of ended.sort(newest).slice(0, CODING_GUEST.maxStatusCommands - commands.length)) {
		const commandId = dashed(name);
		commands.push(seen ?? Object.freeze(await observe(at, commandPlaces(at, session, commandId), commandId)));
	}
	return Object.freeze({
		schema: "qorpera.coding-guest-status/v1",
		workerId: request.workerId,
		commands: Object.freeze(commands),
	});
}

/** Stops the session's commands and its user manager, which lingers no more; answers the units that must have ended
 * and the session's user. */
async function stopSessionWork(
	at: Agent,
	session: Places,
): Promise<{ user: { uid: number; gid: number } | undefined; units: string[] }> {
	const user = await readSessionUser(session);
	const userManager = user ? `user@${user.uid}.service` : undefined;
	await ignore(at.system(TOOLS.systemctl, ["stop", session.slice]));
	if (user && userManager) {
		await ignore(at.system(TOOLS.loginctl, ["disable-linger", `qorpera-${user.uid}`]));
		await ignore(at.system(TOOLS.systemctl, ["stop", userManager]));
	}
	return { user, units: [session.slice, ...(userManager ? [userManager] : [])] };
}

/** `quiesce`: ends everything the session runs (its commands, its user manager and what that started) and keeps its
 * view mounted, so the view's final boundary comes after the last write anything of the session makes. A later `mount`
 * brings the user manager back. Refuses while anything of it still runs. */
export async function quiesceCodingGuestSession(
	request: CodingGuestSessionRequest,
	ports: CodingGuestAgentPorts = {},
): Promise<CodingGuestSessionQuiescedAnswer> {
	const at = settle(ports);
	const session = places(at, request.workerId);
	await locked(at, session.lock, "CODING_GUEST_SESSION_BUSY", async () => {
		const { units } = await stopSessionWork(at, session);
		for (const unit of units)
			if (LIVE.has((await unitState(at, unit)).active)) throw new Error("CODING_GUEST_SESSION_STILL_RUNNING");
	});
	return Object.freeze({ schema: "qorpera.coding-guest-session-quiesced/v1", workerId: request.workerId });
}

/** `stop-session`: ends everything the session runs, then removes its view, mount, network and files. Its user stays,
 * so files it owns on the machine keep their owner. Refuses, removing nothing more, while anything still runs or is
 * mounted there. */
export async function stopCodingGuestSession(
	request: CodingGuestSessionRequest,
	ports: CodingGuestAgentPorts = {},
): Promise<CodingGuestSessionStoppedAnswer> {
	const at = settle(ports);
	const session = places(at, request.workerId);
	await locked(at, session.lock, "CODING_GUEST_SESSION_BUSY", async () => {
		const { user, units } = await stopSessionWork(at, session);
		await ignore(at.system(TOOLS.systemctl, ["stop", session.folderUnit]));
		for (const unit of [...units, session.folderUnit])
			if (LIVE.has((await unitState(at, unit)).active)) throw new Error("CODING_GUEST_SESSION_STILL_RUNNING");
		await ignore(
			at.system(TOOLS.systemctl, ["reset-failed", session.folderUnit, `qorpera-coding-${session.worker}-*.service`]),
		);
		await ignore(at.system(TOOLS.umount, ["-l", session.mountpoint]));
		if (await anythingMountedAt(at, session.mountpoint)) throw new Error("CODING_GUEST_FOLDER_STILL_MOUNTED");
		if (user) {
			const dropIn = userManagerDropIn(at, user.uid);
			if (await exists(dropIn.file)) {
				await rm(dropIn.file, { force: true });
				await ignore(rmdir(dropIn.directory));
				await at.system(TOOLS.systemctl, ["daemon-reload"]);
			}
		}
		await locked(at, machineLock(at), "CODING_GUEST_MACHINE_BUSY", async () => {
			const networks = join(at.runtimeRoot, "networks");
			const index = await heldNetwork(networks, session.worker);
			await ignore(at.system(TOOLS.ip, ["netns", "delete", session.namespace]));
			if (index === undefined) return;
			await ignore(at.system(TOOLS.ip, ["link", "delete", `qgh${index}`]));
			await rm(join(networks, `${index}.ready`), { force: true });
			await rm(join(networks, String(index)), { force: true });
		});
		// Never recursive: whatever is still in the mountpoint is not the folder's to remove.
		try {
			await rmdir(session.mountpoint);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOTEMPTY" || code === "EEXIST") throw new Error("CODING_GUEST_MOUNTPOINT_NOT_EMPTY");
			if (code !== "ENOENT") throw error;
		}
		await rm(session.view, { force: true });
		await rm(session.folderState, { recursive: true, force: true });
		const inputs = join(at.runtimeRoot, "inputs");
		for (const name of (await missing(() => readdir(inputs))) ?? [])
			if (name.startsWith(`${session.worker}-`)) await rm(join(inputs, name), { force: true });
		// Nothing of the session runs any more, so nothing moves in its output folders while they go.
		await rm(session.session, { recursive: true, force: true });
	});
	return Object.freeze({ schema: "qorpera.coding-guest-session-stopped/v1", workerId: request.workerId });
}

/** The relay's output ring: files named by their first byte's offset, each at most segmentBytes, the newest
 * `segments` kept. Written synchronously in arrival order; a failed write breaks it. */
function ringWriter(output: string, ring: { segmentBytes: number; segments: number }, onBroken: () => void) {
	const kept: number[] = [];
	let fd = -1;
	let written = 0;
	let end = 0;
	let broken = false;
	const name = (start: number) => join(output, `${String(start).padStart(16, "0")}.out`);
	const rotate = () => {
		if (fd >= 0) closeSync(fd);
		fd = -1;
		fd = openSync(name(end), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		written = 0;
		kept.push(end);
		while (kept.length > ring.segments) unlinkSync(name(kept.shift() as number));
	};
	return {
		write(chunk: Buffer): void {
			if (broken) return;
			try {
				for (let at = 0; at < chunk.length; ) {
					if (fd < 0 || written >= ring.segmentBytes) rotate();
					const wrote = writeSync(fd, chunk, at, Math.min(ring.segmentBytes - written, chunk.length - at));
					written += wrote;
					end += wrote;
					at += wrote;
				}
			} catch {
				broken = true;
				onBroken();
			}
		},
		close(): void {
			if (fd >= 0) closeSync(fd);
			fd = -1;
		},
		get broken(): boolean {
			return broken;
		},
	};
}

/** `relay <worker32> <command32>`, inside the command's unit as the session's user: reads the run request systemd
 * handed it as stdin, runs bash with exactly its environment, keeps both output streams in the ring and how bash
 * ended in exit.json. Stopped by systemd (cancel or deadline), it leaves no exit record. */
export async function relayCodingGuestCommand(
	argv: readonly string[],
	input: Readable,
	ports: CodingGuestAgentPorts = {},
): Promise<number> {
	const at = settle(ports);
	let checked: { request: CodingGuestRunRequest; command: CommandPlaces };
	try {
		const [worker, commandName, ...rest] = argv;
		if (rest.length > 0 || !COMPACT.test(worker ?? "") || !COMPACT.test(commandName ?? ""))
			throw new Error("CODING_GUEST_ARGUMENTS_INVALID");
		// The agent wrote it from a request of at most maxInputBytes; its own encoding may be longer.
		const request = await readRequest("run", input, 2 * CODING_GUEST.maxInputBytes);
		const session = places(at, request.workerId);
		const command = commandPlaces(at, session, request.commandId);
		if (session.worker !== worker || command.command !== commandName) throw new Error("CODING_GUEST_REQUEST_INVALID");
		if (request.uid !== at.processUid()) throw new Error("CODING_GUEST_RELAY_USER_INVALID");
		// The agent made it and gave it to this user; the relay has no right the user lacks, so its owner is not checked.
		if (!(await lstat(command.output)).isDirectory()) throw new Error("CODING_GUEST_OUTPUT_INVALID");
		// Cancelled before its unit started: nothing runs.
		if (await exists(command.cancel)) return 0;
		checked = { request, command };
	} catch (error) {
		process.stderr.write(`CODING_GUEST_RELAY_REFUSED ${codingErrorCode(error)}\n`);
		return RELAY_REFUSED;
	}
	const { request, command } = checked;
	const exitRecord = join(command.output, "exit.json");
	return new Promise<number>((done) => {
		let stopping = false;
		let finished = false;
		const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", request.command], {
			cwd: request.cwd,
			env: { ...request.environment },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const ring = ringWriter(command.output, at.ring, () => child.kill("SIGKILL"));
		const unsubscribe = at.onTerminate(() => {
			stopping = true;
		});
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (finished) return;
			finished = true;
			unsubscribe();
			ring.close();
			if (ring.broken) return done(RELAY_REFUSED);
			if (stopping) return done(143);
			writeJson(exitRecord, { code, signal }).then(
				() => done(code ?? 128 + (signal ? osConstants.signals[signal] : 0)),
				() => done(RELAY_REFUSED),
			);
		};
		child.stdout.on("data", (chunk: Buffer) => ring.write(chunk));
		child.stderr.on("data", (chunk: Buffer) => ring.write(chunk));
		child.once("error", (error: NodeJS.ErrnoException) => {
			const code = typeof error.code === "string" && /^E[A-Z0-9]{1,30}$/.test(error.code) ? error.code : "UNKNOWN";
			ring.write(Buffer.from(`qorpera: the command did not start (${code})\n`));
			finish(127, null);
		});
		child.once("close", finish);
	});
}

async function readInput(input: Readable, maxBytes: number, timeoutMs: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	const timer = setTimeout(() => input.destroy(new Error("CODING_GUEST_REQUEST_INVALID")), timeoutMs);
	try {
		for await (const chunk of input) {
			size += (chunk as Buffer).length;
			if (size > maxBytes) throw new Error("CODING_GUEST_REQUEST_INVALID");
			chunks.push(Buffer.from(chunk as Buffer));
		}
	} finally {
		clearTimeout(timer);
	}
	return Buffer.concat(chunks);
}
/** Never says what was wrong with the request: a pass or a secret may be in it. */
async function readRequest<V extends CodingGuestVerb>(
	verb: V,
	input: Readable,
	maxBytes: number = CODING_GUEST.maxInputBytes,
): Promise<CodingGuestRequests[V]> {
	try {
		return parseCodingGuestRequest(verb, JSON.parse((await readInput(input, maxBytes, 15000)).toString("utf8")));
	} catch {
		throw new Error("CODING_GUEST_REQUEST_INVALID");
	}
}

/** The agent's entry: one verb, its request on stdin, one answer line on stdout (`output` adds its bytes). Exits 0
 * with a refusal line when the verb refused. */
export async function runCodingGuestAgent(
	argv: readonly string[],
	input: Readable,
	output: Writable,
	ports: CodingGuestAgentPorts = {},
): Promise<number> {
	const [verb, ...rest] = argv;
	if (verb === "relay") return relayCodingGuestCommand(rest, input, ports);
	let line: unknown;
	let bytes: Buffer = Buffer.alloc(0);
	try {
		if (!CODING_GUEST_VERBS.includes(verb as CodingGuestVerb) || rest.length > 0)
			throw new Error("CODING_GUEST_ARGUMENTS_INVALID");
		requireRoot(settle(ports));
		if (verb === "mount") line = await mountCodingGuestSession(await readRequest("mount", input), ports);
		else if (verb === "run") line = await runCodingGuestCommand(await readRequest("run", input), ports);
		else if (verb === "output") {
			const read = await readCodingGuestOutput(await readRequest("output", input), ports);
			line = read.answer;
			bytes = read.bytes;
		} else if (verb === "cancel") line = await cancelCodingGuestCommand(await readRequest("cancel", input), ports);
		else if (verb === "quiesce") line = await quiesceCodingGuestSession(await readRequest("quiesce", input), ports);
		else if (verb === "stop-session")
			line = await stopCodingGuestSession(await readRequest("stop-session", input), ports);
		else line = await readCodingGuestStatus(await readRequest("status", input), ports);
	} catch (error) {
		line = { schema: "qorpera.coding-guest-refusal/v1", code: codingErrorCode(error) };
		bytes = Buffer.alloc(0);
	}
	const answer = Buffer.concat([Buffer.from(`${JSON.stringify(line)}\n`), bytes]);
	await new Promise<void>((done, fail) => output.write(answer, (error) => (error ? fail(error) : done())));
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCodingGuestAgent(process.argv.slice(2), process.stdin, process.stdout).then(
		(code) => {
			process.exitCode = code;
		},
		() => {
			process.stderr.write("CODING_GUEST_REFUSED\n");
			process.exitCode = 1;
		},
	);
}
