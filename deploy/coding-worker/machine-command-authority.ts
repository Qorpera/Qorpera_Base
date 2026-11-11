import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isCloudMachineFolderLost } from "../../packages/contracts/src/cloud-machine.ts";
import {
	CLOUD_MACHINE_TOOL_VERSION, type CloudMachineCodingValueHttpRequest, CloudMachineCodingValueRefusal, type CloudMachineCommandHttpRequest,
	cloudMachineCommandHead, CloudMachineCommandRefusal, type CloudMachineScreenHttpRequest, CloudMachineScreenRefusal,
	CloudMemberMachineActRefusal, CloudMemberMachineScreenRefusal, cloudMemberMachineActRecord,
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
	if (result.state === "refused" && (result.reason === "MACHINE_NOT_RUNNING" || result.reason === "MACHINE_COMMAND_ENDED" ||
		// A member holds the machine's desktop (20260930713000): no new command starts.
		result.reason === "DESKTOP_MEMBER_IN_CONTROL"))
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
	/** The lease generation SQL's read saw (20260930713000): what the helper read leaves only while it stands, and no
	 * member holds the desktop (v233 release review r1, F29 of #1661). */
	desktopGeneration: number;
	/** A read, as SQL authorized it. */
	clear: false;
}
/** SQL's answer when a member held the desktop since its clipboard was last confirmed clear (F32 of #1661): nothing is
 * read; the machine's executor clears both selections and confirms it at this generation, and the agent is refused. */
export interface MachineCodingValueClear {
	machineId: string;
	placementId: string;
	bootId: string;
	executorOwner: string;
	providerId: string;
	receiptId: string;
	desktopGeneration: number;
	clear: true;
}

/** The calling run's live tool authority, its own executing save_coding_value receipt of exactly this envelope, the
 * run's and requester's rules, a running machine of its company and a current capture key, all in SQL
 * (qorpera_authorize_machine_coding_value). A machine that is not running is the agent's refusal; anything else SQL
 * refuses fails the request. */
export async function authorizeMachineCodingValue(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	request: CloudMachineCodingValueHttpRequest,
	signal: AbortSignal,
): Promise<MachineCodingValueAuthority | MachineCodingValueClear> {
	const value = await control.call("qorpera_authorize_machine_coding_value", {
		p_binding: request.binding, p_scope: request.scope, p_receipt_id: request.input.commandId, p_envelope: request.input.envelope,
	}, signal);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (result.schema !== "qorpera.machine-coding-value-authority/v1") throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
	if (result.state === "refused" && (result.reason === "MACHINE_NOT_RUNNING" || result.reason === "DESKTOP_MEMBER_IN_CONTROL"))
		throw new CloudMachineCodingValueRefusal(result.reason);
	if (result.state === "clear") {
		if (Object.keys(result).sort().join() !==
				"bootId,desktopGeneration,executorOwner,machineId,placementId,providerId,receiptId,schema,state" ||
			result.machineId !== request.scope.machineId || result.receiptId !== request.input.commandId ||
			typeof result.placementId !== "string" || !UUID.test(result.placementId) ||
			typeof result.bootId !== "string" || !UUID.test(result.bootId) ||
			typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
			typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId) ||
			typeof result.desktopGeneration !== "number" || !Number.isSafeInteger(result.desktopGeneration) || result.desktopGeneration < 0)
			throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
		signal.throwIfAborted();
		return { machineId: result.machineId, placementId: result.placementId, bootId: result.bootId,
			executorOwner: result.executorOwner, providerId: result.providerId, receiptId: result.receiptId,
			desktopGeneration: result.desktopGeneration, clear: true };
	}
	const target = result.target;
	if (result.state !== "authorized" || result.machineId !== request.scope.machineId || result.receiptId !== request.input.commandId ||
		typeof result.placementId !== "string" || !UUID.test(result.placementId) ||
		typeof result.bootId !== "string" || !UUID.test(result.bootId) ||
		typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
		typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId) ||
		typeof result.desktopGeneration !== "number" || !Number.isSafeInteger(result.desktopGeneration) || result.desktopGeneration < 0 ||
		!target || typeof target !== "object" || Array.isArray(target)) throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
	const bound = target as Record<string, unknown>;
	// The helper's target names the same machine, placement, boot and receipt the executor runs it for.
	if (bound.schema !== "qorpera.coding-value-machine-target/v1" || bound.companyMachineId !== result.machineId ||
		bound.placementId !== result.placementId || bound.bootId !== result.bootId || bound.receiptId !== result.receiptId)
		throw new Error("MACHINE_CODING_VALUE_AUTHORITY_INVALID");
	signal.throwIfAborted();
	return { machineId: result.machineId, placementId: result.placementId, bootId: result.bootId, executorOwner: result.executorOwner,
		providerId: result.providerId, receiptId: result.receiptId, target: { ...bound }, desktopGeneration: result.desktopGeneration,
		clear: false };
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
	/** The lease generation SQL's read saw (20260930713000): the host lets the picture out only while it stands. */
	desktopGeneration: number;
	/** A member held the desktop since its clipboard was last confirmed clear (F35 of #1661): the host clears it under this
	 * call's hold of the desktop and records it before it looks or acts. */
	clipboardClear: boolean;
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
	if (result.state === "refused" && (result.reason === "MACHINE_NOT_RUNNING" || result.reason === "MACHINE_NEEDS_COMPANY_VIEW" ||
		// A member holds the desktop (20260930713000): the agent neither sees nor drives it.
		result.reason === "DESKTOP_MEMBER_IN_CONTROL"))
		throw new CloudMachineScreenRefusal(result.reason);
	if (result.state !== "authorized" || result.machineId !== request.scope.machineId || result.receiptId !== request.input.commandId ||
		typeof result.placementId !== "string" || !UUID.test(result.placementId) ||
		typeof result.bootId !== "string" || !UUID.test(result.bootId) ||
		typeof result.runId !== "string" || !UUID.test(result.runId) ||
		typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
		typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId) ||
		!Number.isSafeInteger(result.desktopGeneration) || (result.desktopGeneration as number) < 0 ||
		typeof result.clipboardClear !== "boolean")
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
		settleMs: request.input.settleMs, look: request.input.look, desktopGeneration: result.desktopGeneration as number,
		clipboardClear: result.clipboardClear };
}

