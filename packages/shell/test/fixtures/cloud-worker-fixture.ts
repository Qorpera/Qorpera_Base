import { randomUUID } from "node:crypto";
import {
	parseWorkerDispatch,
	parseWorkerTodo,
	WORKER_DISPATCH_SCHEMA,
	WORKER_RESULT_SCHEMA,
	type WorkerContinuation,
	type WorkerDispatch,
	type WorkerHandle,
	type WorkerParentIdentity,
	type WorkerResult,
	type WorkerTodoIdentity,
	workerCanonicalJson,
	workerSame,
} from "../../src/cloud-worker-contract.ts";
import { InHouseWorkerLifecycle } from "../../src/cloud-worker-lifecycle.ts";
import {
	type WorkerAuthorityPort,
	type WorkerCommandReceipt,
	type WorkerCompanyFilePort,
	type WorkerContinuationPort,
	type WorkerContinuationReceipt,
	type WorkerDelegationScope,
	type WorkerEffectGuard,
	type WorkerRunPort,
	type WorkerRunRequest,
	workerRunRequestDigest,
} from "../../src/cloud-worker-ports.ts";
import { CompanyFileWorkerTodoStore, WorkerTodoConflict } from "../../src/cloud-worker-todo-store.ts";

export const signal: AbortSignal = new AbortController().signal;

export function workerIdentities(): { todo: WorkerTodoIdentity; parent: WorkerParentIdentity } {
	return {
		todo: {
			companyId: randomUUID(),
			environmentId: randomUUID(),
			todoId: randomUUID(),
			path: "work/todos/review.json",
		},
		parent: {
			runId: randomUUID(),
			staffAgentId: randomUUID(),
			sessionId: randomUUID(),
			requesterUserId: randomUUID(),
			runtimeBundleVersion: "runtime-test/v1",
		},
	};
}

export function workerDispatch(todo: WorkerTodoIdentity, parent: WorkerParentIdentity): WorkerDispatch {
	return parseWorkerDispatch({
		schema: WORKER_DISPATCH_SCHEMA,
		species: "in-house",
		workerId: randomUUID(),
		operationKey: randomUUID(),
		todo,
		parent,
		goal: "Review the bounded source and report the evidence",
		definitionOfDone: ["Return a sourced finding"],
		context: {
			mode: "blank",
			text: "Read only the attached work description.",
			sources: [{ objectId: randomUUID(), path: "work/source.md", version: randomUUID() }],
		},
		delegation: { id: randomUUID(), version: 1 },
		tools: [
			{
				name: "company_read",
				schemaVersion: "v1",
				grant: { id: randomUUID(), version: 1 },
				effect: "read",
				audience: "private",
			},
		],
		destination: { kind: "todo-accepted-results", todoId: todo.todoId, path: todo.path, maxResultBytes: 2048 },
		cancellation: { onParentEnd: "cancel", lateResult: "ignore" },
		completion: { kind: "private-parent", acceptance: "explicit-parent", onBlocked: "parent-followup" },
	});
}

export function workerScope(dispatch: WorkerDispatch): WorkerDelegationScope {
	return structuredClone({
		schema: "qorpera.worker-delegation/v1",
		todo: dispatch.todo,
		parent: dispatch.parent,
		workerId: dispatch.workerId,
		delegation: dispatch.delegation,
		parentEnd: dispatch.cancellation.onParentEnd,
		tools: dispatch.tools,
		sources: dispatch.context.sources,
	});
}

export function workerResult(
	worker: WorkerHandle,
	outcome: WorkerResult["outcome"] = "succeeded",
	fillBudget = false,
): WorkerResult {
	if (!worker.execution) throw new Error("Fixture worker is not admitted");
	const result: WorkerResult = {
		schema: WORKER_RESULT_SCHEMA,
		species: "in-house",
		completionId: randomUUID(),
		receiptId: randomUUID(),
		workerId: worker.dispatch.workerId,
		todo: worker.dispatch.todo,
		parentRunId: worker.dispatch.parent.runId,
		execution: worker.execution,
		delegation: worker.dispatch.delegation,
		epoch: worker.epoch,
		sequence: worker.sequence,
		outcome,
		summary: "The source supports no changes.",
		work: {
			kind: "no-change",
			reason: "Review found no corrective work.",
			evidence: worker.dispatch.context.sources,
		},
	};
	if (fillBudget) {
		result.summary = "";
		const remaining = worker.dispatch.destination.maxResultBytes - Buffer.byteLength(workerCanonicalJson(result));
		if (remaining < 1 || remaining > 2048) throw new Error("Fixture result cannot fill this budget with its summary");
		result.summary = "x".repeat(remaining);
	}
	return result;
}

