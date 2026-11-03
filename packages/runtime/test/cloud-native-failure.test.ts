import {
	nativeCodexErrorToken,
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
		codexError: null,
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

it("names Codex's error discriminant by a fixed name only, and anything else unknown", () => {
	for (const name of [
		"contextWindowExceeded",
		"sessionBudgetExceeded",
		"usageLimitExceeded",
		"serverOverloaded",
		"cyberPolicy",
		"internalServerError",
		"unauthorized",
		"badRequest",
		"threadRollbackFailed",
		"sandboxError",
		"other",
	])
		expect(nativeCodexErrorToken(name)).toBe(name);
	expect(nativeCodexErrorToken(null)).toBe("null");
	for (const name of [
		"httpConnectionFailed",
		"responseStreamConnectionFailed",
		"responseStreamDisconnected",
		"responseTooManyFailedAttempts",
	]) {
		expect(nativeCodexErrorToken({ [name]: { httpStatusCode: 401 } })).toBe(`${name}:401`);
		expect(nativeCodexErrorToken({ [name]: { httpStatusCode: 503 } })).toBe(`${name}:503`);
		expect(nativeCodexErrorToken({ [name]: { httpStatusCode: null } })).toBe(`${name}:null`);
	}
	for (const value of [
		undefined,
		"",
		"Unauthorized",
		"unauthorized ",
		"PRIVATE_PROVIDER_CODE",
		"unauthorized: sk-PRIVATE",
		"__proto__",
		"toString",
		"constructor",
		0,
		true,
		[],
		["unauthorized"],
		{},
		{ unauthorized: {} },
		{ httpConnectionFailed: { httpStatusCode: 429 }, responseStreamDisconnected: { httpStatusCode: 429 } },
		{ httpConnectionFailed: { httpStatusCode: 429, message: "PRIVATE_FAILURE" } },
		{ httpConnectionFailed: { httpStatusCode: "429" } },
		{ httpConnectionFailed: { httpStatusCode: 99 } },
		{ httpConnectionFailed: { httpStatusCode: 600 } },
		{ httpConnectionFailed: { httpStatusCode: 429.5 } },
		{ httpConnectionFailed: { httpStatusCode: Number.NaN } },
		{ httpConnectionFailed: {} },
		{ httpConnectionFailed: null },
		{ httpConnectionFailed: [429] },
		{ httpConnectionFailed: "PRIVATE_FAILURE" },
		{ "PRIVATE_KEY:1": { httpStatusCode: 429 } },
	])
		expect(nativeCodexErrorToken(value)).toBe("unknown");
});

it("keeps a valid Codex error name with the failure, and refuses any other", () => {
	const tagged = tagNativeRuntimeFailure(
		new Error("PRIVATE_FAILURE"),
		"codex-turn-completion",
		"provider_failed",
		null,
		"unauthorized",
	);
	expect(nativeRuntimeFailureMetadata(tagged)).toEqual({
		stage: "codex-turn-completion",
		category: "provider_failed",
		usageSignal: null,
		codexError: "unauthorized",
	});
	for (const token of ["responseTooManyFailedAttempts:503", "httpConnectionFailed:null", "null", "unknown"])
		expect(
			nativeRuntimeFailureMetadata(
				tagNativeRuntimeFailure(new Error("x"), "codex-turn-completion", "provider_failed", null, token),
			)?.codexError,
		).toBe(token);
	for (const token of ["PRIVATE_FAILURE", "", "unauthorized:401", "httpConnectionFailed:42", "httpConnectionFailed:1e2", "httpConnectionFailed:503:x"])
		expect(() =>
			tagNativeRuntimeFailure(new Error("x"), "codex-turn-completion", "provider_failed", null, token),
		).toThrow("Invalid native failure metadata");
});
