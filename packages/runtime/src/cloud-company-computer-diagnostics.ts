import { GUEST_IMAGE_SELF_UPDATE_UNITS, guestImageSelfUpdateCode } from "./lxd-guest-image-updates.ts";

const stages = [
	"image",
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
	// The unit an image that can update itself left unmasked (constants only).
	...GUEST_IMAGE_SELF_UPDATE_UNITS.map(guestImageSelfUpdateCode),
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
	// Which registry-status invariant the supervisor refused (constants only).
	"OFFICE_SUPERVISOR_STATE_KEYS",
	"OFFICE_SUPERVISOR_STATE_SCOPE",
	"OFFICE_SUPERVISOR_STATE_GENERATION",
	"OFFICE_SUPERVISOR_STATE_REVISION",
	"OFFICE_SUPERVISOR_STATE_PRIVACY_VERSION",
	"OFFICE_SUPERVISOR_STATE_PRIVACY_STATE",
	"OFFICE_SUPERVISOR_STATE_OFFICE_STATE",
	"OFFICE_SUPERVISOR_STATE_DRAINS",
	"OFFICE_SUPERVISOR_STATE_CHALLENGE",
	"OFFICE_SUPERVISOR_STATE_DRAIN",
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
	// Why the service refused or ended a member viewer (constants only).
	"OFFICE_SERVICE_NOT_READY",
	"OFFICE_VIEWER_CHANGED",
	"OFFICE_PRIVATE_VIEWER_CHANGED",
	"OFFICE_DESKTOP_CONNECTION_CANCELLED",
	"OFFICE_DESKTOP_RFB_UNAVAILABLE",
	"OFFICE_GUEST_READINESS_UNCONFIRMED",
	"INVALID_VIEW_HANDSHAKE",
	"INVALID_VIEWER_TICKET",
	"INVALID_VIEWER_GRANT",
	"INVALID_PRIVATE_VIEWER_GRANT",
	"INVALID_VIEWER_INPUT",
	"MEMBER_TAKEOVER_REQUIRED",
	"WATCHER_CANNOT_HOLD_CONTROL",
	"VIEWER_LEASE_CHANGED",
	"VIEWER_TICKET_UNCONFIRMED",
	"VIEWER_INPUT_UNCONFIRMED",
	"VIEWER_TRANSPORT_UNAVAILABLE",
	"VIEWER_GATEWAY_CLOSED",
	"VIEWER_CAPACITY_LIMIT",
	"VIEWER_PRIVACY_FENCED",
	"VIEWER_SCREEN_FENCED",
	"VIEWER_EXPIRED",
	"VIEWER_STOPPED",
	"VIEWER_BACKPRESSURE_LIMIT",
	"VIEWER_HELD_INPUT_LIMIT",
	"VIEWER_INPUT_ALREADY_SETTLED",
	"VIEWER_INPUT_NOT_FORWARDED",
	"VIEWER_OUTPUT_UNAVAILABLE",
	"VIEWER_UPGRADE_CLOSED",
	"VIEWER_UPGRADE_PATH",
	"VIEWER_UPGRADE_ORIGIN",
	"VIEWER_UPGRADE_INVALID",
	"UNKNOWN_VIEWER",
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

const viewerStages = ["upgrade", "capacity", "handshake", "redeem", "connect", "stream"] as const;
/** Where the office service refused or ended a member viewer. */
export type CompanyComputerViewerRefusalStage = (typeof viewerStages)[number];
export type CompanyComputerViewerRefusalObserver = (stage: CompanyComputerViewerRefusalStage, error: unknown) => void;

/** What admission looked like at the moment of a refusal; read-only facts. */
export interface CompanyComputerViewerAdmissionState {
	/** The service had completed its first reconciliation and was not stopping. */
	serving: boolean;
	supervisor?: {
		failed: boolean;
		/** Age of the current transport-unconfirmed gap, or null while the latest poll confirmed the state. */
		unconfirmedMs: number | null;
		unconfirmedPolls: number;
		/** Last durable office revision the supervisor confirmed; 0 before the first one. */
		confirmedRevision: number;
	};
}

export interface CompanyComputerViewerRefusalRecord extends CompanyComputerViewerAdmissionState {
	schema: "qorpera.office-viewer-refusal/v1";
	stage: CompanyComputerViewerRefusalStage;
	codes: string[];
	categories: string[];
	/** Identical refusals not written since the previous line for this stage and code. */
	suppressed: number;
}

/**
 * One journal line per refused or ended viewer, so a member who cannot open a
 * screen leaves a trace on the machine that refused them. The line is the same
 * closed projection as the service failure record: constant codes and
 * categories only. It never holds a capability, token, member, screen, address,
 * origin or any byte the client sent, and it changes nothing the client sees.
 * A retrying client cannot flood the journal: each stage and leading code is
 * written at most once per window, and the next line says how many were held.
 */
export function createCompanyComputerViewerRefusalReporter(options: {
	write(line: string): void;
	state?: () => CompanyComputerViewerAdmissionState;
	now?: () => number;
	windowMs?: number;
}): CompanyComputerViewerRefusalObserver {
	const windowMs = options.windowMs ?? 10_000;
	if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 3_600_000)
		throw new Error("INVALID_VIEWER_REFUSAL_WINDOW");
	const now = options.now ?? Date.now;
	const written = new Map<string, { at: number; suppressed: number }>();
	return (stage, error) => {
		try {
			if (!viewerStages.includes(stage)) return;
			const diagnostic = companyComputerFailureDiagnostic(error);
			const key = `${stage}:${diagnostic.codes[0] ?? "UNLISTED"}`;
			const at = now();
			const previous = written.get(key);
			if (previous && at >= previous.at && at - previous.at < windowMs) {
				previous.suppressed = Math.min(previous.suppressed + 1, Number.MAX_SAFE_INTEGER);
				return;
			}
			// Stages and codes are closed sets, so this map is bounded by construction.
			written.set(key, { at, suppressed: 0 });
			const state = options.state?.();
			const supervisor = state?.supervisor;
			const record: CompanyComputerViewerRefusalRecord = {
				schema: "qorpera.office-viewer-refusal/v1",
				stage,
				codes: diagnostic.codes,
				categories: diagnostic.categories,
				suppressed: previous?.suppressed ?? 0,
				serving: state?.serving === true,
				...(supervisor
					? {
							supervisor: {
								failed: supervisor.failed === true,
								unconfirmedMs:
									Number.isSafeInteger(supervisor.unconfirmedMs) && (supervisor.unconfirmedMs as number) >= 0
										? supervisor.unconfirmedMs
										: null,
								unconfirmedPolls: Number.isSafeInteger(supervisor.unconfirmedPolls)
									? supervisor.unconfirmedPolls
									: 0,
								confirmedRevision: Number.isSafeInteger(supervisor.confirmedRevision)
									? supervisor.confirmedRevision
									: 0,
							},
						}
					: {}),
			};
			options.write(JSON.stringify(record));
		} catch {
			/* A diagnostic must never change what happens to the viewer. */
		}
	};
}
