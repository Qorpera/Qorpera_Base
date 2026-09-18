// @vitest-environment jsdom
import { REALTIME_SUBSCRIBE_STATES, RealtimeClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { SettingsView } from "../src/app/views/settings.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedAccountEntitlement } from "../src/cloud/types.ts";
import { deferred, fixture, profileA, profileB, session, settle, team, userA, userB } from "./fixtures.ts";

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
	root.querySelector<HTMLDetailsElement>(".company-danger")!.open = true;
	click(root, ".company-danger button");
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
			const picker = f.root.querySelector<HTMLSelectElement>(".settings-company-picker")!;
			expect(picker.options).toHaveLength(1);
			pending.resolve(profiles);
			await draw();
			expect(f.root.querySelector(".settings-company-picker")).toBe(picker);
			expect(picker.options).toHaveLength(profiles.length + 1);
			const selected = profiles.at(-1)!;
			if (profiles.length > 1) {
				expect(picker.value).toBe("");
				picker.value = selected.profileId;
				picker.dispatchEvent(new Event("change"));
				await draw();
			}
			expect(picker.value).toBe(selected.profileId);
			expect(f.root.querySelector("#settings-content h1")?.textContent).toBe(selected.profileName);
			expect(f.root.querySelector(`.settings-dialog a[href='#/c/${selected.profileId}/file']`)).not.toBeNull();
			expect(f.cloud.rpc).not.toHaveBeenCalled();
		},
	);
	it("preserves the selected company and focus when the profile list refreshes", async () => {
		const f = fixture(),
			auth = new AuthController(f.cloud);
		await auth.start();
		const company = new CompanyController(f.api, profileA, userA.id);
		const view = new SettingsView(
			f.api,
			auth,
			[profileA],
			company,
			() => {},
			() => {},
		);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
			auth.dispose();
		};
		const content = view.el.querySelector<HTMLElement>("#settings-content")!;
		content.focus();
		view.updateProfiles([{ ...profileA }, profileB]);
		expect(view.el.querySelector("#settings-content")).toBe(content);
		expect(document.activeElement).toBe(content);
		expect(view.el.querySelector<HTMLSelectElement>(".settings-company-picker")!.value).toBe(profileA.profileId);
		expect(view.el.querySelector<HTMLElement>(".settings-company-label")!.hidden).toBe(false);
		expect(f.api.getTeam).not.toHaveBeenCalled();
		expect(company.signal.aborted).toBe(false);
	});
	it("borrows the open company again without removing its conversation subscription", async () => {
		const f = await setup(realtimeFixture());
		const composer = f.root.querySelector("textarea");
		const originalChannel = vi.mocked(f.cloud.supabase.channel).mock.results[0]!.value;
		open(f.root);
		const picker = f.root.querySelector<HTMLSelectElement>('[aria-label="Company for settings"]')!;
		picker.value = profileB.profileId;
		picker.dispatchEvent(new Event("change"));
		await draw();
		picker.value = profileA.profileId;
		picker.dispatchEvent(new Event("change"));
		await draw();
		click(f.root, ".settings-close");
		expect(f.cloud.supabase.channel).toHaveBeenCalledTimes(2);
		expect(f.cloud.supabase.removeChannel).toHaveBeenCalledTimes(1);
		expect(f.cloud.supabase.removeChannel).not.toHaveBeenCalledWith(originalChannel);
		expect(f.root.querySelector("textarea")).toBe(composer);
	});
	it("does not reuse a company subscription that is still closing during a quick switch back", async () => {
		const f = await setup(realtimeFixture());
		open(f.root);
		const picker = f.root.querySelector<HTMLSelectElement>('[aria-label="Company for settings"]')!;
		for (const profile of [profileB, profileA, profileB]) {
			picker.value = profile.profileId;
			picker.dispatchEvent(new Event("change"));
			await draw();
		}
		const channels = vi.mocked(f.cloud.supabase.channel).mock.results.map((result) => result.value);
		expect(channels).toHaveLength(3);
		expect(channels[2]).not.toBe(channels[1]);
		expect(f.cloud.supabase.removeChannel).toHaveBeenCalledExactlyOnceWith(channels[1]);
		click(f.root, ".settings-close");
		expect(f.cloud.supabase.removeChannel).toHaveBeenCalledTimes(2);
		expect(f.cloud.supabase.removeChannel).toHaveBeenLastCalledWith(channels[2]);
		expect(f.cloud.supabase.removeChannel).not.toHaveBeenCalledWith(channels[0]);
	});
	it("opens all four tabs over the same conversation and restores the profile button", async () => {
		const f = await setup(),
			composer = f.root.querySelector<HTMLTextAreaElement>("textarea")!;
		composer.value = "Keep my conversation draft";
		composer.dispatchEvent(new Event("input", { bubbles: true }));
		open(f.root);
		await draw();
		expect([...f.root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
			"General",
			"Company",
			"Connections",
		]);
		expect(f.root.querySelector<HTMLElement>(".frame")!.inert).toBe(true);
		click(f.root, "#settings-tab-company");
		expect(f.root.querySelector('.settings-dialog a[href$="/file"]')).not.toBeNull();
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
		search.value = "";
		search.dispatchEvent(new Event("input"));
		click(f.root, "#settings-tab-general");
		f.root
			.querySelector("#settings-tab-general")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(f.root.querySelector("#settings-tab-company"));
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
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Retry company")!.click();
		await draw();
		expect(f.api.getTeam).toHaveBeenCalledTimes(2);
		expect(f.root.querySelector(".settings-team")!.textContent).toContain("Team temporarily unavailable");
		vi.mocked(f.api.getTeam).mockResolvedValue(team);
		[...f.root.querySelectorAll("button")].find((button) => button.textContent === "Retry company")!.click();
		await draw();
		expect(f.root.querySelector(".settings-team")!.textContent).not.toContain("Team temporarily unavailable");
		expect(f.root.querySelector(".company-danger")).not.toBeNull();
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
	it("keeps a different company's conversation and draft when settings deletes a company", async () => {
		const f = await setup(realtimeFixture());
		vi.spyOn(f.api, "deleteProfile").mockImplementation(async () => {
			vi.mocked(f.api.listProfiles).mockResolvedValue([profileA]);
		});
		const composer = f.root.querySelector<HTMLTextAreaElement>("textarea")!;
		composer.value = "Keep this conversation";
		composer.dispatchEvent(new Event("input"));
		open(f.root);
		const picker = f.root.querySelector<HTMLSelectElement>(".settings-company-picker")!;
		picker.value = profileB.profileId;
		picker.dispatchEvent(new Event("change"));
		click(f.root, "#settings-tab-company");
		await draw();
		confirmCompanyRemoval(f.root, true, profileB);
		await draw();
		expect(f.api.deleteProfile).toHaveBeenCalledExactlyOnceWith(profileB.profileId);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${session.sessionId}`);
		expect(f.root.querySelector(".settings-overlay")).toBeNull();
		expect(f.root.querySelector("textarea")).toBe(composer);
		expect(composer.value).toBe("Keep this conversation");
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
		expect(f.root.querySelector(".settings-team")!.textContent).toContain("Deletion unavailable");
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
		expect(settings!.textContent).toContain(profileB.profileName);
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
		expect(settings!.textContent).toContain("Choose a company");
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
	it("does not restore a removed company from an older company-list request", async () => {
		history.replaceState(null, "", "/#/");
		const fixtureState = fixture(),
			pending = deferred<(typeof profileA)[]>();
		vi.mocked(fixtureState.api.listProfiles).mockResolvedValue([profileA, profileB]);
		vi.spyOn(fixtureState.api, "deleteProfile").mockResolvedValue(undefined);
		const f = await setup(fixtureState);
		vi.mocked(f.api.listProfiles).mockReturnValueOnce(pending.promise).mockResolvedValue([]);
		open(f.root);
		const picker = f.root.querySelector<HTMLSelectElement>(".settings-company-picker")!;
		picker.value = profileA.profileId;
		picker.dispatchEvent(new Event("change"));
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
		const f = await setup(realtimeFixture());
		const connectionsUrl = "https://fixture.invalid/rest/v1/rpc/qorpera_list_member_native_execution_connections";
		const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
			if (String(input) === connectionsUrl) return Response.json({ compute_identity: null, connections: [] });
			throw new Error("Unexpected request in the settings read-only fixture");
		});
		vi.stubGlobal("fetch", fetch);
		open(f.root);
		click(f.root, "#settings-tab-connections");
		await draw();
		const cards = [...f.root.querySelectorAll<HTMLElement>("#settings-content .connection-card")];
		expect(cards.map((card) => card.querySelector("strong")!.textContent)).toEqual(["ChatGPT / Codex", "Claude"]);
		for (const card of cards) expect(card.querySelector('small[role="status"]')!.textContent).toMatch(/^Not /);
		expect(
			[...f.root.querySelectorAll<HTMLButtonElement>("#settings-content button")].find(
				(button) => button.textContent === "Add service",
			)!.disabled,
		).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledExactlyOnceWith(connectionsUrl, expect.objectContaining({ method: "POST" }));
	});
});
