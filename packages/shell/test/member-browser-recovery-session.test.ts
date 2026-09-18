import { CloudMemberBrowserRecovery } from "@qorpera/cloud-client/cloud-member-browser-recovery";
import { describe, expect, it, vi } from "vitest";
import { MemberBrowserRecoverySession } from "../src/member-browser-recovery-session.ts";

const id = (n: number) => `37000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) },
		memberId = id(5);
	const profile = { profileId: id(6), label: "Work", version: 2, prepared: true, activeStaffAgentId: id(7) };
	const state = { current: true, ownsPrivacy: false };
	const abort = new AbortController();
	const rpc = vi.fn(async (method: string) => {
		if (method === "qorpera_member_browser_recovery")
			return {
				data: { memberId, offices: [{ scope, ownsPrivacy: state.ownsPrivacy }], nextAfter: null },
				error: null,
			};
		if (method === "qorpera_member_browser_profiles")
			return { data: { scope, memberId, canUse: false, profiles: [profile], nextAfter: null }, error: null };
		if (method === "qorpera_member_browser_grant_status")
			return {
				data: {
					scope,
					memberId,
					profile,
					staffAgentId: id(7),
					grant: { grantId: id(8), version: 3, profileVersion: 2, state: "active", usable: false },
				},
				error: null,
			};
		if (method === "qorpera_set_runtime_browser_grant")
			return { data: { profileId: id(6), grantId: id(8), version: 4, state: "revoked", drains: [] }, error: null };
		throw new Error("No company or viewer access");
	});
	const session = new MemberBrowserRecoverySession({
		client: new CloudMemberBrowserRecovery({ memberId, rpc }),
		signal: abort.signal,
		current: () => {
			if (!state.current) throw new Error("Account changed");
		},
	});
	const select = async () => {
		await session.action({ method: "offices", after: null });
		await session.action({ method: "selectOffice", companyComputerId: id(3) });
	};
	const revoke = {
		method: "configureBrowser",
		enabled: false,
		profileId: id(6),
		profileVersion: 2,
		staffAgentId: id(7),
		expectedVersion: 3,
	};
	return { session, state, abort, rpc, select, revoke };
}
describe("account browser cleanup host", () => {
	it("never contacts a renderer-selected office without owner discovery", async () => {
		const f = fixture();
		await expect(f.session.action({ method: "selectOffice", companyComputerId: id(3) })).rejects.toThrow();
		expect(f.rpc).not.toHaveBeenCalled();
		await f.select();
		await expect(f.session.action({ method: "selectOffice", companyComputerId: id(99) })).rejects.toThrow();
	});
	it("allows explicit revocation for a former member and retired agent", async () => {
		const f = fixture();
		await f.select();
		await expect(f.session.action({ method: "privacy" })).resolves.toBeNull();
		await f.session.action({ method: "profiles", after: null });
		await f.session.action({ method: "browserGrant", profileId: id(6), staffAgentId: id(7) });
		await f.session.action(f.revoke);
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_member_browser_recovery",
			"qorpera_member_browser_profiles",
			"qorpera_member_browser_grant_status",
			"qorpera_set_runtime_browser_grant",
		]);
		await expect(f.session.action(f.revoke)).rejects.toThrow();
	});
	it("cannot create profiles, enter private mode, enable consent or connect a viewer", async () => {
		const f = fixture();
		await f.select();
		const before = f.rpc.mock.calls.length;
		for (const input of [
			{ method: "registerProfile", label: "Work" },
			{ method: "beginPrivate", profileId: id(6), screenId: id(9) },
			{ ...f.revoke, enabled: true },
			{ method: "connectPrivate", challengeId: id(10) },
			{ method: "profiles", after: null, secret: "unexpected" },
		])
			await expect(f.session.action(input)).rejects.toThrow();
		expect(f.rpc).toHaveBeenCalledTimes(before);
	});
	it("requires rediscovery after catalog refresh and fences account changes", async () => {
		const f = fixture();
		await f.select();
		await f.session.action({ method: "offices", after: null });
		await expect(f.session.action({ method: "profiles", after: null })).rejects.toThrow();
		f.state.current = false;
		await expect(f.select()).rejects.toThrow();
		f.state.current = true;
		f.abort.abort();
		await expect(f.select()).rejects.toThrow();
		expect(f.rpc).toHaveBeenCalledTimes(2);
	});
});
