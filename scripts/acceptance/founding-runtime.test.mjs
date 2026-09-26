import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { foundingRuntimeHandoff, assertFoundingRuntimeWork } from "./founding-runtime.mjs";

function fixture() {
	const creator = randomUUID(), launcher = randomUUID(), input = randomUUID();
	const receipt = { receiptId: randomUUID(), turnRequestId: randomUUID(), roster: [{ userId: creator }, { userId: launcher }] };
	const run = { id: randomUUID(), profile_id: randomUUID(), job_id: randomUUID(), environment_id: randomUUID(),
		source_id: randomUUID(), source_kind: "session_turn", session_id: randomUUID(), company_snapshot_id: randomUUID(),
		substrate_version_id: randomUUID(), staff_agent_id: randomUUID(), staff_version: 1, compute_identity_id: randomUUID(),
		requested_by_user_id: launcher, sponsored_by_user_id: launcher, sponsor_binding_id: randomUUID(), sponsor_version: 1, input_ids: [input] };
	const runtime = { phase: "launched", requestCount: 1, request: { id: receipt.turnRequestId, status: "materialized",
		run_id: run.id, profile_id: run.profile_id, input_id: input }, run, receipt, owners: [creator, launcher],
		source: { kind: "private_startup", authorUserId: creator, text: JSON.stringify({ founding: receipt }) } };
	const publication = { state: "completed", published: "published", closureVerified: true, graphStatus: "complete",
		environmentId: run.environment_id, snapshotId: run.company_snapshot_id };
	const pins = foundingRuntimeHandoff(runtime, publication);
	const work = { ...pins, computeIdentityOwnershipKind: "member", computeIdentityOwnerUserId: launcher,
		sponsor: { bindingId: pins.sponsorBindingId, version: pins.sponsorVersion, kind: "member_connection",
			authenticationMode: "native_subscription", provider: "openai", nativeHarness: "codex-cli" } };
	return { runtime, publication, pins, work };
}

test("handoff retains the browser's exact run, published bytes and noncreator sponsor without credentials", () => {
	const { pins, work, runtime } = fixture();
	assertFoundingRuntimeWork(pins, work);
	assert(Object.isFrozen(pins) && Object.isFrozen(pins.inputIds));
	assert.equal(pins.requestedByUserId, runtime.owners[1]);
	assert.equal(pins.runId, runtime.run.id);
	assert(!JSON.stringify(pins).includes("private_startup"));
	assert(!Object.hasOwn(pins, "source"));
});

test("handoff refuses fixture publication, another snapshot, another run and rewritten startup", () => {
	for (const corrupt of [
		({ publication }) => { publication.closureVerified = false; },
		({ publication }) => { publication.snapshotId = randomUUID(); },
		({ runtime }) => { runtime.request.run_id = randomUUID(); },
		({ runtime }) => { runtime.source.text = JSON.stringify({ founding: {} }); },
		({ runtime }) => { runtime.run.sponsored_by_user_id = runtime.owners[0]; },
	]) {
		const value = fixture(); corrupt(value);
		assert.throws(() => foundingRuntimeHandoff(value.runtime, value.publication));
	}
});

test("provider boundary rejects another queued company or cross-member model before physical acquisition", () => {
	for (const corrupt of [
		(work) => { work.runId = randomUUID(); },
		(work) => { work.profileId = randomUUID(); },
		(work) => { work.companySnapshotId = randomUUID(); },
		(work) => { work.computeIdentityOwnerUserId = randomUUID(); },
		(work) => { work.sponsor.bindingId = randomUUID(); },
		(work) => { work.inputIds = [randomUUID()]; },
	]) {
		const { pins, work } = fixture(); corrupt(work);
		assert.throws(() => assertFoundingRuntimeWork(pins, work));
	}
});
