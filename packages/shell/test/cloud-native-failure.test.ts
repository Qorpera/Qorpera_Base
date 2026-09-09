import {
	nativeRuntimeFailureMetadata,
	nativeRuntimeUsageSignal,
	tagNativeRuntimeFailure,
} from "@qorpera/runtime/cloud-native-failure";
import { nativeProviderUsageSignal } from "@qorpera/runtime/cloud-native-provider-host";
import { expect, it } from "vitest";

it("retains the innermost trusted stage through wrapper errors without exposing their content", () => {
	const original = tagNativeRuntimeFailure(new Error("PRIVATE_FAILURE"), "codex-initialize", "transport_unavailable");
	const outer = new Error("PRIVATE_WRAPPER", { cause: original });
	tagNativeRuntimeFailure(outer, "native-tools");
	expect(nativeRuntimeFailureMetadata(outer)).toEqual({
		stage: "codex-initialize",
		category: "transport_unavailable",
		usageSignal: null,
	});
	expect(JSON.stringify(nativeRuntimeFailureMetadata(outer))).not.toContain("PRIVATE_");
});

it("does not accept forged metadata fields or infer a quota from a tagged unknown failure's text", () => {
	const forged = Object.assign(new Error("PRIVATE_FAILURE"), {
		stage: "codex-turn-start",
		category: "provider_failed",
		usageSignal: "usage_limit",
	});
	expect(nativeRuntimeFailureMetadata(forged)).toBeUndefined();
	expect(
		nativeProviderUsageSignal(tagNativeRuntimeFailure(new Error("(provider allowance unavailable)"), "native-tools")),
	).toBeUndefined();
});

it("does not confuse a context or session budget with a subscription allowance", () => {
	for (const value of [
		"contextWindowExceeded",
		"sessionBudgetExceeded",
		"quota",
		"PRIVATE_USAGE_LIMIT",
		null,
		{ httpConnectionFailed: { httpStatusCode: 429, message: "PRIVATE_FAILURE" } },
		{ httpConnectionFailed: { httpStatusCode: "429" } },
	])
		expect(nativeRuntimeUsageSignal(value)).toBeNull();
});
