import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_FOLDER_MOUNTPOINT_MODE,
	COMPANY_COMPUTER_FOLDER_PROGRAM,
	CompanyComputerFolderHelper,
	type CompanyComputerFolderHelperOptions,
	type CompanyComputerFolderHelperSystem,
	type CompanyComputerFolderUnitState,
	companyComputerFolderBoundaryAnswer,
	companyComputerFolderProgram,
	companyComputerFolderUnit,
	createCompanyComputerFolderHelperServer,
	isCompanyComputerCommandNamespace,
	parseCompanyComputerFolderCommandReport,
	parseCompanyComputerMountinfo,
} from "@qorpera/runtime/cloud-company-computer-folder-helper";
import {
	askCompanyComputerFolderHelper,
	COMPANY_COMPUTER_FOLDER_HELPER_SOCKET,
	COMPANY_COMPUTER_FOLDER_RUN_CHUNK_BYTES,
	COMPANY_COMPUTER_FOLDER_RUN_LINE_BYTES,
	type CompanyComputerFolderRequest,
	type CompanyComputerFolderRunEvent,
	companyComputerFolderName,
	companyComputerFolderPaths,
	parseCompanyComputerFolderAnswer,
	parseCompanyComputerFolderRequest,
	parseCompanyComputerFolderRunEvent,
	parseCompanyComputerFolderRunInput,
	startCompanyComputerFolderRun,
} from "@qorpera/runtime/cloud-company-computer-folder-helper-client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The helper against a machine of its own (units, mounts, the folder program); the real mounts, units and program run
// in the office image's proof.
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

const DESKTOP = companyComputerFolderName("desktop", "11111111-2222-4333-8444-555555555555");
const COMMAND = companyComputerFolderName("command", "66666666-7777-4888-9999-aaaaaaaaaaaa");
const VIEW = { environmentId: "env-1", viewId: "view-1", pass: "pass-secret-1" };
const NEWER = { environmentId: "env-1", viewId: "view-2", pass: "pass-secret-2" };
const PROOF = "qorpera.folder-view-proof/v1";

const ACTIVE: CompanyComputerFolderUnitState = {
	active: "active",
	result: "success",
	execMainCode: 0,
	execMainStatus: 0,
};
const INACTIVE: CompanyComputerFolderUnitState = {
	active: "inactive",
	result: "success",
	execMainCode: 0,
	execMainStatus: 0,
};
const CLOSED: CompanyComputerFolderUnitState = {
	active: "failed",
	result: "exit-code",
	execMainCode: 1,
	execMainStatus: 3,
};
const CRASHED: CompanyComputerFolderUnitState = {
	active: "failed",
	result: "signal",
	execMainCode: 2,
	execMainStatus: 9,
};

function report(paths: Array<Record<string, unknown>> = [{ path: "notes.md", outcome: "saved" }], extra = {}) {
	return { commitId: "c1", seq: 4, paths, ...extra };
}
const printed = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);

