import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerBootConfigurationCompletion,
	type CompanyComputerBootIntentRequest,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerBootConfigurationCompletion,
	parseCompanyComputerBootIntent,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerResumeObservation,
} from "@qorpera/contracts";
import { type LxdOfficeBootConfigurationClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { openLxdOfficeBootConfigurationJournal } from "./lxd-office-boot-configuration-journal.ts";
import { createLxdOfficeBootConfigurationPayload } from "./lxd-office-boot-configuration-payload.ts";
import { LxdOfficeBootIntentControl, type LxdOfficeBootIntentRegistry } from "./lxd-office-boot-intent-control.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { readLxdOfficeOutageActivationHistory } from "./lxd-office-outage-activation-history.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import type { readLxdOfficeCredentialFile } from "./lxd-office-physical-host.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { officePhysicalPath, parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { readLxdOfficePowerOffEvidence } from "./lxd-office-power-off-evidence.ts";
import { LxdOfficeResumeWorker } from "./lxd-office-resume-worker.ts";
import { assertLxdOfficeServiceBootstrapContinuity } from "./lxd-office-service-bootstrap-revisions.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const pending = new Set<string>();
interface Ports {
	client?: LxdOfficeBootConfigurationClient;
	readProtected?: typeof readLxdOfficeProtectedFile;
	readCredential?: typeof readLxdOfficeCredentialFile;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}
export interface LxdOfficeBootConfigurationRequest {
	intentId: string;
	request: CompanyComputerBootIntentRequest;
	/** Protected provider endpoint and credential references for this boot. */
	serviceBootstrapPath: string;
}
/** Configures only an already acknowledged resumed boot. Retained history is
 * not current authority: physical, kernel and SQL checks precede effects and
 * confirmation. No preparation, VM start, SQL admission or service start is
 * initiated. Unknown submissions and cancelled IO retain their ownership. */
export class LxdOfficeBootConfigurationWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #registry: LxdOfficeBootIntentRegistry;
	readonly #client: LxdOfficeBootConfigurationClient;
	readonly #ports: Ports;
	readonly #kernelLock;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		registry: LxdOfficeBootIntentRegistry,
		ports: Ports = {},
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#ports = { ...ports };
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
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
		};
		const root = this.#policy.journal.path;
		if (pending.has(root)) throw new Error("OFFICE_BOOT_CONFIGURATION_PENDING");
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
			abort = () => reject(new Error("OFFICE_BOOT_CONFIGURATION_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(input, registry, signal)
			.catch((error) => {
				throw new Error("OFFICE_BOOT_CONFIGURATION_UNCONFIRMED", { cause: error });
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
	/** The digest the predecessor boot recorded for its plan: that boot's own
	 * boot-configuration intent, an accepted outage or reset configuration,
	 * or the origin configuration intent. */
	async #assertPlanContinuity(
		root: string,
		binding: LxdOfficeGuestBinding,
		planPath: string,
		planSha256: string,
		predecessorBootId: string,
		outage: Awaited<ReturnType<typeof readLxdOfficePowerOffEvidence>>["outage"],
		read: (name: string, limit?: number) => Promise<{ value: unknown; bytes: Buffer }>,
		signal: AbortSignal,
	): Promise<void> {
		const { allocationId } = binding;
		let predecessorSha256: string | undefined;
		for (const name of (await readdir(root)).sort()) {
			if (
				!name.startsWith(`boot-configuration-intent-${allocationId}-`) ||
				!name.endsWith(".json") ||
				name.length !== `boot-configuration-intent-${allocationId}-`.length + 41
			)
				continue;
			const value = officeRecord((await read(name)).value, [
				"schema",
				"intentId",
				"allocationId",
				"bootIntentId",
				"activationId",
				"bootId",
				"bootObservationSha256",
				"originPreparationSha256",
				"serviceBootstrapSha256",
				"serviceBootstrapPath",
				"requestSha256",
				"requestBytes",
				"commandId",
			]);
			if (value.bootId !== predecessorBootId) continue;
			if (predecessorSha256 !== undefined) throw new Error("predecessor boot recorded twice");
			predecessorSha256 = officeSha(value.serviceBootstrapSha256);
		}
		// An office born from a reset was first configured by the reset lane, which records the plan
		// digest of that boot under the reset's successor activation.
		for (const name of predecessorSha256 === undefined ? (await readdir(root)).sort() : []) {
			if (
				!name.startsWith(`reset-configuration-${allocationId}-`) ||
				!name.endsWith(".json") ||
				name.length !== `reset-configuration-${allocationId}-`.length + 41
			)
				continue;
			const value = officeRecord((await read(name)).value, [
				"schema",
				"resetId",
				"bootId",
				"command",
				"serviceBootstrapSha256",
			]);
			if (value.schema !== "qorpera.lxd-office-reset-configuration/v1" || value.bootId !== predecessorBootId)
				continue;
			if (predecessorSha256 !== undefined) throw new Error("predecessor boot recorded twice");
			predecessorSha256 = officeSha(value.serviceBootstrapSha256);
		}
		let outageRecorded = false;
		for (const name of (await readdir(root)).sort()) {
			const prefix = `outage-configuration-intent-${allocationId}-`;
			if (!name.startsWith(prefix) || !name.endsWith(".json") || name.length !== prefix.length + 41) continue;
			const value = officeRecord((await read(name)).value, [
				"schema",
				"intentId",
				"allocationId",
				"recoveryId",
				"activationId",
				"bootId",
				"bootObservationSha256",
				"originPreparationSha256",
				"serviceBootstrapSha256",
				"serviceBootstrapPath",
				"requestSha256",
				"requestBytes",
				"commandId",
			]);
			if (value.bootId !== predecessorBootId) continue;
			if (predecessorSha256 !== undefined) throw new Error("predecessor boot recorded twice");
			if (!outage || name !== `${prefix}${outage.recovery.request.activationId}.json`)
				throw new Error("outage predecessor differs");
			// Reuse the admitted-history reader, including the immutable binding,
			// configuration completion/digests, root command journal and activation.
			// Read through the retained snapshot so later authorization rejects edits.
			const history = await readLxdOfficeOutageActivationHistory(
				root,
				outage.observation.intentId,
				binding,
				outage.recovery.request.activationId,
				read,
				this.#client,
				signal,
			);
			if (
				!isDeepStrictEqual(history.recovery, outage.recovery) ||
				!isDeepStrictEqual(history.observation, outage.observation) ||
				history.command.bootId !== predecessorBootId
			)
				throw new Error("outage predecessor differs");
			predecessorSha256 = officeSha(value.serviceBootstrapSha256);
			outageRecorded = true;
		}
		if (outage && !outageRecorded) throw new Error("outage predecessor unrecorded");
		if (predecessorSha256 === undefined) {
			const origin = officeRecord((await read(`configuration-intent-${allocationId}.json`)).value, [
				"schema",
				"intentId",
				"allocationId",
				"bootId",
				"bootObservationSha256",
				"preparationObservationSha256",
				"serviceBootstrapSha256",
				"requestSha256",
				"requestBytes",
				"commandId",
			]);
			if (origin.bootId !== predecessorBootId) throw new Error("predecessor boot unrecorded");
			predecessorSha256 = officeSha(origin.serviceBootstrapSha256);
		}
		const planBytes = await (this.#ports.readProtected ?? readLxdOfficeProtectedFile)(planPath, 16384);
		if (hash(planBytes) !== planSha256) throw new Error("plan changed");
		await assertLxdOfficeServiceBootstrapContinuity(
			{ planBytes, planPath, predecessorSha256, binding },
			this.#ports.readProtected ?? readLxdOfficeProtectedFile,
			signal,
		);
	}
	async #run(input: LxdOfficeBootConfigurationRequest, registry: LxdOfficeBootIntentRegistry, signal: AbortSignal) {
		const root = this.#policy.journal.path,
			{ intentId, request } = input;
		await this.#kernelLock(root);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal),
			{ binding } = creation,
			{ allocationId } = binding,
			suffix = `${allocationId}-${request.predecessor.transitionId}`;
		const read = (name: string, limit = 65536) => readRecord(join(root, name), limit);
		const optional = async (name: string) => {
			try {
				return (await read(name)).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				return undefined;
			}
		};
		const records = new Map<string, { bytes: Buffer; limit: number }>();
		const retainRead = async (name: string, limit = 65536) => {
			const file = await read(name, limit);
			const previous = records.get(name);
			if (previous && !previous.bytes.equals(file.bytes)) throw new Error("retained history changed");
			records.set(name, { bytes: file.bytes, limit });
			return file;
		};
		// All four records must already exist before the composed verifier runs.
		// In particular it cannot reconstruct a missing prepared record or start VM.
		const done = await retainRead(`resume-completed-${suffix}.json`);
		await retainRead(`resume-request-${suffix}.json`);
		const prepared = parseCompanyComputerBootIntent(
				(await retainRead(`resume-prepared-${suffix}.json`)).value,
				request,
			),
			observation = parseCompanyComputerResumeObservation(
				(await retainRead(`resume-observation-${suffix}.json`)).value,
				request,
			);
		if (prepared.state !== "prepared" || observation.intentId !== intentId) throw new Error("resume binding");
		const resume = new LxdOfficeResumeWorker(this.#gate, registry, {
			client: this.#client,
			kernelLock: this.#kernelLock,
		});
		const resumed = await resume.reconcileSettled(intentId, request, signal);
		if (
			resumed.state !== "awaiting_configuration" ||
			!isDeepStrictEqual(done.value, {
				schema: "qorpera.lxd-office-resume-completion/v1",
				intentId,
				allocationId,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				startCommandId: observation.startCommandId,
				bootObservationSha256: officeDigest(observation),
			}) ||
			resumed.bootObservationSha256 !== officeDigest(observation)
		)
			throw new Error("resume acknowledgement");
		const shutdown = await readLxdOfficePowerOffEvidence(root, creation, request, signal);
		const power = await retainRead(`power-off-completed-${suffix}.json`),
			originalFile = await retainRead(
				`preparation-request-${allocationId}.json`,
				COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			),
			original = parseCompanyComputerPreparationRequest(originalFile.value),
			originalObservation = await retainRead(`preparation-observation-${allocationId}.json`),
			originalMarker = await retainRead(`preparation-completed-${allocationId}.json`);
		const evidence = officeRecord(originalObservation.value, [
			"schema",
			"intentId",
			"allocationId",
			"commandId",
			"bootId",
			"requestSha256",
			"operationId",
			"bootObservationSha256",
			"copySha256",
			"completionSha256",
			"adoptionReceiptPath",
			"adoptionReceiptSha256",
			"completion",
		]);
		const preparation = parseCompanyComputerPreparationCommand({
			commandId: evidence.commandId,
			bootId: evidence.bootId,
			requestSha256: evidence.requestSha256,
		});
		if (
			evidence.schema !== "qorpera.lxd-office-preparation-observation/v1" ||
			evidence.intentId !== intentId ||
			evidence.allocationId !== allocationId ||
			preparation.requestSha256 !== hash(originalFile.bytes) ||
			original.bootId !== preparation.bootId ||
			original.bootId !== shutdown.originalBootId ||
			evidence.adoptionReceiptPath !== "/etc/qorpera-office/adoption.json" ||
			evidence.adoptionReceiptSha256 !==
				hash(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`) ||
			!isDeepStrictEqual(originalMarker.value, {
				schema: "qorpera.lxd-office-preparation-completion/v1",
				allocationId,
				commandId: preparation.commandId,
				observationSha256: officeDigest(originalObservation.value),
			})
		)
			throw new Error("original preparation differs");
		const build = () =>
			createLxdOfficeBootConfigurationPayload(
				input.serviceBootstrapPath,
				binding,
				original,
				preparation,
				prepared,
				observation,
				new TextDecoder("utf8", { fatal: true }).decode(power.bytes),
				signal,
				this.#ports,
			);
		const payload = await build();
		try {
			const control = new LxdOfficeBootIntentControl(request, registry),
				requestSha256 = hash(payload.bytes),
				bootId = observation.bootId,
				names = {
					index: `boot-configuration-intent-${allocationId}-${request.activationId}.json`,
					observation: `boot-configuration-observation-${allocationId}-${request.activationId}.json`,
					completion: `boot-configuration-completed-${allocationId}-${request.activationId}.json`,
				},
				directory = join(root, `boot-configuration-${allocationId}-${request.activationId}`);
			const retained = async () => {
				await this.#kernelLock(root);
				for (const [name, file] of records)
					if (!(await read(name, file.limit)).bytes.equals(file.bytes))
						throw new Error("retained history changed");
				if (
					!isDeepStrictEqual(
						await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal),
						creation,
					) ||
					!isDeepStrictEqual(await readLxdOfficePowerOffEvidence(root, creation, request, signal), shutdown)
				)
					throw new Error("shutdown changed");
				signal.throwIfAborted();
			};
			const authorize = async () => {
				await retained();
				const current = await build();
				try {
					if (
						current.serviceBootstrapSha256 !== payload.serviceBootstrapSha256 ||
						!current.bytes.equals(payload.bytes)
					)
						throw new Error("protected sources changed");
				} finally {
					current.bytes.fill(0);
				}
				const physical = await this.#gate.check(binding, signal);
				if (physical.hostBootId !== observation.hostBootId) throw new Error("host changed");
				const cloud = await control.check(AbortSignal.any([signal, physical.signal]));
				if (!isDeepStrictEqual(cloud.intent, prepared)) throw new Error("boot intent changed");
				const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, cloud.signal);
				if (boot.bootId !== bootId || boot.instanceSha256 !== observation.instanceSha256)
					throw new Error("boot changed");
				cloud.signal.throwIfAborted();
				return cloud.signal;
			};
			const expected = {
				schema: "qorpera.lxd-office-boot-configuration-intent/v1",
				intentId,
				allocationId,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				bootId,
				bootObservationSha256: payload.bootObservationSha256,
				originPreparationSha256: preparation.requestSha256,
				serviceBootstrapSha256: payload.serviceBootstrapSha256,
				serviceBootstrapPath: input.serviceBootstrapPath,
				requestSha256,
				requestBytes: payload.bytes.length,
			};
			const identity = (command: ReturnType<typeof parseCompanyComputerPreparationCommand>) => ({
				intentId,
				binding,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				originPreparationSha256: preparation.requestSha256,
				bootObservationSha256: payload.bootObservationSha256,
				command,
			});
			let index = await optional(names.index);
			if (index === undefined) {
				// A new boot takes the plan as it is now. It may differ from the plan
				// the predecessor boot recorded only through the retained revision
				// chain beside it (an office credential replaced while powered off).
				await this.#assertPlanContinuity(
					root,
					binding,
					input.serviceBootstrapPath,
					payload.serviceBootstrapSha256,
					request.predecessor.startup.bootId,
					shutdown.outage,
					retainRead,
					signal,
				);
				const checked = await authorize();
				if ((await optional(names.observation)) !== undefined || (await optional(names.completion)) !== undefined)
					throw new Error("configuration identity lost");
				let exists = true;
				try {
					await lstat(directory);
				} catch (error) {
					if (!code(error, "ENOENT")) throw error;
					exists = false;
				}
				const authority = exists
					? officeRecord((await readRecord(join(directory, "authority.json"))).value, [
							"schema",
							"intentId",
							"binding",
							"bootIntentId",
							"activationId",
							"originPreparationSha256",
							"bootObservationSha256",
							"command",
						])
					: undefined;
				const command = parseCompanyComputerPreparationCommand(
					authority?.command ?? { commandId: randomUUID(), bootId, requestSha256 },
				);
				if (command.bootId !== bootId || command.requestSha256 !== requestSha256)
					throw new Error("configuration command changed");
				const journal = await openLxdOfficeBootConfigurationJournal(root, identity(command), this.#client, exists);
				if ((await journal.observe(checked)).state !== "not_dispatched")
					throw new Error("configuration identity lost");
				checked.throwIfAborted();
				await publish(
					root,
					names.index,
					Buffer.from(officeCanonical({ ...expected, commandId: command.commandId })),
				);
				index = (await read(names.index)).value;
			}
			const saved = officeRecord(index, [...Object.keys(expected), "commandId"]),
				command = parseCompanyComputerPreparationCommand({ commandId: saved.commandId, bootId, requestSha256 });
			if (
				!isDeepStrictEqual(saved, { ...expected, commandId: command.commandId }) ||
				[
					preparation.commandId,
					observation.startCommandId,
					shutdown.stopCommandId,
					shutdown.history.command.commandId,
				].includes(command.commandId)
			)
				throw new Error("configuration identity changed");
			const journal = await openLxdOfficeBootConfigurationJournal(root, identity(command), this.#client);
			const authorizeCommand = async () => {
				const checked = await authorize();
				if (!isDeepStrictEqual((await read(names.index)).value, saved))
					throw new Error("configuration identity changed");
				checked.throwIfAborted();
				return checked;
			};
			let checked = await authorizeCommand(),
				operation = await journal.observe(checked);
			const name = lxdOfficeGuestPlan(binding).request.name;
			if (operation.state === "not_dispatched") {
				if ((await optional(names.observation)) !== undefined || (await optional(names.completion)) !== undefined)
					throw new Error("configuration dispatch lost");
				const lock = await this.#client.readInstanceFile(
					binding.project,
					name,
					"/run/qorpera-office-preparation/control.lock",
					1,
					checked,
				);
				if (lock.uid !== 0 || lock.gid !== 0 || lock.mode !== 0o600 || lock.content.length !== 0)
					throw new Error("guest lock");
				checked = await authorizeCommand();
				await this.#client.pushOfficeBootConfigurationRequest(
					binding.project,
					name,
					requestSha256,
					payload.bytes,
					checked,
				);
				checked = await authorizeCommand();
				const staged = await this.#client.readOfficeBootConfigurationRequest(
					binding.project,
					name,
					requestSha256,
					payload.bytes.length,
					checked,
				);
				try {
					checked.throwIfAborted();
					if (
						staged.uid !== 0 ||
						staged.gid !== 0 ||
						staged.mode !== 0o400 ||
						!staged.content.equals(payload.bytes)
					)
						throw new Error("staging");
				} finally {
					staged.content.fill(0);
				}
				operation = await journal.reconcile(await authorizeCommand());
			}
			const result = {
				intentId,
				allocationId,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				bootId,
				resumeStartCommandId: observation.startCommandId,
				bootObservationSha256: payload.bootObservationSha256,
				commandId: command.commandId,
				requestSha256,
				...(operation.operationId ? { operationId: operation.operationId } : {}),
			};
			if (operation.state === "not_dispatched") throw new Error("configuration dispatch unconfirmed");
			if (operation.state !== "succeeded") return { ...result, state: operation.state };
			if (!operation.operationId) throw new Error("configuration operation");
			const files = Object.fromEntries(
				Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
					const value = payload.body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES];
					return [file, { bytes: Buffer.byteLength(value), sha256: hash(value) }];
				}),
			) as CompanyComputerBootConfigurationCompletion["files"];
			const completion: CompanyComputerBootConfigurationCompletion = {
				schema: "qorpera.office-boot-configuration-completion/v1",
				command,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				originPreparationSha256: preparation.requestSha256,
				adoptionReceiptSha256: payload.adoptionReceiptSha256,
				bootObservationSha256: payload.bootObservationSha256,
				files,
			};
			const readGuest = async (path: string, limit: number, mode: number, checked: AbortSignal) => {
				const file = await this.#client.readInstanceFile(binding.project, name, path, limit, checked);
				try {
					checked.throwIfAborted();
					if (file.uid !== 0 || file.gid !== 0 || file.mode !== mode) throw new Error("guest custody");
					return file.content;
				} catch (error) {
					file.content.fill(0);
					throw error;
				}
			};
			const completionPath = `${companyComputerBootDirectory(bootId)}/configuration-completion.json`,
				completionBytes = await readGuest(completionPath, 16384, 0o600, await authorizeCommand());
			parseCompanyComputerBootConfigurationCompletion(json(completionBytes), completion);
			for (let pass = 0; pass < 2; pass++) {
				const inspection = await authorizeCommand();
				if (
					!(await readGuest(companyComputerBootAdoptionReceiptPath(bootId), 16384, 0o444, inspection)).equals(
						payload.receiptBytes,
					)
				)
					throw new Error("adoption receipt differs");
				for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
					const content = await readGuest(
						`${companyComputerBootDirectory(bootId)}/credentials/${file}`,
						COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
						0o400,
						inspection,
					);
					try {
						if (content.length !== files[file].bytes || hash(content) !== files[file].sha256)
							throw new Error("installed credentials differ");
					} finally {
						content.fill(0);
					}
				}
				if (!(await readGuest(completionPath, 16384, 0o600, inspection)).equals(completionBytes))
					throw new Error("completion changed");
			}
			if (!isDeepStrictEqual(await resume.reconcileSettled(intentId, request, signal), resumed))
				throw new Error("resumed evidence changed");
			const configured = {
					schema: "qorpera.lxd-office-boot-configuration-observation/v1",
					...result,
					bootObservationSha256: payload.bootObservationSha256,
					serviceBootstrapSha256: payload.serviceBootstrapSha256,
					completionSha256: hash(completionBytes),
					completion,
				},
				marker = {
					schema: "qorpera.lxd-office-boot-configuration-completion/v1",
					intentId,
					allocationId,
					bootIntentId: request.bootIntentId,
					activationId: request.activationId,
					commandId: command.commandId,
					observationSha256: officeDigest(configured),
				};
			const completed = await optional(names.completion);
			if (
				completed !== undefined &&
				(!isDeepStrictEqual(completed, marker) || !isDeepStrictEqual(await optional(names.observation), configured))
			)
				throw new Error("retained completion differs");
			checked = await authorizeCommand();
			await publish(root, names.observation, Buffer.from(officeCanonical(configured)));
			if (!isDeepStrictEqual((await read(names.observation)).value, configured))
				throw new Error("retained observation differs");
			checked.throwIfAborted();
			await publish(root, names.completion, Buffer.from(officeCanonical(marker)));
			if (!isDeepStrictEqual((await read(names.completion)).value, marker))
				throw new Error("retained completion differs");
			checked.throwIfAborted();
			return { ...result, state: "awaiting_boot_admission" as const, observationSha256: marker.observationSha256 };
		} finally {
			payload.bytes.fill(0);
		}
	}
}
