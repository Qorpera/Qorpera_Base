import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudCompanyComputerBrowserProfiles,
	type CloudCompanyComputerBrowserProfilesRpc,
} from "../src/cloud-company-computer-browser-profiles.ts";

const id = (n: number) => `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
	const profile = { profileId: id(7), label: "Work browser", version: 2, prepared: true, activeStaffAgentId: id(9) };
	const catalog = { scope, memberId: id(6), canUse: true, profiles: [profile], nextAfter: null };
	const grant = { grantId: id(8), version: 3, profileVersion: 2, state: "active", usable: true };
	const status = { scope, memberId: id(6), staffAgentId: id(9), profile, grant };
	const binding = {
		...scope,
		computerGeneration: 1,
		screenGeneration: 2,
		screenOrdinal: 1,
		staffAgentId: id(9),
		screenId: id(10),
	};
	const change = {
		profileId: id(7),
		grantId: id(8),
		version: 4,
		state: "revoked",
		drains: [{ state: "draining", drainId: id(11), epoch: 2, binding }],
	};
	const rpc = vi.fn<CloudCompanyComputerBrowserProfilesRpc>(async (method) => ({
		error: null,
		data:
			method === "qorpera_member_browser_profiles"
				? catalog
				: method === "qorpera_create_member_browser_profile"
					? profile
					: method === "qorpera_member_browser_grant_status"
						? status
						: change,
	}));
	const client = new CloudCompanyComputerBrowserProfiles({ scope, memberId: id(6), rpc });
	const input = { profileId: id(7), profileVersion: 2, staffAgentId: id(9), expectedVersion: 3, enabled: false };
	return {
		client,
		scope,
		profile,
		catalog,
		grant,
		status,
		change,
		binding,
		rpc,
		input,
		signal: new AbortController().signal,
	};
}
afterEach(() => vi.useRealTimers());
describe("member-owned browser profiles", () => {
	it("lists owner metadata without creating profiles or granting browser access", async () => {
		const f = fixture();
		expect(await f.client.catalog(f.signal)).toEqual(f.catalog);
		expect(f.rpc).toHaveBeenCalledExactlyOnceWith(
			"qorpera_member_browser_profiles",
			{ p_scope: f.scope, p_after: null },
			expect.any(AbortSignal),
		);
		const result = await f.client.catalog(f.signal);
		result.profiles[0].label = "local change";
		expect(f.profile.label).toBe("Work browser");
	});
	it("rejects foreign owners, offices, secret fields and invalid pagination", async () => {
		for (const patch of [
			{ memberId: id(99) },
			{ scope: { ...fixture().scope, companyId: id(99) } },
			{ password: "secret" },
			{ profiles: [fixture().profile, fixture().profile] },
			{ profiles: Array(51).fill(fixture().profile) },
			{ nextAfter: id(7) },
			{ profiles: [{ ...fixture().profile, path: "/private" }] },
		]) {
			const f = fixture();
			f.rpc.mockResolvedValue({ data: { ...f.catalog, ...patch }, error: null });
			await expect(f.client.catalog(f.signal)).rejects.toThrow();
		}
		const f = fixture();
		await expect(f.client.catalog(f.signal, id(7))).rejects.toThrow();
	});
	it("accepts a bounded ordered page and a former-owner cleanup-only catalog", async () => {
		const f = fixture(),
			profiles = Array.from({ length: 50 }, (_, i) => ({ ...f.profile, profileId: id(i + 100) }));
		f.rpc.mockResolvedValueOnce({ data: { ...f.catalog, canUse: false, profiles, nextAfter: id(149) }, error: null });
		expect(await f.client.catalog(f.signal)).toMatchObject({ canUse: false, nextAfter: id(149) });
	});
	it("registers only a named explicit identity and recovers uncertainty by reading", async () => {
		const f = fixture();
		expect(await f.client.register(id(7), "Work browser", f.signal)).toEqual(f.profile);
		expect(f.rpc.mock.calls[0][1]).toEqual({ p_scope: f.scope, p_profile_id: id(7), p_label: "Work browser" });
		f.rpc.mockRejectedValueOnce(new Error("lost reply with private diagnostics"));
		await expect(f.client.register(id(12), "Other", f.signal)).rejects.toThrow(
			"BROWSER_PROFILE_UNCONFIRMED_REFRESH_STATUS",
		);
		await f.client.catalog(f.signal);
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_create_member_browser_profile",
			"qorpera_create_member_browser_profile",
			"qorpera_member_browser_profiles",
		]);
	});
	it("validates labels and substituted registration results", async () => {
		const f = fixture();
		for (const name of ["", " x", "x ", "x\ny", "x".repeat(81)])
			await expect(f.client.register(id(7), name, f.signal)).rejects.toThrow();
		expect(f.rpc).not.toHaveBeenCalled();
		for (const patch of [{ profileId: id(99) }, { label: "Other" }, { prepared: "true" }, { version: 0 }]) {
			f.rpc.mockResolvedValueOnce({ data: { ...f.profile, ...patch }, error: null });
			await expect(f.client.register(id(7), "Work browser", f.signal)).rejects.toThrow();
		}
	});
	it("distinguishes configured consent from currently usable consent", async () => {
		const f = fixture();
		expect(await f.client.grantStatus(id(7), id(9), f.signal)).toEqual(f.status);
		f.rpc.mockResolvedValueOnce({
			data: { ...f.status, grant: { ...f.grant, usable: false, profileVersion: 1 } },
			error: null,
		});
		expect((await f.client.grantStatus(id(7), id(9), f.signal)).grant).toMatchObject({
			usable: false,
			profileVersion: 1,
		});
		f.rpc.mockResolvedValueOnce({ data: { ...f.status, grant: null }, error: null });
		expect((await f.client.grantStatus(id(7), id(9), f.signal)).grant).toBeNull();
	});
	it("refuses inconsistent usable consent and cross-profile/staff metadata", async () => {
		for (const patch of [
			{ staffAgentId: id(99) },
			{ profile: { ...fixture().profile, profileId: id(99) } },
			{ grant: { ...fixture().grant, state: "revoked" } },
			{ grant: { ...fixture().grant, profileVersion: 1 } },
			{ profile: { ...fixture().profile, prepared: false } },
			{ grant: { ...fixture().grant, secret: "cookie" } },
		]) {
			const f = fixture();
			f.rpc.mockResolvedValueOnce({ data: { ...f.status, ...patch }, error: null });
			await expect(f.client.grantStatus(id(7), id(9), f.signal)).rejects.toThrow();
		}
	});
	it("preserves copied intent, exact profile/grant versions and the returned drain", async () => {
		const f = fixture();
		let complete!: (result: Awaited<ReturnType<CloudCompanyComputerBrowserProfilesRpc>>) => void;
		f.rpc.mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const changing = f.client.configure(f.input, f.signal);
		await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
		f.input.expectedVersion = 90;
		f.input.profileId = id(99);
		complete({ data: f.change, error: null });
		expect(await changing).toEqual(f.change);
		expect(f.rpc.mock.calls[0][1]).toEqual({
			p_scope: f.scope,
			p_profile_id: id(7),
			p_profile_version: 2,
			p_staff_agent_id: id(9),
			p_expected_version: 3,
			p_enabled: false,
		});
	});
	it("rejects changed grant outcomes and foreign, repeated or unbounded drains", async () => {
		for (const patch of [
			{ version: 3 },
			{ profileId: id(99) },
			{ state: "active" },
			{ drains: [fixture().change.drains[0], fixture().change.drains[0]] },
			{ drains: Array(33).fill(fixture().change.drains[0]) },
			{ drains: [{ ...fixture().change.drains[0], binding: { ...fixture().binding, staffAgentId: id(99) } }] },
		]) {
			const f = fixture();
			f.rpc.mockResolvedValueOnce({ data: { ...f.change, ...patch }, error: null });
			await expect(f.client.configure(f.input, f.signal)).rejects.toThrow();
		}
	});
	it("does not retry a stalled consent mutation", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.rpc.mockImplementation(() => new Promise(() => undefined));
		const pending = expect(f.client.configure(f.input, f.signal)).rejects.toThrow(
			"BROWSER_PROFILE_UNCONFIRMED_REFRESH_STATUS",
		);
		await vi.advanceTimersByTimeAsync(5001);
		await pending;
		expect(f.rpc).toHaveBeenCalledOnce();
		expect(f.rpc.mock.calls[0][2].aborted).toBe(true);
	});
});