/** systemd, the mount table and the folder program as the helper sees them. */
class FakeSystem implements CompanyComputerFolderHelperSystem {
	readonly calls: string[] = [];
	readonly units = new Map<string, CompanyComputerFolderUnitState>();
	readonly entries: string[] = [];
	readonly publishes: Array<{ args: readonly string[]; timeoutMs: number }> = [];
	/** What a started program does: mounts once the node takes its view, exits 3, or never mounts. */
	program: "mounts" | "closes" | "hangs" = "mounts";
	/** A running program records each newer view it says hello with (its state folder's view.json). */
	follows = true;
	/** The unit's ExecStopPost takes away a mount its program left. */
	stopPost = true;
	shares = true;
	detaches = true;
	published: { code: number | null; stdout: Buffer | undefined } = { code: 0, stdout: printed(report()) };
	/** The stand-in for `qorpera-folder command` (LAUNCHER), and the arguments of each launch. */
	launcher = "";
	readonly launches: string[][] = [];
	#id = 100;
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	#paths(unit: string) {
		const name = /^qorpera-office-folder-mount@(.+)\.service$/.exec(unit)?.[1];
		return companyComputerFolderPaths(name ?? "", this.root);
	}
	#mount(path: string, optional: string, fstype: string, source: string) {
		const id = this.#id++;
		this.entries.push(
			`${id} 1 0:${id} / ${path} rw,relatime${optional ? ` ${optional}` : ""} - ${fstype} ${source} rw`,
		);
	}
	#unmount(path: string) {
		for (let index = this.entries.length - 1; index >= 0; index--)
			if (this.entries[index]?.split(" ")[4] === path) {
				this.entries.splice(index, 1);
				return;
			}
	}
	async #prove(unit: string) {
		const paths = this.#paths(unit);
		const view = JSON.parse(await readFile(paths.view, "utf8"));
		await writeFile(join(paths.state, "view.json"), JSON.stringify({ schema: PROOF, view }));
	}
	async inspect(unit: string) {
		const state = this.units.get(unit) ?? INACTIVE;
		if (state.active === "active" && this.follows) await this.#prove(unit);
		return state;
	}
	async start(unit: string) {
		this.calls.push(`start ${unit}`);
		if (this.program === "closes") return void this.units.set(unit, CLOSED);
		this.units.set(unit, ACTIVE);
		if (this.program === "hangs") return;
		this.#mount(this.#paths(unit).mountpoint, "", "fuse.qorpera", "qorpera-company");
		await this.#prove(unit);
	}
	async stop(unit: string) {
		this.calls.push(`stop ${unit}`);
		if (this.units.get(unit)?.active === "active") this.units.set(unit, INACTIVE);
		const mountpoint = this.#paths(unit).mountpoint;
		if (
			this.stopPost &&
			this.entries.some((line) => line.includes(" fuse.qorpera ") && line.split(" ")[4] === mountpoint)
		)
			this.#unmount(mountpoint);
	}
	async resetFailed(unit: string) {
		this.calls.push(`reset-failed ${unit}`);
		if (this.units.get(unit)?.active === "failed") this.units.set(unit, INACTIVE);
	}
	async mountinfo() {
		return `${["22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw", ...this.entries].join("\n")}\n`;
	}
	async share(path: string) {
		this.calls.push(`share ${path}`);
		this.#mount(path, this.shares ? `shared:${this.#id}` : "", "tmpfs", "tmpfs");
	}
	async detach(path: string) {
		this.calls.push(`detach ${path}`);
		if (!this.detaches) throw new Error("COMPANY_COMPUTER_FOLDER_COMMAND_FAILED");
		this.#unmount(path);
	}
	async publish(args: readonly string[], timeoutMs: number) {
		this.publishes.push({ args, timeoutMs });
		return this.published;
	}
	launch(args: readonly string[]) {
		this.launches.push([...args]);
		return spawn(process.execPath, [this.launcher, ...args], { cwd: "/", stdio: ["pipe", "pipe", "pipe", "pipe"] });
	}
	/** The stand-in reports the command's process group as its mount namespace. */
	async namespaceInUse(mntns: number) {
		try {
			process.kill(-mntns, 0);
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * `qorpera-folder command` as the helper sees it: the command on its stdin, stdout and stderr, its reports on fd 3,
 * and SIGTERM stops the command's process group. Some shell pids stand for a launcher that goes wrong: one that
 * reports its failure, one that reports garbage, one that never reports and one that exits without a report.
 */
const LAUNCHER = `
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
const args = process.argv.slice(2);
const split = args.indexOf("--");
const shell = Number(args[args.indexOf("--shell-pid") + 1]);
const reports = createWriteStream(null, { fd: 3 });
const report = (value) => reports.write(JSON.stringify(value) + "\\n");
if (shell === 4000001) {
	report({ t: "failed", error: "the shell is not the office account's" });
	reports.end(() => process.exit(1));
} else if (shell === 4000002) {
	reports.write("not a report\\n");
	setInterval(() => undefined, 1000);
} else if (shell === 4000003) setInterval(() => undefined, 1000);
else if (shell === 4000004) reports.end(() => process.exit(1));
else {
	// The command must not hold the reports.
	const child = spawn("/bin/sh", ["-c", 'exec 3>&- "$0" "$@"', ...args.slice(split + 1)], { detached: true, stdio: "inherit" });
	child.on("spawn", () => report({ t: "started", pid: child.pid, mntns: child.pid }));
	child.on("exit", (code, signal) => {
		report({ t: "exit", code, signal });
		reports.end(() => process.exit(0));
	});
	process.on("SIGTERM", () => {
		const signal = (name) => {
			try {
				process.kill(-child.pid, name);
			} catch {}
		};
		signal("SIGTERM");
		setTimeout(() => signal("SIGKILL"), 2000).unref();
	});
}
`;

async function setup(options: CompanyComputerFolderHelperOptions = {}) {
	const base = await mkdtemp(join(await realpath(tmpdir()), "fh-"));
	cleanups.push(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "folder");
	const system = new FakeSystem(root);
	const logs: string[] = [];
	const helper = new CompanyComputerFolderHelper(system, {
		root,
		mountMs: 300,
		switchMs: 300,
		settleMs: 100,
		pollMs: 5,
		log: (line) => logs.push(line),
		...options,
	});
	await helper.prepare();
	return { base, root, system, helper, logs, paths: (name: string) => companyComputerFolderPaths(name, root) };
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;
const gone = async (path: string) =>
	lstat(path).then(
		() => false,
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
type Boundary = Extract<CompanyComputerFolderRequest, { op: "boundary" | "unmount" }>;
const boundary = (name: string, final = false): Boundary => ({
	op: "boundary",
	name,
	final,
	timeoutMs: 30000,
});
const unmount = (name: string, final = false): Boundary => ({
	op: "unmount",
	name,
	final,
	timeoutMs: 30000,
});

describe("the folder helper's mounts", () => {
	it("prepares root's folders and refuses a root that is not a directory of its own", async () => {
		const { base, root } = await setup();
		expect(await mode(root)).toBe(0o755);
		expect(await mode(join(root, "views"))).toBe(0o700);
		expect(await mode(join(root, "state"))).toBe(0o700);
		expect(await mode(join(root, "mounts"))).toBe(0o755);
		// A view a stopped helper wrote but never gave a name goes.
		await writeFile(join(root, "views", `.${DESKTOP}.next`), "{}");
		await new CompanyComputerFolderHelper(new FakeSystem(root), { root }).prepare();
		expect(await gone(join(root, "views", `.${DESKTOP}.next`))).toBe(true);
		await mkdir(join(base, "elsewhere"));
		await symlink(join(base, "elsewhere"), join(base, "linked"));
		await expect(
			new CompanyComputerFolderHelper(new FakeSystem(join(base, "linked")), {
				root: join(base, "linked"),
			}).prepare(),
		).rejects.toThrow("COMPANY_COMPUTER_FOLDER_ROOT_UNCONFIRMED");
	});

	it("mounts a view in an empty state folder, under a shared parent, and holds the name", async () => {
		const { helper, system, paths, logs } = await setup();
		const at = paths(DESKTOP);
		// What a mount of the same name left before the helper stopped.
		await mkdir(at.state, { recursive: true });
		await writeFile(join(at.state, "reads.log"), "old");
		expect(await helper.answer({ op: "mount", name: DESKTOP, view: VIEW })).toEqual({ answer: "mounted" });
		expect(JSON.parse(await readFile(at.view, "utf8"))).toEqual(VIEW);
		expect(await mode(at.view)).toBe(0o600);
		expect(await mode(at.state)).toBe(0o700);
		expect(await gone(join(at.state, "reads.log"))).toBe(true);
		expect(await mode(at.parent)).toBe(0o755);
		expect(await mode(at.mountpoint)).toBe(COMPANY_COMPUTER_FOLDER_MOUNTPOINT_MODE);
		const unit = companyComputerFolderUnit(DESKTOP);
		expect(unit).toBe(`qorpera-office-folder-mount@${DESKTOP}.service`);
		expect(system.calls).toEqual([`stop ${unit}`, `share ${at.parent}`, `start ${unit}`]);
		expect(await helper.answer({ op: "mount", name: DESKTOP, view: NEWER })).toEqual({ answer: "held" });
		expect(JSON.parse(await readFile(at.view, "utf8"))).toEqual(VIEW);
		expect(await helper.answer({ op: "list" })).toEqual({
			answer: "list",
			mounts: [{ name: DESKTOP, viewId: "view-1", program: "running" }],
		});
		expect(logs.join("\n")).not.toContain(VIEW.pass);
	});

	it("gives the name back when the node closes the view, no mount comes, or the parent is not shared", async () => {
		const { helper, system, paths } = await setup();
		const at = paths(COMMAND),
			unit = companyComputerFolderUnit(COMMAND);
		const clean = async () => {
			for (const path of [at.view, at.state, at.parent]) expect(await gone(path)).toBe(true);
			expect(system.entries).toEqual([]);
			expect(await helper.answer({ op: "list" })).toEqual({ answer: "list", mounts: [] });
		};
		system.program = "closes";
		expect(await helper.answer({ op: "mount", name: COMMAND, view: VIEW })).toEqual({ answer: "closed" });
		expect(system.calls.slice(-3)).toEqual([`stop ${unit}`, `reset-failed ${unit}`, `detach ${at.parent}`]);
		await clean();
		system.program = "hangs";
		expect(await helper.answer({ op: "mount", name: COMMAND, view: VIEW })).toEqual({ answer: "unanswered" });
		expect(system.calls.slice(-3)).toEqual([`start ${unit}`, `stop ${unit}`, `detach ${at.parent}`]);
		await clean();
		system.program = "mounts";
		system.shares = false;
		expect(await helper.answer({ op: "mount", name: COMMAND, view: VIEW })).toEqual({ answer: "failed" });
		expect(system.calls.slice(-4)).toEqual([
			`stop ${unit}`,
			`share ${at.parent}`,
			`stop ${unit}`,
			`detach ${at.parent}`,
		]);
		await clean();
	});

	it("keeps a name whose mount could not be taken away, lists it and drops it later", async () => {
		const { helper, system, paths } = await setup();
		const at = paths(DESKTOP);
		system.program = "hangs";
		system.detaches = false;
		expect(await helper.answer({ op: "mount", name: DESKTOP, view: VIEW })).toEqual({ answer: "failed" });
		expect(await gone(at.view)).toBe(false);
		expect(await helper.answer({ op: "list" })).toEqual({
			answer: "list",
			mounts: [{ name: DESKTOP, viewId: "view-1", program: "stopped" }],
		});
		expect(await helper.answer({ op: "drop", name: DESKTOP })).toEqual({ answer: "failed" });
		system.detaches = true;
		expect(await helper.answer({ op: "drop", name: DESKTOP })).toEqual({ answer: "dropped" });
		for (const path of [at.view, at.state, at.parent]) expect(await gone(path)).toBe(true);
		expect(await helper.answer({ op: "drop", name: DESKTOP })).toEqual({ answer: "unknown" });
	});

	it("runs one name's requests one after another", async () => {
		const { helper, system } = await setup();
		const [mounted, unmounted] = await Promise.all([
			helper.answer({ op: "mount", name: COMMAND, view: VIEW }),
			helper.answer(unmount(COMMAND, true)),
		]);
		expect(mounted).toEqual({ answer: "mounted" });
		expect(unmounted).toEqual({ answer: "saved", report: report(), unmounted: true });
		expect(system.publishes).toHaveLength(1);
	});
});

describe("the folder helper's boundaries", () => {
	it("publishes the mount's own state, and answers from the program's exit code and report", async () => {
		const { helper, system, paths } = await setup();
		const at = paths(COMMAND);
		expect(await helper.answer(boundary(COMMAND))).toEqual({ answer: "unknown" });
		expect(system.publishes).toEqual([]);
		await helper.answer({ op: "mount", name: COMMAND, view: VIEW });
		expect(await helper.answer({ ...boundary(COMMAND), timeoutMs: 45000 })).toEqual({
			answer: "saved",
			report: report(),
		});
		expect(await helper.answer(boundary(COMMAND, true))).toEqual({ answer: "saved", report: report() });
		expect(system.publishes).toEqual([
			{ args: ["publish", "--view-file", at.view, "--state-dir", at.state, "--json"], timeoutMs: 45000 },
			{ args: ["publish", "--view-file", at.view, "--state-dir", at.state, "--final", "--json"], timeoutMs: 30000 },
		]);
		const refused = report([{ path: "notes.md", outcome: "conflict", receipt: "r1", kept: true }]);
		system.published = { code: 4, stdout: printed(refused) };
		expect(await helper.answer(boundary(COMMAND))).toEqual({ answer: "refused", report: refused });
		system.published = { code: 3, stdout: Buffer.alloc(0) };
		expect(await helper.answer(boundary(COMMAND))).toEqual({ answer: "closed" });
		// After exit 3 the view is closed: answered at once, without the node.
		system.units.set(companyComputerFolderUnit(COMMAND), CLOSED);
		expect(await helper.answer(boundary(COMMAND))).toEqual({ answer: "closed" });
		expect(system.publishes).toHaveLength(4);
		// Any other exit: the publish still runs from the state folder.
		system.units.set(companyComputerFolderUnit(COMMAND), CRASHED);
		system.published = { code: 0, stdout: printed(report()) };
		expect(await helper.answer(boundary(COMMAND))).toEqual({ answer: "saved", report: report() });
		expect(system.publishes).toHaveLength(5);
	});

	it("is unanswered without an exit code, a report or a report that agrees with the code", () => {
		const saved = report(),
			conflict = report([{ path: "a", outcome: "conflict" }]),
			unproven = { commitId: null, seq: null, paths: [], refused: "unproven" };
		expect(companyComputerFolderBoundaryAnswer(0, printed(saved))).toEqual({ answer: "saved", report: saved });
		expect(companyComputerFolderBoundaryAnswer(0, printed({ ...saved, closed: true }))).toEqual({
			answer: "saved",
			report: { ...saved, closed: true },
		});
		expect(companyComputerFolderBoundaryAnswer(4, printed(unproven))).toEqual({
			answer: "refused",
			report: unproven,
		});
		expect(companyComputerFolderBoundaryAnswer(3, undefined)).toEqual({ answer: "closed" });
		expect(companyComputerFolderBoundaryAnswer(0, printed(conflict))).toEqual({
			answer: "unanswered",
			report: conflict,
		});
		expect(companyComputerFolderBoundaryAnswer(4, printed(saved))).toEqual({ answer: "unanswered", report: saved });
		expect(companyComputerFolderBoundaryAnswer(1, printed(saved))).toEqual({ answer: "unanswered", report: saved });
		for (const stdout of [
			undefined,
			Buffer.alloc(0),
			Buffer.from("saved\n"),
			Buffer.from(`${JSON.stringify(saved)}\n${JSON.stringify(saved)}\n`),
			printed({ ...saved, extra: 1 }),
			printed({ paths: [] }),
			Buffer.from([0xff, 0x0a]),
		]) {
			expect(companyComputerFolderBoundaryAnswer(0, stdout)).toEqual({ answer: "unanswered" });
			expect(companyComputerFolderBoundaryAnswer(1, stdout)).toEqual({ answer: "unanswered" });
		}
		expect(companyComputerFolderBoundaryAnswer(null, printed(saved))).toEqual({
			answer: "unanswered",
			report: saved,
		});
	});

	it("unmounts only after a boundary that ends the mount", async () => {
		const { helper, system, paths } = await setup();
		const at = paths(COMMAND);
		await helper.answer({ op: "mount", name: COMMAND, view: VIEW });
		const refused = report([{ path: "a", outcome: "refused", reason: "denied" }]);
		system.published = { code: 4, stdout: printed(refused) };
		expect(await helper.answer(unmount(COMMAND, true))).toEqual({
			answer: "refused",
			report: refused,
			unmounted: false,
		});
		system.published = { code: 1, stdout: undefined };
		expect(await helper.answer(unmount(COMMAND, true))).toEqual({ answer: "unanswered", unmounted: false });
		expect(await gone(at.view)).toBe(false);
		expect(system.entries).toHaveLength(2);
		system.published = { code: 0, stdout: printed(report()) };
		expect(await helper.answer(unmount(COMMAND, true))).toEqual({
			answer: "saved",
			report: report(),
			unmounted: true,
		});
		for (const path of [at.view, at.state, at.parent]) expect(await gone(path)).toBe(true);
		expect(system.entries).toEqual([]);
		expect(await helper.answer(unmount(COMMAND))).toEqual({ answer: "unknown" });
		// A program that exited 3: closed at once, then taken away.
		await helper.answer({ op: "mount", name: DESKTOP, view: VIEW });
		system.units.set(companyComputerFolderUnit(DESKTOP), CLOSED);
		expect(await helper.answer(unmount(DESKTOP))).toEqual({ answer: "closed", unmounted: true });
		const unit = companyComputerFolderUnit(DESKTOP);
		expect(system.calls.slice(-3)).toEqual([
			`stop ${unit}`,
			`reset-failed ${unit}`,
			`detach ${paths(DESKTOP).parent}`,
		]);
		expect(system.publishes).toHaveLength(3);
		expect(await gone(paths(DESKTOP).view)).toBe(true);
	});
});

describe("moving a desktop's mount to a newer view", () => {
	it("switches once the program has said hello with the newer view", async () => {
		const { helper, paths } = await setup();
		const at = paths(DESKTOP);
		await helper.answer({ op: "mount", name: DESKTOP, view: VIEW });
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: NEWER })).toEqual({ answer: "switched" });
		expect(JSON.parse(await readFile(at.view, "utf8"))).toEqual(NEWER);
		expect(JSON.parse(await readFile(join(at.state, "view.json"), "utf8")).view).toEqual(NEWER);
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: NEWER })).toEqual({ answer: "switched" });
	});

	it("refuses another company, another pass for the same view, and a command, and leaves the view file", async () => {
		const { helper, paths } = await setup();
		await helper.answer({ op: "mount", name: DESKTOP, view: VIEW });
		await helper.answer({ op: "mount", name: COMMAND, view: VIEW });
		for (const view of [
			{ ...NEWER, environmentId: "env-2" },
			{ ...VIEW, pass: "another-pass" },
		])
			expect(await helper.answer({ op: "switch", name: DESKTOP, view })).toEqual({ answer: "refused" });
		expect(await helper.answer({ op: "switch", name: COMMAND, view: NEWER })).toEqual({ answer: "refused" });
		for (const name of [DESKTOP, COMMAND]) expect(JSON.parse(await readFile(paths(name).view, "utf8"))).toEqual(VIEW);
		const other = companyComputerFolderName("desktop", "bbbbbbbb-2222-4333-8444-555555555555");
		expect(await helper.answer({ op: "switch", name: other, view: NEWER })).toEqual({ answer: "unknown" });
	});

	it("is pending until the program takes the view, closed after exit 3, and failed on a malformed record", async () => {
		const { helper, system, paths } = await setup();
		const at = paths(DESKTOP);
		await helper.answer({ op: "mount", name: DESKTOP, view: VIEW });
		system.follows = false;
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: NEWER })).toEqual({ answer: "pending" });
		expect(JSON.parse(await readFile(at.view, "utf8"))).toEqual(NEWER);
		// The view the program accepted still refuses another pass for itself, though the file holds the newer view.
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: { ...VIEW, pass: "another-pass" } })).toEqual({
			answer: "refused",
		});
		system.units.set(companyComputerFolderUnit(DESKTOP), CLOSED);
		const third = { ...NEWER, viewId: "view-3" };
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: third })).toEqual({ answer: "closed" });
		expect(JSON.parse(await readFile(at.view, "utf8"))).toEqual(NEWER);
		system.units.set(companyComputerFolderUnit(DESKTOP), ACTIVE);
		await writeFile(join(at.state, "view.json"), JSON.stringify({ schema: PROOF, view: VIEW, extra: 1 }));
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: third })).toEqual({ answer: "failed" });
	});

	it("leaves the mount movable when its program is killed before it takes the newer view", async () => {
		const { helper, system, paths } = await setup();
		const at = paths(DESKTOP),
			unit = companyComputerFolderUnit(DESKTOP);
		await helper.answer({ op: "mount", name: DESKTOP, view: VIEW });
		system.follows = false;
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: NEWER })).toEqual({ answer: "pending" });
		// Killed before its hello: systemd starts it again, and the restarted program reads the view file.
		system.units.set(unit, { ...ACTIVE, active: "activating" });
		const third = { ...NEWER, viewId: "view-3", pass: "pass-secret-3" };
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: third })).toEqual({ answer: "pending" });
		system.units.set(unit, ACTIVE);
		system.follows = true;
		expect(await helper.answer({ op: "switch", name: DESKTOP, view: third })).toEqual({ answer: "switched" });
		expect(JSON.parse(await readFile(at.view, "utf8"))).toEqual(third);
		expect(JSON.parse(await readFile(join(at.state, "view.json"), "utf8")).view).toEqual(third);
	});
});

