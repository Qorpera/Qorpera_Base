import { ACTION_REVIEW_SCHEMA, type ActionReviewAnswer, type ActionReviewCard } from "../cloud/review-rules.ts";
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
		// An approval of an agent's action is answered on its own card; one this client cannot read offers nothing.
		!isDecision && data.schema !== ACTION_REVIEW_SCHEMA
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

/** A Company File path as people say it: "work/old-offer.md" is "Old offer". */
export function readableFileName(path: string): string {
	const base = path.split("/").filter(Boolean).at(-1) ?? path;
	const words = base
		.replace(/\.[a-z0-9]{1,8}$/i, "")
		.replace(/[-_]+/g, " ")
		.trim();
	return words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : base;
}

/** What the agent wants to do, as one plain line. A Company File path never leads: the
 * file is named as people say it. */
function reviewHeadline(card: ActionReviewCard): string {
	if (card.tool === "company_delete" && card.target)
		return t("Delete “{name}”", { name: readableFileName(card.target) });
	return card.title || t("Approval requested");
}

/** Keys whose value is the content itself (what would be said or written). */
const CONTENT_KEYS = new Set(["body", "text", "message", "content", "instructions", "intent"]);
/** Keys whose value names the thing (a subject, a title, a name). */
const NAME_KEYS = new Set(["subject", "title", "name", "displayName"]);

/** The change itself: who or what it reaches, what it is called, and what it says.
 * Paths stay out of view; the exact call is under Technical details. */
function reviewChange(card: ActionReviewCard): HTMLElement | null {
	const fileTool = card.tool?.startsWith("company_") === true;
	const names = card.details.filter(([key]) => NAME_KEYS.has(key));
	const content = card.details.filter(([key]) => CONTENT_KEYS.has(key));
	const other = card.details.filter(
		([key]) => !NAME_KEYS.has(key) && !CONTENT_KEYS.has(key) && key !== "path" && !(fileTool && key === "target"),
	);
	const parts: (HTMLElement | null)[] = [
		card.target && !fileTool ? h("p", { class: "review-target" }, card.target) : null,
		...names.map(([, value]) => h("p", { class: "review-name" }, value)),
		...content.map(([, value]) => h("blockquote", { class: "review-quote" }, value)),
		other.length
			? h(
					"dl",
					{ class: "decision-facts" },
					...other.flatMap(([key, value]) => [h("dt", null, key), h("dd", null, value)]),
				)
			: null,
	];
	return parts.some(Boolean) ? h("div", { class: "review-change" }, ...parts) : null;
}

/** The Always allow editor of one card, kept by the thread across re-renders. */
export interface ActionReviewDraft {
	open: boolean;
	text: string;
}

/**
 * An approval card of an agent's action (auto-review, kernel bundle v130): what
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
		options.onDraft?.({ open: options.draft?.open ?? false, text: ruleInput.value, ...patch });
	const saveRule = () => {
		const text = ruleInput.value.trim();
		if (text) options.answer?.("always_allow", text);
		else ruleInput.focus();
	};
	ruleInput.oninput = () => draft({ open: true, text: ruleInput.value });
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
	const what = reviewHeadline(card);
	// Answered: the card folds to one line that names what was decided.
	if (state !== "pending")
		return h(
			"article",
			{
				class: "auth-card action-review-card is-folded",
				"data-decision-state": state,
				"data-review-id": card.reviewId,
				tabindex: "-1",
			},
			h(
				"span",
				{ class: `review-mark is-${state}`, "aria-hidden": "true" },
				icon(state === "approved" ? "check" : "close"),
			),
			h(
				"p",
				{ class: "review-folded" },
				h(
					"span",
					{ class: "review-outcome" },
					state === "approved"
						? exact === "always_allow"
							? t("Always allowed by {name}.", { name: answeredBy || t("a member") })
							: t("Allowed once by {name}.", { name: answeredBy || t("a member") })
						: t("Declined by {name}.", { name: answeredBy || t("a member") }),
				),
				" ",
				h(
					"span",
					{ class: "review-folded-what" },
					card.target && !card.tool?.startsWith("company_") ? `${what} · ${card.target}` : what,
				),
			),
		);
	const why = [...card.rules.map(rule), builtIn ? h("li", null, t(builtIn)) : null].filter(Boolean);
	return h(
		"article",
		{
			class: "auth-card action-review-card",
			"data-decision-state": state,
			"data-review-id": card.reviewId,
			tabindex: "-1",
		},
		h("h3", { class: "review-headline" }, what),
		reviewChange(card),
		card.summary || why.length
			? h(
					"div",
					{ class: "review-why" },
					card.summary ? h("p", null, card.summary) : null,
					why.length ? h("ul", { class: "review-reasons" }, ...why) : null,
				)
			: null,
		options.answerFailed && options.answer
			? h("p", { class: "review-failed" }, t("That answer did not reach the agent. Answer again."))
			: null,
		options.answer
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
			: h("p", { class: "review-waiting" }, waitingFor),
		h(
			"footer",
			{ class: "review-foot" },
			h("span", { class: "decision-attribution" }, fmtTime(createdAt)),
			card.tool
				? h(
						"details",
						{ class: "review-technical" },
						h("summary", null, t("Technical details")),
						h("pre", { class: "review-call" }, `${card.tool}(${card.arguments ?? ""})`),
					)
				: null,
		),
	);
}
