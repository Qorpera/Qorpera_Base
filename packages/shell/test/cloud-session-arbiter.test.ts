import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessionArbiter } from "../src/cloud-session-arbiter.ts";
import { type HostedPrimaryTransport, QorperaHostedPrimary } from "../src/hosted-primary.ts";

const ENVIRONMENT = "5cd97efb-4318-4e21-9bd7-1a10c949fd65";
const HOSTED_SESSION = "8f5773e2-effc-4702-ab48-90c080f92345";
const CLOUD_CLIENT_SESSION = "75a4cfcd-0a14-4f5e-83c1-647d1f032713";
const AUTHOR = "9d527ad0-e843-49cd-8430-6895ea6d6ce4";
const COMPANY_SNAPSHOT = "7e87e5c7-f476-4e95-9e5e-1cc21a0fa4ae";
const TURN = "83bce388-237f-4bff-ab1f-63c8b0773490";
const CLIENT_INPUT = "712716cc-b232-4c66-a393-009415296ee8";
const EXECUTION_PIN = { companySnapshotId: COMPANY_SNAPSHOT, staffVersion: 3 };

interface FakeCalls {
	listPages: Array<Record<string, unknown>>;
	ensure: Array<Record<string, unknown>>;
	append: Array<Record<string, unknown>>;
	claim: Array<Record<string, unknown>>;
	renew: Array<Record<string, unknown>>;
	complete: Array<Record<string, unknown>>;
}

