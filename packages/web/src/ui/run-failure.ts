import { button, fmtTime, h } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { phrase, t } from "./preferences.ts";

/** What stopped the run, from the cloud's own error text (which names machinery,
 * not causes) and the job status. One classification feeds both the sentence the
 * member reads and whether Try again is worth offering. */
export type RunFailureKind =
	| "computer_hours"
	| "usage_limit"
	| "rate_limited"
	| "provider_refused"
	| "connection"
	| "login_unavailable"
	| "credential"
	| "dispatch"
	| "completion_refused"
	| "lost"
	| "step_timeout"
	| "timeout"
	| "bridge"
	| "no_reply"
	| "cancelled"
	| "other";

export function classifyRunFailure(
	lastError: string | undefined,
	jobStatus: "failed" | "cancelled",
	usageLimit?: boolean,
	rateLimited?: boolean,
): RunFailureKind {
	// The company ran out of computer hours and its hour to finish running work ended: the one
	// code that decides the class, since it names the company's hours, not Qorpera's machinery.
	if ((lastError ?? "").includes("[code=COMPUTER_HOURS_EXHAUSTED]")) return "computer_hours";
	// The cloud recorded a usage-limit signal for this run: the bridge's refusal it was saved with names only
	// a spent budget, which a full context window shares. When the cloud says (true or false), it decides;
	// only an older cloud, which says nothing, leaves it to the error text below.
	if (usageLimit === true) return "usage_limit";
	if (rateLimited === true) return "rate_limited";
	// The run ended, but the cloud refused its completion because work was left unsettled, such as a save whose outcome
	// is unknown (30 October 2026). The runner fails it at once with this code; it used to go silent and read as lost
	// contact minutes later.
	if ((lastError ?? "").includes("[code=RUN_COMPLETION_REFUSED]")) return "completion_refused";
	// The agent's turn ended without its final send_message, so the member got no reply (10 November 2026). Nothing was
	// refused: the runtime's own code says so, and older runs carry the stage's code with the category "unknown", which
	// only that ending produces. A member's stop stays a stop; any other category at that stage reads as below.
	if (
		(lastError ?? "").includes("[code=AGENT_TURN_ENDED_WITHOUT_FINAL_SEND]") ||
		(lastError ?? "").includes("[code=NATIVE_PUBLIC_COMPLETION:UNKNOWN]")
	)
		return jobStatus === "cancelled" ? "cancelled" : "no_reply";
	// Any other refused step carries the provider's fixed code (e.g. "[code=NATIVE_CREDENTIAL_SEALING:STORAGE_BUDGET]").
	// Most name Qorpera's own machinery, not a member's account, so the words inside a code never decide the class: the
	// step stays "bridge", as it was before the code. Only its category can (the part after the colon, from the runtime's
	// closed list), or a whole code that names one step: a step that ran out of time
	// ("[code=NATIVE_PROMPT_COMPOSITION:TIMEOUT]") took too long, it was not refused (Jonas, 21 October 2026).
	const timedOut = / \[code=(?:[A-Z0-9_]{1,42}:)?(?:[A-Z0-9_]{0,41}_)?(?:TIMEOUT|TIMED_OUT)\]/.test(lastError ?? "");
	// A step whose code's category is "cancelled" ("[code=NATIVE_CODEX_TURN_COMPLETION:CANCELLED]") was stopped from
	// Qorpera's side while it ran, e.g. when the run's authority could not be read through a database outage (28
	// October 2026): it was not refused.
	const stepCancelled = / \[code=[A-Z0-9_]{1,42}:CANCELLED\]/.test(lastError ?? "");
	// The turn itself failed with the category "provider_failed" (the whole code): Codex ended it with the model
	// provider's own error, which it reads only once the turn is under way (ChatGPT refused the login's request, as for a
	// workspace plan's login whose Codex turns all failed on 3 November 2026, or could not answer it). The member checks
	// the login paying for the run first. The same category at an earlier step (initialize, configuration, skills,
	// thread or turn start) is the pinned Codex refusing one of the run's requests on the host, which never reached
	// ChatGPT: Qorpera's side, as before.
	const providerFailed = / \[code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED\]/.test(lastError ?? "");
	// The category "transport_unavailable": a connection dropped or could not be made while a step worked (to ChatGPT,
	// or a cloud call of the run), whichever side it was. It is usually brief, so the run is worth trying again.
	const connectionLost = / \[code=[A-Z0-9_]{1,42}:TRANSPORT_UNAVAILABLE\]/.test(lastError ?? "");
	// The host could not download the run's login before the model started (the whole code, with or without a category
	// other than a timeout or a cancellation, which read as theirs above): the login vault or its store refused it (a
	// login signed out since, a binding it does not accept) or failed.
	const loginUnavailable = / \[code=NATIVE_CREDENTIAL_DOWNLOAD(?::[A-Z0-9_]{1,42})?\]/.test(lastError ?? "");
	const error = (lastError ?? "").replace(/ \[code=[A-Z0-9_:]{1,85}\]/g, "");
	// A rate limit is not a usage limit: it passes by itself (contract 17).
	if (usageLimit === undefined && /usage limit|quota/i.test(error)) return "usage_limit";
	if (/not signed in|sign.?in|unauthori[sz]ed|credential|token (is )?(expired|invalid)/i.test(error))
		return "credential";
	if (/dispatch failed|provider request failed|no computer could start/i.test(error)) return "dispatch";
	// A run has no time limit (2026-09-24): a lapsed lease means the run's renewals stopped reaching the cloud,
	// never that it ran too long. Its computer or Qorpera's own database may have stopped answering (21 October 2026:
	// the database), so the member reads that Qorpera lost contact with the run, not which side failed. A step
	// cancelled from Qorpera's side reads the same, unless a member stopped the run.
	if (/lease expired/i.test(error)) return "lost";
	if (stepCancelled) return jobStatus === "cancelled" ? "cancelled" : "lost";
	// One request inside the run got no answer in time (the model socket, the secret broker, a cloud call's own
	// request deadline, a step whose code's category is a timeout): the run itself was not too long.
	if (timedOut || /timed? ?out|did not respond/i.test(error)) return "step_timeout";
	// Only runs from before the time limit was removed carry an expired run deadline.
	if (/deadline expired/i.test(error)) return "timeout";
	if (providerFailed) return "provider_refused";
	if (connectionLost) return "connection";
	if (loginUnavailable) return "login_unavailable";
	if (/bridge request failed/i.test(error)) return "bridge";
	if (jobStatus === "cancelled") return "cancelled";
	return "other";
}

