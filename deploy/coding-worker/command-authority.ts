import { createHash } from "node:crypto";
import type { CloudCodingCommandHttpRequest } from "../../packages/runtime/src/cloud-coding-command-http.ts";
import { parseCloudNativeToolAuthority } from "../../packages/runtime/src/cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "../../packages/runtime/src/cloud-native-tool-operations.ts";

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
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (typeof result.inputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(result.inputSha256) ||
		typeof result.operationKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(result.operationKey) ||
		!result.authority || typeof result.authority !== "object" || Array.isArray(result.authority)) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const authority = result.authority as Record<string, unknown>;
	const parsed = parseCloudNativeToolAuthority({ schema: authority.schema, identity: authority.identity, validForMs: authority.validForMs }, request.binding);
	if (parsed.identity.audienceKind !== "company" || parsed.identity.audienceUserId !== null) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const coding = authority.coding;
	if (!coding || typeof coding !== "object" || Array.isArray(coding)) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	const turn = coding as Record<string, unknown>;
	// The guest protocol names the turn requestId/turn; the kernel names it turnId/sequence.
	if (turn.workerId !== request.scope.workerId || turn.vmId !== request.scope.vmId ||
		turn.turnId !== request.scope.requestId || turn.sequence !== request.scope.turn) throw new Error("CODING_COMMAND_AUTHORITY_INVALID");
	if (request.action === "start") {
		const operationKey = result.operationKey;
		const inputSha256 = createHash("sha256").update(cloudNativeToolOperationEnvelope(parsed.identity, {
			tool: "coding_run_command", toolVersion: "v1", logicalOperationKey: operationKey,
			arguments: { operationKey, command: request.input.command, timeoutMs: request.input.timeoutMs },
			target: { schema: "qorpera.coding-command-target/v1", ...request.scope }, requiresCompanyRevision: false,
		})).digest("hex");
		if (inputSha256 !== result.inputSha256 || inputSha256 !== request.input.inputSha256) throw new Error("CODING_COMMAND_INPUT_DIFFERS");
	}
	signal.throwIfAborted();
	return { inputSha256: result.inputSha256 };
}
