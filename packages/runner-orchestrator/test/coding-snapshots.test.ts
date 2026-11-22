import { describe, expect, it, vi } from "vitest";
import { AGENT_BRIDGE, type AgentPlugClaim } from "../src/agent-plug.ts";
import { CODING_MACHINE_BASE_CONFIG } from "../src/coding-machine.ts";
import { EMPTY_CODING_SETUP, parseCodingSetup } from "../src/coding-setup.ts";
import {
	CODING_SNAPSHOT_BUILDER_SCHEMA,
	CODING_SNAPSHOT_BUILDER_VM_PREFIX,
	CODING_SNAPSHOT_LOG_MAX_JSON_BYTES,
	CODING_SNAPSHOT_RPCS,
	CodingSnapshotBuilder,
	type CodingSnapshotBuilderLxdClient,
	type CodingSnapshotBuildRequest,
	type CodingSnapshotRpcControl,
	codingSnapshotLog,
} from "../src/coding-snapshots.ts";
import type { LxdCreateInstanceRequest, LxdImageSummary, LxdInstanceRecord } from "../src/lxd-client.ts";

const BASE_FP = "a".repeat(64);
const SNAP_FP = "b".repeat(64);
const SNAP_FP_2 = "c".repeat(64);
const MACHINE_SHA = "d".repeat(64);
const COMMIT_SHA = "e".repeat(40);
const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const LEASE_TOKEN = "22222222-2222-4222-8222-222222222222";
const BUILD_ID = "33333333-3333-4333-8333-333333333333";
const BUILD_LEASE = "44444444-4444-4444-8444-444444444444";
const ENV_ID = "55555555-5555-4555-8555-555555555555";
const MEMBER_ID = "66666666-6666-4666-8666-666666666666";
const PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const PLUG_MAC = "0e:51:0a:d2:01:02";

function makeFakeLxd(overrides?: {
	execHandler?: (
		project: string,
		name: string,
		command: readonly string[],
		env: Readonly<Record<string, string>>,
		cwd: string,
		stdin?: Uint8Array | AsyncIterable<Uint8Array>,
		signal?: AbortSignal,
	) => Promise<{ exitCode: number; stdout: Buffer; stderrTail: Buffer }>;
	publishFingerprint?: string;
	publishSize?: number;
}) {
	const instances = new Map<string, LxdInstanceRecord>();
	const images = new Map<string, LxdImageSummary>([
		[BASE_FP, { fingerprint: BASE_FP, size: 1024 * 1024, properties: {} }],
	]);
	const createRequests: LxdCreateInstanceRequest[] = [];
	const commands: { name: string; command: readonly string[]; env: Readonly<Record<string, string>>; cwd: string }[] =
		[];
	const pushedFiles: { name: string; path: string; content: string }[] = [];
	const deletedInstances: string[] = [];
	const deletedImages: string[] = [];

	const client: CodingSnapshotBuilderLxdClient = {
		async getInstance(_project, name) {
			return instances.get(name);
		},
		async createInstance(_project, request) {
			createRequests.push(request);
			instances.set(request.name, {
				name: request.name,
				type: "virtual-machine",
				status: "Stopped",
				statusCode: 102,
				config: { ...request.config, "volatile.base_image": request.source.fingerprint },
				profiles: [...request.profiles],
				devices: request.devices,
				expandedDevices: request.devices,
				expandedConfig: { ...request.config, "volatile.base_image": request.source.fingerprint },
			});
		},
		async setInstancePower(_project, name, action) {
			const inst = instances.get(name);
			if (!inst) throw new Error("not found");
			instances.set(name, {
				...inst,
				status: action === "start" ? "Running" : "Stopped",
				statusCode: action === "start" ? 103 : 102,
			});
		},
		async pushInstanceFile(_project, name, path, content) {
			pushedFiles.push({ name, path, content });
		},
		async deleteInstance(_project, name) {
			deletedInstances.push(name);
			instances.delete(name);
		},
		async execInstancePipe(project, name, request, signal) {
			signal.throwIfAborted();
			commands.push({ name, command: request.command, env: request.environment, cwd: request.cwd });
			if (overrides?.execHandler) {
				return overrides.execHandler(
					project,
					name,
					request.command,
					request.environment,
					request.cwd,
					request.stdin,
					signal,
				);
			}
			return { exitCode: 0, stdout: Buffer.from("ok\n"), stderrTail: Buffer.alloc(0) };
		},
		async hasImage(_project, fingerprint) {
			return images.has(fingerprint);
		},
		async publishInstanceImage(_project, _instanceName, options) {
			const fp = overrides?.publishFingerprint ?? SNAP_FP;
			const size = overrides?.publishSize ?? 123_456_789;
			images.set(fp, { fingerprint: fp, size, properties: options.properties ?? {} });
			return { fingerprint: fp, size };
		},
		async deleteImage(_project, fingerprint) {
			deletedImages.push(fingerprint);
			return images.delete(fingerprint);
		},
		async listImages() {
			return [...images.values()];
		},
		async listInstances() {
			return [...instances.values()];
		},
	};

	return { client, instances, images, createRequests, commands, pushedFiles, deletedInstances, deletedImages };
}