const REASONS: Record<RunFailureKind, string> = {
	computer_hours: phrase("The company is out of computer hours. New work starts again once hours are added."),
	// A usage limit stops the work: it never moves to another account (founder decision 2026-10-01).
	usage_limit: phrase(
		"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again once the limit resets.",
	),
	rate_limited: phrase("ChatGPT turned this run away because too many requests came at once. The login is fine."),
	// The member whose login paid checks it or picks another one; the work never moves to another login by itself.
	provider_refused: phrase(
		"ChatGPT refused or could not answer this run's request. Check the login that pays for it in Settings → AI subscriptions, or choose another login for this conversation.",
	),
	// Try again is offered as for lost contact; the words never ask for it, since the cloud refuses it once work took
	// effect.
	connection: phrase("The run lost its connection while it was working. This is usually brief."),
	login_unavailable: phrase(
		"The run could not load the login that pays for it. Check that login in Settings → AI subscriptions, or choose another login for this conversation.",
	),
	credential: phrase("Your model account needs to be connected again."),
	dispatch: phrase("No computer could be started for this run. The problem is on Qorpera's side."),
	// Try again is refused while a save is unsettled, so the words never ask for it. A founder has nothing to check: a new
	// message carries the work on (Jonas, 7 Nov 2026, plain words for someone who just had an idea).
	completion_refused: phrase("The run ended before all of its work was saved. Send a message to carry on."),
	lost: phrase("Qorpera lost contact with this run. The problem is on Qorpera's side."),
	step_timeout: phrase("One of the run's steps got no answer in time. The problem is on Qorpera's side."),
	timeout: phrase("The run took too long and was stopped."),
	bridge: phrase("The run started, but one of its steps was refused. The problem is on Qorpera's side."),
	// Try again is offered as for lost contact; the words never ask for it.
	no_reply: phrase("The agent finished without sending its answer. The problem is on Qorpera's side."),
	cancelled: phrase("The run was stopped before it finished."),
	other: phrase("The run stopped because of an internal error."),
};

