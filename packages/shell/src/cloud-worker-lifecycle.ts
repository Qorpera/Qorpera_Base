import {
	assertWorkerResultBudget,
	createWorkerContinuation,
	parseWorkerContinuation,
	parseWorkerDispatch,
	parseWorkerExecution,
	parseWorkerResult,
	parseWorkerSources,
	parseWorkerTodo,
	WORKER_HANDLE_SCHEMA,
	WORKER_MAX_COMMANDS,
	WORKER_MAX_HANDLES,
	WORKER_RUN_COMMAND_SCHEMA,
	WORKER_TODO_SCHEMA,
	type WorkerContinuation,
	WorkerContractError,
	type WorkerDispatch,
	type WorkerHandle,
	type WorkerResult,
	type WorkerTodo,
	workerIsTerminal,
	workerKey,
	workerRecord,
	workerSame,
	workerStableId,
	workerUuid,
} from "./cloud-worker-contract.ts";
import {
	type WorkerAuthorityPort,
	type WorkerCommandReceipt,
	type WorkerContinuationPort,
	type WorkerContinuationReceipt,
	type WorkerEffectGuard,
	type WorkerLookup,
	type WorkerRunPort,
	type WorkerRunRequest,
	workerBlankContext,
	workerRunRequestDigest,
} from "./cloud-worker-ports.ts";
import {
	type CompanyFileWorkerTodoStore,
	WorkerTodoConflict,
	type WorkerTodoSnapshot,
} from "./cloud-worker-todo-store.ts";

export class WorkerReconciliationRequired extends Error {
	constructor() {
		super("Worker outcome is unconfirmed; reconcile its existing operation, do not rerun it");
	}
}

export interface WorkerReconciliationFailure {
	workerId: string;
	error: unknown;
}

/** Other handles have been processed; these failures still need cloud reconciliation. */
export class WorkerReconciliationBatchError extends WorkerReconciliationRequired {
	readonly failures: readonly WorkerReconciliationFailure[];
	constructor(failures: readonly WorkerReconciliationFailure[]) {
		super();
		this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
	}
}

export class WorkerDelegationRevoked extends Error {
	constructor() {
		super("Worker delegation has been revoked");
	}
}

function findWorker(todo: WorkerTodo, workerId: string): WorkerHandle {
	const worker = todo.workers.find((worker) => worker.dispatch.workerId === workerId);
	if (!worker) throw new WorkerContractError("Worker does not belong to this todo");
	return worker;
}

function immutableContinuation(intent: WorkerContinuation) {
	const { delivery: _delivery, receiptId: _receiptId, ...identity } = intent;
	return identity;
}

function fenceWorker(worker: WorkerHandle, phase: "cancelled" | "revoked", key: string): boolean {
	if (worker.phase === "cancelled" || worker.phase === "revoked") return false;
	worker.epoch++;
	worker.phase = phase;
	if (worker.continuation) worker.continuation.delivery = "suppressed";
	worker.commands.push({
		key,
		kind: "cancel",
		epoch: worker.epoch,
		sequence: worker.sequence,
		text: "",
		sources: [],
		resumeCompletionId: null,
		delivery: "pending",
		receiptId: null,
	});
	return true;
}

/**
 * Cloud service component. No provider, process, timer, transcript, credential
 * resolver or execution queue lives here. Each transition commits to one live
 * Company File object; only the existing run/continuation adapters do effects.
 */
export class InHouseWorkerLifecycle {
	readonly #store: CompanyFileWorkerTodoStore;
	readonly #authority: WorkerAuthorityPort;
	readonly #runs: WorkerRunPort;
	readonly #continuations: WorkerContinuationPort;
	readonly #actorRunId: string;

	constructor(options: {
		store: CompanyFileWorkerTodoStore;
		authority: WorkerAuthorityPort;
		runs: WorkerRunPort;
		continuations: WorkerContinuationPort;
		actorRunId: string;
	}) {
		if (
			!options.store ||
			!options.authority ||
			!options.runs ||
			!options.continuations ||
			typeof options.authority.assertParent !== "function" ||
			typeof options.authority.resolve !== "function" ||
			[
				options.runs.submit,
				options.runs.lookup,
				options.runs.inspect,
				options.runs.verifyResult,
				options.continuations.submit,
				options.continuations.lookup,
			].some((method) => typeof method !== "function")
		) {
			throw new WorkerContractError(
				"Cloud worker authority, run, Company File and continuation adapters are required",
			);
		}
		this.#store = options.store;
		this.#authority = options.authority;
		this.#runs = options.runs;
		this.#continuations = options.continuations;
		// Host-bound current parent/authorized continuation run. The Company File
		// adapter validates its relationship to the immutable revival target.
		this.#actorRunId = workerUuid(options.actorRunId);
	}

