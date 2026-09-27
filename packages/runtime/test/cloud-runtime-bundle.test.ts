import type { CloudNativeToolIdentity } from "@qorpera/runtime/cloud-native-tool-authority";
import { assertCloudRuntimeBundle } from "@qorpera/runtime/cloud-runtime-bundle";
import { CLOUD_RUNTIME_NATIVE_BINARY_SHA256 } from "@qorpera/runtime/cloud-runtime-bundle.generated";
import { describe, expect, it } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

describe("compiled runtime bundle admission", () => {
	it("accepts only the exact compiled bundle, native artifact and admitted effort", () => {
		const { authority } = nativeToolAuthorityFixture();
		expect(() => assertCloudRuntimeBundle(authority.identity, CLOUD_RUNTIME_NATIVE_BINARY_SHA256)).not.toThrow();
	});
	it.each(["runtimeBundleSha256", "reasoningPolicySha256", "reasoningEffort"] as const)(
		"rejects changed %s before native execution",
		(field) => {
			const { authority } = nativeToolAuthorityFixture();
			const changed = { ...authority.identity, [field]: field === "reasoningEffort" ? "max" : "f".repeat(64) };
			expect(() =>
				assertCloudRuntimeBundle(changed as CloudNativeToolIdentity, CLOUD_RUNTIME_NATIVE_BINARY_SHA256),
			).toThrow("not supported");
		},
	);
	it("does not accept a binary just because it advertises the right protocol version", () => {
		const { authority } = nativeToolAuthorityFixture();
		expect(() => assertCloudRuntimeBundle(authority.identity, "0".repeat(64))).toThrow("not supported");
	});
});
