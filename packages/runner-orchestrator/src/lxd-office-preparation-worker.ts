import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCompletion,
	parseCompanyComputerPreparationReport,
} from "@qorpera/contracts";
import { type LxdOfficePreparationClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock, type LxdOfficeAdoptionCopyResult } from "./lxd-office-adoption-files.ts";
import { planLxdOfficeAdoption } from "./lxd-office-adoption-plan.ts";
import { type LxdOfficeBootRequest, LxdOfficeBootWorker } from "./lxd-office-boot-worker.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { createLxdOfficeGuestPreparationRequest } from "./lxd-office-guest-preparation.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { type LxdOfficePreparationIdentity, LxdOfficePreparationJournal } from "./lxd-office-preparation-journal.ts";
import { readLxdOfficePreparationRecovery } from "./lxd-office-preparation-recovery.ts";
import { LxdOfficeStartControl, type LxdOfficeStartRegistry } from "./lxd-office-start-control.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
type Gate = Pick<LxdOfficePhysicalGate, "policy" | "check">;
interface Ports {
	client?: LxdOfficePreparationClient;
	readProtected?: typeof readLxdOfficeProtectedFile;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}

/** Preparation of the already-created, copied and first-booted office only.
 * Requires the supervisor's process-owned kernel lock and serialized phases.
 * Known execs resume; unknown outcomes retain their one command/allocation.
 * A matching retained helper completion is evidence for a later activation
 * worker. The helper installs the copied-state receipt; this worker independently
 * verifies it. It installs no credentials and performs no cloud
 * activation, ordinary service start, deletion or capacity release. */
