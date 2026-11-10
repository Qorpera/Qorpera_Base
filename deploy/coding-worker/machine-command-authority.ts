import { createHash } from "node:crypto";
import { isCloudMachineFolderLost } from "../../packages/contracts/src/cloud-machine.ts";
import {
	CLOUD_MACHINE_TOOL_VERSION, type CloudMachineCodingValueHttpRequest, CloudMachineCodingValueRefusal, type CloudMachineCommandHttpRequest,
	cloudMachineCommandHead, CloudMachineCommandRefusal, type CloudMachineScreenHttpRequest, CloudMachineScreenRefusal,
} from "../../packages/runtime/src/cloud-machine-command-http.ts";
import { type MachineScreenAction, parseMachineScreenAction } from "../../packages/runtime/src/cloud-machine-screen.ts";
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
	/** The boot SQL knows the placement runs (null before its first), and who the command acts for: a test machine's
	 * start waits for that boot's folder and opens the command's window for its run, staff agent and requester (F3 6d). */
	bootId: string | null;
	runId: string;
	staffAgentId: string;
	requestedByUserId: string;
	/** Why the machine lost the command, when it did for its folder (F3 6e-2a): its executor restarted it, or moved it
	 * to a new disk. Null otherwise, and from a database before 20260930511000. */
	folderLost: string | null;
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
	// Any value outside the six causes (F3 6e-2a) is not SQL's; a database before 20260930511000 sends none.
	const folderLost = result.folderLost === undefined || result.folderLost === null ? undefined : result.folderLost;
	if (folderLost !== undefined && !isCloudMachineFolderLost(folderLost)) throw new Error("MACHINE_COMMAND_AUTHORITY_INVALID");
	if (result.state === "refused" && (result.reason === "MACHINE_NOT_RUNNING" || result.reason === "MACHINE_COMMAND_ENDED"))
		// A command that already ended says why its machine lost it, when the folder made it.
		throw new CloudMachineCommandRefusal(result.reason, folderLost);
	if (result.state !== "authorized" || result.machineId !== request.scope.machineId || result.commandId !== request.input.commandId ||
		typeof result.placementId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.placementId) ||
		typeof result.inputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(result.inputSha256) ||
		typeof result.operationKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(result.operationKey) ||
		typeof result.machine !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(result.machine) ||
		typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
		typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId) ||
		(result.bootId !== null && (typeof result.bootId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.bootId))))
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
		executorOwner: result.executorOwner, providerId: result.providerId, bootId: result.bootId as string | null,
		runId: identity.runId, staffAgentId: identity.staffAgentId, requestedByUserId: identity.requesterUserId,
		folderLost: folderLost ?? null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** What SQL says about one save_coding_value (20260930705000): where the machine runs, and the clipboard helper's target
 * (the service's pattern, the value's capture key and what the box is bound to), which goes to the helper as SQL wrote
 * it. Nothing in it is secret. */
export interface MachineCodingValueAuthority {
	machineId: string;
	placementId: string;
	bootId: string;
	executorOwner: string;
	providerId: string;
	receiptId: string;
	target: Record<string, unknown>;
}

/** The calling run's live tool authority, its own executing save_coding_value receipt of exactly this envelope, the
 * run's and requester's rules, a running machine of its company and a current capture key, all in SQL
 * (qorpera_authorize_machine_coding_value). A machine that is not running is the agent's refusal; anything else SQL
 * refuses fails the request. */
