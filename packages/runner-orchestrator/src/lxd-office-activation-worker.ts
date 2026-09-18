import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	companyComputerBootDirectory,
	parseCompanyComputerConfigurationCompletion,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStartCompletion,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
import { type LxdOfficeConfigurationClient, type LxdOfficeServiceStartClient, LxdUnixClient } from "./lxd-client.ts";
import { LxdOfficeActivationControl, type LxdOfficeActivationRegistry } from "./lxd-office-activation-control.ts";
import { readLxdOfficeActivationEvidence } from "./lxd-office-activation-evidence.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import type { LxdOfficeConfigurationRequest } from "./lxd-office-configuration-worker.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import type { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { LxdOfficeServiceInspectionControl } from "./lxd-office-service-inspection.ts";
import { LxdOfficeServiceStartJournal } from "./lxd-office-service-start-journal.ts";
import { LxdOfficeStartControl, type LxdOfficeStartRegistry } from "./lxd-office-start-control.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
type Client = LxdOfficeConfigurationClient & LxdOfficeServiceStartClient;
interface Ports {
	client?: Client;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
	readProtected?: typeof readLxdOfficeProtectedFile;
	readCredential?: typeof readLxdOfficeCredentialFile;
}
/** Provider-only activation of one acknowledged configuration. This worker
 * never invokes creation, boot, copying, preparation or configuration. Retained
 * evidence permits legitimate working-file changes after service startup.
 * The lifecycle supervisor owns the process kernel lock and serializes phases.
 * Service-start uncertainty never authorizes another dispatch; fresh inspection
 * of the original protected completion can recover a lost reply. */
export class LxdOfficeActivationWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #startRegistry: LxdOfficeStartRegistry;
	readonly #activationRegistry: LxdOfficeActivationRegistry;
	readonly #client: Client;
	readonly #ports: Ports;
	readonly #kernelLock;
	#busy = false;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		startRegistry: LxdOfficeStartRegistry,
		activationRegistry: LxdOfficeActivationRegistry,
		ports: Ports = {},
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#startRegistry = startRegistry;
		this.#activationRegistry = activationRegistry;
		this.#ports = { ...ports };
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
	}
	static async open(
		policyPath: string,
		provenancePath: string,
		startRegistry: LxdOfficeStartRegistry,
		activationRegistry: LxdOfficeActivationRegistry,
		signal: AbortSignal,
	) {
		return new LxdOfficeActivationWorker(
			await LxdOfficePhysicalGate.open(policyPath, provenancePath, signal),
			startRegistry,
			activationRegistry,
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
		if (this.#busy) throw new Error("OFFICE_ACTIVATION_RECONCILIATION_PENDING");
		const input = structuredClone(request);
		this.#busy = true;
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("OFFICE_ACTIVATION_RECONCILIATION_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(input, signal)
			.catch((error) => {
				throw new Error("OFFICE_ACTIVATION_UNCONFIRMED", { cause: error });
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
	async #run(input: LxdOfficeConfigurationRequest, signal: AbortSignal) {
		const root = this.#policy.journal.path;
		await this.#kernelLock(root);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, input.intentId, true, this.#client, signal);
		const { binding } = creation,
			{ allocationId } = binding;
		const name = lxdOfficeGuestPlan(binding).request.name;
		const evidence = await readLxdOfficeActivationEvidence(root, input, binding, this.#client, signal, this.#ports);
		const startControl = new LxdOfficeStartControl(input.intentId, binding, this.#startRegistry);
		const physical = async (caller: AbortSignal) => {
			caller.throwIfAborted();
			await this.#kernelLock(root);
			if (
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(this.#policy, input.intentId, true, this.#client, caller),
					creation,
				) ||
				!isDeepStrictEqual(
					await readLxdOfficeActivationEvidence(root, input, binding, this.#client, caller, this.#ports),
					evidence,
				)
			)
				throw new Error("retained evidence changed");
			const gate = await this.#gate.check(binding, caller);
			if (gate.hostBootId !== evidence.hostBootId) throw new Error("host changed");
			const checked = AbortSignal.any([caller, gate.signal]);
			const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, checked);
			if (
				boot.bootId !== evidence.configuration.command.bootId ||
				boot.instanceSha256 !== evidence.preparedRequest.instanceSha256
			)
				throw new Error("guest changed");
			const completion = await this.#client.readInstanceFile(
				binding.project,
				name,
				"/run/qorpera-office-preparation/configuration-completion.json",
				16384,
				checked,
			);
			if (
				completion.uid !== 0 ||
				completion.gid !== 0 ||
				completion.mode !== 0o600 ||
				hash(completion.content) !== evidence.configurationCompletionSha256
			)
				throw new Error("configuration custody");
			parseCompanyComputerConfigurationCompletion(decode(completion.content), evidence.configuration);
			for (const credentialsRoot of [
				"/etc/qorpera-office/credentials",
				`${companyComputerBootDirectory(evidence.configuration.command.bootId)}/credentials`,
			]) {
				for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
					const bytes = await this.#client.readInstanceFile(
						binding.project,
						name,
						`${credentialsRoot}/${file}`,
						COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
						checked,
					);
					try {
						if (
							bytes.uid !== 0 ||
							bytes.gid !== 0 ||
							bytes.mode !== 0o400 ||
							bytes.content.length !== evidence.configuration.files[file].bytes ||
							hash(bytes.content) !== evidence.configuration.files[file].sha256
						)
							throw new Error("installed files changed");
					} finally {
						bytes.content.fill(0);
					}
				}
			}
			checked.throwIfAborted();
			return checked;
		};
		const seedName = `activation-request-${allocationId}.json`,
			indexName = `activation-intent-${allocationId}.json`;
		let seed: unknown;
		try {
			seed = (await readRecord(join(root, seedName))).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (seed === undefined) {
			const checked = await physical(signal);
			const cloud = await startControl.checkAdoption(evidence.mappings, checked);
			// Missing seed cannot repair any later phase, even an empty journal.
			for (const path of [indexName, `service-start-${allocationId}`, `activation-completed-${allocationId}.json`]) {
				try {
					await lstat(join(root, path));
					throw new Error("identity missing");
				} catch (error) {
					if (!code(error, "ENOENT")) throw error;
				}
			}
			const request = parseCompanyComputerServiceStartRequest({
				schema: "qorpera.office-service-start-request/v1",
				configuration: evidence.configuration,
				configurationCompletionSha256: evidence.configurationCompletionSha256,
				attestation: {
					schema: "qorpera.office-activation-attestation/v1",
					activationId: randomUUID(),
					bootId: evidence.configuration.command.bootId,
					preparationObservationSha256: evidence.preparationObservationSha256,
					configurationObservationSha256: evidence.configurationObservationSha256,
					configurationSha256: evidence.configuration.files["config.json"].sha256,
					adoptionReceiptSha256: evidence.configuration.adoptionReceiptSha256,
					nativePort: evidence.nativePort,
					viewerPort: evidence.viewerPort,
				},
			});
			const bytes = Buffer.from(officeCanonical(request));
			const command = parseCompanyComputerPreparationCommand({
				commandId: randomUUID(),
				bootId: request.attestation.bootId,
				requestSha256: hash(bytes),
			});
			cloud.signal.throwIfAborted();
			await publish(
				root,
				seedName,
				Buffer.from(
					officeCanonical({
						schema: "qorpera.lxd-office-activation-request/v1",
						intentId: input.intentId,
						binding,
						command,
						request,
					}),
				),
			);
			seed = (await readRecord(join(root, seedName))).value;
		}
		const retained = officeRecord(seed, ["schema", "intentId", "binding", "command", "request"]);
		const request = parseCompanyComputerServiceStartRequest(retained.request),
			command = parseCompanyComputerPreparationCommand(retained.command);
		const bytes = Buffer.from(officeCanonical(request));
		if (
			retained.schema !== "qorpera.lxd-office-activation-request/v1" ||
			retained.intentId !== input.intentId ||
			!isDeepStrictEqual(retained.binding, binding) ||
			command.requestSha256 !== hash(bytes) ||
			command.bootId !== request.attestation.bootId ||
			[evidence.configuration.command.commandId, evidence.configuration.preparation.commandId].includes(
				command.commandId,
			) ||
			!isDeepStrictEqual(
				request,
				parseCompanyComputerServiceStartRequest({
					...request,
					configuration: evidence.configuration,
					configurationCompletionSha256: evidence.configurationCompletionSha256,
					attestation: {
						...request.attestation,
						bootId: evidence.configuration.command.bootId,
						preparationObservationSha256: evidence.preparationObservationSha256,
						configurationObservationSha256: evidence.configurationObservationSha256,
						configurationSha256: evidence.configuration.files["config.json"].sha256,
						adoptionReceiptSha256: evidence.configuration.adoptionReceiptSha256,
						nativePort: evidence.nativePort,
						viewerPort: evidence.viewerPort,
					},
				}),
			)
		)
			throw new Error("activation identity changed");
		const identity = {
			intentId: input.intentId,
			binding,
			bootObservationSha256: evidence.bootObservationSha256,
			configurationObservationSha256: evidence.configurationObservationSha256,
			command,
		};
		const expectedIndex = {
			schema: "qorpera.lxd-office-activation-intent/v1",
			requestSha256: officeDigest(retained),
			identity,
		};
		let index: unknown;
		try {
			index = (await readRecord(join(root, indexName))).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (index === undefined) {
			let exists = true;
			try {
				await lstat(join(root, `service-start-${allocationId}`));
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				exists = false;
			}
			const journal = await LxdOfficeServiceStartJournal.open(root, identity, this.#client, exists);
			if ((await journal.observe(signal)).state !== "not_dispatched") throw new Error("activation index missing");
			signal.throwIfAborted();
			await publish(root, indexName, Buffer.from(officeCanonical(expectedIndex)));
			index = (await readRecord(join(root, indexName))).value;
		}
		if (!isDeepStrictEqual(index, expectedIndex)) throw new Error("activation index changed");
		const journal = await LxdOfficeServiceStartJournal.open(root, identity, this.#client);
		const control = new LxdOfficeActivationControl(
			input.intentId,
			binding,
			request.attestation,
			evidence.mappings,
			this.#activationRegistry,
		);
		let state = await control.status(signal).catch(() => null);
		if (!state) {
			const checked = await physical(signal),
				cloud = await startControl.checkAdoption(evidence.mappings, checked);
			state = await control.prepare(AbortSignal.any([checked, cloud.signal]));
		}
		const authorize = async (caller: AbortSignal) => {
			const checked = await physical(caller);
			if (
				!isDeepStrictEqual((await readRecord(join(root, seedName))).value, retained) ||
				!isDeepStrictEqual((await readRecord(join(root, indexName))).value, expectedIndex)
			)
				throw new Error("activation identity changed");
			const status = await control.status(checked);
			state = status;
			if (status.state === "active") {
				// SQL states never regress. This is an idempotent authority check on
				// an already committed activation, not a new pre-inspection transition.
				await control.activate(status.serviceInvocationId!, checked);
				return checked;
			}
			const cloud = await startControl.checkAdoption(evidence.mappings, checked);
			return AbortSignal.any([checked, cloud.signal]);
		};
		let operation = await journal.observe(await authorize(signal));
		if (operation.state === "not_dispatched") {
			if (state.state !== "prepared") throw new Error("unclaimed service");
			await this.#client.pushOfficeServiceStartRequest(
				binding.project,
				name,
				command.requestSha256,
				bytes,
				await authorize(signal),
			);
			const staged = await this.#client.readOfficeServiceStartRequest(
				binding.project,
				name,
				command.requestSha256,
				bytes.length,
				await authorize(signal),
			);
			if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o400 || !staged.content.equals(bytes))
				throw new Error("staging differs");
			const checked = await authorize(signal);
			if (state.state !== "prepared") throw new Error("service already claimed");
			operation = await journal.reconcile(checked);
		}
		const result = {
			intentId: input.intentId,
			allocationId,
			activationId: request.attestation.activationId,
			commandId: command.commandId,
			...(operation.operationId ? { operationId: operation.operationId } : {}),
		};
		let completionFile: Awaited<ReturnType<Client["readInstanceFile"]>>;
		try {
			completionFile = await this.#client.readInstanceFile(
				binding.project,
				name,
				"/run/qorpera-office-preparation/service-start-completion.json",
				16384,
				await authorize(signal),
			);
		} catch {
			signal.throwIfAborted();
			return { ...result, state: operation.state === "succeeded" ? "unknown" : operation.state };
		}
		if (completionFile.uid !== 0 || completionFile.gid !== 0 || completionFile.mode !== 0o600)
			throw new Error("completion custody");
		const completion = parseCompanyComputerServiceStartCompletion(decode(completionFile.content), command, request);
		const inspection = new LxdOfficeServiceInspectionControl(root, binding, this.#client);
		return inspection.inspectAndUse(
			command,
			request,
			completion,
			authorize,
			async (current, checked, assertFresh) => {
				const status = await control.status(checked);
				assertFresh();
				if (status.serviceInvocationId !== null && status.serviceInvocationId !== current.serviceInvocationId)
					throw new Error("invocation differs");
				if (status.state === "prepared" || (status.state === "ready" && !status.readinessFresh))
					return { ...result, state: "awaiting_readiness" as const };
				await control.activate(current.serviceInvocationId, checked);
				assertFresh();
				checked.throwIfAborted();
				const marker = {
					schema: "qorpera.lxd-office-activation-completion/v1",
					...result,
					completion,
					requestSha256: command.requestSha256,
				};
				await publish(root, `activation-completed-${allocationId}.json`, Buffer.from(officeCanonical(marker)));
				if (
					!isDeepStrictEqual(
						(await readRecord(join(root, `activation-completed-${allocationId}.json`))).value,
						marker,
					)
				)
					throw new Error("activation completion changed");
				checked.throwIfAborted();
				return { ...result, state: "active" as const, serviceInvocationId: current.serviceInvocationId };
			},
			signal,
			true,
		);
	}
}
