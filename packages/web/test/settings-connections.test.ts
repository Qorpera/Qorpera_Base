// @vitest-environment jsdom
import type {
	NativeExecutionConnections,
	NativeMemberConnection,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConnectionsView,
	finishPlanSignIn,
	memberPlanSignIn,
	PlanSignIn,
	ProviderSignIns,
} from "../src/app/views/settings-connections.ts";
import {
	ChatGptPlanSignInError,
	ClaudeCodeError,
	ClaudeReadNotStarted,
	PlanSwitchBusyError,
	type WebClaudeLogin,
	type WebExecutionConnections,
	type WebMemberConnection,
	type WebNativeProviderLogin,
	type WebNativeSubscription,
} from "../src/cloud/native-subscription.ts";
import { fmtTime } from "../src/ui/dom.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { deferred, id, settle, timestamp, userA } from "./fixtures.ts";

const WATCH_MS = 2000;
const OPENAI = "ChatGPT / Codex";
const CLAUDE = "Claude";
const START_FAILED = "Sign-in could not be started. If you started one a moment ago, give it a few minutes to clear.";
const ID_KEYS = ["clientIdentityId", "clientLoginId", "clientConnectionId"] as const;
/** A connected account that is not yet enabled for the member's messages. */
const connected: NativeMemberConnection = {
	connectionId: id(81),
	clientConnectionId: id(181),
	connectionVersion: 2,
	provider: "openai",
	nativeHarness: "codex-cli",
	authorizationState: "active",
	maxNativeConcurrency: 1,
	providerAccountReference: "codex-cli:opaque-account",
	providerAccountEmail: "member@example.com",
	billingSource: "member",
	consentVersion: "v1",
	consentedAt: timestamp,
	connectionStatus: "active",
	policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 3 },
};
function observed(...items: NativeMemberConnection[]): NativeExecutionConnections {
	return {
		computeIdentity: {
			computeIdentityId: id(80),
			ownershipKind: "member",
			ownerUserId: userA.id,
			displayName: "My computer",
			templateKey: "member",
			templateVersion: "v1",
			capabilities: ["agent_turn"],
			policy: {},
			status: "active",
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		connections: items,
	};
}
let view: ConnectionsView;
afterEach(() => {
	view?.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function setup(
	onboardingAvailable = false,
	initial: NativeExecutionConnections = observed(connected),
	signIns?: ProviderSignIns,
) {
	const client: Pick<
		WebNativeSubscription,
		| "listConnections"
		| "revokeConnection"
		| "createMemberSponsor"
		| "onboardingAvailable"
		| "beginProviderLogin"
		| "listClaudeLogins"
	> = {
		listConnections: vi.fn(async () => structuredClone(initial)),
		// Claude is offered while the member may sign in with it (20260930564000); these flows are the same for both.
		listClaudeLogins: vi.fn(async () => ({ signInOpen: true, logins: [] })),
		revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
		createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
		onboardingAvailable,
		beginProviderLogin: vi.fn(async (input) => ({
			loginId: input.clientLoginId,
			clientConnectionId: input.clientConnectionId,
			status: "awaiting_member" as const,
			interactionUrl: `https://auth.${input.provider}.com/device`,
			userCode: "ABCD-EFGH",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		})),
	};
	const lifetime = new AbortController();
	view = new ConnectionsView(client, lifetime.signal, signIns);
	document.body.append(view.el);
	await settle();
	return { client, lifetime };
}
function card(label: string): HTMLElement {
	return [...view.el.querySelectorAll<HTMLElement>(".connection-card")].find(
		(item) => item.querySelector("strong")?.textContent === label,
	)!;
}
function claudeLoginCard(loginId?: string): HTMLElement | null {
	return view.el.querySelector<HTMLElement>(
		loginId ? `.connection-card[data-claude-login-id="${loginId}"]` : ".connection-card[data-claude-login-id]",
	);
}
function status(label: string): string | null {
	return card(label).querySelector('small[role="status"]')!.textContent;
}
function addAccount(label: string): HTMLButtonElement {
	view.el.querySelector<HTMLButtonElement>(".connection-add")!.click();
	const provider = [...view.el.querySelectorAll<HTMLButtonElement>(".connection-provider-picker button")].find(
		(item) => item.textContent === label,
	)!;
	provider.click();
	return provider;
}
/** The first action of an existing account or sign-in attempt. */
function action(label: string): HTMLButtonElement {
	return card(label).querySelector<HTMLButtonElement>("button")!;
}
function loginIds(client: Awaited<ReturnType<typeof setup>>["client"], call: number) {
	const { clientIdentityId, clientLoginId, clientConnectionId } = vi.mocked(client.beginProviderLogin).mock.calls[
		call
	]![0];
	return { clientIdentityId, clientLoginId, clientConnectionId };
}

describe("member model account settings", () => {
	it("renders existing identities while refreshing usage and then reads new observations", async () => {
		const { client, lifetime } = await setup(
			true,
			observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }),
		);
		view.dispose();
		const pending = deferred<void>();
		const refreshAccountMetadata = vi.fn(() => pending.promise);
		view = new ConnectionsView({ ...client, refreshAccountMetadata }, lifetime.signal);
		document.body.append(view.el);
		await settle();
		expect(view.el.textContent).toContain("member@example.com");
		expect(view.el.textContent).toContain("Refreshing…");
		expect(refreshAccountMetadata).toHaveBeenCalledTimes(1);
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({
				...connected,
				providerAccountEmail: "verified@example.com",
				sponsorBindingId: id(82),
				sponsorVersion: 1,
			}),
		);
		pending.resolve();
		await settle();
		expect(view.el.textContent).toContain("verified@example.com");
		expect(view.el.textContent).not.toContain("Refreshing…");
		expect(client.beginProviderLogin).not.toHaveBeenCalled();
	});
	it("asks for a new observation only from the member's own Refresh button", async () => {
		const { client, lifetime } = await setup(
			true,
			observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }),
		);
		view.dispose();
		const refreshAccountMetadata = vi.fn(async () => {});
		view = new ConnectionsView({ ...client, refreshAccountMetadata }, lifetime.signal);
		document.body.append(view.el);
		await settle();
		expect(refreshAccountMetadata).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), false);
		[...view.el.querySelectorAll("button")].find((button) => button.textContent === "Refresh")!.click();
		await settle();
		expect(refreshAccountMetadata).toHaveBeenCalledTimes(2);
		expect(refreshAccountMetadata).toHaveBeenLastCalledWith(expect.any(AbortSignal), true);
	});
	it("says Updated for a moment after the member's own Refresh, and never after a failed one", async () => {
		vi.useFakeTimers();
		const { client, lifetime } = await setup(
			true,
			observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }),
		);
		view.dispose();
		const refreshAccountMetadata = vi.fn(async (_signal?: AbortSignal, _force?: boolean) => {});
		view = new ConnectionsView({ ...client, refreshAccountMetadata }, lifetime.signal);
		document.body.append(view.el);
		await settle();
		const refresh = () => view.el.querySelector<HTMLButtonElement>('[data-focus-key="refresh"]')!;
		expect(refresh().textContent).toBe("Refresh");
		refresh().click();
		await settle();
		expect(refresh().textContent).toBe("Updated");
		await vi.advanceTimersByTimeAsync(1999);
		expect(refresh().textContent).toBe("Updated");
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh().textContent).toBe("Refresh");
		// A read the member did not ask for ends "Updated" at once and is not credited to them.
		refresh().click();
		await settle();
		expect(refresh().textContent).toBe("Updated");
		window.dispatchEvent(new Event("focus"));
		expect(refresh().textContent).toBe("Refreshing…");
		await settle();
		expect(refresh().textContent).toBe("Refresh");
		expect(refreshAccountMetadata.mock.calls.at(-1)![1]).toBe(false);
		refresh().click();
		await settle();
		expect(refresh().textContent).toBe("Updated");
		refreshAccountMetadata.mockRejectedValueOnce(new Error("offline"));
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(refresh().textContent).toBe("Refresh");
		expect(view.el.textContent).toContain("Usage could not be refreshed. Try again.");
		expect(refreshAccountMetadata.mock.calls.at(-1)![1]).toBe(false);
		refreshAccountMetadata.mockRejectedValueOnce(new Error("offline"));
		refresh().click();
		await settle();
		expect(refresh().textContent).toBe("Refresh");
		expect(view.el.textContent).toContain("Usage could not be refreshed. Try again.");
		view.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("makes a background read ask for a new observation when Refresh joins it", async () => {
		const { client, lifetime } = await setup(
			true,
			observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }),
		);
		view.dispose();
		const refreshAccountMetadata = vi.fn(async (_signal?: AbortSignal, _force?: boolean) => {});
		view = new ConnectionsView({ ...client, refreshAccountMetadata }, lifetime.signal);
		document.body.append(view.el);
		await settle();
		// Returning to the window starts a background read; the button is not greyed out yet.
		window.dispatchEvent(new Event("focus"));
		view.el.querySelector<HTMLButtonElement>('[data-focus-key="refresh"]')!.click();
		await vi.waitFor(() => expect(refreshAccountMetadata).toHaveBeenCalledTimes(2));
		await settle();
		expect(refreshAccountMetadata.mock.calls.map((call) => call[1])).toEqual([false, true]);
		expect(view.el.querySelector('[data-focus-key="refresh"]')!.textContent).toBe("Updated");
	});
	it("keeps one Updated clock when Refresh is pressed twice during one read", async () => {
		vi.useFakeTimers();
		const { client } = await setup(true, observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }));
		const pending = deferred<NativeExecutionConnections>();
		vi.mocked(client.listConnections).mockReturnValueOnce(pending.promise);
		const refresh = () => view.el.querySelector<HTMLButtonElement>('[data-focus-key="refresh"]')!;
		refresh().click();
		refresh().click();
		pending.resolve(observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }));
		await settle();
		expect(refresh().textContent).toBe("Updated");
		view.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("keeps keyboard focus on Refresh while it reads usage", async () => {
		const { client, lifetime } = await setup(
			true,
			observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }),
		);
		view.dispose();
		const refreshAccountMetadata = vi.fn(async (_signal?: AbortSignal, _force?: boolean) => {});
		view = new ConnectionsView({ ...client, refreshAccountMetadata }, lifetime.signal);
		document.body.append(view.el);
		await settle();
		const refresh = () => view.el.querySelector<HTMLButtonElement>('[data-focus-key="refresh"]')!;
		refresh().focus();
		const pending = deferred<void>();
		refreshAccountMetadata.mockReturnValueOnce(pending.promise);
		refresh().click();
		await settle();
		expect(document.activeElement).toBe(refresh());
		expect(refresh().textContent).toBe("Refreshing…");
		expect(refresh().getAttribute("aria-disabled")).toBe("true");
		pending.resolve();
		await settle();
		expect(refresh().textContent).toBe("Updated");
		expect(refresh().hasAttribute("aria-disabled")).toBe(false);
		expect(document.activeElement).toBe(refresh());
		// A press while a background read greys it out does nothing: that read ends without "Updated".
		const background = deferred<void>();
		refreshAccountMetadata.mockReturnValueOnce(background.promise);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(refresh().getAttribute("aria-disabled")).toBe("true");
		refresh().click();
		background.resolve();
		await settle();
		expect(refresh().textContent).toBe("Refresh");
		expect(refreshAccountMetadata.mock.calls.map((call) => call[1])).toEqual([false, true, false]);
		expect(document.activeElement).toBe(refresh());
	});
	it("shows the returning card details in Danish", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-19T20:00:00Z"));
		setLanguagePreference("da");
		try {
			const first = {
				...connected,
				sponsorBindingId: id(82),
				sponsorVersion: 1,
				providerAccountUsage: {
					observedAt: "2026-09-19T19:00:00.000Z",
					windows: [{ id: "primary" as const, label: "5 hours", usedPercent: 8 }],
				},
			};
			await setup(true, observed(first, { ...first, connectionId: id(83) }));
			const card = view.el.querySelector(".connection-card")!;
			const time = fmtTime("2026-09-19T19:00:00.000Z");
			expect(card.querySelector(".connection-identity")!.textContent).toBe(
				`Tilføjet ${fmtTime(connected.consentedAt)} · ${id(81).slice(-8)}`,
			);
			expect(card.querySelector(".connection-identity")!.getAttribute("title")).toBe(`Forbindelse ${id(81)}`);
			expect(card.querySelector(`[title="Sidst tjekket ${time}"]`)!.textContent).toBe(
				`92% ved sidste tjek · ${time}`,
			);
			view.el.querySelector<HTMLButtonElement>('[data-focus-key="refresh"]')!.click();
			await settle();
			expect(view.el.querySelector('[data-focus-key="refresh"]')!.textContent).toBe("Opdateret");
		} finally {
			setLanguagePreference("en");
		}
	});
	it("tells apart two cards for the same provider and email by when each was added", async () => {
		const first = { ...connected, sponsorBindingId: id(82), sponsorVersion: 1 };
		const second = {
			...first,
			connectionId: id(83),
			providerAccountEmail: "Member@Example.com",
			consentedAt: "2026-09-21T00:24:00.000Z",
		};
		const other = { ...first, connectionId: id(84), providerAccountEmail: "other@example.com" };
		await setup(true, observed(first, second, other));
		const identity = (index: number) =>
			view.el.querySelectorAll(".connection-card")[index]!.querySelector(".connection-identity")?.textContent;
		expect(identity(0)).toBe(`Added ${fmtTime(first.consentedAt)} · ${id(81).slice(-8)}`);
		expect(identity(1)).toBe(`Added ${fmtTime(second.consentedAt)} · ${id(83).slice(-8)}`);
		expect(identity(2)).toBeUndefined();
	});
	it("keeps connected identities visible when usage refresh fails", async () => {
		const { client, lifetime } = await setup(true);
		view.dispose();
		view = new ConnectionsView(
			{ ...client, refreshAccountMetadata: vi.fn().mockRejectedValue(new Error("offline")) },
			lifetime.signal,
		);
		document.body.append(view.el);
		await settle();
		expect(view.el.textContent).toContain("member@example.com");
		expect(view.el.textContent).toContain("Usage could not be refreshed. Try again.");
		expect(view.el.textContent).not.toContain("Your model accounts could not be read");
	});
	it("keeps account addition unavailable without configured onboarding", async () => {
		const { client } = await setup(false, observed());
		expect(view.el.querySelectorAll(".connection-card")).toHaveLength(0);
		const add = view.el.querySelector<HTMLButtonElement>(".connection-add")!;
		expect(add.textContent).toBe("Add account");
		expect(add.disabled).toBe(true);
		add.click();
		expect(view.el.querySelector<HTMLElement>(".connection-provider-picker")!.hidden).toBe(true);
		await settle();
		expect(client.beginProviderLogin).not.toHaveBeenCalled();
		expect(view.el.querySelector('input[type="password"]')).toBeNull();
	});
	it("shows each connected account with its provider logo and email, hiding opaque references", async () => {
		await setup(
			true,
			observed(
				{
					...connected,
					providerAccountReference: "codex-cli:opaque-account",
					providerAccountEmail: "first@example.com",
				},
				{ ...connected, connectionId: id(83), providerAccountEmail: "second@example.com" },
				{
					...connected,
					connectionId: id(84),
					provider: "anthropic",
					nativeHarness: "claude-code",
					providerAccountReference: "claude:opaque-account",
					providerAccountEmail: undefined,
				},
				{ ...connected, connectionId: id(85), connectionStatus: "revoked", authorizationState: "revoked" },
			),
		);
		const accounts = [...view.el.querySelectorAll(".connection-card")];
		expect(accounts).toHaveLength(3);
		expect(accounts.map((item) => item.querySelector("strong")!.textContent)).toEqual([OPENAI, OPENAI, CLAUDE]);
		expect(accounts.map((item) => item.querySelector("small")!.textContent)).toEqual([
			"first@example.com",
			"second@example.com",
			"Email unavailable",
		]);
		expect(accounts.map((item) => item.querySelector("img")!.getAttribute("src"))).toEqual([
			"./assets/provider-openai.svg",
			"./assets/provider-openai.svg",
			"./assets/provider-claude.svg",
		]);
		for (const account of accounts) expect(account.querySelector("button")!.textContent).toBe("Sign out");
		expect(view.el.textContent).not.toContain("opaque-account");
	});
	it("tells apart accounts with missing email by when they were added, without presenting references", async () => {
		await setup(
			true,
			observed(
				{ ...connected, providerAccountEmail: undefined, providerAccountReference: "unverified@example.com" },
				{ ...connected, connectionId: id(83), providerAccountEmail: undefined },
			),
		);
		expect([...view.el.querySelectorAll(".connection-email")].map((item) => item.textContent)).toEqual([
			"Email unavailable",
			"Email unavailable",
		]);
		expect(view.el.textContent).not.toContain("unverified@example.com");
		const identities = [...view.el.querySelectorAll(".connection-identity")];
		expect(identities.map((item) => item.textContent)).toEqual([
			`Added ${fmtTime(connected.consentedAt)} · ${id(81).slice(-8)}`,
			`Added ${fmtTime(connected.consentedAt)} · ${id(83).slice(-8)}`,
		]);
		expect(identities[1]!.getAttribute("title")).toBe(`Connection ${id(83)}`);
		expect(view.el.querySelectorAll("[role=meter]")).toHaveLength(0);
		expect(view.el.textContent).toContain("Usage unavailable");
	});
	it("shows remaining usage and reset countdowns in read-only meters for each account", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-19T20:00:00Z"));
		await setup(
			true,
			observed({
				...connected,
				providerAccountUsage: {
					observedAt: new Date().toISOString(),
					windows: [
						{ id: "primary", label: "5-hour limit", usedPercent: 12.5, resetAt: "2026-09-19T23:30:00Z" },
						{ id: "secondary", label: "Weekly limit", usedPercent: 91, resetAt: "2026-09-26T14:00:00Z" },
					],
				},
			}),
		);
		const meters = [...view.el.querySelectorAll<HTMLElement>("[role=meter]")];
		expect(meters.map((meter) => meter.getAttribute("aria-valuenow"))).toEqual(["87.5", "9"]);
		expect(meters[1]!.classList.contains("is-low")).toBe(true);
		expect(meters[1]!.querySelector<HTMLElement>("span")!.style.width).toBe("9%");
		expect(view.el.textContent).toContain("Resets in 6d 18h");
		expect(view.el.textContent).toContain("9% left");
		expect(view.el.textContent).toContain("Resets in 3h 30m");
		expect(view.el.querySelector('[role="slider"], input[type="range"]')).toBeNull();
		expect(meters.map((meter) => meter.getAttribute("aria-label"))).toEqual([
			"5-hour limit remaining usage",
			"Weekly limit remaining usage",
		]);
		// Two bars would look alike, so each carries its name.
		const card = view.el.querySelector(".connection-card")!;
		const labels = [...card.querySelectorAll(".connection-usage-label")];
		expect(labels.map((item) => item.textContent)).toEqual(["5-hour limit", "Weekly limit"]);
		expect(labels.every((item) => item.getAttribute("aria-hidden") === "true")).toBe(true);
		// The check time is on hover only; the card has no date line of its own.
		expect(card.querySelector(`[title="Last checked ${fmtTime(new Date().toISOString())}"]`)?.textContent).toBe(
			"87.5% left",
		);
		expect(card.querySelector(".connection-identity")).toBeNull();
		expect(card.textContent).not.toContain(id(81).slice(-8));
		expect(card.querySelector("[title^='Connection ']")).toBeNull();
	});
	it("ages a snapshot, expires its meter, and preserves focus when time advances", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-19T20:00:00Z"));
		const { client } = await setup(
			true,
			observed({
				...connected,
				sponsorBindingId: id(82),
				sponsorVersion: 1,
				providerAccountUsage: {
					observedAt: new Date().toISOString(),
					windows: [{ id: "primary", label: "5-hour limit", usedPercent: 100, resetAt: "2026-09-19T20:10:00Z" }],
				},
			}),
		);
		action(OPENAI).focus();
		await vi.advanceTimersByTimeAsync(6 * 60_000);
		// An old reading says when it was taken; one bar needs no name.
		expect(view.el.textContent).toContain(`0% at last check · ${fmtTime("2026-09-19T20:00:00.000Z")}`);
		expect(view.el.querySelector(".connection-usage-meter")!.classList.contains("is-stale")).toBe(true);
		expect(view.el.querySelector(".connection-usage-label")).toBeNull();
		expect(view.el.textContent).not.toContain("5-hour limit");
		expect(document.activeElement).toBe(action(OPENAI));
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(view.el.querySelector("[role=meter]")).toBeNull();
		expect(view.el.textContent).toContain("Reset passed");
		expect(view.el.textContent).not.toContain("0%");
		expect(client.listConnections).toHaveBeenCalledTimes(11);
		view.dispose();
		await vi.advanceTimersByTimeAsync(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("refreshes missing usage while visible, pauses hidden requests, and hydrates usage on return", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-19T20:00:00Z"));
		const account = { ...connected, sponsorBindingId: id(82), sponsorVersion: 1 };
		const { client } = await setup(true, observed(account));
		action(OPENAI).focus();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({
				...account,
				providerAccountUsage: {
					observedAt: new Date().toISOString(),
					windows: [{ id: "primary", label: "5-hour limit", usedPercent: 91 }],
				},
			}),
		);
		vi.spyOn(document, "hidden", "get").mockReturnValue(false);
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(client.listConnections).toHaveBeenCalledTimes(3);
		expect(view.el.textContent).toContain("9% left");
		expect(document.activeElement).toBe(action(OPENAI));
		vi.mocked(client.listConnections).mockImplementation(async () =>
			observed({
				...account,
				providerAccountUsage: {
					observedAt: new Date().toISOString(),
					windows: [{ id: "primary", label: "5-hour limit", usedPercent: 95 }],
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(client.listConnections).toHaveBeenCalledTimes(4);
		expect(view.el.textContent).toContain("5% left");
		expect(view.el.textContent).not.toContain("at last check");
	});
	it("shows an active provider usage wall without treating an earlier snapshot as available quota", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-19T20:00:00Z"));
		await setup(
			true,
			observed({
				...connected,
				usageLimitResetAt: "2026-09-19T21:00:00Z",
				providerAccountUsage: {
					observedAt: new Date().toISOString(),
					windows: [{ id: "primary", label: "5-hour limit", usedPercent: 50 }],
				},
			}),
		);
		expect(view.el.textContent).toContain("Usage limit reached · resets in 1h 0m");
		expect(view.el.querySelector("[role=meter]")!.getAttribute("aria-valuetext")).toBe(
			`50% at last check · ${fmtTime("2026-09-19T20:00:00.000Z")}`,
		);
		expect(view.el.textContent).not.toContain("50% left");
		expect(view.el.querySelector(".connection-usage-meter")!.classList.contains("is-stale")).toBe(true);
	});
	it("never shows a reading time later than now when the host's clock runs ahead", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-19T20:00:00Z"));
		await setup(
			true,
			observed({
				...connected,
				providerAccountUsage: {
					observedAt: "2026-09-19T20:10:00.000Z",
					windows: [{ id: "primary", label: "5-hour limit", usedPercent: 8 }],
				},
			}),
		);
		expect(view.el.querySelector("[role=meter]")!.getAttribute("aria-valuetext")).toBe("92% at last check");
	});
	it("refreshes usage from the account projection without losing keyboard focus", async () => {
		const { client } = await setup(true, observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }));
		const refresh = view.el.querySelector<HTMLButtonElement>('[data-focus-key="refresh"]')!;
		refresh.focus();
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({
				...connected,
				sponsorBindingId: id(82),
				sponsorVersion: 1,
				providerAccountUsage: {
					observedAt: new Date().toISOString(),
					windows: [{ id: "primary", label: "5-hour limit", usedPercent: 0 }],
				},
			}),
		);
		refresh.click();
		await settle();
		expect(view.el.querySelector("[role=meter]")!.getAttribute("aria-valuenow")).toBe("100");
		expect(view.el.textContent).toContain("Reset time unavailable");
		expect(document.activeElement).toBe(view.el.querySelector('[data-focus-key="refresh"]'));
	});
	it.each([false, true])(
		"shows only the latest version of an account regardless of response order: %s",
		async (reverse) => {
			const older = {
				...connected,
				providerAccountEmail: "old@example.com",
				sponsorBindingId: id(82),
				sponsorVersion: 1,
			};
			const newer = { ...older, connectionVersion: 3, providerAccountEmail: "current@example.com" };
			await setup(true, observed(...(reverse ? [newer, older] : [older, newer])));
			expect(view.el.querySelectorAll(".connection-card")).toHaveLength(1);
			expect(card(OPENAI).querySelector("small")!.textContent).toBe("current@example.com");
			expect(view.el.textContent).not.toContain("old@example.com");
		},
	);
	it("does not restore an older account version after the latest version was revoked", async () => {
		const older = { ...connected };
		const { client } = await setup(
			true,
			observed(
				{ ...older, connectionVersion: 3, connectionStatus: "revoked", authorizationState: "revoked" },
				older,
			),
		);
		expect(view.el.querySelectorAll(".connection-card")).toHaveLength(0);
		expect(view.el.textContent).not.toContain("member@example.com");
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
	});
	it("signs out only the selected account when several accounts share a provider", async () => {
		const first = { ...connected, sponsorBindingId: id(82), sponsorVersion: 1 };
		const second = { ...first, connectionId: id(83), providerAccountEmail: "second@example.com" };
		const { client } = await setup(true, observed(first, second));
		vi.mocked(client.listConnections).mockResolvedValue(
			observed(first, { ...second, connectionStatus: "revoked", authorizationState: "revoked" }),
		);
		view.el.querySelectorAll<HTMLButtonElement>(".connection-card button")[1]!.click();
		await settle();
		expect(client.revokeConnection).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: second.connectionId },
			expect.any(AbortSignal),
		);
		expect(view.el.querySelectorAll(".connection-card")).toHaveLength(1);
		expect(card(OPENAI).querySelector("small")!.textContent).toBe("member@example.com");
		expect(view.el.textContent).not.toContain("second@example.com");
	});
	it("keeps existing accounts visible while adding another account from the same provider", async () => {
		vi.useFakeTimers();
		const first = { ...connected, sponsorBindingId: id(82), sponsorVersion: 1 };
		const { client } = await setup(true, observed(first));
		addAccount(OPENAI);
		await settle();
		expect(view.el.querySelectorAll(".connection-card:not(.connection-attempt)")).toHaveLength(1);
		expect(card(OPENAI).querySelector("small")!.textContent).toBe("member@example.com");
		expect(action(OPENAI).textContent).toBe("Sign out");
		expect(view.el.querySelector(".connection-attempt .connection-sign-in")).not.toBeNull();
		const target = loginIds(client, 0).clientConnectionId;
		vi.mocked(client.listConnections).mockResolvedValue(
			observed(first, {
				...first,
				connectionId: id(182),
				clientConnectionId: target,
				providerAccountEmail: "second@example.com",
			}),
		);
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(view.el.querySelector(".connection-attempt")).toBeNull();
		expect([...view.el.querySelectorAll(".connection-email")].map((item) => item.textContent)).toEqual([
			"member@example.com",
			"second@example.com",
		]);
		expect(client.revokeConnection).not.toHaveBeenCalled();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
	});
	it("shows the checked state of each account", async () => {
		const pending = deferred<NativeExecutionConnections>();
		const lifetime = new AbortController();
		view = new ConnectionsView(
			{
				listConnections: vi.fn(() => pending.promise),
				revokeConnection: vi.fn(),
				createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
				onboardingAvailable: true,
				beginProviderLogin: vi.fn(),
			},
			lifetime.signal,
		);
		document.body.append(view.el);
		expect(view.el.textContent).toContain("Checking");
		expect(view.el.querySelector<HTMLButtonElement>(".connection-add")!.disabled).toBe(true);
		pending.resolve(
			observed(connected, {
				...connected,
				connectionId: id(83),
				provider: "anthropic",
				nativeHarness: "claude-code",
				authorizationState: "reauthentication_required",
			}),
		);
		await settle();
		expect(card(OPENAI).querySelector("small")!.textContent).toBe("member@example.com");
		expect(action(OPENAI).textContent).toBe("Sign out");
		expect(card(CLAUDE).textContent).toContain("Sign out and add this account again to reconnect.");
		expect(card(CLAUDE).textContent).not.toContain("Added");
		expect([...card(CLAUDE).querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Sign out"]);
		expect(action(CLAUDE).disabled).toBe(false);
	});
	it.each([
		["OpenAI", "openai", OPENAI],
		["Anthropic", "anthropic", CLAUDE],
	] as const)("starts %s only on an explicit action with fresh admission IDs", async (name, provider, label) => {
		const { client } = await setup(true, observed());
		expect(view.el.querySelectorAll(".connection-card")).toHaveLength(0);
		expect(client.beginProviderLogin).not.toHaveBeenCalled();
		const add = view.el.querySelector<HTMLButtonElement>(".connection-add")!;
		expect(add.getAttribute("aria-expanded")).toBe("false");
		add.click();
		expect(view.el.querySelector(".connection-add")!.getAttribute("aria-expanded")).toBe("true");
		const providers = [...view.el.querySelectorAll<HTMLButtonElement>(".connection-provider-picker button")];
		expect(providers.map((item) => item.textContent)).toEqual([OPENAI, CLAUDE]);
		for (const item of providers) expect(item.querySelector("img")).not.toBeNull();
		expect(client.beginProviderLogin).not.toHaveBeenCalled();
		providers.find((item) => item.textContent === label)!.click();
		expect(view.el.querySelector<HTMLElement>(".connection-provider-picker")!.hidden).toBe(true);
		expect(status(label)).toBe("Preparing sign-in. The first time can take a minute or two.");
		expect(action(label).textContent).toBe("Connecting…");
		expect(action(label).disabled).toBe(true);
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
		// A start belongs to the member, not to this page: it is not given the page's signal.
		expect(vi.mocked(client.beginProviderLogin).mock.calls[0]).toHaveLength(1);
		const input = vi.mocked(client.beginProviderLogin).mock.calls[0]![0];
		expect(input).toMatchObject({ provider, displayName: "My model account" });
		expect(new Set(Object.values(loginIds(client, 0))).size).toBe(3);
		expect(status(label)).toBe("Waiting for you to finish signing in…");
		expect(action(label).textContent).toBe("Cancel");
		expect(view.el.querySelectorAll(".connection-sign-in")).toHaveLength(1);
		const prompt = card(label).querySelector(".connection-sign-in")!;
		expect(prompt.querySelector("p")!.textContent).toBe("Your code: ABCD-EFGH");
		const link = prompt.querySelector<HTMLAnchorElement>("a")!;
		expect(link.textContent).toBe(`Open ${name} sign-in`);
		expect(link.href).toBe(`https://auth.${provider}.com/device`);
		expect(link.target).toBe("_blank");
		expect(link.rel).toBe("noopener noreferrer");
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
	});
	it("watches an open sign-in and enables the finished connection for the member's messages", async () => {
		vi.useFakeTimers();
		const { client } = await setup(true, observed());
		addAccount(OPENAI);
		await settle();
		const target = loginIds(client, 0).clientConnectionId;
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(WATCH_MS - 1);
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(client.listConnections).toHaveBeenCalledTimes(3);
		expect(card(OPENAI).querySelector(".connection-sign-in")).not.toBeNull();
		// Another account finishing is not this sign-in.
		vi.mocked(client.listConnections).mockResolvedValueOnce(
			observed({ ...connected, provider: "anthropic", sponsorBindingId: id(84), sponsorVersion: 1 }),
		);
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(status(OPENAI)).toBe("Waiting for you to finish signing in…");
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
		vi.mocked(client.listConnections).mockResolvedValueOnce(
			observed({ ...connected, connectionId: id(182), clientConnectionId: target }),
		);
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({
				...connected,
				connectionId: id(182),
				clientConnectionId: target,
				sponsorBindingId: id(82),
				sponsorVersion: 1,
			}),
		);
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(view.el.querySelector(".connection-sign-in")).toBeNull();
		expect(card(OPENAI).querySelector("small")!.textContent).toBe("member@example.com");
		expect(action(OPENAI).textContent).toBe("Sign out");
		expect(client.createMemberSponsor).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: id(182), providerConnectionVersion: 2, allowAutonomous: false },
			expect.any(AbortSignal),
		);
		// Enabling re-reads once; with no sign-in open the page stops watching.
		expect(client.listConnections).toHaveBeenCalledTimes(6);
		await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
		expect(client.listConnections).toHaveBeenCalledTimes(6);
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
	});
	it("correlates completion with the exact provider and client ID, then displays the provider email", async () => {
		vi.useFakeTimers();
		const signIns = new ProviderSignIns();
		const { client } = await setup(true, observed(), signIns);
		addAccount(OPENAI);
		await settle();
		const target = loginIds(client, 0).clientConnectionId;
		const unrelated = { ...connected, connectionId: target, sponsorBindingId: id(82), sponsorVersion: 1 };
		vi.mocked(client.listConnections).mockResolvedValue(observed(unrelated));
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(view.el.querySelector(".connection-sign-in")).not.toBeNull();
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({ ...unrelated, provider: "anthropic", nativeHarness: "claude-code", clientConnectionId: target }),
		);
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(view.el.querySelector(".connection-sign-in")).not.toBeNull();
		const matching = {
			...connected,
			connectionId: id(182),
			clientConnectionId: target,
			providerAccountReference: "codex-cli:opaque-account",
			providerAccountEmail: "signed-in@example.com",
			sponsorBindingId: id(183),
			sponsorVersion: 1,
		};
		vi.mocked(client.listConnections).mockResolvedValue(
			observed(unrelated, { ...matching, authorizationState: "reauthentication_required" }),
		);
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(view.el.querySelector(".connection-sign-in")).not.toBeNull();
		expect(view.el.querySelectorAll(".connection-card:not(.connection-attempt)")).toHaveLength(1);
		view.el.querySelector<HTMLAnchorElement>(".connection-sign-in a")!.focus();
		vi.mocked(client.listConnections).mockResolvedValue(observed(unrelated, matching));
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(view.el.querySelector(".connection-attempt")).toBeNull();
		expect(view.el.textContent).toContain("signed-in@example.com");
		expect(view.el.textContent).not.toContain("Email unavailable");
		expect(signIns.attempts.size).toBe(0);
		expect(document.activeElement).toBe(view.el.querySelector(".connection-add"));
		const reads = vi.mocked(client.listConnections).mock.calls.length;
		await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
		expect(client.listConnections).toHaveBeenCalledTimes(reads);
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
	});
	it.each(["focus", "visibilitychange"])(
		"checks completion immediately on %s when returning from sign-in",
		async (event) => {
			vi.useFakeTimers();
			const { client, lifetime } = await setup(true, observed());
			addAccount(OPENAI);
			await settle();
			vi.mocked(client.listConnections).mockResolvedValue(
				observed({
					...connected,
					clientConnectionId: loginIds(client, 0).clientConnectionId,
					sponsorBindingId: id(82),
					sponsorVersion: 1,
				}),
			);
			const target = event === "focus" ? window : document;
			target.dispatchEvent(new Event(event));
			await settle();
			expect(view.el.querySelector(".connection-attempt")).toBeNull();
			expect(view.el.textContent).toContain("member@example.com");
			expect(client.listConnections).toHaveBeenCalledTimes(3);
			target.dispatchEvent(new Event(event));
			await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
			expect(client.listConnections).toHaveBeenCalledTimes(4);
			lifetime.abort();
			target.dispatchEvent(new Event(event));
			await settle();
			expect(client.listConnections).toHaveBeenCalledTimes(4);
		},
	);
	it("coalesces changes during a slow read and observes both completed sign-ins without overlapping reads", async () => {
		vi.useFakeTimers();
		const { client } = await setup(true, observed());
		const earlier = deferred<NativeExecutionConnections>();
		vi.mocked(client.listConnections).mockReturnValueOnce(earlier.promise);
		addAccount(OPENAI);
		await settle();
		addAccount(CLAUDE);
		await settle();
		window.dispatchEvent(new Event("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		vi.mocked(client.listConnections).mockResolvedValue(
			observed(
				{
					...connected,
					clientConnectionId: loginIds(client, 0).clientConnectionId,
					sponsorBindingId: id(82),
					sponsorVersion: 1,
				},
				{
					...connected,
					connectionId: id(84),
					provider: "anthropic",
					nativeHarness: "claude-code",
					clientConnectionId: loginIds(client, 1).clientConnectionId,
					sponsorBindingId: id(85),
					sponsorVersion: 1,
				},
			),
		);
		earlier.resolve(observed());
		await settle();
		expect(client.listConnections).toHaveBeenCalledTimes(3);
		expect(view.el.querySelectorAll(".connection-attempt")).toHaveLength(0);
		expect(view.el.querySelectorAll(".connection-card")).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
		expect(client.listConnections).toHaveBeenCalledTimes(3);
		expect(view.el.querySelectorAll(".connection-card")).toHaveLength(2);
	});
	it("never replays a start: every explicit account addition is a new sign-in with its own IDs", async () => {
		const { client } = await setup(true, observed());
		vi.mocked(client.beginProviderLogin).mockRejectedValueOnce(new Error("Unknown admission result"));
		const original = addAccount(OPENAI);
		original.click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
		expect(status(OPENAI)).toBe(START_FAILED);
		expect(view.el.querySelector(".connection-sign-in")).toBeNull();
		expect(action(OPENAI).textContent).toBe("Try again");
		expect(action(OPENAI).disabled).toBe(false);
		action(OPENAI).click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(2);
		expect(status(OPENAI)).toBe("Waiting for you to finish signing in…");
		// The other provider is its own sign-in.
		addAccount(CLAUDE);
		await settle();
		expect(view.el.querySelectorAll(".connection-sign-in")).toHaveLength(2);
		action(OPENAI).click();
		expect(view.el.querySelectorAll(".connection-sign-in")).toHaveLength(1);
		expect(card(OPENAI)).toBeUndefined();
		expect(status(CLAUDE)).toBe("Waiting for you to finish signing in…");
		addAccount(OPENAI);
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(4);
		const used = [0, 1, 2, 3].flatMap((call) => Object.values(loginIds(client, call)));
		expect(new Set(used).size).toBe(12);
	});
	it("removes an expired sign-in on the next read and uses new IDs for the next attempt", async () => {
		vi.useFakeTimers();
		const { client } = await setup(true, observed());
		addAccount(OPENAI);
		await settle();
		await vi.advanceTimersByTimeAsync(55_000);
		expect(card(OPENAI).querySelector(".connection-sign-in")).not.toBeNull();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(view.el.querySelector(".connection-sign-in")).toBeNull();
		expect(card(OPENAI)).toBeUndefined();
		expect(view.el.querySelector<HTMLButtonElement>(".connection-add")!.disabled).toBe(false);
		const reads = vi.mocked(client.listConnections).mock.calls.length;
		await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
		expect(client.listConnections).toHaveBeenCalledTimes(reads);
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
		addAccount(OPENAI);
		await settle();
		const first = loginIds(client, 0);
		const renewed = loginIds(client, 1);
		for (const key of ID_KEYS) expect(renewed[key]).not.toBe(first[key]);
	});
	it("does not draw or read for a late sign-in response after company/account teardown", async () => {
		const signIns = new ProviderSignIns();
		const { client, lifetime } = await setup(true, observed(), signIns);
		const pending = deferred<WebNativeProviderLogin>();
		vi.mocked(client.beginProviderLogin).mockReturnValueOnce(pending.promise);
		addAccount(OPENAI);
		const [input] = vi.mocked(client.beginProviderLogin).mock.calls[0]!;
		lifetime.abort();
		expect(view.el.textContent).toBe("");
		pending.resolve({
			loginId: input.clientLoginId,
			clientConnectionId: input.clientConnectionId,
			status: "awaiting_member",
			interactionUrl: "https://auth.openai.com/device",
			userCode: "PRIVATE-CODE",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await settle();
		expect(view.el.textContent).toBe("");
		expect(document.querySelector(".connection-sign-in")).toBeNull();
		expect(document.body.textContent).not.toContain("PRIVATE-CODE");
		expect(client.listConnections).toHaveBeenCalledTimes(1);
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
		// The member's sign-in itself is kept for whichever page opens next.
		expect(signIns.attempts.get("openai")).toMatchObject({ starting: false, login: { userCode: "PRIVATE-CODE" } });
	});
	it("picks up an in-flight sign-in and its prompt in a rebuilt page sharing the same sign-ins", async () => {
		const signIns = new ProviderSignIns();
		const first = await setup(true, observed(), signIns);
		const pending = deferred<WebNativeProviderLogin>();
		vi.mocked(first.client.beginProviderLogin).mockReturnValueOnce(pending.promise);
		addAccount(OPENAI);
		const [input] = vi.mocked(first.client.beginProviderLogin).mock.calls[0]!;
		first.lifetime.abort();
		const closed = view;
		const rebuilt = await setup(true, observed(), signIns);
		expect(status(OPENAI)).toBe("Preparing sign-in. The first time can take a minute or two.");
		expect(action(OPENAI).textContent).toBe("Connecting…");
		expect(action(OPENAI).disabled).toBe(true);
		action(OPENAI).click();
		expect(card(CLAUDE)).toBeUndefined();
		expect(rebuilt.client.listConnections).toHaveBeenCalledTimes(1);
		pending.resolve({
			loginId: input.clientLoginId,
			clientConnectionId: input.clientConnectionId,
			status: "awaiting_member",
			interactionUrl: "https://auth.openai.com/device",
			userCode: "ABCD-EFGH",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await settle();
		expect(status(OPENAI)).toBe("Waiting for you to finish signing in…");
		expect(action(OPENAI).textContent).toBe("Cancel");
		const prompt = card(OPENAI).querySelector(".connection-sign-in")!;
		expect(prompt.querySelector("code")!.textContent).toBe("ABCD-EFGH");
		expect(prompt.querySelector<HTMLAnchorElement>("a")!.href).toBe("https://auth.openai.com/device");
		// The open page starts watching for completion; the closed one stays empty and silent.
		expect(rebuilt.client.listConnections).toHaveBeenCalledTimes(2);
		expect(first.client.listConnections).toHaveBeenCalledTimes(1);
		expect(closed.el.textContent).toBe("");
		expect(first.client.beginProviderLogin).toHaveBeenCalledTimes(1);
		expect(rebuilt.client.beginProviderLogin).not.toHaveBeenCalled();
	});
	it("shows an already open sign-in in a rebuilt page and watches it from there", async () => {
		vi.useFakeTimers();
		const signIns = new ProviderSignIns();
		const first = await setup(true, observed(), signIns);
		addAccount(CLAUDE);
		await settle();
		first.lifetime.abort();
		const rebuilt = await setup(true, observed(), signIns);
		expect(card(CLAUDE).querySelector(".connection-sign-in a")!.textContent).toBe("Open Anthropic sign-in");
		const reads = vi.mocked(first.client.listConnections).mock.calls.length;
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(rebuilt.client.listConnections).toHaveBeenCalledTimes(2);
		expect(first.client.listConnections).toHaveBeenCalledTimes(reads);
		action(CLAUDE).click();
		expect(view.el.querySelector(".connection-sign-in")).toBeNull();
		expect(signIns.attempts.size).toBe(0);
	});
	it("stops watching an open sign-in on teardown", async () => {
		vi.useFakeTimers();
		const { client, lifetime } = await setup(true, observed());
		addAccount(OPENAI);
		await settle();
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		lifetime.abort();
		await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
		expect(vi.getTimerCount()).toBe(0);
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		expect(view.el.textContent).toBe("");
		expect(document.querySelector(".connection-sign-in")).toBeNull();
	});
	it("keeps keyboard focus on the provider sign-in link across polling", async () => {
		vi.useFakeTimers();
		const { client } = await setup(true, observed());
		addAccount(OPENAI);
		await settle();
		view.el.querySelector<HTMLAnchorElement>(".connection-sign-in a")!.focus();
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(client.listConnections).toHaveBeenCalledTimes(3);
		expect(document.activeElement).toBe(view.el.querySelector(".connection-sign-in a"));
	});
	it("enables a connected account for member messages once per connection version", async () => {
		vi.useFakeTimers();
		const { client } = await setup(true);
		expect(client.createMemberSponsor).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: id(81), providerConnectionVersion: 2, allowAutonomous: false },
			expect.any(AbortSignal),
		);
		expect(vi.mocked(client.createMemberSponsor).mock.calls[0]![0]).not.toHaveProperty("clientBindingId");
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		expect(card(OPENAI).querySelector("small")!.textContent).toBe("member@example.com");
		// Later reads of the same version do not enable it again.
		addAccount(CLAUDE);
		await settle();
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(client.createMemberSponsor).toHaveBeenCalledTimes(1);
		vi.mocked(client.listConnections).mockResolvedValue(observed({ ...connected, connectionVersion: 3 }));
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(client.createMemberSponsor).toHaveBeenCalledTimes(2);
		expect(vi.mocked(client.createMemberSponsor).mock.calls[1]![0]).toEqual({
			providerConnectionId: id(81),
			providerConnectionVersion: 3,
			allowAutonomous: false,
		});
		expect(client.revokeConnection).not.toHaveBeenCalled();
	});
	it("keeps showing the account as connected when enabling fails, without retrying", async () => {
		const lifetime = new AbortController();
		const createMemberSponsor = vi.fn(async () => {
			throw new Error("lost reply");
		});
		const listConnections = vi.fn(async () => observed(connected));
		view = new ConnectionsView({ listConnections, revokeConnection: vi.fn(), createMemberSponsor }, lifetime.signal);
		document.body.append(view.el);
		await settle();
		expect(createMemberSponsor).toHaveBeenCalledTimes(1);
		expect(listConnections).toHaveBeenCalledTimes(1);
		expect(card(OPENAI).querySelector("small")!.textContent).toBe("member@example.com");
		expect(view.el.querySelector("p[role=status]")).toBeNull();
	});
	it.each([
		["already enabled", observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 })],
		["needing a new sign-in", observed({ ...connected, authorizationState: "reauthentication_required" })],
		["disabled", observed({ ...connected, connectionStatus: "disabled" })],
		["revoked", observed({ ...connected, connectionStatus: "revoked", authorizationState: "revoked" })],
		[
			"switched off by policy",
			observed({ ...connected, policy: { ...connected.policy, enablementStatus: "disabled" } }),
		],
		[
			"not supported yet",
			observed({ ...connected, policy: { ...connected.policy, implementationStatus: "planned" } }),
		],
		[
			"on a disabled computer",
			{ ...observed(connected), computeIdentity: { ...observed().computeIdentity!, status: "disabled" as const } },
		],
		["without a computer", { connections: [connected] }],
	])("does not enable an account that is %s", async (_case, initial) => {
		const { client } = await setup(true, initial);
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
		expect(client.listConnections).toHaveBeenCalledTimes(1);
	});
	it("disconnects the account once and reads the result", async () => {
		const { client } = await setup(true, observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }));
		const pending = deferred<{ connectionId: string; status: "revoked" }>();
		vi.mocked(client.revokeConnection).mockReturnValueOnce(pending.promise);
		const disconnect = action(OPENAI);
		disconnect.click();
		disconnect.click();
		expect(action(OPENAI).textContent).toBe("Signing out…");
		expect(action(OPENAI).disabled).toBe(true);
		action(OPENAI).click();
		expect(client.revokeConnection).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: id(81) },
			expect.any(AbortSignal),
		);
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({ ...connected, connectionStatus: "revoked", authorizationState: "revoked" }),
		);
		pending.resolve({ connectionId: id(81), status: "revoked" });
		await settle();
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		expect(card(OPENAI)).toBeUndefined();
		expect(view.el.querySelector<HTMLButtonElement>(".connection-add")!.disabled).toBe(false);
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
	});
	it("reads the account again after an uncertain disconnect instead of guessing", async () => {
		const { client } = await setup(true, observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }));
		vi.mocked(client.revokeConnection).mockRejectedValueOnce(new Error("lost reply"));
		action(OPENAI).click();
		await settle();
		expect(client.revokeConnection).toHaveBeenCalledTimes(1);
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		expect(card(OPENAI).querySelector("small")!.textContent).toBe("member@example.com");
		expect(view.el.querySelector("p[role=status]")!.textContent).toContain("The account could not be disconnected.");
		// The lost reply had in fact disconnected it: the next read shows that and says nothing more.
		vi.mocked(client.revokeConnection).mockRejectedValueOnce(new Error("lost reply"));
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({ ...connected, connectionStatus: "revoked", authorizationState: "revoked" }),
		);
		action(OPENAI).click();
		await settle();
		expect(client.revokeConnection).toHaveBeenCalledTimes(2);
		expect(card(OPENAI)).toBeUndefined();
		expect(view.el.querySelector("p[role=status]")).toBeNull();
	});
	it("reports a failed sign-out when an account needing reauthentication remains connected", async () => {
		const { client } = await setup(true, observed({ ...connected, authorizationState: "reauthentication_required" }));
		vi.mocked(client.revokeConnection).mockRejectedValueOnce(new Error("lost reply"));
		action(OPENAI).click();
		await settle();
		expect(client.revokeConnection).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: connected.connectionId },
			expect.any(AbortSignal),
		);
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		expect(card(OPENAI).querySelector("small")!.textContent).toBe("member@example.com");
		expect(action(OPENAI).textContent).toBe("Sign out");
		expect(action(OPENAI).disabled).toBe(false);
		expect(view.el.querySelector("p[role=status]")!.textContent).toContain("The account could not be disconnected.");
		expect(client.beginProviderLogin).not.toHaveBeenCalled();
	});
	it("offers another read when the accounts could not be read", async () => {
		const lifetime = new AbortController();
		const listConnections = vi.fn(async () => observed());
		listConnections.mockRejectedValueOnce(new Error("offline"));
		view = new ConnectionsView(
			{ listConnections, revokeConnection: vi.fn(), createMemberSponsor: vi.fn(), onboardingAvailable: true },
			lifetime.signal,
		);
		document.body.append(view.el);
		await settle();
		expect(view.el.querySelector("p[role=status]")!.textContent).toContain("Your model accounts could not be read.");
		[...view.el.querySelectorAll("button")].find((item) => item.textContent === "Try again")!.click();
		await settle();
		expect(listConnections).toHaveBeenCalledTimes(2);
		expect(view.el.querySelector("p[role=status]")).toBeNull();
		expect(view.el.querySelector<HTMLButtonElement>(".connection-add")!.disabled).toBe(true);
	});
	it("aborts and discards a response when the selected company closes", async () => {
		const pending = deferred<NativeExecutionConnections>();
		const lifetime = new AbortController();
		const listConnections = vi.fn((_signal?: AbortSignal) => pending.promise);
		const createMemberSponsor = vi.fn();
		const revokeConnection = vi.fn();
		view = new ConnectionsView({ listConnections, revokeConnection, createMemberSponsor }, lifetime.signal);
		document.body.append(view.el);
		lifetime.abort();
		pending.resolve(observed(connected));
		await settle();
		expect(view.el.textContent).toBe("");
		expect(listConnections.mock.calls[0]![0]!.aborted).toBe(true);
		expect(createMemberSponsor).not.toHaveBeenCalled();
		expect(revokeConnection).not.toHaveBeenCalled();
	});
});

