import { createHash, createHmac } from "node:crypto";
import {
	readBoundedCloudResponse,
	supabaseServiceHeaders,
	withCloudDeadline,
} from "@qorpera/cloud-client/cloud-request";
import { type CloudCodingRepository, type JsonValue, parseCloudCodingRepository } from "@qorpera/contracts";
import type { ModelLoginAuthority, ModelLoginRunBinding } from "./cloud-model-login-vault.ts";
import type { ModelLoginSignInAuthority } from "./cloud-model-login-vault-sign-in.ts";
import type { ModelLoginUsageAuthority } from "./cloud-model-login-vault-usage.ts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import type { CloudToolContent } from "./cloud-native-tool-boundary.ts";
import { cloudToolJsonText } from "./cloud-native-tool-boundary.ts";
import type { CloudSecretEnvelopeIdentity, CloudSecretKeyring } from "./cloud-secret-crypto.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{32,256}$/;
const EXECUTOR_OWNER = /^[A-Za-z0-9_.:-]{1,120}$/;
/** GitHub OAuth, app and personal access tokens: letters, digits, underscores. */
const REPOSITORY_TOKEN = /^[A-Za-z0-9_]{20,512}$/;
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
	/** Non-secret account identity shown to members, e.g. the mailbox address
	 * or GitHub login. Set by OAuth captures; null for typed tokens. */
	readonly accountLabel?: string | null;
}

/** What the OAuth start route may learn about a ticket before any provider
 * contact: the connector and owner class, never the ticket's key or scope. */
