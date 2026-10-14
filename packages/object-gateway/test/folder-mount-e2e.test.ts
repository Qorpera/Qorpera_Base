/** The node's folder service and the machine's folder program together: this package's service over a Unix
 * socket, and the Rust program mounting it for real. A small stand-in for the vsock bridge sits between them and
 * names the machine's CID. Needs the built program, root and /dev/fuse, so it runs only when
 * QORPERA_FOLDER_MOUNT_BIN names the program (the run-on-node step "folder-program" does, in a container). */
import { type ChildProcess, spawn } from "node:child_process";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NasObjects } from "../src/folder-service/objects.ts";
import { encodeFrame, encodeJson, FrameReader, Kind } from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	BRIDGE,
	companyGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	grants,
	hashOf,
	OFFICE,
	PASS,
	storeFile,
	v,
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
			await storeFile(root, "docs/empty-in-place.md", "", 1, BIG),
			await storeFile(root, "docs/empty-rename.md", "", 1, BIG),
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
				const run = spawn(
					program!,
					[
						"publish",
						"--view-file",
						viewFile,
						"--state-dir",
						join(dir, "state"),
						"--connect",
						`unix:${bridgeSocket}`,
					],
					{
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
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

		// A file this mount saved, then renamed, then saved again: the version map takes its save's version to the new
		// name, and the save there is based on what the move published.
		await writeFile(join(company, "docs/new.md"), "hello again");
		await rename(join(company, "docs/new.md"), join(company, "docs/renamed.md"));
		await appendFile(join(company, "docs/renamed.md"), " and more");
		published = await publish();
		expect(published, published.text + output).toMatchObject({ code: 0 });
		expect(published.text).toMatch(/saved\s+docs\/renamed\.md/);
		expect(core.entries.has("docs/new.md")).toBe(false);
		expect(core.entries.get("docs/renamed.md")?.fileSha256).toBe(hashOf("hello again and more"));

		// Editors read their files (the version map takes version one of each); then the node's service restarts,
		// and another machine saves them meanwhile.
		expect(await readFile(join(company, "docs/plan.md"), "utf8")).toBe("plan one");
		expect(await readFile(join(company, "docs/other.md"), "utf8")).toBe("other one");
		// Empty content is an observation too, even when the kernel answers EOF without a FUSE read.
		expect(await readFile(join(company, "docs/empty-in-place.md"), "utf8")).toBe("");
		expect(await readFile(join(company, "docs/empty-rename.md"), "utf8")).toBe("");
		await stopService();
		await startService();
		core.write(await storeFile(root, "docs/plan.md", "plan theirs", 2, BIG));
		core.write(await storeFile(root, "docs/other.md", "other theirs", 2, BIG));
		core.write(await storeFile(root, "docs/empty-in-place.md", "empty in-place theirs", 2, BIG));
		core.write(await storeFile(root, "docs/empty-rename.md", "empty rename theirs", 2, BIG));
		// Let the newer sizes reach the kernel without reading their content into the version map.
		expect(
			await eventually(async () => (await stat(join(company, "docs/empty-in-place.md"))).size > 0, 10_000),
			output,
		).toBe(true);
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
		await writeFile(join(company, "docs/empty-in-place.md"), "empty in-place mine");
		await writeFile(join(company, "docs/.empty-rename.md.tmp"), "empty rename mine");
		await rename(join(company, "docs/.empty-rename.md.tmp"), join(company, "docs/empty-rename.md"));
		published = await publish();
		expect(published.code, published.text + output).toBe(4);
		expect(published.text).toMatch(/conflict\s+docs\/plan\.md/);
		expect(published.text).toMatch(/conflict\s+docs\/other\.md/);
		expect(published.text).toMatch(/conflict\s+docs\/empty-in-place\.md/);
		expect(published.text).toMatch(/conflict\s+docs\/empty-rename\.md/);
		// The other machine's versions stay; this machine's are kept on the receipt, and the mount shows the live ones.
		expect(core.entries.get("docs/plan.md")?.fileSha256).toBe(hashOf("plan theirs"));
		expect(core.entries.get("docs/other.md")?.fileSha256).toBe(hashOf("other theirs"));
		expect(core.entries.has("docs/.other.md.tmp")).toBe(false);
		expect(core.entries.get("docs/empty-in-place.md")?.fileSha256).toBe(hashOf("empty in-place theirs"));
		expect(core.entries.get("docs/empty-rename.md")?.fileSha256).toBe(hashOf("empty rename theirs"));
		expect(core.entries.has("docs/.empty-rename.md.tmp")).toBe(false);
		const copies = [...core.copies.values()].flat();
		for (const path of ["docs/empty-in-place.md", "docs/empty-rename.md"]) {
			const copy = copies.find((copy) => copy.path === path);
			expect(copy, path).toBeDefined();
			const unit = core.commits
				.flatMap((commit) => commit.units)
				.find((unit) => unit.op === "write" && unit.path === path);
			expect(unit?.op).toBe("write");
			if (unit?.op === "write") expect(copy?.manifestSha256).toBe(unit.file.manifestSha256);
		}
		expect(
			await eventually(async () => (await readFile(join(company, "docs/plan.md"), "utf8")) === "plan theirs", 5_000),
		).toBe(true);

		child.kill("SIGTERM");
		expect(await exited).toBe(0);
	}, 60_000);
});

