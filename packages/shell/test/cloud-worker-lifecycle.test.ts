import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertCodingWorkerFollowup,
	type CodingWorkerContinuity,
	parseWorkerContinuation,
	parseWorkerDispatch,
	parseWorkerResult,
	parseWorkerTodo,
	WORKER_MAX_COMMANDS,
	WORKER_MAX_HANDLES,
	WORKER_TODO_MAX_BYTES,
	WorkerContractError,
	type WorkerHandle,
	workerCanonicalJson,
} from "../src/cloud-worker-contract.ts";
import {
	InHouseWorkerLifecycle,
	WorkerReconciliationBatchError,
	WorkerReconciliationRequired,
} from "../src/cloud-worker-lifecycle.ts";
import { assertWorkerToolAllowed, workerBlankContext } from "../src/cloud-worker-ports.ts";
import {
	CompanyFileWorkerTodoStore,
	WorkerTodoConflict,
	WorkerTodoProposalPending,
} from "../src/cloud-worker-todo-store.ts";
import { deferred, MemoryWorkerFixture, signal, workerScope } from "./fixtures/cloud-worker-fixture.ts";

describe("closed worker contracts and private context", () => {
	it("constructs only explicit blank context and narrows rather than inheriting the allowed scope", () => {
		const fixture = new MemoryWorkerFixture();
		const dispatch = fixture.dispatch();
		const scope = workerScope(dispatch);
		scope.tools.push({ ...scope.tools[0], name: "company_write", effect: "company-file" });
		scope.sources.push({ objectId: randomUUID(), path: "private/other.md", version: randomUUID() });
		const context = workerBlankContext(dispatch, scope);
		expect(Object.keys(context).sort()).toEqual(
			[
				"schema",
				"species",
				"workerId",
				"parentRunId",
				"todo",
				"runtimeBundleVersion",
				"goal",
				"definitionOfDone",
				"context",
				"tools",
				"output",
				"cancellation",
				"completion",
				"publicMouth",
				"resultTrust",
			].sort(),
		);
		expect(context.context).toEqual(dispatch.context);
		expect(context.tools).toEqual(dispatch.tools);
		expect(context.output.maxResultBytes).toBe(dispatch.destination.maxResultBytes);
		expect(context).not.toHaveProperty("transcript");
		expect(context).not.toHaveProperty("credentials");
		expect(context).not.toHaveProperty("environment");
		expect(context.publicMouth).toBe("forbidden");
		context.context.text = "mutated";
		expect(dispatch.context.text).not.toBe("mutated");
	});

	it.each(["transcript", "credentials", "providerSession", "environment", "authority"])(
		"rejects ambient %s in dispatch",
		(field) => {
			const dispatch = new MemoryWorkerFixture().dispatch();
			expect(() => parseWorkerDispatch({ ...dispatch, [field]: "untrusted" })).toThrow(WorkerContractError);
			expect(() =>
				parseWorkerDispatch({ ...dispatch, context: { ...dispatch.context, [field]: "untrusted" } }),
			).toThrow(WorkerContractError);
		},
	);

	it.each([
		"send",
		"send_message",
		"send_agent_message",
		"send_coworker_message",
		"delegate_to_staff",
		"worker_dispatch",
	])("has no %s surface", (name) => {
		const dispatch = new MemoryWorkerFixture().dispatch();
		const forbidden = { ...dispatch, tools: [{ ...dispatch.tools[0], name }] };
		expect(() => parseWorkerDispatch(forbidden)).toThrow(WorkerContractError);
		expect(() => workerBlankContext(forbidden, workerScope(forbidden))).toThrow(WorkerContractError);
		expect(() =>
			workerBlankContext(dispatch, {
				...workerScope(dispatch),
				tools: [...dispatch.tools, ...forbidden.tools],
			}),
		).toThrow(WorkerContractError);
		const context = workerBlankContext(dispatch, workerScope(dispatch));
		expect(() => assertWorkerToolAllowed(context, name, "v1")).toThrow(WorkerContractError);
		expect(() => assertWorkerToolAllowed({ ...context, tools: forbidden.tools }, name, "v1")).toThrow(
			WorkerContractError,
		);
		expect(assertWorkerToolAllowed(context, "company_read", "v1")).toEqual(dispatch.tools[0]);
		expect(() => assertWorkerToolAllowed(context, "company_read", "v2")).toThrow(WorkerContractError);
	});

	it("requires exact tool, source, delegation, worker and parent bindings", () => {
		const dispatch = new MemoryWorkerFixture().dispatch();
		const variants = [
			{ ...workerScope(dispatch), parent: { ...dispatch.parent, runId: randomUUID() } },
			{ ...workerScope(dispatch), workerId: randomUUID() },
			{ ...workerScope(dispatch), delegation: { ...dispatch.delegation, version: 2 } },
			{ ...workerScope(dispatch), tools: [] },
			{ ...workerScope(dispatch), sources: [] },
		];
		for (const scope of variants) expect(() => workerBlankContext(dispatch, scope)).toThrow(WorkerContractError);
		expect(() => parseWorkerDispatch({ ...dispatch, tools: [{ ...dispatch.tools[0], audience: "public" }] })).toThrow(
			WorkerContractError,
		);
		expect(() =>
			parseWorkerDispatch({ ...dispatch, destination: { ...dispatch.destination, path: "another/todo.json" } }),
		).toThrow(WorkerContractError);
	});

	it("rejects future schemas, inherited contexts, path aliases and lossy/non-JSON objects", () => {
		const dispatch = new MemoryWorkerFixture().dispatch();
		expect(() => parseWorkerDispatch({ ...dispatch, schema: "qorpera.worker-dispatch/v99" })).toThrow(
			WorkerContractError,
		);
		expect(() => parseWorkerDispatch({ ...dispatch, context: { ...dispatch.context, mode: "inherit" } })).toThrow(
			WorkerContractError,
		);
		for (const path of ["../todo.json", "/todo.json", "a//b", "a/../b", "a/CON", "a/b.", "a\\b", "work/%2e%2e/x"]) {
			expect(() => parseWorkerDispatch({ ...dispatch, todo: { ...dispatch.todo, path } })).toThrow(
				WorkerContractError,
			);
		}
		const getter = Object.defineProperty({}, "x", { enumerable: true, get: () => 1 });
		for (const value of [
			new Date(),
			{ x: undefined },
			{ x: Number.NaN },
			new Array(2),
			getter,
			{ [Symbol("key")]: 1 },
		])
			expect(() => workerCanonicalJson(value)).toThrow(WorkerContractError);
	});

	it("separates in-house workers from infrastructure runners and the coding continuity seam", () => {
		const dispatch = new MemoryWorkerFixture().dispatch();
		for (const species of ["coding", "runner", "coworker"])
			expect(() => parseWorkerDispatch({ ...dispatch, species })).toThrow(WorkerContractError);
		const coding: CodingWorkerContinuity = {
			schema: "qorpera.coding-worker-continuity/v1",
			species: "coding",
			workerId: dispatch.workerId,
			todo: dispatch.todo,
			vmId: randomUUID(),
			repositoryId: randomUUID(),
			branch: "codex/worker-test",
			completion: { kind: "callback", referenceId: randomUUID() },
		};
		expect(() => assertCodingWorkerFollowup(coding, structuredClone(coding))).not.toThrow();
		for (const changed of [
			{ branch: "other" },
			{ vmId: randomUUID() },
			{ repositoryId: randomUUID() },
			{ workerId: randomUUID() },
			{ completion: { kind: "durable-listener" as const, referenceId: randomUUID() } },
		])
			expect(() => assertCodingWorkerFollowup(coding, { ...coding, ...changed })).toThrow(WorkerContractError);
	});
});

