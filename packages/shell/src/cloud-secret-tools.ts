import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";
import type { CloudNativeTool, CloudToolContent } from "./cloud-native-tool-boundary.ts";
import { cloudToolJsonText } from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperation, CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudSecretOperationRequest } from "./cloud-secret-broker.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type ConnectorSchema = {
	type: "object";
	properties: Record<string, ConnectorSchemaNode>;
	required?: string[];
	additionalProperties: false;
};

type ConnectorSchemaNode =
	| {
			type: "string";
			description?: string;
			minLength?: number;
			maxLength?: number;
			enum?: string[];
			pattern?: string;
	  }
	| { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number; enum?: number[] }
	| { type: "boolean"; description?: string }
	| { type: "null"; description?: string }
	| {
			type: "array";
			description?: string;
			items: ConnectorSchemaNode;
			minItems?: number;
			maxItems?: number;
	  }
	| {
			type: "object";
			description?: string;
			properties: Record<string, ConnectorSchemaNode>;
			required?: string[];
			additionalProperties: false;
	  };

export interface CloudNativeConnectorToolDescriptor {
	readonly schema: "qorpera.native-connector-tool/v1";
	readonly grantId: string;
	readonly toolName: string;
	readonly description: string;
	readonly inputSchema: ConnectorSchema;
	readonly connectorId: string;
	readonly operationId: string;
	readonly operationVersion: number;
	readonly adapterSha256: string;
	readonly destinationOrigin: string;
}