export interface CloudSecretCaptureSummary {
	readonly ticketId: string;
	/** The ticket's company profile id (not a secret). */
	readonly companyId: string;
	readonly connectorId: string;
	readonly ownerKind: "company" | "member";
	readonly expiresAt: string;
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

/** A coding executor asking for the repository token of one session it holds
 * (bundle v88). Naming only: the kernel checks every part against the lease. */
export interface CodingRepositoryCredentialRequest {
	readonly workerId: string;
	readonly leaseToken: string;
	readonly executorOwner: string;
	readonly repository: CloudCodingRepository;
}

/** The only answer that ever carries a token out of the broker. It goes to the
 * executor's Git broker, never into a repository VM, a model turn or a log. */
export interface CodingRepositoryCredential {
	readonly schema: "qorpera.coding-repository-credential/v1";
	readonly token: string;
}

export interface CodingRepositoryCredentialAuthorization extends CloudSecretEnvelopeIdentity {
	readonly schema: "qorpera.coding-repository-credential-authorization/v1";
	readonly connectorId: "github";
	readonly credentialName: "access_token";
	readonly encryptedEnvelopeBase64: string;
	readonly envelopeSha256: string;
	readonly workerId: string;
	readonly repository: CloudCodingRepository;
}

export interface CloudSecretBrokerAuthority {
	claimEmailDraftAction?(actionId: string, capabilitySha256: string, signal: AbortSignal): Promise<unknown>;
	finishEmailDraftAction?(
		actionId: string,
		capabilitySha256: string,
		result: JsonValue,
		signal: AbortSignal,
	): Promise<unknown>;
	describeCapture(ticketId: string, captureCapabilitySha256: string, signal: AbortSignal): Promise<unknown>;
	completeCapture(
		ticketId: string,
		captureCapabilitySha256: string,
		encryptedEnvelope: Uint8Array,
		envelopeSha256: string,
		accountLabel: string | null,
		signal: AbortSignal,
	): Promise<unknown>;
	authorizeOperation(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<unknown>;
	authorizeRepositoryCredential(request: CodingRepositoryCredentialRequest, signal: AbortSignal): Promise<unknown>;
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

const ACCOUNT_LABEL = /^[^\s\0]{1,254}$/;

export function parseCloudSecretAccountLabel(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !ACCOUNT_LABEL.test(value))
		throw new Error("Cloud secret account label is invalid");
	return value;
}

function parseDescriptor(value: unknown, description: CloudSecretCaptureDescription): CloudSecretDescriptor {
	const input = record(value, "Cloud secret descriptor");
	const keys = [
		"schema",
		"secretId",
		"version",
		"connectorId",
		"secretName",
		"purpose",
		"ownerKind",
		"ownerUserId",
		"status",
	];
	exact(input, Object.hasOwn(input, "accountLabel") ? [...keys, "accountLabel"] : keys, "Cloud secret descriptor");
	parseCloudSecretAccountLabel(input.accountLabel);
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

export function parseCodingRepositoryCredentialRequest(value: {
	readonly workerId: unknown;
	readonly leaseToken: unknown;
	readonly executorOwner: unknown;
	readonly repository: unknown;
}): CodingRepositoryCredentialRequest {
	if (typeof value.executorOwner !== "string" || !EXECUTOR_OWNER.test(value.executorOwner))
		throw new Error("Coding repository credential request is invalid");
	return {
		workerId: uuid(value.workerId, "Coding worker").toLowerCase(),
		leaseToken: uuid(value.leaseToken, "Coding lease").toLowerCase(),
		executorOwner: value.executorOwner,
		repository: parseCloudCodingRepository(value.repository),
	};
}

function parseRepositoryAuthorization(
	value: unknown,
	request: CodingRepositoryCredentialRequest,
): CodingRepositoryCredentialAuthorization {
	const input = record(value, "Coding repository credential authorization");
	exact(
		input,
		[
			"schema",
			"companyId",
			"environmentId",
			"secretId",
			"secretVersion",
			"keyId",
			"connectorId",
			"credentialName",
			"encryptedEnvelopeBase64",
			"envelopeSha256",
			"workerId",
			"repository",
		],
		"Coding repository credential authorization",
	);
	const repository = parseCloudCodingRepository(input.repository);
	if (
		input.schema !== "qorpera.coding-repository-credential-authorization/v1" ||
		input.connectorId !== "github" ||
		input.credentialName !== "access_token" ||
		typeof input.workerId !== "string" ||
		input.workerId.toLowerCase() !== request.workerId ||
		JSON.stringify(repository) !== JSON.stringify(request.repository) ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		typeof input.encryptedEnvelopeBase64 !== "string" ||
		!/^[A-Za-z0-9+/=\r\n]+$/.test(input.encryptedEnvelopeBase64) ||
		typeof input.envelopeSha256 !== "string" ||
		!SHA.test(input.envelopeSha256)
	)
		throw new Error("Coding repository credential authorization differs from its request");
	return {
		schema: "qorpera.coding-repository-credential-authorization/v1",
		companyId: uuid(input.companyId, "Cloud secret company"),
		environmentId: uuid(input.environmentId, "Cloud secret environment"),
		secretId: uuid(input.secretId, "Cloud secret id"),
		version: integer(input.secretVersion, "Cloud secret version"),
		keyId: input.keyId,
		connectorId: "github",
		credentialName: "access_token",
		encryptedEnvelopeBase64: input.encryptedEnvelopeBase64,
		envelopeSha256: input.envelopeSha256,
		workerId: request.workerId,
		repository,
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

	async capture(
		request: CloudSecretCaptureRequest,
		signal: AbortSignal,
		accountLabel: string | null = null,
	): Promise<CloudSecretDescriptor> {
		try {
			return await this.#capture(request, signal, parseCloudSecretAccountLabel(accountLabel));
		} catch {
			throw new Error("Cloud secret capture was not confirmed");
		}
	}

	/** Lets the OAuth start route confirm a ticket and learn its connector
	 * before sending the member to the provider. Nothing is committed. */
	async describeCapture(
		request: Omit<CloudSecretCaptureRequest, "fields">,
		signal: AbortSignal,
	): Promise<CloudSecretCaptureSummary> {
		try {
			const description = await this.#describe(request, signal);
			return {
				ticketId: description.ticketId,
				companyId: description.companyId,
				connectorId: description.connectorId,
				ownerKind: description.ownerKind,
				expiresAt: description.expiresAt,
			};
		} catch {
			throw new Error("Cloud secret capture is unavailable");
		}
	}

	async #describe(
		request: Omit<CloudSecretCaptureRequest, "fields">,
		signal: AbortSignal,
	): Promise<CloudSecretCaptureDescription> {
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
		return description;
	}

	async #capture(
		request: CloudSecretCaptureRequest,
		signal: AbortSignal,
		accountLabel: string | null,
	): Promise<CloudSecretDescriptor> {
		const description = await this.#describe(request, signal);
		const capabilitySha256 = createHash("sha256").update(request.captureCapability).digest("hex");
		const envelope = this.#keys.seal(request.fields, description);
		try {
			const envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
			return parseDescriptor(
				await this.#authority.completeCapture(
					request.ticketId,
					capabilitySha256,
					envelope,
					envelopeSha256,
					accountLabel,
					signal,
				),
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

	/** A member capability is bound by the kernel to one card and exact edits.
	 * Claim commits before touching Gmail; a duplicate or an interrupted process
	 * can only read its receipt, never issue a second provider mutation. */
	async executeEmailDraft(actionId: string, capability: string, signal: AbortSignal): Promise<JsonValue> {
		if (
			!UUID.test(actionId) ||
			!CAPABILITY.test(capability) ||
			!this.#authority.claimEmailDraftAction ||
			!this.#authority.finishEmailDraftAction
		)
			throw new Error("Email draft action unavailable");
		const hash = createHash("sha256").update(capability).digest("hex");
		const claim = record(await this.#authority.claimEmailDraftAction(actionId, hash, signal), "Email draft claim");
		if (claim.execute === false) return claim.state as JsonValue;
		if (claim.execute !== true || !["save", "send", "discard"].includes(String(claim.action)))
			throw new Error("Email draft claim invalid");
		let result: JsonValue = { status: "unconfirmed" };
		try {
			if (claim.action === "discard" && claim.draftId === null) result = { deleted: true };
			else {
				const operationId =
					claim.action === "save"
						? claim.draftId
							? "update_draft"
							: "create_draft"
						: claim.action === "send"
							? claim.draftId
								? "send_draft"
								: "send_message"
							: "delete_draft";
				const adapters = [...this.#adapters.values()].filter(
					(adapter) => adapter.connectorId === "gmail" && adapter.operationId === operationId,
				);
				if (adapters.length !== 1) throw new Error("Gmail draft adapter unavailable");
				const adapter = adapters[0];
				const identity: CloudSecretEnvelopeIdentity = {
					companyId: uuid(claim.companyId, "Email company"),
					environmentId: uuid(claim.environmentId, "Email environment"),
					secretId: uuid(claim.secretId, "Email secret"),
					version: integer(claim.version, "Email secret version"),
					keyId: String(claim.keyId),
				};
				const envelope = Buffer.from(String(claim.encryptedEnvelopeBase64), "base64");
				try {
					if (createHash("sha256").update(envelope).digest("hex") !== claim.envelopeSha256)
						throw new Error("Email envelope invalid");
					result = await this.#keys.use(envelope, identity, async (credentials) => {
						const content = record(claim.content, "Email content");
						const argumentsValue: JsonValue =
							claim.action === "discard"
								? { draft_id: String(claim.draftId) }
								: {
										...(content as Record<string, JsonValue>),
										...(claim.draftId ? { draft_id: String(claim.draftId) } : {}),
										...(claim.replyTo ? { reply_to_message_id: String(claim.replyTo) } : {}),
									};
						const output = await adapter.execute({
							arguments: argumentsValue,
							credentials,
							credentialName: "refresh_token",
							destinationOrigin: adapter.destinationOrigin,
							idempotencyKey: actionId,
							signal,
						});
						if (containsSensitiveOutput(output, sensitiveFingerprints(credentials)))
							return { status: "unconfirmed" };
						const response = record(output, "Gmail result");
						if (response.status === "completed") return response.result as JsonValue;
						// Only a definitive rejection is retryable with a NEW member action.
						// Provider/server failures, malformed success and transport errors may have sent.
						if (
							response.status === "failed" &&
							["authorization_required", "forbidden", "invalid_request", "not_found", "rate_limited"].includes(
								String(response.reason),
							)
						)
							return {
								status: "failed",
								error:
									response.reason === "authorization_required" || response.reason === "forbidden"
										? "Reconnect Gmail to allow this email action."
										: "Gmail refused this email action. Review the draft and try again.",
							};
						return { status: "unconfirmed" };
					});
				} finally {
					envelope.fill(0);
				}
			}
		} catch {
			result = { status: "unconfirmed" };
		}
		// Completion has its own deadline: aborting a browser/provider call must
		// not skip persistence of a success or ambiguous result.
		return (await this.#authority.finishEmailDraftAction(
			actionId,
			hash,
			result,
			AbortSignal.timeout(5000),
		)) as JsonValue;
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

	/**
	 * The coding executor's repository token (bundle v88): the company's GitHub
	 * connection, released only for a session the kernel confirms the executor
	 * holds right now. The token goes back to the executor's Git broker and
	 * nowhere else; every failure is the same opaque refusal.
	 */
	async repositoryCredential(
		request: CodingRepositoryCredentialRequest,
		signal: AbortSignal,
	): Promise<CodingRepositoryCredential> {
		try {
			return await this.#repositoryCredential(request, signal);
		} catch {
			throw new Error("Coding repository credential is unavailable");
		}
	}

	async #repositoryCredential(
		value: CodingRepositoryCredentialRequest,
		signal: AbortSignal,
	): Promise<CodingRepositoryCredential> {
		const request = parseCodingRepositoryCredentialRequest(value);
		const authorization = parseRepositoryAuthorization(
			await this.#authority.authorizeRepositoryCredential(request, signal),
			request,
		);
		const envelope = Buffer.from(authorization.encryptedEnvelopeBase64, "base64");
		try {
			if (createHash("sha256").update(envelope).digest("hex") !== authorization.envelopeSha256)
				throw new Error("Cloud secret envelope digest differs");
			return await this.#keys.use(envelope, authorization, async (fields) => {
				const token = Object.hasOwn(fields, authorization.credentialName)
					? fields[authorization.credentialName]
					: undefined;
				if (typeof token !== "string" || !REPOSITORY_TOKEN.test(token))
					throw new Error("Cloud secret credential field is unavailable");
				signal.throwIfAborted();
				return { schema: "qorpera.coding-repository-credential/v1", token };
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
		accountLabel: string | null,
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
				p_account_label: accountLabel,
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

	authorizeRepositoryCredential(request: CodingRepositoryCredentialRequest, signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"qorpera_authorize_coding_repository_credential",
			{
				p_broker_authority_id: this.#brokerAuthorityId,
				p_broker_capability_sha256: this.#brokerCapabilitySha256,
				p_worker_id: request.workerId,
				p_lease_token: request.leaseToken,
				p_executor_owner: request.executorOwner,
				p_repository: request.repository,
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
 * `qorpera_secret_broker` role and can execute only the custody RPCs (capture
 * description and completion, operation and repository credential
 * authorization, handing a live run its model login and saving or giving back
 * one renewal); it has no table privileges and never holds a Supabase service
 * key. */
export class PostgresCloudSecretBrokerAuthority
	implements CloudSecretBrokerAuthority, ModelLoginAuthority, ModelLoginSignInAuthority, ModelLoginUsageAuthority
{
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

	claimEmailDraftAction(actionId: string, capabilitySha256: string, signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_claim_email_draft_action($1::uuid,$2::text,$3::uuid,$4::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256, actionId, capabilitySha256],
			signal,
		);
	}

	finishEmailDraftAction(
		actionId: string,
		capabilitySha256: string,
		result: JsonValue,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_finish_email_draft_action($1::uuid,$2::text,$3::uuid,$4::text,$5::jsonb) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256, actionId, capabilitySha256, JSON.stringify(result)],
			signal,
		);
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
		accountLabel: string | null,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_complete_cloud_secret_capture($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text) as result",
			[
				this.#brokerAuthorityId,
				this.#brokerCapabilitySha256,
				ticketId,
				captureCapabilitySha256,
				Buffer.from(encryptedEnvelope).toString("base64"),
				envelopeSha256,
				accountLabel,
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

	authorizeRepositoryCredential(request: CodingRepositoryCredentialRequest, signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_authorize_coding_repository_credential($1::uuid,$2::text,$3::uuid,$4::uuid,$5::text,$6::jsonb) as result",
			[
				this.#brokerAuthorityId,
				this.#brokerCapabilitySha256,
				request.workerId,
				request.leaseToken,
				request.executorOwner,
				JSON.stringify(request.repository),
			],
			signal,
		);
	}

	issueModelLogin(
		binding: ModelLoginRunBinding,
		knownVersion: number | null,
		allowRenewal: boolean,
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_issue_model_login($1::uuid,$2::text,$3::jsonb,$4::bigint,$5::boolean) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256, JSON.stringify(binding), knownVersion, allowRenewal],
			signal,
		);
	}

	commitModelLoginRenewal(
		renewal: Parameters<ModelLoginAuthority["commitModelLoginRenewal"]>[0],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_commit_model_login_renewal($1::uuid,$2::text,$3::uuid,$4::uuid,$5::bigint,$6::text,$7::text,$8::text,$9::timestamptz,$10::timestamptz) as result",
			[
				this.#brokerAuthorityId,
				this.#brokerCapabilitySha256,
				renewal.loginId,
				renewal.token,
				renewal.baseVersion,
				renewal.keyId,
				Buffer.from(renewal.encryptedEnvelope).toString("base64"),
				renewal.envelopeSha256,
				renewal.accessIssuedAt,
				renewal.accessExpiresAt,
			],
			signal,
		);
	}

	releaseModelLoginRenewal(
		release: Parameters<ModelLoginAuthority["releaseModelLoginRenewal"]>[0],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_release_model_login_renewal($1::uuid,$2::text,$3::uuid,$4::uuid,$5::bigint,$6::boolean,$7::text) as result",
			[
				this.#brokerAuthorityId,
				this.#brokerCapabilitySha256,
				release.loginId,
				release.token,
				release.baseVersion,
				release.permanent,
				release.reason,
			],
			signal,
		);
	}

