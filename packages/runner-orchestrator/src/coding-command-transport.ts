import { createHash } from "node:crypto";
import {
	type CloudCodingCommandRead,
	type CloudCodingCommandScope,
	cloudCodingSessionLayout,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
} from "@qorpera/contracts";
import {
	assertLxdCodingMachineInstance,
	type CodingMachineStorage,
	type LxdCodingMachineBinding,
	lxdCodingMachineName,
	lxdCodingMachinePlan,
} from "./coding-machine.ts";
import type { LxdInspectableClient } from "./lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const HELPER = "/opt/qorpera-coding/cloud-coding-command-guest.mjs";
type Action = "start" | "read" | "cancel";
type Client = Pick<LxdInspectableClient, "getInstance" | "readInstanceFile" | "pushInstanceFile" | "execInstance">;

/** One attached session on a member's machine, as the host knows it for this
 * boot: the machine, its NAS placement, the session, the guest's boot and the
 * digests of the session's guest configuration and the helper in use. */
export interface CodingCommandGuestPins {
	machine: Readonly<LxdCodingMachineBinding>;
	storage: CodingMachineStorage;
	workerId: string;
	bootId: string;
	helperSha256: string;
	guestConfigSha256: string;
	client: Client;
}
/** The machine runs this boot, is exactly this machine, has this session's
 * folders attached, and serves the pinned helper and session configuration. */
export async function inspectCodingSessionGuest(
	options: CodingCommandGuestPins,
	helper: string,
	modes: readonly number[],
	signal: AbortSignal,
): Promise<void> {
	if (
		!UUID.test(options.workerId) ||
		!UUID.test(options.bootId) ||
		!SHA.test(options.helperSha256) ||
		!SHA.test(options.guestConfigSha256)
	)
		throw new Error("CODING_COMMAND_BINDING_INVALID");
	const machine = lxdCodingMachinePlan(options.machine).binding,
		name = lxdCodingMachineName(machine.machineId);
	const instance = await options.client.getInstance(machine.project, name, signal);
	if (!instance || instance.status !== "Running" || instance.statusCode !== 103)
		throw new Error("CODING_MACHINE_NOT_RUNNING");
	if (!assertLxdCodingMachineInstance(machine, options.storage, instance).includes(options.workerId))
		throw new Error("CODING_SESSION_DETACHED");
	const boot = await options.client.readInstanceFile(
		machine.project,
		name,
		"/proc/sys/kernel/random/boot_id",
		64,
		signal,
	);
	if (
		boot.uid !== 0 ||
		boot.gid !== 0 ||
		boot.mode !== 0o444 ||
		boot.content.toString("utf8") !== `${options.bootId}\n`
	)
		throw new Error("CODING_MACHINE_BOOT_CHANGED");
	for (const [path, digest, maximumBytes] of [
		[helper, options.helperSha256, 65536],
		[`${cloudCodingSessionLayout(options.workerId).configurationRoot}/guest.json`, options.guestConfigSha256, 8192],
	] as const) {
		const file = await options.client.readInstanceFile(machine.project, name, path, maximumBytes, signal);
		if (
			file.uid !== 0 ||
			file.gid !== 0 ||
			!modes.includes(file.mode) ||
			createHash("sha256").update(file.content).digest("hex") !== digest
		)
			throw new Error("CODING_GUEST_ARTIFACT_DIFFERS");
	}
}
export async function inspectCodingCommandGuest(options: CodingCommandGuestPins, signal: AbortSignal): Promise<void> {
	await inspectCodingSessionGuest(options, HELPER, [0o400, 0o444], signal);
}

/** Only a trusted provider constructs this transport. The authorization
 * callback must verify the native receipt's exact digest, live request lease,
 * retained allocation and node/network admission before each effect. Matching
 * labels or a command UUID are not authorization. */
