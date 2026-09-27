// @vitest-environment jsdom
import { REALTIME_SUBSCRIBE_STATES, RealtimeClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { HubController } from "../src/app/views/hub.ts";
import { SettingsView } from "../src/app/views/settings.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedAccountEntitlement, HostedAccountMatch } from "../src/cloud/types.ts";
import { setTimeZonePreference } from "../src/ui/preferences.ts";
import {
	deferred,
	file,
	fixture,
	id,
	profileA,
	profileB,
	session,
	settle,
	team,
	timestamp,
	userA,
	userB,
} from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function draw() {
	await settle();
	await vi.advanceTimersByTimeAsync(60);
}
async function setup(f = fixture()) {
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud, f.api);
	await draw();
	return { ...f, root };
}
function click(root: Element, selector: string) {
	root.querySelector<HTMLButtonElement>(selector)!.click();
}
function open(root: Element) {
	click(root, ".account-trigger");
	click(root, '[data-account-action="settings"]');
}

function confirmCompanyRemoval(root: Element, deleting: boolean, profile = profileA) {
	expect(root.querySelector(".company-exit")?.textContent).toBe(deleting ? "Delete company" : "Leave company");
	click(root, ".company-exit");
	const dialog = document.querySelector('[role="alertdialog"]')!;
	if (deleting) {
		const input = dialog.querySelector("input")!;
		input.value = profile.profileName;
		input.dispatchEvent(new Event("input"));
	}
	[...dialog.querySelectorAll("button")]
		.find((button) => button.textContent === (deleting ? "Delete company" : "Leave"))!
		.click();
}

function realtimeFixture() {
	const f = fixture();
	const realtime = new RealtimeClient("wss://fixture.invalid/realtime/v1", { params: { apikey: "fixture" } });
	vi.mocked(f.api.listProfiles).mockResolvedValue([profileA, profileB]);
	vi.mocked(f.cloud.supabase.channel).mockImplementation((topic) => {
		// Exercise the installed SDK's topic reuse without opening a socket.
		const channel = realtime.channel(topic);
		vi.spyOn(channel, "subscribe").mockReturnValue(channel);
		return channel;
	});
	// The fixture deliberately leaves removed channels registered, as the SDK
	// does while an asynchronous unsubscribe is waiting for its response.
	return f;
}

