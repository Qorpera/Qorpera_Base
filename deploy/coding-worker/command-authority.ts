import { createHash } from "node:crypto";
import type { CodingLocalRunBinding } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import type {
	CloudCodingCommandAuthority,
	CloudCodingCommandHttpRequest,
	CloudCodingCommandRoute,
} from "../../packages/runtime/src/cloud-coding-command-http.ts";
import { type CloudNativeToolBinding, parseCloudNativeToolAuthority } from "../../packages/runtime/src/cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "../../packages/runtime/src/cloud-native-tool-operations.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** G2-6b: whether a guest's request holds its binding's run lease (its x-qorpera-identity holder, proven by
 * qorpera_native_binding_proven, migration 20260930152000). A gate only: the command's own authorization still checks
 * the run under its lock. The holder goes only into this call's body, never into a log or an error. */
export async function proveNativeBinding(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	binding: CloudNativeToolBinding,
	holder: string,
	signal: AbortSignal,
): Promise<void> {
	if (await control.call("qorpera_native_binding_proven", { p_binding: binding, p_holder: holder }, signal) !== true)
		throw new Error("CODING_COMMAND_UNPROVEN");
}

function parseCodingCommandBindingAuthority(
	value: unknown,
	request: CloudCodingCommandHttpRequest,
): { inputSha256: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (typeof result.inputSha256 !== "string" || !SHA256.test(result.inputSha256) ||
		typeof result.operationKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(result.operationKey) ||
		!result.authority || typeof result.authority !== "object" || Array.isArray(result.authority)) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const authority = result.authority as Record<string, unknown>;
	const parsed = parseCloudNativeToolAuthority({ schema: authority.schema, identity: authority.identity, validForMs: authority.validForMs }, request.binding);
	if (parsed.identity.audienceKind !== "company" || parsed.identity.audienceUserId !== null) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const coding = authority.coding;
	if (!coding || typeof coding !== "object" || Array.isArray(coding)) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const turn = coding as Record<string, unknown>;
	if (turn.workerId !== request.scope.workerId || turn.vmId !== request.scope.vmId ||
		turn.turnId !== request.scope.requestId || turn.sequence !== request.scope.turn) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	if (request.action === "start") {
		const operationKey = result.operationKey;
		const inputSha256 = createHash("sha256").update(cloudNativeToolOperationEnvelope(parsed.identity, {
			tool: "coding_run_command", toolVersion: "v1", logicalOperationKey: operationKey,
			arguments: { operationKey, command: request.input.command,
				...(request.input.timeoutMs === null ? {} : { timeoutMs: request.input.timeoutMs }) },
			target: { schema: "qorpera.coding-command-target/v1", ...request.scope }, requiresCompanyRevision: false,
		})).digest("hex");
		if (inputSha256 !== result.inputSha256 || inputSha256 !== request.input.inputSha256) throw new Error("CODING_COMMAND_INPUT_DIFFERS");
	}
	return { inputSha256: result.inputSha256 };
}

function parseCodingCommandRoute(value: unknown, vmId: string): CloudCodingCommandRoute {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_COMMAND_ROUTE_INVALID");
	const route = value as Record<string, unknown>;
	if (Object.keys(route).sort().join() !== "executorOwner,machineId,providerId,schema" ||
		route.schema !== "qorpera.coding-command-route/v1" || route.machineId !== vmId ||
		typeof route.executorOwner !== "string" || typeof route.providerId !== "string")
		throw new Error("CODING_COMMAND_ROUTE_INVALID");
	return Object.freeze({
		schema: "qorpera.coding-command-route/v1" as const,
		executorOwner: route.executorOwner,
		providerId: route.providerId,
		machineId: route.machineId,
	});
}

export async function authorizeCodingCommand(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	request: CloudCodingCommandHttpRequest,
	signal: AbortSignal,
): Promise<{ inputSha256: string }> {
	const value = await control.call("qorpera_authorize_coding_command", {
		p_binding: request.binding, p_scope: request.scope, p_action: request.action,
		p_command_id: request.input.commandId,
		p_input_sha256: request.action === "start" ? request.input.inputSha256 : null,
	}, signal);
	const parsed = parseCodingCommandBindingAuthority(value, request);
	signal.throwIfAborted();
	return parsed;
}

export async function authorizeCodingCommandV2(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	request: CloudCodingCommandHttpRequest,
	holder: string | null,
	localRun: CodingLocalRunBinding | undefined,
	signal: AbortSignal,
): Promise<CloudCodingCommandAuthority> {
	const startedAt = performance.now();
	const value = await control.call("qorpera_authorize_coding_command_v2", {
		p_binding: request.binding,
		p_holder: holder,
		p_scope: request.scope,
		p_action: request.action,
		p_command_id: request.input.commandId,
		p_input_sha256: request.action === "start" ? request.input.inputSha256 : null,
		p_lease_token: localRun ? localRun.leaseToken : null,
		p_binding_text: localRun ? localRun.bindingText : null,
		p_storage: localRun ? localRun.storage : null,
		p_machine_id_sha256: localRun ? localRun.machineIdSha256 : null,
	}, signal);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (Object.keys(result).sort().join() !== "binding,diskEpoch,rebuildDue,route,runAuthority,schema,vaultEnvVersion" ||
		result.schema !== "qorpera.coding-command-authority/v2" ||
		typeof result.rebuildDue !== "boolean" ||
		(result.diskEpoch !== null && (typeof result.diskEpoch !== "string" || !UUID.test(result.diskEpoch))) ||
		typeof result.vaultEnvVersion !== "string" || !SHA256.test(result.vaultEnvVersion))
		throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	if (localRun) {
		if (!result.runAuthority || typeof result.runAuthority !== "object" || Array.isArray(result.runAuthority))
			throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	} else if (result.runAuthority !== null) {
		throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	}
	const { inputSha256 } = parseCodingCommandBindingAuthority(result.binding, request);
	const route = parseCodingCommandRoute(result.route, request.scope.vmId);
	signal.throwIfAborted();
	return {
		inputSha256,
		route,
		...(localRun ? { runAuthority: result.runAuthority } : {}),
		rebuildDue: result.rebuildDue,
		diskEpoch: result.diskEpoch as string | null,
		vaultEnvVersion: result.vaultEnvVersion,
		startedAt,
	};
}
