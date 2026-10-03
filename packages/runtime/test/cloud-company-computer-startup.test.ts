import {
	parseCompanyComputerActivationAttestation,
	parseCompanyComputerStartupAuthority,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import { CompanyComputerFillKey } from "@qorpera/runtime/cloud-company-account-fill-box";
import { CompanyComputerStartupControl } from "@qorpera/runtime/cloud-company-computer-startup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerId, computerScope } from "./fixtures/company-computer.ts";

const identity = () => ({
	scope: { ...computerScope() },
	computerGeneration: 1,
	allocationId: computerId(70),
	instanceSha256: "a".repeat(64),
	imageSha256: "b".repeat(64),
	bootstrapSha256: "c".repeat(64),
	bootId: computerId(71),
	configurationSha256: "d".repeat(64),
	serviceInvocationId: "e".repeat(32),
});
const attestation = () => ({
	schema: "qorpera.office-activation-attestation/v1",
	activationId: computerId(72),
	bootId: computerId(71),
	preparationObservationSha256: "1".repeat(64),
	configurationObservationSha256: "2".repeat(64),
	configurationSha256: "d".repeat(64),
	adoptionReceiptSha256: "3".repeat(64),
	nativePort: 9443,
	viewerPort: 9444,
});
const response = (state: "prepared" | "ready" | "active" = "prepared") => ({
	schema: "qorpera.office-startup-authority/v1",
	activationId: computerId(72),
	bootId: computerId(71),
	configurationSha256: "d".repeat(64),
	state,
	serviceInvocationId: state === "prepared" ? null : "e".repeat(32),
	validForMs: 5000,
});
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe("closed office activation and service startup contracts", () => {
	it("clones identities and binds startup response to boot, configuration and invocation", () => {
		const input = identity(),
			parsed = parseCompanyComputerStartupIdentity(input);
		expect(parsed).toEqual(input);
		expect(Object.isFrozen(parsed.scope)).toBe(true);
		input.scope.companyId = computerId(100);
		expect(parsed.scope.companyId).not.toBe(input.scope.companyId);
		expect(parseCompanyComputerActivationAttestation(attestation())).toEqual(attestation());
		for (const state of ["prepared", "ready", "active"] as const)
			expect(parseCompanyComputerStartupAuthority(response(state), identity())).toEqual(response(state));
	});
	it.each([
		{ activationId: "bad" },
		{ bootId: computerId(100) },
		{ configurationSha256: "f".repeat(64) },
		{ validForMs: 6000 },
		{ validForMs: 0 },
		{ state: "failed" },
		{ serviceInvocationId: null },
		{ serviceInvocationId: "f".repeat(32) },
		{ extra: "forbidden" },
	])("refuses substituted startup authority %j", (change) => {
		expect(() =>
			parseCompanyComputerStartupAuthority({ ...response("ready"), ...change }, identity(), computerId(72)),
		).toThrow();
	});
	it.each([
		{ schema: "old" },
		{ nativePort: 0 },
		{ nativePort: 1.5 },
		{ viewerPort: 65536 },
		{ viewerPort: 9443 },
		{ activationId: null },
		{ configurationObservationSha256: "invalid" },
		{ preparationObservationSha256: 1 },
		{ extra: true },
	])("refuses malformed activation attestation %j", (change) => {
		expect(() => parseCompanyComputerActivationAttestation({ ...attestation(), ...change })).toThrow();
	});
	it.each([
		{ computerGeneration: 0 },
		{ computerGeneration: 1.5 },
		{ serviceInvocationId: "" },
		{ serviceInvocationId: "0".repeat(32) },
		{ serviceInvocationId: "E".repeat(32) },
		{ allocationId: null },
		{ scope: { ...computerScope(), extra: true } },
		{ extra: true },
		{ configurationSha256: "invalid" },
	])("refuses malformed service identity %j", (change) => {
		expect(() => parseCompanyComputerStartupIdentity({ ...identity(), ...change })).toThrow();
	});
});
describe("provider-controlled startup wait", () => {
	it("reports actual ports while closed and waits for matching provider activation", async () => {
		const call = vi
			.fn()
			.mockResolvedValueOnce(response())
			.mockResolvedValueOnce(response("ready"))
			.mockResolvedValueOnce(response("active"));
		const physical = vi.fn(async () => {}),
			control = new CompanyComputerStartupControl(identity(), { call });
		await control.check(signal());
		await control.waitForActivation({ nativePort: 9443, viewerPort: 9444 }, physical, signal());
		expect(physical).toHaveBeenCalledTimes(2);
		expect(call.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_check_runtime_office_startup",
			"qorpera_report_runtime_office_ready",
			"qorpera_report_runtime_office_ready",
		]);
		expect(call.mock.calls[1][1]).toEqual({
			p_startup: identity(),
			p_activation_id: computerId(72),
			p_native_port: 9443,
			p_viewer_port: 9444,
		});
	});
	it("reports the service's fill key with every readiness report, and refuses a malformed one", async () => {
		const key = new CompanyComputerFillKey().publicKey;
		const call = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response("active"));
		const control = new CompanyComputerStartupControl(identity(), { call }, { fillPublicKey: key });
		await control.check(signal());
		await control.waitForActivation({ nativePort: 9443, viewerPort: 9444 }, async () => {}, signal());
		expect(call.mock.calls[1][1]).toEqual({
			p_startup: identity(),
			p_activation_id: computerId(72),
			p_native_port: 9443,
			p_viewer_port: 9444,
			p_fill_public_key: key,
		});
		for (const bad of ["", "short", `${key}A`, `${key.slice(0, 42)}B`, key.replace(/[A-Za-z]/, "+")])
			if (bad !== key)
				expect(() => new CompanyComputerStartupControl(identity(), { call }, { fillPublicKey: bad }), bad).toThrow(
					"OFFICE_FILL_KEY_MALFORMED",
				);
	});
	it("does not report readiness before authorization or after failed physical preflight", async () => {
		const call = vi.fn().mockResolvedValue(response()),
			control = new CompanyComputerStartupControl(identity(), { call });
		await expect(
			control.waitForActivation({ nativePort: 9443, viewerPort: 9444 }, async () => {}, signal()),
		).rejects.toThrow();
		expect(call).not.toHaveBeenCalled();
		await control.check(signal());
		await expect(
			control.waitForActivation(
				{ nativePort: 9443, viewerPort: 9444 },
				async () => {
					throw new Error("physical changed");
				},
				signal(),
			),
		).rejects.toThrow();
		expect(call).toHaveBeenCalledOnce();
	});
	it("refuses a replaced activation and a reply that did not register the invocation", async () => {
		for (const reply of [{ ...response("ready"), activationId: computerId(100) }, response()]) {
			const call = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(reply),
				control = new CompanyComputerStartupControl(identity(), { call });
			await control.check(signal());
			await expect(
				control.waitForActivation({ nativePort: 9443, viewerPort: 9444 }, async () => {}, signal()),
			).rejects.toThrow();
		}
	});
	it("stops reporting on cancellation", async () => {
		const abort = new AbortController();
		const call = vi
			.fn()
			.mockResolvedValueOnce(response())
			.mockImplementationOnce(async () => {
				abort.abort();
				return response("ready");
			});
		const control = new CompanyComputerStartupControl(identity(), { call });
		await control.check(signal());
		await expect(
			control.waitForActivation({ nativePort: 9443, viewerPort: 9444 }, async () => {}, abort.signal),
		).rejects.toThrow();
		expect(call).toHaveBeenCalledTimes(2);
	});
	it("deducts request time and refuses an expired authority response", async () => {
		vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(5001);
		const control = new CompanyComputerStartupControl(identity(), { call: vi.fn().mockResolvedValue(response()) });
		await expect(control.check(signal())).rejects.toThrow("OFFICE_STARTUP_AUTHORITY_EXPIRED");
	});
});
