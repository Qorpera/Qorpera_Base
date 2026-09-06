// @vitest-environment jsdom
import { RealtimeClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { PolicyApi } from "../src/cloud/policy-api.ts";
import type { HostedAccountEntitlement } from "../src/cloud/types.ts";
import { deferred, fixture, profileA, profileB, session, settle, userB } from "./fixtures.ts";

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
		open(f.root);
		await draw();
		expect([...f.root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
			"General",
			"Company",
			"Connections",
			"Policy",
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
	it.each(["policy", "connections"])(
		"keeps the focused %s control through an unrelated company refresh",
		async (tab) => {
			vi.spyOn(PolicyApi.prototype, "read").mockResolvedValue({
				source: "",
				version: null,
				policy: {
					spending: "ask",
					external_communication: "ask",
					hard_to_reverse_changes: "ask",
					information_sharing: "ask",
				},
			});
			const f = await setup();
			open(f.root);
			click(f.root, `#settings-tab-${tab}`);
			await draw();
			const control =
				tab === "policy"
					? f.root.querySelector<HTMLSelectElement>('select[aria-label="Spending"]')!
					: [...f.root.querySelectorAll("button")].find((button) => button.textContent === "Refresh connections")!;
			control.focus();
			f.hints.get("qorpera_profile_access_state")!();
			await draw();
			expect(control.isConnected).toBe(true);
			expect(document.activeElement).toBe(control);
		},
	);
});