describe("a ChatGPT plan login (shown only when the member has one)", () => {
	const plan: WebMemberConnection = {
		...connected,
		connectionId: id(85),
		clientConnectionId: id(185),
		loginKind: "chatgpt_plan",
		allowAutonomous: false,
	};
	async function planSetup(...items: WebMemberConnection[]) {
		let current = observed(...items) as WebExecutionConnections;
		const client = {
			listConnections: vi.fn(async () => structuredClone(current)),
			revokeConnection: vi.fn(async () => ({ connectionId: id(85), status: "revoked" as const })),
			createMemberSponsor: vi.fn(async () => ({ bindingId: id(86), version: 1 })),
			setWorkWhileAway: vi.fn(async () => {}),
		};
		view = new ConnectionsView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		const set = (next: WebMemberConnection[]) => {
			current = observed(...next) as WebExecutionConnections;
		};
		return { client, set };
	}
	const lever = () => view.el.querySelector<HTMLButtonElement>('.connection-away [role="switch"]');
	it("leaves a Codex login as it was: its label, no switch, consented as before", async () => {
		const { client } = await planSetup({ ...connected, loginKind: "codex", allowAutonomous: true });
		expect(card(OPENAI)).toBeTruthy();
		expect(lever()).toBeNull();
		expect(client.createMemberSponsor).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: id(81), providerConnectionVersion: 2, allowAutonomous: false },
			expect.any(AbortSignal),
		);
	});
	it("names the plan, binds it for the member's messages only, and leaves work while away to the member", async () => {
		const { client, set } = await planSetup(plan);
		expect(card("ChatGPT plan")).toBeTruthy();
		expect(client.createMemberSponsor).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: id(85), providerConnectionVersion: 2, allowAutonomous: false, planLogin: true },
			expect.any(AbortSignal),
		);
		expect(lever()!.getAttribute("aria-checked")).toBe("false");
		expect(client.setWorkWhileAway).not.toHaveBeenCalled();
		set([{ ...plan, allowAutonomous: true, sponsorBindingId: id(86), sponsorVersion: 1 }]);
		lever()!.click();
		await settle();
		expect(client.setWorkWhileAway).toHaveBeenCalledExactlyOnceWith(id(85), true, expect.any(AbortSignal));
		expect(lever()!.getAttribute("aria-checked")).toBe("true");
		lever()!.click();
		await settle();
		expect(client.setWorkWhileAway).toHaveBeenLastCalledWith(id(85), false, expect.any(AbortSignal));
	});
	it("says when the switch could not move, after reading back where it stands", async () => {
		const { client } = await planSetup(plan);
		const reads = client.listConnections.mock.calls.length;
		client.setWorkWhileAway.mockRejectedValueOnce(new Error("offline"));
		lever()!.click();
		await settle();
		// Part of a failed change may have landed: the cloud's state is read back first.
		expect(client.listConnections.mock.calls.length).toBe(reads + 1);
		expect(view.el.textContent).toContain("“Work while you're away” could not be changed. Try again.");
		expect(lever()!.getAttribute("aria-checked")).toBe("false");
		// A busy switch says so, in plain words, also after reading back where it stands.
		client.setWorkWhileAway.mockRejectedValueOnce(new PlanSwitchBusyError());
		lever()!.click();
		await settle();
		expect(client.listConnections.mock.calls.length).toBe(reads + 2);
		expect(view.el.textContent).toContain("Busy right now. Try again in a moment.");
		expect(view.el.textContent).not.toContain("could not be changed");
	});
	it("stays busy until the change is read back, so a second press sends nothing", async () => {
		const { client, set } = await planSetup(plan);
		const change = deferred<void>();
		client.setWorkWhileAway.mockImplementationOnce(() => change.promise);
		lever()!.click();
		await settle();
		expect(lever()!.getAttribute("aria-busy")).toBe("true");
		expect(lever()!.getAttribute("aria-disabled")).toBe("true");
		const read = deferred<WebExecutionConnections>();
		client.listConnections.mockImplementationOnce(() => read.promise);
		set([{ ...plan, allowAutonomous: true }]);
		change.resolve();
		await settle();
		// Changed, but not read back yet: still busy, and a press does nothing.
		expect(lever()!.getAttribute("aria-busy")).toBe("true");
		lever()!.click();
		await settle();
		expect(client.setWorkWhileAway).toHaveBeenCalledTimes(1);
		const turnedOn: WebMemberConnection = { ...plan, allowAutonomous: true };
		read.resolve(observed(turnedOn) as WebExecutionConnections);
		await settle();
		expect(lever()!.getAttribute("aria-checked")).toBe("true");
		expect(lever()!.hasAttribute("aria-busy")).toBe(false);
	});
	it("shows no switch for a plan that needs a new sign-in", async () => {
		await planSetup({ ...plan, authorizationState: "reauthentication_required" });
		expect(lever()).toBeNull();
	});
});

