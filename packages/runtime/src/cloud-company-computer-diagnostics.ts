const stages = [
	"credentials",
	"configuration",
	"tls",
	"outbox",
	"startup",
	"supervision",
	"service-drain",
	"outbox-drain",
] as const;
export type CompanyComputerLifecycleStage = (typeof stages)[number];

const codes = new Set([
	"UNPRIVILEGED_LINUX_OFFICE_REQUIRED",
	"OFFICE_SYSTEMD_CREDENTIALS_REQUIRED",
	"OFFICE_SERVICE_CREDENTIALS_INVALID",
	"INVALID_OFFICE_STARTUP_IDENTITY",
	"OFFICE_STARTUP_AUTHORITY_EXPIRED",
	"OFFICE_STARTUP_READINESS_UNCONFIRMED",
	"OFFICE_SERVICE_START_FAILED",
	"OFFICE_SERVICE_SUPERVISION_FAILED",
	"OFFICE_SERVICE_LISTENER_FAILED",
	"OFFICE_SERVICE_DRAIN_UNCONFIRMED",
	"OFFICE_SERVICE_ENDED_UNEXPECTEDLY",
	"OFFICE_SERVICE_UNAVAILABLE",
	"OFFICE_SUPERVISOR_RECONCILIATION_FAILED",
	"OFFICE_SUPERVISOR_STATUS_STALE",
	"INVALID_OFFICE_SUPERVISOR_STATE",
	"OFFICE_REGISTRY_UNCONFIRMED",
	"OFFICE_LINUX_GUEST_FAILED",
	"OFFICE_GUEST_FAILED",
	"OFFICE_SHARED_PULSE_FAILED",
	"OFFICE_GUEST_DRAIN_UNCONFIRMED",
	"OFFICE_DESKTOP_EXITED",
	"OFFICE_DESKTOP_DRAIN_UNCONFIRMED",
	"OFFICE_SESSION_DRAIN_UNCONFIRMED",
	"OFFICE_NATIVE_DRAIN_UNCONFIRMED",
	"OFFICE_NATIVE_RELEASE_UNCONFIRMED",
	"SHARED_SURFACE_UNCONFIRMED",
	"PRIVATE_SURFACE_UNCONFIRMED",
	"PRIVATE_SURFACE_AUTHORITY_UNCONFIRMED",
	"PRIVATE_SURFACE_DISPLAY_EXITED",
	"PRIVATE_SURFACE_BROWSER_EXITED",
	"PRIVATE_SURFACE_ENDED",
	"PRIVATE_SURFACE_DRAIN_UNCONFIRMED",
	"SCREEN_OUTBOX_DIRECTORY_UNSAFE",
	"COMPUTER_REQUEST_STOPPED",
	// Inner causes of a supervisor reconciliation failure (privacy transition,
	// screen drain and lifecycle bookkeeping). Constants only, never free text.
	"OFFICE_PHYSICAL_DRAIN_REQUIRED",
	"OFFICE_PRIVACY_CHANGED",
	"OFFICE_PRIVACY_CHALLENGE_CHANGED",
	"OFFICE_PRIVACY_FENCED",
	"OFFICE_PRIVACY_UNAVAILABLE",
	"OFFICE_PRIVACY_UNCONFIRMED",
	"OFFICE_DRAIN_UNCONFIRMED",
	"INVALID_OFFICE_DRAIN_CHALLENGE",
	"OFFICE_SCREEN_DRAINING",
	"OFFICE_GATE_CHANGED",
	"OFFICE_GENERATION_MISMATCH",
	"OFFICE_DESKTOP_START_FAILED",
	"OFFICE_DESKTOP_INVALID_READY",
	"OFFICE_DESKTOP_NOT_READY",
	"OFFICE_DESKTOP_ALREADY_OCCUPIED",
	"OFFICE_SESSION_CLOSED",
	"SCREEN_LIFECYCLE_UNCONFIRMED",
	"SCREEN_LIFECYCLE_TRANSITION_INVALID",
	"SCREEN_LIFECYCLE_NOT_REQUESTED",
	"SCREEN_LIFECYCLE_BINDING_DIFFERS",
	"INVALID_SCREEN_OBSERVATION",
	"INVALID_SCREEN_RECEIPT",
	"PRIVATE_SURFACE_CLOSED",
	"PRIVATE_SURFACE_CHALLENGE_DIFFERS",
	"PRIVATE_SURFACE_PROFILE_DIFFERS",
	"PRIVATE_SURFACE_VIEWER_DIFFERS",
	"PRIVATE_SURFACE_WORKBENCH_NOT_EMPTY",
	"PRIVATE_SURFACE_TMPFS_REQUIRED",
	"PRIVATE_SURFACE_SHARED_PATH",
]);
const categories: Record<string, string> = {
	ENOENT: "filesystem-not-found",
	EACCES: "filesystem-permission",
	EPERM: "filesystem-permission",
	EROFS: "filesystem-read-only",
	ENOSPC: "resource-capacity",
	ENOMEM: "resource-memory",
	EMFILE: "resource-file-descriptors",
	ENFILE: "resource-file-descriptors",
	ECONNRESET: "transport",
	ECONNREFUSED: "transport",
	ETIMEDOUT: "timeout",
	EPIPE: "transport",
};

