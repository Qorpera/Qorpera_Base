import type { ActionReviewAnswer, ActionReviewCard } from "../cloud/review-rules.ts";
import type { JsonValue } from "../cloud/types.ts";
import { badge, fmtTime, h, icon } from "./dom.ts";
import { phrase, t } from "./preferences.ts";

/** A runner custom entry keeps its facts under `entry.data`; older desktop bodies keep them at the top. */
export function authorizationData(body: JsonValue): Record<string, JsonValue> {
	if (!body || typeof body !== "object" || Array.isArray(body)) return {};
	const entry = body.entry;
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		const data = entry.data;
		if (data && typeof data === "object" && !Array.isArray(data)) return data;
	}
	return body;
}

export function authorizationRequestId(body: JsonValue): string | undefined {
	const data = authorizationData(body);
	for (const key of ["requestEventId", "request_event_id", "requestId", "request_id", "authorizationRequestId"]) {
		const value = data[key];
		if (typeof value === "string" && value) return value.toLowerCase();
	}
	return undefined;
}

export function renderAuthorizationCard(
	kind: "authorization_request" | "authorization_decision",
	body: JsonValue,
	createdAt: string,
	actor: string,
	resolution?: JsonValue,
	/** Records the decision through the thread (kernel v70); absent while this member may not decide. */
	onDecide?: (decision: "approved" | "declined") => void,
): HTMLElement {
	const data = authorizationData(body);
	const resolved = resolution === undefined ? data : authorizationData(resolution);
	const isDecision = kind === "authorization_decision" || resolution !== undefined;
	const decision = typeof resolved.decision === "string" ? resolved.decision.toLowerCase() : "";
	const approved = decision === "approved" || decision === "approve";
	const declined = ["denied", "rejected", "declined", "deny", "reject"].includes(decision);
	const label = !isDecision
		? t("Awaiting decision")
		: approved
			? t("Approved")
			: declined
				? t("Declined")
				: t("Decision recorded");
	const title =
		typeof data.title === "string" && data.title.trim()
			? data.title
			: typeof data.operation === "string"
				? data.operation.replaceAll(/[-_]/g, " ")
				: kind === "authorization_request"
					? t("Approval requested")
					: t("Authorization decision");
	const summary =
		typeof data.summary === "string"
			? data.summary
			: typeof data.description === "string"
				? data.description
				: undefined;
	const details = Object.entries(data);
	return h(
		"article",
		{
			class: `auth-card ${kind}`,
			"data-decision-state": !isDecision ? "pending" : approved ? "approved" : declined ? "declined" : "recorded",
		},
		h(
			"header",
			{ class: "decision-heading" },
			icon(approved && isDecision ? "check" : "info"),
			h("span", null, t("Approval")),
			badge(label, !isDecision ? "warn" : approved ? "ok" : "neutral"),
		),
		h("h3", null, title),
		summary ? h("p", null, summary) : null,
		h(
			"dl",
			{ class: "decision-facts" },
			...(
				[
					["to", phrase("Recipient")],
					["path", phrase("File")],
					["amount", phrase("Amount")],
					["currency", phrase("Currency")],
					["reason", phrase("Reason")],
				] as const
			).flatMap(([key, label]) =>
				typeof data[key] === "string" || typeof data[key] === "number"
					? [h("dt", null, t(label)), h("dd", null, String(data[key]))]
					: [],
			),
		),
		h("p", { class: "decision-attribution" }, `${actor} · ${fmtTime(createdAt)}`),
		!isDecision
			? h(
					"div",
					{ class: "decision-actions" },
					onDecide ? null : h("p", null, t("Only an owner or admin of this company can decide.")),
					h(
						"button",
						{ type: "button", class: "btn", disabled: !onDecide, onclick: () => onDecide?.("declined") },
						t("Decline"),
					),
					h(
						"button",
						{
							type: "button",
							class: "btn btn-primary",
							disabled: !onDecide,
							onclick: () => onDecide?.("approved"),
						},
						t("Approve"),
					),
				)
			: null,
		details.length
			? h(
					"details",
					{ class: "decision-details" },
					h("summary", null, t("Event details")),
					h(
						"dl",
						{ class: "kv" },
						...details.flatMap(([key, value]) => [
							h("dt", null, key),
							h(
								"dd",
								null,
								value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value),
							),
						]),
					),
				)
			: h("p", { class: "muted" }, t("No details provided.")),
	);
}

const BUILT_IN_LABELS = new Map<string, string>([
	["money", phrase("It moves money.")],
	["legal_terms", phrase("It accepts terms or signs for the company.")],
	["delete_outside", phrase("It deletes data outside Qorpera.")],
	["access_change", phrase("It changes who can access something.")],
	["not_requested", phrase("It does not match what was asked.")],
	["unavailable", phrase("The safety check could not run.")],
]);

/** The Always allow editor of one card, kept by the thread across re-renders. */
export interface ActionReviewDraft {
	open: boolean;
	text: string;
	focused: boolean;
}

/**
 * An approval card of an agent's action (auto-review, kernel bundle v115): what
 * the agent wants to do, why it waits, and the exact call. The member it waits
 * for answers Allow once, Deny, or, on a built-in check's card, Always allow
 * with the proposed rule (editable) saved for the company. Everyone else sees
 * who it waits for.
 */
