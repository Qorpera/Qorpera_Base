import { describe, expect, it } from "vitest";
import { fmtTime } from "../src/ui/dom.ts";
import {
	classifyRunFailure,
	codingFailureReason,
	runFailureInterrupted,
	runFailureReason,
	runWaitingReason,
} from "../src/ui/run-failure.ts";

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
const NO_REPLY = /^The agent finished without sending its answer\. The problem is on Qorpera's side\.$/;

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
		// The agent's turn ended without its final send (10 November 2026): it did not answer, nothing was refused. The
		// runtime's own code, and the stage's code older runs carry; a member's stop stays a stop, and any other category
		// at that stage reads as before.
		[BRIDGE("AGENT_TURN_ENDED_WITHOUT_FINAL_SEND"), "failed", NO_REPLY],
		[BRIDGE("NATIVE_PUBLIC_COMPLETION:UNKNOWN"), "failed", NO_REPLY],
		[`${BRIDGE("NATIVE_PUBLIC_COMPLETION:UNKNOWN")}; durable attempt output requires review`, "failed", NO_REPLY],
		[BRIDGE("NATIVE_PUBLIC_COMPLETION:UNKNOWN"), "cancelled", /stopped before it finished/],
		[BRIDGE("AGENT_TURN_ENDED_WITHOUT_FINAL_SEND"), "cancelled", /stopped before it finished/],
		[BRIDGE("NATIVE_PUBLIC_COMPLETION:CANCELLED"), "failed", /^Qorpera lost contact with this run\./],
		[BRIDGE("NATIVE_PUBLIC_COMPLETION:TIMEOUT"), "failed", /steps got no answer in time/],
		[BRIDGE("NATIVE_PUBLIC_COMPLETION"), "failed", QORPERA_REFUSED],
		[BRIDGE("AGENT_TURN_ENDED_WITHOUT_FINAL_SEND_AGAIN"), "failed", QORPERA_REFUSED],
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
		// Try again appears only when the cloud allows it, so the words never ask for it.
		expect(reason).not.toMatch(/try again/i);
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

	it("offers the member whose own login paid to continue with another of theirs, and tells anyone else who can", () => {
		const budget = BRIDGE("NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED");
		const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
		const stopped = "The model account paying for this work reached its usage limit, so the work stopped.";
		// The card offers their other logins: the work waits for the reset, or goes on now by their pick.
		expect(runFailureReason(budget, "failed", true, { own: true, resetsAt: reset, continuable: true })).toBe(
			`${stopped} It can run again when the limit resets (${fmtTime(reset)}), or you can continue it now with another of your logins.`,
		);
		expect(runFailureReason(budget, "failed", true, { own: true, continuable: true })).toBe(
			`${stopped} It can run again once the limit resets, or you can continue it now with another of your logins.`,
		);
		// No other login of theirs can pay now: the work waits, as before.
		expect(runFailureReason(budget, "failed", true, { own: true, resetsAt: reset, continuable: false })).toBe(
			`${stopped} It does not move to another account. It can run again when the limit resets (${fmtTime(reset)}).`,
		);
		// Anyone else reads who can continue it, never an offer of their own.
		expect(runFailureReason(budget, "failed", true, { own: false, payerName: "Anna", continuable: true })).toBe(
			`${stopped} It can run again once the limit resets. Only Anna can continue it now with another of their logins.`,
		);
		expect(runFailureReason(budget, "failed", true, { continuable: true })).toBe(
			`${stopped} It does not move to another account. It can run again once the limit resets.`,
		);
		// Another failure never reads as continuable.
		const refused = BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED");
		expect(runFailureReason(refused, "failed", false, { own: true, continuable: true })).toMatch(PROVIDER_REFUSED);
		expect(runFailureReason(refused, "failed", false, { own: false, payerName: "Anna" })).toMatch(
			PROVIDER_REFUSED_FOR_OTHERS,
		);
	});

	it("says a waiting run goes on by itself at the reset, and who may continue it now (20260930703000)", () => {
		const until = new Date(Date.now() + 30 * 3_600_000).toISOString();
		const waits = `The model account paying for this work reached its usage limit. The work waits and goes on by itself when the limit resets (${fmtTime(until)})`;
		expect(runWaitingReason(until, { own: true, continuable: true })).toBe(
			`${waits}, or you can continue it now with another of your logins.`,
		);
		expect(runWaitingReason(until, { own: true })).toBe(`${waits}.`);
		expect(runWaitingReason(until, { own: false, payerName: "Anna" })).toBe(
			`${waits}. Only Anna can continue it now with another of their logins.`,
		);
		// The member's own login names no one; anyone else with no name reads the plain words.
		expect(runWaitingReason(until, { own: true, payerName: "Anna" })).toBe(`${waits}.`);
		expect(runWaitingReason(until)).toBe(`${waits}.`);
		expect(runWaitingReason(until, { continuable: true })).toBe(`${waits}.`);
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

describe("a run ChatGPT turned away for too many requests at once (20260930801000)", () => {
	const refused = BRIDGE("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED");
	const TURNED_AWAY = "ChatGPT turned this run away because too many requests came at once. The login is fine.";
	const WAITS =
		"ChatGPT is busy with too many requests at once. This work waits a few minutes and then tries again by itself. The login is fine.";

	it("tells every reader it was too many requests at once, never to check the login", () => {
		expect(classifyRunFailure(refused, "failed", false, true)).toBe("rate_limited");
		for (const payer of [{ own: true }, { own: false, payerName: "Anna" }, {}]) {
			const reason = runFailureReason(refused, "failed", false, payer, true);
			expect(reason).toBe(TURNED_AWAY);
			expect(reason).not.toMatch(/Settings|check|another login|usage limit/i);
		}
	});

	it("tells a member plainly that their own message didn't go through", () => {
		const message = "Your message didn't go through: ChatGPT got too many requests at once. The login is fine.";
		expect(runFailureReason(refused, "failed", false, { own: true }, true, true)).toBe(message);
		expect(runFailureReason(refused, "failed", false, {}, true, true)).toBe(message);
		for (const own of [false, undefined])
			expect(runFailureReason(refused, "failed", false, {}, true, own)).toBe(TURNED_AWAY);
		expect(runFailureReason(refused, "failed", false, { own: true }, false, true)).toMatch(PROVIDER_REFUSED);
	});

	it("keeps a usage limit a usage limit, and reads as before from an older cloud", () => {
		expect(runFailureReason(refused, "failed", true, { own: true }, true)).toMatch(/reached its usage limit/);
		expect(runFailureReason(refused, "failed", false, { own: true })).toMatch(PROVIDER_REFUSED);
		expect(runFailureReason(refused, "failed", false, { own: true }, false)).toMatch(PROVIDER_REFUSED);
	});

	it("is worth trying again as it is", () => {
		expect(runFailureInterrupted(refused, "failed", false, true)).toBe(true);
		expect(runFailureInterrupted(refused, "failed", false)).toBe(false);
	});

	it("says a waiting run tries again by itself in minutes, with no reset and no other login", () => {
		const until = new Date(Date.now() + 90_000).toISOString();
		for (const payer of [{ own: true, continuable: true }, { own: false, payerName: "Anna" }, {}])
			expect(runWaitingReason(until, payer, true)).toBe(WAITS);
		expect(runWaitingReason(until, { own: true })).toMatch(/reached its usage limit/);
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
		// The agent finished without sending its answer: worth trying again as it is.
		[BRIDGE("AGENT_TURN_ENDED_WITHOUT_FINAL_SEND"), "failed", true],
		[BRIDGE("NATIVE_PUBLIC_COMPLETION:UNKNOWN"), "failed", true],
		[BRIDGE("NATIVE_PUBLIC_COMPLETION:UNKNOWN"), "cancelled", true],
		[BRIDGE("NATIVE_PUBLIC_COMPLETION"), "failed", false],
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

describe("a change to code kept in Qorpera that did not go in for its checks (own code storage, step 3)", () => {
	const NOT_PASSED = "Not saved yet: the change did not pass its tests, so the code is as it was.";
	const NOT_TESTED = "Not saved yet: Qorpera could not test the change just now. Nothing was lost.";
	// The executor's words as the cloud keeps them (runner-orchestrator code-checks.ts, with the round sentence the cloud
	// adds): the check, its command and the end of its output, which may say anything, a code included.
	const FAILED = [
		'Nothing went into main: the check "test" failed on this change merged with main as it is now. It ran `npm test` and ended with exit code 124 after 600 s, at its time limit of 600 s. The end of its output:',
		"",
		"    Error: Provider credential is invalid; you have hit your usage limit. Request timed out.",
		"    Native provider bridge request failed (422) [code=COMPUTER_HOURS_EXHAUSTED]",
		"",
		"Its whole output is in ~/.qorpera-checks/out/2-test.log on the session's machine. Checks that passed before it: install. Fix the cause in the code, never by removing or weakening the check or its tests; run the checks yourself from a clean copy, commit and finish again. The checks failed for this session 2 times in a row.",
	].join("\n");
	const REFUSED =
		"Nothing went into main: the repository's checks file, .qorpera/checks.json, is gone in this change, and a repository that has checks keeps them. Fix the file, commit and finish again.";
	const DID_NOT_RUN =
		"Nothing went into main: Qorpera could not run the repository's checks on this change (the session's machine did not answer). This is not a fault in the code. The work is kept on the session's branch; finishing again runs the checks again.";
	const MAIN_MOVED =
		"Nothing went into main yet: main changed twice while this change's checks ran, so they never ran on what would go in. This is not a fault in the code. The work is kept on the session's branch; finishing again checks it once more.";
	// Step 4: every check passed, but the site they built cannot go out (runner-orchestrator code-site.ts).
	const SITE_REFUSED =
		'Nothing went into main: every check passed, but the site in "dist" holds the value of STRIPE_KEY in assets/app.js. A key must never be built into the site. Fix it in the code or in the checks file\'s "site", and finish again.';
	// The cloud's plain words for a failed run, whose code travels apart (20260930560000).
	const STOPPED = "The coding turn stopped. The files the turn wrote stay in the session's workspace as it left them.";
	// What a cloud without step 3's failure words makes of any code it has no case for.
	const QORPERA_WORDS =
		"The coding turn stopped because of a problem on Qorpera's side. The files the turn wrote stay in the session's workspace as it left them; a follow-up turn continues from them.";

	it.each([
		["CODING_CHECKS_FAILED", FAILED, NOT_PASSED],
		["CODING_CHECKS_REFUSED", REFUSED, NOT_PASSED],
		["CODING_CHECKS_DID_NOT_RUN", DID_NOT_RUN, NOT_TESTED],
		["CODING_CHECKS_MAIN_MOVED", MAIN_MOVED, NOT_TESTED],
		["CODING_CHECKS_SITE_REFUSED", SITE_REFUSED, NOT_PASSED],
	] as const)("%s", (code, summary, expected) => {
		// The failed event's code decides, for the owner and for anyone else, whatever the output says.
		for (const said of [
			codingFailureReason(summary, {}, code),
			codingFailureReason(summary, { mine: true }, code),
			codingFailureReason(summary, { mine: false }, code),
			// A summary that still ends with its code, and no code beside it, reads the same, as the cloud reads it.
			codingFailureReason(`${summary} [code=${code}]`),
			codingFailureReason(`${summary}\n[code=${code}]\n`),
			// A cloud whose failure words do not know the code yet: the code still decides.
			codingFailureReason(QORPERA_WORDS, {}, code),
		]) {
			expect(said).toBe(expected);
			// A founder never reads a check's name, its command or output, a branch, a commit, a pull request or "CI".
			expect(said).not.toMatch(/\[|code=|check|npm|main\b|branch|commit|pull request|\bCI\b|git|\.json|\d/i);
		}
	});

	it("leaves a usage limit first, as the cloud does", () => {
		expect(codingFailureReason(FAILED, { usageLimit: true }, "CODING_CHECKS_FAILED")).toBe(
			"The model account paying for this session reached its usage limit. The workspace is kept; a follow-up waits and goes on by itself once the limit resets.",
		);
	});

	it("reads every other code as before, so a cloud that sends none of these works as it did", () => {
		// Only a whole code decides.
		for (const code of [
			"CODING_CHECKS",
			"CODING_CHECKS_FAILED_AGAIN",
			"CODING_CHECKS_FAILED:UNKNOWN",
			"CODING_CHECK_FAILED",
		])
			expect(codingFailureReason(STOPPED, {}, code)).toBe(
				"Something on Qorpera's side refused one of the session's steps. The workspace is kept; a follow-up continues it.",
			);
		// Lower-case reasons name no code.
		expect(codingFailureReason(STOPPED, {}, "coding_checks_failed")).toBe(
			"The session stopped because of an internal error. The workspace is kept; a follow-up continues it.",
		);
		// A code in a summary decides only at its end: one inside the run's error reads as before.
		expect(
			codingFailureReason(
				"The coding turn did not finish: Runner model socket request timed out [code=CODING_CHECKS_FAILED]; durable attempt output requires review",
			),
		).toBe("One of the session's steps got no answer in time. The workspace is kept; a follow-up continues it.");
		// Without a code anywhere, the executor's words are never shown as they are.
		expect(codingFailureReason(MAIN_MOVED)).toBe(
			"The session stopped because of an internal error. The workspace is kept; a follow-up continues it.",
		);
	});
});

describe("a session whose workspace was refused for its files (own code storage, the import's follow-ups, part N)", () => {
	const NAMES =
		"The session could not start: the code holds file names that Qorpera cannot keep. Trying again will not help. The agent knows what to do next.";
	const LARGE =
		"The session could not start: the code holds a file that is too large for Qorpera to keep. Trying again will not help. The agent knows what to do next.";
	const INTERNAL =
		"The session stopped because of an internal error. The workspace is kept; a follow-up continues it.";
	const BRIDGE =
		"Something on Qorpera's side refused one of the session's steps. The workspace is kept; a follow-up continues it.";
	// The executor's words for the agent as the cloud keeps them (runner-orchestrator code-host-repositories.ts): the
	// refused paths, the session's branch and git, then the code. A path may be named like anything, a login's or a
	// limit's words among them.
	const refused = (paths: string, code: string) =>
		`The session's workspace could not be made again: its branch holds file or folder names the company folder does not take (${paths}), so a follow-up will not help. Archive this session with manage_worker, action archive, and start a new one on the repository: the work stays on branch qorpera/coding/11111111-1111-4111-8111-111111111111, where the new session reads each file with git show qorpera/coding/11111111-1111-4111-8111-111111111111:<path> and saves it under a name the folder takes. [code=${code}]`;
	const PATHS = [
		'"bad."',
		'"src/signin.tsx."',
		'"quota.txt "',
		'"usage limit reached/token expired."',
		'"lease expired/timed out."',
		'"deadline expired."',
	];

	it.each([
		["CODE_HOST_NAMES_FOLDER_REFUSES", NAMES],
		["CODE_HOST_NAMES_NOT_UTF8", NAMES],
		["CODE_HOST_NAMES_NOT_NFC", NAMES],
		["CODE_HOST_NAMES_DIFFER_BY_CASE", NAMES],
		["CODE_HOST_FILE_TOO_LARGE", LARGE],
	] as const)("%s", (code, expected) => {
		for (const paths of PATHS) {
			const summary = refused(paths, code);
			// The failed event's code decides, for the owner and for anyone else; and the summary's own code at its end,
			// with no code beside it, the same; a path's words never pick another sentence.
			for (const said of [
				codingFailureReason(summary, {}, code),
				codingFailureReason(summary, { mine: true }, code),
				codingFailureReason(summary, { mine: false }, code),
				codingFailureReason(INTERNAL, {}, code),
				codingFailureReason(summary),
				codingFailureReason(`${summary}\n`),
			]) {
				expect(said, `${code} ${paths}`).toBe(expected);
				// A member never reads a path, a branch, git, a ref, a command or a code.
				expect(said).not.toMatch(/\[|code=|branch|git|ref|commit|merge|manage_worker|archive|"|\d/i);
			}
		}
	});

	it("leaves a usage limit first, and reads every other failure as before", () => {
		expect(codingFailureReason(refused('"bad."', "CODE_HOST_NAMES_FOLDER_REFUSES"), { usageLimit: true })).toBe(
			"The model account paying for this session reached its usage limit. The workspace is kept; a follow-up waits and goes on by itself once the limit resets.",
		);
		// Only a whole code of these five decides: another code of the code host's is a step refused, as before.
		for (const code of [
			"CODE_HOST_NAMES",
			"CODE_HOST_NAMES_FOLDER_REFUSES_AGAIN",
			"CODE_HOST_FILE_TOO_LARGE:X",
			"CODE_HOST_UNEXPECTED_FILE",
		])
			expect(codingFailureReason(INTERNAL, {}, code), code).toBe(BRIDGE);
		expect(codingFailureReason(refused('"bad."', "CODE_HOST_UNEXPECTED_FILE"))).toBe(INTERNAL);
		// Lower-case reasons name no code.
		expect(codingFailureReason(INTERNAL, {}, "code_host_names_folder_refuses")).toBe(INTERNAL);
		// A code inside a summary, not at its end, decides nothing.
		expect(codingFailureReason(`${refused('"bad."', "CODE_HOST_NAMES_FOLDER_REFUSES")} Then it stopped.`)).toBe(
			INTERNAL,
		);
		// A landing refused for names from an executor before 20260930743000 carries no code (the kernel's is lower case):
		// as before, not these words, and not the landing's either.
		const landing =
			'The change was not landed, and nothing changed on main: it holds file or folder names the company folder does not take (one that ends in a dot or a space, holds a backslash or a control character, or is longer than 255 bytes, or a path longer than 4,096 bytes where a session\'s workspace holds it): "bad.". Rename them, commit and finish again.';
		expect(codingFailureReason(landing, {}, "ended_without_submission")).toBe(INTERNAL);
	});
});

describe("a landing refused for its files (migration 20260930743000)", () => {
	const NAMES =
		"The change was not saved: it holds file names that Qorpera cannot keep. The agent has been told to rename them and try again.";
	const LARGE =
		"The change was not saved: it holds a file that is too large for Qorpera to keep. The agent has been told to take it out and try again.";
	const INTERNAL =
		"The session stopped because of an internal error. The workspace is kept; a follow-up continues it.";
	const BRIDGE =
		"Something on Qorpera's side refused one of the session's steps. The workspace is kept; a follow-up continues it.";
	// The executor's words for the agent (runner-orchestrator coding-executor.ts landRefusal), as the kernel keeps them
	// (the code taken off and kept as the reason) and as an older kernel keeps them (the code still at the end). The
	// paths in them may be named like a login, a limit or another code.
	const names = (paths: string) =>
		`The change was not landed, and nothing changed on main: it holds file or folder names the company folder does not take (one that ends in a dot or a space, holds a backslash or a control character, or is longer than 255 bytes, or a path longer than 4,096 bytes where a session's workspace holds it): ${paths}. Rename them, commit and finish again.`;
	const large = (paths: string) =>
		`The change was not landed, and nothing changed on main: it holds files larger than 256 MiB, which a repository kept in Qorpera does not take: ${paths}. Take them out, commit and finish again.`;
	const PATHS = [
		'"bad."',
		'"src/signin.tsx."',
		'"quota.txt "',
		'"usage limit reached/token expired."',
		'"lease expired/timed out."',
		'"x [code=CODE_HOST_NAMES_FOLDER_REFUSES]."',
	];

	it.each([
		["CODING_LAND_NAMES_REFUSED", names, NAMES],
		["CODING_LAND_FILE_TOO_LARGE", large, LARGE],
	] as const)("%s", (code, words, expected) => {
		for (const paths of PATHS) {
			const summary = words(paths);
			for (const said of [
				// As the kernel keeps it: the words, and the code as the failed event's.
				codingFailureReason(summary, {}, code),
				codingFailureReason(summary, { mine: true }, code),
				codingFailureReason(summary, { mine: false }, code),
				// As a kernel from before keeps it: its own words, and the code as the event's.
				codingFailureReason(
					"The coding turn stopped because of a problem on Qorpera's side. The files the turn wrote stay in the session's workspace as it left them; a follow-up turn continues from them.",
					{},
					code,
				),
				// The summary's own code at its end, and no code beside it.
				codingFailureReason(`${summary} [code=${code}]`),
				codingFailureReason(`${summary} [code=${code}]\n`),
			]) {
				expect(said, `${code} ${paths}`).toBe(expected);
				// A member never reads a path, a branch, git, a ref, a command or a code, and is never told it could not start.
				expect(said).not.toMatch(/\[|code=|branch|git|ref|commit|merge|manage_worker|"|\d|could not start/i);
			}
		}
	});

	it("is told apart from a workspace refused for the same files, and leaves every other failure as before", () => {
		expect(codingFailureReason(names('"bad."'), {}, "CODE_HOST_NAMES_FOLDER_REFUSES")).toMatch(
			/^The session could not start: /,
		);
		expect(codingFailureReason(names('"bad."'), {}, "CODING_LAND_NAMES_REFUSED")).toBe(NAMES);
		// A usage limit first.
		expect(codingFailureReason(names('"bad."'), { usageLimit: true }, "CODING_LAND_NAMES_REFUSED")).toBe(
			"The model account paying for this session reached its usage limit. The workspace is kept; a follow-up waits and goes on by itself once the limit resets.",
		);
		// Only a whole code of the two: another landing code is a step refused, as any code no class names.
		for (const code of [
			"CODING_LAND",
			"CODING_LAND_NAMES_REFUSED_AGAIN",
			"CODING_LAND_FILE_TOO_LARGE:X",
			"CODING_LAND_OTHER",
		])
			expect(codingFailureReason(INTERNAL, {}, code), code).toBe(BRIDGE);
		// A code inside the words, not at their end, decides nothing.
		expect(codingFailureReason(`${names('"bad."')} [code=CODING_LAND_NAMES_REFUSED] Then it stopped.`)).toBe(
			INTERNAL,
		);
	});
});
