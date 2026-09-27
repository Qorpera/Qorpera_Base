import { setTimeout as delay } from "node:timers/promises";
import {
	type ExecutionHostIdentityVolumes,
	executionHostIdentityDevice,
	executionHostIdentityOf,
	parseExecutionHostIdentityVolumes,
} from "./execution-host-identity.ts";
import type { LxdInstanceDeviceUpdateClient, LxdStorageVolumeRecord } from "./lxd-client.ts";

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
 * in any other shape is reported as refused and never replaced (the others
 * are still attached), and nothing is detached.
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

	/** Attaches the identities the host lacks, in one change. Returns the ones
	 * this call attached (none when all were already there) and the ones whose
	 * device name the host already uses for something else. */
	async attach(
		computeIdentityIds: readonly string[],
		signal: AbortSignal,
	): Promise<{ attached: string[]; refused: string[] }> {
		const wanted = [...new Set(computeIdentityIds)].sort().map((id) => ({
			id,
			...executionHostIdentityDevice(this.volumes, id),
		}));
		if (!wanted.length) return { attached: [], refused: [] };
		for (let attempt = 1; ; attempt++) {
			let attached: string[] = [],
				refused: string[] = [];
			try {
				await this.#client.updateInstanceDevices(
					this.host.project,
					this.host.instance,
					(instance) => {
						if (instance.type !== "virtual-machine")
							throw new ExecutionHostRefusal("Execution host is not a virtual machine");
						const missing = wanted.filter(
							({ name }) => !instance.devices[name] && !instance.expandedDevices[name],
						);
						refused = wanted
							.filter(
								({ id, name }) =>
									(instance.devices[name] || instance.expandedDevices[name]) &&
									(executionHostIdentityOf(this.volumes, name, instance.devices[name]) !== id ||
										executionHostIdentityOf(this.volumes, name, instance.expandedDevices[name]) !== id),
							)
							.map(({ id }) => id);
						attached = missing.map(({ id }) => id);
						return missing.length
							? { ...instance.devices, ...Object.fromEntries(missing.map(({ name, device }) => [name, device])) }
							: undefined;
					},
					signal,
				);
				return { attached, refused };
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof ExecutionHostRefusal || attempt >= WRITE_ATTEMPTS) throw error;
				await delay(250 * attempt, undefined, { signal });
			}
		}
	}
}
