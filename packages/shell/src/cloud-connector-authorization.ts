import { randomUUID } from "node:crypto";
import {
	CONNECTOR_HASH,
	CONNECTOR_ID,
	CONNECTOR_KEY,
	CONNECTOR_UUID,
	type ConnectorCompanyObject,
	type ConnectorCredentialOwner,
	type ConnectorJsonObject,
	type ConnectorRunIdentity,
	connectorDigest,
	connectorJsonText,
	connectorObject,
	connectorUntilAborted,
	freezeConnectorValue,
} from "./cloud-connector-contract.ts";

export const CONNECTOR_AUTHORIZATION_SCHEMA = "qorpera.connector-authorization/v2";
const REQUEST_TTL_MS = 10 * 60 * 1000;

export type ConnectorAuthorizationStatus = "pending" | "approved" | "declined" | "dismissed" | "expired" | "revoked";

/** Host-built scope. No model-selected principal and no OAuth code, token, password or secret handle. */
export interface ConnectorAuthorizationSpec<I extends ConnectorRunIdentity> {
	readonly identity: I;
	readonly purpose: "connect" | "authorize";
	readonly logicalOperationKey: string;
	readonly runtimeBundleVersion: string;
	readonly audience: ConnectorJsonObject;
	readonly installation: ConnectorCompanyObject;
	readonly connectorId: string;
	readonly operationId: string;
	readonly manifestSha256: string;
	readonly implementationSha256: string;
	readonly permission: string;
	readonly destination: string;
	readonly resource: ConnectorJsonObject;
	readonly connectionId: string | null;
	readonly connectionVersion: number | null;
	readonly credentialOwner: ConnectorCredentialOwner;
	readonly recipientMemberUserId: string;
}

export interface ConnectorAuthorizationKey {
	readonly companyId: string;
	readonly runId: string;
	readonly logicalOperationKey: string;
}

/** Resolved by the existing authenticated member endpoint, not deserialized from a response body. */
export interface ConnectorMemberSession {
	readonly companyId: string;
	readonly userId: string;
	readonly sessionId: string;
}

export interface ConnectorAuthorizationEvidence {
	readonly kind: "connector_authorization";
	readonly approvalId: string;
	readonly requestId: string;
	readonly companyId: string;
	readonly memberUserId: string;
	readonly scopeSha256: string;
	readonly policyVersion: number;
}

export interface ConnectorAuthorizationRequest<I extends ConnectorRunIdentity> {
	readonly schema: typeof CONNECTOR_AUTHORIZATION_SCHEMA;
	readonly id: string;
	readonly spec: ConnectorAuthorizationSpec<I>;
	readonly scopeSha256: string;
	readonly revision: number;
	readonly status: ConnectorAuthorizationStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly expiresAt: number;
	readonly approval: ConnectorAuthorizationEvidence | null;
}

/**
 * All methods are REQUIRED live checks inside the existing control-plane
 * transaction. Merely constructing a member/session/spec/evidence object is
 * not authentication. No filesystem, transcript reconstruction or new store.
 */
export interface ConnectorAuthorizationTransaction<I extends ConnectorRunIdentity> {
	readonly current: ConnectorAuthorizationRequest<I> | undefined;
	/** Fresh authoritative time; the adapter must also recheck expiry at commit. */
	readonly now: number;
	assertRequestAllowed(spec: ConnectorAuthorizationSpec<I>, signal: AbortSignal): Promise<void>;
	assertMember(
		member: ConnectorMemberSession,
		request: ConnectorAuthorizationRequest<I>,
		signal: AbortSignal,
	): Promise<void>;
	approve(
		member: ConnectorMemberSession,
		request: ConnectorAuthorizationRequest<I>,
		signal: AbortSignal,
	): Promise<ConnectorAuthorizationEvidence>;
	/** Fence the exact connector grant atomically with the revoked projection. This is not a vault delete. */
	revoke(
		member: ConnectorMemberSession,
		request: ConnectorAuthorizationRequest<I>,
		signal: AbortSignal,
	): Promise<void>;
	assertExpiryAllowed(request: ConnectorAuthorizationRequest<I>, signal: AbortSignal): Promise<void>;
}