export interface CloudSecretOperationClient {
	execute(request: CloudSecretOperationRequest, signal: AbortSignal): Promise<CloudToolContent>;
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

function exact(
	value: Record<string, unknown>,
	permitted: readonly string[],
	required: readonly string[],
	label: string,
) {
	if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !permitted.includes(key)))
		throw new Error(`${label} is invalid`);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} is invalid`);
	}
	return value as number;
}

function description(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\0]/.test(value)) {
		throw new Error("Connector schema description is invalid");
	}
	return value;
}

/** Accept only an anchored, bounded, non-branching ASCII subset. This keeps
 * connector validation deterministic without trusting an arbitrary regex from
 * the catalog. A pattern may contain one variable-width atom, which covers
 * bounded identifiers without permitting nested or ambiguous repetition. */
function stringPattern(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.length < 3 ||
		value.length > 256 ||
		value[0] !== "^" ||
		value.at(-1) !== "$" ||
		/[\u0000-\u001f\u007f-\uffff]/.test(value)
	)
		throw new Error("Connector string pattern is invalid");
	const body = value.slice(1, -1);
	let index = 0;
	let maximumLength = 0;
	let variableAtoms = 0;
	while (index < body.length) {
		if (body[index] === "[") {
			let end = index + 1;
			let escaped = false;
			for (; end < body.length; end++) {
				const character = body[end];
				if (!escaped && character === "]") break;
				escaped = !escaped && character === "\\";
				if (character !== "\\") escaped = false;
			}
			if (end === index + 1 || end >= body.length || body.slice(index + 1, end).includes("["))
				throw new Error("Connector string pattern is invalid");
			index = end + 1;
		} else if (body[index] === "\\") {
			if (index + 1 >= body.length || !/^[\\^$.*+?()[\]{}|/-]$/.test(body[index + 1] as string))
				throw new Error("Connector string pattern is invalid");
			index += 2;
		} else {
			if (/^[.^$*+?()[\]{}|]$/.test(body[index] as string)) throw new Error("Connector string pattern is invalid");
			index++;
		}
		let minimum = 1;
		let maximum = 1;
		if (body[index] === "?") {
			minimum = 0;
			index++;
		} else if (body[index] === "{") {
			const matched = /^\{([0-9]{1,4})(?:,([0-9]{1,4}))?\}/.exec(body.slice(index));
			if (!matched) throw new Error("Connector string pattern is invalid");
			minimum = Number(matched[1]);
			maximum = matched[2] === undefined ? minimum : Number(matched[2]);
			if (minimum > maximum || maximum > 4096) throw new Error("Connector string pattern is invalid");
			index += matched[0].length;
		} else if (body[index] === "*" || body[index] === "+") {
			throw new Error("Connector string pattern is invalid");
		}
		if (minimum !== maximum && ++variableAtoms > 1) throw new Error("Connector string pattern is invalid");
		maximumLength += maximum;
		if (maximumLength > 4096) throw new Error("Connector string pattern is invalid");
	}
	try {
		new RegExp(value, "u");
	} catch {
		throw new Error("Connector string pattern is invalid");
	}
	return value;
}

function matchesStringPattern(value: string, pattern: string): boolean {
	const matched = new RegExp(pattern, "u").exec(value);
	return matched?.index === 0 && matched[0] === value;
}

function parseSchemaNode(value: unknown, depth: number, budget: { remaining: number }): ConnectorSchemaNode {
	if (depth > 6 || --budget.remaining < 0) throw new Error("Connector schema is too complex");
	const input = record(value, "Connector schema");
	const common = { ...(description(input.description) ? { description: input.description as string } : {}) };
	if (input.type === "string") {
		exact(
			input,
			["type", "description", "minLength", "maxLength", "enum", "pattern"],
			["type"],
			"Connector string schema",
		);
		const minLength = boundedInteger(input.minLength, 0, 65_536, "Connector string minimum");
		const maxLength = boundedInteger(input.maxLength, 0, 65_536, "Connector string maximum");
		if (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
			throw new Error("Connector string bounds are invalid");
		let enumValue: string[] | undefined;
		if (input.enum !== undefined) {
			if (
				!Array.isArray(input.enum) ||
				input.enum.length < 1 ||
				input.enum.length > 64 ||
				input.enum.some((item) => typeof item !== "string" || Buffer.byteLength(item) > 4096) ||
				new Set(input.enum).size !== input.enum.length
			)
				throw new Error("Connector string enum is invalid");
			enumValue = [...input.enum] as string[];
		}
		return {
			type: "string",
			...common,
			...(minLength === undefined ? {} : { minLength }),
			...(maxLength === undefined ? {} : { maxLength }),
			...(enumValue ? { enum: enumValue } : {}),
			...(stringPattern(input.pattern) ? { pattern: input.pattern as string } : {}),
		};
	}
	if (input.type === "number" || input.type === "integer") {
		exact(input, ["type", "description", "minimum", "maximum", "enum"], ["type"], "Connector numeric schema");
		const numeric = (candidate: unknown): candidate is number =>
			typeof candidate === "number" &&
			Number.isFinite(candidate) &&
			(input.type !== "integer" || Number.isSafeInteger(candidate));
		if (
			(input.minimum !== undefined && !numeric(input.minimum)) ||
			(input.maximum !== undefined && !numeric(input.maximum)) ||
			(typeof input.minimum === "number" && typeof input.maximum === "number" && input.minimum > input.maximum)
		)
			throw new Error("Connector numeric bounds are invalid");
		let enumValue: number[] | undefined;
		if (input.enum !== undefined) {
			if (
				!Array.isArray(input.enum) ||
				input.enum.length < 1 ||
				input.enum.length > 64 ||
				input.enum.some((item) => !numeric(item)) ||
				new Set(input.enum).size !== input.enum.length
			)
				throw new Error("Connector numeric enum is invalid");
			enumValue = [...input.enum] as number[];
		}
		return {
			type: input.type,
			...common,
			...(input.minimum === undefined ? {} : { minimum: input.minimum as number }),
			...(input.maximum === undefined ? {} : { maximum: input.maximum as number }),
			...(enumValue ? { enum: enumValue } : {}),
		};
	}
	if (input.type === "boolean" || input.type === "null") {
		exact(input, ["type", "description"], ["type"], "Connector primitive schema");
		return { type: input.type, ...common };
	}
	if (input.type === "array") {
		exact(
			input,
			["type", "description", "items", "minItems", "maxItems"],
			["type", "items"],
			"Connector array schema",
		);
		const minItems = boundedInteger(input.minItems, 0, 128, "Connector array minimum");
		const maxItems = boundedInteger(input.maxItems, 0, 128, "Connector array maximum");
		if (minItems !== undefined && maxItems !== undefined && minItems > maxItems)
			throw new Error("Connector array bounds are invalid");
		return {
			type: "array",
			...common,
			items: parseSchemaNode(input.items, depth + 1, budget),
			...(minItems === undefined ? {} : { minItems }),
			...(maxItems === undefined ? {} : { maxItems }),
		};
	}
	if (input.type === "object") {
		exact(
			input,
			["type", "description", "properties", "required", "additionalProperties"],
			["type", "properties", "additionalProperties"],
			"Connector object schema",
		);
		if (input.additionalProperties !== false) throw new Error("Connector schema must be closed");
		const properties = record(input.properties, "Connector schema properties");
		const names = Object.keys(properties);
		if (names.length > 64 || names.some((name) => !IDENTIFIER.test(name))) {
			throw new Error("Connector schema properties are invalid");
		}
		let required: string[] | undefined;
		if (input.required !== undefined) {
			if (
				!Array.isArray(input.required) ||
				input.required.some((name) => typeof name !== "string" || !Object.hasOwn(properties, name)) ||
				new Set(input.required).size !== input.required.length
			)
				throw new Error("Connector schema required fields are invalid");
			required = [...input.required] as string[];
		}
		return {
			type: "object",
			...common,
			properties: Object.fromEntries(
				names.sort().map((name) => [name, parseSchemaNode(properties[name], depth + 1, budget)]),
			),
			...(required ? { required } : {}),
			additionalProperties: false,
		};
	}
	throw new Error("Connector schema type is unsupported");
}

function parseInputSchema(value: unknown): ConnectorSchema {
	const schema = parseSchemaNode(value, 0, { remaining: 128 });
	if (schema.type !== "object") throw new Error("Connector input schema must be an object");
	cloudToolJsonText(schema, 16 * 1024);
	return schema;
}

function validateValue(value: JsonValue, schema: ConnectorSchemaNode, depth = 0): void {
	if (depth > 6) throw new Error("Connector input is too deep");
	if (schema.type === "string") {
		if (
			typeof value !== "string" ||
			(schema.minLength !== undefined && value.length < schema.minLength) ||
			(schema.maxLength !== undefined && value.length > schema.maxLength) ||
			(schema.enum !== undefined && !schema.enum.includes(value)) ||
			(schema.pattern !== undefined && !matchesStringPattern(value, schema.pattern))
		)
			throw new Error("Connector string input is invalid");
		return;
	}
	if (schema.type === "number" || schema.type === "integer") {
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			(schema.type === "integer" && !Number.isSafeInteger(value)) ||
			(schema.minimum !== undefined && value < schema.minimum) ||
			(schema.maximum !== undefined && value > schema.maximum) ||
			(schema.enum !== undefined && !schema.enum.includes(value))
		)
			throw new Error("Connector numeric input is invalid");
		return;
	}
	if (schema.type === "boolean") {
		if (typeof value !== "boolean") throw new Error("Connector boolean input is invalid");
		return;
	}
	if (schema.type === "null") {
		if (value !== null) throw new Error("Connector null input is invalid");
		return;
	}
	if (schema.type === "array") {
		if (
			!Array.isArray(value) ||
			(schema.minItems !== undefined && value.length < schema.minItems) ||
			(schema.maxItems !== undefined && value.length > schema.maxItems)
		)
			throw new Error("Connector array input is invalid");
		for (const child of value) validateValue(child, schema.items, depth + 1);
		return;
	}
	if (schema.type !== "object") throw new Error("Connector schema type is unsupported");
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Connector object input is invalid");
	const keys = Object.keys(value);
	if (keys.some((name) => !Object.hasOwn(schema.properties, name)))
		throw new Error("Connector input has extra fields");
	if (schema.required?.some((name) => !Object.hasOwn(value, name))) throw new Error("Connector input is incomplete");
	for (const [name, child] of Object.entries(value)) validateValue(child, schema.properties[name], depth + 1);
}

function parseDescriptor(value: unknown): CloudNativeConnectorToolDescriptor {
	const input = record(value, "Native connector tool");
	exact(
		input,
		[
			"schema",
			"grantId",
			"toolName",
			"description",
			"inputSchema",
			"connectorId",
			"operationId",
			"operationVersion",
			"adapterSha256",
			"destinationOrigin",
		],
		[
			"schema",
			"grantId",
			"toolName",
			"description",
			"inputSchema",
			"connectorId",
			"operationId",
			"operationVersion",
			"adapterSha256",
			"destinationOrigin",
		],
		"Native connector tool",
	);
	if (
		input.schema !== "qorpera.native-connector-tool/v1" ||
		typeof input.grantId !== "string" ||
		!UUID.test(input.grantId) ||
		typeof input.toolName !== "string" ||
		!IDENTIFIER.test(input.toolName) ||
		typeof input.description !== "string" ||
		!input.description.trim() ||
		input.description.length > 2048 ||
		typeof input.connectorId !== "string" ||
		!IDENTIFIER.test(input.connectorId) ||
		typeof input.operationId !== "string" ||
		!IDENTIFIER.test(input.operationId) ||
		!Number.isSafeInteger(input.operationVersion) ||
		(input.operationVersion as number) < 1 ||
		typeof input.adapterSha256 !== "string" ||
		!SHA.test(input.adapterSha256) ||
		typeof input.destinationOrigin !== "string" ||
		!input.destinationOrigin.startsWith("https://") ||
		new URL(input.destinationOrigin).origin !== input.destinationOrigin
	)
		throw new Error("Native connector tool is invalid");
	return Object.freeze({
		schema: "qorpera.native-connector-tool/v1",
		grantId: input.grantId,
		toolName: input.toolName,
		description: input.description,
		inputSchema: parseInputSchema(input.inputSchema),
		connectorId: input.connectorId,
		operationId: input.operationId,
		operationVersion: input.operationVersion as number,
		adapterSha256: input.adapterSha256,
		destinationOrigin: input.destinationOrigin,
	});
}

export async function describeCloudSecretTools(
	control: CloudCompanyPathControl,
	binding: CloudNativeToolBinding,
	signal: AbortSignal,
): Promise<readonly CloudNativeConnectorToolDescriptor[]> {
	const value = await cloudToolRequest(
		(requestSignal) => control.call("qorpera_list_native_connector_tools", { p_binding: binding }, requestSignal),
		signal,
	);
	if (!Array.isArray(value) || value.length > 32) throw new Error("Native connector tool catalog is invalid");
	const descriptors = value.map(parseDescriptor);
	if (new Set(descriptors.map((item) => item.toolName)).size !== descriptors.length) {
		throw new Error("Native connector tool catalog has duplicate names");
	}
	return Object.freeze(descriptors);
}

function parseInvocation(value: JsonValue, descriptor: CloudNativeConnectorToolDescriptor) {
	const input = record(value, "Connector invocation");
	if (
		Object.keys(input).sort().join() !== "idempotencyKey,input" ||
		typeof input.idempotencyKey !== "string" ||
		!OPERATION_KEY.test(input.idempotencyKey)
	)
		throw new Error("Connector invocation is invalid");
	cloudToolJsonText(input.input, 64 * 1024);
	validateValue(input.input as JsonValue, descriptor.inputSchema);
	return { idempotencyKey: input.idempotencyKey, input: structuredClone(input.input) as JsonValue };
}

export function cloudSecretTools(options: {
	descriptors: readonly CloudNativeConnectorToolDescriptor[];
	binding: CloudNativeToolBinding;
	control: CloudCompanyPathControl;
	operations: CloudNativeToolOperations;
	broker: CloudSecretOperationClient;
}): CloudNativeTool[] {
	return options.descriptors.map((descriptor) => {
		const target = Object.freeze({
			grantId: descriptor.grantId,
			connectorId: descriptor.connectorId,
			operationId: descriptor.operationId,
			operationVersion: descriptor.operationVersion,
			adapterSha256: descriptor.adapterSha256,
			destinationOrigin: descriptor.destinationOrigin,
		});
		const assertOperation = async (operation: CloudNativeToolOperation, signal: AbortSignal): Promise<void> => {
			if (
				operation.tool !== descriptor.toolName ||
				operation.toolVersion !== `${descriptor.operationVersion}-${descriptor.adapterSha256}` ||
				cloudToolJsonText(operation.target) !== cloudToolJsonText(target) ||
				operation.requiresCompanyRevision
			)
				throw new Error("Connector operation differs from its tool grant");
			const checked = await cloudToolRequest(
				(requestSignal) =>
					options.control.call(
						"qorpera_assert_native_connector_operation",
						{
							p_binding: options.binding,
							p_grant_id: descriptor.grantId,
							p_connector_id: descriptor.connectorId,
							p_operation_id: descriptor.operationId,
							p_operation_version: descriptor.operationVersion,
							p_adapter_sha256: descriptor.adapterSha256,
							p_destination_origin: descriptor.destinationOrigin,
						},
						requestSignal,
					),
				signal,
			);
			if (checked !== null) throw new Error("Connector operation authorization is invalid");
		};
		const tool: CloudNativeTool = {
			name: descriptor.toolName,
			source: "connector",
			description: descriptor.description,
			inputSchema: {
				type: "object",
				properties: {
					idempotencyKey: {
						type: "string",
						description: "Stable key for this exact external effect; reuse it for an identical retry.",
						pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
					},
					input: structuredClone(descriptor.inputSchema),
				},
				required: ["idempotencyKey", "input"],
				additionalProperties: false,
			},
			parseArguments(value) {
				const parsed = parseInvocation(value, descriptor);
				return { idempotencyKey: parsed.idempotencyKey, input: parsed.input };
			},
			async execute(value, context) {
				const parsed = parseInvocation(value, descriptor);
				return options.operations.execute({
					operation: {
						tool: descriptor.toolName,
						toolVersion: `${descriptor.operationVersion}-${descriptor.adapterSha256}`,
						logicalOperationKey: `${descriptor.grantId}:${parsed.idempotencyKey}`,
						arguments: parsed.input,
						target,
						requiresCompanyRevision: false,
					},
					authorize: (operation, _identity, signal) => assertOperation(operation, signal),
					perform: async (operation, operationContext) => ({
						content: await options.broker.execute(
							{
								binding: options.binding,
								receiptId: operationContext.receiptId,
								inputSha256: operationContext.inputSha256,
								grantId: descriptor.grantId,
								connectorId: descriptor.connectorId,
								operationId: descriptor.operationId,
								operationVersion: descriptor.operationVersion,
								adapterSha256: descriptor.adapterSha256,
								destinationOrigin: descriptor.destinationOrigin,
								idempotencyKey: operationContext.idempotencyKey,
								arguments: operation.arguments,
							},
							operationContext.signal,
						),
					}),
					signal: context.signal,
				});
			},
		};
		return tool;
	});
}
