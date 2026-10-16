import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CloudSecretCaptureDescription,
	type CloudSecretConnectorAdapter,
	type CloudSecretOperationRequest,
	type CodingEnvironmentRequest,
	type CodingRepositoryCredentialRequest,
} from "@qorpera/runtime/cloud-secret-broker";
import {
	captureCloudSecret,
	HttpCloudSecretBrokerClient,
	HttpCloudSecretBrokerService,
	type NativeBindingProof,
} from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
});

// A coding session's environment value the kernel releases in these tests (not a real secret).
const ENVIRONMENT_VALUE = "env-value-HTTP-CANARY-0123";

function fixture(reflectSecret = false) {
	const identity = {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		keyId: "company-kek-1",
	};
	const ticketId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ [identity.keyId]: wrappingKey });
	const description: CloudSecretCaptureDescription = {
		schema: "qorpera.cloud-secret-capture-description/v1",
		ticketId,
		...identity,
		ownerKind: "company",
		ownerUserId: null,
		connectorId: "linear",
		secretName: "primary",
		purpose: "Company Linear connection",
		expiresAt: "2099-08-29T00:00:00.000Z",
	};
	let envelope = new Uint8Array();
	// The kernel releases one sealed environment secret for one leased coding session (5j-3).
	const authorizeCodingEnvironment = vi.fn(async (request: CodingEnvironmentRequest) => {
		const sealed = Buffer.from(keyring.seal({ value: ENVIRONMENT_VALUE }, identity));
		return {
			schema: "qorpera.coding-environment-authorization/v1",
			companyId: identity.companyId,
			environmentId: identity.environmentId,
			workerId: request.workerId,
			repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
			secrets: [
				{
					name: "API_KEY",
					secretId: identity.secretId,
					secretVersion: identity.version,
					keyId: identity.keyId,
					ownerKind: "member",
					encryptedEnvelopeBase64: sealed.toString("base64"),
					envelopeSha256: createHash("sha256").update(sealed).digest("hex"),
				},
			],
		};
	});
	const authority: CloudSecretBrokerAuthority = {
		describeCapture: vi.fn(async () => description),
		completeCapture: vi.fn(async (_ticket, _capability, encryptedEnvelope) => {
			envelope = Uint8Array.from(encryptedEnvelope);
			return {
				schema: "qorpera.cloud-secret-descriptor/v1",
				secretId: identity.secretId,
				version: 1,
				connectorId: "linear",
				secretName: "primary",
				purpose: description.purpose,
				ownerKind: "company",
				ownerUserId: null,
				status: "active",
			};
		}),
		authorizeOperation: vi.fn(async (request: CloudSecretOperationRequest) => ({
			schema: "qorpera.cloud-secret-operation-authorization/v1",
			companyId: identity.companyId,
			environmentId: identity.environmentId,
			secretId: identity.secretId,
			secretVersion: identity.version,
			keyId: identity.keyId,
			grantId: request.grantId,
			connectorId: request.connectorId,
			operationId: request.operationId,
			operationVersion: request.operationVersion,
			adapterSha256: request.adapterSha256,
			destinationOrigin: request.destinationOrigin,
			credentialName: "token",
			encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
			envelopeSha256: await crypto.subtle
				.digest("SHA-256", envelope)
				.then((value) => Buffer.from(value).toString("hex")),
			receiptId: request.receiptId,
			inputSha256: request.inputSha256,
		})),
		authorizeRepositoryCredential: vi.fn(async (request: CodingRepositoryCredentialRequest) => {
			// The kernel releases the sealed company connection for one leased session.
			const sealed = Buffer.from(keyring.seal({ access_token: "gho_REPOSITORY_TOKEN_0123456789" }, identity));
			return {
				schema: "qorpera.coding-repository-credential-authorization/v1",
				companyId: identity.companyId,
				environmentId: identity.environmentId,
				secretId: identity.secretId,
				secretVersion: identity.version,
				keyId: identity.keyId,
				connectorId: "github",
				credentialName: "access_token",
				encryptedEnvelopeBase64: sealed.toString("base64"),
				envelopeSha256: await crypto.subtle
					.digest("SHA-256", sealed)
					.then((value) => Buffer.from(value).toString("hex")),
				workerId: request.workerId,
				repository: request.repository,
			};
		}),
		authorizeCodingEnvironment,
	};
	const adapter: CloudSecretConnectorAdapter = {
		connectorId: "linear",
		operationId: "issue_create",
		operationVersion: 1,
		adapterSha256: "b".repeat(64),
		destinationOrigin: "https://api.linear.app",
		execute: vi.fn<CloudSecretConnectorAdapter["execute"]>(async ({ credentials }): Promise<JsonValue> => {
			if (reflectSecret) return { authorization: credentials.token };
			return { issueId: "LIN-1" };
		}),
	};
	const broker = new CloudSecretBroker({ authority, keyring, adapters: [adapter] });
	const runtimeToken = randomBytes(32).toString("base64url");
	const codingExecutorToken = randomBytes(32).toString("base64url");
	const binding = nativeToolAuthorityFixture().binding;
	// G2-6a: the run's own lease proves its binding; the database's proof stands in here.
	const holder = `job.${binding.jobId.toLowerCase()}.${randomBytes(32).toString("base64url")}`;
	const proveBinding = vi.fn<NativeBindingProof>(async (_binding, presented) => {
		if (presented !== holder) throw new Error("native binding proof is refused");
	});
	const service = new HttpCloudSecretBrokerService(broker, runtimeToken, { codingExecutorToken, proveBinding });
	services.push(service);
	const operation: CloudSecretOperationRequest = {
		binding,
		receiptId: randomUUID(),
		inputSha256: "a".repeat(64),
		grantId: randomUUID(),
		connectorId: "linear",
		operationId: "issue_create",
		operationVersion: 1,
		adapterSha256: adapter.adapterSha256,
		destinationOrigin: adapter.destinationOrigin,
		idempotencyKey: "issue-login",
		arguments: { title: "Login is broken" },
	};
	return {
		authority,
		authorizeCodingEnvironment,
		capability,
		ticketId,
		wrappingKey,
		keyring,
		runtimeToken,
		codingExecutorToken,
		broker,
		service,
		operation,
		holder,
		proveBinding,
	};
}

