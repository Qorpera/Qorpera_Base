import { describe, expect, it } from "vitest";
import { tagNativeRuntimeFailure } from "../src/cloud-native-failure.ts";
import { nativeProviderFailureCode } from "../src/cloud-native-provider-service.ts";
import {
	cloudRunnerJobFailureBeforeStartIsRetryable,
	cloudRunnerJobFailureIsRetryable,
} from "../src/cloud-runner-worker.ts";

describe("the fixed code a failed native execution carries back", () => {
	it("keeps an error's own fixed code, also when the runtime tagged its stage", () => {
		expect(nativeProviderFailureCode(new Error("CODING_TURN_ENDED_WITHOUT_SUBMISSION"))).toBe(
			"CODING_TURN_ENDED_WITHOUT_SUBMISSION",
		);
		expect(
			nativeProviderFailureCode(
				tagNativeRuntimeFailure(new Error("CODING_TURN_SCOPE_DIFFERS"), "prompt-composition", "unknown"),
			),
		).toBe("CODING_TURN_SCOPE_DIFFERS");
	});
	it("finds that code under the host's wrapper, as the runner receives it", () => {
		// What the host makes of a coding turn's failure (safeHarnessExecutionFailure).
		const wrapped = (inner: Error) =>
			new Error(
				"Native provider execution failed (stage=prompt-composition, category=unknown) [mouth=uninitialized]",
				{
					cause: tagNativeRuntimeFailure(inner, "prompt-composition", "unknown"),
				},
			);
		expect(nativeProviderFailureCode(wrapped(new Error("CODING_TURN_ENDED_WITHOUT_SUBMISSION")))).toBe(
			"CODING_TURN_ENDED_WITHOUT_SUBMISSION",
		);
		// A code under a second, generic wrapper (a guard: today CloudNativeToolRun.open drops the cause).
		expect(
			nativeProviderFailureCode(
				wrapped(
					new Error("Cloud tool authority unavailable", { cause: new Error("CODING_NATIVE_BINDING_CHANGED") }),
				),
			),
		).toBe("CODING_NATIVE_BINDING_CHANGED");
		// Other causes still give the stage and category, never their text.
		expect(nativeProviderFailureCode(wrapped(new Error("PRIVATE_TOKEN_VALUE")))).toBe(
			"NATIVE_PROMPT_COMPOSITION:UNKNOWN",
		);
		expect(nativeProviderFailureCode(wrapped(new Error(`CODING_${"A".repeat(43)}`)))).toBe(
			"NATIVE_PROMPT_COMPOSITION:UNKNOWN",
		);
	});
	it("names the stage and category of a tagged failure without a code of its own", () => {
		expect(
			nativeProviderFailureCode(
				tagNativeRuntimeFailure(new Error("private provider text"), "wake-envelope", "authority_unavailable"),
			),
		).toBe("NATIVE_WAKE_ENVELOPE:AUTHORITY_UNAVAILABLE");
	});
	it("turns the diagnostics the service already logs verbatim into codes", () => {
		expect(
			nativeProviderFailureCode(
				new Error("Native provider execution harness-execution stage failed (filesystem-permission) [mouth=ready]"),
			),
		).toBe("NATIVE_HARNESS_EXECUTION:FILESYSTEM_PERMISSION");
		expect(
			nativeProviderFailureCode(new Error("Provider harness exited with 1 (provider authorization unavailable)")),
		).toBe("HARNESS_EXITED:PROVIDER_AUTHORIZATION");
		expect(nativeProviderFailureCode(new Error("Codex did not complete its turn"))).toBe("CODEX_TURN_INCOMPLETE");
		expect(nativeProviderFailureCode(new Error("Provider harness output exceeded its byte limit"))).toBe(
			"HARNESS_OUTPUT_LIMIT",
		);
	});
	it("never passes free text or other upper-case text, and keeps every segment short enough for the runner's redaction", () => {
		for (const message of [
			"Coding turn failed for /home/member/secret",
			`${"A".repeat(43)}`,
			"LXD instance agent not running",
			"PRIVATE_TOKEN_VALUE",
			`CODING_${"A".repeat(43)}`,
			"Provider harness exited with 1 [mouth=private-token-must-not-leak]",
			"",
		])
			expect(nativeProviderFailureCode(new Error(message))).toBe("UNCLASSIFIED");
		expect(nativeProviderFailureCode("not an error")).toBe("UNCLASSIFIED");
	});
});

describe("the runner's retry decision", () => {
	it("is the same with or without the provider's code", () => {
		for (const [message, retryable] of [
			["Native provider bridge request failed (422)", true],
			["Native provider bridge request failed (422) [code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]", true],
			["Native provider bridge request failed (422) [code=CODING_TURN_INVALID]", true],
			["Native provider response is invalid", false],
		] as const)
			expect(cloudRunnerJobFailureIsRetryable(new Error(message))).toBe(retryable);
	});

	it("tries again only a timeout before the run started: its context, wake, connectors or prompt", () => {
		for (const stage of ["company-context", "wake-envelope", "connector-tools", "prompt-composition"] as const)
			expect(
				cloudRunnerJobFailureBeforeStartIsRetryable(
					new Error(
						`Native provider bridge request failed (422) [code=${nativeProviderFailureCode(tagNativeRuntimeFailure(new Error("late"), stage, "timeout"))}]`,
					),
				),
			).toBe(true);
		for (const message of [
			"Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:TRANSPORT_UNAVAILABLE]",
			"Native provider bridge request failed (422) [code=NATIVE_NATIVE_TOOLS:TIMEOUT]",
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:TIMEOUT]",
			"Native provider bridge request failed (422) [code=NATIVE_CODING_SESSION:TIMEOUT]",
			"Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:TIMEOUT] trailing",
			"NATIVE_PROMPT_COMPOSITION:TIMEOUT",
		])
			expect(cloudRunnerJobFailureBeforeStartIsRetryable(new Error(message))).toBe(false);
		expect(cloudRunnerJobFailureBeforeStartIsRetryable("[code=NATIVE_PROMPT_COMPOSITION:TIMEOUT]")).toBe(false);
		// A coding session's turn names its own stage, never the prompt's.
		expect(nativeProviderFailureCode(tagNativeRuntimeFailure(new Error("late"), "coding-session", "timeout"))).toBe(
			"NATIVE_CODING_SESSION:TIMEOUT",
		);
	});
});