function fakePrimary(overrides: {
	created?: boolean;
	existingSession?: boolean;
	claimResult?: () => unknown;
	renewResult?: () => unknown;
	completeResult?: () => unknown;
	pendingInputs?: () => unknown;
}): {
	primary: QorperaHostedPrimary;
	calls: FakeCalls;
} {
	const calls: FakeCalls = { listPages: [], ensure: [], append: [], claim: [], renew: [], complete: [] };
	const transport = {
		async ensureStaffSession(input: Record<string, unknown>) {
			calls.ensure.push(input);
			return {
				session_id: HOSTED_SESSION,
				client_session_id:
					overrides.created === false ? CLOUD_CLIENT_SESSION : (input.p_client_session_id as string),
				environment_id: ENVIRONMENT,
				title: "Financial Officer",
				created: overrides.created ?? true,
				created_by_user_id: AUTHOR,
				created_at: "2026-08-18T14:00:00.000Z",
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
		async listSessionsPage(input: Record<string, unknown>) {
			calls.listPages.push(input);
			return {
				items:
					overrides.existingSession === false
						? []
						: [
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
							],
				has_more: false,
				next_updated_at: null,
				next_id: null,
			};
		},
		async appendSessionInput(input: Record<string, unknown>) {
			calls.append.push(input);
			return { input_id: CLOUD_CLIENT_SESSION, position: 1 };
		},
		async listSessionInputs() {
			return {
				items: overrides.pendingInputs?.() ?? [],
				next_after_position: 0,
				has_more: false,
			};
		},
		async claimSessionTurn(input: Record<string, unknown>) {
			calls.claim.push(input);
			return overrides.claimResult
				? overrides.claimResult()
				: {
						claimed: true,
						turn_id: TURN,
						company_snapshot_id: COMPANY_SNAPSHOT,
						staff_version: 3,
						inputs: [
							{
								input_id: CLOUD_CLIENT_SESSION,
								position: 1,
								kind: "user_message",
								author_user_id: AUTHOR,
								author_display_name: "Cloud Owner",
								body: { text: "hello" },
								created_at: "2026-08-18T14:00:01.000Z",
							},
						],
					};
		},
		async renewSessionTurn(input: Record<string, unknown>) {
			calls.renew.push(input);
			return overrides.renewResult?.() ?? { renewed: 1 };
		},
		async completeSessionTurn(input: Record<string, unknown>) {
			calls.complete.push(input);
			return overrides.completeResult?.() ?? { completed: 1 };
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

	it("adopts an existing session without invoking the creating ensure path", async () => {
		const { primary, calls } = fakePrimary({ existingSession: true });
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		const ref = await arbiter.adoptExistingSession("staff-1");
		expect(ref).toMatchObject({
			hostedSessionId: HOSTED_SESSION,
			clientSessionId: CLOUD_CLIENT_SESSION,
			created: false,
		});
		expect(calls.listPages).toHaveLength(1);
		expect(calls.ensure).toHaveLength(0);
	});

	it("does not create a session when an agent is opened without cloud history", async () => {
		const { primary, calls } = fakePrimary({ existingSession: false });
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		expect(await arbiter.adoptExistingSession("staff-1")).toBeUndefined();
		expect(arbiter.sessionForStaff("staff-1")).toBeUndefined();
		expect(calls.listPages).toHaveLength(1);
		expect(calls.ensure).toHaveLength(0);
	});

	it("holds one claim at a time and refuses a second locally", async () => {
		const { primary, calls } = fakePrimary({});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		const claim = await arbiter.claimTurn("staff-1", EXECUTION_PIN);
		expect(claim?.inputs).toHaveLength(1);
		expect(claim).toMatchObject(EXECUTION_PIN);
		expect(arbiter.activeClaim).toBeDefined();
		expect(await arbiter.claimTurn("staff-1", EXECUTION_PIN)).toBeUndefined();
		expect(calls.claim).toHaveLength(1);
		expect(calls.claim[0]).toMatchObject({
			p_company_snapshot_id: COMPANY_SNAPSHOT,
			p_staff_version: 3,
		});
	});

	it("returns nothing when the cloud refuses the turn", async () => {
		const { primary } = fakePrimary({ claimResult: () => ({ claimed: false, reason: "turn-in-flight" }) });
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		expect(await arbiter.claimTurn("staff-1", EXECUTION_PIN)).toBeUndefined();
		expect(arbiter.activeClaim).toBeUndefined();
	});

	it("completes a turn exactly once and only while claimed", async () => {
		const { primary, calls } = fakePrimary({});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		await arbiter.claimTurn("staff-1", EXECUTION_PIN);
		await arbiter.completeTurn(0);
		await arbiter.completeTurn(0);
		expect(calls.complete).toHaveLength(1);
		expect(arbiter.activeClaim).toBeUndefined();
	});

	it("abandoning never marks inputs consumed", async () => {
		const { primary, calls } = fakePrimary({});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		await arbiter.claimTurn("staff-1", EXECUTION_PIN);
		arbiter.abandonClaim();
		await arbiter.completeTurn(0);
		expect(calls.complete).toHaveLength(0);
	});

	it("throttles lease renewal to the renew interval", async () => {
		vi.useFakeTimers();
		try {
			const { primary, calls } = fakePrimary({});
			const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
			await arbiter.ensureSession("staff-1", "Financial Officer");
			await arbiter.claimTurn("staff-1", EXECUTION_PIN);
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

	it("keeps a claim through transient renewal errors until its local lease deadline", async () => {
		vi.useFakeTimers();
		try {
			const { primary, calls } = fakePrimary({
				renewResult: () => {
					throw new Error("network unavailable");
				},
			});
			const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
			await arbiter.ensureSession("staff-1", "Financial Officer");
			const claim = await arbiter.claimTurn("staff-1", EXECUTION_PIN);
			vi.advanceTimersByTime(50_000);
			await expect(arbiter.renewIfDue()).rejects.toThrow("network unavailable");
			expect(arbiter.activeClaim).toBe(claim);
			vi.advanceTimersByTime(130_000);
			await expect(arbiter.renewIfDue()).rejects.toThrow("ownership was lost");
			expect(calls.renew).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("appends user messages against the ensured session", async () => {
		const { primary, calls } = fakePrimary({});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		await arbiter.appendPrompt("staff-1", CLIENT_INPUT, { text: "sync check" });
		expect(calls.append[0]?.p_session_id).toBe(HOSTED_SESSION);
		expect((calls.append[0]?.p_body as { text?: string })?.text).toBe("sync check");
		await expect(arbiter.appendPrompt("staff-2", CLIENT_INPUT, { text: "no session" })).rejects.toThrow(
			"staff session has not been ensured",
		);
	});

	it("keeps complete prompts and pending status durable together", async () => {
		const { primary, calls } = fakePrimary({
			pendingInputs: () => [
				{
					input_id: CLOUD_CLIENT_SESSION,
					position: 2,
					kind: "user_message",
					author_user_id: AUTHOR,
					author_display_name: "Cloud Owner",
					body: { schema: "qorpera.session-prompt/v1", text: "review this", images: [{ sha256: "a" }] },
					created_at: "2026-08-18T14:00:01.000Z",
					status: "processing",
				},
			],
		});
		const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
		await arbiter.ensureSession("staff-1", "Financial Officer");
		await arbiter.appendPrompt("staff-1", CLIENT_INPUT, {
			schema: "qorpera.session-prompt/v1",
			text: "review this",
			images: [{ sha256: "a" }],
		});
		expect(calls.append[0]?.p_body).toMatchObject({ text: "review this", images: [{ sha256: "a" }] });
		expect(await arbiter.pendingInputs("staff-1")).toMatchObject([
			{ inputId: CLOUD_CLIENT_SESSION, status: "processing", authorDisplayName: "Cloud Owner" },
		]);
	});

	it("does not consume or postpone retries after turn ownership is lost", async () => {
		vi.useFakeTimers();
		try {
			let renewals = 0;
			const { primary, calls } = fakePrimary({
				renewResult: () => ({ renewed: renewals++ === 0 ? 0 : 1 }),
				completeResult: () => ({ completed: 0 }),
			});
			const arbiter = new CloudSessionArbiter(primary, ENVIRONMENT);
			await arbiter.ensureSession("staff-1", "Financial Officer");
			await arbiter.claimTurn("staff-1", EXECUTION_PIN);
			vi.advanceTimersByTime(50_000);
			await expect(arbiter.renewIfDue()).rejects.toThrow("ownership was lost");
			await expect(arbiter.renewIfDue()).resolves.toBeUndefined();
			expect(calls.renew).toHaveLength(2);
			await expect(arbiter.completeTurn(0)).rejects.toThrow("ownership was lost");
			expect(arbiter.activeClaim).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
