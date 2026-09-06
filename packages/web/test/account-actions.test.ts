// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import appCss from "../src/styles/app.css?raw";
import conversationCss from "../src/styles/conversation.css?raw";
import settingsCss from "../src/styles/settings.css?raw";
import tokensCss from "../src/styles/tokens.css?raw";
import { fixture, id, profileA, settle, timestamp, userA, userB } from "./fixtures.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	document.body.replaceChildren();
	for (const style of document.head.querySelectorAll("style[data-account-actions-test]")) style.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("account actions with the shared stylesheets", () => {
	it.each(["friends", "invitations"])("keeps %s decisions visible outside company settings", async (page) => {
		vi.useFakeTimers();
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		const style = document.createElement("style");
		style.dataset.accountActionsTest = "true";
		// Load the actual cascade, including settings, to catch selectors leaking
		// onto existing account pages.
		style.textContent = [tokensCss, settingsCss, conversationCss, appCss].join("\n").replace(/^@import .*;$/gm, "");
		document.head.append(style);
		expect(style.sheet?.cssRules.length).toBeGreaterThan(0);
		history.replaceState(null, "", `/#/${page}`);
		const f = fixture(),
			root = document.createElement("div");
		vi.mocked(f.api.listFriends).mockResolvedValue([
			{
				userId: userB.id,
				email: userB.email!,
				displayName: "Friend",
				status: "pending",
				direction: "incoming",
				since: timestamp,
			},
		]);
		vi.mocked(f.api.listIncomingInvitations).mockResolvedValue([
			{
				id: id(43),
				profileId: profileA.profileId,
				environmentId: profileA.environmentId,
				profileName: profileA.profileName,
				environmentName: profileA.environmentName,
				email: userA.email!,
				role: "contributor",
				invitedByUserId: userB.id,
				createdAt: timestamp,
				expiresAt: "2099-01-01T00:00:00Z",
			},
		]);
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		const actions = root.querySelector<HTMLElement>(".person-actions")!;
		expect(actions.textContent).toContain("Accept");
		expect(getComputedStyle(actions).opacity || "1").toBe("1");
		actions.querySelector<HTMLButtonElement>("button")!.focus();
		expect(getComputedStyle(actions).opacity || "1").toBe("1");
	});
});
