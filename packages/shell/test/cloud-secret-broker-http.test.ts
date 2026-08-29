import { randomBytes, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CloudSecretCaptureDescription,
	type CloudSecretConnectorAdapter,
	type CloudSecretOperationRequest,
} from "../src/cloud-secret-broker.ts";
import {
	captureCloudSecret,
	HttpCloudSecretBrokerClient,
	HttpCloudSecretBrokerService,
} from "../src/cloud-secret-broker-http.ts";
import { CloudSecretKeyring } from "../src/cloud-secret-crypto.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
});

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
	const service = new HttpCloudSecretBrokerService(broker, runtimeToken);
	services.push(service);
	const binding = nativeToolAuthorityFixture().binding;
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
	return { authority, capability, ticketId, wrappingKey, keyring, runtimeToken, broker, service, operation };
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
	const client = new HttpCloudSecretBrokerClient({
		origin: `http://127.0.0.1:${port}`,
		runtimeToken: f.runtimeToken,
		allowLoopback: true,
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
