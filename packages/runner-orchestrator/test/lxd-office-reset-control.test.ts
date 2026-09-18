import { setTimeout as sleep } from "node:timers/promises";
import type {
	CompanyComputerLifecycleRequest,
	CompanyComputerResetPhaseEvidence,
	CompanyComputerResetPlan,
	CompanyComputerResetSuccessorRequest,
} from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { LxdOfficeResetControl, LxdOfficeResetSuccessorControl } from "../src/lxd-office-reset-control.ts";

const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const sha = (c: string) => c.repeat(64);
const signal = () => new AbortController().signal;
const predecessor = (): CompanyComputerLifecycleRequest => ({
	schema: "qorpera.office-lifecycle-request/v1",
	transitionId: id(2),
	action: "replace",
	activationId: id(3),
	providerId: id(12),
	providerPolicySha256: sha("f"),
	startup: {
		scope: { companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) },
		computerGeneration: 1,
		allocationId: id(10),
		instanceSha256: sha("a"),
		imageSha256: sha("b"),
		bootstrapSha256: sha("c"),
		bootId: id(11),
		configurationSha256: sha("d"),
		serviceInvocationId: "e".repeat(32),
	},
});
const plan = (): CompanyComputerResetPlan => ({
	schema: "qorpera.lxd-office-reset-plan/v1",
	resetId: id(1),
	intentId: id(13),
	predecessor: predecessor(),
	preparationObservationSha256: sha("1"),
	providerBindingSha256: sha("2"),
	nodeId: null,
	predecessorRootIncarnationId: null,
	rootIncarnationId: id(5),
	successorActivationId: id(4),
	commands: { stopCommandId: id(20), deleteCommandId: id(21), createCommandId: id(22), startCommandId: id(23) },
	custody: { archiveRoot: "/var/lib/qorpera-office-provider/reset-custody" },
});
const status = (change: Record<string, unknown> = {}) => ({
	schema: "qorpera.office-reset/v1",
	resetId: id(1),
	phase: "fenced",
	revision: 1,
	rootIncarnationId: id(5),
	successorActivationId: id(4),
	custodySha256: null,
	restoreSha256: null,
	stopAcknowledgedAtMs: 2000,
	officeRevision: 12,
	privacyVersion: 1,
	validForMs: 5000,
	...change,
});
const evidence = (): CompanyComputerResetPhaseEvidence => ({
	schema: "qorpera.office-reset-phase-evidence/v1",
	resetId: id(1),
	phase: "stopped" as const,
	observation: { stopCommandId: id(20), acknowledgedAtMs: 2000, stopCompletionSha256: sha("3") },
});
const challenge = (change: Record<string, unknown> = {}) => ({
	schema: "qorpera.office-reset-phase-challenge/v1",
	challengeId: id(30),
	resetId: id(1),
	phase: "stopped",
	revision: 1,
	officeRevision: 12,
	privacyVersion: 1,
	evidenceSha256: officeDigest(evidence()),
	validForMs: 5000,
	...change,
});
function fixture(responses: unknown[]) {
	const queue = [...responses];
	const call = vi.fn(async (_method: string, _args: Record<string, unknown>, s: AbortSignal) => {
		s.throwIfAborted();
		const next = queue.shift();
		if (next instanceof Error) throw next;
		if (typeof next === "function") return next();
		return next;
	});
	return { call, control: new LxdOfficeResetControl(plan(), officeDigest(plan()), { call }) };
}

