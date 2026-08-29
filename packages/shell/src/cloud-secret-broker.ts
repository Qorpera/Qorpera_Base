import { createHash } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import type { CloudToolContent } from "./cloud-native-tool-boundary.ts";
import { cloudToolJsonText } from "./cloud-native-tool-boundary.ts";
import { readBoundedCloudResponse, supabaseServiceHeaders, withCloudDeadline } from "./cloud-request.ts";
import type { CloudSecretEnvelopeIdentity, CloudSecretKeyring } from "./cloud-secret-crypto.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_RPC_BYTES = 256 * 1024;

export interface CloudSecretCaptureRequest {
	readonly ticketId: string;
	readonly captureCapability: string;
	readonly fields: Readonly<Record<string, string>>;
}

export interface CloudSecretDescriptor {
	readonly schema: "qorpera.cloud-secret-descriptor/v1";
	readonly secretId: string;
	readonly version: number;
	readonly connectorId: string;
	readonly secretName: string;
	readonly purpose: string;
	readonly ownerKind: "company" | "member";
	readonly ownerUserId: string | null;
	readonly status: "active";
}

export interface CloudSecretOperationRequest {
	readonly binding: CloudNativeToolBinding;
	readonly receiptId: string;
	readonly inputSha256: string;
	readonly grantId: string;
	readonly connectorId: string;
	readonly operationId: string;
	readonly operationVersion: number;
	readonly adapterSha256: string;
	readonly destinationOrigin: string;
	readonly idempotencyKey: string;
	readonly arguments: JsonValue;
}

export interface CloudSecretCaptureDescription extends CloudSecretEnvelopeIdentity {
	readonly schema: "qorpera.cloud-secret-capture-description/v1";
	readonly ticketId: string;
	readonly ownerKind: "company" | "member";
	readonly ownerUserId: string | null;
	readonly connectorId: string;
	readonly secretName: string;
	readonly purpose: string;
	readonly expiresAt: string;
}

export interface CloudSecretOperationAuthorization extends CloudSecretEnvelopeIdentity {
	readonly schema: "qorpera.cloud-secret-operation-authorization/v1";
	readonly grantId: string;
	readonly connectorId: string;
	readonly operationId: string;
	readonly operationVersion: number;
	readonly adapterSha256: string;
	readonly destinationOrigin: string;
	readonly credentialName: string;
	readonly encryptedEnvelopeBase64: string;
	readonly envelopeSha256: string;
	readonly receiptId: string;
	readonly inputSha256: string;
}

export interface CloudSecretBrokerAuthority {
	describeCapture(ticketId: string, captureCapabilitySha256: string, signal: AbortSignal): Promise<unknown>;
	completeCapture(
		ticketId: string,
		captureCapabilitySha256: string,
		encryptedEnvelope: Uint8Array,
		envelopeSha256: string,
		signal: AbortSignal,
	): Promise<unknown>;
	authorizeOperation(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<unknown>;
}

export interface CloudSecretPostgresClient {
	query<Row extends Record<string, unknown>>(
		text: string,
		values: readonly unknown[],
	): Promise<{ readonly rowCount: number | null; readonly rows: readonly Row[] }>;
}

export interface CloudSecretConnectorAdapter {
	readonly connectorId: string;
	readonly operationId: string;
	readonly operationVersion: number;
	readonly adapterSha256: string;
	readonly destinationOrigin: string;
	execute(input: {
		readonly arguments: JsonValue;
		readonly credentials: Readonly<Record<string, string>>;
		readonly credentialName: string;
		readonly destinationOrigin: string;
		readonly idempotencyKey: string;
		readonly signal: AbortSignal;
	}): Promise<JsonValue>;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error(`${label} is invalid`);
	}
	return value as Record<string, unknown>;
}

