import type { JsonValue } from "@qorpera/contracts";
import {
	CLOUD_CONNECTOR_SCHEMA,
	CLOUD_CONNECTOR_SOURCE_CAPABILITY_SCHEMA,
	CLOUD_CONNECTOR_SOURCE_SYSTEM_SCHEMA,
	type CloudConnectorAdapter,
	CONNECTOR_HASH,
	CONNECTOR_ID,
	CONNECTOR_KEY,
	CONNECTOR_MAX_DURATION_MS,
	CONNECTOR_MAX_RESPONSE_BYTES,
	CONNECTOR_UUID,
	type ConnectorAccountBinding,
	type ConnectorContinuationHandle,
	ConnectorFailure,
	type ConnectorInstallation,
	type ConnectorJsonObject,
	type ConnectorOperationDefinition,
	type ConnectorPreparedRequest,
	type ConnectorRunIdentity,
	type ConnectorSourceCapability,
	type ConnectorSourceSystem,
	type ConnectorSourceSystemAuthority,
	type ConnectorSourceSystemStatus,
	connectorJsonText,
	connectorObject,
	freezeConnectorValue,
} from "./cloud-connector-contract.ts";
import { assertConnectorSourceAudience, connectorContinuationHandle } from "./cloud-connector-source.ts";

export interface ConnectorCatalogEntry {
	readonly installation: ConnectorInstallation;
	readonly account: ConnectorAccountBinding;
	readonly adapter: CloudConnectorAdapter;
}

export interface ConnectorCall {
	readonly connectorId: string;
	readonly operationId: string;
	readonly logicalOperationKey: string;
	readonly input: ConnectorJsonObject;
	readonly continuation: ConnectorContinuationHandle | null;
}

function uuid(value: unknown): value is string {
	return typeof value === "string" && CONNECTOR_UUID.test(value);
}

