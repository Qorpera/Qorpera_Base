// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { FriendsController, renderFriends } from "../src/app/views/friends.ts";
import { HubController } from "../src/app/views/hub.ts";
import { SettingsView } from "../src/app/views/settings.ts";
import { fixture, profileA } from "./fixtures.ts";

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("refreshes co-founder invitations and busy/error state without moving a composed Friends field", () => {
	const f = fixture();
	const friends = new FriendsController(f.api);
	const hub = new HubController(f.api);
	const container = document.createElement("div");
	document.body.append(container);
	const invitation = { profileId: profileA.profileId, companyName: "Coffee company", invitedByDisplayName: "Anna" };
	const respond = vi.spyOn(hub, "respondFoundingInvitation").mockResolvedValue();
	try {
		friends.store.set({ loading: false, loaded: true });
		renderFriends(friends, hub, container);
		const field = container.querySelector("input")!;
		field.focus();
		field.dispatchEvent(new CompositionEvent("compositionstart"));
		field.value = "Coffee";
		field.dispatchEvent(new Event("input"));
		hub.store.set({ foundingInvitations: [invitation] });
		renderFriends(friends, hub, container);
		const join = () =>
			[...container.querySelectorAll("button")].find((button) => button.textContent === "Join setup")!;
		expect(join()).toBeDefined();
		expect(container.querySelector("input")).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("Coffee");
		hub.store.set({ busyInvitation: invitation.profileId });
		renderFriends(friends, hub, container);
		expect(join().disabled).toBe(true);
		hub.store.set({ busyInvitation: undefined, error: "Join failed" });
		renderFriends(friends, hub, container);
		expect(container.textContent).toContain("Join failed");
		join().click();
		expect(respond).toHaveBeenCalledExactlyOnceWith(invitation, true);
		hub.store.set({ foundingInvitations: [], error: undefined, foundingInvitationsError: "Invitations unavailable" });
		renderFriends(friends, hub, container);
		expect(join()).toBeUndefined();
		expect(container.textContent).toContain("Invitations unavailable");
		expect(container.querySelector("input")).toBe(field);
	} finally {
		friends.dispose();
		hub.dispose();
	}
});

it("counts pending co-founder invitations in the Settings Friends tab", async () => {
	const f = fixture();
	const auth = new AuthController(f.cloud);
	await auth.start();
	const hub = new HubController(f.api);
	const view = new SettingsView(
		f.api,
		auth,
		hub,
		[],
		undefined,
		() => {},
		() => {},
	);
	document.body.append(view.el);
	try {
		hub.store.set({
			foundingInvitations: [{ profileId: profileA.profileId, companyName: "Coffee", invitedByDisplayName: "Anna" }],
		});
		await Promise.resolve();
		const count = view.el.querySelector<HTMLElement>(".settings-tab-count")!;
		expect(count.hidden).toBe(false);
		expect(count.textContent).toBe("1");
		hub.store.set({ foundingInvitations: [] });
		await Promise.resolve();
		expect(count.hidden).toBe(true);
	} finally {
		view.dispose();
		hub.dispose();
		auth.dispose();
	}
});