describe("Step 5 current integration regressions", () => {
	it("rejects an explicitly granted coworker send before persistence or run admission", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const dispatch = fixture.dispatch();
		dispatch.tools = [{ ...dispatch.tools[0], name: "send_coworker_message", effect: "external" }];
		fixture.scopes.set(dispatch.workerId, workerScope(dispatch));
		const before = await lifecycle.status(signal);
		await expect(lifecycle.dispatch(dispatch, signal)).rejects.toThrow(
			"Worker tools must have no public mouth or delegation surface",
		);
		expect(await lifecycle.status(signal)).toEqual(before);
		expect(fixture.calls).toHaveLength(0);
		expect(fixture.receipts.size).toBe(0);
		expect(fixture.continuationCalls).toHaveLength(0);
	});

	it.each(["absent", "file"])(
		"requires an explicit provenance adapter for the current main %s read envelope",
		async (kind) => {
			const fixture = new MemoryWorkerFixture();
			if (kind === "file") await fixture.create();
			const before = { text: fixture.text, version: fixture.version };
			const store = new CompanyFileWorkerTodoStore(fixture.todo, fixture.parent, {
				...fixture.file,
				read: async (path, offset, limit, signal) => {
					const page = (await fixture.file.read(path, offset, limit, signal)) as Record<string, unknown>;
					// Main's gateway confirms these read-provenance fields before returning them.
					// The independent store must not silently discard them as a compatibility fallback.
					return { ...page, snapshotId: randomUUID(), readObservationId: randomUUID() };
				},
			});
			const lifecycle = new InHouseWorkerLifecycle({
				store,
				authority: fixture.authority,
				runs: fixture.runs,
				continuations: fixture.continuations,
				actorRunId: fixture.parent.runId,
			});
			await expect(store.read(signal)).rejects.toThrow(WorkerContractError);
			await expect(
				kind === "file"
					? lifecycle.dispatch(fixture.dispatch(), signal)
					: lifecycle.createTodo(
							{ goal: "Review evidence", definitionOfDone: ["Accept findings"], sources: [] },
							"create-todo",
							signal,
						),
			).rejects.toThrow(WorkerContractError);
			expect({ text: fixture.text, version: fixture.version }).toEqual(before);
			expect(fixture.calls).toHaveLength(0);
			expect(fixture.receipts.size).toBe(0);
		},
	);
});

describe("in-house lifecycle", () => {
	it("fails closed without required adapters or an authorized host-bound caller", async () => {
		expect(() => new InHouseWorkerLifecycle({} as ConstructorParameters<typeof InHouseWorkerLifecycle>[0])).toThrow(
			WorkerContractError,
		);
		const fixture = new MemoryWorkerFixture();
		await fixture.create();
		await expect(fixture.lifecycle(randomUUID()).status(signal)).rejects.toThrow("Parent authority denied");
	});

	it("admits once without waiting for child work, and keeps completed results unaccepted until the parent acts", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const dispatch = fixture.dispatch();
		const worker = await lifecycle.dispatch(dispatch, signal);
		expect(worker.phase).toBe("running");
		expect(fixture.results.size).toBe(0);
		expect(await lifecycle.dispatch(dispatch, signal)).toEqual(worker);
		expect(fixture.calls).toHaveLength(1);
		expect(fixture.calls[0].context?.context.mode).toBe("blank");
		const result = fixture.result(worker);
		expect(await lifecycle.complete(result, signal)).toBe("recorded");
		expect((await lifecycle.status(signal)).value.acceptedResults).toEqual([]);
		await expect(lifecycle.finishTodo("finish", signal)).rejects.toThrow("unaccepted");
		await lifecycle.accept(worker.dispatch.workerId, result.completionId, "accept", signal);
		await lifecycle.accept(worker.dispatch.workerId, result.completionId, "accept", signal);
		const finished = await lifecycle.finishTodo("finish", signal);
		expect(finished.value.state).toBe("done");
		expect(finished.value.acceptedResults).toHaveLength(1);
		expect(finished.value.acceptedResults[0].acceptedByRunId).toBe(fixture.parent.runId);
	});

	it("deduplicates concurrent dispatch calls and preserves independent workers under Company File CAS", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const dispatches = [fixture.dispatch(), fixture.dispatch(), fixture.dispatch()];
		await Promise.all(
			[...dispatches, dispatches[0]].map((dispatch) => fixture.lifecycle().dispatch(dispatch, signal)),
		);
		const workers = (await lifecycle.status(signal)).value.workers;
		expect(workers).toHaveLength(3);
		expect(new Set(workers.map((worker) => worker.execution?.runId)).size).toBe(3);
		expect(new Set(workers.map((worker) => worker.execution?.streamId)).size).toBe(3);
		expect(fixture.receipts.size).toBe(3);
		expect(fixture.calls).toHaveLength(3);
		await expect(lifecycle.dispatch({ ...dispatches[0], goal: "Different work" }, signal)).rejects.toThrow(
			"different work",
		);
	});

	it("follows up within the same worker and run, with monotonic sequence and bounded explicit input", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const first = await lifecycle.dispatch(fixture.dispatch(), signal);
		const obsolete = fixture.result(first);
		const input = { operationKey: "more", text: "Check the second point", sources: first.dispatch.context.sources };
		const next = await lifecycle.followup(first.dispatch.workerId, input, signal);
		expect(next.execution).toEqual(first.execution);
		expect(next.sequence).toBe(1);
		expect(fixture.calls[1].context).toBeNull();
		expect(fixture.calls[1].command.text).toBe(input.text);
		await lifecycle.followup(first.dispatch.workerId, input, signal);
		expect(fixture.calls).toHaveLength(2);
		await expect(lifecycle.followup(first.dispatch.workerId, { ...input, text: "Changed" }, signal)).rejects.toThrow(
			"other work",
		);
		await expect(
			lifecycle.followup(
				first.dispatch.workerId,
				{
					...input,
					operationKey: "escape",
					sources: [{ objectId: randomUUID(), path: "private/secret", version: randomUUID() }],
				},
				signal,
			),
		).rejects.toThrow("authority");
		expect(await lifecycle.complete(obsolete, signal)).toBe("superseded");
		await lifecycle.complete(fixture.result(next), signal);
		await expect(
			lifecycle.followup(first.dispatch.workerId, { ...input, operationKey: "after-terminal" }, signal),
		).rejects.toThrow("terminal");
	});

	it("reserves a cancellation slot when the follow-up budget is exhausted", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		for (let i = 0; i < WORKER_MAX_COMMANDS - 2; i++)
			await lifecycle.followup(
				worker.dispatch.workerId,
				{ operationKey: `f${i}`, text: "Check", sources: [] },
				signal,
			);
		await expect(
			lifecycle.followup(worker.dispatch.workerId, { operationKey: "overflow", text: "Check", sources: [] }, signal),
		).rejects.toThrow("budget");
		const cancelled = await lifecycle.cancel(worker.dispatch.workerId, "cancel", signal);
		expect(cancelled.commands).toHaveLength(WORKER_MAX_COMMANDS);
		expect(cancelled.commands.at(-1)?.delivery).toBe("confirmed");
	});

	it.each(["blocked", "failed"] as const)(
		"records %s as a private terminal outcome, not accepted output",
		async (outcome) => {
			const fixture = new MemoryWorkerFixture();
			const lifecycle = await fixture.create();
			const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
			const result = fixture.result(worker, outcome);
			await lifecycle.complete(result, signal);
			await lifecycle.reconcile(signal);
			expect((await lifecycle.status(signal)).value.workers[0].phase).toBe(outcome);
			expect(fixture.continuationReceipts.size).toBe(1);
			await expect(
				lifecycle.accept(worker.dispatch.workerId, result.completionId, "accept", signal),
			).rejects.toThrow("successful");
		},
	);

	it("deduplicates terminal results and continuation admission while preserving the exact private parent", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker);
		expect(
			(await Promise.all([lifecycle.complete(result, signal), fixture.lifecycle().complete(result, signal)])).sort(),
		).toEqual(["duplicate", "recorded"]);
		await Promise.all([lifecycle.reconcile(signal), fixture.lifecycle().reconcile(signal)]);
		expect(fixture.continuationReceipts.size).toBe(1);
		const intent = (await lifecycle.status(signal)).value.workers[0].continuation!;
		expect(intent.parent).toEqual(fixture.parent);
		expect(intent.audience).toBe("parent-private");
		expect(intent).not.toHaveProperty("text");
		expect(intent).not.toHaveProperty("author");
		expect(await lifecycle.resolveContinuation(intent, signal)).toEqual({ trust: "untrusted-worker-data", result });
		await expect(
			lifecycle.resolveContinuation({ ...intent, parent: { ...intent.parent, runId: randomUUID() } }, signal),
		).rejects.toThrow("another parent");
		await expect(lifecycle.complete({ ...result, summary: "tampered" }, signal)).rejects.toThrow("receipt");
		expect(() => parseWorkerResult({ ...result, publicMessage: "publish this" })).toThrow(WorkerContractError);
	});

	it("does not let a forged execution or delegation complete work", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker);
		for (const candidate of [
			{ ...result, execution: { ...result.execution, runId: fixture.parent.runId } },
			{ ...result, delegation: { ...result.delegation, version: 2 } },
			{ ...result, epoch: 2 },
		])
			await expect(lifecycle.complete(candidate, signal)).rejects.toThrow("execution");
		expect((await lifecycle.status(signal)).value.workers[0].result).toBeNull();
	});

	it("rejects malformed handle fences and caller-supplied acceptance state", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		await lifecycle.dispatch(fixture.dispatch(), signal);
		const todo = (await lifecycle.status(signal)).value;
		for (const patch of [
			{ epoch: 2 },
			{ phase: "cancelled" },
			{ phase: "succeeded" },
			{ execution: { runId: fixture.parent.runId, streamId: randomUUID() } },
		])
			expect(() => parseWorkerTodo({ ...todo, workers: [{ ...todo.workers[0], ...patch }] })).toThrow(
				WorkerContractError,
			);
		expect(() => parseWorkerTodo({ ...todo, state: "done" })).toThrow(WorkerContractError);
	});
});

