import { afterEach, describe, expect, it, vi } from "vitest";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import {
	LxdOfficeStartControl,
	type LxdOfficeStartRegistry,
	lxdOfficeProviderBindingSha256,
} from "../src/lxd-office-start-control.ts";

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
	const identity = {
		p_provider_id: id(7),
		p_provider_policy_sha256: "f".repeat(64),
		p_scope: { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) },
		p_computer_generation: 1,
		p_intent_id: id(6),
		p_allocation_id: id(5),
		p_instance_sha256: lxdOfficeGuestPlan(binding).instanceSha256,
		p_provider_binding_sha256: lxdOfficeProviderBindingSha256(binding),
	};
	const reservation = {
		schema: "qorpera.office-start-intent/v1",
		intentId: id(6),
		companyComputerId: id(3),
		computerGeneration: 1,
		state: "reserved",
		allocationId: id(5),
		instanceSha256: identity.p_instance_sha256,
		providerBindingSha256: identity.p_provider_binding_sha256,
	};
	const authorization = { state: "authorized", intentId: id(6), computerGeneration: 1, validForMs: 5000 };
	const registry = {
		call: vi.fn<LxdOfficeStartRegistry["call"]>(async (method) =>
			method === "qorpera_reserve_runtime_office_start" ? reservation : authorization,
		),
	};
	const control = new LxdOfficeStartControl(id(6), binding, registry);
	return { binding, identity, reservation, authorization, registry, control, signal: new AbortController().signal };
}
afterEach(() => vi.restoreAllMocks());
describe("provider startup cloud admission", () => {
	it("reserves the exact generation, allocation and complete provider configuration", async () => {
		const f = fixture();
		await expect(f.control.reserve(f.signal)).resolves.toEqual({ state: "reserved" });
		expect(f.registry.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_reserve_runtime_office_start",
			{
				...f.identity,
				p_image_sha256: f.binding.imageFingerprint,
				p_bootstrap_sha256: f.binding.bootstrapSha256,
			},
			f.signal,
		);
	});
	it("freezes caller input and does not let an RPC implementation mutate subsequent reservation identity", async () => {
		const f = fixture();
		f.binding.allocationId = id(50);
		f.binding.workbenchSource = "/mnt/nas/replaced";
		f.registry.call.mockImplementationOnce(async (_method, args) => {
			(args.p_scope as Record<string, unknown>).companyId = id(51);
			return f.reservation;
		});
		await f.control.reserve(f.signal);
		await f.control.reserve(f.signal);
		expect(f.registry.call.mock.calls[1][1]).toMatchObject(f.identity);
	});
	it("returns an explicit capacity refusal without physical preparation or another request", async () => {
		const f = fixture();
		f.registry.call.mockResolvedValue({ state: "refused", reason: "MACHINE_CAPACITY_EXHAUSTED" });
		await expect(f.control.reserve(f.signal)).resolves.toEqual({
			state: "refused",
			reason: "MACHINE_CAPACITY_EXHAUSTED",
		});
		expect(f.registry.call).toHaveBeenCalledOnce();
	});
	it.each([
		"intentId",
		"companyComputerId",
		"computerGeneration",
		"allocationId",
		"instanceSha256",
		"providerBindingSha256",
		"state",
		"schema",
		"extra",
	])("rejects changed reservation field %s", async (field) => {
		const f = fixture();
		f.registry.call.mockResolvedValue({ ...f.reservation, [field]: "different" });
		await expect(f.control.reserve(f.signal)).rejects.toThrow("OFFICE_START_RESERVATION_UNCONFIRMED");
	});
	it("does not retry an unknown reservation; explicit reconciliation uses the original allocation", async () => {
		const f = fixture();
		f.registry.call.mockRejectedValueOnce(new Error("lost response"));
		await expect(f.control.reserve(f.signal)).rejects.toThrow("lost response");
		expect(f.registry.call).toHaveBeenCalledOnce();
		await expect(f.control.reserve(f.signal)).resolves.toEqual({ state: "reserved" });
		expect(f.registry.call.mock.calls[1][1]).toEqual(f.registry.call.mock.calls[0][1]);
	});
	it("checks current SQL authority on every preparation and subtracts registry latency", async () => {
		const f = fixture();
		vi.spyOn(performance, "now")
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(300)
			.mockReturnValueOnce(400)
			.mockReturnValueOnce(500);
		const first = await f.control.check(f.signal);
		const second = await f.control.check(f.signal);
		expect(first.validForMs).toBe(4800);
		expect(second.validForMs).toBe(4900);
		expect(first.signal).not.toBe(second.signal);
		expect(f.registry.call).toHaveBeenCalledTimes(2);
		expect(f.registry.call).toHaveBeenLastCalledWith("qorpera_check_runtime_office_start", f.identity, f.signal);
	});
	it.each(["intentId", "computerGeneration", "validForMs", "state", "extra"])(
		"rejects changed authority field %s",
		async (field) => {
			const f = fixture();
			f.registry.call.mockResolvedValue({ ...f.authorization, [field]: "different" });
			await expect(f.control.check(f.signal)).rejects.toThrow("OFFICE_START_AUTHORITY_UNCONFIRMED");
		},
	);
	it("cannot turn a response delayed beyond its authority window into a fresh grant", async () => {
		const f = fixture();
		vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(5100);
		await expect(f.control.check(f.signal)).rejects.toThrow("OFFICE_START_AUTHORITY_EXPIRED");
	});
	it("binds adoption responses to an immutable exact copy of the requested mappings", async () => {
		const f = fixture();
		const mapping = {
			binding: {
				...f.identity.p_scope,
				computerGeneration: 1,
				screenId: id(10),
				screenOrdinal: 1,
				screenGeneration: 2,
				staffAgentId: id(11),
			},
			browserProfile: { profileId: id(12), grantId: id(13), version: 3 },
		};
		const expected = structuredClone([mapping]);
		f.registry.call.mockImplementationOnce(async (_method, args) => {
			mapping.browserProfile.version = 4;
			return { ...f.authorization, mappings: args.p_mappings };
		});
		await f.control.checkAdoption([mapping], f.signal);
		expect(f.registry.call).toHaveBeenCalledWith(
			"qorpera_check_runtime_office_adoption",
			{ ...f.identity, p_mappings: expected },
			f.signal,
		);
		f.registry.call.mockImplementationOnce(async (_method, args) => {
			(args.p_mappings as typeof expected)[0].browserProfile.version = 9;
			return { ...f.authorization, mappings: args.p_mappings };
		});
		await expect(f.control.checkAdoption(expected, f.signal)).rejects.toThrow("OFFICE_START_AUTHORITY_UNCONFIRMED");
	});
	it("applies the same cancellation and latency window to adoption authority", async () => {
		const f = fixture();
		f.registry.call.mockResolvedValue({ ...f.authorization, mappings: [] });
		vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(5100);
		await expect(f.control.checkAdoption([], f.signal)).rejects.toThrow("OFFICE_START_AUTHORITY_EXPIRED");
		const abort = new AbortController();
		abort.abort(new Error("cancelled"));
		await expect(f.control.checkAdoption([], abort.signal)).rejects.toThrow("cancelled");
		expect(f.registry.call).toHaveBeenCalledOnce();
	});
	it("fences a checked grant on cancellation and rejects cancelled requests before the RPC", async () => {
		const f = fixture();
		const cancellation = new AbortController();
		const grant = await f.control.check(cancellation.signal);
		cancellation.abort(new Error("stopped"));
		expect(grant.signal.aborted).toBe(true);
		await expect(f.control.check(cancellation.signal)).rejects.toThrow("stopped");
		await expect(f.control.reserve(cancellation.signal)).rejects.toThrow("stopped");
		expect(f.registry.call).toHaveBeenCalledOnce();
	});
	it("rejects cancellation after an apparently successful RPC", async () => {
		const f = fixture();
		const cancellation = new AbortController();
		f.registry.call.mockImplementationOnce(async () => {
			cancellation.abort(new Error("stopped after commit"));
			return f.reservation;
		});
		await expect(f.control.reserve(cancellation.signal)).rejects.toThrow("stopped after commit");
	});
	it("binds configuration deterministically and detects mount, network, limit and identity changes", () => {
		const f = fixture();
		const digest = lxdOfficeProviderBindingSha256(f.binding);
		expect(
			lxdOfficeProviderBindingSha256(
				Object.fromEntries(Object.entries(f.binding).reverse()) as unknown as LxdOfficeGuestBinding,
			),
		).toBe(digest);
		for (const patch of [
			{ workbenchSource: "/mnt/nas/other" },
			{ network: "other" },
			{ cpus: 3 },
			{ memoryBytes: 8 * 1024 ** 3 },
			{ rootDiskBytes: 128 * 1024 ** 3 },
			{ allocationId: id(50) },
			{ computerGeneration: 2 },
			{ bootstrapSha256: "c".repeat(64) },
		])
			expect(lxdOfficeProviderBindingSha256({ ...f.binding, ...patch })).not.toBe(digest);
	});
	it("rejects invalid intent identity and incomplete provider configuration before I/O", () => {
		const f = fixture();
		expect(() => new LxdOfficeStartControl("untrusted", f.binding, f.registry)).toThrow(
			"INVALID_OFFICE_START_INTENT",
		);
		expect(
			() => new LxdOfficeStartControl(id(6), { ...f.binding, workbenchSource: "/mnt/nas/company-live" }, f.registry),
		).toThrow("INVALID_LXD_OFFICE_BINDING");
		expect(f.registry.call).not.toHaveBeenCalled();
	});
});
