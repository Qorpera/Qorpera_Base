import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
	OFFICE,
	storeFile,
} from "./folder-service-fixtures.ts";

/** The machine's caches at the speed of a local disk (deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md "Speed"):
 * one project, its sources and many published files in the folder and its `node_modules` in a mount's caches, timed
 * against the same project on the plain disk under it. `QORPERA_FOLDER_MOUNT_BIN` is the program timed; with
 * `QORPERA_FOLDER_MOUNT_BIN_BEFORE` (a build of the program before the kernel cache) it is timed beside it. */
const program = process.env.QORPERA_FOLDER_MOUNT_BIN;
const before = process.env.QORPERA_FOLDER_MOUNT_BIN_BEFORE;
const repo = join(import.meta.dirname, "../../..");
const cleanup: (() => Promise<void> | void)[] = [];
const said: (() => string)[] = [];

afterEach(async (context) => {
	const shown = said.splice(0);
	if (context.task.result?.state === "fail") for (const lines of shown) console.log(lines());
	for (const done of cleanup.splice(0).reverse()) await done();
});

const TIMEOUT = 900_000;
const RUNS = 5;
/** How long the programs are timed idle. */
const IDLE_MS = 60_000;

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

interface Ran {
	readonly code: number | null;
	readonly out: string;
}

function start(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (data: Buffer) => {
		out += data.toString();
	});
	child.stderr.on("data", (data: Buffer) => {
		out += data.toString();
	});
	const done = new Promise<Ran>((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, out }));
	});
	return { child, done };
}

function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	return start(command, args, options).done;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PACKAGES = 30;
const FILES = 100;
/** The published files: `PUBLISHED` of `PUBLISHED_BYTES` each, in `proj/data`. */
const PUBLISHED = 2000;
const PUBLISHED_BYTES = 1024;
/** How many times each published file is read through its held fd. */
const HELD_READS = 10;

const PROJECT: Readonly<Record<string, string>> = {
	"proj/package.json": `${JSON.stringify({ name: "proj", private: true, type: "module" })}\n`,
	"proj/tsconfig.json": `${JSON.stringify({
		compilerOptions: {
			strict: true,
			noEmit: true,
			module: "nodenext",
			target: "es2022",
			types: ["node"],
			skipLibCheck: true,
		},
		include: ["src"],
	})}\n`,
	"proj/src/index.ts": [
		'import { readFileSync } from "node:fs";',
		'import * as ts from "typescript";',
		"",
		'export const size: number = ts.version.length + readFileSync("package.json").length;',
		"",
	].join("\n"),
	...Object.fromEntries(
		Array.from({ length: PUBLISHED }, (_, f) => [`proj/data/f${f}.txt`, `${f} `.padEnd(PUBLISHED_BYTES - 1, "x") + "\n"]),
	),
};

/** The project's `node_modules`, made once on the plain disk: typescript and node's types from the repository's own
 * install, and `PACKAGES` packages of `FILES` small modules each. */
async function nodeModules(at: string): Promise<void> {
	for (const name of ["typescript", "@types/node", "undici-types"])
		await cp(join(repo, "node_modules", name), join(at, name), { recursive: true });
	for (let p = 0; p < PACKAGES; p++) {
		const pkg = join(at, `pkg${p}`);
		await mkdir(join(pkg, "lib"), { recursive: true });
		await writeFile(join(pkg, "package.json"), `${JSON.stringify({ name: `pkg${p}`, main: "index.js" })}\n`);
		const requires = Array.from({ length: FILES }, (_, f) => `require("./lib/f${f}")`);
		await writeFile(join(pkg, "index.js"), `module.exports = [${requires.join(", ")}].length;\n`);
		for (let f = 0; f < FILES; f++)
			await writeFile(join(pkg, "lib", `f${f}.js`), `module.exports = ${f}; // ${"x".repeat(200)}\n`);
	}
}

/** The files under `dir` and their bytes. */
async function sizeOf(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		files++;
		bytes += (await stat(join(entry.parentPath, entry.name))).size;
	}
	return { files, bytes };
}