	takeIdleModelLoginRenewal(signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_take_idle_model_login_renewal($1::uuid,$2::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256],
			signal,
		);
	}

	listModelLoginsWithoutAccount(signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_model_logins_without_account($1::uuid,$2::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256],
			signal,
		);
	}

	recordModelLoginAccount(
		account: Parameters<ModelLoginAuthority["recordModelLoginAccount"]>[0],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_record_model_login_account($1::uuid,$2::text,$3::uuid,$4::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256, account.loginId, account.accountIdentity],
			signal,
		);
	}

	switchOffReplacedNodeLogins(signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_switch_off_replaced_node_logins($1::uuid,$2::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256],
			signal,
		);
	}

	describeModelLoginSignIn(
		request: Parameters<ModelLoginSignInAuthority["describeModelLoginSignIn"]>[0],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_describe_model_login_sign_in($1::uuid,$2::text,$3::uuid,$4::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256, request.loginId, request.capabilitySha256],
			signal,
		);
	}

	modelLoginBrokerCompany(signal: AbortSignal): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_model_login_broker_company($1::uuid,$2::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256],
			signal,
		);
	}

	completeModelLoginSignIn(
		completion: Parameters<ModelLoginSignInAuthority["completeModelLoginSignIn"]>[0],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_complete_model_login_sign_in($1::uuid,$2::text,$3::uuid,$4::text,$5::uuid,$6::text,$7::text,$8::text,$9::timestamptz,$10::timestamptz,$11::text,$12::text) as result",
			[
				this.#brokerAuthorityId,
				this.#brokerCapabilitySha256,
				completion.loginId,
				completion.capabilitySha256,
				completion.modelLoginId,
				completion.keyId,
				Buffer.from(completion.encryptedEnvelope).toString("base64"),
				completion.envelopeSha256,
				completion.accessIssuedAt,
				completion.accessExpiresAt,
				completion.providerAccountReference,
				completion.providerAccountEmail,
			],
			signal,
		);
	}

	describeModelLoginAccountRefresh(
		request: Parameters<ModelLoginUsageAuthority["describeModelLoginAccountRefresh"]>[0],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_describe_model_login_account_refresh($1::uuid,$2::text,$3::uuid,$4::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256, request.requestId, request.capabilitySha256],
			signal,
		);
	}

	recordModelLoginAccountMetadata(
		metadata: Parameters<ModelLoginUsageAuthority["recordModelLoginAccountMetadata"]>[0],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_record_model_login_account_metadata($1::uuid,$2::text,$3::uuid,$4::text,$5::uuid,$6::uuid,$7::bigint,$8::text,$9::jsonb,$10::text) as result",
			[
				this.#brokerAuthorityId,
				this.#brokerCapabilitySha256,
				metadata.requestId,
				metadata.capabilitySha256,
				metadata.loginId,
				metadata.connectionId,
				metadata.connectionVersion,
				metadata.providerAccountEmail,
				metadata.providerAccountUsage === null ? null : JSON.stringify(metadata.providerAccountUsage),
				metadata.providerAccountIdentity,
			],
			signal,
		);
	}

	completeModelLoginAccountRefresh(
		request: Parameters<ModelLoginUsageAuthority["completeModelLoginAccountRefresh"]>[0],
		signal: AbortSignal,
	): Promise<unknown> {
		return this.#rpc(
			"select public.qorpera_complete_model_login_account_refresh($1::uuid,$2::text,$3::uuid,$4::text) as result",
			[this.#brokerAuthorityId, this.#brokerCapabilitySha256, request.requestId, request.capabilitySha256],
			signal,
		);
	}

	#rpc(text: string, values: readonly unknown[], signal: AbortSignal): Promise<unknown> {
		return oneCloudSecretRpc(this.#database, text, values, signal);
	}
}

