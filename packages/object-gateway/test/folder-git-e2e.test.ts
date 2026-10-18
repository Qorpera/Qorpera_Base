import { spawn } from "node:child_process";
import {
	link,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	rmdir,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NasObjects } from "../src/folder-service/objects.ts";
import { WAITS_FOR_REFUSED } from "../src/folder-service/plan.ts";
import { encodeJson, Kind } from "../src/folder-service/protocol.ts";
import { CARRIES } from "../src/folder-service/secret-scan.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService, type MachineBoundary } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	CODING,
	CODING_MACHINE_ID,
	codeHostGrants,
	codingGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	hashOf,
	looseObject,
	OFFICE,
	secretsOf,
	storeFile,
} from "./folder-service-fixtures.ts";

/** Git on the mount (F3 step 5d; deploy/first-node/RUNTIME-COMPANY-FOLDER.md §6 "Git on the mount"): the pinned git,
 * run by two sessions, each in its own mount of one company folder and in its own worker's worktree of one code area,
 * against the folder service and a stand-in core. And the machine's caches the same sessions make, in and out of the
 * code area (deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md). */
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

/** Runs `command`, with `input` on its standard input (empty if not given). */
function run(
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
) {
	return new Promise<Ran>((resolve, reject) => {
		const { input, ...spawned } = options;
		const child = spawn(command, args, { ...spawned, stdio: ["pipe", "pipe", "pipe"] });
		child.stdin.on("error", () => {});
		child.stdin.end(input);
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

/** The folder service and the bridge, over a stand-in core holding the seeded code area and `files` (path, content).
 * `coding`: the sessions are coding sessions on one coding machine (F3 5c), whose saves are checked (5j-5). */
async function area(files: Readonly<Record<string, string>> = {}, coding = false) {
	const base = await mkdtemp(join(tmpdir(), "qorpera-git-e2e-"));
	cleanup.push(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "share");
	const core = new FakeCore();
	core.gitObjectRules = true;
	const tree = await seedArea(base);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(tree, dirname(path)), { recursive: true });
		await writeFile(join(tree, path), content);
	}
	await importTree(core, root, tree);
	let logged = "";
	said.push(() => `service:\n${logged}`);
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const service = new FolderService({
		core,
		objects,
		grants: coding ? codingGrants() : codeHostGrants(),
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
			const named = coding ? { cid: 95, machine: CODING } : { cid: 90, machine: OFFICE };
			upstream.write(encodeJson(Kind.bridge, { ...named, lookup: "found" }));
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
	return { base, root, core, service, bridgeSocket, coding };
}

type Area = Awaited<ReturnType<typeof area>>;

/** Opens the worker's shell command's view (its coding session's, in a coding area) and mounts the company folder for
 * it, with the machine's own disk. */
async function mountSession(at: Area, which: keyof typeof WORKERS): Promise<Session> {
	const { worker, viewId, pass } = WORKERS[which];
	const host = which === "host";
	at.core.openView(
		viewId,
		pass,
		at.coding && !host
			? { kind: "coding_session", codingMachineId: CODING_MACHINE_ID }
			: { kind: host ? "code_host" : "computer_shell_command", machineId: host ? null : ALLOCATION },
	);
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

/** The paths a coding machine's boundary refused in the first worker's view, each with why, in order. */
function refusedAt(boundary: MachineBoundary): string[] {
	const report = boundary.views.find((view) => view.viewId === WORKERS.first.viewId)?.report;
	const paths = report?.paths ?? [];
	return paths
		.filter((entry) => entry.outcome === "refused")
		.map((entry) => `${entry.path}: ${entry.reason}`)
		.sort();
}

/** The paths the core holds under `prefix`. */
function held(core: FakeCore, prefix: string): string[] {
	return [...core.entries.keys()].filter((path) => path.startsWith(prefix)).sort();
}

/** The paths the core holds under `prefix`, each with its version: what a refused change leaves as it was. */
function versions(core: FakeCore, prefix: string): string[] {
	return held(core, prefix).map((path) => `${path} ${core.entries.get(path)?.version}`);
}

/** What a coding machine's boundary refused in the first worker's view (5j-5 (a)): the paths that carry a secret
 * value, and those held back with them, each in order. Every one held back is in the repository, and nothing is
 * refused for another reason. */
function refusedIn(boundary: MachineBoundary): { carries: string[]; waiting: string[] } {
	const lines = refusedAt(boundary);
	const of = (reason: string) =>
		lines.filter((line) => line.endsWith(`: ${reason}`)).map((line) => line.slice(0, -`: ${reason}`.length));
	const carries = of(CARRIES);
	const waiting = of(WAITS_FOR_REFUSED);
	expect(lines.filter((line) => ![CARRIES, WAITS_FOR_REFUSED].some((why) => line.endsWith(`: ${why}`)))).toEqual([]);
	expect(waiting.filter((path) => !path.startsWith(`${R}/`))).toEqual([]);
	return { carries, waiting };
}

/** The test value the coding sessions' secret check looks for (not a secret). */
const VALUE = "test-value-0001";

/** A loose object's id, from its path under the repository (`objects/xx/<38 hex>`). */
function oidOf(name: string): string {
	return name.slice("objects/".length).replace("/", "");
}

/** What another session's git reads of the repository's objects: none holds the value, and the store is whole. */
async function readsNoValue(session: Session, oid: string): Promise<void> {
	expect((await session.gitRun("cat-file", "-e", oid)).code).not.toBe(0);
	expect((await session.git("cat-file", "--batch-all-objects", "--batch")).includes(VALUE)).toBe(false);
	expect(await session.git("fsck", "--no-progress", "--no-dangling")).toBe("");
}

/** The refusal's way out for a git commit, as the executor words it (`coding-executor.ts`), the value already taken out
 * of the files: then a commit is saved. */
async function wayOut(session: Session): Promise<void> {
	await session.git("reflog", "expire", "--expire-unreachable=now", "HEAD");
	await session.git("repack", "-a", "-d", "--max-pack-size=64m");
	await session.git("prune", "--expire=now");
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
		"packs refs right after another session deleted one its machine still lists: git lists them anew, not packing it back",
		async () => {
			const at = await area();
			// The changes a view reads of the feed reach its machine only when let go, as on a busy machine.
			const waiting: (() => void)[] = [];
			let holding = false;
			const open = at.service.open.bind(at.service);
			at.service.open = async (hello, bridge) => {
				const handle = await open(hello, bridge);
				const subscribe = handle.subscribe.bind(handle);
				handle.subscribe = (sink) =>
					subscribe({
						...sink,
						change: (message) => {
							if (holding) waiting.push(() => sink.change(message));
							else sink.change(message);
						},
					});
				return handle;
			};
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			await first.git("branch", "topic", "main");
			await at.service.poll();
			// second's machine lists the loose refs, topic among them.
			expect(await eventually(async () => (await refs(second, "refs/heads/topic")).length === 1)).toBe(true);

			holding = true;
			await first.git("branch", "-D", "topic");
			expect(held(at.core, `${R}/refs/heads/topic`)).toEqual([]);
			// The take of packed-refs' lock reads the feed (second's view drops topic), and the machine forgets its
			// listings of the loose refs, so git lists them from the view, not from what it was told before.
			await second.git("pack-refs", "--all");
			const packed = await readFile(join(second.company, R, "packed-refs"), "utf8");
			expect(packed).toContain(" refs/heads/main\n");
			expect(packed).not.toContain("refs/heads/topic");
			expect(at.core.entries.get(`${R}/packed-refs`)?.fileSha256).toBe(hashOf(packed));
			expect(held(at.core, `${R}/refs/heads/topic`)).toEqual([]);
			expect(at.core.gitLeases.size).toBe(0);

			holding = false;
			for (const send of waiting.splice(0)) send();
			await at.service.poll();
			for (const session of [first, second]) {
				expect(await refs(session, "refs/heads/topic")).toEqual([]);
				expect(await refs(session, "refs/heads/main")).toEqual(["refs/heads/main"]);
			}
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
		"the code host moves a new repository's first branch before any boundary, and packs its refs without losing one",
		async () => {
			const at = await area();
			const host = await mountSession(at, "host");
			const fresh = "code/acme/fresh/repo.git";
			const gitDir = join(host.company, fresh);
			const init = ["--quiet", "--bare", "--template=", "--ref-format=files", "--initial-branch=main"];
			await git(host.company, host.home, "init", ...init, gitDir);
			// The seed's order (5e): the base ref moves under its lease while the new repo.git is only the view's.
			const tree = (await git(gitDir, host.home, "hash-object", "-w", "-t", "tree", "/dev/null")).trim();
			const commit = (await git(gitDir, host.home, "commit-tree", tree, "-m", "base")).trim();
			await git(gitDir, host.home, "update-ref", "refs/heads/main", commit);
			expect(at.core.entries.get(`${fresh}/HEAD`)?.fileSha256).toBe(hashOf("ref: refs/heads/main\n"));
			expect(at.core.entries.get(`${fresh}/refs/heads/main`)?.fileSha256).toBe(hashOf(`${commit}\n`));
			// git gc's pack-refs: packed-refs.new renamed onto packed-refs under its lock, then the loose ref pruned.
			await git(gitDir, host.home, "pack-refs", "--all");
			const packed = await readFile(join(gitDir, "packed-refs"), "utf8");
			expect(packed).toContain(`${commit} refs/heads/main`);
			expect(at.core.entries.get(`${fresh}/packed-refs`)?.fileSha256).toBe(hashOf(packed));
			expect(at.core.entries.has(`${fresh}/packed-refs.new`)).toBe(false);
			expect(at.core.entries.has(`${fresh}/refs/heads/main`)).toBe(false);
			const published = await host.publish();
			expect(published.code, published.out).toBe(0);
			await at.service.poll();

			const first = await mountSession(at, "first");
			expect((await git(join(first.company, fresh), first.home, "rev-parse", "refs/heads/main")).trim()).toBe(
				commit,
			);
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

	it(
		"what git leaves out in a worktree stays on the machine's disk, as git check-ignore says, until the index has it",
		async () => {
			const [w1, w2] = [`${AREA}/worktrees/w1`, `${AREA}/worktrees/w2`];
			const at = await area({
				[`${w1}/.gitignore`]: "*.log\n!keep.log\n/out/\nlogs/\n",
				[`${w1}/sub/.gitignore`]: "*.tmp\n",
			});
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			// The session's own info/exclude (a session-local git file).
			await writeFile(join(first.company, R, "info", "exclude"), "secret.txt\n");
			for (const dir of ["out", "logs", "sub/out", "sub/deep", "src/logs"]) await mkdir(join(first.worktree, dir));
			const paths = [
				"debug.log",
				"keep.log",
				"secret.txt",
				"out/x",
				"logs/y",
				"logs/z",
				"sub/a.tmp",
				"sub/b.txt",
				"sub/out/c",
				"sub/deep/d.log",
				"src/logs/e",
				"src/f.txt",
			];
			for (const path of paths) await writeFile(join(first.worktree, path), `${path}\n`);
			const published = await first.publish();
			expect(published.code, published.out).toBe(0);
			// A cache is just what git leaves out; the rest is published.
			const cached: string[] = [];
			for (const path of paths) {
				if ((await first.gitRun("check-ignore", "-q", path)).code === 0) cached.push(path);
				expect(await readFile(join(first.worktree, path), "utf8")).toBe(`${path}\n`);
			}
			expect(cached).toEqual([
				"debug.log",
				"secret.txt",
				"out/x",
				"logs/y",
				"logs/z",
				"sub/a.tmp",
				"sub/deep/d.log",
				"src/logs/e",
			]);
			expect(paths.filter((path) => at.core.entries.has(`${w1}/${path}`))).toEqual(
				paths.filter((path) => !cached.includes(path)),
			);
			expect(held(at.core, `${w1}/out`)).toEqual([]);
			expect(held(at.core, `${w1}/logs`)).toEqual([]);

			// `git add -f` takes what it names into the index, and so into the folder: of a folder git leaves out, only that.
			await first.git("add", "-f", "debug.log", "logs/y");
			await first.git("add", ".gitignore", "sub/.gitignore");
			await first.git("commit", "-q", "-m", "forced");
			const head = (await first.git("rev-parse", "HEAD")).trim();
			const again = await first.publish();
			expect(again.code, again.out).toBe(0);
			expect(held(at.core, `${w1}/logs`)).toEqual([`${w1}/logs`, `${w1}/logs/y`]);
			expect(at.core.entries.get(`${w1}/debug.log`)?.kind).toBe("file");
			expect(await readFile(join(first.worktree, "logs/z"), "utf8")).toBe("logs/z\n");
			expect(await first.git("status", "--porcelain", "--ignored", "--", "debug.log", "logs")).toBe("!! logs/z\n");

			// A checkout writes the files before the index: what it writes under a pattern is a cache until the index has it.
			await at.service.poll();
			expect(await eventually(async () => (await second.git("rev-parse", "w1")).trim() === head)).toBe(true);
			await second.git("merge", "-q", "--ff-only", "w1");
			expect(await second.git("status", "--porcelain")).toBe("");
			const last = await second.publish();
			expect(last.code, last.out).toBe(0);
			expect(held(at.core, `${w2}/logs`)).toEqual([`${w2}/logs`, `${w2}/logs/y`]);
			expect(at.core.entries.get(`${w2}/debug.log`)?.kind).toBe("file");
			expect(await readFile(join(second.worktree, "debug.log"), "utf8")).toBe("debug.log\n");
		},
		TIMEOUT,
	);

	it(
		"an editor's atomic save goes over a published file from a name git leaves out, and over one git leaves out from a plain name",
		async () => {
			const w1 = `${AREA}/worktrees/w1`;
			const at = await area({ [`${w1}/.gitignore`]: "*.tmp\n.env\n", [`${w1}/notes.md`]: "old\n" });
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			// The editor writes the new content beside the file and renames it over the file.
			await writeFile(join(first.worktree, "notes.md.tmp"), "new\n");
			await rename(join(first.worktree, "notes.md.tmp"), join(first.worktree, "notes.md"));
			await writeFile(join(first.worktree, ".env"), "A=1\n");
			await writeFile(join(first.worktree, ".env.new"), "A=2\n");
			await rename(join(first.worktree, ".env.new"), join(first.worktree, ".env"));
			expect(await readFile(join(first.worktree, "notes.md"), "utf8")).toBe("new\n");
			expect(await readFile(join(first.worktree, ".env"), "utf8")).toBe("A=2\n");
			const names = [".env", ".git", ".gitignore", "README.md", "notes.md", "src"];
			expect((await readdir(first.worktree)).sort()).toEqual(names);
			expect((await first.gitRun("check-ignore", "-q", ".env")).code).toBe(0);
			expect((await first.gitRun("check-ignore", "-q", "notes.md")).code).toBe(1);

			// The boundary publishes the save of the folder's file, and nothing of the other.
			const published = await first.publish();
			expect(published.code, published.out).toBe(0);
			const files = ["notes.md", "notes.md.tmp", ".env", ".env.new"].filter((f) =>
				at.core.entries.has(`${w1}/${f}`),
			);
			expect(files).toEqual(["notes.md"]);
			await at.service.poll();
			const there = join(second.company, w1);
			expect(await eventually(async () => (await readFile(join(there, "notes.md"), "utf8")) === "new\n")).toBe(true);
			expect((await readdir(there)).sort()).toEqual(names.filter((name) => name !== ".env"));
			expect(await readFile(join(first.worktree, ".env"), "utf8")).toBe("A=2\n");
		},
		TIMEOUT,
	);

	it(
		"refuses a coding session's commit of a file carrying a secret value at its ref update, and saves it after the refusal's way out (5j-5)",
		async () => {
			const at = await area({}, true);
			at.service.secrets(CODING_MACHINE_ID, secretsOf(VALUE));
			const first = await mountSession(at, "first");
			const tip = (await first.git("rev-parse", "HEAD")).trim();
			const before = versions(at.core, `${R}/`);
			const env = `${AREA}/worktrees/w1/.env`;
			const blob = `${R}/${looseObject("blob", `KEY=${VALUE}\n`).name}`;
			await writeFile(join(first.worktree, ".env"), `KEY=${VALUE}\n`);
			await first.git("add", ".env");
			const refused = await first.gitRun("commit", "-q", "-m", "settings");
			expect(refused.code, refused.out).not.toBe(0);
			expect((await first.git("rev-parse", "HEAD")).trim()).toBe(tip);
			expect(at.core.gitPublishes).toEqual([]);
			// Git logged the commit it made in the worktree's own HEAD log, a plain file the refused change leaves.
			const headLog = `${R}/worktrees/w1/logs/HEAD`;
			const made = (await readFile(join(first.company, headLog), "utf8")).trim().split("\n").at(-1)?.split(" ")[1];
			expect(made).toMatch(/^[0-9a-f]{40}$/);
			expect(made).not.toBe(tip);
			const tree = (await first.git("rev-parse", `${made}^{tree}`)).trim();
			// The turn's boundary: the file and its object are refused and kept on the machine, and the rest of the
			// repository's change is held back with them (5j-5 (a)): the commit, its tree, the log and the index.
			const refusal = refusedIn(await at.service.boundary(CODING_MACHINE_ID));
			expect(refusal.carries).toEqual([blob, env]);
			const objects = [made!, tree].map((oid) => `${R}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
			expect(refusal.waiting).toEqual(expect.arrayContaining([...objects, headLog, `${R}/worktrees/w1/index`]));
			expect(versions(at.core, `${R}/`)).toEqual(before);

			// The refusal's way out, as the executor words it.
			await writeFile(join(first.worktree, ".env"), "KEY=from-the-vault\n");
			await first.git("add", ".env");
			await wayOut(first);
			await first.git("commit", "-q", "-m", "settings");
			expect(at.core.gitPublishes.at(-1)?.published).toBe(true);
			expect(await first.git("log", "--format=%s")).toBe("settings\nfirst\n");
			expect(await first.git("fsck", "--no-progress", "--no-dangling")).toBe("");
			await expect(stat(join(first.company, blob))).rejects.toMatchObject({ code: "ENOENT" });
			expect(refusedAt(await at.service.boundary(CODING_MACHINE_ID))).toEqual([]);
			expect(at.core.entries.has(blob)).toBe(false);
			expect(at.core.entries.get(env)?.fileSha256).toBe(hashOf("KEY=from-the-vault\n"));
			// No log names the refused commit, on the machine or in the core.
			for (const log of [headLog, `${R}/logs/refs/heads/w1`]) {
				const bytes = await readFile(join(first.company, log));
				expect(bytes.toString()).not.toContain(made);
				expect(at.core.entries.get(log)?.fileSha256).toBe(hashOf(bytes));
			}
		},
		TIMEOUT,
	);

	it(
		"keeps a refused git change safe when the session ignores the refusal, and saves it after the way out (5j-5 (a))",
		async () => {
			const at = await area({}, true);
			at.service.secrets(CODING_MACHINE_ID, secretsOf(VALUE));
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			const tip = (await first.git("rev-parse", "HEAD")).trim();
			const before = versions(at.core, `${R}/`);
			const env = `${AREA}/worktrees/w1/.env`;
			const name = looseObject("blob", `KEY=${VALUE}\n`).name;
			const blob = `${R}/${name}`;
			await writeFile(join(first.worktree, ".env"), `KEY=${VALUE}\n`);
			await first.git("add", ".env");
			expect((await first.gitRun("commit", "-q", "-m", "settings")).code).not.toBe(0);

			// The session goes on as if it had not been refused: it leaves the file out of its next commit, and its turns
			// end. Each boundary refuses the same, each commit is refused though it holds none of the value, and nothing of
			// the repository is published or changed in the core.
			await first.git("reset", "-q", "--", ".env");
			await writeFile(join(first.worktree, "notes.md"), "plain notes\n");
			await first.git("add", "notes.md");
			for (const n of [1, 2]) {
				expect(refusedIn(await at.service.boundary(CODING_MACHINE_ID)).carries).toEqual([blob, env]);
				expect(versions(at.core, `${R}/`)).toEqual(before);
				const later = await first.gitRun("commit", "-q", "-m", `notes ${n}`);
				expect(later.code, later.out).not.toBe(0);
				expect((await first.git("rev-parse", "HEAD")).trim()).toBe(tip);
			}
			expect(at.core.gitPublishes).toEqual([]);
			// Nothing refused can be read outside the session, by another session's git in the core's copy, and that copy
			// is whole, at its tip.
			expect((await second.git("rev-parse", "w1")).trim()).toBe(tip);
			await readsNoValue(second, oidOf(name));

			// The way out: the commit is saved, and nothing refused is left, on the machine or in the core.
			await writeFile(join(first.worktree, ".env"), "KEY=from-the-vault\n");
			await first.git("add", ".env");
			await wayOut(first);
			await first.git("commit", "-q", "-m", "settings");
			expect(at.core.gitPublishes.at(-1)?.published).toBe(true);
			await expect(stat(join(first.company, blob))).rejects.toMatchObject({ code: "ENOENT" });
			expect(refusedAt(await at.service.boundary(CODING_MACHINE_ID))).toEqual([]);
			expect(at.core.entries.has(blob)).toBe(false);
			await readsNoValue(first, oidOf(name));
			await at.service.poll();
			const log = "settings\nfirst\n";
			expect(await eventually(async () => (await second.git("log", "--format=%s", "w1")) === log)).toBe(true);
			expect(await second.git("show", "w1:notes.md")).toBe("plain notes\n");
			await readsNoValue(second, oidOf(name));

			// Git's own indexes of the objects stay in the view that made them, the way out's `objects/info/packs` among
			// them: the core takes none from a session, and another session's git never reads one listing what this
			// session's git held.
			await first.git("commit-graph", "write", "--reachable");
			await first.git("multi-pack-index", "write");
			const indexes = ["info/commit-graph", "info/packs", "pack/multi-pack-index"].map((i) => `${R}/objects/${i}`);
			for (const index of indexes) await stat(join(first.company, index));
			expect(refusedAt(await at.service.boundary(CODING_MACHINE_ID))).toEqual([]);
			for (const index of indexes) {
				expect(at.core.entries.has(index)).toBe(false);
				await expect(stat(join(second.company, index))).rejects.toMatchObject({ code: "ENOENT" });
			}
			expect(await first.git("fsck", "--no-progress", "--no-dangling")).toBe("");
			expect(await second.git("fsck", "--no-progress", "--no-dangling")).toBe("");
		},
		TIMEOUT,
	);

	it(
		"holds a clean commit and a branch's delete while the worktree's git files hold a refused change, and publishes after the way out (5j-5 (a))",
		async () => {
			const at = await area({}, true);
			at.service.secrets(CODING_MACHINE_ID, secretsOf(VALUE));
			const first = await mountSession(at, "first");
			const topic = `${R}/refs/heads/topic`;
			const topicLog = `${R}/logs/refs/heads/topic`;
			await first.git("branch", "topic", "main");
			expect(held(at.core, topic)).toEqual([topic]);
			const logged = held(at.core, topicLog);
			const published = at.core.gitPublishes.length;
			const tip = (await first.git("rev-parse", "HEAD")).trim();
			// A file among the worktree's own git files carries the value: the repository is held whole.
			const notes = `${R}/worktrees/w1/NOTES`;
			await writeFile(join(first.company, notes), `the key is ${VALUE}\n`);

			// A commit that holds none of it is refused at its ref update; git rolls it back, and its lease ends.
			await writeFile(join(first.worktree, "notes.md"), "plain notes\n");
			await first.git("add", "notes.md");
			const commit = await first.gitRun("commit", "-q", "-m", "notes");
			expect(commit.code, commit.out).not.toBe(0);
			expect((await first.git("rev-parse", "HEAD")).trim()).toBe(tip);
			expect(at.core.gitPublishes).toHaveLength(published);
			expect(at.core.gitLeases.size).toBe(0);
			// A branch's delete publishes nothing either: its lock stays, with its lease, and the core keeps the ref and its
			// log.
			await first.gitRun("branch", "-D", "topic");
			expect(at.core.gitLeases.has(topic)).toBe(true);
			expect(held(at.core, topic)).toEqual([topic]);
			expect(held(at.core, topicLog)).toEqual(logged);
			expect(at.core.gitPublishes).toHaveLength(published);
			expect(refusedIn(await at.service.boundary(CODING_MACHINE_ID)).carries).toEqual([notes]);

			// The way out: the file goes, and removing the lock again publishes the delete; then the commit is saved.
			await rm(join(first.company, notes));
			await rm(join(first.company, `${topic}.lock`));
			expect(at.core.gitLeases.size).toBe(0);
			expect(held(at.core, topic)).toEqual([]);
			expect(held(at.core, topicLog)).toEqual([]);
			await first.git("commit", "-q", "-m", "notes");
			expect(at.core.gitPublishes.at(-1)?.published).toBe(true);
			expect(await first.git("log", "--format=%s")).toBe("notes\nfirst\n");
			expect(refusedAt(await at.service.boundary(CODING_MACHINE_ID))).toEqual([]);
			expect(at.core.entries.has(notes)).toBe(false);
		},
		TIMEOUT,
	);

	it(
		"refuses a pack that holds a secret value, holds its .idx and .rev back with it, and saves after the way out (5j-5 (b))",
		async () => {
			const at = await area({}, true);
			at.service.secrets(CODING_MACHINE_ID, secretsOf(VALUE));
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			const before = versions(at.core, `${R}/`);
			const env = `${AREA}/worktrees/w1/.env`;
			const name = looseObject("blob", `KEY=${VALUE}\n`).name;
			await writeFile(join(first.worktree, ".env"), `KEY=${VALUE}\n`);
			await first.git("add", ".env");
			expect((await first.gitRun("commit", "-q", "-m", "settings")).code).not.toBe(0);
			// The session packs what it has not saved: the value is then only in a pack, compressed.
			await first.git("repack", "-d", "-q");
			await expect(stat(join(first.company, R, name))).rejects.toMatchObject({ code: "ENOENT" });
			const packs = join(first.company, R, "objects", "pack");
			const files = (await readdir(packs)).sort();
			const pack = files.find((file) => file.endsWith(".pack"))?.slice(0, -".pack".length);
			expect(files).toEqual(["idx", "pack", "rev"].map((end) => `${pack}.${end}`));
			const P = `${R}/objects/pack/${pack}`;

			// The boundary refuses the pack, and holds back its index and reverse index with the rest of the repository's
			// change; a commit is refused too.
			const refusal = refusedIn(await at.service.boundary(CODING_MACHINE_ID));
			expect(refusal.carries).toEqual([`${P}.pack`, env]);
			expect(refusal.waiting).toEqual(expect.arrayContaining([`${P}.idx`, `${P}.rev`]));
			expect(versions(at.core, `${R}/`)).toEqual(before);
			expect((await first.gitRun("commit", "-q", "-m", "settings")).code).not.toBe(0);
			await readsNoValue(second, oidOf(name));

			// The way out clears the pack: the commit is saved, and no file of the pack is left, on the machine or in the
			// core.
			await writeFile(join(first.worktree, ".env"), "KEY=from-the-vault\n");
			await first.git("add", ".env");
			await wayOut(first);
			await first.git("commit", "-q", "-m", "settings");
			expect(at.core.gitPublishes.at(-1)?.published).toBe(true);
			expect((await readdir(packs)).filter((file) => file.startsWith(`${pack}.`))).toEqual([]);
			expect(refusedAt(await at.service.boundary(CODING_MACHINE_ID))).toEqual([]);
			expect(held(at.core, `${P}.`)).toEqual([]);
			await readsNoValue(first, oidOf(name));
			await at.service.poll();
			const log = "settings\nfirst\n";
			expect(await eventually(async () => (await second.git("log", "--format=%s", "w1")) === log)).toBe(true);
			await readsNoValue(second, oidOf(name));
		},
		TIMEOUT,
	);

	it(
		"refuses a pack whose secret value is whole only once a delta is resolved, and saves after the way out (5j-5 (b))",
		async () => {
			const at = await area({}, true);
			at.service.secrets(CODING_MACHINE_ID, secretsOf(VALUE));
			const first = await mountSession(at, "first");
			const before = versions(at.core, `${R}/`);
			// Two settings files: `v1` holds the value; `v2`, git's base for it, is longer and has the value's ninth byte
			// changed, so the value is whole only in `v1` rebuilt (its delta copies around the one byte it inserts).
			const lines = Array.from({ length: 300 }, (_, i) => `setting_${i} = the value of setting number ${i}\n`);
			const changed = `${VALUE.slice(0, 8)}X${VALUE.slice(9)}`;
			const v1 = [...lines.slice(0, 150), `key = ${VALUE}\n`, ...lines.slice(150)].join("");
			const v2 = [...lines.slice(0, 150), `key = ${changed}\n`, ...lines.slice(150), ...lines.slice(0, 20)].join("");
			const off = join(at.base, "settings");
			await mkdir(off);
			await writeFile(join(off, "v1"), v1);
			await writeFile(join(off, "v2"), v2);
			const [o1, o2] = (await first.git("hash-object", "-w", join(off, "v1"), join(off, "v2"))).trim().split("\n");
			// The session packs the two, uncompressed, and removes their loose copies: the pack holds `v2` as it is and
			// `v1` as a delta against it, and so not the value.
			const into = join(first.company, R, "objects/pack/pack");
			const packed = await run(
				gitBin!,
				["-C", first.worktree, "-c", "pack.compression=0", "pack-objects", "-q", into],
				{
					env: gitEnv(first.home),
					input: `${o1}\n${o2}\n`,
				},
			);
			expect(packed.code, packed.out).toBe(0);
			await first.git("prune-packed");
			for (const oid of [o1, o2])
				await expect(stat(join(first.company, R, "objects", oid.slice(0, 2), oid.slice(2)))).rejects.toMatchObject({
					code: "ENOENT",
				});
			const P = `${R}/objects/pack/pack-${packed.out.trim()}`;
			const bytes = await readFile(join(first.company, `${P}.pack`));
			expect(bytes.indexOf(lines[0])).not.toBe(-1);
			expect(bytes.indexOf(VALUE)).toBe(-1);
			const stored = (await first.git("verify-pack", "-v", join(first.company, `${P}.idx`)))
				.split("\n")
				.find((line) => line.startsWith(o1));
			expect(stored?.trim().split(/\s+/).at(-1)).toBe(o2);

			// The boundary refuses the pack, rebuilt, and holds back its index and reverse index.
			const refusal = refusedIn(await at.service.boundary(CODING_MACHINE_ID));
			expect(refusal.carries).toEqual([`${P}.pack`]);
			expect(refusal.waiting).toEqual(expect.arrayContaining([`${P}.idx`, `${P}.rev`]));
			expect(versions(at.core, `${R}/`)).toEqual(before);

			// The way out clears the pack, and a commit is saved.
			await wayOut(first);
			await writeFile(join(first.worktree, "notes.md"), "plain notes\n");
			await first.git("add", "notes.md");
			await first.git("commit", "-q", "-m", "notes");
			expect(at.core.gitPublishes.at(-1)?.published).toBe(true);
			await expect(stat(join(first.company, `${P}.pack`))).rejects.toMatchObject({ code: "ENOENT" });
			expect(refusedAt(await at.service.boundary(CODING_MACHINE_ID))).toEqual([]);
			expect(held(at.core, `${P}.`)).toEqual([]);
			await readsNoValue(first, o1);
		},
		TIMEOUT,
	);
});

/** The environment npm runs with in a session: the session's home, a cache off the mount, and no network. */
function npmEnv(session: Session, at: Area): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: session.home,
		npm_config_cache: join(at.base, "npm-cache"),
		npm_config_offline: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
}

/** Runs a program that lies on a mount, through a shell off it: a spawn waits for its exec, and an exec that looks the
 * program up on a mount would wait for the service in this same process. */
function runThere(path: string, args: readonly string[]): Promise<Ran> {
	return run("sh", ["-c", 'exec "$@"', "sh", path, ...args]);
}

describe.skipIf(!program || !gitBin)("the machine's caches, out of the code areas", () => {
	it(
		"npm install, a venv and a build stay on the machine, and what no rule makes a cache is published",
		async () => {
			const at = await area({ "apps/web/dist/old.js": "old\n" });
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			// A package with a program, packed off the mount: npm installs it as it would one from a registry.
			const dep = join(at.base, "dep");
			await mkdir(dep);
			const manifest = { name: "dep", version: "1.0.0", bin: { dep: "cli.js" } };
			await writeFile(join(dep, "package.json"), JSON.stringify(manifest));
			await writeFile(join(dep, "cli.js"), "#!/usr/bin/env node\nconsole.log(42);\n", { mode: 0o755 });
			const env = npmEnv(first, at);
			const packed = await run("npm", ["pack", dep, "--pack-destination", at.base], { env });
			expect(packed.code, packed.out).toBe(0);
			const web = join(first.company, "apps/web");
			const dependencies = { dep: `file:${join(at.base, "dep-1.0.0.tgz")}` };
			await writeFile(join(web, "package.json"), JSON.stringify({ name: "web", private: true, dependencies }));
			const installed = await run("npm", ["install", "--prefix", web], { env });
			expect(installed.code, installed.out).toBe(0);
			expect(await runThere(join(web, "node_modules/.bin/dep"), [])).toEqual({ code: 0, out: "42\n" });

			// A venv, without pip (the machine image has none), with a package put into its site-packages by hand.
			const py = join(first.company, "apps/py");
			await mkdir(py, { recursive: true });
			const venv = await run("python3", ["-m", "venv", "--without-pip", join(py, ".venv")]);
			expect(venv.code, venv.out).toBe(0);
			const [lib] = await readdir(join(py, ".venv/lib"));
			await writeFile(join(py, ".venv/lib", lib!, "site-packages/dep.py"), "X = 7\n");
			const imported = await runThere(join(py, ".venv/bin/python"), ["-c", "import dep; print(dep.X)"]);
			expect(imported).toEqual({ code: 0, out: "7\n" });

			await mkdir(join(first.company, ".pnpm-store/v3"), { recursive: true });
			await writeFile(join(first.company, ".pnpm-store/v3/index"), "store\n");
			// A build name is a cache beside a project file only; a file so named, `Build` and the node's `dist` are not.
			await mkdir(join(web, "build"));
			await mkdir(join(first.company, "notes/build"), { recursive: true });
			await writeFile(join(first.company, "notes/build/notes.html"), "<p>notes</p>\n");
			await writeFile(join(web, "target"), "a file\n");
			await mkdir(join(web, "Build"));
			await writeFile(join(web, "Build/x"), "x\n");
			await writeFile(join(web, "dist/new.js"), "new\n");
			// A boundary while a build still writes into its cache.
			const writing = await open(join(web, "build/app.js"), "w");
			await writing.write("let app;\n");
			const published = await first.publish();
			expect(published.code, published.out).toBe(0);
			await writing.write("app = 1;\n");
			await writing.close();
			expect(await readFile(join(web, "build/app.js"), "utf8")).toBe("let app;\napp = 1;\n");
			const ours = ["Build", "build", "dist", "node_modules", "package-lock.json", "package.json", "target"];
			expect((await readdir(web)).sort()).toEqual(ours);

			for (const cached of ["apps/web/node_modules", "apps/web/build", "apps/py/.venv", ".pnpm-store"])
				expect(held(at.core, cached), cached).toEqual([]);
			const files = ["package.json", "package-lock.json", "target", "Build/x", "dist/new.js"];
			for (const path of [...files.map((f) => `apps/web/${f}`), "notes/build/notes.html"])
				expect(at.core.entries.get(path)?.kind, path).toBe("file");
			expect(held(at.core, "apps/py")).toEqual(["apps/py"]);
			await at.service.poll();
			const there = join(second.company, "apps/web");
			const theirs = ["Build", "dist", "package-lock.json", "package.json", "target"];
			const listed = async () => (await readdir(there)).sort().join("/") === theirs.join("/");
			expect(await eventually(listed), second.output()).toBe(true);
			expect((await readdir(join(there, "dist"))).sort()).toEqual(["new.js", "old.js"]);
			expect(await readdir(join(second.company, "apps/py"))).toEqual([]);
			expect(await readdir(second.company)).not.toContain(".pnpm-store");
			expect(await readFile(join(second.company, "notes/build/notes.html"), "utf8")).toBe("<p>notes</p>\n");
		},
		TIMEOUT,
	);

	it(
		"the node's entry wins over a cache, and a folder's move or removal takes its caches along",
		async () => {
			const at = await area({ "apps/web/package.json": "{}\n", "notes/readme.md": "read me\n" });
			const first = await mountSession(at, "first");
			const second = await mountSession(at, "second");
			const web = join(first.company, "apps/web");
			await mkdir(join(web, "coverage"));
			await writeFile(join(web, "coverage/index.html"), "<p>covered</p>\n");
			// Another view publishes a file of the same name: the node's entry wins, and the cache goes.
			await writeFile(join(second.company, "apps/web/coverage"), "from the other view\n");
			const other = await second.publish();
			expect(other.code, other.out).toBe(0);
			await at.service.poll();
			const won = async () => (await readFile(join(web, "coverage"), "utf8")) === "from the other view\n";
			expect(await eventually(won), first.output()).toBe(true);
			expect((await readdir(web)).sort()).toEqual(["coverage", "package.json"]);

			// A folder holding a cache is not empty; moved, its cache goes along; removed, its cache goes too.
			const notes = join(first.company, "notes");
			await mkdir(join(notes, "sub/node_modules"), { recursive: true });
			await writeFile(join(notes, "sub/node_modules/x.js"), "x\n");
			await expect(rmdir(join(notes, "sub"))).rejects.toMatchObject({ code: "ENOTEMPTY" });
			const moved = await run("mv", [join(notes, "sub"), join(notes, "moved")]);
			expect(moved.code, moved.out).toBe(0);
			expect(await readFile(join(notes, "moved/node_modules/x.js"), "utf8")).toBe("x\n");
			expect((await readdir(notes)).sort()).toEqual(["moved", "readme.md"]);
			const removed = await run("rm", ["-r", join(notes, "moved")]);
			expect(removed.code, removed.out).toBe(0);
			const ours = await first.publish();
			expect(ours.code, ours.out).toBe(0);
			expect(held(at.core, "notes")).toEqual(["notes", "notes/readme.md"]);
			await mkdir(join(notes, "moved"));
			expect(await readdir(join(notes, "moved"))).toEqual([]);

			// Another view removes the folder a cache was in: the machine drops the cache when it lists the parent.
			await mkdir(join(notes, "gone/.venv"), { recursive: true });
			await writeFile(join(notes, "gone/.venv/pyvenv.cfg"), "home = /usr/bin\n");
			const made = await first.publish();
			expect(made.code, made.out).toBe(0);
			expect(held(at.core, "notes/gone")).toEqual(["notes/gone"]);
			await at.service.poll();
			const gone = join(second.company, "notes/gone");
			expect(await eventually(async () => (await readdir(gone)).length === 0), second.output()).toBe(true);
			await rmdir(gone);
			const dropped = await second.publish();
			expect(dropped.code, dropped.out).toBe(0);
			expect(held(at.core, "notes/gone")).toEqual([]);
			await at.service.poll();
			expect(await eventually(async () => !(await readdir(notes)).includes("gone")), first.output()).toBe(true);
			await mkdir(join(notes, "gone"));
			expect(await readdir(join(notes, "gone"))).toEqual([]);
		},
		TIMEOUT,
	);

	it(
		"a cache's file renamed into the folder is a save there, a file the session made renames into a cache, and links inside a cache work",
		async () => {
			const at = await area({ "notes/readme.md": "read me\n", "notes/lib/a.py": "A = 1\n" });
			const first = await mountSession(at, "first");
			const notes = join(first.company, "notes");
			const pkg = join(notes, "node_modules/pkg");
			await mkdir(pkg, { recursive: true });
			await writeFile(join(pkg, "index.js"), "cached\n");
			await rename(join(pkg, "index.js"), join(notes, "index.js"));
			// A build writes its output beside its place and renames it in.
			await writeFile(join(notes, "out.js"), "built\n");
			await rename(join(notes, "out.js"), join(pkg, "out.js"));
			expect((await readdir(notes)).sort()).toEqual(["index.js", "lib", "node_modules", "readme.md"]);
			expect(await readdir(pkg)).toEqual(["out.js"]);
			expect(await readFile(join(notes, "index.js"), "utf8")).toBe("cached\n");

			// Anything else crosses only as a copy: the folder's file, a folder, a hard link either way.
			const exdev = { code: "EXDEV" };
			await expect(rename(join(notes, "readme.md"), join(pkg, "readme.md"))).rejects.toMatchObject(exdev);
			await expect(rename(join(notes, "lib"), join(notes, ".venv"))).rejects.toMatchObject(exdev);
			await expect(link(join(pkg, "out.js"), join(notes, "out.js"))).rejects.toMatchObject(exdev);
			await expect(link(join(notes, "readme.md"), join(pkg, "readme.md"))).rejects.toMatchObject(exdev);
			await link(join(pkg, "out.js"), join(pkg, "same.js"));
			await symlink("pkg/out.js", join(notes, "node_modules/main.js"));
			for (const path of [join(pkg, "same.js"), join(notes, "node_modules/main.js")])
				expect(await readFile(path, "utf8")).toBe("built\n");

			// mv copies what it cannot rename.
			const moves = [
				[join(notes, "lib"), join(notes, ".venv")],
				[join(notes, "readme.md"), join(pkg, "readme.md")],
			];
			for (const [from, to] of moves) {
				const moved = await run("mv", [from!, to!]);
				expect(moved.code, moved.out).toBe(0);
			}
			const published = await first.publish();
			expect(published.code, published.out).toBe(0);
			expect(held(at.core, "notes")).toEqual(["notes", "notes/index.js"]);
			expect(await readFile(join(notes, ".venv/a.py"), "utf8")).toBe("A = 1\n");
			expect(await readFile(join(notes, "index.js"), "utf8")).toBe("cached\n");
			expect(await readFile(join(pkg, "readme.md"), "utf8")).toBe("read me\n");
			expect((await readdir(pkg)).sort()).toEqual(["out.js", "readme.md", "same.js"]);
		},
		TIMEOUT,
	);
});
