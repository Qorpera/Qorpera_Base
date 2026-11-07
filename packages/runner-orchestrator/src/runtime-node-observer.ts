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
import { readNodeReleaseImages } from "./runtime-node-releases.ts";
import { timeOrderedUuid } from "./time-ordered-uuid.ts";

export type RuntimeNodeObserverMethod =
	| "qorpera_runtime_node_inventory_context"
	| "qorpera_observe_runtime_node_inventory"
	| "qorpera_observe_runtime_node_health"
	| "qorpera_observe_runtime_node_agent_exit"
	| "qorpera_observe_runtime_node";
export interface RuntimeNodeObserverRegistry {
	call(method: RuntimeNodeObserverMethod, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

const CODE = /^[A-Z][A-Z0-9_]{1,127}$/;
/** Why a look was not ready, for the observer's log line: the step that stopped it (`check`) and the closed code it
 * stopped with. An unavailable inventory also names the kinds of entry that kept it so (`category:REASON`), never an
 * instance. No values: no names, versions, digests, ids or paths. */
export interface RuntimeNodeObserverReason {
	check: string;
	code: string;
	entries?: string[];
}
/** A failure whose message stays the fixed code callers match, carrying the closed code that caused it and, for a
 * look, the step it was in. */
export class RuntimeNodeObserverFailure extends Error {
	readonly code: string;
	readonly check: string | null;
	constructor(message: string, code: string, check: string | null = null) {
		super(message);
		this.name = "RuntimeNodeObserverFailure";
		this.code = CODE.test(code) ? code : "UNCODED";
		this.check = check;
	}
}
/** An error's closed code: a failure's own, a message or a Node system code that is one, a timeout or a cancellation by
 * its name, else UNCODED. Never an error's text. */
export function runtimeNodeObserverCode(error: unknown): string {
	if (error instanceof RuntimeNodeObserverFailure) return error.code;
	const { message, code, name } = (error ?? {}) as { message?: unknown; code?: unknown; name?: unknown };
	const found = [message, code].find((value) => typeof value === "string" && CODE.test(value));
	if (typeof found === "string") return found;
	return name === "TimeoutError" ? "TIMED_OUT" : name === "AbortError" ? "ABORTED" : "UNCODED";
}
/** The reason a look that ended early gives: its own step when it names one, else `check`. */
export function runtimeNodeObserverFailureReason(error: unknown, check: string): RuntimeNodeObserverReason {
	return {
		check: error instanceof RuntimeNodeObserverFailure && error.check ? error.check : check,
		code: runtimeNodeObserverCode(error),
	};
}

async function physicalHost(policy: RuntimeNodeInventoryPolicy, signal: AbortSignal) {
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
	readonly #releases: () => Promise<ReadonlySet<string>>;
	#pending = false;
	constructor(
		policy: RuntimeNodeInventoryPolicy,
		registry: RuntimeNodeObserverRegistry,
		ports?: {
			lxd?: LxdHostInventoryClient;
			host?: typeof physicalHost;
			releases?: () => Promise<ReadonlySet<string>>;
		},
	) {
		this.#policy = parseRuntimeNodeInventoryPolicy(policy);
		this.#registry = registry;
		this.#lxd = ports?.lxd ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#host = ports?.host ?? physicalHost;
		this.#releases = ports?.releases ?? (() => readNodeReleaseImages());
	}
	async observe(caller: AbortSignal): Promise<{
		state: "ready" | "unavailable";
		observationId: string;
		/** Why it is unavailable; null when ready. */
		reason: RuntimeNodeObserverReason | null;
	}> {
		caller.throwIfAborted();
		if (this.#pending) throw new Error("NODE_OBSERVER_BUSY");
		this.#pending = true;
		// The step under way, or the last one started: what a look that is not ready names.
		let check = "host";
		try {
			const signal = AbortSignal.any([caller, AbortSignal.timeout(15000)]),
				started = performance.now();
			const observedAt = new Date().toISOString(),
				observationId = timeOrderedUuid();
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
				args: Record<string, unknown> = { p_observation: observation },
				reason: RuntimeNodeObserverReason | null = null;
			try {
				check = "context";
				const context = parseRuntimeNodeInventoryContext(
					await this.#registry.call(
						"qorpera_runtime_node_inventory_context",
						{ p_node_id: this.#policy.nodeId },
						signal,
					),
				);
				check = "policy";
				if (!isDeepStrictEqual(context.policy, this.#policy)) throw new Error("NODE_OBSERVER_POLICY_DIFFERS");
				check = "inventory";
				const inventory = await this.#lxd.inspectHostInventory(signal);
				check = "host-again";
				const after = await this.#host(this.#policy, signal);
				if (!isDeepStrictEqual(before, after)) throw new Error("NODE_OBSERVER_HOST_CHANGED");
				check = "releases";
				// Only an entry listed by role needs the node's signed releases.
				const released = this.#policy.infrastructure.some((i) => i.role)
					? await this.#releases()
					: new Set<string>();
				signal.throwIfAborted();
				check = "reconcile";
				const reconciled = reconcileRuntimeNodeInventory(inventory, context, released);
				observation.state = reconciled.state;
				if (reconciled.state === "unavailable")
					reason = {
						check,
						code: reconciled.headroomValid
							? "NODE_INVENTORY_ENTRY_UNAVAILABLE"
							: "NODE_INVENTORY_HEADROOM_EXCEEDED",
						entries: [
							...new Set(reconciled.entries.flatMap((e) => (e.reason ? [`${e.category}:${e.reason}`] : []))),
						].sort(),
					};
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
			} catch (error) {
				// A failed scan publishes unavailable, never a fabricated empty
				// ready host. Cancellation cannot open a new outbound request.
				observation.state = "unavailable";
				reason = { check, code: runtimeNodeObserverCode(error) };
			}
			signal.throwIfAborted();
			if (performance.now() - started >= 15000) throw new Error("NODE_OBSERVER_EXPIRED");
			check = "publish";
			// Keep submission outside the scan catch: an ambiguous publication
			// never retries the same ID with different bytes or a new timestamp.
			const result = await this.#registry.call(method, args, signal);
			check = "receipt";
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
			return { state: observation.state as "ready" | "unavailable", observationId, reason };
		} catch (error) {
			throw new RuntimeNodeObserverFailure("NODE_OBSERVER_UNCONFIRMED", runtimeNodeObserverCode(error), check);
		} finally {
			this.#pending = false;
		}
	}
}
