import { describe, expect, it } from "vitest";
import { CLOUD_AGENT_NO_FINAL_SEND_CODE, CloudAgentNoFinalSend } from "../src/cloud-agent-mouth.ts";
import { tagNativeRuntimeFailure } from "../src/cloud-native-failure.ts";
import { nativeProviderFailureCode } from "../src/cloud-native-provider-service.ts";
import {
	cloudRunnerJobFailureBeforeStartIsRetryable,
	cloudRunnerJobFailureIsCutOff,
	cloudRunnerJobFailureIsRetryable,
	RUN_COMPLETION_REFUSED_FAILURE,
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
	it("gives a turn that ended without the final send it owed its own code, by its type", () => {
		const ended = tagNativeRuntimeFailure(new CloudAgentNoFinalSend(), "public-completion", "unknown");
		expect(CLOUD_AGENT_NO_FINAL_SEND_CODE).toBe("AGENT_TURN_ENDED_WITHOUT_FINAL_SEND");
		expect(nativeProviderFailureCode(ended)).toBe(CLOUD_AGENT_NO_FINAL_SEND_CODE);
		// Under the host's wrapper, as the runner receives it.
		expect(
			nativeProviderFailureCode(
				new Error(
					"Native provider execution failed (stage=public-completion, category=unknown) [mouth=uninitialized]",
					{ cause: ended },
				),
			),
		).toBe(CLOUD_AGENT_NO_FINAL_SEND_CODE);
		// Never by its words: the same text from anywhere else keeps its stage and category.
		expect(
			nativeProviderFailureCode(
				tagNativeRuntimeFailure(
					new Error("Native agent turn ended without a final send"),
					"public-completion",
					"unknown",
				),
			),
		).toBe("NATIVE_PUBLIC_COMPLETION:UNKNOWN");
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

	it("tries again only a timeout before the run started: its login download, context, wake, connectors or prompt", () => {
		for (const stage of ["company-context", "wake-envelope", "connector-tools", "prompt-composition"] as const)
			expect(
				cloudRunnerJobFailureBeforeStartIsRetryable(
					new Error(
						`Native provider bridge request failed (422) [code=${nativeProviderFailureCode(tagNativeRuntimeFailure(new Error("late"), stage, "timeout"))}]`,
					),
				),
			).toBe(true);
		// The host names a login download that got no answer this way (cloud-native-model-login-run.test.ts).
		const download = nativeProviderFailureCode(
			new Error("Native provider execution credential-download stage failed (timeout)"),
		);
		expect(download).toBe("NATIVE_CREDENTIAL_DOWNLOAD:TIMEOUT");
		expect(
			cloudRunnerJobFailureBeforeStartIsRetryable(
				new Error(`Native provider bridge request failed (422) [code=${download}]`),
			),
		).toBe(true);
		for (const message of [
			// A refused download, and an opened login's own timeout, stay final.
			"Native provider bridge request failed (422) [code=NATIVE_CREDENTIAL_DOWNLOAD]",
			"Native provider bridge request failed (422) [code=NATIVE_CREDENTIAL_OPENING:TIMEOUT]",
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

	// 10 November 2026 (audit B2): a stage that ends before the model's turn can have sent anything goes on after a
	// timeout or lost transport; a failure that repeats is not a blip, so only the first two attempts go on.
	it("goes on after a pre-turn stage's timeout or lost transport, on the first two attempts", () => {
		const failure = (code: string) => new Error(`Native provider bridge request failed (422) [code=${code}]`);
		const stages = [
			"company-context",
			"wake-envelope",
			"connector-tools",
			"prompt-composition",
			"execution-admission",
			"codex-artifact",
			"codex-identity",
			"codex-result-fence",
			"codex-process-start",
			"codex-initialize",
			"codex-configuration",
			"codex-skills",
			"codex-thread-start",
		] as const;
		const codes = [
			// As the runtime names them.
			...stages.flatMap((stage) =>
				(["timeout", "transport_unavailable"] as const).map((category) =>
					nativeProviderFailureCode(tagNativeRuntimeFailure(new Error("late"), stage, category)),
				),
			),
			// The host's own stages before the harness.
			"NATIVE_CREDENTIAL_DOWNLOAD:TRANSPORT_UNAVAILABLE",
			"NATIVE_INITIAL_AUTHORITY_VALIDATION:TIMEOUT",
			"NATIVE_CREDENTIAL_OPENING:TIMEOUT",
		];
		expect(codes).toContain("NATIVE_CODEX_THREAD_START:TRANSPORT_UNAVAILABLE");
		for (const code of codes) {
			expect(cloudRunnerJobFailureIsCutOff(failure(code), 1)).toBe(true);
			expect(cloudRunnerJobFailureIsCutOff(failure(code), 2)).toBe(true);
			if (!cloudRunnerJobFailureBeforeStartIsRetryable(failure(code))) {
				// The third attempt's failure is final, and the member sees it.
				expect(cloudRunnerJobFailureIsCutOff(failure(code), 3)).toBe(false);
				expect(cloudRunnerJobFailureIsCutOff(failure(code), 7)).toBe(false);
			}
		}
		// What was retried before keeps only the database's cap of eight.
		for (const code of [
			"NATIVE_CREDENTIAL_DOWNLOAD:TIMEOUT",
			"NATIVE_COMPANY_CONTEXT:TIMEOUT",
			"NATIVE_WAKE_ENVELOPE:TIMEOUT",
			"NATIVE_CONNECTOR_TOOLS:TIMEOUT",
			"NATIVE_PROMPT_COMPOSITION:TIMEOUT",
		])
			for (const attemptCount of [1, 3, 7]) {
				expect(cloudRunnerJobFailureIsCutOff(failure(code), attemptCount)).toBe(true);
			}
		// During or after the model's turn, final for now: a run with a log is resumed without asking whether it sent
		// its final message (20260930539000).
		for (const stage of [
			"CODEX_TURN_START",
			"CODEX_TURN_COMPLETION",
			"NATIVE_TOOLS",
			"PUBLIC_COMPLETION",
			"CODING_SESSION",
			"COMPLETION_AUTHORITY_VALIDATION",
			"CREDENTIAL_SEALING",
			"CREDENTIAL_UPLOAD",
			"HARNESS_EXECUTION",
			"BUNDLE_COMPATIBILITY",
			"CODEX_THREAD_STARTS",
			"CODEX",
		])
			for (const category of ["TIMEOUT", "TRANSPORT_UNAVAILABLE"])
				expect(cloudRunnerJobFailureIsCutOff(failure(`NATIVE_${stage}:${category}`), 1)).toBe(false);
		for (const message of [
			"Native provider bridge request failed (422) [code=NATIVE_CODING_SESSION:TRANSPORT_UNAVAILABLE]",
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:UNKNOWN]",
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:CANCELLED]",
			"Native provider bridge request failed (422) [code=NATIVE_WAKE_ENVELOPE:AUTHORITY_UNAVAILABLE]",
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]",
			"Native provider bridge request failed (422) [code=NATIVE_HARNESS_EXECUTION:BUDGET_EXHAUSTED]",
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:INVALID_RESPONSE]",
			"Native provider bridge request failed (422) [code=NATIVE_CREDENTIAL_DOWNLOAD]",
			"Native provider bridge request failed (422) [code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]",
			"Native provider bridge request failed (422) [code=AGENT_TURN_ENDED_WITHOUT_FINAL_SEND]",
			"Native provider bridge request failed (422) [code=HARNESS_EXITED:TIMEOUT]",
			"Native provider bridge request failed (422) [code=NATIVE_:TIMEOUT]",
			"Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:TIMEOUT] trailing",
			"Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:TRANSPORT_UNAVAILABLE] trailing",
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_THREAD_START]",
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_THREAD_START:UNKNOWN]",
			RUN_COMPLETION_REFUSED_FAILURE,
			"Native provider bridge request failed (422)",
			"NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE",
		])
			expect(cloudRunnerJobFailureIsCutOff(new Error(message), 1)).toBe(false);
		// Only an error carries a code.
		expect(cloudRunnerJobFailureIsCutOff("x [code=NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE]", 1)).toBe(
			false,
		);
	});
});