export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Fast race tests only. Durability is separately exercised with real PostgreSQL and object files. */
export class MemoryWorkerFixture {
	readonly todo: WorkerTodoIdentity;
	readonly parent: WorkerParentIdentity;
	text: string | null = null;
	version: string | null = null;
	readonly scopes = new Map<string, WorkerDelegationScope>();
	readonly revoked = new Set<string>();
	parentAllowed = true;
	readonly calls: WorkerRunRequest[] = [];
	readonly receipts = new Map<string, WorkerCommandReceipt>();
	readonly notStarted = new Map<string, string>();
	readonly results = new Map<string, WorkerResult>();
	readonly continuationCalls: WorkerContinuation[] = [];
	readonly continuationReceipts = new Map<string, WorkerContinuationReceipt>();
	uncertainExecution = false;
	beforeCommit?: (guard: WorkerEffectGuard, text: string) => Promise<void>;
	afterCommit?: () => Promise<void>;
	beforeSubmit?: (request: WorkerRunRequest) => Promise<void>;
	afterSubmit?: (request: WorkerRunRequest, receipt: WorkerCommandReceipt) => Promise<void>;
	beforeVerify?: () => Promise<void>;
	beforeContinuation?: () => Promise<void>;
	afterContinuation?: () => Promise<void>;
	readonly authority: WorkerAuthorityPort;
	readonly file: WorkerCompanyFilePort;
	readonly runs: WorkerRunPort;
	readonly continuations: WorkerContinuationPort;

	constructor() {
		({ todo: this.todo, parent: this.parent } = workerIdentities());
		this.authority = {
			assertParent: async (todo, parent, actor) => {
				if (
					!this.parentAllowed ||
					actor !== this.parent.runId ||
					!workerSame(todo, this.todo) ||
					!workerSame(parent, this.parent)
				)
					throw new Error("Parent authority denied");
			},
			resolve: async (dispatch) => {
				if (this.revoked.has(dispatch.workerId)) return null;
				const scope = this.scopes.get(dispatch.workerId);
				if (!scope) throw new Error("Delegation is not configured");
				return structuredClone(scope);
			},
		};
		this.file = {
			read: async (path, offset, limit) => {
				if (this.text === null) return { kind: "absent", path, version: this.version };
				const bytes = Buffer.from(this.text);
				let end = Math.min(bytes.length, offset + limit);
				while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
				return {
					kind: "file",
					path,
					version: this.version,
					offset,
					bytesRead: end - offset,
					totalBytes: bytes.length,
					text: bytes.subarray(offset, end).toString(),
					nextOffset: end === bytes.length ? null : end,
				};
			},
			commit: async (guard, mutation) => {
				await this.beforeCommit?.(guard, mutation.text);
				if (mutation.expectedVersion !== this.version) throw new WorkerTodoConflict();
				this.assertGuard(guard);
				const next = parseWorkerTodo(JSON.parse(mutation.text));
				if (guard.purpose === "dispatch") {
					for (const worker of next.workers) {
						if (this.revoked.has(worker.dispatch.workerId)) throw new Error("Delegation revoked at commit");
					}
				}
				this.text = mutation.text;
				this.version = randomUUID();
				const result = {
					schema: "qorpera.company-path-result/v1",
					state: "applied",
					operationKey: mutation.operationKey,
					path: mutation.path,
					version: this.version,
					snapshotId: randomUUID(),
					receiptId: randomUUID(),
					proposalId: null,
				};
				await this.afterCommit?.();
				return result;
			},
		};
		this.runs = {
			submit: async (request) => {
				this.calls.push(structuredClone(request));
				await this.beforeSubmit?.(request);
				this.assertGuard(request.guard);
				const key = `${request.dispatch.workerId}:${request.command.key}`;
				const previous = this.receipts.get(key);
				if (previous) {
					if (previous.inputSha256 !== workerRunRequestDigest(request)) throw new Error("Command key conflict");
					return structuredClone(previous);
				}
				const admission = [...this.receipts.values()].find(
					(receipt) => receipt.workerId === request.dispatch.workerId && receipt.status === "admitted",
				);
				const receipt: WorkerCommandReceipt = {
					schema: "qorpera.worker-command-receipt/v1",
					workerId: request.dispatch.workerId,
					commandKey: request.command.key,
					inputSha256: workerRunRequestDigest(request),
					receiptId: randomUUID(),
					status: request.command.kind === "cancel" ? "stopped" : "admitted",
					execution:
						admission?.execution ??
						(request.command.kind === "cancel" ? null : { runId: randomUUID(), streamId: randomUUID() }),
				};
				this.receipts.set(key, structuredClone(receipt));
				await this.afterSubmit?.(request, receipt);
				return receipt;
			},
			lookup: async (request) => {
				const key = `${request.dispatch.workerId}:${request.command.key}`;
				const receipt = this.receipts.get(key);
				if (receipt) return { state: "confirmed", receipt: structuredClone(receipt) };
				const proof = this.notStarted.get(key);
				return proof ? { state: "not-started", reconciliationReceiptId: proof } : { state: "uncertain" };
			},
			inspect: async (_guard, execution) => {
				const result = this.results.get(execution.runId);
				return result
					? { state: "terminal", result: structuredClone(result) }
					: { state: this.uncertainExecution ? "uncertain" : "active" };
			},
			verifyResult: async (guard, result) => {
				await this.beforeVerify?.();
				if (this.revoked.has(result.workerId)) throw new Error("Revoked at verification");
				if (
					guard.parent.runId !== result.parentRunId ||
					!workerSame(this.results.get(result.execution.runId) ?? null, result)
				)
					throw new Error("Unknown or modified completion receipt");
			},
		};
		this.continuations = {
			submit: async (guard, intent) => {
				this.continuationCalls.push(structuredClone(intent));
				await this.beforeContinuation?.();
				this.assertGuard(guard);
				const receipt: WorkerContinuationReceipt = this.continuationReceipts.get(intent.intentId) ?? {
					schema: "qorpera.worker-continuation-receipt/v1",
					intentId: intent.intentId,
					parentRunId: intent.parent.runId,
					todoId: intent.todo.todoId,
					workerId: intent.workerId,
					completionId: intent.completionId,
					receiptId: randomUUID(),
				};
				this.continuationReceipts.set(intent.intentId, receipt);
				await this.afterContinuation?.();
				return structuredClone(receipt);
			},
			lookup: async (_guard, intent) => {
				const receipt = this.continuationReceipts.get(intent.intentId);
				return receipt ? { state: "confirmed", receipt: structuredClone(receipt) } : { state: "uncertain" };
			},
		};
	}