export class LxdCodingCommandTransport {
	readonly #pins: CodingCommandGuestPins;
	readonly #scope: Readonly<CloudCodingCommandScope>;
	readonly #project: string;
	readonly #name: string;
	readonly #custody: string;
	readonly #client: Client;
	readonly #authorize: (
		action: Action,
		scope: CloudCodingCommandScope,
		commandId: string,
		inputSha256: string | null,
		signal: AbortSignal,
	) => Promise<void>;
	constructor(options: {
		machine: LxdCodingMachineBinding;
		storage: CodingMachineStorage;
		scope: CloudCodingCommandScope;
		bootId: string;
		helperSha256: string;
		guestConfigSha256: string;
		client: Client;
		authorize: (
			action: Action,
			scope: CloudCodingCommandScope,
			commandId: string,
			inputSha256: string | null,
			signal: AbortSignal,
		) => Promise<void>;
	}) {
		const machine = lxdCodingMachinePlan(options.machine).binding;
		if (
			Object.keys(options.scope).sort().join() !== "requestId,turn,vmId,workerId" ||
			!UUID.test(options.scope.workerId) ||
			options.scope.vmId !== machine.machineId ||
			!UUID.test(options.scope.requestId) ||
			!Number.isSafeInteger(options.scope.turn) ||
			options.scope.turn < 1 ||
			!UUID.test(options.bootId) ||
			!SHA.test(options.helperSha256) ||
			!SHA.test(options.guestConfigSha256)
		)
			throw new Error("CODING_COMMAND_BINDING_INVALID");
		this.#pins = {
			machine,
			storage: options.storage,
			workerId: options.scope.workerId,
			bootId: options.bootId,
			helperSha256: options.helperSha256,
			guestConfigSha256: options.guestConfigSha256,
			client: options.client,
		};
		this.#project = machine.project;
		this.#name = lxdCodingMachineName(machine.machineId);
		this.#custody = cloudCodingSessionLayout(options.scope.workerId).custodyRoot;
		this.#scope = Object.freeze({ ...options.scope });
		this.#client = options.client;
		this.#authorize = options.authorize;
	}
	async #gate(
		action: Action,
		scope: CloudCodingCommandScope,
		commandId: string,
		inputSha256: string | null,
		signal: AbortSignal,
	): Promise<void> {
		if (
			Object.keys(scope).sort().join() !== "requestId,turn,vmId,workerId" ||
			Object.entries(this.#scope).some(([key, value]) => scope[key as keyof CloudCodingCommandScope] !== value) ||
			!UUID.test(commandId) ||
			(inputSha256 !== null && !SHA.test(inputSha256))
		)
			throw new Error("CODING_COMMAND_SCOPE_DIFFERS");
		signal.throwIfAborted();
		await this.#authorize(action, this.#scope, commandId, inputSha256, signal);
		await inspectCodingCommandGuest(this.#pins, signal);
		signal.throwIfAborted();
		await this.#authorize(action, this.#scope, commandId, inputSha256, signal);
		signal.throwIfAborted();
	}
	async #invoke(
		action: Action,
		commandId: string,
		inputSha256: string | null,
		signal: AbortSignal,
		read?: CloudCodingCommandRead,
	) {
		const query = read ? parseCloudCodingCommandRead(read) : undefined;
		const slot = query
			? Number.parseInt(createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 2), 16) % 32
			: null;
		await this.#gate(action, this.#scope, commandId, inputSha256, signal);
		// The command text is never interpolated into exec argv. The reviewed
		// root helper is the only executable selectable at this boundary.
		await this.#client.execInstance(
			this.#project,
			this.#name,
			[
				"/usr/bin/node",
				HELPER,
				action,
				this.#scope.workerId,
				commandId,
				...(read ? [read.tail ? "tail" : String(read.offset ?? 0), String(read.limit ?? 4096)] : []),
			],
			signal,
		);
		const file = await this.#client.readInstanceFile(
			this.#project,
			this.#name,
			`${this.#custody}/commands/${commandId}/${read ? `read-page-${slot}.json` : "status.json"}`,
			65536,
			signal,
		);
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o400) throw new Error("CODING_COMMAND_STATUS_UNPROTECTED");
		const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content));
		if (
			query &&
			(!value ||
				Object.keys(value).sort().join() !== "query,receipt,schema" ||
				value.schema !== "qorpera.coding-command-page/v1" ||
				JSON.stringify(parseCloudCodingCommandRead(value.query)) !== JSON.stringify(query))
		)
			throw new Error("CODING_COMMAND_PAGE_REPLACED");
		const receipt = parseCloudCodingCommandReceipt(query ? value.receipt : value);
		if (
			receipt.commandId !== commandId ||
			receipt.workerId !== this.#scope.workerId ||
			(inputSha256 !== null && receipt.inputSha256 !== inputSha256)
		)
			throw new Error("CODING_COMMAND_STATUS_DIFFERS");
		if (
			read &&
			((!read.tail && receipt.log.offset !== (read.offset ?? 0)) ||
				Buffer.byteLength(receipt.output) > (read.limit ?? 4096))
		)
			throw new Error("CODING_COMMAND_PAGE_DIFFERS");
		await this.#gate(action, this.#scope, commandId, inputSha256, signal);
		return receipt;
	}
	async start(
		scope: CloudCodingCommandScope,
		input: { commandId: string; inputSha256: string; command: string; timeoutMs: number | null },
		signal: AbortSignal,
	) {
		if (
			Object.keys(input).sort().join() !== "command,commandId,inputSha256,timeoutMs" ||
			typeof input.command !== "string" ||
			!input.command.trim() ||
			input.command.includes("\0") ||
			Buffer.byteLength(input.command) > 16384 ||
			Buffer.from(input.command).toString("utf8") !== input.command ||
			(input.timeoutMs !== null && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000))
		)
			throw new Error("CODING_COMMAND_INPUT_INVALID");
		await this.#gate("start", scope, input.commandId, input.inputSha256, signal);
		const request = `${JSON.stringify({ schema: "qorpera.coding-command-request/v2", ...this.#scope, ...input })}\n`;
		if (Buffer.byteLength(request) > 65536) throw new Error("CODING_COMMAND_INPUT_TOO_LARGE");
		const path = `${this.#custody}/inbox/${input.commandId}.json`;
		await this.#client.pushInstanceFile(this.#project, this.#name, path, request, 0o444, signal);
		const staged = await this.#client.readInstanceFile(this.#project, this.#name, path, 65536, signal);
		if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o444 || !staged.content.equals(Buffer.from(request)))
			throw new Error("CODING_COMMAND_STAGING_UNCONFIRMED");
		return this.#invoke("start", input.commandId, input.inputSha256, signal);
	}
	async read(scope: CloudCodingCommandScope, input: CloudCodingCommandRead, signal: AbortSignal) {
		const read = parseCloudCodingCommandRead(input);
		await this.#gate("read", scope, read.commandId, null, signal);
		return this.#invoke("read", read.commandId, null, signal, read);
	}
	async cancel(scope: CloudCodingCommandScope, commandId: string, signal: AbortSignal) {
		await this.#gate("cancel", scope, commandId, null, signal);
		return this.#invoke("cancel", commandId, null, signal);
	}
}
