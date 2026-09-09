import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeActivationControl, type LxdOfficeActivationRegistry } from "../src/lxd-office-activation-control.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { lxdOfficeProviderBindingSha256 } from "../src/lxd-office-start-control.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const binding: LxdOfficeGuestBinding = {
		schema: "qorpera.lxd-office-guest/v2",
		providerId: id(7),
		providerPolicySha256: "f".repeat(64),
		companyId: id(1),
		environmentId: id(2),
		companyComputerId: id(3),
		logicalComputerId: id(4),
		computerGeneration: 1,
		allocationId: id(5),
		project: "offices",
		imageFingerprint: "a".repeat(64),
		bootstrapSha256: "b".repeat(64),
		storagePool: "office-vms",
		rootDiskBytes: 64 * 1024 ** 3,
		workbenchSource: "/mnt/nas/office",
		network: "office-net",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
	};
	const attestation = {
		schema: "qorpera.office-activation-attestation/v1" as const,
		activationId: id(8),
		bootId: id(9),
		preparationObservationSha256: "1".repeat(64),
		configurationObservationSha256: "2".repeat(64),
		configurationSha256: "3".repeat(64),
		adoptionReceiptSha256: "4".repeat(64),
		nativePort: 9443,
		viewerPort: 9444,
	};
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
	const mappings = [
		{
			binding: {
				...scope,
				computerGeneration: 1,
				screenId: id(10),
				screenOrdinal: 1,
				screenGeneration: 2,
				staffAgentId: id(11),
			},
			browserProfile: null,
		},
	];
	const response = {
		schema: "qorpera.office-activation/v1",
		intentId: id(6),
		companyComputerId: id(3),
		computerGeneration: 1,
		allocationId: id(5),
		attestation: structuredClone(attestation),
		state: "prepared",
		serviceInvocationId: null as string | null,
		readinessFresh: false,
	};
	const registry = { call: vi.fn<LxdOfficeActivationRegistry["call"]>(async () => structuredClone(response)) };
	const control = new LxdOfficeActivationControl(id(6), binding, attestation, mappings, registry);
	return { binding, attestation, scope, mappings, response, registry, control, signal: new AbortController().signal };
}
afterEach(() => vi.restoreAllMocks());
describe("provider activation SQL control", () => {
	it("prepares exact retained evidence and recovers metadata without preparation", async () => {
		const f = fixture();
		expect(await f.control.prepare(f.signal)).toEqual({
			state: "prepared",
			serviceInvocationId: null,
			readinessFresh: false,
		});
		expect(f.registry.call.mock.calls[0].slice(0, 2)).toEqual([
			"qorpera_prepare_runtime_office_activation",
			{
				p_scope: f.scope,
				p_computer_generation: 1,
				p_intent_id: id(6),
				p_provider_id: id(7),
				p_provider_policy_sha256: "f".repeat(64),
				p_allocation_id: id(5),
				p_instance_sha256: lxdOfficeGuestPlan(f.binding).instanceSha256,
				p_provider_binding_sha256: lxdOfficeProviderBindingSha256(f.binding),
				p_attestation: f.attestation,
				p_mappings: f.mappings,
			},
		]);
		await f.control.status(f.signal);
		expect(f.registry.call.mock.calls[1].slice(0, 2)).toEqual([
			"qorpera_runtime_office_activation_status",
			{
				p_scope: f.scope,
				p_computer_generation: 1,
				p_intent_id: id(6),
				p_provider_id: id(7),
				p_provider_policy_sha256: "f".repeat(64),
				p_activation_id: id(8),
			},
		]);
	});
	it("retains bindings, attestation and mappings across caller and RPC mutations", async () => {
		const f = fixture();
		f.binding.allocationId = id(100);
		f.attestation.bootId = id(101);
		f.mappings[0].binding.screenGeneration = 50;
		const expected = structuredClone(f.response.attestation);
		f.registry.call.mockImplementationOnce(async (_method, args) => {
			(args.p_attestation as Record<string, unknown>).bootId = id(102);
			(args.p_scope as Record<string, unknown>).companyId = id(103);
			return structuredClone(f.response);
		});
		await f.control.prepare(f.signal);
		await f.control.prepare(f.signal);
		expect(f.registry.call.mock.calls[1][1]).toMatchObject({
			p_allocation_id: id(5),
			p_attestation: expected,
			p_scope: f.scope,
			p_mappings: [{ binding: { screenGeneration: 2 } }],
		});
	});
	it.each([
		"schema",
		"intentId",
		"companyComputerId",
		"computerGeneration",
		"allocationId",
		"attestation",
		"state",
		"serviceInvocationId",
		"readinessFresh",
		"extra",
	])("refuses substituted response field %s", async (field) => {
		const f = fixture();
		f.registry.call.mockResolvedValue({ ...f.response, [field]: "changed" });
		await expect(f.control.status(f.signal)).rejects.toThrow("OFFICE_ACTIVATION_UNCONFIRMED");
	});
	it.each([
		{ state: "prepared", serviceInvocationId: "a".repeat(32) },
		{ state: "prepared", readinessFresh: true },
		{ state: "ready", serviceInvocationId: null },
		{ state: "active", serviceInvocationId: "0".repeat(32) },
		{ state: "ready", serviceInvocationId: "A".repeat(32) },
	])("refuses inconsistent state %j", async (change) => {
		const f = fixture();
		f.registry.call.mockResolvedValue({ ...f.response, ...change });
		await expect(f.control.status(f.signal)).rejects.toThrow("OFFICE_ACTIVATION_UNCONFIRMED");
	});
	it("activates only the independently supplied invocation and can recover its lost committed reply", async () => {
		const f = fixture();
		Object.assign(f.response, { state: "active", serviceInvocationId: "a".repeat(32) });
		f.registry.call.mockRejectedValueOnce(new Error("lost committed reply"));
		await expect(f.control.activate("a".repeat(32), f.signal)).rejects.toThrow("lost committed reply");
		expect(f.registry.call).toHaveBeenCalledOnce();
		expect(await f.control.status(f.signal)).toEqual({
			state: "active",
			serviceInvocationId: "a".repeat(32),
			readinessFresh: false,
		});
		expect(await f.control.activate("a".repeat(32), f.signal)).toMatchObject({ state: "active" });
		expect(f.registry.call.mock.calls[2][1]).toEqual(f.registry.call.mock.calls[0][1]);
		await expect(f.control.activate("b".repeat(32), f.signal)).rejects.toThrow("OFFICE_ACTIVATION_UNCONFIRMED");
		f.response.state = "ready";
		await expect(f.control.activate("a".repeat(32), f.signal)).rejects.toThrow("OFFICE_ACTIVATION_UNCONFIRMED");
	});
	it("refuses malformed identities before registry IO", async () => {
		const f = fixture();
		expect(() => new LxdOfficeActivationControl("bad", f.binding, f.attestation, [], f.registry)).toThrow();
		expect(
			() => new LxdOfficeActivationControl(id(6), f.binding, { ...f.attestation, bootId: "bad" }, [], f.registry),
		).toThrow();
		for (const invocation of ["", "0".repeat(32), "A".repeat(32), "a".repeat(31)])
			await expect(f.control.activate(invocation, f.signal)).rejects.toThrow("INVALID_OFFICE_SERVICE_INVOCATION");
		expect(f.registry.call).not.toHaveBeenCalled();
	});
	it("refuses cancelled and failed replies without silently retrying effects", async () => {
		const f = fixture(),
			abort = new AbortController();
		abort.abort();
		await expect(f.control.prepare(abort.signal)).rejects.toThrow();
		expect(f.registry.call).not.toHaveBeenCalled();
		const cancelled = new AbortController();
		f.registry.call.mockImplementationOnce(async () => {
			cancelled.abort();
			return f.response;
		});
		await expect(f.control.prepare(cancelled.signal)).rejects.toThrow();
		f.registry.call.mockImplementationOnce(async (_method, _args, signal) => {
			expect(signal).not.toBe(f.signal);
			throw new Error("network timeout");
		});
		await expect(f.control.status(f.signal)).rejects.toThrow("network timeout");
		expect(f.registry.call).toHaveBeenCalledTimes(2);
	});
	it("refuses replies whose complete request exceeded the bounded window", async () => {
		const f = fixture();
		vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(5001);
		await expect(f.control.status(f.signal)).rejects.toThrow("OFFICE_ACTIVATION_RESPONSE_EXPIRED");
		expect(f.registry.call).toHaveBeenCalledOnce();
	});
	it("returns on cancellation even if registry IO ignores the signal, without replay", async () => {
		const f = fixture(),
			abort = new AbortController();
		let settle!: (value: unknown) => void;
		f.registry.call.mockImplementationOnce(
			async () =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		const pending = expect(f.control.prepare(abort.signal)).rejects.toThrow("OFFICE_ACTIVATION_REQUEST_ABORTED");
		await vi.waitFor(() => expect(f.registry.call).toHaveBeenCalledOnce());
		abort.abort();
		await pending;
		settle(f.response);
		await Promise.resolve();
		expect(f.registry.call).toHaveBeenCalledOnce();
	});
});