	assertGuard(guard: WorkerEffectGuard): void {
		if (
			guard.actorRunId !== this.parent.runId ||
			!workerSame(guard.parent, this.parent) ||
			!workerSame(guard.todo, this.todo)
		)
			throw new Error("Wrong effect principal");
		if (!this.parentAllowed && guard.purpose !== "cancel" && guard.purpose !== "reconcile")
			throw new Error("Parent revoked");
		if (guard.workerId) {
			const worker =
				this.text &&
				parseWorkerTodo(JSON.parse(this.text)).workers.find(
					(worker) => worker.dispatch.workerId === guard.workerId,
				);
			if (!worker && guard.purpose === "dispatch" && guard.epoch === null && guard.sequence === null) {
				if (
					this.revoked.has(guard.workerId) ||
					!workerSame(guard.delegation, this.scopes.get(guard.workerId)?.delegation ?? null)
				)
					throw new Error("New worker grant revoked");
				return;
			}
			if (
				!worker ||
				!workerSame(worker.dispatch.delegation, guard.delegation) ||
				worker.epoch !== guard.epoch ||
				worker.sequence !== guard.sequence
			)
				throw new Error("Worker effect fenced");
			if (
				!["cancel", "reconcile"].includes(guard.purpose) &&
				(this.revoked.has(guard.workerId) || worker.phase === "cancelled" || worker.phase === "revoked")
			)
				throw new Error("Worker effect revoked");
		}
	}

	dispatch(): WorkerDispatch {
		const dispatch = workerDispatch(this.todo, this.parent);
		this.scopes.set(dispatch.workerId, workerScope(dispatch));
		return dispatch;
	}

	lifecycle(actorRunId = this.parent.runId): InHouseWorkerLifecycle {
		return new InHouseWorkerLifecycle({
			store: new CompanyFileWorkerTodoStore(this.todo, this.parent, this.file),
			authority: this.authority,
			runs: this.runs,
			continuations: this.continuations,
			actorRunId,
		});
	}

	async create(): Promise<InHouseWorkerLifecycle> {
		const lifecycle = this.lifecycle();
		await lifecycle.createTodo(
			{ goal: "Review evidence", definitionOfDone: ["Accept findings"], sources: [] },
			"create-todo",
			signal,
		);
		return lifecycle;
	}

	result(worker: WorkerHandle, outcome: WorkerResult["outcome"] = "succeeded", fillBudget = false): WorkerResult {
		const result = workerResult(worker, outcome, fillBudget);
		this.results.set(result.execution.runId, structuredClone(result));
		return result;
	}
}
