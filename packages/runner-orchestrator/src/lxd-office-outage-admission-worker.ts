import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	parseCompanyComputerOutageServiceStartCompletion,
	parseCompanyComputerOutageServiceStartRequest,
	parseCompanyComputerOutageSuccessor,
	parseCompanyComputerOutageSuccessorRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import type { PaidComputerGuardRecord } from "./computer-paid-guard.ts";
import type { LxdOfficeOutageServiceStartClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeInvocationMeasurement } from "./lxd-office-invocation-measurement.ts";
import type { LxdOfficeOutageConfigurationWorker } from "./lxd-office-outage-configuration-worker.ts";
import { readOptionalOutageRecord, retainOutageRecord } from "./lxd-office-outage-history.ts";
import {
	type LxdOfficeOutageRecoveryRegistry,
	trackLxdOfficeOutageRegistry,
} from "./lxd-office-outage-recovery-control.ts";
import { LxdOfficeOutageServiceInspectionControl } from "./lxd-office-outage-service-inspection.ts";
import { LxdOfficeOutageSuccessorControl } from "./lxd-office-outage-successor-control.ts";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const pending = new Set<string>();
export type LxdOfficeOutageAdmissionPort = Pick<
	LxdOfficeOutageServiceStartClient,
	| "getInstance"
	| "getInstanceState"
	| "readInstanceFile"
	| "submitInstanceOperation"
	| "inspectInstanceOperation"
	| "submitOfficeOutageServiceStart"
	| "inspectOfficeOutageServiceStart"
	| "pushOfficeOutageServiceStartRequest"
	| "readOfficeOutageServiceStartRequest"
	| "submitOfficeOutageServiceInspection"
>;
/** Completes one retained recovery. Root start is dispatched once; unknown
 * replies recover from exact root evidence and a new bounded inspection.
 * No earlier phase check is reused as authority for successor admission. */
