import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CloudSecretConnectorAdapter,
	type CloudSecretOperationRequest,
	PostgresCloudSecretBrokerAuthority,
	SupabaseCloudSecretBrokerAuthority,
} from "@qorpera/runtime/cloud-secret-broker";
import { CloudSecretKeyring, sealCloudSecretFields, withCloudSecretFields } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const keyrings: CloudSecretKeyring[] = [];
afterEach(() => {
	for (const keyring of keyrings.splice(0)) keyring.close();
});

function envelopeIdentity() {
	return {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		keyId: "company-kek-1",
	};
}

it("envelope-encrypts a company secret and binds it to company, environment, id, version and key", async () => {
	const canary = "lin_api_CANARY_NEVER_EXPOSE";
	const wrappingKey = randomBytes(32);
	const identity = envelopeIdentity();
	const envelope = sealCloudSecretFields({ token: canary }, wrappingKey, identity);
	try {
		expect(Buffer.from(envelope).toString("utf8")).not.toContain(canary);
		await expect(
			withCloudSecretFields(envelope, wrappingKey, identity, async (fields) => fields.token),
		).resolves.toBe(canary);
		await expect(
			withCloudSecretFields(envelope, wrappingKey, { ...identity, companyId: randomUUID() }, async () => undefined),
		).rejects.toThrow();
		await expect(
			withCloudSecretFields(envelope, wrappingKey, { ...identity, version: 2 }, async () => undefined),
		).rejects.toThrow();
		const tampered = Uint8Array.from(envelope);
		tampered[tampered.byteLength - 10] ^= 1;
		await expect(withCloudSecretFields(tampered, wrappingKey, identity, async () => undefined)).rejects.toThrow();
	} finally {
		envelope.fill(0);
		wrappingKey.fill(0);
	}
});

async function brokerFixture(canary = "lin_api_CANARY_NEVER_EXPOSE") {
	const fixture = nativeToolAuthorityFixture();
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ "company-kek-1": wrappingKey });
	keyrings.push(keyring);
	const ticketId = randomUUID();
	const secretId = randomUUID();
	const grantId = randomUUID();
	let encryptedEnvelope = new Uint8Array();
	let envelopeSha256 = "";
	let revoked = false;
	const authorizeOperation = vi.fn<CloudSecretBrokerAuthority["authorizeOperation"]>(async (request) => {
		if (revoked) throw new Error(`private revoked ${canary}`);
		return {
			schema: "qorpera.cloud-secret-operation-authorization/v1",
			companyId: fixture.authority.identity.companyId,
			environmentId: fixture.authority.identity.environmentId,
			secretId,
			secretVersion: 1,
			keyId: "company-kek-1",
			grantId,
			connectorId: "linear",
			operationId: "issue_create",
			operationVersion: 1,
			adapterSha256: "a".repeat(64),
			destinationOrigin: "https://api.linear.app",
			credentialName: "token",
			encryptedEnvelopeBase64: Buffer.from(encryptedEnvelope).toString("base64"),
			envelopeSha256,
			receiptId: request.receiptId,
			inputSha256: request.inputSha256,
		};
	});
	const authority: CloudSecretBrokerAuthority = {
		describeCapture: vi.fn(async (describedTicket) => {
			if (describedTicket !== ticketId || revoked) throw new Error("private authority detail");
			return {
				schema: "qorpera.cloud-secret-capture-description/v1",
				ticketId,
				companyId: fixture.authority.identity.companyId,
				environmentId: fixture.authority.identity.environmentId,
				secretId,
				version: 1,
				ownerKind: "company",
				ownerUserId: null,
				connectorId: "linear",
				secretName: "primary",
				purpose: "Create and update Linear issues",
				keyId: "company-kek-1",
				expiresAt: "2099-08-29T12:00:00.000Z",
			};
		}),
		completeCapture: vi.fn(async (_ticket, _capability, envelope, digest) => {
			encryptedEnvelope = Uint8Array.from(envelope);
			envelopeSha256 = digest;
			return {
				schema: "qorpera.cloud-secret-descriptor/v1",
				secretId,
				version: 1,
				connectorId: "linear",
				secretName: "primary",
				purpose: "Create and update Linear issues",
				ownerKind: "company",
				ownerUserId: null,
				status: "active",
			};
		}),
		authorizeOperation,
	};
	const executeAdapter = vi.fn<CloudSecretConnectorAdapter["execute"]>(async (input) => {
		expect(input.credentials.token).toBe(canary);
		expect(input.destinationOrigin).toBe("https://api.linear.app");
		return { created: true, issueId: "ISS-41", title: (input.arguments as { title: string }).title };
	});
	const adapter: CloudSecretConnectorAdapter = {
		connectorId: "linear",
		operationId: "issue_create",
		operationVersion: 1,
		adapterSha256: "a".repeat(64),
		destinationOrigin: "https://api.linear.app",
		execute: executeAdapter,
	};
	const broker = new CloudSecretBroker({ authority, keyring, adapters: [adapter] });
	const request: CloudSecretOperationRequest = {
		binding: fixture.binding,
		receiptId: randomUUID(),
		inputSha256: "b".repeat(64),
		grantId,
		connectorId: "linear",
		operationId: "issue_create",
		operationVersion: 1,
		adapterSha256: "a".repeat(64),
		destinationOrigin: "https://api.linear.app",
		idempotencyKey: "issue-login-broken",
		arguments: { title: "Login is broken" },
	};
	const capture = () =>
		broker.capture(
			{
				ticketId,
				captureCapability: randomBytes(32).toString("base64url"),
				fields: { token: canary },
			},
			new AbortController().signal,
		);
	return {
		...fixture,
		wrappingKey,
		keyring,
		ticketId,
		secretId,
		grantId,
		canary,
		brokerAuthority: authority,
		authorizeOperation,
		adapter,
		executeAdapter,
		broker,
		request,
		capture,
		revoke: () => {
			revoked = true;
		},
		envelope: () => Uint8Array.from(encryptedEnvelope),
		envelopeSha256: () => envelopeSha256,
	};
}

