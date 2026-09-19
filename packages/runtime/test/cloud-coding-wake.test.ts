import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import { type CloudWakeEnvelope, parseCloudWakeEnvelope } from "../src/cloud-wake-bus.ts";

function fixture() {
	const { authority } = nativeToolAuthorityFixture();
	const identity = { ...authority.identity, sessionId: null };
	const parentRunId = randomUUID();
	const eventId = randomUUID();
	const requestId = randomUUID();
	const workerId = randomUUID();
	const wake: CloudWakeEnvelope = {
		schema: "qorpera.wake-envelope/v1",
		id: randomUUID(),
		runId: identity.runId,
		kind: "agent",
		companyId: identity.companyId,
		environmentId: identity.environmentId,
		staffAgentId: identity.staffAgentId,
		requesterUserId: identity.requesterUserId,
		actorStaffId: null,
		actorUserId: null,
		audience: { kind: "company", userId: null, sessionId: null },
		source: { kind: "coding-completion", id: eventId, occurrenceKey: `coding-completion:${workerId}:2:${requestId}` },
		policy: {
			schema: "qorpera.wake-policy/v1",
			kind: "agent",
			initial: "forbidden",
			final: "forbidden",
			silenceAllowed: true,
			maxPublicSends: 0,
		},
		time: { utc: "2026-09-19T12:00:00.000000Z", local: "2026-09-19T12:00:00.000000", timeZone: "UTC" },
		pins: {
			companySnapshotId: randomUUID(),
			staffVersion: identity.staffVersion,
			wakeSchema: "qorpera.wake-envelope/v1",
			runtimeBundleVersion: null,
		},
		routine: null,
		parentRunId,
		causal: { rootId: randomUUID(), agentIds: [identity.staffAgentId] },
		payload: {
			schema: "qorpera.coding-completion/v1",
			eventId,
			requestId,
			workerId,
			turn: 2,
			receiptId: randomUUID(),
			worker: {
				schema: "qorpera.coding-worker/v1",
				id: workerId,
				companyId: identity.companyId,
				parentAgentId: identity.staffAgentId,
				parentRunId: randomUUID(),
				repository: { host: "github.com", owner: "Qorpera", name: "app", baseBranch: "main" },
				branch: `qorpera/coding/${workerId}`,
				vmId: randomUUID(),
				version: 8,
				state: "completed",
				turn: 2,
				pullRequest: { url: "https://github.com/Qorpera/app/pull/2", number: 2, headSha: "a".repeat(40) },
			},
			result: { summary: "Draft PR ready", draftPrVerified: true },
		},
	};
	return { identity, wake };
}

describe("coding completion wake", () => {
	it("binds event, request and turn to the same worker without a human audience", () => {
		const { identity, wake } = fixture();
		const parsed = parseCloudWakeEnvelope(wake, identity);
		expect(parsed).toEqual(wake);
		expect(parsed.policy.maxPublicSends).toBe(0);
		expect(Object.isFrozen(parsed.payload.worker)).toBe(true);
	});
	it.each([
		{ actorUserId: randomUUID() },
		{ actorStaffId: randomUUID() },
		{ parentRunId: null },
		{ audience: { kind: "company", userId: null, sessionId: randomUUID() } },
	])("rejects substituted actor or audience %j", (change) => {
		const { identity, wake } = fixture();
		expect(() => parseCloudWakeEnvelope({ ...wake, ...change }, identity)).toThrow();
	});
	it.each([
		{ eventId: randomUUID() },
		{ requestId: randomUUID() },
		{ workerId: randomUUID() },
		{ turn: 1 },
		{ receiptId: null },
		{ extraAuthority: "instructions" },
		{ result: { reason: "unrecognized" } },
		{ result: { summary: "Ready", noChange: "true" } },
		{ result: { summary: "Ready", secret: "hidden" } },
		{ result: { summary: "a".repeat(8193) } },
	])("rejects changed completion identity or unbounded result %j", (change) => {
		const { identity, wake } = fixture();
		expect(() => parseCloudWakeEnvelope({ ...wake, payload: { ...wake.payload, ...change } }, identity)).toThrow();
	});
	it.each(["companyId", "parentAgentId", "id", "turn", "state"])("rejects changed worker %s", (key) => {
		const { identity, wake } = fixture();
		const worker = wake.payload.worker as Record<string, unknown>;
		expect(() =>
			parseCloudWakeEnvelope(
				{
					...wake,
					payload: {
						...wake.payload,
						worker: { ...worker, [key]: key === "turn" ? 3 : key === "state" ? "running" : randomUUID() },
					},
				},
				identity,
			),
		).toThrow();
	});
	it("does not accept a coworker or office source as coding completion", () => {
		const { identity, wake } = fixture();
		for (const kind of ["coworker", "office-activation"])
			expect(() => parseCloudWakeEnvelope({ ...wake, source: { ...wake.source, kind } }, identity)).toThrow();
	});
	it("accepts typed failure evidence without treating it as human authorization", () => {
		const { identity, wake } = fixture();
		expect(
			parseCloudWakeEnvelope(
				{
					...wake,
					payload: {
						...wake.payload,
						worker: { ...(wake.payload.worker as Record<string, unknown>), state: "recovery-required" },
						result: { reason: "executor-lease-expired" },
					},
				},
				identity,
			).policy.final,
		).toBe("forbidden");
	});
});
