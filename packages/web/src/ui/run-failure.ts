import { button, h } from "./dom.ts";
import { matchesKey } from "./keys.ts";

/** Why a run stopped, in the member's words. The cloud's own text stays
 * out of the card: it names machinery, not causes. */
export function runFailureReason(lastError: string | undefined, jobStatus: "failed" | "cancelled"): string {
	const error = lastError ?? "";
	if (/usage limit|quota|rate.?limit|insufficient|billing/i.test(error))
		return "Your model account has reached its usage limit.";
	if (/not signed in|sign.?in|unauthori[sz]ed|credential|token (is )?(expired|invalid)/i.test(error))
		return "Your model account needs to be connected again.";
	if (/dispatch failed|provider request failed/i.test(error))
		return "No computer could be started for this run. The problem is on Qorpera's side.";
	if (/lease expired|deadline|timed? ?out/i.test(error)) return "The run took too long and was stopped.";
	if (/bridge request failed/i.test(error))
		return "The run started, but one of its steps was refused. The problem is on Qorpera's side.";
	if (jobStatus === "cancelled") return "The run was stopped before it finished.";
	return "The run stopped because of an internal error.";
}

/** Whether the run was interrupted rather than refused: it was stopped for time,
 * cancelled, or never got a computer. Those are worth trying again as they are.
 * A reached usage limit or a disconnected account need the member to act first,
 * so their card offers Dismiss only and says what to do. */
export function runFailureInterrupted(lastError: string | undefined, jobStatus: "failed" | "cancelled"): boolean {
	const error = lastError ?? "";
	if (jobStatus === "cancelled") return true;
	if (/usage limit|quota|rate.?limit|insufficient|billing/i.test(error)) return false;
	if (/not signed in|sign.?in|unauthori[sz]ed|credential|token (is )?(expired|invalid)/i.test(error)) return false;
	return /lease expired|deadline|timed? ?out|dispatch failed|provider request failed/i.test(error);
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

/** A failed run, shown where its answer would have been: one quiet line in the
 * thread, like a company notice, with Dismiss and, for an interrupted run, Try
 * again. Dismissing is durable: the run stops counting against the agent. */
export function runFailureCard(card: RunFailureCard): HTMLElement {
	const busy = card.retrying === true;
	const guarded = (action: () => void) => (event: MouseEvent) => {
		if (!busy && event.detail < 2) action();
	};
	const primary =
		card.action ??
		(card.retry
			? button(
					busy ? "Trying again…" : "Try again",
					guarded(() => card.retry?.()),
					{ small: true },
				)
			: null);
	if (primary instanceof HTMLButtonElement && !card.action) {
		primary.classList.add("run-failure-primary");
		primary.dataset.action = "retry-run";
		if (busy) primary.setAttribute("aria-disabled", "true");
	}
	const dismiss = button("Dismiss", guarded(card.dismiss), { small: true });
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
