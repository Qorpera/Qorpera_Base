import { describe, expect, it } from "vitest";
import { codingFailureReason, runFailureInterrupted, runFailureReason } from "../src/ui/run-failure.ts";

// The runner's own failure when the cloud refuses a run's completion for good (runtime cloud-runner-worker.ts).
const COMPLETION_REFUSED =
	"Runner completion was refused: the run left unsettled work, such as an open operation receipt [code=RUN_COMPLETION_REFUSED]";

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
		// A step whose code's category is a timeout took too long: it was not refused (21 October 2026).
		[
			"Native provider bridge request failed (422) [code=NATIVE_WAKE_ENVELOPE:TIMEOUT]",
			"failed",
			/steps got no answer in time/,
		],
		[
			"Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:TIMEOUT]",
			"failed",
			/steps got no answer in time/,
		],
		[
			"Native provider bridge request failed (422) [code=NATIVE_HARNESS_EXECUTION:STAGE_TIMEOUT]; durable attempt output requires review",
			"failed",
			/steps got no answer in time/,
		],
		// A code that only names a timeout's machinery is still a refusal.
		[
			"Native provider bridge request failed (422) [code=NATIVE_TIMEOUT_WATCH:UNKNOWN]",
			"failed",
			/one of its steps was refused/,
		],
		// A lapsed lease: Qorpera lost contact with the run, whichever side stopped answering (the database, 21 October).
		[
			"Runner lease expired before durable completion; durable attempt output requires review",
			"failed",
			/^Qorpera lost contact with this run\. The problem is on Qorpera's side\.$/,
		],
		[
			"Runner lease expired before durable completion [code=NATIVE_PROMPT_COMPOSITION:TIMEOUT]",
			"failed",
			/^Qorpera lost contact with this run\./,
		],
		// The run ended, but its completion was refused because a save was left unsettled (30 October): a person checks
		// that save first, and the run never reads as lost contact.
		[
			COMPLETION_REFUSED,
			"failed",
			/^The run ended, but one of its saves did not finish\. A person must check it before the run can be tried again\.$/,
		],
		[
			`${COMPLETION_REFUSED}; durable attempt output requires review`,
			"failed",
			/^The run ended, but one of its saves did not finish\./,
		],
		// A step cancelled from Qorpera's side was not refused (WB-001, 28 October: the database stopped answering).
		[
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:CANCELLED]; durable attempt output requires review",
			"failed",
			/^Qorpera lost contact with this run\. The problem is on Qorpera's side\.$/,
		],
		// A member's stop stays a stop; a code that only names a cancellation's machinery is still a refusal.
		[
			"Native provider bridge request failed (422) [code=NATIVE_HARNESS_EXECUTION:CANCELLED]",
			"cancelled",
			/stopped before it finished/,
		],
		["Native provider bridge request failed (422) [code=NATIVE_CANCELLED]", "failed", /one of its steps was refused/],
		[
			"Native provider bridge request failed (422) [code=NATIVE_CANCEL_WATCH:UNKNOWN]",
			"failed",
			/one of its steps was refused/,
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
		// It keeps the Try again it had when it read as lost contact; its reason says a person checks the save first.
		[`${COMPLETION_REFUSED}; durable attempt output requires review`, "failed", true],
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
		["Native provider bridge request failed (422) [code=NATIVE_WAKE_ENVELOPE:TIMEOUT]", "failed", true],
		["Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:TIMEOUT]", "failed", true],
		["Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:UNKNOWN]", "failed", false],
		[
			"Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:CANCELLED]; durable attempt output requires review",
			"failed",
			true,
		],
		["Native provider bridge request failed (422) [code=NATIVE_CREDENTIAL_DOWNLOAD]", "failed", false],
		["something nobody has seen before", "failed", false],
	] as const)("%s → %s", (error, status, expected) => {
		expect(runFailureInterrupted(error, status)).toBe(expected);
	});
});

describe("why a coding session's turn failed, in the member's words", () => {
	// The executor's summary: its own sentence, or "The coding turn did not finish: " and the run's last error.
	const DID_NOT_FINISH = "The coding turn did not finish: ";
	it.each([
		["executor-lease-expired", /^Qorpera lost contact with this session\./],
		[
			`${DID_NOT_FINISH}Native provider bridge request failed (422) [code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]; durable attempt output requires review`,
			/^The session's last turn ended without saving its work or asking a question\./,
		],
		[
			`${DID_NOT_FINISH}Native provider bridge request failed (422) [code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]`,
			/^The session's last turn ended without saving its work/,
		],
		["The coding turn ended without a submission.", /^The session's last turn ended without saving its work/],
		[
			`${DID_NOT_FINISH}Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]`,
			/^The company ran out of computer hours\./,
		],
		// Before the coding runtime's own code reached the runner, the stage's code stood in for it.
		[
			`${DID_NOT_FINISH}Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:UNKNOWN]; durable attempt output requires review`,
			/^Something on Qorpera's side refused one of the session's steps\./,
		],
		[
			`${DID_NOT_FINISH}Native provider bridge request failed (422) [code=CODING_SESSION_DETACHED]`,
			/^Something on Qorpera's side refused/,
		],
		[
			`${DID_NOT_FINISH}Native provider bridge request failed (422) [code=CODING_TURN_ENDED_WITHOUT_SUBMISSION_AGAIN]`,
			/^Something on Qorpera's side refused/,
		],
		[
			`${DID_NOT_FINISH}Runner lease expired before durable completion; durable attempt output requires review`,
			/^Qorpera lost contact with this session\./,
		],
		[
			`${DID_NOT_FINISH}${COMPLETION_REFUSED}; durable attempt output requires review`,
			/^One of the session's saves did not finish, and a person must check it first\./,
		],
		[
			`${DID_NOT_FINISH}Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422)`,
			/^No computer could be started for the session\./,
		],
		[`${DID_NOT_FINISH}Runner model socket request timed out`, /^One of the session's steps got no answer in time\./],
		[
			`${DID_NOT_FINISH}Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:CANCELLED]`,
			/^Qorpera lost contact with this session\./,
		],
		[
			`${DID_NOT_FINISH}Native provider bridge request failed (422) [code=NATIVE_PROMPT_COMPOSITION:TIMEOUT]`,
			/^One of the session's steps got no answer in time\./,
		],
		[`${DID_NOT_FINISH}Execution deadline expired before durable completion`, /^The session took too long/],
		[
			`${DID_NOT_FINISH}You have hit your usage limit. Try again later.`,
			/^The model account paying for this session reached its usage limit\./,
		],
		[`${DID_NOT_FINISH}Provider credential is invalid`, /^The model account needs to be connected again\./],
		["The coding turn was stopped before it finished.", /^The session was stopped before it finished\./],
		["The coding turn did not finish.", /^The session stopped because of an internal error\./],
		["something nobody has seen before", /^The session stopped because of an internal error\./],
		[undefined, /^The session stopped because of an internal error\./],
	] as const)("%s", (reason, expected) => {
		const said = codingFailureReason(reason);
		expect(said).toMatch(expected);
		// What happens to the work is always said.
		expect(said).toMatch(/ The workspace is kept; a follow-up (continues|starts it again|tries again)/);
		// Plain words only: no status codes, no codes, no machinery names.
		expect(said).not.toMatch(/\d{3}|\[|code|runner|provider|bridge|lease|dispatch|native|submission|executor/i);
	});
});
