import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	WORKER_MAX_COMMANDS,
	WORKER_RUN_COMMAND_SCHEMA,
	WORKER_TODO_MAX_BYTES,
	WorkerContractError,
	type WorkerResult,
	workerCanonicalJson,
	workerDigest,
} from "../src/cloud-worker-contract.ts";
import { WorkerReconciliationBatchError, WorkerReconciliationRequired } from "../src/cloud-worker-lifecycle.ts";
import { signal } from "./fixtures/cloud-worker-fixture.ts";
import { createPostgresWorkerFixture, sqlValue } from "./fixtures/cloud-worker-postgres.ts";

const container = process.env.QORPERA_WORKER_TEST_CONTAINER;
const objects = process.env.QORPERA_WORKER_TEST_OBJECTS;

async function restartDisposablePostgres(): Promise<void> {
	if (!container || !/^qorpera-step5-test-[0-9]+-[0-9a-f]{12}$/.test(container))
		throw new Error("Not a Step 5 disposable database");
	for (const args of [
		["kill", "--signal", "KILL", container],
		["start", container],
	]) {
		const command = spawnSync("docker", args, { encoding: "utf8" });
		expect(command.status, command.stderr).toBe(0);
	}
	for (let attempt = 0; attempt < 60; attempt++) {
		if (
			spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "qorpera_test"], {
				encoding: "utf8",
			}).status === 0
		)
			return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	throw new Error("Disposable PostgreSQL did not recover after restart");
}

