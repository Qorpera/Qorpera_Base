import type { CloudMachineCommandReceipt } from "../../packages/contracts/src/cloud-machine.ts";
import type {
	CompanyMachineAccountFill, CompanyMachineAccountFillOutcome, CompanyMachineAccountFillSeal, CompanyMachineCodingValue,
	CompanyMachineCodingValueOutcome,
} from "../../packages/runner-orchestrator/src/company-machine-host.ts";
import {
	CLOUD_MACHINE_ACCOUNT_FILL_SCHEMA,
	type CloudMachineAccountFillAnswer,
	type CloudMachineAccountFillHttpRequest,
	CloudMachineAccountFillRefusal,
	CLOUD_MACHINE_CODING_VALUE_SCHEMA,
	CLOUD_MACHINE_WAKE_WAIT_MS,
	type CloudMachineCodingValueAnswer,
	CloudMachineCodingValueRefusal,
	type CloudMachineCodingValueHttpRequest,
	type CloudMachineCommandHttpRequest,
	CloudMachineCommandRefusal,
	type CloudMachineWakeHttpRequest,
	cloudMachineCommandRefusal,
	createHttpCloudMachineCommandGateway,
	isCloudMachineAccountFillRefusal,
	isCloudMachineCodingValueRefusal,
} from "../../packages/runtime/src/cloud-machine-command-http.ts";
import type { CodingCommandPeer } from "./command-routing.ts";
import type { MachineAccountFillSealRequest } from "./machine-account-fill-broker.ts";
import {
	authorizeMachineAccountFill, authorizeMachineCodingValue, authorizeMachineCommand, type MachineAccountFillAuthority,
	type MachineCodingValueAuthority, type MachineCommandAuthority,
} from "./machine-command-authority.ts";

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
	/** save_coding_value (20260930705000): runs the clipboard helper on this node's machine; absent when the executor carries no machines. */
	codingValueLocal?(authority: MachineCodingValueAuthority, signal: AbortSignal): Promise<CloudMachineCodingValueAnswer>;
	/** fill_company_account (20260930711000): runs the fill helper on this node's machine, asking the vault for the box;
	 * absent when the executor carries no machines or has no broker. */
	accountFillLocal?(
		request: CloudMachineAccountFillHttpRequest,
		authority: MachineAccountFillAuthority,
		signal: AbortSignal,
	): Promise<CloudMachineAccountFillAnswer>;
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
	/** save_coding_value (20260930705000): SQL names the machine's executor, as for a command. This node runs the helper; another
	 * node's executor is sent the request once (it reads SQL again and only runs it locally): the helper clears the clipboard, so a
	 * send again would find nothing. Its refusal reaches the agent as the same refusal (a 409 with its code). */
	async codingValue(request: CloudMachineCodingValueHttpRequest, signal: AbortSignal, localOnly = false): Promise<CloudMachineCodingValueAnswer> {
		const authority = await authorizeMachineCodingValue(this.#options.control, request, signal);
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.codingValueLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.codingValueLocal(authority, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudMachineCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			holder: null, fetch: this.#options.fetch,
		});
		if (!gateway.codingValue) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return gateway.codingValue(request.scope, request.input, signal);
	}
	/** fill_company_account (20260930711000): SQL names the machine's executor, as for a command. This node runs the helper
	 * and asks the vault; another node's executor is sent the request once (it reads SQL again and only runs it locally).
	 * Its refusal reaches the agent as the same refusal (a 409 with its code, and the vault's words). */
	async accountFill(request: CloudMachineAccountFillHttpRequest, signal: AbortSignal, localOnly = false): Promise<CloudMachineAccountFillAnswer> {
		const authority = await authorizeMachineAccountFill(this.#options.control, request, signal);
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.accountFillLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.accountFillLocal(request, authority, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudMachineCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			holder: null, fetch: this.#options.fetch,
		});
		if (!gateway.accountFill) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return gateway.accountFill(request.scope, request.input, signal);
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

/** How a router runs save_coding_value's helper on this node's machines (MachineCommandRouter's `codingValueLocal`): the
 * host's box is the answer, a code the agent can act on its refusal, and any other code a failure. */
export function localMachineCodingValue(host: {
	codingValue(run: CompanyMachineCodingValue, signal: AbortSignal): Promise<CompanyMachineCodingValueOutcome>;
}): (authority: MachineCodingValueAuthority, signal: AbortSignal) => Promise<CloudMachineCodingValueAnswer> {
	return async (authority, signal) => {
		const outcome = await host.codingValue({ placementId: authority.placementId, bootId: authority.bootId,
			receiptId: authority.receiptId, target: authority.target }, signal);
		if ("refused" in outcome) {
			if (isCloudMachineCodingValueRefusal(outcome.refused)) throw new CloudMachineCodingValueRefusal(outcome.refused);
			throw new Error("MACHINE_CODING_VALUE_FAILED");
		}
		return { schema: CLOUD_MACHINE_CODING_VALUE_SCHEMA, commandId: authority.receiptId, box: outcome.box };
	};
}

/** How a router runs fill_company_account's helper on this node's machines (MachineCommandRouter's `accountFillLocal`):
 * the helper's key goes to the vault (`seal`, the executor's broker client) with the run's call and where the helper runs;
 * typed is the answer, a code the agent can act on (or the vault's refusal, with its words) its refusal, and any other
 * code a failure. */
export function localMachineAccountFill(
	host: {
		accountFill(run: CompanyMachineAccountFill, seal: CompanyMachineAccountFillSeal, signal: AbortSignal): Promise<CompanyMachineAccountFillOutcome>;
	},
	vault: { seal(request: MachineAccountFillSealRequest, signal: AbortSignal): ReturnType<CompanyMachineAccountFillSeal> },
): (request: CloudMachineAccountFillHttpRequest, authority: MachineAccountFillAuthority, signal: AbortSignal) => Promise<CloudMachineAccountFillAnswer> {
	return async (request, authority, signal) => {
		const outcome = await host.accountFill({ placementId: authority.placementId, bootId: authority.bootId,
			receiptId: authority.receiptId, target: authority.target },
		(publicKey, sealSignal) => vault.seal({ companyId: authority.companyId, binding: request.binding, receiptId: authority.receiptId,
			idempotencyKey: request.input.idempotencyKey, envelope: request.input.envelope, placementId: authority.placementId,
			bootId: authority.bootId, fillPublicKey: publicKey }, sealSignal), signal);
		if ("vaultRefused" in outcome) throw new CloudMachineAccountFillRefusal("VAULT_REFUSED", outcome.vaultRefused.message);
		if ("refused" in outcome) {
			if (isCloudMachineAccountFillRefusal(outcome.refused)) throw new CloudMachineAccountFillRefusal(outcome.refused);
			throw new Error("MACHINE_ACCOUNT_FILL_FAILED");
		}
		return { schema: CLOUD_MACHINE_ACCOUNT_FILL_SCHEMA, commandId: authority.receiptId, filled: true };
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
	codingValue(request: CloudMachineCodingValueHttpRequest, signal: AbortSignal): Promise<CloudMachineCodingValueAnswer>;
	accountFill(request: CloudMachineAccountFillHttpRequest, signal: AbortSignal): Promise<CloudMachineAccountFillAnswer>;
} {
	return {
		authorize: (request, signal) => authorizeMachineCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal, localOnly),
		wake: (request, signal) => router.wake(request, signal, localOnly),
		codingValue: (request, signal) => router.codingValue(request, signal, localOnly),
		accountFill: (request, signal) => router.accountFill(request, signal, localOnly),
	};
}
