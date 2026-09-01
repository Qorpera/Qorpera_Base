import { createHash } from "node:crypto";
import {
	CLOUD_CONNECTOR_CONTINUATION_SCHEMA,
	CLOUD_CONNECTOR_SOURCE_INVENTORY_SCHEMA,
	CONNECTOR_HASH,
	CONNECTOR_ID,
	CONNECTOR_UUID,
	type ConnectorAccountBinding,
	type ConnectorContinuationHandle,
	type ConnectorContinuationScope,
	ConnectorFailure,
	type ConnectorInvocation,
	type ConnectorJsonObject,
	type ConnectorOperationDefinition,
	type ConnectorResolvedContinuation,
	type ConnectorRunIdentity,
	type ConnectorSourceInventory,
	type ConnectorSourcePage,
	type ConnectorSourceResource,
	connectorDigest,
	connectorJsonText,
	connectorObject,
	freezeConnectorValue,
} from "./cloud-connector-contract.ts";

const SOURCE_TEXT = /^[^\u0000-\u001f\u007f]{1,2048}$/;
const SOURCE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SOURCE_FIELD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

function sourceResource<I extends ConnectorRunIdentity>(
	value: ConnectorSourceResource,
	invocation: ConnectorInvocation<I>,
): ConnectorSourceResource {
	const input = connectorObject(value, [
		"providerResourceId",
		"kind",
		"label",
		"locator",
		"parent",
		"revision",
		"providerTimestamps",
		"accessibility",
		"followUpOperations",
		"metadata",
		"content",
	]);
	const capability = invocation.operation.sourceCapability;
	if (
		!capability ||
		typeof input.providerResourceId !== "string" ||
		!SOURCE_TEXT.test(input.providerResourceId) ||
		typeof input.label !== "string" ||
		!SOURCE_TEXT.test(input.label) ||
		typeof input.locator !== "string" ||
		!SOURCE_TEXT.test(input.locator) ||
		(input.kind !== "repository" && input.kind !== "directory" && input.kind !== "file") ||
		!capability.resourceKinds.includes(input.kind) ||
		(input.accessibility !== "metadata" &&
			input.accessibility !== "listable" &&
			input.accessibility !== "readable" &&
			input.accessibility !== "unsupported") ||
		!Array.isArray(input.followUpOperations) ||
		input.followUpOperations.length > 8 ||
		new Set(input.followUpOperations).size !== input.followUpOperations.length ||
		input.followUpOperations.some((operationId) => typeof operationId !== "string" || !CONNECTOR_ID.test(operationId))
	)
		throw new ConnectorFailure("invalid_response");
	const parentInput = input.parent === null ? null : connectorObject(input.parent, ["providerResourceId", "kind"]);
	if (
		parentInput !== null &&
		(typeof parentInput.providerResourceId !== "string" ||
			!SOURCE_TEXT.test(parentInput.providerResourceId) ||
			(parentInput.kind !== "repository" && parentInput.kind !== "directory"))
	)
		throw new ConnectorFailure("invalid_response");
	const revisionInput = connectorObject(input.revision, ["kind", "value", "stable"]);
	if (
		(revisionInput.kind !== "git_commit" &&
			revisionInput.kind !== "git_tree" &&
			revisionInput.kind !== "git_blob" &&
			revisionInput.kind !== "unavailable") ||
		typeof revisionInput.stable !== "boolean" ||
		(revisionInput.value !== null &&
			(typeof revisionInput.value !== "string" || !SOURCE_TEXT.test(revisionInput.value))) ||
		(revisionInput.stable && revisionInput.value === null) ||
		(revisionInput.kind !== "unavailable" &&
			revisionInput.value !== null &&
			!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(revisionInput.value)) ||
		(revisionInput.kind === "unavailable" && (revisionInput.value !== null || revisionInput.stable))
	)
		throw new ConnectorFailure("invalid_response");
	const timestampsInput = connectorObject(input.providerTimestamps);
	if (
		Object.keys(timestampsInput).length > 8 ||
		Object.entries(timestampsInput).some(
			([key, timestamp]) =>
				!SOURCE_FIELD.test(key) ||
				(timestamp !== null &&
					(typeof timestamp !== "string" ||
						!SOURCE_TIMESTAMP.test(timestamp) ||
						!Number.isFinite(Date.parse(timestamp)))),
		)
	)
		throw new ConnectorFailure("invalid_response");
	const metadata = JSON.parse(connectorJsonText(connectorObject(input.metadata), 2048)) as ConnectorJsonObject;
	const enabledFollowUps = input.followUpOperations.filter(
		(operationId): operationId is string =>
			typeof operationId === "string" &&
			invocation.installation.enabledOperations.includes(operationId) &&
			invocation.installation.manifest.operations.some(
				(operation) => operation.id === operationId && operation.sourceCapability !== null,
			),
	);
	let content: ConnectorSourceResource["content"];
	if (input.content !== undefined) {
		const contentInput = connectorObject(input.content, ["mediaType", "text", "bytes", "sha256"]);
		if (
			input.kind !== "file" ||
			contentInput.mediaType !== "text/plain; charset=utf-8" ||
			typeof contentInput.text !== "string" ||
			!Number.isSafeInteger(contentInput.bytes) ||
			(contentInput.bytes as number) !== Buffer.byteLength(contentInput.text) ||
			typeof contentInput.sha256 !== "string" ||
			!CONNECTOR_HASH.test(contentInput.sha256) ||
			contentInput.sha256 !== createHash("sha256").update(contentInput.text).digest("hex")
		)
			throw new ConnectorFailure("invalid_response");
		content = {
			mediaType: "text/plain; charset=utf-8",
			text: contentInput.text,
			bytes: contentInput.bytes as number,
			sha256: contentInput.sha256,
		};
	}
	return freezeConnectorValue({
		providerResourceId: input.providerResourceId,
		kind: input.kind,
		label: input.label,
		locator: input.locator,
		parent:
			parentInput === null
				? null
				: {
						providerResourceId: parentInput.providerResourceId as string,
						kind: parentInput.kind as "repository" | "directory",
					},
		revision: {
			kind: revisionInput.kind,
			value: revisionInput.value as string | null,
			stable: revisionInput.stable,
		},
		providerTimestamps: JSON.parse(connectorJsonText(timestampsInput)) as ConnectorJsonObject,
		accessibility: input.accessibility,
		followUpOperations: enabledFollowUps,
		metadata,
		...(content ? { content } : {}),
	});
}

