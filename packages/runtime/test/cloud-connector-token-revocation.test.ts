import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CloudConnectorTokenRevocations,
	CloudConnectorTokenRevocationUpkeep,
	CloudConnectorTokenRevoker,
	type ConnectorTokenRevocationAuthority,
} from "../src/cloud-connector-token-revocation.ts";
import { CloudSecretKeyring, sealCloudSecretFields } from "../src/cloud-secret-crypto.ts";

const signal = () => new AbortController().signal;
const GOOGLE_TOKEN = "1//0refresh-token-canary";
const GITHUB_TOKEN = `gho_${"A".repeat(36)}`;
const client = { clientId: "Iv1.clientcanary", clientSecret: "client-secret-canary" };

afterEach(() => {
	vi.restoreAllMocks();
});

/** A fetch that records each request and answers from the queue. */
function provider(...answers: Array<{ status: number; body?: string } | Error>) {
	const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
	const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
		requests.push({
			url: String(url),
			method: init?.method ?? "GET",
			headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
			body: init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : "",
		});
		const answer = answers.shift() ?? { status: 500 };
		if (answer instanceof Error) throw answer;
		return new Response(answer.body ?? null, { status: answer.status });
	});
	return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

describe("the provider revoke calls", () => {
	it.each(["gmail", "google_drive"] as const)(
		"revokes a %s refresh token at Google with the token in the form body only",
		async (connectorId) => {
			const google = provider({ status: 200 });
			const revoker = new CloudConnectorTokenRevoker({ fetch: google.fetch });
			await expect(revoker.revoke(connectorId, { refresh_token: GOOGLE_TOKEN }, signal())).resolves.toBe("revoked");
			expect(google.requests).toEqual([
				{
					url: "https://oauth2.googleapis.com/revoke",
					method: "POST",
					headers: expect.objectContaining({ "content-type": "application/x-www-form-urlencoded" }),
					body: `token=${encodeURIComponent(GOOGLE_TOKEN)}`,
				},
			]);
		},
	);
	it("takes Google's invalid_token as already invalid and refuses anything else", async () => {
		const google = provider(
			{ status: 400, body: '{"error":"invalid_token","error_description":"Token expired or revoked"}' },
			{ status: 400, body: '{"error":"invalid_request"}' },
			{ status: 503, body: `upstream said ${GOOGLE_TOKEN}` },
			new Error(`socket closed near ${GOOGLE_TOKEN}`),
		);
		const revoker = new CloudConnectorTokenRevoker({ fetch: google.fetch });
		const fields = { refresh_token: GOOGLE_TOKEN };
		await expect(revoker.revoke("gmail", fields, signal())).resolves.toBe("already_invalid");
		await expect(revoker.revoke("gmail", fields, signal())).rejects.toThrow(/^Google answered 400$/);
		await expect(revoker.revoke("gmail", fields, signal())).rejects.toThrow(/^Google answered 503$/);
		await expect(revoker.revoke("gmail", fields, signal())).rejects.toThrow(/^Google could not be reached$/);
	});
	it("revokes exactly one GitHub OAuth App token with the app's credentials", async () => {
		const github = provider({ status: 204 }, { status: 404 }, { status: 422 });
		const revoker = new CloudConnectorTokenRevoker({ fetch: github.fetch, github: client });
		const fields = { access_token: GITHUB_TOKEN };
		await expect(revoker.revoke("github", fields, signal())).resolves.toBe("revoked");
		expect(github.requests[0]).toEqual({
			url: "https://api.github.com/applications/Iv1.clientcanary/token",
			method: "DELETE",
			headers: expect.objectContaining({
				authorization: `Basic ${Buffer.from("Iv1.clientcanary:client-secret-canary").toString("base64")}`,
				"user-agent": "qorpera-cloud-connector",
			}),
			body: JSON.stringify({ access_token: GITHUB_TOKEN }),
		});
		await expect(revoker.revoke("github", fields, signal())).resolves.toBe("already_invalid");
		await expect(revoker.revoke("github", fields, signal())).rejects.toThrow(/^GitHub answered 422$/);
		expect(github.requests.every((request) => !request.url.includes("/grant"))).toBe(true);
	});
	it("leaves a typed personal token alone and needs the GitHub client for an app token", async () => {
		const github = provider();
		const revoker = new CloudConnectorTokenRevoker({ fetch: github.fetch });
		await expect(revoker.revoke("github", { access_token: `ghp_${"B".repeat(36)}` }, signal())).resolves.toBe(
			"not_ours",
		);
		await expect(revoker.revoke("github", { access_token: GITHUB_TOKEN }, signal())).rejects.toThrow(
			/^the GitHub client is not configured$/,
		);
		await expect(revoker.revoke("gmail", { access_token: GOOGLE_TOKEN }, signal())).rejects.toThrow(
			/^the stored token is missing$/,
		);
		expect(github.requests).toEqual([]);
	});
});

