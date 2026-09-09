import { type HostedPrimaryTransport, QorperaHostedPrimary } from "@qorpera/cloud-client/hosted-primary";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWakeArbiter } from "../src/cloud-wake-arbiter.ts";

const ENVIRONMENT = "5cd97efb-4318-4e21-9bd7-1a10c949fd65";
const STAFF = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = "33333333-3333-4333-8333-333333333333";
const EXECUTION = "44444444-4444-4444-8444-444444444444";
const PIN = { companySnapshotId: SNAPSHOT, staffVersion: 7 };

interface FakeCalls {
	claim: Array<Record<string, unknown>>;
	renew: Array<Record<string, unknown>>;
	complete: Array<Record<string, unknown>>;
}

function fakePrimary(
	overrides: { claimResult?: () => unknown; renewResult?: () => unknown; completeResult?: () => unknown } = {},
): {
	primary: QorperaHostedPrimary;
	calls: FakeCalls;
} {
	const calls: FakeCalls = { claim: [], renew: [], complete: [] };
	const transport = {
		async claimWake(input: Record<string, unknown>) {
			calls.claim.push(input);
			return overrides.claimResult
				? overrides.claimResult()
				: { claimed: true, execution_id: EXECUTION, company_snapshot_id: SNAPSHOT, staff_version: 7 };
		},
		async renewWake(input: Record<string, unknown>) {
			calls.renew.push(input);
			return overrides.renewResult ? overrides.renewResult() : { renewed: 1 };
		},
		async completeWake(input: Record<string, unknown>) {
			calls.complete.push(input);
			return overrides.completeResult ? overrides.completeResult() : { completed: 1 };
		},
	} as unknown as HostedPrimaryTransport;
	return { primary: new QorperaHostedPrimary(transport), calls };
}

describe("CloudWakeArbiter", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("wins a claim and carries the machine identity to the cloud", async () => {
		const { primary, calls } = fakePrimary();
		const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
		expect(await arbiter.claim("job:demo:slot:1", STAFF, PIN)).toBe("claimed");
		expect(arbiter.activeKey).toBe("job:demo:slot:1");
		expect(arbiter.activeExecutionId).toBe(EXECUTION);
		expect(calls.claim[0]).toMatchObject({
			p_environment_id: ENVIRONMENT,
			p_wake_key: "job:demo:slot:1",
			p_claimant_id: arbiter.claimantId,
			p_staff_agent_id: STAFF,
			p_company_snapshot_id: SNAPSHOT,
			p_staff_version: 7,
		});
	});

	it("distinguishes an in-flight loss from a finished occurrence", async () => {
		const inFlight = fakePrimary({ claimResult: () => ({ claimed: false, reason: "in-flight" }) });
		const arbiterA = new CloudWakeArbiter(inFlight.primary, ENVIRONMENT);
		expect(await arbiterA.claim("job:demo:slot:1", STAFF, PIN)).toBe("lost-in-flight");
		expect(arbiterA.activeKey).toBeUndefined();

		const alreadyRun = fakePrimary({ claimResult: () => ({ claimed: false, reason: "already-run" }) });
		const arbiterB = new CloudWakeArbiter(alreadyRun.primary, ENVIRONMENT);
		expect(await arbiterB.claim("job:demo:slot:1", STAFF, PIN)).toBe("lost-already-run");
		expect(arbiterB.activeKey).toBeUndefined();

		const stale = fakePrimary({ claimResult: () => ({ claimed: false, reason: "stale-revision" }) });
		const arbiterC = new CloudWakeArbiter(stale.primary, ENVIRONMENT);
		expect(await arbiterC.claim("job:demo:slot:1", STAFF, PIN)).toBe("lost-stale-revision");
		expect(arbiterC.activeKey).toBeUndefined();

		const review = fakePrimary({ claimResult: () => ({ claimed: false, reason: "requires-review" }) });
		const arbiterD = new CloudWakeArbiter(review.primary, ENVIRONMENT);
		expect(await arbiterD.claim("job:demo:slot:1", STAFF, PIN)).toBe("lost-requires-review");
	});

	it("completes the active claim exactly once and only while claimed", async () => {
		const { primary, calls } = fakePrimary();
		const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
		await arbiter.claim("job:demo:slot:1", STAFF, PIN);
		await arbiter.complete();
		await arbiter.complete();
		expect(calls.complete).toHaveLength(1);
		expect(arbiter.activeKey).toBeUndefined();
	});

	it("abandoning never marks the occurrence final", async () => {
		const { primary, calls } = fakePrimary();
		const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
		await arbiter.claim("job:demo:slot:1", STAFF, PIN);
		arbiter.abandon();
		await arbiter.complete();
		expect(calls.complete).toHaveLength(0);
	});

	it("throttles lease renewal and stops renewing once released", async () => {
		vi.useFakeTimers();
		try {
			const { primary, calls } = fakePrimary();
			const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
			await arbiter.claim("job:demo:slot:1", STAFF, PIN);
			await arbiter.renewIfDue();
			expect(calls.renew).toHaveLength(0);
			vi.advanceTimersByTime(65_000);
			await arbiter.renewIfDue();
			expect(calls.renew).toHaveLength(1);
			await arbiter.renewIfDue();
			expect(calls.renew).toHaveLength(1);
			arbiter.abandon();
			vi.advanceTimersByTime(65_000);
			await arbiter.renewIfDue();
			expect(calls.renew).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries transient renewal failures without extending the local lease", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
			const { primary, calls } = fakePrimary({
				renewResult: () => {
					throw new Error("network unavailable");
				},
			});
			const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
			await arbiter.claim("job:demo:slot:1", STAFF, PIN);

			vi.advanceTimersByTime(65_000);
			await expect(arbiter.renewIfDue()).rejects.toThrow("network unavailable");
			await expect(arbiter.renewIfDue()).rejects.toThrow("network unavailable");
			expect(calls.renew).toHaveLength(2);
			expect(arbiter.activeKey).toBe("job:demo:slot:1");

			vi.advanceTimersByTime(236_000);
			await expect(arbiter.renewIfDue()).rejects.toThrow("Wake ownership was lost before renew");
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains the active claim until completion is acknowledged", async () => {
		let attempts = 0;
		const { primary, calls } = fakePrimary({
			completeResult: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("network unavailable");
				return { completed: 1 };
			},
		});
		const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
		await arbiter.claim("job:demo:slot:1", STAFF, PIN);
		await expect(arbiter.complete()).rejects.toThrow("network unavailable");
		expect(arbiter.activeKey).toBe("job:demo:slot:1");
		await arbiter.complete();
		expect(calls.complete).toHaveLength(2);
		expect(arbiter.activeKey).toBeUndefined();
	});
});
