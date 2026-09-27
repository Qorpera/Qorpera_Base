import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerConfigurationCompletion,
	companyComputerBootDirectory,
	parseCompanyComputerConfigurationCompletion,
	parseCompanyComputerConfigurationRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { type LxdOfficeConfigurationClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { planLxdOfficeAdoption } from "./lxd-office-adoption-plan.ts";
import type { LxdOfficeBootRequest } from "./lxd-office-boot-worker.ts";
import { LxdOfficeConfigurationJournal } from "./lxd-office-configuration-journal.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import type { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { LxdOfficePreparationWorker } from "./lxd-office-preparation-worker.ts";
import { createLxdOfficeConfigurationPayload } from "./lxd-office-service-bootstrap.ts";
import { LxdOfficeStartControl, type LxdOfficeStartRegistry } from "./lxd-office-start-control.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
type Gate = Pick<LxdOfficePhysicalGate, "policy" | "check">;
type ConfigurationPhase =
	| "IDENTITY"
	| "PREPARATION"
	| "CREDENTIALS"
	| "AUTH_PREPARATION"
	| "AUTH_CREDENTIALS"
	| "AUTH_PHYSICAL"
	| "AUTH_CLOUD"
	| "AUTH_BOOT"
	| "JOURNAL"
	| "STAGE"
	| "STAGE_READ"
	| "DISPATCH"
	| "COMPLETION_READ"
	| "CREDENTIAL_READ"
	| "PUBLISH";
interface Ports {
	client?: LxdOfficeConfigurationClient;
	readProtected?: typeof readLxdOfficeProtectedFile;
	readCredential?: typeof readLxdOfficeCredentialFile;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}
export interface LxdOfficeConfigurationRequest extends LxdOfficeBootRequest {
	/** Root-owned provider document, never a member-supplied path. */
	serviceBootstrapPath: string;
}

/** Installs one fixed service configuration in an acknowledged prepared boot.
 * Requires the supervisor's process-owned kernel lock and serialized phases.
 * Credentials remain in protected source files and root-only guest staging;
 * local journals contain only bindings and hashes. Every effect revalidates
 * preparation, physical/cloud authority and protected inputs. This phase
 * neither activates SQL admission nor starts the ordinary guest service. */
export class LxdOfficeConfigurationWorker {
	readonly #gate: Gate;
	readonly #policy;
	readonly #registry: LxdOfficeStartRegistry;
	readonly #client: LxdOfficeConfigurationClient;
	readonly #ports: Ports;
	readonly #kernelLock;
	readonly #preparation: LxdOfficePreparationWorker;
	#busy = false;
	constructor(gate: Gate, registry: LxdOfficeStartRegistry, ports: Ports = {}) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#ports = { ...ports };
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
		this.#preparation = new LxdOfficePreparationWorker(gate, registry, { ...ports, client: this.#client });
	}
	static async open(
		policyPath: string,
		provenancePath: string,
		registry: LxdOfficeStartRegistry,
		signal: AbortSignal,
	) {
		return new LxdOfficeConfigurationWorker(
			await LxdOfficePhysicalGate.open(policyPath, provenancePath, signal),
			registry,
		);
	}
	async reconcile(request: LxdOfficeConfigurationRequest, caller: AbortSignal) {
		return this.#reconcile(request, caller, false);
	}
	async reconcileSettled(request: LxdOfficeConfigurationRequest, caller: AbortSignal) {
		return this.#reconcile(request, caller, true);
	}
	async #reconcile(request: LxdOfficeConfigurationRequest, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		if (this.#busy) throw new Error("OFFICE_CONFIGURATION_RECONCILIATION_PENDING");
		const input = structuredClone(request);
		this.#busy = true;
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
		let phase: ConfigurationPhase = "IDENTITY",
			phaseStarted = performance.now();
		const phases = new Map<ConfigurationPhase, { calls: number; elapsed: number }>([
			[phase, { calls: 1, elapsed: 0 }],
		]);
		const mark = (next: ConfigurationPhase) => {
			const now = performance.now();
			phases.get(phase)!.elapsed += Math.max(0, now - phaseStarted);
			phase = next;
			phaseStarted = now;
			const previous = phases.get(next) ?? { calls: 0, elapsed: 0 };
			previous.calls += 1;
			phases.set(next, previous);
		};
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => {
				const current = phases.get(phase)!;
				// Closed phase names and bounded monotonic counters only. No paths,
				// commands, credentials or external exception text enter this cause.
				const elapsed = Math.min(
					30000,
					Math.max(0, Math.floor(current.elapsed + performance.now() - phaseStarted)),
				);
				const cause = new Error(`OFFICE_CONFIG_${phase}_N${Math.min(current.calls, 65535)}_MS${elapsed}`);
				reject(new Error("OFFICE_CONFIGURATION_RECONCILIATION_ABORTED", { cause }));
			};
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(input, signal, mark)
			.catch((error) => {
				throw new Error("OFFICE_CONFIGURATION_UNCONFIRMED", { cause: error });
			})
			.finally(() => {
				this.#busy = false;
			});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (settle) await operation.catch(() => {});
		}
	}
	async #run(input: LxdOfficeConfigurationRequest, signal: AbortSignal, mark: (phase: ConfigurationPhase) => void) {
		const root = this.#policy.journal.path;
		await this.#kernelLock(root);
		signal.throwIfAborted();
		const { binding } = await openLxdOfficeCreationIdentity(this.#policy, input.intentId, true, this.#client, signal);
		const { allocationId } = binding;
		const preparationMarkerPath = join(root, `preparation-completed-${allocationId}.json`);
		const preparationObservationPath = join(root, `preparation-observation-${allocationId}.json`);
		// Read acknowledged evidence first: configuration cannot initiate preparation.
		const originalMarker = (await readRecord(preparationMarkerPath)).value;
		const originalObservation = (await readRecord(preparationObservationPath, 65536)).value;
		mark("PREPARATION");
		const prepared = await this.#preparation.reconcileSettled(input, signal);
		if (
			prepared.state !== "awaiting_activation" ||
			!("observationSha256" in prepared) ||
			officeDigest(originalObservation) !== prepared.observationSha256 ||
			!isDeepStrictEqual(originalMarker, {
				schema: "qorpera.lxd-office-preparation-completion/v1",
				allocationId,
				commandId: prepared.commandId,
				observationSha256: prepared.observationSha256,
			})
		)
			throw new Error("preparation");
		const evidence = officeRecord(originalObservation, [
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
		const retainedRequest = await readRecord(
			join(root, `preparation-request-${allocationId}.json`),
			COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
		);
		const request = parseCompanyComputerPreparationRequest(retainedRequest.value);
		const preparation = parseCompanyComputerPreparationCommand({
			commandId: prepared.commandId,
			requestSha256: prepared.requestSha256,
			bootId: prepared.bootId,
		});
		if (hash(retainedRequest.bytes) !== preparation.requestSha256) throw new Error("preparation request");
		mark("CREDENTIALS");
		const payload = await createLxdOfficeConfigurationPayload(
			input.serviceBootstrapPath,
			binding,
			request,
			preparation,
			signal,
			this.#ports,
		);
		try {
			const body = parseCompanyComputerConfigurationRequest(json(payload.bytes));
			const requestSha256 = hash(payload.bytes);
			const observation = (
				await readRecord(
					join(root, `inventory-${officeSha(input.observationSha256)}.json`),
					COMPANY_COMPUTER_PREPARATION_MAX_BYTES + 4096,
				)
			).value as LxdOfficeStorageObservation;
			const plan = planLxdOfficeAdoption(input.input, binding, observation);
			const mappings = plan.screens.map((screen) => ({
				binding: screen.binding,
				browserProfile: screen.browser.disposition === "adopt" ? screen.browser.grant : null,
			}));
			const control = new LxdOfficeStartControl(input.intentId, binding, this.#registry);
			const authorize = async () => {
				mark("AUTH_PREPARATION");
				signal.throwIfAborted();
				await this.#kernelLock(root);
				if (
					!isDeepStrictEqual((await readRecord(preparationMarkerPath)).value, originalMarker) ||
					!isDeepStrictEqual((await readRecord(preparationObservationPath, 65536)).value, originalObservation) ||
					!isDeepStrictEqual(await this.#preparation.reconcileSettled(input, signal), prepared)
				)
					throw new Error("preparation changed");
				mark("AUTH_CREDENTIALS");
				const current = await createLxdOfficeConfigurationPayload(
					input.serviceBootstrapPath,
					binding,
					request,
					preparation,
					signal,
					this.#ports,
				);
				try {
					if (current.planBytesSha256 !== payload.planBytesSha256 || !current.bytes.equals(payload.bytes))
						throw new Error("credentials changed");
				} finally {
					current.bytes.fill(0);
				}
				mark("AUTH_PHYSICAL");
				const physical = await this.#gate.check(binding, signal);
				if (physical.hostBootId !== observation.hostBootId) throw new Error("host changed");
				const checked = AbortSignal.any([signal, physical.signal]);
				mark("AUTH_CLOUD");
				const cloud = await control.checkAdoption(mappings, checked);
				const authorized = AbortSignal.any([checked, cloud.signal]);
				mark("AUTH_BOOT");
				const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, authorized);
				if (boot.bootId !== preparation.bootId || boot.instanceSha256 !== request.instanceSha256)
					throw new Error("boot changed");
				authorized.throwIfAborted();
				return authorized;
			};
			const names = {
				index: `configuration-intent-${allocationId}.json`,
				observation: `configuration-observation-${allocationId}.json`,
				completion: `configuration-completed-${allocationId}.json`,
			};
			const expected = {
				schema: "qorpera.lxd-office-configuration-intent/v1",
				intentId: input.intentId,
				allocationId,
				bootId: preparation.bootId,
				bootObservationSha256: officeSha(evidence.bootObservationSha256),
				preparationObservationSha256: prepared.observationSha256,
				serviceBootstrapSha256: payload.planBytesSha256,
				requestSha256,
				requestBytes: payload.bytes.length,
			};
			let index: unknown;
			try {
				index = (await readRecord(join(root, names.index))).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
			}
			if (index === undefined) {
				const checked = await authorize();
				for (const name of [names.observation, names.completion]) {
					try {
						await lstat(join(root, name));
						throw new Error("identity missing");
					} catch (error) {
						if (!code(error, "ENOENT")) throw error;
					}
				}
				const directory = join(root, `configuration-${allocationId}`);
				let exists = true;
				try {
					await lstat(directory);
				} catch (error) {
					if (!code(error, "ENOENT")) throw error;
					exists = false;
				}
				const retained = exists
					? officeRecord((await readRecord(join(directory, "authority.json"))).value, [
							"schema",
							"intentId",
							"binding",
							"bootObservationSha256",
							"preparationObservationSha256",
							"command",
						])
					: undefined;
				const command = retained
					? parseCompanyComputerPreparationCommand(retained.command)
					: parseCompanyComputerPreparationCommand({
							commandId: randomUUID(),
							requestSha256,
							bootId: preparation.bootId,
						});
				if (
					command.requestSha256 !== requestSha256 ||
					command.bootId !== preparation.bootId ||
					command.commandId === preparation.commandId
				)
					throw new Error("command");
				const journal = await LxdOfficeConfigurationJournal.open(
					root,
					{
						intentId: input.intentId,
						binding,
						bootObservationSha256: expected.bootObservationSha256,
						preparationObservationSha256: prepared.observationSha256,
						command,
					},
					this.#client,
					exists,
				);
				if ((await journal.observe(checked)).state !== "not_dispatched") throw new Error("identity missing");
				checked.throwIfAborted();
				await publish(
					root,
					names.index,
					Buffer.from(officeCanonical({ ...expected, commandId: command.commandId })),
				);
				index = (await readRecord(join(root, names.index))).value;
			}
			const retained = officeRecord(index, [...Object.keys(expected), "commandId"]);
			const command = parseCompanyComputerPreparationCommand({
				commandId: retained.commandId,
				requestSha256,
				bootId: preparation.bootId,
			});
			if (
				command.commandId === preparation.commandId ||
				!isDeepStrictEqual(retained, { ...expected, commandId: command.commandId })
			)
				throw new Error("identity changed");
			const journal = await LxdOfficeConfigurationJournal.open(
				root,
				{
					intentId: input.intentId,
					binding,
					bootObservationSha256: expected.bootObservationSha256,
					preparationObservationSha256: prepared.observationSha256,
					command,
				},
				this.#client,
			);
			const authorizeCommand = async () => {
				const checked = await authorize();
				if (!isDeepStrictEqual((await readRecord(join(root, names.index))).value, retained))
					throw new Error("identity changed");
				checked.throwIfAborted();
				return checked;
			};
			let checked = await authorizeCommand();
			mark("JOURNAL");
			let operation = await journal.observe(checked);
			const name = lxdOfficeGuestPlan(binding).request.name;
			if (operation.state === "not_dispatched") {
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
				mark("STAGE");
				await this.#client.pushOfficeConfigurationRequest(
					binding.project,
					name,
					requestSha256,
					payload.bytes,
					checked,
				);
				checked = await authorizeCommand();
				mark("STAGE_READ");
				const staged = await this.#client.readOfficeConfigurationRequest(
					binding.project,
					name,
					requestSha256,
					payload.bytes.length,
					checked,
				);
				try {
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
				checked = await authorizeCommand();
				mark("DISPATCH");
				operation = await journal.reconcile(checked);
			}
			const result = {
				intentId: input.intentId,
				allocationId,
				commandId: command.commandId,
				bootId: command.bootId,
				requestSha256,
				...(operation.operationId ? { operationId: operation.operationId } : {}),
			};
			if (operation.state !== "succeeded") return { ...result, state: operation.state };
			if (!operation.operationId) throw new Error("operation");
			const files = Object.fromEntries(
				Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
					const content = body[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES];
					return [file, { bytes: Buffer.byteLength(content), sha256: hash(content) }];
				}),
			) as CompanyComputerConfigurationCompletion["files"];
			const expectedCompletion: CompanyComputerConfigurationCompletion = {
				schema: "qorpera.office-configuration-completion/v1",
				command,
				preparation,
				preparationCompletionSha256: officeSha(evidence.completionSha256),
				adoptionReceiptSha256: officeSha(evidence.adoptionReceiptSha256),
				files,
			};
			const readCompletion = async (authority: AbortSignal) => {
				mark("COMPLETION_READ");
				const file = await this.#client.readInstanceFile(
					binding.project,
					name,
					"/run/qorpera-office-preparation/configuration-completion.json",
					16384,
					authority,
				);
				authority.throwIfAborted();
				if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o600) throw new Error("completion custody");
				parseCompanyComputerConfigurationCompletion(json(file.content), expectedCompletion);
				return file.content;
			};
			const completionBytes = await readCompletion(await authorizeCommand());
			// Independently verify the installed protected bytes twice. The helper's
			// receipt alone is insufficient to acknowledge later activation evidence.
			// Each whole pass shares one fresh five-second authority window. Repeating
			// full preparation for every file made read-only confirmation exceed the
			// bounded reconciliation time; expiry still refuses the entire pass.
			for (let pass = 0; pass < 2; pass++) {
				const inspection = await authorizeCommand();
				for (const credentialsRoot of [
					"/etc/qorpera-office/credentials",
					`${companyComputerBootDirectory(command.bootId)}/credentials`,
				]) {
					for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
						mark("CREDENTIAL_READ");
						const property = key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES;
						const installed = await this.#client.readInstanceFile(
							binding.project,
							name,
							`${credentialsRoot}/${file}`,
							COMPANY_COMPUTER_CONFIGURATION_LIMITS[property],
							inspection,
						);
						try {
							inspection.throwIfAborted();
							if (
								installed.uid !== 0 ||
								installed.gid !== 0 ||
								installed.mode !== 0o400 ||
								installed.content.length !== files[file].bytes ||
								hash(installed.content) !== files[file].sha256
							)
								throw new Error("installed credentials");
						} finally {
							installed.content.fill(0);
						}
					}
				}
				if (!(await readCompletion(inspection)).equals(completionBytes)) throw new Error("completion changed");
			}
			const configured = {
				schema: "qorpera.lxd-office-configuration-observation/v1",
				...result,
				bootObservationSha256: expected.bootObservationSha256,
				preparationObservationSha256: prepared.observationSha256,
				serviceBootstrapSha256: payload.planBytesSha256,
				completionSha256: hash(completionBytes),
				completion: expectedCompletion,
			};
			const marker = {
				schema: "qorpera.lxd-office-configuration-completion/v1",
				allocationId,
				commandId: command.commandId,
				observationSha256: officeDigest(configured),
			};
			let completed: unknown;
			try {
				completed = (await readRecord(join(root, names.completion))).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
			}
			if (
				completed !== undefined &&
				(!isDeepStrictEqual(completed, marker) ||
					!isDeepStrictEqual((await readRecord(join(root, names.observation))).value, configured))
			)
				throw new Error("retained evidence");
			checked = await authorizeCommand();
			mark("PUBLISH");
			await publish(root, names.observation, Buffer.from(officeCanonical(configured)));
			if (!isDeepStrictEqual((await readRecord(join(root, names.observation))).value, configured))
				throw new Error("retained observation");
			checked.throwIfAborted();
			await publish(root, names.completion, Buffer.from(officeCanonical(marker)));
			if (!isDeepStrictEqual((await readRecord(join(root, names.completion))).value, marker))
				throw new Error("retained completion");
			checked.throwIfAborted();
			return { ...result, state: "awaiting_activation" as const, observationSha256: marker.observationSha256 };
		} finally {
			payload.bytes.fill(0);
		}
	}
}
