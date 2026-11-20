import {
	type NativeExecutionConnections,
	NativeSubscriptionControlPlane,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeReadNotStarted, createWebNativeSubscription } from "../src/cloud/native-subscription.ts";
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
		// The read of a pending attempt, the admission, the guest.
		expect(f.calls.map((c) => c.url.split("/").pop())).toEqual([
			"qorpera_get_native_account_refresh",
			"qorpera_begin_native_account_refresh",
			"account-refresh",
		]);
		const admission = JSON.parse(String(f.calls[1]?.init?.body)),
			request = JSON.parse(String(f.calls[2]?.init?.body));
		expect(request.schema).toBe("qorpera.native-account-refresh/v1");
		expect(request.refresh_capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(new Headers(f.calls[2]?.init?.headers).get("authorization")).toBe(`Bearer ${request.refresh_capability}`);
		expect(new Headers(f.calls[2]?.init?.headers).has("apikey")).toBe(false);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.refresh_capability));
		expect(admission.p_capability_sha256).toBe(
			Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
		);
		f.finish();
		await Promise.all([first, second]);
	});
	it("polls the same admitted request while its guest is preparing", async () => {
		const f = setup();
		f.fetcher
			.mockResolvedValueOnce(Response.json(null))
			.mockResolvedValueOnce(Response.json(f.receipt))
			.mockResolvedValueOnce(
				Response.json({
					schema: "qorpera.native-account-refresh-result/v1",
					request_id: f.receipt.request_id,
					status: "preparing",
				}),
			);
		const pending = f.client.refreshAccountMetadata!();
		await f.guestStarted.promise;
		expect(f.fetcher).toHaveBeenCalledTimes(4);
		expect(f.fetcher.mock.calls[2]?.[1]?.body).toBe(f.fetcher.mock.calls[3]?.[1]?.body);
		f.finish();
		await pending;
	});
	it("retains admission authority after an uncertain guest response", async () => {
		const f = setup();
		f.fetcher
			.mockResolvedValueOnce(Response.json(null))
			.mockResolvedValueOnce(Response.json(f.receipt))
			.mockResolvedValueOnce(Response.json({}, { status: 503 }));
		await expect(f.client.refreshAccountMetadata!()).rejects.toThrow("could not be refreshed");
		// The server still shows the page's own attempt as pending: nothing marks a failed guest route.
		f.fetcher.mockResolvedValueOnce(Response.json(f.receipt));
		const retried = f.client.refreshAccountMetadata!();
		await f.guestStarted.promise;
		// Each attempt is a read, the admission and the guest. The retry does not watch its own pending attempt: it
		// sends the same admission, which answers the same request, and asks the guest again.
		expect(f.fetcher.mock.calls.map(([url]) => String(url).split("/").pop())).toEqual([
			"qorpera_get_native_account_refresh",
			"qorpera_begin_native_account_refresh",
			"account-refresh",
			"qorpera_get_native_account_refresh",
			"qorpera_begin_native_account_refresh",
			"account-refresh",
		]);
		expect(f.fetcher.mock.calls[1]?.[1]?.body).toBe(f.fetcher.mock.calls[4]?.[1]?.body);
		expect(f.fetcher.mock.calls[2]?.[1]?.body).toBe(f.fetcher.mock.calls[5]?.[1]?.body);
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
		expect(f.calls[2]?.url.endsWith("/account-refresh")).toBe(true);
		expect(f.calls[2]?.init?.signal?.aborted).toBe(false);
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
		expect(f.calls.map((c) => c.url.split("/").pop())).toEqual([
			"qorpera_get_native_account_refresh",
			"qorpera_begin_native_account_refresh",
		]);
	});
	it("asks admission at most once per expiry window, however often views ask", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const f = setup();
			const first = f.client.refreshAccountMetadata!();
			await f.guestStarted.promise;
			f.finish();
			await first;
			expect(f.calls).toHaveLength(3);
			// The thread view and the Connections page ask again every minute; the
			// completed attempt answers them until it expires, without any request,
			// even though the attempt observed no usage for this account.
			for (let minute = 1; minute < 5; minute++) {
				vi.setSystemTime(Date.now() + 60_000);
				await f.client.refreshAccountMetadata!();
			}
			expect(f.calls).toHaveLength(3);
			expect(f.list).toHaveBeenCalledTimes(5);
			vi.setSystemTime(Date.parse(f.receipt.expires_at) + 1);
			f.receipt.status = "completed";
			f.receipt.expires_at = new Date(Date.now() + 300_000).toISOString();
			await f.client.refreshAccountMetadata!();
			expect(f.calls).toHaveLength(5);
			const before = JSON.parse(String(f.calls[1]?.init?.body)),
				after = JSON.parse(String(f.calls[4]?.init?.body));
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
			expect(f.calls).toHaveLength(2);
			vi.setSystemTime(Date.now() + 120_000);
			const fresh = new Date().toISOString();
			f.list.mockResolvedValue(observed(fresh));
			await f.client.refreshAccountMetadata!();
			expect(f.calls).toHaveLength(2);
			if (!force) f.list.mockResolvedValue(observed(fresh, new Date(Date.now() - 1_000).toISOString()));
			await f.client.refreshAccountMetadata!(undefined, force);
			expect(f.calls.map((c) => c.url.split("/").pop())).toEqual([
				"qorpera_get_native_account_refresh",
				"qorpera_begin_native_account_refresh",
				"qorpera_get_native_account_refresh",
				"qorpera_begin_native_account_refresh",
			]);
			const before = JSON.parse(String(f.calls[1]?.init?.body)),
				after = JSON.parse(String(f.calls[3]?.init?.body));
			expect(after.p_client_request_id).not.toBe(before.p_client_request_id);
		} finally {
			vi.useRealTimers();
		}
	});
	it("uses the server's completed attempt cache without booting a guest", async () => {
		const f = setup();
		f.receipt.status = "completed";
		await f.client.refreshAccountMetadata!();
		expect(f.calls.map((c) => c.url.split("/").pop())).toEqual([
			"qorpera_get_native_account_refresh",
			"qorpera_begin_native_account_refresh",
		]);
	});
	it("does not join an attempt that had completed before it looked: admission says whether it is fresh", async () => {
		const f = setup();
		// The read shows a completed attempt that has not run out; nothing was watched, so admission is asked.
		const pending = f.client.refreshAccountMetadata!();
		await f.guestStarted.promise;
		expect(f.calls.map((c) => c.url.split("/").pop())).toEqual([
			"qorpera_get_native_account_refresh",
			"qorpera_begin_native_account_refresh",
			"account-refresh",
		]);
		f.finish();
		await pending;
	});
	it("rejects admission for a different compute identity before guest contact", async () => {
		const f = setup();
		f.receipt.compute_identity_id = id(999);
		f.fetcher.mockResolvedValueOnce(Response.json(null));
		await expect(f.client.refreshAccountMetadata!()).rejects.toThrow("could not be refreshed");
		expect(f.calls.map((c) => c.url.split("/").pop())).toEqual(["qorpera_begin_native_account_refresh"]);
	});
	it("rejects a watched attempt of a different compute identity before admission", async () => {
		const f = setup();
		f.receipt.compute_identity_id = id(999);
		await expect(f.client.refreshAccountMetadata!()).rejects.toThrow("could not be refreshed");
		expect(f.calls.map((c) => c.url.split("/").pop())).toEqual(["qorpera_get_native_account_refresh"]);
	});
	it("watches a pending attempt with backed-off reads and never asks admission while it is pending", async () => {
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
			await vi.waitFor(() => expect(urls).toHaveLength(1));
			await vi.advanceTimersByTimeAsync(1900);
			// One read; nothing again inside the first two seconds, and no admission: it would answer busy (a 500).
			expect(urls).toEqual(["qorpera_get_native_account_refresh"]);
			await vi.advanceTimersByTimeAsync(60_000);
			await pending;
			// The pending attempt is only read (2 s, 3 s, 4.5 s, 6.75 s, then every 10 s); admission is never asked.
			expect(urls.filter((url) => url === "qorpera_begin_native_account_refresh")).toHaveLength(0);
			expect(reads).toBe(6);
		} finally {
			vi.useRealTimers();
		}
	});
	it("after an uncertain guest answer, still only watches a pending attempt that is not its own", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const f = setup();
			f.fetcher
				.mockResolvedValueOnce(Response.json(null))
				.mockResolvedValueOnce(Response.json(f.receipt))
				.mockResolvedValueOnce(Response.json({}, { status: 503 }));
			await expect(f.client.refreshAccountMetadata!()).rejects.toThrow("could not be refreshed");
			// Another tab's attempt is pending now (the page's own has run out on the server, say).
			const other = { ...f.receipt, request_id: id(111) };
			const urls: string[] = [];
			let reads = 0;
			f.fetcher.mockImplementation(async (url: string | URL | Request) => {
				urls.push(String(url).split("/").pop()!);
				if (String(url).endsWith("qorpera_get_native_account_refresh"))
					return Response.json(++reads < 3 ? other : { ...other, status: "completed" });
				throw new Error("Unexpected route");
			});
			const retried = f.client.refreshAccountMetadata!();
			await vi.waitFor(() => expect(urls).toHaveLength(1));
			await vi.advanceTimersByTimeAsync(60_000);
			await retried;
			// Read at once, after 2 s and after 3 s more; neither admission nor the guest is asked.
			expect(urls).toEqual([
				"qorpera_get_native_account_refresh",
				"qorpera_get_native_account_refresh",
				"qorpera_get_native_account_refresh",
			]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("asks busy admission again only after a pause, once the read shows no attempt", async () => {
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
			// A read that shows no attempt, the admission that answers busy, and the read after it.
			await vi.waitFor(() => expect(reads).toBe(2));
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
		// Nothing pending at the read, then admission answers busy (another tab asked in between): the next read
		// shows that attempt completed, and it is joined without a pause.
		f.fetcher
			.mockResolvedValueOnce(Response.json(null))
			.mockResolvedValueOnce(Response.json({ code: "55000", message: "busy" }, { status: 400 }));
		await f.client.refreshAccountMetadata!();
		expect(f.calls.map((c) => c.url)).toEqual([
			"https://fixture.invalid/rest/v1/rpc/qorpera_get_native_account_refresh",
		]);
	});
});

