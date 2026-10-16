import { spawn } from "node:child_process";
import {
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NasObjects } from "../src/folder-service/objects.ts";
import { encodeJson, Kind } from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	codeHostGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	OFFICE,
	storeFile,
} from "./folder-service-fixtures.ts";

/** Git on the mount (F3 step 5d; deploy/first-node/RUNTIME-COMPANY-FOLDER.md §6 "Git on the mount"): the pinned git,
 * run by two sessions, each in its own mount of one company folder and in its own worker's worktree of one code area,
 * against the folder service and a stand-in core. */
const program = process.env.QORPERA_FOLDER_MOUNT_BIN;
const gitBin = process.env.QORPERA_GIT_BIN;
const cleanup: (() => Promise<void> | void)[] = [];

/** What the service logged and the mount programs printed, shown when a test fails. */
const said: (() => string)[] = [];

afterEach(async (context) => {
	const shown = said.splice(0);
	if (context.task.result?.state === "fail") for (const lines of shown) console.log(lines());
	for (const done of cleanup.splice(0).reverse()) await done();
});

const AREA = "code/acme/app";
const R = `${AREA}/repo.git`;
const TIMEOUT = 120_000;

/** The settings the host gives each session's git (§6), with a shorter wait on a lease another session holds. */
const SETTINGS: readonly (readonly [string, string])[] = [
	["core.filesRefLockTimeout", "3000"],
	["core.packedRefsTimeout", "3000"],
	["gc.auto", "0"],
	["maintenance.auto", "false"],
	["gc.worktreePruneExpire", "never"],
	["core.symlinks", "true"],
	["core.checkStat", "minimal"],
	["core.trustctime", "false"],
	["core.splitIndex", "false"],
	["index.sparse", "false"],
	["core.fsmonitor", "false"],
];

async function eventually(check: () => Promise<boolean>, limitMs = 5_000): Promise<boolean> {
	const start = Date.now();
	for (;;) {
		try {
			if (await check()) return true;
		} catch {}
		if (Date.now() - start > limitMs) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function mounted(path: string): Promise<boolean> {
	return (await readFile("/proc/self/mountinfo", "utf8")).split("\n").some((line) => line.split(" ")[4] === path);
}

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve) => server.listen(path, resolve));
}

/** How a child process ended, and what it said. */
interface Ran {
	readonly code: number | null;
	readonly out: string;
}

function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	return new Promise<Ran>((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (data: Buffer) => {
			out += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			out += data.toString();
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, out }));
	});
}

/** The environment a session's git runs with: the host's settings (§6), and nothing from the machine's own. */
function gitEnv(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Worker",
		GIT_AUTHOR_EMAIL: "worker@example.com",
		GIT_COMMITTER_NAME: "Worker",
		GIT_COMMITTER_EMAIL: "worker@example.com",
		GIT_CONFIG_COUNT: String(SETTINGS.length),
	};
	SETTINGS.forEach(([key, value], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = key;
		env[`GIT_CONFIG_VALUE_${i}`] = value;
	});
	return env;
}

/** Runs git in `cwd` with the session settings, and answers how it ended. Git changes into `cwd` itself (`-C`): a
 * spawn's own chdir runs while this process waits for the exec, so a lookup on a mount would wait for the service in
 * this same process. */
function gitRun(cwd: string, home: string, args: readonly string[]): Promise<Ran> {
	return run(gitBin!, ["-C", cwd, ...args], { env: gitEnv(home) });
}

/** Runs git in `cwd`, and answers what it printed: it must succeed. */
async function git(cwd: string, home: string, ...args: string[]): Promise<string> {
	const ran = await gitRun(cwd, home, args);
	if (ran.code !== 0) throw new Error(`git ${args.join(" ")} exited ${ran.code}: ${ran.out}`);
	return ran.out;
}

/** Builds the code area with the pinned git on the machine's own disk: a bare `repo.git` with one commit on `main`,
 * and a worktree per worker (relative paths, so the worktrees resolve on any mount). */
