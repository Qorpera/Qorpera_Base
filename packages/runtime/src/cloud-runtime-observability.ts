import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const CLOUD_RUNTIME_OBSERVATION_SCHEMA = "qorpera.runtime-observation/v1";
/** Runtime-owned tools observed under their own registered name. Connector tools
 * are observed as `connector`; any other name is `unknown_tool`. */
export const CLOUD_RUNTIME_TOOL_OPERATIONS = [
	"company_read",
	"company_list",
	"company_write",
	"company_mkdir",
	"company_delete",
	"send_message",
	"ask_member",
	"read_context",
	"send_coworker_message",
	"computer_start",
	"computer_screen",
	"computer_browser",
	"computer_desktop",
	"computer_shell",
	"computer_screenshot",
	"computer_transfer",
	"hire_agent",
	"create_group_chat",
	"manage_routine",
	"report_work",
	"manage_todo",
	"manage_worker",
	"coding_run_command",
	"coding_read_command",
	"coding_cancel_command",
	"coding_finish",
	"coding_ask",
	// Agent memory (runtime Step 6, Grok Bot shape).
	"update_memory",
	"recall_memory",
	// Company sidebar sections, shared with members (2026-09-24).
	"organize_sidebar",
	// Auto-review (v130): an agent adds an Ask first rule for its member.
	"add_review_rule",
] as const;
/** Closed vocabulary; the SQL ingestion function checks the same list. */
export const CLOUD_RUNTIME_OPERATIONS = [
	"model_turn",
	"model_request",
	...CLOUD_RUNTIME_TOOL_OPERATIONS,
	"company_context",
	"message_composition",
	"connector",
	"unknown_tool",
	"run_authority",
	"context_authority",
	"native_result_fence",
	"diagnostic_export",
	// Auto-review (v130): the reviewer's own model turn before an acting call.
	"action_review",
] as const;
export const CLOUD_RUNTIME_OUTCOMES = [
	"succeeded",
	"failed",
	"cancelled",
	"denied",
	"unconfirmed",
	"proposed",
	"replayed",
] as const;
export const CLOUD_RUNTIME_ERROR_CATEGORIES = [
	"invalid_arguments",
	"unavailable_tool",
	"call_id_reused",
	"budget_exhausted",
	"authority_unavailable",
	"stale_version",
	"protected_path",
	"ambiguous_effect",
	"cancelled",
	"timeout",
	"provider_failed",
	"transport_unavailable",
	"invalid_response",
	"unknown",
	"export_unavailable",
	// Auto-review (v130): why an acting call did not run.
	"approval_pending",
	"approval_declined",
	"review_denied",
	"review_unavailable",
	// A Company File write or mkdir whose folder does not exist (20260926203300).
	"parent_missing",
] as const;

export type CloudRuntimeOperation = (typeof CLOUD_RUNTIME_OPERATIONS)[number];
/** The name a runtime-owned tool must register under; factories assert it with `satisfies`. */
export type CloudRuntimeToolOperation = (typeof CLOUD_RUNTIME_TOOL_OPERATIONS)[number];
export type CloudRuntimeOutcome = (typeof CLOUD_RUNTIME_OUTCOMES)[number];
export type CloudRuntimeErrorCategory = (typeof CLOUD_RUNTIME_ERROR_CATEGORIES)[number];
/** A safe classification from a trusted boundary, never a provider's diagnostic text. */
export class CloudRuntimeDiagnosticError extends Error {
	readonly category: CloudRuntimeErrorCategory;
	constructor(category: CloudRuntimeErrorCategory, safeMessage = "Cloud operation did not complete") {
		super(safeMessage);
		this.category = category;
	}
}

