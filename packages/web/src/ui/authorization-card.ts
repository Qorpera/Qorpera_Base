import type { JsonValue } from "../cloud/types.ts";
import { badge, fmtTime, h, icon } from "./dom.ts";
import { t } from "./preferences.ts";

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
					["to", "Recipient"],
					["path", "File"],
					["amount", "Amount"],
					["currency", "Currency"],
					["reason", "Reason"],
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
