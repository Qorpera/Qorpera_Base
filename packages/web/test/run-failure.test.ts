import { describe, expect, it } from "vitest";
import { fmtTime } from "../src/ui/dom.ts";
import { codingFailureReason, runFailureInterrupted, runFailureReason } from "../src/ui/run-failure.ts";

// The runner's own failure when the cloud refuses a run's completion for good (runtime cloud-runner-worker.ts).
const COMPLETION_REFUSED =
	"Runner completion was refused: the run left unsettled work, such as an open operation receipt [code=RUN_COMPLETION_REFUSED]";
// The runner's report of a refused bridge request, as production stored it (3 November 2026), for a code.
const BRIDGE = (code: string) => `Native provider bridge request failed (422) [code=${code}]`;
// To the member whose own login paid for the run, and to anyone else (or when the web cannot tell whose it is).
const PROVIDER_REFUSED =
	/^ChatGPT refused or could not answer this run's request\. Check the login that pays for it in Settings → AI subscriptions, or choose another login for this conversation\.$/;
const PROVIDER_REFUSED_FOR_OTHERS =
	/^ChatGPT refused or could not answer this run's request\. The member whose login pays for it can check that login in Settings → AI subscriptions\.$/;
const CONNECTION_LOST = /^The run lost its connection while it was working\. This is usually brief\.$/;
const LOGIN_UNAVAILABLE =
	/^The run could not load the login that pays for it\. Check that login in Settings → AI subscriptions, or choose another login for this conversation\.$/;
const LOGIN_UNAVAILABLE_FOR_OTHERS =
	/^The run could not load the login that pays for it\. The member whose login it is can check it in Settings → AI subscriptions\.$/;