describe("the folder helper's socket", () => {
	async function serve() {
		const context = await setup();
		const server: Server = createCompanyComputerFolderHelperServer(context.helper);
		const socket = join(context.base, "helper.sock");
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		cleanups.push(() => new Promise((resolve) => server.close(resolve)));
		return { ...context, socket };
	}
	function raw(socket: string, bytes: string | Buffer): Promise<string> {
		return new Promise((resolve, reject) => {
			const connection = createConnection(socket);
			let text = "";
			connection.setEncoding("utf8");
			connection.on("data", (chunk: string) => {
				text += chunk;
			});
			connection.on("end", () => resolve(text));
			connection.on("error", reject);
			connection.write(bytes);
		});
	}

	it("answers each request line, and invalid for anything else", async () => {
		const { socket } = await serve();
		expect(await askCompanyComputerFolderHelper({ op: "mount", name: DESKTOP, view: VIEW }, { socket })).toEqual({
			answer: "mounted",
		});
		expect(await askCompanyComputerFolderHelper(boundary(DESKTOP), { socket })).toEqual({
			answer: "saved",
			report: report(),
		});
		expect(await askCompanyComputerFolderHelper({ op: "list" }, { socket })).toEqual({
			answer: "list",
			mounts: [{ name: DESKTOP, viewId: "view-1", program: "running" }],
		});
		for (const line of [
			"not json",
			JSON.stringify({ op: "list", extra: 1 }),
			JSON.stringify({ ...boundary(DESKTOP), final: true }),
			JSON.stringify({ op: "mount", name: DESKTOP, view: { ...VIEW, pass: "has space" } }),
			JSON.stringify({ op: "drop", name: "desktop-1" }),
		])
			expect(await raw(socket, `${line}\n`)).toBe('{"answer":"invalid"}\n');
		// A run's request may be as long as a run's line; any other only as long as a request line.
		expect(await raw(socket, "x".repeat(COMPANY_COMPUTER_FOLDER_RUN_LINE_BYTES))).toBe('{"answer":"invalid"}\n');
		expect(await raw(socket, `{"op":"list"${" ".repeat(5000)}}\n`)).toBe('{"answer":"invalid"}\n');
		expect(await raw(socket, `{"op":"list"${" ".repeat(4000)}}\n`)).toMatch(/^\{"answer":"list",/);
		expect(await raw(socket, Buffer.from([0xff, 0x0a]))).toBe('{"answer":"invalid"}\n');
		// A run has a connection of its own.
		expect(
			await askCompanyComputerFolderHelper(
				{ op: "run", name: COMMAND, shellPid: 4242, network: true, command: "true" } as never,
				{ socket },
			),
		).toBe(undefined);
	});

	it("is no answer without a helper, and never asks with a malformed request", async () => {
		const { base } = await setup();
		expect(await askCompanyComputerFolderHelper({ op: "list" }, { socket: join(base, "absent.sock") })).toBe(
			undefined,
		);
		expect(
			await askCompanyComputerFolderHelper(
				{ ...boundary(DESKTOP), final: true },
				{ socket: join(base, "absent.sock") },
			),
		).toBe(undefined);
		expect(COMPANY_COMPUTER_FOLDER_HELPER_SOCKET).toBe("/run/qorpera-folder-helper/helper.sock");
	});

	it("takes only the answers each request may get", () => {
		expect(parseCompanyComputerFolderAnswer("mount", '{"answer":"mounted"}')).toEqual({ answer: "mounted" });
		expect(parseCompanyComputerFolderAnswer("mount", '{"answer":"invalid"}')).toEqual({ answer: "invalid" });
		for (const [op, line] of [
			["mount", '{"answer":"mounted","extra":1}'],
			["mount", '{"answer":"switched"}'],
			["switch", '{"answer":"dropped"}'],
			["boundary", '{"answer":"saved"}'],
			["boundary", '{"answer":"closed","unmounted":true}'],
			["unmount", '{"answer":"closed"}'],
			["unmount", `{"answer":"saved","unmounted":"yes","report":${JSON.stringify(report())}}`],
			["list", `{"answer":"list","mounts":[{"name":"${DESKTOP}","viewId":"v","program":"gone"}]}`],
			["drop", "dropped"],
		] as const)
			expect(parseCompanyComputerFolderAnswer(op, line)).toBe(undefined);
		expect(parseCompanyComputerFolderAnswer("unmount", `{"answer":"unanswered","unmounted":false}`)).toEqual({
			answer: "unanswered",
			unmounted: false,
		});
		expect(parseCompanyComputerFolderRequest(JSON.stringify({ ...boundary(COMMAND), timeoutMs: 999 }))).toBe(
			undefined,
		);
		expect(parseCompanyComputerFolderRequest(JSON.stringify({ ...boundary(COMMAND), timeoutMs: 120001 }))).toBe(
			undefined,
		);
		expect(parseCompanyComputerFolderRequest(JSON.stringify(unmount(COMMAND, true)))).toEqual(unmount(COMMAND, true));
	});
});

describe("the folder helper's runs", () => {
	const SECOND = companyComputerFolderName("command", "66666666-7777-4888-9999-bbbbbbbbbbbb");
	const THIRD = companyComputerFolderName("command", "66666666-7777-4888-9999-cccccccccccc");
	type Run = Extract<CompanyComputerFolderRequest, { op: "run" }>;

	/** The helper on a socket, with the launcher stand-in and these command mounts. */
	async function running(names: readonly string[] = [COMMAND], options: CompanyComputerFolderHelperOptions = {}) {
		const context = await setup({ endedPollMs: 20, ...options });
		context.system.launcher = join(context.base, "launcher.mjs");
		await writeFile(context.system.launcher, LAUNCHER);
		const server: Server = createCompanyComputerFolderHelperServer(context.helper);
		const connections = new Set<Socket>();
		server.on("connection", (connection) => {
			connections.add(connection);
			connection.on("close", () => connections.delete(connection));
		});
		const socket = join(context.base, "helper.sock");
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		// A run still open stops its command.
		cleanups.push(
			() =>
				new Promise((resolve) => {
					for (const connection of connections) connection.destroy();
					server.close(resolve);
				}),
		);
		for (const name of names)
			expect(await context.helper.answer({ op: "mount", name, view: VIEW })).toEqual({ answer: "mounted" });
		const ended = (name: string) => askCompanyComputerFolderHelper({ op: "ended", name }, { socket });
		const record = async (name: string) =>
			JSON.parse(await readFile(join(context.paths(name).state, "command.json"), "utf8"));
		return { ...context, socket, ended, record };
	}
	function start(socket: string, command: string, extra: Partial<Run> = {}) {
		const events: CompanyComputerFolderRunEvent[] = [];
		const run = startCompanyComputerFolderRun(
			{ op: "run", name: COMMAND, shellPid: 4242, network: true, command, ...extra },
			(event) => events.push(event),
			{ socket },
		);
		const output = () =>
			Buffer.concat(
				events.flatMap((event) => (event.t === "out" ? [Buffer.from(event.data, "base64")] : [])),
			).toString();
		return { run, events, output };
	}

	it("starts the command with the launcher, relays its output and exit, and ends once nothing is left", async () => {
		const { socket, system, paths, ended, record } = await running();
		const command = "echo out; echo err >&2; exit 7";
		const { run, events, output } = start(socket, command);
		expect(await run.answer).toEqual({ answer: "started" });
		await run.closed;
		expect(output().split("\n").sort()).toEqual(["", "err", "out"]);
		expect(events.slice(-2)).toEqual([{ t: "exit", code: 7, signal: null }, { t: "ended" }]);
		expect(system.launches).toEqual([
			[
				"command",
				"--shell-pid",
				"4242",
				"--tree",
				paths(COMMAND).parent,
				"--network",
				"yes",
				"--",
				"/usr/bin/bash",
				"--noprofile",
				"--norc",
				"-c",
				command,
			],
		]);
		expect(await record(COMMAND)).toEqual({ mntns: expect.any(Number), ended: true });
		expect(await mode(join(paths(COMMAND).state, "command.json"))).toBe(0o600);
		expect(await ended(COMMAND)).toEqual({ answer: "ended" });
	});

	it("passes the writes to the command's input, those sent before its start too, and its output in chunks", async () => {
		const { socket, system } = await running([COMMAND, SECOND, THIRD]);
		const cat = start(socket, "cat", { network: false });
		cat.run.write(Buffer.from("hello "), false);
		cat.run.write(Buffer.from("there"), true);
		expect(await cat.run.answer).toEqual({ answer: "started" });
		await cat.run.closed;
		expect(cat.output()).toBe("hello there");
		expect(cat.events.slice(-2)).toEqual([{ t: "exit", code: 0, signal: null }, { t: "ended" }]);
		expect(system.launches[0]?.slice(5, 7)).toEqual(["--network", "no"]);
		const count = start(socket, "wc -c", { name: SECOND });
		expect(await count.run.answer).toEqual({ answer: "started" });
		count.run.write(Buffer.alloc(200000, 0x61), true);
		await count.run.closed;
		expect(count.output().trim()).toBe("200000");
		const long = start(socket, "head -c 300000 /dev/zero | tr '\\0' a", { name: THIRD });
		await long.run.closed;
		const chunks = long.events.flatMap((event) => (event.t === "out" ? [Buffer.from(event.data, "base64")] : []));
		expect(chunks.every((chunk) => chunk.length <= COMPANY_COMPUTER_FOLDER_RUN_CHUNK_BYTES)).toBe(true);
		expect(long.output()).toBe("a".repeat(300000));
	});

	it("stops the command's process group, and a stop after its exit does nothing", async () => {
		const { socket } = await running();
		const sleeper = start(socket, "sleep 30");
		expect(await sleeper.run.answer).toEqual({ answer: "started" });
		sleeper.run.stop();
		await sleeper.run.closed;
		expect(sleeper.events).toEqual([{ t: "exit", code: null, signal: "SIGTERM" }, { t: "ended" }]);
		sleeper.run.stop();
	});

	it("ends only once the command's background jobs are gone, and `ended` answers running until then", async () => {
		const { socket, ended, record } = await running();
		const lingering = start(socket, "(sleep 1.5 </dev/null >/dev/null 2>&1 &); echo done");
		expect(await lingering.run.answer).toEqual({ answer: "started" });
		await vi.waitFor(() => expect(lingering.events.some((event) => event.t === "exit")).toBe(true), {
			timeout: 5000,
			interval: 20,
		});
		expect(lingering.output()).toBe("done\n");
		expect(await ended(COMMAND)).toEqual({ answer: "running" });
		expect(await record(COMMAND)).toEqual({ mntns: expect.any(Number), ended: false });
		await lingering.run.closed;
		expect(lingering.events.at(-1)).toEqual({ t: "ended" });
		expect(await ended(COMMAND)).toEqual({ answer: "ended" });
		expect(await record(COMMAND)).toEqual({ mntns: expect.any(Number), ended: true });
	});

	it("runs nothing on a mount that is not there, ran a command already, is closed or is not served", async () => {
		const { socket, system, logs, ended } = await running([COMMAND, SECOND, THIRD]);
		const absent = companyComputerFolderName("command", "66666666-7777-4888-9999-dddddddddddd");
		expect(await start(socket, "true", { name: absent }).run.answer).toEqual({ answer: "unknown" });
		expect(await ended(absent)).toEqual({ answer: "unknown" });
		// Before its command, a mount has no end to answer.
		expect(await ended(COMMAND)).toEqual({ answer: "unknown" });
		await start(socket, "true").run.closed;
		const again = start(socket, "true");
		expect(await again.run.answer).toEqual({ answer: "refused" });
		await again.run.closed;
		expect(again.events).toEqual([]);
		system.units.set(companyComputerFolderUnit(SECOND), CLOSED);
		expect(await start(socket, "true", { name: SECOND }).run.answer).toEqual({ answer: "closed" });
		system.entries.length = 0;
		expect(await start(socket, "true", { name: THIRD }).run.answer).toEqual({ answer: "failed" });
		expect(logs).toContain(`folder-helper: run ${THIRD}: its mount is not served`);
		expect(system.launches).toHaveLength(1);
	});

	it("keeps the claim of a command that did not start, so the mount runs none and never ends", async () => {
		const { socket, logs, ended, record } = await running();
		const failed = start(socket, "true", { shellPid: 4000001 });
		expect(await failed.run.answer).toEqual({ answer: "failed" });
		await failed.run.closed;
		expect(logs).toContain(`folder-helper: run ${COMMAND}: failed: "the shell is not the office account's"`);
		expect(await record(COMMAND)).toEqual({ mntns: null, ended: false });
		expect(await ended(COMMAND)).toEqual({ answer: "unknown" });
		expect(await start(socket, "true").run.answer).toEqual({ answer: "refused" });
	});

	it("fails a launcher that reports garbage, nothing, or nothing in time, and stops it", async () => {
		const { socket, logs, record } = await running([COMMAND, SECOND, THIRD], { launchMs: 300 });
		for (const [name, shellPid] of [
			[COMMAND, 4000002],
			[SECOND, 4000004],
			[THIRD, 4000003],
		] as const) {
			const launch = start(socket, "true", { name, shellPid });
			expect(await launch.run.answer).toEqual({ answer: "failed" });
			await launch.run.closed;
			expect(logs).toContain(`folder-helper: run ${name}: failed: no start report`);
			expect(await record(name)).toEqual({ mntns: null, ended: false });
		}
	});

	it("stops the command when the asker leaves or sends a malformed line, and still answers its end", async () => {
		const { socket, ended, record } = await running([COMMAND, SECOND]);
		const sleeper = start(socket, "sleep 30");
		expect(await sleeper.run.answer).toEqual({ answer: "started" });
		sleeper.run.close();
		await vi.waitFor(async () => expect(await ended(COMMAND)).toEqual({ answer: "ended" }), {
			timeout: 5000,
			interval: 50,
		});
		expect(await record(COMMAND)).toEqual({ mntns: expect.any(Number), ended: true });
		const request: Run = { op: "run", name: SECOND, shellPid: 4242, network: true, command: "sleep 30" };
		const connection = createConnection(socket);
		connection.on("error", () => undefined);
		connection.resume();
		await new Promise((resolve) => {
			connection.on("close", resolve);
			connection.write(`${JSON.stringify(request)}\n{"t":"write","data":"!","end":false}\n`);
		});
		await vi.waitFor(async () => expect(await ended(SECOND)).toEqual({ answer: "ended" }), {
			timeout: 5000,
			interval: 50,
		});
	});

	it("takes only well-formed runs, events, inputs and launcher reports", () => {
		const run: Run = { op: "run", name: COMMAND, shellPid: 4242, network: false, command: "ls -la" };
		expect(parseCompanyComputerFolderRequest(JSON.stringify(run))).toEqual(run);
		expect(parseCompanyComputerFolderRequest(JSON.stringify({ ...run, shellPid: 4194304 }))).toEqual({
			...run,
			shellPid: 4194304,
		});
		for (const bad of [
			{ ...run, command: "ls\0" },
			{ ...run, shellPid: 1 },
			{ ...run, shellPid: 4194305 },
			{ ...run, shellPid: 42.5 },
			{ ...run, name: DESKTOP },
			{ ...run, network: "yes" },
			{ ...run, extra: 1 },
			{ op: "ended", name: DESKTOP },
			{ op: "ended", name: COMMAND, extra: 1 },
		])
			expect(parseCompanyComputerFolderRequest(JSON.stringify(bad))).toBe(undefined);
		expect(parseCompanyComputerFolderRequest(JSON.stringify({ op: "ended", name: COMMAND }))).toEqual({
			op: "ended",
			name: COMMAND,
		});
		expect(parseCompanyComputerFolderAnswer("run", '{"answer":"started"}')).toEqual({ answer: "started" });
		expect(parseCompanyComputerFolderAnswer("run", '{"answer":"held"}')).toBe(undefined);
		expect(parseCompanyComputerFolderAnswer("ended", '{"answer":"running"}')).toEqual({ answer: "running" });
		expect(parseCompanyComputerFolderAnswer("ended", '{"answer":"started"}')).toBe(undefined);

		expect(parseCompanyComputerFolderRunEvent('{"t":"out","data":"aGk="}')).toEqual({ t: "out", data: "aGk=" });
		expect(parseCompanyComputerFolderRunEvent('{"t":"exit","code":null,"signal":"SIG34"}')).toEqual({
			t: "exit",
			code: null,
			signal: "SIG34",
		});
		expect(parseCompanyComputerFolderRunEvent('{"t":"ended"}')).toEqual({ t: "ended" });
		for (const bad of [
			'{"t":"out","data":"not base64!"}',
			`{"t":"out","data":"${"A".repeat(90004)}"}`,
			'{"t":"exit","code":256,"signal":null}',
			'{"t":"exit","code":0,"signal":"TERM"}',
			'{"t":"exit","code":0}',
			'{"t":"ended","extra":1}',
			'{"t":"started"}',
		])
			expect(parseCompanyComputerFolderRunEvent(bad)).toBe(undefined);

		expect(parseCompanyComputerFolderRunInput('{"t":"write","data":"","end":true}')).toEqual({
			t: "write",
			data: "",
			end: true,
		});
		expect(parseCompanyComputerFolderRunInput('{"t":"stop"}')).toEqual({ t: "stop" });
		for (const bad of [
			'{"t":"write","data":"aGk="}',
			'{"t":"write","data":"aGk=","end":"yes"}',
			`{"t":"write","data":"${"A".repeat(90004)}","end":false}`,
			'{"t":"stop","now":true}',
			'["stop"]',
		])
			expect(parseCompanyComputerFolderRunInput(bad)).toBe(undefined);

		expect(parseCompanyComputerFolderCommandReport('{"t":"started","pid":812,"mntns":4026532301}')).toEqual({
			t: "started",
			pid: 812,
			mntns: 4026532301,
		});
		expect(parseCompanyComputerFolderCommandReport('{"t":"exit","code":null,"signal":"SIGKILL"}')).toEqual({
			t: "exit",
			code: null,
			signal: "SIGKILL",
		});
		expect(parseCompanyComputerFolderCommandReport('{"t":"failed","error":"setns: EPERM"}')).toEqual({
			t: "failed",
			error: "setns: EPERM",
		});
		for (const bad of [
			'{"t":"started","pid":0,"mntns":4026532301}',
			'{"t":"started","pid":812,"mntns":"4026532301"}',
			'{"t":"started","pid":812}',
			'{"t":"exit","code":-1,"signal":null}',
			'{"t":"failed","error":1}',
			'{"t":"failed","error":"x","extra":1}',
			"[1]",
			"null",
			"not json",
		])
			expect(parseCompanyComputerFolderCommandReport(bad)).toBe(undefined);
	});

	it("knows a command's mount namespace by the clone of its mount parent, deleted or not", () => {
		const table = (...lines: string[]) =>
			parseCompanyComputerMountinfo(
				`${["1 0 8:1 / / rw - ext4 /dev/sda1 rw", "30 1 0:24 / /run rw shared:5 - tmpfs tmpfs rw", ...lines].join("\n")}\n`,
			);
		const clone = (root: string) => `40 30 0:24 ${root} /run/qorpera-company rw master:9 - tmpfs tmpfs rw`;
		expect(isCompanyComputerCommandNamespace(table(clone(`/qorpera-folder/mounts/${COMMAND}`)), COMMAND)).toBe(true);
		expect(
			isCompanyComputerCommandNamespace(table(clone(`/qorpera-folder/mounts/${COMMAND}//deleted`)), COMMAND),
		).toBe(true);
		expect(isCompanyComputerCommandNamespace(table(clone(`/qorpera-folder/mounts/${SECOND}`)), COMMAND)).toBe(false);
		expect(isCompanyComputerCommandNamespace(table(), COMMAND)).toBe(false);
		// Only the top mount there counts.
		expect(
			isCompanyComputerCommandNamespace(
				table(clone(`/qorpera-folder/mounts/${COMMAND}`), "41 40 0:30 / /run/qorpera-company rw - tmpfs tmpfs rw"),
				COMMAND,
			),
		).toBe(false);
	});
});

describe("the folder helper's machine", () => {
	it("reads the mount table and each program's state", () => {
		expect(
			parseCompanyComputerMountinfo(
				"36 35 0:51 / /run/a\\040b/company rw,nosuid master:1 shared:7 - fuse.qorpera qorpera-company rw\n",
			),
		).toEqual([
			{
				root: "/",
				mountpoint: "/run/a b/company",
				optional: ["master:1", "shared:7"],
				fstype: "fuse.qorpera",
				source: "qorpera-company",
			},
		]);
		expect(() => parseCompanyComputerMountinfo("36 35 0:51 / /run/a rw\n")).toThrow(
			"COMPANY_COMPUTER_FOLDER_MOUNTS_UNCONFIRMED",
		);
		expect(companyComputerFolderProgram(ACTIVE)).toBe("running");
		expect(companyComputerFolderProgram({ ...INACTIVE, active: "activating" })).toBe("restarting");
		expect(companyComputerFolderProgram(CLOSED)).toBe("closed");
		expect(companyComputerFolderProgram(CRASHED)).toBe("stopped");
		expect(companyComputerFolderProgram({ ...CLOSED, execMainStatus: 1 })).toBe("stopped");
		expect(companyComputerFolderProgram(INACTIVE)).toBe("stopped");
		expect(companyComputerFolderProgram({ ...INACTIVE, active: "deactivating" })).toBe("unknown");
		expect(companyComputerFolderProgram(undefined)).toBe("unknown");
	});

	it("starts each mount's program from a unit that uses the helper's own paths", async () => {
		const guest = (name: string) =>
			readFile(new URL(`../../../deploy/lxd-company-computer-guest/${name}`, import.meta.url), "utf8");
		const at = companyComputerFolderPaths(DESKTOP);
		const template = (path: string) => path.replace(DESKTOP, "%i");
		const mount = await guest("qorpera-office-folder-mount@.service.in");
		const lines = mount.split("\n");
		expect(lines).toContain(`ConditionPathExists=${template(at.view)}`);
		expect(lines).toContain(
			`ExecStart=${COMPANY_COMPUTER_FOLDER_PROGRAM} mount --view-file ${template(at.view)} --mountpoint ${template(at.mountpoint)} --state-dir ${template(at.state)} --allow-other yes --owner-uid @OFFICE_UID@ --owner-gid @OFFICE_GID@`,
		);
		expect(lines).toContain(`ExecStopPost=-/usr/bin/umount -l ${template(at.mountpoint)}`);
		expect(lines).toContain("RestartPreventExitStatus=3");
		expect(lines).toContain("DeviceAllow=/dev/fuse rw");
		const helper = await guest("qorpera-office-folder-helper.service");
		expect(helper.split("\n")).toContain(
			"ExecStart=/usr/bin/node /opt/qorpera-office/qorpera-company-computer-folder-helper.mjs",
		);
		// Neither may make a mount namespace of its own: their mounts must reach PID 1's.
		for (const unit of [mount, helper])
			for (const line of unit.split("\n").filter((line) => !line.startsWith("#")))
				expect(line).not.toMatch(
					/^(ProtectSystem|PrivateTmp|PrivateDevices|PrivateMounts|ProtectHome|ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|TemporaryFileSystem|BindPaths|BindReadOnlyPaths|ProtectKernel|ProtectControlGroups|ProtectProc|ProtectHostname|RootDirectory|MountAPIVFS)/,
				);
		expect((await guest("qorpera-office-folder-helper.socket")).split("\n")).toContain(
			`ListenStream=${COMPANY_COMPUTER_FOLDER_HELPER_SOCKET}`,
		);
	});
});