/** The same, for a member whose own login did not pay for the run, or when the web cannot tell: the card is the agent's,
 * so every member reads it, and only the member whose login it is can check it. */
const REASONS_FOR_OTHERS: Partial<Record<RunFailureKind, string>> = {
	provider_refused: phrase(
		"ChatGPT refused or could not answer this run's request. The member whose login pays for it can check that login in Settings → AI subscriptions.",
	),
	login_unavailable: phrase(
		"The run could not load the login that pays for it. The member whose login it is can check it in Settings → AI subscriptions.",
	),
};

/** What the web knows of the login that paid for a failed run (SessionExecutionView.payer): whether it is the reading
 * member's own, and when its usage limit resets. */
export interface RunPayer {
	own?: boolean;
	/** Said only for a usage limit, and only while it is ahead. */
	resetsAt?: string;
	/** The card offers the member whose own login paid their other logins that can pay now ("Continue with …"). */
	continuable?: boolean;
	/** For anyone else: the name of the member whose login paid, the only one who can continue the work on another
	 * login of theirs. */
	payerName?: string;
}

/** Where OpenAI sends a member to manage their ChatGPT plan's usage (Sign in with ChatGPT UI guidelines). */
export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

/** A member's own ChatGPT plan reached its usage limit: OpenAI's words, with ChatGPT named. */
export function planUsageLimitReason(): string {
	return t("ChatGPT · Usage limit reached. Review your plan or this app's limit in ChatGPT settings.");
}

/** "Manage usage": opens the member's ChatGPT usage settings in a new tab. */
export function manageUsageLink(): HTMLElement {
	const link = h(
		"a",
		{ class: "btn btn-small", href: MANAGE_USAGE_URL, target: "_blank", rel: "noopener noreferrer" },
		t("Manage usage"),
	);
	link.dataset.action = "manage-usage";
	return link;
}

/** Why a run stopped, in the member's words. What it asks of the paying login's member is said to that member only
 * (`payer.own`); anyone else reads who can act. */
export function runFailureReason(
	lastError: string | undefined,
	jobStatus: "failed" | "cancelled",
	usageLimit?: boolean,
	payer: RunPayer = {},
	rateLimited?: boolean,
	ownMessage?: boolean,
): string {
	const kind = classifyRunFailure(lastError, jobStatus, usageLimit, rateLimited);
	if (kind === "rate_limited" && ownMessage === true) return t(MESSAGE_RATE_LIMITED);
	const resetsAt = payer.resetsAt;
	const time = kind === "usage_limit" && resetsAt && Date.parse(resetsAt) > Date.now() ? fmtTime(resetsAt) : undefined;
	// The work never moves by itself. The member whose own login paid may continue it with another login of theirs that
	// can pay now (the card's "Continue with …"); anyone else reads who can.
	if (kind === "usage_limit" && payer.own === true && payer.continuable === true)
		return time
			? t(
					"The model account paying for this work reached its usage limit, so the work stopped. It can run again when the limit resets ({time}), or you can continue it now with another of your logins.",
					{ time },
				)
			: t(
					"The model account paying for this work reached its usage limit, so the work stopped. It can run again once the limit resets, or you can continue it now with another of your logins.",
				);
	if (kind === "usage_limit" && payer.own !== true && payer.payerName)
		return t(
			"The model account paying for this work reached its usage limit, so the work stopped. It can run again once the limit resets. Only {name} can continue it now with another of their logins.",
			{ name: payer.payerName },
		);
	if (time)
		return t(
			"The model account paying for this work reached its usage limit, so the work stopped. It does not move to another account. It can run again when the limit resets ({time}).",
			{ time },
		);
	return t((payer.own === true ? undefined : REASONS_FOR_OTHERS[kind]) ?? REASONS[kind]);
}

