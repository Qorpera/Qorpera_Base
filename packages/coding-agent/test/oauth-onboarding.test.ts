/**
 * OAuth onboarding (authorization code + PKCE) against a faux provider:
 * the browser leg is driven by fetching the loopback redirect ourselves.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCompanyConnections, resolveCompanySecret } from "../src/core/company-connections.ts";
import {
	createProtectedCompanySecretVault,
	protectedCompanySecretVaultPath,
} from "../src/core/company-secret-vault.ts";
import { runOAuthOnboarding } from "../src/core/oauth-onboarding.ts";

let root: string;
let prevAgentDir: string | undefined;
let provider: Server | undefined;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	prevAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
	process.env.QORPERA_CODING_AGENT_DIR = `${root}-agent-home`;
});

afterEach(() => {
	provider?.close();
	provider = undefined;
	if (prevAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
	else process.env.QORPERA_CODING_AGENT_DIR = prevAgentDir;
	for (const dir of [root, `${root}-agent-home`]) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

function base64url(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Faux token endpoint verifying the PKCE exchange; resolves its base URL. */
function startFauxProvider(grant: Record<string, unknown>, expectedChallenge: () => string): Promise<string> {
	return new Promise((resolveUrl) => {
		const seen: string[] = [];
		provider = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				const form = new URLSearchParams(body);
				const verifier = form.get("code_verifier") ?? "";
				if (
					form.get("grant_type") !== "authorization_code" ||
					form.get("code") !== "granted-code" ||
					!form.get("redirect_uri")?.startsWith("http://127.0.0.1:") ||
					base64url(createHash("sha256").update(verifier).digest()) !== expectedChallenge()
				) {
					response
						.writeHead(400)
						.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed", seen }));
					return;
				}
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(grant));
			});
		});
		provider.listen(0, "127.0.0.1", () => {
			resolveUrl(`http://127.0.0.1:${(provider?.address() as AddressInfo).port}`);
		});
	});
}

/** Play the founder's browser: follow the authorize URL's redirect with a code. */
function browse(url: string, overrides?: Record<string, string>): void {
	const authorize = new URL(url);
	const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
	redirect.searchParams.set("code", "granted-code");
	redirect.searchParams.set("state", overrides?.state ?? authorize.searchParams.get("state") ?? "");
	void fetch(redirect);
}