// Run only through scripts/test-runtime-workers.mjs. Never connect to an arbitrary
// database URL, existing production container, endpoint or provider credentials.
describe.skipIf(!container || !objects)("worker persistence on disposable Company File storage", () => {
	it("rechecks database authority inside publication after parent acceptance preflight", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const worker = await fixture.lifecycle().dispatch(fixture.dispatch(), signal);
		const result = fixture.result(worker);
		await fixture.lifecycle().complete(result, signal);
		const before = await fixture.lifecycle().status(signal);
		fixture.beforeFilePublish = (guard) => {
			if (guard.purpose === "accept")
				fixture.query(
					`select public.qorpera_set_execution_sponsor_status(${sqlValue(fixture.identity.todo.companyId)},${sqlValue(fixture.identity.sponsorId)},'revoked');`,
				);
		};
		await expect(
			fixture.lifecycle().accept(worker.dispatch.workerId, result.completionId, "accept", signal),
		).rejects.toThrow("delegation revoked");
		const fresh = await fixture.reopen().tree();
		expect(fresh.head).toBe(before.version);
		expect(fresh.document?.acceptedResults).toEqual([]);
	}, 120_000);

	it("reserves maximum completion and acceptance at capacity across an unclean PostgreSQL restart", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const lifecycle = fixture.lifecycle();
		const dispatch = fixture.dispatch();
		fixture.afterRunCommit = () => {
			throw new Error("admission response lost after transaction committed");
		};
		await expect(lifecycle.dispatch(dispatch, signal)).rejects.toThrow(WorkerReconciliationRequired);
		const recovered = fixture.reopen();
		await recovered.lifecycle().reconcile(signal);
		let worker = (await recovered.lifecycle().status(signal)).value.workers[0];
		expect(worker.phase).toBe("running");
		let capacityReached = false;
		for (let index = 0; index < WORKER_MAX_COMMANDS - 2; index++) {
			const before = await recovered.lifecycle().status(signal);
			try {
				worker = await recovered
					.reopen()
					.lifecycle()
					.followup(
						dispatch.workerId,
						{
							operationKey: `capacity-${index}`,
							text: index === 0 ? `x${"\u0001".repeat(2047)}` : "x".repeat(2048),
							sources: [],
						},
						signal,
					);
			} catch (error) {
				expect(error).toBeInstanceOf(WorkerContractError);
				expect(await recovered.reopen().lifecycle().status(signal)).toEqual(before);
				capacityReached = true;
				break;
			}
		}
		expect(capacityReached).toBe(true);
		const result = recovered.result(worker, true);
		expect(Buffer.byteLength(workerCanonicalJson(result))).toBe(dispatch.destination.maxResultBytes);
		const acceptKey = "a".repeat(96);
		await recovered.lifecycle().complete(result, signal);
		await recovered.lifecycle().accept(dispatch.workerId, result.completionId, acceptKey, signal);
		const before = await recovered.lifecycle().status(signal);
		expect(before.value.workers[0].continuation?.delivery).toBe("pending");

		// Kill (not a graceful shutdown) and reopen the same durable volume.
		await restartDisposablePostgres();
		const fresh = fixture.reopen();
		expect(await fresh.lifecycle().status(signal)).toEqual(before);
		await fresh.lifecycle().reconcile(signal);
		expect(await fresh.lifecycle().complete(result, signal)).toBe("duplicate");
		await fresh.lifecycle().accept(dispatch.workerId, result.completionId, acceptKey, signal);
		const finished = await fresh.lifecycle().finishTodo("finish", signal);
		expect(finished.value.state).toBe("done");
		expect(finished.value.acceptedResults).toHaveLength(1);
		expect(finished.value.workers[0].continuation?.delivery).toBe("confirmed");
		expect(Buffer.byteLength((await fresh.tree()).text!)).toBeLessThanOrEqual(WORKER_TODO_MAX_BYTES);
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_execution_runs where profile_id=${sqlValue(fixture.identity.todo.companyId)} and source_id=${sqlValue(dispatch.workerId)};`,
			),
		).toBe(1);
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_run_operation_receipts where run_id=${sqlValue(fixture.identity.parent.runId)} and operation_kind='test_worker_continuation';`,
			),
		).toBe(1);
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_session_inputs as input join public.qorpera_shared_sessions as session on session.id=input.session_id where session.profile_id=${sqlValue(fixture.identity.todo.companyId)};`,
			),
		).toBe(0);
	}, 120_000);

	it("persists another child's completion while an independent execution lookup repeatedly fails", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const first = await fixture.lifecycle().dispatch(fixture.dispatch(), signal);
		const second = await fixture.lifecycle().dispatch(fixture.dispatch(), signal);
		const result = fixture.result(second);
		for (let attempt = 0; attempt < 2; attempt++) {
			const fresh = fixture.reopen();
			const inspect = fresh.runs.inspect;
			fresh.runs.inspect = async (guard, execution, signal) => {
				if (execution.runId === first.execution!.runId) throw new Error("Independent lookup failure");
				return inspect(guard, execution, signal);
			};
			const failure = await fresh
				.lifecycle()
				.reconcile(signal)
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(WorkerReconciliationBatchError);
			expect(failure).toMatchObject({ failures: [{ workerId: first.dispatch.workerId }] });
		}
		const persisted = (await fixture.reopen().lifecycle().status(signal)).value;
		expect(persisted.workers[0].phase).toBe("running");
		expect(persisted.workers[1].result).toEqual(result);
		expect(persisted.workers[1].continuation?.delivery).toBe("confirmed");
		expect(
			fixture.query<number>(
				`select count(*) from public.qorpera_run_operation_receipts where run_id=${sqlValue(fixture.identity.parent.runId)} and operation_kind='test_worker_continuation';`,
			),
		).toBe(1);
	}, 120_000);

	it("persists recovered active status but denies a status commit after live authority is revoked", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const worker = await fixture.lifecycle().dispatch(fixture.dispatch(), signal);
		fixture.runs.inspect = async () => ({ state: "uncertain" });
		await fixture.lifecycle().reconcile(signal);
		expect((await fixture.reopen().lifecycle().status(signal)).value.workers[0].phase).toBe("reconciling");
		const recovered = fixture.reopen();
		await recovered.lifecycle().reconcile(signal);
		const active = (await recovered.reopen().lifecycle().status(signal)).value.workers[0];
		expect(active.phase).toBe("running");
		expect(active.execution).toEqual(worker.execution);
		expect(
			recovered.query<number>(
				`select count(*) from public.qorpera_execution_runs where source_id=${sqlValue(worker.dispatch.workerId)};`,
			),
		).toBe(1);

		await fixture.lifecycle().reconcile(signal); // Test inspector is still uncertain.
		const before = await recovered.lifecycle().status(signal);
		recovered.beforeFilePublish = (guard) => {
			if (guard.purpose === "status")
				recovered.query(
					`select public.qorpera_set_execution_sponsor_status(${sqlValue(recovered.identity.todo.companyId)},${sqlValue(recovered.identity.sponsorId)},'revoked');`,
				);
		};
		await expect(recovered.lifecycle().reconcile(signal)).rejects.toThrow(WorkerReconciliationBatchError);
		const after = await fixture.reopen().tree();
		expect(after.head).toBe(before.version);
		expect(after.document?.workers[0].phase).toBe("reconciling");
	}, 120_000);

	it("uses existing run admission for concurrent children without losing todo updates or follow-up continuity", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const dispatches = [fixture.dispatch(), fixture.dispatch()];
		await Promise.all(dispatches.map((dispatch) => fixture.reopen().lifecycle().dispatch(dispatch, signal)));
		const admitted = (await fixture.lifecycle().status(signal)).value.workers;
		expect(admitted).toHaveLength(2);
		expect(new Set(admitted.map((worker) => worker.execution?.runId)).size).toBe(2);
		const first = admitted[0];
		const followed = await fixture
			.reopen()
			.lifecycle()
			.followup(
				first.dispatch.workerId,
				{ operationKey: "followup", text: "Check one additional point", sources: [] },
				signal,
			);
		expect(followed.execution).toEqual(first.execution);
		expect(followed.sequence).toBe(1);
		const latest = (await fixture.lifecycle().status(signal)).value.workers;
		const results = latest.map((worker) => fixture.result(worker));
		await Promise.all(results.map((result) => fixture.reopen().lifecycle().complete(result, signal)));
		await Promise.all(
			results.map((result) =>
				fixture
					.reopen()
					.lifecycle()
					.accept(result.workerId, result.completionId, `accept:${result.workerId}`, signal),
			),
		);
		const persisted = await fixture.reopen().tree();
		expect(persisted.document?.acceptedResults).toHaveLength(2);
		expect(persisted.entries.map((entry) => entry.path)).toContain("work/source.md");
		expect(
			fixture.query<number>(
				`select count(*) from public.qorpera_execution_runs where profile_id=${sqlValue(fixture.identity.todo.companyId)};`,
			),
		).toBe(3);
		expect(
			fixture.query<boolean>(
				`select bool_and(not (job.payload ? 'goal') and not (job.payload ? 'transcript') and job.payload ? 'todo') from public.qorpera_runner_jobs as job where job.profile_id=${sqlValue(fixture.identity.todo.companyId)} and job.job_type='worker_component_test';`,
			),
		).toBe(true);
	}, 120_000);

	it("rolls back an interrupted Company File publication before any child admission", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const before = await fixture.lifecycle().status(signal);
		const snapshots = fixture.query<number>(
			`select count(*) from public.qorpera_company_snapshots where profile_id=${sqlValue(fixture.identity.todo.companyId)};`,
		);
		const dispatch = fixture.dispatch();
		fixture.rollbackBeforePublish = true;
		await expect(fixture.lifecycle().dispatch(dispatch, signal)).rejects.toThrow("interrupted before publish");
		const fresh = fixture.reopen();
		expect(await fresh.lifecycle().status(signal)).toEqual(before);
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_company_snapshots where profile_id=${sqlValue(fixture.identity.todo.companyId)};`,
			),
		).toBe(snapshots);
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_execution_runs where source_id=${sqlValue(dispatch.workerId)};`,
			),
		).toBe(0);
		await fresh.lifecycle().dispatch(dispatch, signal);
		expect((await fresh.lifecycle().status(signal)).value.workers[0].phase).toBe("running");
	}, 120_000);

	it("retains interrupted inflight dispatch as uncertain, requiring a durable not-started resolution", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const dispatch = fixture.dispatch();
		fixture.afterFileCommit = (guard) => {
			if (guard.purpose === "reconcile") throw new Error("process died after claim commit");
		};
		await expect(fixture.lifecycle().dispatch(dispatch, signal)).rejects.toThrow("process died");
		const fresh = fixture.reopen();
		await fresh.lifecycle().reconcile(signal);
		await fresh.reopen().lifecycle().reconcile(signal);
		const worker = (await fresh.lifecycle().status(signal)).value.workers[0];
		expect(worker.commands[0].delivery).toBe("uncertain");
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_execution_runs where source_id=${sqlValue(dispatch.workerId)};`,
			),
		).toBe(0);
		const command = worker.commands[0];
		const digest = workerDigest({
			schema: WORKER_RUN_COMMAND_SCHEMA,
			dispatch: worker.dispatch,
			command: {
				key: command.key,
				kind: command.kind,
				epoch: command.epoch,
				sequence: command.sequence,
				text: command.text,
				sources: command.sources,
				resumeCompletionId: command.resumeCompletionId,
			},
		});
		const key = `worker:${dispatch.workerId}:${dispatch.operationKey}`;
		// Explicit test operator resolution. Mere absence above never authorizes resubmission.
		fresh.query(`insert into public.qorpera_run_operation_receipts(id,run_id,job_id,assignment_id,logical_operation_key,operation_kind,input_sha256,downstream_idempotency_sha256,status,completed_at,recovery_resolution,recovery_resolved_by_user_id,recovery_resolved_at)
			select ${sqlValue(randomUUID())},id,job_id,${sqlValue(fresh.identity.assignmentId)},${sqlValue(key)},'test_worker_command',${sqlValue(digest)},${sqlValue(workerDigest([fresh.identity.parent.runId, key]))},'cancelled',statement_timestamp(),'confirmed_not_run',${sqlValue(fresh.identity.parent.requesterUserId)},statement_timestamp() from public.qorpera_execution_runs where id=${sqlValue(fresh.identity.parent.runId)};`);
		await fresh.reopen().lifecycle().reconcile(signal);
		expect((await fresh.lifecycle().status(signal)).value.workers[0].phase).toBe("running");
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_execution_runs where source_id=${sqlValue(dispatch.workerId)};`,
			),
		).toBe(1);
	}, 120_000);

	it("cancels an admitted child after a lost response and ignores its late completion across reconstruction", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const dispatch = fixture.dispatch();
		fixture.afterRunCommit = () => {
			throw new Error("lost admission response");
		};
		await expect(fixture.lifecycle().dispatch(dispatch, signal)).rejects.toThrow(WorkerReconciliationRequired);
		const fresh = fixture.reopen();
		const cancelled = await fresh.lifecycle().cancel(dispatch.workerId, "cancel", signal);
		expect(cancelled.phase).toBe("cancelled");
		expect(cancelled.commands.at(-1)?.delivery).toBe("confirmed");
		expect(cancelled.execution).not.toBeNull();
		const result = fresh.result({ ...cancelled, epoch: 1 });
		expect(await fresh.reopen().lifecycle().complete(result, signal)).toBe("ignored");
		const persisted = (await fresh.reopen().lifecycle().status(signal)).value;
		expect(persisted.workers[0].continuation).toBeNull();
		expect(persisted.acceptedResults).toEqual([]);
		expect(
			fresh.query<string>(
				`select to_jsonb(job.status) from public.qorpera_runner_jobs as job join public.qorpera_execution_runs as run on run.job_id=job.id where run.id=${sqlValue(cancelled.execution!.runId)};`,
			),
		).toBe("cancelled");
	}, 120_000);

	it("deduplicates lost private continuation acknowledgements and denies consumption after authority loss", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const worker = await fixture.lifecycle().dispatch(fixture.dispatch(), signal);
		await fixture.lifecycle().complete(fixture.result(worker), signal);
		fixture.afterContinuationCommit = () => {
			throw new Error("lost continuation acknowledgement");
		};
		await expect(fixture.lifecycle().reconcile(signal)).rejects.toThrow(WorkerReconciliationRequired);
		const fresh = fixture.reopen();
		await fresh.lifecycle().reconcile(signal);
		await fresh.reopen().lifecycle().reconcile(signal);
		const intent = (await fresh.lifecycle().status(signal)).value.workers[0].continuation!;
		expect(intent.delivery).toBe("confirmed");
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_run_operation_receipts where run_id=${sqlValue(fresh.identity.parent.runId)} and operation_kind='test_worker_continuation';`,
			),
		).toBe(1);
		fresh.query(
			`select public.qorpera_set_execution_sponsor_status(${sqlValue(fresh.identity.todo.companyId)},${sqlValue(fresh.identity.sponsorId)},'revoked');`,
		);
		await expect(fresh.reopen().lifecycle().resolveContinuation(intent, signal)).rejects.toThrow("revoked");
	}, 120_000);

	it.each(["admission-ack", "status-publication"] as const)(
		"never durably marks admission running after revocation during %s",
		async (timing) => {
			const fixture = await createPostgresWorkerFixture(container!, objects!);
			const dispatch = fixture.dispatch();
			const revoke = () =>
				fixture.query(
					`select public.qorpera_set_execution_sponsor_status(${sqlValue(fixture.identity.todo.companyId)},${sqlValue(fixture.identity.sponsorId)},'revoked');`,
				);
			if (timing === "admission-ack")
				fixture.afterRunCommit = (request) => {
					if (request.command.kind === "dispatch") revoke();
				};
			else
				fixture.beforeFilePublish = (guard) => {
					if (guard.purpose === "status") revoke();
				};
			await expect(fixture.lifecycle().dispatch(dispatch, signal)).rejects.toThrow();
			const acknowledged = (await fixture.reopen().tree()).document!.workers[0];
			expect(acknowledged.commands[0].delivery).toBe("confirmed");
			expect(acknowledged.execution).not.toBeNull();
			expect(acknowledged.phase).not.toBe("running");
			await fixture.reopen().lifecycle().reconcile(signal);
			const fenced = (await fixture.reopen().tree()).document!.workers[0];
			expect(fenced.phase).toBe("revoked");
			expect(fenced.epoch).toBe(2);
			expect(fenced.commands.at(-1)?.delivery).toBe("confirmed");
			expect(
				fixture.query<number>(
					`select count(*) from public.qorpera_execution_runs where source_id=${sqlValue(dispatch.workerId)};`,
				),
			).toBe(1);
			expect(
				fixture.query<string>(
					`select to_jsonb(job.status) from public.qorpera_runner_jobs as job join public.qorpera_execution_runs as run on run.job_id=job.id where run.id=${sqlValue(fenced.execution!.runId)};`,
				),
			).toBe("failed"); // Existing sponsor revocation owns the terminal job outcome.
		},
		120_000,
	);

	it("recovers an explicitly resumed blocked checkpoint after a lost acknowledgement and unclean restart", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const worker = await fixture.lifecycle().dispatch(fixture.dispatch(), signal);
		const blocked = fixture.result(worker, false, { outcome: "blocked" });
		await fixture.lifecycle().complete(blocked, signal);
		await fixture.lifecycle().reconcile(signal);
		const oldIntent = (await fixture.lifecycle().status(signal)).value.workers[0].continuation!;
		const input = {
			operationKey: "resume",
			completionId: blocked.completionId,
			text: "The missing bounded input is now available.",
			sources: [],
		};
		fixture.afterRunCommit = (request) => {
			if (request.command.kind === "followup") throw new Error("lost resumed input acknowledgement");
		};
		await expect(fixture.lifecycle().resumeBlocked(worker.dispatch.workerId, input, signal)).rejects.toThrow(
			WorkerReconciliationRequired,
		);
		const before = await fixture.reopen().lifecycle().status(signal);
		expect(before.value.workers[0].history[0]).toEqual({
			result: blocked,
			continuation: { ...oldIntent, delivery: "suppressed" },
		});
		expect(before.value.workers[0].commands.at(-1)?.delivery).toBe("uncertain");
		await restartDisposablePostgres();
		const fresh = fixture.reopen();
		expect(await fresh.lifecycle().status(signal)).toEqual(before);
		await fresh.lifecycle().reconcile(signal);
		const resumed = await fresh.lifecycle().resumeBlocked(worker.dispatch.workerId, input, signal);
		expect(resumed).toMatchObject({ phase: "running", epoch: 1, sequence: 1, execution: worker.execution });
		expect(resumed.dispatch).toEqual(worker.dispatch);
		expect(resumed.commands.at(-1)).toMatchObject({
			resumeCompletionId: blocked.completionId,
			delivery: "confirmed",
		});
		expect(await fresh.lifecycle().complete(blocked, signal)).toBe("superseded");
		await expect(fresh.lifecycle().resolveContinuation(oldIntent, signal)).rejects.toThrow();
		const result = fresh.result(resumed);
		await fresh.lifecycle().complete(result, signal);
		await fresh.lifecycle().accept(worker.dispatch.workerId, result.completionId, "accept", signal);
		await fresh.lifecycle().reconcile(signal);
		const finished = await fresh.lifecycle().finishTodo("finish", signal);
		expect(finished.value.acceptedResults.map((item) => item.result)).toEqual([result]);
		expect(finished.value.workers[0].history[0].result).toEqual(blocked);
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_execution_runs where source_id=${sqlValue(worker.dispatch.workerId)};`,
			),
		).toBe(1);
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_run_operation_receipts where run_id=${sqlValue(fresh.identity.parent.runId)} and operation_kind='test_worker_command';`,
			),
		).toBe(2);
		expect(
			fresh.query<number>(
				`select count(*) from public.qorpera_run_operation_receipts where run_id=${sqlValue(fresh.identity.parent.runId)} and operation_kind='test_worker_continuation';`,
			),
		).toBe(2);
	}, 120_000);

	it.each(["company-file", "proposal"] as const)(
		"retains accepted %s receipts and actual stored bytes across an unclean restart",
		async (kind) => {
			const fixture = await createPostgresWorkerFixture(container!, objects!);
			const worker = await fixture.lifecycle().dispatch(fixture.dispatchOutput(kind), signal);
			const initialHead = (await fixture.tree()).head;
			const body = `# Bounded worker output\n\nStored ${kind} evidence: æøå 日本語.\n`;
			const work = await fixture.publishWorkerOutput(worker, kind, body);
			const source = work.kind === "company-file" ? work.outputs[0] : work.sources[0];
			if (kind === "proposal") expect((await fixture.tree()).head).toBe(initialHead);
			const result = fixture.result(worker, false, { work });
			await fixture.lifecycle().complete(result, signal);
			await fixture.lifecycle().accept(worker.dispatch.workerId, result.completionId, "accept", signal);
			const before = await fixture.lifecycle().status(signal);
			expect(before.value.acceptedResults[0].result.work).toEqual(work);
			expect(before.value.workers[0].continuation?.delivery).toBe("pending");
			await restartDisposablePostgres();
			const fresh = fixture.reopen();
			expect(await fresh.lifecycle().status(signal)).toEqual(before);
			const entry = (await fresh.snapshotEntries(source.version)).find((entry) => entry.path === source.path);
			if (entry?.kind !== "file") throw new Error("Stored output file disappeared");
			expect(Buffer.from(await fresh.objects.getFile(fresh.identity.todo.companyId, entry.file)).toString()).toBe(
				body,
			);
			expect(await fresh.publishWorkerOutput(worker, kind, body)).toEqual(work);
			expect(await fresh.lifecycle().complete(result, signal)).toBe("duplicate");
			await fresh.lifecycle().accept(worker.dispatch.workerId, result.completionId, "accept", signal);
			await fresh.lifecycle().reconcile(signal);
			const finished = await fresh.lifecycle().finishTodo("finish", signal);
			expect(finished.value.state).toBe("done");
			expect(finished.value.acceptedResults).toHaveLength(1);
			expect(finished.value.workers[0].continuation?.delivery).toBe("confirmed");
			const liveEntry = (await fresh.tree()).entries.find((entry) => entry.path === source.path);
			if (work.kind === "company-file") expect(liveEntry).toEqual(entry);
			else {
				expect(liveEntry).toBeUndefined();
				expect(
					fresh.query<{ status: string; proposal_snapshot_id: string; execution_id: string }>(
						`select to_jsonb(proposal) from public.qorpera_company_proposals as proposal where id=${sqlValue(work.proposalId)};`,
					),
				).toMatchObject({
					status: "open",
					proposal_snapshot_id: source.version,
					execution_id: worker.execution!.runId,
				});
				expect(
					fresh.query<number>(
						`select count(*) from public.qorpera_company_proposal_revisions where proposal_id=${sqlValue(work.proposalId)};`,
					),
				).toBe(1);
			}
			expect(
				fresh.query<number>(
					`select count(*) from public.qorpera_run_operation_receipts where run_id=${sqlValue(fresh.identity.parent.runId)} and operation_kind='test_worker_output';`,
				),
			).toBe(1);
			expect(
				fresh.query<number>(
					`select count(*) from public.qorpera_execution_runs where profile_id=${sqlValue(fresh.identity.todo.companyId)};`,
				),
			).toBe(2);
			expect(
				fresh.query<number>(
					`select count(*) from public.qorpera_session_inputs as input join public.qorpera_shared_sessions as session on session.id=input.session_id where session.profile_id=${sqlValue(fresh.identity.todo.companyId)};`,
				),
			).toBe(0);
		},
		120_000,
	);

	it("rejects missing, substituted and cross-worker artifact receipts despite authentic completion receipts", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const worker = await fixture.lifecycle().dispatch(fixture.dispatchOutput("company-file"), signal);
		const other = await fixture.lifecycle().dispatch(fixture.dispatch(), signal);
		await expect(fixture.publishWorkerOutput(other, "company-file", "Unauthorized output")).rejects.toThrow(
			"explicit output grant",
		);
		const work = await fixture.publishWorkerOutput(worker, "company-file", "Accepted evidence\n");
		if (work.kind !== "company-file") throw new Error("Expected artifact result");
		const invalid: WorkerResult["work"][] = [
			{ ...work, receiptIds: [randomUUID()] },
			{ ...work, outputs: [{ ...work.outputs[0], objectId: randomUUID() }] },
			{ ...work, outputs: [{ ...work.outputs[0], version: randomUUID() }] },
			{ ...work, outputs: [{ ...work.outputs[0], path: "work/source.md" }] },
		];
		const before = await fixture.lifecycle().status(signal);
		for (const replacement of invalid) {
			const result = fixture.result(worker, false, { work: replacement });
			await expect(fixture.lifecycle().complete(result, signal)).rejects.toThrow("Output receipt");
		}
		await expect(fixture.lifecycle().complete(fixture.result(other, false, { work }), signal)).rejects.toThrow(
			"Output receipt",
		);
		expect(await fixture.reopen().lifecycle().status(signal)).toEqual(before);
		const valid = fixture.result(worker, false, { work });
		await fixture.lifecycle().complete(valid, signal);
		await fixture.lifecycle().accept(worker.dispatch.workerId, valid.completionId, "accept", signal);
		expect((await fixture.reopen().tree()).document?.acceptedResults[0].result.work).toEqual(work);
	}, 120_000);

	it("rejects acceptance when a live artifact changes after receipt preflight but before publication", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const worker = await fixture.lifecycle().dispatch(fixture.dispatchOutput("company-file"), signal);
		const work = await fixture.publishWorkerOutput(worker, "company-file", "Original output\n");
		if (work.kind !== "company-file") throw new Error("Expected artifact result");
		const result = fixture.result(worker, false, { work });
		await fixture.lifecycle().complete(result, signal);
		fixture.beforeFilePublish = async (guard) => {
			if (guard.purpose !== "accept") return;
			fixture.beforeFilePublish = undefined;
			const current = await fixture.reopen().tree();
			const replacement = await fixture.objects.putFile(
				fixture.identity.todo.companyId,
				Buffer.from("Superseding output\n"),
				"application/octet-stream",
			);
			await fixture
				.reopen()
				.publish(
					[
						...current.entries.filter((entry) => entry.path !== work.outputs[0].path),
						{ kind: "file", path: work.outputs[0].path, executable: false, file: replacement },
					],
					current.head,
					randomUUID(),
				);
		};
		await expect(
			fixture.lifecycle().accept(worker.dispatch.workerId, result.completionId, "accept", signal),
		).rejects.toThrow("receipted live Company File artifact");
		expect((await fixture.reopen().tree()).document?.acceptedResults).toEqual([]);
	}, 120_000);

	it("rechecks proposal identity and rejection inside the acceptance transaction without publishing proposed bytes", async () => {
		const fixture = await createPostgresWorkerFixture(container!, objects!);
		const worker = await fixture.lifecycle().dispatch(fixture.dispatchOutput("proposal"), signal);
		const work = await fixture.publishWorkerOutput(
			worker,
			"proposal",
			"Proposed evidence awaiting separate approval\n",
		);
		if (work.kind !== "proposal") throw new Error("Expected proposal result");
		const wrong = fixture.result(worker, false, { work: { ...work, proposalId: randomUUID() } });
		await expect(fixture.lifecycle().complete(wrong, signal)).rejects.toThrow("Proposal output");
		const result = fixture.result(worker, false, { work });
		await fixture.lifecycle().complete(result, signal);
		const before = await fixture.lifecycle().status(signal);
		fixture.beforeFilePublish = (guard) => {
			if (guard.purpose === "accept")
				fixture.query(
					`update public.qorpera_company_proposals set status='rejected',resolved_by_user_id=${sqlValue(fixture.identity.parent.requesterUserId)},resolved_at=statement_timestamp() where id=${sqlValue(work.proposalId)};`,
				);
		};
		await expect(
			fixture.lifecycle().accept(worker.dispatch.workerId, result.completionId, "accept", signal),
		).rejects.toThrow("proposal changed before result publication");
		expect(await fixture.reopen().lifecycle().status(signal)).toEqual(before);
		expect((await fixture.reopen().tree()).entries.some((entry) => entry.path === work.sources[0].path)).toBe(false);
		await expect(
			fixture.reopen().lifecycle().accept(worker.dispatch.workerId, result.completionId, "retry", signal),
		).rejects.toThrow("Proposal output");
	}, 120_000);
});