export function runWaitingReason(until: string, payer: RunPayer = {}, rateLimited?: boolean): string {
	if (rateLimited === true) return t(RATE_LIMIT_WAIT);
	const time = fmtTime(until);
	if (payer.own === true && payer.continuable === true)
		return t(
			"The model account paying for this work reached its usage limit. The work waits and goes on by itself when the limit resets ({time}), or you can continue it now with another of your logins.",
			{ time },
		);
	if (payer.own !== true && payer.payerName)
		return t(
			"The model account paying for this work reached its usage limit. The work waits and goes on by itself when the limit resets ({time}). Only {name} can continue it now with another of their logins.",
			{ time, name: payer.payerName },
		);
	return t(
		"The model account paying for this work reached its usage limit. The work waits and goes on by itself when the limit resets ({time}).",
		{ time },
	);
}

const MESSAGE_RATE_LIMITED = phrase(
	"Your message didn't go through: ChatGPT got too many requests at once. The login is fine.",
);

const RATE_LIMIT_WAIT = phrase(
	"ChatGPT is busy with too many requests at once. This work waits a few minutes and then tries again by itself. The login is fine.",
);

// The coding executor's own words for a turn that ended with no coding_finish or
// coding_ask, or that was stopped (runner-orchestrator coding-executor.ts). Any
// other failure it reports carries the run's last error after its own prefix.
const CODING_TURN_ENDED = "The coding turn ended without a submission.";
const CODING_TURN_STOPPED = "The coding turn was stopped before it finished.";

const CODING_REASONS: Record<RunFailureKind | "no_submission", string> = {
	no_submission: phrase(
		"The session's last turn ended without saving its work or asking a question. The workspace is kept; a follow-up continues it.",
	),
	// Cut off an hour after the company ran out of computer hours (20260928259270).
	computer_hours: phrase(
		"The company ran out of computer hours. The workspace is kept; a follow-up continues once hours are added.",
	),
	usage_limit: phrase(
		"The model account paying for this session reached its usage limit. The workspace is kept; a follow-up waits and goes on by itself once the limit resets.",
	),
	rate_limited: phrase(
		"ChatGPT turned the session's request away because too many requests came at once. The login is fine. The workspace is kept; a follow-up continues it.",
	),
	provider_refused: phrase(
		"ChatGPT refused or could not answer the session's request. Check the login that pays for it in Settings → AI subscriptions. The workspace is kept; a follow-up continues it.",
	),
	connection: phrase(
		"The session lost its connection while it was working. The workspace is kept; a follow-up continues it.",
	),
	login_unavailable: phrase(
		"The session could not load the login that pays for it. Check that login in Settings → AI subscriptions. The workspace is kept; a follow-up continues it.",
	),
	credential: phrase(
		"The model account needs to be connected again. The workspace is kept; a follow-up continues it once the account is connected.",
	),
	dispatch: phrase("No computer could be started for the session. The workspace is kept; a follow-up tries again."),
	completion_refused: phrase(
		"The session ended before all of its work was saved. The workspace is kept; a follow-up continues it.",
	),
	lost: phrase("Qorpera lost contact with this session. The workspace is kept; a follow-up starts it again."),
	step_timeout: phrase(
		"One of the session's steps got no answer in time. The workspace is kept; a follow-up continues it.",
	),
	timeout: phrase("The session took too long and was stopped. The workspace is kept; a follow-up continues it."),
	bridge: phrase(
		"Something on Qorpera's side refused one of the session's steps. The workspace is kept; a follow-up continues it.",
	),
	// A coding session never ends its turn this way; its words are the refused step's.
	no_reply: phrase(
		"Something on Qorpera's side refused one of the session's steps. The workspace is kept; a follow-up continues it.",
	),
	cancelled: phrase("The session was stopped before it finished. The workspace is kept; a follow-up continues it."),
	other: phrase("The session stopped because of an internal error. The workspace is kept; a follow-up continues it."),
};

/** The same, for a member who does not own the session, whose owner's login pays for it, or when the web cannot tell. */
const CODING_REASONS_FOR_OTHERS: Partial<Record<RunFailureKind, string>> = {
	provider_refused: phrase(
		"ChatGPT refused or could not answer the session's request. The member whose login pays for it can check that login in Settings → AI subscriptions. The workspace is kept; a follow-up continues it.",
	),
	login_unavailable: phrase(
		"The session could not load the login that pays for it. The member whose login it is can check it in Settings → AI subscriptions. The workspace is kept; a follow-up continues it.",
	),
};

