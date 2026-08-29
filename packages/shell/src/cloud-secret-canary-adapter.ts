import { createHash } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { readBoundedCloudResponse, withCloudDeadline } from "./cloud-request.ts";
import type { CloudSecretConnectorAdapter } from "./cloud-secret-broker.ts";

export const STEP2_SECRET_CANARY_CONNECTOR_ID = "step2_canary";
export const STEP2_SECRET_CANARY_OPERATION_ID = "record_marker";
export const STEP2_SECRET_CANARY_OPERATION_VERSION = 1;
export const STEP2_SECRET_CANARY_DESTINATION_ORIGIN = "https://127.0.0.1:9443";

const ADAPTER_SPECIFICATION = JSON.stringify({
	schema: "qorpera.step2-secret-canary-adapter/v1",
	connectorId: STEP2_SECRET_CANARY_CONNECTOR_ID,
	operationId: STEP2_SECRET_CANARY_OPERATION_ID,
	operationVersion: STEP2_SECRET_CANARY_OPERATION_VERSION,
	destinationOrigin: STEP2_SECRET_CANARY_DESTINATION_ORIGIN,
	credentialPlacement: "authorization-bearer",
	requestPath: "/v1/effects",
});

export const STEP2_SECRET_CANARY_ADAPTER_SHA256 = createHash("sha256").update(ADAPTER_SPECIFICATION).digest("hex");

export type Step2SecretCanaryBehavior =
	| "safe"
	| "reflect_raw"
	| "reflect_url"
	| "reflect_base64"
	| "reflect_base64url"
	| "drop_once"
	| "stall";

interface Step2SecretCanaryArguments {
	readonly label: string;
	readonly behavior: Step2SecretCanaryBehavior;
}

const BEHAVIORS = new Set<Step2SecretCanaryBehavior>([
	"safe",
	"reflect_raw",
	"reflect_url",
	"reflect_base64",
	"reflect_base64url",
	"drop_once",
	"stall",
]);

function parseArguments(value: JsonValue): Step2SecretCanaryArguments {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Step 2 secret canary arguments are invalid");
	}
	const input = value as Record<string, JsonValue>;
	if (
		Object.keys(input).sort().join() !== ["behavior", "label"].join() ||
		typeof input.label !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.label) ||
		typeof input.behavior !== "string" ||
		!BEHAVIORS.has(input.behavior as Step2SecretCanaryBehavior)
	) {
		throw new Error("Step 2 secret canary arguments are invalid");
	}
	return { label: input.label, behavior: input.behavior as Step2SecretCanaryBehavior };
}

function parseResult(value: unknown): JsonValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Step 2 secret canary result is invalid");
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input).sort().join();
	if (
		(keys !== ["effectId", "reused", "schema", "status"].sort().join() &&
			keys !== ["effectId", "reflection", "reused", "schema", "status"].sort().join()) ||
		input.schema !== "qorpera.step2-secret-canary-result/v1" ||
		input.status !== "completed" ||
		typeof input.effectId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.effectId) ||
		typeof input.reused !== "boolean" ||
		(Object.hasOwn(input, "reflection") && typeof input.reflection !== "string")
	) {
		throw new Error("Step 2 secret canary result is invalid");
	}
	return structuredClone(input) as JsonValue;
}

/**
 * The only connector adapter compiled into the Step 2 custody canary. Its
 * destination, authentication placement, request path, and response shape are
 * closed in source. It is deliberately not a production connector.
 */
export function createStep2SecretCanaryAdapter(fetchImplementation: typeof fetch = fetch): CloudSecretConnectorAdapter {
	return Object.freeze({
		connectorId: STEP2_SECRET_CANARY_CONNECTOR_ID,
		operationId: STEP2_SECRET_CANARY_OPERATION_ID,
		operationVersion: STEP2_SECRET_CANARY_OPERATION_VERSION,
		adapterSha256: STEP2_SECRET_CANARY_ADAPTER_SHA256,
		destinationOrigin: STEP2_SECRET_CANARY_DESTINATION_ORIGIN,
		async execute(input: Parameters<CloudSecretConnectorAdapter["execute"]>[0]): Promise<JsonValue> {
			console.error("Step 2 secret-custody canary adapter admitted one fixed destination operation");
			if (
				input.destinationOrigin !== STEP2_SECRET_CANARY_DESTINATION_ORIGIN ||
				input.credentialName !== "api_key" ||
				!Object.hasOwn(input.credentials, "api_key") ||
				Object.keys(input.credentials).sort().join() !== "api_key" ||
				!/^[A-Za-z0-9_-]{43}$/.test(input.credentials.api_key) ||
				!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey)
			) {
				throw new Error("Step 2 secret canary authority is invalid");
			}
			const argumentsValue = parseArguments(input.arguments);
			return withCloudDeadline(
				async (requestSignal) => {
					const body = Buffer.from(
						JSON.stringify({ schema: "qorpera.step2-secret-canary-request/v1", ...argumentsValue }),
						"utf8",
					);
					try {
						const response = await fetchImplementation(`${STEP2_SECRET_CANARY_DESTINATION_ORIGIN}/v1/effects`, {
							method: "POST",
							redirect: "error",
							headers: {
								authorization: `Bearer ${input.credentials.api_key}`,
								"content-type": "application/json",
								"idempotency-key": input.idempotencyKey,
							},
							body,
							signal: requestSignal,
						});
						if (!response.ok) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error("Step 2 secret canary destination rejected the effect");
						}
						const responseBytes = await readBoundedCloudResponse(response, 16 * 1024, requestSignal);
						try {
							const result = parseResult(
								JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)),
							);
							console.error("Step 2 secret-custody canary destination returned its closed result");
							return result;
						} finally {
							responseBytes.fill(0);
						}
					} finally {
						body.fill(0);
					}
				},
				5000,
				input.signal,
			);
		},
	});
}