/** A real program and service on a core view, with only the database and object store replaced. Frame interception
 * models a link losing an acknowledgement after the service took the log; no mount internals are called. */
const CORE_PASS = "readpass_0123456789-abcdefghijklmnopqrstuvw";

async function loggedMount(kind = "computer_shell_command") {
	const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-log-e2e-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const root = join(dir, "share");
	const core = new FakeCore();
	core.seed([
		folder("docs"),
		await storeFile(root, "docs/plan.md", "the plan", 1),
		await storeFile(root, "docs/empty.md", "", 1),
	]);
	const viewId = v(700);
	const receipt = { resourceId: v(60), resourceRevision: 9, grantId: v(61), grantRevision: 2 };
	core.receipts = () => receipt;
	core.openView(viewId, CORE_PASS, { kind, machineId: ALLOCATION });
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const serviceSocket = join(dir, "service.sock");
	const sockets = new Set<Socket>();
	let service: FolderService;
	let server: Server;
	let running = false;
	const start = async (): Promise<void> => {
		service = new FolderService({
			core,
			objects,
			grants: companyGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => {},
		});
		server = createFolderServer(service, () => {});
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		await listen(server, serviceSocket);
		running = true;
	};
	const stop = async (): Promise<void> => {
		if (!running) return;
		running = false;
		service.stop();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	await start();
	cleanup.push(stop);
	const bridgeSocket = join(dir, "bridge.sock");
	const faults = { dropReadAnswer: false, dropReport: false, dropPollAnswer: false };
	const requests: { kind: number; body: unknown }[] = [];
	const bridge = createServer((machine) => {
		const incoming = new FrameReader();
		const outgoing = new FrameReader();
		const upstream = connect(serviceSocket, () => {
			upstream.write(encodeJson(Kind.bridge, { cid: 90, lookup: "found", machine: OFFICE }));
			machine.on("data", (data: Buffer) => {
				for (const frame of incoming.push(data))
					if (frame.kind !== Kind.chunk && frame.kind !== Kind.hello)
						requests.push({ kind: frame.kind, body: JSON.parse(frame.payload.toString()) });
			});
			machine.pipe(upstream);
		});
		upstream.on("data", (data: Buffer) => {
			for (const frame of outgoing.push(data)) {
				if (
					(frame.kind === Kind.readsOk && faults.dropReadAnswer) ||
					(frame.kind === Kind.report && faults.dropReport)
				) {
					faults.dropReadAnswer = false;
					faults.dropReport = false;
					machine.destroy();
					upstream.destroy();
					return;
				}
				if (frame.kind === Kind.report && faults.dropPollAnswer) {
					faults.dropPollAnswer = false;
					faults.dropReadAnswer = true;
				}
				machine.write(encodeFrame(frame.kind, frame.payload));
			}
		});
		machine.on("error", () => upstream.destroy());
		upstream.on("error", () => machine.destroy());
		machine.on("close", () => upstream.destroy());
		upstream.on("close", () => machine.destroy());
	});
	await listen(bridge, bridgeSocket);
	cleanup.push(() => new Promise<void>((resolve) => bridge.close(() => resolve())));
	const viewFile = join(dir, "view.json");
	const state = join(dir, "state");
	const company = join(dir, "company");
	await writeFile(viewFile, JSON.stringify({ environmentId: ENV, viewId, pass: CORE_PASS }), { mode: 0o600 });
	await mkdir(company);
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
			`unix:${bridgeSocket}`,
			"--threads",
			"4",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout.on("data", (data: Buffer) => {
		output += data.toString();
	});
	child.stderr.on("data", (data: Buffer) => {
		output += data.toString();
	});
	const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
	const kill = async (): Promise<void> => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		if (await mounted(company))
			await new Promise<void>((resolve) => spawn("umount", ["-l", company]).on("exit", () => resolve()));
	};
	cleanup.push(kill);
	expect(await eventually(() => mounted(company)), output).toBe(true);
	const publish = (
		final = false,
		stateDir = state,
	): Promise<{ code: number | null; stdout: string; stderr: string }> =>
		new Promise((resolve) => {
			const run = spawn(
				program!,
				[
					"publish",
					"--view-file",
					viewFile,
					"--state-dir",
					stateDir,
					"--connect",
					`unix:${bridgeSocket}`,
					"--json",
					...(final ? ["--final"] : []),
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			run.stdout.on("data", (data: Buffer) => {
				stdout += data.toString();
			});
			run.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			run.on("exit", (code) => resolve({ code, stdout, stderr }));
		});
	const journal = async (): Promise<
		{
			t: string;
			seq?: number;
			released?: number;
			log?: string;
			read?: { seq: number; path: string; version: string | null; authority: unknown };
		}[]
	> =>
		(await readFile(join(state, "reads.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	return {
		core,
		root,
		viewId,
		receipt,
		company,
		state,
		requests,
		faults,
		publish,
		journal,
		kill,
		restart: async () => {
			await stop();
			await start();
		},
		output: () => output,
	};
}

describe.skipIf(!program)("durable read proof through a real FUSE mount", () => {
	it("refuses a nonexistent publisher state directory locally without poisoning the healthy mount", async () => {
		const m = await loggedMount();
		await readFile(join(m.company, "docs/plan.md"));
		const missing = join(m.state, "wrong", "state");
		const before = m.requests.length;
		const refused = await m.publish(false, missing);
		expect(refused).toMatchObject({ code: 1, stdout: "" });
		expect(refused.stderr).toContain("exact --state-dir");
		expect(m.requests).toHaveLength(before);
		await expect(stat(join(m.state, "wrong"))).rejects.toMatchObject({ code: "ENOENT" });
		await writeFile(join(m.company, "docs/healthy.md"), "still healthy");
		expect((await m.publish()).code).toBe(0);
		expect(m.core.entries.get("docs/healthy.md")?.fileSha256).toBe(hashOf("still healthy"));
	}, 15_000);

	it("retains a unique conflict receipt when its report arrives but the release poll answer is lost", async () => {
		const m = await loggedMount();
		await readFile(join(m.company, "docs/plan.md"));
		m.core.write(await storeFile(m.root, "docs/plan.md", "newer live bytes", 2));
		await writeFile(join(m.company, "docs/plan.md"), "my stale bytes");
		m.faults.dropPollAnswer = true;
		const uncertain = await m.publish();
		expect(uncertain.code).toBe(1);
		expect(uncertain.stderr).toContain("completion is unproven");
		const report = JSON.parse(uncertain.stdout);
		expect(report.paths).toEqual([
			{
				path: "docs/plan.md",
				outcome: "conflict",
				reason: "version_changed",
				receipt: expect.any(String),
			},
		]);
		expect(m.core.copies.has(report.paths[0].receipt)).toBe(true);
		expect(m.core.entries.get("docs/plan.md")?.fileSha256).toBe(hashOf("newer live bytes"));
		const retried = await m.publish();
		expect(retried.code).toBe(0);
		expect(JSON.parse(retried.stdout).paths).toEqual([]);
	}, 15_000);

	it("journals cached and empty opens with receipts, replays a lost acknowledgement before a write, and keeps released prefixes across service restarts", async () => {
		const m = await loggedMount();
		await readdir(m.company); // The root itself is never logged.
		await readdir(join(m.company, "docs"));
		expect(await readFile(join(m.company, "docs/plan.md"), "utf8")).toBe("the plan");
		expect(await readFile(join(m.company, "docs/plan.md"), "utf8")).toBe("the plan");
		expect(await readFile(join(m.company, "docs/empty.md"), "utf8")).toBe("");
		const reads = (await m.journal()).flatMap((line) => (line.read ? [line.read] : []));
		expect(reads.map((read) => read.path)).toEqual(["docs", "docs/plan.md", "docs/plan.md", "docs/empty.md"]);
		expect(reads.map((read) => read.seq)).toEqual([1, 2, 3, 4]);
		for (const read of reads) expect(read.authority).toEqual(m.receipt);
		expect(reads[0]?.version).toBeNull();
		expect(reads[3]?.version).toBe(v(1));
		m.faults.dropReadAnswer = true;
		await writeFile(join(m.company, "docs/result.md"), "result from plan");
		const beforeWrite = m.requests.slice(
			0,
			m.requests.findIndex((request) => request.kind === Kind.open),
		);
		expect(beforeWrite.filter((request) => request.kind === Kind.reads).length).toBe(2);
		m.core.commitHook = async () => {
			expect(m.core.readSets.get(m.viewId)?.has("docs/plan.md")).toBe(true);
			expect(m.core.readSets.get(m.viewId)?.has("docs/empty.md")).toBe(true);
		};
		const report = await m.publish();
		expect(report, m.output()).toMatchObject({ code: 0, stderr: "" });
		expect(JSON.parse(report.stdout).paths).toEqual([{ path: "docs/result.md", outcome: "saved" }]);
		const released = m.core.releases.length;
		expect((await m.journal()).some((line) => line.t === "released" && line.seq === 4)).toBe(true);
		await m.restart();
		expect((await m.publish()).code).toBe(0);
		expect(m.core.releases).toHaveLength(released);
		// A newly observed read, never sent before this service restart, is handed over at a quiet no-write boundary.
		expect(
			await eventually(async () => (await readFile(join(m.company, "docs/plan.md"), "utf8")) === "the plan", 10_000),
			m.output(),
		).toBe(true);
		await m.restart();
		const noWrites = await m.publish();
		expect(noWrites).toMatchObject({ code: 0, stderr: "" });
		expect(JSON.parse(noWrites.stdout)).toEqual({ commitId: null, seq: null, paths: [] });
		expect(m.core.releases.length).toBeGreaterThan(released);
	}, 30_000);

	it("releases a read before a write after service restart, and retries lost intake before a no-write boundary", async () => {
		const m = await loggedMount();
		await readFile(join(m.company, "docs/plan.md"));
		expect(m.core.releases).toHaveLength(0);
		await m.restart();
		m.core.commitHook = async () => {
			expect(m.core.readSets.get(m.viewId)?.get("docs/plan.md")).toEqual({
				path: "docs/plan.md",
				version: v(1),
				authority: m.receipt,
			});
		};
		await writeFile(join(m.company, "docs/result.md"), "after restart");
		expect((await m.publish()).code).toBe(0);
		expect(m.core.entries.get("docs/result.md")?.fileSha256).toBe(hashOf("after restart"));
		await readFile(join(m.company, "docs/empty.md"));
		const releases = m.core.releases.length;
		m.faults.dropReadAnswer = true;
		expect(await m.publish()).toMatchObject({ code: 1, stdout: "" });
		expect(m.core.releases).toHaveLength(releases);
		const retried = await m.publish();
		expect(retried.code).toBe(0);
		expect(JSON.parse(retried.stdout)).toEqual({ commitId: null, seq: null, paths: [] });
		expect(m.core.readSets.get(m.viewId)?.get("docs/empty.md")).toEqual({
			path: "docs/empty.md",
			version: v(1),
			authority: m.receipt,
		});
	}, 30_000);

	it("releases a desktop's reads before its automatic quiet save, without a publisher", async () => {
		const m = await loggedMount("computer_desktop");
		await readFile(join(m.company, "docs/plan.md"));
		m.core.commitHook = async () => {
			expect(m.core.readSets.get(m.viewId)?.get("docs/plan.md")?.authority).toEqual(m.receipt);
		};
		await writeFile(join(m.company, "docs/result.md"), "quiet save");
		expect(await eventually(async () => m.core.entries.has("docs/result.md"), 5_000), m.output()).toBe(true);
		expect(m.requests.some((request) => request.kind === Kind.publish)).toBe(false);
		expect(m.core.readSets.get(m.viewId)?.has("docs/plan.md")).toBe(true);
	}, 15_000);

	it("publishes a dead mount's retained log, retries unanswered no-write releases, and requires a closed final report", async () => {
		const m = await loggedMount();
		await readFile(join(m.company, "docs/plan.md"));
		await m.kill();
		m.core.releaseFailures = { mode: "down", count: 3 };
		const unknown = await m.publish();
		expect(unknown.code).toBe(1);
		expect(JSON.parse(unknown.stdout).paths).toEqual([]);
		expect(unknown.stderr).toContain("release did not complete");
		expect(unknown.stderr).not.toContain(CORE_PASS);
		expect((await m.publish()).code).toBe(0);
		const releases = m.core.releases.length;
		await m.restart();
		expect((await m.publish()).code).toBe(0);
		expect(m.core.releases).toHaveLength(releases);
		m.core.endCommand(m.viewId);
		m.core.commitFailures = { mode: "down", count: 3 };
		const unfinished = await m.publish(true);
		expect(unfinished.code).toBe(1);
		expect(JSON.parse(unfinished.stdout).closed).toBeUndefined();
		expect(unfinished.stderr).toContain("did not close");
		const final = await m.publish(true);
		expect(final.code).toBe(0);
		expect(JSON.parse(final.stdout)).toMatchObject({ closed: true, paths: [] });
		expect(m.core.views.get(m.viewId)?.state).toBe("closed");
	}, 15_000);

	it("keeps a final's definitive per-path refusal structured without claiming the view closed", async () => {
		const m = await loggedMount();
		await readFile(join(m.company, "docs/plan.md"));
		await writeFile(join(m.company, "docs/result.md"), "refused save");
		await m.kill();
		m.core.endCommand(m.viewId);
		m.core.commitRefusal = "denied";
		const answer = await m.publish(true);
		expect(answer.code).toBe(4);
		const report = JSON.parse(answer.stdout);
		expect(report.closed).toBeUndefined();
		expect(report.paths).toEqual([{ path: "docs/result.md", outcome: "refused", reason: "denied", kept: true }]);
		expect(m.core.entries.has("docs/result.md")).toBe(false);
	}, 15_000);

	it("never claims a lost report or released marker succeeded, and safely replays the still-retained read prefix", async () => {
		const m = await loggedMount();
		await readFile(join(m.company, "docs/plan.md"));
		await m.kill();
		m.faults.dropPollAnswer = true;
		const unknown = await m.publish();
		expect(unknown.code).toBe(1);
		expect(JSON.parse(unknown.stdout).paths).toEqual([]);
		expect((await m.journal()).some((line) => line.t === "released")).toBe(false);
		await m.restart();
		expect((await m.publish()).code).toBe(0);
		expect(m.core.readSets.get(m.viewId)?.size).toBe(1);
		m.faults.dropReport = true;
		expect(await m.publish()).toMatchObject({ code: 1, stdout: "" });
		expect((await m.publish()).code).toBe(0);
	}, 15_000);

	it("fails opens and every later publish closed when its journal is lost, including after a service restart", async () => {
		const m = await loggedMount();
		await readFile(join(m.company, "docs/plan.md"));
		await appendFile(join(m.state, "reads.jsonl"), "invalid-complete-record\n");
		await expect(readFile(join(m.company, "docs/plan.md"))).rejects.toMatchObject({ code: "EIO" });
		const refused = await m.publish();
		expect(refused.code).toBe(4);
		expect(JSON.parse(refused.stdout)).toEqual({ commitId: null, seq: null, paths: [], refused: "unproven" });
		await m.kill();
		await rm(join(m.state, "reads.jsonl"));
		await m.restart();
		const stillRefused = await m.publish();
		expect(stillRefused.code).toBe(4);
		expect(JSON.parse(stillRefused.stdout).refused).toBe("unproven");
		expect(m.core.commits).toHaveLength(0);
		const missing = await m.publish(false, join(m.state, "missing"));
		expect(missing).toMatchObject({ code: 1, stdout: "" });
	}, 15_000);
});
