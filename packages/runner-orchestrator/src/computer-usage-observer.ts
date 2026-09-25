import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ComputerUsageOutbox } from "./computer-usage-outbox.ts";
import { type ComputerUsageRegistry, type ComputerUsageSample, usageUuid } from "./computer-usage-sample.ts";
import { LxdUnixClient } from "./lxd-client.ts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { parseLxdProcUptime } from "./lxd-proc-uptime.ts";
import {
	parseRuntimeNodeInventoryContext,
	parseRuntimeNodeInventoryPolicy,
	type RuntimeNodeInventoryPolicy,
	reconcileRuntimeNodeInventory,
} from "./runtime-node-inventory.ts";
import { physicalHost, type RuntimeNodeObserverRegistry } from "./runtime-node-observer.ts";

type Client = Pick<LxdUnixClient, "inspectHostInventory" | "readInstanceFile">;
type Registry = ComputerUsageRegistry & RuntimeNodeObserverRegistry;
/** Shadow only. A process lifetime and exact predecessor establish bounded
 * observation continuity. Missing IO/restarts never earn an inferred interval. */
export class RuntimeComputerUsageObserver {
	readonly #policy: RuntimeNodeInventoryPolicy;
	readonly #registry: Registry;
	readonly #client: Client;
	readonly #host: typeof physicalHost;
	readonly #outbox: ComputerUsageOutbox;
	readonly #now: () => Date;
	readonly #observerId = randomUUID();
	readonly #previous = new Map<string, string>();
	#pending = false;
	constructor(
		policy: RuntimeNodeInventoryPolicy,
		registry: Registry,
		outbox: ComputerUsageOutbox,
		ports?: { client?: Client; host?: typeof physicalHost; now?: () => Date },
	) {
		this.#policy = parseRuntimeNodeInventoryPolicy(policy);
		this.#registry = registry;
		this.#outbox = outbox;
		this.#client = ports?.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#host = ports?.host ?? physicalHost;
		this.#now = ports?.now ?? (() => new Date());
	}
	async observe(caller: AbortSignal): Promise<void> {
		if (this.#pending) throw new Error("COMPUTER_USAGE_OBSERVER_BUSY");
		this.#pending = true;
		try {
			const signal = AbortSignal.any([caller, AbortSignal.timeout(15000)]);
			await this.#outbox.flush(this.#registry, signal);
			signal.throwIfAborted();
			const before = await this.#host(this.#policy, signal);
			signal.throwIfAborted();
			const context = parseRuntimeNodeInventoryContext(
				await this.#registry.call(
					"qorpera_runtime_node_inventory_context",
					{ p_node_id: this.#policy.nodeId },
					signal,
				),
			);
			if (!isDeepStrictEqual(context.policy, this.#policy)) throw new Error("COMPUTER_USAGE_POLICY_DIFFERS");
			const retained = officeRecord(
				await this.#registry.call(
					"qorpera_read_node_computer_usage",
					{ p_node_id: this.#policy.nodeId, p_machine_id_sha256: before.machineIdSha256 },
					signal,
				),
				["schema", "allocations"],
			);
			if (
				retained.schema !== "qorpera.node-computer-usage/v1" ||
				!Array.isArray(retained.allocations) ||
				retained.allocations.length > 4096
			)
				throw new Error("COMPUTER_USAGE_RECOVERY_INVALID");
			const allocations = new Map(
				context.allocations
					.filter((a) => a.providerKind !== "login")
					.map((a) => [a.allocationId, a.instanceSha256]),
			);
			for (const item of retained.allocations) {
				const r = officeRecord(item, ["allocationId", "instanceSha256"]);
				const id = usageUuid(r.allocationId),
					sha = officeSha(r.instanceSha256);
				if (allocations.has(id) && allocations.get(id) !== sha)
					throw new Error("COMPUTER_USAGE_ALLOCATION_CHANGED");
				allocations.set(id, sha);
			}
			if (allocations.size > 4096) throw new Error("COMPUTER_USAGE_INVENTORY_LIMIT");
			for (const id of this.#previous.keys()) if (!allocations.has(id)) this.#previous.delete(id);
			const inventory = reconcileRuntimeNodeInventory(await this.#client.inspectHostInventory(signal), context);
			const samples: ComputerUsageSample[] = [];
			for (const [allocationId, instanceSha256] of allocations) {
				const entry = inventory.entries.find((e) => e.allocation?.allocationId === allocationId);
				const sample: ComputerUsageSample = {
					schema: "qorpera.computer-usage-sample/v1",
					nodeId: this.#policy.nodeId,
					machineIdSha256: before.machineIdSha256,
					allocationId,
					instanceSha256,
					observationId: randomUUID(),
					observerId: this.#observerId,
					previousObservationId: this.#previous.get(allocationId) ?? null,
					hostBootId: before.bootId,
					physicalId: entry?.physicalId ?? null,
					guestBootId: null,
					uptimeMs: null,
					observedAt: this.#now().toISOString(),
					state: "gap",
					reason: entry ? "not_running" : "missing",
				};
				if (entry?.reason) sample.reason = "unconfirmed";
				if (entry && !entry.reason && entry.state === "running" && entry.category === "managed") {
					try {
						const boot = async () => {
							const file = await this.#client.readInstanceFile(
								entry.project,
								entry.name,
								"/proc/sys/kernel/random/boot_id",
								64,
								signal,
							);
							if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444)
								throw new Error("COMPUTER_USAGE_BOOT_INVALID");
							return usageUuid(file.content.toString("utf8").trim());
						};
						const guestBootId = await boot();
						const uptime = await this.#client.readInstanceFile(
							entry.project,
							entry.name,
							"/proc/uptime",
							128,
							signal,
						);
						if (uptime.uid !== 0 || uptime.gid !== 0 || uptime.mode !== 0o444 || (await boot()) !== guestBootId)
							throw new Error("COMPUTER_USAGE_CLOCK_INVALID");
						sample.uptimeMs = parseLxdProcUptime(uptime.content);
						sample.guestBootId = guestBootId;
						sample.state = "running";
						sample.reason = "running";
						sample.observedAt = this.#now().toISOString();
					} catch {
						sample.uptimeMs = null;
						sample.guestBootId = null;
						sample.reason = "unconfirmed";
					}
				}
				samples.push(sample);
			}
			const afterInventory = reconcileRuntimeNodeInventory(await this.#client.inspectHostInventory(signal), context);
			if (!isDeepStrictEqual(before, await this.#host(this.#policy, signal)))
				throw new Error("COMPUTER_USAGE_HOST_CHANGED");
			for (const sample of samples) {
				const first = inventory.entries.find((e) => e.allocation?.allocationId === sample.allocationId);
				const after = afterInventory.entries.find((e) => e.allocation?.allocationId === sample.allocationId);
				if (!isDeepStrictEqual(first, after)) {
					sample.state = "gap";
					sample.reason = "unconfirmed";
					sample.guestBootId = null;
					sample.uptimeMs = null;
				}
				signal.throwIfAborted();
				await this.#outbox.enqueue(sample);
				this.#previous.set(sample.allocationId, sample.observationId);
			}
			await this.#outbox.flush(this.#registry, signal);
		} catch {
			this.#previous.clear();
			throw new Error("COMPUTER_USAGE_OBSERVER_UNCONFIRMED");
		} finally {
			this.#pending = false;
		}
	}
}
