import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudConnectorDefinition,
	type CloudConnectorOperationDefinition,
	cloudConnectorAdapterSha256,
} from "./cloud-connector-catalog.ts";
import { connectorOutcome } from "./cloud-connector-http.ts";
import type { CloudSecretConnectorAdapter } from "./cloud-secret-broker.ts";
import { validateCloudConnectorInput } from "./cloud-secret-tools.ts";

/**
 * Builds the broker-side adapters for one catalog connector. The builder owns
 * the checks every operation shares: the broker's destination and credential
 * name must equal the catalog's, the sealed credential must be present, and
 * the business arguments must satisfy the closed schema a second time. The
 * provider recipe receives only a bearer token and validated arguments.
 */

export interface ConnectorOperationContext {
	readonly fetch: typeof fetch;
	readonly origin: string;
	readonly bearer: string;
	readonly idempotencyKey: string;
	readonly signal: AbortSignal;
}

export type ConnectorOperationHandler = (
	args: Record<string, JsonValue>,
	context: ConnectorOperationContext,
) => Promise<JsonValue>;

export type ConnectorCredentialExchange = (
	credential: string,
	fetchImplementation: typeof fetch,
	signal: AbortSignal,
) => Promise<string>;

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function closedArguments(value: JsonValue, operation: CloudConnectorOperationDefinition): Record<string, JsonValue> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Connector arguments are invalid");
	}
	validateCloudConnectorInput(value, operation.inputSchema);
	return structuredClone(value) as Record<string, JsonValue>;
}

export function defineConnectorAdapters(
	connector: CloudConnectorDefinition,
	options: {
		readonly fetch: typeof fetch;
		readonly exchange: ConnectorCredentialExchange;
		readonly handlers: Readonly<Record<string, ConnectorOperationHandler>>;
	},
): readonly CloudSecretConnectorAdapter[] {
	const handlerIds = Object.keys(options.handlers).sort().join();
	const operationIds = connector.operations
		.map((operation) => operation.id)
		.sort()
		.join();
	if (handlerIds !== operationIds) throw new Error(`Connector ${connector.id} handlers differ from its catalog`);
	return Object.freeze(
		connector.operations.map((operation): CloudSecretConnectorAdapter => {
			const handler = options.handlers[operation.id] as ConnectorOperationHandler;
			const adapterSha256 = cloudConnectorAdapterSha256(connector, operation);
			return Object.freeze({
				connectorId: connector.id,
				operationId: operation.id,
				operationVersion: operation.version,
				adapterSha256,
				destinationOrigin: connector.destinationOrigin,
				async execute(input: Parameters<CloudSecretConnectorAdapter["execute"]>[0]) {
					if (
						input.destinationOrigin !== connector.destinationOrigin ||
						input.credentialName !== connector.credentialName ||
						!Object.hasOwn(input.credentials, connector.credentialName) ||
						typeof input.credentials[connector.credentialName] !== "string" ||
						!input.credentials[connector.credentialName] ||
						!OPERATION_KEY.test(input.idempotencyKey)
					) {
						throw new Error(`Connector ${connector.id} authority is invalid`);
					}
					const args = closedArguments(input.arguments, operation);
					return connectorOutcome(async () => {
						const bearer = await options.exchange(
							input.credentials[connector.credentialName] as string,
							options.fetch,
							input.signal,
						);
						return handler(args, {
							fetch: options.fetch,
							origin: connector.destinationOrigin,
							bearer,
							idempotencyKey: input.idempotencyKey,
							signal: input.signal,
						});
					});
				},
			});
		}),
	);
}