describe("fences, interrupted dispatch and uncertain effects", () => {
	it("cancels on parent termination unless a live grant explicitly allows retention", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const cancelled = await lifecycle.dispatch(fixture.dispatch(), signal);
		const retained = fixture.dispatch();
		retained.cancellation.onParentEnd = "retain-grant";
		await expect(lifecycle.dispatch(retained, signal)).rejects.toThrow("outlive");
		fixture.scopes.get(retained.workerId)!.parentEnd = "retain-grant";
		await lifecycle.dispatch(retained, signal);
		await lifecycle.parentEnded(signal);
		await fixture.lifecycle().parentEnded(signal);
		const workers = (await lifecycle.status(signal)).value.workers;
		expect(workers.find((worker) => worker.dispatch.workerId === cancelled.dispatch.workerId)?.phase).toBe(
			"cancelled",
		);
		expect(workers.find((worker) => worker.dispatch.workerId === retained.workerId)?.phase).toBe("running");
		expect(fixture.calls.filter((call) => call.command.kind === "cancel")).toHaveLength(1);
		fixture.revoked.add(retained.workerId);
		await fixture.lifecycle().parentEnded(signal);
		expect(
			(await lifecycle.status(signal)).value.workers.every(
				(worker) => worker.phase === "cancelled" || worker.phase === "revoked",
			),
		).toBe(true);
	});

	it("keeps cancellation writable at the aggregate byte limit", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		for (let i = 0; i < 8; i++) {
			const dispatch = fixture.dispatch();
			dispatch.context.text = "x".repeat(4096);
			dispatch.goal = "x".repeat(1024);
			try {
				await lifecycle.dispatch(dispatch, signal);
			} catch (error) {
				expect(error).toBeInstanceOf(WorkerContractError);
				break;
			}
		}
		const before = (await lifecycle.status(signal)).value;
		expect(before.workers.length).toBeGreaterThan(1);
		const after = await lifecycle.cancelTodo("cancel-at-budget", signal);
		expect(after.value.state).toBe("cancelled");
		expect(after.value.workers.every((worker) => worker.commands.at(-1)?.delivery === "confirmed")).toBe(true);
	});

	it("does not admit when cancellation wins before the effect transaction", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const entered = deferred();
		const release = deferred();
		fixture.beforeSubmit = async (request) => {
			if (request.command.kind === "dispatch") {
				entered.resolve();
				await release.promise;
			}
		};
		const dispatch = fixture.dispatch();
		const pending = lifecycle.dispatch(dispatch, signal).catch((error: unknown) => error);
		await entered.promise;
		await fixture.lifecycle().cancel(dispatch.workerId, "cancel", signal);
		release.resolve();
		expect(await pending).toBeInstanceOf(WorkerReconciliationRequired);
		const worker = (await lifecycle.status(signal)).value.workers[0];
		expect(worker.phase).toBe("cancelled");
		expect(worker.epoch).toBe(2);
		expect(worker.execution).toBeNull();
		expect([...fixture.receipts.values()].filter((receipt) => receipt.status === "admitted")).toHaveLength(0);
	});

	it("retains cleanup identity but never reopens a worker when admission acknowledged after cancellation", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const entered = deferred();
		const release = deferred();
		fixture.afterSubmit = async (request) => {
			if (request.command.kind === "dispatch") {
				entered.resolve();
				await release.promise;
			}
		};
		const dispatch = fixture.dispatch();
		const pending = lifecycle.dispatch(dispatch, signal);
		await entered.promise;
		await fixture.lifecycle().cancel(dispatch.workerId, "cancel", signal);
		release.resolve();
		const worker = await pending;
		expect(worker.phase).toBe("cancelled");
		expect(worker.execution).not.toBeNull();
		expect(worker.commands.every((command) => command.delivery === "confirmed")).toBe(true);
		expect(fixture.calls).toHaveLength(2);
	});

	it("suppresses a completion when cancellation wins during receipt verification", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker);
		const entered = deferred();
		const release = deferred();
		fixture.beforeVerify = async () => {
			entered.resolve();
			await release.promise;
		};
		const pending = lifecycle.complete(result, signal);
		await entered.promise;
		await fixture.lifecycle().cancel(worker.dispatch.workerId, "cancel", signal);
		release.resolve();
		expect(await pending).toBe("ignored");
		expect((await lifecycle.status(signal)).value.workers[0].continuation).toBeNull();
	});

	it("suppresses queued and late continuation acknowledgements after cancellation", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		await lifecycle.complete(fixture.result(worker), signal);
		const entered = deferred();
		const release = deferred();
		fixture.afterContinuation = async () => {
			entered.resolve();
			await release.promise;
		};
		const pending = lifecycle.reconcile(signal);
		await entered.promise;
		const intent = fixture.continuationCalls[0];
		await fixture.lifecycle().cancel(worker.dispatch.workerId, "cancel", signal);
		release.resolve();
		await pending;
		expect((await lifecycle.status(signal)).value.workers[0].continuation?.delivery).toBe("suppressed");
		await expect(lifecycle.resolveContinuation(intent, signal)).rejects.toThrow("fenced");
	});

	it("rechecks live authority at acceptance and never revives a fenced worker after regrant", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker);
		await lifecycle.complete(result, signal);
		fixture.beforeCommit = async (guard) => {
			if (guard.purpose === "accept") fixture.revoked.add(worker.dispatch.workerId);
		};
		await expect(lifecycle.accept(worker.dispatch.workerId, result.completionId, "accept", signal)).rejects.toThrow(
			"revoked",
		);
		fixture.beforeCommit = undefined;
		await lifecycle.reconcile(signal);
		fixture.revoked.clear();
		await lifecycle.reconcile(signal);
		expect(await lifecycle.complete(result, signal)).toBe("ignored");
		await lifecycle.dispatch(worker.dispatch, signal);
		const state = (await lifecycle.status(signal)).value;
		expect(state.workers[0].phase).toBe("revoked");
		expect(state.workers[0].continuation?.delivery).toBe("suppressed");
		expect(state.acceptedResults).toEqual([]);
		expect(fixture.calls.filter((call) => call.command.kind === "dispatch")).toHaveLength(1);
	});

	it("revokes an active worker and ignores late results without sending any public message", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker);
		fixture.revoked.add(worker.dispatch.workerId);
		expect(await lifecycle.complete(result, signal)).toBe("ignored");
		await lifecycle.reconcile(signal);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("revoked");
		expect(fixture.continuationCalls).toEqual([]);
	});

	it("cancels a whole todo atomically without accepting or notifying on late work", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const workers = await Promise.all(
			[fixture.dispatch(), fixture.dispatch()].map((dispatch) => lifecycle.dispatch(dispatch, signal)),
		);
		const cancelled = await lifecycle.cancelTodo("cancel-all", signal);
		expect(cancelled.value.state).toBe("cancelled");
		expect(cancelled.value.workers.every((worker) => worker.phase === "cancelled")).toBe(true);
		for (const worker of workers) expect(await lifecycle.complete(fixture.result(worker), signal)).toBe("ignored");
		await expect(lifecycle.dispatch(fixture.dispatch(), signal)).rejects.toThrow("closed");
	});

	it("recovers a lost admission response from its receipt without dispatching again", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		fixture.afterSubmit = async () => {
			throw new Error("lost response");
		};
		await expect(lifecycle.dispatch(fixture.dispatch(), signal)).rejects.toThrow(WorkerReconciliationRequired);
		expect((await lifecycle.status(signal)).value.workers[0].commands[0].delivery).toBe("uncertain");
		fixture.afterSubmit = undefined;
		const restarted = fixture.lifecycle();
		await restarted.reconcile(signal);
		expect((await restarted.status(signal)).value.workers[0].phase).toBe("running");
		expect(fixture.calls).toHaveLength(1);
	});

	it("leaves an ambiguous effect fenced across restarts until positive not-started proof exists", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const dispatch = fixture.dispatch();
		fixture.beforeSubmit = async () => {
			throw new Error("unknown outcome");
		};
		await expect(lifecycle.dispatch(dispatch, signal)).rejects.toThrow(WorkerReconciliationRequired);
		fixture.beforeSubmit = undefined;
		await fixture.lifecycle().reconcile(signal);
		await fixture.lifecycle().reconcile(signal);
		expect(fixture.calls).toHaveLength(1);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("reconciling");
		fixture.notStarted.set(`${dispatch.workerId}:${dispatch.operationKey}`, randomUUID());
		await fixture.lifecycle().reconcile(signal);
		expect(fixture.calls).toHaveLength(2);
		expect(fixture.calls[1].command).toEqual(fixture.calls[0].command);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("running");
	});

	it("recovers interruption after durable intent but before claiming dispatch", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		fixture.afterCommit = async () => {
			fixture.afterCommit = undefined;
			throw new Error("process exited after commit");
		};
		await expect(lifecycle.dispatch(fixture.dispatch(), signal)).rejects.toThrow("process exited");
		expect(fixture.calls).toHaveLength(0);
		await fixture.lifecycle().reconcile(signal);
		expect(fixture.calls).toHaveLength(1);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("running");
	});

	it("does not mistake an interrupted inflight marker for proof of no effect", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		let commits = 0;
		fixture.afterCommit = async () => {
			if (++commits === 2) throw new Error("process exited at claim");
		};
		await expect(lifecycle.dispatch(fixture.dispatch(), signal)).rejects.toThrow("process exited");
		fixture.afterCommit = undefined;
		await fixture.lifecycle().reconcile(signal);
		expect(fixture.calls).toHaveLength(0);
		expect((await lifecycle.status(signal)).value.workers[0].commands[0].delivery).toBe("uncertain");
	});

	it("recovers a lost continuation response using its immutable intent identity", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		await lifecycle.complete(fixture.result(worker), signal);
		fixture.afterContinuation = async () => {
			throw new Error("lost continuation response");
		};
		await expect(lifecycle.reconcile(signal)).rejects.toThrow(WorkerReconciliationRequired);
		fixture.afterContinuation = undefined;
		await fixture.lifecycle().reconcile(signal);
		expect(fixture.continuationCalls).toHaveLength(1);
		expect(fixture.continuationReceipts.size).toBe(1);
		expect((await lifecycle.status(signal)).value.workers[0].continuation?.delivery).toBe("confirmed");
	});

	it("requires reconciliation if completion precedes its admission acknowledgement", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		fixture.afterSubmit = async () => {
			throw new Error("lost response");
		};
		await expect(lifecycle.dispatch(fixture.dispatch(), signal)).rejects.toThrow(WorkerReconciliationRequired);
		const worker = (await lifecycle.status(signal)).value.workers[0];
		const receipt = [...fixture.receipts.values()][0];
		const result = fixture.result({ ...worker, execution: receipt.execution });
		await expect(lifecycle.complete(result, signal)).rejects.toThrow(WorkerReconciliationRequired);
		fixture.afterSubmit = undefined;
		await fixture.lifecycle().reconcile(signal);
		expect((await lifecycle.status(signal)).value.workers[0].result).toEqual(result);
		expect(fixture.calls).toHaveLength(1);
	});

	it("does not re-execute when a known execution becomes uncertain", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		await lifecycle.dispatch(fixture.dispatch(), signal);
		fixture.uncertainExecution = true;
		await lifecycle.reconcile(signal);
		await fixture.lifecycle().reconcile(signal);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("reconciling");
		expect(fixture.calls).toHaveLength(1);
	});

	it("will not convert a protected Company File proposal into a dispatched worker", async () => {
		const fixture = new MemoryWorkerFixture();
		await fixture.create();
		const lifecycle = new InHouseWorkerLifecycle({
			store: new CompanyFileWorkerTodoStore(fixture.todo, fixture.parent, {
				read: fixture.file.read,
				commit: async (_guard, mutation) => ({
					schema: "qorpera.company-path-result/v1",
					state: "proposed",
					operationKey: mutation.operationKey,
					path: mutation.path,
					version: mutation.expectedVersion,
					snapshotId: null,
					receiptId: randomUUID(),
					proposalId: randomUUID(),
				}),
			}),
			authority: fixture.authority,
			runs: fixture.runs,
			continuations: fixture.continuations,
			actorRunId: fixture.parent.runId,
		});
		await expect(lifecycle.dispatch(fixture.dispatch(), signal)).rejects.toThrow(WorkerTodoProposalPending);
		expect(fixture.calls).toHaveLength(0);
	});

	it("rejects tombstones, inconsistent page versions, oversized todos and missing current authority", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const dispatch = fixture.dispatch();
		dispatch.context.text = "x".repeat(4000);
		await lifecycle.dispatch(dispatch, signal);
		const read = fixture.file.read;
		const store = new CompanyFileWorkerTodoStore(fixture.todo, fixture.parent, {
			...fixture.file,
			read: async (path, offset, limit, signal) => {
				const page = (await read(path, offset, limit, signal)) as Record<string, unknown>;
				return { ...page, version: randomUUID() };
			},
		});
		await expect(store.read(signal)).rejects.toThrow(WorkerTodoConflict);
		const todo = (await lifecycle.status(signal)).value;
		expect(() => parseWorkerTodo({ ...todo, workers: Array.from({ length: 8 }, () => todo.workers[0]) })).toThrow(
			WorkerContractError,
		);
		fixture.text = null;
		await expect(lifecycle.status(signal)).rejects.toThrow("deleted");
		fixture.parentAllowed = false;
		await expect(lifecycle.status(signal)).rejects.toThrow("authority");
	});
});