function baseVmPolicy() {
	return {
		project: "coding",
		imageFingerprint: BASE_FP,
		storagePool: "coding-disks",
		cpus: 4,
		memoryBytes: 8 * 1024 ** 3,
		rootDiskBytes: 64 * 1024 ** 3,
	};
}

async function sampleSetup() {
	const parsed = await parseCodingSetup({
		async read(path) {
			if (path === ".qorpera/environment.json") {
				return {
					kind: "file",
					bytes: Buffer.from(
						JSON.stringify({
							install: "npm ci",
							start: "npm run dev",
							env: {
								NODE_ENV: "development",
								APP_MODE: "fast",
								PATH: "/evil",
								GITHUB_TOKEN: "ghp_secret",
							},
						}),
					),
				};
			}
			return { kind: "missing" };
		},
	});
	return parsed;
}

describe("coding snapshot records and builder (5h)", () => {
	it("names all ten snapshot RPCs the control lets through", () => {
		expect(CODING_SNAPSHOT_RPCS).toEqual([
			"qorpera_begin_coding_snapshot_build",
			"qorpera_renew_coding_snapshot_build",
			"qorpera_finish_coding_snapshot_build",
			"qorpera_list_coding_snapshots",
			"qorpera_record_coding_snapshot_removed",
			"qorpera_claim_coding_snapshot_build",
			"qorpera_complete_coding_snapshot_build",
			"qorpera_fail_coding_snapshot_build",
			"qorpera_sweep_coding_snapshots",
			"qorpera_fallback_coding_machine_base_image",
		]);
	});

	it("truncates and redacts build logs to fit SQL JSON byte limit", () => {
		const raw = `secret-token ${"x".repeat(70_000)} tail-marker`;
		const out = codingSnapshotLog(raw, (t) => t.replaceAll("secret-token", "[REDACTED]"));
		expect(out).not.toContain("secret-token");
		expect(out).toContain("...[truncated]\n");
		expect(out).toContain("tail-marker");
		expect(Buffer.byteLength(JSON.stringify(out), "utf8") - 2).toBeLessThanOrEqual(
			CODING_SNAPSHOT_LOG_MAX_JSON_BYTES,
		);
	});

	it("runs end-to-end build, scrubs builder VM, publishes image, records completion, and deletes builder VM", async () => {
		const fakeLxd = makeFakeLxd();
		const parsed = await sampleSetup();
		const rpcCalls: { method: string; args: Record<string, unknown> }[] = [];
		const control: CodingSnapshotRpcControl = {
			async rpc(method, args) {
				rpcCalls.push({ method, args });
				if (method === "qorpera_claim_coding_snapshot_build") {
					return {
						schema: "qorpera.coding-snapshot-claim/v1",
						state: "claimed",
						baseImageFingerprint: BASE_FP,
						snapshot: null,
						build: {
							buildId: BUILD_ID,
							leaseToken: BUILD_LEASE,
							leaseUntil: new Date(Date.now() + 120_000).toISOString(),
							baseImageFingerprint: BASE_FP,
							repository: "acme/app",
							setupDigest: parsed.setupDigest,
							commitSha: COMMIT_SHA,
							ttlSeconds: 3600,
						},
					};
				}
				if (method === "qorpera_complete_coding_snapshot_build") {
					return {
						schema: "qorpera.coding-snapshot-build/v1",
						buildId: BUILD_ID,
						state: "ready",
						imageFingerprint: args.p_image_fingerprint,
						imageBytes: args.p_image_bytes,
						expiresAt: "2026-12-01T00:00:00.000Z",
					};
				}
				return {};
			},
		};

		const plugClaims: AgentPlugClaim[] = [];
		const builder = new CodingSnapshotBuilder({
			control,
			lxd: fakeLxd.client,
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			vmPolicy: baseVmPolicy(),
			agentPlug: async (claim) => {
				plugClaims.push(claim);
				return PLUG_MAC;
			},
			projectAllowsAgentCard: async () => true,
			readyPollMs: 5,
		});

		const outcome = await builder.buildNow({
			workerId: WORKER_ID,
			leaseToken: LEASE_TOKEN,
			profileId: PROFILE_ID,
			environmentId: ENV_ID,
			memberUserId: MEMBER_ID,
			repository: "acme/app",
			setupDigest: parsed.setupDigest,
			commitSha: COMMIT_SHA,
			setupSpec: parsed.setupSpec,
			readArchive: async () => Buffer.from("tar-bytes"),
		});

		expect(outcome).toEqual({
			state: "ready",
			buildId: BUILD_ID,
			imageFingerprint: SNAP_FP,
			imageBytes: 123_456_789,
			expiresAt: "2026-12-01T00:00:00.000Z",
		});

		expect(fakeLxd.createRequests).toHaveLength(1);
		const created = fakeLxd.createRequests[0];
		expect(created.name.startsWith(CODING_SNAPSHOT_BUILDER_VM_PREFIX)).toBe(true);
		expect(Object.keys(created.devices).sort()).toEqual(["network", "root"]);
		expect(created.devices.network.parent).toBe(AGENT_BRIDGE);
		expect(created.devices.network.hwaddr).toBe(PLUG_MAC);
		expect(created.config).toMatchObject({
			...CODING_MACHINE_BASE_CONFIG,
			"user.qorpera.schema": CODING_SNAPSHOT_BUILDER_SCHEMA,
			"user.qorpera.company_id": PROFILE_ID,
			"user.qorpera.machine_id": BUILD_ID,
			"user.qorpera.member_user_id": MEMBER_ID,
			"user.qorpera.build_id": BUILD_ID,
		});
		expect(created.config).not.toHaveProperty("security.secureboot");
		expect(plugClaims).toEqual([
			{
				kind: "coding",
				companyId: PROFILE_ID,
				machineId: BUILD_ID,
				memberUserId: MEMBER_ID,
				project: "coding",
				instance: created.name,
			},
		]);
		expect(created.source.fingerprint).toBe(BASE_FP);

		const installCmd = fakeLxd.commands.find((c) => c.command.includes("npm ci"));
		expect(installCmd).toBeDefined();
		expect(installCmd?.env).toEqual({ APP_MODE: "fast", NODE_ENV: "development" });
		expect(installCmd?.env).not.toHaveProperty("PATH");
		expect(installCmd?.env).not.toHaveProperty("GITHUB_TOKEN");

		const scrubCmd = fakeLxd.commands.find((c) => c.command.some((a) => a.includes("/etc/machine-id")));
		expect(scrubCmd).toBeDefined();

		expect(fakeLxd.deletedInstances).toEqual([fakeLxd.createRequests[0].name]);
		expect(fakeLxd.instances.size).toBe(0);
		expect(rpcCalls.map((c) => c.method)).toEqual([
			"qorpera_claim_coding_snapshot_build",
			"qorpera_complete_coding_snapshot_build",
		]);
		await builder.close();
	});

	it("cleans up disposable builder VM and records failed outcome when a setup step fails", async () => {
		const fakeLxd = makeFakeLxd({
			execHandler: async (_p, _n, command) => {
				if (command.includes("npm ci")) {
					return { exitCode: 1, stdout: Buffer.from(""), stderrTail: Buffer.from("EACCES\n") };
				}
				return { exitCode: 0, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) };
			},
		});
		const parsed = await sampleSetup();
		const rpcCalls: { method: string; args: Record<string, unknown> }[] = [];
		const control: CodingSnapshotRpcControl = {
			async rpc(method, args) {
				rpcCalls.push({ method, args });
				if (method === "qorpera_claim_coding_snapshot_build") {
					return {
						schema: "qorpera.coding-snapshot-claim/v1",
						state: "claimed",
						baseImageFingerprint: BASE_FP,
						snapshot: null,
						build: {
							buildId: BUILD_ID,
							leaseToken: BUILD_LEASE,
							leaseUntil: new Date(Date.now() + 120_000).toISOString(),
							baseImageFingerprint: BASE_FP,
							repository: "acme/app",
							setupDigest: parsed.setupDigest,
							commitSha: COMMIT_SHA,
							ttlSeconds: 3600,
						},
					};
				}
				return { schema: "qorpera.coding-snapshot-build/v1", buildId: BUILD_ID, state: "failed" };
			},
		};

		const builder = new CodingSnapshotBuilder({
			control,
			lxd: fakeLxd.client,
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			vmPolicy: baseVmPolicy(),
			agentPlug: async () => PLUG_MAC,
			readyPollMs: 5,
		});

		const outcome = await builder.buildNow({
			workerId: WORKER_ID,
			leaseToken: LEASE_TOKEN,
			profileId: PROFILE_ID,
			environmentId: ENV_ID,
			memberUserId: MEMBER_ID,
			repository: "acme/app",
			setupDigest: parsed.setupDigest,
			commitSha: COMMIT_SHA,
			setupSpec: parsed.setupSpec,
		});

		expect(outcome.state).toBe("failed");
		if (outcome.state === "failed") {
			expect(outcome.code).toBe("SETUP_STEP_FAILED");
			expect(outcome.log).toContain("EACCES");
		}
		expect(fakeLxd.deletedInstances).toHaveLength(1);
		expect(fakeLxd.instances.size).toBe(0);
		expect(rpcCalls[1].method).toBe("qorpera_fail_coding_snapshot_build");
		expect(rpcCalls[1].args.p_abandoned).toBe(false);
		await builder.close();
	});

	it("marks build abandoned and still deletes builder VM on caller abort", async () => {
		const abortController = new AbortController();
		const fakeLxd = makeFakeLxd({
			execHandler: async (_p, _n, command, _env, _cwd, _stdin, signal) => {
				if (command.includes("npm ci")) {
					abortController.abort(new Error("user cancelled"));
					signal?.throwIfAborted();
				}
				return { exitCode: 0, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) };
			},
		});
		const parsed = await sampleSetup();
		const failArgs: Record<string, unknown>[] = [];
		const control: CodingSnapshotRpcControl = {
			async rpc(method, args) {
				if (method === "qorpera_claim_coding_snapshot_build") {
					return {
						schema: "qorpera.coding-snapshot-claim/v1",
						state: "claimed",
						baseImageFingerprint: BASE_FP,
						snapshot: null,
						build: {
							buildId: BUILD_ID,
							leaseToken: BUILD_LEASE,
							leaseUntil: new Date(Date.now() + 120_000).toISOString(),
							baseImageFingerprint: BASE_FP,
							repository: "acme/app",
							setupDigest: parsed.setupDigest,
							commitSha: COMMIT_SHA,
							ttlSeconds: 3600,
						},
					};
				}
				if (method === "qorpera_fail_coding_snapshot_build") {
					failArgs.push(args);
				}
				return { schema: "qorpera.coding-snapshot-build/v1", buildId: BUILD_ID, state: "abandoned" };
			},
		};

		const builder = new CodingSnapshotBuilder({
			control,
			lxd: fakeLxd.client,
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			vmPolicy: baseVmPolicy(),
			agentPlug: async () => PLUG_MAC,
			readyPollMs: 5,
		});

		const outcome = await builder.buildNow(
			{
				workerId: WORKER_ID,
				leaseToken: LEASE_TOKEN,
				profileId: PROFILE_ID,
				environmentId: ENV_ID,
				memberUserId: MEMBER_ID,
				repository: "acme/app",
				setupDigest: parsed.setupDigest,
				commitSha: COMMIT_SHA,
				setupSpec: parsed.setupSpec,
			},
			abortController.signal,
		);

		expect(outcome).toEqual({ state: "abandoned", code: "BUILD_ABORTED", buildId: BUILD_ID });
		expect(failArgs).toHaveLength(1);
		expect(failArgs[0].p_abandoned).toBe(true);
		expect(fakeLxd.deletedInstances).toHaveLength(1);
		expect(fakeLxd.instances.size).toBe(0);
		await builder.close();
	});

	it("enforces bounded concurrency of 1 build at a time and deletes orphan published image on complete RPC failure", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const fakeLxd = makeFakeLxd({
			execHandler: async (_p, _n, command) => {
				if (command.includes("echo step")) {
					concurrent++;
					maxConcurrent = Math.max(maxConcurrent, concurrent);
					await new Promise((r) => setTimeout(r, 20));
					concurrent--;
				}
				return { exitCode: 0, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) };
			},
		});
		let buildSeq = 0;
		const control: CodingSnapshotRpcControl = {
			async rpc(method) {
				if (method === "qorpera_claim_coding_snapshot_build") {
					buildSeq++;
					const id = buildSeq === 1 ? BUILD_ID : "77777777-7777-4777-8777-777777777777";
					return {
						schema: "qorpera.coding-snapshot-claim/v1",
						state: "claimed",
						baseImageFingerprint: BASE_FP,
						snapshot: null,
						build: {
							buildId: id,
							leaseToken: BUILD_LEASE,
							leaseUntil: new Date(Date.now() + 120_000).toISOString(),
							baseImageFingerprint: BASE_FP,
							repository: "acme/app",
							setupDigest: "1".repeat(64),
							commitSha: COMMIT_SHA,
							ttlSeconds: 3600,
						},
					};
				}
				if (method === "qorpera_complete_coding_snapshot_build") {
					if (buildSeq === 2) throw new Error("LEASE_EXPIRED");
					return {
						schema: "qorpera.coding-snapshot-build/v1",
						buildId: BUILD_ID,
						state: "ready",
						imageFingerprint: SNAP_FP,
						imageBytes: 100,
						expiresAt: null,
					};
				}
				return {};
			},
		};

		const builder = new CodingSnapshotBuilder({
			control,
			lxd: fakeLxd.client,
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			vmPolicy: baseVmPolicy(),
			agentPlug: async () => PLUG_MAC,
			readyPollMs: 5,
		});

		const req: CodingSnapshotBuildRequest = {
			workerId: WORKER_ID,
			leaseToken: LEASE_TOKEN,
			profileId: PROFILE_ID,
			environmentId: ENV_ID,
			memberUserId: MEMBER_ID,
			repository: "acme/app",
			setupDigest: "1".repeat(64),
			commitSha: COMMIT_SHA,
			setupSpec: {
				...EMPTY_CODING_SETUP,
				install: [{ from: "install", commands: [{ name: null, run: { shell: "echo step" } }] }],
			},
		};

		const [first, second] = await Promise.all([builder.buildNow(req), builder.buildNow(req)]);
		expect(maxConcurrent).toBe(1);
		expect(first.state).toBe("ready");
		expect(second.state).toBe("failed");
		expect(fakeLxd.deletedImages).toContain(SNAP_FP);
		expect(fakeLxd.instances.size).toBe(0);
		await builder.close();
	});

	it("housekeeps expired snapshots, records removals, protects referenced images, and cleans leaked VMs/images", async () => {
		const fakeLxd = makeFakeLxd();
		const orphanFp = "9".repeat(64);
		fakeLxd.images.set(SNAP_FP, {
			fingerprint: SNAP_FP,
			size: 500,
			properties: { "qorpera.kind": "coding-snapshot" },
		});
		fakeLxd.images.set(SNAP_FP_2, {
			fingerprint: SNAP_FP_2,
			size: 600,
			properties: { "qorpera.kind": "coding-snapshot" },
		});
		fakeLxd.images.set(orphanFp, {
			fingerprint: orphanFp,
			size: 700,
			properties: { "qorpera.kind": "coding-snapshot" },
		});
		fakeLxd.instances.set(`${CODING_SNAPSHOT_BUILDER_VM_PREFIX}leaked123`, {
			name: `${CODING_SNAPSHOT_BUILDER_VM_PREFIX}leaked123`,
			type: "virtual-machine",
			status: "Running",
			statusCode: 103,
			config: {},
			profiles: [],
			devices: {},
			expandedDevices: {},
			expandedConfig: {},
		});

		const removedIds: string[] = [];
		const control: CodingSnapshotRpcControl = {
			async rpc(method, args) {
				if (method === "qorpera_sweep_coding_snapshots") {
					return {
						schema: "qorpera.coding-snapshot-sweep/v1",
						abandonedBuilds: 1,
						retiredSnapshots: 2,
						pruneImages: [{ snapshotId: BUILD_ID, imageFingerprint: SNAP_FP, imageBytes: 500 }],
						keepImageFingerprints: [SNAP_FP_2],
					};
				}
				if (method === "qorpera_record_coding_snapshot_removed") {
					removedIds.push(String(args.p_snapshot_id));
					return { schema: "qorpera.coding-snapshot-removed/v1", snapshotId: args.p_snapshot_id };
				}
				return {};
			},
		};

		const builder = new CodingSnapshotBuilder({
			control,
			lxd: fakeLxd.client,
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			vmPolicy: baseVmPolicy(),
		});

		const swept = await builder.housekeep(AbortSignal.timeout(5_000));
		expect(swept).toEqual({
			abandonedBuilds: 1,
			retiredSnapshots: 2,
			prunedImages: [SNAP_FP],
			orphanImagesDeleted: [orphanFp],
			orphanVmsDeleted: [`${CODING_SNAPSHOT_BUILDER_VM_PREFIX}leaked123`],
		});
		expect(removedIds).toEqual([BUILD_ID]);
		expect(fakeLxd.images.has(BASE_FP)).toBe(true);
		expect(fakeLxd.images.has(SNAP_FP_2)).toBe(true);
		expect(fakeLxd.images.has(SNAP_FP)).toBe(false);
		expect(fakeLxd.images.has(orphanFp)).toBe(false);
		expect(fakeLxd.instances.size).toBe(0);
		await builder.close();
	});

	it("handles builder VM cleanup even when start fails immediately after create", async () => {
		const fakeLxd = makeFakeLxd();
		fakeLxd.client.setInstancePower = vi.fn().mockRejectedValue(new Error("start refused"));
		const control: CodingSnapshotRpcControl = {
			async rpc(method) {
				if (method === "qorpera_claim_coding_snapshot_build") {
					return {
						schema: "qorpera.coding-snapshot-claim/v1",
						state: "claimed",
						baseImageFingerprint: BASE_FP,
						snapshot: null,
						build: {
							buildId: BUILD_ID,
							leaseToken: BUILD_LEASE,
							leaseUntil: new Date(Date.now() + 120_000).toISOString(),
							baseImageFingerprint: BASE_FP,
							repository: "acme/app",
							setupDigest: "1".repeat(64),
							commitSha: COMMIT_SHA,
							ttlSeconds: 3600,
						},
					};
				}
				return {};
			},
		};

		const builder = new CodingSnapshotBuilder({
			control,
			lxd: fakeLxd.client,
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			vmPolicy: baseVmPolicy(),
			agentPlug: async () => PLUG_MAC,
		});

		const outcome = await builder.buildNow({
			workerId: WORKER_ID,
			leaseToken: LEASE_TOKEN,
			profileId: PROFILE_ID,
			environmentId: ENV_ID,
			memberUserId: MEMBER_ID,
			repository: "acme/app",
			setupDigest: "1".repeat(64),
			commitSha: COMMIT_SHA,
			setupSpec: EMPTY_CODING_SETUP,
		});

		expect(outcome.state).toBe("failed");
		expect(fakeLxd.deletedInstances).toHaveLength(1);
		expect(fakeLxd.instances.size).toBe(0);
		await builder.close();
	});

	it("refuses to launch a snapshot builder when the LXD project disallows the agent card", async () => {
		const fakeLxd = makeFakeLxd();
		const plugSpy = vi.fn(async () => PLUG_MAC);
		const control: CodingSnapshotRpcControl = {
			async rpc(method) {
				if (method === "qorpera_claim_coding_snapshot_build") {
					return {
						schema: "qorpera.coding-snapshot-claim/v1",
						state: "claimed",
						baseImageFingerprint: BASE_FP,
						snapshot: null,
						build: {
							buildId: BUILD_ID,
							leaseToken: BUILD_LEASE,
							leaseUntil: new Date(Date.now() + 120_000).toISOString(),
							profileId: PROFILE_ID,
							memberUserId: MEMBER_ID,
							baseImageFingerprint: BASE_FP,
							repository: "acme/app",
							setupDigest: "1".repeat(64),
							commitSha: COMMIT_SHA,
							ttlSeconds: 3600,
						},
					};
				}
				return { schema: "qorpera.coding-snapshot-build/v1", buildId: BUILD_ID, state: "failed" };
			},
		};
		const builder = new CodingSnapshotBuilder({
			control,
			lxd: fakeLxd.client,
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			vmPolicy: baseVmPolicy(),
			agentPlug: plugSpy,
			projectAllowsAgentCard: async () => false,
		});
		const outcome = await builder.buildNow({
			workerId: WORKER_ID,
			leaseToken: LEASE_TOKEN,
			profileId: PROFILE_ID,
			environmentId: ENV_ID,
			memberUserId: MEMBER_ID,
			repository: "acme/app",
			setupDigest: "1".repeat(64),
			commitSha: COMMIT_SHA,
			setupSpec: EMPTY_CODING_SETUP,
		});
		expect(outcome.state).toBe("failed");
		if (outcome.state === "failed") expect(outcome.code).toBe("PROJECT_REFUSES_AGENT_CARD");
		expect(plugSpy).not.toHaveBeenCalled();
		expect(fakeLxd.createRequests).toHaveLength(0);
		await builder.close();
	});

	it("protects a newly published snapshot image when housekeep sweeps before complete commits (F7)", async () => {
		const fakeLxd = makeFakeLxd();
		let releaseComplete!: () => void;
		let completeStarted!: () => void;
		const completeStartedPromise = new Promise<void>((resolve) => {
			completeStarted = resolve;
		});
		const completeGate = new Promise<void>((resolve) => {
			releaseComplete = resolve;
		});
		let releaseSweep!: () => void;
		const sweepGate = new Promise<void>((resolve) => {
			releaseSweep = resolve;
		});
		const control: CodingSnapshotRpcControl = {
			async rpc(method, args) {
				if (method === "qorpera_claim_coding_snapshot_build") {
					return {
						schema: "qorpera.coding-snapshot-claim/v1",
						state: "claimed",
						baseImageFingerprint: BASE_FP,
						snapshot: null,
						build: {
							buildId: BUILD_ID,
							leaseToken: BUILD_LEASE,
							leaseUntil: new Date(Date.now() + 120_000).toISOString(),
							profileId: PROFILE_ID,
							memberUserId: MEMBER_ID,
							baseImageFingerprint: BASE_FP,
							repository: "acme/app",
							setupDigest: "1".repeat(64),
							commitSha: COMMIT_SHA,
							ttlSeconds: 3600,
						},
					};
				}
				if (method === "qorpera_complete_coding_snapshot_build") {
					completeStarted();
					await completeGate;
					return {
						schema: "qorpera.coding-snapshot-build/v1",
						buildId: BUILD_ID,
						state: "ready",
						imageFingerprint: args.p_image_fingerprint,
						imageBytes: args.p_image_bytes,
						expiresAt: null,
					};
				}
				if (method === "qorpera_sweep_coding_snapshots") {
					const reply = {
						schema: "qorpera.coding-snapshot-sweep/v1",
						abandonedBuilds: 0,
						retiredSnapshots: 0,
						pruneImages: [],
						keepImageFingerprints: [],
					};
					await sweepGate;
					return reply;
				}
				return {};
			},
		};
		const builder = new CodingSnapshotBuilder({
			control,
			lxd: fakeLxd.client,
			owner: "node-1",
			machineIdSha256: MACHINE_SHA,
			vmPolicy: baseVmPolicy(),
			agentPlug: async () => PLUG_MAC,
			readyPollMs: 5,
		});
		const buildPromise = builder.buildNow({
			workerId: WORKER_ID,
			leaseToken: LEASE_TOKEN,
			profileId: PROFILE_ID,
			environmentId: ENV_ID,
			memberUserId: MEMBER_ID,
			repository: "acme/app",
			setupDigest: "1".repeat(64),
			commitSha: COMMIT_SHA,
			setupSpec: EMPTY_CODING_SETUP,
		});
		await completeStartedPromise;
		const housekeepPromise = builder.housekeep(AbortSignal.timeout(5_000));
		releaseComplete();
		const built = await buildPromise;
		expect(built.state).toBe("ready");
		releaseSweep();
		const swept = await housekeepPromise;
		expect(swept.orphanImagesDeleted).toEqual([]);
		expect(fakeLxd.images.has(SNAP_FP)).toBe(true);
		await builder.close();
	});
});
