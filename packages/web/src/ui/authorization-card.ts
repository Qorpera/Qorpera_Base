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
		// Only an extension that starts with a letter: "Møde 10.30" and "2026.09" keep their dots.
		.replace(/\.(?=[a-z])[a-z0-9]{1,8}$/i, "")
		// A dash next to a letter joins words; a date such as 2026-09-28 keeps its own. (No
		// lookbehind: Safari before 16.4 cannot parse one, and the whole app would not load.)
		.replace(/(\p{L})[-_]+|[-_]+(?=\p{L})/gu, (_, letter?: string) => (letter ? `${letter} ` : " "))
		.replace(/_+/g, " ")
		.trim();
	if (!words) return base;
	// "iOS plan" keeps its own capitals; "old offer" starts with one.
	return /^\p{Ll}\p{Lu}/u.test(words) ? words : words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

/** What the agent wants to do, as one plain line. A Company File path never leads: the
 * file is named as people say it. */
function reviewHeadline(card: ActionReviewCard): string {
	if (card.tool === "company_delete" && card.target)
		return t("Delete “{name}”", { name: readableFileName(card.target) });
	return card.title || t("Approval requested");
}

/** Sending an email: the card is the thread's email card (email-draft-card.ts), read-only. */
const EMAIL_TOOLS = new Set(["gmail_send_message", "gmail_send_draft"]);

/** The email exactly as the approval would send it, read from the call the card covers:
 * every recipient and the whole text. The card's short facts (shortened to one line,
 * without Cc) are only the fallback when the call cannot be read. */
function emailFields(card: ActionReviewCard): {
	to: string;
	cc: string;
	bcc: string;
	subject?: string;
	body?: string;
} {
	let input: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(card.arguments ?? "");
		const inner =
			parsed && typeof parsed === "object" && !Array.isArray(parsed) && "input" in parsed ? parsed.input : parsed;
		if (inner && typeof inner === "object" && !Array.isArray(inner)) input = inner as Record<string, unknown>;
	} catch {
		/* The short facts below stand in. */
	}
	const list = (value: unknown) =>
		Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string").join(", ")
			: typeof value === "string"
				? value
				: "";
	const detail = (...keys: string[]) => card.details.find(([key]) => keys.includes(key))?.[1];
	return {
		to: list(input.to) || card.target || "",
		cc: list(input.cc),
		bcc: list(input.bcc),
		subject: typeof input.subject === "string" ? input.subject : detail("subject"),
		body: typeof input.body === "string" ? input.body : detail("body", "text"),
	};
}

/** Detail keys (as cloud-action-review.ts sends them) whose value is the content itself:
 * what would be said, written, asked of a worker or run on the computer. */
const CONTENT_KEYS = new Set(["body", "text", "intent", "task", "command"]);
/** Detail keys whose value names the thing (a subject, a title, a name). */
const NAME_KEYS = new Set(["subject", "title", "name"]);

/** The reviewer's reason as it reads on the card: a Company File path in it is named
 * as people say it, like the headline. */
