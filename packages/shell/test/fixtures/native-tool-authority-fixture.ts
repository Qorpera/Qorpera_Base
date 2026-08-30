import { randomUUID } from "node:crypto";
import {
	CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA,
	type CloudNativeToolAuthority,
	type CloudNativeToolBinding,
} from "../../src/cloud-native-tool-authority.ts";
import {
	CLOUD_RUNTIME_BUNDLE_SHA256,
	CLOUD_RUNTIME_MODEL_POLICY_SHA256,
} from "../../src/cloud-runtime-bundle.generated.ts";

export function nativeToolAuthorityFixture(): { binding: CloudNativeToolBinding; authority: CloudNativeToolAuthority } {
	const binding: CloudNativeToolBinding = {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
		provider: "openai",
		nativeHarness: "codex-cli",
		model: "offline-probe",
	};
	const requesterUserId = randomUUID();
	return {
		binding,
		authority: {
			schema: CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA,
			validForMs: 30_000,
			identity: {
				companyId: randomUUID(),
				environmentId: randomUUID(),
				runId: binding.runId,
				jobId: binding.jobId,
				runnerId: binding.runnerId,
				assignmentId: binding.assignmentId,
				leaseId: binding.leaseId,
				computeIdentityId: binding.computeIdentityId,
				staffAgentId: randomUUID(),
				staffVersion: 2,
				sessionId: randomUUID(),
				requesterUserId,
				sponsorUserId: randomUUID(),
				sponsorBindingId: randomUUID(),
				sponsorVersion: 3,
				providerConnectionId: randomUUID(),
				providerConnectionVersion: 4,
				audienceKind: "company",
				audienceUserId: null,
				runtimeBundleId: randomUUID(),
				runtimeBundleSha256: CLOUD_RUNTIME_BUNDLE_SHA256,
				reasoningEffort: "low",
				reasoningPolicySha256: CLOUD_RUNTIME_MODEL_POLICY_SHA256,
				provider: "openai",
				nativeHarness: "codex-cli",
				model: binding.model,
			},
		},
	};
}
