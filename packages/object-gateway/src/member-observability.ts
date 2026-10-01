import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ObjectDependencyError } from "./dependency.ts";

export const MEMBER_OBSERVATIONS_PATH = "/v1/member-company-observations";
export const MEMBER_OBSERVATION_CAPACITY = 512;
export const MEMBER_OBSERVATION_RETENTION_MS = 15 * 60_000;
export const MEMBER_OBSERVATION_OPERATIONS = [
	"object_read",
	"file_request",
	"command_submit",
	"command_status",
	"command_content",
	"command_review",
	"proposal_content",
	"proposal_review",
] as const;
export const MEMBER_EFFECT_OUTCOMES = ["none", "proposed", "applied", "replayed", "rejected", "unconfirmed"] as const;
export type MemberObservationOperation = (typeof MEMBER_OBSERVATION_OPERATIONS)[number];
export type MemberEffectOutcome = (typeof MEMBER_EFFECT_OUTCOMES)[number];
type MemberResponseOutcome = "started" | "succeeded" | "denied" | "failed" | "aborted";
type MemberErrorCategory =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "invalid_request"
	| "stale_version"
	| "conflict"
	| "dependency_unavailable"
	| "response_aborted"
	| "unknown";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_FIELDS = [
	"companyId",
	"environmentId",
	"commandId",
	"proposalId",
	"actorUserId",
	"resourceId",
	"resourceVersion",
] as const;
const BYTE_FIELDS = [
	"requestBodyBytes",
	"responseBodyBytes",
	"logicalObjectReadBytes",
	"logicalWriteInputBytes",
] as const;
const QUERY_FIELDS = [
	"limit",
	"companyId",
	"environmentId",
	"commandId",
	"actorUserId",
	"resourceId",
	"operation",
	"outcome",
] as const;

export interface MemberRequestObservation {
	schema: "qorpera.member-request-observation/v1";
	attemptId: string;
	operation: MemberObservationOperation;
	startedAt: string | null;
	endedAt: string | null;
	durationMs: number | null;
	responseOutcome: MemberResponseOutcome;
	httpStatus: number | null;
	errorCategory: MemberErrorCategory | null;
	effectOutcome: MemberEffectOutcome;
	effectObservedAt: string | null;
	companyId: string | null;
	environmentId: string | null;
	commandId: string | null;
	proposalId: string | null;
	actorUserId: string | null;
	resourceId: string | null;
	resourceVersion: string | null;
	requestBodyBytes: number | null;
	responseBodyBytes: number | null;
	logicalObjectReadBytes: number | null;
	logicalWriteInputBytes: number | null;
}

type MemberObservationDetails = Partial<
	Pick<MemberRequestObservation, (typeof ID_FIELDS)[number] | (typeof BYTE_FIELDS)[number]>
>;
export interface MemberRequestObservationSpan {
	operation(value: MemberObservationOperation): void;
	update(details: MemberObservationDetails): void;
	effect(outcome: MemberEffectOutcome): void;
	fail(status?: number): void;
	finish(status: number | null, aborted?: boolean): void;
}

export interface MemberObservationQuery {
	limit: number;
	companyId?: string;
	environmentId?: string;
	commandId?: string;
	actorUserId?: string;
	resourceId?: string;
	operation?: MemberObservationOperation;
	outcome?: MemberResponseOutcome;
}

/** Filter values are closed metadata. Never accept a URL, path, token or free text. */
export function parseMemberObservationQuery(url: string): MemberObservationQuery {
	if (url.length > 1024 || !/^\/v1\/member-company-observations(?:\?[A-Za-z0-9_=&-]+)?$/.test(url))
		throw new ObjectDependencyError(404);
	const fields = url.split("?")[1]?.split("&") ?? [];
	if (fields.some((field) => !/^[A-Za-z]+=[A-Za-z0-9_-]+$/.test(field))) throw new ObjectDependencyError(400);
	const query = new URLSearchParams(url.split("?")[1]);
	const seen = new Set<string>();
	for (const [key, value] of query) {
		if (seen.has(key) || !QUERY_FIELDS.includes(key as (typeof QUERY_FIELDS)[number]) || !value)
			throw new ObjectDependencyError(400);
		seen.add(key);
	}
	const limit = query.get("limit") ?? "50";
	if (!/^(?:[1-9][0-9]?|100)$/.test(limit)) throw new ObjectDependencyError(400);
	const result: MemberObservationQuery = { limit: Number(limit) };
	for (const key of ["companyId", "environmentId", "commandId", "actorUserId", "resourceId"] as const) {
		const value = query.get(key);
		if (value !== null) {
			if (!UUID.test(value)) throw new ObjectDependencyError(400);
			result[key] = value;
		}
	}
	const operation = query.get("operation");
	if (operation !== null) {
		if (!MEMBER_OBSERVATION_OPERATIONS.includes(operation as MemberObservationOperation))
			throw new ObjectDependencyError(400);
		result.operation = operation as MemberObservationOperation;
	}
	const outcome = query.get("outcome");
	if (outcome !== null) {
		if (!["started", "succeeded", "denied", "failed", "aborted"].includes(outcome))
			throw new ObjectDependencyError(400);
		result.outcome = outcome as MemberResponseOutcome;
	}
	return result;
}

