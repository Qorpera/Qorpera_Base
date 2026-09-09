import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	accountAuthStoragePath,
	FileAccountAuthStorage,
	projectQorperaAccount,
	QorperaAccountAuth,
	type QorperaAccountAuthOptions,
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
	it("does not require the Company File gateway for office or account cleanup APIs", () => {
		const id = (n: number) => `37000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
		const auth = new QorperaAccountAuth(temporaryRoot("headless-office"), {
			projectUrl: "https://project.test",
			publishableKey: "public",
			openExternal: async () => {},
		});
		expect(auth.memberCompanyComputer(id(1), id(2), id(3))).toBeDefined();
		expect(auth.memberBrowserRecovery(id(3))).toBeDefined();
		expect(() => auth.memberCompanyFile(id(1), id(2), id(3))).toThrow("gateway is not configured");
	});
	it("requires explicit trusted TLS configuration for office viewing", () => {
		const id = (n: number) => `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
		const options = {
			projectUrl: "https://project.test",
			publishableKey: "public",
			objectGatewayUrl: "https://objects.test",
			openExternal: async () => {},
		};
		const auth = new QorperaAccountAuth(temporaryRoot("office-viewer"), options);
		expect(auth.memberCompanyComputerViews(id(1), id(2), id(3))).toBeUndefined();
		for (const officeViewerOrigin of [
			"ws://office.test",
			"wss://user:password@office.test",
			"wss://office.test/path",
			"wss://office.test?token=secret",
		]) {
			expect(
				() =>
					new QorperaAccountAuth(temporaryRoot("bad-office-viewer"), {
						...options,
						officeViewerOrigin,
						officeViewerClientOrigin: "https://desktop.test",
					}),
			).toThrow("Invalid Company Computer viewer origin");
		}
		const configured = new QorperaAccountAuth(temporaryRoot("configured-office-viewer"), {
			...options,
			officeViewerOrigin: "wss://office.test",
			officeViewerClientOrigin: "https://desktop.test",
		});
		const views = configured.memberCompanyComputerViews(id(1), id(2), id(3))!;
		expect(
			views({ companyId: id(1), environmentId: id(2), companyComputerId: id(4), logicalComputerId: id(5) }),
		).toBeDefined();
		expect(() =>
			views({ companyId: id(9), environmentId: id(2), companyComputerId: id(4), logicalComputerId: id(5) }),
		).toThrow();
	});
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

	it("uses the hosted credential-blind native login bridge without desktop configuration", async () => {
		let requestedUrl = "";
		const auth = new QorperaAccountAuth(temporaryRoot("native-login-bridge"), {
			projectUrl: "https://project.test",
			publishableKey: "sb_publishable_test",
			fetch: async (input) => {
				requestedUrl = String(input);
				return Response.json({
					schema: "qorpera.native-provider-login-result/v1",
					login_id: "10000000-0000-4000-8000-000000000001",
					status: "awaiting_member",
					interaction_url: "https://auth.openai.com/device",
					user_code: "ABCD-EFGH",
				});
			},
			openExternal: async () => {},
		});
		await expect(
			auth.nativeProviderIdentityBridge().beginLogin({
				loginId: "10000000-0000-4000-8000-000000000001",
				clientLoginId: "10000000-0000-4000-8000-000000000002",
				clientConnectionId: "10000000-0000-4000-8000-000000000003",
				computeIdentityId: "10000000-0000-4000-8000-000000000004",
				computeIdentityOwnershipKind: "member",
				computeIdentityOwnerUserId: "10000000-0000-4000-8000-000000000005",
				provider: "openai",
				nativeHarness: "codex-cli",
				capability: "a".repeat(43),
				expiresAt: "2099-08-21T12:15:00.000Z",
			}),
		).resolves.toMatchObject({ status: "awaiting_member", userCode: "ABCD-EFGH" });
		expect(requestedUrl).toBe("https://project.test/functions/v1/native-provider-login/login");
	});

	it("routes production company objects through cloud storage first by default", async () => {
		const userData = temporaryRoot("production-object-gateway");
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
		new FileAccountAuthStorage(accountAuthStoragePath(userData)).setItem(
			"sb-wovsmjvghnbcbfazdtvr-auth-token",
			JSON.stringify({
				access_token: accessToken,
				refresh_token: "refresh-token",
				expires_at: Math.floor(Date.now() / 1000) + 3600,
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
		);
		const profileId = "10000000-0000-4000-8000-000000000001";
		const bytes = Buffer.from("company object", "utf-8");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const requestedUrls: string[] = [];
		const auth = new QorperaAccountAuth(userData, {
			fetch: async (input) => {
				requestedUrls.push(String(input));
				return new Response(bytes);
			},
			openExternal: async () => {},
		});

		await expect(
			auth.hostedObjects().getObject(profileId, {
				sha256,
				bytes: bytes.byteLength,
				mediaType: "application/octet-stream",
			}),
		).resolves.toEqual(Uint8Array.from(bytes));
		/* Cloud-first since the transports chained: the gateway remains the
		 * per-object fallback and the dual-write keeps the NAS converged. */
		expect(requestedUrls).toHaveLength(1);
		expect(requestedUrls[0]).toContain(`/storage/v1/object/qorpera-profile-objects/${profileId}/${sha256}`);
	});

	it("connects session run controls to the authenticated RPC client with an abort signal", async () => {
		const sessionId = "28000000-0000-4000-8000-000000000055";
		const staffAgentId = "28000000-0000-4000-8000-000000000054";
		let path = "";
		let body: unknown;
		let signal: AbortSignal | null | undefined;
		const auth = new QorperaAccountAuth(temporaryRoot("session-run-control"), {
			projectUrl: "https://project.test",
			publishableKey: "sb_publishable_test",
			openExternal: async () => {},
			fetch: async (input, options) => {
				path = String(input);
				body = JSON.parse(String(options?.body));
				signal = options?.signal;
				return Response.json({ session_id: sessionId, staff_agent_id: staffAgentId, run: null });
			},
		});
		await expect(auth.cloudSessionRunControl().read(sessionId, staffAgentId)).resolves.toEqual({
			sessionId,
			staffAgentId,
			run: null,
		});
		expect(path).toBe("https://project.test/rest/v1/rpc/qorpera_get_session_run_control");
		expect(body).toEqual({ p_session_id: sessionId });
		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("can explicitly use Supabase Storage for production acceptance while the NAS is offline", async () => {
		const profileId = "10000000-0000-4000-8000-000000000001";
		const bytes = Buffer.from("acceptance object", "utf-8");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const requestedUrls: string[] = [];
		const auth = new QorperaAccountAuth(temporaryRoot("supabase-object-primary"), {
			objectStoragePrimary: "supabase",
			fetch: async (input) => {
				requestedUrls.push(String(input));
				return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
			},
			openExternal: async () => {},
		});

		await expect(
			auth.hostedObjects().getObject(profileId, {
				sha256,
				bytes: bytes.byteLength,
				mediaType: "application/octet-stream",
			}),
		).resolves.toEqual(Uint8Array.from(bytes));
		expect(requestedUrls).toHaveLength(1);
		expect(requestedUrls[0]).toContain(`/storage/v1/object/qorpera-profile-objects/${profileId}/${sha256}`);
	});

	it("restores the last validated account when an expired session cannot refresh offline", async () => {
		const userData = temporaryRoot("account-offline");
		const storage = new FileAccountAuthStorage(accountAuthStoragePath(userData));
		const user = {
			id: "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f",
			email: "founder@qorpera.com",
			aud: "authenticated",
			role: "authenticated",
			app_metadata: { provider: "github" },
			user_metadata: { full_name: "Qorpera Founder" },
			created_at: "2026-08-15T00:00:00.000Z",
		};
		const payload = Buffer.from(
			JSON.stringify({
				sub: user.id,
				aud: "authenticated",
				role: "authenticated",
				exp: Math.floor(Date.now() / 1000) - 60,
			}),
		).toString("base64url");
		storage.setItem(
			"sb-project-auth-token",
			JSON.stringify({
				access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`,
				refresh_token: "refresh-token",
				expires_at: Math.floor(Date.now() / 1000) - 60,
				expires_in: 3600,
				token_type: "bearer",
				user,
			}),
		);
		storage.setItem(
			"qorpera-account-projection/v1",
			JSON.stringify({
				schema: "qorpera-account-projection/v1",
				account: {
					id: user.id,
					email: user.email,
					displayName: "Qorpera Founder",
					provider: "github",
				},
			}),
		);

		const auth = new QorperaAccountAuth(userData, {
			projectUrl: "https://project.test",
			publishableKey: "sb_publishable_test",
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
			openExternal: async () => {},
		});
		expect(await auth.info()).toEqual({
			authenticated: true,
			offline: true,
			user: {
				id: user.id,
				email: user.email,
				displayName: "Qorpera Founder",
				provider: "github",
			},
		});
	});

	it("persists remembered browser sessions and keeps unremembered sessions in memory", async () => {
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
		const options: QorperaAccountAuthOptions = {
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
		};
		const auth = new QorperaAccountAuth(userData, options);

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
		const restored = new QorperaAccountAuth(userData, options);
		expect(await restored.info()).toEqual(account);
		expect(await restored.signOut()).toEqual({ authenticated: false });
		expect(existsSync(accountAuthStoragePath(userData))).toBe(false);

		const ephemeral = new QorperaAccountAuth(userData, options);
		expect(await ephemeral.signInWithProvider("github", { rememberLocally: false })).toEqual(account);
		expect(await ephemeral.info()).toEqual(account);
		expect(existsSync(accountAuthStoragePath(userData))).toBe(false);
		expect(await new QorperaAccountAuth(userData, options).info()).toEqual({ authenticated: false });
		expect(await ephemeral.signOut()).toEqual({ authenticated: false });
	});
});
