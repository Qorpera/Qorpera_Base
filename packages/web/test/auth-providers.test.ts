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

describe("sign-in page weight", () => {
	// Attributes only: jsdom has no layout and loads no images, so this cannot show what a browser downloads.
	it("marks both lockups lazy, with loading set before src", () => {
		const f = fixture();
		f.auth(null);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => {})),
		);
		auth = new AuthController(f.cloud);
		renderSignIn(auth, root);
		const lockups = [...root.querySelectorAll<HTMLImageElement>(".auth-brand img")];
		expect(lockups.map((image) => image.className)).toEqual(["lockup-on-light", "lockup-on-dark"]);
		expect(lockups.map((image) => image.getAttribute("loading"))).toEqual(["lazy", "lazy"]);
		for (const image of lockups) {
			const names = image.getAttributeNames();
			expect(names.indexOf("loading")).toBeGreaterThanOrEqual(0);
			expect(names.indexOf("loading")).toBeLessThan(names.indexOf("src"));
		}
	});
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

	it("preserves a code being entered when delayed provider discovery completes", async () => {
		const f = fixture();
		f.auth(null);
		const response = deferred<Response>();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => response.promise),
		);
		auth = new AuthController(f.cloud);
		auth.store.subscribe(() => renderSignIn(auth, root));
		await auth.start();
		auth.store.set({ pendingEmail: "member@example.com" });
		await settle();
		root.querySelector<HTMLInputElement>("#signinCode")!.value = "12345";
		response.resolve(Response.json({ external: { google: true } }));
		await settle();
		expect(root.querySelector<HTMLInputElement>("#signinCode")!.value).toBe("12345");
		expect(root.querySelectorAll("[data-provider]")).toHaveLength(0);
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

	it.each([false, true])("removes callback credentials after initialization (failed: %s)", async (failed) => {
		const f = fixture();
		if (failed) f.auth(null);
		vi.mocked(f.cloud.supabase.auth.initialize).mockResolvedValue({
			error: failed ? new AuthError("Not a valid PKCE flow url") : null,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ external: {} })),
		);
		history.replaceState(
			null,
			"",
			"/?keep=yes&code=dummy-code&sb_flow_id=dummy-flow#access_token=dummy-access&refresh_token=dummy-refresh&provider_token=dummy-provider&provider_refresh_token=dummy-provider-refresh&expires_in=3600&expires_at=9999999999&token_type=bearer&type=magiclink",
		);
		auth = new AuthController(f.cloud);
		await auth.start();
		expect(location.search).toBe("?keep=yes");
		expect(location.hash).toBe("#/");
		expect(location.href).not.toContain("dummy-");
	});

	it("preserves an ordinary app route while removing rejected query callback data", async () => {
		const f = fixture();
		f.auth(null);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ external: {} })),
		);
		history.replaceState(
			null,
			"",
			"/?keep=yes&error=access_denied&error_description=private-description&error_code=expired#/account",
		);
		auth = new AuthController(f.cloud);
		await auth.start();
		expect(location.search).toBe("?keep=yes");
		expect(location.hash).toBe("#/account");
	});

	it("does not rewrite ordinary route or query parameters", async () => {
		const f = fixture();
		history.replaceState(null, "", "/?type=company&keep=yes#/c/company/file?code=notes");
		const before = location.href;
		auth = new AuthController(f.cloud);
		await auth.start();
		expect(location.href).toBe(before);
	});

	it("cleans a callback even when disposed during auth initialization", async () => {
		const f = fixture();
		const initialization = deferred<{ error: AuthError | null }>();
		vi.mocked(f.cloud.supabase.auth.initialize).mockReturnValue(initialization.promise);
		history.replaceState(null, "", "/#access_token=dummy-access&refresh_token=dummy-refresh");
		auth = new AuthController(f.cloud);
		const started = auth.start();
		auth.dispose();
		initialization.resolve({ error: new AuthError("Rejected callback") });
		await started;
		expect(location.hash).toBe("#/");
		expect(f.cloud.supabase.auth.onAuthStateChange).not.toHaveBeenCalled();
	});

	it("does not erase a different callback or app route opened during initialization", async () => {
		const f = fixture();
		const initialization = deferred<{ error: AuthError | null }>();
		vi.mocked(f.cloud.supabase.auth.initialize).mockReturnValue(initialization.promise);
		history.replaceState(null, "", "/?code=original#access_token=dummy-original");
		auth = new AuthController(f.cloud);
		const started = auth.start();
		history.replaceState({ retained: true }, "", "/?code=different&keep=yes#/account");
		const newer = location.href;
		initialization.resolve({ error: null });
		await started;
		expect(location.href).toBe(newer);
		expect(history.state).toEqual({ retained: true });
	});

	it("cleans callback credentials if initialization rejects unexpectedly", async () => {
		const f = fixture();
		vi.mocked(f.cloud.supabase.auth.initialize).mockRejectedValue(new Error("Initialization failed"));
		history.replaceState(null, "", "/#access_token=dummy-access&refresh_token=dummy-refresh");
		auth = new AuthController(f.cloud);
		await expect(auth.start()).rejects.toThrow("Initialization failed");
		expect(location.hash).toBe("#/");
	});
});