const QORPERA_REFUSED = /^The run started, but one of its steps was refused\. The problem is on Qorpera's side\.$/;

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
		[COMPLETION_REFUSED, "failed", /^The run ended before all of its work was saved\. Send a message to carry on\.$/],
		[
			`${COMPLETION_REFUSED}; durable attempt output requires review`,
			"failed",
			/^The run ended before all of its work was saved\./,
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
		// The turn failed with the model provider's own error (3 November 2026: a ChatGPT workspace plan's login whose
		// every Codex turn failed), told here to a member whose own login did not pay.
		[BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED"), "failed", PROVIDER_REFUSED_FOR_OTHERS],
		[
			`${BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED")}; durable attempt output requires review`,
			"failed",
			PROVIDER_REFUSED_FOR_OTHERS,
		],
		// The same category at an earlier step is the pinned Codex refusing a request on the host, before any model
		// request: Qorpera's side.
		[BRIDGE("NATIVE_CODEX_INITIALIZE:PROVIDER_FAILED"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CODEX_CONFIGURATION:PROVIDER_FAILED"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CODEX_SKILLS:PROVIDER_FAILED"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CODEX_THREAD_START:PROVIDER_FAILED"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CODEX_TURN_START:PROVIDER_FAILED"), "failed", QORPERA_REFUSED],
		// A connection that dropped or could not be made, to ChatGPT or a cloud call (31 October 2026, while the database
		// stopped answering): usually brief.
		[BRIDGE("NATIVE_PROMPT_COMPOSITION:TRANSPORT_UNAVAILABLE"), "failed", CONNECTION_LOST],
		[BRIDGE("NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE"), "failed", CONNECTION_LOST],
		// The run's login could not be downloaded before the model started; a download that got no answer is a timeout.
		[BRIDGE("NATIVE_CREDENTIAL_DOWNLOAD"), "failed", LOGIN_UNAVAILABLE_FOR_OTHERS],
		[BRIDGE("NATIVE_CREDENTIAL_DOWNLOAD:UNKNOWN"), "failed", LOGIN_UNAVAILABLE_FOR_OTHERS],
		[BRIDGE("NATIVE_CREDENTIAL_DOWNLOAD:TIMEOUT"), "failed", /steps got no answer in time/],
		[BRIDGE("NATIVE_CREDENTIAL_DOWNLOAD:CANCELLED"), "failed", /^Qorpera lost contact with this run\./],
		// Qorpera's own machinery stays Qorpera's: the company's context, a coding session's own step, opening or sealing
		// the login on the host, the host's own credential, a spent budget the cloud did not record as a usage limit.
		[BRIDGE("NATIVE_COMPANY_CONTEXT:UNKNOWN"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CODING_SESSION:UNKNOWN"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CREDENTIAL_OPENING"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CREDENTIAL_UPLOAD:UNKNOWN"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_HOST_CREDENTIAL"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED"), "failed", QORPERA_REFUSED],
		// Only a whole category or a whole code decides, never words inside a code.
		[BRIDGE("NATIVE_PROVIDER_FAILED_WATCH:UNKNOWN"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED_AGAIN"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_TRANSPORT_UNAVAILABLE"), "failed", QORPERA_REFUSED],
		[BRIDGE("NATIVE_CREDENTIAL_DOWNLOADER"), "failed", QORPERA_REFUSED],
		// The runner's own provider of computers, as production stored it: no computer, not ChatGPT.
		[
			"Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422) [code=PROVIDER_ACQUIRE]",
			"failed",
			/^No computer could be started for this run\./,
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

	it("says when the limit resets, when the paying login's reset is known and ahead", () => {
		const budget = BRIDGE("NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED");
		const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
		expect(runFailureReason(budget, "failed", true, { own: true, resetsAt: reset })).toBe(
			`The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again when the limit resets (${fmtTime(reset)}).`,
		);
		// A reset that has passed, or none known: no time.
		const plain =
			"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again once the limit resets.";
		const past = new Date(Date.now() - 60_000).toISOString();
		expect(runFailureReason(budget, "failed", true, { own: true, resetsAt: past })).toBe(plain);
		expect(runFailureReason(budget, "failed", true, { own: true })).toBe(plain);
		expect(runFailureReason(budget, "failed", true)).toBe(plain);
		// A reset never makes a usage limit of another failure.
		const refused = BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED");
		expect(runFailureReason(refused, "failed", false, { own: true, resetsAt: reset })).toMatch(PROVIDER_REFUSED);
		expect(runFailureReason(budget, "failed", false, { own: true, resetsAt: reset })).toMatch(QORPERA_REFUSED);
	});

	it("asks the member whose own login paid to check it, and tells anyone else who can", () => {
		const refused = BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED");
		const download = BRIDGE("NATIVE_CREDENTIAL_DOWNLOAD");
		expect(runFailureReason(refused, "failed", false, { own: true })).toMatch(PROVIDER_REFUSED);
		expect(runFailureReason(download, "failed", false, { own: true })).toMatch(LOGIN_UNAVAILABLE);
		// Another member's login, or the web cannot tell: no choice that is not theirs to make.
		for (const payer of [{ own: false }, {}]) {
			expect(runFailureReason(refused, "failed", false, payer)).toMatch(PROVIDER_REFUSED_FOR_OTHERS);
			expect(runFailureReason(download, "failed", false, payer)).toMatch(LOGIN_UNAVAILABLE_FOR_OTHERS);
		}
		// Words that ask nothing of the login's member read the same to everyone.
		const lost = BRIDGE("NATIVE_PROMPT_COMPOSITION:TRANSPORT_UNAVAILABLE");
		expect(runFailureReason(lost, "failed", false, { own: true })).toBe(runFailureReason(lost, "failed", false));
		const context = BRIDGE("NATIVE_COMPANY_CONTEXT:UNKNOWN");
		expect(runFailureReason(context, "failed", false, { own: true })).toMatch(QORPERA_REFUSED);
	});

	it("never says the work moves to another login by itself", () => {
		for (const error of [
			BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED"),
			BRIDGE("NATIVE_CREDENTIAL_DOWNLOAD"),
			BRIDGE("NATIVE_PROMPT_COMPOSITION:TRANSPORT_UNAVAILABLE"),
		]) {
			const reason = runFailureReason(error, "failed", false);
			expect(reason).not.toMatch(/moves? to another|switch|automatic/i);
			expect(reason).not.toMatch(/Qorpera's side/);
		}
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
		// ChatGPT refused the login's request: the member checks the login or picks another one first.
		[BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED"), "failed", false],
		// A dropped connection is usually brief.
		[BRIDGE("NATIVE_PROMPT_COMPOSITION:TRANSPORT_UNAVAILABLE"), "failed", true],
		[BRIDGE("NATIVE_COMPANY_CONTEXT:UNKNOWN"), "failed", false],
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
			/^The session ended before all of its work was saved\./,
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
		// As production stored it (3 November 2026): the session's login was refused by ChatGPT.
		[
			`${DID_NOT_FINISH}${BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED")}`,
			/^ChatGPT refused or could not answer the session's request\. The member whose login pays for it can check that login in Settings → AI subscriptions\./,
		],
		[
			`${DID_NOT_FINISH}${BRIDGE("NATIVE_CODEX_TURN_START:PROVIDER_FAILED")}`,
			/^Something on Qorpera's side refused one of the session's steps\./,
		],
		[
			`${DID_NOT_FINISH}${BRIDGE("NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE")}`,
			/^The session lost its connection while it was working\./,
		],
		[
			`${DID_NOT_FINISH}${BRIDGE("NATIVE_CREDENTIAL_DOWNLOAD")}`,
			/^The session could not load the login that pays for it\. The member whose login it is can check it in Settings → AI subscriptions\./,
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
		expect(said).toMatch(
			/ The workspace is kept; a follow-up (continues|starts it again|tries again|waits and goes on)/,
		);
		// Plain words only: no status codes, no codes, no machinery names.
		expect(said).not.toMatch(/\d{3}|\[|code|runner|provider|bridge|lease|dispatch|native|submission|executor/i);
	});
});

describe("a coding session's failed turn, to the member who owns it", () => {
	const DID_NOT_FINISH = "The coding turn did not finish: ";
	it("asks the owner, whose login pays, to check it", () => {
		expect(
			codingFailureReason(`${DID_NOT_FINISH}${BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED")}`, {
				mine: true,
			}),
		).toBe(
			"ChatGPT refused or could not answer the session's request. Check the login that pays for it in Settings → AI subscriptions. The workspace is kept; a follow-up continues it.",
		);
		expect(codingFailureReason(`${DID_NOT_FINISH}${BRIDGE("NATIVE_CREDENTIAL_DOWNLOAD")}`, { mine: true })).toBe(
			"The session could not load the login that pays for it. Check that login in Settings → AI subscriptions. The workspace is kept; a follow-up continues it.",
		);
		// Anyone else reads who can act.
		expect(
			codingFailureReason(`${DID_NOT_FINISH}${BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED")}`, {
				mine: false,
			}),
		).toMatch(/^ChatGPT refused or could not answer the session's request\. The member whose login pays for it /);
	});
});

describe("a coding session's failed turn, by its code (20260930560000)", () => {
	// The summary is the cloud's plain words now; the failed event's code decides.
	const WORDS = "The coding turn stopped. The files the turn wrote stay in the session's workspace as it left them.";
	it.each([
		[
			"provider_outage",
			/^ChatGPT was overloaded or had a server error while the session worked\. This is usually brief/,
		],
		[
			"NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED",
			/^ChatGPT refused or could not answer the session's request\. The member whose login pays for it /,
		],
		["NATIVE_CODEX_TURN_START:PROVIDER_FAILED", /^Something on Qorpera's side refused one of the session's steps\./],
		["NATIVE_CODING_SESSION:UNKNOWN", /^Something on Qorpera's side refused one of the session's steps\./],
		["NATIVE_CODEX_TURN_COMPLETION:CANCELLED", /^Qorpera lost contact with this session\./],
		["NATIVE_PROMPT_COMPOSITION:TIMEOUT", /^One of the session's steps got no answer in time\./],
		["NATIVE_CODEX_TURN_COMPLETION:TRANSPORT_UNAVAILABLE", /^The session lost its connection while it was working\./],
		["NATIVE_CREDENTIAL_DOWNLOAD", /^The session could not load the login that pays for it\./],
		["CODING_TURN_ENDED_WITHOUT_SUBMISSION", /^The session's last turn ended without saving its work/],
		["COMPUTER_HOURS_EXHAUSTED", /^The company ran out of computer hours\./],
		["RUN_COMPLETION_REFUSED", /^The session ended before all of its work was saved\./],
		// Lower-case reasons name no code: the summary decides, as before.
		["turn_failed", /^The session stopped because of an internal error\./],
	] as const)("%s", (code, expected) => {
		const said = codingFailureReason(WORDS, {}, code);
		expect(said).toMatch(expected);
		expect(said).toMatch(
			/ The workspace is kept; a follow-up (continues|starts it again|tries again|waits and goes on)/,
		);
		expect(said).not.toMatch(/\d{3}|\[|code|runner|provider|bridge|lease|dispatch|native|submission|executor/i);
	});

	it("keeps the code a summary from before carries", () => {
		const before =
			"The coding turn did not finish: Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:CANCELLED]";
		expect(codingFailureReason(before, {}, "NATIVE_CODEX_TURN_COMPLETION:CANCELLED")).toMatch(
			/^Qorpera lost contact with this session\./,
		);
	});

	it("tells the owner the outage is not their login's", () => {
		expect(codingFailureReason(WORDS, { mine: true }, "provider_outage")).toBe(
			"ChatGPT was overloaded or had a server error while the session worked. This is usually brief, and the login is fine. The workspace is kept; a follow-up continues it.",
		);
	});
});
