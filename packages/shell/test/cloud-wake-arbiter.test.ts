import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWakeArbiter } from "../src/cloud-wake-arbiter.ts";
import { type HostedPrimaryTransport, QorperaHostedPrimary } from "../src/hosted-primary.ts";

const ENVIRONMENT = "5cd97efb-4318-4e21-9bd7-1a10c949fd65";

interface FakeCalls {
	claim: Array<Record<string, unknown>>;
	renew: Array<Record<string, unknown>>;
	complete: Array<Record<string, unknown>>;
}

function fakePrimary(overrides: { claimResult?: () => unknown } = {}): {
	primary: QorperaHostedPrimary;
	calls: FakeCalls;
} {
	const calls: FakeCalls = { claim: [], renew: [], complete: [] };
	const transport = {
		async claimWake(input: Record<string, unknown>) {
			calls.claim.push(input);
			return overrides.claimResult ? overrides.claimResult() : { claimed: true };
		},
		async renewWake(input: Record<string, unknown>) {
			calls.renew.push(input);
			return { renewed: 1 };
		},
		async completeWake(input: Record<string, unknown>) {
			calls.complete.push(input);
			return { completed: 1 };
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
		expect(await arbiter.claim("job:demo:slot:1")).toBe("claimed");
		expect(arbiter.activeKey).toBe("job:demo:slot:1");
		expect(calls.claim[0]).toMatchObject({
			p_environment_id: ENVIRONMENT,
			p_wake_key: "job:demo:slot:1",
			p_claimant_id: arbiter.claimantId,
		});
	});

	it("distinguishes an in-flight loss from a finished occurrence", async () => {
		const inFlight = fakePrimary({ claimResult: () => ({ claimed: false, reason: "in-flight" }) });
		const arbiterA = new CloudWakeArbiter(inFlight.primary, ENVIRONMENT);
		expect(await arbiterA.claim("job:demo:slot:1")).toBe("lost-in-flight");
		expect(arbiterA.activeKey).toBeUndefined();

		const alreadyRun = fakePrimary({ claimResult: () => ({ claimed: false, reason: "already-run" }) });
		const arbiterB = new CloudWakeArbiter(alreadyRun.primary, ENVIRONMENT);
		expect(await arbiterB.claim("job:demo:slot:1")).toBe("lost-already-run");
		expect(arbiterB.activeKey).toBeUndefined();
	});

	it("completes the active claim exactly once and only while claimed", async () => {
		const { primary, calls } = fakePrimary();
		const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
		await arbiter.claim("job:demo:slot:1");
		await arbiter.complete();
		await arbiter.complete();
		expect(calls.complete).toHaveLength(1);
		expect(arbiter.activeKey).toBeUndefined();
	});

	it("abandoning never marks the occurrence final", async () => {
		const { primary, calls } = fakePrimary();
		const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
		await arbiter.claim("job:demo:slot:1");
		arbiter.abandon();
		await arbiter.complete();
		expect(calls.complete).toHaveLength(0);
	});

	it("throttles lease renewal and stops renewing once released", async () => {
		vi.useFakeTimers();
		try {
			const { primary, calls } = fakePrimary();
			const arbiter = new CloudWakeArbiter(primary, ENVIRONMENT);
			await arbiter.claim("job:demo:slot:1");
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
});