/** One broker database call: exactly one row with a `result`, within 5 s. */
function oneCloudSecretRpc(
	database: CloudSecretPostgresClient,
	text: string,
	values: readonly unknown[],
	signal: AbortSignal,
): Promise<unknown> {
	return withCloudDeadline(
		async () => {
			const result = await database.query<{ result: unknown }>(text, values);
			if (result.rowCount !== 1 || result.rows.length !== 1 || !("result" in (result.rows[0] ?? {}))) {
				throw new Error("Cloud secret authority returned invalid data");
			}
			return result.rows[0]?.result;
		},
		5000,
		signal,
	);
}

const PRINCIPAL_SECRET = /^[A-Za-z0-9_-]{43}$/;

/** The shared vault's capabilities (Vault By Default), all derived from its one principal secret so both
 * copies of the vault hold the same ones and nothing is stored: its own, which lets it register new
 * companies, and each company's, whose hash is that company's authority row. */
export function sharedBrokerCapability(principalSecret: string, companyId?: string): string {
	if (!PRINCIPAL_SECRET.test(principalSecret)) throw new Error("Shared cloud secret broker secret is invalid");
	const label =
		companyId === undefined
			? "qorpera.broker-principal/v1"
			: `qorpera.broker-authority/v1:${uuid(companyId, "Shared cloud secret broker company").toLowerCase()}`;
	return createHmac("sha256", Buffer.from(principalSecret, "base64url")).update(label).digest("base64url");
}

