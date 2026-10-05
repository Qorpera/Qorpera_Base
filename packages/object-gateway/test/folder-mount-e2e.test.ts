/** The node's folder service and the machine's folder program together: this package's service over a Unix
 * socket, and the Rust program mounting it for real. A small stand-in for the vsock bridge sits between them and
 * names the machine's CID. Needs the built program, root and /dev/fuse, so it runs only when
 * QORPERA_FOLDER_MOUNT_BIN names the program (the run-on-node step "folder-program" does, in a container). */
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
	BRIDGE,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	grants,
	hashOf,
	PASS,
	storeFile,
	writableGrants,
} from "./folder-service-fixtures.ts";

const program = process.env.QORPERA_FOLDER_MOUNT_BIN;
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

async function eventually(check: () => Promise<boolean>, limitMs = 3_000): Promise<boolean> {
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

describe.skipIf(!program)("folder program against the folder service", () => {
	it("mounts the view, reads it, follows changes and access, and unmounts on SIGTERM", async () => {
		const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-e2e-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "share");
		const core = new FakeCore();
		core.seed([
			folder("docs"),
			await storeFile(root, "docs/plan.md", "the plan, version one", 1),
			await storeFile(root, "readme.md", "hi", 1),
			folder("private"),
			await storeFile(root, "private/salary.md", "secret", 1),
			await storeFile(root, "big.bin", "x".repeat(3 * 1024 * 1024 + 7), 1, 1024 * 1024),
		]);
		const service = new FolderService({
			core,
			objects: new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 }),
			grants: grants(),
			log: () => {},
		});
		const serviceSocket = join(dir, "service.sock");
		const server = createFolderServer(service, () => {});
		await listen(server, serviceSocket);
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		// The bridge's part: name the machine, then pass bytes through.
		const bridgeSocket = join(dir, "bridge.sock");
		const bridge = createServer((machine) => {
			const upstream = connect(serviceSocket, () => {
				upstream.write(encodeJson(Kind.bridge, BRIDGE));
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

		const viewFile = join(dir, "view.json");
		await writeFile(viewFile, JSON.stringify({ environmentId: ENV, viewId: "proof", pass: PASS }), { mode: 0o600 });
		await chmod(viewFile, 0o600);
		const company = join(dir, "company");
		await mkdir(company);
		let output = "";
		const child: ChildProcess = spawn(
			program!,
			[
				"mount",
				"--view-file",
				viewFile,
				"--mountpoint",
				company,
				"--connect",
				`unix:${bridgeSocket}`,
				"--threads",
				"4",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const collect = (d: Buffer): void => {
			output += d.toString();
		};
		child.stdout!.on("data", collect);
		child.stderr!.on("data", collect);
		const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
		cleanup.push(async () => {
			if (child.exitCode === null) child.kill("SIGKILL");
			if (await mounted(company)) spawn("umount", ["-l", company]);
		});

		expect(await eventually(() => mounted(company)), output).toBe(true);
		expect((await readdir(company)).sort()).toEqual(["big.bin", "docs", "private", "readme.md"]);
		expect(await readFile(join(company, "docs/plan.md"), "utf8")).toBe("the plan, version one");
		const big = await readFile(join(company, "big.bin"));
		expect(big.byteLength).toBe(3 * 1024 * 1024 + 7);
		expect(big.every((b) => b === 0x78)).toBe(true);
		expect((await stat(join(company, "readme.md"))).mode & 0o777).toBe(0o444);

		// A member's edit reaches the mount within one poll of the clock.
		core.write(await storeFile(root, "docs/plan.md", "the plan, version two", 2));
		const edited = Date.now();
		await service.poll();
		expect(
			await eventually(
				async () => (await readFile(join(company, "docs/plan.md"), "utf8")) === "the plan, version two",
			),
		).toBe(true);
		expect(Date.now() - edited).toBeLessThan(1_000);

		// A folder taken away disappears.
		core.authority((p) => p === "private" || p.startsWith("private/"));
		await service.poll();
		await service.settled();
		expect(await eventually(async () => !(await readdir(company)).includes("private"))).toBe(true);
		await expect(readFile(join(company, "private/salary.md"))).rejects.toMatchObject({ code: "ENOENT" });

		child.kill("SIGTERM");
		expect(await exited).toBe(0);
		expect(await mounted(company)).toBe(false);
	}, 30_000);

	it("writes through a writable mount, publishes what may go, and keeps stale saves after a service restart as conflicts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-e2e-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const root = join(dir, "share");
		const BIG = 4 * 1024 * 1024;
		const core = new FakeCore();
		core.seed([
			folder("docs"),
			await storeFile(root, "docs/plan.md", "plan one", 1, BIG),
			await storeFile(root, "docs/other.md", "other one", 1, BIG),
			folder("reports"),
			await storeFile(root, "reports/q1.md", "q1 one", 1, BIG),
		]);
		const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
		const uploads = new FakeUploads(root, core);
		const serviceSocket = join(dir, "service.sock");
		// The service, started again on demand: what was pending goes with it, as on a node's restart.
		let service: FolderService;
		let server: Server;
		const sockets = new Set<Socket>();
		const startService = async (): Promise<void> => {
			service = new FolderService({
				core,
				objects,
				grants: writableGrants(),
				staging: new FolderStaging(core, uploads, objects),
				log: () => {},
			});
			server = createFolderServer(service, () => {});
			server.on("connection", (socket) => {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
			});
			await listen(server, serviceSocket);
		};
		const stopService = async (): Promise<void> => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			service.stop();
		};
		await startService();
		cleanup.push(stopService);
		const bridgeSocket = join(dir, "bridge.sock");
		const bridge = createServer((machine) => {
			const upstream = connect(serviceSocket, () => {
				upstream.write(encodeJson(Kind.bridge, BRIDGE));
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

		const viewFile = join(dir, "view.json");
		await writeFile(viewFile, JSON.stringify({ environmentId: ENV, viewId: "proof", pass: PASS }), { mode: 0o600 });
		await chmod(viewFile, 0o600);
		const company = join(dir, "company");
		await mkdir(company);
		let output = "";
		const child: ChildProcess = spawn(
			program!,
			[
				"mount",
				"--view-file",
				viewFile,
				"--mountpoint",
				company,
				"--connect",
				`unix:${bridgeSocket}`,
				"--threads",
				"4",
				"--state-dir",
				join(dir, "state"),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		child.stdout!.on("data", (d: Buffer) => {
			output += d.toString();
		});
		child.stderr!.on("data", (d: Buffer) => {
			output += d.toString();
		});
		const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
		cleanup.push(async () => {
			if (child.exitCode === null) child.kill("SIGKILL");
			if (await mounted(company)) spawn("umount", ["-l", company]);
		});
		/** `qorpera-folder publish`: its exit code and what it printed. */
		const publish = (): Promise<{ code: number | null; text: string }> =>
			new Promise((resolve) => {
				let text = "";
				const run = spawn(program!, ["publish", "--view-file", viewFile, "--connect", `unix:${bridgeSocket}`], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				run.stdout!.on("data", (d: Buffer) => {
					text += d.toString();
				});
				run.stderr!.on("data", (d: Buffer) => {
					text += d.toString();
				});
				run.on("exit", (code) => resolve({ code, text }));
			});

		expect(await eventually(() => mounted(company)), output).toBe(true);
		expect((await stat(join(company, "docs/plan.md"))).mode & 0o777).toBe(0o644);

		// A new file: there at once, published when the machine asks.
		await writeFile(join(company, "docs/new.md"), "hello");
		expect(await readFile(join(company, "docs/new.md"), "utf8")).toBe("hello");
		expect(core.entries.has("docs/new.md")).toBe(false);
		let published = await publish();
		expect(published, output).toMatchObject({ code: 0 });
		expect(published.text).toMatch(/saved\s+docs\/new\.md/);
		expect(core.entries.get("docs/new.md")).toMatchObject({
			fileSha256: hashOf("hello"),
			mediaType: "text/markdown",
		});

		// A file still open for writing is left out of a boundary, and goes with the next one after its close.
		const held = await open(join(company, "docs/open.md"), "w");
		await held.write("held open");
		published = await publish();
		expect(published.code, published.text + output).toBe(4);
		expect(published.text).toMatch(/waiting\s+docs\/open\.md\s+\(still open for writing/);
		expect(core.entries.has("docs/open.md")).toBe(false);
		await held.close();
		published = await publish();
		expect(published, output).toMatchObject({ code: 0 });
		expect(published.text).toMatch(/saved\s+docs\/open\.md/);
		expect(core.entries.get("docs/open.md")?.fileSha256).toBe(hashOf("held open"));

		// Lock, swap and backup names stay in this view, unpublished; a published path cannot go there.
		await writeFile(join(company, "docs/.~lock.plan.md#"), "locked");
		await writeFile(join(company, "docs/.plan.md.swp"), "swap");
		published = await publish();
		expect(published, output).toMatchObject({ code: 0 });
		expect(published.text).toMatch(/nothing to publish/);
		expect([...core.entries.keys()].filter((p) => p.startsWith("docs/."))).toEqual([]);
		expect(await readFile(join(company, "docs/.~lock.plan.md#"), "utf8")).toBe("locked");
		await expect(rename(join(company, "docs/other.md"), join(company, "docs/other.md~"))).rejects.toMatchObject({
			code: "EXDEV",
		});

		// A folder moved here, a file in it read at its new path and saved in place: the move publishes first and gives
		// the file a new version, and the save is based on that one, not taken for a stale one.
		await rename(join(company, "reports"), join(company, "archive"));
		expect(await readFile(join(company, "archive/q1.md"), "utf8")).toBe("q1 one");
		await writeFile(join(company, "archive/q1.md"), "q1 mine");
		published = await publish();
		expect(published, published.text + output).toMatchObject({ code: 0 });
		expect(published.text).toMatch(/saved\s+archive\/q1\.md/);
		expect(core.entries.has("reports/q1.md")).toBe(false);
		expect(core.entries.get("archive/q1.md")?.fileSha256).toBe(hashOf("q1 mine"));

		// Two editors read their files (the version map takes version one of each); then the node's service restarts,
		// and another machine saves both meanwhile.
		expect(await readFile(join(company, "docs/plan.md"), "utf8")).toBe("plan one");
		expect(await readFile(join(company, "docs/other.md"), "utf8")).toBe("other one");
		await stopService();
		await startService();
		core.write(await storeFile(root, "docs/plan.md", "plan theirs", 2, BIG));
		core.write(await storeFile(root, "docs/other.md", "other theirs", 2, BIG));
		// One saves in place, the other through a temporary file renamed over: both are based on what they read.
		expect(
			await eventually(async () => {
				await writeFile(join(company, "docs/plan.md"), "plan mine");
				return true;
			}, 10_000),
			output,
		).toBe(true);
		await writeFile(join(company, "docs/.other.md.tmp"), "other mine");
		await rename(join(company, "docs/.other.md.tmp"), join(company, "docs/other.md"));
		published = await publish();
		expect(published.code, published.text + output).toBe(4);
		expect(published.text).toMatch(/conflict\s+docs\/plan\.md/);
		expect(published.text).toMatch(/conflict\s+docs\/other\.md/);
		// The other machine's versions stay; this machine's are kept on the receipt, and the mount shows the live ones.
		expect(core.entries.get("docs/plan.md")?.fileSha256).toBe(hashOf("plan theirs"));
		expect(core.entries.get("docs/other.md")?.fileSha256).toBe(hashOf("other theirs"));
		expect(core.entries.has("docs/.other.md.tmp")).toBe(false);
		expect(
			await eventually(async () => (await readFile(join(company, "docs/plan.md"), "utf8")) === "plan theirs", 5_000),
		).toBe(true);

		child.kill("SIGTERM");
		expect(await exited).toBe(0);
	}, 60_000);
});