describe("Continue with ChatGPT (offered only while the company may use plan logins)", () => {
	const url = "https://auth.openai.com/oauth/authorize?state=fixture";
	const route = `#/c/${id(10)}/chat/${id(11)}`;
	const signIn = {
		companyId: id(10),
		memberId: userA.id,
		loginId: id(105),
		clientConnectionId: id(103),
		capability: "c".repeat(43),
		expiresAt: timestamp,
		startedAt: Date.now(),
	};
	const kept = () => sessionStorage.getItem("qorpera.chatgpt-plan-sign-in.v1");
	async function signInSetup(
		available: boolean,
		{
			plan = new PlanSignIn(),
			offered,
			items = [connected],
		}: { plan?: PlanSignIn | null; offered?: ("openai" | "anthropic")[]; items?: WebMemberConnection[] } = {},
	) {
		const client = {
			listConnections: vi.fn(async () => observed(...items)),
			revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
			createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
			onboardingAvailable: true,
			beginProviderLogin: vi.fn(),
			chatGptPlanAvailable: vi.fn(async () => available),
			beginChatGptPlanSignIn: vi.fn(async () => ({ url, signIn })),
		};
		const navigate = vi.fn();
		view = new ConnectionsView(
			client,
			new AbortController().signal,
			undefined,
			undefined,
			offered,
			navigate,
			plan ?? undefined,
		);
		document.body.append(view.el);
		await settle();
		return { client, navigate };
	}
	const choice = () =>
		[...view.el.querySelectorAll<HTMLButtonElement>(".connection-provider-picker button")].find(
			(item) => item.textContent === "Continue with ChatGPT",
		);
	const status = () => view.el.querySelector(".connection-plan")?.textContent;
	async function openAdd() {
		view.el.querySelector<HTMLButtonElement>(".connection-add")!.click();
		await settle();
	}
	afterEach(() => {
		sessionStorage.clear();
		history.replaceState(null, "", "/#/");
	});
	it("is not offered while the company may not use plan logins", async () => {
		const { client } = await signInSetup(false);
		expect(client.chatGptPlanAvailable).not.toHaveBeenCalled();
		await openAdd();
		expect(client.chatGptPlanAvailable).toHaveBeenCalledOnce();
		expect(view.el.querySelector(".connection-provider-picker")?.textContent).toContain(OPENAI);
		expect(choice()).toBeUndefined();
	});
	it("is offered only where its return is finished: never on a page without the member's plan sign-in", async () => {
		for (const setup of [{ plan: null }, { offered: ["anthropic" as const] }]) {
			const { client } = await signInSetup(true, setup);
			await openAdd();
			expect(client.chatGptPlanAvailable).not.toHaveBeenCalled();
			expect(choice()).toBeUndefined();
			view.dispose();
		}
	});
	it("is not offered beside a signed-in ChatGPT plan", async () => {
		const plan: WebMemberConnection = { ...connected, loginKind: "chatgpt_plan", allowAutonomous: false };
		await signInSetup(true, { items: [plan] });
		await openAdd();
		expect(choice()).toBeUndefined();
		view.dispose();
		await signInSetup(true, { items: [{ ...plan, authorizationState: "reauthentication_required" }] });
		await openAdd();
		expect(choice()).toBeTruthy();
	});
	it("starts the sign-in, keeps it with the page it began on, and sends the browser to OpenAI", async () => {
		history.replaceState(null, "", `/${route}`);
		const { client, navigate } = await signInSetup(true);
		await openAdd();
		const begin = deferred<{ url: string; signIn: typeof signIn }>();
		client.beginChatGptPlanSignIn.mockReturnValueOnce(begin.promise);
		choice()!.click();
		await settle();
		// One sign-in at a time.
		expect(status()).toBe("Opening ChatGPT…");
		await openAdd();
		expect(choice()!.disabled).toBe(true);
		choice()!.click();
		begin.resolve({ url, signIn });
		await settle();
		expect(client.beginChatGptPlanSignIn).toHaveBeenCalledOnce();
		expect(JSON.parse(kept()!)).toEqual({ ...signIn, returnRoute: route });
		expect(navigate).toHaveBeenCalledExactlyOnceWith(url);
	});
	it("does not go to OpenAI when this tab cannot keep the sign-in", async () => {
		const { navigate } = await signInSetup(true);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		await openAdd();
		choice()!.click();
		await settle();
		expect(navigate).not.toHaveBeenCalled();
		expect(status()).toBe("The ChatGPT sign-in could not be started. Try again.");
	});
	it("can start again after the browser comes back from OpenAI's page through its page cache", async () => {
		await signInSetup(true);
		await openAdd();
		choice()!.click();
		await settle();
		expect(status()).toBe("Opening ChatGPT…");
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		expect(status()).toBeUndefined();
		await openAdd();
		expect(choice()!.disabled).toBe(false);
	});
	it("says why a sign-in could not start", async () => {
		const { client, navigate } = await signInSetup(true);
		client.beginChatGptPlanSignIn.mockRejectedValueOnce(new ChatGptPlanSignInError("other_plan"));
		await openAdd();
		choice()!.click();
		await settle();
		expect(status()).toBe("Disconnect your other ChatGPT plan first.");
		expect(navigate).not.toHaveBeenCalled();
		expect(kept()).toBeNull();
	});
	it("drops the capability before the confirm, shows it finishing, then the outcome once, and reads the accounts again", async () => {
		sessionStorage.setItem("qorpera.chatgpt-plan-sign-in.v1", JSON.stringify({ ...signIn, returnRoute: route }));
		const plan = new PlanSignIn();
		const { client } = await signInSetup(true, { plan });
		const confirm = deferred<void>();
		const finish = vi.fn(() => confirm.promise);
		const outcome = {
			outcome: "confirm" as const,
			confirmation: "d".repeat(43),
			signIn: { ...signIn, returnRoute: route },
		};
		const finishing = finishPlanSignIn(plan, { finishChatGptPlanSignIn: finish }, outcome);
		expect(kept()).toBeNull();
		expect(finish).toHaveBeenCalledExactlyOnceWith(outcome);
		await settle();
		expect(status()).toBe("Finishing your ChatGPT sign-in…");
		await openAdd();
		expect(choice()!.disabled).toBe(true);
		// A second return while one finishes is dropped.
		await finishPlanSignIn(plan, { finishChatGptPlanSignIn: finish }, outcome);
		expect(finish).toHaveBeenCalledOnce();
		const reads = client.listConnections.mock.calls.length;
		confirm.resolve();
		await finishing;
		await settle();
		expect(status()).toBe("Your ChatGPT plan is connected.");
		expect(client.listConnections).toHaveBeenCalledTimes(reads + 1);
		expect(plan.result).toBeUndefined();
	});
	it("keeps the outcome for a later page when none was open, and shows it there once", async () => {
		const plan = memberPlanSignIn(userA.id, id(10));
		await finishPlanSignIn(
			plan,
			{
				finishChatGptPlanSignIn: async () => {
					throw new ChatGptPlanSignInError("declined");
				},
			},
			{ outcome: "failed", reason: "declined", signIn: { ...signIn, returnRoute: route } },
		);
		// Another company's page does not take it.
		await signInSetup(true, { plan: memberPlanSignIn(userA.id, id(12)) });
		expect(status()).toBeUndefined();
		view.dispose();
		await signInSetup(true, { plan: memberPlanSignIn(userA.id, id(10)) });
		expect(status()).toBe("The ChatGPT sign-in was cancelled.");
		view.dispose();
		await signInSetup(true, { plan: memberPlanSignIn(userA.id, id(10)) });
		expect(status()).toBeUndefined();
	});
});