/** The shared vault's principal: it lists the companies it serves and registers new ones, and hands out
 * each company's own authority, which every existing broker call uses unchanged. */
export class PostgresCloudSecretBrokerPrincipal {
	readonly #database: CloudSecretPostgresClient;
	readonly #principalId: string;
	readonly #principalSecret: string;
	readonly #capabilitySha256: string;

	constructor(options: { database: CloudSecretPostgresClient; principalId: string; principalSecret: string }) {
		this.#database = options.database;
		this.#principalId = uuid(options.principalId, "Shared cloud secret broker principal");
		this.#principalSecret = options.principalSecret;
		this.#capabilitySha256 = createHash("sha256")
			.update(sharedBrokerCapability(options.principalSecret))
			.digest("hex");
	}

	/** The companies it serves and the new companies it should register. */
	companies(signal: AbortSignal): Promise<unknown> {
		return oneCloudSecretRpc(
			this.#database,
			"select public.qorpera_broker_principal_companies($1::uuid,$2::text) as result",
			[this.#principalId, this.#capabilitySha256],
			signal,
		);
	}

	/** Registers a new company: its authority row carries the hash of the capability derived for it. */
	register(companyId: string, signal: AbortSignal): Promise<unknown> {
		const capability = sharedBrokerCapability(this.#principalSecret, companyId);
		return oneCloudSecretRpc(
			this.#database,
			"select public.qorpera_register_company_with_broker_principal($1::uuid,$2::text,$3::uuid,$4::text) as result",
			[this.#principalId, this.#capabilitySha256, companyId, createHash("sha256").update(capability).digest("hex")],
			signal,
		);
	}

	/** A registered company's own authority: every existing broker call with its derived capability. */
	authority(companyId: string, authorityId: string): PostgresCloudSecretBrokerAuthority {
		return new PostgresCloudSecretBrokerAuthority({
			database: this.#database,
			brokerAuthorityId: authorityId,
			brokerCapability: sharedBrokerCapability(this.#principalSecret, companyId),
		});
	}
}
