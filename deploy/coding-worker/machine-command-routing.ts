import type { CloudMachineCommandReceipt } from "../../packages/contracts/src/cloud-machine.ts";
import {
	type CloudMachineCommandHttpRequest,
	CloudMachineCommandRefusal,
	cloudMachineCommandRefusal,
	createHttpCloudMachineCommandGateway,
} from "../../packages/runtime/src/cloud-machine-command-http.ts";
import type { CodingCommandPeer } from "./command-routing.ts";
import { authorizeMachineCommand, type MachineCommandAuthority } from "./machine-command-authority.ts";

interface MachineCommandRouterOptions {
	owner: string;
	providerId: string;
	peers: readonly CodingCommandPeer[];
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	credential(name: string): Promise<string>;
	/** This node's machines; absent when the executor carries no machines. */
	executeLocal?(request: CloudMachineCommandHttpRequest, authority: MachineCommandAuthority, signal: AbortSignal): Promise<CloudMachineCommandReceipt>;
	fetch?: typeof fetch;
}

/** Like coding commands: SQL names the machine's executor, and only an owner
 * in this deployment's peer allowlist is ever a destination. */
export class MachineCommandRouter {
	readonly #options: MachineCommandRouterOptions;
	constructor(options: MachineCommandRouterOptions) {
		this.#options = { ...options, peers: options.peers.map((peer) => Object.freeze({ ...peer })) };
	}
	async execute(request: CloudMachineCommandHttpRequest, signal: AbortSignal, localOnly = false): Promise<CloudMachineCommandReceipt> {
		const authority = await authorizeMachineCommand(this.#options.control, request, signal);
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.executeLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.executeLocal(request, authority, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudMachineCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			// The peer listener takes no holder: this executor proved the guest's at its own ingress.
			holder: null, fetch: this.#options.fetch,
		});
		// No retry: an uncertain start remains uncertain. The receiving peer has
		// its own credential, rechecks SQL and may only execute locally; its
		// refusal reaches the agent as the same refusal.
		try {
			return await (request.action === "start" ? gateway.start(request.scope, request.input, signal) :
				request.action === "read" ? gateway.read(request.scope, request.input, signal) :
				gateway.cancel(request.scope, request.input.commandId, signal));
		} catch (error) {
			const refusal = cloudMachineCommandRefusal(error);
			throw refusal ? new CloudMachineCommandRefusal(refusal) : error;
		}
	}
}
