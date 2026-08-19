import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessionArbiter } from "../src/cloud-session-arbiter.ts";
import { type HostedPrimaryTransport, QorperaHostedPrimary } from "../src/hosted-primary.ts";

const ENVIRONMENT = "5cd97efb-4318-4e21-9bd7-1a10c949fd65";
const HOSTED_SESSION = "8f5773e2-effc-4702-ab48-90c080f92345";
const CLOUD_CLIENT_SESSION = "75a4cfcd-0a14-4f5e-83c1-647d1f032713";
const AUTHOR = "9d527ad0-e843-49cd-8430-6895ea6d6ce4";

interface FakeCalls {
	ensure: Array<Record<string, unknown>>;
	append: Array<Record<string, unknown>>;
	claim: Array<Record<string, unknown>>;
	renew: Array<Record<string, unknown>>;
	complete: Array<Record<string, unknown>>;
}

function fakePrimary(overrides: { created?: boolean; claimResult?: () => unknown }): {
	primary: QorperaHostedPrimary;
	calls: FakeCalls;
} {
	const calls: FakeCalls = { ensure: [], append: [], claim: [], renew: [], complete: [] };
	const transport = {
		async ensureStaffSession(input: Record<string, unknown>) {
			calls.ensure.push(input);
			return {
				session_id: HOSTED_SESSION,
				environment_id: ENVIRONMENT,
				title: "Financial Officer",
				created: overrides.created ?? true,
				created_by_user_id: AUTHOR,
			};
		},
		async listSessions() {
			return [
				{
					session_id: HOSTED_SESSION,
					client_session_id: CLOUD_CLIENT_SESSION,
					profile_id: AUTHOR,
					environment_id: ENVIRONMENT,
					title: "Financial Officer",
					staff_agent_id: "staff-1",
					status: "open",
					created_by_user_id: AUTHOR,
					created_at: "2026-08-18T14:00:00.000Z",
					updated_at: "2026-08-18T14:00:00.000Z",
				},
			];
		},
		async appendSessionInput(input: Record<string, unknown>) {
			calls.append.push(input);
			return { input_id: CLOUD_CLIENT_SESSION, position: 1 };
		},
		async claimSessionTurn(input: Record<string, unknown>) {
			calls.claim.push(input);
			return overrides.claimResult
				? overrides.claimResult()
				: {
						claimed: true,
						inputs: [
							{
								input_id: CLOUD_CLIENT_SESSION,
								position: 1,
								kind: "user_message",
								author_user_id: AUTHOR,
								body: { text: "hello" },
								created_at: "2026-08-18T14:00:01.000Z",
							},
						],
					};
		},
		async renewSessionTurn(input: Record<string, unknown>) {
			calls.renew.push(input);
			return { renewed: 1 };
		},
		async completeSessionTurn(input: Record<string, unknown>) {
			calls.complete.push(input);
			return { completed: 1 };
		},
	} as unknown as HostedPrimaryTransport;
	return { primary: new QorperaHostedPrimary(transport), calls };
}

describe("CloudSessionArbiter", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("keeps its own client session identity when the ensure creates", async () => {
		const { primary, calls } = fakePrimary({ created: true });
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		const ref = await arbiter.ensureSession("staff-1", "Financial Officer", CLOUD_CLIENT_SESSION);
		expect(ref.created).toBe(true);
		expect(ref.clientSessionId).toBe(CLOUD_CLIENT_SESSION);
		expect(ref.hostedSessionId).toBe(HOSTED_SESSION);
		expect(calls.ensure[0]?.p_client_session_id).toBe(CLOUD_CLIENT_SESSION);
		expect(arbiter.sessionForStaff("staff-1")).toEqual(ref);
	});

	it("adopts the cloud's trail identity when the session already exists", async () => {
		const { primary } = fakePrimary({ created: false });
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		// The preferred id loses: the cloud's client session id is the shared
		// trail identity every machine must converge on.
		const ref = await arbiter.ensureSession("staff-1", "Financial Officer", AUTHOR);
		expect(ref.created).toBe(false);
		expect(ref.clientSessionId).toBe(CLOUD_CLIENT_SESSION);
	});

	it("holds one claim at a time and refuses a second locally", async () => {
		const { primary, calls } = fakePrimary({});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		const claim = await arbiter.claimTurn("staff-1");
		expect(claim?.inputs).toHaveLength(1);
		expect(arbiter.activeClaim).toBeDefined();
		expect(await arbiter.claimTurn("staff-1")).toBeUndefined();
		expect(calls.claim).toHaveLength(1);
	});

	it("returns nothing when the cloud refuses the turn", async () => {
		const { primary } = fakePrimary({ claimResult: () => ({ claimed: false, reason: "turn-in-flight" }) });
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		expect(await arbiter.claimTurn("staff-1")).toBeUndefined();
		expect(arbiter.activeClaim).toBeUndefined();
	});

	it("completes a turn exactly once and only while claimed", async () => {
		const { primary, calls } = fakePrimary({});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		await arbiter.claimTurn("staff-1");
		await arbiter.completeTurn();
		await arbiter.completeTurn();
		expect(calls.complete).toHaveLength(1);
		expect(arbiter.activeClaim).toBeUndefined();
	});

	it("abandoning never marks inputs consumed", async () => {
		const { primary, calls } = fakePrimary({});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		await arbiter.claimTurn("staff-1");
		arbiter.abandonClaim();
		await arbiter.completeTurn();
		expect(calls.complete).toHaveLength(0);
	});

	it("throttles lease renewal to the renew interval", async () => {
		vi.useFakeTimers();
		try {
			const { primary, calls } = fakePrimary({});
			const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
			await arbiter.ensureSession("staff-1", "Financial Officer");
			await arbiter.claimTurn("staff-1");
			await arbiter.renewIfDue();
			expect(calls.renew).toHaveLength(0);
			vi.advanceTimersByTime(50_000);
			await arbiter.renewIfDue();
			expect(calls.renew).toHaveLength(1);
			await arbiter.renewIfDue();
			expect(calls.renew).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("appends user messages against the ensured session", async () => {
		const { primary, calls } = fakePrimary({});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		await arbiter.appendUserMessage("staff-1", "sync check");
		expect(calls.append[0]?.p_session_id).toBe(HOSTED_SESSION);
		expect((calls.append[0]?.p_body as { text?: string })?.text).toBe("sync check");
		await expect(arbiter.appendUserMessage("staff-2", "no session")).rejects.toThrow(
			"staff session has not been ensured",
		);
	});
});
