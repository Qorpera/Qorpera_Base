/**
 * OAuth onboarding (authorization code + PKCE) against a faux provider:
 * the browser leg is driven by fetching the loopback redirect ourselves.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCompanyConnections, resolveCompanySecret } from "../src/core/company-connections.ts";
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
					response.writeHead(400).end(JSON.stringify({ error: "invalid_grant", seen }));
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
});
