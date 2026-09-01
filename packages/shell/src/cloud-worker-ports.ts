import {
	parseWorkerDispatch,
	parseWorkerGrant,
	parseWorkerParent,
	parseWorkerSources,
	parseWorkerTodoIdentity,
	parseWorkerTools,
	WORKER_CONTEXT_SCHEMA,
	type WORKER_RUN_COMMAND_SCHEMA,
	type WorkerCommand,
	type WorkerContinuation,
	WorkerContractError,
	type WorkerDispatch,
	type WorkerExecutionIdentity,
	type WorkerGrantReference,
	type WorkerParentIdentity,
	type WorkerResult,
	type WorkerSourceReference,
	type WorkerTodoIdentity,
	type WorkerToolReference,
	workerDigest,
	workerRecord,
	workerSame,
	workerUuid,
} from "./cloud-worker-contract.ts";

/** Checked inside the existing effect transaction, not merely before the RPC. */
export interface WorkerEffectGuard {
	todo: WorkerTodoIdentity;
	parent: WorkerParentIdentity;
	/** Host-bound caller; never accepted from a child's result or an LLM argument. */
	actorRunId: string;
	expectedVersion: string | null;
	workerId: string | null;
	delegation: WorkerGrantReference | null;
	/** null only for a todo-wide action or an expected-absent handle being inserted. */
	epoch: number | null;
	sequence: number | null;
	/** status is a positive observation and requires live authority, never a cleanup exemption. */
	purpose: "todo" | "dispatch" | "followup" | "cancel" | "complete" | "accept" | "continue" | "reconcile" | "status";
}

/**
 * Adapter to the existing governed Company File read/mutate machinery. Reads
 * use this component's pinned closed baseline page/absent shapes; mutation
 * receipts use qorpera.company-path-result/v1. The current main gateway also
 * returns snapshotId/readObservationId on reads. Its envelope is deliberately
 * rejected until an explicit bridge validates and preserves that provenance
 * through native context fencing; silently dropping the fields is not a bridge.
 * commit must atomically recheck the guard and path ACLs with the CAS,
 * immutable receipt, revision and change event. A dispatch with a workerId but
 * null epoch expects an absent handle and must validate the inserted dispatch's
 * delegation inside that transaction. It is NOT a new file gateway.
 * Completion/acceptance (and an explicit blocked-checkpoint resume) must also
 * revalidate the bound result/output receipts against the CAS head and current
 * proposal state. Earlier verifyResult preflight alone cannot close that race.
 *
 * No default adapter exists: a plain unguarded gateway cannot be passed here.
 */
