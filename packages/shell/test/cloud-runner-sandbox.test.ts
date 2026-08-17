import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import type { JsonValue } from "@qorpera/pi-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCloudCompanyTree } from "../src/cloud-company-snapshot.ts";
import type { ResolvedCompanySubstrateReference } from "../src/cloud-company-substrate.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";
import type { CloudRunnerJob } from "../src/cloud-runner-control.ts";
import type {
	CloudRunnerSandboxBackend,
	CloudRunnerSandboxGuarantees,
	CloudRunnerSandboxProcess,
	CloudRunnerSandboxRequest,
	CloudRunnerSubstrateResolver,
} from "../src/cloud-runner-sandbox.ts";
import { executeCloudRunnerJob } from "../src/cloud-runner-sandbox.ts";
import type {
	HostedArtifactIndex,
	HostedArtifactIndexEntry,
	HostedCompanyOperation,
	HostedCompanySnapshot,
	HostedCompanySubstrateVersion,
} from "../src/hosted-primary.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const versionId = "66666666-6666-4666-8666-666666666666";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const artifactId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const jobId = "77777777-7777-4777-8777-777777777777";
const runnerId = "88888888-8888-4888-8888-888888888888";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const createdAt = "2026-08-17T00:00:00.000Z";
const temporaryDirectories: string[] = [];

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
		if (this.objects.has(path)) return "exists";
		this.objects.set(path, Uint8Array.from(bytes));
		return "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		const bytes = this.objects.get(path);
		if (!bytes) throw new Error("object not found");
		return Uint8Array.from(bytes);
	}
}

const testGuarantees: CloudRunnerSandboxGuarantees = {
	boundary: "test",
	hostFilesystem: "none",
	inputFilesystem: "read_only",
	outputFilesystem: "job_private",
	network: "deny_by_default",
	environment: "allowlist_only",
	privileges: "unprivileged",
	resourceLimits: "kernel_enforced",
	termination: "boundary_destroyed",
};

class TestSandboxBackend implements CloudRunnerSandboxBackend {
	readonly backendId = "synthetic-test";
	readonly guarantees: Readonly<CloudRunnerSandboxGuarantees>;
	readonly capabilities = ["agent_turn"] as const;
	readonly jobTypes = ["agent_turn"] as const;
	readonly #handler: (request: CloudRunnerSandboxRequest, signal: AbortSignal) => Promise<JsonValue>;
	terminateCalls = 0;

	constructor(
		handler: (request: CloudRunnerSandboxRequest, signal: AbortSignal) => Promise<JsonValue>,
		guarantees: Readonly<CloudRunnerSandboxGuarantees> = testGuarantees,
	) {
		this.#handler = handler;
		this.guarantees = guarantees;
	}

	async start(request: CloudRunnerSandboxRequest): Promise<CloudRunnerSandboxProcess> {
		const controller = new AbortController();
		const result = Promise.resolve().then(() => this.#handler(request, controller.signal));
		return {
			result,
			terminate: async () => {
				this.terminateCalls++;
				controller.abort();
				await result.catch(() => undefined);
			},
		};
	}
}

class FixtureSubstrate implements CloudRunnerSubstrateResolver {
	readonly resolved: ResolvedCompanySubstrateReference;
	readonly operations: HostedCompanyOperation[];
	readonly artifacts: HostedArtifactIndexEntry[];
	resolveCalls = 0;

	constructor(
		resolved: ResolvedCompanySubstrateReference,
		operations: HostedCompanyOperation[],
		artifacts: HostedArtifactIndexEntry[],
	) {
		this.resolved = resolved;
		this.operations = operations;
		this.artifacts = artifacts;
	}

	async resolve(): Promise<ResolvedCompanySubstrateReference> {
		this.resolveCalls++;
		return this.resolved;
	}

	async listOperations(_version: HostedCompanySubstrateVersion, afterSequence = 0): Promise<HostedCompanyOperation[]> {
		return this.operations.filter((operation) => operation.sequence > afterSequence);
	}

