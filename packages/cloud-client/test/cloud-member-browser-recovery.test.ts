import { describe, expect, it, vi } from "vitest";
import { CloudMemberBrowserRecovery } from "../src/cloud-member-browser-recovery.ts";

const id = (n: number) => `37000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
	const value = { memberId: id(5), offices: [{ scope, ownsPrivacy: true }], nextAfter: null as string | null };
	const rpc = vi.fn(async () => ({ data: value, error: null }));
	const client = new CloudMemberBrowserRecovery({ memberId: id(5), rpc });
	return { scope, value, rpc, client, signal: new AbortController().signal };
}
describe("account browser recovery", () => {
	it("discovers only closed owner metadata and copies caller-visible scope", async () => {
		const f = fixture();
		const catalog = await f.client.catalog(f.signal);
		expect(catalog).toEqual(f.value);
		Object.assign(catalog.offices[0].scope, { companyId: id(99) });
		expect(f.scope.companyId).toBe(id(1));
		expect(f.rpc).toHaveBeenCalledWith("qorpera_member_browser_recovery", { p_after: null }, expect.any(AbortSignal));
	});
	it("rejects another owner, private details and invalid scope", async () => {
		for (const change of ["owner", "extra", "scope", "state"]) {
			const f = fixture();
			if (change === "owner") f.value.memberId = id(99);
			else if (change === "extra") Object.assign(f.value.offices[0], { password: "never" });
			else if (change === "scope") f.scope.companyId = "bad";
			else Object.assign(f.value.offices[0], { ownsPrivacy: "true" });
			await expect(f.client.catalog(f.signal)).rejects.toThrow();
		}
	});
	it("rejects oversized, duplicate, unordered and forged continuation pages", async () => {
		for (const change of ["oversized", "duplicate", "cursor", "behind"]) {
			const f = fixture();
			if (change === "oversized") f.value.offices = Array(51).fill(f.value.offices[0]);
			else if (change === "duplicate") f.value.offices.push(f.value.offices[0]);
			else if (change === "cursor") f.value.nextAfter = id(3);
			await expect(f.client.catalog(f.signal, change === "behind" ? id(4) : null)).rejects.toThrow();
		}
	});
	it("keeps failures closed without retrying mutations or revealing database errors", async () => {
		const f = fixture();
		f.rpc.mockRejectedValue(new Error("secret backend"));
		await expect(f.client.catalog(f.signal)).rejects.toThrow("BROWSER_RECOVERY_UNCONFIRMED_REFRESH_STATUS");
		expect(f.rpc).toHaveBeenCalledOnce();
	});
});
