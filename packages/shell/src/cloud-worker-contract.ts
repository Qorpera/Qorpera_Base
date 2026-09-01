import { createHash } from "node:crypto";

export const WORKER_DISPATCH_SCHEMA = "qorpera.worker-dispatch/v2";
export const WORKER_RESULT_SCHEMA = "qorpera.worker-result/v1";
export const WORKER_TODO_SCHEMA = "qorpera.worker-todo/v2";
export const WORKER_HANDLE_SCHEMA = "qorpera.worker-handle/v2";
export const WORKER_CONTINUATION_SCHEMA = "qorpera.worker-continuation/v1";
export const WORKER_CONTEXT_SCHEMA = "qorpera.worker-context/v2";
export const WORKER_RUN_COMMAND_SCHEMA = "qorpera.worker-run-command/v2";
export const WORKER_TODO_MAX_BYTES = 32 * 1024;
export const WORKER_MAX_HANDLES = 8;
export const WORKER_MAX_COMMANDS = 24;

// Byte-accounting placeholders only. Never persisted or submitted as identities.
const CAPACITY_UUID = "00000000-0000-4000-8000-000000000000";
const CAPACITY_KEY = "k".repeat(96);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
// Private coworker delivery is still not a worker's parent-only reporting channel.
const FORBIDDEN_WORKER_TOOLS = new Set([
	"send",
	"send_message",
	"send_agent_message",
	"send_coworker_message",
	"delegate_to_staff",
	"worker_dispatch",
]);

/** Logical Company File identity, never an object-store URL or a machine path. */
export interface WorkerTodoIdentity {
	companyId: string;
	environmentId: string;
	todoId: string;
	path: string;
}

/** An immutable revival target, not a credential or permission to restart a run. */
export interface WorkerParentIdentity {
	runId: string;
	staffAgentId: string;
	sessionId: string | null;
	requesterUserId: string;
	runtimeBundleVersion: string;
}

export interface WorkerGrantReference {
	id: string;
	version: number;
}

export interface WorkerSourceReference {
	objectId: string;
	path: string;
	version: string;
}

/** The cloud catalog must resolve each grant's exact resource and effect class. */
export interface WorkerToolReference {
	name: string;
	schemaVersion: string;
	grant: WorkerGrantReference;
	effect: "read" | "company-file" | "external";
	audience: "private";
}

export interface WorkerDispatch {
	schema: typeof WORKER_DISPATCH_SCHEMA;
	species: "in-house";
	workerId: string;
	operationKey: string;
	todo: WorkerTodoIdentity;
	parent: WorkerParentIdentity;
	goal: string;
	definitionOfDone: string[];
	context: { mode: "blank"; text: string; sources: WorkerSourceReference[] };
	delegation: WorkerGrantReference;
	tools: WorkerToolReference[];
	destination: {
		kind: "todo-accepted-results";
		todoId: string;
		path: string;
		/** Canonical UTF-8 JSON bytes for the entire result envelope, including references. */
		maxResultBytes: number;
	};
	cancellation: { onParentEnd: "cancel" | "retain-grant"; lateResult: "ignore" };
	completion: { kind: "private-parent"; acceptance: "explicit-parent"; onBlocked: "parent-followup" };
}

export interface WorkerExecutionIdentity {
	runId: string;
	streamId: string;
}

export interface WorkerResult {
	schema: typeof WORKER_RESULT_SCHEMA;
	species: "in-house";
	completionId: string;
	receiptId: string;
	workerId: string;
	todo: WorkerTodoIdentity;
	parentRunId: string;
	execution: WorkerExecutionIdentity;
	delegation: WorkerGrantReference;
	epoch: number;
	sequence: number;
	outcome: "succeeded" | "blocked" | "failed";
	summary: string;
	work:
		| { kind: "no-change"; reason: string; evidence: WorkerSourceReference[] }
		| { kind: "company-file"; outputs: WorkerSourceReference[]; receiptIds: string[] }
		| { kind: "proposal"; proposalId: string; receiptId: string; sources: WorkerSourceReference[] };
}

export type WorkerDeliveryState = "pending" | "inflight" | "uncertain" | "confirmed";

export interface WorkerCommand {
	key: string;
	kind: "dispatch" | "followup" | "cancel";
	epoch: number;
	sequence: number;
	text: string;
	sources: WorkerSourceReference[];
	/** Explicit parent acknowledgement of the blocked checkpoint being continued. */
	resumeCompletionId: string | null;
	delivery: WorkerDeliveryState;
	receiptId: string | null;
}