	async createTodo(
		input: Pick<WorkerTodo, "goal" | "definitionOfDone" | "sources">,
		operationKey: string,
		signal: AbortSignal,
	): Promise<WorkerTodoSnapshot> {
		workerKey(operationKey);
		const value = parseWorkerTodo({
			schema: WORKER_TODO_SCHEMA,
			identity: this.#store.identity,
			parent: this.#store.parent,
			revision: 1,
			state: "open",
			goal: input.goal,
			definitionOfDone: input.definitionOfDone,
			sources: input.sources,
			workers: [],
			acceptedResults: [],
		});
		await this.#assertParent(signal);
		for (let attempt = 0; attempt < 8; attempt++) {
			const existing = await this.#store.read(signal);
			if (existing) {
				if (
					!workerSame(
						[existing.value.goal, existing.value.definitionOfDone, existing.value.sources],
						[value.goal, value.definitionOfDone, value.sources],
					)
				)
					throw new WorkerContractError("Todo identity is bound to other work");
				await this.#assertParent(signal);
				return existing;
			}
			try {
				const snapshot = await this.#store.write(
					null,
					value,
					operationKey,
					{
						actorRunId: this.#actorRunId,
						purpose: "todo",
						workerId: null,
						delegation: null,
						epoch: null,
						sequence: null,
					},
					signal,
				);
				await this.#assertParent(signal);
				return snapshot;
			} catch (error) {
				if (!(error instanceof WorkerTodoConflict)) throw error;
			}
		}
		throw new WorkerTodoConflict();
	}

	async status(signal: AbortSignal): Promise<WorkerTodoSnapshot> {
		await this.#assertParent(signal);
		const snapshot = await this.#read(signal);
		await this.#assertParent(signal);
		return snapshot;
	}

	async dispatch(value: WorkerDispatch, signal: AbortSignal): Promise<WorkerHandle> {
		const dispatch = parseWorkerDispatch(value);
		if (!workerSame(dispatch.todo, this.#store.identity) || !workerSame(dispatch.parent, this.#store.parent))
			throw new WorkerContractError("Dispatch belongs to another parent or todo");
		await this.#assertParent(signal);
		await this.#authorize(dispatch, signal);
		await this.#change(
			`dispatch:${dispatch.operationKey}`,
			"dispatch",
			dispatch.workerId,
			(todo) => {
				const previous = todo.workers.find(
					(worker) =>
						worker.dispatch.workerId === dispatch.workerId ||
						worker.dispatch.operationKey === dispatch.operationKey,
				);
				if (previous) {
					if (!workerSame(previous.dispatch, dispatch))
						throw new WorkerContractError("Worker dispatch identity is bound to different work");
					return { changed: false, result: undefined };
				}
				if (todo.state !== "open" || todo.workers.length >= WORKER_MAX_HANDLES)
					throw new WorkerContractError("Todo is closed or its worker budget is exhausted");
				todo.workers.push({
					schema: WORKER_HANDLE_SCHEMA,
					dispatch,
					epoch: 1,
					sequence: 0,
					phase: "pending",
					execution: null,
					commands: [
						{
							key: dispatch.operationKey,
							kind: "dispatch",
							epoch: 1,
							sequence: 0,
							text: "",
							sources: [],
							resumeCompletionId: null,
							delivery: "pending",
							receiptId: null,
						},
					],
					history: [],
					result: null,
					continuation: null,
				});
				return { changed: true, result: undefined };
			},
			signal,
		);
		await this.#sendCommand(dispatch.workerId, signal);
		return findWorker((await this.status(signal)).value, dispatch.workerId);
	}

	async followup(
		workerId: string,
		input: { operationKey: string; text: string; sources: WorkerDispatch["context"]["sources"] },
		signal: AbortSignal,
	): Promise<WorkerHandle> {
		return this.#followup(workerId, input, null, signal);
	}

	/** Explicit parent input continues one blocked checkpoint; never restores a fenced grant or clones a stream. */
	async resumeBlocked(
		workerId: string,
		input: {
			operationKey: string;
			completionId: string;
			text: string;
			sources: WorkerDispatch["context"]["sources"];
		},
		signal: AbortSignal,
	): Promise<WorkerHandle> {
		workerRecord(input, ["operationKey", "completionId", "text", "sources"]);
		return this.#followup(
			workerId,
			{ operationKey: input.operationKey, text: input.text, sources: input.sources },
			workerUuid(input.completionId),
			signal,
		);
	}

	async #followup(
		workerId: string,
		input: { operationKey: string; text: string; sources: WorkerDispatch["context"]["sources"] },
		resumeCompletionId: string | null,
		signal: AbortSignal,
	): Promise<WorkerHandle> {
		workerUuid(workerId);
		workerRecord(input, ["operationKey", "text", "sources"]);
		const key = workerKey(input.operationKey);
		const sources = parseWorkerSources(input.sources);
		if (
			typeof input.text !== "string" ||
			!input.text.trim() ||
			input.text.includes("\0") ||
			Buffer.byteLength(input.text) > 2048
		)
			throw new WorkerContractError("Follow-up requires bounded explicit context");
		const text = input.text;
		await this.#assertParent(signal);
		const snapshot = await this.#read(signal);
		const before = findWorker(snapshot.value, workerId);
		const scope = await this.#authorize(before.dispatch, signal);
		if (sources.some((source) => !scope.sources.some((allowed) => workerSame(source, allowed))))
			throw new WorkerContractError("Follow-up exceeds delegated read authority");
		if (resumeCompletionId !== null && !before.commands.some((command) => command.key === key)) {
			if (before.phase !== "blocked" || before.result?.completionId !== resumeCompletionId)
				throw new WorkerContractError("Only the current blocked checkpoint can be continued");
			await this.#runs.verifyResult(this.#guard(snapshot, before, "followup"), before.result, signal);
			await this.#authorize(before.dispatch, signal);
		}
		await this.#change(
			`followup:${key}`,
			"followup",
			workerId,
			(todo) => {
				const worker = findWorker(todo, workerId);
				const existing = worker.commands.find((command) => command.key === key);
				if (existing) {
					if (
						existing.kind !== "followup" ||
						existing.text !== text ||
						existing.resumeCompletionId !== resumeCompletionId ||
						!workerSame(existing.sources, sources)
					)
						throw new WorkerContractError("Follow-up key is bound to other work");
					return { changed: false, result: undefined };
				}
				if (
					todo.state !== "open" ||
					(workerIsTerminal(worker.phase) && !(worker.phase === "blocked" && resumeCompletionId !== null)) ||
					worker.commands.length >= WORKER_MAX_COMMANDS - 1
				)
					throw new WorkerContractError("Worker is terminal or its follow-up budget is exhausted");
				if (resumeCompletionId !== null) {
					if (
						worker.phase !== "blocked" ||
						worker.result?.completionId !== resumeCompletionId ||
						!worker.continuation
					)
						throw new WorkerContractError("Blocked checkpoint changed before continuation");
					worker.history.push({
						result: worker.result,
						continuation: { ...worker.continuation, delivery: "suppressed" },
					});
					worker.result = null;
					worker.continuation = null;
					worker.phase = "reconciling";
				}
				worker.sequence++;
				worker.commands.push({
					key,
					kind: "followup",
					epoch: worker.epoch,
					sequence: worker.sequence,
					text,
					sources,
					resumeCompletionId,
					delivery: "pending",
					receiptId: null,
				});
				return { changed: true, result: undefined };
			},
			signal,
		);
		await this.#sendCommand(workerId, signal);
		return findWorker((await this.status(signal)).value, workerId);
	}

	async cancel(workerId: string, operationKey: string, signal: AbortSignal): Promise<WorkerHandle> {
		workerUuid(workerId);
		workerKey(operationKey);
		await this.#assertParent(signal);
		await this.#fence(workerId, "cancelled", operationKey, signal);
		await this.#sendCommand(workerId, signal);
		return findWorker((await this.status(signal)).value, workerId);
	}

	async cancelTodo(operationKey: string, signal: AbortSignal): Promise<WorkerTodoSnapshot> {
		workerKey(operationKey);
		await this.#assertParent(signal);
		const { snapshot } = await this.#change(
			`cancel-todo:${operationKey}`,
			"cancel",
			null,
			(todo) => {
				if (todo.state === "done") throw new WorkerContractError("Completed todo cannot be cancelled");
				if (todo.state === "cancelled") return { changed: false, result: undefined };
				todo.state = "cancelled";
				for (const worker of todo.workers)
					fenceWorker(worker, "cancelled", `cancel:${workerStableId([operationKey, worker.commands])}`);
				return { changed: true, result: undefined };
			},
			signal,
		);
		const failures = await this.#forWorkers(
			snapshot.value.workers,
			(worker) => this.#sendCommand(worker.dispatch.workerId, signal),
			signal,
		);
		if (failures.length) throw new WorkerReconciliationBatchError(failures);
		return this.status(signal);
	}

	/** Main-owned run termination hook; this component neither interrupts nor restarts the parent. */
	async parentEnded(signal: AbortSignal): Promise<WorkerTodoSnapshot> {
		const snapshot = await this.#read(signal);
		const failures = await this.#forWorkers(
			snapshot.value.workers,
			async (worker) => {
				if (worker.phase === "cancelled" || worker.phase === "revoked") return;
				const id = worker.dispatch.workerId;
				if (worker.dispatch.cancellation.onParentEnd === "cancel") {
					await this.#fence(id, "cancelled", `parent-ended:${id}`, signal, true);
				} else {
					try {
						await this.#authorize(worker.dispatch, signal);
					} catch (error) {
						if (!(error instanceof WorkerDelegationRevoked)) throw error;
						await this.#fence(id, "revoked", `revoke:${id}`, signal);
					}
				}
			},
			signal,
		);
		// Attempt every fence before issuing physical stops, even if one fence failed.
		failures.push(
			...(await this.#forWorkers(
				(
					await this.#read(signal)
				).value.workers,
				async (worker) => {
					if (worker.phase === "cancelled" || worker.phase === "revoked")
						await this.#sendCommand(worker.dispatch.workerId, signal);
				},
				signal,
			)),
		);
		if (failures.length) throw new WorkerReconciliationBatchError(failures);
		return this.#read(signal);
	}

	/** Receipt authentication is separate from untrusted result content. No implicit acceptance. */
	async complete(
		value: WorkerResult,
		signal: AbortSignal,
	): Promise<"recorded" | "duplicate" | "ignored" | "superseded"> {
		const result = parseWorkerResult(value);
		if (!workerSame(result.todo, this.#store.identity) || result.parentRunId !== this.#store.parent.runId)
			throw new WorkerContractError("Completion targets another parent");
		const snapshot = await this.#read(signal);
		const worker = findWorker(snapshot.value, result.workerId);
		if (worker.phase === "cancelled" || worker.phase === "revoked" || snapshot.value.state === "cancelled")
			return "ignored";
		if (result.sequence < worker.sequence || result.epoch < worker.epoch) return "superseded";
		this.#assertResultBinding(worker, result);
		try {
			await this.#authorize(worker.dispatch, signal);
		} catch (error) {
			if (!(error instanceof WorkerDelegationRevoked)) throw error;
			await this.#fence(result.workerId, "revoked", `revoke:${result.workerId}`, signal);
			return "ignored";
		}
		await this.#runs.verifyResult(this.#guard(snapshot, worker, "complete"), result, signal);
		try {
			await this.#authorize(worker.dispatch, signal);
		} catch (error) {
			if (!(error instanceof WorkerDelegationRevoked)) throw error;
			await this.#fence(result.workerId, "revoked", `revoke:${result.workerId}`, signal);
			return "ignored";
		}
		const changed = await this.#change(
			`complete:${result.completionId}`,
			"complete",
			result.workerId,
			(todo) => {
				const worker = findWorker(todo, result.workerId);
				if (worker.phase === "cancelled" || worker.phase === "revoked" || todo.state === "cancelled")
					return { changed: false, result: "ignored" as const };
				if (result.sequence < worker.sequence || result.epoch < worker.epoch)
					return { changed: false, result: "superseded" as const };
				this.#assertResultBinding(worker, result);
				if (worker.result) {
					if (!workerSame(worker.result, result))
						throw new WorkerContractError("Worker already has a different terminal result");
					return { changed: false, result: "duplicate" as const };
				}
				worker.result = result;
				worker.phase = result.outcome;
				worker.continuation = createWorkerContinuation(result, todo.parent);
				return { changed: true, result: "recorded" as const };
			},
			signal,
		);
		return changed.result;
	}

	async accept(
		workerId: string,
		completionId: string,
		operationKey: string,
		signal: AbortSignal,
	): Promise<WorkerTodoSnapshot> {
		workerUuid(workerId);
		workerUuid(completionId);
		workerKey(operationKey);
		await this.#assertParent(signal);
		const snapshot = await this.#read(signal);
		const worker = findWorker(snapshot.value, workerId);
		if (!worker.result || worker.result.completionId !== completionId || worker.phase !== "succeeded")
			throw new WorkerContractError("Only a current successful worker result can be accepted");
		await this.#authorize(worker.dispatch, signal);
		await this.#runs.verifyResult(this.#guard(snapshot, worker, "accept"), worker.result, signal);
		await this.#authorize(worker.dispatch, signal);
		const { snapshot: accepted } = await this.#change(
			`accept:${operationKey}`,
			"accept",
			workerId,
			(todo) => {
				const worker = findWorker(todo, workerId);
				const previous = todo.acceptedResults.find(
					(item) => item.workerId === workerId || item.operationKey === operationKey,
				);
				if (previous) {
					if (
						previous.workerId !== workerId ||
						previous.operationKey !== operationKey ||
						previous.result.completionId !== completionId
					)
						throw new WorkerContractError("Acceptance key is bound to other work");
					return { changed: false, result: undefined };
				}
				if (todo.state !== "open" || worker.phase !== "succeeded" || worker.result?.completionId !== completionId)
					throw new WorkerContractError("Result was fenced before acceptance");
				todo.acceptedResults.push({
					workerId,
					operationKey,
					acceptedByRunId: this.#actorRunId,
					result: worker.result,
				});
				return { changed: true, result: undefined };
			},
			signal,
		);
		await this.#assertParent(signal);
		return accepted;
	}

	async finishTodo(operationKey: string, signal: AbortSignal): Promise<WorkerTodoSnapshot> {
		workerKey(operationKey);
		await this.#assertParent(signal);
		const { snapshot } = await this.#change(
			`finish:${operationKey}`,
			"todo",
			null,
			(todo) => {
				if (todo.state === "done") return { changed: false, result: undefined };
				if (
					todo.state !== "open" ||
					!todo.acceptedResults.length ||
					todo.workers.some(
						(worker) =>
							!workerIsTerminal(worker.phase) ||
							worker.commands.some((command) => command.kind === "cancel" && command.delivery !== "confirmed") ||
							(worker.phase === "succeeded" &&
								!todo.acceptedResults.some((accepted) => accepted.workerId === worker.dispatch.workerId)),
					)
				) {
					throw new WorkerContractError("Todo has unaccepted or unresolved work");
				}
				todo.state = "done";
				return { changed: true, result: undefined };
			},
			signal,
		);
		await this.#assertParent(signal);
		return snapshot;
	}

	/** Bounded one-pass drain, invoked by the existing cloud reconciler; no timer or queue. */
	async reconcile(signal: AbortSignal): Promise<WorkerTodoSnapshot> {
		const start = await this.#read(signal);
		const failures = await this.#forWorkers(
			start.value.workers,
			async (initial) => {
				const id = initial.dispatch.workerId;
				let snapshot = await this.#read(signal);
				let worker = findWorker(snapshot.value, id);
				if (!workerIsTerminal(worker.phase)) {
					try {
						await this.#authorize(worker.dispatch, signal);
					} catch (error) {
						if (!(error instanceof WorkerDelegationRevoked)) throw error;
						await this.#fence(id, "revoked", `revoke:${id}`, signal);
					}
				}
				await this.#sendCommand(id, signal);
				snapshot = await this.#read(signal);
				worker = findWorker(snapshot.value, id);
				if (
					!workerIsTerminal(worker.phase) &&
					worker.execution &&
					worker.commands.every((command) => command.delivery === "confirmed")
				) {
					await this.#authorize(worker.dispatch, signal);
					const observed = await this.#runs.inspect(
						this.#guard(snapshot, worker, "reconcile"),
						worker.execution,
						signal,
					);
					if (observed.state === "terminal") {
						workerRecord(observed, ["state", "result"]);
						await this.complete(observed.result, signal);
					} else if (observed.state === "uncertain") {
						workerRecord(observed, ["state"]);
						await this.#change(
							`uncertain:${id}`,
							"reconcile",
							id,
							(todo) => {
								const current = findWorker(todo, id);
								if (workerIsTerminal(current.phase) || current.phase === "reconciling")
									return { changed: false, result: undefined };
								current.phase = "reconciling";
								return { changed: true, result: undefined };
							},
							signal,
						);
					} else {
						workerRecord(observed, ["state"]);
						if (observed.state !== "active") throw new WorkerContractError("Unknown worker execution state");
						await this.#markRunning(snapshot, id, signal);
					}
				}
				await this.#deliverContinuation(id, signal);
			},
			signal,
		);
		if (failures.length) throw new WorkerReconciliationBatchError(failures);
		return this.#read(signal);
	}

	/** Receipt recovery is cleanup; promoting its observed execution is a separate live-authority CAS. */
	async #markRunning(snapshot: WorkerTodoSnapshot, workerId: string, signal: AbortSignal): Promise<void> {
		const worker = findWorker(snapshot.value, workerId);
		if (workerIsTerminal(worker.phase)) return;
		try {
			await this.#authorize(worker.dispatch, signal);
		} catch (error) {
			if (!(error instanceof WorkerDelegationRevoked)) throw error;
			await this.#fence(workerId, "revoked", `revoke:${workerId}`, signal);
			await this.#sendCommand(workerId, signal);
			return;
		}
		await this.#change(
			`active:${workerId}`,
			"status",
			workerId,
			(todo, previous) => {
				const current = findWorker(todo, workerId);
				if (
					previous.version !== snapshot.version ||
					current.phase !== "reconciling" ||
					current.epoch !== worker.epoch ||
					current.sequence !== worker.sequence ||
					!current.execution ||
					!workerSame(current.execution, worker.execution) ||
					current.commands.some((command) => command.delivery !== "confirmed")
				)
					return { changed: false, result: undefined };
				current.phase = "running";
				return { changed: true, result: undefined };
			},
			signal,
		);
	}

	async #forWorkers(
		workers: readonly WorkerHandle[],
		visit: (worker: WorkerHandle) => Promise<void>,
		signal: AbortSignal,
	): Promise<WorkerReconciliationFailure[]> {
		const failures: WorkerReconciliationFailure[] = [];
		for (const worker of workers) {
			signal.throwIfAborted();
			try {
				await visit(worker);
			} catch (error) {
				signal.throwIfAborted();
				failures.push({ workerId: worker.dispatch.workerId, error });
			}
			signal.throwIfAborted();
		}
		return failures;
	}

	/** Queue consumers must invoke this after their own atomic current-authority admission. */
	async resolveContinuation(
		value: WorkerContinuation,
		signal: AbortSignal,
	): Promise<{ trust: "untrusted-worker-data"; result: WorkerResult }> {
		const requested = parseWorkerContinuation(value);
		if (!workerSame(requested.todo, this.#store.identity) || !workerSame(requested.parent, this.#store.parent))
			throw new WorkerContractError("Continuation targets another parent");
		const snapshot = await this.#read(signal);
		const worker = findWorker(snapshot.value, requested.workerId);
		if (
			!worker.continuation ||
			worker.continuation.delivery === "suppressed" ||
			worker.phase === "revoked" ||
			worker.phase === "cancelled" ||
			!workerSame(immutableContinuation(worker.continuation), immutableContinuation(requested)) ||
			!worker.result
		)
			throw new WorkerContractError("Continuation is stale or fenced");
		await this.#authorize(worker.dispatch, signal);
		await this.#runs.verifyResult(this.#guard(snapshot, worker, "continue"), worker.result, signal);
		await this.#authorize(worker.dispatch, signal);
		const current = findWorker((await this.#read(signal)).value, requested.workerId);
		if (
			current.epoch !== worker.epoch ||
			current.continuation?.delivery === "suppressed" ||
			!workerSame(current.result, worker.result)
		)
			throw new WorkerContractError("Continuation changed during authorization");
		return { trust: "untrusted-worker-data", result: worker.result };
	}

	async #assertParent(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		await this.#authority.assertParent(this.#store.identity, this.#store.parent, this.#actorRunId, signal);
		signal.throwIfAborted();
	}

	async #authorize(dispatch: WorkerDispatch, signal: AbortSignal) {
		signal.throwIfAborted();
		const scope = await this.#authority.resolve(structuredClone(dispatch), signal);
		signal.throwIfAborted();
		if (scope === null) throw new WorkerDelegationRevoked();
		workerBlankContext(dispatch, scope);
		return structuredClone(scope);
	}

	async #read(signal: AbortSignal): Promise<WorkerTodoSnapshot> {
		const snapshot = await this.#store.read(signal);
		if (!snapshot) throw new WorkerContractError("Durable todo does not exist");
		return snapshot;
	}

	#guard(
		snapshot: WorkerTodoSnapshot,
		worker: WorkerHandle | null,
		purpose: WorkerEffectGuard["purpose"],
	): WorkerEffectGuard {
		return {
			todo: this.#store.identity,
			parent: this.#store.parent,
			actorRunId: this.#actorRunId,
			expectedVersion: snapshot.version,
			workerId: worker?.dispatch.workerId ?? null,
			delegation: worker?.dispatch.delegation ?? null,
			epoch: worker?.epoch ?? null,
			sequence: worker?.sequence ?? null,
			purpose,
		};
	}

	async #change<T>(
		key: string,
		purpose: WorkerEffectGuard["purpose"],
		workerId: string | null,
		apply: (todo: WorkerTodo, previous: WorkerTodoSnapshot) => { changed: boolean; result: T },
		signal: AbortSignal,
	): Promise<{ snapshot: WorkerTodoSnapshot; result: T }> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const previous = await this.#read(signal);
			const next = structuredClone(previous.value);
			const effect = apply(next, previous);
			if (!effect.changed) return { snapshot: previous, result: effect.result };
			next.revision++;
			const worker = workerId
				? (previous.value.workers.find((entry) => entry.dispatch.workerId === workerId) ?? null)
				: null;
			const guard = this.#guard(previous, worker, purpose);
			if (workerId && !worker) {
				const inserted = findWorker(next, workerId);
				guard.workerId = inserted.dispatch.workerId;
				guard.delegation = inserted.dispatch.delegation;
			}
			try {
				const snapshot = await this.#store.write(previous, next, key, guard, signal);
				return { snapshot, result: effect.result };
			} catch (error) {
				if (!(error instanceof WorkerTodoConflict)) throw error;
			}
		}
		throw new WorkerTodoConflict();
	}

	async #fence(
		workerId: string,
		phase: "cancelled" | "revoked",
		key: string,
		signal: AbortSignal,
		internal = false,
	): Promise<void> {
		await this.#change(
			`fence:${key}`,
			"cancel",
			workerId,
			(todo) => {
				const worker = findWorker(todo, workerId);
				const commandKey =
					internal || phase === "revoked" ? `cancel:${workerStableId([phase, key, worker.commands])}` : key;
				if (worker.commands.some((command) => command.key === commandKey && command.kind !== "cancel"))
					throw new WorkerContractError("Cancellation key is already in use");
				return { changed: fenceWorker(worker, phase, commandKey), result: undefined };
			},
			signal,
		);
	}

	#assertResultBinding(worker: WorkerHandle, result: WorkerResult): void {
		assertWorkerResultBudget(worker.dispatch, result);
		if (
			worker.history.some(
				(item) => item.result.completionId === result.completionId || item.result.receiptId === result.receiptId,
			)
		)
			throw new WorkerContractError("Completion identity was already used by a previous checkpoint");
		if (
			!worker.execution ||
			worker.commands.some((command) => command.kind !== "cancel" && command.delivery !== "confirmed")
		)
			throw new WorkerReconciliationRequired();
		if (
			!workerSame(result.execution, worker.execution) ||
			!workerSame(result.delegation, worker.dispatch.delegation) ||
			result.epoch !== worker.epoch ||
			result.sequence !== worker.sequence
		)
			throw new WorkerContractError("Completion does not match its worker execution");
	}

	async #sendCommand(workerId: string, signal: AbortSignal): Promise<void> {
		let snapshot = await this.#read(signal);
		let worker = findWorker(snapshot.value, workerId);
		const fenced = worker.phase === "cancelled" || worker.phase === "revoked";
		const command = worker.commands.find(
			(command) =>
				command.delivery !== "confirmed" && (fenced ? command.kind === "cancel" : command.kind !== "cancel"),
		);
		if (!command || (!fenced && workerIsTerminal(worker.phase))) return;
		let fresh = false;
		if (command.delivery === "pending") {
			const claimed = await this.#change(
				`claim:${workerId}:${command.key}`,
				"reconcile",
				workerId,
				(todo) => {
					const current = findWorker(todo, workerId);
					const queued = current.commands.find((entry) => entry.key === command.key)!;
					if (queued.delivery !== "pending" || (current.epoch !== command.epoch && command.kind !== "cancel"))
						return { changed: false, result: false };
					queued.delivery = "inflight";
					return { changed: true, result: true };
				},
				signal,
			);
			fresh = claimed.result;
			snapshot = claimed.snapshot;
			worker = findWorker(snapshot.value, workerId);
		}
		const current = worker.commands.find((entry) => entry.key === command.key)!;
		if (current.delivery === "confirmed" || (current.epoch !== worker.epoch && current.kind !== "cancel")) return;
		let context: WorkerRunRequest["context"] = null;
		if (current.kind !== "cancel") {
			try {
				const scope = await this.#authorize(worker.dispatch, signal);
				if (current.sources.some((source) => !scope.sources.some((allowed) => workerSame(source, allowed))))
					throw new WorkerContractError("Follow-up source authority changed");
				if (current.kind === "dispatch") context = workerBlankContext(worker.dispatch, scope);
			} catch (error) {
				if (!(error instanceof WorkerDelegationRevoked)) throw error;
				await this.#fence(workerId, "revoked", `revoke:${workerId}`, signal);
				return;
			}
		}
		if (current.kind === "followup" && !worker.execution) throw new WorkerReconciliationRequired();
		const request: WorkerRunRequest = {
			schema: WORKER_RUN_COMMAND_SCHEMA,
			guard: this.#guard(snapshot, worker, current.kind),
			dispatch: structuredClone(worker.dispatch),
			command: {
				key: current.key,
				kind: current.kind,
				epoch: current.epoch,
				sequence: current.sequence,
				text: current.text,
				sources: structuredClone(current.sources),
				resumeCompletionId: current.resumeCompletionId,
			},
			execution: worker.execution,
			context,
		};
		try {
			let receipt: WorkerCommandReceipt;
			if (fresh) receipt = await this.#runs.submit(request, signal);
			else {
				const found = await this.#runs.lookup(request, signal);
				const recovered = this.#lookup(found);
				if (recovered === "uncertain") {
					await this.#uncertainCommand(workerId, current.key, signal);
					return;
				}
				receipt = recovered === "not-started" ? await this.#runs.submit(request, signal) : recovered;
			}
			const checked = this.#commandReceipt(receipt, request);
			const acknowledged = await this.#change(
				`ack:${workerId}:${current.key}`,
				"reconcile",
				workerId,
				(todo) => {
					const worker = findWorker(todo, workerId);
					const command = worker.commands.find((entry) => entry.key === current.key)!;
					if (command.delivery === "confirmed") {
						if (command.receiptId !== checked.receiptId)
							throw new WorkerContractError("Command receipt identity changed");
						return { changed: false, result: undefined };
					}
					if (checked.execution) {
						if (
							(worker.execution && !workerSame(worker.execution, checked.execution)) ||
							todo.workers.some(
								(other) =>
									other.dispatch.workerId !== workerId &&
									other.execution &&
									(other.execution.runId === checked.execution!.runId ||
										other.execution.streamId === checked.execution!.streamId),
							)
						)
							throw new WorkerContractError("Execution or stream was reused across workers");
						worker.execution = checked.execution;
					}
					command.delivery = "confirmed";
					command.receiptId = checked.receiptId;
					if (!workerIsTerminal(worker.phase)) worker.phase = "reconciling";
					return { changed: true, result: undefined };
				},
				signal,
			);
			await this.#markRunning(acknowledged.snapshot, workerId, signal);
		} catch {
			if (!signal.aborted) await this.#uncertainCommand(workerId, current.key, signal);
			throw new WorkerReconciliationRequired();
		}
	}

	#lookup<T>(value: WorkerLookup<T>): T | "uncertain" | "not-started" {
		if (value.state === "confirmed") {
			workerRecord(value, ["state", "receipt"]);
			return value.receipt;
		}
		if (value.state === "not-started") {
			workerRecord(value, ["state", "reconciliationReceiptId"]);
			workerUuid(value.reconciliationReceiptId);
			return "not-started";
		}
		workerRecord(value, ["state"]);
		if (value.state !== "uncertain") throw new WorkerContractError("Unknown reconciliation state");
		return "uncertain";
	}

	#commandReceipt(value: WorkerCommandReceipt, request: WorkerRunRequest): WorkerCommandReceipt {
		workerRecord(value, ["schema", "workerId", "commandKey", "inputSha256", "receiptId", "status", "execution"]);
		if (
			value.schema !== "qorpera.worker-command-receipt/v1" ||
			value.workerId !== request.dispatch.workerId ||
			value.commandKey !== request.command.key ||
			value.inputSha256 !== workerRunRequestDigest(request) ||
			value.status !== (request.command.kind === "cancel" ? "stopped" : "admitted")
		)
			throw new WorkerContractError("Worker command receipt differs");
		workerUuid(value.receiptId);
		const execution = value.execution === null ? null : parseWorkerExecution(value.execution);
		if (
			(!execution && request.command.kind !== "cancel") ||
			(execution &&
				(execution.runId === request.dispatch.parent.runId ||
					execution.streamId === request.dispatch.parent.sessionId ||
					(request.execution && !workerSame(request.execution, execution))))
		)
			throw new WorkerContractError("Worker reused parent or other execution continuity");
		return { ...value, execution };
	}

	async #uncertainCommand(workerId: string, key: string, signal: AbortSignal): Promise<void> {
		await this.#change(
			`uncertain:${workerId}:${key}`,
			"reconcile",
			workerId,
			(todo) => {
				const worker = findWorker(todo, workerId);
				const command = worker.commands.find((command) => command.key === key)!;
				if (command.delivery === "confirmed" || command.delivery === "uncertain")
					return { changed: false, result: undefined };
				command.delivery = "uncertain";
				if (!workerIsTerminal(worker.phase)) worker.phase = "reconciling";
				return { changed: true, result: undefined };
			},
			signal,
		);
	}

	async #deliverContinuation(workerId: string, signal: AbortSignal): Promise<void> {
		let snapshot = await this.#read(signal);
		let worker = findWorker(snapshot.value, workerId);
		if (!worker.continuation || ["confirmed", "suppressed"].includes(worker.continuation.delivery)) return;
		const intentId = worker.continuation.intentId;
		try {
			await this.#authorize(worker.dispatch, signal);
		} catch (error) {
			if (!(error instanceof WorkerDelegationRevoked)) throw error;
			await this.#fence(workerId, "revoked", `revoke:${workerId}`, signal);
			return;
		}
		let fresh = false;
		if (worker.continuation.delivery === "pending") {
			const claimed = await this.#change(
				`continuation-claim:${workerId}`,
				"continue",
				workerId,
				(todo) => {
					const intent = findWorker(todo, workerId).continuation;
					if (!intent || intent.intentId !== intentId || intent.delivery !== "pending")
						return { changed: false, result: false };
					intent.delivery = "inflight";
					return { changed: true, result: true };
				},
				signal,
			);
			fresh = claimed.result;
			snapshot = claimed.snapshot;
			worker = findWorker(snapshot.value, workerId);
		}
		const intent = worker.continuation;
		if (!intent || intent.intentId !== intentId || ["confirmed", "suppressed"].includes(intent.delivery)) return;
		const guard = this.#guard(snapshot, worker, "continue");
		try {
			let receipt: WorkerContinuationReceipt;
			if (fresh) receipt = await this.#continuations.submit(guard, structuredClone(intent), signal);
			else {
				const found = this.#lookup(await this.#continuations.lookup(guard, structuredClone(intent), signal));
				if (found === "uncertain") {
					await this.#uncertainContinuation(workerId, intentId, signal);
					return;
				}
				receipt =
					found === "not-started"
						? await this.#continuations.submit(guard, structuredClone(intent), signal)
						: found;
			}
			workerRecord(receipt, [
				"schema",
				"intentId",
				"parentRunId",
				"todoId",
				"workerId",
				"completionId",
				"receiptId",
			]);
			if (
				receipt.schema !== "qorpera.worker-continuation-receipt/v1" ||
				receipt.intentId !== intent.intentId ||
				receipt.parentRunId !== intent.parent.runId ||
				receipt.todoId !== intent.todo.todoId ||
				receipt.workerId !== intent.workerId ||
				receipt.completionId !== intent.completionId
			)
				throw new WorkerContractError("Continuation receipt targets another parent");
			workerUuid(receipt.receiptId);
			await this.#change(
				`continuation-ack:${intent.intentId}`,
				"continue",
				workerId,
				(todo) => {
					const current = findWorker(todo, workerId).continuation;
					if (!current || current.intentId !== intentId || current.delivery === "suppressed")
						return { changed: false, result: undefined };
					if (current.delivery === "confirmed") {
						if (current.receiptId !== receipt.receiptId)
							throw new WorkerContractError("Continuation receipt changed");
						return { changed: false, result: undefined };
					}
					current.delivery = "confirmed";
					current.receiptId = receipt.receiptId;
					return { changed: true, result: undefined };
				},
				signal,
			);
		} catch {
			if (!signal.aborted) await this.#uncertainContinuation(workerId, intentId, signal);
			throw new WorkerReconciliationRequired();
		}
	}

	async #uncertainContinuation(workerId: string, intentId: string, signal: AbortSignal): Promise<void> {
		await this.#change(
			`continuation-uncertain:${intentId}`,
			"continue",
			workerId,
			(todo) => {
				const intent = findWorker(todo, workerId).continuation;
				if (
					!intent ||
					intent.intentId !== intentId ||
					["confirmed", "suppressed", "uncertain"].includes(intent.delivery)
				)
					return { changed: false, result: undefined };
				intent.delivery = "uncertain";
				return { changed: true, result: undefined };
			},
			signal,
		);
	}
}