/** The folder service and the bridge, over a stand-in core holding `files` (path, content). */
async function area(files: Readonly<Record<string, string>>) {
	const base = await mkdtemp(join(tmpdir(), "qorpera-speed-e2e-"));
	cleanup.push(() => rm(base, { recursive: true, force: true }));
	const root = join(base, "share");
	const core = new FakeCore();
	let version = 1000;
	for (const [path, content] of Object.entries(files)) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (!core.entries.has(dir)) core.entries.set(dir, folder(dir, version++));
		}
		core.entries.set(path, await storeFile(root, path, Buffer.from(content), version++, 65536));
	}
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
	// The feed's heartbeat, without the rest of `start()`: a program whose feed is silent for 45 s drops it and
	// connects again, which would land in the timed runs.
	const beat = setInterval(() => service.heartbeat(), 15_000);
	cleanup.push(async () => {
		clearInterval(beat);
		for (const socket of sockets) socket.destroy();
		service.stop();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
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
	return { base, core, bridgeSocket };
}

type Area = Awaited<ReturnType<typeof area>>;

const VIEWS = [
	{ viewId: "5e6f7081-92a3-4b4c-8d5e-6f708192a3b4", pass: "cmdpass_0123456789-abcdefghijklmnopqrstuvwx" },
	{ viewId: "6f708192-a3b4-4c5d-8e6f-708192a3b4c5", pass: "cmdpass_1123456789-abcdefghijklmnopqrstuvwx" },
	{ viewId: "708192a3-b4c5-4d6e-8f70-8192a3b4c5d6", pass: "cmdpass_2123456789-abcdefghijklmnopqrstuvwx" },
	{ viewId: "8192a3b4-c5d6-4e7f-8081-92a3b4c5d6e7", pass: "cmdpass_3123456789-abcdefghijklmnopqrstuvwx" },
	{ viewId: "92a3b4c5-d6e7-4f80-8192-a3b4c5d6e7f8", pass: "cmdpass_4123456789-abcdefghijklmnopqrstuvwx" },
	{ viewId: "a3b4c5d6-e7f8-4081-9203-b4c5d6e7f809", pass: "cmdpass_5123456789-abcdefghijklmnopqrstuvwx" },
] as const;

interface Mount {
	readonly company: string;
	readonly pid: number;
	readonly output: () => string;
}

/** A shell command's view of the folder, mounted by `bin` with `extra` options. */
async function mountView(
	at: Area,
	which: number,
	bin: string,
	extra: readonly string[],
	env: Record<string, string> = {},
): Promise<Mount> {
	const { viewId, pass } = VIEWS[which]!;
	at.core.openView(viewId, pass, { kind: "computer_shell_command", machineId: ALLOCATION });
	const name = `view${which}`;
	const dir = join(at.base, name);
	const company = join(dir, "company");
	await mkdir(company, { recursive: true });
	const viewFile = join(dir, "view.json");
	await writeFile(viewFile, JSON.stringify({ environmentId: ENV, viewId, pass }), { mode: 0o600 });
	let output = "";
	const child = spawn(
		bin,
		[
			"mount",
			"--view-file",
			viewFile,
			"--state-dir",
			join(dir, "state"),
			"--mountpoint",
			company,
			"--connect",
			`unix:${at.bridgeSocket}`,
			"--threads",
			"4",
			...extra,
		],
		{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
	);
	const collect = (data: Buffer): void => {
		output += data.toString();
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	said.push(() => `${name}:\n${output}`);
	const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await exited;
		}
		if (await mounted(company)) await run("umount", ["-l", company]);
	});
	expect(await eventually(() => mounted(company), 10_000), output).toBe(true);
	return { company, pid: child.pid!, output: () => output };
}

/** A cache folder for `--cache-dir`: one only this account can use. */
async function cacheDir(at: Area, name: string): Promise<string> {
	const dir = join(at.base, name);
	await mkdir(dir, { mode: 0o700 });
	return dir;
}

/** The CPU time a process has used so far, in milliseconds (`/proc/<pid>/stat`: utime and stime, in clock ticks). */
async function cpuOf(pid: number): Promise<number> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
}

/** One timed run: its wall time, the CPU the command used and the bytes it read (its own report at exit), and the CPU
 * the folder program used meanwhile. */
interface Timed {
	readonly wallMs: number;
	readonly cpuMs: number;
	readonly readBytes: number;
	readonly programMs: number;
}