it("refuses a non-loopback listener even when a caller supplies one explicitly", () => {
	const f = fixture();
	expect(() => new HttpCloudSecretBrokerService(f.broker, f.runtimeToken, "0.0.0.0", 8080)).toThrow(
		"configuration is invalid",
	);
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("captures plaintext over the one-time member route and returns only a safe descriptor", async () => {
	const f = fixture();
	const port = await f.service.start();
	const canary = "lin_api_NEVER_VISIBLE";
	const rewrite: typeof fetch = (input, init) => {
		const url = new URL(String(input));
		return fetch(`http://127.0.0.1:${port}${url.pathname}`, init);
	};
	const descriptor = await captureCloudSecret(
		"https://secrets.qorpera.test",
		{ ticketId: f.ticketId, captureCapability: f.capability, fields: { token: canary } },
		new AbortController().signal,
		rewrite,
	);
	expect(descriptor).toEqual({
		schema: "qorpera.cloud-secret-descriptor/v1",
		secretId: expect.any(String),
		version: 1,
		connectorId: "linear",
		secretName: "primary",
		purpose: "Company Linear connection",
		ownerKind: "company",
		ownerUserId: null,
		status: "active",
	});
	expect(JSON.stringify(descriptor)).not.toContain(canary);
	const envelope = vi.mocked(f.authority.completeCapture).mock.calls[0][2];
	expect(Buffer.from(envelope).toString("utf8")).not.toContain(canary);
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("requires the private runtime credential and fences reflected secret material", async () => {
	const f = fixture(true);
	const port = await f.service.start();
	await captureCloudSecret(
		"https://secrets.qorpera.test",
		{ ticketId: f.ticketId, captureCapability: f.capability, fields: { token: "lin_api_REFLECTED" } },
		new AbortController().signal,
		(input, init) => fetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}`, init),
	);
	// The client names its company in the query so the shared origin's router
	// reaches this company's broker; the broker routes by path and ignores it.
	const companyId = randomUUID();
	const requested: string[] = [];
	const client = new HttpCloudSecretBrokerClient({
		origin: `http://127.0.0.1:${port}`,
		runtimeToken: f.runtimeToken,
		companyId: companyId.toUpperCase(),
		holder: () => f.holder,
		allowLoopback: true,
		fetch: (input, init) => {
			requested.push(String(input));
			return fetch(input, init);
		},
	});
	await expect(client.execute(f.operation, new AbortController().signal)).resolves.toEqual({
		kind: "json",
		value: {
			schema: "qorpera.connector-result/v1",
			status: "completed",
			result: "withheld_sensitive_response",
		},
	});
	const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/operations`, {
		method: "POST",
		headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}`, "content-type": "application/json" },
		body: "{}",
	});
	expect(unauthorized.status).toBe(404);
	expect(await unauthorized.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "not_found" });
	expect(f.authority.authorizeOperation).toHaveBeenCalledTimes(1);
	expect(requested).toEqual([`http://127.0.0.1:${port}/v1/operations?company=${companyId}`]);
	expect(
		() =>
			new HttpCloudSecretBrokerClient({
				origin: `http://127.0.0.1:${port}`,
				runtimeToken: f.runtimeToken,
				companyId: "../other",
				holder: () => f.holder,
				allowLoopback: true,
			}),
	).toThrow("company is invalid");
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("serves a runtime route only after the run's own lease proves its binding (G2-6a)", async () => {
	const f = fixture();
	const port = await f.service.start();
	await captureCloudSecret(
		"https://secrets.qorpera.test",
		{ ticketId: f.ticketId, captureCapability: f.capability, fields: { token: "lin_api_PROOF" } },
		new AbortController().signal,
		(input, init) => fetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}`, init),
	);
	const send = (holder: string | undefined) =>
		fetch(`http://127.0.0.1:${port}/v1/operations?company=${randomUUID()}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${f.runtimeToken}`,
				"content-type": "application/json",
				...(holder === undefined ? {} : { "x-qorpera-identity": holder }),
			},
			body: JSON.stringify({ schema: "qorpera.cloud-secret-operation-request/v1", ...f.operation }),
		});
	// No holder, a malformed one, or another run's lease: refused before the broker authorizes anything, and the reply
	// carries nothing of the holder.
	const lease = f.holder.split(".")[2] as string;
	for (const holder of [undefined, "", lease, `identity.${lease}`, `${f.holder}x`, `job.${randomUUID()}.${lease}`]) {
		const refused = await send(holder);
		expect(refused.status).toBe(403);
		expect(await refused.text()).not.toContain(lease);
	}
	expect(f.authority.authorizeOperation).not.toHaveBeenCalled();
	// Only a well-formed holder reaches the proof, which gets the request's binding.
	expect(f.proveBinding).toHaveBeenCalledTimes(1);
	expect(f.proveBinding.mock.calls[0]?.[0]).toMatchObject({
		jobId: f.operation.binding.jobId,
		runId: f.operation.binding.runId,
	});
	// The run's own lease is served.
	expect((await send(f.holder)).status).toBe(200);
	expect(f.authority.authorizeOperation).toHaveBeenCalledTimes(1);
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("refuses an operation the database does not authorize for this broker, whatever company the query names", async () => {
	// A request the router sends to another company's broker reaches a broker
	// whose authority does not own the run's grant: the database refuses it
	// ("cloud secret broker does not own this envelope"), so no adapter runs.
	const f = fixture(true);
	vi.mocked(f.authority.authorizeOperation).mockRejectedValue(
		new Error("cloud secret broker does not own this envelope"),
	);
	const port = await f.service.start();
	const client = new HttpCloudSecretBrokerClient({
		origin: `http://127.0.0.1:${port}`,
		runtimeToken: f.runtimeToken,
		companyId: randomUUID(),
		holder: () => f.holder,
		allowLoopback: true,
	});
	await expect(client.execute(f.operation, new AbortController().signal)).rejects.toThrow(
		"Cloud secret broker rejected the operation",
	);
	expect(f.authority.authorizeOperation).toHaveBeenCalledTimes(1);
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("releases a coding repository token only to the executor's token, uncached, and nothing on a kernel refusal", async () => {
	const f = fixture();
	const port = await f.service.start();
	const post = (authorization: string) =>
		fetch(`http://127.0.0.1:${port}/v1/repository-credentials?company=${randomUUID()}`, {
			method: "POST",
			headers: { authorization, "content-type": "application/json" },
			body: JSON.stringify({
				schema: "qorpera.coding-repository-credential-request/v1",
				workerId: randomUUID(),
				leaseToken: randomUUID(),
				executorOwner: "coding-node-02",
				repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
			}),
		});
	// The runtime token every guest holds never opens the route.
	const guest = await post(`Bearer ${f.runtimeToken}`);
	expect(guest.status).toBe(404);
	expect(f.authority.authorizeRepositoryCredential).not.toHaveBeenCalled();
	const released = await post(`Bearer ${f.codingExecutorToken}`);
	expect(released.status).toBe(200);
	expect(released.headers.get("cache-control")).toBe("no-store");
	expect(released.headers.get("access-control-allow-origin")).toBeNull();
	expect(await released.json()).toEqual({
		schema: "qorpera.coding-repository-credential/v1",
		token: "gho_REPOSITORY_TOKEN_0123456789",
	});
	const unauthorized = await post(`Bearer ${randomBytes(32).toString("base64url")}`);
	expect(unauthorized.status).toBe(404);
	expect(await unauthorized.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "not_found" });
	expect(f.authority.authorizeRepositoryCredential).toHaveBeenCalledTimes(1);
	vi.mocked(f.authority.authorizeRepositoryCredential).mockRejectedValueOnce(
		new Error("company GitHub connection is unavailable to this agent"),
	);
	const refused = await post(`Bearer ${f.codingExecutorToken}`);
	expect(refused.status).toBe(403);
	const text = await refused.text();
	expect(JSON.parse(text)).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
	expect(text).not.toContain("gho_");
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("answers the coding environment only to the executor's token, uncached, and nothing on a refusal", async () => {
	const f = fixture();
	const port = await f.service.start();
	const body = {
		schema: "qorpera.coding-environment-request/v1",
		workerId: randomUUID(),
		leaseToken: randomUUID(),
		executorOwner: "coding-node-02",
	};
	const post = (servicePort: number, authorization: string, sent: Record<string, unknown> = body) =>
		fetch(`http://127.0.0.1:${servicePort}/v1/coding-environment?company=${randomUUID()}`, {
			method: "POST",
			headers: { authorization, "content-type": "application/json" },
			body: JSON.stringify(sent),
		});
	const notFound = { schema: "qorpera.cloud-secret-error/v1", error: "not_found" };
	const unavailable = { schema: "qorpera.cloud-secret-error/v1", error: "unavailable" };
	// The runtime token every guest holds never opens the route.
	const guest = await post(port, `Bearer ${f.runtimeToken}`);
	expect(guest.status).toBe(404);
	expect(await guest.json()).toEqual(notFound);
	const unauthorized = await post(port, `Bearer ${randomBytes(32).toString("base64url")}`);
	expect(unauthorized.status).toBe(404);
	expect(await unauthorized.json()).toEqual(notFound);
	expect(f.authorizeCodingEnvironment).not.toHaveBeenCalled();
	const released = await post(port, `Bearer ${f.codingExecutorToken}`);
	expect(released.status).toBe(200);
	expect(released.headers.get("cache-control")).toBe("no-store");
	expect(released.headers.get("access-control-allow-origin")).toBeNull();
	expect(await released.json()).toEqual({
		schema: "qorpera.coding-environment/v1",
		environment: { API_KEY: ENVIRONMENT_VALUE },
	});
	expect(f.authorizeCodingEnvironment).toHaveBeenCalledTimes(1);
	expect(f.authorizeCodingEnvironment).toHaveBeenCalledWith(
		{ workerId: body.workerId, leaseToken: body.leaseToken, executorOwner: body.executorOwner },
		expect.any(AbortSignal),
	);
	// A request that is not exactly the v1 shape is refused before the kernel is asked.
	for (const sent of [
		{ ...body, schema: "qorpera.coding-environment-request/v2" },
		{ ...body, repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" } },
	]) {
		const malformed = await post(port, `Bearer ${f.codingExecutorToken}`, sent);
		expect(malformed.status).toBe(403);
		expect(malformed.headers.get("cache-control")).toBe("no-store");
		expect(await malformed.json()).toEqual(unavailable);
	}
	expect(f.authorizeCodingEnvironment).toHaveBeenCalledTimes(1);
	f.authorizeCodingEnvironment.mockRejectedValueOnce(new Error("coding session lease is unavailable"));
	const refused = await post(port, `Bearer ${f.codingExecutorToken}`);
	expect(refused.status).toBe(403);
	expect(refused.headers.get("cache-control")).toBe("no-store");
	const text = await refused.text();
	expect(JSON.parse(text)).toEqual(unavailable);
	expect(text).not.toContain(ENVIRONMENT_VALUE);
	// A broker started without the executor's token has no environment route at all.
	const bare = new HttpCloudSecretBrokerService(f.broker, f.runtimeToken);
	services.push(bare);
	const barePort = await bare.start();
	for (const token of [f.codingExecutorToken, f.runtimeToken]) {
		const closed = await post(barePort, `Bearer ${token}`);
		expect(closed.status).toBe(404);
		expect(await closed.json()).toEqual(notFound);
	}
	expect(f.authorizeCodingEnvironment).toHaveBeenCalledTimes(2);
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("rejects a broker descriptor carrying undeclared fields", async () => {
	await expect(
		captureCloudSecret(
			"https://secrets.qorpera.test",
			{ ticketId: randomUUID(), captureCapability: randomBytes(32).toString("base64url"), fields: { token: "x" } },
			new AbortController().signal,
			async () =>
				Response.json({
					schema: "qorpera.cloud-secret-descriptor/v1",
					secretId: randomUUID(),
					version: 1,
					connectorId: "linear",
					secretName: "primary",
					purpose: "Company Linear connection",
					ownerKind: "company",
					ownerUserId: null,
					status: "active",
					encryptedEnvelope: "must-not-cross",
				}),
		),
	).rejects.toThrow("returned invalid data");
});

it("answers a browser's capture from a listed member origin, and only that origin, with CORS", async () => {
	const f = fixture();
	const service = new HttpCloudSecretBrokerService(f.broker, f.runtimeToken, "127.0.0.1", 0, [
		"https://app.qorpera.test",
	]);
	services.push(service);
	const port = await service.start();
	const preflight = await fetch(`http://127.0.0.1:${port}/v1/captures/${f.ticketId}`, {
		method: "OPTIONS",
		headers: { origin: "https://app.qorpera.test", "access-control-request-method": "POST" },
	});
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.qorpera.test");
	expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");
	const stranger = await fetch(`http://127.0.0.1:${port}/v1/captures/${f.ticketId}`, {
		method: "OPTIONS",
		headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
	});
	expect(stranger.status).toBe(404);
	expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
	const refused = await fetch(`http://127.0.0.1:${port}/v1/captures/${f.ticketId}`, {
		method: "POST",
		headers: { origin: "https://evil.example", "content-type": "application/json" },
		body: JSON.stringify({
			schema: "qorpera.cloud-secret-capture-request/v1",
			captureCapability: f.capability,
			fields: { token: "lin_api_NEVER_VISIBLE" },
		}),
	});
	expect(refused.status).toBe(403);
	expect(vi.mocked(f.authority.completeCapture)).not.toHaveBeenCalled();
	const accepted = await fetch(`http://127.0.0.1:${port}/v1/captures/${f.ticketId}`, {
		method: "POST",
		headers: { origin: "https://app.qorpera.test", "content-type": "application/json" },
		body: JSON.stringify({
			schema: "qorpera.cloud-secret-capture-request/v1",
			captureCapability: f.capability,
			fields: { token: "lin_api_NEVER_VISIBLE" },
		}),
	});
	expect(accepted.status).toBe(200);
	expect(accepted.headers.get("access-control-allow-origin")).toBe("https://app.qorpera.test");
	expect(accepted.headers.get("vary")).toBe("origin");
	// The runtime route never answers a browser.
	const operations = await fetch(`http://127.0.0.1:${port}/v1/operations`, {
		method: "OPTIONS",
		headers: { origin: "https://app.qorpera.test", "access-control-request-method": "POST" },
	});
	expect(operations.status).toBe(404);
	expect(
		() => new HttpCloudSecretBrokerService(f.broker, f.runtimeToken, "127.0.0.1", 0, ["http://app.qorpera.test"]),
	).toThrow("member origin is invalid");
	f.wrappingKey.fill(0);
	f.keyring.close();
});
