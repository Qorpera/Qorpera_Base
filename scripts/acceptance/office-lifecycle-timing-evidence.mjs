export const OFFICE_RESET_TIMING_SCHEMA = "qorpera.office-acceptance-reset-timing/v1";
export const OFFICE_RESET_TIMING_STAGES = [
	"physical_check", "physical_inspect", "guest_instance", "guest_boot_read", "guest_read",
	"typed_inspection", "reset_control_submit", "reset_control_poll", "package_staging", "package_measurement",
	"package_probe", "package_invocation", "package_observation", "package_preflight", "package_install", "package_tool",
	"package_poll", "package_file_read", "package_file_push", "package_directory", "package_receipt",
	"reset_status", "successor_check", "successor_status", "successor_activate", "package_challenge", "package_ack",
];
const stages = new Set(OFFICE_RESET_TIMING_STAGES);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 600000;
const object = value => value && typeof value === "object" && !Array.isArray(value);

/** Reproject every field after process transport. Timing is diagnostic only;
 * no request, file path, capability, result or error text is retained. */
export function projectOfficeResetTiming(value) {
	if (!object(value) || value.schema !== OFFICE_RESET_TIMING_SCHEMA || !integer(value.attempt) || value.attempt < 1
		|| !integer(value.elapsedMs) || !integer(value.total) || !integer(value.omitted) || !integer(value.pendingAtSettlement)
		|| !["fulfilled", "rejected"].includes(value.outcome) || typeof value.parentAborted !== "boolean"
		|| !Array.isArray(value.records) || value.records.length > 96 || value.total !== value.records.length + value.omitted) return null;
	const records = [];
	for (const row of value.records) {
		if (!object(row) || !stages.has(row.stage) || !integer(row.atMs) || !integer(row.elapsedMs)
			|| !["fulfilled", "rejected"].includes(row.outcome)
			|| typeof row.parentAborted !== "boolean" || !(row.operationAborted === null || typeof row.operationAborted === "boolean")
			|| !(row.physicalAborted === null || typeof row.physicalAborted === "boolean")
			|| !(row.physicalLease === null || (integer(row.physicalLease) && row.physicalLease >= 1))
			|| !(row.physicalRemainingMs === null || (integer(row.physicalRemainingMs) && row.physicalRemainingMs <= 5000))) return null;
		records.push({ stage: row.stage, atMs: row.atMs, elapsedMs: row.elapsedMs, outcome: row.outcome,
			parentAborted: row.parentAborted, operationAborted: row.operationAborted, physicalAborted: row.physicalAborted,
			physicalLease: row.physicalLease, physicalRemainingMs: row.physicalRemainingMs });
	}
	return { schema: OFFICE_RESET_TIMING_SCHEMA, attempt: value.attempt, elapsedMs: value.elapsedMs, outcome: value.outcome,
		parentAborted: value.parentAborted, total: value.total, omitted: value.omitted, pendingAtSettlement: value.pendingAtSettlement, records };
}

/** Reset-only first/recent retention is independent of lifecycle observations.
 * Earlier admission chatter and a long reset retry history cannot erase both
 * the first attempt and the most recent attempted boundary. */
export function officeResetTimingHistory() {
	const first = [], recent = []; let total = 0, rejected = 0;
	return {
		accept(value) {
			if (!object(value) || value.schema !== OFFICE_RESET_TIMING_SCHEMA) return false;
			const projected = projectOfficeResetTiming(value);
			if (!projected) { rejected++; return true; }
			total++;
			if (first.length < 2) first.push(projected);
			else { if (recent.length === 12) recent.shift(); recent.push(projected); }
			return true;
		},
		snapshot: () => ({ schema: "qorpera.office-acceptance-reset-timing-history/v1", total, rejected,
			omitted: total - first.length - recent.length, first: structuredClone(first), recent: structuredClone(recent),
			clock: "provider-process-monotonic-relative", uninstrumented: ["provider-private-material-validation", "nas-and-archive-validation"],
			signals: "states observed at stage settlement, not the cause of failure; the latest inspect at entry is pinned per call, physical check has no association",
			stageMeaning: "package tool mode stages measure LXD submission, not guest execution; polling and package_measurement include execution waits; rows can be omitted, and guest loader/CPU costs are not measured",
			physicalRemaining: "conservative time from physical inspect entry; original signal is independently observed" }),
	};
}