async function timed(probe: string, args: readonly string[], cwd: string, programPid?: number): Promise<Timed> {
	const cpuBefore = programPid ? await cpuOf(programPid) : 0;
	const began = process.hrtime.bigint();
	const ran = await run(process.execPath, ["--require", probe, ...args], { cwd });
	const wallMs = Number(process.hrtime.bigint() - began) / 1e6;
	const programMs = programPid ? (await cpuOf(programPid)) - cpuBefore : 0;
	const report = /^SPEED (.*)$/m.exec(ran.out);
	if (ran.code !== 0 || !report) throw new Error(`${args.join(" ")} exited ${ran.code}: ${ran.out}`);
	const used = JSON.parse(report[1]!) as { user: number; system: number; rchar: number };
	return { wallMs, cpuMs: (used.user + used.system) / 1000, readBytes: used.rchar, programMs };
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** A script in the area, run by `node` with absolute paths from a folder off the mounts. */
async function script(at: Area, name: string, lines: readonly string[]): Promise<string> {
	const path = join(at.base, name);
	await writeFile(path, [...lines, ""].join("\n"));
	return path;
}

/** Where a workload runs: the project's root there, the folder program serving it, and what runs beside it. */
interface Place {
	readonly name: string;
	readonly root: string;
	readonly pid?: number;
	/** Started before each run and stopped after it: answers how many changes it made a second. */
	readonly beside?: () => { stop: () => Promise<number> };
}

describe.skipIf(!program)("the machine's caches at the speed of a local disk", () => {
	it(
		"times tsc, a load of small modules and reads of published files on the plain disk and on mounts, then idle mounts",
		async () => {
			const at = await area(PROJECT);
			// What each run reports at its end: its CPU and the bytes it read.
			const probe = await script(at, "probe.cjs", [
				'process.on("exit", () => {',
				"\tconst used = process.resourceUsage();",
				'\tconst io = require("node:fs").readFileSync("/proc/self/io", "utf8");',
				"\tconst rchar = Number(/rchar: (\\d+)/.exec(io)[1]);",
				'\tprocess.stderr.write("SPEED " + JSON.stringify({ user: used.userCPUTime, system: used.systemCPUTime, rchar }) + "\\n");',
				"});",
			]);
			const made = join(at.base, "node_modules");
			await nodeModules(made);
			const size = await sizeOf(made);
			// The plain disk: the same project beside the mounts' state, on the disk their caches are on.
			const plain = join(at.base, "plain");
			for (const [path, content] of Object.entries(PROJECT)) {
				await mkdir(join(plain, dirname(path)), { recursive: true });
				await writeFile(join(plain, path), content);
			}
			await cp(made, join(plain, "proj/node_modules"), { recursive: true });
			// The mounts: before the kernel cache (its own caches); the program with its kernel cache turned off as on a kernel
			// without the epoch (the fallback) and on, each alone on a cache folder; and three on one cache folder.
			const mounts: { name: string; mount: Mount; kernel?: "on" | "off"; copy: boolean }[] = [];
			if (before) mounts.push({ name: "before (MC2b)", mount: await mountView(at, 0, before, []), copy: true });
			const offDir = await cacheDir(at, "caches-off");
			const offSwitch = { QORPERA_FOLDER_TEST_KERNEL_OFF: "timed without it" };
			mounts.push({
				name: "kernel cache off",
				mount: await mountView(at, 1, program!, ["--cache-dir", offDir], offSwitch),
				kernel: "off",
				copy: true,
			});
			const onDir = await cacheDir(at, "caches-on");
			mounts.push({
				name: "kernel cache",
				mount: await mountView(at, 2, program!, ["--cache-dir", onDir]),
				kernel: "on",
				copy: true,
			});
			const sharedDir = await cacheDir(at, "caches-shared");
			for (const [i, which] of [3, 4, 5].entries())
				mounts.push({
					name: `3 on one cache folder: ${"ABC"[i]}`,
					mount: await mountView(at, which, program!, ["--cache-dir", sharedDir]),
					kernel: "on",
					copy: i === 0,
				});
			const offLine = "kernel cache off: timed without it (test switch)";
			for (const { mount, kernel } of mounts) {
				if (!kernel) continue;
				const line = kernel === "on" ? "kernel cache on" : offLine;
				expect(await eventually(async () => mount.output().includes(line)), mount.output()).toBe(true);
			}
			for (const { mount, copy } of mounts) {
				if (!copy) continue;
				// `cp` runs outside the mount: a spawn's own chdir onto it would wait for the service in this process.
				const copied = await run("cp", ["-r", made, join(mount.company, "proj/node_modules")], { cwd: at.base });
				expect(copied.code, copied.out).toBe(0);
			}
			const find = (name: string) => mounts.find((m) => m.name === name)?.mount;
			const [a, b] = [find("3 on one cache folder: A")!, find("3 on one cache folder: B")!];
			expect(await eventually(async () => (await readdir(join(b.company, "proj/node_modules"))).includes("pkg0"))).toBe(
				true,
			);
			// The programs' places, and B's load while A makes and removes names in the node_modules they share.
			const placeOf = (m: Mount, name: string): Place => ({ name, root: m.company, pid: m.pid });
			const plainPlace: Place = { name: "plain disk", root: plain };
			const beforePlace = before ? [placeOf(find("before (MC2b)")!, "before (MC2b)")] : [];
			const offPlace = placeOf(find("kernel cache off")!, "kernel cache off (fall-back), alone");
			const onPlace = placeOf(find("kernel cache")!, "kernel cache, alone");
			const churn = await script(at, "churn.cjs", [
				'const fs = require("node:fs");',
				"const dir = process.argv[2];",
				"let n = 0;",
				"let stop = false;",
				'process.on("SIGTERM", () => { stop = true; });',
				"const start = Date.now();",
				"(function batch() {",
				'\tfor (let i = 0; i < 50; i++, n++) { const f = dir + "/.churn" + (n % 64); fs.writeFileSync(f, ""); fs.unlinkSync(f); }',
				'\tif (!stop) return setImmediate(batch);',
				'\tprocess.stdout.write("CHURN " + (n / ((Date.now() - start) / 1000)) + "\\n");',
				"})();",
			]);
			const busyPeer: Place = {
				...placeOf(b, "kernel cache, B: A makes and removes names in its node_modules"),
				beside: () => {
					const started = start(process.execPath, [churn, join(a.company, "proj/node_modules")], { cwd: at.base });
					return {
						stop: async () => {
							started.child.kill("SIGTERM");
							const ran = await started.done;
							const rate = /^CHURN (.*)$/m.exec(ran.out);
							if (ran.code !== 0 || !rate) throw new Error(`churn exited ${ran.code}: ${ran.out}`);
							return Number(rate[1]);
						},
					};
				},
			};
			const loader = await script(at, "load.cjs", [
				'const { createRequire } = require("node:module");',
				"const project = process.argv[2];",
				'const load = createRequire(require("node:path").join(project, "package.json"));',
				"let n = 0;",
				`for (let p = 0; p < ${PACKAGES}; p++) n += load("pkg" + p);`,
				`if (n !== ${PACKAGES * FILES}) throw new Error("loaded " + n);`,
			]);
			const statRead = await script(at, "stat-read.cjs", [
				'const fs = require("node:fs");',
				'const data = require("node:path").join(process.argv[2], "data");',
				"let bytes = 0;",
				`for (let f = 0; f < ${PUBLISHED}; f++) {`,
				'\tconst file = data + "/f" + f + ".txt";',
				"\tif (fs.statSync(file).size !== " + PUBLISHED_BYTES + ') throw new Error("size of " + file);',
				"\tbytes += fs.readFileSync(file).length;",
				"}",
				`if (bytes !== ${PUBLISHED * PUBLISHED_BYTES}) throw new Error("read " + bytes);`,
			]);
			const heldReads = await script(at, "held-reads.cjs", [
				'const fs = require("node:fs");',
				'const data = require("node:path").join(process.argv[2], "data");',
				`const fds = Array.from({ length: ${PUBLISHED} }, (_, f) => fs.openSync(data + "/f" + f + ".txt", "r"));`,
				`const buffer = Buffer.alloc(${PUBLISHED_BYTES});`,
				"let bytes = 0;",
				`for (let r = 0; r < ${HELD_READS}; r++) for (const fd of fds) bytes += fs.readSync(fd, buffer, 0, buffer.length, 0);`,
				`if (bytes !== ${HELD_READS * PUBLISHED * PUBLISHED_BYTES}) throw new Error("read " + bytes);`,
			]);
			const workloads = [
				{
					name: "tsc --noEmit",
					args: (root: string) => [
						join(root, "proj/node_modules/typescript/bin/tsc"),
						"-p",
						join(root, "proj/tsconfig.json"),
					],
					places: [plainPlace, ...beforePlace, offPlace, onPlace],
				},
				{
					name: `load ${PACKAGES * FILES} small modules`,
					args: (root: string) => [loader, join(root, "proj")],
					places: [
						plainPlace,
						...beforePlace,
						offPlace,
						onPlace,
						placeOf(b, "kernel cache, B: 2 idle peers on its cache folder"),
					],
				},
				{
					// A pass of its own: what A's changes drop of B's kernel holds is not in the idle peers' runs.
					name: `load ${PACKAGES * FILES} small modules while A makes and removes names`,
					args: (root: string) => [loader, join(root, "proj")],
					places: [plainPlace, ...beforePlace, busyPeer],
				},
				{
					name: `stat + read ${PUBLISHED} published files`,
					args: (root: string) => [statRead, join(root, "proj")],
					places: [plainPlace, ...beforePlace, onPlace],
				},
				{
					name: `${HELD_READS} reads of ${PUBLISHED} published files through held fds`,
					args: (root: string) => [heldReads, join(root, "proj")],
					places: [plainPlace, ...beforePlace, onPlace],
				},
			];
			const rows: string[] = [];
			const rates: number[] = [];
			for (const work of workloads) {
				const results = new Map<string, Timed[]>(work.places.map((p) => [p.name, []]));
				// One run each to warm up, then the runs taken, the places in turn so a slow moment hits them all.
				for (let r = 0; r <= RUNS; r++)
					for (const place of work.places) {
						const beside = place.beside?.();
						if (beside) await sleep(200);
						const one = await timed(probe, work.args(place.root), at.base, place.pid);
						const rate = await beside?.stop();
						if (r > 0) results.get(place.name)!.push(one);
						if (r > 0 && rate !== undefined) rates.push(rate);
					}
				const plainWall = median(results.get(plainPlace.name)!.map((t) => t.wallMs));
				for (const place of work.places) {
					const all = results.get(place.name)!;
					const wall = median(all.map((t) => t.wallMs));
					rows.push(
						`| ${work.name} | ${place.name} | ${wall.toFixed(0)} | ${(wall / plainWall).toFixed(2)} | ${median(all.map((t) => t.cpuMs)).toFixed(0)} | ${median(all.map((t) => t.programMs)).toFixed(0)} | ${median(all.map((t) => t.readBytes))} |`,
					);
				}
			}
			// Idle: each program's CPU over a minute in which nothing uses the mounts.
			await sleep(2_000);
			const idleFrom = await Promise.all(mounts.map(({ mount }) => cpuOf(mount.pid)));
			await sleep(IDLE_MS);
			const idleTo = await Promise.all(mounts.map(({ mount }) => cpuOf(mount.pid)));
			// No program fell back or lost its feed on the way.
			for (const { mount, kernel } of mounts) {
				if (kernel) expect(mount.output().replace(offLine, ""), mount.output()).not.toContain("kernel cache off");
				expect(mount.output(), mount.output()).not.toContain("feed lost");
			}
			console.log(
				[
					`node_modules: ${size.files} files, ${size.bytes} bytes; ${PUBLISHED} published files of ${PUBLISHED_BYTES} bytes; median of ${RUNS} runs after one warm-up`,
					"| Workload | Where | Wall ms | × plain | Process CPU ms | Folder program CPU ms | Bytes read |",
					"|---|---|---|---|---|---|---|",
					...rows,
					`A made and removed ${median(rates).toFixed(0)} names a second during B's runs (median)`,
					`| Program | CPU ms in ${IDLE_MS / 1000} s idle |`,
					"|---|---|",
					...mounts.map(({ name }, i) => `| ${name} | ${(idleTo[i]! - idleFrom[i]!).toFixed(0)} |`),
				]
					.map((line) => `SPEED-TABLE ${line}`)
					.join("\n"),
			);
		},
		TIMEOUT,
	);
});
