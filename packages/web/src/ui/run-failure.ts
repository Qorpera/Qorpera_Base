import { button, h } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { phrase, t } from "./preferences.ts";

/** What stopped the run, from the cloud's own error text (which names machinery,
 * not causes) and the job status. One classification feeds both the sentence the
 * member reads and whether Try again is worth offering. */
export type RunFailureKind =
	| "computer_hours"
	| "usage_limit"
	| "credential"
	| "dispatch"
	| "completion_refused"
	| "lost"
	| "step_timeout"
	| "timeout"
	| "bridge"
	| "cancelled"
	| "other";

export function classifyRunFailure(
	lastError: string | undefined,
	jobStatus: "failed" | "cancelled",
	usageLimit?: boolean,
): RunFailureKind {
	// The company ran out of computer hours and its hour to finish running work ended: the one
	// code that decides the class, since it names the company's hours, not Qorpera's machinery.
	if ((lastError ?? "").includes("[code=COMPUTER_HOURS_EXHAUSTED]")) return "computer_hours";
	// The cloud recorded a usage-limit signal for this run: the bridge's refusal it was saved with names only
	// a spent budget, which a full context window shares. When the cloud says (true or false), it decides;
	// only an older cloud, which says nothing, leaves it to the error text below.
	if (usageLimit === true) return "usage_limit";
	// The run ended, but the cloud refused its completion because work was left unsettled, such as a save whose outcome
	// is unknown (30 October 2026). The runner fails it at once with this code; it used to go silent and read as lost
	// contact minutes later.
	if ((lastError ?? "").includes("[code=RUN_COMPLETION_REFUSED]")) return "completion_refused";
	// Any other refused step carries the provider's fixed code (e.g. "[code=NATIVE_CREDENTIAL_SEALING:STORAGE_BUDGET]").
	// It names Qorpera's own machinery, not a member's account, so its words never decide the class: the step stays
	// "bridge", as it was before the code. Only its category can: a step that ran out of time
	// ("[code=NATIVE_PROMPT_COMPOSITION:TIMEOUT]") took too long, it was not refused (Jonas, 21 October 2026).
	const timedOut = / \[code=(?:[A-Z0-9_]{1,42}:)?(?:[A-Z0-9_]{0,41}_)?(?:TIMEOUT|TIMED_OUT)\]/.test(lastError ?? "");
	// A step whose code's category is "cancelled" ("[code=NATIVE_CODEX_TURN_COMPLETION:CANCELLED]") was stopped from
	// Qorpera's side while it ran, e.g. when the run's authority could not be read through a database outage (28
	// October 2026): it was not refused.
	const stepCancelled = / \[code=[A-Z0-9_]{1,42}:CANCELLED\]/.test(lastError ?? "");
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
	credential: phrase("Your model account needs to be connected again."),
	dispatch: phrase("No computer could be started for this run. The problem is on Qorpera's side."),
	// Try again is refused while a save is unsettled, so the member reads that a person checks it first, never that a
	// retry would do.
	completion_refused: phrase(
		"The run ended, but one of its saves did not finish. A person must check it before the run can be tried again.",
	),
	lost: phrase("Qorpera lost contact with this run. The problem is on Qorpera's side."),
	step_timeout: phrase("One of the run's steps got no answer in time. The problem is on Qorpera's side."),
	timeout: phrase("The run took too long and was stopped."),
	bridge: phrase("The run started, but one of its steps was refused. The problem is on Qorpera's side."),
	cancelled: phrase("The run was stopped before it finished."),
	other: phrase("The run stopped because of an internal error."),
};

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

/** Why a run stopped, in the member's words. */
export function runFailureReason(
	lastError: string | undefined,
	jobStatus: "failed" | "cancelled",
	usageLimit?: boolean,
): string {
	return t(REASONS[classifyRunFailure(lastError, jobStatus, usageLimit)]);
}

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
		"The model account paying for this session reached its usage limit. The workspace is kept; a follow-up continues it once the limit resets.",
	),
	credential: phrase(
		"The model account needs to be connected again. The workspace is kept; a follow-up continues it once the account is connected.",
	),
	dispatch: phrase("No computer could be started for the session. The workspace is kept; a follow-up tries again."),
	completion_refused: phrase(
		"One of the session's saves did not finish, and a person must check it first. The workspace is kept; a follow-up continues it after that.",
	),
	lost: phrase("Qorpera lost contact with this session. The workspace is kept; a follow-up starts it again."),
	step_timeout: phrase(
		"One of the session's steps got no answer in time. The workspace is kept; a follow-up continues it.",
	),
	timeout: phrase("The session took too long and was stopped. The workspace is kept; a follow-up continues it."),
	bridge: phrase(
		"Something on Qorpera's side refused one of the session's steps. The workspace is kept; a follow-up continues it.",
	),
	cancelled: phrase("The session was stopped before it finished. The workspace is kept; a follow-up continues it."),
	other: phrase("The session stopped because of an internal error. The workspace is kept; a follow-up continues it."),
};

