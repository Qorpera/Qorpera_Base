import { randomUUID } from "node:crypto";
import { parseCompanyComputerBootIntent, parseCompanyComputerBootIntentRequest } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeBootIntentControl } from "../src/lxd-office-boot-intent-control.ts";

function fixture() {
	const request = parseCompanyComputerBootIntentRequest({
		schema: "qorpera.office-boot-intent-request/v1",
		bootIntentId: randomUUID(),
		activationId: randomUUID(),
		stopHistorySha256: "7".repeat(64),
		powerOffCompletionSha256: "8".repeat(64),
		predecessor: {
			schema: "qorpera.office-lifecycle-request/v1",
			action: "reboot",
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
	});
	const prepared = {
		schema: "qorpera.office-boot-intent/v1",
		request,
		state: "prepared",
		stopAcknowledgedAtMs: Date.now(),
		officeRevision: 3,
		privacyVersion: 11,
		validForMs: 5000,
	};
	return { request, prepared, admitted: { ...prepared, state: "admitted" } };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe("provider explicit pre-boot intent", () => {
	it.each(["reboot", "power_off"])("accepts %s with no fabricated future boot/configuration", (action) => {
		const f = fixture();
		const parsed = parseCompanyComputerBootIntentRequest({
			...f.request,
			predecessor: { ...f.request.predecessor, action },
		});
		expect(parsed.predecessor.action).toBe(action);
		expect(Object.isFrozen(parsed.predecessor.startup.scope)).toBe(true);
		for (const extra of [
			{ bootId: randomUUID() },
			{ configurationSha256: "a".repeat(64) },
			{ resumeAutomatically: true },
		])
			expect(() => parseCompanyComputerBootIntentRequest({ ...parsed, ...extra })).toThrow(
				"INVALID_OFFICE_BOOT_INTENT_REQUEST",
			);
	});
	it.each(["service_restart", "replace", "delete"])("refuses %s", (action) => {
		const f = fixture();
		expect(() =>
			parseCompanyComputerBootIntentRequest({ ...f.request, predecessor: { ...f.request.predecessor, action } }),
		).toThrow("INVALID_OFFICE_BOOT_INTENT_REQUEST");
	});
	it.each(["bootIntentId", "activationId"])("requires a valid %s", (key) => {
		const f = fixture();
		for (const value of [undefined, null, 1, "", "0".repeat(36), randomUUID().toUpperCase()])
			expect(() => parseCompanyComputerBootIntentRequest({ ...f.request, [key]: value })).toThrow(
				"INVALID_OFFICE_BOOT_INTENT_REQUEST",
			);
		expect(() =>
			parseCompanyComputerBootIntentRequest({ ...f.request, activationId: f.request.predecessor.activationId }),
		).toThrow("INVALID_OFFICE_BOOT_INTENT_REQUEST");
	});
	it.each(["stopHistorySha256", "powerOffCompletionSha256"])("bounds and binds %s", (key) => {
		const f = fixture();
		for (const value of [null, 1, "", "a".repeat(63), "A".repeat(64), "a".repeat(65)])
			expect(() => parseCompanyComputerBootIntentRequest({ ...f.request, [key]: value })).toThrow(
				"INVALID_OFFICE_BOOT_INTENT_REQUEST",
			);
		expect(() =>
			parseCompanyComputerBootIntent({ ...f.prepared, request: { ...f.request, [key]: "b".repeat(64) } }, f.request),
		).toThrow("UNCONFIRMED");
	});
	it.each([
		{ extra: true },
		{ state: "active" },
		{ validForMs: 5001 },
		{ stopAcknowledgedAtMs: 0 },
		{ officeRevision: 0 },
		{ privacyVersion: -1 },
		{ request: {} },
	])("refuses malformed metadata %j", (change) => {
		const f = fixture();
		expect(() => parseCompanyComputerBootIntent({ ...f.prepared, ...change }, f.request)).toThrow("UNCONFIRMED");
	});
	it("deducts authority RPC latency and refuses a reply at the deadline", async () => {
		const f = fixture(),
			clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		const call = vi.fn(async (method: string) => {
			expect(method).toBe("qorpera_check_runtime_office_boot_intent");
			clock.mockReturnValue(1500);
			return f.prepared;
		});
		const control = new LxdOfficeBootIntentControl(f.request, { call });
		const authority = await control.check(signal());
		expect(authority.intent).toEqual(f.prepared);
		expect(authority.validForMs).toBe(4500);
		expect(authority.signal.aborted).toBe(false);
		call.mockImplementationOnce(async () => {
			clock.mockReturnValue(6500);
			return f.prepared;
		});
		await expect(control.check(signal())).rejects.toThrow("UNCONFIRMED");
	});
	it("recovers committed metadata without automatic dispatch or renewal", async () => {
		const f = fixture(),
			call = vi.fn(async () => f.prepared as unknown);
		const control = new LxdOfficeBootIntentControl(f.request, { call });
		call.mockRejectedValueOnce(new Error("sensitive transport failure"));
		await expect(control.prepare(signal())).rejects.toThrow(/^OFFICE_BOOT_INTENT_REQUEST_UNCONFIRMED$/);
		expect(await control.status(signal())).toEqual(f.prepared);
		call.mockResolvedValue(f.admitted);
		expect(await control.prepare(signal())).toEqual(f.admitted);
		expect(await control.status(signal())).toEqual(f.admitted);
		await expect(control.check(signal())).rejects.toThrow("UNCONFIRMED");
		expect(call).toHaveBeenCalledTimes(5);
	});
	it.each([{ state: "prepared" }, { stopAcknowledgedAtMs: 1 }, { officeRevision: 4 }, { privacyVersion: 12 }])(
		"rejects regressing/changed metadata %j",
		async (change) => {
			const f = fixture(),
				call = vi.fn(async () => f.admitted as unknown);
			const control = new LxdOfficeBootIntentControl(f.request, { call });
			await control.status(signal());
			call.mockResolvedValueOnce({ ...f.admitted, ...change });
			await expect(control.status(signal())).rejects.toThrow("UNCONFIRMED");
			expect(await control.status(signal())).toEqual(f.admitted);
		},
	);
	it("keeps cancelled IO owned until settlement and ignores the late response", async () => {
		const f = fixture();
		let settle!: (value: unknown) => void;
		const call = vi.fn(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		const control = new LxdOfficeBootIntentControl(f.request, { call }),
			cancel = new AbortController();
		const pending = expect(control.prepare(cancel.signal)).rejects.toThrow("UNCONFIRMED");
		cancel.abort();
		await pending;
		await expect(control.check(signal())).rejects.toThrow("PENDING");
		settle(f.admitted);
		await new Promise((resolve) => setTimeout(resolve, 0));
		call.mockResolvedValueOnce(f.prepared);
		expect(await control.status(signal())).toEqual(f.prepared);
	});
	it("retains the request against nested caller and transport mutation", async () => {
		const f = fixture(),
			input = structuredClone(f.request);
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => {
			expect(args.p_request).toEqual(f.request);
			(args.p_request as { predecessor: { action: string } }).predecessor.action = "replace";
			return f.prepared;
		});
		const control = new LxdOfficeBootIntentControl(input, { call });
		(input.predecessor.startup.scope as { companyId: string }).companyId = randomUUID();
		expect(await control.prepare(signal())).toEqual(f.prepared);
		expect(await control.status(signal())).toEqual(f.prepared);
	});
});