export function cloudRuntimeErrorCategory(error: unknown, signal?: AbortSignal): CloudRuntimeErrorCategory {
	if (signal?.aborted)
		return signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled";
	return error instanceof CloudRuntimeDiagnosticError ? error.category : "unknown";
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const COUNTERS = [
	"inputBytes",
	"outputBytes",
	"inputTokens",
	"outputTokens",
	"cachedInputTokens",
	"cacheWriteInputTokens",
	"reasoningOutputTokens",
	"totalTokens",
] as const;
const NULL_COUNTERS = {
	inputBytes: null,
	outputBytes: null,
	inputTokens: null,
	outputTokens: null,
	cachedInputTokens: null,
	cacheWriteInputTokens: null,
	reasoningOutputTokens: null,
	totalTokens: null,
};

/** Metadata only. No error messages, paths, tool arguments, provider output or secret handles. */
export interface CloudRuntimeObservation {
	schema: typeof CLOUD_RUNTIME_OBSERVATION_SCHEMA;
	attemptId: string;
	parentAttemptId: string | null;
	assignmentId: string | null;
	phase: "start" | "finish";
	operation: CloudRuntimeOperation;
	logicalOperationSha256: string | null;
	observedAt: string;
	durationMs: number | null;
	status: "started" | CloudRuntimeOutcome;
	errorCategory: CloudRuntimeErrorCategory | null;
	receiptId: string | null;
	readId: string | null;
	inputBytes: number | null;
	outputBytes: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedInputTokens: number | null;
	cacheWriteInputTokens: number | null;
	reasoningOutputTokens: number | null;
	totalTokens: number | null;
}

export type CloudRuntimeObservationDetails = Partial<
	Pick<
		CloudRuntimeObservation,
		| "errorCategory"
		| "receiptId"
		| "readId"
		| "inputBytes"
		| "outputBytes"
		| "inputTokens"
		| "outputTokens"
		| "cachedInputTokens"
		| "cacheWriteInputTokens"
		| "reasoningOutputTokens"
		| "totalTokens"
	>
>;

const KEYS = [
	"schema",
	"attemptId",
	"parentAttemptId",
	"assignmentId",
	"phase",
	"operation",
	"logicalOperationSha256",
	"observedAt",
	"durationMs",
	"status",
	"errorCategory",
	"receiptId",
	"readId",
	...COUNTERS,
]
	.sort()
	.join();

/** Reject unknown fields rather than redacting an open-ended payload after collection. */
export function parseCloudRuntimeObservation(value: unknown): CloudRuntimeObservation {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== KEYS)
		throw new Error("Invalid runtime observation");
	const row = value as Record<string, unknown>;
	if (
		row.schema !== CLOUD_RUNTIME_OBSERVATION_SCHEMA ||
		typeof row.attemptId !== "string" ||
		!UUID.test(row.attemptId) ||
		["parentAttemptId", "assignmentId", "receiptId", "readId"].some(
			(key) => row[key] !== null && (typeof row[key] !== "string" || !UUID.test(row[key])),
		) ||
		!CLOUD_RUNTIME_OPERATIONS.includes(row.operation as CloudRuntimeOperation) ||
		(row.logicalOperationSha256 !== null &&
			(typeof row.logicalOperationSha256 !== "string" || !SHA.test(row.logicalOperationSha256))) ||
		typeof row.observedAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.observedAt) ||
		row.observedAt.startsWith("0000-") ||
		!Number.isFinite(Date.parse(row.observedAt)) ||
		new Date(row.observedAt).toISOString() !== row.observedAt ||
		[...COUNTERS, "durationMs"].some(
			(key) => row[key] !== null && (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0),
		) ||
		(row.errorCategory !== null &&
			!CLOUD_RUNTIME_ERROR_CATEGORIES.includes(row.errorCategory as CloudRuntimeErrorCategory)) ||
		(row.phase === "start"
			? row.status !== "started" || row.durationMs !== null || row.errorCategory !== null
			: row.phase !== "finish" || !CLOUD_RUNTIME_OUTCOMES.includes(row.status as CloudRuntimeOutcome))
	)
		throw new Error("Invalid runtime observation");
	return { ...row } as unknown as CloudRuntimeObservation;
}

/** An HTTP success alone does not confirm optional diagnostic ingestion. */
export function assertCloudRuntimeObservationReceipt(
	value: unknown,
	runId: string,
	observation: CloudRuntimeObservation,
): void {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "attemptId,ingestedAt,phase,replayed,runId,schema"
	)
		throw new CloudRuntimeDiagnosticError("invalid_response", "Runtime observation acknowledgement unavailable");
	const row = value as Record<string, unknown>;
	if (
		row.schema !== "qorpera.runtime-observation-receipt/v1" ||
		row.runId !== runId ||
		row.attemptId !== observation.attemptId ||
		row.phase !== observation.phase ||
		typeof row.replayed !== "boolean" ||
		typeof row.ingestedAt !== "string" ||
		!/^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
			row.ingestedAt,
		) ||
		!Number.isFinite(Date.parse(row.ingestedAt)) ||
		new Date(`${row.ingestedAt.slice(0, 19)}.000Z`).toISOString().slice(0, 19) !== row.ingestedAt.slice(0, 19)
	)
		throw new CloudRuntimeDiagnosticError("invalid_response", "Runtime observation acknowledgement unavailable");
}

