import type { JsonValue } from "../cloud/types.ts";
import { badge, fmtTime, h, icon } from "./dom.ts";

export function authorizationRequestId(body: JsonValue): string | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	for (const key of ["requestEventId", "request_event_id", "requestId", "request_id", "authorizationRequestId"]) {
		const value = body[key];
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
): HTMLElement {
	const data = body && typeof body === "object" && !Array.isArray(body) ? body : {};
	const resolved = resolution && typeof resolution === "object" && !Array.isArray(resolution) ? resolution : data;
	const isDecision = kind === "authorization_decision" || resolution !== undefined;
	const decision = typeof resolved.decision === "string" ? resolved.decision.toLowerCase() : "";
	const approved = decision === "approved" || decision === "approve";
	const declined = ["denied", "rejected", "declined", "deny", "reject"].includes(decision);
	const label = !isDecision
		? "Awaiting decision"
		: approved
			? "Approved"
			: declined
				? "Declined"
				: "Decision recorded";
	const title =
		typeof data.title === "string" && data.title.trim()
			? data.title
			: typeof data.operation === "string"
				? data.operation.replaceAll(/[-_]/g, " ")
				: kind === "authorization_request"
					? "Approval requested"
					: "Authorization decision";
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
			h("span", null, "Approval"),
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
					? [h("dt", null, label), h("dd", null, String(data[key]))]
					: [],
			),
		),
		h("p", { class: "decision-attribution" }, `${actor} · ${fmtTime(createdAt)}`),
		!isDecision
			? h(
					"div",
					{ class: "decision-actions" },
					h("p", null, "Decisions are not available from this client yet."),
					h("button", { type: "button", class: "btn", disabled: true }, "Decline"),
					h("button", { type: "button", class: "btn btn-primary", disabled: true }, "Approve"),
				)
			: null,
		details.length
			? h(
					"details",
					{ class: "decision-details" },
					h("summary", null, "Event details"),
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
			: h("p", { class: "muted" }, "No details provided."),
	);
}