export interface ConnectorAuthorizationStore<I extends ConnectorRunIdentity> {
	/**
	 * Lock/uniquely key by (company, run, logical operation), read current state,
	 * and atomically persist the transition, approval/revocation and existing
	 * interaction journal. Roll back on throw/abort; recheck at commit. The journal
	 * is consumed by the existing wake path, not a new connector event queue.
	 */
	transact(
		key: ConnectorAuthorizationKey,
		transition: (transaction: ConnectorAuthorizationTransaction<I>) => Promise<ConnectorAuthorizationRequest<I>>,
		signal: AbortSignal,
	): Promise<ConnectorAuthorizationRequest<I>>;
}

export type ConnectorAuthorizationRejection =
	| "invalid_request"
	| "denied"
	| "not_found"
	| "wrong_member"
	| "stale"
	| "duplicate"
	| "expired";

export class ConnectorAuthorizationError extends Error {
	readonly reason: ConnectorAuthorizationRejection;
	constructor(reason: ConnectorAuthorizationRejection) {
		super(`Connector authorization: ${reason}`);
		this.name = "ConnectorAuthorizationError";
		this.reason = reason;
	}
}

function assertKey(key: ConnectorAuthorizationKey): void {
	connectorObject(key, ["companyId", "runId", "logicalOperationKey"]);
	if (
		!CONNECTOR_UUID.test(key.companyId) ||
		!CONNECTOR_UUID.test(key.runId) ||
		!CONNECTOR_KEY.test(key.logicalOperationKey)
	)
		throw new ConnectorAuthorizationError("invalid_request");
}

function assertScope<I extends ConnectorRunIdentity>(spec: ConnectorAuthorizationSpec<I>): void {
	connectorJsonText(spec);
	connectorObject(spec, [
		"identity",
		"purpose",
		"logicalOperationKey",
		"runtimeBundleVersion",
		"audience",
		"installation",
		"connectorId",
		"operationId",
		"manifestSha256",
		"implementationSha256",
		"permission",
		"destination",
		"resource",
		"connectionId",
		"connectionVersion",
		"credentialOwner",
		"recipientMemberUserId",
	]);
	connectorObject(spec.credentialOwner, ["kind", "id"]);
	connectorObject(spec.installation, [
		"companyFileId",
		"objectId",
		"logicalPath",
		"objectVersion",
		"ownerPrincipalId",
		"policyClass",
	]);
	assertKey({
		companyId: spec.identity.companyId,
		runId: spec.identity.runId,
		logicalOperationKey: spec.logicalOperationKey,
	});
	if (
		[
			spec.identity.staffAgentId,
			spec.identity.requesterUserId,
			spec.recipientMemberUserId,
			spec.credentialOwner.id,
			spec.installation.companyFileId,
			spec.installation.objectId,
			spec.installation.ownerPrincipalId,
		].some((id) => !CONNECTOR_UUID.test(id)) ||
		(spec.purpose !== "connect" && spec.purpose !== "authorize") ||
		(spec.purpose === "connect" && (spec.connectionId !== null || spec.connectionVersion !== null)) ||
		(spec.purpose === "authorize" &&
			(typeof spec.connectionId !== "string" ||
				!CONNECTOR_UUID.test(spec.connectionId) ||
				!Number.isSafeInteger(spec.connectionVersion) ||
				(spec.connectionVersion as number) < 1)) ||
		!CONNECTOR_ID.test(spec.connectorId) ||
		!CONNECTOR_ID.test(spec.operationId) ||
		!CONNECTOR_HASH.test(spec.manifestSha256) ||
		!CONNECTOR_HASH.test(spec.implementationSha256) ||
		!spec.runtimeBundleVersion ||
		!spec.permission ||
		!spec.installation.objectVersion ||
		!spec.installation.policyClass ||
		spec.installation.logicalPath !== `connectors/${spec.connectorId}/manifest.json` ||
		Object.keys(connectorObject(spec.audience)).length === 0 ||
		Object.keys(connectorObject(spec.resource)).length === 0 ||
		(spec.credentialOwner.kind !== "member" && spec.credentialOwner.kind !== "company") ||
		(spec.credentialOwner.kind === "member" && spec.credentialOwner.id !== spec.recipientMemberUserId) ||
		(spec.credentialOwner.kind === "company" && spec.credentialOwner.id !== spec.identity.companyId)
	)
		throw new ConnectorAuthorizationError("invalid_request");
	let destination: URL;
	try {
		destination = new URL(spec.destination);
	} catch {
		throw new ConnectorAuthorizationError("invalid_request");
	}
	if (
		destination.protocol !== "https:" ||
		destination.origin !== spec.destination ||
		destination.username ||
		destination.password
	)
		throw new ConnectorAuthorizationError("invalid_request");
}

