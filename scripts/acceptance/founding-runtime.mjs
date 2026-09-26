import assert from "node:assert/strict";
import { CloudRunnerOrchestrator } from "../../packages/runner-orchestrator/src/orchestrator.ts";
import { sqlUuid } from "./founding-fixtures.mjs";

/** Detached authority pins from the actual materialized browser launch. This
 * contains no member session, model credential, database handle or capability. */
export function foundingRuntimeHandoff(runtime, publication) {
	assert.equal(runtime.phase, "launched");
	assert.equal(runtime.requestCount, 1);
	assert.equal(runtime.request.status, "materialized");
	const run = runtime.run;
	assert.equal(runtime.request.run_id, run.id);
	assert.equal(runtime.request.profile_id, run.profile_id);
	assert.equal(runtime.receipt.turnRequestId, runtime.request.id);
	assert.equal(runtime.source.kind, "private_startup");
	assert.deepEqual(JSON.parse(runtime.source.text).founding, runtime.receipt);
	assert.equal(publication.state, "completed");
	assert.equal(publication.published, "published");
	assert.equal(publication.closureVerified, true);
	assert.equal(publication.graphStatus, "complete");
	assert.equal(publication.environmentId, run.environment_id);
	assert.equal(publication.snapshotId, run.company_snapshot_id);
	assert.equal(run.requested_by_user_id, run.sponsored_by_user_id);
	assert(runtime.owners.includes(run.requested_by_user_id));
	assert(runtime.owners.includes(runtime.source.authorUserId));
	const pins = {
		schema: "qorpera.founding-runtime-handoff/v1",
		profileId: run.profile_id,
		runId: run.id,
		jobId: run.job_id,
		environmentId: run.environment_id,
		sourceId: run.source_id,
		sourceKind: run.source_kind,
		sessionId: run.session_id,
		companySnapshotId: run.company_snapshot_id,
		substrateVersionId: run.substrate_version_id,
		staffAgentId: run.staff_agent_id,
		staffVersion: run.staff_version,
		computeIdentityId: run.compute_identity_id,
		requestedByUserId: run.requested_by_user_id,
		sponsoredByUserId: run.sponsored_by_user_id,
		sponsorBindingId: run.sponsor_binding_id,
		sponsorVersion: run.sponsor_version,
		receiptId: runtime.receipt.receiptId,
		inputIds: Object.freeze([...run.input_ids]),
	};
	for (const key of Object.keys(pins).filter((key) => key.endsWith("Id"))) sqlUuid(pins[key]);
	for (const id of pins.inputIds) sqlUuid(id);
	assert.equal(pins.sourceKind, "session_turn");
	assert(pins.inputIds.includes(runtime.request.input_id));
	assert(Number.isSafeInteger(pins.staffVersion) && pins.staffVersion > 0);
	assert(Number.isSafeInteger(pins.sponsorVersion) && pins.sponsorVersion > 0);
	return Object.freeze(pins);
}

export function assertFoundingRuntimeWork(pins, work) {
	assert.equal(pins.schema, "qorpera.founding-runtime-handoff/v1");
	for (const key of ["profileId", "runId", "jobId", "environmentId", "sourceId", "sourceKind", "sessionId",
		"companySnapshotId", "substrateVersionId", "staffAgentId", "staffVersion", "computeIdentityId",
		"requestedByUserId", "sponsoredByUserId"]) assert.equal(work[key], pins[key], `Claim changed founding ${key}`);
	assert.deepEqual(work.inputIds, pins.inputIds, "Claim changed founding inputs");
	assert.equal(work.computeIdentityOwnershipKind, "member");
	assert.equal(work.computeIdentityOwnerUserId, pins.sponsoredByUserId);
	assert.equal(work.sponsor.bindingId, pins.sponsorBindingId);
	assert.equal(work.sponsor.version, pins.sponsorVersion);
	assert.equal(work.sponsor.kind, "member_connection");
	assert.equal(work.sponsor.authenticationMode, "native_subscription");
	assert.equal(work.sponsor.provider, "openai");
	assert.equal(work.sponsor.nativeHarness, "codex-cli");
}

/** Run the production orchestration path against the caller's real isolated
 * control plane and LxdCloudRunnerProviderBackend. No synthetic run, claim,
 * runner activation, assignment capability or funding is inserted here. Host
 * composition must also await execution/settlement; assignment alone is not an
 * inference or completed-computer acceptance result. */
export async function dispatchFoundingRuntime({ pins, orchestratorId, controlPlane, backend, signal }) {
	assert(signal instanceof AbortSignal, "Bounded joined execution signal required");
	const adapter = {
		adapterId: backend.adapterId,
		reconcile: (abort) => backend.reconcile(abort),
		acquire: async (work, abort) => {
			assertFoundingRuntimeWork(pins, work);
			return backend.acquire(work.runId, work, abort);
		},
		deliver: async (runner, delivery, abort) => {
			assertFoundingRuntimeWork(pins, delivery.work);
			assert.equal(delivery.assignment.runId, pins.runId);
			assert.equal(delivery.assignment.jobId, pins.jobId);
			return backend.deliver(runner, delivery, abort);
		},
		stop: (runner, reason, abort) => backend.stop(runner, reason, abort),
	};
	const orchestrator = new CloudRunnerOrchestrator({
		orchestratorId, controlPlane, providerAdapter: adapter, claimLeaseSeconds: 900,
		claimRenewalIntervalMs: 30000, assignmentSeconds: 900,
	});
	const result = await orchestrator.runOnce(signal);
	assert.equal(result.reconciliationErrors?.length ?? 0, 0, "Joined runtime reconciliation failed");
	assert.equal(result.status, "assigned", "Browser-created run did not reach actual guest assignment");
	assertFoundingRuntimeWork(pins, result.claim.work);
	return { schema: "qorpera.founding-runtime-dispatch/v1", runId: pins.runId, profileId: pins.profileId,
		companySnapshotId: pins.companySnapshotId, runnerId: result.runner.runnerId,
		assignmentId: result.assignment.assignmentId, status: result.status };
}
