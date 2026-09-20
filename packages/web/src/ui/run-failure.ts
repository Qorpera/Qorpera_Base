import { h, icon } from "./dom.ts";
import { matchesKey } from "./keys.ts";

/** Why a run stopped, in the member's words. The cloud's own text stays
 * available under "Technical details"; it names machinery, not causes. */
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

export interface RunFailureCard {
	/** Who did not answer, e.g. "Yang Tang did not finish this run". */
	title: string;
	reason?: string;
	/** The cloud's own error text, shown collapsed. */
	details?: string;
	/** Absent when this run cannot be tried again (or the cloud cannot do it yet). */
	retry?: () => void;
	retrying?: boolean;
	/** What went wrong with the last Try again. */
	retryError?: string;
	dismiss: () => void;
	/** A link that replaces Try again, e.g. "Review" for a run that left a proposal. */
	action?: HTMLElement;
}

/** A failed run, shown where its answer would have been: one centred card with one
 * action. Dismissing is the quiet cross in the corner (and Escape), not a second button. */
export function runFailureCard(card: RunFailureCard): HTMLElement {
	const busy = card.retrying === true;
	const guarded = (action: () => void) => (event: MouseEvent) => {
		if (!busy && event.detail < 2) action();
	};
	const primary =
		card.action ??
		(card.retry
			? h(
					"button",
					{
						type: "button",
						class: "run-failure-primary",
						"data-action": "retry-run",
						"aria-disabled": busy ? "true" : undefined,
						onclick: guarded(() => card.retry?.()),
					},
					busy ? "Trying again…" : "Try again",
				)
			: null);
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
				"button",
				{
					type: "button",
					class: "run-failure-close",
					"aria-label": "Dismiss",
					title: "Dismiss",
					"data-action": "dismiss-run",
					"aria-disabled": busy ? "true" : undefined,
					onclick: guarded(card.dismiss),
				},
				icon("close"),
			),
			h("span", { class: "run-failure-mark", "aria-hidden": "true" }, icon("close")),
			h("strong", { class: "run-failure-title", role: "alert" }, card.title),
			card.reason ? h("p", { class: "run-failure-reason" }, card.reason) : null,
			card.retryError ? h("p", { class: "run-failure-error", role: "alert" }, card.retryError) : null,
			primary ? h("span", { class: "run-failure-rule", "aria-hidden": "true" }) : null,
			primary,
			card.details
				? h(
						"details",
						{ class: "run-failure-details" },
						h("summary", {}, "Technical details"),
						h("code", {}, card.details),
					)
				: null,
		),
	);
}