export function connectorContinuationHandle(value: unknown): ConnectorContinuationHandle {
	const input = connectorObject(value, ["id", "version"]);
	if (
		typeof input.id !== "string" ||
		!CONNECTOR_UUID.test(input.id) ||
		!Number.isSafeInteger(input.version) ||
		(input.version as number) < 1
	)
		throw new ConnectorFailure("invalid_arguments");
	return Object.freeze({ id: input.id, version: input.version as number });
}

export function assertConnectorSourceAudience<I extends Pick<ConnectorRunIdentity, "companyId" | "requesterUserId">>(
	identity: I,
	audienceValue: ConnectorJsonObject,
	account: ConnectorAccountBinding,
): void {
	const audience = connectorObject(audienceValue, ["kind", "id"]);
	if (typeof audience.id !== "string" || !CONNECTOR_UUID.test(audience.id))
		throw new ConnectorFailure("authority_denied");
	if (account.owner.kind === "member") {
		if (
			account.owner.id !== identity.requesterUserId ||
			audience.kind !== "member" ||
			audience.id !== account.owner.id
		)
			throw new ConnectorFailure("authority_denied");
		return;
	}
	if (
		(audience.kind !== "company" || audience.id !== identity.companyId) &&
		(audience.kind !== "member" || audience.id !== identity.requesterUserId)
	)
		throw new ConnectorFailure("authority_denied");
}

export function createConnectorContinuationScope<I extends ConnectorRunIdentity>(options: {
	identity: I;
	runtimeBundleVersion: string;
	audience: ConnectorJsonObject;
	installation: ConnectorInvocation<I>["installation"];
	account: ConnectorAccountBinding;
	operation: ConnectorOperationDefinition;
	input: ConnectorJsonObject;
}): ConnectorContinuationScope {
	const { identity, installation, operation } = options;
	if (!operation.sourceCapability || operation.sourceCapability.pagination !== "host_continuation")
		throw new ConnectorFailure("invalid_arguments");
	assertConnectorSourceAudience(identity, options.audience, options.account);
	return freezeConnectorValue({
		schema: CLOUD_CONNECTOR_CONTINUATION_SCHEMA,
		identity: {
			companyId: identity.companyId,
			runId: identity.runId,
			staffAgentId: identity.staffAgentId,
			requesterUserId: identity.requesterUserId,
		},
		runtimeBundleVersion: options.runtimeBundleVersion,
		audience: structuredClone(options.audience),
		installation: structuredClone(installation.object),
		manifestSha256: connectorDigest(installation.manifest),
		connectorId: installation.manifest.id,
		connectorVersion: installation.manifest.version,
		implementation: structuredClone(installation.manifest.implementation),
		operationId: operation.id,
		operationVersion: operation.version,
		account: structuredClone(options.account),
		selectorSha256: connectorDigest(options.input),
	});
}

export function connectorContinuationScopeSha256(scope: ConnectorContinuationScope): string {
	return connectorDigest(scope);
}

