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
	/** What the company folder did around the command (F3 6e-2a). The executor
	 * adds it on a test machine; the machine itself never sends it. */
	readonly companyFolder?: CloudMachineCommandFolder;
}

/** How a test machine's boot stands with the company folder, in plain
 * sentences for the agent. `company`: `mounted` (this boot has /company),
 * `pending` (not yet), `none` (not on this boot; `why` says why). `heldBack`:
 * why output is held back. `lost`: why the machine lost the command. The
 * paths the machine changed in /company that were not saved come once, on the
 * first receipt that shows the output after them; `moreNotSaved` counts those
 * not listed. */
export interface CloudMachineCommandFolder {
	readonly company: "mounted" | "pending" | "none";
	readonly why?: string;
	readonly heldBack?: string;
	readonly lost?: string;
	readonly notSaved?: readonly CloudMachineFolderNotSaved[];
	readonly moreNotSaved?: number;
}
export interface CloudMachineFolderNotSaved {
	readonly path: string;
	/** The folder's outcome for the path, never `saved`: conflict, refused, denied, waiting_for_review, … */
	readonly outcome: string;
	readonly reason?: string;
}
export const CLOUD_MACHINE_FOLDER_LIMITS = /* @__PURE__ */ Object.freeze({
	sentence: 300,
	path: 300,
	outcome: 64,
	reason: 200,
	notSaved: 8,
	/** As the agent's tool measures it: JSON in a JSON string, `<>&` and line separators as `\uXXXX`. */
	bytes: 1536,
});

/** Why a machine lost a command for its folder (F3 6e-2a), by SQL's cause
 * (`folder_lost_reason`): the executor restarted it, or moved it to a new disk.
 * The same words as SQL's (qorpera_company_machine_folder_lost_text). */
export const CLOUD_MACHINE_FOLDER_LOST: Readonly<Record<string, string>> = /* @__PURE__ */ Object.freeze({
	restart_unproven: "the executor restarted the machine because it could not prove what the machine read in /company",
	restart_view_closed: "the executor restarted the machine because its /company view was closed",
	restart_view_gone: "the executor restarted the machine because the company folder service lost its /company view",
	moved_unchecked: "the machine moved to a new disk because a command ran on the old one before /company was checked",
	moved_starter:
		"the machine moved to a new disk because the agent or member who started it no longer reads the whole company folder",
	moved_unreadable: "the machine moved to a new disk because something it read in /company is no longer readable",
});
/** Whether `value` is one of those causes. */
export function isCloudMachineFolderLost(value: unknown): value is string {
	return typeof value === "string" && Object.hasOwn(CLOUD_MACHINE_FOLDER_LOST, value);
}

/** The size of `companyFolder` as it reaches the agent inside a tool result. */
export function cloudMachineFolderBytes(folder: CloudMachineCommandFolder): number {
	return Buffer.byteLength(JSON.stringify(JSON.stringify(folder)).replace(/[<>&\u2028\u2029]/g, "\\u0000"));
}

const folderText = (value: unknown, limit: number): value is string =>
	typeof value === "string" &&
	value.trim() !== "" &&
	value.length <= limit &&
	!/[\0-\x1f\x7f]/u.test(value) &&
	!/[\ud800-\udfff]/u.test(value);

const FOLDER_KEYS = ["company", "why", "heldBack", "lost", "notSaved", "moreNotSaved"];

export function parseCloudMachineCommandFolder(value: unknown): CloudMachineCommandFolder {
	const fail = () => new Error("Invalid machine command folder report");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
	const input = value as Record<string, unknown>;
	const L = CLOUD_MACHINE_FOLDER_LIMITS;
	if (
		Object.keys(input).some((key) => !FOLDER_KEYS.includes(key)) ||
		!["mounted", "pending", "none"].includes(input.company as string) ||
		(input.company === "none") !== (input.why !== undefined) ||
		(input.why !== undefined && !folderText(input.why, L.sentence)) ||
		(input.heldBack !== undefined && !folderText(input.heldBack, L.sentence)) ||
		(input.lost !== undefined && !folderText(input.lost, L.sentence)) ||
		(input.moreNotSaved !== undefined &&
			(!Number.isSafeInteger(input.moreNotSaved) || Number(input.moreNotSaved) < 1))
	)
		throw fail();
	let notSaved: CloudMachineFolderNotSaved[] | undefined;
	if (input.notSaved !== undefined) {
		if (!Array.isArray(input.notSaved) || input.notSaved.length < 1 || input.notSaved.length > L.notSaved)
			throw fail();
		notSaved = input.notSaved.map((item: unknown) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw fail();
			const entry = item as Record<string, unknown>;
			if (
				Object.keys(entry).some((key) => !["path", "outcome", "reason"].includes(key)) ||
				!folderText(entry.path, L.path) ||
				typeof entry.outcome !== "string" ||
				!/^[a-z][a-z_]{0,63}$/.test(entry.outcome) ||
				entry.outcome === "saved" ||
				(entry.reason !== undefined && !folderText(entry.reason, L.reason))
			)
				throw fail();
			return Object.freeze({
				path: entry.path,
				outcome: entry.outcome,
				...(entry.reason !== undefined ? { reason: entry.reason as string } : {}),
			});
		});
	}
	const folder: CloudMachineCommandFolder = Object.freeze({
		company: input.company as CloudMachineCommandFolder["company"],
		...(input.why !== undefined ? { why: input.why as string } : {}),
		...(input.heldBack !== undefined ? { heldBack: input.heldBack as string } : {}),
		...(input.lost !== undefined ? { lost: input.lost as string } : {}),
		...(notSaved ? { notSaved: Object.freeze(notSaved) } : {}),
		...(input.moreNotSaved !== undefined ? { moreNotSaved: input.moreNotSaved as number } : {}),
	});
	if (cloudMachineFolderBytes(folder) > L.bytes) throw fail();
	return folder;
}

/** Closed, bounded and consistent: the log cursor and state rules are the
 * coding command's, checked by its own parser. */
export function parseCloudMachineCommandReceipt(value: unknown): CloudMachineCommandReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid machine command result");
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input)
		.filter((key) => key !== "companyFolder")
		.sort()
		.join();
	if (
		keys !== "commandId,exitCode,inputSha256,log,machineId,output,schema,state,truncated" ||
		input.schema !== "qorpera.machine-command-result/v1" ||
		typeof input.machineId !== "string" ||
		!UUID.test(input.machineId)
	)
		throw new Error("Invalid machine command result");
	const { machineId, schema: _schema, companyFolder, ...rest } = input;
	const folder = "companyFolder" in input ? parseCloudMachineCommandFolder(companyFolder) : undefined;
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
		...(folder ? { companyFolder: folder } : {}),
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
});