describe("account model logins", () => {
	/** A Codex login the member signed in to once, used in all their companies (20260930548000). */
	const account = { loginId: id(90), status: "active" as const, companies: 2, connectionIds: [id(81)] };
	const linked = { ...connected, sponsorBindingId: id(82), sponsorVersion: 1 };
	async function setupAccount(
		listAccountLogins: WebNativeSubscription["listAccountLogins"] = vi.fn(async () => ({
			enabled: true,
			logins: [account],
		})),
	) {
		const client = {
			listConnections: vi.fn(async () => structuredClone(observed(linked))),
			revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
			createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
			listAccountLogins,
			signOutEverywhere: vi.fn(async () => undefined),
		};
		const lifetime = new AbortController();
		view = new ConnectionsView(client, lifetime.signal);
		document.body.append(view.el);
		await settle();
		return client;
	}
	const buttons = () => [...card(OPENAI).querySelectorAll<HTMLButtonElement>("button")];

	it("says an account login is used in all the member's companies, and stops using it here only", async () => {
		const client = await setupAccount();
		expect(card(OPENAI).textContent).toContain("Used in all your companies");
		expect(buttons().map((item) => item.textContent)).toEqual(["Stop using here", "Sign out everywhere"]);
		buttons()[0]!.click();
		await settle();
		expect(client.revokeConnection).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: id(81) },
			expect.any(AbortSignal),
		);
		expect(client.signOutEverywhere).not.toHaveBeenCalled();
	});

	it("signs out everywhere from the account login's card, then reads the accounts again", async () => {
		const client = await setupAccount();
		const reads = vi.mocked(client.listConnections).mock.calls.length;
		buttons()[1]!.click();
		await settle();
		expect(client.signOutEverywhere).toHaveBeenCalledExactlyOnceWith(id(90), expect.any(AbortSignal));
		expect(client.revokeConnection).not.toHaveBeenCalled();
		expect(vi.mocked(client.listConnections).mock.calls.length).toBeGreaterThan(reads);
	});

	it("says so when signing out everywhere fails", async () => {
		const client = await setupAccount();
		vi.mocked(client.signOutEverywhere).mockRejectedValueOnce(new Error("offline"));
		buttons()[1]!.click();
		await settle();
		expect(view.el.textContent).toContain("You could not be signed out everywhere. Try again.");
	});

	it("keeps a company login's own Sign out, also when the account logins cannot be read", async () => {
		await setupAccount(vi.fn(async () => ({ enabled: true, logins: [] })));
		expect(card(OPENAI).textContent).not.toContain("Used in all your companies");
		expect(buttons().map((item) => item.textContent)).toEqual(["Sign out"]);
		view.dispose();
		await setupAccount(vi.fn(async () => Promise.reject(new Error("offline"))));
		expect(buttons().map((item) => item.textContent)).toEqual(["Sign out"]);
		expect(view.el.textContent).toContain("member@example.com");
	});

	it("keeps the company page as it was: no account-wide note, and Add account with its picker", async () => {
		await setupAccount();
		expect(view.el.querySelector(".connection-note")).toBeNull();
		expect(view.el.querySelector(".connection-add")?.textContent).toBe("Add account");
		expect(view.el.querySelector(".connection-provider-picker")).not.toBeNull();
	});

	it("shows the account login's card in Danish", async () => {
		setLanguagePreference("da");
		try {
			await setupAccount();
			expect(card(OPENAI).textContent).toContain("Bruges i alle dine virksomheder");
			expect(buttons().map((item) => item.textContent)).toEqual(["Stop med at bruge her", "Log ud overalt"]);
		} finally {
			setLanguagePreference("en");
		}
	});
});