async function seedArea(base: string): Promise<string> {
	const home = join(base, "home");
	const scratch = join(base, "scratch");
	const area = join(base, "tree", AREA);
	await mkdir(home, { recursive: true });
	await mkdir(join(scratch, "src"), { recursive: true });
	await mkdir(area, { recursive: true });
	await git(base, home, "init", "-q", "-b", "main", scratch);
	await writeFile(join(scratch, "README.md"), "# app\n");
	await writeFile(join(scratch, "src", "a.txt"), "one\ntwo\nthree\n");
	await git(scratch, home, "add", ".");
	await git(scratch, home, "commit", "-q", "-m", "first");
	await git(base, home, "clone", "-q", "--bare", scratch, join(area, "repo.git"));
	for (const worker of ["w1", "w2"])
		await git(
			join(area, "repo.git"),
			home,
			"worktree",
			"add",
			"-q",
			"--relative-paths",
			`../worktrees/${worker}`,
			"-b",
			worker,
			"main",
		);
	return join(base, "tree");
}

/** Puts every folder and file under `tree` into the stand-in core, each with its own version. */
async function importTree(core: FakeCore, root: string, tree: string): Promise<void> {
	let version = 1000;
	const walk = async (rel: string): Promise<void> => {
		for (const entry of await readdir(join(tree, rel), { withFileTypes: true })) {
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				core.entries.set(path, folder(path, version++));
				await walk(path);
			} else if (entry.isFile()) {
				const mode = (await stat(join(tree, path))).mode;
				const bytes = await readFile(join(tree, path));
				core.entries.set(
					path,
					await storeFile(root, path, bytes, version++, 65536, { executable: (mode & 0o111) !== 0 }),
				);
			} else throw new Error(`Not a file or folder: ${path}`);
		}
	};
	await walk("");
}

const WORKERS = {
	first: {
		worker: "w1",
		viewId: "5e6f7081-92a3-4b4c-8d5e-6f708192a3b4",
		pass: "cmdpass_0123456789-abcdefghijklmnopqrstuvwx",
	},
	second: {
		worker: "w2",
		viewId: "6f708192-a3b4-4c5d-8e6f-708192a3b4c5",
		pass: "cmdpass_1123456789-abcdefghijklmnopqrstuvwx",
	},
	/** The company's code host, with its `code_host` view: it runs git with `--git-dir` (no worktree of its own here). */
	host: {
		worker: "main",
		viewId: "708192a3-b4c5-4d6e-8f70-8192a3b4c5d6",
		pass: "cmdpass_2123456789-abcdefghijklmnopqrstuvwx",
	},
} as const;

/** One session: its own shell command's view, mount and worktree. */
interface Session {
	readonly viewId: string;
	/** The mountpoint, with the whole company folder. */
	readonly company: string;
	/** The session's worktree, on the mount. */
	readonly worktree: string;
	/** The session's home, where its git runs from. */
	readonly home: string;
	readonly output: () => string;
	git(...args: string[]): Promise<string>;
	gitRun(...args: string[]): Promise<Ran>;
	/** A boundary, from the program's `publish`; `final` is the command's last. */
	publish(final?: boolean): Promise<Ran>;
	/** The mount dies the way a killed machine's would: no boundary, no unmount. */
	kill(): Promise<void>;
}

/** The folder service and the bridge, over a stand-in core holding the seeded code area. */
async function area() {
	const base = await mkdtemp(join(tmpdir(), "qorpera-git-e2e-"));
	cleanup.push(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "share");
	const core = new FakeCore();
	await importTree(core, root, await seedArea(base));
	let logged = "";
	said.push(() => `service:\n${logged}`);
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const service = new FolderService({
		core,
		objects,
		grants: codeHostGrants(),
		staging: new FolderStaging(core, new FakeUploads(root, core), objects),
		log: (line) => {
			logged += `${line}\n`;
		},
	});
	const serviceSocket = join(base, "service.sock");
	const sockets = new Set<Socket>();
	const server = createFolderServer(service, () => {});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await listen(server, serviceSocket);
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy();
		service.stop();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	// The bridge's part: name the machine, then pass bytes through.
	const bridgeSocket = join(base, "bridge.sock");
	const bridge = createServer((machine) => {
		const upstream = connect(serviceSocket, () => {
			upstream.write(encodeJson(Kind.bridge, { cid: 90, lookup: "found", machine: OFFICE }));
			machine.pipe(upstream);
			upstream.pipe(machine);
		});
		machine.on("error", () => upstream.destroy());
		upstream.on("error", () => machine.destroy());
		machine.on("close", () => upstream.destroy());
		upstream.on("close", () => machine.destroy());
	});
	await listen(bridge, bridgeSocket);
	cleanup.push(() => new Promise<void>((resolve) => bridge.close(() => resolve())));
	return { base, root, core, service, bridgeSocket };
}

