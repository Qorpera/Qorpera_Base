import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerScope,
	COMPANY_COMPUTER_TOOL_VERSION,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	type CompanyComputerTool,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { parseCompanyComputerStartIntent } from "@qorpera/cloud-client/cloud-company-computer-start";
import type { JsonValue } from "@qorpera/contracts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { type CloudNativeToolOperations, cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";

export interface CompanyComputerStartDescriptor {
	state: "available";
	scope: CompanyComputerScope;
	computerGeneration: number;
	resources: { officeGrantId: string; officeGrantVersion: number };
}

export interface CompanyComputerStartRegistry {
	call(
		method: "qorpera_native_office_start_descriptor" | "qorpera_native_office_start",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_OFFICE_START_RESPONSE");
	return value as Record<string, unknown>;
}

export function parseCompanyComputerStartDescriptor(
	value: unknown,
	run: CloudNativeToolRun,
): CompanyComputerStartDescriptor | undefined {
	if (value && typeof value === "object" && "state" in value && value.state === "unavailable") {
		record(value, "state");
		return undefined;
	}
	const descriptor = record(value, "computerGeneration,resources,scope,state");
	const scope = record(
		descriptor.scope,
		"companyComputerId,companyId,environmentId,logicalComputerId",
	) as unknown as CompanyComputerScope;
	assertCompanyComputerScope(scope, scope);
	const resources = record(descriptor.resources, "officeGrantId,officeGrantVersion");
	if (
		descriptor.state !== "available" ||
		run.identity.audienceKind !== "company" ||
		scope.companyId !== run.identity.companyId ||
		scope.environmentId !== run.identity.environmentId ||
		!Number.isSafeInteger(descriptor.computerGeneration) ||
		(descriptor.computerGeneration as number) < 1 ||
		typeof resources.officeGrantId !== "string" ||
		!COMPANY_COMPUTER_UUID.test(resources.officeGrantId) ||
		!Number.isSafeInteger(resources.officeGrantVersion) ||
		(resources.officeGrantVersion as number) < 1
	)
		throw new Error("INVALID_OFFICE_START_DESCRIPTOR");
	return structuredClone(descriptor) as unknown as CompanyComputerStartDescriptor;
}

/** Company-owned startup demand, with no screen/guest/member-device fallback.
 * Closing this native session cancels requests in flight, not an accepted
 * durable office intent. Provider readiness and subsequent work are separate. */
export function createCompanyComputerStartSession(options: {
	run: CloudNativeToolRun;
	operations: CloudNativeToolOperations;
	descriptor: CompanyComputerStartDescriptor;
	registry: CompanyComputerStartRegistry;
}): { tools: readonly CompanyComputerTool[]; close(): Promise<void> } {
	const descriptor = parseCompanyComputerStartDescriptor(options.descriptor, options.run);
	if (!descriptor) throw new Error("OFFICE_START_UNAVAILABLE");
	const lifetime = new AbortController();
	const pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
	const parse = (value: JsonValue): { operationKey: string } => {
		const input = record(value, "operationKey");
		if (typeof input.operationKey !== "string" || !pattern.test(input.operationKey))
			throw new Error("INVALID_OFFICE_START_ARGUMENTS");
		return { operationKey: input.operationKey };
	};
	const tool: CompanyComputerTool = {
		name: "computer_start",
		source: "runtime",
		description:
			`${COMPANY_COMPUTER_TOOL_VERSION}. Request startup of the cloud shared office for this company. ` +
			"An accepted request can remain pending while the provider prepares the office; it is not permission to use screens, browser or shell. " +
			"Use a stable operationKey for the same request. An uncertain result requires reconciliation, never a new key. " +
			"The accepted request survives this session ending. After activation and successful completion of this run, an internal agent wake continues pending work with the original request and completed receipts. Finish this run normally; do not poll or create another start request. No member device or provider credentials are used.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey"],
			properties: { operationKey: { type: "string", pattern: pattern.source } },
		},
		parseArguments: parse,
		execute: async (value, context) => {
			const args = parse(value);
			if (context.companyId !== options.run.identity.companyId || context.runId !== options.run.identity.runId)
				throw new Error("COMPUTER_RUN_MISMATCH");
			const signal = AbortSignal.any([context.signal, options.run.signal, lifetime.signal]);
			signal.throwIfAborted();
			return options.operations.execute({
				operation: {
					tool: "computer_start",
					toolVersion: COMPANY_COMPUTER_TOOL_VERSION,
					logicalOperationKey: args.operationKey,
					arguments: { kind: "start" },
					requiresCompanyRevision: false,
					target: {
						realm: "company_computer",
						scope: { ...descriptor.scope },
						computerGeneration: descriptor.computerGeneration,
						resources: { ...descriptor.resources },
					},
				},
				signal,
				authorize: async (operation, identity, checked) => {
					if (!isDeepStrictEqual(identity, options.run.identity)) throw new Error("OFFICE_START_IDENTITY_CHANGED");
					const result = record(
						await cloudToolRequest(
							(requestSignal) =>
								options.registry.call(
									"qorpera_native_office_start",
									{
										p_binding: options.run.binding,
										p_envelope: cloudNativeToolOperationEnvelope(identity, operation),
										p_action: "authorize",
									},
									requestSignal,
								),
							checked,
						),
						"state",
					);
					if (result.state !== "authorized") throw new Error("OFFICE_START_UNCONFIRMED");
				},
				perform: async (operation, effect) => {
					const result = parseCompanyComputerStartIntent(
						await cloudToolRequest(
							(checked) =>
								options.registry.call(
									"qorpera_native_office_start",
									{
										p_binding: options.run.binding,
										p_envelope: cloudNativeToolOperationEnvelope(effect.identity, operation),
										p_action: "begin",
										p_receipt_id: effect.receiptId,
										p_idempotency_sha256: createHash("sha256").update(effect.idempotencyKey).digest("hex"),
									},
									checked,
								),
							effect.signal,
						),
						descriptor.scope,
						descriptor.computerGeneration,
					);
					if (result.state === "cancelled") throw new Error("OFFICE_START_UNCONFIRMED");
					return { content: { kind: "json", value: { ...result } } };
				},
			});
		},
	};
	return {
		tools: [tool],
		close: async () => {
			lifetime.abort(new Error("OFFICE_START_SESSION_CLOSED"));
		},
	};
}
