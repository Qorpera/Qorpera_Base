import { randomUUID } from "node:crypto";
import { parseCompanyComputerOutageSuccessorRequest } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeOutageSuccessorControl } from "../src/lxd-office-outage-successor-control.ts";

function fixture() {
	const recovery = {
		schema: "qorpera.office-outage-recovery-request/v1",
		recoveryId: randomUUID(),
		outageRequestId: randomUUID(),
		activationId: randomUUID(),
		startCommandId: randomUUID(),
	};
	const bootId = randomUUID();
	const request = parseCompanyComputerOutageSuccessorRequest({
		schema: "qorpera.office-outage-successor-request/v1",
		recovery,
		attestation: {
			schema: "qorpera.office-activation-attestation/v1",
			activationId: recovery.activationId,
			bootId,
			preparationObservationSha256: "1".repeat(64),
			configurationObservationSha256: "2".repeat(64),
			configurationSha256: "3".repeat(64),
			adoptionReceiptSha256: "4".repeat(64),
			nativePort: 9443,
			viewerPort: 9444,
		},
		termination: {
			schema: "qorpera.office-outage-termination-acknowledgement/v1",
			officeRevision: 3,
			acknowledgedAtMs: 1000,
			request: {
				recovery,
				inspection: {
					schema: "qorpera.office-outage-termination-inspection/v1",
					command: { commandId: randomUUID(), requestSha256: "5".repeat(64), bootId },
					inspectionId: randomUUID(),
					recoveryId: recovery.recoveryId,
					startCommandId: recovery.startCommandId,
					bootId,
					hostBootId: randomUUID(),
					physicalInstanceId: randomUUID(),
					bootObservationSha256: "1".repeat(64),
					originPreparationSha256: "6".repeat(64),
					originAdoptionReceiptSha256: "7".repeat(64),
					predecessorConfigurationSha256: "8".repeat(64),
					predecessorAdoptionReceiptSha256: "7".repeat(64),
					cgroupState: "empty",
					preparationState: "unstarted",
					serviceState: "unstarted",
				},
			},
		},
	});
	const prepared = {
		schema: "qorpera.office-outage-successor/v1",
		request,
		state: "prepared",
		serviceInvocationId: null,
		readinessFresh: false,
		officeRevision: 3,
		privacyVersion: 2,
	};
	const ready = { ...prepared, state: "ready", serviceInvocationId: "9".repeat(32), readinessFresh: true };
	return { request, prepared, ready, active: { ...ready, state: "active" } };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe("outage successor admission control", () => {
	it("deducts RPC latency from the authority envelope", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		const call = vi.fn(async () => {
			clock.mockReturnValue(1600);
			return { schema: "qorpera.office-outage-successor-authority/v1", successor: f.prepared, validForMs: 5000 };
		});
		const control = new LxdOfficeOutageSuccessorControl(f.request, { call });
		expect((await control.check(signal())).validForMs).toBe(4400);
		call.mockResolvedValueOnce(f.prepared as never);
		await expect(control.check(signal())).rejects.toThrow("UNCONFIRMED");
	});
	it("recovers a committed activation without repeating the activation call", async () => {
		const f = fixture(),
			call = vi.fn(async () => f.prepared as unknown);
		const control = new LxdOfficeOutageSuccessorControl(f.request, { call });
		await control.prepare(signal());
		call.mockRejectedValueOnce(new Error("lost reply"));
		await expect(control.activate(f.active.serviceInvocationId, performance.now() + 5000, signal())).rejects.toThrow(
			"UNCONFIRMED",
		);
		call.mockResolvedValueOnce(f.active);
		expect(await control.status(signal())).toEqual(f.active);
		expect(call.mock.calls).toHaveLength(3);
	});
	it("sends the typed activation envelope and requires the matching active invocation", async () => {
		const f = fixture();
		const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
			expect(method).toBe("qorpera_activate_runtime_office_outage_successor");
			expect(args).toEqual({
				p_request: { successor: f.request, serviceInvocationId: f.active.serviceInvocationId },
			});
			return f.active;
		});
		const control = new LxdOfficeOutageSuccessorControl(f.request, { call });
		expect(await control.activate(f.active.serviceInvocationId, performance.now() + 5000, signal())).toEqual(
			f.active,
		);
		call.mockResolvedValueOnce({ ...f.active, serviceInvocationId: "a".repeat(32) });
		await expect(control.activate(f.active.serviceInvocationId, performance.now() + 5000, signal())).rejects.toThrow(
			"UNCONFIRMED",
		);
	});
	it.each([
		{ state: "prepared", serviceInvocationId: null, readinessFresh: false },
		{ serviceInvocationId: "a".repeat(32) },
		{ officeRevision: 4 },
		{ privacyVersion: 3 },
	])("rejects state regression or immutable metadata substitution %j", async (change) => {
		const f = fixture(),
			call = vi.fn(async () => f.active as unknown);
		const control = new LxdOfficeOutageSuccessorControl(f.request, { call });
		await control.status(signal());
		call.mockResolvedValueOnce({ ...f.active, ...change });
		await expect(control.status(signal())).rejects.toThrow("UNCONFIRMED");
	});
	it("rejects an expired inspection deadline even if activation committed", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		const call = vi.fn(async () => {
			clock.mockReturnValue(1500);
			return f.active;
		});
		const control = new LxdOfficeOutageSuccessorControl(f.request, { call });
		for (const deadline of [1000, 6001, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => control.activate(f.active.serviceInvocationId, deadline, signal())).toThrow(
				"INSPECTION_UNCONFIRMED",
			);
		await expect(control.activate(f.active.serviceInvocationId, 1500, signal())).rejects.toThrow("UNCONFIRMED");
		expect(await control.status(signal())).toEqual(f.active);
	});
	it("retains ownership of cancelled I/O until it settles", async () => {
		const f = fixture();
		let settle!: (value: unknown) => void;
		const call = vi.fn(
			() =>
				new Promise<unknown>((resolve) => {
					settle = resolve;
				}),
		);
		const control = new LxdOfficeOutageSuccessorControl(f.request, { call }),
			cancel = new AbortController();
		const result = expect(control.prepare(cancel.signal)).rejects.toThrow("UNCONFIRMED");
		cancel.abort();
		await result;
		await expect(control.status(signal())).rejects.toThrow("PENDING");
		settle(f.active);
		await new Promise((resolve) => setTimeout(resolve, 0));
		call.mockResolvedValueOnce(f.prepared);
		expect(await control.status(signal())).toEqual(f.prepared);
	});
	it("isolates retained request from caller and transport mutation", async () => {
		const f = fixture(),
			input = structuredClone(f.request);
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => {
			expect(args.p_request).toEqual(f.request);
			(args.p_request as { schema: string }).schema = "changed";
			return f.prepared;
		});
		const control = new LxdOfficeOutageSuccessorControl(input, { call });
		(input.termination.request.inspection.command as { commandId: string }).commandId = randomUUID();
		expect(await control.prepare(signal())).toEqual(f.prepared);
		expect(await control.status(signal())).toEqual(f.prepared);
	});
});