/** A coding turn whose run ChatGPT could not serve (its own overload or server error, 20260930560000). */
const CODING_PROVIDER_OUTAGE = phrase(
	"ChatGPT was overloaded or had a server error while the session worked. This is usually brief, and the login is fine. The workspace is kept; a follow-up continues it.",
);

/** A change to code kept in Qorpera that did not go in for its checks (own code storage, step 3): the executor's codes,
 * which the cloud keeps as the failed turn's code. The executor's own words name the check, its command and the end of
 * its output, for the agents; a founder reads only that nothing was saved, and whether the change or Qorpera stopped
 * it. The session's owning agent follows up by itself, so nothing is asked of the founder. */
const CODING_CHECKS_FAILED = phrase("Not saved yet: the change did not pass its tests, so the code is as it was.");
const CODING_CHECKS_NOT_RUN = phrase("Not saved yet: Qorpera could not test the change just now. Nothing was lost.");

function codingChecksReason(code: string | undefined): string | undefined {
	switch (code) {
		// A check failed, or the checks file is gone or broken, or the site the checks built cannot go out (step 4: no
		// index.html, over the limits, a secret in it): the change's own doing.
		case "CODING_CHECKS_FAILED":
		case "CODING_CHECKS_REFUSED":
		case "CODING_CHECKS_SITE_REFUSED":
			return CODING_CHECKS_FAILED;
		// The checks could not run, or main moved twice while they ran: never the code's fault.
		case "CODING_CHECKS_DID_NOT_RUN":
		case "CODING_CHECKS_MAIN_MOVED":
			return CODING_CHECKS_NOT_RUN;
	}
	return undefined;
}

/** A session whose workspace could not be made for the names of the files it would hold, or for a file too large (own
 * code storage, the import's follow-ups, part N): the code host's codes, which the cloud keeps as the failed turn's
 * code, or at the end of the executor's summary. That summary is the agent's (the paths, the session's branch, git);
 * a member reads only that the session could not start, that trying again will not help, and that the agent knows what
 * to do. The code decides before any word of the summary is read, since the summary names the refused paths. */
const CODING_NAMES_REFUSED = phrase(
	"The session could not start: the code holds file names that Qorpera cannot keep. Trying again will not help. The agent knows what to do next.",
);
const CODING_FILE_TOO_LARGE = phrase(
	"The session could not start: the code holds a file that is too large for Qorpera to keep. Trying again will not help. The agent knows what to do next.",
);
/** A change the code host refused at its landing for the same reasons (migration 20260930743000): the turn ran, and its
 * change was not saved. The executor's own codes for it (CODING_LAND_*), not the code host's, tell the two apart; the
 * agent's words say what to rename or take out. */
const CODING_LAND_NAMES_REFUSED = phrase(
	"The change was not saved: it holds file names that Qorpera cannot keep. The agent has been told to rename them and try again.",
);
const CODING_LAND_FILE_TOO_LARGE = phrase(
	"The change was not saved: it holds a file that is too large for Qorpera to keep. The agent has been told to take it out and try again.",
);

function codingNamesReason(code: string | undefined): string | undefined {
	switch (code) {
		case "CODE_HOST_NAMES_FOLDER_REFUSES":
		case "CODE_HOST_NAMES_NOT_UTF8":
		case "CODE_HOST_NAMES_NOT_NFC":
		case "CODE_HOST_NAMES_DIFFER_BY_CASE":
			return CODING_NAMES_REFUSED;
		case "CODE_HOST_FILE_TOO_LARGE":
			return CODING_FILE_TOO_LARGE;
		case "CODING_LAND_NAMES_REFUSED":
			return CODING_LAND_NAMES_REFUSED;
		case "CODING_LAND_FILE_TOO_LARGE":
			return CODING_LAND_FILE_TOO_LARGE;
	}
	return undefined;
}

/** What the kernel tells about a coding turn that stopped at its login's usage limit (20260929993000). */
export interface CodingUsageLimit {
	usageLimit?: boolean;
	paidByChatgptPlan?: boolean;
	/** The member reading it owns the session, so the plan (the login that pays) is theirs. */
	mine?: boolean;
}

