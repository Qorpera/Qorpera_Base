import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerOutageConfigurationCompletion,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	parseCompanyComputerOutageConfigurationAuthority,
	parseCompanyComputerOutageConfigurationCompletion,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import type { PaidComputerGuardRecord } from "./computer-paid-guard.ts";
import type { LxdOfficeOutageConfigurationClient } from "./lxd-client.ts";
import { LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { createLxdOfficeOutageConfigurationPayload } from "./lxd-office-outage-configuration-payload.ts";
import { readOptionalOutageRecord, retainOutageRecord } from "./lxd-office-outage-history.ts";
import type { LxdOfficeOutageTerminationWorker } from "./lxd-office-outage-termination-worker.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";
import { assertLxdOfficeServiceBootstrapContinuity } from "./lxd-office-service-bootstrap-revisions.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const pending = new Set<string>();
type SourcePorts = Parameters<typeof createLxdOfficeOutageConfigurationPayload>[8];
export type LxdOfficeOutageConfigurationPort = Pick<
	LxdOfficeOutageConfigurationClient,
	| "getInstance"
	| "getInstanceState"
	| "readInstanceFile"
	| "submitInstanceOperation"
	| "inspectInstanceOperation"
	| "submitOfficeOutageConfiguration"
	| "inspectOfficeOutageConfiguration"
	| "pushOfficeOutageConfigurationRequest"
	| "readOfficeOutageConfigurationRequest"
>;
export class LxdOfficeOutageConfigurationWorker {
	readonly termination: LxdOfficeOutageTerminationWorker;
	readonly client: LxdOfficeOutageConfigurationPort;
	readonly sources: SourcePorts;
	constructor(
		termination: LxdOfficeOutageTerminationWorker,
		client: LxdOfficeOutageConfigurationPort,
		sources: SourcePorts = {},
	) {
		this.termination = termination;
		this.client = client;
		this.sources = sources;
	}
	async reconcile(
		intentId: string,
		guard: PaidComputerGuardRecord,
		serviceBootstrapPath: string,
		signal: AbortSignal,
	) {
		const root = this.termination.resume.gate.policy.journal.path;
		if (pending.has(root)) throw new Error("OFFICE_OUTAGE_CONFIGURATION_PENDING");
		pending.add(root);
		try {
			return await this.#run(intentId, guard, officePhysicalPath(serviceBootstrapPath), signal);
		} finally {
			pending.delete(root);
		}
	}
	async #run(intentId: string, guard: PaidComputerGuardRecord, serviceBootstrapPath: string, signal: AbortSignal) {
		const terminated = await this.termination.reconcile(intentId, guard, signal);
		if (terminated.state !== "awaiting_configuration") return terminated;
		const { recovery, observation, termination, request, bootObservationSha256 } = terminated,
			resume = this.termination.resume,
			root = resume.gate.policy.journal.path,
			creation = await openLxdOfficeCreationIdentity(resume.gate.policy, intentId, true, this.client, signal),
			{ binding } = creation,
			allocationId = binding.allocationId,
			bootId = observation.bootId,
			suffix = `${allocationId}-${request.activationId}`,
			indexName = `outage-configuration-intent-${suffix}.json`,
			observationName = `outage-configuration-observation-${suffix}.json`,
			completedName = `outage-configuration-completed-${suffix}.json`,
			originalFile = await readRecord(
				join(root, `preparation-request-${allocationId}.json`),
				COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			),
			original = parseCompanyComputerPreparationRequest(originalFile.value),
			evidence = (await readRecord(join(root, `preparation-observation-${allocationId}.json`))).value;
		if (
			!evidence ||
			typeof evidence !== "object" ||
			!("commandId" in evidence) ||
			!("bootId" in evidence) ||
			!("requestSha256" in evidence)
		)
			throw new Error("OFFICE_OUTAGE_PREPARATION_PREFIX_LOST");
		const preparation = parseCompanyComputerPreparationCommand({
			commandId: evidence.commandId,
			bootId: evidence.bootId,
			requestSha256: evidence.requestSha256,
		});
		if (preparation.requestSha256 !== hash(originalFile.bytes) || original.bootId !== preparation.bootId)
			throw new Error("OFFICE_OUTAGE_PREPARATION_CHANGED");
		const build = () =>
			createLxdOfficeOutageConfigurationPayload(
				serviceBootstrapPath,
				binding,
				original,
				preparation,
				recovery,
				observation,
				termination,
				signal,
				this.sources,
			);
		const payload = await build();
		try {
			const requestSha256 = hash(payload.bytes),
				expected = {
					schema: "qorpera.lxd-office-outage-configuration-intent/v1",
					intentId,
					allocationId,
					recoveryId: request.recoveryId,
					activationId: request.activationId,
					bootId,
					bootObservationSha256,
					originPreparationSha256: preparation.requestSha256,
					serviceBootstrapSha256: payload.serviceBootstrapSha256,
					serviceBootstrapPath,
					requestSha256,
					requestBytes: payload.bytes.length,
				};
			let saved = await readOptionalOutageRecord(root, indexName);
			const wasCompleted = await readOptionalOutageRecord(root, completedName);
			const physical = async () => {
				const sample = await resume.gate.check(binding, signal);
				if (sample.hostBootId !== observation.hostBootId) throw new Error("OFFICE_OUTAGE_HOST_CHANGED");
				const checked = AbortSignal.any([signal, sample.signal]),
					vm = await this.client.getInstance(binding.project, lxdOfficeGuestPlan(binding).request.name, checked);
				if (
					vm?.config["volatile.uuid"] !== observation.physicalInstanceId ||
					vm.expandedConfig["volatile.uuid"] !== observation.physicalInstanceId
				)
					throw new Error("OFFICE_OUTAGE_VM_CHANGED");
				await resume.ports.paidComputer.assertActive(binding, checked);
				if (
					!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.client, binding, checked), {
						bootId,
						instanceSha256: observation.instanceSha256,
					})
				)
					throw new Error("OFFICE_OUTAGE_BOOT_CHANGED");
				return checked;
			};
			const authorize = async () => {
				const rebuilt = await build();
				try {
					if (
						!rebuilt.bytes.equals(payload.bytes) ||
						rebuilt.serviceBootstrapSha256 !== payload.serviceBootstrapSha256
					)
						throw new Error("OFFICE_OUTAGE_PROTECTED_SOURCES_CHANGED");
				} finally {
					rebuilt.bytes.fill(0);
				}
				const checked = await physical();
				if (wasCompleted !== undefined) return checked;
				const started = performance.now(),
					authority = parseCompanyComputerOutageConfigurationAuthority(
						await resume.registry.call(
							"qorpera_check_runtime_office_outage_configuration",
							{ p_request: { recovery: request, termination } },
							checked,
						),
						{ recovery: request, termination },
					);
				if (!isDeepStrictEqual(authority.recovery, recovery))
					throw new Error("OFFICE_OUTAGE_CONFIGURATION_SNAPSHOT_CHANGED");
				const remaining = Math.floor(authority.validForMs - (performance.now() - started));
				if (remaining < 1) throw new Error("OFFICE_OUTAGE_CONFIGURATION_AUTHORITY_EXPIRED");
				return AbortSignal.any([checked, AbortSignal.timeout(remaining)]);
			};
			if (saved === undefined) {
				if (wasCompleted !== undefined || (await readOptionalOutageRecord(root, observationName)) !== undefined)
					throw new Error("OFFICE_OUTAGE_CONFIGURATION_PREFIX_LOST");
				const candidates: string[] = [];
				for (const name of await readdir(root)) {
					if (
						!(
							name === `configuration-intent-${allocationId}.json` ||
							["boot-configuration-intent", "outage-configuration-intent", "reset-configuration"].some(
								(prefix) => name.startsWith(`${prefix}-${allocationId}-`) && name.endsWith(".json"),
							)
						)
					)
						continue;
					const value = (await readRecord(join(root, name))).value;
					if (
						value &&
						typeof value === "object" &&
						"bootId" in value &&
						value.bootId === recovery.predecessor.startup.bootId &&
						"serviceBootstrapSha256" in value
					)
						candidates.push(officeSha(value.serviceBootstrapSha256));
				}
				if (candidates.length !== 1) throw new Error("OFFICE_OUTAGE_BOOTSTRAP_PREDECESSOR_AMBIGUOUS");
				const read = this.sources?.readProtected ?? readLxdOfficeProtectedFile,
					planBytes = await read(serviceBootstrapPath, 16384);
				if (hash(planBytes) !== payload.serviceBootstrapSha256) throw new Error("OFFICE_OUTAGE_BOOTSTRAP_CHANGED");
				await assertLxdOfficeServiceBootstrapContinuity(
					{ planBytes, planPath: serviceBootstrapPath, predecessorSha256: candidates[0], binding },
					read,
					signal,
				);
				await authorize();
				const command = parseCompanyComputerPreparationCommand({ commandId: randomUUID(), bootId, requestSha256 });
				await LxdOfficeControlJournal.open(
					root,
					{
						intentId,
						binding,
						recoveryId: request.recoveryId,
						activationId: request.activationId,
						bootObservationSha256,
						command,
						originPreparationSha256: preparation.requestSha256,
					},
					{
						submit: this.client.submitOfficeOutageConfiguration.bind(this.client),
						inspect: this.client.inspectOfficeOutageConfiguration.bind(this.client),
					},
					false,
					"outage-configuration",
				);
				await retainOutageRecord(root, indexName, { ...expected, commandId: command.commandId });
				saved = await readOptionalOutageRecord(root, indexName);
			}
			const index = officeRecord(saved, [...Object.keys(expected), "commandId"]),
				command = parseCompanyComputerPreparationCommand({ commandId: index.commandId, bootId, requestSha256 });
			if (!isDeepStrictEqual(index, { ...expected, commandId: command.commandId }))
				throw new Error("OFFICE_OUTAGE_CONFIGURATION_IDENTITY_CHANGED");
			const directory = `outage-configuration-${suffix}`,
				authority = await readOptionalOutageRecord(root, `${directory}/authority.json`);
			if (authority === undefined) throw new Error("OFFICE_OUTAGE_CONFIGURATION_JOURNAL_LOST");
			const journal = await LxdOfficeControlJournal.open(
				root,
				{
					intentId,
					binding,
					recoveryId: request.recoveryId,
					activationId: request.activationId,
					bootObservationSha256,
					command,
					originPreparationSha256: preparation.requestSha256,
				},
				{
					submit: this.client.submitOfficeOutageConfiguration.bind(this.client),
					inspect: this.client.inspectOfficeOutageConfiguration.bind(this.client),
				},
				authority !== undefined,
				"outage-configuration",
			);
			let operation = await journal.observe(signal),
				checked = await authorize();
			const name = lxdOfficeGuestPlan(binding).request.name;
			if (operation.state === "not_dispatched") {
				if (wasCompleted !== undefined) throw new Error("OFFICE_OUTAGE_CONFIGURATION_DISPATCH_LOST");
				await this.client.pushOfficeOutageConfigurationRequest(
					binding.project,
					name,
					requestSha256,
					payload.bytes,
					checked,
				);
				const staged = await this.client.readOfficeOutageConfigurationRequest(
					binding.project,
					name,
					requestSha256,
					payload.bytes.length,
					await authorize(),
				);
				try {
					if (
						staged.uid !== 0 ||
						staged.gid !== 0 ||
						staged.mode !== 0o400 ||
						!staged.content.equals(payload.bytes)
					)
						throw new Error("OFFICE_OUTAGE_CONFIGURATION_STAGE_CHANGED");
				} finally {
					staged.content.fill(0);
				}
				operation = await journal.reconcile(await authorize());
			}
			if (operation.state !== "succeeded") return { ...terminated, state: operation.state };
			const files = Object.fromEntries(
				Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
					const value = payload.body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES];
					return [file, { bytes: Buffer.byteLength(value), sha256: hash(value) }];
				}),
			) as CompanyComputerOutageConfigurationCompletion["files"];
			const expectedCompletion: CompanyComputerOutageConfigurationCompletion = {
				schema: "qorpera.office-outage-configuration-completion/v1",
				command,
				recoveryId: request.recoveryId,
				activationId: request.activationId,
				originPreparationSha256: preparation.requestSha256,
				adoptionReceiptSha256: payload.adoptionReceiptSha256,
				bootObservationSha256,
				files,
			};
			const readGuest = async (path: string, limit: number, mode: number, checked: AbortSignal) => {
				const file = await this.client.readInstanceFile(binding.project, name, path, limit, checked);
				if (file.uid !== 0 || file.gid !== 0 || file.mode !== mode) {
					file.content.fill(0);
					throw new Error("OFFICE_OUTAGE_CONFIGURATION_CUSTODY_INVALID");
				}
				return file.content;
			};
			const completionPath = `${companyComputerBootDirectory(bootId)}/configuration-completion.json`,
				completionBytes = await readGuest(completionPath, 16384, 0o600, await authorize()),
				completion = parseCompanyComputerOutageConfigurationCompletion(
					JSON.parse(completionBytes.toString()),
					expectedCompletion,
				);
			for (let pass = 0; pass < 2; pass++) {
				checked = await authorize();
				if (
					!(await readGuest(companyComputerBootAdoptionReceiptPath(bootId), 65536, 0o444, checked)).equals(
						payload.receiptBytes,
					)
				)
					throw new Error("OFFICE_OUTAGE_ADOPTION_CHANGED");
				for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
					const content = await readGuest(
						`${companyComputerBootDirectory(bootId)}/credentials/${file}`,
						COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
						0o400,
						checked,
					);
					try {
						if (content.length !== files[file].bytes || hash(content) !== files[file].sha256)
							throw new Error("OFFICE_OUTAGE_INSTALLED_CREDENTIALS_CHANGED");
					} finally {
						content.fill(0);
					}
				}
				if (!(await readGuest(completionPath, 16384, 0o600, checked)).equals(completionBytes))
					throw new Error("OFFICE_OUTAGE_CONFIGURATION_COMPLETION_CHANGED");
			}
			const configured = {
				schema: "qorpera.lxd-office-outage-configuration-observation/v1",
				intentId,
				allocationId,
				recoveryId: request.recoveryId,
				activationId: request.activationId,
				bootId,
				resumeStartCommandId: observation.startCommandId,
				bootObservationSha256,
				commandId: command.commandId,
				requestSha256,
				...(operation.operationId ? { operationId: operation.operationId } : {}),
				serviceBootstrapSha256: payload.serviceBootstrapSha256,
				completionSha256: hash(completionBytes),
				completion,
			};
			const marker = {
				schema: "qorpera.lxd-office-outage-configuration-completion/v1",
				intentId,
				allocationId,
				recoveryId: request.recoveryId,
				activationId: request.activationId,
				commandId: command.commandId,
				observationSha256: officeDigest(configured),
			};
			await retainOutageRecord(root, observationName, configured);
			await retainOutageRecord(root, completedName, marker);
			return {
				...terminated,
				state: "awaiting_admission" as const,
				configured,
				marker,
				completion,
				completionSha256: hash(completionBytes),
			};
		} finally {
			payload.bytes.fill(0);
		}
	}
}