describe("a sign-in ChatGPT no longer accepts", () => {
	const refused: WebMemberConnection = {
		...connected,
		sponsorBindingId: id(82),
		sponsorVersion: 1,
		loginStatus: "needs_sign_in",
		providerAccountUsage: {
			observedAt: timestamp,
			windows: [{ id: "primary", label: "5-hour limit", usedPercent: 10 }],
		},
	};

	it("says so on the card with Sign in again and no usage, and one press starts the normal sign-in", async () => {
		const { client } = await setup(true, observed(refused));
		expect(status(OPENAI)).toBe("ChatGPT no longer accepts this sign-in.");
		expect(card(OPENAI).querySelector(".connection-usage")).toBeNull();
		expect(card(OPENAI).textContent).not.toContain("Usage unavailable");
		expect([...card(OPENAI).querySelectorAll("button")].map((item) => item.textContent)).toEqual([
			"Sign in again",
			"Sign out",
		]);
		card(OPENAI).querySelector<HTMLButtonElement>('[data-action="sign-in-again"]')!.click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ provider: "openai" }),
		);
		expect(view.el.querySelector(".connection-attempt")?.textContent).toContain("Open OpenAI sign-in");
	});

	it("keeps a login the cloud says nothing about as it was", async () => {
		const active: WebMemberConnection = { ...refused, loginStatus: "active" };
		await setup(true, observed(active));
		expect(card(OPENAI).querySelector('small[role="status"]')).toBeNull();
		expect(card(OPENAI).querySelector(".connection-usage")).not.toBeNull();
		expect(view.el.querySelector('[data-action="sign-in-again"]')).toBeNull();
	});

	it("hides it once the member has a working login of the same account", async () => {
		const fresh: WebMemberConnection = { ...connected, connectionId: id(83), clientConnectionId: id(183) };
		await setup(true, observed(refused, fresh));
		const cards = [...view.el.querySelectorAll<HTMLElement>(".connection-card")];
		expect(cards.map((item) => item.dataset.connectionId)).toEqual([id(83)]);
		expect(view.el.textContent).not.toContain("ChatGPT no longer accepts this sign-in.");
		expect(view.el.textContent).not.toContain("Added ");
	});

	it("keeps it beside a working login when neither has an email", async () => {
		const unnamed: WebMemberConnection = { ...refused };
		delete unnamed.providerAccountEmail;
		const fresh: WebMemberConnection = { ...connected, connectionId: id(83), clientConnectionId: id(183) };
		delete fresh.providerAccountEmail;
		await setup(true, observed(unnamed, fresh));
		const cards = [...view.el.querySelectorAll<HTMLElement>(".connection-card")];
		expect(cards.map((item) => item.dataset.connectionId)).toEqual([unnamed.connectionId, id(83)]);
		expect(view.el.querySelector('[data-action="sign-in-again"]')).not.toBeNull();
	});
});

