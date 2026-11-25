import { isDeepStrictEqual } from "node:util";
import {
	type CloudCodingCommandAuthority,
	type CloudCodingCommandExecution,
	type CloudCodingCommandHttpRequest,
	type CloudCodingCommandRoute,
	createHttpCloudCodingCommandGateway,
} from "../../packages/runtime/src/cloud-coding-command-http.ts";
import { CloudCommandPages } from "../../packages/runtime/src/cloud-command-pages.ts";
import {
	type CloudCodingChannelAuthorized,
	type CloudCodingChannelRequest,
	CloudHomeChannelRefused,
	type CloudHomeChannelSide,
} from "../../packages/runtime/src/cloud-home-channel.ts";
import { createCloudCodingChannel } from "../../packages/runtime/src/cloud-home-channel-client.ts";
import { authorizeCodingCommand } from "./command-authority.ts";

export interface CodingCommandPeer {
	owner: string;
	providerId: string;
	origin: string;
	tokenCredential: string;
}

/** The SQL placement selects only an identity in this deployment's allowlist.
 * Neither model arguments nor database values become network destinations. */
interface CodingCommandRouterOptions {
	owner: string;
	providerId: string;
	peers: readonly CodingCommandPeer[];
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	credential(name: string): Promise<string>;
	executeLocal(
		request: CloudCodingCommandHttpRequest,
		signal: AbortSignal,
		authority?: CloudCodingCommandAuthority,
	): Promise<CloudCodingCommandExecution>;
	openChannelLocal?(
		authority: CloudCodingChannelAuthorized,
		request: CloudCodingChannelRequest,
		signal: AbortSignal,
	): Promise<CloudHomeChannelSide>;
	fetch?: typeof fetch;
}

const CHANNEL_REFUSALS = new Map<string, string>([
	["CODING_CODEX_NOT_PINNED", "CODING_CODEX_NOT_PINNED"],
	["CODING_SFTP_MISSING", "CODING_SFTP_MISSING"],
	["CODING_BOOT_CHANGED", "CODING_BOOT_CHANGED"],
	["CODING_CHANNEL_UNSUPPORTED", "CODING_CHANNEL_UNSUPPORTED"],
	["CODING_HOST_TURN_NOT_PREPARED", "MACHINE_NOT_RUNNING"],
	["CODING_HOST_MACHINE_REFUSED:MACHINE_NEW_DISK", "MACHINE_NEW_DISK"],
]);
export class CodingCommandRouter {
	readonly #options: CodingCommandRouterOptions;
	/** What each peer said it takes for a page of a command's log (keyholes S1), learned from its answers. */
	readonly #pages = new CloudCommandPages();
	constructor(options: CodingCommandRouterOptions) {
		this.#options = { ...options, peers: options.peers.map((peer) => Object.freeze({ ...peer })) };
	}
	async execute(
		request: CloudCodingCommandHttpRequest,
		signal: AbortSignal,
		localOnly = false,
		authority?: CloudCodingCommandAuthority,
	): Promise<CloudCodingCommandExecution> {
		let route: CloudCodingCommandRoute;
		if (authority?.route) {
			if (
				authority.route.schema !== "qorpera.coding-command-route/v1" ||
				authority.route.machineId !== request.scope.vmId ||
				typeof authority.route.executorOwner !== "string" ||
				typeof authority.route.providerId !== "string"
			)
				throw new Error("CODING_COMMAND_ROUTE_INVALID");
			route = authority.route;
		} else {
			await authorizeCodingCommand(this.#options.control, request, signal);
			const value = await this.#options.control.call("qorpera_route_coding_command", {
				p_binding: request.binding, p_scope: request.scope, p_action: request.action,
				p_command_id: request.input.commandId,
				p_input_sha256: request.action === "start" ? request.input.inputSha256 : null,
			}, signal);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_COMMAND_ROUTE_INVALID");
			const parsed = value as Record<string, unknown>;
			if (Object.keys(parsed).sort().join() !== "executorOwner,machineId,providerId,schema" ||
				parsed.schema !== "qorpera.coding-command-route/v1" || parsed.machineId !== request.scope.vmId ||
				typeof parsed.executorOwner !== "string" || typeof parsed.providerId !== "string") throw new Error("CODING_COMMAND_ROUTE_INVALID");
			route = parsed as unknown as CloudCodingCommandRoute;
		}
		signal.throwIfAborted();
		if (route.executorOwner === this.#options.owner && route.providerId === this.#options.providerId)
			return this.#options.executeLocal(request, signal, authority);
		if (localOnly) throw new Error("CODING_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === route.executorOwner && entry.providerId === route.providerId);
		if (!peer) throw new Error("CODING_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudCodingCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			// The peer listener takes no holder: this executor proved the guest's at its own ingress.
			holder: null,
			authorize: async (scope, _identity, checked) => {
				if (!isDeepStrictEqual(scope, request.scope)) throw new Error("CODING_COMMAND_REQUEST_CHANGED");
				await authorizeCodingCommand(this.#options.control, request, checked);
			},
			fetch: this.#options.fetch, pages: this.#pages,
		});
		// No retry: an uncertain start remains uncertain. The receiving peer has
		// its own credential, rechecks SQL and may only execute locally.
		const receipt = await (request.action === "start" ? gateway.start(request.scope, request.input, signal) :
			request.action === "read" ? gateway.read(request.scope, request.input, signal) :
			gateway.cancel(request.scope, request.input.commandId, signal));
		// F3 5g-5: the peer's own service decided what of the command its receipt shows, after its final authorization, on
		// the node that holds the machine and its disk. This executor's checks after it can only refuse the receipt.
		return { receipt, hidden: async () => undefined };
	}
	async openChannel(
		authority: CloudCodingChannelAuthorized,
		request: CloudCodingChannelRequest,
		signal: AbortSignal,
		localOnly = false,
	): Promise<CloudHomeChannelSide> {
		if (authority.executorOwner === this.#options.owner && authority.providerId === this.#options.providerId) {
			if (!this.#options.openChannelLocal) throw new Error("CODING_COMMAND_WRONG_EXECUTOR");
			try {
				return await this.#options.openChannelLocal(authority, request, signal);
			} catch (error) {
				const mapped = error instanceof Error ? CHANNEL_REFUSALS.get(error.message) : undefined;
				if (mapped) throw new CloudHomeChannelRefused(mapped);
				throw error;
			}
		}
		if (localOnly) throw new Error("CODING_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find(
			(entry) => entry.owner === authority.executorOwner && entry.providerId === authority.providerId,
		);
		if (!peer) throw new Error("CODING_COMMAND_ROUTE_UNAVAILABLE");
		const channel = createCloudCodingChannel({
			url: peer.origin,
			token: await this.#options.credential(peer.tokenCredential),
			binding: request.binding,
			holder: null,
		});
		return await channel.open({ scope: request.scope, kind: request.kind }, signal);
	}
}
