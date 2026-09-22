// @vitest-environment jsdom
import type {
	NativeExecutionConnections,
	NativeMemberConnection,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsView, ProviderSignIns } from "../src/app/views/settings-connections.ts";
import type { WebNativeProviderLogin, WebNativeSubscription } from "../src/cloud/native-subscription.ts";
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
		"listConnections" | "revokeConnection" | "createMemberSponsor" | "onboardingAvailable" | "beginProviderLogin"
	> = {
		listConnections: vi.fn(async () => structuredClone(initial)),
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
		const labels = [...view.el.querySelectorAll("button")].map((item) => item.textContent);
		for (const removed of ["Refresh model accounts", "Enable for my messages", "Revoke connection"])
			expect(labels).not.toContain(removed);
		expect(view.el.textContent).toContain("Connect your tools");
		const service = [...view.el.querySelectorAll("button")].find((item) => item.textContent === "Add service")!;
		expect(service.disabled).toBe(true);
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
			"./assets/provider-anthropic.svg",
		]);
		for (const account of accounts) expect(account.querySelector("button")!.textContent).toBe("Sign out");
		expect(view.el.textContent).not.toContain("opaque-account");
	});
	it("distinguishes accounts with missing email without presenting references as identity", async () => {
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
		expect(identities[0]!.textContent).toContain(id(81).slice(-8));
		expect(identities[1]!.textContent).toContain(id(83).slice(-8));
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
		expect(view.el.textContent).toContain("Last checked");
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
		expect(view.el.textContent).toContain("0% at last check");
		expect(view.el.textContent).toContain("may be out of date");
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
		expect(view.el.textContent).not.toContain("may be out of date");
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
		expect(view.el.textContent).toContain("50% at last check");
		expect(view.el.textContent).not.toContain("50% left");
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