describe("office reset authority adapter", () => {
	it("binds every call to the retained plan and refuses regressed status", async () => {
		const f = fixture([
			status(),
			status({ phase: "stopped", revision: 2 }),
			status({ phase: "fenced", revision: 3 }),
			status({ phase: "stopped", revision: 1 }),
			status({ phase: "custodied", revision: 3, custodySha256: sha("4") }),
			status({ phase: "custodied", revision: 4, custodySha256: sha("5") }),
			status({ phase: "custodied", revision: 4, custodySha256: sha("4"), stopAcknowledgedAtMs: 2001 }),
		]);
		await expect(f.control.begin(signal())).resolves.toMatchObject({ phase: "fenced" });
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_begin_runtime_office_reset",
			{ p_plan: plan(), p_plan_sha256: officeDigest(plan()) },
			expect.any(AbortSignal),
		);
		await expect(f.control.status(signal())).resolves.toMatchObject({ phase: "stopped" });
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_runtime_office_reset_status",
			{ p_plan: plan() },
			expect.anything(),
		);
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_RESET_REQUEST_UNCONFIRMED");
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_RESET_REQUEST_UNCONFIRMED");
		await expect(f.control.status(signal())).resolves.toMatchObject({ custodySha256: sha("4") });
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_RESET_REQUEST_UNCONFIRMED");
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_RESET_REQUEST_UNCONFIRMED");
		expect(() => new LxdOfficeResetControl(plan(), "short", { call: f.call })).toThrow();
		expect(() => new LxdOfficeResetControl({ ...plan(), resetId: id(2) }, sha("1"), { call: f.call })).toThrow(
			"INVALID_OFFICE_RESET_PLAN",
		);
	});
	it("issues nonce-bound challenges whose window is deducted from latency and acks within it", async () => {
		const f = fixture([
			challenge(),
			challenge({ validForMs: 4000 }),
			status({ phase: "stopped", revision: 2 }),
			challenge({ challengeId: id(31) }),
			challenge({ evidenceSha256: sha("0") }),
			async () => {
				await sleep(20);
				return challenge({ validForMs: 5 });
			},
		]);
		const prepared = await f.control.preparePhase("stopped", id(30), officeDigest(evidence()), signal());
		expect(prepared.challenge.challengeId).toBe(id(30));
		expect(prepared.validForMs).toBeLessThanOrEqual(5000);
		expect(prepared.validForMs).toBeGreaterThan(4000);
		expect(prepared.signal.aborted).toBe(false);
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_prepare_runtime_office_reset_phase",
			{ p_plan: plan(), p_phase: "stopped", p_challenge_id: id(30), p_evidence_sha256: officeDigest(evidence()) },
			expect.anything(),
		);
		const checked = await f.control.checkPhase("stopped", id(30), officeDigest(evidence()), signal());
		expect(checked.validForMs).toBeLessThanOrEqual(4000);
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_check_runtime_office_reset_phase",
			{ p_plan: plan(), p_challenge_id: id(30) },
			expect.anything(),
		);
		await expect(f.control.ackPhase(id(30), evidence(), checked.deadline, signal())).resolves.toMatchObject({
			phase: "stopped",
		});
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_ack_runtime_office_reset_phase",
			{ p_plan: plan(), p_challenge_id: id(30), p_evidence: evidence() },
			expect.anything(),
		);
		await expect(f.control.preparePhase("stopped", id(30), officeDigest(evidence()), signal())).rejects.toThrow(
			"OFFICE_RESET_REQUEST_UNCONFIRMED",
		);
		await expect(f.control.preparePhase("stopped", id(30), officeDigest(evidence()), signal())).rejects.toThrow(
			"OFFICE_RESET_REQUEST_UNCONFIRMED",
		);
		await expect(f.control.preparePhase("stopped", id(30), officeDigest(evidence()), signal())).rejects.toThrow(
			"OFFICE_RESET_REQUEST_EXPIRED",
		);
		await expect(f.control.preparePhase("stopped", id(1), officeDigest(evidence()), signal())).rejects.toThrow(
			"OFFICE_RESET_CHALLENGE_UNCONFIRMED",
		);
		await expect(f.control.preparePhase("stopped", "nonce", officeDigest(evidence()), signal())).rejects.toThrow(
			"OFFICE_RESET_CHALLENGE_UNCONFIRMED",
		);
		expect(() => f.control.ackPhase("nonce", evidence(), performance.now() + 100, signal())).toThrow(
			"OFFICE_RESET_CHALLENGE_UNCONFIRMED",
		);
		expect(() =>
			f.control.ackPhase(id(30), { ...evidence(), resetId: id(2) }, performance.now() + 100, signal()),
		).toThrow("INVALID_OFFICE_RESET_PHASE_EVIDENCE");
		await expect(f.control.ackPhase(id(30), evidence(), performance.now() - 1, signal())).rejects.toThrow(
			"OFFICE_RESET_REQUEST_EXPIRED",
		);
	});
	it("serializes calls, honours the caller signal and never returns a late reply", async () => {
		let release = () => {};
		const f = fixture([
			() =>
				new Promise((resolve) => {
					release = () => resolve(status());
				}),
			async () => {
				await sleep(30);
				return status({ phase: "stopped", revision: 2 });
			},
			status(),
		]);
		const first = f.control.begin(signal());
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_RESET_REQUEST_PENDING");
		release();
		await expect(first).resolves.toMatchObject({ phase: "fenced" });
		const aborted = new AbortController();
		aborted.abort();
		await expect(f.control.status(aborted.signal)).rejects.toThrow();
		expect(f.call).toHaveBeenCalledTimes(1);
		const controller = new AbortController();
		const late = f.control.status(controller.signal);
		controller.abort();
		await expect(late).rejects.toThrow("OFFICE_RESET_REQUEST_UNCONFIRMED");
		await sleep(40);
		// The late reply never reached its caller, yet it still fences later
		// regressions: a reply older than the committed phase is refused.
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_RESET_REQUEST_UNCONFIRMED");
		expect(f.call).toHaveBeenCalledTimes(3);
	});
});