	async listArtifacts(_index: HostedArtifactIndex, afterOrdinal = 0): Promise<HostedArtifactIndexEntry[]> {
		return this.artifacts.filter((artifact) => artifact.ordinal > afterOrdinal);
	}
}

interface SandboxFixture {
	temporaryRoot: string;
	objects: CloudContentAddressedStore;
	substrate: FixtureSubstrate;
	job: CloudRunnerJob;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "qorpera-runner-sandbox-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function sandboxFixture(): Promise<SandboxFixture> {
	const temporaryRoot = await temporaryDirectory();
	const companyRoot = join(temporaryRoot, "company");
	scaffoldCompany(companyRoot);
	await writeFile(join(companyRoot, "company.md"), "# Exact company\n", "utf-8");
	const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
	const tree = await captureCloudCompanyTree(companyRoot, profileId, objects);
	const artifactBytes = Buffer.from("verified artifact\n", "utf-8");
	const artifactObject = await objects.putObject(profileId, artifactBytes, "text/plain");
	const artifactIndex: HostedArtifactIndex = {
		indexId: artifactIndexId,
		profileId,
		environmentId,
		clientIndexId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		contractVersion: 1,
		contentSha256: "d".repeat(64),
		artifactCount: 1,
		totalBytes: artifactBytes.byteLength,
		createdByUserId: actorUserId,
		createdAt,
	};
	const snapshot: HostedCompanySnapshot = {
		snapshotId,
		profileId,
		environmentId,
		workspaceId,
		clientSnapshotId: "55555555-5555-4555-8555-555555555555",
		tree,
		createdByUserId: actorUserId,
		createdAt,
	};
	const version: HostedCompanySubstrateVersion = {
		versionId,
		profileId,
		environmentId,
		companySnapshotId: snapshotId,
		clientVersionId: "99999999-9999-4999-8999-999999999999",
		contractVersion: 1,
		operationSequence: 2,
		operationCount: 1,
		artifactIndexId,
		artifactManifestSha256: artifactIndex.contentSha256,
		contentSha256: "e".repeat(64),
		createdByUserId: actorUserId,
		createdAt,
	};
	const operation: HostedCompanyOperation = {
		profileId,
		sequence: 2,
		environmentId,
		operationType: "session_event",
		entityId: "12121212-1212-4212-8212-121212121212",
		entityVersion: 1,
		contentSha256: "f".repeat(64),
		payload: { message: "immutable operation" },
		actorUserId,
		createdAt,
	};
	const artifact: HostedArtifactIndexEntry = {
		ordinal: 1,
		artifactId,
		profileId,
		environmentId,
		clientArtifactId: "abababab-abab-4bab-8bab-abababababab",
		artifactType: "text",
		name: "plan.txt",
		rootObjectSha256: artifactObject.sha256,
		rootContract: "qorpera.object/v1",
		contentSha256: artifactObject.sha256,
		bytes: artifactObject.bytes,
		mediaType: artifactObject.mediaType,
		createdByUserId: actorUserId,
		createdAt,
		eligibleForGcAt: "2026-09-17T00:00:00.000Z",
	};
	const substrate = new FixtureSubstrate({ version, snapshot, artifactIndex }, [operation], [artifact]);
	const job: CloudRunnerJob = {
		jobId,
		profileId,
		environmentId,
		substrateVersionId: versionId,
		clientJobId: "13131313-1313-4313-8313-131313131313",
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: { prompt: "Prepare the plan" },
		status: "leased",
		attemptCount: 1,
		runnerId,
		outputArtifactCount: 0,
		createdByUserId: actorUserId,
		createdAt,
		startedAt: createdAt,
		leaseExpiresAt: "2026-08-17T00:02:00.000Z",
	};
	return { temporaryRoot, objects, substrate, job };
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud runner execution sandboxes", () => {
	it("materializes one exact substrate, publishes bounded output, and removes the disposable workspace", async () => {
		const fixture = await sandboxFixture();
		let executionRoot = "";
		const backend = new TestSandboxBackend(async (request) => {
			executionRoot = dirname(dirname(request.input.companyRoot));
			await expect(readFile(join(request.input.companyRoot, "company.md"), "utf-8")).resolves.toBe(
				"# Exact company\n",
			);
			await expect(readFile(request.input.operationsPath, "utf-8")).resolves.toContain("immutable operation");
			await expect(readFile(join(request.input.artifactsRoot, "000001", "content"), "utf-8")).resolves.toBe(
				"verified artifact\n",
			);
			expect(request.environment).toEqual({ QORPERA_JOB_MODE: "test" });
			expect(request.substrate).toMatchObject({ versionId, operationCount: 1, artifactCount: 1 });
			await writeFile(join(request.outputRoot, "answer.md"), "bounded answer\n", "utf-8");
			return { status: "ok" };
		});
		const publish = vi.fn(async (input: { outputRoot: string }) => ({
			artifact: await readFile(join(input.outputRoot, "answer.md"), "utf-8"),
		}));

		const execution = await executeCloudRunnerJob({
			...fixture,
			backend,
			allowTestBackend: true,
			environment: { QORPERA_JOB_MODE: "test" },
			outputPublisher: { publish },
		});

		expect(execution.result).toMatchObject({
			schema: "qorpera.runner-result/v1",
			backend_result: { status: "ok" },
			output_count: 1,
			publication: { artifact: "bounded answer\n" },
		});
		expect(execution.outputFiles).toMatchObject([{ path: "answer.md", bytes: 15 }]);
		expect(publish).toHaveBeenCalledOnce();
		await expect(stat(executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses an in-process test backend unless the caller explicitly enables test execution", async () => {
		const fixture = await sandboxFixture();
		const backend = new TestSandboxBackend(async () => ({ status: "not-run" }));
		await expect(executeCloudRunnerJob({ ...fixture, backend })).rejects.toThrow(
			"Test sandbox backend cannot execute untrusted runner work",
		);
		expect(fixture.substrate.resolveCalls).toBe(0);
	});

	it("refuses a backend that does not deny host filesystem access", async () => {
		const fixture = await sandboxFixture();
		const backend = new TestSandboxBackend(async () => ({ status: "not-run" }), {
			...testGuarantees,
			hostFilesystem: "host_visible" as "none",
		});
		await expect(executeCloudRunnerJob({ ...fixture, backend, allowTestBackend: true })).rejects.toThrow(
			"required isolation guarantees",
		);
	});

	it("terminates a sandbox at its wall-time limit and cleans its materialized input", async () => {
		const fixture = await sandboxFixture();
		let executionRoot = "";
		const backend = new TestSandboxBackend(async (request, signal) => {
			executionRoot = dirname(dirname(request.input.companyRoot));
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("terminated")), { once: true });
			});
			return { status: "unreachable" };
		});
		await expect(
			executeCloudRunnerJob({
				...fixture,
				backend,
				allowTestBackend: true,
				limits: { wallTimeMs: 20 },
			}),
		).rejects.toThrow("wall-time limit");
		expect(backend.terminateCalls).toBe(1);
		await expect(stat(executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects output that exceeds the byte limit and still removes the workspace", async () => {
		const fixture = await sandboxFixture();
		let executionRoot = "";
		const backend = new TestSandboxBackend(async (request) => {
			executionRoot = dirname(dirname(request.input.companyRoot));
			await writeFile(join(request.outputRoot, "too-large.txt"), "12345", "utf-8");
			return { status: "ok" };
		});
		await expect(
			executeCloudRunnerJob({
				...fixture,
				backend,
				allowTestBackend: true,
				limits: { maxOutputBytes: 4 },
			}),
		).rejects.toThrow("output exceeds its byte limit");
		await expect(stat(executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects linked output instead of publishing data outside the private output mount", async () => {
		const fixture = await sandboxFixture();
		const backend = new TestSandboxBackend(async (request) => {
			await link(join(request.input.companyRoot, "company.md"), join(request.outputRoot, "linked.md"));
			return { status: "ok" };
		});
		await expect(executeCloudRunnerJob({ ...fixture, backend, allowTestBackend: true })).rejects.toThrow(
			"private physical files",
		);
	});

	it("does not pass credentials through the sandbox environment", async () => {
		const fixture = await sandboxFixture();
		const backend = new TestSandboxBackend(async () => ({ status: "not-run" }));
		await expect(
			executeCloudRunnerJob({
				...fixture,
				backend,
				allowTestBackend: true,
				environment: { SUPABASE_AUTH_TOKEN: "secret" },
			}),
		).rejects.toThrow("cannot contain credentials");
		expect(fixture.substrate.resolveCalls).toBe(0);
	});
});
