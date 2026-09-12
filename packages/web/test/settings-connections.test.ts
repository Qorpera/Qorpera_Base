// @vitest-environment jsdom
import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsView } from "../src/app/views/settings-connections.ts";
import type { WebNativeSubscription } from "../src/cloud/native-subscription.ts";
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
});
async function setup() {
	const client: Pick<WebNativeSubscription, "listConnections" | "revokeConnection" | "createMemberSponsor"> = {
		listConnections: vi.fn(async () => structuredClone(connections)),
		revokeConnection: vi.fn(async () => ({ connectionId: id(81), status: "revoked" as const })),
		createMemberSponsor: vi.fn(async () => ({ bindingId: id(82), version: 1 })),
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
