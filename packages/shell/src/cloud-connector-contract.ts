import { createHash } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";

export const CLOUD_CONNECTOR_SCHEMA = "qorpera.cloud-connector/v2";
export const CLOUD_CONNECTOR_RESULT_SCHEMA = "qorpera.cloud-connector-result/v2";
export const CLOUD_CONNECTOR_SOURCE_CAPABILITY_SCHEMA = "qorpera.cloud-connector-source-capability/v1";
export const CLOUD_CONNECTOR_SOURCE_INVENTORY_SCHEMA = "qorpera.cloud-connector-source-inventory/v1";
export const CLOUD_CONNECTOR_SOURCE_SYSTEM_SCHEMA = "qorpera.cloud-connector-source-system/v2";
export const CLOUD_CONNECTOR_CONTINUATION_SCHEMA = "qorpera.cloud-connector-continuation/v1";
export const CONNECTOR_MAX_DURATION_MS = 20_000;
export const CONNECTOR_MAX_RESPONSE_BYTES = 256 * 1024;
export const CONNECTOR_MAX_RESULT_BYTES = 16 * 1024;
/** Leave room for Step 2's full admitted identity in its 8 KiB result envelope. */
export const CONNECTOR_MAX_FENCED_CONTENT_BYTES = 5 * 1024;
export const CONNECTOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CONNECTOR_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const CONNECTOR_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export const CONNECTOR_HASH = /^[a-f0-9]{64}$/;

export type ConnectorJsonObject = { [key: string]: JsonValue };

/** Structural minimum only. Pass the ENTIRE admitted Step 2 identity as I. This is not a grant. */
export interface ConnectorRunIdentity {
	readonly companyId: string;
	readonly runId: string;
	readonly staffAgentId: string;
	readonly requesterUserId: string;
}

export type ConnectorContent = { kind: "json"; value: JsonValue } | { kind: "text"; value: string };

/** Matches CloudNativeToolOperation; no replacement ledger or authority implementation. */
export interface ConnectorNativeOperation {
	readonly tool: string;
	readonly toolVersion: string;
	readonly logicalOperationKey: string;
	readonly arguments: JsonValue;
	readonly target: ConnectorJsonObject;
	readonly requiresCompanyRevision: boolean;
}

export interface ConnectorReceiptContext<I extends ConnectorRunIdentity> {
	readonly identity: I;
	readonly receiptId: string;
	readonly idempotencyKey: string;
	readonly signal: AbortSignal;
}

/**
 * Supply the existing CloudNativeToolOperations instance, never an in-memory production substitute.
 * It must await authorization before beginning a receipt and honor cancellation before admission.
 * The native instance retains its own run cancellation. Its signal below is the connector session
 * lifetime; per-caller cancellation is enforced in authorize/perform and the bounded result wait,
 * so cancelling one waiter cannot abort another caller's native run-authority check.
 * An already-admitted read may finish its live checks and complete a data-free cancellation
 * receipt after its caller stops waiting. Native run cancellation still prevents completion.
 */
export interface ConnectorNativeOperations<I extends ConnectorRunIdentity> {
	execute(options: {
		operation: ConnectorNativeOperation;
		authorize: (operation: ConnectorNativeOperation, identity: I, signal: AbortSignal) => Promise<void>;
		perform: (
			operation: ConnectorNativeOperation,
			context: ConnectorReceiptContext<I>,
		) => Promise<{ content: ConnectorContent; outputSnapshotId?: string; proposalId?: string }>;
		signal: AbortSignal;
	}): Promise<ConnectorContent>;
}

/** Structurally compatible with the existing CloudNativeToolBoundary. */
export interface ConnectorNativeTool<I extends ConnectorRunIdentity> {
	readonly name: string;
	readonly description: string;
	readonly source: "connector";
	readonly inputSchema: ConnectorJsonObject;
	parseArguments(value: JsonValue): JsonValue;
	execute(
		value: JsonValue,
		context: {
			readonly companyId: string;
			readonly runId: string;
			readonly callId: string;
			readonly argumentSha256: string;
			readonly identity?: I;
			readonly signal: AbortSignal;
		},
	): Promise<ConnectorContent>;
}

export interface ConnectorImplementation {
	readonly id: string;
	readonly version: string;
	readonly sha256: string;
}