describe("settings session lifecycle", () => {
	it.each([[profileA], [profileA, profileB]])(
		"updates open settings after the initial company list arrives: %j",
		async (...profiles) => {
			history.replaceState(null, "", "/#/");
			const fixtureState = fixture(),
				pending = deferred<typeof profiles>();
			vi.mocked(fixtureState.api.listProfiles).mockReturnValue(pending.promise);
			const f = await setup(fixtureState);
			open(f.root);
			click(f.root, "#settings-tab-company");
			const content = () => f.root.querySelector("#settings-content")!;
			expect(content().textContent).toContain("Open a company to see these settings.");
			pending.resolve(profiles);
			await draw();
			if (profiles.length > 1) {
				// Several companies: the member opens one from the list first.
				expect(content().textContent).toContain("Open a company to see these settings.");
				expect(content().querySelector("a[href$='/file']")).toBeNull();
				expect(f.api.getTeam).not.toHaveBeenCalled();
			} else {
				// The Company tab has no heading of its own.
				expect(content().querySelector("h1")).toBeNull();
				expect(content().querySelector(`a[href='#/c/${profileA.profileId}/file']`)).not.toBeNull();
			}
			// On the company list itself the rail needs no way back to it.
			expect(f.root.querySelector<HTMLElement>(".settings-back")!.hidden).toBe(true);
			expect(f.cloud.rpc).not.toHaveBeenCalled();
		},
	);
	it("preserves the selected company and focus when the profile list refreshes", async () => {
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const company = new CompanyController(f.api, profileA, userA.id);
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA],
			company,
			() => {},
			() => {},
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			company.stop();
			auth.dispose();
		};
		const content = view.el.querySelector<HTMLElement>("#settings-content")!;
		content.focus();
		view.updateProfiles([{ ...profileA }, profileB]);
		expect(view.el.querySelector("#settings-content")).toBe(content);
		expect(document.activeElement).toBe(content);
		expect(f.api.getTeam).not.toHaveBeenCalled();
		expect(company.signal.aborted).toBe(false);
	});
	it("shows only the open company, and returns to it unstarted when it is listed again", async () => {
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const company = new CompanyController(f.api, profileA, userA.id);
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA, profileB],
			company,
			() => {},
			() => {},
			"company",
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			company.stop();
			auth.dispose();
		};
		// The Company tab has no heading of its own: its Company File link names the company.
		const shown = () => view.el.querySelector("#settings-content a[href$='/file']")?.getAttribute("href");
		expect(shown()).toBe(`#/c/${profileA.profileId}/file`);
		expect(view.el.querySelector("#settings-content h1")).toBeNull();
		// Settings over a company never show another one, however often the list repeats.
		view.updateProfiles([profileB]);
		view.updateProfiles([{ ...profileB }]);
		expect(view.el.querySelector("#settings-content")!.textContent).toContain(
			"Open a company to see these settings.",
		);
		expect(shown()).toBeUndefined();
		expect(f.api.getTeam).not.toHaveBeenCalled();
		view.updateProfiles([profileA, profileB]);
		await settle();
		expect(shown()).toBe(`#/c/${profileA.profileId}/file`);
		// The open company is borrowed again: Settings neither start nor stop it.
		expect(f.api.getTeam).not.toHaveBeenCalled();
		expect(company.signal.aborted).toBe(false);
	});
	it("shows the account's only company when Settings are not over a company", async () => {
		history.replaceState(null, "", "/#/");
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileA, profileB],
			undefined,
			() => {},
			() => {},
			"company",
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			auth.dispose();
		};
		expect(view.el.querySelector("#settings-content")!.textContent).toContain(
			"Open a company to see these settings.",
		);
		const shown = () => view.el.querySelector("#settings-content a[href$='/file']")?.getAttribute("href");
		expect(shown()).toBeUndefined();
		view.updateProfiles([profileB]);
		await settle();
		expect(shown()).toBe(`#/c/${profileB.profileId}/file`);
		expect(view.el.querySelector("#settings-content h1")).toBeNull();
		// A company joins: the one shown stays.
		view.updateProfiles([profileA, profileB]);
		await settle();
		expect(shown()).toBe(`#/c/${profileB.profileId}/file`);
		// The company shown is removed: the one left is shown.
		view.updateProfiles([profileA]);
		await settle();
		expect(shown()).toBe(`#/c/${profileA.profileId}/file`);
	});
	it("shows no other company on a company page that has none to lend", async () => {
		// A company page without its company: access lost, or not available.
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const hub = new HubController(f.api);
		const view = new SettingsView(
			f.api,
			auth,
			hub,
			[profileB],
			undefined,
			() => {},
			() => {},
			"company",
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			hub.dispose();
			auth.dispose();
		};
		view.updateProfiles([{ ...profileB }]);
		await settle();
		expect(view.el.querySelector("#settings-content")!.textContent).toContain(
			"Open a company to see these settings.",
		);
		expect(view.el.querySelector<HTMLElement>(".settings-back")!.hidden).toBe(false);
		expect(f.api.getTeam).not.toHaveBeenCalled();
	});
	it("stays open on the revoked-access page and does not restart the revoked company", async () => {
		const f = await setup();
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector("main")?.textContent).toContain("Your access to this company was revoked");
		const teams = vi.mocked(f.api.getTeam).mock.calls.length;
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		await vi.advanceTimersByTimeAsync(5000);
		// The revoked company is still listed; Settings used to start it again,
		// fail at once and close themselves.
		expect(f.root.querySelector(".settings-overlay")).not.toBeNull();
		expect(f.root.querySelector("#settings-content")!.textContent).toContain("Open a company to see these settings.");
		expect(vi.mocked(f.api.getTeam).mock.calls.length).toBe(teams);
	});
	it("ends the rail with a way back to the company list, not a company picker", async () => {
		const f = await setup();
		open(f.root);
		await draw();
		const nav = f.root.querySelector(".settings-nav")!;
		expect(nav.querySelector("select")).toBeNull();
		const back = nav.querySelector<HTMLAnchorElement>(".settings-back")!;
		expect(nav.lastElementChild).toBe(back);
		expect(back.hidden).toBe(false);
		expect(back.getAttribute("href")).toBe("#/");
		expect(back.textContent).toBe("Back to companies");
		expect(back.querySelector("svg.icon")).not.toBeNull();
		back.click();
		await draw();
		expect(location.hash).toBe("#/");
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		expect(f.root.querySelector(".company-card[href]")).not.toBeNull();
		// The company list itself needs no way back.
		open(f.root);
		expect(f.root.querySelector<HTMLElement>(".settings-back")!.hidden).toBe(true);
	});
	it("opens all seven tabs over the same conversation and restores the profile button", async () => {
		const f = await setup(),
			composer = f.root.querySelector<HTMLTextAreaElement>("textarea")!;
		composer.value = "Keep my conversation draft";
		composer.dispatchEvent(new Event("input", { bubbles: true }));
		open(f.root);
		await draw();
		expect([...f.root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
			"General",
			"Appearance",
			"Company",
			"Friends",
			"Plan & usage",
			"Connections",
			"Rules",
		]);
		for (const tab of f.root.querySelectorAll('[role="tab"]')) expect(tab.querySelector("svg.icon")).not.toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
		click(f.root, "#settings-tab-company");
		expect(f.root.querySelector('.settings-dialog a[href$="/file"]')).not.toBeNull();
		// No company execution controls, and no Organization or Approvals pages to link to.
		expect(
			f.root.querySelector(
				'.settings-dialog :is(.company-execution, .settings-execution, a[href$="/organization"], a[href$="/approvals"])',
			),
		).toBeNull();
		expect(f.root.querySelector(".settings-dialog")?.textContent).not.toMatch(
			/Company execution|Organization|Approvals/,
		);
		expect(f.root.querySelector('.account-popover a[href$="/file"]')).toBeNull();
		click(f.root, ".settings-close");
		expect(f.root.querySelector(".settings-dialog")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		expect(f.root.querySelector("textarea")).toBe(composer);
		expect(composer.value).toBe("Keep my conversation draft");
		expect(document.activeElement).toBe(f.root.querySelector(".account-trigger"));
	});
	it("filters tabs, navigates by keyboard, and keeps an invitation picker open on refresh", async () => {
		const f = await setup();
		open(f.root);
		await draw();
		const search = f.root.querySelector<HTMLInputElement>(".settings-nav input")!;
		search.value = "time zone";
		search.dispatchEvent(new Event("input"));
		const shownTabs = [...f.root.querySelectorAll<HTMLElement>(".settings-nav [role=tab]")].filter(
			(tab) => !tab.hidden,
		);
		expect(shownTabs.map((tab) => tab.id)).toEqual(["settings-tab-general"]);
		search.value = "team";
		search.dispatchEvent(new Event("input"));
		expect(f.root.querySelector("#settings-tab-company")?.getAttribute("aria-selected")).toBe("true");
		const picker = f.root.querySelector<HTMLDetailsElement>(".company-invite")!;
		picker.open = true;
		const role = f.root.querySelector<HTMLSelectElement>('[data-draft="invite-role"]')!;
		role.value = "viewer";
		role.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector<HTMLDetailsElement>(".company-invite")!.open).toBe(true);
		expect(f.root.querySelector<HTMLSelectElement>('[data-draft="invite-role"]')!.value).toBe("viewer");
		expect(document.activeElement).toBe(f.root.querySelector('[data-draft="invite-role"]'));
		// Each word matches on its own, so the button's own label finds its tab.
		search.value = "Delete company";
		search.dispatchEvent(new Event("input"));
		expect(
			[...f.root.querySelectorAll<HTMLElement>(".settings-nav [role=tab]")]
				.filter((tab) => !tab.hidden)
				.map((tab) => tab.id),
		).toEqual(["settings-tab-company"]);
		const exit = f.root.querySelector<HTMLButtonElement>(".company-exit")!;
		exit.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector(".company-exit")).not.toBe(exit);
		expect(document.activeElement).toBe(f.root.querySelector(".company-exit"));
		search.value = "";
		search.dispatchEvent(new Event("input"));
		click(f.root, "#settings-tab-general");
		f.root
			.querySelector("#settings-tab-general")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(f.root.querySelector("#settings-tab-appearance"));
	});
	it("selects the top matching tab when a search hides the open one", async () => {
		const f = await setup();
		open(f.root);
		await draw();
		const search = f.root.querySelector<HTMLInputElement>(".settings-nav input")!;
		// Company lists the invitations it sent, Friends the ones waiting for this account.
		search.value = "invitations";
		search.dispatchEvent(new Event("input"));
		const shown = [...f.root.querySelectorAll<HTMLElement>('[role="tab"]')].filter((tab) => !tab.hidden);
		expect(shown.map((tab) => tab.id)).toEqual(["settings-tab-company", "settings-tab-friends"]);
		expect(f.root.querySelector("#settings-tab-company")?.getAttribute("aria-selected")).toBe("true");
	});
	it("accepts a company invitation from the Friends tab and opens that company", async () => {
		const fixtureState = fixture();
		const invitation = {
			id: id(43),
			profileId: profileB.profileId,
			environmentId: profileB.environmentId,
			profileName: profileB.profileName,
			environmentName: profileB.environmentName,
			email: userA.email!,
			role: "contributor" as const,
			invitedByUserId: userB.id,
			createdAt: timestamp,
			expiresAt: "2099-01-01T00:00:00Z",
		};
		vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([invitation]);
		const accept = vi.spyOn(fixtureState.api, "acceptInvitation").mockImplementation(async () => {
			vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([]);
			vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		});
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-friends");
		expect(f.root.querySelector("#settings-tab-friends .settings-tab-count")?.textContent).toBe("1");
		const row = f.root.querySelector(".settings-dialog .person-row")!;
		expect(row.textContent).toContain(profileB.profileName);
		// The expiry sits in the second line, which stays visible on phones.
		expect(row.querySelector(".person-copy > span")?.textContent).toMatch(/^Invited as contributor · expires \S/);
		expect(row.querySelector(".person-meta")).toBeNull();
		[...row.querySelectorAll("button")].find((button) => button.textContent === "Accept")!.click();
		await draw();
		expect(accept).toHaveBeenCalledExactlyOnceWith(invitation.id);
		expect(location.hash).toBe(`#/c/${profileB.profileId}`);
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
	});
	it("declines a company invitation without leaving settings", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([
			{
				id: id(43),
				profileId: profileB.profileId,
				environmentId: profileB.environmentId,
				profileName: profileB.profileName,
				environmentName: profileB.environmentName,
				email: userA.email!,
				role: "viewer",
				invitedByUserId: userB.id,
				createdAt: timestamp,
				expiresAt: "2099-01-01T00:00:00Z",
			},
		]);
		const decline = vi.spyOn(fixtureState.api, "declineInvitation").mockImplementation(async () => {
			vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([]);
		});
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-friends");
		[...f.root.querySelectorAll<HTMLButtonElement>(".settings-dialog .person-row button")]
			.find((button) => button.textContent === "Decline")!
			.click();
		await draw();
		expect(decline).toHaveBeenCalledExactlyOnceWith(id(43));
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(f.root.querySelector("#settings-tab-friends")?.getAttribute("aria-selected")).toBe("true");
		expect(f.root.querySelector<HTMLElement>("#settings-tab-friends .settings-tab-count")!.hidden).toBe(true);
		expect(f.root.querySelector(".settings-dialog")?.textContent).not.toContain(profileB.profileName);
	});
	it("sends a friend request only to an address an account holds", async () => {
		const f = await setup();
		const send = vi.spyOn(f.api, "sendFriendRequest").mockResolvedValue();
		const find = vi
			.mocked(f.api.findAccountByEmail)
			.mockImplementation(async (email) =>
				email === "new@example.invalid" ? { userId: id(45), email, displayName: "New Person", self: false } : null,
			);
		open(f.root);
		click(f.root, "#settings-tab-friends");
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".panel-search input")!,
			submit = f.root.querySelector<HTMLButtonElement>('.panel-search button[type="submit"]')!,
			panel = () => f.root.querySelector(".settings-dialog .panel")!,
			names = () => [...panel().querySelectorAll(".person-row strong")].map((name) => name.textContent),
			typeIn = async (value: string) => {
				field.value = value;
				field.dispatchEvent(new Event("input"));
				await draw();
			};
		// A whole address no account holds finds nobody, and no request can go to it.
		await typeIn("nobody@example.invalid");
		expect(panel().querySelector(".skeleton-list")).not.toBeNull();
		expect(submit.disabled).toBe(true);
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledExactlyOnceWith("nobody@example.invalid");
		expect(panel().querySelector(".skeleton-list")).toBeNull();
		expect(panel().textContent).toContain("No Qorpera account uses nobody@example.invalid.");
		expect(names()).toEqual([]);
		expect(submit.disabled).toBe(true);
		field.form!.dispatchEvent(new Event("submit", { cancelable: true }));
		await draw();
		expect(send).not.toHaveBeenCalled();
		// An address still being typed is not looked up; the one typing stops at is.
		await typeIn("new@example.inv");
		await typeIn("New@Example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledTimes(2);
		expect(find).toHaveBeenLastCalledWith("new@example.invalid");
		expect(names()).toEqual(["New Person"]);
		expect(panel().textContent).toContain("Add a friend");
		expect(submit.disabled).toBe(false);
		submit.click();
		await draw();
		expect(send).toHaveBeenCalledExactlyOnceWith("new@example.invalid");
		expect(f.api.listFriends).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector("#settings-content")?.textContent).toContain("Request sent to new@example.invalid.");
		expect(field.value).toBe("");
		expect(names()).toEqual([]);
		// An address already answered is not asked again, until "no account" may have changed.
		await typeIn("nobody@example.invalid");
		expect(panel().textContent).toContain("No Qorpera account uses nobody@example.invalid.");
		expect(find).toHaveBeenCalledTimes(2);
		await typeIn("");
		await vi.advanceTimersByTimeAsync(60_000);
		await typeIn("nobody@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledTimes(3);
		expect(panel().textContent).toContain("No Qorpera account uses nobody@example.invalid.");
	});
	it("shows only the answer for the address the field holds now, and says when it is your own", async () => {
		const f = await setup();
		const slow = deferred<HostedAccountMatch | null>();
		const find = vi
			.mocked(f.api.findAccountByEmail)
			.mockImplementation((email) =>
				email === "slow@example.invalid"
					? slow.promise
					: Promise.resolve({ userId: userA.id, email, displayName: "Me", self: true }),
			);
		open(f.root);
		click(f.root, "#settings-tab-friends");
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".panel-search input")!,
			submit = f.root.querySelector<HTMLButtonElement>('.panel-search button[type="submit"]')!,
			panel = () => f.root.querySelector(".settings-dialog .panel")!,
			names = () => [...panel().querySelectorAll(".person-row strong")].map((name) => name.textContent),
			typeIn = async (value: string) => {
				field.value = value;
				field.dispatchEvent(new Event("input"));
				await draw();
			};
		await typeIn("slow@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		await typeIn("me@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(panel().textContent).toContain("That is your own address.");
		expect(submit.disabled).toBe(true);
		// Typed again while its answer is on the way, an address waits for that answer instead of asking twice.
		await typeIn("slow@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(panel().querySelector(".skeleton-list")).not.toBeNull();
		await typeIn("me@example.invalid");
		expect(find).toHaveBeenCalledTimes(2);
		// The first address's answer arrives late: the field has moved on.
		slow.resolve({ userId: id(46), email: "slow@example.invalid", displayName: "Slow", self: false });
		await draw();
		expect(names()).toEqual([]);
		expect(panel().textContent).toContain("That is your own address.");
		// It was kept, so that address shows its account at once.
		await typeIn("slow@example.invalid");
		expect(names()).toEqual(["Slow"]);
		expect(submit.disabled).toBe(false);
		expect(find).toHaveBeenCalledTimes(2);
	});
	it("asks again after a failed lookup, and lets any address through on a cloud without the lookup", async () => {
		const f = await setup();
		const send = vi.spyOn(f.api, "sendFriendRequest").mockResolvedValue();
		const find = vi.mocked(f.api.findAccountByEmail).mockRejectedValueOnce(new Error("The network is down."));
		open(f.root);
		click(f.root, "#settings-tab-friends");
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".panel-search input")!,
			submit = f.root.querySelector<HTMLButtonElement>('.panel-search button[type="submit"]')!,
			panel = () => f.root.querySelector(".settings-dialog .panel")!,
			typeIn = async (value: string) => {
				field.value = value;
				field.dispatchEvent(new Event("input"));
				await draw();
			};
		await typeIn("new@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(panel().textContent).toContain("The network is down.");
		expect(submit.disabled).toBe(true);
		// Until the release that adds the lookup is live, the cloud refuses an address no account holds.
		find.mockRejectedValue(
			new CloudRpcError("qorpera_find_account_by_email", { message: "missing", code: "PGRST202" }, 404),
		);
		[...panel().querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click();
		await draw();
		expect(find).toHaveBeenCalledTimes(2);
		expect(panel().textContent).toContain("Nobody here by that address. Send new@example.invalid a friend request.");
		expect(submit.disabled).toBe(false);
		await typeIn("other@example.invalid");
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledTimes(2);
		expect(submit.disabled).toBe(false);
		submit.click();
		await draw();
		expect(send).toHaveBeenCalledExactlyOnceWith("other@example.invalid");
	});
	it("sends on Enter pressed before the answer came, once the address finds someone", async () => {
		const f = await setup();
		const send = vi.spyOn(f.api, "sendFriendRequest").mockResolvedValue();
		const find = vi
			.mocked(f.api.findAccountByEmail)
			.mockImplementation(async (email) =>
				email === "new@example.invalid" ? { userId: id(45), email, displayName: "New Person", self: false } : null,
			);
		open(f.root);
		click(f.root, "#settings-tab-friends");
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".panel-search input")!,
			enter = () =>
				field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		field.value = "nobody@example.invalid";
		field.dispatchEvent(new Event("input"));
		enter();
		await draw();
		expect(find).toHaveBeenCalledExactlyOnceWith("nobody@example.invalid");
		expect(send).not.toHaveBeenCalled();
		field.value = "new@example.invalid";
		field.dispatchEvent(new Event("input"));
		enter();
		await draw();
		expect(find).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledExactlyOnceWith("new@example.invalid");
		expect(field.value).toBe("");
		// Enter twice before a slow answer: one request, and the field keeps the address if it fails.
		const refused = deferred<void>();
		send.mockReturnValueOnce(refused.promise);
		find.mockClear();
		field.value = "second@example.invalid";
		field.dispatchEvent(new Event("input"));
		find.mockResolvedValueOnce({
			userId: id(47),
			email: "second@example.invalid",
			displayName: "Second",
			self: false,
		});
		enter();
		enter();
		await draw();
		expect(send).toHaveBeenCalledTimes(2);
		expect(field.value).toBe("second@example.invalid");
		refused.reject(new Error("The cloud refused it."));
		await draw();
		expect(f.root.querySelector("#settings-content")?.textContent).toContain("The cloud refused it.");
		expect(field.value).toBe("second@example.invalid");
	});
	it("looks up a friend's address again once they are no longer a friend", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listFriends).mockResolvedValueOnce([
			{
				userId: userB.id,
				email: userB.email!,
				displayName: "Friend B",
				status: "accepted",
				direction: "outgoing",
				since: timestamp,
			},
		]);
		const f = await setup(fixtureState);
		const remove = vi.spyOn(f.api, "removeFriend").mockResolvedValue();
		const find = vi
			.mocked(f.api.findAccountByEmail)
			.mockImplementation(async (email) => ({ userId: userB.id, email, displayName: "Friend B", self: false }));
		open(f.root);
		click(f.root, "#settings-tab-friends");
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".panel-search input")!,
			submit = f.root.querySelector<HTMLButtonElement>('.panel-search button[type="submit"]')!,
			panel = () => f.root.querySelector(".settings-dialog .panel")!;
		// A friend's address shows the friend, and is not looked up.
		field.value = userB.email!;
		field.dispatchEvent(new Event("input"));
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).not.toHaveBeenCalled();
		expect(submit.disabled).toBe(true);
		[...panel().querySelectorAll("button")].find((button) => button.textContent === "Remove")!.click();
		await draw();
		expect(remove).toHaveBeenCalledExactlyOnceWith(userB.id);
		await vi.advanceTimersByTimeAsync(250);
		await draw();
		expect(find).toHaveBeenCalledExactlyOnceWith(userB.email!.toLowerCase());
		expect(panel().querySelector(".skeleton-list")).toBeNull();
		expect(panel().textContent).toContain("Add a friend");
		expect(submit.disabled).toBe(false);
	});
	it("never moves the Friends field: composed text filters the list and the field keeps focus", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture(),
			profiles = deferred<(typeof profileA)[]>(),
			friend = { status: "accepted", direction: "outgoing", since: timestamp } as const;
		vi.mocked(fixtureState.api.listProfiles).mockReturnValue(profiles.promise);
		vi.mocked(fixtureState.api.listFriends).mockResolvedValue([
			{ ...friend, userId: userB.id, email: userB.email!, displayName: "Émile" },
			{ ...friend, userId: id(44), email: "carl@example.invalid", displayName: "Carl" },
		]);
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-friends");
		await draw();
		const field = f.root.querySelector<HTMLInputElement>(".panel-search input")!,
			names = () =>
				[...f.root.querySelectorAll(".settings-dialog .person-row strong")].map((name) => name.textContent);
		expect(names()).toEqual(["Émile", "Carl"]);
		// Every removal that took the field out of the page, even if it was put back afterwards.
		const removed: Node[] = [],
			observer = new MutationObserver((records) => {
				for (const record of records) removed.push(...record.removedNodes);
			}),
			fieldRemovals = () => {
				for (const record of observer.takeRecords()) removed.push(...record.removedNodes);
				return removed.filter((node) => node.contains(field));
			};
		observer.observe(f.root, { childList: true, subtree: true });
		// A dead key (´ then e on a Danish Mac) or an IME composes "é"; the list filters while it composes.
		field.focus();
		field.dispatchEvent(new CompositionEvent("compositionstart"));
		field.value = "é";
		field.dispatchEvent(new InputEvent("input", { isComposing: true }));
		await draw();
		expect(fieldRemovals()).toEqual([]);
		expect(document.activeElement).toBe(field);
		expect(names()).toEqual(["Émile"]);
		// The company list arriving mid-composition selects the open tab again; nothing it shows changed.
		const row = f.root.querySelector(".settings-dialog .person-row");
		const back = f.root.querySelector<HTMLAnchorElement>(".settings-nav .settings-back")!;
		expect(f.api.getTeam).not.toHaveBeenCalled();
		profiles.resolve([profileA]);
		await draw();
		// Settings took up the account's only company (they start it: no picker shows it any more),
		// and the rail still ends with its way back, hidden here on the company list.
		expect(f.api.getTeam).toHaveBeenCalledExactlyOnceWith(profileA.profileId);
		expect(f.root.querySelector(".settings-nav")!.lastElementChild).toBe(back);
		expect(back.hidden).toBe(true);
		expect(fieldRemovals()).toEqual([]);
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("é");
		expect(f.root.querySelector(".settings-dialog .person-row")).toBe(row);
		observer.disconnect();
	});
	it("draws the Friends dates again in a time zone chosen while the tab was hidden", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		// 23:30 UTC on 5 September is already 6 September in Auckland.
		vi.mocked(fixtureState.api.listFriends).mockResolvedValue([
			{
				status: "accepted",
				direction: "outgoing",
				since: "2026-09-05T23:30:00Z",
				userId: userB.id,
				email: userB.email!,
				displayName: "Émile",
			},
		]);
		expect(setTimeZonePreference("UTC")).toBe(true);
		try {
			const f = await setup(fixtureState);
			open(f.root);
			click(f.root, "#settings-tab-friends");
			await draw();
			const row = () => f.root.querySelector(".settings-dialog .person-row")?.textContent;
			expect(row()).toContain("since Sep 5, 2026");
			click(f.root, "#settings-tab-general");
			expect(setTimeZonePreference("Pacific/Auckland")).toBe(true);
			await draw();
			click(f.root, "#settings-tab-friends");
			await draw();
			expect(row()).toContain("since Sep 6, 2026");
		} finally {
			setTimeZonePreference("system");
		}
	});
	it("draws the Friends rows again when the tab is shown again, so a company logo is live", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listIncomingInvitations).mockResolvedValue([
			{
				id: id(43),
				profileId: profileB.profileId,
				environmentId: profileB.environmentId,
				profileName: profileB.profileName,
				environmentName: profileB.environmentName,
				email: userA.email!,
				role: "contributor",
				invitedByUserId: userB.id,
				createdAt: timestamp,
				expiresAt: "2099-01-01T00:00:00Z",
			},
		]);
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-friends");
		await draw();
		const logo = () => f.root.querySelector(".settings-dialog .person-row .company-logo");
		const first = logo();
		expect(first?.isConnected).toBe(true);
		// Off the page the logo's figure stops; a theme or size change would not reach it.
		click(f.root, "#settings-tab-general");
		await draw();
		expect(first?.isConnected).toBe(false);
		click(f.root, "#settings-tab-friends");
		await draw();
		expect(logo()).not.toBeNull();
		expect(logo()).not.toBe(first);
		expect(logo()?.isConnected).toBe(true);
	});
	it("offers accepted friends in the company invitation picker and sends Add a friend to the Friends tab", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listFriends).mockResolvedValue([
			{
				userId: userB.id,
				email: userB.email!,
				displayName: "Friend B",
				status: "accepted",
				direction: "outgoing",
				since: timestamp,
			},
		]);
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		// A settings search that hides the Friends tab is cleared on the way there.
		const search = f.root.querySelector<HTMLInputElement>(".settings-nav input")!;
		search.value = "team";
		search.dispatchEvent(new Event("input"));
		expect(f.root.querySelector<HTMLElement>("#settings-tab-friends")!.hidden).toBe(true);
		f.root.querySelector<HTMLDetailsElement>(".company-invite")!.open = true;
		expect(f.root.querySelector(".invite-results")?.textContent).toContain("Friend B");
		[...f.root.querySelectorAll<HTMLButtonElement>(".company-invite button")]
			.find((button) => button.textContent === "Add a friend")!
			.click();
		expect(search.value).toBe("");
		expect(f.root.querySelector<HTMLElement>("#settings-tab-friends")!.hidden).toBe(false);
		expect(f.root.querySelector("#settings-tab-friends")?.getAttribute("aria-selected")).toBe("true");
		expect(document.activeElement).toBe(f.root.querySelector(".panel-search input"));
		expect(f.api.listFriends).toHaveBeenCalledTimes(1);
	});
	it("closes nested confirmation before settings, and cancels it on sign-out", async () => {
		const f = await setup();
		open(f.root);
		click(f.root, "#settings-tab-company");
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Delete company")!.click();
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Delete company")!.click();
		f.auth(null);
		await draw();
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
		expect(document.querySelector(".settings-overlay")).toBeNull();
	});
	it("shows the plan and the open company's storage on the Plan & usage tab", async () => {
		const f = await setup();
		const loading = deferred<Awaited<ReturnType<typeof f.api.getCompanyFile>>>();
		vi.mocked(f.api.getCompanyFile).mockReturnValueOnce(loading.promise);
		open(f.root);
		expect(f.root.querySelector("#settings-content")?.textContent).not.toContain("Current plan");
		click(f.root, "#settings-tab-plan");
		await draw();
		const content = () => f.root.querySelector("#settings-content")!;
		expect(content().querySelector("h1")?.textContent).toBe("Plan & usage");
		expect(content().textContent).toContain("Current plan");
		expect(content().textContent).toContain("Loading storage…");
		expect(f.api.getCompanyFile).toHaveBeenCalledTimes(1);
		loading.resolve({ ...file, storageUsedBytes: 2_000_000 });
		await draw();
		expect(content().querySelector(".settings-usage:not(.settings-hours) strong")?.textContent).toMatch(
			/^1\.9 MiB used of /,
		);
		expect(
			content().querySelector(".settings-usage:not(.settings-hours) small:not(.settings-eyebrow)")?.textContent,
		).toBe(profileA.profileName);
		expect(content().querySelector(".settings-usage:not(.settings-hours) progress")).not.toBeNull();
		// The Company tab reuses what the Plan tab loaded.
		click(f.root, "#settings-tab-company");
		await draw();
		expect(f.api.getCompanyFile).toHaveBeenCalledTimes(1);
	});
	it("asks to open a company for usage and retries a failed storage lookup", async () => {
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		const f = await setup(fixtureState);
		vi.mocked(f.api.getCompanyFile).mockRejectedValueOnce(new Error("Storage offline"));
		open(f.root);
		click(f.root, "#settings-tab-plan");
		await draw();
		const content = () => f.root.querySelector("#settings-content")!;
		expect(content().textContent).toContain("Storage information unavailable");
		const retry = () => [...content().querySelectorAll("button")].find((button) => button.textContent === "Retry");
		retry()!.click();
		// The button disables at once while the retry runs.
		expect(retry()?.disabled).toBe(true);
		await draw();
		expect(f.api.getCompanyFile).toHaveBeenCalledTimes(2);
		expect(content().textContent).not.toContain("Storage information unavailable");
		expect(content().querySelector(".settings-usage:not(.settings-hours) progress")).not.toBeNull();
		click(f.root, ".settings-close");
		location.hash = "#/";
		await draw();
		open(f.root);
		click(f.root, "#settings-tab-plan");
		await draw();
		expect(content().textContent).toContain("Open a company to see its storage.");
		expect(content().querySelector(".settings-usage:not(.settings-hours)")).toBeNull();
	});
	it("keeps focus in General when the account plan arrives", async () => {
		const f = await setup(),
			pending = deferred<HostedAccountEntitlement>();
		vi.mocked(f.api.getAccountEntitlement).mockReturnValueOnce(pending.promise);
		open(f.root);
		await draw();
		const language = f.root.querySelector<HTMLButtonElement>(".preference-picker-button")!;
		language.focus();
		pending.resolve({
			planKey: "free",
			billingMode: "fixture",
			featureSet: "fixture",
			storageAllocation: "fixture",
			source: "fixture",
		});
		await draw();
		expect(language.isConnected).toBe(true);
		expect(document.activeElement).toBe(language);
	});
	it("shows an account failure in General", async () => {
		const f = await setup(),
			pending = deferred<HostedAccountEntitlement>();
		vi.mocked(f.api.getAccountEntitlement).mockReturnValueOnce(pending.promise);
		open(f.root);
		await draw();
		pending.reject(new Error("Account temporarily unavailable"));
		await draw();
		expect(f.root.querySelector(".settings-content")!.textContent).toContain("Account temporarily unavailable");
	});
	it("discards a late account response after closing settings or changing account", async () => {
		const f = await setup(),
			pending = deferred<HostedAccountEntitlement>();
		vi.mocked(f.api.getAccountEntitlement).mockReturnValueOnce(pending.promise);
		open(f.root);
		f.auth(userB);
		await draw();
		pending.resolve({
			planKey: "OLD PRIVATE PLAN",
			billingMode: "fixture",
			featureSet: "fixture",
			storageAllocation: "fixture",
			source: "fixture",
		});
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.textContent).not.toContain("OLD PRIVATE PLAN");
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
	});
	it("closes settings immediately when company membership is revoked", async () => {
		const f = await setup();
		open(f.root);
		click(f.root, "#settings-tab-company");
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		expect(f.root.querySelector("main")?.textContent).toContain("Your access to this company was revoked");
	});
	it("shows an initial team failure and recovers on retry with healthy Realtime", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.getTeam).mockRejectedValue(new Error("Team temporarily unavailable"));
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-company");
		const channel = vi.mocked(f.cloud.supabase.channel).mock.results[0]!.value;
		vi.mocked(channel.subscribe).mock.calls[0]![0]!(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.api.getTeam).toHaveBeenCalledTimes(1);
		expect(f.root.querySelector(".settings-team")!.textContent).toContain("Team temporarily unavailable");
		expect(f.root.querySelector(".settings-team")!.textContent).not.toContain("Loading team");
		// No Delete company while the team cannot be read; the empty slot hides.
		expect(f.root.querySelector(".settings-company-exit")!.childElementCount).toBe(0);
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Retry company")!.click();
		await draw();
		expect(f.api.getTeam).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".settings-team")!.textContent).toContain("Team temporarily unavailable");
		vi.mocked(f.api.getTeam).mockResolvedValue(team);
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Retry company")!.click();
		await draw();
		expect(f.root.querySelector(".settings-team")!.textContent).not.toContain("Team temporarily unavailable");
		expect(f.root.querySelector(".settings-file + .settings-company-exit > .company-exit")?.textContent).toBe(
			"Delete company",
		);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it.each(["delete", "leave"])("closes settings and refreshes the hub after %s", async (action) => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.getTeam).mockResolvedValue({
			...team,
			role: action === "delete" ? "owner" : "contributor",
		});
		const removal = vi
			.spyOn(fixtureState.api, action === "delete" ? "deleteProfile" : "leaveProfile")
			.mockImplementation(async () => {
				vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([]);
			});
		const f = await setup(fixtureState);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, action === "delete");
		await draw();
		expect(removal).toHaveBeenCalledExactlyOnceWith(profileA.profileId);
		expect(location.hash).toBe("#/");
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(false);
		expect(f.root.querySelector(".company-card[href]")).toBeNull();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(2);
		expect(f.cloud.supabase.removeChannel).toHaveBeenCalledTimes(1);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("keeps settings and company membership after a failed deletion", async () => {
		history.replaceState(null, "", "/#/");
		const f = await setup();
		vi.spyOn(f.api, "deleteProfile").mockRejectedValue(new Error("Deletion unavailable"));
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		expect(f.root.querySelector(".settings-company-exit")!.textContent).toContain("Deletion unavailable");
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
		expect(f.root.querySelector(".company-card[href]")!.textContent).toContain(profileA.profileName);
		expect(f.api.listProfiles).toHaveBeenCalledTimes(1);
	});
	it("refreshes the hub even when revocation arrives before the deletion response", async () => {
		history.replaceState(null, "", "/#/");
		const f = await setup(),
			pending = deferred<void>();
		vi.spyOn(f.api, "deleteProfile").mockReturnValue(pending.promise);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		vi.mocked(f.api.listProfiles).mockResolvedValue([]);
		pending.resolve();
		await draw();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".company-card[href]")).toBeNull();
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("ignores a deletion response from a previous account", async () => {
		history.replaceState(null, "", "/#/");
		const f = await setup(),
			pending = deferred<void>();
		vi.spyOn(f.api, "deleteProfile").mockReturnValue(pending.promise);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		vi.mocked(f.api.listProfiles).mockResolvedValue([profileB]);
		f.auth(userB);
		await draw();
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		const settings = f.root.querySelector(".settings-overlay");
		const reads = vi.mocked(f.api.listProfiles).mock.calls.length;
		pending.resolve();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBe(settings);
		// The new account's only company is shown (the Company tab names it by its Company File link).
		expect(settings!.querySelector(`#settings-content a[href='#/c/${profileB.profileId}/file']`)).not.toBeNull();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(reads);
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
	});
	it("keeps a newer settings session open when an old deletion completes", async () => {
		history.replaceState(null, "", "/#/");
		const f = await setup(),
			pending = deferred<void>();
		vi.spyOn(f.api, "deleteProfile").mockReturnValue(pending.promise);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		click(f.root, ".settings-close");
		open(f.root);
		const settings = f.root.querySelector(".settings-overlay");
		vi.mocked(f.api.listProfiles).mockResolvedValue([]);
		pending.resolve();
		await draw();
		expect(f.root.querySelector(".settings-overlay")).toBe(settings);
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
		click(f.root, "#settings-tab-company");
		expect(settings!.textContent).toContain("Open a company to see these settings.");
		expect(f.api.listProfiles).toHaveBeenCalledTimes(2);
	});
	it("returns the standalone Team page to an updated hub after leaving", async () => {
		history.replaceState(null, "", `/#/c/${profileA.profileId}/team`);
		const fixtureState = fixture();
		vi.mocked(fixtureState.api.getTeam).mockResolvedValue({ ...team, role: "contributor" });
		vi.spyOn(fixtureState.api, "leaveProfile").mockImplementation(async () => {
			vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([]);
		});
		const f = await setup(fixtureState);
		confirmCompanyRemoval(f.root, false);
		await draw();
		expect(location.hash).toBe("#/");
		expect(f.root.querySelector(".team")).toBeNull();
		expect(f.root.querySelector(".company-card[href]")).toBeNull();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(2);
		expect(f.cloud.supabase.removeChannel).toHaveBeenCalledTimes(1);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it.each(["settings", "team page"])("shows a failed company deletion right under its button in %s", async (place) => {
		history.replaceState(null, "", place === "settings" ? "/#/" : `/#/c/${profileA.profileId}/team`);
		const fixtureState = fixture();
		vi.spyOn(fixtureState.api, "deleteProfile").mockRejectedValue(new Error("Deleting is paused"));
		const f = await setup(fixtureState);
		if (place === "settings") {
			open(f.root);
			click(f.root, "#settings-tab-company");
			await draw();
		}
		confirmCompanyRemoval(f.root, true);
		await draw();
		const exit = f.root.querySelector(".company-exit")!;
		expect(exit.nextElementSibling?.matches(".notice-danger")).toBe(true);
		expect(exit.nextElementSibling?.textContent).toContain("Deleting is paused");
		// Not also at the top of the page, above the members.
		expect(f.root.querySelectorAll(".notice-danger")).toHaveLength(1);
		expect(location.hash).toBe(place === "settings" ? "#/" : `#/c/${profileA.profileId}/team`);
	});
	it("does not restore a removed company from an older company-list request", async () => {
		const fixtureState = fixture(),
			pending = deferred<(typeof profileA)[]>();
		vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		vi.spyOn(fixtureState.api, "deleteProfile").mockResolvedValue(undefined);
		const f = await setup(fixtureState);
		vi.mocked(f.api.listProfiles).mockReturnValueOnce(pending.promise).mockResolvedValue([]);
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true);
		await draw();
		open(f.root);
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true, profileB);
		await draw();
		pending.resolve([profileB]);
		await draw();
		expect(f.api.deleteProfile).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".company-card[href]")).toBeNull();
		expect(f.api.listProfiles).toHaveBeenCalledTimes(3);
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it.each(["connections"])("keeps the focused %s control through an unrelated company refresh", async (tab) => {
		const f = await setup();
		open(f.root);
		click(f.root, `#settings-tab-${tab}`);
		await draw();
		const control = f.root.querySelector<HTMLElement>("#settings-content")!;
		control.focus();
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(control.isConnected).toBe(true);
		expect(document.activeElement).toBe(control);
	});
	it("only reads member account state on Connections", async () => {
		// Isolate Settings reads from an open conversation's quota polling.
		// The Team route keeps the same company authority without a composer.
		history.replaceState(null, "", `/#/c/${profileA.profileId}/team`);
		const f = await setup(realtimeFixture());
		const connectionsUrl = "https://fixture.invalid/rest/v1/rpc/qorpera_list_member_native_execution_connections";
		const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
			if (String(input).endsWith("/qorpera_list_member_notifications")) return Response.json([]);
			if (String(input) === connectionsUrl) return Response.json({ compute_identity: null, connections: [] });
			throw new Error("Unexpected request in the settings read-only fixture");
		});
		vi.stubGlobal("fetch", fetch);
		open(f.root);
		click(f.root, "#settings-tab-connections");
		await draw();
		const cards = [...f.root.querySelectorAll<HTMLElement>("#settings-content .connection-card")];
		expect(cards).toHaveLength(0);
		expect(f.root.querySelector<HTMLButtonElement>("#settings-content .connection-add")!.disabled).toBe(true);
		expect(f.root.querySelector<HTMLElement>("#settings-content .connection-provider-picker")!.hidden).toBe(true);
		// The Services section lists the Step 7 connectors with their own Connect buttons.
		expect(f.root.querySelectorAll("#settings-content .service-card")).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(60_000);
		// Model accounts never go through the SDK RPC path; the services list is the only RPC.
		expect(vi.mocked(f.cloud.rpc).mock.calls.map(([name]) => name)).toEqual([
			"qorpera_list_cloud_secret_connections",
		]);
		expect(fetch.mock.calls.filter(([url]) => String(url) === connectionsUrl)).toEqual([
			[connectionsUrl, expect.objectContaining({ method: "POST" })],
		]);
	});
});