describe("Step 5 review regressions", () => {
	it.each([
		["plain", "x".repeat(2048)],
		["JSON-escaped", `x${"\u0001".repeat(2047)}`],
		["UTF-8", "\u{1f642}".repeat(512)],
	])("reserves completion and acceptance before admitting more %s context", async (_label, text) => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		let worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		let capacityReached = false;
		for (let index = 0; index < WORKER_MAX_COMMANDS - 2; index++) {
			const before = await lifecycle.status(signal);
			const calls = fixture.calls.length;
			try {
				worker = await lifecycle.followup(
					worker.dispatch.workerId,
					{ operationKey: `capacity-${index}`, text, sources: [] },
					signal,
				);
			} catch (error) {
				expect(error).toBeInstanceOf(WorkerContractError);
				expect(await lifecycle.status(signal)).toEqual(before);
				expect(fixture.calls).toHaveLength(calls);
				capacityReached = true;
				break;
			}
		}
		expect(capacityReached).toBe(true);
		const result = fixture.result(worker, "succeeded", true);
		expect(Buffer.byteLength(workerCanonicalJson(result))).toBe(worker.dispatch.destination.maxResultBytes);
		await fixture.lifecycle().complete(result, signal);
		await fixture.lifecycle().reconcile(signal);
		await fixture.lifecycle().accept(worker.dispatch.workerId, result.completionId, "a".repeat(96), signal);
		expect((await fixture.lifecycle().finishTodo("finish", signal)).value.state).toBe("done");
		expect(Buffer.byteLength(fixture.text!)).toBeLessThanOrEqual(WORKER_TODO_MAX_BYTES);
	});

	it("reserves maximum results and acceptance for every concurrently admitted worker", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const workers: WorkerHandle[] = [];
		let capacityReached = false;
		for (let index = 0; index < WORKER_MAX_HANDLES; index++) {
			const before = await lifecycle.status(signal);
			const calls = fixture.calls.length;
			try {
				workers.push(await lifecycle.dispatch(fixture.dispatch(), signal));
			} catch (error) {
				expect(error).toBeInstanceOf(WorkerContractError);
				expect(await lifecycle.status(signal)).toEqual(before);
				expect(fixture.calls).toHaveLength(calls);
				capacityReached = true;
				break;
			}
		}
		expect(capacityReached).toBe(true);
		expect(workers.length).toBeGreaterThan(1);
		const results = workers.map((worker) => fixture.result(worker, "succeeded", true));
		await Promise.all(results.map((result) => fixture.lifecycle().complete(result, signal)));
		await fixture.lifecycle().reconcile(signal);
		await Promise.all(
			results.map((result, index) =>
				fixture.lifecycle().accept(result.workerId, result.completionId, `a${index}`.padEnd(96, "x"), signal),
			),
		);
		const finished = await fixture.lifecycle().finishTodo("finish", signal);
		expect(finished.value.acceptedResults).toHaveLength(workers.length);
		expect(fixture.continuationReceipts.size).toBe(workers.length);
		expect(Buffer.byteLength(fixture.text!)).toBeLessThanOrEqual(WORKER_TODO_MAX_BYTES);
	});

	it("reserves every outstanding command acknowledgement as a full todo recovers", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		let worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		fixture.beforeSubmit = async () => {
			throw new Error("Uncertain first follow-up");
		};
		await expect(
			lifecycle.followup(
				worker.dispatch.workerId,
				{
					operationKey: "first-followup",
					text: "x".repeat(2048),
					sources: [],
				},
				signal,
			),
		).rejects.toThrow(WorkerReconciliationRequired);
		fixture.beforeSubmit = undefined;
		let capacityReached = false;
		for (let index = 0; index < WORKER_MAX_COMMANDS - 3; index++) {
			try {
				worker = await lifecycle.followup(
					worker.dispatch.workerId,
					{
						operationKey: `pending-${index}`,
						text: "x".repeat(2048),
						sources: [],
					},
					signal,
				);
			} catch (error) {
				expect(error).toBeInstanceOf(WorkerContractError);
				capacityReached = true;
				break;
			}
		}
		expect(capacityReached).toBe(true);
		expect(worker.commands.filter((command) => command.delivery === "pending").length).toBeGreaterThan(1);
		await fixture.lifecycle().reconcile(signal);
		expect(fixture.calls).toHaveLength(2); // No retries without positive not-started proof.
		fixture.notStarted.set(`${worker.dispatch.workerId}:first-followup`, randomUUID());
		for (let index = 0; index < worker.sequence; index++) await fixture.lifecycle().reconcile(signal);
		worker = (await fixture.lifecycle().status(signal)).value.workers[0];
		expect(worker.commands.every((command) => command.delivery === "confirmed")).toBe(true);
		const result = fixture.result(worker, "succeeded", true);
		await fixture.lifecycle().complete(result, signal);
		await fixture.lifecycle().accept(worker.dispatch.workerId, result.completionId, "a".repeat(96), signal);
		await fixture.lifecycle().reconcile(signal);
		expect((await fixture.lifecycle().finishTodo("finish", signal)).value.state).toBe("done");
	});

	it("requires an explicit feasible result budget and rejects oversized completion before receipt verification", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const dispatch = fixture.dispatch();
		for (const maxResultBytes of [undefined, 0, 1, 1.5, "2048", WORKER_TODO_MAX_BYTES + 1])
			expect(() =>
				parseWorkerDispatch({ ...dispatch, destination: { ...dispatch.destination, maxResultBytes } }),
			).toThrow(WorkerContractError);
		const worker = await lifecycle.dispatch(dispatch, signal);
		const result = fixture.result(worker, "succeeded", true);
		result.summary += "x";
		let verified = false;
		fixture.beforeVerify = async () => {
			verified = true;
		};
		await expect(lifecycle.complete(result, signal)).rejects.toThrow("dispatch byte budget");
		expect(verified).toBe(false);
		expect((await lifecycle.status(signal)).value.workers[0].result).toBeNull();
	});

	it("reconciles an independent completed child despite another child's repeated lookup failure", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const first = await lifecycle.dispatch(fixture.dispatch(), signal);
		const second = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(second);
		const inspect = fixture.runs.inspect;
		const lookupError = new Error("First child lookup unavailable");
		fixture.runs.inspect = async (guard, execution, signal) => {
			if (execution.runId === first.execution!.runId) throw lookupError;
			return inspect(guard, execution, signal);
		};
		for (let attempt = 0; attempt < 3; attempt++) {
			const failure = await fixture
				.lifecycle()
				.reconcile(signal)
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(WorkerReconciliationBatchError);
			expect(failure).toMatchObject({ failures: [{ workerId: first.dispatch.workerId, error: lookupError }] });
		}
		const current = (await lifecycle.status(signal)).value.workers[1];
		expect(current.result).toEqual(result);
		expect(current.continuation?.delivery).toBe("confirmed");
		expect(fixture.continuationReceipts.size).toBe(1);
	});

	it("isolates authority outages without revoking that worker or blocking another completion", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const first = await lifecycle.dispatch(fixture.dispatch(), signal);
		const second = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(second);
		const resolve = fixture.authority.resolve;
		fixture.authority.resolve = async (dispatch, signal) => {
			if (dispatch.workerId === first.dispatch.workerId) throw new Error("Authority unavailable");
			return resolve(dispatch, signal);
		};
		await expect(lifecycle.reconcile(signal)).rejects.toThrow(WorkerReconciliationBatchError);
		const workers = (await lifecycle.status(signal)).value.workers;
		expect(workers[0].phase).toBe("running");
		expect(workers[0].epoch).toBe(1);
		expect(workers[1].result).toEqual(result);
		expect(workers[1].continuation?.delivery).toBe("confirmed");
	});

	it("delivers another private intent after the first continuation adapter throws", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const first = await lifecycle.dispatch(fixture.dispatch(), signal);
		const second = await lifecycle.dispatch(fixture.dispatch(), signal);
		for (const worker of [first, second]) await lifecycle.complete(fixture.result(worker), signal);
		const submit = fixture.continuations.submit;
		let firstSubmissions = 0;
		fixture.continuations.submit = async (guard, intent, signal) => {
			if (intent.workerId === first.dispatch.workerId) {
				firstSubmissions++;
				throw new Error("First continuation unconfirmed");
			}
			return submit(guard, intent, signal);
		};
		await expect(lifecycle.reconcile(signal)).rejects.toThrow(WorkerReconciliationBatchError);
		await fixture.lifecycle().reconcile(signal);
		const workers = (await lifecycle.status(signal)).value.workers;
		expect(workers[0].continuation?.delivery).toBe("uncertain");
		expect(workers[1].continuation?.delivery).toBe("confirmed");
		expect(firstSubmissions).toBe(1);
		expect(fixture.continuationReceipts.size).toBe(1);
	});

	it.each(["cancelTodo", "parentEnded"] as const)("drains independent cancellations during %s", async (method) => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const first = await lifecycle.dispatch(fixture.dispatch(), signal);
		await lifecycle.dispatch(fixture.dispatch(), signal);
		fixture.beforeSubmit = async (request) => {
			if (request.command.kind === "cancel" && request.dispatch.workerId === first.dispatch.workerId)
				throw new Error("First stop unconfirmed");
		};
		const cancellation =
			method === "cancelTodo" ? lifecycle.cancelTodo("stop-all", signal) : lifecycle.parentEnded(signal);
		await expect(cancellation).rejects.toThrow(WorkerReconciliationBatchError);
		const workers = (await lifecycle.status(signal)).value.workers;
		expect(workers.every((worker) => worker.phase === "cancelled")).toBe(true);
		expect(workers[0].commands.at(-1)?.delivery).toBe("uncertain");
		expect(workers[1].commands.at(-1)?.delivery).toBe("confirmed");
		fixture.beforeSubmit = undefined;
		await fixture.lifecycle().reconcile(signal);
		expect(fixture.calls.filter((call) => call.command.kind === "cancel")).toHaveLength(2);
	});

	it("honors caller abort rather than treating it as an isolated worker failure", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		await lifecycle.dispatch(fixture.dispatch(), signal);
		const second = await lifecycle.dispatch(fixture.dispatch(), signal);
		fixture.result(second);
		const controller = new AbortController();
		const reason = new Error("Caller stopped reconciliation");
		let inspected = 0;
		fixture.runs.inspect = async () => {
			inspected++;
			controller.abort(reason);
			throw reason;
		};
		await expect(lifecycle.reconcile(controller.signal)).rejects.toBe(reason);
		expect(inspected).toBe(1);
		expect((await lifecycle.status(signal)).value.workers[1].result).toBeNull();
	});

	it("rejects non-string enum values rather than coercing arrays", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const todo = (await lifecycle.status(signal)).value;
		expect(() => parseWorkerTodo({ ...todo, state: ["open"] })).toThrow(WorkerContractError);
		const dispatch = fixture.dispatch();
		expect(() => parseWorkerDispatch({ ...dispatch, tools: [{ ...dispatch.tools[0], effect: ["read"] }] })).toThrow(
			WorkerContractError,
		);
		const worker = await lifecycle.dispatch(dispatch, signal);
		expect(() => parseWorkerResult({ ...fixture.result(worker), outcome: ["succeeded"] })).toThrow(
			WorkerContractError,
		);
		const current = (await lifecycle.status(signal)).value;
		for (const patch of [
			{ phase: ["running"] },
			{ commands: [{ ...worker.commands[0], delivery: ["uncertain"], receiptId: null }] },
			{
				commands: [
					...worker.commands,
					{
						key: "bad-kind",
						kind: ["followup"],
						epoch: 1,
						sequence: 0,
						text: "",
						sources: [],
						resumeCompletionId: null,
						delivery: "pending",
						receiptId: null,
					},
				],
			},
		])
			expect(() => parseWorkerTodo({ ...current, workers: [{ ...current.workers[0], ...patch }] })).toThrow(
				WorkerContractError,
			);
		await lifecycle.complete(fixture.result(worker), signal);
		const intent = (await lifecycle.status(signal)).value.workers[0].continuation!;
		expect(() => parseWorkerContinuation({ ...intent, delivery: ["pending"] })).toThrow(WorkerContractError);
	});

	it("rejects enum coercion objects without invoking their hooks", () => {
		const dispatch = new MemoryWorkerFixture().dispatch();
		let coerced = false;
		const effect = {
			toString: () => {
				coerced = true;
				return "read";
			},
		};
		expect(() => parseWorkerDispatch({ ...dispatch, tools: [{ ...dispatch.tools[0], effect }] })).toThrow(
			WorkerContractError,
		);
		expect(coerced).toBe(false);
	});

	it("restores running after a known uncertain execution is confirmed active", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		await lifecycle.dispatch(fixture.dispatch(), signal);
		fixture.uncertainExecution = true;
		await lifecycle.reconcile(signal);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("reconciling");
		fixture.uncertainExecution = false;
		await fixture.lifecycle().reconcile(signal);
		const recovered = await lifecycle.status(signal);
		expect(recovered.value.workers[0].phase).toBe("running");
		await fixture.lifecycle().reconcile(signal);
		expect(await lifecycle.status(signal)).toEqual(recovered);
		expect(fixture.calls).toHaveLength(1);
	});

	it.each(["cancel", "revoke"] as const)("does not apply a late active observation after %s", async (action) => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		fixture.uncertainExecution = true;
		await lifecycle.reconcile(signal);
		const entered = deferred();
		const release = deferred();
		fixture.runs.inspect = async () => {
			entered.resolve();
			await release.promise;
			return { state: "active" };
		};
		const pending = lifecycle.reconcile(signal);
		await entered.promise;
		if (action === "cancel") await fixture.lifecycle().cancel(worker.dispatch.workerId, "cancel", signal);
		else fixture.revoked.add(worker.dispatch.workerId);
		release.resolve();
		await pending;
		const current = (await lifecycle.status(signal)).value.workers[0];
		expect(current.phase).toBe(action === "cancel" ? "cancelled" : "revoked");
		expect(current.commands.at(-1)?.delivery).toBe("confirmed");
		expect(current.epoch).toBe(2);
	});

	it("does not clear a newer uncertain follow-up with an old active observation", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		fixture.uncertainExecution = true;
		await lifecycle.reconcile(signal);
		fixture.uncertainExecution = false;
		const inspect = fixture.runs.inspect;
		const entered = deferred();
		const release = deferred();
		fixture.runs.inspect = async () => {
			entered.resolve();
			await release.promise;
			return { state: "active" };
		};
		const pending = lifecycle.reconcile(signal);
		await entered.promise;
		fixture.afterSubmit = async () => {
			throw new Error("Follow-up response lost");
		};
		await expect(
			lifecycle.followup(
				worker.dispatch.workerId,
				{ operationKey: "newer", text: "Check again", sources: [] },
				signal,
			),
		).rejects.toThrow(WorkerReconciliationRequired);
		fixture.afterSubmit = undefined;
		release.resolve();
		await pending;
		const current = (await lifecycle.status(signal)).value.workers[0];
		expect(current.sequence).toBe(1);
		expect(current.phase).toBe("reconciling");
		expect(current.commands.at(-1)?.delivery).toBe("uncertain");
		fixture.runs.inspect = inspect;
		await fixture.lifecycle().reconcile(signal);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("running");
		expect(fixture.calls).toHaveLength(2);
	});

	it("requires live authority inside the positive active-state commit", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		fixture.uncertainExecution = true;
		await lifecycle.reconcile(signal);
		fixture.uncertainExecution = false;
		fixture.beforeCommit = async (guard) => {
			if (guard.purpose === "status") fixture.revoked.add(worker.dispatch.workerId);
		};
		await expect(lifecycle.reconcile(signal)).rejects.toThrow(WorkerReconciliationBatchError);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("reconciling");
		fixture.beforeCommit = undefined;
		await fixture.lifecycle().reconcile(signal);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("revoked");
	});
});