function reviewReason(card: ActionReviewCard): string {
	if (!card.summary || !card.target || !card.tool?.startsWith("company_")) return card.summary;
	const path = card.target.replace(/^\/+/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (!path) return card.summary;
	const name = `“${readableFileName(card.target)}”`;
	// The path with a leading slash or in its own quotes reads as the one quoted name. A
	// function replacer, so a "$" in the name is never read as a replacement pattern.
	return card.summary.replace(new RegExp(`["'“‘\`]?/?${path}["'”’\`]?`, "g"), () => name);
}

/** The change itself: who or what it reaches, what it is called, and what it says.
 * Paths stay out of view, and the call itself is never shown. */
function reviewChange(card: ActionReviewCard): HTMLElement | null {
	const fileTool = card.tool?.startsWith("company_") === true;
	// A name the target already says (a Drive file's name) is not said twice.
	const names = card.details.filter(([key, value]) => NAME_KEYS.has(key) && value !== card.target);
	const content = card.details.filter(([key]) => CONTENT_KEYS.has(key));
	const other = card.details.filter(([key]) => !NAME_KEYS.has(key) && !CONTENT_KEYS.has(key) && key !== "path");
	const parts: (HTMLElement | null)[] = [
		card.target && !fileTool ? h("p", { class: "review-target" }, card.target) : null,
		...names.map(([, value]) => h("p", { class: "review-name" }, value)),
		...content.map(([key, value]) =>
			h("blockquote", { class: key === "command" ? "review-quote is-command" : "review-quote" }, value),
		),
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
 * the agent wants to do and the change itself, and why it waits. The member it waits
 * for answers Allow once, Deny, or, on a built-in check's card, Always allow
 * with the proposed rule (editable) saved for the company. Everyone else sees
 * who it waits for.
 */
export function renderActionReviewCard(
	card: ActionReviewCard,
	resolution: JsonValue | undefined,
	options: {
		/** Present only while this member may answer the card. */
		answer?: (answer: ActionReviewAnswer, ruleText?: string) => void;
		memberName: (userId: string) => string;
		/** An earlier answer never reached the agent: the card is open again. */
		answerFailed?: boolean;
		draft?: ActionReviewDraft;
		onDraft?: (draft: ActionReviewDraft) => void;
		/** How the change would look, drawn under it while the card waits: a page an agent asks to save (step I10,
		 * app/views/interface-preview.ts). The thread keeps it across re-renders. */
		preview?: HTMLElement;
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
	const reasons =
		card.summary || why.length
			? h(
					"div",
					{ class: "review-why" },
					card.summary ? h("p", null, reviewReason(card)) : null,
					why.length ? h("ul", { class: "review-reasons" }, ...why) : null,
				)
			: null;
	const failed =
		options.answerFailed && options.answer
			? h("p", { class: "review-failed" }, t("That answer did not reach the agent. Answer again."))
			: null;
	const alwaysButton = card.alwaysAllow
		? h(
				"button",
				{
					type: "button",
					class: "btn review-always-open",
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
		: null;
	const deny = (label: string) =>
		h("button", { type: "button", class: "btn", onclick: () => options.answer?.("deny") }, label);
	const allow = (label: string, className: string) =>
		h("button", { type: "button", class: className, onclick: () => options.answer?.("allow_once") }, label);
	// An email the agent wants to send is shown as the email card the thread already has for
	// drafts, read-only: sending it is allowing it.
	if (EMAIL_TOOLS.has(card.tool ?? "")) {
		const email = emailFields(card);
		const row = (label: string, value: string) =>
			h(
				"div",
				{ class: "email-draft-row" },
				h("span", { class: "email-draft-label" }, label),
				h("span", { class: "email-draft-from" }, value),
			);
		return h(
			"article",
			{
				class: "interaction-card email-draft-card action-review-card review-email",
				"data-decision-state": state,
				"data-review-id": card.reviewId,
				tabindex: "-1",
				"aria-label": what,
			},
			h(
				"header",
				{ class: "email-draft-heading" },
				h("h3", null, t("New email")),
				// Whoever cannot answer reads who it waits for below; no second label here.
				options.answer ? h("span", { class: "email-draft-status" }, t("Waiting for you")) : null,
			),
			h(
				"div",
				{ class: "email-draft-panel" },
				email.to ? row(t("To"), email.to) : null,
				email.cc ? row(t("Cc"), email.cc) : null,
				email.bcc ? row(t("Bcc"), email.bcc) : null,
				email.subject ? row(t("Subject"), email.subject) : null,
				email.body ? h("div", { class: "review-email-body" }, email.body) : null,
			),
			reasons,
			failed,
			options.answer
				? h(
						"div",
						{ class: "review-answer" },
						h(
							"div",
							{ class: "email-draft-actions" },
							allow(t("Send email"), "btn email-draft-send"),
							deny(t("Don't send")),
							alwaysButton,
						),
						card.alwaysAllow ? always : null,
					)
				: h("p", { class: "review-waiting" }, waitingFor),
		);
	}
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
		options.preview,
		reasons,
		failed,
		options.answer
			? h(
					"div",
					{ class: "review-answer" },
					h(
						"div",
						{ class: "decision-actions" },
						deny(t("Deny")),
						alwaysButton,
						allow(t("Allow once"), "btn btn-primary"),
					),
					card.alwaysAllow ? always : null,
				)
			: h("p", { class: "review-waiting" }, waitingFor),
	);
}