/** Private internal input. No text, human author, credentials, or public destination. */
export interface WorkerContinuation {
	schema: typeof WORKER_CONTINUATION_SCHEMA;
	intentId: string;
	kind: "worker-result";
	audience: "parent-private";
	todo: WorkerTodoIdentity;
	parent: WorkerParentIdentity;
	workerId: string;
	completionId: string;
	delegation: WorkerGrantReference;
	epoch: number;
	sequence: number;
	delivery: WorkerDeliveryState | "suppressed";
	receiptId: string | null;
}

export type WorkerPhase =
	| "pending"
	| "running"
	| "reconciling"
	| "succeeded"
	| "blocked"
	| "failed"
	| "cancelled"
	| "revoked";

export interface WorkerHandle {
	schema: typeof WORKER_HANDLE_SCHEMA;
	dispatch: WorkerDispatch;
	epoch: number;
	sequence: number;
	phase: WorkerPhase;
	execution: WorkerExecutionIdentity | null;
	commands: WorkerCommand[];
	/** Immutable blocked checkpoints. Their old private intents remain suppressed. */
	history: { result: WorkerResult; continuation: WorkerContinuation }[];
	result: WorkerResult | null;
	continuation: WorkerContinuation | null;
}

export interface WorkerAcceptedResult {
	workerId: string;
	operationKey: string;
	acceptedByRunId: string;
	result: WorkerResult;
}

/** One atomic Company File object, not a parallel task table. */
export interface WorkerTodo {
	schema: typeof WORKER_TODO_SCHEMA;
	identity: WorkerTodoIdentity;
	parent: WorkerParentIdentity;
	revision: number;
	state: "open" | "done" | "cancelled";
	goal: string;
	definitionOfDone: string[];
	sources: WorkerSourceReference[];
	workers: WorkerHandle[];
	acceptedResults: WorkerAcceptedResult[];
}

export class WorkerContractError extends Error {
	constructor(message = "Invalid worker contract") {
		super(message);
	}
}

export function workerRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
		Reflect.ownKeys(value).length !== keys.length ||
		Object.keys(value).sort().join() !== [...keys].sort().join() ||
		Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !("value" in descriptor))
	)
		throw new WorkerContractError();
	return value as Record<string, unknown>;
}

export function workerUuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new WorkerContractError("Invalid worker identity");
	return value;
}

export function workerKey(value: unknown): string {
	if (typeof value !== "string" || !KEY.test(value)) throw new WorkerContractError("Invalid worker operation key");
	return value;
}

function text(value: unknown, max: number, empty = false): string {
	if (
		typeof value !== "string" ||
		(!empty && !value.trim()) ||
		value.includes("\0") ||
		Buffer.byteLength(value) > max ||
		Buffer.from(value).toString("utf8") !== value
	)
		throw new WorkerContractError();
	return value;
}

export function workerPath(value: unknown): string {
	const path = text(value, 1024);
	// Deliberately narrower than the gateway's portable-path rules. Never normalize aliases.
	if (
		!/^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/.test(path) ||
		path
			.split("/")
			.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					part.endsWith(".") ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
			)
	) {
		throw new WorkerContractError("Invalid worker Company File path");
	}
	return path;
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
		throw new WorkerContractError();
	return value as number;
}

function choice<const Values extends readonly string[]>(value: unknown, allowed: Values): Values[number] {
	if (typeof value !== "string" || !allowed.includes(value)) throw new WorkerContractError();
	return value as Values[number];
}

function list(value: unknown, max: number, min = 0): unknown[] {
	if (
		!Array.isArray(value) ||
		value.length < min ||
		value.length > max ||
		Reflect.ownKeys(value).length !== value.length + 1 ||
		Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).some(
			(descriptor) => !descriptor || !("value" in descriptor),
		)
	)
		throw new WorkerContractError();
	return value;
}

function version(value: unknown): string {
	if (typeof value !== "string" || !VERSION.test(value)) throw new WorkerContractError();
	return value;
}

export function parseWorkerTodoIdentity(value: unknown): WorkerTodoIdentity {
	const input = workerRecord(value, ["companyId", "environmentId", "todoId", "path"]);
	return {
		companyId: workerUuid(input.companyId),
		environmentId: workerUuid(input.environmentId),
		todoId: workerUuid(input.todoId),
		path: workerPath(input.path),
	};
}