describe("Claude sign-in (coding only, offered while the member may sign in with it)", () => {
	const claudeLogin = {
		loginId: id(95),
		clientConnectionId: id(96),
		createdAt: timestamp,
		providerAccountEmail: "member@example.com",
	};
	async function claudeSetup(
		signInOpen: boolean,
		submitCode = vi.fn(async (_code: string): Promise<"completed" | "saving"> => "completed"),
	) {
		const listed = { signInOpen, logins: [] as (typeof claudeLogin)[] };
		const client = {
			listConnections: vi.fn(async () => structuredClone(observed(connected))),
			revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
			createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
			onboardingAvailable: true,
			beginProviderLogin: vi.fn(
				async (
					input: Parameters<WebNativeSubscription["beginProviderLogin"]>[0],
				): Promise<WebNativeProviderLogin> => ({
					loginId: input.clientLoginId,
					clientConnectionId: input.clientConnectionId,
					status: "awaiting_member",
					interactionUrl: "https://claude.com/cai/oauth/authorize?code=true&state=fixture",
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
					submitCode,
				}),
			),
			listClaudeLogins: vi.fn(async () => structuredClone(listed)),
			signOutClaude: vi.fn(async () => {
				listed.logins = [];
			}),
		};
		view = new ConnectionsView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		return { client, listed, submitCode };
	}
	const pickerLabels = () => {
		view.el.querySelector<HTMLButtonElement>(".connection-add")!.click();
		return [...view.el.querySelectorAll<HTMLButtonElement>(".connection-provider-picker button")].map(
			(item) => item.textContent,
		);
	};
	function paste(code: string) {
		const input = card(CLAUDE).querySelector<HTMLInputElement>(".connection-code input")!;
		input.value = code;
		input.dispatchEvent(new Event("input"));
		card(CLAUDE).querySelector<HTMLFormElement>(".connection-code")!.requestSubmit();
	}

	it("is not offered while the member may not sign in with Claude", async () => {
		await claudeSetup(false);
		expect(pickerLabels()).toEqual([OPENAI]);
	});

	it("opens Anthropic's page, sends the pasted code once, and then shows the member's Claude login", async () => {
		const { client, listed, submitCode } = await claudeSetup(true);
		expect(pickerLabels()).toEqual([OPENAI, CLAUDE]);
		addAccount(CLAUDE);
		await settle();
		expect(vi.mocked(client.beginProviderLogin).mock.calls[0]![0].provider).toBe("anthropic");
		const link = card(CLAUDE).querySelector<HTMLAnchorElement>(".connection-sign-in a")!;
		expect(link.textContent).toBe("Open Claude sign-in");
		expect(link.href).toBe("https://claude.com/cai/oauth/authorize?code=true&state=fixture");
		expect(status(CLAUDE)).toBe("Sign in on Claude's page, then paste the code it shows you here.");
		expect(card(CLAUDE).textContent).toContain("Claude chats and Claude Code work. Never routines.");
		// Nothing is sent without a code.
		paste("   ");
		await settle();
		expect(submitCode).not.toHaveBeenCalled();
		expect(status(CLAUDE)).toBe("Paste the code from Claude first.");
		listed.logins = [
			{
				...claudeLogin,
				clientConnectionId: vi.mocked(client.beginProviderLogin).mock.calls[0]![0].clientConnectionId,
			},
		];
		paste("  anthropic-code#state \n");
		await settle();
		expect(submitCode).toHaveBeenCalledTimes(1);
		expect(submitCode).toHaveBeenCalledWith("anthropic-code#state");
		expect(view.el.querySelector(".connection-code")).toBeNull();
		expect(view.el.textContent).toContain("Claude is connected. New Claude work in all your companies uses it.");
		const saved = claudeLoginCard()!;
		expect(saved.textContent).toContain("member@example.com");
		expect(saved.textContent).toContain("Claude chats and Claude Code work, in all your companies. Never routines.");
		expect(saved.querySelector(".badge")).toBeNull();
		expect(saved.textContent).not.toContain("Use this");
		// No sponsor is made for it: it is no provider connection.
		expect(client.createMemberSponsor).toHaveBeenCalledTimes(1);
		expect(client.createMemberSponsor).toHaveBeenCalledWith(
			expect.objectContaining({ providerConnectionId: id(81) }),
			expect.anything(),
		);
	});

	it("says it is still connecting while the vault saves the login, and connected once the login is listed", async () => {
		const { client, listed } = await claudeSetup(
			true,
			vi.fn(async (): Promise<"completed" | "saving"> => "saving"),
		);
		addAccount(CLAUDE);
		await settle();
		paste("anthropic-code#state");
		await settle();
		expect(status(CLAUDE)).toBe("Connecting Claude…");
		expect(view.el.querySelector(".connection-code")).toBeNull();
		expect(view.el.textContent).not.toContain("Claude is connected.");
		listed.logins = [
			{
				...claudeLogin,
				clientConnectionId: vi.mocked(client.beginProviderLogin).mock.calls[0]![0].clientConnectionId,
			},
		];
		await vi.waitFor(() => expect(claudeLoginCard()).not.toBeNull(), { timeout: 5000 });
		expect(view.el.textContent).toContain("Claude is connected. New Claude work in all your companies uses it.");
		expect(view.el.querySelector(".connection-attempt")).toBeNull();
	});

	it("says a refused code did not work and offers a new sign-in", async () => {
		const { client } = await claudeSetup(
			true,
			vi.fn(async (): Promise<"completed" | "saving"> => {
				throw new ClaudeCodeError();
			}),
		);
		addAccount(CLAUDE);
		await settle();
		paste("wrong-code-1234");
		await settle();
		expect(status(CLAUDE)).toBe("That code did not work. Start the sign-in again.");
		expect(view.el.querySelector(".connection-code")).toBeNull();
		action(CLAUDE).click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(2);
	});

	it("signs the member's Claude login out from its card", async () => {
		const { client, listed } = await claudeSetup(true);
		listed.logins = [claudeLogin];
		view.dispose();
		view = new ConnectionsView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		claudeLoginCard()!.querySelector<HTMLButtonElement>("button")!.click();
		await settle();
		expect(client.signOutClaude).toHaveBeenCalledWith(id(95), expect.any(AbortSignal), undefined);
		expect(claudeLoginCard()).toBeNull();
	});
});