it("captures out of band and gives an adapter operation access without exposing the value", async () => {
	const fixture = await brokerFixture();
	const descriptor = await fixture.capture();
	expect(descriptor).toMatchObject({ secretId: fixture.secretId, ownerKind: "company", status: "active" });
	expect(Buffer.from(fixture.envelope()).toString("utf8")).not.toContain(fixture.canary);
	expect(Object.keys(JSON.parse(Buffer.from(fixture.envelope()).toString("utf8"))).sort()).toEqual([
		"aadSha256",
		"companyId",
		"environmentId",
		"keyId",
		"payloadCiphertext",
		"payloadIv",
		"payloadTag",
		"schema",
		"secretId",
		"version",
		"wrapIv",
		"wrapTag",
		"wrappedKey",
	]);
	expect(JSON.stringify(descriptor)).not.toContain(fixture.canary);
	await expect(
		withCloudSecretFields(
			fixture.envelope(),
			fixture.wrappingKey,
			{
				companyId: fixture.authority.identity.companyId,
				environmentId: fixture.authority.identity.environmentId,
				secretId: fixture.secretId,
				version: 1,
				keyId: "company-kek-1",
			},
			async (fields) => fields.token,
		),
	).resolves.toBe(fixture.canary);
	await expect(fixture.broker.execute(fixture.request, new AbortController().signal)).resolves.toEqual({
		kind: "json",
		value: { created: true, issueId: "ISS-41", title: "Login is broken" },
	});
	expect(fixture.executeAdapter).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(fixture.authorizeOperation.mock.results)).not.toContain(fixture.canary);
	fixture.wrappingKey.fill(0);
});

it("withholds reflected credential material while preserving a completed semantic outcome", async () => {
	const fixture = await brokerFixture();
	await fixture.capture();
	fixture.executeAdapter.mockResolvedValueOnce({ ok: true, echo: `Bearer ${fixture.canary}` });
	const output = await fixture.broker.execute(fixture.request, new AbortController().signal);
	expect(output).toEqual({
		kind: "json",
		value: {
			schema: "qorpera.connector-result/v1",
			status: "completed",
			result: "withheld_sensitive_response",
		},
	});
	expect(JSON.stringify(output)).not.toContain(fixture.canary);
	fixture.executeAdapter.mockResolvedValueOnce({ ok: true, authorization: "masked" });
	await expect(
		fixture.broker.execute({ ...fixture.request, receiptId: randomUUID() }, new AbortController().signal),
	).resolves.toMatchObject({ value: { result: "withheld_sensitive_response" } });
	fixture.wrappingKey.fill(0);
});