describe("Claude reads and resets", () => {
	function claudeSetup(begin: (attempt: number, body: Record<string, unknown>) => Response) {
		const f = fixture();
		f.cloud.config.nativeProviderLoginUrl = "https://fixture.invalid/functions/v1/native-provider-login/";
		f.cloud.config.publishableKey = "sb_publishable_fixture1234";
		f.cloud.config.objectGatewayUrl = "https://objects.fixture.invalid";
		const receipt = {
			request_id: id(120),
			profile_id: profileA.profileId,
			compute_identity_id: id(104),
			requested_by_user_id: userA.id,
			expires_at: new Date(Date.now() + 300000).toISOString(),
			status: "pending",
		};
		const begins: Record<string, unknown>[] = [];
		const posts: { headers: Headers; body: Record<string, unknown> }[] = [];
		let polls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				if (String(url).endsWith("qorpera_begin_claude_login_read")) {
					begins.push(body);
					return begin(begins.length, body);
				}
				if (String(url).endsWith("/account-refresh")) {
					posts.push({ headers: new Headers(init?.headers), body });
					polls++;
					return Response.json({
						schema: "qorpera.native-account-refresh-result/v1",
						request_id: body.request_id,
						status: polls < 2 ? "preparing" : "completed",
					});
				}
				throw new Error("Unexpected route");
			}),
		);
		const client = createWebNativeSubscription(
			f.cloud,
			profileA.profileId,
			userA.id,
			new AbortController().signal,
			vi.fn(),
		);
		return { client, receipt, begins, posts };
	}

	it("asks for a read with a capability only the vault sees, and waits until the vault answers", async () => {
		const f = claudeSetup(() =>
			Response.json({
				request_id: id(120),
				profile_id: profileA.profileId,
				compute_identity_id: id(104),
				requested_by_user_id: userA.id,
				expires_at: new Date(Date.now() + 300000).toISOString(),
				status: "pending",
			}),
		);
		expect(await f.client.readClaude!({ loginId: id(130), force: true })).toBe(id(120));
		expect(f.begins).toHaveLength(1);
		expect(f.begins[0]).toMatchObject({
			p_profile_id: profileA.profileId,
			p_claude_login_id: id(130),
			p_force: true,
			p_reset_kind: null,
		});
		expect(f.begins[0]!.p_capability_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(f.posts).toHaveLength(2);
		const bearer = f.posts[0]!.headers.get("authorization")!.slice("Bearer ".length);
		const digest = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		expect(digest).toBe(f.begins[0]!.p_capability_sha256);
		expect(f.posts[0]!.body).toMatchObject({ request_id: id(120), refresh_capability: bearer });
	});

	it("answers at once when the reading is fresh", async () => {
		const f = claudeSetup(() =>
			Response.json({
				request_id: id(121),
				profile_id: profileA.profileId,
				compute_identity_id: id(104),
				requested_by_user_id: userA.id,
				expires_at: new Date(Date.now() + 300000).toISOString(),
				status: "completed",
			}),
		);
		expect(await f.client.readClaude!({ loginId: id(131) })).toBe(id(121));
		expect(f.begins[0]).toMatchObject({ p_claude_login_id: id(131), p_force: false, p_reset_kind: null });
		expect(f.posts).toEqual([]);
	});

	it("waits out another read before a reset, and says a reset that never began was not started", async () => {
		const pending = {
			request_id: id(122),
			profile_id: profileA.profileId,
			compute_identity_id: id(104),
			requested_by_user_id: userA.id,
			expires_at: new Date(Date.now() + 300000).toISOString(),
			status: "pending",
		};
		const busy = claudeSetup((attempt) =>
			attempt === 1
				? Response.json({ code: "55000", message: "Account refresh already in progress" }, { status: 400 })
				: Response.json(pending),
		);
		expect(await busy.client.readClaude!({ loginId: id(130), reset: "full" })).toBe(id(122));
		expect(busy.begins.map((body) => body.p_reset_kind)).toEqual(["full", "full"]);
		const refused = claudeSetup(() =>
			Response.json({ code: "55000", message: "No such Claude reset to use" }, { status: 400 }),
		);
		await expect(refused.client.readClaude!({ loginId: id(130), reset: "session" })).rejects.toBeInstanceOf(
			ClaudeReadNotStarted,
		);
		expect(refused.begins).toHaveLength(1);
		expect(refused.posts).toEqual([]);
	});

	it("lists the Claude login's usage, resets and last reset, and leaves out any part out of shape", async () => {
		const f = fixture();
		const login = {
			loginId: id(97),
			clientConnectionId: id(98),
			createdAt: timestamp,
			providerAccountEmail: null,
			usage: {
				observedAt: timestamp,
				windows: [{ id: "seven_day", label: "Weekly", usedPercent: 28, resetAt: timestamp }],
			},
			resets: {
				observedAt: timestamp,
				entries: [{ kind: null, left: 1, refills: null, weekStays: null, useBy: timestamp, usable: "at_limit" }],
			},
			lastReset: { requestId: id(99), kind: "full", outcome: "reset", left: 2, at: timestamp },
		};
		const fiveHour = { id: "five_hour", label: "5 hours", usedPercent: 100, resetAt: timestamp };
		const answers = [
			{ schema: "qorpera.claude-logins/v1", signInOpen: true, readable: true, logins: [login] },
			{
				schema: "qorpera.claude-logins/v1",
				signInOpen: true,
				logins: [
					{ ...login, usage: { ...login.usage, windows: [fiveHour, ...login.usage.windows] } },
					{ ...login, loginId: id(96), usage: { observedAt: timestamp, windows: [fiveHour] } },
					{
						...login,
						loginId: id(95),
						usage: { observedAt: timestamp, limitResetAt: timestamp, windows: [fiveHour] },
					},
				],
			},
			{
				schema: "qorpera.claude-logins/v1",
				signInOpen: false,
				logins: [
					{
						...login,
						usage: { observedAt: timestamp, windows: [{ id: "seven_day", label: "Weekly", usedPercent: 140 }] },
						resets: { observedAt: timestamp, entries: [{ kind: "lunar", left: 1, usable: "now" }] },
						lastReset: { requestId: id(99), kind: "full", outcome: "spent", left: 2, at: timestamp },
					},
				],
			},
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(answers.shift())),
		);
		const client = createWebNativeSubscription(
			f.cloud,
			profileA.profileId,
			userA.id,
			new AbortController().signal,
			vi.fn(),
		);
		const listed = await client.listClaudeLogins!();
		expect(listed.readable).toBe(true);
		expect(listed.logins[0]).toMatchObject({
			usage: login.usage,
			resets: { entries: [{ kind: null, left: 1, useBy: timestamp, usable: "at_limit" }] },
			lastReset: login.lastReset,
		});
		const older = await client.listClaudeLogins!();
		expect(older.logins[0]?.usage).toEqual(login.usage);
		expect(older.logins[1]).not.toHaveProperty("usage");
		expect(older.logins[2]?.usage).toEqual({ observedAt: timestamp, limitResetAt: timestamp, windows: [] });
		const bad = await client.listClaudeLogins!();
		expect(bad.readable).toBe(false);
		expect(bad.logins[0]).not.toHaveProperty("usage");
		expect(bad.logins[0]).not.toHaveProperty("resets");
		expect(bad.logins[0]).not.toHaveProperty("lastReset");
	});

	it("lists which Claude login is In use and until when one is used up, picks one and signs out naming the next", async () => {
		const f = fixture();
		const base = { clientConnectionId: id(98), createdAt: timestamp, providerAccountEmail: "work@example.com" };
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		const answers: unknown[] = [
			{
				schema: "qorpera.claude-logins/v1",
				signInOpen: true,
				readable: true,
				logins: [
					{ ...base, loginId: id(97), inUse: true, usedUpUntil: "2026-11-18T20:28:00Z" },
					{ ...base, loginId: id(96), inUse: false, usedUpUntil: null },
				],
			},
			{
				schema: "qorpera.claude-logins/v1",
				signInOpen: true,
				logins: [{ ...base, loginId: id(97), usedUpUntil: "soon" }],
			},
			{ schema: "qorpera.claude-login-use/v1", loginId: id(96), logins: [] },
			{ schema: "qorpera.claude-login-sign-out/v1", loginId: id(97), status: "revoked" },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
				return Response.json(answers.shift());
			}),
		);
		const client = createWebNativeSubscription(
			f.cloud,
			profileA.profileId,
			userA.id,
			new AbortController().signal,
			vi.fn(),
		);
		const listed = await client.listClaudeLogins!();
		expect(listed.logins.map((login) => [login.inUse ?? false, login.usedUpUntil])).toEqual([
			[true, "2026-11-18T20:28:00Z"],
			[false, undefined],
		]);
		await expect(client.listClaudeLogins!()).rejects.toThrow("Invalid cloud response");
		await client.useClaude!(id(96));
		await client.signOutClaude!(id(97), undefined, id(96));
		expect(calls.slice(2).map((call) => [call.url.split("/rpc/")[1], call.body])).toEqual([
			["qorpera_use_claude_login", { p_login_id: id(96) }],
			["qorpera_sign_out_claude_login", { p_login_id: id(97), p_next_login_id: id(96) }],
		]);
		await expect(client.signOutClaude!(id(97), undefined, "not-a-login")).rejects.toThrow("Invalid Claude login.");
	});
});