describe("oauth onboarding", () => {
	it("completes the PKCE flow and binds a refreshable oauth2 secret without any pasting", async () => {
		let challenge = "";
		const providerUrl = await startFauxProvider(
			{ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 },
			() => challenge,
		);
		const result = await runOAuthOnboarding(
			root,
			"prov",
			{
				authUrl: "https://provider.example/authorize",
				tokenUrl: `${providerUrl}/token`,
				clientId: "client-1",
				scope: "read",
			},
			{
				onAuthorizeUrl: (url) => {
					const authorize = new URL(url);
					challenge = authorize.searchParams.get("code_challenge") ?? "";
					expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
					expect(authorize.searchParams.get("client_id")).toBe("client-1");
					expect(authorize.searchParams.get("scope")).toBe("read");
					browse(url);
				},
			},
		);
		expect(result.kind).toBe("oauth2");
		expect(readCompanyConnections(root).secretNames).toEqual(["prov"]);
		// Unexpired: resolvable with no network.
		const failingFetch: typeof fetch = () => {
			throw new Error("no network expected");
		};
		expect(await resolveCompanySecret(root, "prov", failingFetch)).toBe("fresh-access");
	});

	it("delivers a Google Sheets grant only to the selected vault adapter", async () => {
		let challenge = "";
		const vaultPath = protectedCompanySecretVaultPath(`${root}-agent-home`, "local:test-company");
		const vault = createProtectedCompanySecretVault(vaultPath, {
			id: "test-protector",
			protect: (plaintext) => Buffer.from([...Buffer.from(plaintext, "utf-8")].map((value) => value ^ 0xa5)),
			unprotect: (ciphertext) => Buffer.from([...ciphertext].map((value) => value ^ 0xa5)).toString("utf-8"),
		});
		const providerUrl = await startFauxProvider(
			{ access_token: "google-access", refresh_token: "google-refresh", expires_in: 3600 },
			() => challenge,
		);
		writeFileSync(
			join(root, "connector-manifest.json"),
			JSON.stringify({
				secretName: "google_sheets_oauth",
				scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
			}),
			"utf-8",
		);

		await runOAuthOnboarding(
			root,
			"google_sheets_oauth",
			{
				authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenUrl: `${providerUrl}/token`,
				clientId: "qorpera-desktop-client",
				scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
				authorizationParameters: { access_type: "offline", prompt: "consent" },
			},
			{
				onAuthorizeUrl: (url) => {
					const authorize = new URL(url);
					challenge = authorize.searchParams.get("code_challenge") ?? "";
					expect(authorize.searchParams.get("access_type")).toBe("offline");
					expect(authorize.searchParams.get("prompt")).toBe("consent");
					browse(url);
				},
				storeSecret: (_companyRoot, name, secret) => vault.put(name, secret),
			},
		);

		expect(vault.get("google_sheets_oauth")).toMatchObject({
			kind: "oauth2",
			accessToken: "google-access",
			refreshToken: "google-refresh",
		});
		const protectedVaultContent = readFileSync(vaultPath, "utf-8");
		expect(protectedVaultContent).not.toContain("google-access");
		expect(protectedVaultContent).not.toContain("google-refresh");
		expect(readCompanyConnections(root).secretNames).toEqual([]);
		const portableCompanyContent = readFileSync(join(root, "connector-manifest.json"), "utf-8");
		expect(portableCompanyContent).toContain("google_sheets_oauth");
		expect(portableCompanyContent).not.toContain("google-access");
		expect(portableCompanyContent).not.toContain("google-refresh");
	});

	it("stores a static secret when the provider returns no refresh token", async () => {
		let challenge = "";
		const providerUrl = await startFauxProvider({ access_token: "only-access" }, () => challenge);
		const result = await runOAuthOnboarding(
			root,
			"prov",
			{ authUrl: "https://provider.example/authorize", tokenUrl: `${providerUrl}/token`, clientId: "client-1" },
			{
				onAuthorizeUrl: (url) => {
					challenge = new URL(url).searchParams.get("code_challenge") ?? "";
					browse(url);
				},
			},
		);
		expect(result.kind).toBe("static");
	});

	it("reports a safe provider error code when the token exchange fails", async () => {
		let challenge = "";
		const providerUrl = await startFauxProvider({ access_token: "unused" }, () => `${challenge}-wrong`);
		await expect(
			runOAuthOnboarding(
				root,
				"prov",
				{ authUrl: "https://provider.example/authorize", tokenUrl: `${providerUrl}/token`, clientId: "client-1" },
				{
					onAuthorizeUrl: (url) => {
						challenge = new URL(url).searchParams.get("code_challenge") ?? "";
						browse(url);
					},
				},
			),
		).rejects.toThrow("token endpoint returned 400 (invalid_grant): PKCE verification failed");
	});

	it("completes a Nordea-style POST consent flow without exposing header credentials in the URL", async () => {
		let authorizationQuery = new URLSearchParams();
		let authorizationHeaders: IncomingHttpHeaders = {};
		let tokenBody = "";
		let tokenHeaders: IncomingHttpHeaders = {};
		const providerUrl = await new Promise<string>((resolveUrl) => {
			provider = createServer((request, response) => {
				const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
				if (request.method === "POST" && requestUrl.pathname === "/business/v5/authorize") {
					authorizationQuery = requestUrl.searchParams;
					authorizationHeaders = request.headers;
					const browserUrl = new URL("https://login.nordea.test/consent");
					browserUrl.searchParams.set("redirect_uri", requestUrl.searchParams.get("redirect_uri") ?? "");
					browserUrl.searchParams.set("state", requestUrl.searchParams.get("state") ?? "");
					response.writeHead(302, { location: browserUrl.toString() }).end();
					return;
				}
				if (request.method === "POST" && requestUrl.pathname === "/business/v5/authorize/token") {
					tokenHeaders = request.headers;
					request.on("data", (chunk) => {
						tokenBody += chunk;
					});
					request.on("end", () => {
						response.writeHead(200, { "content-type": "application/json" }).end(
							JSON.stringify({
								access_token: "nordea-access",
								refresh_token: "nordea-refresh",
								expires_in: 3600,
							}),
						);
					});
					return;
				}
				response.writeHead(404).end();
			});
			provider.listen(0, "127.0.0.1", () => {
				resolveUrl(`http://127.0.0.1:${(provider?.address() as AddressInfo).port}`);
			});
		});
		const publicHeaders = {
			Signature: "SKIP_SIGNATURE_VALIDATION_FOR_SANDBOX",
			"X-Nordea-Originating-Host": "$" + "{url_host}",
			"X-Nordea-Originating-Date": "$" + "{http_date}",
			Digest: "$" + "{body_sha256_digest}",
		};
		const result = await runOAuthOnboarding(
			root,
			"nordea",
			{
				authUrl: `${providerUrl}/business/v5/authorize`,
				tokenUrl: `${providerUrl}/business/v5/authorize/token`,
				clientId: "sandbox-client-id",
				clientSecret: "sandbox-client-secret",
				scope: "ACCOUNTS_BASIC,ACCOUNTS_BALANCES,ACCOUNTS_TRANSACTIONS",
				authorizationMethod: "post",
				usePkce: false,
				authorizationParameters: { country: "DK", duration: "15552000" },
				authorizationHeaders: publicHeaders,
				clientAuthentication: {
					kind: "headers",
					clientIdHeader: "X-IBM-Client-Id",
					clientSecretHeader: "X-IBM-Client-Secret",
				},
				tokenHeaders: publicHeaders,
			},
			{ onAuthorizeUrl: browse },
		);

		expect(result.kind).toBe("oauth2");
		expect(authorizationQuery.get("country")).toBe("DK");
		expect(authorizationQuery.get("duration")).toBe("15552000");
		expect(authorizationQuery.get("scope")).toBe("ACCOUNTS_BASIC,ACCOUNTS_BALANCES,ACCOUNTS_TRANSACTIONS");
		expect(authorizationQuery.get("code_challenge")).toBeNull();
		expect(authorizationQuery.toString()).not.toContain("sandbox-client-secret");
		expect(authorizationHeaders["x-ibm-client-id"]).toBe("sandbox-client-id");
		expect(authorizationHeaders["x-ibm-client-secret"]).toBe("sandbox-client-secret");
		expect(authorizationHeaders.signature).toBe("SKIP_SIGNATURE_VALIDATION_FOR_SANDBOX");
		expect(authorizationHeaders["x-nordea-originating-host"]).toBe(new URL(providerUrl).host);
		expect(authorizationHeaders.digest).toBe(`SHA-256=${createHash("sha256").update("").digest("base64")}`);
		const form = new URLSearchParams(tokenBody);
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("code")).toBe("granted-code");
		expect(form.get("code_verifier")).toBeNull();
		expect(form.get("client_id")).toBeNull();
		expect(form.get("client_secret")).toBeNull();
		expect(tokenHeaders["x-ibm-client-id"]).toBe("sandbox-client-id");
		expect(tokenHeaders["x-ibm-client-secret"]).toBe("sandbox-client-secret");
		expect(tokenHeaders.digest).toBe(`SHA-256=${createHash("sha256").update(tokenBody).digest("base64")}`);
		expect(readCompanyConnections(root).secretNames).toEqual(["nordea"]);
	});

	it("rejects a redirect whose state was not minted by this flow", async () => {
		await expect(
			runOAuthOnboarding(
				root,
				"prov",
				{
					authUrl: "https://provider.example/authorize",
					tokenUrl: "https://provider.example/token",
					clientId: "c",
				},
				{ onAuthorizeUrl: (url) => browse(url, { state: "forged-state" }), timeoutMs: 5_000 },
			),
		).rejects.toThrow(/state mismatch/);
		expect(readCompanyConnections(root).secretNames).toEqual([]);
	});

	it("cancels the browser wait without storing a grant", async () => {
		const controller = new AbortController();
		await expect(
			runOAuthOnboarding(
				root,
				"prov",
				{
					authUrl: "https://provider.example/authorize",
					tokenUrl: "https://provider.example/token",
					clientId: "c",
				},
				{
					signal: controller.signal,
					onAuthorizeUrl: () => controller.abort(),
					timeoutMs: 5_000,
				},
			),
		).rejects.toThrow(/cancelled/);
		expect(readCompanyConnections(root).secretNames).toEqual([]);
	});

	it("rejects an already-cancelled flow without opening a listener", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runOAuthOnboarding(
				root,
				"prov",
				{
					authUrl: "https://provider.example/authorize",
					tokenUrl: "https://provider.example/token",
					clientId: "c",
				},
				{ signal: controller.signal },
			),
		).rejects.toThrow(/cancelled/);
		expect(readCompanyConnections(root).secretNames).toEqual([]);
	});

	it("rejects dangerous client-auth header names before contacting a provider", async () => {
		await expect(
			runOAuthOnboarding(
				root,
				"prov",
				{
					authUrl: "https://provider.example/authorize",
					tokenUrl: "https://provider.example/token",
					clientId: "c",
					clientSecret: "secret",
					authorizationMethod: "post",
					clientAuthentication: {
						kind: "headers",
						clientIdHeader: "Host",
						clientSecretHeader: "X-Client-Secret",
					},
				},
				{ timeoutMs: 5_000 },
			),
		).rejects.toThrow(/headers are invalid/);
		expect(readCompanyConnections(root).secretNames).toEqual([]);
	});
});