function currentRequest<I extends ConnectorRunIdentity>(
	transaction: ConnectorAuthorizationTransaction<I>,
	key: ConnectorAuthorizationKey,
): ConnectorAuthorizationRequest<I> {
	const current = transaction.current;
	if (!current) throw new ConnectorAuthorizationError("not_found");
	connectorJsonText(current);
	connectorObject(current, [
		"schema",
		"id",
		"spec",
		"scopeSha256",
		"revision",
		"status",
		"createdAt",
		"updatedAt",
		"expiresAt",
		"approval",
	]);
	assertScope(current.spec);
	if (
		current.schema !== CONNECTOR_AUTHORIZATION_SCHEMA ||
		!CONNECTOR_UUID.test(current.id) ||
		!Number.isSafeInteger(current.revision) ||
		current.revision < 1 ||
		!["pending", "approved", "declined", "dismissed", "expired", "revoked"].includes(current.status) ||
		current.spec.identity.companyId !== key.companyId ||
		current.spec.identity.runId !== key.runId ||
		current.spec.logicalOperationKey !== key.logicalOperationKey ||
		current.scopeSha256 !== connectorDigest(current.spec) ||
		![current.createdAt, current.updatedAt, current.expiresAt, transaction.now].every(Number.isSafeInteger) ||
		transaction.now < current.updatedAt ||
		current.updatedAt < current.createdAt ||
		current.createdAt < 0 ||
		current.expiresAt <= current.createdAt ||
		current.expiresAt - current.createdAt > REQUEST_TTL_MS
	)
		throw new ConnectorAuthorizationError("invalid_request");
	if (current.approval !== null) {
		if (current.status !== "approved" && current.status !== "revoked")
			throw new ConnectorAuthorizationError("invalid_request");
		assertEvidence(current.approval, current);
	} else if (current.status === "approved") throw new ConnectorAuthorizationError("invalid_request");
	return current;
}

function assertEvidence<I extends ConnectorRunIdentity>(
	approval: ConnectorAuthorizationEvidence,
	request: ConnectorAuthorizationRequest<I>,
): void {
	connectorObject(approval, [
		"kind",
		"approvalId",
		"requestId",
		"companyId",
		"memberUserId",
		"scopeSha256",
		"policyVersion",
	]);
	if (
		approval.kind !== "connector_authorization" ||
		!CONNECTOR_UUID.test(approval.approvalId) ||
		approval.requestId !== request.id ||
		approval.companyId !== request.spec.identity.companyId ||
		approval.memberUserId !== request.spec.recipientMemberUserId ||
		approval.scopeSha256 !== request.scopeSha256 ||
		!Number.isSafeInteger(approval.policyVersion) ||
		approval.policyVersion < 1
	)
		throw new ConnectorAuthorizationError("denied");
}

