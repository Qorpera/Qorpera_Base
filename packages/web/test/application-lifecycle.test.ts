// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { HubController } from "../src/app/views/hub.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedCompanyOrganization } from "../src/cloud/organization.ts";
import type { HostedAccountEntitlement, HostedProfile, StaffSessionHandle } from "../src/cloud/types.ts";
import { deferred, fixture, id, profileA, profileB, session, settle, staff, team, userA, userB } from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	history.replaceState(null, "", "/#/");
	sessionStorage.clear();
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function draw(): Promise<void> {
	await settle();
	await vi.advanceTimersByTimeAsync(60);
}
function mounted(hash = "#/") {
	history.replaceState(null, "", `/${hash}`);
	const f = fixture();
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud, f.api);
	return { ...f, root };
}

describe("account and route ownership", () => {
	it("retries an uncertain product send with the same input identity and preserves its draft", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const send = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({ input_id: id(91), position: 1 }),
		);
		send.mockRejectedValueOnce(new Error("Response lost"));
		vi.stubGlobal("fetch", send);
		await draw();
		const input = f.root.querySelector("textarea")!;
		input.value = "One request";
		input.dispatchEvent(new Event("input"));
		await settle();
		const button = f.root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
		button.click();
		button.click();
		await draw();
		expect(send).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("One request");
		button.click();
		await draw();
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[0]?.[1]?.body).toBe(send.mock.calls[1]?.[1]?.body);
		expect(input.value).toBe("");
	});
	it("submits from the product composer through the authenticated member transport", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const send = vi.fn(async () => Response.json({ input_id: id(91), position: 1 }));
		vi.stubGlobal("fetch", send);
		await draw();
		const input = f.root.querySelector("textarea")!;
		input.value = "Work from the web";
		input.dispatchEvent(new Event("input"));
		await settle();
		f.root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
		await draw();
		expect(send).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("");
		expect(f.root.textContent).toContain("Work from the web");
	});
	it.each(["route", "account"])(
		"does not dispatch a composer write after %s changes during token refresh",
		async (change) => {
			const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
			const send = vi.fn();
			vi.stubGlobal("fetch", send);
			await draw();
			const original = await f.cloud.supabase.auth.getSession();
			const token = deferred<typeof original>();
			vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
			const input = f.root.querySelector("textarea")!;
			input.value = "Private draft";
			input.dispatchEvent(new Event("input"));
			await settle();
			expect(f.root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
			f.root.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
			await settle();
			if (change === "route") history.replaceState(null, "", "/#/account");
			else f.auth(userB);
			token.resolve(original);
			await draw();
			expect(send).not.toHaveBeenCalled();
		},
	);
	it.each([true, false])("waits for organization loading before resolving home (seeded: %s)", async (seeded) => {
		const home = `#/c/${profileA.profileId}`;
		const f = mounted(home);
		const loading = deferred<HostedCompanyOrganization | undefined>();
		vi.mocked(f.api.getOrganization).mockReturnValue(loading.promise);
		await draw();
		expect(f.api.listStaff).toHaveBeenCalled();
		expect(location.hash).toBe(home);
		expect(f.root.querySelector("main")?.textContent).toContain("Opening company");
		loading.resolve(
			seeded
				? {
						schema: "qorpera.company-organization/v1",
						profileId: profileA.profileId,
						cofounder: { staffAgentId: staff.id, formationId: id(30), memberSessionId: session.sessionId },
						formation: {
							formationId: id(30),
							state: "operating",
							status: "active",
							revision: 1,
							projectionStatus: "ready",
							sourcePath: "company/formation.json",
						},
						responsibilities: [],
						projects: [],
					}
				: undefined,
		);
		await draw();
		if (seeded) {
			expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
			expect(f.root.querySelector("textarea")).not.toBeNull();
		} else {
			expect(location.hash).toBe(home);
			expect(f.root.querySelector("main")?.textContent).toContain("This company has no Co-Founder yet");
		}
	});

	it("waits for membership before creating the private Co-Founder conversation", async () => {
		const home = `#/c/${profileA.profileId}`;
		const f = mounted(home);
		const loading = deferred<typeof team>();
		vi.mocked(f.api.getTeam).mockReturnValue(loading.promise);
		vi.mocked(f.api.getOrganization).mockResolvedValue({
			schema: "qorpera.company-organization/v1",
			profileId: profileA.profileId,
			cofounder: { staffAgentId: staff.id, formationId: id(30) },
			formation: {
				formationId: id(30),
				state: "operating",
				status: "active",
				revision: 1,
				projectionStatus: "ready",
				sourcePath: "company/formation.json",
			},
			responsibilities: [],
			projects: [],
		});
		const create = vi.spyOn(f.api, "ensureMemberPrivateStaffSession").mockResolvedValue({
			...session,
			audience: { kind: "member_private", userId: userA.id },
			created: true,
		});
		await draw();
		expect(create).not.toHaveBeenCalled();
		expect(f.root.querySelector("main")?.textContent).toContain("Opening company");
		loading.resolve(team);
		await draw();
		expect(create).toHaveBeenCalledExactlyOnceWith(
			profileA.environmentId,
			staff.id,
			userA.id,
			expect.any(String),
			"Co-Founder",
		);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
	});

	it("waits for membership before resolving a staff route", async () => {
		const route = `#/c/${profileA.profileId}/staff/${staff.id}`;
		const f = mounted(route);
		const loading = deferred<typeof team>();
		vi.mocked(f.api.getTeam).mockReturnValue(loading.promise);
		vi.mocked(f.api.listSessions).mockResolvedValue([]);
		const create = vi.spyOn(f.api, "ensureStaffSession").mockResolvedValue({ ...session, created: true });
		await draw();
		expect(location.hash).toBe(route);
		expect(f.root.querySelector("main")?.textContent).toContain("Opening company");
		loading.resolve(team);
		await draw();
		expect(create).toHaveBeenCalledTimes(1);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
	});

	it("cancels a private confirmation dialog when the account changes", async () => {
		const f = mounted(`#/c/${profileA.profileId}/team`);
		await draw();
		const deleteProfile = vi.spyOn(f.api, "deleteProfile").mockResolvedValue();
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Delete company")!.click();
		expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Company A PRIVATE");
		f.auth(userB);
		await draw();
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
		expect(deleteProfile).not.toHaveBeenCalled();
	});

	it("preserves a team invitation draft through background refreshes", async () => {
		const f = mounted(`#/c/${profileA.profileId}/team`);
		await draw();
		const email = f.root.querySelector<HTMLInputElement>('input[type="email"]')!;
		email.value = "draft@example.invalid";
		email.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		const refreshed = f.root.querySelector<HTMLInputElement>('input[type="email"]')!;
		expect(refreshed.value).toBe("draft@example.invalid");
		expect(document.activeElement).toBe(refreshed);
	});
	it("clears company and invitation state on identity changes and rejects old responses", async () => {
		const { api, auth, root } = mounted();
		await draw();
		expect(root.textContent).toContain("Company A PRIVATE");
		const old = deferred<HostedProfile[]>();
		vi.mocked(api.listProfiles).mockReturnValueOnce(old.promise).mockResolvedValue([profileB]);
		auth(null);
		await draw();
		auth(userA);
		await draw();
		auth(userB);
		await draw();
		expect(root.textContent).toContain("Company B");
		old.resolve([profileA]);
		await draw();
		expect(root.textContent).not.toContain("Company A PRIVATE");
		expect(root.textContent).toContain("Account B");
	});

	it("loads entitlement and friends afresh for the new account", async () => {
		const { api, auth, root } = mounted("#/account");
		await draw();
		expect(root.textContent).toContain("Account A private plan");
		const entitlement: HostedAccountEntitlement = {
			planKey: "Account B plan",
			billingMode: "fixture",
			featureSet: "fixture",
			storageAllocation: "fixture",
			source: "fixture",
		};
		vi.mocked(api.getAccountEntitlement).mockResolvedValue(entitlement);
		vi.mocked(api.listProfiles).mockResolvedValue([profileB]);
		auth(userB);
		await draw();
		expect(root.textContent).toContain("Account B plan");
		expect(root.textContent).not.toContain("Account A private plan");
		location.hash = "#/friends";
		await draw();
		expect(api.listFriends).toHaveBeenCalledTimes(1);
		auth(userA);
		await draw();
		expect(api.listFriends).toHaveBeenCalledTimes(2);
	});

	it("does not navigate after a staff-session request finishes on another page", async () => {
		const { api, root } = mounted();
		const opened = deferred<StaffSessionHandle>();
		vi.mocked(api.listSessions).mockResolvedValue([]);
		vi.spyOn(api, "ensureStaffSession").mockReturnValue(opened.promise);
		await draw();
		location.hash = `#/c/${profileA.profileId}/staff/${staff.id}`;
		await draw();
		expect(api.ensureStaffSession).toHaveBeenCalledTimes(1);
		location.hash = "#/account";
		await draw();
		opened.resolve({
			sessionId: session.sessionId,
			clientSessionId: session.clientSessionId,
			environmentId: session.environmentId,
			title: session.title,
			audience: session.audience,
			created: true,
			createdByUserId: userA.id,
			createdAt: session.createdAt,
		});
		await draw();
		expect(location.hash).toBe("#/account");
		expect(root.textContent).toContain("Plan & billing");
	});

	it("ignores a late company lookup after navigating away", async () => {
		const f = mounted();
		await draw();
		const profiles = deferred<HostedProfile[]>();
		vi.mocked(f.api.listProfiles).mockReturnValue(profiles.promise);
		location.hash = `#/c/${profileB.profileId}/file`;
		await draw();
		location.hash = "#/friends";
		await draw();
		profiles.resolve([profileB]);
		await draw();
		expect(location.hash).toBe("#/friends");
		expect(f.api.getCompanyFile).not.toHaveBeenCalled();
		expect(f.root.querySelector("main")?.textContent).toContain("Friends");
	});

	it("initializes Company File once while its response is delayed", async () => {
		const f = mounted(`#/c/${profileA.profileId}/file`);
		const loading = deferred<Awaited<ReturnType<typeof f.api.getCompanyFile>>>();
		vi.mocked(f.api.getCompanyFile).mockReturnValue(loading.promise);
		await draw();
		await vi.advanceTimersByTimeAsync(180);
		expect(f.api.getCompanyFile).toHaveBeenCalledTimes(1);
	});

	it("toggles and closes company navigation without replacing the composer", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		const composer = f.root.querySelector("textarea");
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await draw();
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector("main .mobile-navigation-toggle"));
		expect(f.root.querySelector("textarea")).toBe(composer);
	});

	it("keeps profile-menu focus through refreshes and closes it before the mobile drawer", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		const teamLink = '.account-popover [data-account-action="settings"]';
		f.root.querySelector<HTMLAnchorElement>(teamLink)!.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector<HTMLElement>(".account-popover")!.hidden).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector(teamLink));
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await draw();
		expect(f.root.querySelector<HTMLElement>(".account-popover")!.hidden).toBe(true);
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(true);
		expect(document.activeElement).toBe(f.root.querySelector(".rail .account-trigger"));
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await draw();
		expect(f.root.querySelector("main")?.inert).toBe(false);
		expect(document.activeElement).toBe(f.root.querySelector("main .mobile-navigation-toggle"));
	});

	it("keeps company navigation and sign out available when the profile moves between rail and account pages", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const signOut = vi.spyOn(AuthController.prototype, "signOut").mockImplementation(async () => f.auth(null));
		await draw();
		expect(f.root.querySelector(".topbar .account-trigger")).toBeNull();
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		expect(f.root.querySelector('.account-popover a[href$="/team"]')).toBeNull();
		f.root.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
		f.root.querySelector<HTMLButtonElement>("#settings-tab-company")!.click();
		await draw();
		expect(f.root.querySelector(".settings-dialog")?.textContent).toContain("Delete company");
		f.root.querySelector<HTMLButtonElement>(".settings-close")!.click();
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		f.root.querySelector<HTMLAnchorElement>('.account-popover a[href="#/friends"]')!.click();
		await draw();
		expect(f.api.listFriends).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".topbar .account-trigger")?.textContent).toContain("Account A");
		expect(f.root.querySelector(".account-company-name")).toBeNull();
		location.hash = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
		await draw();
		expect(f.root.querySelectorAll(".account-trigger")).toHaveLength(1);
		f.root.querySelector<HTMLButtonElement>(".rail .account-trigger")!.click();
		f.root.querySelector<HTMLButtonElement>(".account-signout")!.click();
		await draw();
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(f.root.querySelector(".account-trigger")).toBeNull();
		expect(f.root.textContent).not.toContain(profileA.profileName);
	});

	it("restores access to the page when membership is revoked with the mobile drawer open", async () => {
		const f = mounted(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		await draw();
		f.root.querySelector<HTMLButtonElement>("main .mobile-navigation-toggle")!.click();
		await draw();
		expect(f.root.querySelector("main")?.inert).toBe(true);
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector("main")?.textContent).toContain("Your access to this company was revoked");
		expect(f.root.querySelector("main")?.inert).toBe(false);
		expect(f.root.querySelector(".frame")?.classList.contains("navigation-open")).toBe(false);
		expect(f.root.querySelector(".topbar .account-trigger")).not.toBeNull();
		expect(f.root.querySelector(".account-company-name")).toBeNull();
	});

	it("keeps rail searches bound to the current company and current route", () => {
		const f = fixture();
		const a = new CompanyController(f.api, profileA, userA.id),
			b = new CompanyController(f.api, profileB, userA.id);
		dispose = () => {
			a.stop();
			b.stop();
		};
		for (const controller of [a, b]) controller.store.set({ team, sessions: [session], loading: false });
		const rail = document.createElement("aside");
		const context = {
			profiles: [profileA, profileB],
			user: userA,
			auth: new AuthController(f.cloud),
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
		};
		renderRail(rail, a, { ...context, route: { name: "company", profileId: profileA.profileId, section: "file" } });
		renderRail(rail, b, { ...context, route: { name: "company", profileId: profileB.profileId, section: "file" } });
		renderRail(rail, b, { ...context, route: { name: "company", profileId: profileB.profileId, section: "team" } });
		const search = rail.querySelector("input")!;
		search.value = "Fixture";
		search.dispatchEvent(new Event("input"));
		expect(rail.querySelector(".account-trigger")?.textContent).toContain("Account A");
		expect(rail.textContent).not.toContain("Company A PRIVATE");
		expect(rail.querySelector('a[href$="/team"]')).toBeNull();
	});

	it("retains creation idempotency across an ambiguous failure and controller restart", async () => {
		const f = fixture();
		const create = vi.spyOn(f.api, "createCompany").mockRejectedValue(new Error("Response lost"));
		let hub = new HubController(f.api, userA.id);
		await hub.createCompany("One company");
		hub.dispose();
		hub = new HubController(f.api, userA.id);
		expect(hub.store.get().creationRetry?.name).toBe("One company");
		await hub.createCompany("One company");
		expect(create.mock.calls[0]?.[0]).toBe(create.mock.calls[1]?.[0]);
		expect(new HubController(f.api, userB.id).store.get().creationRetry).toBeUndefined();
		hub.dispose();
	});
});
