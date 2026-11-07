import type { CloudMachineCommandReceipt } from "../../packages/contracts/src/cloud-machine.ts";
import {
	CLOUD_MACHINE_WAKE_WAIT_MS,
	type CloudMachineCommandHttpRequest,
	CloudMachineCommandRefusal,
	type CloudMachineWakeHttpRequest,
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
	/** Asks this node's machines for a pass now; with a wait, true once a step took the machine somewhere. Absent when the executor carries no machines. */
	wakeLocal?(machineId: string, wait: boolean, signal: AbortSignal): Promise<boolean>;
	fetch?: typeof fetch;
}

/** True as soon as one is true, false once all said no. */
function anyTold(asked: readonly Promise<boolean>[]): Promise<boolean> {
	return new Promise((settle) => {
		for (const one of asked) void one.then((told) => { if (told) settle(true); });
		void Promise.all(asked).then(() => settle(false));
	});
}

/** Like coding commands: SQL names the machine's executor, and only an owner
 * in this deployment's peer allowlist is ever a destination. */
export class MachineCommandRouter {
	readonly #options: MachineCommandRouterOptions;
	constructor(options: MachineCommandRouterOptions) {
		this.#options = { ...options, peers: options.peers.map((peer) => Object.freeze({ ...peer })) };
	}
	/** A wake goes to this node's machines and to every peer's: a machine in line has no node yet, and any executor's pass
	 * may admit it. It asks nothing of SQL: each step of that pass does. The answer comes from this node's machines when it
	 * has them, otherwise from the first peer that was told. */
	async wake(request: CloudMachineWakeHttpRequest, signal: AbortSignal, localOnly = false): Promise<boolean> {
		const bounded = AbortSignal.any([signal, AbortSignal.timeout(CLOUD_MACHINE_WAKE_WAIT_MS)]);
		const { wait } = request.input;
		const local = this.#options.wakeLocal?.(request.scope.machineId, wait, bounded);
		const peers = localOnly ? [] : this.#options.peers.map(async (peer) => {
			const gateway = createHttpCloudMachineCommandGateway({
				url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
				holder: null, fetch: this.#options.fetch,
			});
			return (await gateway.wake?.(request.scope, wait, bounded)) === true;
		}).map((asked) => asked.catch(() => false));
		const asked = local ? [local, ...peers] : peers;
		return wait ? anyTold(asked) : Promise.all(asked).then(() => false);
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
			throw refusal ? new CloudMachineCommandRefusal(refusal, error instanceof CloudMachineCommandRefusal ? error.folderLost : undefined) : error;
		}
	}
}

/** How a router reaches this node's machines for a wake (MachineCommandRouter's `wakeLocal`). */
export function localMachineWake(host: {
	wake(): void;
	changed(machineId: string, signal: AbortSignal): Promise<boolean>;
}): (machineId: string, wait: boolean, signal: AbortSignal) => Promise<boolean> {
	return async (machineId, wait, signal) => {
		if (wait) return host.changed(machineId, signal);
		host.wake();
		return false;
	};
}

/** The machine routes of an executor's command service: its ingress (`localOnly` false), or its peer listener (true), which
 * never forwards. */
export function machineCommandRoutes(
	router: MachineCommandRouter,
	control: MachineCommandRouterOptions["control"],
	localOnly: boolean,
): {
	authorize(request: CloudMachineCommandHttpRequest, signal: AbortSignal): Promise<MachineCommandAuthority>;
	execute(request: CloudMachineCommandHttpRequest, signal: AbortSignal): Promise<CloudMachineCommandReceipt>;
	wake(request: CloudMachineWakeHttpRequest, signal: AbortSignal): Promise<boolean>;
} {
	return {
		authorize: (request, signal) => authorizeMachineCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal, localOnly),
		wake: (request, signal) => router.wake(request, signal, localOnly),
	};
}
