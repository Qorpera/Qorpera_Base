import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudCodingCommandGateway } from "@qorpera/runtime/cloud-coding-command-tools";
import { type CloudCodingNativeControl, CloudNativeCodingRuntime } from "@qorpera/runtime/cloud-native-coding-runtime";
import { CloudNativeCompanyRuntime } from "@qorpera/runtime/cloud-native-company-runtime";
import { nativeRuntimeFailureMetadata } from "@qorpera/runtime/cloud-native-failure";
import { HttpNativeProviderComputerBridge } from "@qorpera/runtime/cloud-native-provider";
import {
	type NativeCompanyExecutionRequest,
	NativeProviderHost,
	sealNativeCredentialCapsule,
} from "@qorpera/runtime/cloud-native-provider-host";
import {
	HttpNativeProviderHostService,
	nativeProviderFailureCode,
} from "@qorpera/runtime/cloud-native-provider-service";
import type { CloudRunnerNativeAuthority } from "@qorpera/runtime/cloud-runner-broker";
import * as runtimeBundle from "@qorpera/runtime/cloud-runtime-bundle";
import { CLOUD_RUNTIME_NATIVE_BINARY_SHA256 } from "@qorpera/runtime/cloud-runtime-bundle.generated";
import {
	type CloudRuntimeObservation,
	parseCloudRuntimeObservation,
} from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeCompanyContextFixture } from "./fixtures/native-company-context-fixture.ts";

const rpcFixture = fileURLToPath(new URL("./fixtures/codex-boundary-rpc-fixture.cjs", import.meta.url));
const binarySha256 = createHash("sha256")
	.update(await readFile(process.execPath))
	.digest("hex");
let root: string;
const assertBundle = runtimeBundle.assertCloudRuntimeBundle;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "qorpera-coding-turn-end-test-"));
	// The synthetic native protocol fixture is Node, not the signed Linux binary.
	vi.spyOn(runtimeBundle, "assertCloudRuntimeBundle").mockImplementation((identity) =>
		assertBundle(identity, CLOUD_RUNTIME_NATIVE_BINARY_SHA256),
	);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

/** A coding session's turn through the production composition: the company runtime
 * selects the coding runtime, which runs the real native session against the
 * synthetic Codex. In the fixture's default mode the model writes a final text
 * message and ends its turn without calling a tool, as it did on 2026-10-01 05:13Z
 * when told to "end your turn without waiting". */
