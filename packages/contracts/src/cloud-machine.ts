import { parseCloudCodingCommandReceipt } from "./cloud-coding-command.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

/** A command on a company machine (runtime 2026-09-28): the same durable
 * handle, bounded log pages and states as a coding command, bound to the
 * machine instead of a coding session. `lost`: the machine stopped or
 * restarted under the command; its log stays readable. */
export interface CloudMachineCommandReceipt {
	readonly schema: "qorpera.machine-command-result/v1";
	readonly machineId: string;
	readonly commandId: string;
	readonly inputSha256: string;
	readonly state: "running" | "succeeded" | "failed" | "cancelled" | "lost" | "unconfirmed";
	readonly exitCode: number | null;
	readonly output: string;
	readonly truncated: boolean;
	readonly log: {
		readonly offset: number;
		readonly nextOffset: number;
		readonly totalBytes: number;
		readonly limitBytes: number;
		readonly limitReached: boolean;
	};
}

/** Closed, bounded and consistent: the log cursor and state rules are the
 * coding command's, checked by its own parser. */
export function parseCloudMachineCommandReceipt(value: unknown): CloudMachineCommandReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid machine command result");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !==
			"commandId,exitCode,inputSha256,log,machineId,output,schema,state,truncated" ||
		input.schema !== "qorpera.machine-command-result/v1" ||
		typeof input.machineId !== "string" ||
		!UUID.test(input.machineId)
	)
		throw new Error("Invalid machine command result");
	const { machineId, schema: _schema, ...rest } = input;
	const checked = parseCloudCodingCommandReceipt({
		...rest,
		schema: "qorpera.coding-command-result/v2",
		workerId: machineId,
		state: input.state === "lost" ? "unconfirmed" : input.state,
	});
	// A machine says `lost` in its own words; the coding session's `machine_stopped` and output gap are not its own.
	if (checked.state === "machine_stopped" || checked.log.gapBytes !== undefined)
		throw new Error("Invalid machine command result");
	return Object.freeze({
		schema: "qorpera.machine-command-result/v1",
		machineId,
		commandId: checked.commandId,
		inputSha256: checked.inputSha256,
		state: input.state as CloudMachineCommandReceipt["state"],
		exitCode: checked.exitCode,
		output: checked.output,
		truncated: checked.truncated,
		log: checked.log,
	}) as CloudMachineCommandReceipt;
}

/** What the executor pushes into a machine for one command start. The input
 * digest is the machine_run operation receipt's: it binds the command. */
export interface CloudMachineCommandRequest {
	readonly schema: "qorpera.machine-command-request/v1";
	readonly machineId: string;
	readonly commandId: string;
	readonly inputSha256: string;
	readonly command: string;
	/** A deadline the agent chose; null runs it until it exits or is cancelled. */
	readonly timeoutMs: number | null;
}
export function parseCloudMachineCommandRequest(value: unknown): CloudMachineCommandRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid machine command request");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !== "command,commandId,inputSha256,machineId,schema,timeoutMs" ||
		input.schema !== "qorpera.machine-command-request/v1" ||
		typeof input.machineId !== "string" ||
		!UUID.test(input.machineId) ||
		typeof input.commandId !== "string" ||
		!UUID.test(input.commandId) ||
		typeof input.inputSha256 !== "string" ||
		!SHA.test(input.inputSha256) ||
		typeof input.command !== "string" ||
		!input.command.trim() ||
		input.command.includes("\0") ||
		/[\ud800-\udfff]/u.test(input.command) ||
		Buffer.byteLength(input.command) > 16384 ||
		(input.timeoutMs !== null && (!Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1000))
	)
		throw new Error("Invalid machine command request");
	return Object.freeze({ ...input }) as unknown as CloudMachineCommandRequest;
}

/** The fixed places inside a machine. The whole VM belongs to one company
 * job and its commands run as root, so these guard nothing against the job
 * itself: the VM is the boundary, and the executor parses everything it
 * reads back as untrusted, bounded data. */
export const CLOUD_MACHINE_GUEST_PATHS = /* @__PURE__ */ Object.freeze({
	helper: "/opt/qorpera-machine/cloud-machine-guest.mjs",
	state: "/var/lib/qorpera-machine",
	runtime: "/run/qorpera-machine",
	slice: "qorpera-machine.slice",
	unitPrefix: "qorpera-machine-command-",
	/** Where a coding session's repository is attached read-only. */
	repository: "/mnt/repository",
});