/** What SQL says about one member's look at a desktop (20260930712000): where the machine runs, the member, whether the
 * look puts off the desktop's own idle stop, and whether this executor serves it (it does only as the machine's own,
 * once; an executor that forwards the look reads it without serving it). */
export interface MemberMachineScreenAuthority {
	useId: string;
	machineId: string;
	placementId: string;
	bootId: string;
	executorOwner: string;
	providerId: string;
	userId: string;
	served: boolean;
	keepDesktop: boolean;
	/** The lease generation SQL's read saw (20260930713000): the host lets the picture out only while it stands. */
	desktopGeneration: number;
}

/** The look's single-use id, begun as the member, read again live in SQL (qorpera_member_machine_screen_authority) by
 * this executor (`owner`, `providerId`). A machine that is not running and a disk the member may not see are the
 * member's refusals; anything else SQL refuses fails the look. */
export async function authorizeMemberMachineScreen(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	request: { useId: string; owner: string; providerId: string },
	signal: AbortSignal,
): Promise<MemberMachineScreenAuthority> {
	if (!UUID.test(request.useId)) throw new Error("MEMBER_SCREEN_AUTHORITY_INVALID");
	const value = await control.call("qorpera_member_machine_screen_authority", {
		p_use_id: request.useId, p_owner: request.owner, p_provider_id: request.providerId,
	}, signal);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MEMBER_SCREEN_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (result.schema !== "qorpera.member-machine-screen-authority/v1") throw new Error("MEMBER_SCREEN_AUTHORITY_INVALID");
	if (result.state === "refused" && (result.reason === "MACHINE_NOT_RUNNING" || result.reason === "MACHINE_NEEDS_COMPANY_VIEW" ||
		// Another member took the desktop since the begin (20260930713000).
		result.reason === "DESKTOP_MEMBER_IN_CONTROL"))
		throw new CloudMemberMachineScreenRefusal(result.reason);
	if (result.state !== "authorized" ||
		Object.keys(result).sort().join() !==
			"bootId,desktopGeneration,executorOwner,keepDesktop,machineId,placementId,providerId,schema,served,state,useId,userId" ||
		!Number.isSafeInteger(result.desktopGeneration) || (result.desktopGeneration as number) < 0 ||
		result.useId !== request.useId ||
		![result.machineId, result.placementId, result.bootId, result.userId].every((id) => typeof id === "string" && UUID.test(id)) ||
		typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
		typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId) ||
		typeof result.keepDesktop !== "boolean" ||
		// Served only by the machine's own executor: what SQL says and what this executor is agree.
		result.served !== (result.executorOwner === request.owner && result.providerId === request.providerId))
		throw new Error("MEMBER_SCREEN_AUTHORITY_INVALID");
	signal.throwIfAborted();
	return { useId: result.useId, machineId: result.machineId as string, placementId: result.placementId as string,
		bootId: result.bootId as string, executorOwner: result.executorOwner, providerId: result.providerId,
		userId: result.userId as string, served: result.served as boolean, keepDesktop: result.keepDesktop,
		desktopGeneration: result.desktopGeneration as number };
}