const ids = {
	companyId: "10000000-0000-4000-8000-000000000001",
	environmentId: "10000000-0000-4000-8000-000000000002",
};
const secret = (n: number) => `10000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

/** A broker queue: real sealed envelopes, a fake SQL authority and a fake provider. */
function queue(entries: Array<{ connectorId: "gmail" | "google_drive" | "github"; fields: Record<string, string> }>) {
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ "company-kek-1": wrappingKey });
	const claims = entries.map((entry, index) => {
		const identity = { ...ids, secretId: secret(index + 1), version: 1, keyId: "company-kek-1" };
		const envelope = Buffer.from(sealCloudSecretFields(entry.fields, wrappingKey, identity));
		return {
			schema: "qorpera.connector-token-revocation/v1",
			...ids,
			secretId: identity.secretId,
			secretVersion: 1,
			keyId: "company-kek-1",
			connectorId: entry.connectorId,
			encryptedEnvelopeBase64: envelope.toString("base64"),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		};
	});
	const rounds: unknown[] = [claims];
	const authority = {
		claimConnectorTokenRevocations: vi.fn(async (limit: number) => {
			expect(limit).toBe(20);
			return rounds.shift() ?? [];
		}),
		completeConnectorTokenRevocation: vi.fn(
			async (_answer: Parameters<ConnectorTokenRevocationAuthority["completeConnectorTokenRevocation"]>[0]) => ({}),
		),
	} satisfies ConnectorTokenRevocationAuthority;
	return { keyring, claims, rounds, authority };
}

describe("a broker's revocation queue", () => {
	it("opens each envelope, revokes and records each outcome, and never records a token", async () => {
		const q = queue([
			{ connectorId: "gmail", fields: { refresh_token: GOOGLE_TOKEN } },
			{ connectorId: "github", fields: { access_token: GITHUB_TOKEN } },
			{ connectorId: "github", fields: { access_token: `ghp_${"C".repeat(36)}` } },
			{ connectorId: "google_drive", fields: { refresh_token: GOOGLE_TOKEN } },
		]);
		const calls = provider({ status: 200 }, { status: 204 }, { status: 500, body: GOOGLE_TOKEN });
		const revocations = new CloudConnectorTokenRevocations({
			authority: q.authority,
			keyring: q.keyring,
			revoker: new CloudConnectorTokenRevoker({ fetch: calls.fetch, github: client }),
		});
		await expect(revocations.pass(signal())).resolves.toEqual({ completed: 3, failed: 1 });
		expect(q.authority.completeConnectorTokenRevocation.mock.calls.map(([answer]) => answer)).toEqual([
			{ secretId: secret(1), version: 1, outcome: "revoked", error: null },
			{ secretId: secret(2), version: 1, outcome: "revoked", error: null },
			{ secretId: secret(3), version: 1, outcome: "not_ours", error: null },
			{ secretId: secret(4), version: 1, outcome: null, error: "Google answered 500" },
		]);
		expect(JSON.stringify(q.authority.completeConnectorTokenRevocation.mock.calls)).not.toMatch(/gho_|1\/\/0/);
		// A short claim ends the pass.
		expect(q.authority.claimConnectorTokenRevocations).toHaveBeenCalledOnce();
	});
	it("records a changed envelope or one that does not open, without calling the provider", async () => {
		const q = queue([
			{ connectorId: "gmail", fields: { refresh_token: GOOGLE_TOKEN } },
			{ connectorId: "gmail", fields: { refresh_token: GOOGLE_TOKEN } },
		]);
		const first = q.claims[0]!;
		first.envelopeSha256 = "0".repeat(64);
		// Sealed for another secret: the identity check refuses it.
		q.claims[1]!.secretId = secret(9);
		const calls = provider();
		await new CloudConnectorTokenRevocations({
			authority: q.authority,
			keyring: q.keyring,
			revoker: new CloudConnectorTokenRevoker({ fetch: calls.fetch }),
		}).pass(signal());
		expect(q.authority.completeConnectorTokenRevocation.mock.calls.map(([answer]) => answer)).toEqual([
			{ secretId: secret(1), version: 1, outcome: null, error: "the envelope digest differs" },
			{ secretId: secret(9), version: 1, outcome: null, error: "the envelope could not be opened" },
		]);
		expect(calls.requests).toEqual([]);
	});
	it("claims again while claims come back full, at most three times a pass", async () => {
		const revoke = vi.fn(async () => "revoked" as const);
		const claims = queue(
			Array.from({ length: 20 }, () => ({ connectorId: "gmail" as const, fields: { refresh_token: GOOGLE_TOKEN } })),
		);
		claims.authority.claimConnectorTokenRevocations.mockImplementation(async () => claims.claims);
		await expect(
			new CloudConnectorTokenRevocations({
				authority: claims.authority,
				keyring: claims.keyring,
				revoker: { revoke },
			}).pass(signal()),
		).resolves.toEqual({ completed: 60, failed: 0 });
		expect(claims.authority.claimConnectorTokenRevocations).toHaveBeenCalledTimes(3);
	});
	it("refuses a claim answer of the wrong shape before opening anything", async () => {
		const q = queue([{ connectorId: "gmail", fields: { refresh_token: GOOGLE_TOKEN } }]);
		q.rounds[0] = [{ ...q.claims[0], connectorId: "slack" }];
		const revoke = vi.fn();
		await expect(
			new CloudConnectorTokenRevocations({ authority: q.authority, keyring: q.keyring, revoker: { revoke } }).pass(
				signal(),
			),
		).rejects.toThrow("Token revocation claim is invalid");
		expect(revoke).not.toHaveBeenCalled();
		expect(q.authority.completeConnectorTokenRevocation).not.toHaveBeenCalled();
	});
});

describe("the single-company broker's loop", () => {
	it("runs a pass a minute, logs counts only, and survives a failed pass", async () => {
		vi.useFakeTimers();
		try {
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			const pass = vi
				.fn()
				.mockRejectedValueOnce(new Error(`database said ${GOOGLE_TOKEN}`))
				.mockResolvedValueOnce({ completed: 2, failed: 1 })
				.mockResolvedValue({ completed: 0, failed: 0 });
			const upkeep = new CloudConnectorTokenRevocationUpkeep({
				revocations: { pass },
				passEveryMs: 60_000,
				firstPassMs: 1000,
			});
			upkeep.start();
			await vi.advanceTimersByTimeAsync(1000);
			await vi.advanceTimersByTimeAsync(60_000);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(pass).toHaveBeenCalledTimes(3);
			expect(log.mock.calls.map(([line]) => line)).toEqual([
				"Connector token revocation: a pass stopped on an error; the next pass tries again.",
				"Connector token revocation: 2 completed, 1 failed (offered again later).",
			]);
			await upkeep.close();
			await vi.advanceTimersByTimeAsync(120_000);
			expect(pass).toHaveBeenCalledTimes(3);
			expect(pass.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
		} finally {
			vi.useRealTimers();
		}
	});
});