function assertMemberShape(member: ConnectorMemberSession, companyId: string): void {
	connectorObject(member, ["companyId", "userId", "sessionId"]);
	if (member.companyId !== companyId || !CONNECTOR_UUID.test(member.userId) || !CONNECTOR_UUID.test(member.sessionId))
		throw new ConnectorAuthorizationError("wrong_member");
}

function response(value: unknown): {
	requestId: string;
	expectedRevision: number;
	decision: "approve" | "decline" | "dismiss";
} {
	const input = connectorObject(value, ["requestId", "expectedRevision", "decision"]);
	if (
		typeof input.requestId !== "string" ||
		!CONNECTOR_UUID.test(input.requestId) ||
		!Number.isSafeInteger(input.expectedRevision) ||
		(input.expectedRevision as number) < 1 ||
		(input.decision !== "approve" && input.decision !== "decline" && input.decision !== "dismiss")
	)
		throw new ConnectorAuthorizationError("invalid_request");
	return { requestId: input.requestId, expectedRevision: input.expectedRevision as number, decision: input.decision };
}

/** Connector-specific lifecycle only. Approval does NOT authenticate a provider or grant an external write. */
export class CloudConnectorAuthorizations<I extends ConnectorRunIdentity> {
	readonly #store: ConnectorAuthorizationStore<I>;

	constructor(store: ConnectorAuthorizationStore<I>) {
		if (typeof store?.transact !== "function") throw new ConnectorAuthorizationError("denied");
		this.#store = store;
	}

