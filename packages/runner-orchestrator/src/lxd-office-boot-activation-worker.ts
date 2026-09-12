import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	type CompanyComputerBootSuccessor,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerBootServiceStartCompletion,
	parseCompanyComputerBootServiceStartRequest,
	parseCompanyComputerBootSuccessor,
	parseCompanyComputerBootSuccessorRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import { type LxdOfficeBootServiceStartClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import {
	type LxdOfficeBootActivationEvidenceClient,
	readLxdOfficeBootActivationEvidence,
} from "./lxd-office-boot-activation-evidence.ts";
import type { LxdOfficeBootConfigurationRequest } from "./lxd-office-boot-configuration-worker.ts";
import { LxdOfficeBootServiceInspectionControl } from "./lxd-office-boot-service-inspection.ts";
import { openLxdOfficeBootServiceStartJournal } from "./lxd-office-boot-service-start-journal.ts";
import {
	LxdOfficeBootSuccessorControl,
	type LxdOfficeBootSuccessorRegistry,
} from "./lxd-office-boot-successor-control.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeInvocationMeasurement } from "./lxd-office-invocation-measurement.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { officePhysicalPath, parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { officeStopHash as hash, officeStopDecode } from "./lxd-office-stop-evidence.ts";
import { readLxdOfficeStopHistory } from "./lxd-office-stop-history.ts";

type Client = LxdOfficeBootActivationEvidenceClient & LxdOfficeBootServiceStartClient;
interface Ports extends NonNullable<Parameters<typeof readLxdOfficeBootActivationEvidence>[5]> {
	client?: Client;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
	measureInvocation?: LxdOfficeInvocationMeasurement;
}
export interface LxdOfficeBootActivationResult {
	state: "active" | "awaiting_readiness" | "pending" | "unknown" | "failed";
	intentId: string;
	allocationId: string;
	activationId: string;
	bootIntentId: string;
	bootId: string;
	commandId: string;
	configurationObservationSha256: string;
	serviceInvocationId?: string;
}
const pending = new Set<string>();
/** Acknowledged configuration advances to one SQL-prepared ordinary start.
 * It never invokes VM resume or configuration. The supervisor holds the kernel
 * lock and retains a forward stage; metadata recovery is separate from fresh
 * physical/SQL dispatch checks and the single inspection-to-activation window. */
export class LxdOfficeBootActivationWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #registry: LxdOfficeBootSuccessorRegistry;
	readonly #client: Client;
	readonly #kernelLock;
	readonly #ports: Ports;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		registry: LxdOfficeBootSuccessorRegistry,
		ports: Ports = {},
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
		this.#ports = ports;
	}
	reconcile(input: LxdOfficeBootConfigurationRequest, caller: AbortSignal) {
		return this.#reconcile(input, caller, false);
	}
	reconcileSettled(input: LxdOfficeBootConfigurationRequest, caller: AbortSignal) {
		return this.#reconcile(input, caller, true);
	}
	async #reconcile(value: LxdOfficeBootConfigurationRequest, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		const input = {
				intentId: value.intentId,
				request: parseCompanyComputerBootIntentRequest(value.request),
				serviceBootstrapPath: officePhysicalPath(value.serviceBootstrapPath),
			},
			root = this.#policy.journal.path;
		if (pending.has(root)) throw new Error("OFFICE_BOOT_ACTIVATION_PENDING");
		pending.add(root);
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]),
			io = new Set<Promise<unknown>>();
		const registry: LxdOfficeBootSuccessorRegistry = {
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
			abort = () => reject(new Error("OFFICE_BOOT_ACTIVATION_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(input, registry, signal)
			.catch((error) => {
				throw new Error("OFFICE_BOOT_ACTIVATION_UNCONFIRMED", { cause: error });
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
		input: LxdOfficeBootConfigurationRequest,
		registry: LxdOfficeBootSuccessorRegistry,
		signal: AbortSignal,
	): Promise<LxdOfficeBootActivationResult> {
		const root = this.#policy.journal.path,
			{ intentId } = input,
			bootIntent = input.request;
		await this.#kernelLock(root);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal),
			{ binding } = creation,
			{ allocationId } = binding,
			evidence = await readLxdOfficeBootActivationEvidence(root, input, creation, this.#client, signal, this.#ports),
			name = lxdOfficeGuestPlan(binding).request.name;
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
					throw new Error("forward prefix lost");
				} catch (error) {
					if (!code(error, "ENOENT")) throw error;
				}
			}
		};
		const retain = async (name: string, value: unknown) => {
			signal.throwIfAborted();
			await publish(root, name, Buffer.from(officeCanonical(value)));
			if (!isDeepStrictEqual(await optional(name), value)) throw new Error("retained record changed");
		};
		const guest = async (
			path: string,
			limit: number,
			mode: number,
			checked: AbortSignal,
			verify: (bytes: Buffer) => boolean,
		) => {
			const file = await this.#client.readInstanceFile(binding.project, name, path, limit, checked);
			try {
				checked.throwIfAborted();
				if (
					file.uid !== 0 ||
					file.gid !== 0 ||
					file.mode !== mode ||
					file.content.length > limit ||
					!verify(file.content)
				)
					throw new Error("guest evidence changed");
			} finally {
				file.content.fill(0);
			}
		};
		const physical = async (caller: AbortSignal) => {
			caller.throwIfAborted();
			await this.#kernelLock(root);
			if (
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, caller),
					creation,
				) ||
				!isDeepStrictEqual(
					await readLxdOfficeBootActivationEvidence(root, input, creation, this.#client, caller, this.#ports),
					evidence,
				)
			)
				throw new Error("configured history changed");
			const archive = await readLxdOfficeStopHistory(
				this.#client,
				binding,
				evidence.shutdown.history.command,
				bootIntent.predecessor.activationId,
				evidence.shutdown.history.completionPath,
				Object.fromEntries(evidence.shutdown.history.entries.map((e) => [e.path, e.sha256])),
				caller,
			);
			if (archive.manifestSha256 !== bootIntent.stopHistorySha256) throw new Error("root shutdown history changed");
			const directory = companyComputerBootDirectory(evidence.bootId),
				{ configuration } = evidence;
			await guest(
				`${directory}/configuration-completion.json`,
				16384,
				0o600,
				caller,
				(bytes) =>
					hash(bytes) === evidence.configurationCompletionSha256 &&
					isDeepStrictEqual(officeStopDecode(bytes), configuration),
			);
			await guest(`${directory}/configuration-claim.json`, 4096, 0o600, caller, (bytes) =>
				isDeepStrictEqual(officeStopDecode(bytes), {
					schema: "qorpera.office-boot-configuration-claim/v1",
					command: configuration.command,
					bootIntentId: bootIntent.bootIntentId,
					activationId: bootIntent.activationId,
				}),
			);
			await guest(companyComputerBootAdoptionReceiptPath(evidence.bootId), 16384, 0o444, caller, (bytes) =>
				bytes.equals(evidence.receiptBytes),
			);
			for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES))
				await guest(
					`${directory}/credentials/${file}`,
					COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
					0o400,
					caller,
					(bytes) =>
						bytes.length === configuration.files[file].bytes && hash(bytes) === configuration.files[file].sha256,
				);
			const checked = await this.#gate.check(binding, caller);
			if (checked.hostBootId !== evidence.hostBootId) throw new Error("host changed");
			const bounded = AbortSignal.any([caller, checked.signal]),
				boot = await inspectLxdOfficeGuestBoot(this.#client, binding, bounded);
			if (boot.bootId !== evidence.bootId || boot.instanceSha256 !== bootIntent.predecessor.startup.instanceSha256)
				throw new Error("guest boot changed");
			bounded.throwIfAborted();
			return bounded;
		};
		const suffix = `${allocationId}-${bootIntent.activationId}`,
			seedName = `boot-successor-request-${suffix}.json`,
			preparedName = `boot-successor-prepared-${suffix}.json`,
			packetName = `boot-service-start-request-${suffix}.json`,
			indexName = `boot-service-start-intent-${suffix}.json`,
			journalName = `boot-service-start-${suffix}`,
			doneName = `boot-successor-completed-${suffix}.json`;
		const successorRequest = parseCompanyComputerBootSuccessorRequest({
			schema: "qorpera.office-boot-successor-request/v1",
			bootIntentId: bootIntent.bootIntentId,
			predecessor: bootIntent.predecessor,
			attestation: {
				schema: "qorpera.office-activation-attestation/v1",
				activationId: bootIntent.activationId,
				bootId: evidence.bootId,
				configurationSha256: evidence.configuration.files["config.json"].sha256,
				adoptionReceiptSha256: evidence.configuration.adoptionReceiptSha256,
				preparationObservationSha256: evidence.preparationObservationSha256,
				configurationObservationSha256: evidence.configurationObservationSha256,
				nativePort: evidence.nativePort,
				viewerPort: evidence.viewerPort,
			},
			stopHistorySha256: bootIntent.stopHistorySha256,
			powerOffCompletionSha256: bootIntent.powerOffCompletionSha256,
			bootObservationSha256: evidence.bootObservationSha256,
		});
		const seed = {
			schema: "qorpera.lxd-office-boot-successor-request/v1",
			intentId,
			binding,
			request: successorRequest,
			configurationObservationSha256: evidence.configurationObservationSha256,
		};
		if ((await optional(seedName)) === undefined) {
			await absent([preparedName, packetName, indexName, journalName, doneName]);
			await physical(signal);
			await retain(seedName, seed);
		}
		if (!isDeepStrictEqual(await optional(seedName), seed)) throw new Error("successor identity changed");
		const control = new LxdOfficeBootSuccessorControl(successorRequest, registry);
		let preparedValue = await optional(preparedName);
		if (preparedValue === undefined) {
			await absent([packetName, indexName, journalName, doneName]);
			preparedValue = await control.prepare(await physical(signal));
			if ((preparedValue as CompanyComputerBootSuccessor).state !== "prepared")
				throw new Error("prepared prefix lost");
			await retain(preparedName, preparedValue);
		}
		const prepared = parseCompanyComputerBootSuccessor(preparedValue, successorRequest);
		if (
			prepared.state !== "prepared" ||
			prepared.stopAcknowledgedAtMs !== evidence.stopAcknowledgedAtMs ||
			prepared.officeRevision !== evidence.officeRevision ||
			prepared.privacyVersion !== evidence.privacyVersion
		)
			throw new Error("prepared snapshot differs");
		let state: CompanyComputerBootSuccessor = prepared;
		const authorize = async (caller: AbortSignal) => {
			const checked = await physical(caller);
			if (
				!isDeepStrictEqual(await optional(seedName), seed) ||
				!isDeepStrictEqual(await optional(preparedName), prepared)
			)
				throw new Error("successor prefix changed");
			const current = await control.check(checked);
			if (
				!isDeepStrictEqual(
					{ ...current.successor, state: "prepared", serviceInvocationId: null, readinessFresh: false },
					prepared,
				)
			)
				throw new Error("successor snapshot rebound");
			state = current.successor;
			current.signal.throwIfAborted();
			return current.signal;
		};
		const request = parseCompanyComputerBootServiceStartRequest({
				schema: "qorpera.office-boot-service-start-request/v1",
				successor: prepared,
				configuration: evidence.configuration,
				configurationCompletionSha256: evidence.configurationCompletionSha256,
			}),
			bytes = Buffer.from(officeCanonical(request));
		let packetValue = await optional(packetName);
		if (packetValue === undefined) {
			await absent([indexName, journalName, doneName]);
			await authorize(signal);
			if (state.state !== "prepared") throw new Error("unclaimed successor");
			packetValue = {
				schema: "qorpera.lxd-office-boot-service-start-request/v1",
				intentId,
				binding,
				request,
				command: parseCompanyComputerPreparationCommand({
					commandId: randomUUID(),
					bootId: evidence.bootId,
					requestSha256: hash(bytes),
				}),
			};
			await retain(packetName, packetValue);
		}
		const packet = officeRecord(packetValue, ["schema", "intentId", "binding", "request", "command"]),
			command = parseCompanyComputerPreparationCommand(packet.command);
		if (
			!isDeepStrictEqual(packet, {
				schema: "qorpera.lxd-office-boot-service-start-request/v1",
				intentId,
				binding,
				request,
				command,
			}) ||
			command.requestSha256 !== hash(bytes) ||
			command.bootId !== evidence.bootId ||
			[
				evidence.configuration.command.commandId,
				evidence.preparationCommandId,
				evidence.resumeStartCommandId,
				evidence.shutdown.stopCommandId,
				evidence.shutdown.history.command.commandId,
			].includes(command.commandId)
		)
			throw new Error("start packet changed");
		const identity = {
				intentId,
				binding,
				bootObservationSha256: evidence.bootObservationSha256,
				configurationObservationSha256: evidence.configurationObservationSha256,
				bootIntentId: bootIntent.bootIntentId,
				activationId: bootIntent.activationId,
				command,
			},
			index = {
				schema: "qorpera.lxd-office-boot-service-start-intent/v1",
				requestSha256: officeDigest(packet),
				identity,
			};
		if ((await optional(indexName)) === undefined) {
			await absent([doneName]);
			let exists = true;
			try {
				await lstat(join(root, journalName));
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				exists = false;
			}
			const initial = await openLxdOfficeBootServiceStartJournal(root, identity, this.#client, exists);
			if ((await initial.observe(signal)).state !== "not_dispatched") throw new Error("start index lost");
			await retain(indexName, index);
		}
		if (!isDeepStrictEqual(await optional(indexName), index)) throw new Error("start index changed");
		const checkedStart = async (caller: AbortSignal) => {
			const checked = await authorize(caller);
			if (
				!isDeepStrictEqual(await optional(packetName), packet) ||
				!isDeepStrictEqual(await optional(indexName), index)
			)
				throw new Error("start evidence changed");
			checked.throwIfAborted();
			return checked;
		};
		const journal = await openLxdOfficeBootServiceStartJournal(root, identity, this.#client);
		let operation = await journal.observe(await checkedStart(signal));
		if (operation.state === "not_dispatched") {
			await absent([doneName]);
			if (state.state !== "prepared") throw new Error("unclaimed invocation");
			await guest(
				"/run/qorpera-office-preparation/control.lock",
				1,
				0o600,
				await checkedStart(signal),
				(bytes) => bytes.length === 0,
			);
			await this.#client.pushOfficeBootServiceStartRequest(
				binding.project,
				name,
				command.requestSha256,
				bytes,
				await checkedStart(signal),
			);
			const staged = await this.#client.readOfficeBootServiceStartRequest(
				binding.project,
				name,
				command.requestSha256,
				bytes.length,
				await checkedStart(signal),
			);
			if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o400 || !staged.content.equals(bytes))
				throw new Error("start staging changed");
			const checked = await checkedStart(signal);
			if (state.state !== "prepared") throw new Error("invocation already claimed");
			operation = await journal.reconcile(checked);
		}
		const result = {
			intentId,
			allocationId,
			activationId: bootIntent.activationId,
			bootIntentId: bootIntent.bootIntentId,
			bootId: evidence.bootId,
			commandId: command.commandId,
			configurationObservationSha256: evidence.configurationObservationSha256,
		};
		const checked = await checkedStart(signal);
		let file: Awaited<ReturnType<Client["readInstanceFile"]>>;
		try {
			file = await this.#client.readInstanceFile(
				binding.project,
				name,
				"/run/qorpera-office-preparation/boot-service-start-completion.json",
				8192,
				checked,
			);
		} catch {
			checked.throwIfAborted();
			if ((await optional(doneName)) !== undefined) throw new Error("acknowledged completion missing");
			return {
				...result,
				state:
					operation.state === "succeeded" || operation.state === "not_dispatched" ? "unknown" : operation.state,
			};
		}
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o600 || file.content.length > 8192)
			throw new Error("start completion custody");
		const completion = parseCompanyComputerBootServiceStartCompletion(
				officeStopDecode(file.content),
				command,
				request,
			),
			inspection = new LxdOfficeBootServiceInspectionControl(root, binding, this.#client);
		return inspection.inspectAndUse(
			command,
			request,
			completion,
			checkedStart,
			async (current, checked, assertFresh, deadline) => {
				const status = await control.status(checked);
				assertFresh();
				if (status.serviceInvocationId !== null && status.serviceInvocationId !== current.serviceInvocationId)
					throw new Error("successor invocation differs");
				if (status.state === "prepared" || (status.state === "ready" && !status.readinessFresh))
					return { ...result, state: "awaiting_readiness" as const };
				if (status.state === "ready" && this.#ports.measureInvocation) {
					await this.#ports.measureInvocation(
						bootIntent.activationId,
						parseCompanyComputerStartupIdentity({
							...bootIntent.predecessor.startup,
							bootId: evidence.bootId,
							configurationSha256: current.configurationSha256,
							serviceInvocationId: current.serviceInvocationId,
						}),
						deadline,
						checked,
					);
					assertFresh();
				}
				await control.activate(current.serviceInvocationId, deadline, checked);
				assertFresh();
				await retain(doneName, {
					schema: "qorpera.lxd-office-boot-successor-completion/v1",
					...result,
					predecessorActivationId: bootIntent.predecessor.activationId,
					...(operation.operationId ? { operationId: operation.operationId } : {}),
					completion,
					requestSha256: command.requestSha256,
				});
				assertFresh();
				return { ...result, state: "active" as const, serviceInvocationId: current.serviceInvocationId };
			},
			signal,
			true,
		);
	}
}