it("withholds even a short reflected credential instead of trading secrecy for fewer false positives", async () => {
	const fixture = await brokerFixture("abc");
	await fixture.capture();
	fixture.executeAdapter.mockResolvedValueOnce({ ok: true, echo: "abc" });
	await expect(fixture.broker.execute(fixture.request, new AbortController().signal)).resolves.toMatchObject({
		value: { result: "withheld_sensitive_response" },
	});
	fixture.wrappingKey.fill(0);
});

it("fails closed on revocation and never releases private authority or adapter errors", async () => {
	const fixture = await brokerFixture();
	await fixture.capture();
	fixture.revoke();
	let error = "";
	try {
		await fixture.broker.execute(fixture.request, new AbortController().signal);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	expect(error).not.toContain(fixture.canary);
	expect(fixture.executeAdapter).not.toHaveBeenCalled();
	fixture.wrappingKey.fill(0);
});

it("binds the downstream idempotency key to the database receipt authorization", async () => {
	const fixture = await brokerFixture();
	let rpcBody: Record<string, unknown> | undefined;
	const authority = new SupabaseCloudSecretBrokerAuthority({
		supabaseUrl: "https://database.qorpera.test",
		serviceRoleKey: "synthetic-service-role",
		brokerAuthorityId: randomUUID(),
		brokerCapability: randomBytes(32).toString("base64url"),
		fetch: async (_input, init) => {
			rpcBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({ accepted: true });
		},
	});
	await authority.authorizeOperation(fixture.request, new AbortController().signal);
	expect(rpcBody?.p_downstream_idempotency_sha256).toBe(
		createHash("sha256").update(fixture.request.idempotencyKey).digest("hex"),
	);
	fixture.wrappingKey.fill(0);
});

it("uses only the three static broker-role SQL calls and binds downstream idempotency", async () => {
	const fixture = await brokerFixture();
	const queries: Array<{ text: string; values: readonly unknown[] }> = [];
	const authorityId = randomUUID();
	const authority = new PostgresCloudSecretBrokerAuthority({
		database: {
			async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
				queries.push({ text, values });
				return { rowCount: 1, rows: [{ result: { accepted: true } } as unknown as Row] };
			},
		},
		brokerAuthorityId: authorityId,
		brokerCapability: randomBytes(32).toString("base64url"),
	});
	await authority.describeCapture(randomUUID(), "c".repeat(64), new AbortController().signal);
	await authority.completeCapture(
		randomUUID(),
		"d".repeat(64),
		Buffer.from("encrypted"),
		"e".repeat(64),
		null,
		new AbortController().signal,
	);
	await authority.authorizeOperation(fixture.request, new AbortController().signal);
	expect(queries.map((query) => query.text)).toEqual([
		"select public.qorpera_describe_cloud_secret_capture($1::uuid,$2::text,$3::uuid,$4::text) as result",
		"select public.qorpera_complete_cloud_secret_capture($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text) as result",
		"select public.qorpera_authorize_cloud_secret_operation($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text,$7::uuid,$8::text,$9::text,$10::bigint,$11::text,$12::text) as result",
	]);
	expect(queries[2]?.values[5]).toBe(createHash("sha256").update(fixture.request.idempotencyKey).digest("hex"));
	expect(JSON.stringify(queries)).not.toContain(fixture.request.idempotencyKey);
	fixture.wrappingKey.fill(0);
});

it("reopens persisted ciphertext after a broker restart without a plaintext fallback", async () => {
	const fixture = await brokerFixture();
	await fixture.capture();
	const recoveredKeyring = new CloudSecretKeyring({ "company-kek-1": fixture.wrappingKey });
	keyrings.push(recoveredKeyring);
	const recoveredAuthority: CloudSecretBrokerAuthority = {
		describeCapture: fixture.brokerAuthority.describeCapture,
		completeCapture: fixture.brokerAuthority.completeCapture,
		authorizeOperation: fixture.brokerAuthority.authorizeOperation,
	};
	const recovered = new CloudSecretBroker({
		authority: recoveredAuthority,
		keyring: recoveredKeyring,
		adapters: [fixture.adapter],
	});
	const result = await recovered.execute(fixture.request, new AbortController().signal);
	expect(result).toMatchObject({ kind: "json", value: { created: true } });
	expect(createHash("sha256").update(fixture.envelope()).digest("hex")).toBe(fixture.envelopeSha256());
	fixture.wrappingKey.fill(0);
});
