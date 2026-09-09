import { randomUUID } from "node:crypto";
import {
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopChallenge,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopInspection,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeStopControl } from "../src/lxd-office-stop-control.ts";

function fixture() {
	const request = parseCompanyComputerServiceStopRequest({
		schema: "qorpera.office-service-stop-request/v1",
		startCompletionSha256: "8".repeat(64),
		revocation: {
			schema: "qorpera.office-lifecycle-transition/v1",
			state: "draining",
			revocationRevision: 2,
			requestedAtMs: Date.now() - 1000,
			drains: [],
			request: {
				schema: "qorpera.office-lifecycle-request/v1",
				action: "service_restart",
				transitionId: randomUUID(),
				activationId: randomUUID(),
				providerId: randomUUID(),
				providerPolicySha256: "a".repeat(64),
				startup: {
					scope: {
						companyId: randomUUID(),
						environmentId: randomUUID(),
						companyComputerId: randomUUID(),
						logicalComputerId: randomUUID(),
					},
					computerGeneration: 1,
					allocationId: randomUUID(),
					bootId: randomUUID(),
					instanceSha256: "1".repeat(64),
					imageSha256: "2".repeat(64),
					bootstrapSha256: "3".repeat(64),
					configurationSha256: "4".repeat(64),
					serviceInvocationId: "5".repeat(32),
				},
			},
		},
	});
	const command = {
			commandId: randomUUID(),
			requestSha256: "9".repeat(64),
			bootId: request.revocation.request.startup.bootId,
		},
		nonce = randomUUID();
	const completion = parseCompanyComputerServiceStopCompletion(
		{
			schema: "qorpera.office-service-stop-completion/v1",
			command,
			transitionId: request.revocation.request.transitionId,
			activationId: request.revocation.request.activationId,
			revocationRevision: 2,
			configurationSha256: "4".repeat(64),
			startCompletionSha256: request.startCompletionSha256,
			fromServiceInvocationId: "5".repeat(32),
			observedInvocationId: "6".repeat(32),
			stoppedInvocationId: null,
			controlGroup: "/system.slice/qorpera-company-computer.service",
			cgroupState: "absent",
		},
		command,
		request,
	);
	const inspection = parseCompanyComputerServiceStopInspection(
		{
			schema: "qorpera.office-service-stop-inspection/v1",
			inspectionId: nonce,
			stop: completion,
			cgroupState: "absent",
		},
		nonce,
		completion,
		request,
	);
	const challenge = {
		schema: "qorpera.office-service-stop-challenge/v1",
		inspectionId: nonce,
		command,
		transitionId: request.revocation.request.transitionId,
		revocationRevision: 2,
		officeRevision: 4,
		privacyVersion: 0,
		drains: [],
		validForMs: 5000,
	};
	const receipt = {
		schema: "qorpera.office-service-stop-acknowledgement/v1",
		state: "stopped",
		request: request.revocation.request,
		inspection,
		acknowledgedAtMs: Date.now(),
	};
	return { request, command, nonce, completion, inspection, challenge, receipt };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe("bounded provider physical stop acknowledgement", () => {
	it("deducts preparation latency and binds one original identity through acknowledgement", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const call = vi.fn(async () => {
			clock.mockReturnValue(200);
			return f.challenge as unknown;
		});
		const control = new LxdOfficeStopControl(f.request, f.command, { call });
		const prepared = await control.prepare(f.nonce, signal());
		expect(prepared.validForMs).toBe(4800);
		call.mockResolvedValueOnce(f.receipt);
		expect(await control.acknowledge(f.inspection, signal())).toEqual(f.receipt);
		expect(call.mock.calls).toHaveLength(2);
	});
	it("refuses unissued and expired local inspection before any acknowledgement RPC", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(0),
			call = vi.fn(async () => f.challenge);
		const control = new LxdOfficeStopControl(f.request, f.command, { call });
		expect(() => control.acknowledge(f.inspection, signal())).toThrow("INSPECTION_EXPIRED");
		await control.prepare(f.nonce, signal());
		clock.mockReturnValue(5000);
		expect(() => control.acknowledge(f.inspection, signal())).toThrow("INSPECTION_EXPIRED");
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("does not extend a reused challenge even if a response suggests a fresh window", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(0),
			call = vi.fn(async () => f.challenge);
		const control = new LxdOfficeStopControl(f.request, f.command, { call });
		await control.prepare(f.nonce, signal());
		clock.mockReturnValue(2000);
		expect((await control.prepare(f.nonce, signal())).validForMs).toBe(3000);
	});
	it("rejects a late committed response and recovers only through explicit metadata status", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(0),
			call = vi.fn(async () => f.challenge as unknown);
		const control = new LxdOfficeStopControl(f.request, f.command, { call });
		await control.prepare(f.nonce, signal());
		call.mockImplementationOnce(async () => {
			clock.mockReturnValue(5100);
			return f.receipt;
		});
		await expect(control.acknowledge(f.inspection, signal())).rejects.toThrow(/^OFFICE_STOP_REQUEST_UNCONFIRMED$/);
		call.mockResolvedValueOnce(f.receipt);
		expect(await control.status(signal())).toEqual(f.receipt);
		expect(call).toHaveBeenCalledTimes(3);
	});
	it("keeps cancelled IO pending until settlement and rejects its late result", async () => {
		const f = fixture();
		let settle!: (value: unknown) => void;
		const call = vi.fn(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		const control = new LxdOfficeStopControl(f.request, f.command, { call }),
			cancel = new AbortController();
		const pending = expect(control.prepare(f.nonce, cancel.signal)).rejects.toThrow("UNCONFIRMED");
		cancel.abort();
		await pending;
		await expect(control.status(signal())).rejects.toThrow("PENDING");
		settle(f.challenge);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(() => control.acknowledge(f.inspection, signal())).toThrow("EXPIRED");
		call.mockResolvedValueOnce(null);
		expect(await control.status(signal())).toBeNull();
	});
	it("refuses substituted or missing retained acknowledgement without mutating its cached receipt", async () => {
		const f = fixture(),
			call = vi.fn(async () => f.receipt as unknown),
			control = new LxdOfficeStopControl(f.request, f.command, { call });
		expect(await control.status(signal())).toEqual(f.receipt);
		call.mockResolvedValueOnce({ ...f.receipt, acknowledgedAtMs: f.receipt.acknowledgedAtMs + 1 });
		await expect(control.status(signal())).rejects.toThrow("UNCONFIRMED");
		call.mockResolvedValueOnce(null);
		await expect(control.status(signal())).rejects.toThrow("UNCONFIRMED");
	});
	it.each([
		{ validForMs: 0 },
		{ validForMs: 5001 },
		{ validForMs: 1.5 },
		{ privacyVersion: -1 },
		{ officeRevision: 1 },
		{ revocationRevision: 3 },
		{ transitionId: randomUUID() },
		{ inspectionId: randomUUID() },
		{ command: {} },
		{ extra: true },
	])("rejects unbound challenge %j", (change) => {
		const f = fixture();
		expect(() =>
			parseCompanyComputerServiceStopChallenge({ ...f.challenge, ...change }, f.request, f.command, f.nonce),
		).toThrow("UNCONFIRMED");
	});
	it.each([{ state: "active" }, { extra: true }, { acknowledgedAtMs: 0 }, { request: {} }, { inspection: {} }])(
		"rejects acknowledgement %j",
		(change) => {
			const f = fixture();
			expect(() =>
				parseCompanyComputerServiceStopAcknowledgement({ ...f.receipt, ...change }, f.request, f.command),
			).toThrow("UNCONFIRMED");
		},
	);
});
