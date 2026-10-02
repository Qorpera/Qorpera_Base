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
	"decide_routine",
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
	// Agent skills (contract 15.2): own and company libraries.
	"read_skill",
	"search_skills",
	"update_skill",
	// Company sidebar sections, shared with members (2026-09-24).
	"organize_sidebar",
	// Auto-review (v130): an agent adds an Ask first rule for its member.
	"add_review_rule",
	// Machines agents start for tests and long jobs (2026-09-28).
	"machine_start",
	"machine_run",
	"machine_read",
	"machine_cancel",
	"machine_stop",
	"machine_delete",
	"machine_list",
	// Event wakes (W2): the company's hooks and one event's body.
	"list_hooks",
	"read_event",
	// Company mail (M2b): an email from a mailbox.
	"send_mail",
	// The run box (F3 step 2b): commands over the company folder, read-only.
	"exec_command",
	"write_stdin",
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

/** Rows per export call. The SQL batch function (20260929370000) accepts 1 to 50. */
export const CLOUD_RUNTIME_OBSERVATION_BATCH_ROWS = 50;
/** SQLSTATEs the single-row function refuses a row with: invalid, unavailable reference, changed replay. */
const REFUSAL_CODES = ["22023", "42501", "23505"];

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

/** Each slot is that row's exact receipt or the database's refusal of that row alone.
 * Returns how many rows were refused. */
export function assertCloudRuntimeObservationBatchReceipt(
	value: unknown,
	runId: string,
	observations: readonly CloudRuntimeObservation[],
): number {
	const row = value as Record<string, unknown>;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "receipts,runId,schema" ||
		row.schema !== "qorpera.runtime-observation-batch-receipt/v1" ||
		row.runId !== runId ||
		!Array.isArray(row.receipts) ||
		row.receipts.length !== observations.length
	)
		throw new CloudRuntimeDiagnosticError("invalid_response", "Runtime observation acknowledgement unavailable");
	let refused = 0;
	for (const [index, receipt] of (row.receipts as unknown[]).entries()) {
		const refusal = receipt as Record<string, unknown>;
		if (
			refusal &&
			typeof refusal === "object" &&
			!Array.isArray(refusal) &&
			Object.keys(refusal).sort().join() === "code,schema" &&
			refusal.schema === "qorpera.runtime-observation-refusal/v1" &&
			REFUSAL_CODES.includes(refusal.code as string)
		)
			refused++;
		else assertCloudRuntimeObservationReceipt(receipt, runId, observations[index]);
	}
	return refused;
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

/** Sends one batch of up to CLOUD_RUNTIME_OBSERVATION_BATCH_ROWS rows, in order. Resolves
 * once the database answered for every row: with how many rows it refused (a count), or
 * with anything else when it refused none. Rejects when the batch should be tried again. */
export type CloudRuntimeObservationPublisher = (
	observations: readonly CloudRuntimeObservation[],
	signal: AbortSignal,
) => Promise<unknown>;

/** Rows waiting or in flight; beyond this new rows are dropped (and counted). */
const QUEUE_ROWS = 256;
/** Attempts per batch. A batch that fails them all is dropped, so it never holds up the rest. */
const BATCH_ATTEMPTS = 4;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 2000;
/** Rows behind a live, member-visible phase (writing, 20260920011000) go at once, with what gathered. */
const LIVE_OPERATIONS: readonly CloudRuntimeOperation[] = ["message_composition"];

/** Optional cloud diagnostics, never an authority/receipt or a prerequisite to work.
 * Rows gather for up to a second (until 50 wait, or at once for a live writing
 * phase), then one export call at a time sends up to 50 queued rows in order. A failed or timed-out
 * call is tried again with backoff (the database acknowledges an exact replay instead of
 * recording it twice), and a batch that fails every attempt is dropped. A bounded queue
 * drops rows beyond it, and close() flushes for a bounded time, so an outage never
 * accumulates promises, delays tool calls or changes a product result.
 */
export class CloudRuntimeObservability {
	readonly #assignmentId: string | null;
	readonly #publish: CloudRuntimeObservationPublisher;
	readonly #clock: () => number;
	readonly #monotonic: () => number;
	readonly #timeoutMs: number;
	readonly #flushMs: number;
	readonly #batchDelayMs: number;
	readonly #queue: CloudRuntimeObservation[] = [];
	readonly #stop = new AbortController();
	#draining: Promise<void> | undefined;
	/** Ends the current gathering wait early: a full batch is waiting, or close() flushes. */
	#gathered: (() => void) | undefined;
	#closing: Promise<void> | undefined;
	#closed = false;
	/** The last export call failed; cleared by the next success. */
	#unavailable = false;
	#dropped = 0;
	#sent = 0;