function version(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function label(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}

function accountBinding(value: unknown, companyId: string): ConnectorAccountBinding {
	const input = connectorObject(value, [
		"companyId",
		"connectionId",
		"connectionVersion",
		"providerAccountId",
		"owner",
		"credential",
		"grant",
	]);
	const owner = connectorObject(input.owner, ["kind", "id"]);
	const credential = input.credential === null ? null : connectorObject(input.credential, ["id", "version"]);
	const grant = input.grant === null ? null : connectorObject(input.grant, ["id", "version", "approverUserId"]);
	if (
		input.companyId !== companyId ||
		!uuid(input.connectionId) ||
		!version(input.connectionVersion) ||
		!label(input.providerAccountId) ||
		(owner.kind !== "member" && owner.kind !== "company") ||
		!uuid(owner.id) ||
		(owner.kind === "company" && owner.id !== companyId) ||
		(credential !== null && (!uuid(credential.id) || !version(credential.version))) ||
		(grant !== null &&
			(!uuid(grant.id) || !version(grant.version) || (grant.approverUserId !== null && !uuid(grant.approverUserId))))
	)
		throw new ConnectorFailure("authority_denied");
	return JSON.parse(connectorJsonText(input)) as ConnectorAccountBinding;
}

/** Catalog input must come from the governed Company File read set, not a local directory scan. */
export class CloudConnectorCatalog {
	readonly #entries = new Map<string, ConnectorCatalogEntry>();
	readonly #implementations = new Map<string, CloudConnectorAdapter>();

	constructor(
		registrations: readonly { readonly installation: unknown; readonly account: unknown }[],
		adapters: readonly CloudConnectorAdapter[],
	) {
		if (registrations.length > 16 || adapters.length > 16) throw new ConnectorFailure("unavailable");
		const implementations = new Map<string, CloudConnectorAdapter>();
		for (const adapter of adapters) {
			const manifest = adapter.manifest;
			connectorObject(manifest, [
				"schema",
				"id",
				"version",
				"displayName",
				"provider",
				"implementation",
				"destinations",
				"authentication",
				"authorizationSurface",
				"operations",
			]);
			connectorObject(manifest.implementation, ["id", "version", "sha256"]);
			connectorJsonText(manifest);
			const invalidCapability = manifest.operations.some((operation) => {
				connectorObject(operation, [
					"id",
					"version",
					"description",
					"access",
					"effect",
					"permission",
					"inputSchema",
					"receipt",
					"retry",
					"reconciliation",
					"approval",
					"resultTrust",
					"timeoutMs",
					"maxResponseBytes",
					"sourceCapability",
				]);
				if (operation.sourceCapability === null) return false;
				const capability = connectorObject(operation.sourceCapability, [
					"schema",
					"kind",
					"resourceKinds",
					"pagination",
					"maxItems",
					"maxOutputBytes",
					"maxDepth",
					"maxRequests",
					"maxContinuationSteps",
				]);
				return (
					capability.schema !== CLOUD_CONNECTOR_SOURCE_CAPABILITY_SCHEMA ||
					!["source_inventory", "container_listing", "metadata_retrieval", "content_retrieval"].includes(
						capability.kind as string,
					) ||
					!Array.isArray(capability.resourceKinds) ||
					capability.resourceKinds.length === 0 ||
					new Set(capability.resourceKinds).size !== capability.resourceKinds.length ||
					capability.resourceKinds.some((kind) => !["repository", "directory", "file"].includes(kind)) ||
					(capability.pagination !== "none" && capability.pagination !== "host_continuation") ||
					!Number.isSafeInteger(capability.maxItems) ||
					(capability.maxItems as number) < 1 ||
					(capability.maxItems as number) > 32 ||
					!Number.isSafeInteger(capability.maxOutputBytes) ||
					(capability.maxOutputBytes as number) < 512 ||
					(capability.maxOutputBytes as number) > 4096 ||
					!Number.isSafeInteger(capability.maxDepth) ||
					(capability.maxDepth as number) < 0 ||
					(capability.maxDepth as number) > 16 ||
					capability.maxRequests !== 1 ||
					!Number.isSafeInteger(capability.maxContinuationSteps) ||
					(capability.pagination === "none" && capability.maxContinuationSteps !== 0) ||
					(capability.pagination === "host_continuation" &&
						((capability.maxContinuationSteps as number) < 2 ||
							(capability.maxContinuationSteps as number) > 10)) ||
					operation.access !== "read" ||
					operation.effect !== "none" ||
					operation.retry !== "read_after_reauthorization" ||
					operation.approval !== "live_grant" ||
					operation.receipt !== "run_operation" ||
					operation.reconciliation !== "none" ||
					operation.resultTrust !== "untrusted_data"
				);
			});
			if (
				manifest.schema !== CLOUD_CONNECTOR_SCHEMA ||
				!CONNECTOR_ID.test(manifest.id) ||
				implementations.has(manifest.id) ||
				!label(manifest.version) ||
				typeof manifest.displayName !== "string" ||
				!manifest.displayName.trim() ||
				Buffer.byteLength(manifest.displayName) > 160 ||
				!CONNECTOR_ID.test(manifest.provider) ||
				!CONNECTOR_ID.test(manifest.implementation.id) ||
				!label(manifest.implementation.version) ||
				!CONNECTOR_HASH.test(manifest.implementation.sha256) ||
				manifest.authentication !== "out_of_band_bearer" ||
				manifest.authorizationSurface !== "connector_authorization" ||
				typeof adapter.parseInput !== "function" ||
				typeof adapter.parseContinuation !== "function" ||
				typeof adapter.prepare !== "function" ||
				typeof adapter.decode !== "function" ||
				typeof adapter.classifyFailure !== "function" ||
				manifest.operations.length === 0 ||
				manifest.operations.length > 16 ||
				new Set(manifest.operations.map((operation) => operation.id)).size !== manifest.operations.length ||
				manifest.operations.some(
					(operation) =>
						!CONNECTOR_ID.test(operation.id) ||
						!label(operation.version) ||
						typeof operation.description !== "string" ||
						!operation.description.trim() ||
						Buffer.byteLength(operation.description) > 2048 ||
						!label(operation.permission) ||
						(operation.access !== "read" && operation.access !== "write") ||
						(operation.effect !== "none" &&
							operation.effect !== "external" &&
							operation.effect !== "destructive") ||
						operation.inputSchema.type !== "object" ||
						operation.inputSchema.additionalProperties !== false ||
						!Number.isSafeInteger(operation.timeoutMs) ||
						operation.timeoutMs < 1 ||
						operation.timeoutMs > CONNECTOR_MAX_DURATION_MS ||
						!Number.isSafeInteger(operation.maxResponseBytes) ||
						operation.maxResponseBytes < 1 ||
						operation.maxResponseBytes > CONNECTOR_MAX_RESPONSE_BYTES ||
						(operation.access === "read" && operation.effect !== "none") ||
						(operation.access === "write" && operation.effect === "none") ||
						operation.receipt !== "run_operation" ||
						operation.reconciliation !== "none" ||
						operation.resultTrust !== "untrusted_data" ||
						(operation.access === "read" &&
							(operation.retry !== "read_after_reauthorization" || operation.approval !== "live_grant")) ||
						(operation.access === "write" &&
							(operation.retry !== "never_automatically" || operation.approval !== "action_grant")),
				) ||
				invalidCapability ||
				manifest.destinations.length === 0 ||
				manifest.destinations.some((origin) => {
					try {
						if (typeof origin !== "string") return true;
						const url = new URL(origin);
						return (
							url.protocol !== "https:" ||
							url.origin !== origin ||
							url.username !== "" ||
							url.password !== "" ||
							url.hostname.includes("*")
						);
					} catch {
						return true;
					}
				})
			)
				throw new ConnectorFailure("unavailable");
			implementations.set(
				manifest.id,
				Object.freeze({ ...adapter, manifest: freezeConnectorValue(structuredClone(manifest)) }),
			);
		}
		for (const [id, adapter] of implementations) this.#implementations.set(id, adapter);
		for (const registration of registrations) {
			const input = connectorObject(JSON.parse(connectorJsonText(registration.installation)), [
				"companyId",
				"object",
				"manifest",
				"enabledOperations",
			]);
			const definition = connectorObject(input.manifest);
			const adapter = implementations.get(typeof definition.id === "string" ? definition.id : "");
			// An installed manifest cannot redefine a compiled adapter's operations, permissions,
			// destinations, schemas, effect classification, implementation hash or limits.
			if (!adapter || connectorJsonText(definition) !== connectorJsonText(adapter.manifest))
				throw new ConnectorFailure("unavailable");
			const object = connectorObject(input.object, [
				"companyFileId",
				"objectId",
				"logicalPath",
				"objectVersion",
				"ownerPrincipalId",
				"policyClass",
			]);
			if (
				!uuid(input.companyId) ||
				!uuid(object.companyFileId) ||
				!uuid(object.objectId) ||
				!uuid(object.ownerPrincipalId) ||
				object.logicalPath !== `connectors/${adapter.manifest.id}/manifest.json` ||
				!label(object.objectVersion) ||
				!label(object.policyClass) ||
				!Array.isArray(input.enabledOperations) ||
				input.enabledOperations.length === 0 ||
				new Set(input.enabledOperations).size !== input.enabledOperations.length ||
				input.enabledOperations.some(
					(id) => !adapter.manifest.operations.some((operation) => operation.id === id),
				) ||
				this.#entries.has(adapter.manifest.id)
			)
				throw new ConnectorFailure("unavailable");
			const account = accountBinding(registration.account, input.companyId);
			const installation = JSON.parse(connectorJsonText(input)) as ConnectorInstallation;
			this.#entries.set(adapter.manifest.id, freezeConnectorValue({ installation, account, adapter }));
		}
	}

	get(
		connectorId: string,
		operationId: string,
	): { entry: ConnectorCatalogEntry; operation: ConnectorOperationDefinition } {
		const entry = this.#entries.get(connectorId);
		const operation = entry?.installation.manifest.operations.find((candidate) => candidate.id === operationId);
		if (!entry || !operation || !entry.installation.enabledOperations.includes(operationId))
			throw new ConnectorFailure("unavailable");
		return { entry, operation };
	}

	get requiresContinuations(): boolean {
		for (const { installation } of this.#entries.values()) {
			if (
				installation.manifest.operations.some(
					(operation) =>
						installation.enabledOperations.includes(operation.id) &&
						operation.sourceCapability?.pagination === "host_continuation",
				)
			)
				return true;
		}
		return false;
	}

	parseCall(value: JsonValue): ConnectorCall {
		const input = connectorObject(JSON.parse(connectorJsonText(value)), [
			"connectorId",
			"operationId",
			"logicalOperationKey",
			"input",
			"continuation",
		]);
		if (
			typeof input.connectorId !== "string" ||
			typeof input.operationId !== "string" ||
			typeof input.logicalOperationKey !== "string" ||
			!CONNECTOR_KEY.test(input.logicalOperationKey)
		)
			throw new ConnectorFailure("invalid_arguments");
		const { entry, operation } = this.get(input.connectorId, input.operationId);
		const continuation =
			input.continuation === undefined || input.continuation === null
				? null
				: connectorContinuationHandle(input.continuation);
		if (
			continuation &&
			(!operation.sourceCapability || operation.sourceCapability.pagination !== "host_continuation")
		)
			throw new ConnectorFailure("invalid_arguments");
		const parsed = entry.adapter.parseInput(input.operationId, input.input as JsonValue);
		return freezeConnectorValue({
			connectorId: input.connectorId,
			operationId: input.operationId,
			logicalOperationKey: input.logicalOperationKey,
			input: parsed,
			continuation,
		});
	}

	async sourceSystems<I extends ConnectorRunIdentity>(
		identity: I,
		audience: ConnectorJsonObject,
		authority: ConnectorSourceSystemAuthority<I>,
		signal: AbortSignal,
	): Promise<readonly ConnectorSourceSystem[]> {
		if (typeof authority?.status !== "function") throw new ConnectorFailure("unavailable");
		const systems: ConnectorSourceSystem[] = [];
		for (const [connectorId, adapter] of this.#implementations) {
			signal.throwIfAborted();
			const sourceOperations = adapter.manifest.operations.filter(
				(
					operation,
				): operation is ConnectorOperationDefinition & { readonly sourceCapability: ConnectorSourceCapability } =>
					operation.sourceCapability !== null,
			);
			if (sourceOperations.length === 0) continue;
			const entry = this.#entries.get(connectorId);
			let visibleEntry = entry;
			if (visibleEntry) {
				try {
					assertConnectorSourceAudience(identity, audience, visibleEntry.account);
				} catch {
					visibleEntry = undefined;
				}
			}
			const visibleInstallation = visibleEntry?.installation;
			const enabled = visibleInstallation
				? sourceOperations.filter((operation) => visibleInstallation.enabledOperations.includes(operation.id))
				: [];
			let status: ConnectorSourceSystemStatus | undefined;
			if (visibleEntry) {
				try {
					const statusInput = connectorObject(
						JSON.parse(
							connectorJsonText(
								await authority.status(
									{
										identity,
										audience,
										installation: visibleEntry.installation,
										account: visibleEntry.account,
										operationIds: enabled.map((operation) => operation.id),
									},
									signal,
								),
								4096,
							),
						),
						["state", "authorizations"],
					);
					if (!Array.isArray(statusInput.authorizations)) throw new ConnectorFailure("unavailable");
					const authorizations = statusInput.authorizations.map((value) => {
						const authorization = connectorObject(value, ["operationId", "state"]);
						if (
							typeof authorization.operationId !== "string" ||
							!enabled.some((operation) => operation.id === authorization.operationId) ||
							(authorization.state !== "authorization_required" && authorization.state !== "live_check_required")
						)
							throw new ConnectorFailure("unavailable");
						return {
							operationId: authorization.operationId,
							state: authorization.state,
						} as const;
					});
					if (
						(statusInput.state !== "connected" &&
							statusInput.state !== "authentication_required" &&
							statusInput.state !== "revoked") ||
						authorizations.length !== enabled.length ||
						new Set(authorizations.map((authorization) => authorization.operationId)).size !==
							authorizations.length ||
						(statusInput.state === "connected" && visibleEntry.account.credential === null) ||
						authorizations.some(
							(authorization) =>
								authorization.state === "live_check_required" && visibleEntry.account.grant === null,
						)
					)
						throw new ConnectorFailure("unavailable");
					status = freezeConnectorValue({ state: statusInput.state, authorizations });
				} catch (error) {
					if (error instanceof ConnectorFailure && error.code !== "invalid_arguments") throw error;
					throw new ConnectorFailure("unavailable");
				}
			}
			const system: ConnectorSourceSystem = {
				schema: CLOUD_CONNECTOR_SOURCE_SYSTEM_SCHEMA,
				trust: "host_metadata",
				connectorId,
				connectorVersion: adapter.manifest.version,
				provider: adapter.manifest.provider,
				displayName: adapter.manifest.displayName,
				state: status?.state ?? "available_for_connection",
				account: visibleEntry
					? {
							connectionId: visibleEntry.account.connectionId,
							connectionVersion: visibleEntry.account.connectionVersion,
							providerAccountId: visibleEntry.account.providerAccountId,
							owner: visibleEntry.account.owner,
						}
					: null,
				capabilities: sourceOperations.map((operation) => {
					const operationEnabled = enabled.includes(operation);
					return {
						operationId: operation.id,
						operationVersion: operation.version,
						enabled: operationEnabled,
						authorization: operationEnabled
							? (status?.authorizations.find((authorization) => authorization.operationId === operation.id)
									?.state ?? "authorization_required")
							: "not_enabled",
						capability: freezeConnectorValue(structuredClone(operation.sourceCapability)),
					};
				}),
			};
			systems.push(freezeConnectorValue(system));
		}
		return freezeConnectorValue(systems);
	}

	get inputSchema(): ConnectorJsonObject {
		const choices: JsonValue[] = [];
		for (const { installation } of this.#entries.values()) {
			for (const operation of installation.manifest.operations) {
				if (!installation.enabledOperations.includes(operation.id)) continue;
				choices.push({
					properties: {
						connectorId: { const: installation.manifest.id },
						operationId: { const: operation.id },
						input: structuredClone(operation.inputSchema),
					},
					...(operation.sourceCapability?.pagination === "host_continuation"
						? {}
						: { not: { required: ["continuation"] } }),
				});
			}
		}
		return {
			type: "object",
			additionalProperties: false,
			required: ["connectorId", "operationId", "logicalOperationKey", "input"],
			properties: {
				connectorId: { type: "string" },
				operationId: { type: "string" },
				logicalOperationKey: {
					type: "string",
					pattern: CONNECTOR_KEY.source,
					description:
						"Stable logical work identity. Reuse it on replay; never use a call ordinal to bypass an uncertain effect.",
				},
				input: { type: "object" },
				continuation: {
					type: "object",
					additionalProperties: false,
					required: ["id", "version"],
					properties: {
						id: { type: "string", pattern: CONNECTOR_UUID.source },
						version: { type: "integer", minimum: 1 },
					},
					description: "Opaque host-issued continuation bound to this run, audience, account and selector.",
				},
			},
			...(choices.length ? { oneOf: choices } : { not: {} }),
		};
	}
}

/** Applies after provider preparation and before any credential use. No redirects or caller-supplied headers. */
export function assertConnectorDestination(
	entry: ConnectorCatalogEntry,
	operation: ConnectorOperationDefinition,
	request: ConnectorPreparedRequest,
): void {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		throw new ConnectorFailure("invalid_arguments");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		url.href !== request.url ||
		!entry.installation.manifest.destinations.includes(url.origin) ||
		(operation.access === "read" && (request.method !== "GET" || request.body !== undefined)) ||
		Object.keys(request.headers).some((name) =>
			[
				"authorization",
				"cookie",
				"host",
				"proxy-authorization",
				"connection",
				"content-length",
				"transfer-encoding",
			].includes(name.toLowerCase()),
		)
	)
		throw new ConnectorFailure("authority_denied");
	connectorJsonText(request);
}