export type ConnectorSourceCapabilityKind =
	| "source_inventory"
	| "container_listing"
	| "metadata_retrieval"
	| "content_retrieval";

export type ConnectorSourceResourceKind = "repository" | "directory" | "file";

/** Descriptive compiled metadata only. Live authority is still required for every operation. */
export interface ConnectorSourceCapability {
	readonly schema: typeof CLOUD_CONNECTOR_SOURCE_CAPABILITY_SCHEMA;
	readonly kind: ConnectorSourceCapabilityKind;
	readonly resourceKinds: readonly ConnectorSourceResourceKind[];
	readonly pagination: "none" | "host_continuation";
	readonly maxItems: number;
	readonly maxOutputBytes: number;
	readonly maxDepth: number;
	readonly maxRequests: number;
	readonly maxContinuationSteps: number;
}

export interface ConnectorOperationDefinition {
	readonly id: string;
	readonly version: string;
	readonly description: string;
	readonly access: "read" | "write";
	readonly effect: "none" | "external" | "destructive";
	readonly permission: string;
	readonly inputSchema: ConnectorJsonObject;
	readonly receipt: "run_operation";
	readonly retry: "read_after_reauthorization" | "never_automatically";
	readonly reconciliation: "none";
	readonly approval: "live_grant" | "action_grant";
	readonly resultTrust: "untrusted_data";
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
	readonly sourceCapability: ConnectorSourceCapability | null;
}

export interface CloudConnectorManifest {
	readonly schema: typeof CLOUD_CONNECTOR_SCHEMA;
	readonly id: string;
	readonly version: string;
	readonly displayName: string;
	readonly provider: string;
	readonly implementation: ConnectorImplementation;
	readonly destinations: readonly string[];
	readonly authentication: "out_of_band_bearer";
	readonly authorizationSurface: "connector_authorization";
	readonly operations: readonly ConnectorOperationDefinition[];
}

export interface ConnectorCompanyObject {
	readonly companyFileId: string;
	readonly objectId: string;
	readonly logicalPath: string;
	readonly objectVersion: string;
	readonly ownerPrincipalId: string;
	readonly policyClass: string;
}

/** A governed Company File read/projection, not a filesystem path or installation request. */
export interface ConnectorInstallation {
	readonly companyId: string;
	readonly object: ConnectorCompanyObject;
	readonly manifest: CloudConnectorManifest;
	readonly enabledOperations: readonly string[];
}

export type ConnectorCredentialOwner = { readonly kind: "member" | "company"; readonly id: string };

/** Opaque vault reference only. Never put bearer values or a provider-subscription capsule here. */
export interface ConnectorCredentialHandle {
	readonly id: string;
	readonly version: number;
}

/** Cloud-resolved and pinned per run. No account, owner, handle, or grant selector is model-facing. */
export interface ConnectorAccountBinding {
	readonly companyId: string;
	readonly connectionId: string;
	readonly connectionVersion: number;
	readonly providerAccountId: string;
	readonly owner: ConnectorCredentialOwner;
	readonly credential: ConnectorCredentialHandle | null;
	readonly grant: { readonly id: string; readonly version: number; readonly approverUserId: string | null } | null;
}

export interface ConnectorPreparedRequest {
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly resource: ConnectorJsonObject;
	readonly successStatus: number;
}

export interface ConnectorContinuationHandle {
	readonly id: string;
	readonly version: number;
}

/** Host-only scope. It binds an opaque continuation to this run, audience, account and selector. */
export interface ConnectorContinuationScope {
	readonly schema: typeof CLOUD_CONNECTOR_CONTINUATION_SCHEMA;
	readonly identity: ConnectorRunIdentity;
	readonly runtimeBundleVersion: string;
	readonly audience: ConnectorJsonObject;
	readonly installation: ConnectorCompanyObject;
	readonly manifestSha256: string;
	readonly connectorId: string;
	readonly connectorVersion: string;
	readonly implementation: ConnectorImplementation;
	readonly operationId: string;
	readonly operationVersion: string;
	readonly account: ConnectorAccountBinding;
	readonly selectorSha256: string;
}

export interface ConnectorResolvedContinuation {
	readonly schema: typeof CLOUD_CONNECTOR_CONTINUATION_SCHEMA;
	readonly handle: ConnectorContinuationHandle;
	readonly scopeSha256: string;
	readonly cursor: ConnectorJsonObject;
}

