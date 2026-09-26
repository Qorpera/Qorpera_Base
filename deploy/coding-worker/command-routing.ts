import { isDeepStrictEqual } from "node:util";
import { createHttpCloudCodingCommandGateway, type CloudCodingCommandHttpRequest } from "../../packages/runtime/src/cloud-coding-command-http.ts";
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
	executeLocal(request: CloudCodingCommandHttpRequest, signal: AbortSignal): Promise<unknown>;
	fetch?: typeof fetch;
}
export class CodingCommandRouter {
	readonly #options: CodingCommandRouterOptions;
	constructor(options: CodingCommandRouterOptions) {
		this.#options = { ...options, peers: options.peers.map((peer) => Object.freeze({ ...peer })) };
	}
	async execute(request: CloudCodingCommandHttpRequest, signal: AbortSignal, localOnly = false): Promise<unknown> {
		await authorizeCodingCommand(this.#options.control, request, signal);
		const value = await this.#options.control.call("qorpera_route_coding_command", {
			p_binding: request.binding, p_scope: request.scope, p_action: request.action,
			p_command_id: request.input.commandId,
			p_input_sha256: request.action === "start" ? request.input.inputSha256 : null,
		}, signal);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_COMMAND_ROUTE_INVALID");
		const route = value as Record<string, unknown>;
		if (Object.keys(route).sort().join() !== "executorOwner,machineId,providerId,schema" ||
			route.schema !== "qorpera.coding-command-route/v1" || route.machineId !== request.scope.vmId ||
			typeof route.executorOwner !== "string" || typeof route.providerId !== "string") throw new Error("CODING_COMMAND_ROUTE_INVALID");
		signal.throwIfAborted();
		if (route.executorOwner === this.#options.owner && route.providerId === this.#options.providerId)
			return this.#options.executeLocal(request, signal);
		if (localOnly) throw new Error("CODING_COMMAND_WRONG_EXECUTOR");
		const peer = this.#options.peers.find((entry) => entry.owner === route.executorOwner && entry.providerId === route.providerId);
		if (!peer) throw new Error("CODING_COMMAND_ROUTE_UNAVAILABLE");
		const gateway = createHttpCloudCodingCommandGateway({
			url: peer.origin, token: await this.#options.credential(peer.tokenCredential), binding: request.binding,
			authorize: async (scope, _identity, checked) => {
				if (!isDeepStrictEqual(scope, request.scope)) throw new Error("CODING_COMMAND_REQUEST_CHANGED");
				await authorizeCodingCommand(this.#options.control, request, checked);
			},
			fetch: this.#options.fetch,
		});
		// No retry: an uncertain start remains uncertain. The receiving peer has
		// its own credential, rechecks SQL and may only execute locally.
		return request.action === "start" ? gateway.start(request.scope, request.input, signal) :
			request.action === "read" ? gateway.read(request.scope, request.input, signal) :
			gateway.cancel(request.scope, request.input.commandId, signal);
	}
}