describe("Step 5 reassessment regressions", () => {
	it("retains admission cleanup identity without marking a revoked worker running", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const dispatch = fixture.dispatch();
		let publishedRunningAfterRevocation = false;
		fixture.beforeCommit = async (guard, text) => {
			const worker = parseWorkerTodo(JSON.parse(text)).workers[0];
			if (guard.purpose === "reconcile" && worker?.commands[0].delivery === "confirmed")
				fixture.revoked.add(dispatch.workerId);
			if (fixture.revoked.has(dispatch.workerId) && worker?.phase === "running")
				publishedRunningAfterRevocation = true;
		};
		const worker = await lifecycle.dispatch(dispatch, signal);
		expect(publishedRunningAfterRevocation).toBe(false);
		expect(worker.phase).toBe("revoked");
		expect(worker.epoch).toBe(2);
		expect(worker.execution).not.toBeNull();
		expect(worker.commands.every((command) => command.delivery === "confirmed")).toBe(true);
		expect(fixture.calls.map((call) => call.command.kind)).toEqual(["dispatch", "cancel"]);
	});

	it("continues a blocked checkpoint in the same worker without replaying its old private completion", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const first = await lifecycle.dispatch(fixture.dispatch(), signal);
		const blocked = fixture.result(first, "blocked");
		await lifecycle.complete(blocked, signal);
		await lifecycle.reconcile(signal);
		const oldIntent = (await lifecycle.status(signal)).value.workers[0].continuation!;
		const input = {
			operationKey: "answer-blocker",
			completionId: blocked.completionId,
			text: "The missing detail is available; continue this same goal.",
			sources: [],
		};
		const continued = await lifecycle.resumeBlocked(first.dispatch.workerId, input, signal);
		expect(continued.execution).toEqual(first.execution);
		expect(continued.sequence).toBe(1);
		expect(continued.epoch).toBe(1);
		expect(continued.phase).toBe("running");
		expect(continued.result).toBeNull();
		expect(continued.continuation).toBeNull();
		expect(continued.history).toEqual([{ result: blocked, continuation: { ...oldIntent, delivery: "suppressed" } }]);
		expect(fixture.calls.at(-1)?.command.resumeCompletionId).toBe(blocked.completionId);
		expect(fixture.calls.at(-1)?.context).toBeNull();
		await fixture.lifecycle().resumeBlocked(first.dispatch.workerId, input, signal);
		expect(fixture.calls).toHaveLength(2);
		expect(await lifecycle.complete(blocked, signal)).toBe("superseded");
		await expect(lifecycle.resolveContinuation(oldIntent, signal)).rejects.toThrow("stale or fenced");
		const result = fixture.result(continued);
		await lifecycle.complete(result, signal);
		await lifecycle.reconcile(signal);
		await lifecycle.accept(first.dispatch.workerId, result.completionId, "accept", signal);
		const finished = await lifecycle.finishTodo("finish", signal);
		expect(finished.value.workers).toHaveLength(1);
		expect(finished.value.workers[0].history[0].result).toEqual(blocked);
		expect(finished.value.acceptedResults[0].result).toEqual(result);
		expect(fixture.continuationReceipts.size).toBe(2);
	});

	it.each(["dispatch", "followup"] as const)(
		"revalidates authority when recovering a lost %s acknowledgement",
		async (kind) => {
			const fixture = new MemoryWorkerFixture();
			const lifecycle = await fixture.create();
			const dispatch = fixture.dispatch();
			if (kind === "followup") await lifecycle.dispatch(dispatch, signal);
			fixture.afterSubmit = async () => {
				throw new Error("Lost admission response");
			};
			await expect(
				kind === "dispatch"
					? lifecycle.dispatch(dispatch, signal)
					: lifecycle.followup(dispatch.workerId, { operationKey: "more", text: "Check", sources: [] }, signal),
			).rejects.toThrow(WorkerReconciliationRequired);
			fixture.afterSubmit = undefined;
			fixture.beforeCommit = async (guard, text) => {
				const worker = parseWorkerTodo(JSON.parse(text)).workers[0];
				if (guard.purpose === "reconcile" && worker.commands.every((command) => command.delivery === "confirmed"))
					fixture.revoked.add(dispatch.workerId);
			};
			await fixture.lifecycle().reconcile(signal);
			const worker = (await lifecycle.status(signal)).value.workers[0];
			expect(worker.phase).toBe("revoked");
			expect(worker.execution).not.toBeNull();
			expect(worker.commands.at(-1)?.delivery).toBe("confirmed");
			expect(fixture.calls.filter((call) => call.command.kind === kind)).toHaveLength(1);
		},
	);

	it("does not promote a recovered receipt through an authority outage", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const resolve = fixture.authority.resolve;
		fixture.beforeCommit = async (guard, text) => {
			if (guard.purpose === "reconcile" && parseWorkerTodo(JSON.parse(text)).workers[0]?.execution)
				fixture.authority.resolve = async () => {
					throw new Error("Authority unavailable");
				};
		};
		await expect(lifecycle.dispatch(fixture.dispatch(), signal)).rejects.toThrow(WorkerReconciliationRequired);
		const before = (await lifecycle.status(signal)).value.workers[0];
		expect(before.phase).toBe("reconciling");
		expect(before.commands[0].delivery).toBe("confirmed");
		fixture.beforeCommit = undefined;
		fixture.authority.resolve = resolve;
		await fixture.lifecycle().reconcile(signal);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("running");
		expect(fixture.calls).toHaveLength(1);
	});

	it("requires live authority inside the status publication after admission", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const dispatch = fixture.dispatch();
		fixture.beforeCommit = async (guard) => {
			if (guard.purpose === "status") fixture.revoked.add(dispatch.workerId);
		};
		await expect(lifecycle.dispatch(dispatch, signal)).rejects.toThrow(WorkerReconciliationRequired);
		const before = (await lifecycle.status(signal)).value.workers[0];
		expect(before.phase).toBe("reconciling");
		expect(before.commands[0].delivery).toBe("confirmed");
		fixture.beforeCommit = undefined;
		await fixture.lifecycle().reconcile(signal);
		expect((await lifecycle.status(signal)).value.workers[0].phase).toBe("revoked");
		expect(fixture.calls.map((call) => call.command.kind)).toEqual(["dispatch", "cancel"]);
	});

	it("requires the explicit current checkpoint and narrowed context to continue blocked work", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker, "blocked");
		await lifecycle.complete(result, signal);
		const before = await lifecycle.status(signal);
		const input = { operationKey: "resume", completionId: result.completionId, text: "Continue", sources: [] };
		await expect(
			lifecycle.followup(
				worker.dispatch.workerId,
				{ operationKey: "ordinary", text: "Continue", sources: [] },
				signal,
			),
		).rejects.toThrow("terminal");
		await expect(
			lifecycle.resumeBlocked(worker.dispatch.workerId, { ...input, completionId: randomUUID() }, signal),
		).rejects.toThrow("current blocked");
		await expect(
			lifecycle.resumeBlocked(
				worker.dispatch.workerId,
				{ ...input, sources: [{ objectId: randomUUID(), path: "private/secret", version: randomUUID() }] },
				signal,
			),
		).rejects.toThrow("authority");
		expect(await lifecycle.status(signal)).toEqual(before);
		expect(fixture.calls).toHaveLength(1);
	});

	it.each(["succeeded", "failed"] as const)("does not reopen a %s stream as a blocked checkpoint", async (outcome) => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker, outcome);
		await lifecycle.complete(result, signal);
		await expect(
			lifecycle.resumeBlocked(
				worker.dispatch.workerId,
				{ operationKey: "resume", completionId: result.completionId, text: "Continue", sources: [] },
				signal,
			),
		).rejects.toThrow("current blocked");
		expect(fixture.calls).toHaveLength(1);
	});

	it("serializes concurrent parent continuations of the same blocked checkpoint", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker, "blocked");
		await lifecycle.complete(result, signal);
		const input = { operationKey: "resume", completionId: result.completionId, text: "Continue", sources: [] };
		await Promise.all([
			lifecycle.resumeBlocked(worker.dispatch.workerId, input, signal),
			fixture.lifecycle().resumeBlocked(worker.dispatch.workerId, input, signal),
		]);
		await expect(
			lifecycle.resumeBlocked(worker.dispatch.workerId, { ...input, text: "Conflicting context" }, signal),
		).rejects.toThrow("other work");
		await expect(
			lifecycle.resumeBlocked(worker.dispatch.workerId, { ...input, operationKey: "another-resume" }, signal),
		).rejects.toThrow("current blocked");
		const current = (await lifecycle.status(signal)).value.workers[0];
		expect(current.history).toHaveLength(1);
		expect(current.sequence).toBe(1);
		expect(current.execution).toEqual(worker.execution);
		expect(fixture.calls.filter((call) => call.command.kind === "followup")).toHaveLength(1);
	});

	it.each(["intent", "admission"] as const)(
		"recovers a blocked continuation interrupted after its %s",
		async (boundary) => {
			const fixture = new MemoryWorkerFixture();
			const lifecycle = await fixture.create();
			const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
			const blocked = fixture.result(worker, "blocked");
			await lifecycle.complete(blocked, signal);
			if (boundary === "intent")
				fixture.afterCommit = async () => {
					throw new Error("Interrupted intent");
				};
			else
				fixture.afterSubmit = async () => {
					throw new Error("Interrupted admission");
				};
			await expect(
				lifecycle.resumeBlocked(
					worker.dispatch.workerId,
					{ operationKey: "resume", completionId: blocked.completionId, text: "Continue", sources: [] },
					signal,
				),
			).rejects.toThrow();
			fixture.afterCommit = undefined;
			fixture.afterSubmit = undefined;
			await fixture.lifecycle().reconcile(signal);
			const current = (await lifecycle.status(signal)).value.workers[0];
			expect(current.phase).toBe("running");
			expect(current.execution).toEqual(worker.execution);
			expect(current.history[0].result).toEqual(blocked);
			expect(current.commands.at(-1)?.resumeCompletionId).toBe(blocked.completionId);
			expect(fixture.calls).toHaveLength(2);
		},
	);

	it.each(["cancel", "revoke"] as const)(
		"cannot continue blocked work when %s wins during verification",
		async (action) => {
			const fixture = new MemoryWorkerFixture();
			const lifecycle = await fixture.create();
			const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
			const blocked = fixture.result(worker, "blocked");
			await lifecycle.complete(blocked, signal);
			const entered = deferred();
			const release = deferred();
			fixture.beforeVerify = async () => {
				entered.resolve();
				await release.promise;
			};
			const resumed = lifecycle
				.resumeBlocked(
					worker.dispatch.workerId,
					{ operationKey: "resume", completionId: blocked.completionId, text: "Continue", sources: [] },
					signal,
				)
				.catch((error: unknown) => error);
			await entered.promise;
			if (action === "cancel") await fixture.lifecycle().cancel(worker.dispatch.workerId, "cancel", signal);
			else fixture.revoked.add(worker.dispatch.workerId);
			release.resolve();
			expect(await resumed).toBeInstanceOf(Error);
			fixture.beforeVerify = undefined;
			await lifecycle.reconcile(signal);
			fixture.revoked.clear();
			await expect(
				lifecycle.resumeBlocked(
					worker.dispatch.workerId,
					{ operationKey: "again", completionId: blocked.completionId, text: "Continue", sources: [] },
					signal,
				),
			).rejects.toThrow("current blocked");
			const current = (await lifecycle.status(signal)).value.workers[0];
			expect(current.history).toEqual([]);
			expect(current.epoch).toBe(2);
			expect(current.phase).toBe(action === "cancel" ? "cancelled" : "revoked");
			expect(fixture.calls.filter((call) => call.command.kind === "followup")).toHaveLength(0);
		},
	);

	it.each(["acknowledged", "uncertain"] as const)(
		"does not apply a late %s continuation response to a newer checkpoint",
		async (outcome) => {
			const fixture = new MemoryWorkerFixture();
			const lifecycle = await fixture.create();
			const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
			const blocked = fixture.result(worker, "blocked");
			await lifecycle.complete(blocked, signal);
			const entered = deferred();
			const release = deferred();
			fixture.afterContinuation = async () => {
				entered.resolve();
				await release.promise;
				if (outcome === "uncertain") throw new Error("Lost old continuation response");
			};
			const oldDelivery = lifecycle.reconcile(signal).catch((error: unknown) => error);
			await entered.promise;
			const continued = await lifecycle.resumeBlocked(
				worker.dispatch.workerId,
				{ operationKey: "resume", completionId: blocked.completionId, text: "Continue", sources: [] },
				signal,
			);
			const result = fixture.result(continued);
			await lifecycle.complete(result, signal);
			release.resolve();
			const oldOutcome = await oldDelivery;
			if (outcome === "uncertain") expect(oldOutcome).toBeInstanceOf(WorkerReconciliationBatchError);
			else expect(oldOutcome).not.toBeInstanceOf(Error);
			const current = (await lifecycle.status(signal)).value.workers[0];
			expect(current.continuation?.completionId).toBe(result.completionId);
			expect(current.continuation?.delivery).toBe("pending");
			expect(current.continuation?.receiptId).toBeNull();
			expect(current.history[0].continuation.delivery).toBe("suppressed");
			fixture.afterContinuation = undefined;
			await fixture.lifecycle().reconcile(signal);
			expect(fixture.continuationReceipts.size).toBe(2);
		},
	);

	it("rejects checkpoint identity reuse and malformed history", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		const worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		const blocked = fixture.result(worker, "blocked");
		await lifecycle.complete(blocked, signal);
		const continued = await lifecycle.resumeBlocked(
			worker.dispatch.workerId,
			{ operationKey: "resume", completionId: blocked.completionId, text: "Continue", sources: [] },
			signal,
		);
		const result = fixture.result(continued);
		await expect(lifecycle.complete({ ...result, completionId: blocked.completionId }, signal)).rejects.toThrow(
			"previous checkpoint",
		);
		await expect(lifecycle.complete({ ...result, receiptId: blocked.receiptId }, signal)).rejects.toThrow(
			"previous checkpoint",
		);
		const todo = (await lifecycle.status(signal)).value;
		for (const change of [
			{ history: [] },
			{
				history: [
					{ ...continued.history[0], continuation: { ...continued.history[0].continuation, delivery: "pending" } },
				],
			},
			{ history: [{ ...continued.history[0], result: { ...blocked, outcome: "succeeded" } }] },
			{
				commands: continued.commands.map((command) =>
					command.kind === "followup" ? { ...command, resumeCompletionId: randomUUID() } : command,
				),
			},
		])
			expect(() => parseWorkerTodo({ ...todo, workers: [{ ...continued, ...change }] })).toThrow(
				WorkerContractError,
			);
		expect(() => parseWorkerDispatch({ ...worker.dispatch, schema: "qorpera.worker-dispatch/v1" })).toThrow(
			WorkerContractError,
		);
		expect(() => parseWorkerTodo({ ...todo, schema: "qorpera.worker-todo/v1" })).toThrow(WorkerContractError);
	});

	it("keeps a full-budget success and acceptance writable after several durable blocked checkpoints", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		let worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		for (let index = 0; index < 3; index++) {
			const blocked = fixture.result(worker, "blocked", true);
			await lifecycle.complete(blocked, signal);
			worker = await fixture
				.lifecycle()
				.resumeBlocked(
					worker.dispatch.workerId,
					{ operationKey: `resume-${index}`, completionId: blocked.completionId, text: "Continue", sources: [] },
					signal,
				);
		}
		let refused = false;
		for (let index = 0; index < WORKER_MAX_COMMANDS; index++) {
			const before = await lifecycle.status(signal);
			const calls = fixture.calls.length;
			try {
				worker = await lifecycle.followup(
					worker.dispatch.workerId,
					{ operationKey: `fill-${index}`, text: "x".repeat(2048), sources: [] },
					signal,
				);
			} catch (error) {
				expect(error).toBeInstanceOf(WorkerContractError);
				expect(await lifecycle.status(signal)).toEqual(before);
				expect(fixture.calls).toHaveLength(calls);
				refused = true;
				break;
			}
		}
		expect(refused).toBe(true);
		const result = fixture.result(worker, "succeeded", true);
		await lifecycle.complete(result, signal);
		await lifecycle.accept(worker.dispatch.workerId, result.completionId, "a".repeat(96), signal);
		const finished = await lifecycle.finishTodo("finish", signal);
		expect(finished.value.workers[0].history).toHaveLength(3);
		expect(finished.value.state).toBe("done");
		expect(Buffer.byteLength(fixture.text!)).toBeLessThanOrEqual(WORKER_TODO_MAX_BYTES);
	});

	it("refuses another blocked checkpoint before admission when history exhausts capacity, retaining cancellation space", async () => {
		const fixture = new MemoryWorkerFixture();
		const lifecycle = await fixture.create();
		let worker = await lifecycle.dispatch(fixture.dispatch(), signal);
		let refused = false;
		for (let index = 0; index < WORKER_MAX_COMMANDS; index++) {
			const blocked = fixture.result(worker, "blocked", true);
			await lifecycle.complete(blocked, signal);
			const before = await lifecycle.status(signal);
			const calls = fixture.calls.length;
			try {
				worker = await lifecycle.resumeBlocked(
					worker.dispatch.workerId,
					{ operationKey: `resume-${index}`, completionId: blocked.completionId, text: "Continue", sources: [] },
					signal,
				);
			} catch (error) {
				expect(error).toBeInstanceOf(WorkerContractError);
				expect((error as Error).message).toContain("capacity");
				expect(await lifecycle.status(signal)).toEqual(before);
				expect(fixture.calls).toHaveLength(calls);
				await fixture.lifecycle().reconcile(signal);
				const cancelled = await lifecycle.cancel(worker.dispatch.workerId, "c".repeat(96), signal);
				expect(cancelled.phase).toBe("cancelled");
				expect(cancelled.commands.at(-1)?.delivery).toBe("confirmed");
				expect(cancelled.result).toEqual(blocked);
				expect(cancelled.history).toEqual(before.value.workers[0].history);
				refused = true;
				break;
			}
		}
		expect(refused).toBe(true);
		expect(Buffer.byteLength(fixture.text!)).toBeLessThanOrEqual(WORKER_TODO_MAX_BYTES);
	});
});