describe("Claude usage and limit resets on the Claude card", () => {
	const hours = (count: number) => new Date(Date.now() + count * 3_600_000).toISOString();
	function login(overrides: Partial<WebClaudeLogin> = {}): WebClaudeLogin {
		return {
			loginId: id(97),
			clientConnectionId: id(98),
			createdAt: timestamp,
			providerAccountEmail: "member@example.com",
			usage: {
				observedAt: new Date().toISOString(),
				windows: [
					{ id: "five_hour", label: "5 hours", usedPercent: 28, resetAt: hours(2.7) },
					{ id: "seven_day", label: "Weekly", usedPercent: 87, resetAt: hours(100) },
					{ id: "seven_day_model", label: "Weekly · Fable", usedPercent: 9, resetAt: hours(100) },
				],
			},
			...overrides,
		};
	}
	const fullReset = {
		kind: "full" as const,
		left: 3,
		refills: "5-hour and weekly limits",
		weekStays: "2026-11-21T10:00:00.000Z",
		useBy: "2026-11-30T10:00:00.000Z",
		usable: "now" as const,
	};
	type ReadClaude = (options: { loginId: string; reset?: string; force?: boolean }) => Promise<string>;
	async function claudeView(listed: WebClaudeLogin, readClaude = vi.fn<ReadClaude>(async () => id(99))) {
		const logins = { signInOpen: true, readable: true, logins: [listed] };
		const client = {
			listConnections: vi.fn(async () => structuredClone(observed())),
			revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
			createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
			listClaudeLogins: vi.fn(async () => structuredClone(logins)),
			signOutClaude: vi.fn(async () => undefined),
			readClaude,
		};
		view = new ConnectionsView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		return { client, logins };
	}
	const claudeCard = () => claudeLoginCard()!;
	const bars = () =>
		[...claudeCard().querySelectorAll(".connection-usage-window")].map((window) => window.textContent);

	it("says an unused 5-hour window starts at the next use instead of a missing reset time", async () => {
		await claudeView(
			login({
				usage: {
					observedAt: new Date().toISOString(),
					windows: [
						{ id: "five_hour", label: "5 hours", usedPercent: 0 },
						{ id: "seven_day", label: "Weekly", usedPercent: 4, resetAt: hours(100) },
					],
				},
			}),
		);
		expect(bars()).toEqual([
			expect.stringMatching(/^5 hours.*Starts when you next use Claude.*100% left$/),
			expect.stringMatching(/^Weekly.*96% left$/),
		]);
		expect(claudeCard().textContent).not.toContain("Reset time unavailable");
	});

	it("shows Claude Code's 5-hour, weekly and per-model bars, and reads them again when Settings opens", async () => {
		const { client } = await claudeView(login());
		expect(bars()).toEqual([
			expect.stringMatching(/^5 hours.*72% left$/),
			expect.stringMatching(/^Weekly.*13% left$/),
			expect.stringMatching(/^Weekly · Fable.*91% left$/),
		]);
		expect(client.readClaude).toHaveBeenCalledWith({ loginId: id(97), force: false }, expect.any(AbortSignal));
		expect(claudeCard().querySelector(".connection-resets")).toBeNull();
	});

	it("offers a reset the account holds, with what it refills, and uses it on one click", async () => {
		const finish = deferred<string>();
		const readClaude = vi.fn(async (options: { reset?: string }) => (options.reset ? finish.promise : id(99)));
		const { client, logins } = await claudeView(
			login({ resets: { observedAt: new Date().toISOString(), entries: [fullReset] } }),
			readClaude,
		);
		const row = claudeCard().querySelector<HTMLElement>(".connection-resets")!;
		expect(row.classList.contains("is-ready")).toBe(false);
		expect(row.querySelector("strong")!.textContent).toBe("3 resets");
		expect(row.querySelector("small")!.textContent).toMatch(
			/^Refills your 5-hour and weekly limits · your weekly reset day stays \S+ · use by /,
		);
		row.querySelector<HTMLButtonElement>("button")!.click();
		await settle();
		expect(readClaude).toHaveBeenLastCalledWith({ loginId: id(97), reset: "full" }, expect.any(AbortSignal));
		expect(claudeCard().querySelector(".connection-resets")).toBeNull();
		expect(claudeCard().querySelectorAll(".connection-usage-meter.refilling")).toHaveLength(2);
		expect(claudeCard().textContent).toContain("Using a reset…");
		logins.logins[0]!.lastReset = {
			requestId: id(90),
			kind: "full",
			outcome: "reset",
			left: 0,
			at: new Date().toISOString(),
		};
		finish.resolve(id(90));
		await settle();
		expect(claudeCard().querySelector(".reset-done")!.textContent).toContain("Reset used · no resets left");
		expect(readClaude).toHaveBeenLastCalledWith({ loginId: id(97), force: true }, expect.any(AbortSignal));
		expect(client.signOutClaude).not.toHaveBeenCalled();
	});

	it("lifts the row onto its own tile at a limit, and says only once a limit is hit for a reset saved for one", async () => {
		await claudeView(
			login({
				usage: {
					observedAt: new Date().toISOString(),
					limitResetAt: hours(3.2),
					windows: [{ id: "five_hour", label: "5 hours", usedPercent: 100, resetAt: hours(3.2) }],
				},
				resets: {
					observedAt: new Date().toISOString(),
					entries: [{ ...fullReset, kind: "session", left: 1, refills: "5-hour limit" }],
				},
			}),
		);
		expect(claudeCard().querySelector(".connection-usage-limit")!.textContent).toMatch(
			/^Usage limit reached · resets in/,
		);
		const tile = claudeCard().querySelector<HTMLElement>(".connection-resets.is-ready")!;
		expect(tile.querySelector("strong")!.textContent).toBe("Keep going now with a reset");
		expect(tile.querySelector("small")!.textContent).toMatch(/^1 reset · refills your 5-hour limit · use by /);
		expect(tile.querySelector("button")!.classList.contains("btn-primary")).toBe(true);
		view.dispose();
		document.body.replaceChildren();
		await claudeView(
			login({
				resets: {
					observedAt: new Date().toISOString(),
					entries: [{ ...fullReset, kind: null, left: 1, refills: null, weekStays: null, usable: "at_limit" }],
				},
			}),
		);
		const saved = claudeCard().querySelector<HTMLElement>(".connection-resets")!;
		expect(saved.querySelector("strong")!.textContent).toBe("1 reset");
		expect(saved.querySelector("small")!.textContent).toMatch(/^Usable once you reach a limit · use by /);
		expect(saved.querySelector("button")).toBeNull();
	});

	it("says nothing was used and offers another try, or points to the bars when Claude Code could not confirm", async () => {
		const outcome = { value: "failed" as "failed" | "unconfirmed" };
		const readClaude = vi.fn(async (options: { reset?: string }) => (options.reset ? id(91) : id(99)));
		const { logins } = await claudeView(
			login({ resets: { observedAt: new Date().toISOString(), entries: [fullReset] } }),
			readClaude,
		);
		logins.logins[0]!.lastReset = {
			requestId: id(91),
			kind: "full",
			outcome: outcome.value,
			left: null,
			at: timestamp,
		};
		claudeCard().querySelector<HTMLButtonElement>(".connection-resets button")!.click();
		await settle();
		const failed = claudeCard().querySelector<HTMLElement>(".connection-resets.is-ready")!;
		expect(failed.querySelector("strong")!.textContent).toBe("Couldn't reset your limits");
		expect(failed.querySelector("small")!.textContent).toBe("Nothing was used · 3 resets · try again in a moment");
		expect(failed.querySelector("button")!.textContent).toBe("Try again");
		logins.logins[0]!.lastReset = {
			requestId: id(91),
			kind: "full",
			outcome: "unconfirmed",
			left: null,
			at: timestamp,
		};
		failed.querySelector<HTMLButtonElement>("button")!.click();
		await settle();
		const unconfirmed = claudeCard().querySelector<HTMLElement>(".connection-resets.is-ready")!;
		expect(unconfirmed.querySelector("strong")!.textContent).toBe("Couldn't confirm the reset went through");
		expect(unconfirmed.querySelector("button")).toBeNull();
		expect(readClaude.mock.calls.filter(([options]) => options.reset)).toHaveLength(2);
	});

	it("reads nothing while a reset holds the refresh, and reads the bars once it ends", async () => {
		const reset = deferred<string>();
		const readClaude = vi.fn(async (options: { reset?: string; force?: boolean }) =>
			options.reset ? reset.promise : id(99),
		);
		const { logins } = await claudeView(
			login({ resets: { observedAt: new Date().toISOString(), entries: [fullReset] } }),
			readClaude,
		);
		claudeCard().querySelector<HTMLButtonElement>(".connection-resets button")!.click();
		await settle();
		const refresh = view.el.querySelector<HTMLButtonElement>('[data-focus-key="refresh"]')!;
		expect(refresh.getAttribute("aria-disabled")).toBe("true");
		refresh.click();
		await settle();
		expect(readClaude.mock.calls.filter(([options]) => options.force === true)).toHaveLength(0);
		expect(view.el.textContent).not.toContain("Updated");
		logins.logins[0]!.lastReset = { requestId: id(92), kind: "full", outcome: "reset", left: 2, at: timestamp };
		reset.resolve(id(92));
		await settle();
		await settle();
		expect(readClaude.mock.calls.filter(([options]) => options.force === true)).toHaveLength(1);
		expect(view.el.textContent).not.toContain("Usage could not be refreshed");
	});

	it("refreshes ChatGPT first, then each Claude login, one at a time", async () => {
		const chatgpt = deferred<void>();
		const first = deferred<string>();
		const order: string[] = [];
		const refreshAccountMetadata = vi.fn(async () => {
			order.push("chatgpt");
			await chatgpt.promise;
		});
		const readClaude = vi.fn(async (options: { loginId: string }) => {
			order.push(options.loginId);
			if (options.loginId === id(97)) await first.promise;
			return id(99);
		});
		const logins = { signInOpen: true, readable: true, logins: [login(), login({ loginId: id(96) })] };
		view = new ConnectionsView(
			{
				listConnections: vi.fn(async () => structuredClone(observed(connected))),
				revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
				createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
				listClaudeLogins: vi.fn(async () => structuredClone(logins)),
				refreshAccountMetadata,
				readClaude,
			},
			new AbortController().signal,
		);
		document.body.append(view.el);
		await settle();
		expect(order).toEqual(["chatgpt"]);
		chatgpt.resolve();
		await settle();
		expect(order).toEqual(["chatgpt", id(97)]);
		first.resolve(id(99));
		await settle();
		expect(order).toEqual(["chatgpt", id(97), id(96)]);
		expect(view.el.textContent).not.toContain("Usage could not be refreshed");
	});

	it("says what brings Claude's usage back when the last reading is old or missing", async () => {
		const hint = "Usage updates the next time Claude works on a task.";
		await claudeView(
			login({
				usage: {
					observedAt: hours(-9),
					windows: [{ id: "five_hour", label: "5 hours", usedPercent: 40, resetAt: hours(-4) }],
				},
			}),
		);
		expect(claudeCard().querySelector(".connection-usage")!.textContent).toContain(hint);
		view.dispose();
		document.body.replaceChildren();
		await claudeView({
			loginId: id(97),
			clientConnectionId: id(98),
			createdAt: timestamp,
			providerAccountEmail: "member@example.com",
		});
		expect(claudeCard().querySelector(".connection-usage")!.textContent).toBe(`Usage unavailable${hint}`);
		view.dispose();
		document.body.replaceChildren();
		await claudeView(login());
		expect(claudeCard().textContent).not.toContain(hint);
		view.dispose();
		document.body.replaceChildren();
		const old = { observedAt: hours(-9), windows: [{ id: "five_hour" as const, label: "5 hours", usedPercent: 40 }] };
		const logins = {
			signInOpen: true,
			readable: true,
			logins: [login({ inUse: true, usage: old }), login({ loginId: id(96), usage: old })],
		};
		view = new ConnectionsView(
			{
				listConnections: vi.fn(async () => structuredClone(observed())),
				revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
				createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
				listClaudeLogins: vi.fn(async () => structuredClone(logins)),
				readClaude: vi.fn(async () => id(99)),
			},
			new AbortController().signal,
		);
		document.body.append(view.el);
		await settle();
		expect(claudeLoginCard(id(97))!.querySelector(".connection-usage")!.textContent).toContain(hint);
		expect(claudeLoginCard(id(96))!.querySelector(".connection-usage")!.textContent).toContain(
			"Usage updates once this login is in use and Claude works on a task.",
		);
	});

	it("says nothing was used and offers another try when the reset never began", async () => {
		const readClaude = vi.fn(async (options: { reset?: string }) => {
			if (options.reset) throw new ClaudeReadNotStarted();
			return id(99);
		});
		await claudeView(login({ resets: { observedAt: new Date().toISOString(), entries: [fullReset] } }), readClaude);
		claudeCard().querySelector<HTMLButtonElement>(".connection-resets button")!.click();
		await settle();
		const failed = claudeCard().querySelector<HTMLElement>(".connection-resets.is-ready")!;
		expect(failed.querySelector("strong")!.textContent).toBe("Couldn't reset your limits");
		expect(failed.querySelector("button")!.textContent).toBe("Try again");
	});
});

