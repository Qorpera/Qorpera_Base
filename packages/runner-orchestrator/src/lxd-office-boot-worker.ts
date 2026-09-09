import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type LxdTrackedClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { planLxdOfficeAdoption } from "./lxd-office-adoption-plan.ts";
import { assertOfficeStorageMaintenanceHandoff } from "./lxd-office-adoption-worker.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { assertLxdOfficeGuestInstance, inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { reserveLxdOfficeNodeMachine } from "./lxd-office-node-admission.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { LxdOfficeStartControl, type LxdOfficeStartRegistry } from "./lxd-office-start-control.ts";
import { parseLxdOfficeStorageReview } from "./lxd-office-storage-review.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Gate = Pick<LxdOfficePhysicalGate, "policy" | "check">;
interface Ports {
	client?: LxdTrackedClient;
	readProtected?: typeof readLxdOfficeProtectedFile;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}
export interface LxdOfficeBootRequest {
	intentId: string;
	observationSha256: string;
	input: unknown;
	reviewPath: string;
	writerFencePath: string;
}

/** First boot of the copied, still unadmitted office. Requires the existing
 * process-owned kernel flock and retained infrastructure writer handoff.
 * The pinned image must keep ordinary services fail-closed without provider
 * configuration/credentials. This worker installs neither, runs no guest
 * commands and cannot activate an office or release its retained capacity.
 * open() uses real host/LXD/cloud IO; constructor ports are trusted test seams. */
