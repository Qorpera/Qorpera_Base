// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { navigate } from "../src/app/router.ts";
import { webBrowserRecovery } from "../src/cloud/browser-recovery.ts";
import { deferred, fixture, id, userA, userB } from "./fixtures.ts";

let close: (() => void) | undefined;
beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	history.replaceState(null, "", "/#/browser-access");
});
afterEach(() => {
	close?.();
	close = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function click(root: ParentNode, label: string) {
	const button = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
	if (!button) throw new Error(`Missing button ${label}: ${root.textContent}`);
	button.click();
}
async function setup() {
	const f = fixture();
	vi.mocked(f.api.listProfiles).mockResolvedValue([]);
	const scope = { companyId: id(30), environmentId: id(31), companyComputerId: id(32), logicalComputerId: id(33) };
	const profile = {
		profileId: id(34),
		label: "Former company browser",
		version: 4,
		prepared: true,
		activeStaffAgentId: id(35) as string | null,
	};
	let version = 8,
		revoked = false;
	const calls: { method: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
	const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const method = String(input).split("/").at(-1)!;
		const args = JSON.parse(init!.body as string);
		calls.push({ method, args, signal: init!.signal! });
		expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(new Headers(init!.headers).get("authorization")).toBe("Bearer fixture-token");
		if (method === "qorpera_member_browser_recovery")
			return Response.json({ memberId: userA.id, offices: [{ scope, ownsPrivacy: false }], nextAfter: null });
		if (method === "qorpera_member_browser_profiles")
			return Response.json({ scope, memberId: userA.id, canUse: false, profiles: [profile], nextAfter: null });
		if (method === "qorpera_member_browser_grant_status")
			return Response.json({
				scope,
				memberId: userA.id,
				staffAgentId: id(35),
				profile,
				grant: {
					grantId: id(36),
					version,
					profileVersion: 4,
					state: revoked ? "revoked" : "active",
					usable: false,
				},
			});
		if (method === "qorpera_set_runtime_browser_grant") {
			expect(args).toEqual({
				p_scope: scope,
				p_profile_id: profile.profileId,
				p_profile_version: 4,
				p_staff_agent_id: id(35),
				p_expected_version: 8,
				p_enabled: false,
			});
			revoked = true;
			version++;
			profile.activeStaffAgentId = null;
			return Response.json({ profileId: profile.profileId, grantId: id(36), version, state: "revoked", drains: [] });
		}
		throw new Error(`Unexpected ${method}`);
	});
	vi.stubGlobal("fetch", fetcher);
	const root = document.createElement("div");
	document.body.append(root);
	close = mountApplication(root, f.cloud, f.api);
	await vi.waitFor(() => expect(root.textContent).toContain("Computer 000000000032"));
	return {
		...f,
		root,
		scope,
		profile,
		fetcher,
		calls,
		changeVersion: () => {
			version++;
		},
	};
}
describe("product account browser cleanup", () => {
	it("finishes only the account's observed private sign-in and keeps physical closure pending", async () => {
		const f = await setup(),
			normal = f.fetcher.getMockImplementation()!;
		let leaving = false;
		const mutations: Record<string, unknown>[] = [];
		const challenge = {
			scope: f.scope,
			computerGeneration: 2,
			challengeId: id(40),
			version: 3,
			state: "entering",
			memberId: userA.id,
			profileId: f.profile.profileId,
			profileVersion: 4,
			screenId: id(41),
			drains: [
				{
					state: "draining",
					drainId: id(42),
					epoch: 3,
					binding: {
						...f.scope,
						computerGeneration: 2,
						screenId: id(41),
						screenOrdinal: 1,
						screenGeneration: 2,
						staffAgentId: id(35),
					},
				},
			],
		};
		f.fetcher.mockImplementation(async (input, init) => {
			const method = String(input).split("/").at(-1);
			if (method === "qorpera_member_browser_recovery")
				return Response.json({
					memberId: userA.id,
					offices: [{ scope: f.scope, ownsPrivacy: true }],
					nextAfter: null,
				});
			if (method === "qorpera_runtime_office_privacy_status")
				return Response.json({
					scope: f.scope,
					computerGeneration: 2,
					version: leaving ? 4 : 3,
					state: leaving ? "leaving" : "private",
					challenge: leaving ? { ...challenge, state: "leaving", version: 4 } : challenge,
				});
			if (method === "qorpera_request_runtime_office_privacy") {
				const args = JSON.parse(init!.body as string);
				mutations.push(args);
				expect(args).toEqual({
					p_scope: f.scope,
					p_profile_id: f.profile.profileId,
					p_screen_id: id(41),
					p_expected_version: 3,
					p_private: false,
				});
				leaving = true;
				return Response.json({ ...challenge, version: 4, state: "leaving" });
			}
			return normal(input, init);
		});
		click(f.root, "Refresh computers");
		await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
		click(f.root, "Computer 000000000032");
		await vi.waitFor(() => expect(f.root.textContent).toContain("Finish your private sign-in"));
		expect(mutations).toHaveLength(0);
		click(f.root, "Finish your private sign-in");
		await vi.waitFor(() => expect(f.root.textContent).toContain("closure requested"));
		expect(mutations).toHaveLength(1);
		expect(f.root.textContent).not.toContain("Finish your private sign-in");
	});
	it("loads former-company metadata without opening a company and revokes only the displayed consent", async () => {
		const f = await setup();
		expect(f.api.getTeam).not.toHaveBeenCalled();
		click(f.root, "Computer 000000000032");
		await vi.waitFor(() => expect(f.root.textContent).toContain("Revoke browser consent"));
		expect(f.root.textContent).not.toContain("Finish your private sign-in");
		click(f.root, "Revoke browser consent");
		await vi.waitFor(() => expect(f.root.textContent).toContain("Browser consent revoked."));
		expect(f.calls.filter((c) => c.method === "qorpera_set_runtime_browser_grant")).toHaveLength(1);
		expect(f.root.textContent).toContain("No active browser consent.");
	});
	it("rejects consent changed since the displayed observation without issuing a mutation", async () => {
		const f = await setup();
		click(f.root, "Computer 000000000032");
		await vi.waitFor(() => expect(f.root.textContent).toContain("Revoke browser consent"));
		f.changeVersion();
		click(f.root, "Revoke browser consent");
		await vi.waitFor(() => expect(f.root.textContent).toContain("could not be confirmed"));
		expect(f.calls.some((c) => c.method === "qorpera_set_runtime_browser_grant")).toBe(false);
	});
	it("does not replay an uncertain revocation and lets a refresh show the resulting state", async () => {
		const f = await setup(),
			normal = f.fetcher.getMockImplementation()!;
		f.fetcher.mockImplementation(async (input, init) => {
			const response = await normal(input, init);
			if (String(input).endsWith("qorpera_set_runtime_browser_grant")) throw new Error("Lost reply");
			return response;
		});
		click(f.root, "Computer 000000000032");
		await vi.waitFor(() => expect(f.root.textContent).toContain("Revoke browser consent"));
		click(f.root, "Revoke browser consent");
		await vi.waitFor(() => expect(f.root.textContent).toContain("could not be confirmed"));
		expect(f.calls.filter((c) => c.method === "qorpera_set_runtime_browser_grant")).toHaveLength(1);
		click(f.root, "Refresh this computer");
		await vi.waitFor(() => expect(f.root.textContent).toContain("No active browser consent."));
		expect(f.calls.filter((c) => c.method === "qorpera_set_runtime_browser_grant")).toHaveLength(1);
	});
	it.each(["account", "route"])(
		"aborts a pending metadata request and clears the old view on %s change",
		async (change) => {
			const f = await setup(),
				pending = deferred<Response>();
			f.fetcher.mockReturnValueOnce(pending.promise);
			click(f.root, "Computer 000000000032");
			await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
			const requestSignal = f.fetcher.mock.calls[1]![1]!.signal!;
			const oldView = f.root.querySelector(".browser-recovery")!;
			if (change === "account") f.auth(userB);
			else navigate({ name: "account" }, true);
			// Auth store notifications are coalesced into the next microtask.
			await Promise.resolve();
			expect(requestSignal.aborted).toBe(true);
			expect(oldView.isConnected).toBe(false);
			pending.resolve(
				Response.json({
					scope: f.scope,
					memberId: userA.id,
					canUse: false,
					profiles: [f.profile],
					nextAfter: null,
				}),
			);
			await vi.waitFor(() => expect(f.root.textContent).not.toContain("Former company browser"));
			expect(oldView.textContent).toBe("");
		},
	);
	it("rejects a changed token owner before transmitting and offers explicit load recovery", async () => {
		const f = await setup();
		vi.mocked(f.cloud.supabase.auth.getSession).mockResolvedValue({
			data: { session: { user: userB, access_token: "other-token" } },
			error: null,
		} as Awaited<ReturnType<typeof f.cloud.supabase.auth.getSession>>);
		click(f.root, "Refresh computers");
		await vi.waitFor(() => expect(f.root.textContent).toContain("could not be confirmed"));
		expect(f.fetcher).toHaveBeenCalledTimes(1);
	});
	it("links from account settings without requiring current company membership", async () => {
		const f = await setup();
		navigate({ name: "account" }, true);
		await vi.waitFor(() => expect(f.root.querySelector('a[href="#/browser-access"]')).not.toBeNull());
	});
	it("rejects an unsafe control-plane origin before reading auth", () => {
		const f = fixture();
		f.cloud.config.projectUrl = "https://fixture.invalid/other";
		expect(() => webBrowserRecovery(f.cloud, userA.id, new AbortController().signal, () => {})).toThrow(
			"Invalid browser access configuration",
		);
		expect(f.cloud.supabase.auth.getSession).not.toHaveBeenCalled();
	});
});