function exact(input: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(input).sort().join() !== [...keys].sort().join()) throw new Error(`${label} is invalid`);
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function integer(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} is invalid`);
	return value as number;
}

function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function parseCaptureDescription(value: unknown): CloudSecretCaptureDescription {
	const input = record(value, "Cloud secret capture description");
	exact(
		input,
		[
			"schema",
			"ticketId",
			"companyId",
			"environmentId",
			"secretId",
			"version",
			"ownerKind",
			"ownerUserId",
			"connectorId",
			"secretName",
			"purpose",
			"keyId",
			"expiresAt",
		],
		"Cloud secret capture description",
	);
	if (
		input.schema !== "qorpera.cloud-secret-capture-description/v1" ||
		(input.ownerKind !== "company" && input.ownerKind !== "member") ||
		(input.ownerKind === "company" ? input.ownerUserId !== null : !UUID.test(String(input.ownerUserId))) ||
		typeof input.secretName !== "string" ||
		!IDENTIFIER.test(input.secretName) ||
		typeof input.purpose !== "string" ||
		!input.purpose ||
		input.purpose.length > 512 ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		typeof input.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(input.expiresAt))
	)
		throw new Error("Cloud secret capture description is invalid");
	return {
		schema: "qorpera.cloud-secret-capture-description/v1",
		ticketId: uuid(input.ticketId, "Cloud secret capture ticket"),
		companyId: uuid(input.companyId, "Cloud secret company"),
		environmentId: uuid(input.environmentId, "Cloud secret environment"),
		secretId: uuid(input.secretId, "Cloud secret id"),
		version: integer(input.version, "Cloud secret version"),
		ownerKind: input.ownerKind,
		ownerUserId: input.ownerUserId as string | null,
		connectorId: identifier(input.connectorId, "Cloud secret connector"),
		secretName: input.secretName,
		purpose: input.purpose,
		keyId: input.keyId,
		expiresAt: new Date(input.expiresAt).toISOString(),
	};
}

function parseDescriptor(value: unknown, description: CloudSecretCaptureDescription): CloudSecretDescriptor {
	const input = record(value, "Cloud secret descriptor");
	exact(
		input,
		["schema", "secretId", "version", "connectorId", "secretName", "purpose", "ownerKind", "ownerUserId", "status"],
		"Cloud secret descriptor",
	);
	if (
		input.schema !== "qorpera.cloud-secret-descriptor/v1" ||
		input.secretId !== description.secretId ||
		input.version !== description.version ||
		input.connectorId !== description.connectorId ||
		input.secretName !== description.secretName ||
		input.purpose !== description.purpose ||
		input.ownerKind !== description.ownerKind ||
		input.ownerUserId !== description.ownerUserId ||
		input.status !== "active"
	)
		throw new Error("Cloud secret descriptor differs from its capture");
	return structuredClone(input) as unknown as CloudSecretDescriptor;
}

function parseAuthorization(value: unknown, request: CloudSecretOperationRequest): CloudSecretOperationAuthorization {
	const input = record(value, "Cloud secret operation authorization");
	exact(
		input,
		[
			"schema",
			"companyId",
			"environmentId",
			"secretId",
			"secretVersion",
			"keyId",
			"grantId",
			"connectorId",
			"operationId",
			"operationVersion",
			"adapterSha256",
			"destinationOrigin",
			"credentialName",
			"encryptedEnvelopeBase64",
			"envelopeSha256",
			"receiptId",
			"inputSha256",
		],
		"Cloud secret operation authorization",
	);
	if (input.schema !== "qorpera.cloud-secret-operation-authorization/v1")
		throw new Error("Cloud secret operation authorization is invalid");
	if (
		input.grantId !== request.grantId ||
		input.connectorId !== request.connectorId ||
		input.operationId !== request.operationId ||
		input.operationVersion !== request.operationVersion ||
		input.adapterSha256 !== request.adapterSha256 ||
		input.destinationOrigin !== request.destinationOrigin ||
		input.receiptId !== request.receiptId ||
		input.inputSha256 !== request.inputSha256 ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		typeof input.credentialName !== "string" ||
		!IDENTIFIER.test(input.credentialName) ||
		typeof input.encryptedEnvelopeBase64 !== "string" ||
		!/^[A-Za-z0-9+/=\r\n]+$/.test(input.encryptedEnvelopeBase64) ||
		typeof input.envelopeSha256 !== "string" ||
		!SHA.test(input.envelopeSha256)
	)
		throw new Error("Cloud secret operation authorization differs from its request");
	return {
		schema: "qorpera.cloud-secret-operation-authorization/v1",
		companyId: uuid(input.companyId, "Cloud secret company"),
		environmentId: uuid(input.environmentId, "Cloud secret environment"),
		secretId: uuid(input.secretId, "Cloud secret id"),
		version: integer(input.secretVersion, "Cloud secret version"),
		keyId: input.keyId,
		grantId: request.grantId,
		connectorId: request.connectorId,
		operationId: request.operationId,
		operationVersion: request.operationVersion,
		adapterSha256: request.adapterSha256,
		destinationOrigin: request.destinationOrigin,
		credentialName: input.credentialName,
		encryptedEnvelopeBase64: input.encryptedEnvelopeBase64,
		envelopeSha256: input.envelopeSha256,
		receiptId: request.receiptId,
		inputSha256: request.inputSha256,
	};
}

function adapterKey(value: {
	connectorId: string;
	operationId: string;
	operationVersion: number;
	adapterSha256: string;
	destinationOrigin: string;
}): string {
	return [
		value.connectorId,
		value.operationId,
		String(value.operationVersion),
		value.adapterSha256,
		value.destinationOrigin,
	].join("\0");
}

function sensitiveFingerprints(fields: Readonly<Record<string, string>>): readonly string[] {
	const fingerprints = new Set<string>();
	for (const value of Object.values(fields)) {
		for (const candidate of [
			value,
			encodeURIComponent(value),
			Buffer.from(value, "utf8").toString("base64"),
			Buffer.from(value, "utf8").toString("base64url"),
		]) {
			if (candidate.length > 0) fingerprints.add(candidate);
		}
	}
	return [...fingerprints];
}

function containsSensitiveOutput(
	value: JsonValue,
	fingerprints: readonly string[],
	ancestors = new Set<object>(),
): boolean {
	if (typeof value === "string") return fingerprints.some((candidate) => value.includes(candidate));
	if (value === null || typeof value === "boolean" || typeof value === "number") return false;
	if (typeof value !== "object" || ancestors.has(value)) return true;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.some((item) => containsSensitiveOutput(item, fingerprints, ancestors));
		for (const [key, child] of Object.entries(value)) {
			if (
				/(?:authorization|proxy_authorization|cookie|set_cookie|password|passwd|secret|token|api_?key|credential|session)/i.test(
					key,
				)
			) {
				return true;
			}
			if (containsSensitiveOutput(child, fingerprints, ancestors)) return true;
		}
		return false;
	} finally {
		ancestors.delete(value);
	}
}

const WITHHELD_RESULT: CloudToolContent = Object.freeze({
	kind: "json",
	value: Object.freeze({
		schema: "qorpera.connector-result/v1",
		status: "completed",
		result: "withheld_sensitive_response",
	}),
});

/**
 * The only component that unwraps connector credentials. It never exposes a
 * get/reveal/export method: capture commits ciphertext, and execution returns
 * only a reduced, secret-fenced connector result.
 */
export class CloudSecretBroker {
	readonly #authority: CloudSecretBrokerAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #adapters = new Map<string, CloudSecretConnectorAdapter>();

	constructor(options: {
		authority: CloudSecretBrokerAuthority;
		keyring: CloudSecretKeyring;
		adapters: readonly CloudSecretConnectorAdapter[];
	}) {
		this.#authority = options.authority;
		this.#keys = options.keyring;
		for (const adapter of options.adapters) {
			if (
				!IDENTIFIER.test(adapter.connectorId) ||
				!IDENTIFIER.test(adapter.operationId) ||
				!Number.isSafeInteger(adapter.operationVersion) ||
				adapter.operationVersion < 1 ||
				!SHA.test(adapter.adapterSha256) ||
				new URL(adapter.destinationOrigin).origin !== adapter.destinationOrigin ||
				!adapter.destinationOrigin.startsWith("https://")
			)
				throw new Error("Cloud secret connector adapter is invalid");
			const key = adapterKey(adapter);
			if (this.#adapters.has(key)) throw new Error("Cloud secret connector adapter is duplicated");
			this.#adapters.set(key, adapter);
		}
	}

	async capture(request: CloudSecretCaptureRequest, signal: AbortSignal): Promise<CloudSecretDescriptor> {
		try {
			return await this.#capture(request, signal);
		} catch {
			throw new Error("Cloud secret capture was not confirmed");
		}
	}

	async #capture(request: CloudSecretCaptureRequest, signal: AbortSignal): Promise<CloudSecretDescriptor> {
		if (!UUID.test(request.ticketId) || !CAPABILITY.test(request.captureCapability)) {
			throw new Error("Cloud secret capture request is invalid");
		}
		const capabilitySha256 = createHash("sha256").update(request.captureCapability).digest("hex");
		const description = parseCaptureDescription(
			await this.#authority.describeCapture(request.ticketId, capabilitySha256, signal),
		);
		if (description.ticketId !== request.ticketId || Date.parse(description.expiresAt) <= Date.now()) {
			throw new Error("Cloud secret capture is unavailable");
		}
		const envelope = this.#keys.seal(request.fields, description);
		try {
			const envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
			return parseDescriptor(
				await this.#authority.completeCapture(request.ticketId, capabilitySha256, envelope, envelopeSha256, signal),
				description,
			);
		} finally {
			envelope.fill(0);
		}
	}

	async execute(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<CloudToolContent> {
		try {
			return await this.#execute(request, signal);
		} catch {
			throw new Error("Cloud secret operation outcome unconfirmed");
		}
	}

	async #execute(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<CloudToolContent> {
		if (
			!UUID.test(request.receiptId) ||
			!UUID.test(request.grantId) ||
			!SHA.test(request.inputSha256) ||
			!IDENTIFIER.test(request.connectorId) ||
			!IDENTIFIER.test(request.operationId) ||
			!Number.isSafeInteger(request.operationVersion) ||
			request.operationVersion < 1 ||
			!SHA.test(request.adapterSha256) ||
			!OPERATION_KEY.test(request.idempotencyKey) ||
			cloudToolJsonText(request.arguments).length > 64 * 1024
		)
			throw new Error("Cloud secret operation request is invalid");
		const authorization = parseAuthorization(await this.#authority.authorizeOperation(request, signal), request);
		const envelope = Buffer.from(authorization.encryptedEnvelopeBase64, "base64");
		if (createHash("sha256").update(envelope).digest("hex") !== authorization.envelopeSha256) {
			envelope.fill(0);
			throw new Error("Cloud secret envelope digest differs");
		}
		const adapter = this.#adapters.get(adapterKey(request));
		if (!adapter) {
			envelope.fill(0);
			throw new Error("Cloud secret connector adapter is unavailable");
		}
		try {
			return await this.#keys.use(envelope, authorization, async (fields) => {
				if (!Object.hasOwn(fields, authorization.credentialName)) {
					throw new Error("Cloud secret credential field is unavailable");
				}
				const result = await adapter.execute({
					arguments: structuredClone(request.arguments),
					credentials: fields,
					credentialName: authorization.credentialName,
					destinationOrigin: authorization.destinationOrigin,
					idempotencyKey: request.idempotencyKey,
					signal,
				});
				cloudToolJsonText(result, 32 * 1024);
				if (containsSensitiveOutput(result, sensitiveFingerprints(fields))) return structuredClone(WITHHELD_RESULT);
				return { kind: "json", value: structuredClone(result) };
			});
		} finally {
			envelope.fill(0);
		}
	}
}

function cloudOrigin(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new Error("Cloud secret authority URL is invalid");
	}
	return url.origin;
}

export class SupabaseCloudSecretBrokerAuthority implements CloudSecretBrokerAuthority {
	readonly #origin: string;
	readonly #serviceKey: string;
	readonly #brokerAuthorityId: string;
	readonly #brokerCapabilitySha256: string;
	readonly #fetch: typeof fetch;

	constructor(options: {
		supabaseUrl: string;
		serviceRoleKey: string;
		brokerAuthorityId: string;
		brokerCapability: string;
		fetch?: typeof fetch;
	}) {
		this.#origin = cloudOrigin(options.supabaseUrl);
		if (!options.serviceRoleKey || /[\0\r\n]/.test(options.serviceRoleKey)) {
			throw new Error("Cloud secret authority service key is invalid");
		}
		this.#serviceKey = options.serviceRoleKey;
		this.#brokerAuthorityId = uuid(options.brokerAuthorityId, "Cloud secret broker authority");
		if (!CAPABILITY.test(options.brokerCapability)) throw new Error("Cloud secret broker capability is invalid");
		this.#brokerCapabilitySha256 = createHash("sha256").update(options.brokerCapability).digest("hex");
		this.#fetch = options.fetch ?? fetch;
	}

	describeCapture(ticketId: string, captureCapabilitySha256: string, signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"qorpera_describe_cloud_secret_capture",
			{
				p_broker_authority_id: this.#brokerAuthorityId,
				p_broker_capability_sha256: this.#brokerCapabilitySha256,
				p_ticket_id: ticketId,
				p_capture_capability_sha256: captureCapabilitySha256,
			},
			signal,
		);
	}

	completeCapture(
		ticketId: string,
		captureCapabilitySha256: string,
		encryptedEnvelope: Uint8Array,
		envelopeSha256: string,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"qorpera_complete_cloud_secret_capture",
			{
				p_broker_authority_id: this.#brokerAuthorityId,
				p_broker_capability_sha256: this.#brokerCapabilitySha256,
				p_ticket_id: ticketId,
				p_capture_capability_sha256: captureCapabilitySha256,
				p_encrypted_envelope_base64: Buffer.from(encryptedEnvelope).toString("base64"),
				p_envelope_sha256: envelopeSha256,
			},
			signal,
		);
	}

	authorizeOperation(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"qorpera_authorize_cloud_secret_operation",
			{
				p_broker_authority_id: this.#brokerAuthorityId,
				p_broker_capability_sha256: this.#brokerCapabilitySha256,
				p_binding: request.binding,
				p_receipt_id: request.receiptId,
				p_input_sha256: request.inputSha256,
				p_downstream_idempotency_sha256: createHash("sha256").update(request.idempotencyKey).digest("hex"),
				p_grant_id: request.grantId,
				p_connector_id: request.connectorId,
				p_operation_id: request.operationId,
				p_operation_version: request.operationVersion,
				p_adapter_sha256: request.adapterSha256,
				p_destination_origin: request.destinationOrigin,
			},
			signal,
		);
	}

	async #rpc(name: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		return withCloudDeadline(
			async (requestSignal) => {
				const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${name}`, {
					method: "POST",
					redirect: "error",
					headers: { ...supabaseServiceHeaders(this.#serviceKey), "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: requestSignal,
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("Cloud secret authority rejected the operation");
				}
				const bytes = await readBoundedCloudResponse(response, MAX_RPC_BYTES, requestSignal);
				try {
					return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
				} catch {
					throw new Error("Cloud secret authority returned invalid data");
				} finally {
					bytes.fill(0);
				}
			},
			5000,
			signal,
		);
	}
}