/** What SQL says about one member's action on a desktop (20260930713000): where the machine runs, and whether this
 * executor serves it (only the machine's own does, once; one that forwards reads it without serving it). */
export interface MemberMachineActAuthority {
	actionId: string;
	machineId: string;
	placementId: string;
	bootId: string;
	executorOwner: string;
	providerId: string;
	userId: string;
	/** The seat the action was begun in: the host asks the fence again once it holds the desktop (round 23 of #1661). */
	seat: number;
	served: boolean;
}

/** The action's single-use id, begun as the member, read again live in SQL (qorpera_member_machine_desktop_act_authority)
 * by this executor (`owner`, `providerId`). SQL's record of the action must be exactly this one's
 * (cloudMemberMachineActRecord: a typed text by its length), so what runs is what the member's begin was let in for. A
 * machine that is not running, a disk the member may not see and a hold of the desktop that ended are the member's
 * refusals; anything else SQL refuses fails the action. */
export async function authorizeMemberMachineAct(
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	request: { actionId: string; action: MachineScreenAction; owner: string; providerId: string },
	signal: AbortSignal,
): Promise<MemberMachineActAuthority> {
	if (!UUID.test(request.actionId)) throw new Error("MEMBER_ACT_AUTHORITY_INVALID");
	const value = await control.call("qorpera_member_machine_desktop_act_authority", {
		p_action_id: request.actionId, p_owner: request.owner, p_provider_id: request.providerId,
	}, signal);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MEMBER_ACT_AUTHORITY_INVALID");
	const result = value as Record<string, unknown>;
	if (result.schema !== "qorpera.member-machine-desktop-act-authority/v1") throw new Error("MEMBER_ACT_AUTHORITY_INVALID");
	if (result.state === "refused" && (result.reason === "MACHINE_NOT_RUNNING" || result.reason === "MACHINE_NEEDS_COMPANY_VIEW" ||
		result.reason === "DESKTOP_CONTROL_ENDED"))
		throw new CloudMemberMachineActRefusal(result.reason);
	if (result.state !== "authorized" ||
		Object.keys(result).sort().join() !==
			"action,actionId,bootId,executorOwner,machineId,placementId,providerId,schema,seat,served,state,userId" ||
		typeof result.seat !== "number" || !Number.isSafeInteger(result.seat) || result.seat < 1 ||
		result.actionId !== request.actionId ||
		![result.machineId, result.placementId, result.bootId, result.userId].every((id) => typeof id === "string" && UUID.test(id)) ||
		typeof result.executorOwner !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(result.executorOwner) ||
		typeof result.providerId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.providerId) ||
		// Served only by the machine's own executor: what SQL says and what this executor is agree.
		result.served !== (result.executorOwner === request.owner && result.providerId === request.providerId))
		throw new Error("MEMBER_ACT_AUTHORITY_INVALID");
	// The action SQL let in is the one here (a text by its length): a peer's request that differs never runs.
	if (!isDeepStrictEqual(result.action, cloudMemberMachineActRecord(request.action))) throw new Error("MEMBER_ACT_DIFFERS");
	signal.throwIfAborted();
	return { actionId: result.actionId, machineId: result.machineId as string, placementId: result.placementId as string,
		bootId: result.bootId as string, executorOwner: result.executorOwner, providerId: result.providerId,
		userId: result.userId as string, seat: result.seat, served: result.served as boolean };
}