export class LxdOfficeOutageAdmissionWorker {
	readonly configuration: LxdOfficeOutageConfigurationWorker;
	readonly client: LxdOfficeOutageAdmissionPort;
	readonly options: { measureInvocation?: LxdOfficeInvocationMeasurement };
	constructor(
		configuration: LxdOfficeOutageConfigurationWorker,
		client: LxdOfficeOutageAdmissionPort,
		options: { measureInvocation?: LxdOfficeInvocationMeasurement } = {},
	) {
		this.configuration = configuration;
		this.client = client;
		this.options = options;
	}
	async reconcile(
		intentId: string,
		guard: PaidComputerGuardRecord,
		serviceBootstrapPath: string,
		signal: AbortSignal,
	) {
		const root = this.configuration.termination.resume.gate.policy.journal.path;
		if (pending.has(root)) throw new Error("OFFICE_OUTAGE_ADMISSION_PENDING");
		pending.add(root);
		const tracked = trackLxdOfficeOutageRegistry(this.configuration.termination.resume.registry);
		try {
			return await this.#run(intentId, guard, serviceBootstrapPath, signal, tracked.registry);
		} finally {
			await tracked.settle();
			pending.delete(root);
		}
	}
	async #run(
		intentId: string,
		guard: PaidComputerGuardRecord,
		serviceBootstrapPath: string,
		signal: AbortSignal,
		registry: LxdOfficeOutageRecoveryRegistry,
	) {
		const configured = await this.configuration.reconcile(intentId, guard, serviceBootstrapPath, signal);
		if (configured.state !== "awaiting_admission") return configured;
		const {
				request: base,
				recovery,
				observation,
				termination,
				completion: configuration,
				completionSha256,
				bootObservationSha256,
			} = configured,
			resume = this.configuration.termination.resume,
			root = resume.gate.policy.journal.path,
			creation = await openLxdOfficeCreationIdentity(resume.gate.policy, intentId, true, this.client, signal),
			{ binding } = creation,
			{ allocationId } = binding,
			activationId = base.activationId,
			bootId = observation.bootId,
			name = lxdOfficeGuestPlan(binding).request.name,
			directory = companyComputerBootDirectory(bootId),
			suffix = `${allocationId}-${activationId}`,
			configurationObservationSha256 = officeDigest(configured.configured),
			seedName = `outage-successor-request-${suffix}.json`,
			preparedName = `outage-successor-prepared-${suffix}.json`,
			packetName = `outage-service-start-request-${suffix}.json`,
			indexName = `outage-service-start-intent-${suffix}.json`,
			doneName = `outage-service-start-completed-${suffix}.json`,
			activeName = `outage-activation-completed-${suffix}.json`,
			journalName = `outage-service-start-${suffix}`;
		const absent = async (names: string[]) => {
			for (const item of names)
				if ((await readOptionalOutageRecord(root, item)) !== undefined)
					throw new Error("OFFICE_OUTAGE_ADMISSION_PREFIX_LOST");
		};
		const guest = async (path: string, limit: number, mode: number, checked: AbortSignal) => {
			const file = await this.client.readInstanceFile(binding.project, name, path, limit, checked);
			if (file.uid !== 0 || file.gid !== 0 || file.mode !== mode || file.content.length > limit) {
				file.content.fill(0);
				throw new Error("OFFICE_OUTAGE_ADMISSION_CUSTODY_INVALID");
			}
			checked.throwIfAborted();
			return file.content;
		};
		const physical = async (caller: AbortSignal) => {
			await (resume.ports.kernelLock ?? assertOfficeAdoptionKernelLock)(root);
			if (
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(resume.gate.policy, intentId, true, this.client, caller),
					creation,
				) ||
				!isDeepStrictEqual(
					await readOptionalOutageRecord(root, `outage-configuration-observation-${suffix}.json`),
					configured.configured,
				) ||
				!isDeepStrictEqual(
					await readOptionalOutageRecord(root, `outage-configuration-completed-${suffix}.json`),
					configured.marker,
				)
			)
				throw new Error("OFFICE_OUTAGE_ADMISSION_HISTORY_CHANGED");
			const sampled = await resume.gate.check(binding, caller),
				checked = AbortSignal.any([caller, sampled.signal]);
			if (sampled.hostBootId !== observation.hostBootId) throw new Error("OFFICE_OUTAGE_ADMISSION_HOST_CHANGED");
			const instance = await this.client.getInstance(binding.project, name, checked);
			if (
				instance?.config["volatile.uuid"] !== observation.physicalInstanceId ||
				instance.expandedConfig["volatile.uuid"] !== observation.physicalInstanceId
			)
				throw new Error("OFFICE_OUTAGE_ADMISSION_VM_CHANGED");
			await resume.ports.paidComputer.assertActive(binding, checked);
			if (
				!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.client, binding, checked), {
					bootId,
					instanceSha256: observation.instanceSha256,
				})
			)
				throw new Error("OFFICE_OUTAGE_ADMISSION_BOOT_CHANGED");
			const completed = await guest(`${directory}/configuration-completion.json`, 16384, 0o600, checked);
			if (
				hash(completed) !== completionSha256 ||
				!isDeepStrictEqual(JSON.parse(completed.toString()), configuration)
			)
				throw new Error("OFFICE_OUTAGE_ADMISSION_CONFIGURATION_CHANGED");
			if (
				!isDeepStrictEqual(
					JSON.parse((await guest(`${directory}/configuration-claim.json`, 4096, 0o600, checked)).toString()),
					{
						schema: "qorpera.office-outage-configuration-claim/v1",
						command: configuration.command,
						recoveryId: base.recoveryId,
						activationId,
					},
				)
			)
				throw new Error("OFFICE_OUTAGE_ADMISSION_CLAIM_CHANGED");
			if (
				hash(await guest(companyComputerBootAdoptionReceiptPath(bootId), 65536, 0o444, checked)) !==
				configuration.adoptionReceiptSha256
			)
				throw new Error("OFFICE_OUTAGE_ADMISSION_ADOPTION_CHANGED");
			for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
				const bytes = await guest(
					`${directory}/credentials/${file}`,
					COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
					0o400,
					checked,
				);
				try {
					if (bytes.length !== configuration.files[file].bytes || hash(bytes) !== configuration.files[file].sha256)
						throw new Error("OFFICE_OUTAGE_ADMISSION_CREDENTIALS_CHANGED");
				} finally {
					bytes.fill(0);
				}
			}
			checked.throwIfAborted();
			return checked;
		};
		const configBytes = await guest(
			`${directory}/credentials/config.json`,
			COMPANY_COMPUTER_CONFIGURATION_LIMITS.configuration,
			0o400,
			await physical(signal),
		);
		let nativePort: unknown, viewerPort: unknown;
		try {
			if (hash(configBytes) !== configuration.files["config.json"].sha256)
				throw new Error("OFFICE_OUTAGE_ADMISSION_CONFIGURATION_CHANGED");
			const config: { native?: { port?: unknown }; viewer?: { port?: unknown } } = JSON.parse(
				configBytes.toString(),
			);
			nativePort = config.native?.port;
			viewerPort = config.viewer?.port;
		} finally {
			configBytes.fill(0);
		}
		const successorRequest = parseCompanyComputerOutageSuccessorRequest({
			schema: "qorpera.office-outage-successor-request/v1",
			recovery: base,
			termination,
			attestation: {
				schema: "qorpera.office-activation-attestation/v1",
				activationId,
				bootId,
				configurationSha256: configuration.files["config.json"].sha256,
				adoptionReceiptSha256: configuration.adoptionReceiptSha256,
				preparationObservationSha256: bootObservationSha256,
				configurationObservationSha256,
				nativePort,
				viewerPort,
			},
		});
		const seed = {
			schema: "qorpera.lxd-office-outage-successor-request/v1",
			intentId,
			binding,
			request: successorRequest,
			configurationObservationSha256,
		};
		if ((await readOptionalOutageRecord(root, seedName)) === undefined) {
			await absent([preparedName, packetName, indexName, `${journalName}/authority.json`, doneName, activeName]);
			await retainOutageRecord(root, seedName, seed);
		} else if (!isDeepStrictEqual(await readOptionalOutageRecord(root, seedName), seed))
			throw new Error("OFFICE_OUTAGE_SUCCESSOR_CHANGED");
		const control = new LxdOfficeOutageSuccessorControl(successorRequest, registry);
		let preparedValue = await readOptionalOutageRecord(root, preparedName);
		if (preparedValue === undefined) {
			await absent([packetName, indexName, `${journalName}/authority.json`, doneName, activeName]);
			const prepared = await control.prepare(await physical(signal));
			if (prepared.state !== "prepared") throw new Error("OFFICE_OUTAGE_PREPARED_PREFIX_LOST");
			preparedValue = prepared;
			await retainOutageRecord(root, preparedName, preparedValue);
		}
		const prepared = parseCompanyComputerOutageSuccessor(preparedValue, successorRequest);
		if (
			prepared.state !== "prepared" ||
			prepared.officeRevision !== termination.officeRevision ||
			prepared.privacyVersion !== recovery.privacyVersion
		)
			throw new Error("OFFICE_OUTAGE_PREPARED_SNAPSHOT_CHANGED");
		let state = prepared;
		const authorize = async (caller: AbortSignal) => {
			const checked = await physical(caller);
			if (
				!isDeepStrictEqual(await readOptionalOutageRecord(root, seedName), seed) ||
				!isDeepStrictEqual(await readOptionalOutageRecord(root, preparedName), prepared)
			)
				throw new Error("OFFICE_OUTAGE_SUCCESSOR_PREFIX_CHANGED");
			const current = await control.check(checked);
			if (
				!isDeepStrictEqual(
					{ ...current.successor, state: "prepared", serviceInvocationId: null, readinessFresh: false },
					prepared,
				)
			)
				throw new Error("OFFICE_OUTAGE_SUCCESSOR_SNAPSHOT_CHANGED");
			state = current.successor;
			return current.signal;
		};
		const request = parseCompanyComputerOutageServiceStartRequest({
				schema: "qorpera.office-outage-service-start-request/v1",
				successor: prepared,
				configuration,
				configurationCompletionSha256: completionSha256,
			}),
			bytes = Buffer.from(officeCanonical(request));
		let packetValue = await readOptionalOutageRecord(root, packetName);
		if (packetValue === undefined) {
			await absent([indexName, `${journalName}/authority.json`, doneName, activeName]);
			await authorize(signal);
			if (state.state !== "prepared") throw new Error("OFFICE_OUTAGE_INVOCATION_UNCLAIMED");
			packetValue = {
				schema: "qorpera.lxd-office-outage-service-start-request/v1",
				intentId,
				binding,
				request,
				command: { commandId: randomUUID(), requestSha256: hash(bytes), bootId },
			};
			await retainOutageRecord(root, packetName, packetValue);
		}
		const packet = officeRecord(packetValue, ["schema", "intentId", "binding", "request", "command"]),
			command = parseCompanyComputerPreparationCommand(packet.command);
		if (
			!isDeepStrictEqual(packet, {
				schema: "qorpera.lxd-office-outage-service-start-request/v1",
				intentId,
				binding,
				request,
				command,
			}) ||
			command.requestSha256 !== hash(bytes) ||
			command.bootId !== bootId ||
			[
				configuration.command.commandId,
				base.startCommandId,
				termination.request.inspection.command.commandId,
			].includes(command.commandId)
		)
			throw new Error("OFFICE_OUTAGE_START_PACKET_CHANGED");
		const identity = {
				intentId,
				binding,
				bootObservationSha256,
				configurationObservationSha256,
				recoveryId: base.recoveryId,
				activationId,
				command,
			},
			index = {
				schema: "qorpera.lxd-office-outage-service-start-intent/v1",
				requestSha256: officeDigest(packet),
				identity,
			};
		const exists = (await readOptionalOutageRecord(root, `${journalName}/authority.json`)) !== undefined;
		if (!exists && (await readOptionalOutageRecord(root, indexName)) !== undefined)
			throw new Error("OFFICE_OUTAGE_START_JOURNAL_LOST");
		const journal = await LxdOfficeControlJournal.open(
			root,
			identity,
			{
				submit: this.client.submitOfficeOutageServiceStart.bind(this.client),
				inspect: this.client.inspectOfficeOutageServiceStart.bind(this.client),
			},
			exists,
			"outage-service-start",
		);
		if ((await readOptionalOutageRecord(root, indexName)) === undefined) {
			await absent([doneName, activeName]);
			if ((await journal.observe(signal)).state !== "not_dispatched")
				throw new Error("OFFICE_OUTAGE_START_INDEX_LOST");
		}
		await retainOutageRecord(root, indexName, index);
		const checkedStart = async (caller: AbortSignal) => {
			const checked = await authorize(caller);
			if (
				!isDeepStrictEqual(await readOptionalOutageRecord(root, packetName), packet) ||
				!isDeepStrictEqual(await readOptionalOutageRecord(root, indexName), index)
			)
				throw new Error("OFFICE_OUTAGE_START_PREFIX_CHANGED");
			checked.throwIfAborted();
			return checked;
		};
		let operation = await journal.observe(await checkedStart(signal));
		if (operation.state === "not_dispatched") {
			await absent([doneName, activeName]);
			if (state.state !== "prepared") throw new Error("OFFICE_OUTAGE_INVOCATION_UNCLAIMED");
			if (
				(await guest("/run/qorpera-office-preparation/control.lock", 1, 0o600, await checkedStart(signal)))
					.length !== 0
			)
				throw new Error("OFFICE_OUTAGE_LOCK_CHANGED");
			await this.client.pushOfficeOutageServiceStartRequest(
				binding.project,
				name,
				command.requestSha256,
				bytes,
				await checkedStart(signal),
			);
			const staged = await this.client.readOfficeOutageServiceStartRequest(
				binding.project,
				name,
				command.requestSha256,
				bytes.length,
				await checkedStart(signal),
			);
			if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o400 || !staged.content.equals(bytes))
				throw new Error("OFFICE_OUTAGE_START_STAGE_CHANGED");
			const checked = await checkedStart(signal);
			if (state.state !== "prepared") throw new Error("OFFICE_OUTAGE_INVOCATION_ALREADY_CLAIMED");
			operation = await journal.reconcile(checked);
		}
		const result = {
			intentId,
			allocationId,
			recoveryId: base.recoveryId,
			activationId,
			bootId,
			commandId: command.commandId,
			configurationObservationSha256,
		};
		let completionBytes: Buffer;
		try {
			completionBytes = await guest(
				"/run/qorpera-office-preparation/outage-service-start-completion.json",
				8192,
				0o600,
				await checkedStart(signal),
			);
		} catch (error) {
			signal.throwIfAborted();
			if (operation.state === "succeeded") throw error;
			return { ...result, state: operation.state === "not_dispatched" ? ("unknown" as const) : operation.state };
		}
		const completion = parseCompanyComputerOutageServiceStartCompletion(
				JSON.parse(completionBytes.toString()),
				command,
				request,
			),
			inspection = new LxdOfficeOutageServiceInspectionControl(root, binding, this.client);
		return inspection.inspectAndUse(
			command,
			request,
			completion,
			checkedStart,
			async (current, checked, assertFresh, deadline) => {
				const status = await control.status(checked);
				assertFresh();
				if (status.serviceInvocationId !== null && status.serviceInvocationId !== current.serviceInvocationId)
					throw new Error("OFFICE_OUTAGE_INVOCATION_CHANGED");
				if (status.state === "prepared" || (status.state === "ready" && !status.readinessFresh))
					return { ...result, state: "awaiting_readiness" as const };
				if (status.state === "ready" && this.options.measureInvocation) {
					await this.options.measureInvocation(
						activationId,
						parseCompanyComputerStartupIdentity({
							...recovery.predecessor.startup,
							bootId,
							configurationSha256: current.configurationSha256,
							serviceInvocationId: current.serviceInvocationId,
						}),
						deadline,
						checked,
					);
					assertFresh();
				}
				const activation = await control.activate(current.serviceInvocationId, deadline, checked);
				assertFresh();
				const marker = {
					schema: "qorpera.lxd-office-outage-service-start-completion/v1",
					...result,
					predecessorActivationId: recovery.predecessor.activationId,
					...(operation.operationId ? { operationId: operation.operationId } : {}),
					completion,
					requestSha256: command.requestSha256,
				};
				await retainOutageRecord(root, doneName, marker);
				await retainOutageRecord(root, activeName, {
					schema: "qorpera.lxd-office-outage-activation-completion/v1",
					intentId,
					allocationId,
					recoveryId: base.recoveryId,
					activationId,
					startCommandId: command.commandId,
					startObservationSha256: officeDigest(marker),
					activation,
				});
				assertFresh();
				return { ...result, state: "active" as const, serviceInvocationId: current.serviceInvocationId };
			},
			signal,
			true,
		);
	}
}
