import { describe, expect, it, vi } from "vitest";
import { LxdOfficeProviderControl, type LxdOfficeProviderRegistry } from "../src/lxd-office-provider-control.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const assignment = {
		companyId: id(1),
		environmentId: id(2),
		companyComputerId: id(3),
		logicalComputerId: id(4),
		computerGeneration: 1,
		providerId: id(7),
		providerPolicySha256: "f".repeat(64),
		imageFingerprint: "a".repeat(64),
		bootstrapSha256: "b".repeat(64),
	};
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
	const intent = {
		schema: "qorpera.office-start-intent/v1",
		intentId: id(6),
		companyComputerId: id(3),
		computerGeneration: 1,
		state: "requested",
	};
	const reservation = { allocationId: id(5), instanceSha256: "c".repeat(64), providerBindingSha256: "d".repeat(64) };
	const result = {
		schema: "qorpera.office-provider-status/v1",
		scope,
		computerGeneration: 1,
		officeState: "provisioning",
		providerId: id(7),
		providerPolicySha256: "f".repeat(64),
		providerVersion: 1,
		preparationEnabled: true,
		imageSha256: "a".repeat(64),
		bootstrapSha256: "b".repeat(64),
		intent: intent as typeof intent | null,
		reservation: null as typeof reservation | null,
	};
	const registry = { call: vi.fn<LxdOfficeProviderRegistry["call"]>(async () => result) };
	const control = new LxdOfficeProviderControl(assignment, registry);
	return { assignment, scope, result, intent, reservation, registry, control, signal: new AbortController().signal };
}
describe("persistent office provider discovery", () => {
	it("discovers current demand through a provider-scoped read only", async () => {
		const f = fixture();
		await expect(f.control.status(f.signal)).resolves.toEqual({
			providerVersion: 1,
			preparationEnabled: true,
			officeState: "provisioning",
			intent: { intentId: id(6), state: "requested" },
			reservation: null,
		});
		expect(f.registry.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_runtime_office_provider_status",
			{
				p_scope: f.scope,
				p_computer_generation: 1,
				p_provider_id: id(7),
				p_provider_policy_sha256: "f".repeat(64),
			},
			f.signal,
		);
	});
	it("reads an empty assignment without creating a start request or allocation", async () => {
		const f = fixture();
		f.result.intent = null;
		await expect(f.control.status(f.signal)).resolves.toMatchObject({ intent: null, reservation: null });
		expect(f.registry.call).toHaveBeenCalledOnce();
	});
	it("keeps cancelled/disabled allocation metadata available for reconciliation without granting preparation", async () => {
		const f = fixture();
		f.intent.state = "cancelled";
		f.result.reservation = f.reservation;
		f.result.preparationEnabled = false;
		f.result.providerVersion = 2;
		await expect(f.control.status(f.signal)).resolves.toEqual({
			providerVersion: 2,
			preparationEnabled: false,
			officeState: "provisioning",
			intent: { intentId: id(6), state: "cancelled" },
			reservation: f.reservation,
		});
	});
	it.each([
		"schema",
		"scope",
		"computerGeneration",
		"providerId",
		"providerPolicySha256",
		"imageSha256",
		"bootstrapSha256",
		"providerVersion",
		"preparationEnabled",
		"officeState",
		"url",
	])("rejects changed assignment metadata: %s", async (key) => {
		const f = fixture();
		f.registry.call.mockResolvedValue({ ...f.result, [key]: "untrusted" });
		await expect(f.control.status(f.signal)).rejects.toThrow();
	});
	it.each(["schema", "companyComputerId", "computerGeneration", "intentId", "state", "command"])(
		"rejects changed intent metadata: %s",
		async (key) => {
			const f = fixture();
			f.registry.call.mockResolvedValue({ ...f.result, intent: { ...f.intent, [key]: "untrusted" } });
			await expect(f.control.status(f.signal)).rejects.toThrow();
		},
	);
	it.each(["allocationId", "instanceSha256", "providerBindingSha256", "path"])(
		"rejects changed reservation metadata: %s",
		async (key) => {
			const f = fixture();
			f.intent.state = "reserved";
			f.registry.call.mockResolvedValue({ ...f.result, reservation: { ...f.reservation, [key]: "untrusted" } });
			await expect(f.control.status(f.signal)).rejects.toThrow();
		},
	);
	it.each(["no intent", "requested with allocation", "reserved without allocation"])(
		"rejects inconsistent reservation: %s",
		async (state) => {
			const f = fixture();
			if (state === "no intent") {
				f.result.intent = null;
				f.result.reservation = f.reservation;
			}
			if (state === "requested with allocation") f.result.reservation = f.reservation;
			if (state === "reserved without allocation") f.intent.state = "reserved";
			await expect(f.control.status(f.signal)).rejects.toThrow("INVALID_OFFICE_PROVIDER_RESERVATION");
		},
	);
	it("copies input/output and re-reads current status on every call", async () => {
		const f = fixture();
		f.assignment.providerId = id(90);
		f.intent.state = "reserved";
		f.result.reservation = f.reservation;
		const status = await f.control.status(f.signal);
		status.intent!.state = "cancelled";
		status.reservation!.allocationId = id(90);
		await expect(f.control.status(f.signal)).resolves.toMatchObject({
			intent: { state: "reserved" },
			reservation: { allocationId: id(5) },
		});
		expect(f.registry.call.mock.calls[1][1].p_provider_id).toBe(id(7));
	});
	it("rejects cancelled reads before and after the transport and performs no retry", async () => {
		const f = fixture();
		const stop = new AbortController();
		f.registry.call.mockImplementationOnce(async () => {
			stop.abort(new Error("stopped"));
			return f.result;
		});
		await expect(f.control.status(stop.signal)).rejects.toThrow("stopped");
		await expect(f.control.status(stop.signal)).rejects.toThrow("stopped");
		expect(f.registry.call).toHaveBeenCalledOnce();
	});
	it("rejects unknown transport results without turning discovery into an automatic provider enrollment", async () => {
		const f = fixture();
		f.registry.call.mockRejectedValue(new Error("unavailable"));
		await expect(f.control.status(f.signal)).rejects.toThrow("unavailable");
		expect(f.registry.call).toHaveBeenCalledOnce();
	});
	it.each([
		"providerId",
		"providerPolicySha256",
		"computerGeneration",
		"companyId",
		"imageFingerprint",
		"bootstrapSha256",
		"allocationId",
	])("rejects invalid configured assignment: %s", (key) => {
		const f = fixture();
		expect(() => new LxdOfficeProviderControl({ ...f.assignment, [key]: "untrusted" }, f.registry)).toThrow();
		expect(f.registry.call).not.toHaveBeenCalled();
	});
});
