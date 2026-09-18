import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudCompanyComputerAccess,
	type CompanyComputerAccessRpc,
	type CompanyComputerAccessStatus,
} from "../src/index.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
function fixture() {
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
	const status: CompanyComputerAccessStatus = {
		schema: "qorpera.office-access-status/v1",
		scope,
		staffAgentId: id(5),
		grant: { grantId: id(6), version: 2, state: "active", capabilities: ["desktop"] },
	};
	const rpc = vi.fn<CompanyComputerAccessRpc>(async () => ({ data: status, error: null }));
	return { scope, status, rpc, client: new CloudCompanyComputerAccess(scope, id(5), rpc) };
}
afterEach(() => vi.useRealTimers());
describe("shared member office capability administration", () => {
	it("sends the exact observed version and explicit capabilities to the member RPC", async () => {
		const f = fixture();
		await expect(
			f.client.configure({ expectedVersion: 1, enabled: true, capabilities: ["desktop"] }, signal()),
		).resolves.toEqual(f.status);
		expect(f.rpc).toHaveBeenCalledExactlyOnceWith(
			"qorpera_configure_runtime_office_access",
			{
				p_scope: f.scope,
				p_staff_agent_id: id(5),
				p_expected_version: 1,
				p_enabled: true,
				p_capabilities: ["desktop"],
			},
			expect.any(AbortSignal),
		);
	});
	it("recovers an unknown write through status without retrying the mutation", async () => {
		const f = fixture();
		f.rpc.mockRejectedValueOnce(new Error("secret SQL"));
		await expect(
			f.client.configure({ expectedVersion: 1, enabled: true, capabilities: ["desktop"] }, signal()),
		).rejects.toThrow("OFFICE_ACCESS_UNCONFIRMED_REFRESH_STATUS");
		await expect(f.client.status(signal())).resolves.toEqual(f.status);
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_configure_runtime_office_access",
			"qorpera_runtime_office_access_status",
		]);
	});
	it("represents no grant and durable revocation without implying physical drain", async () => {
		const f = fixture();
		f.status.grant = null;
		await expect(f.client.status(signal())).resolves.toMatchObject({ grant: null });
		f.status.grant = { grantId: id(6), version: 1, state: "revoked", capabilities: ["desktop", "shell"] };
		await expect(
			f.client.configure({ expectedVersion: 0, enabled: false, capabilities: ["desktop", "shell"] }, signal()),
		).resolves.toEqual(f.status);
	});
	it.each([[], ["browser"], ["shell", "desktop"], ["desktop", "desktop"], ["desktop", "shell", "browser"], null])(
		"rejects capabilities %j before RPC",
		async (value) => {
			const f = fixture();
			await expect(
				f.client.configure({ expectedVersion: 1, enabled: true, capabilities: value as never }, signal()),
			).rejects.toThrow("INVALID_OFFICE_ACCESS_CAPABILITIES");
			expect(f.rpc).not.toHaveBeenCalled();
		},
	);
	it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER])("rejects invalid expected version %s", async (expectedVersion) => {
		const f = fixture();
		await expect(
			f.client.configure({ expectedVersion, enabled: true, capabilities: ["desktop"] }, signal()),
		).rejects.toThrow("INVALID_OFFICE_ACCESS_REQUEST");
		expect(f.rpc).not.toHaveBeenCalled();
	});
	it.each([{ version: 3 }, { state: "revoked" }, { capabilities: ["shell"] }, { grantId: id(99), extra: true }])(
		"rejects a mismatched or open write acknowledgement %j",
		async (change) => {
			const f = fixture();
			Object.assign(f.status.grant!, change);
			await expect(
				f.client.configure({ expectedVersion: 1, enabled: true, capabilities: ["desktop"] }, signal()),
			).rejects.toThrow();
		},
	);
	it.each([{ staffAgentId: id(99) }, { schema: "other" }, { extra: true }, { grant: {} }])(
		"rejects unbound status %j",
		async (change) => {
			const f = fixture();
			Object.assign(f.status, change);
			await expect(f.client.status(signal())).rejects.toThrow();
		},
	);
	it("rejects another office and unexpected scope metadata", async () => {
		const f = fixture();
		f.status.scope = { ...f.scope, companyId: id(99) };
		await expect(f.client.status(signal())).rejects.toThrow();
		f.status.scope = { ...f.scope, extra: true } as never;
		await expect(f.client.status(signal())).rejects.toThrow();
	});
	it("keeps request options and returned state independent of mutable client inputs", async () => {
		const f = fixture();
		const options = { expectedVersion: 1, enabled: true, capabilities: ["desktop"] as ["desktop"] };
		const pending = f.client.configure(options, signal());
		options.enabled = false;
		options.capabilities[0] = "shell" as never;
		const result = await pending;
		result.grant!.capabilities[0] = "shell";
		expect(f.status.grant!.capabilities).toEqual(["desktop"]);
		f.scope.companyId = id(99);
		f.status.scope = { ...f.scope, companyId: id(1) };
		await f.client.status(signal());
		expect(f.rpc.mock.calls[1][1].p_scope).toEqual(f.status.scope);
	});
	it("bounds unresponsive calls, suppresses diagnostics and never retries on error", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.rpc.mockReturnValueOnce(new Promise(() => {}));
		const pending = expect(f.client.status(signal())).rejects.toThrow("OFFICE_ACCESS_UNCONFIRMED_REFRESH_STATUS");
		await vi.advanceTimersByTimeAsync(5001);
		await pending;
		f.rpc.mockResolvedValueOnce({ data: null, error: { message: "secret SQL" } });
		await expect(f.client.status(signal())).rejects.toThrow("OFFICE_ACCESS_UNCONFIRMED_REFRESH_STATUS");
		expect(f.rpc).toHaveBeenCalledTimes(2);
	});
});
