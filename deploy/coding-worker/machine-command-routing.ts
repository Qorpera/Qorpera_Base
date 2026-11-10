import type { CloudMachineCommandReceipt } from "../../packages/contracts/src/cloud-machine.ts";
import type {
	CompanyMachineCodingValue, CompanyMachineCodingValueOutcome, CompanyMachineMemberLook, CompanyMachineMemberLookOutcome,
	CompanyMachineScreen, CompanyMachineScreenOutcome,
} from "../../packages/runner-orchestrator/src/company-machine-host.ts";
import {
	CLOUD_MACHINE_CODING_VALUE_SCHEMA,
	CLOUD_MACHINE_SCREEN_SCHEMA,
	CLOUD_MACHINE_WAKE_WAIT_MS,
	type CloudMachineCodingValueAnswer,
	CloudMachineCodingValueRefusal,
	type CloudMachineCodingValueHttpRequest,
	type CloudMachineCommandHttpRequest,
	CloudMachineCommandRefusal,
	type CloudMachineScreenAnswer,
	type CloudMachineScreenHttpRequest,
	CloudMachineScreenRefusal,
	type CloudMachineWakeHttpRequest,
	type CloudMemberMachineScreen,
	type CloudMemberMachineScreenPeerRequest,
	CloudMemberMachineScreenRefusal,
	cloudMachineCommandRefusal,
	createHttpCloudMachineCommandGateway,
	createHttpMemberMachineScreenPeer,
	isCloudMachineCodingValueRefusal,
	isCloudMachineScreenRefusal,
} from "../../packages/runtime/src/cloud-machine-command-http.ts";
import type { CloudMemberMachineScreenLook } from "../../packages/runtime/src/cloud-member-machine-screen-http.ts";
import { MACHINE_SCREEN_REQUEST_SCHEMA, parseMachineScreenHeader } from "../../packages/runtime/src/cloud-machine-screen.ts";
import type { CodingCommandPeer } from "./command-routing.ts";
import {
	authorizeMachineCodingValue, authorizeMachineCommand, authorizeMachineScreen, authorizeMemberMachineScreen,
	type MachineCodingValueAuthority, type MachineCommandAuthority, type MachineScreenAuthority, type MemberMachineScreenAuthority,
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
	/** machine_screen (20260930708000): runs the screen helper on this node's machine; absent when the executor carries no machines. */
	screenLocal?(authority: MachineScreenAuthority, signal: AbortSignal): Promise<CloudMachineScreenAnswer>;
	/** A member's look (20260930712000): begins it as the member (member-control.ts); absent when this executor takes no
	 * member's requests (only the node behind the member bridge does). */
	memberBegin?(token: string, look: { companyId: string; machineId: string; confirmed: boolean }, signal: AbortSignal): Promise<string>;
	/** A member's look at this node's machine; absent when the executor carries no machines. */
	memberScreenLocal?(authority: MemberMachineScreenAuthority, etag: string | null, signal: AbortSignal): Promise<CloudMemberMachineScreen>;
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
	/** machine_screen (20260930708000): SQL names the machine's executor, as for a command. This node runs the helper; another
	 * node's executor is sent the request once (it reads SQL again and only runs it locally): an action is never sent twice.
	 * Its refusal reaches the agent as the same refusal (a 409 with its code). */
	async screen(request: CloudMachineScreenHttpRequest, signal: AbortSignal, localOnly = false): Promise<CloudMachineScreenAnswer> {
		const authority = await authorizeMachineScreen(this.#options.control, request, signal);
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.screenLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.screenLocal(authority, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudMachineCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			holder: null, fetch: this.#options.fetch,
		});
		if (!gateway.screen) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return gateway.screen(request.scope, request.input, signal);
	}
	/** A member's look at a desktop (20260930712000), as this executor's member listener took it: begun as the member (the
	 * database checks their token and answers a single-use id), then read again as the executor, and looked at on this
	 * node or sent once to the machine's node. */
	async memberScreen(look: CloudMemberMachineScreenLook, signal: AbortSignal): Promise<CloudMemberMachineScreen> {
		if (!this.#options.memberBegin) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		const useId = await this.#options.memberBegin(look.token, { companyId: look.companyId, machineId: look.machineId,
			confirmed: look.confirmed }, signal);
		return this.#memberServe(useId, look.etag, signal, false);
	}
	/** A member's look another executor sent here (the peer listener): read again, and looked at on this node only. */
	memberScreenPeer(request: CloudMemberMachineScreenPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineScreen> {
		return this.#memberServe(request.useId, request.etag, signal, true);
	}
	/** SQL names the machine's executor, as for a command, and serves the use only to it, once: this node looks, or
	 * another node's executor is sent the use once (it reads SQL again, which serves it there, and never forwards). */
	async #memberServe(useId: string, etag: string | null, signal: AbortSignal, localOnly: boolean): Promise<CloudMemberMachineScreen> {
		const authority = await authorizeMemberMachineScreen(this.#options.control,
			{ useId, owner: this.#options.owner, providerId: this.#options.providerId }, signal);
		if (authority.served) {
			if (!this.#options.memberScreenLocal) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
			return this.#options.memberScreenLocal(authority, etag, signal);
		}
		if (localOnly) throw new Error("MACHINE_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId);
		if (!peer) throw new Error("MACHINE_COMMAND_ROUTE_UNAVAILABLE");
		return createHttpMemberMachineScreenPeer({ url: peer.origin, token: await this.#options.credential(peer.tokenCredential),
			fetch: this.#options.fetch }).memberScreen({ useId, etag }, signal);
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

/** How a router runs machine_screen's helper on this node's machines (MachineCommandRouter's `screenLocal`): the helper's
 * request as SQL authorized it; the host's header and PNG (base64) are the answer, a code the agent can act on its
 * refusal, and any other code a failure. */
export function localMachineScreen(host: {
	screen(run: CompanyMachineScreen, signal: AbortSignal): Promise<CompanyMachineScreenOutcome>;
}): (authority: MachineScreenAuthority, signal: AbortSignal) => Promise<CloudMachineScreenAnswer> {
	return async (authority, signal) => {
		const outcome = await host.screen({ placementId: authority.placementId, bootId: authority.bootId, runId: authority.runId,
			request: { schema: MACHINE_SCREEN_REQUEST_SCHEMA, receiptId: authority.receiptId, action: authority.action,
				settleMs: authority.settleMs, look: authority.look } }, signal);
		if ("refused" in outcome) {
			if (isCloudMachineScreenRefusal(outcome.refused)) throw new CloudMachineScreenRefusal(outcome.refused);
			throw new Error("MACHINE_SCREEN_FAILED");
		}
		return { schema: CLOUD_MACHINE_SCREEN_SCHEMA, commandId: authority.receiptId, header: parseMachineScreenHeader(outcome.header),
			png: outcome.png ? outcome.png.toString("base64") : null, ...(outcome.heldBack !== undefined ? { heldBack: outcome.heldBack } : {}) };
	};
}

/** How a router looks at this node's machine for a member (MachineCommandRouter's `memberScreenLocal`): the host's
 * picture and its etag, or no picture when the member has it (their etag is the picture's); the screen off, a restarted
 * machine and an image without scrot as the member's refusals; a held picture as SCREEN_HIDDEN (the machine holds a read
 * the member may not read) or SCREEN_HELD (look again), with nothing of the picture. */
export function localMemberMachineScreen(host: {
	memberLook(look: CompanyMachineMemberLook, signal: AbortSignal): Promise<CompanyMachineMemberLookOutcome>;
}): (authority: MemberMachineScreenAuthority, etag: string | null, signal: AbortSignal) => Promise<CloudMemberMachineScreen> {
	return async (authority, etag, signal) => {
		const outcome = await host.memberLook({ placementId: authority.placementId, bootId: authority.bootId,
			userId: authority.userId, keepDesktop: authority.keepDesktop }, signal);
		if ("refused" in outcome) throw new CloudMemberMachineScreenRefusal(outcome.refused);
		if ("held" in outcome) throw new CloudMemberMachineScreenRefusal(outcome.held === "hidden" ? "SCREEN_HIDDEN" : "SCREEN_HELD");
		return { etag: outcome.etag, png: outcome.etag === etag ? null : outcome.png };
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
	screen(request: CloudMachineScreenHttpRequest, signal: AbortSignal): Promise<CloudMachineScreenAnswer>;
	memberScreen?(request: CloudMemberMachineScreenPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineScreen>;
} {
	return {
		authorize: (request, signal) => authorizeMachineCommand(control, request, signal),
		execute: (request, signal) => router.execute(request, signal, localOnly),
		wake: (request, signal) => router.wake(request, signal, localOnly),
		codingValue: (request, signal) => router.codingValue(request, signal, localOnly),
		screen: (request, signal) => router.screen(request, signal, localOnly),
		// A member's look comes from another executor only, on the peer listener; a guest's ingress has none.
		...(localOnly ? { memberScreen: (request: CloudMemberMachineScreenPeerRequest, signal: AbortSignal) => router.memberScreenPeer(request, signal) } : {}),
	};
}
