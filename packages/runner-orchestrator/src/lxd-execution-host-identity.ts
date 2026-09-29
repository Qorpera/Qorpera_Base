import { setTimeout as delay } from "node:timers/promises";
import {
	type ExecutionHostIdentityVolumes,
	executionHostIdentityDevice,
	executionHostIdentityOf,
	parseExecutionHostIdentityVolumes,
} from "./execution-host-identity.ts";
import type { LxdInstanceDeviceUpdateClient, LxdInstanceRecord, LxdStorageVolumeRecord } from "./lxd-client.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** A concurrent change to the host (another attach, an operator) fails the
 * conditional write; each retry decides again from a fresh read. */
const WRITE_ATTEMPTS = 3;

/** Refusals decided from the host itself: a retry cannot change them. */
class ExecutionHostRefusal extends Error {}

export interface LxdExecutionHost {
	/** LXD project of the host: the login gateway's own, where it creates the volumes. */
	project: string;
	instance: string;
}

/**
 * The node's shared execution host as its login gateway keeps it: every
 * Compute Identity volume the gateway created on this node is attached to the
 * host as exactly one identity device (execution-host-identity.ts), so a
 * member's first run after a new login or a recovery here finds their login
 * without an operator. Attaching is additive and idempotent: an identity
 * already attached in exactly that shape is left alone, a device of that name
 * in any other shape is reported as refused and never replaced. Only a deleted
 * company's identity is detached (detach, RUNTIME-COMPANY-DELETE.md D4). Each
 * missing identity is its own change, so one volume LXD cannot hot-plug never
 * holds up the others.
 * LXD hot-plugs the device into the running VM (a stopped one gets it at its
 * next start); the host's execution service waits for the mount itself.
 */
export class LxdExecutionHostIdentities {
	readonly host: Readonly<LxdExecutionHost>;
	readonly volumes: Readonly<ExecutionHostIdentityVolumes>;
	readonly #client: LxdInstanceDeviceUpdateClient;

	constructor(host: LxdExecutionHost, volumes: ExecutionHostIdentityVolumes, client: LxdInstanceDeviceUpdateClient) {
		if (!NAME.test(host.project) || !NAME.test(host.instance)) throw new Error("Execution host is invalid");
		this.host = Object.freeze({ project: host.project, instance: host.instance });
		this.volumes = Object.freeze(parseExecutionHostIdentityVolumes(volumes));
		this.#client = client;
	}

	/** The custom volumes of the identity pool in the host's project, for the
	 * gateway to pick its own identity volumes from. */
	async volumeCandidates(signal: AbortSignal): Promise<LxdStorageVolumeRecord[]> {
		return this.#client.listCustomStorageVolumes(this.host.project, this.volumes.pool, signal);
	}

	/** Attaches the identities the host lacks. Returns the ones this call
	 * attached, the ones whose device name the host already uses for something
	 * else, and the ones whose attach failed (with the last failure). A host
	 * that cannot be read, or is not a virtual machine, throws. */
	async attach(
		computeIdentityIds: readonly string[],
		signal: AbortSignal,
	): Promise<{ attached: string[]; refused: string[]; failed: string[]; failure?: string }> {
		const wanted = [...new Set(computeIdentityIds)].sort().map((id) => ({
			id,
			...executionHostIdentityDevice(this.volumes, id),
		}));
		const result: { attached: string[]; refused: string[]; failed: string[]; failure?: string } = {
			attached: [],
			refused: [],
			failed: [],
		};
		if (!wanted.length) return result;
		const instance = await this.#client.getInstance(this.host.project, this.host.instance, signal);
		if (!instance) throw new Error("Execution host is missing");
		if (instance.type !== "virtual-machine") throw new Error("Execution host is not a virtual machine");
		for (const identity of wanted) {
			const outcome = this.#state(instance, identity.id, identity.name);
			if (outcome === "refused") result.refused.push(identity.id);
			if (outcome !== "missing") continue;
			try {
				if ((await this.#attachOne(identity, signal)) === "attached") result.attached.push(identity.id);
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof ExecutionHostRefusal) result.refused.push(identity.id);
				else {
					result.failed.push(identity.id);
					result.failure = error instanceof Error ? error.message : "unknown";
				}
			}
		}
		return result;
	}

	/** Detaches a deleted company's identity: only its device of exactly the
	 * identity shape, set on the host itself (a profile's is refused like any
	 * other shape), and only confirmed once a fresh read of the host has it in
	 * neither its devices nor its expanded devices. LXD hot-unplugs it from the
	 * running VM. */
	async detach(computeIdentityId: string, signal: AbortSignal): Promise<"detached" | "absent"> {
		const { name } = executionHostIdentityDevice(this.volumes, computeIdentityId);
		let detached = false;
		for (let attempt = 1; ; attempt++) {
			try {
				detached =
					(await this.#client.updateInstanceDevices(
						this.host.project,
						this.host.instance,
						(instance) => {
							if (instance.type !== "virtual-machine")
								throw new ExecutionHostRefusal("Execution host is not a virtual machine");
							const state = this.#state(instance, computeIdentityId, name);
							if (state === "refused") throw new ExecutionHostRefusal(`Device ${name} is not this volume`);
							if (state === "missing") return undefined;
							// "present" means the host sets it itself, in exactly this shape.
							const { [name]: _removed, ...devices } = instance.devices;
							return devices;
						},
						signal,
					)) || detached;
				break;
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof ExecutionHostRefusal || attempt >= WRITE_ATTEMPTS) throw error;
				await delay(250 * attempt, undefined, { signal });
			}
		}
		const instance = await this.#client.getInstance(this.host.project, this.host.instance, signal);
		if (!instance) throw new Error("Execution host is missing");
		if (this.#state(instance, computeIdentityId, name) !== "missing")
			throw new Error(`Device ${name} is still on the execution host`);
		return detached ? "detached" : "absent";
	}

	#state(instance: LxdInstanceRecord, id: string, name: string): "missing" | "present" | "refused" {
		const local = instance.devices[name],
			expanded = instance.expandedDevices[name];
		if (!local && !expanded) return "missing";
		return executionHostIdentityOf(this.volumes, name, local) === id &&
			executionHostIdentityOf(this.volumes, name, expanded) === id
			? "present"
			: "refused";
	}

	/** One conditional write, decided on its own read of the host; a
	 * concurrent change makes it decide again from a fresh read. */
	async #attachOne(
		identity: { id: string; name: string; device: Readonly<Record<string, string>> },
		signal: AbortSignal,
	): Promise<"attached" | "present"> {
		for (let attempt = 1; ; attempt++) {
			try {
				const written = await this.#client.updateInstanceDevices(
					this.host.project,
					this.host.instance,
					(instance) => {
						if (instance.type !== "virtual-machine")
							throw new ExecutionHostRefusal("Execution host is not a virtual machine");
						const state = this.#state(instance, identity.id, identity.name);
						if (state === "refused") throw new ExecutionHostRefusal(`Device ${identity.name} is not this volume`);
						return state === "missing" ? { ...instance.devices, [identity.name]: identity.device } : undefined;
					},
					signal,
				);
				return written ? "attached" : "present";
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof ExecutionHostRefusal || attempt >= WRITE_ATTEMPTS) throw error;
				await delay(250 * attempt, undefined, { signal });
			}
		}
	}
}
