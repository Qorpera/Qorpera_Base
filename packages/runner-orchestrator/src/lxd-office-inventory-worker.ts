import { join } from "node:path";
import { type LxdTrackedClient, LxdUnixClient } from "./lxd-client.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { assertLxdOfficeGuestInstance, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest } from "./lxd-office-image-provenance.ts";
import { publish, readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import {
	LxdOfficeStartControl,
	type LxdOfficeStartRegistry,
	lxdOfficeProviderBindingSha256,
} from "./lxd-office-start-control.ts";
import {
	inspectOfficeStorage,
	type OfficeInventoryLimits,
	type OfficeStorageInventory,
	parseOfficeInventoryLimits,
} from "./lxd-office-storage-inventory.ts";

export interface LxdOfficeStorageObservation {
	readonly schema: "qorpera.lxd-office-storage-observation/v1";
	readonly intentId: string;
	readonly allocationId: string;
	readonly providerBindingSha256: string;
	readonly hostBootId: string;
	readonly inventory: Readonly<OfficeStorageInventory>;
}
type Gate = Pick<LxdOfficePhysicalGate, "policy" | "check">;

/** Provider-only inventory for an already-created, stopped allocation. The
 * durable observation is evidence for explicit operator review, never an
 * adoption receipt, a writer fence, permission to boot, or proof of durability.
 * Tests may supply trusted in-process ports; open() uses the real Linux/LXD IO. */
export class LxdOfficeInventoryWorker {
	readonly #gate: Gate;
	readonly #policy;
	readonly #registry: LxdOfficeStartRegistry;
	readonly #limits;
	readonly #client: LxdTrackedClient;
	readonly #inspect: typeof inspectOfficeStorage;
	#busy = false;
	constructor(
		gate: Gate,
		registry: LxdOfficeStartRegistry,
		limits: OfficeInventoryLimits,
		client?: LxdTrackedClient,
		inspect = inspectOfficeStorage,
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#limits = parseOfficeInventoryLimits(limits);
		this.#client = client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#inspect = inspect;
	}
	static async open(
		policyPath: string,
		provenancePath: string,
		registry: LxdOfficeStartRegistry,
		limits: OfficeInventoryLimits,
		signal: AbortSignal,
	): Promise<LxdOfficeInventoryWorker> {
		return new LxdOfficeInventoryWorker(
			await LxdOfficePhysicalGate.open(policyPath, provenancePath, signal),
			registry,
			limits,
		);
	}
	async inspect(
		intentId: string,
		caller: AbortSignal,
	): Promise<{ observation: LxdOfficeStorageObservation; observationSha256: string; evidencePath: string }> {
		return this.#inspectSettled(intentId, caller, false);
	}
	async inspectSettled(intentId: string, caller: AbortSignal) {
		return this.#inspectSettled(intentId, caller, true);
	}
	async #inspectSettled(intentId: string, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		if (this.#busy) throw new Error("OFFICE_INVENTORY_WORKER_PENDING");
		this.#busy = true;
		const signal = AbortSignal.any([caller, AbortSignal.timeout(300000)]);
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("OFFICE_INVENTORY_WORKER_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(intentId, signal).finally(() => {
			this.#busy = false;
		});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (settle) await operation.catch(() => {});
		}
	}
	async #run(intentId: string, signal: AbortSignal) {
		const policy = this.#policy;
		const { binding, createCommandId } = await openLxdOfficeCreationIdentity(
			policy,
			intentId,
			true,
			this.#client,
			signal,
		);
		const control = new LxdOfficeStartControl(intentId, binding, this.#registry);
		const before = await this.#gate.check(binding, signal);
		const checked = AbortSignal.any([signal, before.signal]);
		const journal = await LxdOfficeOperationJournal.open(policy.journal.path, intentId, binding, this.#client, true);
		if ((await journal.observe(createCommandId, "create", checked)).state !== "succeeded")
			throw new Error("OFFICE_INVENTORY_CREATION_UNCONFIRMED");
		const { request } = lxdOfficeGuestPlan(binding);
		const stopped = async (check: AbortSignal) => {
			await journal.assertInitialCreation(createCommandId, check);
			const authority = await control.check(check);
			const authorized = AbortSignal.any([check, authority.signal]);
			const instance = await this.#client.getInstance(binding.project, request.name, authorized);
			authorized.throwIfAborted();
			if (!instance || instance.status !== "Stopped" || instance.statusCode !== 102)
				throw new Error("OFFICE_INVENTORY_STOPPED_VM_UNCONFIRMED");
			assertLxdOfficeGuestInstance(binding, instance);
		};
		await stopped(checked);
		// Hashing is read-only and can exceed a five-second preparation grant.
		// No observation is returned or published without renewed authority and
		// physical checks afterwards. These checks do not fence other NAS users.
		const inventory = await this.#inspect(
			{
				root: policy.workbench.mountPoint,
				mount: policy.workbench,
				uid: policy.workbench.uid,
				gid: policy.workbench.gid,
				serverAddress: policy.workbench.serverAddress,
			},
			this.#limits,
			signal,
		);
		signal.throwIfAborted();
		const after = await this.#gate.check(binding, signal);
		if (before.hostBootId !== after.hostBootId) throw new Error("OFFICE_INVENTORY_HOST_CHANGED");
		const final = AbortSignal.any([signal, after.signal]);
		await stopped(final);
		const observation: LxdOfficeStorageObservation = Object.freeze({
			schema: "qorpera.lxd-office-storage-observation/v1",
			intentId,
			allocationId: binding.allocationId,
			providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
			hostBootId: after.hostBootId,
			inventory,
		});
		const observationSha256 = officeDigest(observation);
		const name = `inventory-${observationSha256}.json`;
		const evidencePath = join(policy.journal.path, name);
		final.throwIfAborted();
		await publish(policy.journal.path, name, Buffer.from(officeCanonical(observation)));
		// An already-published file must be intact too. Bound the complete
		// observation to the maximum inventory plus its small binding envelope.
		const recorded = await readRecord(evidencePath, 16 * 1024 ** 2 + 4096);
		if (officeDigest(recorded.value) !== observationSha256) throw new Error("OFFICE_INVENTORY_EVIDENCE_CHANGED");
		await stopped(final);
		final.throwIfAborted();
		return { observation, observationSha256, evidencePath };
	}
}