export async function authorizeMachineCodingValue(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	request: CloudMachineCodingValueHttpRequest,
	signal: AbortSignal,
): Promise<MachineCodingValueAuthority> {
	const value = await control.call("qorpera_authorize_machine_coding_value", {
		p_binding: request.binding, p_scope: request.scope, p_receipt_id: request.input.commandId, p_envelope: request.input.envelope,
	}, signal);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (result.schema !== "qorpera.machine-coding-value-authority/v1") throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
	if (result.state === "refused" && result.reason === "MACHINE_NOT_RUNNING") throw new CloudMachineCodingValueRefusal("MACHINE_NOT_RUNNING");
	const target = result.target;
	if (result.state !== "authorized" || result.machineId !== request.scope.machineId || result.receiptId !== request.input.commandId ||
		typeof result.placementId !== "string" || !UUID.test(result.placementId) ||
		typeof result.bootId !== "string" || !UUID.test(result.bootId) ||
		typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
		typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId) ||
		!target || typeof target !== "object" || Array.isArray(target)) throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
	const bound = target as Record<string, unknown>;
	// The helper's target names the same machine, placement, boot and receipt the executor runs it for.
	if (bound.schema !== "qorpera.coding-value-machine-target/v1" || bound.companyMachineId !== result.machineId ||
		bound.placementId !== result.placementId || bound.bootId !== result.bootId || bound.receiptId !== result.receiptId)
		throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
	signal.throwIfAborted();
	return { machineId: result.machineId, placementId: result.placementId, bootId: result.bootId, executorOwner: result.executorOwner,
		providerId: result.providerId, receiptId: result.receiptId, target: { ...bound } };
}

/** What SQL says about one machine_screen (20260930708000): where the machine runs, the run that sees the screen, and
 * what the helper does: for an action, the action as its receipt holds it, with the envelope's settle time and look;
 * for a look, the request's own. */
export interface MachineScreenAuthority {
	machineId: string;
	placementId: string;
	bootId: string;
	executorOwner: string;
	providerId: string;
	runId: string;
	receiptId: string | null;
	action: MachineScreenAction | null;
	settleMs: number;
	look: boolean;
}

/** The calling run's live tool authority, for an action its own executing machine_screen receipt of exactly this
 * envelope, and a running machine of its company, all in SQL (qorpera_authorize_machine_screen). A machine that is not
 * running is the agent's refusal; anything else SQL refuses fails the request. An action is what SQL read from the
 * receipted envelope, checked again here as the helper checks it, and its settle time and look must be the request's. */
export async function authorizeMachineScreen(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	request: CloudMachineScreenHttpRequest,
	signal: AbortSignal,
): Promise<MachineScreenAuthority> {
	const value = await control.call("qorpera_authorize_machine_screen", {
		p_binding: request.binding, p_scope: request.scope, p_receipt_id: request.input.commandId, p_envelope: request.input.envelope,
	}, signal);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MACHINE_SCREEN_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (result.schema !== "qorpera.machine-screen-authority/v1") throw new Error("MACHINE_SCREEN_AUTHORITY_INVALID");
	// The agent hears these: a machine that is not running, and a disk that has had a company folder view its caller may
	// not see (20260930420000; review r1 F1).
	if (result.state === "refused" && (result.reason === "MACHINE_NOT_RUNNING" || result.reason === "MACHINE_NEEDS_COMPANY_VIEW"))
		throw new CloudMachineScreenRefusal(result.reason);
	if (result.state !== "authorized" || result.machineId !== request.scope.machineId || result.receiptId !== request.input.commandId ||
		typeof result.placementId !== "string" || !UUID.test(result.placementId) ||
		typeof result.bootId !== "string" || !UUID.test(result.bootId) ||
		typeof result.runId !== "string" || !UUID.test(result.runId) ||
		typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
		typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId))
		throw new Error("MACHINE_SCREEN_AUTHORITY_INVALID");
	let action: MachineScreenAction | null = null;
	if (request.input.commandId === null) {
		if (result.action !== null || result.settleMs !== null || result.look !== null) throw new Error("MACHINE_SCREEN_AUTHORITY_INVALID");
	} else {
		try {
			action = parseMachineScreenAction(result.action);
		} catch {
			throw new Error("MACHINE_SCREEN_AUTHORITY_INVALID");
		}
		if (result.settleMs !== request.input.settleMs || result.look !== request.input.look) throw new Error("MACHINE_SCREEN_AUTHORITY_INVALID");
	}
	signal.throwIfAborted();
	return { machineId: result.machineId, placementId: result.placementId, bootId: result.bootId, executorOwner: result.executorOwner,
		providerId: result.providerId, runId: result.runId, receiptId: request.input.commandId, action,
		settleMs: request.input.settleMs, look: request.input.look };
}