export function parseResolvedConnectorContinuation(
	value: unknown,
	scope: ConnectorContinuationScope,
	handle: ConnectorContinuationHandle,
): ConnectorResolvedContinuation {
	const input = connectorObject(value, ["schema", "handle", "scopeSha256", "cursor"]);
	const returnedHandle = connectorContinuationHandle(input.handle);
	if (
		input.schema !== CLOUD_CONNECTOR_CONTINUATION_SCHEMA ||
		returnedHandle.id !== handle.id ||
		returnedHandle.version !== handle.version ||
		input.scopeSha256 !== connectorContinuationScopeSha256(scope) ||
		typeof input.scopeSha256 !== "string" ||
		!CONNECTOR_HASH.test(input.scopeSha256)
	)
		throw new ConnectorFailure("authority_denied");
	const cursor = JSON.parse(connectorJsonText(connectorObject(input.cursor))) as ConnectorJsonObject;
	return freezeConnectorValue({
		schema: CLOUD_CONNECTOR_CONTINUATION_SCHEMA,
		handle: returnedHandle,
		scopeSha256: input.scopeSha256,
		cursor,
	});
}

export function parseIssuedConnectorContinuation(
	value: unknown,
	scope: ConnectorContinuationScope,
): Omit<ConnectorResolvedContinuation, "cursor"> {
	const input = connectorObject(value, ["schema", "handle", "scopeSha256"]);
	const handle = connectorContinuationHandle(input.handle);
	if (
		input.schema !== CLOUD_CONNECTOR_CONTINUATION_SCHEMA ||
		input.scopeSha256 !== connectorContinuationScopeSha256(scope) ||
		typeof input.scopeSha256 !== "string" ||
		!CONNECTOR_HASH.test(input.scopeSha256)
	)
		throw new ConnectorFailure("authority_denied");
	return Object.freeze({
		schema: CLOUD_CONNECTOR_CONTINUATION_SCHEMA,
		handle,
		scopeSha256: input.scopeSha256,
	});
}

export function connectorSourceInventory<I extends ConnectorRunIdentity>(
	invocation: ConnectorInvocation<I>,
	page: ConnectorSourcePage,
	continuation: ConnectorContinuationHandle | null,
): ConnectorSourceInventory {
	const capability = invocation.operation.sourceCapability;
	if (!capability) throw new ConnectorFailure("invalid_response");
	assertConnectorSourceAudience(invocation.identity, invocation.audience, invocation.account);
	if (
		typeof page.complete !== "boolean" ||
		typeof page.truncated !== "boolean" ||
		!(["none", "item_limit", "byte_limit", "continuation_limit"] as const).includes(page.reason) ||
		(page.complete && page.truncated) ||
		page.truncated !== (page.reason !== "none") ||
		(page.complete && continuation !== null) ||
		(!page.complete && !page.truncated && continuation === null)
	)
		throw new ConnectorFailure("invalid_response");
	let resources: ConnectorSourceResource[];
	try {
		resources = page.resources.map((resource) => sourceResource(resource, invocation));
	} catch (error) {
		if (error instanceof ConnectorFailure && error.code === "invalid_arguments")
			throw new ConnectorFailure("invalid_response");
		throw error;
	}
	if (new Set(resources.map((resource) => resource.providerResourceId)).size !== resources.length)
		throw new ConnectorFailure("invalid_response");
	const normalizedPage = { ...page, resources };
	let pageBytes: number;
	try {
		pageBytes = Buffer.byteLength(connectorJsonText(normalizedPage));
	} catch {
		throw new ConnectorFailure("response_too_large");
	}
	if (resources.length > capability.maxItems || pageBytes > capability.maxOutputBytes)
		throw new ConnectorFailure("response_too_large");
	const memberPrivate = invocation.account.owner.kind === "member";
	const result: ConnectorSourceInventory = {
		schema: CLOUD_CONNECTOR_SOURCE_INVENTORY_SCHEMA,
		trust: "untrusted_data",
		provider: invocation.installation.manifest.provider,
		connector: {
			id: invocation.installation.manifest.id,
			version: invocation.installation.manifest.version,
			implementation: { ...invocation.installation.manifest.implementation },
		},
		account: {
			companyId: invocation.account.companyId,
			connectionId: invocation.account.connectionId,
			connectionVersion: invocation.account.connectionVersion,
			providerAccountId: invocation.account.providerAccountId,
			owner: invocation.account.owner,
			grant:
				invocation.account.grant === null
					? null
					: { id: invocation.account.grant.id, version: invocation.account.grant.version },
			credentialVersion: invocation.account.credential?.version ?? null,
		},
		requesterUserId: invocation.identity.requesterUserId,
		audience: structuredClone(invocation.audience),
		visibility: memberPrivate
			? { scope: "member_private", ownerId: invocation.account.owner.id }
			: { scope: "company_owned", companyId: invocation.identity.companyId },
		capability: {
			kind: capability.kind,
			operationId: invocation.operation.id,
			operationVersion: invocation.operation.version,
		},
		resources: structuredClone(resources),
		completeness: {
			complete: page.complete,
			truncated: page.truncated,
			reason: page.reason,
		},
		continuation: continuation ? { ...continuation } : null,
		publication: "requires_governed_company_file_operation",
		imported: false,
	};
	connectorJsonText(result, capability.maxOutputBytes + 4096);
	return freezeConnectorValue(result);
}