export function renderActionReviewCard(
	card: ActionReviewCard,
	createdAt: string,
	resolution: JsonValue | undefined,
	options: {
		/** Present only while this member may answer the card. */
		answer?: (answer: ActionReviewAnswer, ruleText?: string) => void;
		memberName: (userId: string) => string;
		/** An earlier answer never reached the agent: the card is open again. */
		answerFailed?: boolean;
		draft?: ActionReviewDraft;
		onDraft?: (draft: ActionReviewDraft) => void;
	},
): HTMLElement {
	const resolved = resolution === undefined ? undefined : authorizationData(resolution);
	const decision = typeof resolved?.decision === "string" ? resolved.decision : "";
	const exact =
		resolved?.answer && typeof resolved.answer === "object" && !Array.isArray(resolved.answer)
			? resolved.answer.answer
			: undefined;
	const answeredBy = typeof resolved?.answeredBy === "string" ? options.memberName(resolved.answeredBy) : "";
	const state = !resolved ? "pending" : decision === "approved" ? "approved" : "declined";
	const waitingFor =
		card.approverScope === "member"
			? t("Waiting for {name} to approve.", { name: card.approverName || t("the member") })
			: t("Waiting for an owner or admin to approve.");
	const rule = (item: ActionReviewCard["rules"][number]) =>
		h(
			"li",
			null,
			item.scope === "company"
				? t("Company rule: {rule}", { rule: item.when })
				: t("Personal rule: {rule}", { rule: item.when }),
		);
	const builtIn = BUILT_IN_LABELS.get(card.builtIn);
	const editorId = `review-always-${card.reviewId}`;
	const ruleInput = h("input", {
		type: "text",
		class: "review-rule-input",
		maxLength: 280,
		value: options.draft?.text ?? card.proposedRule ?? "",
		"data-review-rule": card.reviewId,
		"aria-label": t("Always allow when an agent wants to"),
	}) as HTMLInputElement;
	const draft = (patch: Partial<ActionReviewDraft>) =>
		options.onDraft?.({
			open: options.draft?.open ?? false,
			text: ruleInput.value,
			focused: document.activeElement === ruleInput,
			...patch,
		});
	const saveRule = () => {
		const text = ruleInput.value.trim();
		if (text) options.answer?.("always_allow", text);
		else ruleInput.focus();
	};
	ruleInput.oninput = () => draft({ open: true, text: ruleInput.value });
	ruleInput.onfocus = () => draft({ open: true, focused: true });
	ruleInput.onblur = () => draft({ open: true, focused: false });
	ruleInput.onkeydown = (event: KeyboardEvent) => {
		if (event.key === "Enter" && !event.isComposing) {
			event.preventDefault();
			saveRule();
		}
	};
	const always = h(
		"div",
		{ class: "review-always", id: editorId, hidden: !options.draft?.open },
		h("label", null, t("Always allow when an agent wants to"), ruleInput),
		h(
			"div",
			{ class: "decision-actions" },
			h("button", { type: "button", class: "btn btn-primary", onclick: saveRule }, t("Save rule and allow")),
		),
	);
	return h(
		"article",
		{
			class: "auth-card action-review-card",
			"data-decision-state": state,
			"data-review-id": card.reviewId,
			tabindex: "-1",
		},
		h(
			"header",
			{ class: "decision-heading" },
			icon(state === "approved" ? "check" : "lock"),
			h("span", null, t("Approval")),
			badge(
				state === "pending" ? t("Waiting") : state === "approved" ? t("Allowed") : t("Declined"),
				state === "pending" ? "warn" : state === "approved" ? "ok" : "neutral",
			),
		),
		h("h3", null, card.title || t("Approval requested")),
		card.target ? h("p", { class: "review-target" }, card.target) : null,
		card.summary ? h("p", null, card.summary) : null,
		card.rules.length || builtIn
			? h("ul", { class: "review-reasons" }, ...card.rules.map(rule), builtIn ? h("li", null, t(builtIn)) : null)
			: null,
		card.details.length
			? h(
					"dl",
					{ class: "decision-facts" },
					...card.details.flatMap(([key, value]) => [h("dt", null, key), h("dd", null, value)]),
				)
			: null,
		card.tool
			? h(
					"details",
					{ class: "decision-details" },
					h("summary", null, t("Exact action")),
					h("pre", { class: "review-call" }, `${card.tool}(${card.arguments ?? ""})`),
				)
			: null,
		h("p", { class: "decision-attribution" }, fmtTime(createdAt)),
		state === "pending" && options.answerFailed
			? h("p", { class: "review-failed" }, t("That answer did not reach the agent. Answer again."))
			: null,
		state === "pending"
			? options.answer
				? h(
						"div",
						{ class: "review-answer" },
						h(
							"div",
							{ class: "decision-actions" },
							h("button", { type: "button", class: "btn", onclick: () => options.answer?.("deny") }, t("Deny")),
							card.alwaysAllow
								? h(
										"button",
										{
											type: "button",
											class: "btn",
											"aria-expanded": String(Boolean(options.draft?.open)),
											"aria-controls": editorId,
											onclick: (event: MouseEvent) => {
												always.hidden = false;
												(event.currentTarget as HTMLElement).setAttribute("aria-expanded", "true");
												draft({ open: true });
												ruleInput.focus();
											},
										},
										t("Always allow…"),
									)
								: null,
							h(
								"button",
								{ type: "button", class: "btn btn-primary", onclick: () => options.answer?.("allow_once") },
								t("Allow once"),
							),
						),
						card.alwaysAllow ? always : null,
					)
				: h("p", { class: "review-waiting muted" }, waitingFor)
			: h(
					"p",
					{ class: "review-outcome muted" },
					state === "approved"
						? exact === "always_allow"
							? t("Always allowed by {name}.", { name: answeredBy || t("a member") })
							: t("Allowed once by {name}.", { name: answeredBy || t("a member") })
						: t("Declined by {name}.", { name: answeredBy || t("a member") }),
				),
	);
}