async function fixture() {
	const f = nativeCompanyContextFixture();
	// A coding session has no conversation: its audience is the company.
	f.context = { ...f.context, identity: { ...f.context.identity, sessionId: null } };
	f.authority = { ...f.authority, identity: { ...f.authority.identity, sessionId: null } };
	const identity = f.context.identity;
	const workerId = randomUUID();
	const parentRunId = randomUUID();
	const repository = { host: "github.com", owner: "Qorpera", name: "test", baseBranch: "main" };
	const scope = {
		harness: "codex",
		repository,
		branch: `qorpera/coding/${workerId}`,
		baseSha: null,
		harnessSessionRef: null,
		sequence: 1,
		vmId: randomUUID(),
	};
	const goal = "Start sh -c 'sleep 900; echo done' with no time limit, check it is running, then end your turn.";
	const wake = {
		schema: "qorpera.wake-envelope/v1",
		id: randomUUID(),
		runId: identity.runId,
		kind: "agent",
		companyId: identity.companyId,
		environmentId: identity.environmentId,
		staffAgentId: identity.staffAgentId,
		requesterUserId: identity.requesterUserId,
		actorStaffId: null,
		actorUserId: null,
		audience: { kind: "company", userId: null, sessionId: null },
		source: { kind: "worker-dispatch", id: workerId, occurrenceKey: `worker-dispatch:${workerId}:1` },
		policy: {
			schema: "qorpera.wake-policy/v1",
			kind: "agent",
			initial: "forbidden",
			final: "forbidden",
			silenceAllowed: true,
			maxPublicSends: 0,
		},
		time: {
			utc: "2026-10-01T05:13:00.000000Z",
			local: "2026-10-01T07:13:00.000000",
			timeZone: "Europe/Copenhagen",
		},
		pins: {
			companySnapshotId: randomUUID(),
			staffVersion: identity.staffVersion,
			wakeSchema: "qorpera.wake-envelope/v1",
			runtimeBundleVersion: null,
		},
		routine: null,
		parentRunId,
		payload: {
			schema: "qorpera.worker-dispatch/v1",
			workerId,
			workerKey: "sleep-check",
			sequence: 1,
			species: "coding",
			title: "Start a long command",
			todo: { todoKey: "sleep", title: "Sleep", path: `work/todos/${identity.staffAgentId}/sleep.json` },
			parentRunId,
			access: "read",
			outputFolder: `work/todos/${identity.staffAgentId}/sleep/sleep-check`,
			dispatch: {
				goal,
				definitionOfDone: "The command is running.",
				context: "",
				sources: [],
				followUp: null,
				authority: "Work only on the session branch.",
				output: "End the turn with coding_finish or coding_ask.",
				cancellation: "Ends with its todo.",
				completion: "The parent is revived when the turn ends.",
			},
			coding: scope,
		},
		causal: { rootId: randomUUID(), agentIds: [identity.staffAgentId] },
	};
	const coding = {
		workerId,
		sequence: 1,
		turnId: randomUUID(),
		vmId: scope.vmId,
		harness: "codex",
		model: null,
		repository,
		branch: scope.branch,
		baseSha: null,
		harnessSessionRef: null,
		title: "Start a long command",
		goal,
		definitionOfDone: "The command is running.",
		context: "",
		followUp: null,
		pullRequest: null,
		submission: null,
	};
	const codingCall = vi.fn<CloudCodingNativeControl["call"]>(async (method, args) => {
		expect(args.p_binding).toEqual(f.binding);
		if (method === "qorpera_authorize_coding_turn") return { ...structuredClone(f.authority), coding };
		if (method === "qorpera_read_coding_turn_context")
			return {
				schema: "qorpera.coding-turn-context/v2",
				workerId,
				sequence: 1,
				input: { from: "dispatch", text: null, answers: null },
				earlierTurns: [],
				omittedEarlierTurns: 0,
				commands: { running: [], stopped: [], omitted: 0 },
			};
		if (method === "qorpera_begin_native_coding_execution")
			return {
				schema: "qorpera.native-company-execution-start/v1",
				runId: f.binding.runId,
				jobId: f.binding.jobId,
				leaseId: f.binding.leaseId,
				binarySha256: args.p_binary_sha256,
				runtimeBundleSha256: f.authority.identity.runtimeBundleSha256,
				reasoningEffort: f.authority.identity.reasoningEffort,
				reasoningPolicySha256: f.authority.identity.reasoningPolicySha256,
				toolCatalogSha256: createHash("sha256").update(String(args.p_tool_catalog_text)).digest("hex"),
				contextSha256: args.p_context_sha256,
				contextBytes: args.p_context_bytes,
			};
		if (method === "qorpera_record_coding_context_view")
			return {
				schema: "qorpera.native-context-view-receipt/v1",
				requestId: (args.p_view as { requestId: string }).requestId,
				viewId: randomUUID(),
				sha256: "b".repeat(64),
				ordinal: 1,
			};
		throw new Error("Unexpected synthetic coding RPC");
	});
	const refused = async (): Promise<never> => {
		throw new Error("Not expected in a turn that calls no tool");
	};
	const gateway: CloudCodingCommandGateway = { authorize: refused, start: refused, read: refused, cancel: refused };
	const evidence = join(root, "evidence.json");
	// Not a mode of its own: any name the fixture does not know takes its default branch.
	const command = [process.execPath, rpcFixture, "coding-text-end", evidence] as const;
	const observations: CloudRuntimeObservation[] = [];
	const runtime = new CloudNativeCompanyRuntime({
		controlPlane: {
			describeToolAuthority: refused,
			beginToolOperation: refused,
			completeToolOperation: refused,
			completeFolderToolOperation: refused,
			sendMessage: refused,
			appendInteractionRequest: refused,
		},
		pathControl: {
			call: async (method, args) => {
				if (method === "qorpera_record_runtime_observation_batch") {
					const batch = (args.p_observations as unknown[]).map((row) => parseCloudRuntimeObservation(row));
					observations.push(...batch);
					return {
						schema: "qorpera.runtime-observation-batch-receipt/v1",
						runId: f.binding.runId,
						receipts: batch.map((observation) => ({
							schema: "qorpera.runtime-observation-receipt/v1",
							runId: f.binding.runId,
							attemptId: observation.attemptId,
							phase: observation.phase,
							ingestedAt: new Date().toISOString(),
							replayed: false,
						})),
					};
				}
				expect(args.p_binding).toEqual(f.binding);
				if (method === "qorpera_describe_company_run_context") return structuredClone(f.context);
				if (method === "qorpera_read_native_wake") return structuredClone(wake);
				throw new Error("Unexpected synthetic company RPC");
			},
		},
		folderBytes: () => {
			throw new Error("A coding turn has no company folder");
		},
		command,
		binarySha256,
		timeoutMs: 10_000,
		coding: new CloudNativeCodingRuntime({
			control: {
				call: codingCall,
				describeToolAuthority: refused,
				beginToolOperation: refused,
				completeToolOperation: refused,
			},
			gateway: () => gateway,
			command,
			binarySha256,
			timeoutMs: 10_000,
		}),
	});
	const identityRoot = join(root, "identity");
	await mkdir(join(identityRoot, "codex"), { recursive: true, mode: 0o700 });
	await writeFile(join(identityRoot, "codex", "auth.json"), '{"tokens":{"access_token":"SYNTHETIC_NATIVE_SECRET"}}', {
		mode: 0o600,
	});
	const request: NativeCompanyExecutionRequest = {
		runtime: "company-path-v1",
		authority: {
			...f.binding,
			encryptedCapsuleReference: `native-capsule/${f.binding.credentialCapsuleId}`,
			attestationPolicySha256: "a".repeat(64),
			expiresAt: "2099-08-28T12:00:00Z",
		},
		job: {
			jobId: f.binding.jobId,
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: 1,
			payload: null,
		},
	};
	return { ...f, runtime, codingCall, observations, identityRoot, request };
}