export class LxdOfficePreparationWorker {
	readonly #gate: Gate;
	readonly #policy;
	readonly #registry: LxdOfficeStartRegistry;
	readonly #client: LxdOfficePreparationClient;
	readonly #kernelLock;
	readonly #readProtected;
	readonly #boot: LxdOfficeBootWorker;
	#busy = false;
	constructor(gate: Gate, registry: LxdOfficeStartRegistry, ports: Ports = {}) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
		this.#readProtected = ports.readProtected ?? readLxdOfficeProtectedFile;
		this.#boot = new LxdOfficeBootWorker(gate, registry, { ...ports, client: this.#client });
	}
	static async open(
		policyPath: string,
		provenancePath: string,
		registry: LxdOfficeStartRegistry,
		signal: AbortSignal,
	) {
		return new LxdOfficePreparationWorker(
			await LxdOfficePhysicalGate.open(policyPath, provenancePath, signal),
			registry,
		);
	}
	async reconcile(request: LxdOfficeBootRequest, caller: AbortSignal) {
		return this.#reconcile(request, caller, false);
	}
	/** Keep composed configuration work occupied until preparation IO settles. */
	async reconcileSettled(request: LxdOfficeBootRequest, caller: AbortSignal) {
		return this.#reconcile(request, caller, true);
	}
	async #reconcile(request: LxdOfficeBootRequest, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		if (this.#busy) throw new Error("OFFICE_PREPARATION_RECONCILIATION_PENDING");
		const input = structuredClone(request);
		this.#busy = true;
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("OFFICE_PREPARATION_RECONCILIATION_ABORTED"));
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
	async #run(input: LxdOfficeBootRequest, signal: AbortSignal) {
		const policy = this.#policy,
			root = policy.journal.path;
		await this.#kernelLock(root);
		signal.throwIfAborted();
		const creation = await openLxdOfficeCreationIdentity(policy, input.intentId, true, this.#client, signal);
		const { binding } = creation;
		const allocationId = binding.allocationId;
		const bootCompletionPath = join(root, `boot-completed-${allocationId}.json`);
		const bootObservationPath = join(root, `boot-observation-${allocationId}.json`);
		// Missing acknowledged boot evidence cannot cause this phase to start a VM.
		const originalBootCompletion = (await readRecord(bootCompletionPath)).value;
		const originalBootObservation = (await readRecord(bootObservationPath)).value;
		const boot = await this.#boot.reconcileSettled(input, signal);
		if (boot.state !== "awaiting_preparation" || !("bootObservationSha256" in boot))
			throw new Error("OFFICE_PREPARATION_BOOT_UNCONFIRMED");
		if (
			!isDeepStrictEqual(originalBootCompletion, {
				schema: "qorpera.lxd-office-first-boot-completion/v1",
				allocationId,
				startCommandId: boot.startCommandId,
				bootObservationSha256: boot.bootObservationSha256,
			}) ||
			officeDigest(originalBootObservation) !== boot.bootObservationSha256
		)
			throw new Error("OFFICE_PREPARATION_BOOT_UNCONFIRMED");
		const observation = (
			await readRecord(
				join(root, `inventory-${officeSha(input.observationSha256)}.json`),
				COMPANY_COMPUTER_PREPARATION_MAX_BYTES + 4096,
			)
		).value as LxdOfficeStorageObservation;
		const plan = planLxdOfficeAdoption(input.input, binding, observation);
		const copy = (await readRecord(join(root, `adoption-result-${plan.adoptionId}.json`)))
			.value as LxdOfficeAdoptionCopyResult;
		if (officeDigest(copy) !== boot.copySha256) throw new Error("OFFICE_PREPARATION_COPY_CHANGED");
		// LXD 6.9 gives the fixed workbench disk the lxd_workbench virtiofs tag.
		// These are the pinned preparation unit's limits, not client choices.
		const request = createLxdOfficeGuestPreparationRequest({
			binding,
			observation,
			plan,
			result: copy,
			bootId: boot.bootId,
			uid: policy.workbench.uid,
			gid: policy.workbench.gid,
			workbenchMount: {
				filesystem: "virtiofs",
				source: "lxd_workbench",
				root: "/",
				mountPoint: "/var/lib/qorpera-office",
			},
			limits: { memoryBytes: 4 * 1024 ** 3, pids: 512, cpuQuota: 200000, cpuPeriod: 100000 },
		});
		const bytes = Buffer.from(`${JSON.stringify(request)}\n`);
		if (bytes.length > COMPANY_COMPUTER_PREPARATION_MAX_BYTES)
			throw new Error("OFFICE_PREPARATION_REQUEST_TOO_LARGE");
		const requestSha256 = hash(bytes);
		const control = new LxdOfficeStartControl(input.intentId, binding, this.#registry);
		const mappings = plan.screens.map((screen) => ({
			binding: screen.binding,
			browserProfile: screen.browser.disposition === "adopt" ? screen.browser.grant : null,
		}));
		const authorize = async () => {
			signal.throwIfAborted();
			await this.#kernelLock(root);
			if (
				!isDeepStrictEqual((await readRecord(bootCompletionPath)).value, originalBootCompletion) ||
				!isDeepStrictEqual((await readRecord(bootObservationPath)).value, originalBootObservation) ||
				!isDeepStrictEqual(await this.#boot.reconcileSettled(input, signal), boot)
			)
				throw new Error("OFFICE_PREPARATION_EVIDENCE_CHANGED");
			const physical = await this.#gate.check(binding, signal);
			if (physical.hostBootId !== observation.hostBootId) throw new Error("OFFICE_PREPARATION_HOST_CHANGED");
			const checked = AbortSignal.any([signal, physical.signal]);
			const cloud = await control.checkAdoption(mappings, checked);
			const authorized = AbortSignal.any([checked, cloud.signal]);
			const current = await inspectLxdOfficeGuestBoot(this.#client, binding, authorized);
			if (current.bootId !== boot.bootId || current.instanceSha256 !== boot.instanceSha256)
				throw new Error("OFFICE_PREPARATION_BOOT_CHANGED");
			authorized.throwIfAborted();
			return authorized;
		};
		const indexName = `preparation-intent-${allocationId}.json`;
		const requestName = `preparation-request-${allocationId}.json`;
		const observationName = `preparation-observation-${allocationId}.json`;
		const completionName = `preparation-completed-${allocationId}.json`;
		const expected = {
			schema: "qorpera.lxd-office-preparation-intent/v1",
			intentId: input.intentId,
			allocationId,
			bootObservationSha256: boot.bootObservationSha256,
			bootId: boot.bootId,
			copySha256: boot.copySha256,
			requestSha256,
			requestBytes: bytes.length,
		};
		let index: unknown;
		try {
			index = (await readRecord(join(root, indexName))).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (index === undefined) {
			const checked = await authorize();
			for (const name of [observationName, completionName]) {
				try {
					await lstat(join(root, name));
					throw new Error("OFFICE_PREPARATION_IDENTITY_MISSING");
				} catch (error) {
					if (!code(error, "ENOENT")) throw error;
				}
			}
			const directory = join(root, `preparation-${allocationId}`);
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
						"command",
					])
				: undefined;
			const command = retained
				? parseCompanyComputerPreparationCommand(retained.command)
				: parseCompanyComputerPreparationCommand({ commandId: randomUUID(), requestSha256, bootId: boot.bootId });
			if (command.requestSha256 !== requestSha256 || command.bootId !== boot.bootId)
				throw new Error("OFFICE_PREPARATION_IDENTITY_CHANGED");
			const identity: LxdOfficePreparationIdentity = {
				intentId: input.intentId,
				binding,
				bootObservationSha256: boot.bootObservationSha256,
				command,
			};
			const journal = await LxdOfficePreparationJournal.open(root, identity, this.#client, exists);
			if ((await journal.observe(checked)).state !== "not_dispatched")
				throw new Error("OFFICE_PREPARATION_IDENTITY_MISSING");
			checked.throwIfAborted();
			await publish(root, requestName, bytes);
			if (!(await readRecord(join(root, requestName), COMPANY_COMPUTER_PREPARATION_MAX_BYTES)).bytes.equals(bytes))
				throw new Error("OFFICE_PREPARATION_REQUEST_CHANGED");
			await publish(root, indexName, Buffer.from(officeCanonical({ ...expected, commandId: command.commandId })));
			index = (await readRecord(join(root, indexName))).value;
		}
		const retained = officeRecord(index, [...Object.keys(expected), "commandId"]);
		const command = parseCompanyComputerPreparationCommand({
			commandId: retained.commandId,
			requestSha256,
			bootId: boot.bootId,
		});
		if (!isDeepStrictEqual(retained, { ...expected, commandId: command.commandId }))
			throw new Error("OFFICE_PREPARATION_IDENTITY_CHANGED");
		const journal = await LxdOfficePreparationJournal.open(
			root,
			{ intentId: input.intentId, binding, bootObservationSha256: boot.bootObservationSha256, command },
			this.#client,
		);
		const authorizeCommand = async () => {
			const checked = await authorize();
			if (
				!isDeepStrictEqual((await readRecord(join(root, indexName))).value, retained) ||
				!(await readRecord(join(root, requestName), COMPANY_COMPUTER_PREPARATION_MAX_BYTES)).bytes.equals(bytes)
			)
				throw new Error("OFFICE_PREPARATION_IDENTITY_CHANGED");
			checked.throwIfAborted();
			return checked;
		};
		let checked = await authorizeCommand();
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
				throw new Error("OFFICE_PREPARATION_GUEST_LOCK_UNCONFIRMED");
			checked = await authorizeCommand();
			await this.#client.pushOfficePreparationRequest(binding.project, name, requestSha256, bytes, checked);
			checked = await authorizeCommand();
			const staged = await this.#client.readOfficePreparationRequest(
				binding.project,
				name,
				requestSha256,
				bytes.length,
				checked,
			);
			if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o400 || !staged.content.equals(bytes))
				throw new Error("OFFICE_PREPARATION_STAGING_UNCONFIRMED");
			checked = await authorizeCommand();
			operation = await journal.reconcile(checked);
		}
		const recovery = await readLxdOfficePreparationRecovery(
			root,
			{ intentId: input.intentId, binding, bootObservationSha256: boot.bootObservationSha256, command },
			this.#client,
			checked,
			operation,
			input.reviewPath,
			this.#readProtected,
		);
		operation = recovery.operation;
		const { recoveryBytes } = recovery;
		const result = {
			intentId: input.intentId,
			allocationId,
			commandId: command.commandId,
			bootId: boot.bootId,
			requestSha256,
			...(operation.operationId ? { operationId: operation.operationId } : {}),
		};
		if (operation.state !== "succeeded") return { ...result, state: operation.state };
		if (!operation.operationId) throw new Error("OFFICE_PREPARATION_OPERATION_UNCONFIRMED");
		const readGuest = async (path: string, authorized: AbortSignal) => {
			const file = await this.#client.readInstanceFile(
				binding.project,
				name,
				`/run/qorpera-office-preparation/${path}`,
				65536,
				authorized,
			);
			if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o600 || !file.content.length)
				throw new Error("OFFICE_PREPARATION_GUEST_EVIDENCE_UNPROTECTED");
			return file.content;
		};
		checked = await authorizeCommand();
		const completionBytes = await readGuest("completion.json", checked);
		const reportBytes = await readGuest("result.json", checked);
		const expectedReceiptBytes = Buffer.from(
			`${JSON.stringify(companyComputerPreparationAdoptionReceipt(request))}\n`,
		);
		const readReceipt = async (authorized: AbortSignal) => {
			const file = await this.#client.readInstanceFile(
				binding.project,
				name,
				COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
				16384,
				authorized,
			);
			if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444 || !file.content.equals(expectedReceiptBytes))
				throw new Error("OFFICE_PREPARATION_ADOPTION_UNCONFIRMED");
			return file.content;
		};
		const receiptBytes = await readReceipt(checked);
		const hashes = {
			commandId: command.commandId,
			requestSha256,
			contentSha256: hash(JSON.stringify(request.entries)),
			reportSha256: hash(reportBytes),
			adoptionReceiptSha256: hash(receiptBytes),
		};
		const completion = parseCompanyComputerPreparationCompletion(json(completionBytes), request, hashes);
		if (
			!isDeepStrictEqual(
				parseCompanyComputerPreparationReport(json(reportBytes), request, hashes),
				completion.report,
			)
		)
			throw new Error("OFFICE_PREPARATION_REPORT_CHANGED");
		checked = await authorizeCommand();
		if (
			!completionBytes.equals(await readGuest("completion.json", checked)) ||
			!reportBytes.equals(await readGuest("result.json", checked)) ||
			!receiptBytes.equals(await readReceipt(checked))
		)
			throw new Error("OFFICE_PREPARATION_REPORT_CHANGED");
		if (
			recoveryBytes &&
			!(await this.#readProtected(`${input.reviewPath}.preparation-recovery`, 16384)).equals(recoveryBytes)
		)
			throw new Error("OFFICE_PREPARATION_RECOVERY_CHANGED");
		checked.throwIfAborted();
		const evidence = {
			schema: "qorpera.lxd-office-preparation-observation/v1",
			...result,
			bootObservationSha256: boot.bootObservationSha256,
			copySha256: boot.copySha256,
			completionSha256: hash(completionBytes),
			adoptionReceiptPath: COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
			adoptionReceiptSha256: hash(receiptBytes),
			completion,
		};
		const marker = {
			schema: "qorpera.lxd-office-preparation-completion/v1",
			allocationId,
			commandId: command.commandId,
			observationSha256: officeDigest(evidence),
		};
		let completed: unknown;
		try {
			completed = (await readRecord(join(root, completionName))).value;
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (
			completed !== undefined &&
			(!isDeepStrictEqual(completed, marker) ||
				!isDeepStrictEqual((await readRecord(join(root, observationName), 65536)).value, evidence))
		)
			throw new Error("OFFICE_PREPARATION_RETAINED_EVIDENCE_CHANGED");
		await publish(root, observationName, Buffer.from(officeCanonical(evidence)));
		if (!isDeepStrictEqual((await readRecord(join(root, observationName), 65536)).value, evidence))
			throw new Error("OFFICE_PREPARATION_RETAINED_EVIDENCE_CHANGED");
		checked.throwIfAborted();
		await publish(root, completionName, Buffer.from(officeCanonical(marker)));
		if (!isDeepStrictEqual((await readRecord(join(root, completionName))).value, marker))
			throw new Error("OFFICE_PREPARATION_RETAINED_EVIDENCE_CHANGED");
		checked.throwIfAborted();
		return { ...result, state: "awaiting_activation" as const, observationSha256: marker.observationSha256 };
	}
}
