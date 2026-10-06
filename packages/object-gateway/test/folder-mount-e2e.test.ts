/** The node's folder service and the machine's folder program together: this package's service over a Unix
 * socket, and the Rust program mounting it for real. A small stand-in for the vsock bridge sits between them and
 * names the machine's CID. Needs the built program, root and /dev/fuse, so it runs only when
 * QORPERA_FOLDER_MOUNT_BIN names the program (the run-on-node step "folder-program" does, in a container). */
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NasObjects } from "../src/folder-service/objects.ts";
import { encodeJson, Kind } from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService } from "../src/folder-service/service.ts";
import { BRIDGE, ENV, FakeCore, folder, grants, PASS, storeFile } from "./folder-service-fixtures.ts";

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
});