describe("office reset successor adapter", () => {
	const request = (): CompanyComputerResetSuccessorRequest => ({
		schema: "qorpera.office-reset-successor-request/v1",
		resetId: id(1),
		rootIncarnationId: id(5),
		predecessor: predecessor(),
		attestation: {
			schema: "qorpera.office-activation-attestation/v1",
			activationId: id(4),
			bootId: id(16),
			preparationObservationSha256: sha("1"),
			configurationObservationSha256: sha("a"),
			configurationSha256: sha("b"),
			adoptionReceiptSha256: sha("5"),
			nativePort: 9443,
			viewerPort: 9444,
		},
		custodySha256: sha("9"),
		restoreSha256: sha("0"),
	});
	const successor = (change: Record<string, unknown> = {}) => ({
		schema: "qorpera.office-reset-successor/v1",
		request: request(),
		state: "prepared",
		serviceInvocationId: null,
		readinessFresh: false,
		stopAcknowledgedAtMs: 2000,
		officeRevision: 12,
		privacyVersion: 1,
		validForMs: 5000,
		...change,
	});
	function fixture(responses: unknown[]) {
		const queue = [...responses];
		const call = vi.fn(async (_method: string, _args: Record<string, unknown>, s: AbortSignal) => {
			s.throwIfAborted();
			const next = queue.shift();
			if (next instanceof Error) throw next;
			return next;
		});
		return { call, control: new LxdOfficeResetSuccessorControl(request(), { call }) };
	}
	it("prepares, checks readiness with a fresh window and activates only the inspected invocation", async () => {
		const ready = successor({ state: "ready", serviceInvocationId: "c".repeat(32), readinessFresh: true });
		const f = fixture([
			successor(),
			ready,
			{ ...ready, state: "active" },
			successor({ state: "ready", serviceInvocationId: "d".repeat(32), readinessFresh: true }),
			successor({ ...ready, officeRevision: 13 }),
		]);
		await expect(f.control.prepare(signal())).resolves.toMatchObject({ state: "prepared" });
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_prepare_runtime_office_reset_successor",
			{ p_request: request() },
			expect.anything(),
		);
		const checked = await f.control.check(signal());
		expect(checked.successor.state).toBe("ready");
		expect(checked.validForMs).toBeLessThanOrEqual(5000);
		await expect(
			f.control.activate("c".repeat(32), performance.now() + checked.validForMs, checked.signal),
		).resolves.toMatchObject({ state: "active" });
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_activate_runtime_office_reset_successor",
			{ p_request: request(), p_service_invocation_id: "c".repeat(32) },
			expect.anything(),
		);
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_RESET_SUCCESSOR_REQUEST_UNCONFIRMED");
		await expect(f.control.status(signal())).rejects.toThrow("OFFICE_RESET_SUCCESSOR_REQUEST_UNCONFIRMED");
		for (const [invocation, deadline] of [
			["e".repeat(32), performance.now() + 1000],
			["0".repeat(32), performance.now() + 1000],
			["c".repeat(32), performance.now() - 1],
			["c".repeat(32), performance.now() + 6000],
		] as const)
			expect(() => f.control.activate(invocation, deadline, signal())).toThrow(
				"OFFICE_RESET_SUCCESSOR_INSPECTION_UNCONFIRMED",
			);
	});
	it("refuses activation replies that do not confirm the requested invocation", async () => {
		const f = fixture([successor({ state: "ready", serviceInvocationId: "d".repeat(32), readinessFresh: true })]);
		await expect(f.control.activate("c".repeat(32), performance.now() + 1000, signal())).rejects.toThrow(
			"OFFICE_RESET_SUCCESSOR_REQUEST_UNCONFIRMED",
		);
		expect(() => new LxdOfficeResetSuccessorControl({ ...request(), resetId: id(4) }, { call: f.call })).toThrow(
			"INVALID_OFFICE_RESET_SUCCESSOR_REQUEST",
		);
	});
});
