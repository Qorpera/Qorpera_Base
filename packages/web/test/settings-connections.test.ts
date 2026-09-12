// @vitest-environment jsdom
import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsView } from "../src/app/views/settings-connections.ts";
import type { WebNativeProviderLogin, WebNativeSubscription } from "../src/cloud/native-subscription.ts";
import { deferred, id, settle, timestamp, userA } from "./fixtures.ts";

const connections: NativeExecutionConnections = {
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
	connections: [
		{
			connectionId: id(81),
			connectionVersion: 2,
			provider: "openai",
			nativeHarness: "codex-cli",
			authorizationState: "active",
			maxNativeConcurrency: 1,
			billingSource: "member",
			consentVersion: "v1",
			consentedAt: timestamp,
			connectionStatus: "active",
			policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 3 },
		},
	],
};
let view: ConnectionsView;
afterEach(() => {
	view?.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function setup(onboardingAvailable = false) {
	const client: Pick<
		WebNativeSubscription,
		"listConnections" | "revokeConnection" | "createMemberSponsor" | "onboardingAvailable" | "beginProviderLogin"
	> = {
		listConnections: vi.fn(async () => structuredClone(connections)),
		revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
		createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
		onboardingAvailable,
		beginProviderLogin: vi.fn(async (input) => ({
			loginId: input.clientLoginId,
			connectionId: input.clientConnectionId,
			status: "awaiting_member" as const,
			interactionUrl: "https://auth.openai.com/device",
			userCode: "ABCD-EFGH",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		})),
	};
	const lifetime = new AbortController();
	view = new ConnectionsView(client, lifetime.signal);
	document.body.append(view.el);
	await settle();
	return { client, lifetime };
}
function action(label: string): HTMLButtonElement {
	return [...view.el.querySelectorAll("button")].find((button) => button.textContent === label)!;
}
describe("member model account settings", () => {
	it("keeps provider sign-in unavailable without an explicitly configured gateway", async () => {
		const { client } = await setup();
		expect(view.el.textContent).toContain("Connecting a new model account from the browser is not available yet");
		expect(action("Sign in with OpenAI")).toBeUndefined();
		expect(action("Sign in with Anthropic")).toBeUndefined();
		expect(client.beginProviderLogin).not.toHaveBeenCalled();
		expect(view.el.querySelector('input[type="password"]')).toBeNull();
	});
	it.each([
		["OpenAI", "openai"],
		["Anthropic", "anthropic"],
	] as const)("starts %s only on an explicit action with fresh admission IDs", async (label, provider) => {
		const { client } = await setup(true);
		expect(client.beginProviderLogin).not.toHaveBeenCalled();
		action(`Sign in with ${label}`).click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
		const input = vi.mocked(client.beginProviderLogin).mock.calls[0]![0];
		expect(input).toMatchObject({ provider, displayName: "My model account" });
		expect(new Set([input.clientIdentityId, input.clientLoginId, input.clientConnectionId]).size).toBe(3);
		const link = view.el.querySelector<HTMLAnchorElement>(".provider-sign-in-prompt a")!;
		expect(link.href).toBe("https://auth.openai.com/device");
		expect(link.rel).toBe("noopener noreferrer");
		expect(view.el.querySelector("code")!.textContent).toBe("ABCD-EFGH");
		expect(view.el.querySelector("time")!.getAttribute("datetime")).toBeDefined();
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
	});
	it("confirms completion from the exact refreshed connection without enabling sponsorship", async () => {
		const { client } = await setup(true);
		action("Sign in with OpenAI").click();
		await settle();
		const target = vi.mocked(client.beginProviderLogin).mock.calls[0]![0].clientConnectionId;
		action("Refresh model accounts").click();
		await settle();
		expect(view.el.querySelector(".provider-sign-in-prompt")).not.toBeNull();
		vi.mocked(client.listConnections).mockResolvedValueOnce({
			...connections,
			connections: [{ ...connections.connections[0]!, connectionId: target }],
		});
		action("Refresh model accounts").click();
		await settle();
		expect(view.el.querySelector(".provider-sign-in-prompt")).toBeNull();
		expect(view.el.textContent).toContain("Model account connected. Enable it for your messages when ready");
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
	});
	it("requires refresh after uncertain sign-in and allocates new IDs only for a new explicit attempt", async () => {
		const { client } = await setup(true);
		vi.mocked(client.beginProviderLogin).mockRejectedValueOnce(new Error("Unknown admission result"));
		const original = action("Sign in with OpenAI");
		original.click();
		original.click();
		await settle();
		expect(view.el.textContent).toContain("Sign-in could not be confirmed");
		original.click();
		action("Sign in with OpenAI").click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
		action("Refresh model accounts").click();
		await settle();
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
		action("Sign in with OpenAI").click();
		await settle();
		const [first, second] = vi.mocked(client.beginProviderLogin).mock.calls;
		for (const key of ["clientIdentityId", "clientLoginId", "clientConnectionId"] as const)
			expect(first![0][key]).not.toBe(second![0][key]);
	});
	it("clears expired instructions and requires a connection refresh before a new attempt", async () => {
		vi.useFakeTimers();
		const { client } = await setup(true);
		action("Sign in with OpenAI").click();
		await settle();
		await vi.advanceTimersByTimeAsync(60_001);
		expect(view.el.querySelector(".provider-sign-in-prompt")).toBeNull();
		expect(view.el.textContent).toContain("Sign-in instructions expired");
		expect(action("Sign in with OpenAI").disabled).toBe(true);
		expect(client.listConnections).toHaveBeenCalledTimes(1);
		expect(client.beginProviderLogin).toHaveBeenCalledTimes(1);
	});
	it("aborts and discards a late sign-in response on company/account teardown", async () => {
		const { client, lifetime } = await setup(true);
		const pending = deferred<WebNativeProviderLogin>();
		vi.mocked(client.beginProviderLogin).mockReturnValueOnce(pending.promise);
		action("Sign in with OpenAI").click();
		const [input, signal] = vi.mocked(client.beginProviderLogin).mock.calls[0]!;
		lifetime.abort();
		expect(signal?.aborted).toBe(true);
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
		expect(document.querySelector(".provider-sign-in-prompt")).toBeNull();
		expect(client.listConnections).toHaveBeenCalledTimes(1);
		expect(client.createMemberSponsor).not.toHaveBeenCalled();
	});
	it("enables only the selected observed connection for member messages", async () => {
		const { client } = await setup();
		action("Enable for my messages").click();
		await settle();
		expect(client.createMemberSponsor).toHaveBeenCalledExactlyOnceWith(
			{
				clientBindingId: expect.any(String),
				providerConnectionId: id(81),
				providerConnectionVersion: 2,
				allowAutonomous: false,
			},
			expect.any(AbortSignal),
		);
		expect(action("Enable for my messages").disabled).toBe(true);
		expect(client.revokeConnection).not.toHaveBeenCalled();
	});
	it("retains uncertain enable identity but uses a new identity after connection rotation", async () => {
		const { client } = await setup();
		vi.mocked(client.createMemberSponsor).mockRejectedValueOnce(new Error("lost reply"));
		action("Enable for my messages").click();
		await settle();
		const first = vi.mocked(client.createMemberSponsor).mock.calls[0]![0];
		expect(first.clientBindingId).not.toBe(id(81));
		action("Refresh model accounts").click();
		await settle();
		action("Enable for my messages").click();
		await settle();
		expect(vi.mocked(client.createMemberSponsor).mock.calls[1]![0]).toEqual(first);
		vi.mocked(client.listConnections).mockResolvedValueOnce({
			...connections,
			connections: [{ ...connections.connections[0]!, connectionVersion: 3 }],
		});
		action("Refresh model accounts").click();
		await settle();
		expect(view.el.textContent).not.toContain("Refresh to read its current state");
		action("Enable for my messages").click();
		await settle();
		const rotated = vi.mocked(client.createMemberSponsor).mock.calls[2]![0];
		expect(rotated.clientBindingId).not.toBe(first.clientBindingId);
		expect(rotated.providerConnectionVersion).toBe(3);
	});
	it("requires status recovery after an uncertain revocation without replay", async () => {
		const { client } = await setup();
		vi.mocked(client.revokeConnection).mockRejectedValueOnce(new Error("lost reply"));
		action("Revoke connection").click();
		await settle();
		expect(view.el.textContent).toContain("Refresh before trying again");
		action("Revoke connection").click();
		expect(client.revokeConnection).toHaveBeenCalledTimes(1);
		vi.mocked(client.listConnections).mockResolvedValueOnce({
			...connections,
			connections: [{ ...connections.connections[0]!, connectionStatus: "revoked" }],
		});
		action("Refresh model accounts").click();
		await settle();
		expect(action("Revoke connection").disabled).toBe(true);
		expect(action("Enable for my messages").disabled).toBe(true);
	});
	it("aborts and discards a response when the selected company closes", async () => {
		const { client, lifetime } = await setup();
		const pending = deferred<NativeExecutionConnections>();
		vi.mocked(client.listConnections).mockReturnValueOnce(pending.promise);
		action("Refresh model accounts").click();
		lifetime.abort();
		pending.resolve(connections);
		await settle();
		expect(view.el.textContent).toBe("");
		expect(vi.mocked(client.listConnections).mock.calls[1]![0]!.aborted).toBe(true);
		expect(client.revokeConnection).not.toHaveBeenCalled();
	});
});