type Area = Awaited<ReturnType<typeof area>>;

/** Opens the worker's shell command's view and mounts the company folder for it, with the machine's own disk. */
async function mountSession(at: Area, which: keyof typeof WORKERS): Promise<Session> {
	const { worker, viewId, pass } = WORKERS[which];
	const host = which === "host";
	at.core.openView(viewId, pass, {
		kind: host ? "code_host" : "computer_shell_command",
		machineId: host ? null : ALLOCATION,
	});
	const dir = join(at.base, which);
	const company = join(dir, "company");
	const home = join(dir, "home");
	const state = join(dir, "state");
	await mkdir(company, { recursive: true });
	await mkdir(home, { recursive: true });
	const viewFile = join(dir, "view.json");
	await writeFile(viewFile, JSON.stringify({ environmentId: ENV, viewId, pass }), { mode: 0o600 });
	const connect = `unix:${at.bridgeSocket}`;
	let output = "";
	const child = spawn(
		program!,
		[
			"mount",
			"--view-file",
			viewFile,
			"--state-dir",
			state,
			"--mountpoint",
			company,
			"--connect",
			connect,
			"--threads",
			"4",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const collect = (data: Buffer): void => {
		output += data.toString();
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	said.push(() => `${which}:\n${output}`);
	const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
	const kill = async (): Promise<void> => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
		if (await mounted(company)) await run("umount", ["-l", company]);
	};
	cleanup.push(kill);
	expect(await eventually(() => mounted(company), 10_000), output).toBe(true);
	const worktree = join(company, AREA, "worktrees", worker);
	return {
		viewId,
		company,
		worktree,
		home,
		output: () => output,
		git: (...args) => git(worktree, home, ...args),
		gitRun: (...args) => gitRun(worktree, home, args),
		publish: (final = false) =>
			run(program!, [
				"publish",
				"--view-file",
				viewFile,
				"--state-dir",
				state,
				"--connect",
				connect,
				"--json",
				...(final ? ["--final"] : []),
			]),
		kill,
	};
}

/** The ref names under `prefix`, as a session's git sees them. */
async function refs(session: Session, prefix: string): Promise<string[]> {
	const out = await session.git("for-each-ref", "--format=%(refname)", prefix);
	return out.split("\n").filter((line) => line !== "");
}

/** The paths the core holds under `prefix`. */
function held(core: FakeCore, prefix: string): string[] {
	return [...core.entries.keys()].filter((path) => path.startsWith(prefix)).sort();
}

describe.skipIf(!program || !gitBin)("git on the mount, with the pinned git", () => {
	it(
		"a commit in one session is in the other's git at once: its objects, ref and log go with the lease",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			expect(await first.git("status", "--porcelain")).toBe("");
			await writeFile(join(first.worktree, "src", "b.txt"), "new\n");
			await first.git("add", "src/b.txt");
			await first.git("commit", "-q", "-m", "second");
			const head = (await first.git("rev-parse", "HEAD")).trim();
			expect(at.core.gitPublishes.at(-1)?.published).toBe(true);
			expect(at.core.gitLeases.size).toBe(0);

			await at.service.poll();
			const seen = async () => (await second.git("rev-parse", "w1")).trim() === head;
			expect(await eventually(seen), second.output()).toBe(true);
			expect(await second.git("log", "--format=%s", "w1")).toBe("second\nfirst\n");
			expect(await second.git("show", "w1:src/b.txt")).toBe("new\n");
			expect(await second.git("fsck", "--no-progress", "--no-dangling")).toBe("");

			// The worktree's own files publish at its boundary; a lock file never.
			const published = await first.publish();
			expect(published.code, published.out).toBe(0);
			expect(at.core.entries.get(`${AREA}/worktrees/w1/src/b.txt`)?.kind).toBe("file");
			expect(held(at.core, AREA).filter((path) => path.endsWith(".lock"))).toEqual([]);
			expect(await first.git("status", "--porcelain")).toBe("");
		},
		TIMEOUT,
	);

	it(
		"rebases one worker's branch onto the other's",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			await writeFile(join(second.worktree, "README.md"), "# app\n\nby w2\n");
			await second.git("commit", "-q", "-am", "readme");
			const onto = (await second.git("rev-parse", "HEAD")).trim();
			for (const n of [1, 2]) {
				await writeFile(join(first.worktree, `f${n}.txt`), `${n}\n`);
				await first.git("add", `f${n}.txt`);
				await first.git("commit", "-q", "-m", `f${n}`);
			}
			await at.service.poll();
			expect(await eventually(async () => (await first.git("rev-parse", "w2")).trim() === onto)).toBe(true);

			await first.git("rebase", "-q", "w2");
			const log = "f2\nf1\nreadme\nfirst\n";
			expect(await first.git("log", "--format=%s")).toBe(log);
			expect(await readFile(join(first.worktree, "README.md"), "utf8")).toBe("# app\n\nby w2\n");
			expect(await first.git("status", "--porcelain")).toBe("");
			await at.service.poll();
			expect(await eventually(async () => (await second.git("log", "--format=%s", "w1")) === log)).toBe(true);
			expect(at.core.gitLeases.size).toBe(0);
		},
		TIMEOUT,
	);

	it(
		"a link git tracks is the folder's link, and a clone copies the shared objects it cannot link",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			await symlink("README.md", join(first.worktree, "latest"));
			await first.git("add", "latest");
			await first.git("commit", "-q", "-m", "link");
			expect(await first.git("ls-files", "-s", "latest")).toMatch(/^120000 /);
			const published = await first.publish();
			expect(published.code, published.out).toBe(0);
			expect(at.core.entries.get(`${AREA}/worktrees/w1/latest`)).toMatchObject({
				kind: "symlink",
				target: "README.md",
			});

			await at.service.poll();
			expect(await eventually(async () => (await second.git("log", "-1", "--format=%s", "w1")) === "link\n")).toBe(
				true,
			);
			await second.git("merge", "-q", "--ff-only", "w1");
			expect(await readlink(join(second.worktree, "latest"))).toBe("README.md");
			expect(await second.git("status", "--porcelain")).toBe("");

			// A hard link out of a git object store is EXDEV (mount.rs `git_objects`), so a local clone copies instead (of
			// w1: the repository's HEAD stays at main).
			const commit = (await second.git("rev-parse", "HEAD")).trim();
			const object = join(second.company, R, "objects", commit.slice(0, 2), commit.slice(2));
			await expect(link(object, join(second.worktree, "object"))).rejects.toMatchObject({ code: "EXDEV" });
			await second.git("clone", "-q", "-b", "w1", join(second.company, R), "copy");
			expect(await second.git("-C", "copy", "log", "--format=%s")).toBe("link\nfirst\n");
			expect(await readlink(join(second.worktree, "copy", "latest"))).toBe("README.md");
			expect(await second.git("-C", "copy", "fsck", "--no-progress", "--no-dangling")).toBe("");
		},
		TIMEOUT,
	);

	it(
		"fetches N refs and a new commit from a remote, each ref under its own lease",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			const home = join(at.base, "home");
			const remote = join(at.base, "remote.git");
			await git(at.base, home, "clone", "-q", "--bare", join(at.base, "scratch"), remote);
			const extra = (await git(remote, home, "commit-tree", "main^{tree}", "-p", "main", "-m", "extra")).trim();
			const N = 24;
			for (let n = 0; n < N; n++) await git(remote, home, "branch", `b${n}`, n === 0 ? extra : "main");

			await first.git("fetch", "-q", remote, "+refs/heads/*:refs/remotes/origin/*");
			expect(await refs(first, "refs/remotes/origin")).toHaveLength(N + 1);
			expect((await first.git("rev-parse", "origin/b0")).trim()).toBe(extra);
			expect(at.core.gitLeases.size).toBe(0);
			expect(held(at.core, `${R}/refs/remotes/origin/`)).toHaveLength(N + 1);

			await at.service.poll();
			expect(await eventually(async () => (await refs(second, "refs/remotes/origin")).length === N + 1)).toBe(true);
			expect(await second.git("log", "--format=%s", "origin/b0")).toBe("extra\nfirst\n");
		},
		TIMEOUT,
	);

	it(
		"deletes a branch: its ref and log go, under the ref's lease",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			await first.git("branch", "topic", "main");
			expect(held(at.core, `${R}/refs/heads/topic`)).toEqual([`${R}/refs/heads/topic`]);
			await at.service.poll();
			expect(await eventually(async () => (await refs(second, "refs/heads/topic")).length === 1)).toBe(true);

			await first.git("branch", "-D", "topic");
			expect(await refs(first, "refs/heads/topic")).toEqual([]);
			expect(held(at.core, `${R}/refs/heads/topic`)).toEqual([]);
			expect(held(at.core, `${R}/logs/refs/heads/topic`)).toEqual([]);
			expect(at.core.gitLeases.size).toBe(0);
			await at.service.poll();
			expect(await eventually(async () => (await refs(second, "refs/heads/topic")).length === 0)).toBe(true);
			// main lives in packed-refs, which the delete looked at and left as it was.
			expect(await refs(second, "refs/heads/main")).toEqual(["refs/heads/main"]);
		},
		TIMEOUT,
	);

	it(
		"a git killed with a ref locked holds the lease until its command's last boundary",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			const main = (await first.git("rev-parse", "main")).trim();
			await writeFile(join(first.worktree, "k.txt"), "k\n");
			await first.git("add", "k.txt");
			await first.git("commit", "-q", "-m", "k");
			const next = (await first.git("rev-parse", "HEAD")).trim();

			// git takes the lock (prepare), and is killed before it commits.
			const locker = spawn(gitBin!, ["-C", first.worktree, "update-ref", "--stdin"], {
				env: gitEnv(first.home),
				stdio: ["pipe", "pipe", "pipe"],
			});
			let answered = "";
			locker.stdout.on("data", (data: Buffer) => {
				answered += data.toString();
			});
			locker.stdin.write(`start\nupdate refs/heads/main ${next} ${main}\nprepare\n`);
			expect(await eventually(async () => answered.includes("prepare: ok"))).toBe(true);
			const gone = new Promise<void>((resolve) => locker.on("exit", () => resolve()));
			locker.kill("SIGKILL");
			await gone;
			expect(at.core.gitLeases.has(`${R}/refs/heads/main`)).toBe(true);

			const busy = await second.gitRun("branch", "-f", "main", "w2");
			expect(busy.code).not.toBe(0);
			expect(busy.out).toMatch(/main\.lock': File exists/);

			// The machine dies with it; the command's last boundary gives the lease back and drops the lock.
			await first.kill();
			at.core.endCommand(first.viewId);
			const final = await first.publish(true);
			expect(final.code, final.out).toBe(0);
			expect(at.core.gitLeases.size).toBe(0);
			expect(held(at.core, `${R}/refs/heads/main`)).toEqual([]);

			await second.git("branch", "-f", "main", "w2");
			expect((await second.git("rev-parse", "main")).trim()).toBe((await second.git("rev-parse", "w2")).trim());
		},
		TIMEOUT,
	);

	it(
		"two sessions race one ref: one wins, the other fails and changes nothing",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			const main = (await first.git("rev-parse", "main")).trim();
			const tips: string[] = [];
			for (const session of [first, second]) {
				await writeFile(join(session.worktree, "race.txt"), `${session.viewId}\n`);
				await session.git("add", "race.txt");
				await session.git("commit", "-q", "-m", "race");
				tips.push((await session.git("rev-parse", "HEAD")).trim());
			}
			const ran = await Promise.all(
				[first, second].map((session, i) => session.gitRun("update-ref", "refs/heads/main", tips[i]!, main)),
			);
			expect(
				ran.filter((r) => r.code === 0),
				ran.map((r) => r.out).join("\n"),
			).toHaveLength(1);
			const winner = tips[ran.findIndex((r) => r.code === 0)]!;
			await at.service.poll();
			for (const session of [first, second])
				expect(await eventually(async () => (await session.git("rev-parse", "main")).trim() === winner)).toBe(true);
			expect(at.core.gitLeases.size).toBe(0);
		},
		TIMEOUT,
	);

	it(
		"a hook or setting written in one session is that session's only",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			const hook = join(first.company, R, "hooks", "post-commit");
			await writeFile(hook, '#!/bin/sh\necho hooked > "$HOME/hooked"\n', { mode: 0o755 });
			await first.git("config", "core.editor", "true");
			for (const session of [first, second]) {
				await writeFile(join(session.worktree, "h.txt"), "h\n");
				await session.git("add", "h.txt");
				await session.git("commit", "-q", "-m", "h");
			}
			expect(await readFile(join(first.home, "hooked"), "utf8")).toBe("hooked\n");
			await expect(stat(join(second.home, "hooked"))).rejects.toThrow(/ENOENT/);
			expect((await first.git("config", "core.editor")).trim()).toBe("true");
			expect((await second.gitRun("config", "core.editor")).code).toBe(1);

			const published = await first.publish();
			expect(published.code, published.out).toBe(0);
			await at.service.poll();
			expect(held(at.core, `${R}/hooks/post-commit`)).toEqual([]);
			expect(await readdir(join(second.company, R, "hooks"))).not.toContain("post-commit");
			// alternates and an object's times are not the session's to change.
			await expect(writeFile(join(first.company, R, "objects/info/alternates"), "/elsewhere\n")).rejects.toThrow(
				/EPERM/,
			);
			const object = (await readdir(join(first.company, R, "objects"))).find((name) => /^[0-9a-f]{2}$/.test(name))!;
			const loose = join(
				first.company,
				R,
				"objects",
				object,
				(await readdir(join(first.company, R, "objects", object)))[0]!,
			);
			await expect(utimes(loose, new Date(), new Date())).rejects.toThrow(/EPERM/);
		},
		TIMEOUT,
	);

	it(
		"the code host's config and hooks are published, and a session takes its own copy from them",
		async () => {
			const at = await area();
			const host = await mountSession(at, "host");
			const gitDir = join(host.company, R);
			const hook = "#!/bin/sh\necho canonical\n";
			await git(gitDir, host.home, "config", "qorpera.canonical", "yes");
			await writeFile(join(gitDir, "hooks", "post-commit"), hook, { mode: 0o755 });
			const published = await host.publish();
			expect(published.code, published.out).toBe(0);
			const config = hashOf(await readFile(join(gitDir, "config")));
			expect(at.core.entries.get(`${R}/config`)?.fileSha256).toBe(config);
			expect(at.core.entries.get(`${R}/hooks/post-commit`)?.fileSha256).toBe(hashOf(hook));
			await at.service.poll();

			const first = await mountSession(at, "first");
			expect((await first.git("config", "qorpera.canonical")).trim()).toBe("yes");
			expect(await readFile(join(first.company, R, "hooks", "post-commit"), "utf8")).toBe(hook);
			await first.git("config", "qorpera.canonical", "no");
			const own = await first.publish();
			expect(own.code, own.out).toBe(0);
			expect(at.core.entries.get(`${R}/config`)?.fileSha256).toBe(config);
			expect((await git(gitDir, host.home, "config", "qorpera.canonical")).trim()).toBe("yes");
		},
		TIMEOUT,
	);

	it(
		"the code host makes a new repository with git init, its boundary publishes HEAD and config, and a session cannot write them",
		async () => {
			const at = await area();
			const host = await mountSession(at, "host");
			const fresh = "code/acme/fresh/repo.git";
			const gitDir = join(host.company, fresh);
			const init = ["--quiet", "--bare", "--template=", "--ref-format=files", "--initial-branch=main"];
			await git(host.company, host.home, "init", ...init, gitDir);
			const head = "ref: refs/heads/main\n";
			expect(await readFile(join(gitDir, "HEAD"), "utf8")).toBe(head);
			const published = await host.publish();
			expect(published.code, published.out).toBe(0);
			expect(at.core.entries.get(`${fresh}/HEAD`)?.fileSha256).toBe(hashOf(head));
			const config = hashOf(await readFile(join(gitDir, "config")));
			expect(at.core.entries.get(`${fresh}/config`)?.fileSha256).toBe(config);
			// git init's probe file (`tXXXXXX`) came and went before the boundary.
			const top = [...at.core.entries.keys()].filter(
				(path) => path.startsWith(`${fresh}/`) && !path.slice(fresh.length + 1).includes("/"),
			);
			expect(top.filter((path) => path.startsWith(`${fresh}/t`))).toEqual([]);
			await at.service.poll();

			const first = await mountSession(at, "first");
			expect(await readFile(join(first.company, fresh, "HEAD"), "utf8")).toBe(head);
			for (const name of ["HEAD.lock", "tXXXXXX"])
				await expect(
					writeFile(join(first.company, fresh, name), "ref: refs/heads/w1\n", { flag: "wx" }),
				).rejects.toThrow(/EPERM/);
			expect(at.core.entries.get(`${fresh}/HEAD`)?.fileSha256).toBe(hashOf(head));
		},
		TIMEOUT,
	);

	it(
		"a cache folder stays on the machine's disk, and leaves the list once git tracks it",
		async () => {
			const at = await area();
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			const pkg = join(first.worktree, "node_modules", "pkg");
			await mkdir(pkg, { recursive: true });
			await writeFile(join(pkg, "index.js"), "module.exports = 1;\n");
			const published = await first.publish();
			expect(published.code, published.out).toBe(0);
			const cached = `${AREA}/worktrees/w1/node_modules`;
			expect(held(at.core, cached)).toEqual([]);
			await at.service.poll();
			expect(await readdir(join(second.company, AREA, "worktrees/w1"))).not.toContain("node_modules");

			// Once the index has it, it is the worktree's like any other folder: published at the next boundary, a link in it
			// as the folder's link.
			await mkdir(join(first.worktree, "node_modules", ".bin"));
			await symlink("../pkg/index.js", join(first.worktree, "node_modules", ".bin", "tool"));
			await first.git("add", "node_modules/pkg/index.js");
			await first.git("commit", "-q", "-m", "vendored");
			const again = await first.publish();
			expect(again.code, again.out).toBe(0);
			const files = [cached, `${cached}/.bin`, `${cached}/.bin/tool`, `${cached}/pkg`, `${cached}/pkg/index.js`];
			expect(held(at.core, cached)).toEqual(files);
			expect(at.core.entries.get(`${cached}/.bin/tool`)).toMatchObject({
				kind: "symlink",
				target: "../pkg/index.js",
			});
			await at.service.poll();
			const there = join(second.company, cached, "pkg/index.js");
			expect(await eventually(async () => (await readFile(there, "utf8")) === "module.exports = 1;\n")).toBe(true);
			expect(await readlink(join(second.company, cached, ".bin/tool"))).toBe("../pkg/index.js");
			expect(await readlink(join(first.worktree, "node_modules", ".bin", "tool"))).toBe("../pkg/index.js");
			expect(await readFile(join(first.worktree, "node_modules", ".bin", "tool"), "utf8")).toBe(
				"module.exports = 1;\n",
			);
			expect((await first.git("status", "--porcelain")).trim()).toBe("?? node_modules/.bin/");
		},
		TIMEOUT,
	);
});
