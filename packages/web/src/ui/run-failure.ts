import { button, h } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { phrase, t } from "./preferences.ts";

/** What stopped the run, from the cloud's own error text (which names machinery,
 * not causes) and the job status. One classification feeds both the sentence the
 * member reads and whether Try again is worth offering. */
export type RunFailureKind =
	| "usage_limit"
	| "credential"
	| "dispatch"
	| "lost"
	| "step_timeout"
	| "timeout"
	| "bridge"
	| "cancelled"
	| "other";

export function classifyRunFailure(lastError: string | undefined, jobStatus: "failed" | "cancelled"): RunFailureKind {
	// A refused step carries the provider's fixed code (e.g. "[code=NATIVE_CREDENTIAL_SEALING:TIMEOUT]").
	// It names Qorpera's own machinery, not a member's account or a time limit, so it
	// never decides the class: the step stays "bridge", as it was before the code.
	const error = (lastError ?? "").replace(/ \[code=[A-Z0-9_:]{1,85}\]/g, "");
	if (/usage limit|quota|rate.?limit|insufficient|billing/i.test(error)) return "usage_limit";
	if (/not signed in|sign.?in|unauthori[sz]ed|credential|token (is )?(expired|invalid)/i.test(error))
		return "credential";
	if (/dispatch failed|provider request failed|no computer could start/i.test(error)) return "dispatch";
	// A run has no time limit (2026-09-24): a lapsed lease means the computer running it
	// stopped renewing it, from a crash or a lost connection, never that it ran too long.
	if (/lease expired/i.test(error)) return "lost";
	// One request inside the run got no answer in time (the model socket, the secret
	// broker, a cloud call's own request deadline): the run itself was not too long.
	if (/timed? ?out|did not respond/i.test(error)) return "step_timeout";
	// Only runs from before the time limit was removed carry an expired run deadline.
	if (/deadline expired/i.test(error)) return "timeout";
	if (/bridge request failed/i.test(error)) return "bridge";
	if (jobStatus === "cancelled") return "cancelled";
	return "other";
}

const REASONS: Record<RunFailureKind, string> = {
	usage_limit: phrase("Your model account has reached its usage limit."),
	credential: phrase("Your model account needs to be connected again."),
	dispatch: phrase("No computer could be started for this run. The problem is on Qorpera's side."),
	lost: phrase("The computer running this run stopped answering. The problem is on Qorpera's side."),
	step_timeout: phrase("One of the run's steps got no answer in time. The problem is on Qorpera's side."),
	timeout: phrase("The run took too long and was stopped."),
	bridge: phrase("The run started, but one of its steps was refused. The problem is on Qorpera's side."),
	cancelled: phrase("The run was stopped before it finished."),
	other: phrase("The run stopped because of an internal error."),
};

/** Why a run stopped, in the member's words. */
export function runFailureReason(lastError: string | undefined, jobStatus: "failed" | "cancelled"): string {
	return t(REASONS[classifyRunFailure(lastError, jobStatus)]);
}

/** Whether the run was interrupted rather than refused: its computer stopped
 * answering, a step got no answer in time, it was stopped for time, cancelled, or
 * never got a computer. Those are worth trying again as they are.
 * A reached usage limit or a disconnected account need the member to act first,
 * so their card offers Dismiss only and says what to do. */
export function runFailureInterrupted(lastError: string | undefined, jobStatus: "failed" | "cancelled"): boolean {
	const kind = classifyRunFailure(lastError, jobStatus);
	return (
		kind === "lost" || kind === "step_timeout" || kind === "timeout" || kind === "dispatch" || kind === "cancelled"
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
