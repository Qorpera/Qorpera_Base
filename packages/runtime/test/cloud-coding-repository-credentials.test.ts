import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerRepositoryCredentials } from "../../../deploy/coding-worker/repository-credentials.ts";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CodingRepositoryCredentialRequest,
} from "../src/cloud-secret-broker.ts";
import { HttpCloudSecretBrokerService } from "../src/cloud-secret-broker-http.ts";
import { CloudSecretKeyring } from "../src/cloud-secret-crypto.ts";

// Bundle v88: the coding executor asks the company's secret broker for the
// repository token of one session it holds. Real broker HTTP service, real
// envelope sealing and opening; the kernel is a fake authority.

const services: HttpCloudSecretBrokerService[] = [];
const keyrings: CloudSecretKeyring[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const TOKEN = `gho_${"A1b2C3d4".repeat(4)}`;
const repository = { host: "github.com" as const, owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" };

async function fixture(options: { token?: string; refuse?: boolean } = {}) {
	const identity = {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 3,
		keyId: "company-kek-1",
	};
	const keyring = new CloudSecretKeyring({ [identity.keyId]: randomBytes(32) });
	keyrings.push(keyring);
	const envelope = Buffer.from(keyring.seal({ access_token: options.token ?? TOKEN }, identity));
	const authorizeRepositoryCredential = vi.fn(async (request: CodingRepositoryCredentialRequest) => {
		if (options.refuse) throw new Error("company GitHub connection is unavailable to this agent");
		return {
			schema: "qorpera.coding-repository-credential-authorization/v1",
			companyId: identity.companyId,
			environmentId: identity.environmentId,
			secretId: identity.secretId,
			secretVersion: identity.version,
			keyId: identity.keyId,
			connectorId: "github",
			credentialName: "access_token",
			// PostgreSQL's encode(...,'base64') wraps lines; the broker accepts that.
			encryptedEnvelopeBase64: envelope.toString("base64").replace(/(.{76})/g, "$1\n"),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
			workerId: request.workerId,
			repository: request.repository,
		};
	});
	const authority: CloudSecretBrokerAuthority = {
		describeCapture: vi.fn(async () => {
			throw new Error("unused");
		}),
		completeCapture: vi.fn(async () => {
			throw new Error("unused");
		}),
		authorizeOperation: vi.fn(async () => {
			throw new Error("unused");
		}),
		authorizeRepositoryCredential,
	};
	const broker = new CloudSecretBroker({ authority, keyring, adapters: [] });
	const runtimeToken = randomBytes(32).toString("base64url");
	const service = new HttpCloudSecretBrokerService(broker, runtimeToken);
	services.push(service);
	const port = await service.start();
	const requested: string[] = [];
	// The shared public origin, rewritten to the loopback listener.
	const rewrite: typeof fetch = (input, init) => {
		const url = new URL(String(input));
		requested.push(url.href);
		return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
	};
	const scope = { companyId: identity.companyId.toUpperCase(), workerId: randomUUID(), leaseToken: randomUUID() };
	const credentials = new BrokerRepositoryCredentials({
		origin: "https://secrets.qorpera.test",
		runtimeToken,
		executorOwner: "coding-node-02",
		fetch: rewrite,
	});
	return { identity, authorizeRepositoryCredential, runtimeToken, port, requested, scope, credentials };
}

describe("coding repository credentials through the company's secret broker", () => {
	it("lends the company connection's token to one step of the session the executor holds", async () => {
		const f = await fixture();
		const use = vi.fn(async (token: string) => token.length);
		await expect(
			f.credentials.withRepositoryToken(f.scope, repository, use, new AbortController().signal),
		).resolves.toBe(TOKEN.length);
		expect(use).toHaveBeenCalledExactlyOnceWith(TOKEN);
		expect(f.requested).toEqual([
			`https://secrets.qorpera.test/v1/repository-credentials?company=${f.identity.companyId}`,
		]);
		expect(f.authorizeRepositoryCredential).toHaveBeenCalledExactlyOnceWith(
			{
				workerId: f.scope.workerId,
				leaseToken: f.scope.leaseToken,
				executorOwner: "coding-node-02",
				repository,
			},
			expect.any(AbortSignal),
		);
		// Each step asks again: nothing is cached.
		await f.credentials.withRepositoryToken(f.scope, repository, use, new AbortController().signal);
		expect(f.authorizeRepositoryCredential).toHaveBeenCalledTimes(2);
	});

	it("answers only the runtime credential, never caches, and refuses without a token when the kernel refuses", async () => {
		const f = await fixture({ refuse: true });
		const body = JSON.stringify({
			schema: "qorpera.coding-repository-credential-request/v1",
			workerId: f.scope.workerId,
			leaseToken: f.scope.leaseToken,
			executorOwner: "coding-node-02",
			repository,
		});
		const post = (authorization: string) =>
			fetch(`http://127.0.0.1:${f.port}/v1/repository-credentials?company=${f.identity.companyId}`, {
				method: "POST",
				headers: { authorization, "content-type": "application/json" },
				body,
			});
		const stranger = await post(`Bearer ${randomBytes(32).toString("base64url")}`);
		expect(stranger.status).toBe(404);
		expect(await stranger.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "not_found" });
		expect(f.authorizeRepositoryCredential).not.toHaveBeenCalled();
		const refused = await post(`Bearer ${f.runtimeToken}`);
		expect(refused.status).toBe(403);
		expect(refused.headers.get("cache-control")).toBe("no-store");
		const text = await refused.text();
		expect(JSON.parse(text)).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
		expect(text).not.toContain(TOKEN);
		const use = vi.fn(async () => undefined);
		const failure = await f.credentials
			.withRepositoryToken(f.scope, repository, use, new AbortController().signal)
			.catch((error: unknown) => error as Error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("CODING_REPOSITORY_CREDENTIAL_UNAVAILABLE");
		expect(use).not.toHaveBeenCalled();
	});

	it("marks the released token no-store and refuses a malformed request before the kernel", async () => {
		const f = await fixture();
		const post = (value: Record<string, unknown>) =>
			fetch(`http://127.0.0.1:${f.port}/v1/repository-credentials`, {
				method: "POST",
				headers: { authorization: `Bearer ${f.runtimeToken}`, "content-type": "application/json" },
				body: JSON.stringify({
					schema: "qorpera.coding-repository-credential-request/v1",
					workerId: f.scope.workerId,
					leaseToken: f.scope.leaseToken,
					executorOwner: "coding-node-02",
					repository,
					...value,
				}),
			});
		const released = await post({});
		expect(released.status).toBe(200);
		expect(released.headers.get("cache-control")).toBe("no-store");
		expect(await released.json()).toEqual({ schema: "qorpera.coding-repository-credential/v1", token: TOKEN });
		for (const invalid of [
			{ repository: { ...repository, host: "gitlab.com" } },
			{ workerId: "../worker" },
			{ executorOwner: "exec owner" },
			{ extra: true },
		])
			expect((await post(invalid)).status).toBe(403);
		expect(f.authorizeRepositoryCredential).toHaveBeenCalledTimes(1);
	});

	it("refuses a sealed value that is not a GitHub token", async () => {
		const f = await fixture({ token: "not a token\n" });
		const use = vi.fn(async () => undefined);
		await expect(
			f.credentials.withRepositoryToken(f.scope, repository, use, new AbortController().signal),
		).rejects.toThrow("CODING_REPOSITORY_CREDENTIAL_UNAVAILABLE");
		expect(use).not.toHaveBeenCalled();
	});
});

describe("executor-side broker client", () => {
	const scope = { companyId: randomUUID(), workerId: randomUUID(), leaseToken: randomUUID() };
	const client = (fetcher: typeof fetch) =>
		new BrokerRepositoryCredentials({
			origin: "https://secrets.qorpera.test",
			runtimeToken: randomBytes(32).toString("base64url"),
			executorOwner: "coding-node-02",
			fetch: fetcher,
		});

	it("posts over HTTPS without following redirects and accepts only the exact answer", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ schema: "qorpera.coding-repository-credential/v1", token: TOKEN }),
		);
		await client(fetcher).withRepositoryToken(scope, repository, async () => undefined, new AbortController().signal);
		expect(fetcher).toHaveBeenCalledWith(
			`https://secrets.qorpera.test/v1/repository-credentials?company=${scope.companyId}`,
			expect.objectContaining({ method: "POST", redirect: "error" }),
		);
		for (const answer of [
			new Response("{}", { status: 302, headers: { location: "https://elsewhere.test/" } }),
			Response.json({ schema: "qorpera.coding-repository-credential/v1", token: TOKEN }, { status: 201 }),
			Response.json({ schema: "qorpera.coding-repository-credential/v1", token: TOKEN, expiresAt: null }),
			Response.json({ schema: "qorpera.coding-repository-credential/v2", token: TOKEN }),
			Response.json({ schema: "qorpera.coding-repository-credential/v1", token: `${TOKEN}\nx` }),
			new Response(JSON.stringify({ schema: "qorpera.coding-repository-credential/v1", token: TOKEN.repeat(200) })),
		]) {
			const use = vi.fn(async () => undefined);
			const error = await client(async () => answer)
				.withRepositoryToken(scope, repository, use, new AbortController().signal)
				.catch((failure: unknown) => failure as Error);
			expect((error as Error).message).toBe("CODING_REPOSITORY_CREDENTIAL_UNAVAILABLE");
			expect(use).not.toHaveBeenCalled();
		}
	});

	it("never reveals the token in an error and refuses an invalid scope or configuration", async () => {
		const leaked = await client(async () => {
			throw new Error(`network failure carrying ${TOKEN}`);
		})
			.withRepositoryToken(scope, repository, async () => undefined, new AbortController().signal)
			.catch((failure: unknown) => failure as Error);
		expect(String(leaked)).not.toContain(TOKEN);
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			client(fetcher).withRepositoryToken(
				{ ...scope, workerId: "../other" },
				repository,
				async () => undefined,
				new AbortController().signal,
			),
		).rejects.toThrow("SCOPE_INVALID");
		expect(fetcher).not.toHaveBeenCalled();
		for (const origin of [
			"http://secrets.qorpera.test",
			"https://secrets.qorpera.test/v1",
			"https://a:b@secrets.test",
		])
			expect(
				() =>
					new BrokerRepositoryCredentials({
						origin,
						runtimeToken: randomBytes(32).toString("base64url"),
						executorOwner: "coding-node-02",
					}),
			).toThrow("CONFIG_INVALID");
		expect(
			() =>
				new BrokerRepositoryCredentials({
					origin: "https://secrets.qorpera.test",
					runtimeToken: "short",
					executorOwner: "coding-node-02",
				}),
		).toThrow("CONFIG_INVALID");
	});
});