/** Why a coding session's turn failed, in the member's words, and that its
 * workspace is kept. The reason is the kernel's "executor-lease-expired" or the
 * executor's summary, which carries the run's last error and its fixed code;
 * both name machinery, so neither is ever shown as it is. A turn the kernel says
 * stopped at a usage limit is told as one, in OpenAI's words for the owner's plan;
 * a change that did not go in for its checks says only that it was not saved, a
 * session whose workspace was refused for its files only that it could not start,
 * and a landing refused for them only that the change was not saved. */
export function codingFailureReason(reason: string | undefined, limit: CodingUsageLimit = {}, code?: string): string {
	if (limit.usageLimit === true)
		return limit.paidByChatgptPlan === true && limit.mine === true
			? `${planUsageLimitReason()} ${t("The workspace is kept; a follow-up continues it.")}`
			: t(CODING_REASONS.usage_limit);
	// The run failed with the model provider's outage (20260930560000): ChatGPT's, usually brief; the login is fine.
	if (code === "provider_outage") return t(CODING_PROVIDER_OUTAGE);
	// The change's checks failed or could not run (step 3): the code decides, before any word of the summary is read,
	// since the summary holds the check's output. A summary that still ends with its code reads the same (the code read
	// as 20260930721000's qorpera_coding_turn_failure reads it).
	const checks =
		codingChecksReason(code) ?? codingChecksReason(reason?.match(/\[code=(CODING_CHECKS_[A-Z_]{1,40})\]\s*$/)?.[1]);
	if (checks) return t(checks);
	// The session's workspace was refused for its files' names or a file's size (part N's codes), or a landing was
	// (20260930743000's codes): the same way.
	const names =
		codingNamesReason(code) ??
		codingNamesReason(reason?.match(/\[code=((?:CODE_HOST|CODING_LAND)_[A-Z0-9_]{1,40})\]\s*$/)?.[1]);
	if (names) return t(names);
	// Since 20260930560000 a failed run's summary is plain words and its code travels apart (the failed event's `code`,
	// 20260930551000): the code alone decides, as it did inside the executor's summary, and a code no class names is a
	// step refused on Qorpera's side, as the bridge's text said. Lower-case reasons (turn_failed, stopped, ...) name no
	// code, and a summary that still carries its own code (from before 20260930560000) keeps it.
	const byCode =
		code !== undefined && /^[A-Z0-9_]{1,42}(?::[A-Z0-9_]{1,42})?$/.test(code) && !reason?.includes("[code=");
	if (byCode) reason = ` [code=${code}]`;
	if (reason === "executor-lease-expired") return t(CODING_REASONS.lost);
	if (reason === CODING_TURN_ENDED || reason?.includes("[code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]"))
		return t(CODING_REASONS.no_submission);
	const classified = classifyRunFailure(reason, reason === CODING_TURN_STOPPED ? "cancelled" : "failed");
	const kind = byCode && classified === "other" ? "bridge" : classified;
	return t((limit.mine === true ? undefined : CODING_REASONS_FOR_OTHERS[kind]) ?? CODING_REASONS[kind]);
}

/** Whether the run was interrupted rather than refused: Qorpera lost contact with
 * it, a step got no answer in time or lost its connection, it was stopped for time,
 * cancelled, never got a computer, or the agent finished its turn without sending its
 * answer. Those are worth trying again as they are.
 * A reached usage limit, a disconnected account, a login ChatGPT refused or that
 * could not be loaded, or a company out of computer hours need someone to act
 * first, so their card offers Dismiss only and says what to do.
 * A refused completion keeps the Try again it had when it read as lost contact: the
 * card still hides it while the run's save is unsettled (canRetryFailedRun), and
 * its reason says a person checks that save first. */
export function runFailureInterrupted(
	lastError: string | undefined,
	jobStatus: "failed" | "cancelled",
	usageLimit?: boolean,
	rateLimited?: boolean,
): boolean {
	const kind = classifyRunFailure(lastError, jobStatus, usageLimit, rateLimited);
	return (
		kind === "lost" ||
		kind === "rate_limited" ||
		kind === "completion_refused" ||
		kind === "step_timeout" ||
		kind === "connection" ||
		kind === "timeout" ||
		kind === "dispatch" ||
		kind === "no_reply" ||
		kind === "cancelled"
	);
}