/** Never invoke error getters, stringifiers or toJSON while preparing a log. */
function data(value: unknown, key: string): unknown {
	try {
		if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

/** Internal cause retention only. The message is never an approved log field. */
export class CompanyComputerLifecycleFailure extends Error {
	readonly stage: CompanyComputerLifecycleStage;
	constructor(stage: CompanyComputerLifecycleStage, cause: unknown) {
		const message = data(cause, "message");
		super(typeof message === "string" ? message : "OFFICE_LIFECYCLE_FAILED", { cause });
		this.stage = stage;
	}
}

/** Closed, bounded projection. No stack, raw message, identifiers, paths or hashes. */
export function companyComputerFailureDiagnostic(error: unknown): {
	schema: "qorpera.office-service-failure/v1";
	stages: CompanyComputerLifecycleStage[];
	codes: string[];
	categories: string[];
	/** Consecutive transport-unconfirmed supervisor polls and their wall-clock
	 * span, present only when the stale-status budget was exhausted. */
	staleStatus?: { polls: number; durationMs: number };
} {
	const result: ReturnType<typeof companyComputerFailureDiagnostic> = {
		schema: "qorpera.office-service-failure/v1",
		stages: [],
		codes: [],
		categories: [],
	};
	const pending = [error];
	const seen = new Set<unknown>();
	for (let index = 0; pending.length && index < 16; index++) {
		const current = pending.shift();
		if (seen.has(current)) continue;
		seen.add(current);
		const stage = data(current, "stage");
		if (
			stages.includes(stage as CompanyComputerLifecycleStage) &&
			!result.stages.includes(stage as CompanyComputerLifecycleStage)
		)
			result.stages.push(stage as CompanyComputerLifecycleStage);
		const message = data(current, "message");
		if (typeof message === "string" && codes.has(message) && !result.codes.includes(message))
			result.codes.push(message);
		const polls = data(current, "unconfirmedPolls");
		const durationMs = data(current, "unconfirmedMs");
		if (
			message === "OFFICE_SUPERVISOR_STATUS_STALE" &&
			!result.staleStatus &&
			Number.isSafeInteger(polls) &&
			(polls as number) >= 0 &&
			Number.isSafeInteger(durationMs) &&
			(durationMs as number) >= 0
		)
			result.staleStatus = { polls: polls as number, durationMs: durationMs as number };
		const code = data(current, "code");
		const category = data(current, "category");
		const classified =
			typeof code === "string" && Object.hasOwn(categories, code)
				? categories[code]
				: category === "timeout" || category === "cancelled"
					? category
					: undefined;
		if (classified && !result.categories.includes(classified)) result.categories.push(classified);
		const cause = data(current, "cause");
		if (cause !== undefined && pending.length < 16) pending.unshift(cause);
		const errors = data(current, "errors");
		if (errors !== undefined) {
			for (let child = 0; child < 16 && pending.length < 16; child++) {
				const nested = data(errors, String(child));
				if (nested !== undefined) pending.push(nested);
			}
		}
	}
	if (!result.categories.length) result.categories.push("unknown");
	return result;
}
