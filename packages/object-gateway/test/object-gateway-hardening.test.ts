import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyFolderCreator } from "../src/company-folder-creation.ts";
import { ObjectDependencyError } from "../src/dependency.ts";
import { ObjectUnavailableError } from "../src/folder-service/objects.ts";
import { type ErrorCode, encodeJson, FrameReader, Kind, ProtocolError } from "../src/folder-service/protocol.ts";
import { NativeSearchWorker } from "../src/folder-service/search-native.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import type { ChangeMessage, FolderService, ViewHandle } from "../src/folder-service/service.ts";
import { ViewTree } from "../src/folder-service/view-tree.ts";
import { createSerialGate, startGatewayMaintenance } from "../src/maintenance.ts";
import { serveMemberFolderCommit } from "../src/member-folder-commits.ts";
import { BRIDGE, ENV, PASS, PROFILE } from "./folder-service-fixtures.ts";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

const USER = "34000000-0000-4000-8000-000000000001";

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

describe("maintenance shutdown race", () => {
	it("skips initial maintain() and reconcile() once stop() is called while probe() or recoverGc() is running", async () => {
		let releaseProbe!: () => void;
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		let maintainCalls = 0;
		const loops = startGatewayMaintenance({
			probeAuthority: () => probeGate,
			probeStore: async () => undefined,
			recoverGc: async () => {
				maintainCalls++;
			},
			reconcile: async () => {
				maintainCalls++;
			},
			nasGate: createSerialGate(),
			intervalMs: 60_000,
		});
		loops.stop();
		releaseProbe();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(maintainCalls).toBe(0);

		let releaseGc!: () => void;
		const gcGate = new Promise<void>((resolve) => {
			releaseGc = resolve;
		});
		let reconcileCalls = 0;
		const second = startGatewayMaintenance({
			probeAuthority: async () => undefined,
			probeStore: async () => undefined,
			recoverGc: () => gcGate,
			reconcile: async () => {
				reconcileCalls++;
			},
			nasGate: createSerialGate(),
			intervalMs: 60_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		second.stop();
		releaseGc();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(reconcileCalls).toBe(0);
	});
});

describe("folder server backpressure and forced teardown", () => {
	it("destroys a feed connection that stops reading and overflows FEED_BACKLOG, releasing its handle", async () => {
		let changeListener: ((message: ChangeMessage) => void) | undefined;
		let released = 0;
		let releaseDone!: () => void;
		const waitReleased = new Promise<void>((resolve) => {
			releaseDone = resolve;
		});
		const handle = {
			asOfSeq: 1,
			writable: false,
			core: false,
			subscribe(cb: { change: (m: ChangeMessage) => void; closed: (code: ErrorCode, msg: string) => void }) {
				changeListener = cb.change;
			},
			release() {
				released++;
				releaseDone();
			},
		} as unknown as ViewHandle;
		const service = {
			open: async () => handle,
		} as unknown as FolderService;
		const logs: string[] = [];
		const server: Server = createFolderServer(service, (line) => logs.push(line), {
			drainMs: 100,
			closeGraceMs: 50,
		});
		const sockPath = join(await tempDir("qorpera-feed-backlog-"), "svc.sock");
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		const client = connect(sockPath);
		cleanup.push(() => {
			client.destroy();
		});
		await new Promise<void>((resolve, reject) => {
			client.once("connect", resolve);
			client.once("error", reject);
		});
		const reader = new FrameReader();
		const gotHello = new Promise<void>((resolve) => {
			client.on("data", (chunk: Buffer) => {
				for (const frame of reader.push(chunk)) {
					if (frame.kind === Kind.helloOk) resolve();
				}
			});
		});
		client.write(encodeJson(Kind.bridge, BRIDGE));
		client.write(
			encodeJson(Kind.hello, { protocol: 1, environmentId: ENV, viewId: "proof", pass: PASS, role: "feed" }),
		);
		await gotHello;

		client.pause();
		const bigChange: ChangeMessage = {
			seq: 2,
			resync: false,
			paths: [`dir/${"x".repeat(4096)}`],
		};
		for (let i = 0; i < 1500 && released === 0; i++) {
			changeListener!({ ...bigChange, seq: i + 2 });
		}
		await waitReleased;
		expect(released).toBe(1);
		expect(logs.some((line) => line.includes("is not reading its feed"))).toBe(true);
	});

	it("bounds drained() wait on a stalled io peer and releases its handle", async () => {
		let released = 0;
		let releaseDone!: () => void;
		const waitReleased = new Promise<void>((resolve) => {
			releaseDone = resolve;
		});
		const bigChunk = Buffer.alloc(1024 * 1024, 0x61);
		const handle = {
			asOfSeq: 1,
			writable: false,
			core: false,
			async read() {
				return bigChunk;
			},
			release() {
				released++;
				releaseDone();
			},
		} as unknown as ViewHandle;
		const service = {
			open: async () => handle,
		} as unknown as FolderService;
		const server: Server = createFolderServer(service, () => {}, { drainMs: 80, closeGraceMs: 40 });
		const sockPath = join(await tempDir("qorpera-drain-timeout-"), "svc.sock");
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		const client = connect(sockPath);
		cleanup.push(() => {
			client.destroy();
		});
		await new Promise<void>((resolve, reject) => {
			client.once("connect", resolve);
			client.once("error", reject);
		});
		const reader = new FrameReader();
		const gotHello = new Promise<void>((resolve) => {
			client.on("data", (chunk: Buffer) => {
				for (const frame of reader.push(chunk)) {
					if (frame.kind === Kind.helloOk) resolve();
				}
			});
		});
		client.write(encodeJson(Kind.bridge, BRIDGE));
		client.write(
			encodeJson(Kind.hello, { protocol: 1, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" }),
		);
		await gotHello;

		client.pause();
		const started = Date.now();
		for (let i = 0; i < 4; i++) {
			client.write(encodeJson(Kind.read, { path: "big.bin", version: ENV, offset: 0, length: bigChunk.byteLength }));
		}
		await waitReleased;
		expect(released).toBe(1);
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});

describe("NativeSearchWorker frame timeout and leader failure isolation", () => {
	async function writeFakeWorker(script: string): Promise<string> {
		const dir = await tempDir("qorpera-fake-search-");
		const file = join(dir, "fake-worker.mjs");
		await writeFile(file, `#!/usr/bin/env node\n${script}\n`, "utf8");
		await chmod(file, 0o755);
		return file;
	}

	function sampleTree(count = 1): ViewTree {
		const tree = new ViewTree();
		for (let i = 0; i < count; i++) {
			tree.put({
				path: `dir/file-${String(i).padStart(4, "0")}.txt`,
				kind: "file",
				version: `34000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
				manifestSha256: "a".repeat(64),
				fileSha256: "b".repeat(64),
				bytes: 16,
			});
		}
		return tree;
	}

	it("times out a wedged worker frame, kills the wedged child, and respawns cleanly on retry", async () => {
		const stateDir = await tempDir("qorpera-wedge-state-");
		const marker = join(stateDir, "first-run");
		const fakeBin = await writeFakeWorker(`
import { existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const wedge = !existsSync(marker);
if (wedge) writeFileSync(marker, "1");
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	while (buf.length >= 4) {
		const len = buf.readUInt32BE(0);
		if (buf.length < 4 + len) return;
		const frame = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
		buf = buf.subarray(4 + len);
		if (frame.op === "dropTree") continue;
		if (wedge) return;
		const reply = Buffer.from(JSON.stringify({ id: frame.id, synced: true }), "utf8");
		const out = Buffer.alloc(4 + reply.length);
		out.writeUInt32BE(reply.length, 0);
		reply.copy(out, 4);
		process.stdout.write(out);
	}
});
`);
		const worker = new NativeSearchWorker({
			folderProgram: fakeBin,
			storageRoot: stateDir,
			frameTimeoutMs: 120,
		});
		cleanup.push(() => worker.close());

		const tree = sampleTree(2);
		await expect(worker.acquireSnapshot(tree)).rejects.toThrow(ObjectUnavailableError);
		const recovered = await worker.acquireSnapshot(tree);
		expect(recovered.revision).toBe(tree.revision);
		worker.releaseSnapshot(recovered);
	});

	it("isolates a healthy follower when the coalesced sync leader fails its serving check or budget deadline", async () => {
		const stateDir = await tempDir("qorpera-coalesce-state-");
		const fakeBin = await writeFakeWorker(`
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	while (buf.length >= 4) {
		const len = buf.readUInt32BE(0);
		if (buf.length < 4 + len) return;
		const frame = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
		buf = buf.subarray(4 + len);
		if (frame.op === "dropTree") continue;
		const reply = Buffer.from(JSON.stringify({ id: frame.id, synced: true }), "utf8");
		const out = Buffer.alloc(4 + reply.length);
		out.writeUInt32BE(reply.length, 0);
		reply.copy(out, 4);
		setTimeout(() => process.stdout.write(out), 15);
	}
});
`);
		const worker = new NativeSearchWorker({
			folderProgram: fakeBin,
			storageRoot: stateDir,
			indexMiB: 1,
			budgetWaitMs: 500,
			frameTimeoutMs: 2_000,
		});
		cleanup.push(() => worker.close());

		const bigTree = sampleTree(2_100);
		let leaderServingCalls = 0;
		const leaderError = new Error("leader view disconnected");
		const leaderPromise = worker.acquireSnapshot(bigTree, {
			serving: () => {
				leaderServingCalls++;
				if (leaderServingCalls >= 2) throw leaderError;
			},
		});
		const followerPromise = worker.acquireSnapshot(bigTree, {
			serving: () => {},
		});
		await expect(leaderPromise).rejects.toBe(leaderError);
		const followerSnap = await followerPromise;
		expect(followerSnap.revision).toBe(bigTree.revision);
		worker.releaseSnapshot(followerSnap);

		const blocker = sampleTree(3_200);
		const held = await worker.acquireSnapshot(blocker);
		const contended = sampleTree(3_200);
		const now = performance.now();
		const shortLeader = worker.acquireSnapshot(contended, { waitDeadline: now + 40 });
		const patientFollower = worker.acquireSnapshot(contended, { waitDeadline: now + 1_000 });
		setTimeout(() => worker.releaseSnapshot(held), 90);
		await expect(shortLeader).rejects.toThrow(ProtocolError);
		const recovered = await patientFollower;
		expect(recovered.revision).toBe(contended.revision);
		worker.releaseSnapshot(recovered);
	});
});

describe("mapBounded stepSignal propagation on sibling staging failure", () => {
	it("aborts sibling seed uploads in CompanyFolderCreator when one file fails to stage", async () => {
		const observedSignals: AbortSignal[] = [];
		let openCount = 0;
		const creator = new CompanyFolderCreator({
			workerId: "34000000-0000-4000-8000-00000000000a",
			authority: {
				async publisher(method, _args, signal) {
					if (method === "qorpera_folder_company_creation_claim") {
						return {
							schema: "qorpera.company-creation-claim/v1",
							creationId: "34000000-0000-4000-8000-0000000000c1",
							profileId: PROFILE,
							environmentId: ENV,
							generation: 2,
							attempt: 1,
							leaseUntil: "2026-10-03T08:05:00Z",
							operationKey: "company-create:34000000-0000-4000-8000-0000000000c1",
							cofounderId: "34000000-0000-4000-8000-0000000000a1",
							firstTodoId: "34000000-0000-4000-8000-0000000000b1",
							kickoffRequestedBy: USER,
							input: {
								schema: "qorpera.company-seed-input/v1",
								companyName: "Nordlys Kaffe",
								vision: "Coffee.",
								kickoffRequestedBy: USER,
								founders: [{ userId: USER, displayName: "Anna", role: "" }],
							},
						};
					}
					if (method === "qorpera_folder_open_upload") {
						openCount++;
						if (signal) observedSignals.push(signal);
						if (openCount === 2) throw new Error("boom");
						return await new Promise((_, reject) => {
							signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
						});
					}
					if (method === "qorpera_folder_company_creation_release") {
						return { schema: "qorpera.company-creation-release/v1", released: true };
					}
					throw new Error(`unexpected ${method}`);
				},
			},
			store: {
				async get() {
					return new Uint8Array();
				},
			},
			replication: {
				async uploadWithAuthority() {
					return "stored" as const;
				},
			},
		});
		const outer = new AbortController();
		expect(await creator.createOne(outer.signal)).toBe(true);
		expect(outer.signal.aborted).toBe(false);
		expect(observedSignals.length).toBeGreaterThanOrEqual(2);
		expect(observedSignals[0]!.aborted).toBe(true);
	});

	it("aborts sibling file uploads in serveMemberFolderCommit when one write unit fails to stage", async () => {
		const observedSignals: AbortSignal[] = [];
		let openCount = 0;
		const server: HttpServer = createHttpServer((request, response) => {
			void serveMemberFolderCommit(request, response, {
				authority: {
					async member() {
						return {
							schema: "qorpera.member-folder-writer/v1",
							actor: { kind: "member", userId: USER },
							profileId: PROFILE,
						};
					},
					async publisher(method, _args, signal) {
						if (method === "qorpera_folder_open_upload") {
							openCount++;
							if (signal) observedSignals.push(signal);
							if (openCount === 2) throw new Error("boom");
							return await new Promise((_, reject) => {
								signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
							});
						}
						throw new Error(`unexpected ${method}`);
					},
				},
				store: {
					async get() {
						return new Uint8Array();
					},
				},
				replication: {
					async uploadWithAuthority() {
						return "stored" as const;
					},
				},
			}).catch((error: unknown) => {
				const status = error instanceof ObjectDependencyError ? error.status : 500;
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "failed" }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const res = await fetch(`http://127.0.0.1:${port}/v1/member-folder-commits/${ENV}`, {
			method: "POST",
			headers: {
				authorization: "Bearer synthetic-member-jwt",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				schema: "qorpera.member-folder-commit/v1",
				operationKey: "web:34000000-0000-4000-8000-0000000000d1",
				units: [
					{ op: "write", path: "notes/a.md", text: "alpha" },
					{ op: "write", path: "notes/b.md", text: "beta" },
				],
			}),
		});
		expect(res.status).toBe(500);
		expect(observedSignals.length).toBe(2);
		expect(observedSignals[0]!.aborted).toBe(true);
	});
});