export interface RunFailureCard {
	/** Who did not answer, e.g. "Yang Tang did not finish this run". */
	title: string;
	reason?: string;
	/** Absent when this run cannot be tried again (or the cloud cannot do it yet). */
	retry?: () => void;
	retrying?: boolean;
	/** What went wrong with the last Try again. */
	retryError?: string;
	/** Absent for a run that waits rather than failed: there is nothing to dismiss. */
	dismiss?: () => void;
	/** A link that replaces Try again, e.g. "Review" for a run that left a proposal. */
	action?: HTMLElement;
	/** A run that stopped at its usage limit, for the member whose own login paid: their other logins that can pay now,
	 * each a "Continue with …" button. Nothing goes on until they pick one. */
	continueWith?: RunFailureContinue;
}

export interface RunFailureContinue {
	logins: readonly { connectionId: string; account: string }[];
	choose: (connectionId: string) => void;
	/** The login being continued with now. */
	continuing?: string;
	/** No pick now: a read of the logins or a message is on its way. */
	waiting?: boolean;
	/** What the last pick left to say: that it failed, or that the member's own message continues the work. */
	note?: string;
}

/** A failed run, shown as one quiet line right above the composer, in the same
 * band and shape as a company notice, with Dismiss and, for an interrupted run,
 * Try again. Dismissing is durable: the run stops counting against the agent. A run
 * waiting at its login's usage limit takes the same line with no Dismiss. */
export function runFailureCard(card: RunFailureCard): HTMLElement {
	const busy = card.retrying === true;
	const guarded = (action: () => void) => (event: MouseEvent) => {
		if (!busy && event.detail < 2) action();
	};
	const primary =
		card.action ??
		(card.retry
			? button(
					busy ? t("Trying again…") : t("Try again"),
					guarded(() => card.retry?.()),
					{ small: true },
				)
			: null);
	if (primary instanceof HTMLButtonElement && !card.action) {
		primary.classList.add("run-failure-primary");
		primary.dataset.action = "retry-run";
		if (busy) primary.setAttribute("aria-disabled", "true");
	}
	const onDismiss = card.dismiss;
	const dismiss = onDismiss ? button(t("Dismiss"), guarded(onDismiss), { small: true }) : null;
	if (dismiss) {
		dismiss.classList.add("run-failure-secondary");
		dismiss.dataset.action = "dismiss-run";
		if (busy) dismiss.setAttribute("aria-disabled", "true");
	}
	const offer = card.continueWith;
	const held = offer !== undefined && (offer.continuing !== undefined || offer.waiting === true);
	const logins = (offer?.logins ?? []).map((login) => {
		const choose = button(
			offer?.continuing === login.connectionId
				? t("Continuing…")
				: t("Continue with {account}", { account: login.account }),
			(event: MouseEvent) => {
				if (!held && event.detail < 2) offer?.choose(login.connectionId);
			},
			{ small: true },
		);
		choose.classList.add("run-failure-continue");
		choose.dataset.action = "continue-run";
		choose.dataset.connectionId = login.connectionId;
		if (held) choose.setAttribute("aria-disabled", "true");
		return choose;
	});
	return h(
		"div",
		{
			class: "run-failure",
			role: "group",
			"aria-label": card.title,
			onkeydown: (event: KeyboardEvent) => {
				if (!onDismiss || !matchesKey(event, "dismiss")) return;
				event.preventDefault();
				event.stopPropagation();
				if (!busy) onDismiss();
			},
		},
		h(
			"div",
			{ class: logins.length ? "run-failure-card has-logins" : "run-failure-card" },
			h(
				"p",
				{ class: "run-failure-text" },
				h("strong", { class: "run-failure-title", role: "alert" }, card.title),
				card.reason ? " " : null,
				card.reason ? h("span", { class: "run-failure-reason" }, card.reason) : null,
				card.retryError ? " " : null,
				card.retryError ? h("span", { class: "run-failure-error", role: "alert" }, card.retryError) : null,
				offer?.note ? " " : null,
				offer?.note ? h("span", { class: "run-failure-note", role: "status" }, offer.note) : null,
			),
			h("div", { class: "run-failure-actions" }, primary, ...logins, dismiss),
		),
	);
}
