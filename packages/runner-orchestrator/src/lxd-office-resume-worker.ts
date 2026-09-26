import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerBootIntentRequest,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import { type LxdOfficeServiceStartClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { LxdOfficeBootIntentControl, type LxdOfficeBootIntentRegistry } from "./lxd-office-boot-intent-control.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { assertLxdOfficeGuestInstance, inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { reserveLxdOfficeNodeMachine } from "./lxd-office-node-admission.ts";
import { openLxdOfficeCurrentOperationJournal } from "./lxd-office-outage-history.ts";
import type { LxdOfficePaidComputerPort } from "./lxd-office-paid-computer.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { readLxdOfficePowerOffEvidence } from "./lxd-office-power-off-evidence.ts";
import { readLxdOfficeStopHistory } from "./lxd-office-stop-history.ts";

interface Ports {
	paidComputer?: LxdOfficePaidComputerPort;
	client?: LxdOfficeServiceStartClient;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}
const pending = new Set<string>();
/** Explicit resume/reboot boot stage on the existing disk. The caller must
 * hold the provider kernel flock and supply a planned boot intent. No root
 * configuration or ordinary service mutation occurs. The existing allocation
 * must pass fresh node admission before power-on; it is never released here.
 * Unknown VM submissions remain uncertain forever; accepted operations may
 * be observed. Only a distinct measured boot with unchanged protected stop
 * history advances to the separate new-boot configuration/admission phase. */
export class LxdOfficeResumeWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #registry: LxdOfficeBootIntentRegistry;
	readonly #client: LxdOfficeServiceStartClient;
	readonly #kernelLock;
	readonly #paid?: LxdOfficePaidComputerPort;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		registry: LxdOfficeBootIntentRegistry,
		ports: Ports = {},
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#paid = ports.paidComputer;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
	}
	reconcile(intentId: string, request: CompanyComputerBootIntentRequest, caller: AbortSignal) {
		return this.#reconcile(intentId, request, caller, false);
	}
	reconcileSettled(intentId: string, request: CompanyComputerBootIntentRequest, caller: AbortSignal) {
		return this.#reconcile(intentId, request, caller, true);
	}
	async #reconcile(intentId: string, value: CompanyComputerBootIntentRequest, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		const request = parseCompanyComputerBootIntentRequest(value),
			root = this.#policy.journal.path;
		if (pending.has(root)) throw new Error("OFFICE_RESUME_PENDING");
		pending.add(root);
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]),
			io = new Set<Promise<unknown>>();
		const registry: LxdOfficeBootIntentRegistry = {
			call: (method, args, checked) => {
				const work = Promise.resolve().then(() => {
					checked.throwIfAborted();
					return this.#registry.call(method, args, checked);
				});
				io.add(work);
				void work.then(
					() => io.delete(work),
					() => io.delete(work),
				);
				return work;
			},
		};
		let abort = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_RESUME_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(intentId, request, registry, signal)
			.catch((error) => {
				throw new Error("OFFICE_RESUME_UNCONFIRMED", { cause: error });
			})
			.finally(async () => {
				await Promise.allSettled([...io]);
				pending.delete(root);
			});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (settle) await operation.catch(() => {});
		}
	}
	async #run(
		intentId: string,
		request: CompanyComputerBootIntentRequest,
		registry: LxdOfficeBootIntentRegistry,
		signal: AbortSignal,
	) {
		const root = this.#policy.journal.path;
		await this.#kernelLock(root);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal),
			{ binding } = creation,
			{ allocationId } = binding;
		const shutdown = await readLxdOfficePowerOffEvidence(root, creation, request, signal),
			selected = await openLxdOfficeCurrentOperationJournal(
				root,
				creation,
				this.#client,
				this.#paid?.operations(binding),
			),
			journal = selected.journal,
			control = new LxdOfficeBootIntentControl(request, registry);
		const suffix = `${allocationId}-${request.predecessor.transitionId}`,
			seedName = `resume-request-${suffix}.json`,
			preparedName = `resume-prepared-${suffix}.json`,
			observationName = `resume-observation-${suffix}.json`,
			doneName = `resume-completed-${suffix}.json`;
		const read = async (name: string) => {
			try {
				return (await readRecord(join(root, name), 65536)).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				return undefined;
			}
		};
		const retain = async (name: string, value: unknown) => {
			signal.throwIfAborted();
			await publish(root, name, Buffer.from(officeCanonical(value)));
			if (!isDeepStrictEqual(await read(name), value)) throw new Error("resume record differs");
		};
		const expected = {
			schema: "qorpera.lxd-office-resume-request/v1",
			intentId,
			binding,
			request,
			powerOffRequestSha256: shutdown.seedSha256,
			hostBootId: shutdown.hostBootId,
		};
		let saved = await read(seedName);
		if (saved === undefined) {
			if (
				(await read(preparedName)) !== undefined ||
				(await read(observationName)) !== undefined ||
				(await read(doneName)) !== undefined
			)
				throw new Error("resume prefix lost");
			await journal.assertRetainedLifecycleSequence(shutdown.commands, signal);
			await retain(seedName, { ...expected, startCommandId: randomUUID() });
			saved = await read(seedName);
		}
		const seed = officeRecord(saved, [...Object.keys(expected), "startCommandId"]),
			command = parseCompanyComputerPreparationCommand({
				commandId: seed.startCommandId,
				bootId: shutdown.hostBootId,
				requestSha256: officeDigest(request),
			});
		if (!isDeepStrictEqual(seed, { ...expected, startCommandId: command.commandId }))
			throw new Error("resume identity differs");
		const sequence = [...shutdown.commands, { commandId: command.commandId, action: "start" as const }];
		const retained = async () => {
			await this.#kernelLock(root);
			await selected.assertCurrent();
			if (
				!isDeepStrictEqual(await read(seedName), seed) ||
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal),
					creation,
				) ||
				!isDeepStrictEqual(await readLxdOfficePowerOffEvidence(root, creation, request, signal), shutdown)
			)
				throw new Error("resume history changed");
			await journal.assertRetainedLifecycleSequence(sequence, signal);
			const stop = await journal.observe(shutdown.stopCommandId, "stop", signal);
			if (stop.state !== "succeeded" || stop.operationId !== shutdown.stopOperationId)
				throw new Error("VM shutdown unconfirmed");
			signal.throwIfAborted();
		};
		const physical = async () => {
			await retained();
			const physical = await this.#gate.check(binding, signal);
			if (physical.hostBootId !== shutdown.hostBootId) throw new Error("resume host changed");
			const checked = AbortSignal.any([signal, physical.signal]),
				instance = await this.#client.getInstance(
					binding.project,
					lxdOfficeGuestPlan(binding).request.name,
					checked,
				);
			if (!instance) throw new Error("resume VM missing");
			assertLxdOfficeGuestInstance(binding, instance);
			checked.throwIfAborted();
			return { checked, instance };
		};
		await retained();
		const intent = await control.prepare(signal),
			pinned = { ...intent, state: "prepared" };
		// An admitted intent cannot reconstruct lost local preparation history.
		const previous = await read(preparedName);
		if (
			previous === undefined &&
			(intent.state !== "prepared" ||
				(await journal.observe(command.commandId, "start", signal)).state !== "not_dispatched")
		)
			throw new Error("resume preparation lost");
		await retain(preparedName, pinned);
		const authorize = async (caller: AbortSignal) => {
			const cloud = await control.check(caller);
			await retained();
			if (!isDeepStrictEqual(await read(preparedName), pinned)) throw new Error("resume preparation changed");
			cloud.signal.throwIfAborted();
			return cloud.signal;
		};
		let operation = await journal.observe(command.commandId, "start", signal);
		if (operation.state === "not_dispatched") {
			if ((await read(observationName)) !== undefined || (await read(doneName)) !== undefined)
				throw new Error("resume dispatch lost");
			const { checked, instance } = await physical();
			if (instance.status !== "Stopped" || instance.statusCode !== 102) throw new Error("resume VM not stopped");
			const state = await this.#client.getInstanceState(binding.project, instance.name, checked);
			if (state.status !== "Stopped" || state.statusCode !== 102) throw new Error("resume VM state differs");
			let authorized = await authorize(checked);
			const paid = await this.#paid?.prepareStart(
				binding,
				command.commandId,
				{ kind: "resume", request },
				authorized,
			);
			if (!paid) {
				const node = await reserveLxdOfficeNodeMachine(this.#policy, binding, registry, authorized);
				if (node.state === "refused") throw new Error(node.reason);
				authorized = node.signal;
			}
			operation = await journal.reconcile(command.commandId, "start", authorized);
		}
		const result = {
			intentId,
			allocationId,
			bootIntentId: request.bootIntentId,
			activationId: request.activationId,
			startCommandId: command.commandId,
		};
		if (operation.state === "abandoned_before_dispatch")
			return { ...result, state: "failed" as const, reason: "OFFICE_PAID_START_ABANDONED" };
		if (operation.state !== "succeeded") return { ...result, state: operation.state };
		const before = await physical(),
			boot = await inspectLxdOfficeGuestBoot(this.#client, binding, before.checked);
		if (shutdown.bootIds.includes(boot.bootId)) throw new Error("resume boot not distinct");
		const archive = await readLxdOfficeStopHistory(
			this.#client,
			binding,
			shutdown.history.command,
			request.predecessor.activationId,
			shutdown.history.completionPath,
			Object.fromEntries(shutdown.history.entries.map((entry) => [entry.path, entry.sha256])),
			signal,
		);
		if (archive.manifestSha256 !== request.stopHistorySha256) throw new Error("resume root history differs");
		// Archive hashing is read-only and may exceed a physical sample's five
		// seconds. Recheck the host/VM and boot afterwards under a new window;
		// the overall reconciliation and all dispatch authority remain bounded.
		const { checked } = await physical();
		if (!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.#client, binding, checked), boot))
			throw new Error("resume boot changed during history read");
		const observation = {
			schema: "qorpera.lxd-office-resume-observation/v1",
			...result,
			requestSha256: officeDigest(seed),
			powerOffCompletionSha256: request.powerOffCompletionSha256,
			stopHistorySha256: request.stopHistorySha256,
			hostBootId: shutdown.hostBootId,
			bootId: boot.bootId,
			instanceSha256: boot.instanceSha256,
			operationId: operation.operationId,
		};
		const completion = {
				schema: "qorpera.lxd-office-resume-completion/v1",
				...result,
				bootObservationSha256: officeDigest(observation),
			},
			done = await read(doneName);
		if (done !== undefined) {
			if (!isDeepStrictEqual(done, completion) || !isDeepStrictEqual(await read(observationName), observation))
				throw new Error("resume completion differs");
			// Metadata recovery may follow post-boot handoff. It grants no effects.
			await control.status(checked);
		} else {
			const authorized = await authorize(checked);
			if (!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.#client, binding, authorized), boot))
				throw new Error("resume boot changed");
			authorized.throwIfAborted();
			await retain(observationName, observation);
			authorized.throwIfAborted();
			await retain(doneName, completion);
		}
		checked.throwIfAborted();
		return {
			...result,
			state: "awaiting_configuration" as const,
			bootId: boot.bootId,
			instanceSha256: boot.instanceSha256,
			bootObservationSha256: officeDigest(observation),
		};
	}
}
