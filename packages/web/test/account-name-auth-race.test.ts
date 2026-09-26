// @vitest-environment jsdom
import { type AuthChangeEvent, processLock } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { type Cloud, createCloud } from "../src/cloud/client.ts";
import { deferred, settle, userA } from "./fixtures.ts";

const storageKey = "qorpera-web-auth/v1";
const clouds: Cloud[] = [];
const controllers: AuthController[] = [];

beforeEach(() => {
	history.replaceState(null, "", "/");
	localStorage.clear();
	localStorage.setItem(
		storageKey,
		JSON.stringify({
			access_token: "fixture-access-token",
			refresh_token: "fixture-refresh-token",
			expires_at: Math.floor(Date.now() / 1000) + 3600,
			expires_in: 3600,
			token_type: "bearer",
			user: userA,
		}),
	);
	// Separate SDK clients below share storage like tabs; broadcasts are irrelevant
	// to whether a late request can overwrite that storage after sign-out.
	vi.stubGlobal("BroadcastChannel", undefined);
});

afterEach(async () => {
	for (const controller of controllers.splice(0)) controller.dispose();
	for (const cloud of clouds.splice(0)) await cloud.supabase.auth.dispose();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("account name saves and authentication transitions", () => {
	it.each([false, true])(
		"does not restore a signed-out session after a delayed save (Web Locks: %s)",
		async (webLocks) => {
			const locks = vi.fn(async (name: string, options: LockOptions, callback: (lock: Lock) => Promise<unknown>) =>
				processLock(name, -1, () => callback({ name, mode: options.mode ?? "exclusive" })),
			);
			vi.stubGlobal("navigator", { locks: webLocks ? { request: locks } : undefined });
			const started = deferred<void>();
			const response = deferred<Response>();
			const requests: string[] = [];
			vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				requests.push(`${method} ${new URL(url).pathname}`);
				if (url.endsWith("/auth/v1/user") && method === "PUT") {
					started.resolve();
					return response.promise;
				}
				if (url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
				if (url.endsWith("/auth/v1/settings")) return Response.json({ external: {} });
				if (url.endsWith("/auth/v1/user")) return Response.json(userA);
				throw new Error(`Unexpected auth request: ${method} ${url}`);
			});
			const cloud = createCloud({
				projectUrl: "https://auth-race.example.invalid",
				publishableKey: "fixture-publishable-key",
				objectGatewayUrl: "https://objects.example.invalid",
			});
			clouds.push(cloud);
			const auth = new AuthController(cloud);
			controllers.push(auth);
			await auth.start();
			const events: AuthChangeEvent[] = [];
			cloud.supabase.auth.onAuthStateChange((event) => {
				events.push(event);
			});
			// A second client exercises origin-wide lock coordination rather than
			// only the first client's internal pending-operation queue.
			const signOutCloud = webLocks ? createCloud(cloud.config) : cloud;
			if (webLocks) clouds.push(signOutCloud);
			await signOutCloud.supabase.auth.initialize();
			const saving = auth.updateName("Jonas");
			await started.promise;
			const signingOut = webLocks ? signOutCloud.supabase.auth.signOut() : auth.signOut();
			await settle();
			const signedOutBeforeSave = requests.includes("POST /auth/v1/logout");
			response.resolve(Response.json({ ...userA, user_metadata: { display_name: "Jonas" } }));
			await Promise.all([saving, signingOut]);
			expect(signedOutBeforeSave).toBe(false);
			expect(localStorage.getItem(storageKey)).toBeNull();
			expect((await cloud.supabase.auth.getSession()).data.session).toBeNull();
			if (webLocks) {
				expect(locks).toHaveBeenCalled();
				expect(locks.mock.calls.every(([name]) => name === `lock:${storageKey}`)).toBe(true);
			} else {
				expect(auth.store.get().user).toBeNull();
				expect(events.indexOf("USER_UPDATED")).toBeLessThan(events.indexOf("SIGNED_OUT"));
			}
		},
	);
});
