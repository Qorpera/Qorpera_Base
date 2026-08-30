import { describe, expect, it } from "vitest";
import type { CloudNativeToolIdentity } from "../src/cloud-native-tool-authority.ts";
import { CLOUD_RUNTIME_NATIVE_BINARY_SHA256 } from "../src/cloud-runtime-bundle.generated.ts";
import { assertCloudRuntimeBundle } from "../src/cloud-runtime-bundle.ts";
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
			const changed = { ...authority.identity, [field]: field === "reasoningEffort" ? "high" : "f".repeat(64) };
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