describe("several Claude logins, one In use", () => {
	const work: WebClaudeLogin = {
		loginId: id(70),
		clientConnectionId: id(71),
		createdAt: timestamp,
		providerAccountEmail: "work@example.com",
		inUse: true,
	};
	const home: WebClaudeLogin = {
		loginId: id(72),
		clientConnectionId: id(73),
		createdAt: timestamp,
		providerAccountEmail: "home@example.com",
	};
	const spare: WebClaudeLogin = {
		loginId: id(74),
		clientConnectionId: id(75),
		createdAt: timestamp,
		providerAccountEmail: "spare@example.com",
	};
	async function several(
		logins: WebClaudeLogin[],
		readClaude?: (options: { loginId: string; force?: boolean }) => Promise<string>,
	) {
		const listed = { signInOpen: true, readable: readClaude !== undefined, logins };
		const client = {
			listConnections: vi.fn(async () => structuredClone(observed())),
			revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
			createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
			onboardingAvailable: true,
			beginProviderLogin: vi.fn(
				async (
					input: Parameters<WebNativeSubscription["beginProviderLogin"]>[0],
				): Promise<WebNativeProviderLogin> => ({
					loginId: input.clientLoginId,
					clientConnectionId: input.clientConnectionId,
					status: "awaiting_member",
					interactionUrl: "https://claude.com/cai/oauth/authorize?code=true&state=fixture",
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
					submitCode: async () => "completed" as const,
				}),
			),
			listClaudeLogins: vi.fn(async () => structuredClone(listed)),
			useClaude: vi.fn(async (loginId: string) => {
				listed.logins = listed.logins.map((login) => ({ ...login, inUse: login.loginId === loginId }));
			}),
			signOutClaude: vi.fn(async (loginId: string, _signal?: AbortSignal, next?: string) => {
				listed.logins = listed.logins
					.filter((login) => login.loginId !== loginId)
					.map((login) => (next ? { ...login, inUse: login.loginId === next } : login));
			}),
			...(readClaude ? { readClaude: vi.fn(readClaude) } : {}),
		};
		view = new ConnectionsView(client, new AbortController().signal);
		document.body.append(view.el);
		await settle();
		return { client, listed };
	}
	const buttons = (element: Element) =>
		[...element.querySelectorAll<HTMLButtonElement>("button")].map((item) => item.textContent);
	const press = (element: Element, label: string) =>
		[...element.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!.click();

	it("tags the login In use, lists it first, and offers Use this on the other", async () => {
		await several([{ ...home }, { ...work }]);
		const cards = [...view.el.querySelectorAll<HTMLElement>(".connection-card[data-claude-login-id]")];
		expect(cards.map((item) => item.dataset.claudeLoginId)).toEqual([id(70), id(72)]);
		expect(cards[0]!.querySelector("strong")!.textContent).toBe("Claude In use");
		expect(cards[0]!.querySelector(".badge.badge-ok")!.textContent).toBe("In use");
		expect(cards[0]!.textContent).toContain(
			"Claude chats and Claude Code work, in all your companies. Never routines.",
		);
		expect(buttons(cards[0]!)).toEqual(["Sign out"]);
		expect(cards[1]!.querySelector(".badge")).toBeNull();
		expect(cards[1]!.textContent).toContain("Not in use. New Claude work goes to the login marked In use.");
		expect(buttons(cards[1]!)).toEqual(["Use this", "Sign out"]);
	});

	it("moves In use only on the member's click", async () => {
		const { client } = await several([{ ...work }, { ...home }]);
		expect(client.useClaude).not.toHaveBeenCalled();
		press(claudeLoginCard(id(72))!, "Use this");
		await settle();
		expect(client.useClaude).toHaveBeenCalledWith(id(72), expect.any(AbortSignal));
		expect(claudeLoginCard(id(72))!.querySelector(".badge")!.textContent).toBe("In use");
		expect(buttons(claudeLoginCard(id(70))!)).toEqual(["Use this", "Sign out"]);
	});

	it("offers another Claude login in Add account and keeps the login in use through the new sign-in", async () => {
		const { client, listed } = await several([{ ...work }]);
		addAccount("Another Claude login");
		await settle();
		const attempt = view.el.querySelector<HTMLElement>(".connection-attempt")!;
		expect(attempt.querySelector("strong")!.textContent).toBe("Another Claude login");
		expect(attempt.querySelector('small[role="status"]')!.textContent).toBe(
			"Sign in on Claude's page with the other account, then paste the code here. work@example.com stays in use until you pick the new one.",
		);
		listed.logins = [
			...listed.logins,
			{
				...home,
				clientConnectionId: vi.mocked(client.beginProviderLogin).mock.calls[0]![0].clientConnectionId,
			},
		];
		const input = attempt.querySelector<HTMLInputElement>(".connection-code input")!;
		input.value = "anthropic-code#state";
		input.dispatchEvent(new Event("input"));
		attempt.querySelector<HTMLFormElement>(".connection-code")!.requestSubmit();
		await settle();
		await settle();
		expect(view.el.textContent).toContain(
			"Claude login added. work@example.com stays in use until you pick another.",
		);
		expect(client.useClaude).not.toHaveBeenCalled();
	});

	it("asks before signing out the login in use and names the login that takes over", async () => {
		const { client } = await several([{ ...work }, { ...home }]);
		press(claudeLoginCard(id(70))!, "Sign out");
		await settle();
		expect(client.signOutClaude).not.toHaveBeenCalled();
		const strip = claudeLoginCard(id(70))!.querySelector<HTMLElement>(".connection-resets.is-ready")!;
		expect(strip.querySelector("strong")!.textContent).toBe("Sign out of this Claude login?");
		expect(strip.querySelector("small")!.textContent).toBe(
			"New Claude work moves to home@example.com. Work already running keeps this login until it ends.",
		);
		expect(buttons(strip)).toEqual(["Sign out", "Cancel"]);
		press(strip, "Cancel");
		await settle();
		expect(claudeLoginCard(id(70))!.querySelector(".connection-resets")).toBeNull();
		press(claudeLoginCard(id(70))!, "Sign out");
		await settle();
		press(claudeLoginCard(id(70))!.querySelector(".connection-resets")!, "Sign out");
		await settle();
		expect(client.signOutClaude).toHaveBeenCalledWith(id(70), expect.any(AbortSignal), id(72));
		expect(claudeLoginCard(id(70))).toBeNull();
		expect(claudeLoginCard(id(72))!.querySelector(".badge")).toBeNull();
		expect(claudeLoginCard(id(72))!.textContent).toContain("Claude chats and Claude Code work");
	});

	it("offers one Use button per other login with three, and signs out a login not in use at once", async () => {
		const { client } = await several([{ ...work }, { ...home }, { ...spare }]);
		press(claudeLoginCard(id(72))!, "Sign out");
		await settle();
		expect(client.signOutClaude).toHaveBeenCalledWith(id(72), expect.any(AbortSignal), undefined);
		press(claudeLoginCard(id(70))!, "Sign out");
		await settle();
		expect(client.signOutClaude).toHaveBeenCalledTimes(1);
		view.dispose();
		document.body.replaceChildren();
		await several([{ ...work }, { ...home }, { ...spare }]);
		press(claudeLoginCard(id(70))!, "Sign out");
		await settle();
		const strip = claudeLoginCard(id(70))!.querySelector<HTMLElement>(".connection-resets")!;
		expect(strip.querySelector("small")!.textContent).toBe(
			"Pick the login new Claude work uses. Work already running keeps this one until it ends.",
		);
		expect(buttons(strip)).toEqual(["Use home@example.com", "Use spare@example.com", "Cancel"]);
	});

	it("says so when Use this could not switch the login, and keeps the tag where it was", async () => {
		const { client } = await several([{ ...work }, { ...home }]);
		client.useClaude.mockRejectedValueOnce(new Error("refused"));
		press(claudeLoginCard(id(72))!, "Use this");
		await settle();
		expect(view.el.textContent).toContain("The Claude login could not be switched. Try again.");
		expect(claudeLoginCard(id(70))!.querySelector(".badge")!.textContent).toBe("In use");
	});

	it("reads every login's usage even when one read fails, and then says the refresh failed", async () => {
		const reads: string[] = [];
		await several([{ ...work }, { ...home }, { ...spare }], async (options) => {
			reads.push(options.loginId);
			if (options.loginId === id(70)) throw new Error("unavailable");
			return id(99);
		});
		expect(reads).toEqual([id(70), id(72), id(74)]);
		expect(view.el.textContent).toContain("Usage could not be refreshed. Try again.");
	});

	it("reads the usage of every login, each by its own id", async () => {
		const reads: string[] = [];
		await several([{ ...work }, { ...home }], async (options) => {
			reads.push(options.loginId);
			return id(99);
		});
		expect(reads).toEqual([id(70), id(72)]);
	});
});
