import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopRequest,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";
import { type LxdOfficeServiceStartClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { readLxdOfficeBootVmEvidence } from "./lxd-office-boot-vm-evidence.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { assertLxdOfficeGuestInstance, inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { suspendLxdOfficeNodeMachine } from "./lxd-office-node-admission.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { readLxdOfficeResetVmHistory } from "./lxd-office-reset-vm-history.ts";
import { LxdOfficeStopControl, type LxdOfficeStopRegistry } from "./lxd-office-stop-control.ts";
import { officeStopDecode, officeStopHash, readLxdOfficeStopEvidence } from "./lxd-office-stop-evidence.ts";
import { readLxdOfficeStopHistory } from "./lxd-office-stop-history.ts";

interface Ports {
	client?: LxdOfficeServiceStartClient;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}
export interface LxdOfficePowerOffResult {
	state: "powered_off" | "pending" | "unknown" | "failed";
	intentId: string;
	allocationId: string;
	transitionId: string;
	commandId: string;
}
const pending = new Set<string>();

/** Explicit power_off or reboot shutdown stage. Admission and service shutdown must already be
 * acknowledged. Persist historical evidence before the VM becomes unreadable;
 * then one durable LXD stop may be observed across process recovery. Missing
 * VMs, unknown replies or time never release capacity or authorize a restart.
 * The stopped VM, root disk and attached workbench remain allocated. */
export class LxdOfficePowerOffWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #registry: LxdOfficeStopRegistry;
	readonly #client: LxdOfficeServiceStartClient;
	readonly #kernelLock;
	/** `${allocationId}-${transitionId}` whose node suspension SQL has answered. */
	#suspended: string | undefined;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		registry: LxdOfficeStopRegistry,
		ports: Ports = {},
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
	}
	reconcile(intentId: string, request: CompanyComputerLifecycleRequest, caller: AbortSignal) {
		return this.#reconcile(intentId, request, caller, false);
	}
	reconcileSettled(intentId: string, request: CompanyComputerLifecycleRequest, caller: AbortSignal) {
		return this.#reconcile(intentId, request, caller, true);
	}
	async #reconcile(intentId: string, value: CompanyComputerLifecycleRequest, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		const request = parseCompanyComputerLifecycleRequest(value),
			root = this.#policy.journal.path;
		if (!["power_off", "reboot"].includes(request.action)) throw new Error("OFFICE_POWER_OFF_ACTION_REQUIRED");
		if (pending.has(root)) throw new Error("OFFICE_POWER_OFF_PENDING");
		pending.add(root);
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
		const io = new Set<Promise<unknown>>();
		const registry: LxdOfficeStopRegistry = {
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
			abort = () => reject(new Error("OFFICE_POWER_OFF_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(intentId, request, registry, signal)
			.catch((error) => {
				throw new Error("OFFICE_POWER_OFF_UNCONFIRMED", { cause: error });
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
		recovery: CompanyComputerLifecycleRequest,
		registry: LxdOfficeStopRegistry,
		signal: AbortSignal,
	): Promise<LxdOfficePowerOffResult> {
		const root = this.#policy.journal.path;
		await this.#kernelLock(root);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal);
		const { binding } = creation,
			{ allocationId } = binding,
			{ transitionId } = recovery;
		const { request: plan, instanceSha256 } = lxdOfficeGuestPlan(binding);
		if (
			recovery.providerId !== binding.providerId ||
			recovery.providerPolicySha256 !== binding.providerPolicySha256 ||
			recovery.startup.allocationId !== allocationId ||
			recovery.startup.instanceSha256 !== instanceSha256 ||
			recovery.startup.imageSha256 !== binding.imageFingerprint ||
			recovery.startup.bootstrapSha256 !== binding.bootstrapSha256 ||
			recovery.startup.computerGeneration !== binding.computerGeneration ||
			!isDeepStrictEqual(recovery.startup.scope, {
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
			})
		)
			throw new Error("power-off binding differs");
		const suffix = `${allocationId}-${transitionId}`,
			seedName = `power-off-request-${suffix}.json`,
			doneName = `power-off-completed-${suffix}.json`,
			stopName = `service-stop-request-${suffix}.json`,
			historyName = `power-off-history-${suffix}.json`,
			stopDoneName = `service-stop-completed-${suffix}.json`;
		const optional = async (name: string) => {
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
			if (!isDeepStrictEqual(await optional(name), value)) throw new Error("power-off record differs");
		};
		const envelope = officeRecord(await optional(stopName), ["schema", "request", "command"]);
		const stop = parseCompanyComputerServiceStopRequest(envelope.request),
			stopCommand = parseCompanyComputerPreparationCommand(envelope.command);
		if (
			envelope.schema !== "qorpera.lxd-office-stop-request/v1" ||
			!isDeepStrictEqual(stop.revocation.request, recovery) ||
			stopCommand.bootId !== recovery.startup.bootId ||
			stopCommand.requestSha256 !== officeStopHash(Buffer.from(officeCanonical(stop)))
		)
			throw new Error("stop request differs");
		const marker = officeRecord(await optional(stopDoneName), [
			"schema",
			"intentId",
			"allocationId",
			"transitionId",
			"commandId",
			"receipt",
		]);
		const receipt = parseCompanyComputerServiceStopAcknowledgement(marker.receipt, stop, stopCommand);
		if (
			!isDeepStrictEqual(marker, {
				schema: "qorpera.lxd-office-stop-completion/v1",
				intentId,
				allocationId,
				transitionId,
				commandId: stopCommand.commandId,
				receipt,
			})
		)
			throw new Error("stop acknowledgement differs");
		const control = new LxdOfficeStopControl(stop, stopCommand, registry);
		const journal = await LxdOfficeOperationJournal.open(root, intentId, binding, this.#client, true);
		let seedValue = await optional(seedName);
		if (seedValue === undefined) {
			if ((await optional(doneName)) !== undefined) throw new Error("power-off prefix lost");
			const evidence = await readLxdOfficeStopEvidence(root, intentId, binding, recovery, this.#client, signal);

			const resetOriginActivationId =
				evidence.kind === "reset" || evidence.kind === "reset_restart"
					? evidence.origin.completion.activationId
					: undefined;
			const bootIntent =
				evidence.kind === "boot" || evidence.kind === "boot_restart" ? evidence.origin.bootIntent : undefined;
			const reset = resetOriginActivationId
				? await readLxdOfficeResetVmHistory(
						root,
						creation,
						resetOriginActivationId,
						async (name) => (await readRecord(join(root, name))).value,
						signal,
					)
				: undefined;
			const resumed = bootIntent ? await readLxdOfficeBootVmEvidence(root, creation, bootIntent, signal) : undefined;
			const boot = reset
				? reset.observation
				: resumed
					? { ...resumed.observation, createCommandId: creation.createCommandId }
					: ((await readRecord(join(root, `boot-observation-${allocationId}.json`))).value as Record<
							string,
							unknown
						>);
			if (
				stop.startCompletionSha256 !== evidence.startCompletionSha256 ||
				boot.createCommandId !== creation.createCommandId ||
				boot.bootId !== recovery.startup.bootId ||
				boot.hostBootId !== evidence.hostBootId
			)
				throw new Error("power-off history differs");
			await journal.assertRetainedLifecycleSequence(
				reset
					? reset.commands
					: resumed
						? resumed.commands
						: [
								{ commandId: creation.createCommandId, action: "create" },
								{ commandId: boot.startCommandId as string, action: "start" },
							],
				signal,
			);
			const completionPath = evidence.initial
				? "/run/qorpera-office-preparation/service-stop-completion.json"
				: `/run/qorpera-office-preparation/service-stop-completion-${recovery.activationId}.json`;
			const file = await this.#client.readInstanceFile(binding.project, plan.name, completionPath, 8192, signal);
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== 0o600 ||
				file.content.length > 8192 ||
				!isDeepStrictEqual(officeStopDecode(file.content), receipt.inspection.stop)
			)
				throw new Error("root stop differs");
			const stopCompletionSha256 = officeStopHash(file.content);
			file.content.fill(0);
			const history = await readLxdOfficeStopHistory(
				this.#client,
				binding,
				stopCommand,
				recovery.activationId,
				completionPath,
				{ ...evidence.installed, [completionPath]: stopCompletionSha256 },
				signal,
			);
			signal.throwIfAborted();
			await publish(root, historyName, history.bytes);
			if (!(await readRecord(join(root, historyName), 65536)).bytes.equals(history.bytes))
				throw new Error("retained history differs");
			const records = { ...evidence.records };
			records[historyName] = history.manifestSha256;
			for (const name of [stopName, stopDoneName])
				records[name] = officeStopHash((await readRecord(join(root, name))).bytes);
			seedValue = {
				schema: reset
					? "qorpera.lxd-office-power-off-request/v4"
					: bootIntent
						? "qorpera.lxd-office-power-off-request/v3"
						: "qorpera.lxd-office-power-off-request/v2",
				...(reset ? { resetOriginActivationId } : {}),
				...(bootIntent ? { bootIntent } : {}),
				intentId,
				binding,
				request: recovery,
				commandId: randomUUID(),
				startCommandId: boot.startCommandId,
				hostBootId: evidence.hostBootId,
				stopCompletionSha256,
				stopHistorySha256: history.manifestSha256,
				records,
			};
			await retain(seedName, seedValue);
		}
		const resetRoot =
			(seedValue as { schema?: unknown } | null)?.schema === "qorpera.lxd-office-power-off-request/v4";
		const later = (seedValue as { schema?: unknown } | null)?.schema === "qorpera.lxd-office-power-off-request/v3";
		const seed = officeRecord(seedValue, [
			...(later ? ["bootIntent"] : resetRoot ? ["resetOriginActivationId"] : []),
			"schema",
			"intentId",
			"binding",
			"request",
			"commandId",
			"startCommandId",
			"hostBootId",
			"stopCompletionSha256",
			"stopHistorySha256",
			"records",
		]);
		const command = parseCompanyComputerPreparationCommand({
			commandId: seed.commandId,
			bootId: seed.hostBootId,
			requestSha256: seed.stopCompletionSha256,
		});
		parseCompanyComputerPreparationCommand({ ...command, commandId: seed.startCommandId });
		if (
			seed.schema !==
				(resetRoot
					? "qorpera.lxd-office-power-off-request/v4"
					: later
						? "qorpera.lxd-office-power-off-request/v3"
						: "qorpera.lxd-office-power-off-request/v2") ||
			seed.intentId !== intentId ||
			!isDeepStrictEqual(seed.binding, binding) ||
			!isDeepStrictEqual(seed.request, recovery) ||
			command.commandId === stopCommand.commandId ||
			!seed.records ||
			typeof seed.records !== "object" ||
			Array.isArray(seed.records)
		)
			throw new Error("power-off identity differs");

		const bootIntent = later ? parseCompanyComputerBootIntentRequest(seed.bootIntent) : undefined;
		const reset = resetRoot
			? await readLxdOfficeResetVmHistory(
					root,
					creation,
					seed.resetOriginActivationId as string,
					async (name) => {
						if (!Object.hasOwn(seed.records as object, name)) throw new Error("reset power-off record unpinned");
						return (await readRecord(join(root, name))).value;
					},
					signal,
				)
			: undefined;
		if (
			reset &&
			(reset.observation.bootId !== recovery.startup.bootId ||
				reset.observation.startCommandId !== seed.startCommandId ||
				reset.observation.hostBootId !== seed.hostBootId)
		)
			throw new Error("reset power-off boot differs");
		const resumed = bootIntent ? await readLxdOfficeBootVmEvidence(root, creation, bootIntent, signal) : undefined;
		if (
			resumed &&
			(resumed.observation.bootId !== recovery.startup.bootId ||
				resumed.observation.startCommandId !== seed.startCommandId ||
				resumed.observation.hostBootId !== seed.hostBootId)
		)
			throw new Error("power-off resumed boot differs");
		const bootNames = reset
			? [`reset-activation-${allocationId}-${reset.plan.successorActivationId}.json`]
			: bootIntent
				? ["request", "prepared", "observation", "completed"].map(
						(kind) => `resume-${kind}-${allocationId}-${bootIntent.predecessor.transitionId}.json`,
					)
				: [`boot-observation-${allocationId}.json`];
		const sequence = [
			...(reset
				? reset.commands
				: resumed
					? resumed.commands
					: [
							{ commandId: creation.createCommandId, action: "create" as const },
							{ commandId: seed.startCommandId as string, action: "start" as const },
						]),
			{ commandId: command.commandId, action: "stop" as const },
		];
		const records = seed.records as Record<string, unknown>,
			entries = Object.entries(records);
		if (
			entries.length < 3 ||
			entries.length > 256 ||
			![stopName, stopDoneName, historyName, ...bootNames].every((name) => Object.hasOwn(records, name)) ||
			entries.some(
				([name, sha]) => !/^[a-z0-9-]+\.json$/.test(name) || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha),
			)
		)
			throw new Error("power-off history invalid");
		const historyFile = await readRecord(join(root, historyName), 65536),
			history = parseCompanyComputerStopHistoryManifest(
				historyFile.value,
				recovery.startup.bootId,
				recovery.activationId,
			);
		if (
			seed.stopHistorySha256 !== records[historyName] ||
			officeStopHash(historyFile.bytes) !== seed.stopHistorySha256 ||
			!isDeepStrictEqual(history.command, stopCommand) ||
			!history.entries.some(
				(entry) => entry.path === history.completionPath && entry.sha256 === seed.stopCompletionSha256,
			)
		)
			throw new Error("power-off history differs");
		const retained = async () => {
			await this.#kernelLock(root);
			if (
				!isDeepStrictEqual(await optional(seedName), seed) ||
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal),
					creation,
				)
			)
				throw new Error("power-off history changed");
			for (const [name, sha] of entries)
				if (officeStopHash((await readRecord(join(root, name), 65536)).bytes) !== sha)
					throw new Error("retained bytes changed");
			if (
				bootIntent &&
				!isDeepStrictEqual(await readLxdOfficeBootVmEvidence(root, creation, bootIntent, signal), resumed)
			)
				throw new Error("power-off VM history changed");
			if (
				reset &&
				!isDeepStrictEqual(
					await readLxdOfficeResetVmHistory(
						root,
						creation,
						reset.plan.successorActivationId,
						async (name) => (await readRecord(join(root, name))).value,
						signal,
					),
					reset,
				)
			)
				throw new Error("reset power-off history changed");
			await journal.assertRetainedLifecycleSequence(sequence, signal);
			signal.throwIfAborted();
		};
		const physical = async () => {
			await retained();
			const gate = await this.#gate.check(binding, signal);
			if (gate.hostBootId !== seed.hostBootId) throw new Error("power-off host changed");
			const checked = AbortSignal.any([signal, gate.signal]);
			const instance = await this.#client.getInstance(binding.project, plan.name, checked);
			if (!instance) throw new Error("power-off VM missing");
			assertLxdOfficeGuestInstance(binding, instance);
			checked.throwIfAborted();
			return { checked, instance };
		};
		const authority = async (caller: AbortSignal) => {
			// SQL status locks/rechecks current non-superseded activation, provider,
			// maintenance and charged allocation. Its receipt alone is historical.
			const deadline = performance.now() + 5000,
				checked = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
			if (!isDeepStrictEqual(await control.status(checked), receipt)) throw new Error("power-off authority changed");
			return { checked, deadline };
		};
		await retained();
		let operation = await journal.observe(command.commandId, "stop", signal);
		if (operation.state === "not_dispatched") {
			if ((await optional(doneName)) !== undefined) throw new Error("power-off dispatch lost");
			const { checked, instance } = await physical();
			if (instance.status !== "Running" || instance.statusCode !== 103)
				throw new Error("power-off boot unavailable");
			const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, checked);
			if (boot.bootId !== recovery.startup.bootId || boot.instanceSha256 !== instanceSha256)
				throw new Error("power-off boot changed");
			const current = await authority(checked);
			await retained();
			current.checked.throwIfAborted();
			if (performance.now() >= current.deadline) throw new Error("power-off authority expired");
			operation = await journal.reconcile(command.commandId, "stop", current.checked);
		}
		const result = { intentId, allocationId, transitionId, commandId: command.commandId };
		if (operation.state !== "succeeded") return { ...result, state: operation.state };
		const { checked, instance } = await physical();
		if (instance.status !== "Stopped" || instance.statusCode !== 102)
			throw new Error("power-off physical state differs");
		const state = await this.#client.getInstanceState(binding.project, plan.name, checked);
		if (state.status !== "Stopped" || state.statusCode !== 102) throw new Error("power-off state differs");
		await authority(checked);
		const after = await this.#client.getInstance(binding.project, plan.name, checked);
		if (!after || after.status !== "Stopped" || after.statusCode !== 102) throw new Error("power-off state changed");
		assertLxdOfficeGuestInstance(binding, after);
		await retained();
		checked.throwIfAborted();
		await retain(doneName, {
			schema: "qorpera.lxd-office-power-off-completion/v1",
			...result,
			requestSha256: officeDigest(seed),
			operationId: operation.operationId,
			instanceSha256,
			hostBootId: seed.hostBootId,
		});
		// An explicit power-off gives the node slot back until resume re-admits it.
		// A reboot resumes at once and keeps its slot. Every confirmed answer
		// (suspended, already suspended, kept NOT_RESERVED, or kept RESUME_PENDING)
		// is final for this transition: the lifecycle replays a stopped computer
		// every pass, and each call locks the node row (2026-09-28: 16 calls a
		// minute for 42 hours). A new process asks once more.
		if (recovery.action === "power_off" && this.#suspended !== suffix) {
			await suspendLxdOfficeNodeMachine(this.#policy, binding, transitionId, registry, checked);
			this.#suspended = suffix;
		}
		return { ...result, state: "powered_off" };
	}
}
