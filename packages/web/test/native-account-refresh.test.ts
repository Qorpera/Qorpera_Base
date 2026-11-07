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
function observed(observedAt: string, resetAt?: string): NativeExecutionConnections {
	return {
		...accounts,
		connections: accounts.connections.map((account) => ({
			...account,
			providerAccountUsage: {
				observedAt,
				windows: [{ id: "primary" as const, label: "5 hours", usedPercent: 30, ...(resetAt ? { resetAt } : {}) }],
			},
		})),
	};
}
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
	it("asks about the accounts the caller just read, not the cloud again", async () => {
		const f = setup();
		const pending = f.client.refreshAccountMetadata!(undefined, false, accounts);
		await f.guestStarted.promise;
		expect(f.list).not.toHaveBeenCalled();
		f.finish();
		await pending;
		await f.client.refreshAccountMetadata!();
		expect(f.list).toHaveBeenCalledTimes(1);
	});

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
	it("does not create a maintenance request while every account's usage was observed within the last minute", async () => {
		const f = setup();
		f.list.mockResolvedValue(observed(new Date(Date.now() - 30_000).toISOString()));
		await f.client.refreshAccountMetadata!();
		await f.client.refreshAccountMetadata!();
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(f.list).toHaveBeenCalledTimes(2);
	});
	it.each([
		["a minute-old observation", () => observed(new Date(Date.now() - 61_000).toISOString())],
		["a passed window reset", () => observed(new Date().toISOString(), new Date(Date.now() - 1_000).toISOString())],
	])("treats %s as stale and asks for a new observation", async (_, accounts) => {
		const f = setup();
		f.receipt.status = "completed";
		f.list.mockResolvedValueOnce(accounts());
		await f.client.refreshAccountMetadata!();
		expect(f.calls.map((c) => c.url.split("/").pop())).toEqual(["qorpera_begin_native_account_refresh"]);
	});
	it("asks admission at most once per expiry window, however often views ask", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const f = setup();
			const first = f.client.refreshAccountMetadata!();
			await f.guestStarted.promise;
			f.finish();
			await first;
			expect(f.calls).toHaveLength(2);
			// The thread view and the Connections page ask again every minute; the
			// completed attempt answers them until it expires, without any request,
			// even though the attempt observed no usage for this account.
			for (let minute = 1; minute < 5; minute++) {
				vi.setSystemTime(Date.now() + 60_000);
				await f.client.refreshAccountMetadata!();
			}
			expect(f.calls).toHaveLength(2);
			expect(f.list).toHaveBeenCalledTimes(5);
			vi.setSystemTime(Date.parse(f.receipt.expires_at) + 1);
			f.receipt.status = "completed";
			f.receipt.expires_at = new Date(Date.now() + 300_000).toISOString();
			await f.client.refreshAccountMetadata!();
			expect(f.calls).toHaveLength(3);
			const before = JSON.parse(String(f.calls[0]?.init?.body)),
				after = JSON.parse(String(f.calls[2]?.init?.body));
			expect(after.p_client_request_id).not.toBe(before.p_client_request_id);
		} finally {
			vi.useRealTimers();
		}
	});
	it.each([
		["a reset that passed since the completed attempt", false],
		["the member's own Refresh", true],
	])("asks for a new attempt inside the window for %s", async (_, force) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const f = setup();
			f.receipt.status = "completed";
			await f.client.refreshAccountMetadata!();
			expect(f.calls).toHaveLength(1);
			vi.setSystemTime(Date.now() + 120_000);
			const fresh = new Date().toISOString();
			f.list.mockResolvedValue(observed(fresh));
			await f.client.refreshAccountMetadata!();
			expect(f.calls).toHaveLength(1);
			if (!force) f.list.mockResolvedValue(observed(fresh, new Date(Date.now() - 1_000).toISOString()));
			await f.client.refreshAccountMetadata!(undefined, force);
			expect(f.calls.map((c) => c.url.split("/").pop())).toEqual([
				"qorpera_begin_native_account_refresh",
				"qorpera_begin_native_account_refresh",
			]);
			const before = JSON.parse(String(f.calls[0]?.init?.body)),
				after = JSON.parse(String(f.calls[1]?.init?.body));
			expect(after.p_client_request_id).not.toBe(before.p_client_request_id);
		} finally {
			vi.useRealTimers();
		}
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
	it("watches a pending attempt with backed-off reads instead of re-asking busy admission", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const f = setup();
			let reads = 0;
			const urls: string[] = [];
			f.fetcher.mockImplementation(async (url: string | URL | Request) => {
				urls.push(String(url).split("/").pop()!);
				if (String(url).endsWith("qorpera_begin_native_account_refresh"))
					return Response.json({ code: "55000", message: "Account refresh already in progress" }, { status: 500 });
				if (String(url).endsWith("qorpera_get_native_account_refresh"))
					return Response.json(++reads < 6 ? f.receipt : { ...f.receipt, status: "completed" });
				throw new Error("Unexpected route");
			});
			const pending = f.client.refreshAccountMetadata!();
			await vi.waitFor(() => expect(urls).toHaveLength(2));
			await vi.advanceTimersByTimeAsync(1900);
			// One admission and one read; nothing again inside the first two seconds.
			expect(urls).toEqual(["qorpera_begin_native_account_refresh", "qorpera_get_native_account_refresh"]);
			await vi.advanceTimersByTimeAsync(60_000);
			await pending;
			// The pending attempt is only read (2 s, 3 s, 4.5 s, 6.75 s, then every 10 s); admission is never re-asked.
			expect(urls.filter((url) => url === "qorpera_begin_native_account_refresh")).toHaveLength(1);
			expect(reads).toBe(6);
		} finally {
			vi.useRealTimers();
		}
	});
	it("asks admission again only after the watched attempt is gone", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const f = setup();
			let begins = 0,
				reads = 0;
			f.fetcher.mockImplementation(async (url: string | URL | Request) => {
				if (String(url).endsWith("qorpera_begin_native_account_refresh"))
					return ++begins === 1
						? Response.json({ code: "55000", message: "Account refresh already in progress" }, { status: 500 })
						: Response.json({ ...f.receipt, status: "completed" });
				if (String(url).endsWith("qorpera_get_native_account_refresh")) {
					reads++;
					return Response.json(null);
				}
				throw new Error("Unexpected route");
			});
			const pending = f.client.refreshAccountMetadata!();
			await vi.waitFor(() => expect(reads).toBe(1));
			await vi.advanceTimersByTimeAsync(1900);
			expect(begins).toBe(1);
			await vi.advanceTimersByTimeAsync(200);
			await pending;
			expect(begins).toBe(2);
		} finally {
			vi.useRealTimers();
		}
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