/** Names an invocation by the registered tool, never by the model-supplied name. */
export function cloudRuntimeToolOperation(
	tool: { readonly name: string; readonly source: string } | undefined,
): CloudRuntimeOperation {
	if (!tool) return "unknown_tool";
	if (tool.source === "connector") return "connector";
	return CLOUD_RUNTIME_TOOL_OPERATIONS.find((value) => value === tool.name) ?? "unknown_tool";
}

/** Correlates logical retries without retaining a model-supplied call/operation key. */
export function cloudRuntimeOperationHash(runId: string, operation: CloudRuntimeOperation, key: string): string {
	return createHash("sha256")
		.update(JSON.stringify([runId, operation, key]))
		.digest("hex");
}

export interface CloudRuntimeObservationSpan {
	readonly attemptId: string;
	/** Completed host metadata for an exact retry, independent of exporter delivery. */
	readonly result: CloudRuntimeObservation | null;
	child(operation: CloudRuntimeOperation): CloudRuntimeObservationSpan;
	update(details: CloudRuntimeObservationDetails): void;
	finish(outcome: CloudRuntimeOutcome, details?: CloudRuntimeObservationDetails): void;
}

export type CloudRuntimeObservationPublisher = (
	observation: CloudRuntimeObservation,
	signal: AbortSignal,
) => Promise<unknown>;

/** Optional cloud diagnostics, never an authority/receipt or a prerequisite to work.
 * One bounded exporter, a bounded queue and a circuit that stops on a stalled
 * exporter prevent an outage from accumulating promises or delaying tool calls.
 * No automatic retry: canonical effects and diagnostic delivery are independent.
 */
export class CloudRuntimeObservability {
	readonly #assignmentId: string | null;
	readonly #publish: CloudRuntimeObservationPublisher;
	readonly #clock: () => number;
	readonly #monotonic: () => number;
	readonly #timeoutMs: number;
	readonly #queue: CloudRuntimeObservation[] = [];
	readonly #stop = new AbortController();
	#pumping = false;
	#closed = false;
	#failed = false;
	#dropped = 0;
	#sent = 0;

