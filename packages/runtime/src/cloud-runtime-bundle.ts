import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	CLOUD_RUNTIME_BUNDLE_SHA256,
	CLOUD_RUNTIME_MODEL_POLICY_SHA256,
	CLOUD_RUNTIME_NATIVE_BINARY_SHA256,
} from "./cloud-runtime-bundle.generated.ts";
import { isCloudRuntimeReasoningEffort } from "./cloud-runtime-policy.ts";

/** Compiled into the signed host. A database label cannot select different executable policy. */
export function assertCloudRuntimeBundle(identity: CloudNativeToolIdentity, binarySha256: string): void {
	if (
		identity.runtimeBundleSha256 !== CLOUD_RUNTIME_BUNDLE_SHA256 ||
		identity.reasoningPolicySha256 !== CLOUD_RUNTIME_MODEL_POLICY_SHA256 ||
		!isCloudRuntimeReasoningEffort(identity.reasoningEffort) ||
		binarySha256 !== CLOUD_RUNTIME_NATIVE_BINARY_SHA256
	)
		throw new Error("Admitted runtime bundle is not supported by this host");
}