	constructor(options: {
		assignmentId: string | null;
		publish: CloudRuntimeObservationPublisher;
		clock?: () => number;
		monotonicClock?: () => number;
		/** One export call's deadline. */
		timeoutMs?: number;
		/** How long close() keeps exporting what is queued. */
		flushMs?: number;
		/** How long rows gather before a call that is not full; 0 sends at once. */
		batchDelayMs?: number;
	}) {
		this.#assignmentId = options.assignmentId;
		this.#publish = options.publish;
		this.#clock = options.clock ?? Date.now;
		this.#monotonic = options.monotonicClock ?? (() => performance.now());
		this.#timeoutMs = options.timeoutMs ?? 2000;
		this.#flushMs = options.flushMs ?? 1000;
		this.#batchDelayMs = options.batchDelayMs ?? 1000;
		if (
			(options.assignmentId !== null && !UUID.test(options.assignmentId)) ||
			[this.#timeoutMs, this.#flushMs].some((value) => !Number.isInteger(value) || value < 1 || value > 10_000) ||
			!Number.isInteger(this.#batchDelayMs) ||
			this.#batchDelayMs < 0 ||
			this.#batchDelayMs > 10_000
		)
			throw new Error("Invalid runtime observation configuration");
	}

	get state(): { sent: number; dropped: number; pending: number; status: "active" | "unavailable" | "closed" } {
		return {
			sent: this.#sent,
			dropped: this.#dropped,
			pending: this.#queue.length,
			status: this.#unavailable ? "unavailable" : this.#closed ? "closed" : "active",
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
		if (this.#closed || this.#queue.length >= QUEUE_ROWS) {
			this.#dropped++;
			return;
		}
		try {
			this.#queue.push(parseCloudRuntimeObservation(row));
		} catch {
			this.#dropped++;
			return;
		}
		if (this.#queue.length >= CLOUD_RUNTIME_OBSERVATION_BATCH_ROWS || LIVE_OPERATIONS.includes(row.operation))
			this.#gathered?.();
		this.#pump();
	}

	#pump(): void {
		if (this.#draining || this.#stop.signal.aborted) return;
		this.#draining = this.#drain()
			.catch(() => undefined)
			.finally(() => {
				this.#draining = undefined;
				// A row queued while the last drain was returning still gets its own.
				if (this.#queue.length) this.#pump();
			});
	}

	/** Rows stay queued until acknowledged, so a retry resends them in the same order. */
	async #drain(): Promise<void> {
		let attempts = 0;
		while (this.#queue.length && !this.#stop.signal.aborted) {
			if (attempts === 0) await this.#gather();
			const batch = this.#queue.slice(0, CLOUD_RUNTIME_OBSERVATION_BATCH_ROWS);
			const refused = await this.#send(batch);
			if (refused !== null) {
				this.#queue.splice(0, batch.length);
				this.#sent += batch.length - refused;
				this.#dropped += refused;
				this.#unavailable = false;
				attempts = 0;
				continue;
			}
			this.#unavailable = true;
			if (++attempts >= BATCH_ATTEMPTS) {
				this.#queue.splice(0, batch.length);
				this.#dropped += batch.length;
			}
			await this.#backoff(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)));
			if (attempts >= BATCH_ATTEMPTS) attempts = 0;
		}
	}

	/** Rows the database refused, or null when the batch should be tried again. */
	async #send(batch: readonly CloudRuntimeObservation[]): Promise<number | null> {
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
			const refused = await Promise.race([Promise.resolve().then(() => this.#publish(batch, signal)), aborted]);
			return typeof refused === "number" && Number.isSafeInteger(refused) && refused >= 0
				? Math.min(refused, batch.length)
				: 0;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			deadline.abort();
		}
	}

	/** Lets rows gather for `batchDelayMs`, unless a full batch or a live row waits, or close() flushes. */
	#gather(): Promise<void> {
		if (
			this.#closed ||
			!this.#batchDelayMs ||
			this.#queue.length >= CLOUD_RUNTIME_OBSERVATION_BATCH_ROWS ||
			this.#queue.some((row) => LIVE_OPERATIONS.includes(row.operation))
		)
			return Promise.resolve();
		return new Promise<void>((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				this.#gathered = undefined;
				resolve();
			};
			const timer = setTimeout(done, this.#batchDelayMs);
			timer.unref?.();
			this.#gathered = done;
		});
	}

	/** Waits about `ms` (jittered so runs spread out), or until the exporter stops. */
	#backoff(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				this.#stop.signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, Math.round(ms * (0.75 + Math.random() / 2)));
			timer.unref?.();
			this.#stop.signal.addEventListener("abort", done, { once: true });
			if (this.#stop.signal.aborted) done();
		});
	}

	/** Accepts no more rows and keeps exporting the queued ones for at most `flushMs`;
	 * whatever is still unsent then is dropped. Diagnostic failure cannot change the
	 * product result. */
	close(): Promise<void> {
		this.#closing ??= (async () => {
			this.#closed = true;
			this.#gathered?.();
			const deadline = setTimeout(() => this.#stop.abort(), this.#flushMs);
			try {
				while (this.#draining) await this.#draining;
			} finally {
				clearTimeout(deadline);
				this.#stop.abort();
				this.#dropped += this.#queue.length;
				this.#queue.length = 0;
			}
		})();
		return this.#closing;
	}
}