	constructor(options: {
		assignmentId: string | null;
		publish: CloudRuntimeObservationPublisher;
		clock?: () => number;
		monotonicClock?: () => number;
		timeoutMs?: number;
	}) {
		this.#assignmentId = options.assignmentId;
		this.#publish = options.publish;
		this.#clock = options.clock ?? Date.now;
		this.#monotonic = options.monotonicClock ?? (() => performance.now());
		this.#timeoutMs = options.timeoutMs ?? 750;
		if (
			(options.assignmentId !== null && !UUID.test(options.assignmentId)) ||
			!Number.isInteger(this.#timeoutMs) ||
			this.#timeoutMs < 1 ||
			this.#timeoutMs > 1000
		)
			throw new Error("Invalid runtime observation configuration");
	}

	get state(): { sent: number; dropped: number; pending: number; status: "active" | "unavailable" | "closed" } {
		return {
			sent: this.#sent,
			dropped: this.#dropped,
			pending: this.#queue.length + Number(this.#pumping),
			status: this.#failed ? "unavailable" : this.#closed ? "closed" : "active",
		};
	}

	start(
		operation: CloudRuntimeOperation,
		options: { logicalOperationSha256?: string; parentAttemptId?: string; inputBytes?: number } = {},
	): CloudRuntimeObservationSpan {
		const begin = this.#ticks();
		const row: Omit<CloudRuntimeObservation, "phase" | "observedAt" | "durationMs" | "status" | "errorCategory"> = {
			schema: CLOUD_RUNTIME_OBSERVATION_SCHEMA,
			attemptId: randomUUID(),
			parentAttemptId: options.parentAttemptId ?? null,
			assignmentId: this.#assignmentId,
			operation,
			logicalOperationSha256: options.logicalOperationSha256 ?? null,
			receiptId: null,
			readId: null,
			...NULL_COUNTERS,
			inputBytes: options.inputBytes ?? null,
		};
		const startedAt = this.#timestamp();
		if (startedAt !== null)
			this.#emit({
				...row,
				phase: "start",
				observedAt: startedAt,
				durationMs: null,
				status: "started",
				errorCategory: null,
			});
		else this.#dropped++;
		let finished = false;
		let details: CloudRuntimeObservationDetails = {};
		let result: CloudRuntimeObservation | null = null;
		return {
			attemptId: row.attemptId,
			get result() {
				return result === null ? null : { ...result };
			},
			child: (operation) => this.start(operation, { parentAttemptId: row.attemptId }),
			update: (next) => {
				try {
					if (
						!finished &&
						Object.keys(next).every((key) => ["errorCategory", "receiptId", "readId", ...COUNTERS].includes(key))
					)
						details = { ...details, ...next };
				} catch {
					this.#dropped++;
				}
			},
			finish: (status, next = {}) => {
				if (finished) return;
				finished = true;
				try {
					if (
						!Object.keys(next).every((key) => ["errorCategory", "receiptId", "readId", ...COUNTERS].includes(key))
					) {
						this.#dropped++;
						return;
					}
					const endedAt = this.#timestamp();
					if (endedAt === null) {
						this.#dropped++;
						return;
					}
					const end = this.#ticks();
					const duration = begin !== null && end !== null ? Math.round(end - begin) : null;
					result = parseCloudRuntimeObservation({
						...row,
						...details,
						...next,
						phase: "finish",
						status,
						observedAt: endedAt,
						errorCategory: next.errorCategory ?? details.errorCategory ?? null,
						durationMs: duration !== null && Number.isSafeInteger(duration) && duration >= 0 ? duration : null,
					});
					this.#emit(result);
				} catch {
					this.#dropped++;
				}
			},
		};
	}

	#ticks(): number | null {
		try {
			const value = this.#monotonic();
			return Number.isFinite(value) && value >= 0 ? value : null;
		} catch {
			return null;
		}
	}

	#timestamp(): string | null {
		try {
			const value = new Date(this.#clock()).toISOString();
			return /^\d{4}-/.test(value) && !value.startsWith("0000-") ? value : null;
		} catch {
			return null;
		}
	}

	#emit(row: CloudRuntimeObservation): void {
		if (this.#closed || this.#failed || this.#queue.length >= 256) {
			this.#dropped++;
			return;
		}
		try {
			this.#queue.push(parseCloudRuntimeObservation(row));
		} catch {
			this.#dropped++;
			return;
		}
		if (!this.#pumping) void this.#drain();
	}

	async #drain(): Promise<void> {
		this.#pumping = true;
		try {
			while (!this.#closed && !this.#failed && this.#queue.length) {
				const row = this.#queue.shift()!;
				const deadline = new AbortController();
				const signal = AbortSignal.any([this.#stop.signal, deadline.signal]);
				let timer: ReturnType<typeof setTimeout> | undefined;
				const aborted = new Promise<never>((_, reject) => {
					const stop = () => reject(new Error("Runtime observation export stopped"));
					signal.addEventListener("abort", stop, { once: true });
					timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
					timer.unref?.();
				});
				try {
					await Promise.race([Promise.resolve().then(() => this.#publish(row, signal)), aborted]);
					this.#sent++;
				} catch {
					this.#failed = true;
					this.#dropped += 1 + this.#queue.length;
					this.#queue.length = 0;
				} finally {
					clearTimeout(timer);
					deadline.abort();
				}
			}
		} finally {
			this.#pumping = false;
		}
	}

	/** A bounded final drain; diagnostic failure cannot change the product result. */
	async close(): Promise<void> {
		const end = performance.now() + 250;
		while (this.#pumping && performance.now() < end) await new Promise<void>((resolve) => setTimeout(resolve, 5));
		this.#closed = true;
		this.#dropped += this.#queue.length;
		this.#queue.length = 0;
		this.#stop.abort();
	}
}