export function parseWorkerParent(value: unknown): WorkerParentIdentity {
	const input = workerRecord(value, ["runId", "staffAgentId", "sessionId", "requesterUserId", "runtimeBundleVersion"]);
	return {
		runId: workerUuid(input.runId),
		staffAgentId: workerUuid(input.staffAgentId),
		sessionId: input.sessionId === null ? null : workerUuid(input.sessionId),
		requesterUserId: workerUuid(input.requesterUserId),
		runtimeBundleVersion: version(input.runtimeBundleVersion),
	};
}

export function parseWorkerGrant(value: unknown): WorkerGrantReference {
	const input = workerRecord(value, ["id", "version"]);
	return { id: workerUuid(input.id), version: integer(input.version, 1) };
}

export function parseWorkerSources(value: unknown): WorkerSourceReference[] {
	const sources = list(value, 16).map((value) => {
		const input = workerRecord(value, ["objectId", "path", "version"]);
		return { objectId: workerUuid(input.objectId), path: workerPath(input.path), version: workerUuid(input.version) };
	});
	if (new Set(sources.map((source) => source.path)).size !== sources.length)
		throw new WorkerContractError("Duplicate source path");
	return sources;
}

export function parseWorkerTools(value: unknown): WorkerToolReference[] {
	const tools = list(value, 16).map((value): WorkerToolReference => {
		const input = workerRecord(value, ["name", "schemaVersion", "grant", "effect", "audience"]);
		const effect = choice(input.effect, ["read", "company-file", "external"]);
		if (
			typeof input.name !== "string" ||
			!/^[a-z][a-z0-9_]{0,63}$/.test(input.name) ||
			FORBIDDEN_WORKER_TOOLS.has(input.name) ||
			input.audience !== "private"
		) {
			throw new WorkerContractError("Worker tools must have no public mouth or delegation surface");
		}
		return {
			name: input.name,
			schemaVersion: version(input.schemaVersion),
			grant: parseWorkerGrant(input.grant),
			effect,
			audience: "private",
		};
	});
	if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
		throw new WorkerContractError("Duplicate worker tool");
	return tools;
}

export function parseWorkerDispatch(value: unknown): WorkerDispatch {
	const input = workerRecord(value, [
		"schema",
		"species",
		"workerId",
		"operationKey",
		"todo",
		"parent",
		"goal",
		"definitionOfDone",
		"context",
		"delegation",
		"tools",
		"destination",
		"cancellation",
		"completion",
	]);
	const context = workerRecord(input.context, ["mode", "text", "sources"]);
	const destination = workerRecord(input.destination, ["kind", "todoId", "path", "maxResultBytes"]);
	const cancellation = workerRecord(input.cancellation, ["onParentEnd", "lateResult"]);
	const completion = workerRecord(input.completion, ["kind", "acceptance", "onBlocked"]);
	const todo = parseWorkerTodoIdentity(input.todo);
	if (
		input.schema !== WORKER_DISPATCH_SCHEMA ||
		input.species !== "in-house" ||
		context.mode !== "blank" ||
		destination.kind !== "todo-accepted-results" ||
		destination.todoId !== todo.todoId ||
		destination.path !== todo.path ||
		(cancellation.onParentEnd !== "cancel" && cancellation.onParentEnd !== "retain-grant") ||
		cancellation.lateResult !== "ignore" ||
		completion.kind !== "private-parent" ||
		completion.acceptance !== "explicit-parent" ||
		completion.onBlocked !== "parent-followup"
	)
		throw new WorkerContractError();
	const dispatch: WorkerDispatch = {
		schema: WORKER_DISPATCH_SCHEMA,
		species: "in-house",
		workerId: workerUuid(input.workerId),
		operationKey: workerKey(input.operationKey),
		todo,
		parent: parseWorkerParent(input.parent),
		goal: text(input.goal, 1024),
		definitionOfDone: list(input.definitionOfDone, 8, 1).map((item) => text(item, 256)),
		context: { mode: "blank", text: text(context.text, 4096, true), sources: parseWorkerSources(context.sources) },
		delegation: parseWorkerGrant(input.delegation),
		tools: parseWorkerTools(input.tools),
		destination: {
			kind: "todo-accepted-results",
			todoId: todo.todoId,
			path: todo.path,
			maxResultBytes: integer(destination.maxResultBytes, 1, WORKER_TODO_MAX_BYTES),
		},
		cancellation: { onParentEnd: cancellation.onParentEnd, lateResult: "ignore" },
		completion: { kind: "private-parent", acceptance: "explicit-parent", onBlocked: "parent-followup" },
	};
	// Even the smallest terminal envelope must fit at the final allowed sequence.
	// Larger summaries/artifacts must obey the explicit budget, not consume another worker's reserve.
	assertWorkerResultBudget(dispatch, {
		schema: WORKER_RESULT_SCHEMA,
		species: "in-house",
		completionId: CAPACITY_UUID,
		receiptId: CAPACITY_UUID,
		workerId: dispatch.workerId,
		todo,
		parentRunId: dispatch.parent.runId,
		execution: { runId: CAPACITY_UUID, streamId: CAPACITY_UUID },
		delegation: dispatch.delegation,
		epoch: 1,
		sequence: WORKER_MAX_COMMANDS,
		outcome: "succeeded",
		summary: "x",
		work: { kind: "no-change", reason: "x", evidence: [] },
	});
	return dispatch;
}