/**
 * Adapter to existing trusted host control state. It is not a model cursor, grant,
 * scheduler, crawler queue, or new production store. Missing integration fails closed.
 */
export interface ConnectorContinuationPort {
	resolve(
		scope: ConnectorContinuationScope,
		handle: ConnectorContinuationHandle,
		signal: AbortSignal,
	): Promise<ConnectorResolvedContinuation>;
	issue(
		scope: ConnectorContinuationScope,
		cursor: ConnectorJsonObject,
		signal: AbortSignal,
	): Promise<Omit<ConnectorResolvedContinuation, "cursor">>;
}

export interface ConnectorSourceRevision {
	readonly kind: "git_commit" | "git_tree" | "git_blob" | "unavailable";
	readonly value: string | null;
	readonly stable: boolean;
}

export interface ConnectorSourceResource {
	readonly providerResourceId: string;
	readonly kind: ConnectorSourceResourceKind;
	readonly label: string;
	readonly locator: string;
	readonly parent: {
		readonly providerResourceId: string;
		readonly kind: Exclude<ConnectorSourceResourceKind, "file">;
	} | null;
	readonly revision: ConnectorSourceRevision;
	readonly providerTimestamps: ConnectorJsonObject;
	readonly accessibility: "metadata" | "listable" | "readable" | "unsupported";
	readonly followUpOperations: readonly string[];
	readonly metadata: ConnectorJsonObject;
	readonly content?: {
		readonly mediaType: "text/plain; charset=utf-8";
		readonly text: string;
		readonly bytes: number;
		readonly sha256: string;
	};
}

export interface ConnectorSourcePage {
	readonly resources: readonly ConnectorSourceResource[];
	readonly complete: boolean;
	readonly truncated: boolean;
	readonly reason: "none" | "item_limit" | "byte_limit" | "continuation_limit";
	readonly nextCursor?: ConnectorJsonObject;
}

export interface ConnectorSourceInventory {
	readonly schema: typeof CLOUD_CONNECTOR_SOURCE_INVENTORY_SCHEMA;
	readonly trust: "untrusted_data";
	readonly provider: string;
	readonly connector: {
		readonly id: string;
		readonly version: string;
		readonly implementation: ConnectorImplementation;
	};
	readonly account: {
		readonly companyId: string;
		readonly connectionId: string;
		readonly connectionVersion: number;
		readonly providerAccountId: string;
		readonly owner: ConnectorCredentialOwner;
		readonly grant: { readonly id: string; readonly version: number } | null;
		readonly credentialVersion: number | null;
	};
	readonly requesterUserId: string;
	readonly audience: ConnectorJsonObject;
	readonly visibility:
		| { readonly scope: "member_private"; readonly ownerId: string }
		| { readonly scope: "company_owned"; readonly companyId: string };
	readonly capability: {
		readonly kind: ConnectorSourceCapabilityKind;
		readonly operationId: string;
		readonly operationVersion: string;
	};
	readonly resources: readonly ConnectorSourceResource[];
	readonly completeness: {
		readonly complete: boolean;
		readonly truncated: boolean;
		readonly reason: ConnectorSourcePage["reason"];
	};
	readonly continuation: ConnectorContinuationHandle | null;
	readonly publication: "requires_governed_company_file_operation";
	readonly imported: false;
}

export interface ConnectorSourceSystem {
	readonly schema: typeof CLOUD_CONNECTOR_SOURCE_SYSTEM_SCHEMA;
	readonly trust: "host_metadata";
	readonly connectorId: string;
	readonly connectorVersion: string;
	readonly provider: string;
	readonly displayName: string;
	readonly state: "connected" | "authentication_required" | "revoked" | "available_for_connection";
	readonly account: {
		readonly connectionId: string;
		readonly connectionVersion: number;
		readonly providerAccountId: string;
		readonly owner: ConnectorCredentialOwner;
	} | null;
	readonly capabilities: readonly {
		readonly operationId: string;
		readonly operationVersion: string;
		readonly enabled: boolean;
		readonly authorization: "not_enabled" | "authorization_required" | "live_check_required";
		readonly capability: ConnectorSourceCapability;
	}[];
}

export interface ConnectorSourceSystemStatus {
	readonly state: "connected" | "authentication_required" | "revoked";
	readonly authorizations: readonly {
		readonly operationId: string;
		readonly state: "authorization_required" | "live_check_required";
	}[];
}

