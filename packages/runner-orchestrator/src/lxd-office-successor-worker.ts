import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerLifecycleRequest,
	type CompanyComputerServiceSoftwarePlan,
	type CompanyComputerServiceSuccessor,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceSoftwarePlan,
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopRequest,
	parseCompanyComputerServiceSuccessor,
	parseCompanyComputerServiceSuccessorRequest,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import { type LxdOfficeServiceRestartClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import type { LxdOfficeRetainedActivationHistoryClient } from "./lxd-office-boot-restart-history.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeInvocationMeasurement } from "./lxd-office-invocation-measurement.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { officeStopDecode, officeStopHash, readLxdOfficeStopEvidence } from "./lxd-office-stop-evidence.ts";
import { LxdOfficeSuccessorControl, type LxdOfficeSuccessorRegistry } from "./lxd-office-successor-control.ts";
import { lxdOfficeSuccessorLane } from "./lxd-office-successor-lane.ts";

type Client = LxdOfficeRetainedActivationHistoryClient & LxdOfficeServiceRestartClient;
interface Ports {
	client?: Client;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
	/** A signed update reserves its successor identity before installation. */
	softwarePlan?: CompanyComputerServiceSoftwarePlan;
	measureInvocation?: LxdOfficeInvocationMeasurement;
}
export interface LxdOfficeSuccessorResult {
	state: "active" | "awaiting_readiness" | "pending" | "unknown" | "failed";
	intentId: string;
	allocationId: string;
	activationId: string;
	transitionId: string;
	commandId: string;
	serviceInvocationId?: string;
}
const pending = new Set<string>();

/** Explicit same-boot restart after retained SQL stop acknowledgement. The
 * supervisor owns the kernel lock and serialization with stop/other phases.
 * Requests precede SQL preparation and durable dispatch. A lost physical reply
 * can only be observed. A current SQL check is required before every effect;
 * fresh root inspection spans readiness checking and final SQL activation. */
export class LxdOfficeSuccessorWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #registry: LxdOfficeSuccessorRegistry;
	readonly #client: Client;
	readonly #kernelLock;
	readonly #softwarePlan;
	readonly #measureInvocation;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		registry: LxdOfficeSuccessorRegistry,
		ports: Ports = {},
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
		this.#softwarePlan =
			ports.softwarePlan === undefined ? undefined : parseCompanyComputerServiceSoftwarePlan(ports.softwarePlan);
		this.#measureInvocation = ports.measureInvocation;
		if (this.#softwarePlan && !this.#measureInvocation) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_REQUIRED");
	}
	reconcile(intentId: string, request: CompanyComputerLifecycleRequest, caller: AbortSignal) {
		return this.#reconcile(intentId, request, caller, false);
	}
	reconcileSettled(intentId: string, request: CompanyComputerLifecycleRequest, caller: AbortSignal) {
		return this.#reconcile(intentId, request, caller, true);
	}
	async #reconcile(intentId: string, value: CompanyComputerLifecycleRequest, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		const recovery = parseCompanyComputerLifecycleRequest(value),
			root = this.#policy.journal.path;
		if (recovery.action !== "service_restart") throw new Error("OFFICE_SUCCESSOR_ACTION_REQUIRED");
		if (this.#softwarePlan && !isDeepStrictEqual(recovery, this.#softwarePlan.predecessor))
			throw new Error("OFFICE_SOFTWARE_PREDECESSOR_CHANGED");
		if (pending.has(root)) throw new Error("OFFICE_SUCCESSOR_RECONCILIATION_PENDING");
		pending.add(root);
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
		let abort = () => {};
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("OFFICE_SUCCESSOR_RECONCILIATION_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const io = new Set<Promise<unknown>>();
		const registry: LxdOfficeSuccessorRegistry = {
			call: (method, args, checked) => {
				const operation = Promise.resolve().then(() => {
					checked.throwIfAborted();
					return this.#registry.call(method, args, checked);
				});
				io.add(operation);
				void operation.then(
					() => io.delete(operation),
					() => io.delete(operation),
				);
				return operation;
			},
		};
		const operation = this.#run(intentId, recovery, registry, signal)
			.catch((error) => {
				throw new Error("OFFICE_SUCCESSOR_UNCONFIRMED", { cause: error });
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
		registry: LxdOfficeSuccessorRegistry,
		signal: AbortSignal,
	): Promise<LxdOfficeSuccessorResult> {
		const root = this.#policy.journal.path;
		await this.#kernelLock(root);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal);
		const { binding } = creation,
			{ allocationId } = binding,
			{ transitionId } = recovery;
		const name = lxdOfficeGuestPlan(binding).request.name;
		const evidence = await readLxdOfficeStopEvidence(root, intentId, binding, recovery, this.#client, signal);
		const optional = async (name: string) => {
			try {
				return (await readRecord(join(root, name), 65536)).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				return undefined;
			}
		};
		const absent = async (names: string[]) => {
			for (const name of names) {
				try {
					await lstat(join(root, name));
					throw new Error("lost successor prefix");
				} catch (error) {
					if (!code(error, "ENOENT")) throw error;
				}
			}
		};
		const retain = async (name: string, value: unknown) => {
			signal.throwIfAborted();
			await publish(root, name, Buffer.from(officeCanonical(value)));
			if (!isDeepStrictEqual(await optional(name), value)) throw new Error("successor record changed");
		};
		const stopEnvelope = officeRecord(await optional(`service-stop-request-${allocationId}-${transitionId}.json`), [
			"schema",
			"request",
			"command",
		]);
		const stop = parseCompanyComputerServiceStopRequest(stopEnvelope.request),
			stopCommand = parseCompanyComputerPreparationCommand(stopEnvelope.command);
		if (
			stopEnvelope.schema !== "qorpera.lxd-office-stop-request/v1" ||
			!isDeepStrictEqual(stop.revocation.request, recovery) ||
			stop.startCompletionSha256 !== evidence.startCompletionSha256 ||
			stopCommand.requestSha256 !== officeStopHash(Buffer.from(officeCanonical(stop)))
		)
			throw new Error("predecessor stop differs");
		const stopMarker = officeRecord(await optional(`service-stop-completed-${allocationId}-${transitionId}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"transitionId",
			"commandId",
			"receipt",
		]);
		const acknowledgement = parseCompanyComputerServiceStopAcknowledgement(stopMarker.receipt, stop, stopCommand);
		if (
			!isDeepStrictEqual(stopMarker, {
				schema: "qorpera.lxd-office-stop-completion/v1",
				intentId,
				allocationId,
				transitionId,
				commandId: stopCommand.commandId,
				receipt: acknowledgement,
			})
		)
			throw new Error("stop acknowledgement differs");
		const stopPath = evidence.initial
			? "/run/qorpera-office-preparation/service-stop-completion.json"
			: `/run/qorpera-office-preparation/service-stop-completion-${recovery.activationId}.json`;
		const guestStop = async (checked: AbortSignal) => {
			const file = await this.#client.readInstanceFile(binding.project, name, stopPath, 8192, checked);
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== 0o600 ||
				file.content.length > 8192 ||
				!isDeepStrictEqual(officeStopDecode(file.content), acknowledgement.inspection.stop)
			)
				throw new Error("root stop differs");
			return officeStopHash(file.content);
		};
		const stopCompletionSha256 = await guestStop(signal);
		const physical = async (caller: AbortSignal) => {
			caller.throwIfAborted();
			await this.#kernelLock(root);
			if (
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, caller),
					creation,
				) ||
				!isDeepStrictEqual(
					await readLxdOfficeStopEvidence(root, intentId, binding, recovery, this.#client, caller),
					evidence,
				) ||
				!isDeepStrictEqual(
					await optional(`service-stop-request-${allocationId}-${transitionId}.json`),
					stopEnvelope,
				) ||
				!isDeepStrictEqual(
					await optional(`service-stop-completed-${allocationId}-${transitionId}.json`),
					stopMarker,
				) ||
				(await guestStop(caller)) !== stopCompletionSha256
			)
				throw new Error("retained stop changed");
			const gate = await this.#gate.check(binding, caller);
			if (gate.hostBootId !== evidence.hostBootId) throw new Error("successor host changed");
			const checked = AbortSignal.any([caller, gate.signal]);
			const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, checked);
			if (boot.bootId !== recovery.startup.bootId || boot.instanceSha256 !== recovery.startup.instanceSha256)
				throw new Error("successor boot changed");
			checked.throwIfAborted();
			return checked;
		};
		const seedName = `successor-request-${allocationId}-${transitionId}.json`,
			preparedName = `successor-prepared-${allocationId}-${transitionId}.json`;
		let seedValue = await optional(seedName);
		if (seedValue === undefined) {
			await absent([preparedName]);
			await physical(signal);
			seedValue = {
				schema: "qorpera.lxd-office-successor-request/v1",
				intentId,
				binding,
				request: parseCompanyComputerServiceSuccessorRequest({
					schema: "qorpera.office-service-successor-request/v1",
					predecessor: recovery,
					attestation: {
						...evidence.attestation,
						activationId: this.#softwarePlan?.successorActivationId ?? randomUUID(),
					},
				}),
				startObservationSha256: evidence.startObservationSha256,
			};
			await retain(seedName, seedValue);
		}
		const seed = officeRecord(seedValue, ["schema", "intentId", "binding", "request", "startObservationSha256"]),
			successorRequest = parseCompanyComputerServiceSuccessorRequest(seed.request);
		if (
			!isDeepStrictEqual(seed, {
				schema: "qorpera.lxd-office-successor-request/v1",
				intentId,
				binding,
				request: successorRequest,
				startObservationSha256: evidence.startObservationSha256,
			}) ||
			!isDeepStrictEqual(successorRequest.predecessor, recovery) ||
			(this.#softwarePlan !== undefined &&
				successorRequest.attestation.activationId !== this.#softwarePlan.successorActivationId) ||
			!isDeepStrictEqual(
				{ ...successorRequest.attestation, activationId: recovery.activationId },
				evidence.attestation,
			)
		)
			throw new Error("successor identity changed");
		const activationId = successorRequest.attestation.activationId,
			suffix = `${allocationId}-${activationId}`;
		const purpose = evidence.kind === "original" ? "service-restart" : "boot-service-restart";
		const packetName = `${purpose}-request-${suffix}.json`,
			indexName = `${purpose}-intent-${suffix}.json`,
			journalName = `${purpose}-${suffix}`,
			doneName = `successor-completed-${suffix}.json`;
		const control = new LxdOfficeSuccessorControl(successorRequest, registry);
		let preparedValue = await optional(preparedName);
		if (preparedValue === undefined) {
			await absent([packetName, indexName, journalName, doneName]);
			preparedValue = await control.prepare(await physical(signal));
			if ((preparedValue as CompanyComputerServiceSuccessor).state !== "prepared")
				throw new Error("lost prepared prefix");
			await retain(preparedName, preparedValue);
		}
		const prepared = parseCompanyComputerServiceSuccessor(preparedValue, successorRequest);
		if (prepared.state !== "prepared" || prepared.stopAcknowledgedAtMs !== acknowledgement.acknowledgedAtMs)
			throw new Error("prepared metadata differs");
		let state = prepared;
		const authorize = async (caller: AbortSignal) => {
			const checked = await physical(caller);
			if (
				!isDeepStrictEqual(await optional(seedName), seed) ||
				!isDeepStrictEqual(await optional(preparedName), prepared)
			)
				throw new Error("successor authority changed");
			const current = await control.check(checked);
			if (
				!isDeepStrictEqual(
					{ ...current.successor, state: "prepared", serviceInvocationId: null, readinessFresh: false },
					prepared,
				)
			)
				throw new Error("successor metadata rebound");
			state = current.successor;
			current.signal.throwIfAborted();
			return current.signal;
		};
		const lane = lxdOfficeSuccessorLane(
				root,
				binding,
				evidence,
				prepared,
				stop,
				acknowledgement,
				stopCompletionSha256,
				this.#client,
			),
			request = lane.request;
		const bytes = Buffer.from(officeCanonical(request));
		let packetValue = await optional(packetName);
		if (packetValue === undefined) {
			await absent([indexName, journalName, doneName]);
			await authorize(signal);
			if (state.state !== "prepared") throw new Error("unclaimed successor");
			packetValue = {
				schema: lane.packetSchema,
				intentId,
				binding,
				request,
				command: parseCompanyComputerPreparationCommand({
					commandId: randomUUID(),
					bootId: recovery.startup.bootId,
					requestSha256: officeStopHash(bytes),
				}),
			};
			await retain(packetName, packetValue);
		}
		const packet = officeRecord(packetValue, ["schema", "intentId", "binding", "request", "command"]),
			command = parseCompanyComputerPreparationCommand(packet.command);
		if (
			!isDeepStrictEqual(packet, {
				schema: lane.packetSchema,
				intentId,
				binding,
				request,
				command,
			}) ||
			command.requestSha256 !== officeStopHash(bytes) ||
			command.bootId !== recovery.startup.bootId ||
			[...evidence.forbiddenCommandIds, stopCommand.commandId].includes(command.commandId)
		)
			throw new Error("restart packet changed");
		const identity = {
			intentId,
			binding,
			bootObservationSha256: evidence.bootObservationSha256,
			command,
			activationId,
			transitionId,
			configurationObservationSha256: successorRequest.attestation.configurationObservationSha256,
			stopObservationSha256: officeDigest(acknowledgement),
			...lane.bootIdentity,
		};
		const index = { schema: lane.indexSchema, requestSha256: officeDigest(packet), identity };
		if ((await optional(indexName)) === undefined) {
			await absent([doneName]);
			let exists = true;
			try {
				await lstat(join(root, journalName));
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				exists = false;
			}
			const initial = await lane.openJournal(identity, exists);
			if ((await initial.observe(signal)).state !== "not_dispatched") throw new Error("restart index lost");
			await retain(indexName, index);
		}
		if (!isDeepStrictEqual(await optional(indexName), index)) throw new Error("restart index changed");
		const checkedRestart = async (caller: AbortSignal) => {
			const checked = await authorize(caller);
			if (
				!isDeepStrictEqual(await optional(packetName), packet) ||
				!isDeepStrictEqual(await optional(indexName), index)
			)
				throw new Error("restart evidence changed");
			checked.throwIfAborted();
			return checked;
		};
		const journal = await lane.openJournal(identity);
		let operation = await journal.observe(await checkedRestart(signal));
		if (operation.state === "not_dispatched") {
			if (state.state !== "prepared") throw new Error("unclaimed invocation");
			await lane.push(binding.project, name, command.requestSha256, bytes, await checkedRestart(signal));
			const staged = await lane.read(
				binding.project,
				name,
				command.requestSha256,
				bytes.length,
				await checkedRestart(signal),
			);
			if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o400 || !staged.content.equals(bytes))
				throw new Error("restart staging changed");
			const checked = await checkedRestart(signal);
			if (state.state !== "prepared") throw new Error("invocation already claimed");
			operation = await journal.reconcile(checked);
		}
		const result = { intentId, allocationId, activationId, transitionId, commandId: command.commandId };
		let file: Awaited<ReturnType<Client["readInstanceFile"]>>;
		const checked = await checkedRestart(signal);
		try {
			file = await this.#client.readInstanceFile(
				binding.project,
				name,
				`/run/qorpera-office-preparation/${purpose}-completion-${activationId}.json`,
				8192,
				checked,
			);
		} catch {
			checked.throwIfAborted();
			return {
				...result,
				state:
					operation.state === "succeeded" || operation.state === "not_dispatched" ? "unknown" : operation.state,
			};
		}
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o600 || file.content.length > 8192)
			throw new Error("restart completion custody");
		const completion = lane.parseCompletion(officeStopDecode(file.content), command);
		return lane.inspectAndUse(
			command,
			completion,
			checkedRestart,
			async (current, checked, assertFresh, deadline) => {
				const status = await control.status(checked);
				assertFresh();
				if (status.serviceInvocationId !== null && status.serviceInvocationId !== current.serviceInvocationId)
					throw new Error("successor invocation differs");
				if (status.state === "prepared" || (status.state === "ready" && !status.readinessFresh))
					return { ...result, state: "awaiting_readiness" as const };
				if (status.state === "ready" && this.#measureInvocation) {
					await this.#measureInvocation(
						activationId,
						parseCompanyComputerStartupIdentity({
							...recovery.startup,
							serviceInvocationId: current.serviceInvocationId,
							configurationSha256: current.configurationSha256,
						}),
						deadline,
						checked,
					);
					assertFresh();
				}
				await control.activate(current.serviceInvocationId, deadline, checked);
				assertFresh();
				await retain(doneName, {
					schema: "qorpera.lxd-office-successor-completion/v1",
					intentId,
					allocationId,
					activationId,
					commandId: command.commandId,
					predecessorActivationId: recovery.activationId,
					...(operation.operationId ? { operationId: operation.operationId } : {}),
					completion,
					requestSha256: command.requestSha256,
				});
				assertFresh();
				return { ...result, state: "active" as const, serviceInvocationId: current.serviceInvocationId };
			},
			signal,
		);
	}
}