export function parseWorkerExecution(value: unknown): WorkerExecutionIdentity {
	const input = workerRecord(value, ["runId", "streamId"]);
	return { runId: workerUuid(input.runId), streamId: workerUuid(input.streamId) };
}

export function parseWorkerResult(value: unknown): WorkerResult {
	const input = workerRecord(value, [
		"schema",
		"species",
		"completionId",
		"receiptId",
		"workerId",
		"todo",
		"parentRunId",
		"execution",
		"delegation",
		"epoch",
		"sequence",
		"outcome",
		"summary",
		"work",
	]);
	const outcome = choice(input.outcome, ["succeeded", "blocked", "failed"]);
	if (input.schema !== WORKER_RESULT_SCHEMA || input.species !== "in-house") throw new WorkerContractError();
	const kind = (input.work as { kind?: unknown } | null)?.kind;
	let work: WorkerResult["work"];
	if (kind === "no-change") {
		const data = workerRecord(input.work, ["kind", "reason", "evidence"]);
		work = { kind, reason: text(data.reason, 1024), evidence: parseWorkerSources(data.evidence) };
	} else if (kind === "company-file") {
		const data = workerRecord(input.work, ["kind", "outputs", "receiptIds"]);
		const outputs = parseWorkerSources(data.outputs);
		const receiptIds = list(data.receiptIds, 16, 1).map(workerUuid);
		if (!outputs.length || new Set(receiptIds).size !== receiptIds.length) throw new WorkerContractError();
		work = { kind, outputs, receiptIds };
	} else if (kind === "proposal") {
		const data = workerRecord(input.work, ["kind", "proposalId", "receiptId", "sources"]);
		work = {
			kind,
			proposalId: workerUuid(data.proposalId),
			receiptId: workerUuid(data.receiptId),
			sources: parseWorkerSources(data.sources),
		};
	} else throw new WorkerContractError();
	return {
		schema: WORKER_RESULT_SCHEMA,
		species: "in-house",
		completionId: workerUuid(input.completionId),
		receiptId: workerUuid(input.receiptId),
		workerId: workerUuid(input.workerId),
		todo: parseWorkerTodoIdentity(input.todo),
		parentRunId: workerUuid(input.parentRunId),
		execution: parseWorkerExecution(input.execution),
		delegation: parseWorkerGrant(input.delegation),
		epoch: integer(input.epoch, 1),
		sequence: integer(input.sequence, 0, WORKER_MAX_COMMANDS),
		outcome,
		summary: text(input.summary, 2048),
		work,
	};
}

export function assertWorkerResultBudget(dispatch: WorkerDispatch, result: WorkerResult): void {
	if (Buffer.byteLength(workerCanonicalJson(result)) > dispatch.destination.maxResultBytes)
		throw new WorkerContractError("Worker result exceeds its dispatch byte budget");
}

function delivery(value: unknown): WorkerDeliveryState {
	return choice(value, ["pending", "inflight", "uncertain", "confirmed"]);
}