	async #transaction(
		key: ConnectorAuthorizationKey,
		signal: AbortSignal,
		transition: (
			transaction: ConnectorAuthorizationTransaction<I>,
			signal: AbortSignal,
		) => Promise<ConnectorAuthorizationRequest<I>>,
	): Promise<ConnectorAuthorizationRequest<I>> {
		assertKey(key);
		const deadline = new AbortController();
		const combined = AbortSignal.any([signal, deadline.signal]);
		const timer = setTimeout(() => deadline.abort(), 5000);
		try {
			return await connectorUntilAborted(
				() =>
					this.#store.transact(
						key,
						async (transaction) => {
							combined.throwIfAborted();
							if (!Number.isSafeInteger(transaction.now) || transaction.now < 0)
								throw new ConnectorAuthorizationError("invalid_request");
							const next = await transition(transaction, combined);
							combined.throwIfAborted();
							return freezeConnectorValue(structuredClone(next));
						},
						combined,
					),
				combined,
			);
		} catch (error) {
			throw error instanceof ConnectorAuthorizationError ? error : new ConnectorAuthorizationError("denied");
		} finally {
			clearTimeout(timer);
			deadline.abort();
		}
	}

	request(specValue: ConnectorAuthorizationSpec<I>, signal: AbortSignal): Promise<ConnectorAuthorizationRequest<I>> {
		assertScope(specValue);
		const spec = freezeConnectorValue(structuredClone(specValue));
		const key = {
			companyId: spec.identity.companyId,
			runId: spec.identity.runId,
			logicalOperationKey: spec.logicalOperationKey,
		};
		return this.#transaction(key, signal, async (transaction, checkSignal) => {
			await transaction.assertRequestAllowed(spec, checkSignal);
			if (transaction.current) {
				const current = currentRequest(transaction, key);
				if (current.scopeSha256 !== connectorDigest(spec)) throw new ConnectorAuthorizationError("stale");
				// Exact duplicate requests reuse one interaction; terminal requests never reopen.
				if (current.status === "pending" && transaction.now >= current.expiresAt)
					return { ...current, status: "expired", revision: current.revision + 1, updatedAt: transaction.now };
				return current;
			}
			return {
				schema: CONNECTOR_AUTHORIZATION_SCHEMA,
				id: randomUUID(),
				spec,
				scopeSha256: connectorDigest(spec),
				revision: 1,
				status: "pending",
				createdAt: transaction.now,
				updatedAt: transaction.now,
				expiresAt: transaction.now + REQUEST_TTL_MS,
				approval: null,
			};
		});
	}

	async respond(
		key: ConnectorAuthorizationKey,
		value: unknown,
		member: ConnectorMemberSession,
		signal: AbortSignal,
	): Promise<{ accepted: boolean; request: ConnectorAuthorizationRequest<I> }> {
		const input = response(value);
		assertMemberShape(member, key.companyId);
		const request = await this.#transaction(key, signal, async (transaction, checkSignal) => {
			const current = currentRequest(transaction, key);
			if (member.userId !== current.spec.recipientMemberUserId)
				throw new ConnectorAuthorizationError("wrong_member");
			await transaction.assertMember(member, current, checkSignal);
			if (input.requestId !== current.id || input.expectedRevision !== current.revision)
				throw new ConnectorAuthorizationError("stale");
			if (current.status !== "pending") throw new ConnectorAuthorizationError("duplicate");
			if (transaction.now >= current.expiresAt)
				return { ...current, status: "expired", revision: current.revision + 1, updatedAt: transaction.now };
			let approval: ConnectorAuthorizationEvidence | null = null;
			if (input.decision === "approve") {
				approval = await transaction.approve(member, current, checkSignal);
				assertEvidence(approval, current);
				// Throw so the existing transaction rolls back any provisional consent.
				if (transaction.now >= current.expiresAt) throw new ConnectorAuthorizationError("expired");
			}
			return {
				...current,
				status: input.decision === "approve" ? "approved" : input.decision === "decline" ? "declined" : "dismissed",
				approval,
				revision: current.revision + 1,
				updatedAt: transaction.now,
			};
		});
		return { accepted: request.status !== "expired", request };
	}

	revoke(
		key: ConnectorAuthorizationKey,
		requestId: string,
		expectedRevision: number,
		member: ConnectorMemberSession,
		signal: AbortSignal,
	): Promise<ConnectorAuthorizationRequest<I>> {
		assertMemberShape(member, key.companyId);
		return this.#transaction(key, signal, async (transaction, checkSignal) => {
			const current = currentRequest(transaction, key);
			if (requestId !== current.id || expectedRevision !== current.revision)
				throw new ConnectorAuthorizationError("stale");
			if (current.status !== "pending" && current.status !== "approved")
				throw new ConnectorAuthorizationError("duplicate");
			await transaction.assertMember(member, current, checkSignal);
			await transaction.revoke(member, current, checkSignal);
			return { ...current, status: "revoked", revision: current.revision + 1, updatedAt: transaction.now };
		});
	}

	expire(key: ConnectorAuthorizationKey, signal: AbortSignal): Promise<ConnectorAuthorizationRequest<I>> {
		return this.#transaction(key, signal, async (transaction, checkSignal) => {
			const current = currentRequest(transaction, key);
			await transaction.assertExpiryAllowed(current, checkSignal);
			if (current.status !== "pending" || transaction.now < current.expiresAt) return current;
			return { ...current, status: "expired", revision: current.revision + 1, updatedAt: transaction.now };
		});
	}
}

/** Send through the existing authorized typed-interaction mouth. Never render a vault URL or OAuth state. */
export function projectConnectorAuthorization<I extends ConnectorRunIdentity>(
	request: ConnectorAuthorizationRequest<I>,
): ConnectorJsonObject {
	return {
		schema: CONNECTOR_AUTHORIZATION_SCHEMA,
		kind: "connector_authorization",
		requestId: request.id,
		revision: request.revision,
		status: request.status,
		connectorId: request.spec.connectorId,
		operationId: request.spec.operationId,
		purpose: request.spec.purpose,
		permission: request.spec.permission,
		destination: request.spec.destination,
		resource: structuredClone(request.spec.resource),
		audience: structuredClone(request.spec.audience),
		scopeSha256: request.scopeSha256,
		approvalScope: "connector_access_only",
		credentialOwner: { ...request.spec.credentialOwner },
		expiresAt: request.expiresAt,
		authentication: "out_of_band_required",
	};
}