const NO_OBSERVATION: MemberRequestObservationSpan = Object.freeze({
	operation: () => undefined,
	update: () => undefined,
	effect: () => undefined,
	fail: () => undefined,
	finish: () => undefined,
});

/** Optional, bounded process memory only. These diagnostics never authorize work,
 * release data, retry a mutation, or replace its canonical command/proposal. */
export class MemberCompanyObservations {
	readonly #instanceId = randomUUID();
	readonly #clock: () => number;
	readonly #monotonic: () => number;
	readonly #capacity: number;
	readonly #retentionMs: number;
	readonly #startedAt: string | null;
	readonly #rows = new Map<string, { begin: number; row: MemberRequestObservation }>();
	#evicted = 0;
	#dropped = 0;

	constructor(
		options: { clock?: () => number; monotonicClock?: () => number; capacity?: number; retentionMs?: number } = {},
	) {
		this.#clock = options.clock ?? Date.now;
		this.#monotonic = options.monotonicClock ?? (() => performance.now());
		this.#capacity = options.capacity ?? MEMBER_OBSERVATION_CAPACITY;
		this.#retentionMs = options.retentionMs ?? MEMBER_OBSERVATION_RETENTION_MS;
		if (
			!Number.isSafeInteger(this.#capacity) ||
			this.#capacity < 1 ||
			this.#capacity > MEMBER_OBSERVATION_CAPACITY ||
			!Number.isSafeInteger(this.#retentionMs) ||
			this.#retentionMs < 1 ||
			this.#retentionMs > MEMBER_OBSERVATION_RETENTION_MS
		)
			throw new Error("Invalid member observation bounds");
		this.#startedAt = this.#wall();
	}

	#wall(): string | null {
		try {
			return new Date(this.#clock()).toISOString();
		} catch {
			return null;
		}
	}

	#prune(now: number): void {
		for (const [id, entry] of this.#rows) {
			if (now < entry.begin || now - entry.begin >= this.#retentionMs) {
				this.#rows.delete(id);
				this.#evicted++;
			}
		}
	}

	start(operation: MemberObservationOperation): MemberRequestObservationSpan {
		try {
			const begin = this.#monotonic();
			if (!Number.isFinite(begin) || begin < 0 || !MEMBER_OBSERVATION_OPERATIONS.includes(operation))
				throw new Error("Invalid observation");
			this.#prune(begin);
			while (this.#rows.size >= this.#capacity) {
				this.#rows.delete(this.#rows.keys().next().value!);
				this.#evicted++;
			}
			const row: MemberRequestObservation = {
				schema: "qorpera.member-request-observation/v1",
				attemptId: randomUUID(),
				operation,
				startedAt: this.#wall(),
				endedAt: null,
				durationMs: null,
				responseOutcome: "started",
				httpStatus: null,
				errorCategory: null,
				effectOutcome: "none",
				effectObservedAt: null,
				companyId: null,
				environmentId: null,
				commandId: null,
				proposalId: null,
				actorUserId: null,
				resourceId: null,
				resourceVersion: null,
				requestBodyBytes: null,
				responseBodyBytes: null,
				logicalObjectReadBytes: null,
				logicalWriteInputBytes: null,
			};
			this.#rows.set(row.attemptId, { begin, row });
			// The span retains only an opaque attempt ID, not an evicted record.
			const id = row.attemptId;
			return {
				operation: (value) =>
					this.#change(id, (entry) => {
						if (!MEMBER_OBSERVATION_OPERATIONS.includes(value)) throw new Error("Invalid observation");
						entry.row.operation = value;
					}),
				update: (details) =>
					this.#change(id, (entry) => {
						const keys = Object.keys(details);
						if (keys.some((key) => ![...ID_FIELDS, ...BYTE_FIELDS].includes(key as (typeof ID_FIELDS)[number])))
							throw new Error("Invalid observation");
						for (const key of ID_FIELDS) {
							const value = details[key];
							if (
								value !== undefined &&
								(typeof value !== "string" ||
									!UUID.test(value) ||
									(entry.row[key] !== null && entry.row[key] !== value))
							)
								throw new Error("Invalid observation");
						}
						for (const key of BYTE_FIELDS) {
							const value = details[key];
							if (
								value !== undefined &&
								(value === null || !Number.isSafeInteger(value) || value < 0 || value > 8 * 1024 * 1024)
							)
								throw new Error("Invalid observation");
						}
						for (const key of ID_FIELDS) if (details[key] !== undefined) entry.row[key] = details[key]!;
						for (const key of BYTE_FIELDS) if (details[key] !== undefined) entry.row[key] = details[key]!;
					}),
				effect: (outcome) =>
					this.#change(id, (entry) => {
						if (!MEMBER_EFFECT_OUTCOMES.includes(outcome)) throw new Error("Invalid observation");
						// An HTTP failure cannot erase a positively observed canonical effect.
						if (
							["applied", "replayed"].includes(entry.row.effectOutcome) &&
							!["applied", "replayed"].includes(outcome)
						)
							return;
						entry.row.effectOutcome = outcome;
						entry.row.effectObservedAt = this.#wall();
					}),
				fail: (status) =>
					this.#change(id, (entry) => {
						entry.row.errorCategory =
							status === 401
								? "unauthorized"
								: status === 403
									? "forbidden"
									: status === 404
										? "not_found"
										: status === 412
											? "stale_version"
											: status === 409 || status === 423
												? "conflict"
												: status === 400 || status === 405 || status === 413
													? "invalid_request"
													: status !== undefined && status >= 500 && status <= 599
														? "dependency_unavailable"
														: "unknown";
					}),
				finish: (status, aborted = false) =>
					this.#change(id, (entry) => {
						if (entry.row.responseOutcome !== "started") return;
						if (status !== null && (!Number.isSafeInteger(status) || status < 100 || status > 599))
							throw new Error("Invalid observation");
						let duration: number | null = null;
						try {
							const elapsed = Math.round(this.#monotonic() - entry.begin);
							if (Number.isSafeInteger(elapsed) && elapsed >= 0) duration = elapsed;
						} catch {
							/* Unknown duration does not change the request. */
						}
						entry.row.endedAt = this.#wall();
						entry.row.durationMs = duration;
						entry.row.httpStatus = status;
						entry.row.responseOutcome = aborted
							? "aborted"
							: status !== null && status >= 200 && status < 300
								? "succeeded"
								: status !== null && status >= 400 && status < 500
									? "denied"
									: "failed";
						if (aborted && entry.row.errorCategory === null) entry.row.errorCategory = "response_aborted";
					}),
			};
		} catch {
			this.#dropped++;
			return NO_OBSERVATION;
		}
	}

	#change(id: string, apply: (entry: { begin: number; row: MemberRequestObservation }) => void): void {
		try {
			const entry = this.#rows.get(id);
			if (entry) apply(entry);
		} catch {
			this.#dropped++;
		}
	}

	snapshot(query: MemberObservationQuery) {
		// Validate direct callers too, not only the HTTP decoder.
		const encoded = new URLSearchParams(
			Object.entries(query).map(([key, value]): [string, string] => [key, String(value)]),
		).toString();
		parseMemberObservationQuery(`${MEMBER_OBSERVATIONS_PATH}?${encoded}`);
		let freshness: "current" | "unknown" = "current";
		try {
			const now = this.#monotonic();
			if (!Number.isFinite(now) || now < 0) throw new Error("Unknown clock");
			this.#prune(now);
		} catch {
			freshness = "unknown";
		}
		const matching = [...this.#rows.values()]
			.reverse()
			.map((entry) => entry.row)
			.filter((row) =>
				Object.entries(query).every(
					([key, value]) =>
						key === "limit" ||
						(key === "outcome" ? row.responseOutcome : row[key as keyof MemberRequestObservation]) === value,
				),
			);
		return {
			schema: "qorpera.member-request-observation-window/v1",
			instanceId: this.#instanceId,
			processStartedAt: this.#startedAt,
			asOf: this.#wall(),
			freshness,
			retention: "bounded-process-memory-only",
			retentionMs: this.#retentionMs,
			capacity: this.#capacity,
			priorProcessObservationsAvailable: false,
			completeHistory: false,
			evicted: this.#evicted,
			dropped: this.#dropped,
			retained: this.#rows.size,
			matched: matching.length,
			more: matching.length > query.limit,
			byteSemantics: {
				requestBodyBytes: "observed-http-body",
				responseBodyBytes: "prepared-http-body-not-client-acknowledgement",
				logicalObjectReadBytes: "verified-immutable-object-payload-not-whole-file-or-nas-traffic",
				logicalWriteInputBytes: "validated-write-input-not-committed-or-replicated-traffic",
			},
			canonicalIdentity: "authorized-read-descriptor-or-command-proposal-query",
			clientDeliveryConfirmed: false,
			observations: matching.slice(0, query.limit).map((row) => ({ ...row })),
		};
	}
}
