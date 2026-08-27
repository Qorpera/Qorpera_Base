import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudAgentSendInput, CloudAgentSendReceipt } from "../../src/cloud-agent-mouth.ts";
import {
	type NativeProviderExecutionRequest,
	NativeProviderHost,
	OfficialCliNativeHarnessDriver,
	sealNativeCredentialCapsule,
} from "../../src/cloud-native-provider-host.ts";

/** No model calls or real credentials. Runnable unchanged on a cloud Linux VM. */
export async function runCloudMouthProbe(companyParent = tmpdir()): Promise<{
	platform: string;
	companyRoot: string;
	companyFileSha256: string;
	publicMessages: number;
	immediateDelivery: boolean;
	retryDeduplicated: boolean;
	privateOutputExcluded: boolean;
}> {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "qorpera-mouth-runtime-"));
	// Unlike mkdtemp's fixed 0700, this supports the NAS's shared group and mapped uid.
	const companyRoot = join(companyParent, `.qorpera-mouth-probe-${randomUUID()}`);
	await mkdir(companyRoot, { mode: 0o770 });
	try {
		const identityRoot = join(temporaryRoot, "identity");
		const inputRoot = join(temporaryRoot, "input");
		await mkdir(join(identityRoot, "codex"), { recursive: true });
		await mkdir(inputRoot);
		await writeFile(join(identityRoot, "codex", "auth.json"), '{"probe":"not-a-provider-credential"}');
		await writeFile(join(companyRoot, "exec"), await readFile(new URL("./cloud-mouth-harness.cjs", import.meta.url)));
		const runId = randomUUID();
		const jobId = randomUUID();
		const sessionId = randomUUID();
		const computeIdentityId = randomUUID();
		const capsuleId = randomUUID();
		const masterKey = randomBytes(32).toString("base64url");
		let capsule = await sealNativeCredentialCapsule(identityRoot, masterKey, capsuleId);
		await writeFile(
			join(inputRoot, "context.json"),
			JSON.stringify({
				schema: "qorpera.runner-execution-context/v1",
				run: { runId, jobId, sessionId },
			}),
		);
		await writeFile(join(inputRoot, "inputs.jsonl"), '{"text":"Update the Company File."}\n');
		await writeFile(join(inputRoot, "transcript.jsonl"), "");
		const messages = new Map<string, { input: CloudAgentSendInput; receipt: CloudAgentSendReceipt }>();
		let executionFinished = false;
		let immediateDelivery = false;
		let deliveries = 0;
		const host = new NativeProviderHost({
			controlPlane: {
				describeLogin: async () => {
					throw new Error("Probe does not log in");
				},
				completeLogin: async () => {
					throw new Error("Probe does not log in");
				},
				validateExecution: async () => undefined,
				sendMessage: async (request, input) => {
					assert.equal(request.authority.runId, runId);
					deliveries++;
					const previous = messages.get(input.idempotencyKey);
					if (previous) {
						assert.deepEqual(previous.input, input);
						return previous.receipt;
					}
					const receipt: CloudAgentSendReceipt = {
						schema: "qorpera.agent-send/v1",
						runId,
						sessionId,
						messageId: randomUUID(),
						phase: input.phase,
						sequence: messages.size + 1,
					};
					messages.set(input.idempotencyKey, { input, receipt });
					if (input.phase === "progress") immediateDelivery = !executionFinished;
					return receipt;
				},
			},
			capsules: {
				get: async () => capsule,
				put: async (_reference, bytes) => {
					capsule = bytes;
				},
			},
			harness: new OfficialCliNativeHarnessDriver(process.execPath),
			masterKey,
			computeIdentityId,
			temporaryRoot,
		});
		const request: NativeProviderExecutionRequest = {
			authority: {
				leaseId: randomUUID(),
				runId,
				credentialCapsuleId: capsuleId,
				encryptedCapsuleReference: `native-capsule/${capsuleId}`,
				attestationPolicySha256: "b".repeat(64),
				computeIdentityId,
				runnerId: randomUUID(),
				assignmentId: randomUUID(),
				provider: "openai",
				nativeHarness: "codex-cli",
				model: "probe-no-provider-call",
				expiresAt: "2099-08-27T12:00:00.000Z",
			},
			job: { jobId, jobType: "agent_turn", requiredCapability: "agent_turn", attemptCount: 1, payload: {} },
			input: {
				companyRoot,
				executionContextPath: join(inputRoot, "context.json"),
				queuedInputsPath: join(inputRoot, "inputs.jsonl"),
				transcriptPath: join(inputRoot, "transcript.jsonl"),
			},
			outputRoot: join(temporaryRoot, "output"),
		};
		const result = await host.execute(request);
		executionFinished = true;
		assert.deepEqual(result, {
			schema: "qorpera.native-harness-result/v2",
			run_id: runId,
			message_count: 2,
			final_message_id: messages.get("final-1")?.receipt.messageId,
			provider_session_id: "cloud-mouth-probe",
		});
		assert.equal(immediateDelivery, true);
		assert.equal(deliveries, 3);
		assert.equal(messages.size, 2);
		const publicState = JSON.stringify({ result, messages: [...messages.values()] });
		assert(!publicState.includes("PRIVATE_"));
		const bytes = await readFile(join(companyRoot, "mouth-probe.txt"));
		assert.equal(bytes.toString("utf8"), "The cloud agent changed this Company File.\n");
		return {
			platform: process.platform,
			companyRoot,
			companyFileSha256: createHash("sha256").update(bytes).digest("hex"),
			publicMessages: messages.size,
			immediateDelivery,
			retryDeduplicated: true,
			privateOutputExcluded: true,
		};
	} finally {
		await rm(companyRoot, { recursive: true, force: true });
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}