function command(value: unknown): WorkerCommand {
	const input = workerRecord(value, [
		"key",
		"kind",
		"epoch",
		"sequence",
		"text",
		"sources",
		"resumeCompletionId",
		"delivery",
		"receiptId",
	]);
	const kind = choice(input.kind, ["dispatch", "followup", "cancel"]);
	const result: WorkerCommand = {
		key: workerKey(input.key),
		kind,
		epoch: integer(input.epoch, 1),
		sequence: integer(input.sequence, 0, WORKER_MAX_COMMANDS),
		text: text(input.text, 2048, kind !== "followup"),
		sources: parseWorkerSources(input.sources),
		resumeCompletionId: input.resumeCompletionId === null ? null : workerUuid(input.resumeCompletionId),
		delivery: delivery(input.delivery),
		receiptId: input.receiptId === null ? null : workerUuid(input.receiptId),
	};
	if (
		(result.delivery === "confirmed") !== (result.receiptId !== null) ||
		(result.kind !== "followup" &&
			(result.text !== "" || result.sources.length || result.resumeCompletionId !== null))
	)
		throw new WorkerContractError();
	return result;
}

export function parseWorkerContinuation(value: unknown): WorkerContinuation {
	const input = workerRecord(value, [
		"schema",
		"intentId",
		"kind",
		"audience",
		"todo",
		"parent",
		"workerId",
		"completionId",
		"delegation",
		"epoch",
		"sequence",
		"delivery",
		"receiptId",
	]);
	if (
		input.schema !== WORKER_CONTINUATION_SCHEMA ||
		input.kind !== "worker-result" ||
		input.audience !== "parent-private"
	)
		throw new WorkerContractError();
	const result: WorkerContinuation = {
		schema: WORKER_CONTINUATION_SCHEMA,
		intentId: workerUuid(input.intentId),
		kind: "worker-result",
		audience: "parent-private",
		todo: parseWorkerTodoIdentity(input.todo),
		parent: parseWorkerParent(input.parent),
		workerId: workerUuid(input.workerId),
		completionId: workerUuid(input.completionId),
		delegation: parseWorkerGrant(input.delegation),
		epoch: integer(input.epoch, 1),
		sequence: integer(input.sequence, 0, WORKER_MAX_COMMANDS),
		delivery: input.delivery === "suppressed" ? "suppressed" : delivery(input.delivery),
		receiptId: input.receiptId === null ? null : workerUuid(input.receiptId),
	};
	if (
		(result.delivery === "confirmed" && result.receiptId === null) ||
		(!["confirmed", "suppressed"].includes(result.delivery) && result.receiptId !== null)
	)
		throw new WorkerContractError();
	return result;
}

export function workerSame(left: unknown, right: unknown): boolean {
	return workerCanonicalJson(left) === workerCanonicalJson(right);
}