/** Least-privilege broker authority. The database login is the NOINHERIT
 * `qorpera_secret_broker` role and can execute only the three custody RPCs;
 * it has no table privileges and never holds a Supabase service key. */
export class PostgresCloudSecretBrokerAuthority implements CloudSecretBrokerAuthority {
	readonly #database: CloudSecretPostgresClient;
	readonly #brokerAuthorityId: string;
	readonly #brokerCapabilitySha256: string;

	constructor(options: {
		database: CloudSecretPostgresClient;
		brokerAuthorityId: string;
		brokerCapability: string;
	}) {
		this.#database = options.database;
		this.#brokerAuthorityId = uuid(options.brokerAuthorityId, "Cloud secret broker authority");
		if (!CAPABILITY.test(options.brokerCapability)) throw new Error("Cloud secret broker capability is invalid");
		this.#brokerCapabilitySha256 = createHash("sha256").update(options.brokerCapability).digest("hex");
	}

	describeCapture(ticketId: string, captureCapabilitySha256: string, signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_describe_cloud_secret_capture($1::uuid,$2::text,$3::uuid,$4::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256, ticketId, captureCapabilitySha256],
			signal,
		);
	}

	completeCapture(
		ticketId: string,
		captureCapabilitySha256: string,
		encryptedEnvelope: Uint8Array,
		envelopeSha256: string,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_complete_cloud_secret_capture($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text) as result",
			[
				this.#brokerAuthorityId,
				this.#brokerCapabilitySha256,
				ticketId,
				captureCapabilitySha256,
				Buffer.from(encryptedEnvelope).toString("base64"),
				envelopeSha256,
			],
			signal,
		);
	}

	authorizeOperation(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_authorize_cloud_secret_operation($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text,$7::uuid,$8::text,$9::text,$10::bigint,$11::text,$12::text) as result",
			[
				this.#brokerAuthorityId,
				this.#brokerCapabilitySha256,
				JSON.stringify(request.binding),
				request.receiptId,
				request.inputSha256,
				createHash("sha256").update(request.idempotencyKey).digest("hex"),
				request.grantId,
				request.connectorId,
				request.operationId,
				request.operationVersion,
				request.adapterSha256,
				request.destinationOrigin,
			],
			signal,
		);
	}

	async #rpc(text: string, values: readonly unknown[], signal: AbortSignal): Promise<unknown> {
		return withCloudDeadline(
			async () => {
				const result = await this.#database.query<{ result: unknown }>(text, values);
				if (result.rowCount !== 1 || result.rows.length !== 1 || !("result" in (result.rows[0] ?? {}))) {
					throw new Error("Cloud secret authority returned invalid data");
				}
				return result.rows[0]?.result;
			},
			5000,
			signal,
		);
	}
}
