// @vitest-environment jsdom
import { AuthError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { renderSignIn } from "../src/app/views/signin.ts";
import { deferred, fixture, settle } from "./fixtures.ts";

vi.mock("../src/app/views/crown.ts", () => ({ mountCrown: () => ({ dispose() {} }) }));

let auth: AuthController;
let root: HTMLElement;
beforeEach(() => {
	root = document.createElement("div");
	document.body.append(root);
	history.replaceState(null, "", "/");
});
afterEach(() => {
	auth?.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("deployed sign-in methods", () => {
	it("advertises only enabled providers and retains email input while settings load", async () => {
		const f = fixture();
		f.auth(null);
		const response = deferred<Response>();
		const fetchSettings = vi.fn(() => response.promise);
		vi.stubGlobal("fetch", fetchSettings);
		auth = new AuthController(f.cloud);
		auth.store.subscribe(() => renderSignIn(auth, root));
		await auth.start();
		await settle();
		expect(root.querySelectorAll("[data-provider]")).toHaveLength(0);
		const email = root.querySelector<HTMLInputElement>("#signinEmail")!;
		email.value = "member@example.com";
		email.focus();
		response.resolve(Response.json({ external: { google: true, github: false } }));
		await settle();
		expect(root.querySelectorAll("[data-provider]")).toHaveLength(1);
		expect(root.querySelector('[data-provider="google"]')).not.toBeNull();
		expect(root.querySelector<HTMLInputElement>("#signinEmail")!.value).toBe("member@example.com");
		expect(document.activeElement).toBe(root.querySelector("#signinEmail"));
		expect(fetchSettings).toHaveBeenCalledWith("https://fixture.invalid/auth/v1/settings", {
			headers: { apikey: "fixture-publishable" },
			credentials: "omit",
			signal: expect.any(AbortSignal),
		});
	});

	it.each([false, "true", null])("does not enable a provider from an invalid or disabled flag: %s", async (google) => {
		const f = fixture();
		f.auth(null);
		const oauth = vi.fn();
		Object.assign(f.cloud.supabase.auth, { signInWithOAuth: oauth });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ external: { google, github: false } })),
		);
		auth = new AuthController(f.cloud);
		await auth.start();
		await settle();
		renderSignIn(auth, root);
		expect(root.querySelectorAll("[data-provider]")).toHaveLength(0);
		expect(root.querySelector("form")).not.toBeNull();
		await auth.signInWithOAuth("google");
		expect(oauth).not.toHaveBeenCalled();
		expect(auth.store.get().error).toContain("Continue with email");
	});

	it("leaves email sign-in usable after provider discovery fails", async () => {
		const f = fixture();
		f.auth(null);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		auth = new AuthController(f.cloud);
		await auth.start();
		await settle();
		renderSignIn(auth, root);
		expect(root.querySelectorAll("[data-provider]")).toHaveLength(0);
		expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
		expect(auth.store.get().error).toBeUndefined();
	});

	it("surfaces an unsuccessful callback instead of silently returning to sign-in", async () => {
		const f = fixture();
		f.auth(null);
		vi.mocked(f.cloud.supabase.auth.initialize).mockResolvedValue({
			error: new AuthError("PKCE verifier unavailable"),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ external: {} })),
		);
		history.replaceState(null, "", "/?code=consumed-code");
		auth = new AuthController(f.cloud);
		await auth.start();
		await settle();
		renderSignIn(auth, root);
		expect(root.textContent).toContain("Request a new email code in this browser");
		expect(location.search).toBe("");
	});

	it("aborts discovery on disposal and ignores a late response", async () => {
		const f = fixture();
		f.auth(null);
		const response = deferred<Response>();
		let requestSignal: AbortSignal | null | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				requestSignal = init.signal;
				return response.promise;
			}),
		);
		auth = new AuthController(f.cloud);
		await auth.start();
		auth.dispose();
		expect(requestSignal?.aborted).toBe(true);
		response.resolve(Response.json({ external: { google: true, github: true } }));
		await settle();
		expect(auth.store.get().oauthProviders).toEqual([]);
	});
});
