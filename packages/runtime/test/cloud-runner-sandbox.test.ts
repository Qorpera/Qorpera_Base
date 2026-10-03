import { link, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	HostedArtifactIndex,
	HostedArtifactIndexEntry,
	HostedCompanyOperation,
	HostedCompanySnapshot,
	HostedCompanySubstrateVersion,
} from "@qorpera/cloud-client/hosted-primary";
import { captureCloudCompanyTree } from "@qorpera/cloud-client/node/cloud-company-snapshot";
import type { ResolvedCompanySubstrateReference } from "@qorpera/cloud-client/node/cloud-company-substrate";
import { CloudContentAddressedStore, type CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import type { CloudRunnerJob } from "@qorpera/cloud-client/node/cloud-runner-protocol";
import type { JsonValue } from "@qorpera/contracts";
import type {
	CloudRunnerCanonicalTranscriptEvent,
	CloudRunnerQueuedInput,
	CloudRunnerSandboxBackend,
	CloudRunnerSandboxGuarantees,
	CloudRunnerSandboxProcess,
	CloudRunnerSandboxRequest,
	CloudRunnerSubstrateResolver,
	ResolvedCloudRunnerExecutionContext,
} from "@qorpera/runtime/cloud-runner-sandbox";
import { executeCloudRunnerJob } from "@qorpera/runtime/cloud-runner-sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scaffoldCompany } from "./fixtures/scaffold-company.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const versionId = "66666666-6666-4666-8666-666666666666";
const artifactIndexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const artifactId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const jobId = "77777777-7777-4777-8777-777777777777";
const runId = "89898989-8989-4989-8989-898989898989";
const assignmentId = "78787878-7878-4787-8787-787878787878";
const sessionId = "45454545-4545-4454-8545-454545454545";
const runnerId = "88888888-8888-4888-8888-888888888888";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";
const staffAgentId = "69696969-6969-4969-8969-696969696969";
const inputId = "70707070-7070-4070-8070-707070707070";
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
	companyCheckout: "job_private",
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
	readonly jobTypes = ["agent_turn", "proposal_review"] as const;
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
	readonly execution: ResolvedCloudRunnerExecutionContext;
	readonly transcript: CloudRunnerCanonicalTranscriptEvent[];
	readonly inputs: CloudRunnerQueuedInput[];
	readonly operations: HostedCompanyOperation[];
	readonly artifacts: HostedArtifactIndexEntry[];
	resolveCalls = 0;

	constructor(
		resolved: ResolvedCompanySubstrateReference,
		operations: HostedCompanyOperation[],
		artifacts: HostedArtifactIndexEntry[],
		execution: ResolvedCloudRunnerExecutionContext,
		transcript: CloudRunnerCanonicalTranscriptEvent[],
		inputs: CloudRunnerQueuedInput[],
	) {
		this.resolved = resolved;
		this.operations = operations;
		this.artifacts = artifacts;
		this.execution = execution;
		this.transcript = transcript;
		this.inputs = inputs;
	}

	async resolveExecution(): Promise<ResolvedCloudRunnerExecutionContext> {
		return this.execution;
	}

	async listTranscript(afterSequence = 0): Promise<CloudRunnerCanonicalTranscriptEvent[]> {
		return this.transcript.filter((event) => event.sequence > afterSequence);
	}

	async listInputs(): Promise<CloudRunnerQueuedInput[]> {
		return structuredClone(this.inputs);
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
	inputImageObject: { sha256: string; bytes: number };
	substrate: FixtureSubstrate;
	job: CloudRunnerJob;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(await realpath(tmpdir()), "qorpera-runner-sandbox-test-"));
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
	const inputImageBytes = Buffer.from("image-bytes", "utf-8");
	const inputImageObject = await objects.putObject(profileId, inputImageBytes, "image/png");
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
	const execution: ResolvedCloudRunnerExecutionContext = {
		run: {
			runId,
			profileId,
			environmentId,
			sourceKind: "session_turn",
			sourceId: "12121212-1212-4212-8212-121212121212",
			sessionId,
			jobId,
			substrateVersionId: versionId,
			companySnapshotId: snapshotId,
			staffAgentId,
			staffVersion: 3,
			inputIds: [inputId],
			sponsorBindingId: "56565656-5656-4565-8565-565656565656",
			sponsorVersion: 1,
			requiredCapability: "agent_turn",
			jobType: "agent_turn",
			payloadSha256: "9".repeat(64),
			publicationMode: "automatic",
			reviewerStaffIds: [],
			computeIdentityId: "78787878-7878-4787-8787-787878787878",
			computeIdentityOwnershipKind: "member",
			computeIdentityOwnerUserId: actorUserId,
			transcriptStartSequence: 1,
			status: "runner_started",
			createdByUserId: actorUserId,
			requestedByUserId: actorUserId,
			sponsoredByUserId: actorUserId,
			createdAt,
		},
		sponsor: {
			bindingId: "56565656-5656-4565-8565-565656565656",
			version: 1,
			kind: "member_connection",
			providerConnectionId: "67676767-6767-4676-8676-676767676767",
			providerConnectionVersion: 2,
			provider: "openai",
			authenticationMode: "native_subscription",
			nativeHarness: "codex",
			allowAutonomous: false,
		},
	};
	const transcript: CloudRunnerCanonicalTranscriptEvent[] = [
		{
			sessionId,
			sequence: 1,
			eventId: "23232323-2323-4232-8232-232323232323",
			eventType: "message",
			actorUserId,
			body: { schema: "qorpera.shared-trail-entry-part/v1", payloadBase64: "e30=" },
			eventHash: "8".repeat(64),
			createdAt,
		},
	];
	const inputs: CloudRunnerQueuedInput[] = [
		{
			inputId,
			position: 1,
			kind: "user_message",
			authorUserId: actorUserId,
			authorDisplayName: "Owner",
			body: {
				schema: "qorpera.session-prompt/v1",
				text: "Prepare the plan",
				images: [
					{
						objectSha256: inputImageObject.sha256,
						bytes: inputImageObject.bytes,
						mediaType: inputImageObject.mediaType,
					},
				],
			},
			createdAt,
		},
	];
	const substrate = new FixtureSubstrate(
		{ version, snapshot, artifactIndex },
		[operation],
		[artifact],
		execution,
		transcript,
		inputs,
	);
	const job: CloudRunnerJob = {
		jobId,
		runId,
		profileId,
		environmentId,
		sessionId,
		substrateVersionId: versionId,
		clientJobId: "13131313-1313-4313-8313-131313131313",
		assignmentId,
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
	return { temporaryRoot, objects, inputImageObject, substrate, job };
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
			await expect(readFile(join(request.input.companyRoot, ".git", "HEAD"), "utf-8")).resolves.toBe(
				"ref: refs/heads/qorpera-runner\n",
			);
			await expect(
				readFile(join(request.input.companyRoot, ".git", "refs", "heads", "qorpera-runner"), "utf-8"),
			).resolves.toMatch(/^[0-9a-f]{40}\n$/);
			await expect(readFile(join(request.input.companyBaseRoot, "company.md"), "utf-8")).resolves.toBe(
				"# Exact company\n",
			);
			await expect(readFile(join(request.input.companyRoot, "company.md"), "utf-8")).resolves.toBe(
				"# Exact company\n",
			);
			await writeFile(join(request.input.companyRoot, "company.md"), "# Runner revision\n", "utf-8");
			await expect(readFile(join(request.input.companyBaseRoot, "company.md"), "utf-8")).resolves.toBe(
				"# Exact company\n",
			);
			await expect(readFile(request.input.operationsPath, "utf-8")).resolves.toContain("immutable operation");
			const queuedInput = JSON.parse((await readFile(request.input.queuedInputsPath, "utf-8")).trim()) as {
				inputId: string;
				materializedImages: Array<{ objectSha256: string; path: string }>;
			};
			expect(queuedInput).toMatchObject({
				inputId,
				materializedImages: [
					{
						objectSha256: fixture.inputImageObject.sha256,
						path: `/qorpera/input/attachments/${inputId}/01-${fixture.inputImageObject.sha256}`,
					},
				],
			});
			await expect(
				readFile(join(request.input.attachmentsRoot, inputId, `01-${fixture.inputImageObject.sha256}`), "utf-8"),
			).resolves.toBe("image-bytes");
			await expect(readFile(request.input.transcriptPath, "utf-8")).resolves.toContain(
				"23232323-2323-4232-8232-232323232323",
			);
			await expect(readFile(request.input.executionContextPath, "utf-8")).resolves.toContain(
				'"schema":"qorpera.runner-execution-context/v1"',
			);
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
		const monotonicNow = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125);
		const publishCompanyFile = vi.fn(async (input: { companyRoot: string; baseSnapshot: { snapshotId: string } }) => {
			expect(input.baseSnapshot.snapshotId).toBe(snapshotId);
			await expect(readFile(join(input.companyRoot, "company.md"), "utf-8")).resolves.toBe("# Runner revision\n");
			return "46464646-4646-4646-8646-464646464646";
		});

		const execution = await executeCloudRunnerJob({
			...fixture,
			backend,
			allowTestBackend: true,
			environment: { QORPERA_JOB_MODE: "test" },
			outputPublisher: { publish },
			companyFilePublisher: { publish: publishCompanyFile },
			monotonicNow,
		});

		expect(execution.result).toMatchObject({
			schema: "qorpera.runner-result/v1",
			backend_result: { status: "ok" },
			output_count: 1,
			publication: { artifact: "bounded answer\n" },
			usage: {
				schema: "qorpera.runner-usage/v1",
				execution_ms: 25,
				output_bytes: 15,
				result_bytes: 15,
				limits: { cpu_millis: 2000 },
			},
		});
		expect(execution.usage).toMatchObject({ executionMs: 25, outputBytes: 15, resultBytes: 15 });
		expect(execution.usage.inputBytes).toBeGreaterThan(0);
		expect(execution.outputFiles).toMatchObject([{ path: "answer.md", bytes: 15 }]);
		expect(execution.outputSnapshotId).toBe("46464646-4646-4646-8646-464646464646");
		expect(publish).toHaveBeenCalledOnce();
		expect(publishCompanyFile).toHaveBeenCalledOnce();
		await expect(stat(executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("materializes the exact proposed Company File as read-only review input", async () => {
		const fixture = await sandboxFixture();
		const proposedRoot = join(fixture.temporaryRoot, "proposed-company");
		scaffoldCompany(proposedRoot);
		await writeFile(join(proposedRoot, "company.md"), "# Proposed company\n", "utf-8");
		const proposalSnapshotId = "47474747-4747-4747-8747-474747474747";
		const proposalTree = await captureCloudCompanyTree(proposedRoot, profileId, fixture.objects);
		fixture.substrate.execution.proposalSnapshot = {
			snapshotId: proposalSnapshotId,
			profileId,
			environmentId,
			workspaceId,
			clientSnapshotId: "48484848-4848-4484-8484-484848484848",
			parentSnapshotId: snapshotId,
			tree: proposalTree,
			createdByUserId: actorUserId,
			createdAt,
		};
		fixture.substrate.execution.run.sourceKind = "proposal_review";
		delete fixture.substrate.execution.run.sessionId;
		fixture.substrate.execution.run.inputIds = [];
		fixture.substrate.execution.run.jobType = "proposal_review";
		fixture.substrate.execution.run.transcriptStartSequence = 0;
		fixture.substrate.execution.sponsor.allowAutonomous = true;
		delete fixture.job.sessionId;
		fixture.job.jobType = "proposal_review";
		fixture.job.payload = {
			schema: "qorpera.company-proposal-review/v1",
			proposal_snapshot: { snapshot_id: proposalSnapshotId },
		};
		fixture.substrate.inputs.splice(0);
		fixture.substrate.transcript.splice(0);
		const publishCompanyFile = vi.fn(async () => "49494949-4949-4494-8494-494949494949");
		const backend = new TestSandboxBackend(async (request) => {
			expect(request.input.proposalRoot).toBeDefined();
			await expect(readFile(join(request.input.companyBaseRoot, "company.md"), "utf-8")).resolves.toBe(
				"# Exact company\n",
			);
			await expect(readFile(join(request.input.proposalRoot ?? "", "company.md"), "utf-8")).resolves.toBe(
				"# Proposed company\n",
			);
			await expect(readFile(request.input.substrateManifestPath, "utf-8")).resolves.toContain(
				`"proposalSnapshotId":"${proposalSnapshotId}"`,
			);
			return { status: "ok", review: { decision: "approve", comment: "Verified the proposed bytes." } };
		});

		const result = await executeCloudRunnerJob({
			...fixture,
			backend,
			allowTestBackend: true,
			companyFilePublisher: { publish: publishCompanyFile },
		});
		expect(result.outputSnapshotId).toBeUndefined();
		expect(publishCompanyFile).not.toHaveBeenCalled();
	});

	it("rejects artifacts produced by a proposal review", async () => {
		const fixture = await sandboxFixture();
		const proposalSnapshotId = "47474747-4747-4747-8747-474747474747";
		fixture.substrate.execution.proposalSnapshot = {
			...fixture.substrate.resolved.snapshot,
			snapshotId: proposalSnapshotId,
			clientSnapshotId: "48484848-4848-4484-8484-484848484848",
			tree: { ...fixture.substrate.resolved.snapshot.tree, contractVersion: 3 },
		};
		fixture.substrate.execution.run.sourceKind = "proposal_review";
		delete fixture.substrate.execution.run.sessionId;
		fixture.substrate.execution.run.inputIds = [];
		fixture.substrate.execution.run.jobType = "proposal_review";
		fixture.substrate.execution.run.transcriptStartSequence = 0;
		fixture.substrate.execution.sponsor.allowAutonomous = true;
		delete fixture.job.sessionId;
		fixture.job.jobType = "proposal_review";
		fixture.job.payload = {
			schema: "qorpera.company-proposal-review/v1",
			proposal_snapshot: { snapshot_id: proposalSnapshotId },
		};
		fixture.substrate.inputs.splice(0);
		fixture.substrate.transcript.splice(0);
		const backend = new TestSandboxBackend(async (request) => {
			await writeFile(join(request.outputRoot, "untrusted.txt"), "review side output", "utf-8");
			return { status: "ok", review: { decision: "approve", comment: "Looks fine." } };
		});

		await expect(executeCloudRunnerJob({ ...fixture, backend, allowTestBackend: true })).rejects.toThrow(
			"cannot publish artifacts",
		);
	});

	it("refuses an in-process test backend unless the caller explicitly enables test execution", async () => {
		const fixture = await sandboxFixture();
		const backend = new TestSandboxBackend(async () => ({ status: "not-run" }));
		await expect(executeCloudRunnerJob({ ...fixture, backend })).rejects.toThrow(
			"Test sandbox backend cannot execute untrusted runner work",
		);
		expect(fixture.substrate.resolveCalls).toBe(0);
	});

	it("refuses a folder-v2 run, which has no Company File substrate, before resolving anything", async () => {
		const fixture = await sandboxFixture();
		delete fixture.job.substrateVersionId;
		const backend = new TestSandboxBackend(async () => ({ status: "not-run" }));
		await expect(executeCloudRunnerJob({ ...fixture, backend, allowTestBackend: true })).rejects.toThrow(
			"needs a Company File substrate",
		);
		expect(fixture.substrate.resolveCalls).toBe(0);
	});

	it("creates a disposable host-only broker directory without putting credentials in the sandbox request", async () => {
		const fixture = await sandboxFixture();
		let brokerRoot = "";
		const modelBroker = {
			requestModel: vi.fn(async () => {
				throw new Error("not called by the sandbox materialization test");
			}),
		};
		const backend = new TestSandboxBackend(async (request) => {
			expect(request.hostBroker?.model).toBe(modelBroker);
			brokerRoot = request.hostBroker?.root ?? "";
			expect(brokerRoot).toBe(join(dirname(dirname(request.input.companyRoot)), "broker"));
			expect((await stat(brokerRoot)).isDirectory()).toBe(true);
			return { status: "ok" };
		});

		await executeCloudRunnerJob({
			...fixture,
			backend,
			modelBroker,
			allowTestBackend: true,
		});

		expect(modelBroker.requestModel).not.toHaveBeenCalled();
		await expect(stat(brokerRoot)).rejects.toMatchObject({ code: "ENOENT" });
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
