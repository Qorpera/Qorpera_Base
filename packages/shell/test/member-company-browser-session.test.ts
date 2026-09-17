import { CloudCompanyComputerBrowserProfiles } from "@qorpera/cloud-client/cloud-company-computer-browser-profiles";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import { CloudCompanyComputerSignIn } from "@qorpera/cloud-client/cloud-company-computer-sign-in";
import type { CompanyComputerMemberStatus } from "@qorpera/cloud-client/cloud-company-computer-views";
import { describe, expect, it, vi } from "vitest";
import { MemberCompanyBrowserSession } from "../src/member-company-browser-session.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) },
		memberId = id(5);
	const profile = { profileId: id(6), label: "Work", version: 2, prepared: true, activeStaffAgentId: id(7) };
	const binding = {
		...scope,
		computerGeneration: 1,
		screenId: id(8),
		screenOrdinal: 1,
		screenGeneration: 1,
		staffAgentId: id(7),
	};
	const challenge: CompanyComputerPrivacyChallenge = {
		scope,
		computerGeneration: 1,
		challengeId: id(9),
		version: 1,
		state: "entering",
		memberId,
		profileId: profile.profileId,
		profileVersion: 3,
		screenId: binding.screenId,
		drains: [{ state: "draining", drainId: id(10), epoch: 2, binding }],
	};
	const state = {
		current: true,
		canUse: true,
		privacy: "shared",
		version: 0,
		challenge: null as CompanyComputerPrivacyChallenge | null,
		lose: false,
		grantVersion: 1,
	};
	const rpc = vi.fn(async (method: string, args: Record<string, unknown>) => {
		if (method === "qorpera_member_browser_profiles")
			return { data: { scope, memberId, canUse: state.canUse, profiles: [profile], nextAfter: null }, error: null };
		if (method === "qorpera_runtime_office_privacy_status")
			return {
				data: {
					scope,
					computerGeneration: 1,
					state: state.privacy,
					version: state.version,
					challenge: state.challenge,
				},
				error: null,
			};
		if (method === "qorpera_member_browser_grant_status")
			return {
				data: {
					scope,
					memberId,
					staffAgentId: args.p_staff_agent_id,
					profile,
					grant: {
						grantId: id(11),
						version: state.grantVersion,
						profileVersion: 2,
						state: "active",
						usable: state.canUse,
					},
				},
				error: null,
			};
		if (method === "qorpera_check_runtime_office_private_access")
			return { data: { state: "authorized", validForMs: 5000, version: state.version }, error: null };
		if (state.lose) throw new Error("fixture lost reply");
		if (method === "qorpera_create_member_browser_profile")
			return { data: { ...profile, profileId: args.p_profile_id, label: args.p_label }, error: null };
		if (method === "qorpera_request_runtime_office_privacy")
			return {
				data: {
					...challenge,
					version: Number(args.p_expected_version) + 1,
					state: args.p_private ? "entering" : "leaving",
				},
				error: null,
			};
		if (method === "qorpera_set_runtime_browser_grant")
			return {
				data: {
					profileId: profile.profileId,
					grantId: id(11),
					version: Number(args.p_expected_version) + 1,
					state: args.p_enabled ? "active" : "revoked",
					drains: [],
				},
				error: null,
			};
		throw new Error("Unexpected RPC");
	});
	const abort = new AbortController();
	const session = new MemberCompanyBrowserSession({
		profiles: new CloudCompanyComputerBrowserProfiles({ scope, memberId, rpc }),
		signIn: new CloudCompanyComputerSignIn({ scope, memberId, rpc }),
		current: () => {
			if (!state.current) throw new Error("Account changed");
		},
		signal: abort.signal,
	});
	const context = {
		staffIds: [id(7)],
		viewingAvailable: true,
		screens: {
			scope,
			computerGeneration: 1,
			state: "active",
			maintenance: null,
			privacyState: "shared",
			privacyVersion: 0,
			screens: [{ binding, epoch: 1, drainPending: false, driver: "agent", takeoverMemberId: null }],
			viewers: [],
		} as CompanyComputerMemberStatus,
	};
	const action = (input: unknown) => session.action(input, context);
	const refresh = async () => {
		await action({ method: "profiles", after: null });
		await action({ method: "privacy" });
	};
	const configure = {
		method: "configureBrowser",
		profileId: profile.profileId,
		profileVersion: 2,
		staffAgentId: id(7),
		expectedVersion: 1,
		enabled: true,
	};
	return {
		scope,
		memberId,
		profile,
		binding,
		challenge,
		state,
		rpc,
		abort,
		session,
		context,
		action,
		refresh,
		configure,
	};
}
describe("member browser session", () => {
	it("rejects undiscovered and extra-field actions before contacting authority", async () => {
		const f = fixture();
		for (const input of [
			{ method: "profiles", after: id(9) },
			{ method: "profiles", after: null, password: "secret" },
			{ method: "browserGrant", profileId: id(6), staffAgentId: id(7) },
			f.configure,
			{ method: "finishPrivate" },
		])
			await expect(f.action(input)).rejects.toThrow();
		expect(f.rpc).not.toHaveBeenCalled();
	});
	it("invalid names cannot poison creation and uncertain creation keeps one explicit retry identity", async () => {
		const f = fixture();
		await f.refresh();
		for (const label of ["", " ", " padded", "control\n", "x".repeat(81)])
			await expect(f.action({ method: "registerProfile", label })).rejects.toThrow();
		f.state.lose = true;
		await expect(f.action({ method: "registerProfile", label: "Work 2" })).rejects.toThrow();
		await expect(f.action({ method: "registerProfile", label: "Work 3" })).rejects.toThrow();
		await f.refresh();
		f.state.lose = false;
		await f.action({ method: "retryProfile" });
		const registrations = f.rpc.mock.calls.filter(([method]) => method === "qorpera_create_member_browser_profile");
		expect(registrations).toHaveLength(2);
		expect(registrations[1][1]).toEqual(registrations[0][1]);
	});
	it("requires exact observed consent and refresh after an uncertain mutation", async () => {
		const f = fixture();
		await f.refresh();
		await f.action({ method: "browserGrant", profileId: id(6), staffAgentId: id(7) });
		await expect(f.action({ ...f.configure, expectedVersion: 0 })).rejects.toThrow();
		f.state.lose = true;
		await expect(f.action(f.configure)).rejects.toThrow();
		await expect(f.action(f.configure)).rejects.toThrow();
		expect(f.rpc.mock.calls.filter(([method]) => method === "qorpera_set_runtime_browser_grant")).toHaveLength(1);
	});
	it("allows cleanup of a retired agent's consent after removal without enabling it", async () => {
		const f = fixture();
		f.state.canUse = false;
		f.context.staffIds = [];
		await f.refresh();
		await f.action({ method: "browserGrant", profileId: id(6), staffAgentId: id(7) });
		await expect(f.action(f.configure)).rejects.toThrow();
		await f.action({ ...f.configure, enabled: false });
		expect(f.rpc.mock.calls.at(-1)?.[1].p_enabled).toBe(false);
	});
	it("requires the observed shared privacy version and configured viewing before entry", async () => {
		const f = fixture();
		await f.refresh();
		const input = { method: "beginPrivate", profileId: id(6), screenId: id(8) };
		f.context.viewingAvailable = false;
		await expect(f.action(input)).rejects.toThrow();
		f.context.viewingAvailable = true;
		f.context.screens.privacyVersion = 1;
		await expect(f.action(input)).rejects.toThrow();
		f.context.screens.privacyVersion = 0;
		await f.action(input);
		await expect(f.action(input)).rejects.toThrow();
		expect(f.rpc.mock.calls.filter(([method]) => method === "qorpera_request_runtime_office_privacy")).toHaveLength(
			1,
		);
	});
	it("never replays an uncertain entry or finishes automatically on close", async () => {
		const f = fixture();
		await f.refresh();
		f.state.lose = true;
		const input = { method: "beginPrivate", profileId: id(6), screenId: id(8) };
		await expect(f.action(input)).rejects.toThrow();
		await expect(f.action(input)).rejects.toThrow();
		f.abort.abort();
		await expect(f.action({ method: "finishPrivate" })).rejects.toThrow();
		expect(f.rpc.mock.calls.filter(([method]) => method === "qorpera_request_runtime_office_privacy")).toHaveLength(
			1,
		);
	});
	it("checks fresh owner authority for each private reconnect", async () => {
		const f = fixture();
		f.state.privacy = "private";
		f.state.version = 1;
		f.state.challenge = f.challenge;
		await f.refresh();
		await expect(f.session.privateChallenge(id(99), f.abort.signal)).rejects.toThrow();
		expect(await f.session.privateChallenge(id(9), f.abort.signal)).toEqual(f.challenge);
		f.state.privacy = "leaving";
		f.state.version = 2;
		f.state.challenge = { ...f.challenge, state: "leaving", version: 2 };
		await expect(f.session.privateChallenge(id(9), f.abort.signal)).rejects.toThrow();
		expect(
			f.rpc.mock.calls.filter(([method]) => method === "qorpera_check_runtime_office_private_access"),
		).toHaveLength(1);
	});
	it("allows explicit exit after membership removal and requires refresh before repeating", async () => {
		const f = fixture();
		f.state.canUse = false;
		f.state.privacy = "private";
		f.state.version = 1;
		f.state.challenge = f.challenge;
		await f.refresh();
		await f.action({ method: "finishPrivate" });
		await expect(f.action({ method: "finishPrivate" })).rejects.toThrow();
		expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
			p_profile_id: id(6),
			p_screen_id: id(8),
			p_expected_version: 1,
			p_private: false,
		});
	});
	it("fences the host account and signal before requesting metadata", async () => {
		const f = fixture();
		f.state.current = false;
		await expect(f.refresh()).rejects.toThrow();
		f.state.current = true;
		f.abort.abort();
		await expect(f.refresh()).rejects.toThrow();
		expect(f.rpc).not.toHaveBeenCalled();
	});
});
