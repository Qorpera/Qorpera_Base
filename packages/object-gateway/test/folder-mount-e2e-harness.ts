import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { CoreEntry } from "../src/folder-service/core.ts";
import { NasObjects } from "../src/folder-service/objects.ts";
import { encodeFrame, encodeJson, FrameReader, Kind, parseHello } from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	companyGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	OFFICE,
	storeFile,
	v,
} from "./folder-service-fixtures.ts";

export const CORE_PASS = "readpass_0123456789-abcdefghijklmnopqrstuvw";

export async function eventually(check: () => Promise<boolean>, limitMs = 3_000): Promise<boolean> {
	const start = Date.now();
	for (;;) {
		try {
			if (await check()) return true;
		} catch {}
		if (Date.now() - start > limitMs) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export async function mounted(path: string): Promise<boolean> {
	return (await readFile("/proc/self/mountinfo", "utf8")).split("\n").some((line) => line.split(" ")[4] === path);
}

export function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve) => server.listen(path, resolve));
}

export async function createLoggedMount(
	program: string,
	cleanup: (() => Promise<void> | void)[],
	kind = "computer_shell_command",
	seeded: CoreEntry[] = [],
) {
	const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-log-e2e-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const root = join(dir, "share");
	const core = new FakeCore();
	core.seed([
		folder("docs"),
		await storeFile(root, "docs/plan.md", "the plan", 1),
		await storeFile(root, "docs/empty.md", "", 1),
		...seeded,
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
	const faults = { dropReadAnswer: false, dropReport: false, dropPollAnswer: false, dropHelloAnswer: false };
	const requests: { kind: number; body: unknown }[] = [];
	const answers: number[] = [];
	const bridge = createServer((machine) => {
		const incoming = new FrameReader();
		const outgoing = new FrameReader();
		const upstream = connect(serviceSocket, () => {
			upstream.write(encodeJson(Kind.bridge, { cid: 90, lookup: "found", machine: OFFICE }));
			machine.on("data", (data: Buffer) => {
				for (const frame of incoming.push(data)) {
					if (frame.kind === Kind.hello) {
						const hello = parseHello(frame.payload);
						requests.push({
							kind: frame.kind,
							body: {
								viewId: hello.viewId,
								previousViewId: hello.previous?.viewId,
								abandon: hello.abandon === true,
							},
						});
					} else if (frame.kind !== Kind.chunk)
						requests.push({ kind: frame.kind, body: JSON.parse(frame.payload.toString()) });
				}
			});
			machine.pipe(upstream);
		});
		upstream.on("data", (data: Buffer) => {
			for (const frame of outgoing.push(data)) {
				if (frame.kind === Kind.helloOk && faults.dropHelloAnswer) {
					faults.dropHelloAnswer = false;
					machine.destroy();
					upstream.destroy();
					return;
				}
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
				answers.push(frame.kind);
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
	const launch = () => {
		const child = spawn(
			program,
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
		return child;
	};
	let child = launch();
	let exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
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
				program,
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
		child: () => child,
		exited: () => exited,
		service: () => service,
		disconnect: () => {
			for (const socket of sockets) socket.destroy();
		},
		remount: async () => {
			child = launch();
			exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
			expect(await eventually(() => mounted(company)), output).toBe(true);
		},
		replace: async (next: string) => {
			core.openView(next, CORE_PASS, { kind, machineId: ALLOCATION });
			const current = JSON.parse(await readFile(viewFile, "utf8")) as { viewId: string };
			core.views.get(current.viewId)!.state = "closed";
			await service.renewLeases();
			const temporary = `${viewFile}.next`;
			await writeFile(temporary, JSON.stringify({ environmentId: ENV, viewId: next, pass: CORE_PASS }), {
				mode: 0o600,
			});
			await rename(temporary, viewFile);
		},
		receipt,
		company,
		state,
		requests,
		answers,
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