/**
 * Adapter to the existing current connection, membership, credential and grant
 * authority. It returns no handles or secrets and does not create another store.
 */
export interface ConnectorSourceSystemAuthority<I extends ConnectorRunIdentity> {
	status(
		options: {
			readonly identity: I;
			readonly audience: ConnectorJsonObject;
			readonly installation: ConnectorInstallation;
			readonly account: ConnectorAccountBinding;
			readonly operationIds: readonly string[];
		},
		signal: AbortSignal,
	): Promise<ConnectorSourceSystemStatus>;
}

export type ConnectorDecodedResponse =
	| { readonly kind: "data"; readonly data: JsonValue }
	| { readonly kind: "source"; readonly page: ConnectorSourcePage };

export type ConnectorFailureCode =
	| "invalid_arguments"
	| "unavailable"
	| "authority_denied"
	| "revoked"
	| "authorization_required"
	| "authentication_required"
	| "authentication_expired"
	| "rate_limited"
	| "provider_rejected"
	| "provider_unavailable"
	| "cancelled"
	| "timed_out"
	| "response_too_large"
	| "invalid_response"
	| "uncertain"
	| "receipt_unconfirmed";

export type ConnectorRetry =
	| { readonly kind: "never" }
	| { readonly kind: "authorize" }
	| { readonly kind: "reauthorize" }
	| { readonly kind: "after"; readonly delayMs: number }
	| { readonly kind: "reconcile" };

export interface ConnectorOutcome {
	readonly schema: typeof CLOUD_CONNECTOR_RESULT_SCHEMA;
	readonly status: "ok" | ConnectorFailureCode;
	readonly effect: "none" | "applied" | "uncertain";
	readonly retry: ConnectorRetry;
	readonly data?: JsonValue;
}

/** Static codes only: raw vault, transport and provider errors must never cross this boundary. */
export class ConnectorFailure extends Error {
	readonly code: ConnectorFailureCode;
	constructor(code: ConnectorFailureCode) {
		super(`Cloud connector: ${code}`);
		this.name = "ConnectorFailure";
		this.code = code;
	}
}

export function connectorFailure(
	code: ConnectorFailureCode,
	effect: ConnectorOutcome["effect"] = "none",
	retry?: ConnectorRetry,
): ConnectorOutcome {
	return {
		schema: CLOUD_CONNECTOR_RESULT_SCHEMA,
		status: code,
		effect,
		retry:
			effect === "uncertain"
				? { kind: "reconcile" }
				: (retry ??
					(code === "authorization_required"
						? { kind: "authorize" }
						: code === "authentication_required" || code === "authentication_expired"
							? { kind: "reauthorize" }
							: { kind: "never" })),
	};
}

export interface CloudConnectorAdapter {
	readonly manifest: CloudConnectorManifest;
	parseInput(operationId: string, value: JsonValue): ConnectorJsonObject;
	parseContinuation(operationId: string, value: JsonValue): ConnectorJsonObject;
	prepare(operationId: string, input: ConnectorJsonObject, cursor?: ConnectorJsonObject): ConnectorPreparedRequest;
	decode(
		operationId: string,
		value: JsonValue,
		request: ConnectorPreparedRequest,
		headers: Headers,
	): ConnectorDecodedResponse;
	/** Error bodies are bounded, validated JSON with credentials redacted; never return their raw text. */
	classifyFailure(
		status: number,
		headers: Headers,
		write: boolean,
		now: number,
		body: JsonValue | null,
	): ConnectorOutcome;
}

export interface ConnectorInvocation<I extends ConnectorRunIdentity> {
	readonly identity: I;
	readonly runtimeBundleVersion: string;
	readonly audience: ConnectorJsonObject;
	readonly installation: ConnectorInstallation;
	readonly account: ConnectorAccountBinding;
	readonly operation: ConnectorOperationDefinition;
	readonly nativeOperation: ConnectorNativeOperation;
	readonly request: ConnectorPreparedRequest;
	readonly continuation: {
		readonly scope: ConnectorContinuationScope;
		readonly handle: ConnectorContinuationHandle | null;
		readonly cursor: ConnectorJsonObject | null;
	} | null;
}

