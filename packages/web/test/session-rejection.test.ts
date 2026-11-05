// @vitest-environment jsdom

import { AuthError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { type Cloud, CloudRpcError, createCloud, sessionRejection } from "../src/cloud/client.ts";
import { startGoodWillCard } from "../src/cloud/good-will.ts";
import { fixture, settle, userA } from "./fixtures.ts";

/* After the database move (new Auth signing keys) a browser kept its old session: the
 * cloud refused every request with "No suitable key or wrong key type" and the member saw
 * red errors instead of sign-in. A refusal of the session itself now signs the member out
 * in this browser, once; permission refusals, network failures and 5xx do not. */

const PROJECT = "https://rejects.example.invalid";
const storageKey = "qorpera-web-auth/v1";
const clouds: Cloud[] = [];
const controllers: AuthController[] = [];

function bearer(token: string): RequestInit {
	return { headers: new Headers({ Authorization: `Bearer ${token}`, apikey: "key" }) };
}

function refusal(status: number, body: unknown): Response {
	return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
}

describe("which cloud answers refuse the session itself", () => {
	it.each([
		[
			"PostgREST, new signing keys",
			"/rest/v1/rpc/qorpera_list_hosted_profiles",
			401,
			{ code: "PGRST301", message: "No suitable key or wrong key type" },
		],
		[
			"PostgREST, expired token",
			"/rest/v1/rpc/qorpera_list_hosted_profiles",
			401,
			{ code: "PGRST303", message: "JWT expired" },
		],
		[
			"PostgREST, invalid token",
			"/rest/v1/rpc/x",
			401,
			{ code: "PGRST301", message: "JWSError JWSInvalidSignature" },
		],
		["functions gateway", "/functions/v1/computer-billing/good-will-card", 401, { msg: "Invalid JWT" }],
		[
			"functions gateway code",
			"/functions/v1/x",
			401,
			{ code: "UNAUTHORIZED_INVALID_JWT_FORMAT", message: "Invalid" },
		],
		[
			"storage",
			"/storage/v1/object/list/pictures",
			401,
			{ statusCode: "401", error: "Unauthorized", message: "jwt expired" },
		],
		["Auth user, 401", "/auth/v1/user", 401, { code: 401, error_code: "no_authorization", msg: "no token" }],
		["Auth user, 403", "/auth/v1/user", 403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" }],
	])("%s", async (_name, path, status, body) => {
		await expect(
			sessionRejection(PROJECT, `${PROJECT}${path}`, bearer("token-1"), refusal(status, body)),
		).resolves.toEqual({ accessToken: "token-1" });
	});

	it("names the refresh token a refused refresh carried", async () => {
		const init = { method: "POST", headers: { apikey: "key" }, body: JSON.stringify({ refresh_token: "refresh-1" }) };
		for (const status of [401, 403])
			await expect(
				sessionRejection(PROJECT, `${PROJECT}/auth/v1/token?grant_type=refresh_token`, init, refusal(status, {})),
			).resolves.toEqual({ refreshToken: "refresh-1" });
		// Signing in (a code exchange) refused is not a stored session refused.
		await expect(
			sessionRejection(PROJECT, `${PROJECT}/auth/v1/token?grant_type=pkce`, init, refusal(403, {})),
		).resolves.toBeUndefined();
	});

	it.each([
		["a permission refusal", "/rest/v1/rpc/x", 403, { code: "42501", message: "Only an owner can do this." }],
		["a 401 that is not about the token", "/rest/v1/rpc/x", 401, { code: "42501", message: "permission denied" }],
		["a 401 with an empty body", "/functions/v1/x", 401, ""],
		["a server failure", "/rest/v1/rpc/x", 500, { message: "JWT secret is missing" }],
		["a gateway failure", "/auth/v1/user", 503, ""],
		["a refused logout", "/auth/v1/logout", 401, { msg: "invalid JWT" }],
		[
			"another host",
			"https://other.example.invalid/rest/v1/rpc/x",
			401,
			{ code: "PGRST301", message: "JWT expired" },
		],
	])("not %s", async (_name, path, status, body) => {
		const url = path.startsWith("https:") ? path : `${PROJECT}${path}`;
		await expect(sessionRejection(PROJECT, url, bearer("token-1"), refusal(status, body))).resolves.toBeUndefined();
	});

	it("not a request that carried no member token", async () => {
		await expect(
			sessionRejection(
				PROJECT,
				`${PROJECT}/rest/v1/rpc/x`,
				{ headers: { apikey: "key" } },
				refusal(401, { code: "PGRST301", message: "No suitable key or wrong key type" }),
			),
		).resolves.toBeUndefined();
	});
});

describe("a refused session signs the member out", () => {
	beforeEach(() => {
		history.replaceState(null, "", "/");
		localStorage.clear();
		localStorage.setItem(
			storageKey,
			JSON.stringify({
				access_token: "old-keys-token",
				refresh_token: "old-refresh-token",
				expires_at: Math.floor(Date.now() / 1000) + 3600,
				expires_in: 3600,
				token_type: "bearer",
				user: userA,
			}),
		);
		vi.stubGlobal("BroadcastChannel", undefined);
	});

	afterEach(async () => {
		for (const controller of controllers.splice(0)) controller.dispose();
		for (const cloud of clouds.splice(0)) await cloud.supabase.auth.dispose();
		localStorage.clear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function start(rest: (url: URL, init?: RequestInit) => Promise<Response>) {
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			requests.push(`${method} ${url.pathname}${url.search}`);
			if (url.pathname === "/auth/v1/logout") return refusal(403, { error_code: "bad_jwt", msg: "invalid JWT" });
			if (url.pathname === "/auth/v1/settings") return Response.json({ external: {} });
			return rest(url, init);
		});
		const cloud = createCloud({
			projectUrl: PROJECT,
			publishableKey: "fixture-publishable-key",
			objectGatewayUrl: "https://objects.example.invalid",
		});
		clouds.push(cloud);
		const auth = new AuthController(cloud);
		controllers.push(auth);
		await auth.start();
		expect(auth.store.get().session?.access_token).toBe("old-keys-token");
		return { cloud, auth, requests };
	}

	it("clears the session and shows sign-in once, however many calls were refused", async () => {
		const { cloud, auth, requests } = await start(async () =>
			refusal(401, { code: "PGRST301", details: null, hint: null, message: "No suitable key or wrong key type" }),
		);
		const calls = await Promise.allSettled([
			cloud.rpc("qorpera_list_hosted_profiles"),
			cloud.rpc("qorpera_list_profile_invitations"),
			cloud.rpc("qorpera_list_friends"),
		]);
		expect(calls.every((call) => call.status === "rejected" && call.reason instanceof CloudRpcError)).toBe(true);
		await vi.waitFor(() => expect(auth.store.get().session).toBeNull());
		await settle();
		expect(auth.store.get()).toMatchObject({
			session: null,
			user: null,
			message: "You were signed out. Sign in again.",
		});
		expect(localStorage.getItem(storageKey)).toBeNull();
		expect(requests.filter((request) => request.startsWith("POST /auth/v1/logout"))).toEqual([
			"POST /auth/v1/logout?scope=local",
		]);
		// Signed out, the next refused call has no session to clear: no second sign-out, no loop.
		await cloud.rpc("qorpera_list_hosted_profiles").catch(() => {});
		await settle();
		expect(requests.filter((request) => request.startsWith("POST /auth/v1/logout"))).toHaveLength(1);
	});

	it("signs out when a direct function call outside the SDK is refused", async () => {
		const { cloud, auth, requests } = await start(async (url) =>
			url.pathname.startsWith("/functions/v1/") ? refusal(401, { msg: "Invalid JWT" }) : Response.json([]),
		);
		await expect(startGoodWillCard(cloud, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).rejects.toThrow();
		await vi.waitFor(() => expect(auth.store.get().session).toBeNull());
		expect(auth.store.get().message).toBe("You were signed out. Sign in again.");
		expect(requests.filter((request) => request.startsWith("POST /auth/v1/logout"))).toHaveLength(1);
	});

	it("signs out when Auth refuses the session's token", async () => {
		const { cloud, auth } = await start(async (url) =>
			url.pathname === "/auth/v1/user"
				? refusal(403, {
						code: 403,
						error_code: "bad_jwt",
						msg: "invalid JWT: unable to parse or verify signature",
					})
				: Response.json([]),
		);
		await cloud.supabase.auth.getUser();
		await vi.waitFor(() => expect(auth.store.get().session).toBeNull());
		expect(auth.store.get().message).toBe("You were signed out. Sign in again.");
	});

	it.each([
		["a permission refusal", async () => refusal(403, { code: "42501", message: "Only an owner can do this." })],
		["a server failure", async () => refusal(500, { message: "internal error" })],
		["an unavailable gateway", async () => new Response("", { status: 503 })],
		[
			"a network failure",
			async (): Promise<Response> => {
				throw new TypeError("Failed to fetch");
			},
		],
	])("keeps the member signed in after %s", async (_name, answer) => {
		const { cloud, auth, requests } = await start(answer);
		await cloud.rpc("qorpera_list_hosted_profiles").catch(() => {});
		await settle();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(auth.store.get().session?.access_token).toBe("old-keys-token");
		expect(auth.store.get().message).toBeUndefined();
		expect(localStorage.getItem(storageKey)).not.toBeNull();
		expect(requests.some((request) => request.includes("/logout"))).toBe(false);
	});
});

describe("only the token this browser holds now counts", () => {
	afterEach(() => {
		for (const controller of controllers.splice(0)) controller.dispose();
		localStorage.clear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("ignores a late refusal of an earlier token and signs out on the current one", async () => {
		const f = fixture();
		let reject!: (rejection: { accessToken?: string; refreshToken?: string }) => void;
		const signOut = vi.fn(async () => ({ error: null }));
		Object.assign(f.cloud, {
			onSessionRejected: (listener: typeof reject) => {
				reject = listener;
				return () => {};
			},
		});
		Object.assign(f.cloud.supabase.auth, { signOut });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ external: {} })),
		);
		const auth = new AuthController(f.cloud);
		controllers.push(auth);
		await auth.start();
		expect(auth.store.get().session?.access_token).toBe("fixture-token");
		reject({ accessToken: "token-before-refresh" });
		reject({ refreshToken: "refresh-before-refresh" });
		await settle();
		expect(signOut).not.toHaveBeenCalled();
		expect(auth.store.get().session).not.toBeNull();
		reject({ refreshToken: "fixture-refresh" });
		reject({ accessToken: "fixture-token" });
		await settle();
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(signOut).toHaveBeenCalledWith({ scope: "local" });
		expect(auth.store.get()).toMatchObject({ session: null, message: "You were signed out. Sign in again." });
	});

	async function controller(signOut: ReturnType<typeof vi.fn>) {
		const f = fixture();
		let reject!: (rejection: { accessToken?: string; refreshToken?: string }) => void;
		Object.assign(f.cloud, {
			onSessionRejected: (listener: typeof reject) => {
				reject = listener;
				return () => {};
			},
		});
		Object.assign(f.cloud.supabase.auth, { signOut });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ external: {} })),
		);
		const auth = new AuthController(f.cloud);
		controllers.push(auth);
		await auth.start();
		return { f, auth, reject: (rejection: { accessToken?: string; refreshToken?: string }) => reject(rejection) };
	}

	it("forgets the stored session when Auth's sign-out could not remove it", async () => {
		localStorage.setItem(storageKey, JSON.stringify({ access_token: "fixture-token" }));
		const signOut = vi.fn(async () => ({ error: new AuthError("Session could not be loaded") }));
		const { auth, reject } = await controller(signOut);
		reject({ accessToken: "fixture-token" });
		await settle();
		expect(signOut).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(storageKey)).toBeNull();
		expect(auth.store.get()).toMatchObject({ session: null, message: "You were signed out. Sign in again." });
	});

	it("keeps a session a refresh put in place while the sign-out waited", async () => {
		const signOut = vi.fn(async () => ({ error: null }));
		const { f, auth, reject } = await controller(signOut);
		const refreshed = { ...auth.store.get().session!, access_token: "refreshed-token" };
		vi.mocked(f.cloud.supabase.auth.getSession).mockResolvedValue({ data: { session: refreshed }, error: null });
		reject({ accessToken: "fixture-token" });
		await settle();
		expect(signOut).not.toHaveBeenCalled();
		expect(auth.store.get().session?.access_token).toBe("fixture-token");
		expect(auth.store.get().message).toBeUndefined();
		// A later refusal of the token it holds then signs out as usual.
		vi.mocked(f.cloud.supabase.auth.getSession).mockResolvedValue({
			data: { session: auth.store.get().session! },
			error: null,
		});
		reject({ accessToken: "fixture-token" });
		await settle();
		expect(signOut).toHaveBeenCalledTimes(1);
	});
});
