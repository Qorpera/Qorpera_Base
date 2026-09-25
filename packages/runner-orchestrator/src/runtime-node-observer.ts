import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type LxdHostInventoryClient, LxdUnixClient } from "./lxd-client.ts";
import { inspectLxdHostInventorySocket } from "./lxd-office-physical-host.ts";
import { readRuntimeNodeHost } from "./runtime-node-host.ts";
import {
	parseRuntimeNodeInventoryContext,
	parseRuntimeNodeInventoryPolicy,
	type RuntimeNodeInventoryPolicy,
	reconcileRuntimeNodeInventory,
} from "./runtime-node-inventory.ts";

export type RuntimeNodeObserverMethod =
	| "qorpera_runtime_node_inventory_context"
	| "qorpera_observe_runtime_node_inventory"
	| "qorpera_observe_runtime_node_health"
	| "qorpera_observe_runtime_node";
export interface RuntimeNodeObserverRegistry {
	call(method: RuntimeNodeObserverMethod, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export async function physicalHost(policy: RuntimeNodeInventoryPolicy, signal: AbortSignal) {
	const socket = await inspectLxdHostInventorySocket(policy.host, signal),
		hardware = await readRuntimeNodeHost(signal);
	if (hardware.machineIdSha256 !== policy.host.machineIdSha256) throw new Error("NODE_OBSERVER_HOST_DIFFERS");
	return { ...socket, ...hardware };
}
export type RuntimeNodeObserverHost = Awaited<ReturnType<typeof physicalHost>>;

/** One measurement at a time, with no overlapping replacement after timeout.
 * The deployed composition always uses protected host evidence and the local
 * Unix daemon. Ports permit explicit fixture evidence in offline tests. */
export class RuntimeNodeInventoryObserver {
	readonly #policy: RuntimeNodeInventoryPolicy;
	readonly #registry: RuntimeNodeObserverRegistry;
	readonly #lxd: LxdHostInventoryClient;
	readonly #host: typeof physicalHost;
	#pending = false;
	constructor(
		policy: RuntimeNodeInventoryPolicy,
		registry: RuntimeNodeObserverRegistry,
		ports?: { lxd?: LxdHostInventoryClient; host?: typeof physicalHost },
	) {
		this.#policy = parseRuntimeNodeInventoryPolicy(policy);
		this.#registry = registry;
		this.#lxd = ports?.lxd ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#host = ports?.host ?? physicalHost;
	}
	async observe(caller: AbortSignal): Promise<{ state: "ready" | "unavailable"; observationId: string }> {
		caller.throwIfAborted();
		if (this.#pending) throw new Error("NODE_OBSERVER_BUSY");
		this.#pending = true;
		try {
			const signal = AbortSignal.any([caller, AbortSignal.timeout(15000)]),
				started = performance.now();
			const observedAt = new Date().toISOString(),
				observationId = randomUUID();
			const before = await this.#host(this.#policy, signal);
			signal.throwIfAborted();
			const observation = {
				schema: "qorpera.runtime-node-observation/v1",
				nodeId: this.#policy.nodeId,
				machineIdSha256: before.machineIdSha256,
				observationId,
				observedAt,
				cpuMillis: before.cpuMillis,
				memoryBytes: before.memoryBytes,
				state: "unavailable",
			};
			let method: RuntimeNodeObserverMethod = "qorpera_observe_runtime_node",
				args: Record<string, unknown> = { p_observation: observation };
			try {
				const context = parseRuntimeNodeInventoryContext(
					await this.#registry.call(
						"qorpera_runtime_node_inventory_context",
						{ p_node_id: this.#policy.nodeId },
						signal,
					),
				);
				if (!isDeepStrictEqual(context.policy, this.#policy)) throw new Error("NODE_OBSERVER_POLICY_DIFFERS");
				const inventory = await this.#lxd.inspectHostInventory(signal);
				const after = await this.#host(this.#policy, signal);
				if (!isDeepStrictEqual(before, after)) throw new Error("NODE_OBSERVER_HOST_CHANGED");
				const reconciled = reconcileRuntimeNodeInventory(inventory, context);
				observation.state = reconciled.state;
				method = "qorpera_observe_runtime_node_inventory";
				args = {
					p_observation: observation,
					p_context_sha256: context.contextSha256,
					p_inventory: {
						schema: "qorpera.runtime-node-inventory/v1",
						bootId: before.bootId,
						entries: reconciled.entries,
					},
				};
			} catch {
				// A failed scan publishes unavailable, never a fabricated empty
				// ready host. Cancellation cannot open a new outbound request.
				observation.state = "unavailable";
			}
			signal.throwIfAborted();
			if (performance.now() - started >= 15000) throw new Error("NODE_OBSERVER_EXPIRED");
			// Keep submission outside the scan catch: an ambiguous publication
			// never retries the same ID with different bytes or a new timestamp.
			const result = await this.#registry.call(method, args, signal);
			signal.throwIfAborted();
			if (!result || typeof result !== "object" || Array.isArray(result))
				throw new Error("NODE_OBSERVER_PUBLICATION_UNCONFIRMED");
			const r = result as Record<string, unknown>;
			if (
				Object.keys(r).sort().join() !== "nodeId,observationId,observedAt" ||
				r.nodeId !== this.#policy.nodeId ||
				r.observationId !== observationId ||
				typeof r.observedAt !== "string" ||
				Date.parse(r.observedAt) !== Date.parse(observedAt)
			)
				throw new Error("NODE_OBSERVER_PUBLICATION_UNCONFIRMED");
			return { state: observation.state as "ready" | "unavailable", observationId };
		} catch {
			throw new Error("NODE_OBSERVER_UNCONFIRMED");
		} finally {
			this.#pending = false;
		}
	}
}
