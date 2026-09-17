// @vitest-environment jsdom
import type {
	NativeExecutionConnections,
	NativeMemberConnection,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsView, ProviderSignIns } from "../src/app/views/settings-connections.ts";
import type { WebNativeProviderLogin, WebNativeSubscription } from "../src/cloud/native-subscription.ts";
import { deferred, id, settle, timestamp, userA } from "./fixtures.ts";

const WATCH_MS = 5000;
const OPENAI = "ChatGPT / Codex";
const CLAUDE = "Claude";
const START_FAILED = "Sign-in could not be started. If you started one a moment ago, give it a few minutes to clear.";
const ID_KEYS = ["clientIdentityId", "clientLoginId", "clientConnectionId"] as const;
/** A connected account that is not yet enabled for the member's messages. */
const connected: NativeMemberConnection = {
	connectionId: id(81),
	connectionVersion: 2,
	provider: "openai",
	nativeHarness: "codex-cli",
	authorizationState: "active",
	maxNativeConcurrency: 1,
	providerAccountReference: "member@example.com",
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
			connectionId: input.clientConnectionId,
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
/** The one action of a provider card. */
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
	it("shows one card per provider and keeps sign-in unavailable without configured onboarding", async () => {
		const { client } = await setup(false, observed());
		expect([...view.el.querySelectorAll(".connection-card strong")].map((item) => item.textContent)).toEqual([
			OPENAI,
			CLAUDE,
		]);
		for (const label of [OPENAI, CLAUDE]) {
			expect(status(label)).toBe("Not available yet");
			expect(action(label).textContent).toBe("Connect");
			expect(action(label).disabled).toBe(true);
			action(label).click();
		}
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
		expect(status(OPENAI)).toBe("Checking…");
		expect(action(OPENAI).disabled).toBe(true);
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
		expect(status(OPENAI)).toBe("Connected · member@example.com");
		expect(action(OPENAI).textContent).toBe("Disconnect");
		expect(status(CLAUDE)).toBe("Sign in again to keep using this account");
		expect(action(CLAUDE).textContent).toBe("Sign in again");
		expect(action(CLAUDE).disabled).toBe(false);
	});
	it.each([
		["OpenAI", "openai", OPENAI],
		["Anthropic", "anthropic", CLAUDE],
	] as const)("starts %s only on an explicit action with fresh admission IDs", async (name, provider, label) => {
		const { client } = await setup(true, observed());
		expect(status(label)).toBe("Not connected");
		expect(client.beginProviderLogin).not.toHaveBeenCalled();
		action(label).click();
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
		action(OPENAI).click();
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
		vi.mocked(client.listConnections).mockResolvedValueOnce(observed({ ...connected, connectionId: target }));
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({ ...connected, connectionId: target, sponsorBindingId: id(82), sponsorVersion: 1 }),
		);
		await vi.advanceTimersByTimeAsync(WATCH_MS);
		expect(view.el.querySelector(".connection-sign-in")).toBeNull();
		expect(status(OPENAI)).toBe("Connected · member@example.com");
		expect(action(OPENAI).textContent).toBe("Disconnect");
		expect(client.createMemberSponsor).toHaveBeenCalledExactlyOnceWith(
			{ providerConnectionId: target, providerConnectionVersion: 2, allowAutonomous: false },
			expect.any(AbortSignal),
		);
		// Enabling re-reads once; with no sign-in open the page stops watching.
		expect(client.listConnections).toHaveBeenCalledTimes(6);
		await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
		expect(client.listConnections).toHaveBeenCalledTimes(6);
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
	});
	it("never replays a start: every explicit Connect is a new sign-in with its own IDs", async () => {
		const { client } = await setup(true, observed());
		vi.mocked(client.beginProviderLogin).mockRejectedValueOnce(new Error("Unknown admission result"));
		const original = action(OPENAI);
		original.click();
		original.click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
		expect(status(OPENAI)).toBe(START_FAILED);
		expect(view.el.querySelector(".connection-sign-in")).toBeNull();
		expect(action(OPENAI).textContent).toBe("Connect");
		expect(action(OPENAI).disabled).toBe(false);
		action(OPENAI).click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(2);
		expect(status(OPENAI)).toBe("Waiting for you to finish signing in…");
		// The other provider is its own sign-in.
		action(CLAUDE).click();
		await settle();
		expect(view.el.querySelectorAll(".connection-sign-in")).toHaveLength(2);
		action(OPENAI).click();
		expect(view.el.querySelectorAll(".connection-sign-in")).toHaveLength(1);
		expect(status(OPENAI)).toBe("Not connected");
		expect(status(CLAUDE)).toBe("Waiting for you to finish signing in…");
		action(OPENAI).click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(4);
		const used = [0, 1, 2, 3].flatMap((call) => Object.values(loginIds(client, call)));
		expect(new Set(used).size).toBe(12);
	});
	it("removes an expired sign-in on the next read and uses new IDs for the next attempt", async () => {
		vi.useFakeTimers();
		const { client } = await setup(true, observed());
		action(OPENAI).click();
		await settle();
		await vi.advanceTimersByTimeAsync(55_000);
		expect(card(OPENAI).querySelector(".connection-sign-in")).not.toBeNull();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(view.el.querySelector(".connection-sign-in")).toBeNull();
		expect(status(OPENAI)).toBe("Not connected");
		expect(action(OPENAI).textContent).toBe("Connect");
		const reads = vi.mocked(client.listConnections).mock.calls.length;
		await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
		expect(client.listConnections).toHaveBeenCalledTimes(reads);
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
		action(OPENAI).click();
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
		action(OPENAI).click();
		const [input] = vi.mocked(client.beginProviderLogin).mock.calls[0]!;
		lifetime.abort();
		expect(view.el.textContent).toBe("");
		pending.resolve({
			loginId: input.clientLoginId,
			connectionId: input.clientConnectionId,
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
		action(OPENAI).click();
		const [input] = vi.mocked(first.client.beginProviderLogin).mock.calls[0]!;
		first.lifetime.abort();
		const closed = view;
		const rebuilt = await setup(true, observed(), signIns);
		expect(status(OPENAI)).toBe("Preparing sign-in. The first time can take a minute or two.");
		expect(action(OPENAI).textContent).toBe("Connecting…");
		expect(action(OPENAI).disabled).toBe(true);
		action(OPENAI).click();
		expect(status(CLAUDE)).toBe("Not connected");
		expect(rebuilt.client.listConnections).toHaveBeenCalledTimes(1);
		pending.resolve({
			loginId: input.clientLoginId,
			connectionId: input.clientConnectionId,
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
		action(CLAUDE).click();
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
		action(OPENAI).click();
		await settle();
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		lifetime.abort();
		await vi.advanceTimersByTimeAsync(WATCH_MS * 3);
		expect(vi.getTimerCount()).toBe(0);
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		expect(view.el.textContent).toBe("");
		expect(document.querySelector(".connection-sign-in")).toBeNull();
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
		expect(status(OPENAI)).toBe("Connected · member@example.com");
		// Later reads of the same version do not enable it again.
		action(CLAUDE).click();
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
		expect(status(OPENAI)).toBe("Connected · member@example.com");
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
		expect(action(OPENAI).textContent).toBe("Disconnecting…");
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
		expect(status(OPENAI)).toBe("Not connected");
		expect(action(OPENAI).textContent).toBe("Connect");
		expect(action(OPENAI).disabled).toBe(false);
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
	});
	it("reads the account again after an uncertain disconnect instead of guessing", async () => {
		const { client } = await setup(true, observed({ ...connected, sponsorBindingId: id(82), sponsorVersion: 1 }));
		vi.mocked(client.revokeConnection).mockRejectedValueOnce(new Error("lost reply"));
		action(OPENAI).click();
		await settle();
		expect(client.revokeConnection).toHaveBeenCalledTimes(1);
		expect(client.listConnections).toHaveBeenCalledTimes(2);
		expect(status(OPENAI)).toBe("Connected · member@example.com");
		expect(view.el.querySelector("p[role=status]")!.textContent).toContain("The account could not be disconnected.");
		// The lost reply had in fact disconnected it: the next read shows that and says nothing more.
		vi.mocked(client.revokeConnection).mockRejectedValueOnce(new Error("lost reply"));
		vi.mocked(client.listConnections).mockResolvedValue(
			observed({ ...connected, connectionStatus: "revoked", authorizationState: "revoked" }),
		);
		action(OPENAI).click();
		await settle();
		expect(client.revokeConnection).toHaveBeenCalledTimes(2);
		expect(status(OPENAI)).toBe("Not connected");
		expect(view.el.querySelector("p[role=status]")).toBeNull();
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
		expect(status(OPENAI)).toBe("Not available yet");
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
