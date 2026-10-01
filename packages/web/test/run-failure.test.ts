import { describe, expect, it } from "vitest";
import { runFailureInterrupted, runFailureReason } from "../src/ui/run-failure.ts";

describe("why a run stopped, in the member's words", () => {
	it.each([
		[
			"Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422)",
			"failed",
			/No computer could be started/,
		],
		["Native provider bridge request failed (422)", "failed", /one of its steps was refused/],
		[
			"Native provider bridge request failed (422) [code=NATIVE_CREDENTIAL_SEALING:STORAGE_BUDGET]; durable attempt output requires review",
			"failed",
			/one of its steps was refused/,
		],
		[
			"Native provider bridge request failed (422) [code=NATIVE_WAKE_ENVELOPE:TIMEOUT]",
			"failed",
			/one of its steps was refused/,
		],
		[
			"Runner lease expired before durable completion; durable attempt output requires review",
			"failed",
			/computer running this run stopped answering/,
		],
		// A run has no time limit any more; only older runs carry a deadline.
		["Execution deadline expired before durable completion", "failed", /took too long/],
		["No computer could start the run within a day", "failed", /No computer could be started/],
		// One request inside the run timed out, not the run.
		["Runner model socket request timed out", "failed", /steps got no answer in time/],
		["Cloud secret broker request timed out", "failed", /steps got no answer in time/],
		[
			"Cloud service did not respond before the request deadline. Retry when the service recovers.",
			"failed",
			/steps got no answer in time/,
		],
		["Execution deadline expired before runner acceptance", "failed", /took too long/],
		["You have hit your usage limit. Try again later.", "failed", /usage limit/],
		["Provider credential is invalid", "failed", /connected again/],
		["Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]", "failed", /out of computer hours/],
		[
			"Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]; durable attempt output requires review",
			"failed",
			/out of computer hours/,
		],
		[undefined, "cancelled", /stopped before it finished/],
		["something nobody has seen before", "failed", /internal error/],
	] as const)("%s", (error, status, expected) => {
		const reason = runFailureReason(error, status);
		expect(reason).toMatch(expected);
		// Plain words only: no status codes, no machinery names.
		expect(reason).not.toMatch(/\d{3}|runner|provider|bridge|lease|dispatch/i);
	});

	it("takes the cloud's word on a usage limit, and never reads a rate limit as one", () => {
		const limit = /reached its usage limit/;
		// The cloud recorded the limit for this run: the saved refusal names only a spent budget.
		expect(
			runFailureReason(
				"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]",
				"failed",
				true,
			),
		).toMatch(limit);
		// The cloud says no: the error text cannot overrule it.
		expect(runFailureReason("You have hit your usage limit. Try again later.", "failed", false)).not.toMatch(limit);
		// A rate limit passes by itself.
		expect(runFailureReason("Rate limit reached for requests", "failed")).not.toMatch(limit);
	});
});

describe("whether a stopped run is worth trying again as it is", () => {
	it.each([
		["Runner lease expired before durable completion; durable attempt output requires review", "failed", true],
		[
			"Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422)",
			"failed",
			true,
		],
		[undefined, "cancelled", true],
		["No computer could start the run within a day", "failed", true],
		["Runner model socket request timed out", "failed", true],
		["You have hit your usage limit. Try again later.", "failed", false],
		["Provider credential is invalid", "failed", false],
		// Hours have to be added first: no Try again.
		["Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]", "failed", false],
		["Native provider bridge request failed (422)", "failed", false],
		["Native provider bridge request failed (422) [code=NATIVE_WAKE_ENVELOPE:TIMEOUT]", "failed", false],
		["Native provider bridge request failed (422) [code=NATIVE_CREDENTIAL_DOWNLOAD]", "failed", false],
		["something nobody has seen before", "failed", false],
	] as const)("%s → %s", (error, status, expected) => {
		expect(runFailureInterrupted(error, status)).toBe(expected);
	});
});
