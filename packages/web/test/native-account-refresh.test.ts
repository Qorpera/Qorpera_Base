import {
	type NativeExecutionConnections,
	NativeSubscriptionControlPlane,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebNativeSubscription } from "../src/cloud/native-subscription.ts";
import { deferred, fixture, id, profileA, timestamp, userA } from "./fixtures.ts";

const accounts: NativeExecutionConnections = {
	computeIdentity: {
		computeIdentityId: id(104),
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
			clientConnectionId: id(181),
			connectionVersion: 1,
			provider: "openai",
			nativeHarness: "codex-cli",
			authorizationState: "active",
			maxNativeConcurrency: 1,
			providerAccountReference: "opaque",
			billingSource: "member",
			consentVersion: "v1",
			consentedAt: timestamp,
			connectionStatus: "active",
			policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 3 },
		},
	],
};
function setup() {
	const f = fixture();
	f.cloud.config.nativeProviderLoginUrl = "https://fixture.invalid/functions/v1/native-provider-login/";
	f.cloud.config.publishableKey = "sb_publishable_fixture1234";
	f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
	const company = new AbortController();
	const receipt = {
		request_id: id(110),
		profile_id: profileA.profileId,
		compute_identity_id: id(104),
		requested_by_user_id: userA.id,
		expires_at: new Date(Date.now() + 300000).toISOString(),
		status: "pending",
	};
	const calls: { url: string; init?: RequestInit }[] = [];
	const guestStarted = deferred<void>();
	const guest = deferred<Response>();
	const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		if (String(url).endsWith("qorpera_begin_native_account_refresh")) return Response.json(receipt);
		if (String(url).endsWith("qorpera_get_native_account_refresh"))
			return Response.json({ ...receipt, status: "completed" });
		if (String(url).endsWith("/account-refresh")) {
			guestStarted.resolve();
			return guest.promise;
		}
		throw new Error("Unexpected route");
	});
	vi.stubGlobal("fetch", fetcher);
	const list = vi.spyOn(NativeSubscriptionControlPlane.prototype, "listConnections").mockResolvedValue(accounts);
	const client = createWebNativeSubscription(f.cloud, profileA.profileId, userA.id, company.signal, vi.fn());
	const finish = () =>
		guest.resolve(
			Response.json({
				schema: "qorpera.native-account-refresh-result/v1",
				request_id: receipt.request_id,
				status: "completed",
			}),
		);
	return { ...f, client, company, receipt, calls, fetcher, list, guestStarted, guest, finish };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
describe("account metadata refresh transport", () => {
	it("coalesces refreshes, uses isolated capability transport and awaits guest completion", async () => {
		const f = setup();
		const first = f.client.refreshAccountMetadata!(),
			second = f.client.refreshAccountMetadata!();
		await f.guestStarted.promise;
		expect(f.calls).toHaveLength(2);
		const admission = JSON.parse(String(f.calls[0]?.init?.body)),
			request = JSON.parse(String(f.calls[1]?.init?.body));
		expect(request.schema).toBe("qorpera.native-account-refresh/v1");
		expect(request.refresh_capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(new Headers(f.calls[1]?.init?.headers).get("authorization")).toBe(`Bearer ${request.refresh_capability}`);
		expect(new Headers(f.calls[1]?.init?.headers).has("apikey")).toBe(false);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.refresh_capability));
		expect(admission.p_capability_sha256).toBe(
			Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
		);
		f.finish();
		await Promise.all([first, second]);
	});
	it("polls the same admitted request while its guest is preparing", async () => {
		const f = setup();
		f.fetcher.mockResolvedValueOnce(Response.json(f.receipt)).mockResolvedValueOnce(
			Response.json({
				schema: "qorpera.native-account-refresh-result/v1",
				request_id: f.receipt.request_id,
				status: "preparing",
			}),
		);
		const pending = f.client.refreshAccountMetadata!();
		await f.guestStarted.promise;
		expect(f.fetcher).toHaveBeenCalledTimes(3);
		expect(f.fetcher.mock.calls[1]?.[1]?.body).toBe(f.fetcher.mock.calls[2]?.[1]?.body);
		f.finish();
		await pending;
	});
	it("retains admission authority after an uncertain guest response", async () => {
		const f = setup();
		f.fetcher
			.mockResolvedValueOnce(Response.json(f.receipt))
			.mockResolvedValueOnce(Response.json({}, { status: 503 }));
		await expect(f.client.refreshAccountMetadata!()).rejects.toThrow("could not be refreshed");
		const retried = f.client.refreshAccountMetadata!();
		await f.guestStarted.promise;
		expect(f.fetcher.mock.calls[0]?.[1]?.body).toBe(f.fetcher.mock.calls[2]?.[1]?.body);
		expect(f.fetcher.mock.calls[1]?.[1]?.body).toBe(f.fetcher.mock.calls[3]?.[1]?.body);
		f.finish();
		await retried;
	});

	it("canceling one view does not cancel the shared refresh or another waiter", async () => {
		const f = setup(),
			view = new AbortController();
		const first = f.client.refreshAccountMetadata!(view.signal);
		const failed = expect(first).rejects.toThrow();
		const second = f.client.refreshAccountMetadata!();
		await f.guestStarted.promise;
		view.abort();
		await failed;
		expect(f.calls[1]?.init?.signal?.aborted).toBe(false);
		f.finish();
		await second;
	});
	it("company cancellation invalidates all waiting views", async () => {
		const f = setup();
		const pending = f.client.refreshAccountMetadata!();
		const failed = expect(pending).rejects.toThrow();
		await f.guestStarted.promise;
		f.company.abort();
		await failed;
		f.finish();
	});
	it("does not create a maintenance request without connected accounts", async () => {
		const f = setup();
		f.list.mockResolvedValueOnce({ connections: [] });
		await f.client.refreshAccountMetadata!();
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("uses the server's completed attempt cache without booting a guest", async () => {
		const f = setup();
		f.receipt.status = "completed";
		await f.client.refreshAccountMetadata!();
		expect(f.calls).toHaveLength(1);
	});
	it("rejects admission for a different compute identity before guest contact", async () => {
		const f = setup();
		f.receipt.compute_identity_id = id(999);
		await expect(f.client.refreshAccountMetadata!()).rejects.toThrow("could not be refreshed");
		expect(f.calls).toHaveLength(1);
	});
	it("joins another tab's completed scoped attempt after busy admission", async () => {
		const f = setup();
		f.fetcher.mockResolvedValueOnce(Response.json({ code: "55000", message: "busy" }, { status: 400 }));
		await f.client.refreshAccountMetadata!();
		expect(f.calls.map((c) => c.url)).toEqual([
			"https://fixture.invalid/rest/v1/rpc/qorpera_get_native_account_refresh",
		]);
	});
});