export interface WorkerCompanyFilePort {
	read(path: string, offset: number, limit: number, signal: AbortSignal): Promise<unknown>;
	commit(
		guard: WorkerEffectGuard,
		mutation: { path: string; operationKey: string; expectedVersion: string | null; text: string },
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface WorkerDelegationScope {
	schema: "qorpera.worker-delegation/v1";
	todo: WorkerTodoIdentity;
	parent: WorkerParentIdentity;
	workerId: string;
	delegation: WorkerGrantReference;
	parentEnd: "cancel" | "retain-grant";
	tools: WorkerToolReference[];
	sources: WorkerSourceReference[];
}

/** Resolve references through the current authority spine, without returning secrets. */
export interface WorkerAuthorityPort {
	assertParent(
		todo: WorkerTodoIdentity,
		parent: WorkerParentIdentity,
		actorRunId: string,
		signal: AbortSignal,
	): Promise<void>;
	/** null is positive revocation; unavailability must throw, not impersonate revocation or consent. */
	resolve(dispatch: WorkerDispatch, signal: AbortSignal): Promise<WorkerDelegationScope | null>;
}

export interface WorkerBlankContext {
	schema: typeof WORKER_CONTEXT_SCHEMA;
	species: "in-house";
	workerId: string;
	parentRunId: string;
	todo: WorkerTodoIdentity;
	runtimeBundleVersion: string;
	goal: string;
	definitionOfDone: string[];
	context: WorkerDispatch["context"];
	tools: WorkerToolReference[];
	output: WorkerDispatch["destination"];
	cancellation: WorkerDispatch["cancellation"];
	completion: WorkerDispatch["completion"];
	publicMouth: "forbidden";
	resultTrust: "untrusted-worker-data";
}

/** Narrow by exact versioned references. A scope never becomes automatic context. */
export function workerBlankContext(
	dispatchValue: WorkerDispatch,
	scopeValue: WorkerDelegationScope,
): WorkerBlankContext {
	const dispatch = parseWorkerDispatch(dispatchValue);
	const scope = workerRecord(scopeValue, [
		"schema",
		"todo",
		"parent",
		"workerId",
		"delegation",
		"parentEnd",
		"tools",
		"sources",
	]);
	if (
		scope.schema !== "qorpera.worker-delegation/v1" ||
		workerUuid(scope.workerId) !== dispatch.workerId ||
		!workerSame(parseWorkerTodoIdentity(scope.todo), dispatch.todo) ||
		!workerSame(parseWorkerParent(scope.parent), dispatch.parent) ||
		!workerSame(parseWorkerGrant(scope.delegation), dispatch.delegation)
	)
		throw new WorkerContractError("Worker delegation binding differs");
	if (
		(scope.parentEnd !== "cancel" && scope.parentEnd !== "retain-grant") ||
		(dispatch.cancellation.onParentEnd === "retain-grant" && scope.parentEnd !== "retain-grant")
	)
		throw new WorkerContractError("Worker cannot outlive its delegated parent policy");
	const tools = parseWorkerTools(scope.tools);
	const sources = parseWorkerSources(scope.sources);
	if (
		dispatch.tools.some((requested) => !tools.some((allowed) => workerSame(requested, allowed))) ||
		dispatch.context.sources.some((requested) => !sources.some((allowed) => workerSame(requested, allowed)))
	) {
		throw new WorkerContractError("Worker dispatch exceeds its delegated scope");
	}
	// Construct every field. No parent transcript, provider session, environment,
	// filesystem root, secret, ambient tools, or credential handle is copied.
	return {
		schema: WORKER_CONTEXT_SCHEMA,
		species: "in-house",
		workerId: dispatch.workerId,
		parentRunId: dispatch.parent.runId,
		todo: dispatch.todo,
		runtimeBundleVersion: dispatch.parent.runtimeBundleVersion,
		goal: dispatch.goal,
		definitionOfDone: dispatch.definitionOfDone,
		context: dispatch.context,
		tools: dispatch.tools,
		output: dispatch.destination,
		cancellation: dispatch.cancellation,
		completion: dispatch.completion,
		publicMouth: "forbidden",
		resultTrust: "untrusted-worker-data",
	};
}

/** Call from the worker's tool router as well as omitting the public mouth at composition. */
export function assertWorkerToolAllowed(
	context: WorkerBlankContext,
	name: string,
	schemaVersion: string,
): WorkerToolReference {
	const tools = parseWorkerTools(context.tools);
	const tool = tools.find((tool) => tool.name === name && tool.schemaVersion === schemaVersion);
	if (context.publicMouth !== "forbidden" || !tool)
		throw new WorkerContractError("Tool is unavailable to this private worker");
	return tool;
}

export interface WorkerRunRequest {
	schema: typeof WORKER_RUN_COMMAND_SCHEMA;
	guard: WorkerEffectGuard;
	dispatch: WorkerDispatch;
	command: Pick<WorkerCommand, "key" | "kind" | "epoch" | "sequence" | "text" | "sources" | "resumeCompletionId">;
	execution: WorkerExecutionIdentity | null;
	/** Blank on first dispatch; a follow-up only adds its explicit bounded input. */
	context: WorkerBlankContext | null;
}

export interface WorkerCommandReceipt {
	schema: "qorpera.worker-command-receipt/v1";
	workerId: string;
	commandKey: string;
	inputSha256: string;
	receiptId: string;
	status: "admitted" | "stopped";
	execution: WorkerExecutionIdentity | null;
}

export type WorkerLookup<T> =
	| { state: "confirmed"; receipt: T }
	| { state: "not-started"; reconciliationReceiptId: string }
	| { state: "uncertain" };

/**
 * Existing cloud run admission/receipts/commands, not a second agent engine.
 * submit returns admission, never awaits a model. Stable command identity must
 * dedupe atomically, even across simultaneous callers and process restarts.
 * Every effect rechecks guard, current delegation, sponsor and cancellation.
 * A cancel fences the logical worker even if its admission is still in flight;
 * "stopped" additionally proves actual execution drain. No fallback sponsor.
 * A blocked result closes one checkpoint, not the logical worker stream. Only
 * an explicit follow-up naming resumeCompletionId may continue it, with the
 * same execution identity and live grant. Reject unsupported v2 continuity;
 * never substitute a new run, stream, worker, sponsor or broadened context.
 */
export interface WorkerRunPort {
	submit(request: WorkerRunRequest, signal: AbortSignal): Promise<WorkerCommandReceipt>;
	/** Mere absence is uncertain. not-started requires durable proof that no previous sender can still act. */
	lookup(request: WorkerRunRequest, signal: AbortSignal): Promise<WorkerLookup<WorkerCommandReceipt>>;
	inspect(
		guard: WorkerEffectGuard,
		execution: WorkerExecutionIdentity,
		signal: AbortSignal,
	): Promise<{ state: "active" } | { state: "terminal"; result: WorkerResult } | { state: "uncertain" }>;
	/** Authenticate the existing child completion and every Company File/proposal receipt, not its text. */
	verifyResult(guard: WorkerEffectGuard, result: WorkerResult, signal: AbortSignal): Promise<void>;
}

export interface WorkerContinuationReceipt {
	schema: "qorpera.worker-continuation-receipt/v1";
	intentId: string;
	parentRunId: string;
	todoId: string;
	workerId: string;
	completionId: string;
	receiptId: string;
}

/**
 * Reuse the existing wake/continuation queue. Admission and consumption both
 * recheck the immutable parent target, live authority and current worker fence.
 * Never append a user_message, call the mouth, or choose a replacement parent.
 */
export interface WorkerContinuationPort {
	submit(
		guard: WorkerEffectGuard,
		intent: WorkerContinuation,
		signal: AbortSignal,
	): Promise<WorkerContinuationReceipt>;
	lookup(
		guard: WorkerEffectGuard,
		intent: WorkerContinuation,
		signal: AbortSignal,
	): Promise<WorkerLookup<WorkerContinuationReceipt>>;
}

/** Changing the CAS revision on reconciliation cannot invent new logical work. */
export function workerRunRequestDigest(request: WorkerRunRequest): string {
	return workerDigest({ schema: request.schema, dispatch: request.dispatch, command: request.command });
}
