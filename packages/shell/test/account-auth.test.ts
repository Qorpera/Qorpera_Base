import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	accountAuthStoragePath,
	FileAccountAuthStorage,
	projectQorperaAccount,
	QorperaAccountAuth,
} from "../src/account-auth.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
	const root = join(tmpdir(), `qorpera-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Qorpera account auth", () => {
	it("stores the Supabase session atomically outside the renderer", () => {
		const userData = temporaryRoot("account-storage");
		const path = accountAuthStoragePath(userData);
		const storage = new FileAccountAuthStorage(path);
		expect(storage.getItem("session")).toBeNull();
		storage.setItem("session", "first");
		storage.setItem("pkce", "verifier");
		expect(new FileAccountAuthStorage(path).getItem("session")).toBe("first");
		storage.removeItem("session");
		expect(new FileAccountAuthStorage(path).getItem("session")).toBeNull();
		expect(new FileAccountAuthStorage(path).getItem("pkce")).toBe("verifier");
		storage.clear();
		expect(existsSync(path)).toBe(false);
	});

	it("projects only stable public identity fields", () => {
		expect(
			projectQorperaAccount({
				id: "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f",
				email: "founder@qorpera.com",
				app_metadata: { provider: "github", secret: "hidden" },
				user_metadata: {
					full_name: "Qorpera Founder",
					avatar_url: "https://example.test/avatar.png",
					private_note: "hidden",
				},
				aud: "authenticated",
				created_at: "2026-08-15T00:00:00.000Z",
			} as never),
		).toEqual({
			id: "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f",
			email: "founder@qorpera.com",
			displayName: "Qorpera Founder",
			avatarUrl: "https://example.test/avatar.png",
			provider: "github",
		});
	});

	it("completes a browser PKCE callback and persists a Supabase user session", async () => {
		const userData = temporaryRoot("account-oauth");
		const userId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
		const payload = Buffer.from(
			JSON.stringify({
				sub: userId,
				aud: "authenticated",
				role: "authenticated",
				exp: Math.floor(Date.now() / 1000) + 3600,
			}),
		).toString("base64url");
		const accessToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
		const fauxFetch: typeof fetch = async (input) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
			if (url.pathname !== "/auth/v1/token" || url.searchParams.get("grant_type") !== "pkce") {
				throw new Error(`Unexpected Supabase request: ${url.pathname}${url.search}`);
			}
			return new Response(
				JSON.stringify({
					access_token: accessToken,
					refresh_token: "refresh-token",
					expires_in: 3600,
					token_type: "bearer",
					user: {
						id: userId,
						email: "founder@qorpera.com",
						aud: "authenticated",
						role: "authenticated",
						app_metadata: { provider: "github" },
						user_metadata: { full_name: "Qorpera Founder" },
						created_at: "2026-08-15T00:00:00.000Z",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const auth = new QorperaAccountAuth(userData, {
			projectUrl: "https://project.test",
			publishableKey: "sb_publishable_test",
			fetch: fauxFetch,
			timeoutMs: 5_000,
			openExternal: async (authorizationUrl) => {
				const redirectTo = new URL(authorizationUrl).searchParams.get("redirect_to");
				if (!redirectTo) throw new Error("Missing redirect_to");
				const response = await fetch(`${redirectTo}?code=faux-code`);
				expect(response.ok).toBe(true);
			},
		});

		const account = await auth.signInWithProvider("github");
		expect(account).toEqual({
			authenticated: true,
			user: {
				id: userId,
				email: "founder@qorpera.com",
				displayName: "Qorpera Founder",
				provider: "github",
			},
		});
		expect(await auth.info()).toEqual(account);
		expect(existsSync(accountAuthStoragePath(userData))).toBe(true);
		const persistedEntries: unknown = JSON.parse(readFileSync(accountAuthStoragePath(userData), "utf-8"));
		expect(
			persistedEntries && typeof persistedEntries === "object" && !Array.isArray(persistedEntries)
				? Object.keys(persistedEntries).filter((key) => key.endsWith("-code-verifier"))
				: null,
		).toEqual([]);
		expect(await auth.signOut()).toEqual({ authenticated: false });
		expect(existsSync(accountAuthStoragePath(userData))).toBe(false);
	});
});