export interface ConnectorAuthority<I extends ConnectorRunIdentity> {
	/**
	 * Revalidate the FULL admitted run, membership, pinned Company File version,
	 * account owner, delegated grant, exact resource/destination/body/audience and
	 * required action approval. Dispatch/release must resolve the supplied receipt
	 * and downstream key to this exact unfinished effect in the existing ledger.
	 * Return no credentials. Missing authority must reject, never choose an account.
	 */
	assertAuthorized(
		invocation: ConnectorInvocation<I>,
		phase: "admission" | "dispatch" | "release",
		receipt: { readonly receiptId: string; readonly idempotencyKey: string } | undefined,
		signal: AbortSignal,
	): Promise<void>;
}

export interface ConnectorCredentialVault<I extends ConnectorRunIdentity> {
	/**
	 * Adapter to the existing cloud vault/credential bridge. Validate exact handle
	 * version, company/member ownership, connection, grant and run again. Supply a
	 * bearer only to this trusted RPC module, never to a model or Company File.
	 * Do not refresh/substitute another account. Invoke consume once, await it and
	 * stop on signal; a late callback cannot dispatch. No storage is implemented here.
	 */
	withBearer(
		invocation: ConnectorInvocation<I>,
		receipt: { readonly receiptId: string; readonly idempotencyKey: string },
		consume: (bearer: string) => Promise<void>,
		signal: AbortSignal,
	): Promise<void>;
}

export function connectorObject(value: unknown, keys?: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
		(keys && Object.keys(value).some((key) => !keys.includes(key)))
	)
		throw new ConnectorFailure("invalid_arguments");
	return value as Record<string, unknown>;
}

/** Bounded canonical JSON with no accessors, class instances, cycles, or non-JSON values. */
export function connectorJsonText(value: unknown, maximumBytes = 32 * 1024): string {
	let nodes = 0;
	let bytes = 0;
	const ancestors = new Set<object>();
	const account = (part: string): string => {
		bytes += Buffer.byteLength(part);
		if (bytes > maximumBytes) throw new ConnectorFailure("invalid_arguments");
		return part;
	};
	const encode = (item: unknown, depth: number): string => {
		if (++nodes > 10_000 || depth > 24) throw new ConnectorFailure("invalid_arguments");
		if (item === null || typeof item === "boolean" || typeof item === "string") return account(JSON.stringify(item));
		if (typeof item === "number" && Number.isFinite(item)) return account(JSON.stringify(item));
		if (!item || typeof item !== "object" || ancestors.has(item)) throw new ConnectorFailure("invalid_arguments");
		ancestors.add(item);
		try {
			const array = Array.isArray(item);
			if (!array) connectorObject(item);
			const keys = Object.keys(item);
			if (keys.length > 10_000 || (array && keys.length !== item.length))
				throw new ConnectorFailure("invalid_arguments");
			account(`${array ? "[]" : "{}"}${",".repeat(Math.max(0, keys.length - 1))}`);
			const entries = (array ? Array.from({ length: item.length }, (_, index) => String(index)) : keys.sort()).map(
				(key) => {
					const descriptor = Object.getOwnPropertyDescriptor(item, key);
					if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new ConnectorFailure("invalid_arguments");
					return `${array ? "" : account(`${JSON.stringify(key)}:`)}${encode(descriptor.value, depth + 1)}`;
				},
			);
			return array ? `[${entries.join(",")}]` : `{${entries.join(",")}}`;
		} finally {
			ancestors.delete(item);
		}
	};
	return encode(value, 0);
}

export function connectorDigest(value: unknown): string {
	return createHash("sha256")
		.update(connectorJsonText(value, 256 * 1024))
		.digest("hex");
}

/** Size accounting only; the existing native untrusted-data fence remains mandatory. */
export function connectorFencedContentBytes(value: unknown): number {
	const text = JSON.stringify(connectorJsonText(value)).replace(
		/[<>&\u2028\u2029]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	return Buffer.byteLength(text);
}

export function freezeConnectorValue<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeConnectorValue(child);
		Object.freeze(value);
	}
	return value;
}

/** Bound even a stalled integration port. Abort never proves that a dispatched write did not occur. */
export function connectorUntilAborted<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(new ConnectorFailure("cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			signal.removeEventListener("abort", abort);
			abort();
			return;
		}
		Promise.resolve()
			.then(() => {
				signal.throwIfAborted();
				return operation();
			})
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