export class LxdOfficeBootWorker {
	readonly #gate: Gate;
	readonly #policy;
	readonly #registry: LxdOfficeStartRegistry;
	readonly #client: LxdTrackedClient;
	readonly #readProtected;
	readonly #kernelLock;
	#busy = false;
	constructor(gate: Gate, registry: LxdOfficeStartRegistry, ports: Ports = {}) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#readProtected = ports.readProtected ?? readLxdOfficeProtectedFile;
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
	}
	static async open(
		policyPath: string,
		provenancePath: string,
		registry: LxdOfficeStartRegistry,
		signal: AbortSignal,
	) {
		return new LxdOfficeBootWorker(await LxdOfficePhysicalGate.open(policyPath, provenancePath, signal), registry);
	}
	async reconcile(request: LxdOfficeBootRequest, caller: AbortSignal) {
		return this.#reconcile(request, caller, false);
	}
	/** Composed workers retain their phase until this worker's underlying IO
	 * settles, even when the public caller has already cancelled. */
	async reconcileSettled(request: LxdOfficeBootRequest, caller: AbortSignal) {
		return this.#reconcile(request, caller, true);
	}
	async #reconcile(request: LxdOfficeBootRequest, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		if (this.#busy) throw new Error("OFFICE_BOOT_RECONCILIATION_PENDING");
		const input = structuredClone(request);
		this.#busy = true;
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("OFFICE_BOOT_RECONCILIATION_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(input, signal).finally(() => {
			this.#busy = false;
		});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (settle) await operation.catch(() => {});
		}
	}
	async #run(request: LxdOfficeBootRequest, signal: AbortSignal) {
		const policy = this.#policy;
		await this.#kernelLock(policy.journal.path);
		signal.throwIfAborted();
		const identity = await openLxdOfficeCreationIdentity(policy, request.intentId, true, this.#client, signal);
		const { binding, createCommandId } = identity;
		const root = policy.journal.path;
		const observation = (
			await readRecord(join(root, `inventory-${officeSha(request.observationSha256)}.json`), 16 * 1024 ** 2 + 4096)
		).value as LxdOfficeStorageObservation;
		if (officeDigest(observation) !== request.observationSha256 || observation.intentId !== request.intentId)
			throw new Error("OFFICE_BOOT_INVENTORY_MISMATCH");
		const plan = planLxdOfficeAdoption(request.input, binding, observation);
		const planSha256 = officeDigest(plan);
		const reviewBytes = await this.#readProtected(request.reviewPath, 16384);
		const reviewSha256 = createHash("sha256").update(reviewBytes).digest("hex");
		const review = parseLxdOfficeStorageReview(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(reviewBytes)),
			observation,
			planSha256,
		);
		const copyPath = join(root, `adoption-result-${plan.adoptionId}.json`);
		const copied = officeRecord((await readRecord(copyPath)).value, [
			"schema",
			"state",
			"adoptionId",
			"observationSha256",
			"planSha256",
			"reviewSha256",
			"outputInventorySha256",
		]);
		const copy = {
			schema: "qorpera.lxd-office-adoption-copy/v1",
			state: "copied",
			adoptionId: plan.adoptionId,
			observationSha256: request.observationSha256,
			planSha256,
			reviewSha256,
			outputInventorySha256: officeSha(copied.outputInventorySha256),
		};
		if (!isDeepStrictEqual(copied, copy)) throw new Error("OFFICE_BOOT_COPY_MISMATCH");
		const authorityPath = join(root, `adoption-${plan.adoptionId}.json`);
		const copyAuthority = {
			schema: "qorpera.lxd-office-adoption-authority/v1",
			planSha256,
			reviewSha256,
			observationSha256: request.observationSha256,
		};
		const journal = await LxdOfficeOperationJournal.open(root, request.intentId, binding, this.#client, true);
		const control = new LxdOfficeStartControl(request.intentId, binding, this.#registry);
		const mappings = plan.screens.map((screen) => ({
			binding: screen.binding,
			browserProfile: screen.browser.disposition === "adopt" ? screen.browser.grant : null,
		}));
		const authorize = async () => {
			signal.throwIfAborted();
			await this.#kernelLock(root);
			const physical = await this.#gate.check(binding, signal);
			if (physical.hostBootId !== observation.hostBootId) throw new Error("OFFICE_BOOT_HOST_CHANGED");
			const checked = AbortSignal.any([signal, physical.signal]);
			if (
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(policy, request.intentId, true, this.#client, checked),
					identity,
				) ||
				!isDeepStrictEqual((await readRecord(authorityPath)).value, copyAuthority) ||
				!isDeepStrictEqual((await readRecord(copyPath)).value, copy) ||
				!reviewBytes.equals(await this.#readProtected(request.reviewPath, 16384))
			)
				throw new Error("OFFICE_BOOT_EVIDENCE_CHANGED");
			assertOfficeStorageMaintenanceHandoff(
				await this.#readProtected(request.writerFencePath, 16384),
				observation,
				plan,
				review,
			);
			const cloud = await control.checkAdoption(mappings, checked);
			const authorized = AbortSignal.any([checked, cloud.signal]);
			authorized.throwIfAborted();
			return authorized;
		};
		const name = `boot-intent-${binding.allocationId}.json`;
		const expected = {
			schema: "qorpera.lxd-office-first-boot/v1",
			intentId: request.intentId,
			allocationId: binding.allocationId,
			createCommandId,
			hostBootId: observation.hostBootId,
			observationSha256: request.observationSha256,
			planSha256,
			reviewSha256,
			copySha256: officeDigest(copy),
		};
		let retained: unknown;
		try {
			retained = (await readRecord(join(root, name))).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (retained === undefined) {
			const checked = await authorize();
			// A missing first-boot identity cannot be reconstructed after a start.
			await journal.assertInitialCreation(createCommandId, checked);
			checked.throwIfAborted();
			await publish(root, name, Buffer.from(officeCanonical({ ...expected, startCommandId: randomUUID() })));
			retained = (await readRecord(join(root, name))).value;
		}
		const saved = officeRecord(retained, [...Object.keys(expected), "startCommandId"]);
		if (
			typeof saved.startCommandId !== "string" ||
			!UUID.test(saved.startCommandId) ||
			!isDeepStrictEqual(saved, { ...expected, startCommandId: saved.startCommandId })
		)
			throw new Error("OFFICE_BOOT_IDENTITY_CHANGED");
		const startCommandId = saved.startCommandId;
		await syncDirectory(root);
		const authorizeBoot = async () => {
			const checked = await authorize();
			if (!isDeepStrictEqual((await readRecord(join(root, name))).value, saved))
				throw new Error("OFFICE_BOOT_IDENTITY_CHANGED");
			await journal.assertInitialBootSequence(createCommandId, startCommandId, checked);
			return checked;
		};
		let checked = await authorizeBoot();
		let operation = await journal.observe(startCommandId, "start", checked);
		if (operation.state === "not_dispatched") {
			const vm = await this.#client.getInstance(binding.project, lxdOfficeGuestPlan(binding).request.name, checked);
			if (!vm || vm.status !== "Stopped" || vm.statusCode !== 102)
				throw new Error("OFFICE_BOOT_STOPPED_VM_UNCONFIRMED");
			assertLxdOfficeGuestInstance(binding, vm);
			const node = await reserveLxdOfficeNodeMachine(policy, binding, this.#registry, checked);
			if (node.state === "refused") throw new Error(node.reason);
			operation = await journal.reconcile(startCommandId, "start", node.signal);
		}
		const result = {
			intentId: request.intentId,
			allocationId: binding.allocationId,
			startCommandId,
			...("operationId" in operation && operation.operationId ? { operationId: operation.operationId } : {}),
		};
		if (operation.state !== "succeeded") return { ...result, state: operation.state };
		checked = await authorizeBoot();
		const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, checked);
		const evidence = {
			...expected,
			schema: "qorpera.lxd-office-first-boot-observation/v1",
			startCommandId,
			bootId: boot.bootId,
			instanceSha256: boot.instanceSha256,
		};
		// The boot observation is write-once. A reboot is explicit lifecycle
		// recovery, not permission to reuse old preparation or silently rebind.
		const bootName = `boot-observation-${binding.allocationId}.json`;
		const completionName = `boot-completed-${binding.allocationId}.json`;
		const completion = {
			schema: "qorpera.lxd-office-first-boot-completion/v1",
			allocationId: binding.allocationId,
			startCommandId,
			bootObservationSha256: officeDigest(evidence),
		};
		checked = await authorizeBoot();
		if (!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.#client, binding, checked), boot))
			throw new Error("OFFICE_GUEST_BOOT_CHANGED");
		checked.throwIfAborted();
		let completed: unknown;
		try {
			completed = (await readRecord(join(root, completionName))).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (completed !== undefined) {
			if (!isDeepStrictEqual(completed, completion)) throw new Error("OFFICE_GUEST_BOOT_CHANGED");
			// Once completion is visible, a missing observation is lost evidence,
			// never permission to reconstruct it from a later physical boot.
			if (!isDeepStrictEqual((await readRecord(join(root, bootName))).value, evidence))
				throw new Error("OFFICE_GUEST_BOOT_CHANGED");
		}
		await publish(root, bootName, Buffer.from(officeCanonical(evidence)));
		if (!isDeepStrictEqual((await readRecord(join(root, bootName))).value, evidence))
			throw new Error("OFFICE_GUEST_BOOT_CHANGED");
		checked.throwIfAborted();
		await publish(root, completionName, Buffer.from(officeCanonical(completion)));
		if (!isDeepStrictEqual((await readRecord(join(root, completionName))).value, completion))
			throw new Error("OFFICE_GUEST_BOOT_CHANGED");
		checked.throwIfAborted();
		return {
			...result,
			state: "awaiting_preparation" as const,
			bootId: boot.bootId,
			instanceSha256: boot.instanceSha256,
			copySha256: officeDigest(copy),
			bootObservationSha256: officeDigest(evidence),
		};
	}
}
