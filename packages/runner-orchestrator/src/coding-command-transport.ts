import { createHash } from "node:crypto";
import { type CloudCodingCommandScope, parseCloudCodingCommandReceipt } from "@qorpera/contracts";
import { assertLxdCodingVmInstance, type LxdCodingVmBinding, lxdCodingVmPlan } from "./coding-vm.ts";
import type { LxdInspectableClient } from "./lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const HELPER = "/opt/qorpera-coding/cloud-coding-command-guest.mjs";
type Action = "start" | "read" | "cancel";
type Client = Pick<LxdInspectableClient, "getInstance" | "readInstanceFile" | "pushInstanceFile" | "execInstance">;

export interface CodingCommandGuestPins {
	vm: Readonly<LxdCodingVmBinding>;
	bootId: string;
	helperSha256: string;
	guestConfigSha256: string;
	client: Client;
}
export async function inspectCodingCommandGuest(options: CodingCommandGuestPins, signal: AbortSignal): Promise<void> {
	if (!UUID.test(options.bootId) || !SHA.test(options.helperSha256) || !SHA.test(options.guestConfigSha256))
		throw new Error("CODING_COMMAND_BINDING_INVALID");
	const name = lxdCodingVmPlan(options.vm).request.name;
	const instance = await options.client.getInstance(options.vm.project, name, signal);
	if (!instance || instance.status !== "Running" || instance.statusCode !== 103)
		throw new Error("CODING_VM_NOT_RUNNING");
	assertLxdCodingVmInstance(options.vm, instance);
	const boot = await options.client.readInstanceFile(
		options.vm.project,
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
		throw new Error("CODING_VM_BOOT_CHANGED");
	for (const [path, digest, maximumBytes] of [
		[HELPER, options.helperSha256, 65536],
		["/etc/qorpera-coding/guest.json", options.guestConfigSha256, 8192],
	] as const) {
		const file = await options.client.readInstanceFile(options.vm.project, name, path, maximumBytes, signal);
		if (
			file.uid !== 0 ||
			file.gid !== 0 ||
			![0o400, 0o444].includes(file.mode) ||
			createHash("sha256").update(file.content).digest("hex") !== digest
		)
			throw new Error("CODING_GUEST_ARTIFACT_DIFFERS");
	}
}

/** Only a trusted provider constructs this transport. The authorization
 * callback must verify the native receipt's exact digest, live request lease,
 * retained allocation and node/network admission before each effect. Matching
 * labels or a command UUID are not authorization. */
export class LxdCodingCommandTransport {
	readonly #vm: Readonly<LxdCodingVmBinding>;
	readonly #scope: Readonly<CloudCodingCommandScope>;
	readonly #name: string;
	readonly #bootId: string;
	readonly #helperSha256: string;
	readonly #guestConfigSha256: string;
	readonly #client: Client;
	readonly #authorize: (
		action: Action,
		scope: CloudCodingCommandScope,
		commandId: string,
		inputSha256: string | null,
		signal: AbortSignal,
	) => Promise<void>;
	constructor(options: {
		vm: LxdCodingVmBinding;
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
		const plan = lxdCodingVmPlan(options.vm);
		if (
			Object.keys(options.scope).sort().join() !== "requestId,turn,vmId,workerId" ||
			options.scope.workerId !== plan.binding.workerId ||
			options.scope.vmId !== plan.binding.allocationId ||
			!UUID.test(options.scope.requestId) ||
			!Number.isSafeInteger(options.scope.turn) ||
			options.scope.turn < 1 ||
			!UUID.test(options.bootId) ||
			!SHA.test(options.helperSha256) ||
			!SHA.test(options.guestConfigSha256)
		)
			throw new Error("CODING_COMMAND_BINDING_INVALID");
		this.#vm = plan.binding;
		this.#name = plan.request.name;
		this.#scope = Object.freeze({ ...options.scope });
		this.#bootId = options.bootId;
		this.#helperSha256 = options.helperSha256;
		this.#guestConfigSha256 = options.guestConfigSha256;
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
		await inspectCodingCommandGuest(
			{
				vm: this.#vm,
				bootId: this.#bootId,
				helperSha256: this.#helperSha256,
				guestConfigSha256: this.#guestConfigSha256,
				client: this.#client,
			},
			signal,
		);
		signal.throwIfAborted();
		await this.#authorize(action, this.#scope, commandId, inputSha256, signal);
		signal.throwIfAborted();
	}
	async #invoke(action: Action, commandId: string, inputSha256: string | null, signal: AbortSignal) {
		await this.#gate(action, this.#scope, commandId, inputSha256, signal);
		// The command text is never interpolated into exec argv. The reviewed
		// root helper is the only executable selectable at this boundary.
		await this.#client.execInstance(
			this.#vm.project,
			this.#name,
			["/usr/bin/node", HELPER, action, commandId],
			signal,
		);
		const file = await this.#client.readInstanceFile(
			this.#vm.project,
			this.#name,
			`/var/lib/qorpera-coding/commands/${commandId}/status.json`,
			32768,
			signal,
		);
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o400) throw new Error("CODING_COMMAND_STATUS_UNPROTECTED");
		const receipt = parseCloudCodingCommandReceipt(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)),
		);
		if (
			receipt.commandId !== commandId ||
			receipt.workerId !== this.#scope.workerId ||
			(inputSha256 !== null && receipt.inputSha256 !== inputSha256)
		)
			throw new Error("CODING_COMMAND_STATUS_DIFFERS");
		await this.#gate(action, this.#scope, commandId, inputSha256, signal);
		return receipt;
	}
	async start(
		scope: CloudCodingCommandScope,
		input: { commandId: string; inputSha256: string; command: string; timeoutMs: number },
		signal: AbortSignal,
	) {
		if (
			Object.keys(input).sort().join() !== "command,commandId,inputSha256,timeoutMs" ||
			typeof input.command !== "string" ||
			!input.command.trim() ||
			input.command.includes("\0") ||
			Buffer.byteLength(input.command) > 16384 ||
			Buffer.from(input.command).toString("utf8") !== input.command ||
			!Number.isSafeInteger(input.timeoutMs) ||
			input.timeoutMs < 1000 ||
			input.timeoutMs > 1800000
		)
			throw new Error("CODING_COMMAND_INPUT_INVALID");
		await this.#gate("start", scope, input.commandId, input.inputSha256, signal);
		const request = `${JSON.stringify({ schema: "qorpera.coding-command-request/v1", ...this.#scope, ...input })}\n`;
		if (Buffer.byteLength(request) > 65536) throw new Error("CODING_COMMAND_INPUT_TOO_LARGE");
		const path = `/var/lib/qorpera-coding/inbox/${input.commandId}.json`;
		await this.#client.pushInstanceFile(this.#vm.project, this.#name, path, request, 0o444, signal);
		const staged = await this.#client.readInstanceFile(this.#vm.project, this.#name, path, 65536, signal);
		if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o444 || !staged.content.equals(Buffer.from(request)))
			throw new Error("CODING_COMMAND_STAGING_UNCONFIRMED");
		return this.#invoke("start", input.commandId, input.inputSha256, signal);
	}
	async read(scope: CloudCodingCommandScope, commandId: string, signal: AbortSignal) {
		await this.#gate("read", scope, commandId, null, signal);
		return this.#invoke("read", commandId, null, signal);
	}
	async cancel(scope: CloudCodingCommandScope, commandId: string, signal: AbortSignal) {
		await this.#gate("cancel", scope, commandId, null, signal);
		return this.#invoke("cancel", commandId, null, signal);
	}
}
