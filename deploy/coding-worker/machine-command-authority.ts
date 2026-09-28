import { createHash } from "node:crypto";
import {
	CLOUD_MACHINE_TOOL_VERSION, type CloudMachineCommandHttpRequest, cloudMachineCommandHead, CloudMachineCommandRefusal,
} from "../../packages/runtime/src/cloud-machine-command-http.ts";
import { parseCloudNativeToolAuthority } from "../../packages/runtime/src/cloud-native-tool-authority.ts";
import { cloudNativeToolOperationEnvelope } from "../../packages/runtime/src/cloud-native-tool-operations.ts";

/** What SQL says about one machine command: where it runs, and for a start
 * the receipt's input digest, which binds the exact command. */
export interface MachineCommandAuthority {
	inputSha256: string;
	machineId: string;
	/** Where the machine runs now: its LXD instance on the executor's node. */
	placementId: string;
	machine: string;
	executorOwner: string;
	providerId: string;
}

/** The calling run's live tool authority, a running machine of its company
 * and, for a start, its own machine_run receipt: the executor rebuilds that
 * receipt's operation from the request and requires the same digest, so the
 * command, its deadline and its notification are exactly what the agent sent. */
export async function authorizeMachineCommand(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	request: CloudMachineCommandHttpRequest,
	signal: AbortSignal,
): Promise<MachineCommandAuthority> {
	const value = await control.call("qorpera_authorize_machine_command", {
		p_binding: request.binding, p_scope: request.scope, p_action: request.action,
		p_command_id: request.input.commandId,
		p_input_sha256: request.action === "start" ? request.input.inputSha256 : null,
		p_detail: request.action === "start" ? { commandHead: cloudMachineCommandHead(request.input.command), notify: request.input.notify } : null,
	}, signal);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MACHINE_COMMAND_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (result.schema !== "qorpera.machine-command-authority/v1") throw new Error("MACHINE_COMMAND_AUTHORITY_INVALID");
	if (result.state === "refused" && (result.reason === "MACHINE_NOT_RUNNING" || result.reason === "MACHINE_COMMAND_ENDED"))
		throw new CloudMachineCommandRefusal(result.reason);
	if (result.state !== "authorized" || result.machineId !== request.scope.machineId || result.commandId !== request.input.commandId ||
		typeof result.placementId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.placementId) ||
		typeof result.inputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(result.inputSha256) ||
		typeof result.operationKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(result.operationKey) ||
		typeof result.machine !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(result.machine) ||
		typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
		typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId))
		throw new Error("MACHINE_COMMAND_AUTHORITY_INVALID");
	const identity = parseCloudNativeToolAuthority({ schema: "qorpera.native-tool-authority/v1", identity: result.identity, validForMs: 1 }, request.binding).identity;
	if (request.action === "start") {
		const operationKey = result.operationKey;
		const inputSha256 = createHash("sha256").update(cloudNativeToolOperationEnvelope(identity, {
			tool: "machine_run", toolVersion: CLOUD_MACHINE_TOOL_VERSION, logicalOperationKey: operationKey,
			// The tool records a deadline only when the agent chose one.
			arguments: { operationKey, machine: result.machine, command: request.input.command, notify: request.input.notify,
				...(request.input.timeoutMs === null ? {} : { timeoutMs: request.input.timeoutMs }) },
			target: { realm: "company_machine", machineId: request.scope.machineId }, requiresCompanyRevision: false,
		})).digest("hex");
		if (inputSha256 !== result.inputSha256 || inputSha256 !== request.input.inputSha256) throw new Error("MACHINE_COMMAND_INPUT_DIFFERS");
	}
	signal.throwIfAborted();
	return { inputSha256: result.inputSha256, machineId: result.machineId as string, placementId: result.placementId, machine: result.machine,
		executorOwner: result.executorOwner, providerId: result.providerId };
}
