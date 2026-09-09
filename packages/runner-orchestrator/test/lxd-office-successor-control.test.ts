import { randomUUID } from "node:crypto";
import { parseCompanyComputerServiceSuccessor, parseCompanyComputerServiceSuccessorRequest } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeSuccessorControl } from "../src/lxd-office-successor-control.ts";

function fixture() {
	const bootId = randomUUID();
	const request = parseCompanyComputerServiceSuccessorRequest({
		schema: "qorpera.office-service-successor-request/v1",
		predecessor: {
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
				bootId,
				instanceSha256: "1".repeat(64),
				imageSha256: "2".repeat(64),
				bootstrapSha256: "3".repeat(64),
				configurationSha256: "4".repeat(64),
				serviceInvocationId: "5".repeat(32),
			},
		},
		attestation: {
			schema: "qorpera.office-activation-attestation/v1",
			activationId: randomUUID(),
			bootId,
			preparationObservationSha256: "1".repeat(64),
			configurationObservationSha256: "2".repeat(64),
			configurationSha256: "4".repeat(64),
			adoptionReceiptSha256: "3".repeat(64),
			nativePort: 9443,
			viewerPort: 9444,
		},
	});
	const prepared = {
		schema: "qorpera.office-service-successor/v1",
		request,
		state: "prepared",
		serviceInvocationId: null,
		readinessFresh: false,
		stopAcknowledgedAtMs: Date.now(),
		officeRevision: 3,
		privacyVersion: 11,
		validForMs: 5000,
	};
	const ready = { ...prepared, state: "ready", serviceInvocationId: "6".repeat(32), readinessFresh: true };
	const active = { ...ready, state: "active" };
	return { request, prepared, ready, active };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe("provider service successor admission", () => {
	it("deducts current authority RPC latency without confusing metadata status with permission", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		const call = vi.fn(async (method: string) => {
			expect(method).toBe("qorpera_check_runtime_office_successor");
			clock.mockReturnValue(1500);
			return f.prepared;
		});
		const control = new LxdOfficeSuccessorControl(f.request, { call });
		const authority = await control.check(signal());
		expect(authority.successor).toEqual(f.prepared);
		expect(authority.validForMs).toBe(4500);
		expect(authority.signal.aborted).toBe(false);
		call.mockImplementationOnce(async () => {
			clock.mockReturnValue(6500);
			return f.prepared;
		});
		await expect(control.check(signal())).rejects.toThrow("UNCONFIRMED");
	});
	it.each(["reboot", "poweroff", "replace", "delete"])("refuses %s as same-boot service restart", (action) => {
		const f = fixture();
		expect(() =>
			parseCompanyComputerServiceSuccessorRequest({
				...f.request,
				predecessor: { ...f.request.predecessor, action },
			}),
		).toThrow("INVALID_OFFICE_SERVICE_SUCCESSOR_REQUEST");
	});
	it.each(["activationId", "bootId", "configurationSha256"] as const)("refuses changed %s binding", (key) => {
		const f = fixture();
		const value =
			key === "activationId" ? f.request.predecessor.activationId : key === "bootId" ? randomUUID() : "9".repeat(64);
		expect(() =>
			parseCompanyComputerServiceSuccessorRequest({
				...f.request,
				attestation: { ...f.request.attestation, [key]: value },
			}),
		).toThrow("INVALID_OFFICE_SERVICE_SUCCESSOR_REQUEST");
	});
	it.each([
		{ extra: true },
		{ state: "stopped" },
		{ readinessFresh: true },
		{ serviceInvocationId: "6".repeat(32) },
		{ validForMs: 5001 },
		{ stopAcknowledgedAtMs: 0 },
		{ officeRevision: 0 },
		{ privacyVersion: -1 },
		{ request: {} },
	])("refuses malformed preparation %j", (change) => {
		const f = fixture();
		expect(() => parseCompanyComputerServiceSuccessor({ ...f.prepared, ...change }, f.request)).toThrow(
			"UNCONFIRMED",
		);
	});
	it("rejects prior invocation, substituted request and unknown response fields", () => {
		const f = fixture();
		for (const change of [
			{ serviceInvocationId: f.request.predecessor.startup.serviceInvocationId },
			{ serviceInvocationId: null },
			{ serviceInvocationId: "0".repeat(32) },
			{ extra: true },
			{ request: fixture().request },
		])
			expect(() => parseCompanyComputerServiceSuccessor({ ...f.active, ...change }, f.request)).toThrow(
				"UNCONFIRMED",
			);
	});
	it("recovers committed metadata without automatically starting or reactivating", async () => {
		const f = fixture(),
			call = vi.fn(async () => f.prepared as unknown);
		const control = new LxdOfficeSuccessorControl(f.request, { call });
		expect(await control.prepare(signal())).toEqual(f.prepared);
		call.mockResolvedValueOnce(f.ready);
		expect(await control.status(signal())).toEqual(f.ready);
		call.mockRejectedValueOnce(new Error("private transport details"));
		await expect(control.activate(f.active.serviceInvocationId, performance.now() + 5000, signal())).rejects.toThrow(
			/^OFFICE_SUCCESSOR_REQUEST_UNCONFIRMED$/,
		);
		call.mockResolvedValueOnce(f.active);
		expect(await control.status(signal())).toEqual(f.active);
		expect(call.mock.calls).toHaveLength(4);
	});
	it.each([
		{ state: "prepared", serviceInvocationId: null, readinessFresh: false },
		{ serviceInvocationId: "7".repeat(32) },
		{ stopAcknowledgedAtMs: 1 },
		{ officeRevision: 4 },
		{ privacyVersion: 12 },
	])("rejects regression or immutable metadata changes %j", async (change) => {
		const f = fixture(),
			call = vi.fn(async () => f.active as unknown);
		const control = new LxdOfficeSuccessorControl(f.request, { call });
		await control.status(signal());
		call.mockResolvedValueOnce({ ...f.active, ...change });
		await expect(control.status(signal())).rejects.toThrow("UNCONFIRMED");
		expect(await control.status(signal())).toEqual(f.active);
	});
	it("uses an absolute inspection deadline and rejects late committed responses", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(1000),
			call = vi.fn(async () => {
				clock.mockReturnValue(1500);
				return f.active;
			});
		const control = new LxdOfficeSuccessorControl(f.request, { call });
		for (const deadline of [1000, 6001, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => control.activate(f.active.serviceInvocationId, deadline, signal())).toThrow(
				"INSPECTION_UNCONFIRMED",
			);
		expect(() => control.activate(f.request.predecessor.startup.serviceInvocationId, 1500, signal())).toThrow(
			"INSPECTION_UNCONFIRMED",
		);
		await expect(control.activate(f.active.serviceInvocationId, 1500, signal())).rejects.toThrow("UNCONFIRMED");
		expect(call).toHaveBeenCalledTimes(1);
		call.mockResolvedValueOnce(f.active);
		expect(await control.status(signal())).toEqual(f.active);
	});
	it("keeps cancelled IO owned until it settles and ignores its late response", async () => {
		const f = fixture();
		let settle!: (v: unknown) => void;
		const call = vi.fn(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		const control = new LxdOfficeSuccessorControl(f.request, { call }),
			cancel = new AbortController();
		const pending = expect(control.prepare(cancel.signal)).rejects.toThrow("UNCONFIRMED");
		cancel.abort();
		await pending;
		await expect(control.status(signal())).rejects.toThrow("PENDING");
		settle(f.active);
		await new Promise((resolve) => setTimeout(resolve, 0));
		call.mockResolvedValueOnce(f.prepared);
		expect(await control.status(signal())).toEqual(f.prepared);
	});
	it("retains parsed request against caller and transport mutation", async () => {
		const f = fixture(),
			input = structuredClone(f.request);
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => {
			expect(args.p_request).toEqual(f.request);
			(args.p_request as { schema: string }).schema = "changed transport clone";
			return f.prepared;
		});
		const control = new LxdOfficeSuccessorControl(input, { call });
		(input as { schema: string }).schema = "changed caller";
		expect(await control.prepare(signal())).toEqual(f.prepared);
		expect(await control.status(signal())).toEqual(f.prepared);
	});
});