/** Reject lossy JSON values rather than silently dropping authority-bearing fields. */
export function workerCanonicalJson(value: unknown): string {
	const active = new Set<object>();
	const encode = (value: unknown, depth: number): string => {
		if (depth > 32) throw new WorkerContractError();
		if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
		if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
		if (typeof value !== "object" || !value || active.has(value)) throw new WorkerContractError();
		active.add(value);
		let result: string;
		if (Array.isArray(value))
			result = `[${list(value, WORKER_TODO_MAX_BYTES)
				.map((child) => encode(child, depth + 1))
				.join(",")}]`;
		else {
			workerRecord(value, Object.keys(value));
			result = `{${Object.keys(value)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], depth + 1)}`)
				.join(",")}}`;
		}
		active.delete(value);
		return result;
	};
	return encode(value, 0);
}

export function workerDigest(value: unknown): string {
	return createHash("sha256").update(workerCanonicalJson(value)).digest("hex");
}

export function workerStableId(value: unknown): string {
	const hash = workerDigest(value);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function workerIsTerminal(phase: WorkerPhase): boolean {
	return ["succeeded", "blocked", "failed", "cancelled", "revoked"].includes(phase);
}

/** Shared construction keeps the reserved continuation envelope equal to the real one. */
export function createWorkerContinuation(
	result: Pick<WorkerResult, "todo" | "workerId" | "completionId" | "delegation" | "epoch" | "sequence">,
	parent: WorkerParentIdentity,
): WorkerContinuation {
	return {
		schema: WORKER_CONTINUATION_SCHEMA,
		intentId: workerStableId([WORKER_CONTINUATION_SCHEMA, result.todo, result.workerId, result.completionId]),
		kind: "worker-result",
		audience: "parent-private",
		todo: result.todo,
		parent,
		workerId: result.workerId,
		completionId: result.completionId,
		delegation: result.delegation,
		epoch: result.epoch,
		sequence: result.sequence,
		delivery: "pending",
		receiptId: null,
	};
}

/**
 * Size a future-complete aggregate, never a state transition. Reserve both copies
 * of every possible successful result, the private intent, all outstanding receipt
 * acknowledgements, one maximum-key cancellation per live handle, and revision
 * growth. Capacity is consumed at dispatch/follow-up, not after a child has acted.
 */
function reservedTodoBytes(todo: WorkerTodo): number {
	const acceptedResults: (Omit<WorkerAcceptedResult, "result"> & { result: WorkerResult | null })[] = [
		...todo.acceptedResults,
	];
	let futureResultBytes = 0;
	const workers = todo.workers.map((worker) => {
		const fenced = worker.phase === "cancelled" || worker.phase === "revoked";
		const commands = worker.commands.map((command) => ({
			...command,
			delivery: "confirmed" as const,
			receiptId: CAPACITY_UUID,
		}));
		if (!fenced) {
			commands.push({
				key: CAPACITY_KEY,
				kind: "cancel",
				epoch: 2,
				sequence: worker.sequence,
				text: "",
				sources: [],
				resumeCompletionId: null,
				delivery: "confirmed",
				receiptId: CAPACITY_UUID,
			});
			if (!worker.result) futureResultBytes += worker.dispatch.destination.maxResultBytes - 4; // Replaces null.
			if (
				(!worker.result || worker.result.outcome === "succeeded") &&
				!acceptedResults.some((accepted) => accepted.workerId === worker.dispatch.workerId)
			) {
				acceptedResults.push({
					workerId: worker.dispatch.workerId,
					operationKey: CAPACITY_KEY,
					acceptedByRunId: CAPACITY_UUID,
					result: worker.result,
				});
				if (!worker.result) futureResultBytes += worker.dispatch.destination.maxResultBytes - 4;
			}
		}
		const continuation =
			worker.continuation ??
			(fenced
				? null
				: createWorkerContinuation(
						{
							todo: todo.identity,
							workerId: worker.dispatch.workerId,
							completionId: CAPACITY_UUID,
							delegation: worker.dispatch.delegation,
							epoch: 1,
							sequence: worker.sequence,
						},
						todo.parent,
					));
		return {
			...worker,
			phase: "reconciling", // Longest phase; cancellation must remain writable even after completion.
			execution: worker.execution ?? { runId: CAPACITY_UUID, streamId: CAPACITY_UUID },
			commands,
			continuation: continuation ? { ...continuation, delivery: "suppressed", receiptId: CAPACITY_UUID } : null,
		};
	});
	return (
		Buffer.byteLength(
			workerCanonicalJson({
				...todo,
				revision: Number.MAX_SAFE_INTEGER,
				state: "cancelled",
				workers,
				acceptedResults,
			}),
		) + futureResultBytes
	);
}

export function parseWorkerTodo(value: unknown): WorkerTodo {
	const encodedBytes = Buffer.byteLength(workerCanonicalJson(value));
	if (encodedBytes > WORKER_TODO_MAX_BYTES) throw new WorkerContractError("Worker todo byte budget exceeded");
	const input = workerRecord(value, [
		"schema",
		"identity",
		"parent",
		"revision",
		"state",
		"goal",
		"definitionOfDone",
		"sources",
		"workers",
		"acceptedResults",
	]);
	const state = choice(input.state, ["open", "done", "cancelled"]);
	if (input.schema !== WORKER_TODO_SCHEMA) throw new WorkerContractError();
	const identity = parseWorkerTodoIdentity(input.identity);
	const parent = parseWorkerParent(input.parent);
	const workers = list(input.workers, WORKER_MAX_HANDLES).map((value): WorkerHandle => {
		const input = workerRecord(value, [
			"schema",
			"dispatch",
			"epoch",
			"sequence",
			"phase",
			"execution",
			"commands",
			"history",
			"result",
			"continuation",
		]);
		const phase = choice(input.phase, [
			"pending",
			"running",
			"reconciling",
			"succeeded",
			"blocked",
			"failed",
			"cancelled",
			"revoked",
		]);
		if (input.schema !== WORKER_HANDLE_SCHEMA) throw new WorkerContractError();
		const dispatch = parseWorkerDispatch(input.dispatch);
		const handle: WorkerHandle = {
			schema: WORKER_HANDLE_SCHEMA,
			dispatch,
			epoch: integer(input.epoch, 1),
			sequence: integer(input.sequence, 0, WORKER_MAX_COMMANDS),
			phase,
			execution: input.execution === null ? null : parseWorkerExecution(input.execution),
			commands: list(input.commands, WORKER_MAX_COMMANDS, 1).map(command),
			history: list(input.history, WORKER_MAX_COMMANDS - 2).map((value) => {
				const checkpoint = workerRecord(value, ["result", "continuation"]);
				return {
					result: parseWorkerResult(checkpoint.result),
					continuation: parseWorkerContinuation(checkpoint.continuation),
				};
			}),
			result: input.result === null ? null : parseWorkerResult(input.result),
			continuation: input.continuation === null ? null : parseWorkerContinuation(input.continuation),
		};
		if (
			!workerSame(dispatch.todo, identity) ||
			!workerSame(dispatch.parent, parent) ||
			handle.commands[0].kind !== "dispatch" ||
			handle.commands[0].key !== dispatch.operationKey ||
			handle.commands[0].epoch !== 1 ||
			handle.commands[0].sequence !== 0 ||
			new Set(handle.commands.map((item) => item.key)).size !== handle.commands.length
		)
			throw new WorkerContractError("Worker handle identity differs");
		const followups = handle.commands.filter((item) => item.kind === "followup");
		const cancelled = handle.phase === "cancelled" || handle.phase === "revoked";
		const cancellations = handle.commands.filter((item) => item.kind === "cancel");
		if (
			(!cancelled && handle.commands.length >= WORKER_MAX_COMMANDS) ||
			followups.length !== handle.sequence ||
			followups.some((item, index) => item.sequence !== index + 1 || item.epoch !== 1) ||
			handle.commands.slice(1).some((item) => item.kind === "dispatch") ||
			cancellations.length !== (cancelled ? 1 : 0) ||
			handle.epoch !== (cancelled ? 2 : 1) ||
			(cancelled &&
				(handle.commands.at(-1) !== cancellations[0] ||
					cancellations[0].epoch !== handle.epoch ||
					cancellations[0].sequence !== handle.sequence)) ||
			(handle.execution === null && (handle.commands[0].delivery === "confirmed" || handle.phase === "running")) ||
			(handle.phase === "pending" && handle.execution !== null) ||
			(handle.execution !== null &&
				(handle.execution.runId === parent.runId || handle.execution.streamId === parent.sessionId))
		)
			throw new WorkerContractError();
		if (handle.result && (handle.result.sequence !== handle.sequence || !workerIsTerminal(handle.phase)))
			throw new WorkerContractError("Worker result binding differs");
		if (
			["succeeded", "blocked", "failed"].includes(handle.phase) &&
			(!handle.result ||
				!handle.continuation ||
				handle.result.outcome !== handle.phase ||
				handle.result.epoch !== handle.epoch)
		)
			throw new WorkerContractError();
		if (!handle.result && handle.continuation) throw new WorkerContractError();
		const checkpoints = [
			...handle.history,
			...(handle.result ? [{ result: handle.result, continuation: handle.continuation }] : []),
		];
		for (const { result, continuation } of checkpoints) {
			assertWorkerResultBudget(dispatch, result);
			if (
				result.workerId !== dispatch.workerId ||
				!workerSame(result.todo, identity) ||
				result.parentRunId !== parent.runId ||
				!workerSame(result.execution, handle.execution) ||
				!workerSame(result.delegation, dispatch.delegation) ||
				result.epoch !== 1 ||
				result.sequence > handle.sequence ||
				handle.commands.some(
					(item) => item.kind !== "cancel" && item.sequence <= result.sequence && item.delivery !== "confirmed",
				) ||
				!continuation ||
				!workerSame(
					{ ...continuation, delivery: "pending", receiptId: null },
					createWorkerContinuation(result, parent),
				)
			)
				throw new WorkerContractError("Worker checkpoint binding differs");
		}
		if (
			new Set(checkpoints.map((item) => item.result.completionId)).size !== checkpoints.length ||
			new Set(checkpoints.map((item) => item.result.receiptId)).size !== checkpoints.length ||
			followups.filter((item) => item.resumeCompletionId !== null).length !== handle.history.length ||
			handle.history.some(
				({ result, continuation }, index) =>
					result.outcome !== "blocked" ||
					result.sequence >= handle.sequence ||
					(index > 0 && result.sequence <= handle.history[index - 1].result.sequence) ||
					continuation.delivery !== "suppressed" ||
					!followups.some(
						(item) => item.sequence === result.sequence + 1 && item.resumeCompletionId === result.completionId,
					),
			)
		)
			throw new WorkerContractError("Worker blocked-continuation history differs");
		if (
			["cancelled", "revoked"].includes(handle.phase) &&
			handle.continuation &&
			handle.continuation.delivery !== "suppressed"
		)
			throw new WorkerContractError();
		return handle;
	});
	if (
		new Set(workers.map((worker) => worker.dispatch.workerId)).size !== workers.length ||
		new Set(workers.map((worker) => worker.dispatch.operationKey)).size !== workers.length ||
		new Set(workers.flatMap((worker) => (worker.execution ? [worker.execution.runId] : []))).size !==
			workers.filter((worker) => worker.execution).length ||
		new Set(workers.flatMap((worker) => (worker.execution ? [worker.execution.streamId] : []))).size !==
			workers.filter((worker) => worker.execution).length
	)
		throw new WorkerContractError("Duplicate worker identity");
	const acceptedResults = list(input.acceptedResults, WORKER_MAX_HANDLES).map((value): WorkerAcceptedResult => {
		const data = workerRecord(value, ["workerId", "operationKey", "acceptedByRunId", "result"]);
		const result = parseWorkerResult(data.result);
		const worker = workers.find((worker) => worker.dispatch.workerId === data.workerId);
		if (!worker?.result || !workerSame(worker.result, result) || result.outcome !== "succeeded")
			throw new WorkerContractError("Accepted result is not a completed worker output");
		return {
			workerId: workerUuid(data.workerId),
			operationKey: workerKey(data.operationKey),
			acceptedByRunId: workerUuid(data.acceptedByRunId),
			result,
		};
	});
	if (
		new Set(acceptedResults.map((item) => item.workerId)).size !== acceptedResults.length ||
		new Set(acceptedResults.map((item) => item.operationKey)).size !== acceptedResults.length
	)
		throw new WorkerContractError();
	if (
		input.state === "done" &&
		(acceptedResults.length === 0 ||
			workers.some(
				(worker) =>
					!workerIsTerminal(worker.phase) ||
					(worker.phase === "succeeded" &&
						!acceptedResults.some((result) => result.workerId === worker.dispatch.workerId)),
			))
	)
		throw new WorkerContractError();
	if (
		input.state === "cancelled" &&
		workers.some((worker) => worker.phase !== "cancelled" && worker.phase !== "revoked")
	)
		throw new WorkerContractError();
	const todo: WorkerTodo = {
		schema: WORKER_TODO_SCHEMA,
		identity,
		parent,
		revision: integer(input.revision, 1),
		state,
		goal: text(input.goal, 1024),
		definitionOfDone: list(input.definitionOfDone, 8, 1).map((item) => text(item, 256)),
		sources: parseWorkerSources(input.sources),
		workers,
		acceptedResults,
	};
	if (reservedTodoBytes(todo) > WORKER_TODO_MAX_BYTES)
		throw new WorkerContractError("Worker todo completion/control capacity exhausted");
	return todo;
}

/** Step 9 seam only: continuity is not inferred from a provider session ID. */
export interface CodingWorkerContinuity {
	schema: "qorpera.coding-worker-continuity/v1";
	species: "coding";
	workerId: string;
	todo: WorkerTodoIdentity;
	vmId: string;
	repositoryId: string;
	branch: string;
	completion: { kind: "callback" | "durable-listener"; referenceId: string };
}

export function assertCodingWorkerFollowup(previous: CodingWorkerContinuity, next: CodingWorkerContinuity): void {
	for (const value of [previous, next]) {
		workerRecord(value, ["schema", "species", "workerId", "todo", "vmId", "repositoryId", "branch", "completion"]);
		workerRecord(value.completion, ["kind", "referenceId"]);
		if (
			value.schema !== "qorpera.coding-worker-continuity/v1" ||
			value.species !== "coding" ||
			!["callback", "durable-listener"].includes(value.completion.kind)
		)
			throw new WorkerContractError();
		workerUuid(value.workerId);
		workerUuid(value.vmId);
		workerUuid(value.repositoryId);
		workerUuid(value.completion.referenceId);
		parseWorkerTodoIdentity(value.todo);
		text(value.branch, 256);
	}
	if (!workerSame(previous, next))
		throw new WorkerContractError(
			"Coding follow-up must retain worker, VM, repository, branch and completion channel",
		);
}