/** What the kernel tells about a coding turn that stopped at its login's usage limit (20260929993000). */
export interface CodingUsageLimit {
	usageLimit?: boolean;
	paidByChatgptPlan?: boolean;
	/** The member reading it owns the session, so the plan is theirs. */
	mine?: boolean;
}

/** Why a coding session's turn failed, in the member's words, and that its
 * workspace is kept. The reason is the kernel's "executor-lease-expired" or the
 * executor's summary, which carries the run's last error and its fixed code;
 * both name machinery, so neither is ever shown as it is. A turn the kernel says
 * stopped at a usage limit is told as one, in OpenAI's words for the owner's plan. */
export function codingFailureReason(reason: string | undefined, limit: CodingUsageLimit = {}): string {
	if (limit.usageLimit === true)
		return limit.paidByChatgptPlan === true && limit.mine === true
			? `${planUsageLimitReason()} ${t("The workspace is kept; a follow-up continues it.")}`
			: t(CODING_REASONS.usage_limit);
	if (reason === "executor-lease-expired") return t(CODING_REASONS.lost);
	if (reason === CODING_TURN_ENDED || reason?.includes("[code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]"))
		return t(CODING_REASONS.no_submission);
	return t(CODING_REASONS[classifyRunFailure(reason, reason === CODING_TURN_STOPPED ? "cancelled" : "failed")]);
}

/** Whether the run was interrupted rather than refused: Qorpera lost contact with
 * it, a step got no answer in time, it was stopped for time, cancelled, or never
 * got a computer. Those are worth trying again as they are.
 * A reached usage limit, a disconnected account or a company out of computer hours
 * need someone to act first, so their card offers Dismiss only and says what to do.
 * A refused completion keeps the Try again it had when it read as lost contact: the
 * card still hides it while the run's save is unsettled (canRetryFailedRun), and
 * its reason says a person checks that save first. */
export function runFailureInterrupted(
	lastError: string | undefined,
	jobStatus: "failed" | "cancelled",
	usageLimit?: boolean,
): boolean {
	const kind = classifyRunFailure(lastError, jobStatus, usageLimit);
	return (
		kind === "lost" ||
		kind === "completion_refused" ||
		kind === "step_timeout" ||
		kind === "timeout" ||
		kind === "dispatch" ||
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
	dismiss: () => void;
	/** A link that replaces Try again, e.g. "Review" for a run that left a proposal. */
	action?: HTMLElement;
}

/** A failed run, shown as one quiet line right above the composer, in the same
 * band and shape as a company notice, with Dismiss and, for an interrupted run,
 * Try again. Dismissing is durable: the run stops counting against the agent. */
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
	const dismiss = button(t("Dismiss"), guarded(card.dismiss), { small: true });
	dismiss.classList.add("run-failure-secondary");
	dismiss.dataset.action = "dismiss-run";
	if (busy) dismiss.setAttribute("aria-disabled", "true");
	return h(
		"div",
		{
			class: "run-failure",
			role: "group",
			"aria-label": card.title,
			onkeydown: (event: KeyboardEvent) => {
				if (!matchesKey(event, "dismiss")) return;
				event.preventDefault();
				event.stopPropagation();
				if (!busy) card.dismiss();
			},
		},
		h(
			"div",
			{ class: "run-failure-card" },
			h(
				"p",
				{ class: "run-failure-text" },
				h("strong", { class: "run-failure-title", role: "alert" }, card.title),
				card.reason ? " " : null,
				card.reason ? h("span", { class: "run-failure-reason" }, card.reason) : null,
				card.retryError ? " " : null,
				card.retryError ? h("span", { class: "run-failure-error", role: "alert" }, card.retryError) : null,
			),
			h("div", { class: "run-failure-actions" }, primary, dismiss),
		),
	);
}
