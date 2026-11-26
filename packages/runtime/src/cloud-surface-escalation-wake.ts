import { isUuidAnyCase } from "@qorpera/contracts";

export const CLOUD_SURFACE_ESCALATION_WAKE_SCHEMA = "qorpera.surface-escalation-wake/v1";

export const SURFACE_ESCALATION_WAKE_PROTOCOL =
	"\n# This run: a Surface session escalated to you\nA Surface session paused, conflicted, or failed and escalated to you (members are not badged on the Surface rail for agent blockers). wake.payload names surfaceTitle, surfaceSlug, sessionTitle, surfaceSessionId, reason (needs_input, failed, or conflict), summary, and question. First decide if you can unblock it yourself from company files, vision, or Identity; if so, call steer_surface_session with surfaceSessionId and concrete direction, and finish silently. Only if the founder genuinely must decide or unblock something external, ask them cleanly in your own voice in this thread (no raw session IDs or internal jargon), and call steer_surface_session once they answer.";

export function isValidSurfaceEscalationWakePayload(
	payloadBody: Record<string, unknown>,
	sourceId: string,
	occurrenceKey: string,
): boolean {
	const allowedKeys = new Set([
		"schema",
		"escalationId",
		"surfaceSessionId",
		"surfaceId",
		"surfaceSlug",
		"surfaceTitle",
		"sessionTitle",
		"reason",
		"summary",
		"question",
		"memberInitiated",
	]);
	for (const key of Object.keys(payloadBody)) {
		if (!allowedKeys.has(key)) return false;
	}
	if (payloadBody.schema !== CLOUD_SURFACE_ESCALATION_WAKE_SCHEMA) return false;
	if (!isUuidAnyCase(payloadBody.escalationId) || payloadBody.escalationId.toLowerCase() !== sourceId.toLowerCase()) {
		return false;
	}
	if (!isUuidAnyCase(payloadBody.surfaceSessionId) || !isUuidAnyCase(payloadBody.surfaceId)) return false;
	if (occurrenceKey.toLowerCase() !== `surface-escalation:${sourceId.toLowerCase()}`) return false;
	if (typeof payloadBody.surfaceSlug !== "string" || !payloadBody.surfaceSlug.trim()) return false;
	if (typeof payloadBody.surfaceTitle !== "string" || typeof payloadBody.sessionTitle !== "string") return false;
	if (payloadBody.reason !== "needs_input" && payloadBody.reason !== "failed" && payloadBody.reason !== "conflict") {
		return false;
	}
	if (
		typeof payloadBody.summary !== "string" ||
		!payloadBody.summary.trim() ||
		typeof payloadBody.memberInitiated !== "boolean"
	)
		return false;
	return true;
}