it("fails a coding turn whose model ends with text and no submission with its own code, tagged at its stage", async () => {
	const f = await fixture();
	const failure = await f.runtime.execute(f.request, f.identityRoot, new AbortController().signal).then(
		() => undefined,
		(error: unknown) => error,
	);
	// The throw point: the end of the coding runtime's turn, after the native session returned.
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe("CODING_TURN_ENDED_WITHOUT_SUBMISSION");
	expect(nativeRuntimeFailureMetadata(failure)).toMatchObject({ stage: "prompt-composition", category: "unknown" });
	expect(nativeProviderFailureCode(failure)).toBe("CODING_TURN_ENDED_WITHOUT_SUBMISSION");
	// The model's turn itself succeeded, and nothing was submitted.
	expect(
		f.observations.some(
			(observation) =>
				observation.operation === "model_turn" &&
				observation.phase === "finish" &&
				observation.status === "succeeded",
		),
	).toBe(true);
	expect(f.codingCall.mock.calls.map(([method]) => method)).not.toContain("qorpera_submit_coding_turn");
});

it("carries CODING_TURN_ENDED_WITHOUT_SUBMISSION to the runner through the host's harness wrapper", async () => {
	const f = await fixture();
	const masterKey = randomBytes(32).toString("base64url");
	const capsule = await sealNativeCredentialCapsule(f.identityRoot, masterKey, f.binding.credentialCapsuleId);
	const refused = async (): Promise<never> => {
		throw new Error("Not expected in a coding turn");
	};
	const host = new NativeProviderHost({
		masterKey,
		computeIdentityId: f.binding.computeIdentityId,
		temporaryRoot: root,
		controlPlane: {
			validateExecution: async () => {},
			sendMessage: refused,
			describeLogin: refused,
			completeLogin: refused,
		},
		capsules: { get: async () => capsule, put: refused },
		cloudRuntime: f.runtime,
		harness: { beginLogin: refused },
	});
	const token = randomBytes(32).toString("base64url");
	const service = new HttpNativeProviderHostService(host, token);
	const port = await service.start();
	const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const authority: CloudRunnerNativeAuthority = {
			...f.request.authority,
			authenticationMode: "native_subscription",
			providerConnectionId: f.context.identity.providerConnectionId,
			providerConnectionVersion: f.context.identity.providerConnectionVersion,
			computeIdentityOwnershipKind: "member",
			computeIdentityOwnerUserId: f.context.identity.sponsorUserId!,
			credentialOwnershipKind: "member",
			credentialOwnerUserId: f.context.identity.sponsorUserId!,
		};
		const bridge = new HttpNativeProviderComputerBridge(`http://127.0.0.1:${port}/`, token, fetch, {
			executionBoundary: "virtual_machine",
		});
		const process = await bridge.startCompany(authority, { jobId: f.binding.jobId, attemptCount: 1 });
		// Before the fix the runner read "[code=NATIVE_PROMPT_COMPOSITION:UNKNOWN]": the host wraps the
		// runtime's failure, and only the outer error's own text was checked for a coding code.
		await expect(process.result).rejects.toThrow(
			/^Native provider bridge request failed \(422\) \[code=CODING_TURN_ENDED_WITHOUT_SUBMISSION\]$/,
		);
		expect(logged).toHaveBeenCalledWith(
			"Native provider request rejected: Native provider execution failed (stage=prompt-composition, category=unknown) [code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]",
		);
		expect(logged.mock.calls.flat().join("\n")).not.toMatch(/PRIVATE_|SYNTHETIC_NATIVE_SECRET/);
	} finally {
		logged.mockRestore();
		await service.close();
	}
});
