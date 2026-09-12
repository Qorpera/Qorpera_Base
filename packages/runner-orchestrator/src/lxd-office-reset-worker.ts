import { createHash, randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	COMPANY_COMPUTER_RESET_PHASES,
	type CompanyComputerActivationAttestation,
	type CompanyComputerPreparationCommand,
	type CompanyComputerPreparationRequest,
	type CompanyComputerResetChallengePhase,
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetCustodyBinding,
	type CompanyComputerResetCustodyManifest,
	type CompanyComputerResetPhase,
	type CompanyComputerResetPlan,
	type CompanyComputerResetRestoreReceipt,
	type CompanyComputerResetStatus,
	type CompanyComputerResetSuccessor,
	companyComputerResetRestorablePath,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerResetCustodyManifest,
	parseCompanyComputerResetOutboxManifest,
	parseCompanyComputerResetPlan,
	parseCompanyComputerResetRestoreReceipt,
	parseCompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetSuccessor,
	parseCompanyComputerResetSuccessorRequest,
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopRequest,
	parseCompanyComputerStartupIdentity,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";
import {
	type LxdHostInventoryClient,
	type LxdOfficeResetClient,
	type LxdOfficeResetSuccessorClient,
	type LxdOfficeServiceRestartClient,
	type LxdTrackedClient,
	LxdUnixClient,
	OFFICE_RESET_HISTORY_ROOT,
	OFFICE_RESET_OUTBOX_ROOT,
} from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import type { LxdOfficeRetainedActivationHistoryClient } from "./lxd-office-boot-restart-history.ts";
import { readLxdOfficeBootVmEvidence } from "./lxd-office-boot-vm-evidence.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import {
	assertLxdOfficeGuestInstance,
	inspectLxdOfficeGuestBoot,
	type LxdOfficeGuestBinding,
	lxdOfficeGuestPlan,
} from "./lxd-office-guest.ts";
import { assertOfficeImageResetCapability, parseOfficeImagePackage } from "./lxd-office-image-installation.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeInvocationMeasurement } from "./lxd-office-invocation-measurement.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import { reserveLxdOfficeNodeMachine } from "./lxd-office-node-admission.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import {
	type readLxdOfficeCredentialFile,
	type readLxdOfficeProtectedFile,
	readLxdOfficeProtectedImageManifestFile,
} from "./lxd-office-physical-host.ts";
import { officePhysicalPath, parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { createLxdOfficeResetConfigurationPayload } from "./lxd-office-reset-configuration-payload.ts";
import {
	LxdOfficeResetControl,
	type LxdOfficeResetRegistry,
	LxdOfficeResetSuccessorControl,
	type LxdOfficeResetSuccessorRegistry,
} from "./lxd-office-reset-control.ts";
import {
	type LxdOfficeResetArchive,
	openLxdOfficeResetArchive,
	openLxdOfficeResetNasCustody,
	readLxdOfficeResetArchive,
	sealLxdOfficeResetArchive,
} from "./lxd-office-reset-custody.ts";
import { LxdOfficeResetJournal, type LxdOfficeResetSeed, parseLxdOfficeResetSeed } from "./lxd-office-reset-journal.ts";
import {
	createLxdOfficeResetSuccessorLane,
	type LxdOfficeResetSuccessorLane,
	type LxdOfficeResetSuccessorLaneContext,
} from "./lxd-office-reset-successor-lane.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";
import { officeStopDecode, officeStopHash, readLxdOfficeStopEvidence } from "./lxd-office-stop-evidence.ts";
import type { RuntimeNodeRegistry } from "./runtime-node-admission.ts";

type Client = LxdOfficeResetClient &
	LxdOfficeResetSuccessorClient &
	LxdTrackedClient &
	LxdOfficeRetainedActivationHistoryClient &
	LxdOfficeServiceRestartClient &
	LxdHostInventoryClient;
export interface LxdOfficeResetWorkerRegistry {
	call(
		method:
			| Parameters<LxdOfficeResetRegistry["call"]>[0]
			| Parameters<LxdOfficeResetSuccessorRegistry["call"]>[0]
			| Parameters<RuntimeNodeRegistry["call"]>[0],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
interface Ports {
	client?: Client;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
	readProtected?: typeof readLxdOfficeProtectedFile;
	readCredential?: typeof readLxdOfficeCredentialFile;
	/** Trusted test port only; production composes the guest lane on the client. */
	successorLane?: LxdOfficeResetSuccessorLane;
	measureInvocation?: LxdOfficeInvocationMeasurement;
	/** Trusted test port only; production holds the real NAS descriptors. */
	nasCustody?: typeof openLxdOfficeResetNasCustody;
}
export interface LxdOfficeResetInput {
	intentId: string;
	plan: CompanyComputerResetPlan;
	planSha256: string;
	serviceBootstrapPath: string;
	/** Protected manifest of the immutable preparation image, never the live root. */
	imagePackageManifestPath?: string;
}
export interface LxdOfficeResetResult {
	state: "progressed" | "held" | "pending" | "unknown" | "failed" | "awaiting_readiness" | "active";
	phase: CompanyComputerResetPhase;
	reason?: string;
	intentId: string;
	allocationId: string;
	resetId: string;
	transitionId: string;
	activationId: string;
	serviceInvocationId?: string;
}
interface Preparation {
	request: CompanyComputerPreparationRequest;
	command: CompanyComputerPreparationCommand;
	bytes: Buffer;
	adoptionReceiptSha256: string;
}
type Authorize = (caller: AbortSignal) => Promise<AbortSignal>;
type Acknowledge = (
	phase: CompanyComputerResetChallengePhase,
	observation: Record<string, unknown>,
	authorize: Authorize,
) => Promise<LxdOfficeResetResult>;
interface Context {
	input: LxdOfficeResetInput;
	plan: CompanyComputerResetPlan;
	seed: LxdOfficeResetSeed;
	binding: LxdOfficeGuestBinding;
	name: string;
	preparation: Preparation;
	stopCommand: CompanyComputerPreparationCommand;
	names: Record<
		| "seed"
		| "custody"
		| "restore"
		| "configuration"
		| "configured"
		| "successor"
		| "prepared"
		| "start"
		| "started"
		| "done",
		string
	>;
	optional: (name: string, limit?: number) => Promise<unknown>;
	retain: (name: string, value: unknown) => Promise<void>;
	registry: LxdOfficeResetWorkerRegistry;
	control: LxdOfficeResetControl;
	journal: LxdOfficeResetJournal;
	operations: LxdOfficeOperationJournal;
	status: CompanyComputerResetStatus;
	result: Omit<LxdOfficeResetResult, "state" | "phase">;
	signal: AbortSignal;
}
const pending = new Set<string>();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTBOX_RECORD = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9]{16})\.json$/;
const evidenceOf = (
	plan: CompanyComputerResetPlan,
	phase: CompanyComputerResetChallengePhase,
	observation: object,
) => ({
	schema: "qorpera.office-reset-phase-evidence/v1" as const,
	resetId: plan.resetId,
	phase,
	observation: observation as Record<string, unknown>,
});
function outboxCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(outboxCanonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b, "en"))
				.map(([key, item]) => [key, outboxCanonical(item)]),
		);
	return value;
}

/** Serialized governed root reset for one retained allocation. The supervisor
 * owns the kernel lock and dispatches this worker only after the explicit
 * protected reset plan and the acknowledged replace stop. Each call advances
 * at most one phase; SQL is the phase authority, the local journal fences
 * dispatch order, and every physical command has exactly one planned
 * identity. Unknown dispatch outcomes are observed, never redispatched; no
 * phase releases capacity, rebinds the allocation or reserves another node. */
export class LxdOfficeResetWorker {
	readonly #gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly #policy;
	readonly #registry: LxdOfficeResetWorkerRegistry;
	readonly #client: Client;
	readonly #kernelLock;
	readonly #ports: Ports;
	readonly #lane: LxdOfficeResetSuccessorLane;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		registry: LxdOfficeResetWorkerRegistry,
		ports: Ports = {},
	) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
		this.#ports = { ...ports };
		this.#lane = ports.successorLane ?? createLxdOfficeResetSuccessorLane(this.#policy.journal.path, this.#client);
	}
	reconcile(input: LxdOfficeResetInput, caller: AbortSignal) {
		return this.#reconcile(input, caller, false);
	}
	reconcileSettled(input: LxdOfficeResetInput, caller: AbortSignal) {
		return this.#reconcile(input, caller, true);
	}
	async #reconcile(value: LxdOfficeResetInput, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		const input: LxdOfficeResetInput = {
			intentId: value.intentId,
			plan: parseCompanyComputerResetPlan(value.plan),
			planSha256: officeSha(value.planSha256),
			serviceBootstrapPath: officePhysicalPath(value.serviceBootstrapPath),
			imagePackageManifestPath:
				value.imagePackageManifestPath === undefined
					? undefined
					: officePhysicalPath(value.imagePackageManifestPath),
		};
		if (!UUID.test(input.intentId) || input.intentId !== input.plan.intentId)
			throw new Error("OFFICE_RESET_INTENT_DIFFERS");
		const root = this.#policy.journal.path;
		if (pending.has(root)) throw new Error("OFFICE_RESET_RECONCILIATION_PENDING");
		pending.add(root);
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]),
			io = new Set<Promise<unknown>>();
		const registry: LxdOfficeResetWorkerRegistry = {
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
			abort = () => reject(new Error("OFFICE_RESET_RECONCILIATION_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(input, registry, signal)
			.catch((error) => {
				throw new Error("OFFICE_RESET_UNCONFIRMED", { cause: error });
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
	async #assertResetImage(input: LxdOfficeResetInput, signal: AbortSignal): Promise<void> {
		try {
			signal.throwIfAborted();
			if (!input.imagePackageManifestPath) throw new Error("missing manifest");
			const bytes = this.#ports.readProtected
				? await this.#ports.readProtected(input.imagePackageManifestPath, 1024 ** 2)
				: await readLxdOfficeProtectedImageManifestFile(input.imagePackageManifestPath);
			if (hash(bytes) !== this.#policy.image.guestPackageManifestSha256) throw new Error("image manifest differs");
			assertOfficeImageResetCapability(parseOfficeImagePackage(officeStopDecode(bytes)));
			signal.throwIfAborted();
		} catch {
			throw new Error("OFFICE_RESET_IMAGE_CAPABILITY_UNCONFIRMED");
		}
	}
	async #run(
		input: LxdOfficeResetInput,
		registry: LxdOfficeResetWorkerRegistry,
		signal: AbortSignal,
	): Promise<LxdOfficeResetResult> {
		const root = this.#policy.journal.path,
			{ intentId, plan } = input,
			recovery = plan.predecessor;
		await this.#kernelLock(root);
		await this.#assertResetImage(input, signal);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal),
			{ binding } = creation,
			{ allocationId } = binding,
			{ transitionId } = recovery,
			guest = lxdOfficeGuestPlan(binding),
			name = guest.request.name;
		if (
			recovery.providerId !== binding.providerId ||
			recovery.providerPolicySha256 !== binding.providerPolicySha256 ||
			recovery.startup.allocationId !== allocationId ||
			recovery.startup.instanceSha256 !== guest.instanceSha256 ||
			recovery.startup.imageSha256 !== binding.imageFingerprint ||
			recovery.startup.bootstrapSha256 !== binding.bootstrapSha256 ||
			recovery.startup.computerGeneration !== binding.computerGeneration ||
			plan.providerBindingSha256 !== lxdOfficeProviderBindingSha256(binding) ||
			!isDeepStrictEqual(recovery.startup.scope, {
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
			})
		)
			throw new Error("reset binding differs");
		const result = {
			intentId,
			allocationId,
			resetId: plan.resetId,
			transitionId,
			activationId: plan.successorActivationId,
		};
		const suffix = `${allocationId}-${plan.resetId}`,
			names: Context["names"] = {
				seed: `reset-seed-${suffix}.json`,
				custody: `reset-custody-${suffix}.json`,
				restore: `reset-restore-${suffix}.json`,
				configuration: `reset-configuration-${suffix}.json`,
				configured: `reset-configured-${suffix}.json`,
				successor: `reset-successor-request-${suffix}.json`,
				prepared: `reset-successor-prepared-${suffix}.json`,
				start: `reset-service-start-${suffix}.json`,
				started: `reset-service-started-${suffix}.json`,
				done: `reset-completed-${suffix}.json`,
			};
		const optional = async (name: string, limit = 65536) => {
			try {
				return (await readRecord(join(root, name), limit)).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
				return undefined;
			}
		};
		const retain = async (name: string, value: unknown) => {
			signal.throwIfAborted();
			await publish(root, name, Buffer.from(officeCanonical(value)));
			if (!isDeepStrictEqual(await optional(name), value)) throw new Error("reset record changed");
		};
		// The acknowledged replace stop is the fence; both records are immutable.
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
			stopCommand.bootId !== recovery.startup.bootId ||
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
		const preparation = await this.#preparation(root, allocationId);
		if (preparation.command.requestSha256 === plan.preparationObservationSha256)
			throw new Error("reset preparation identity differs");
		const control = new LxdOfficeResetControl(plan, input.planSha256, registry);
		const journal = await LxdOfficeResetJournal.open(root, plan);
		const operations = await LxdOfficeOperationJournal.open(root, intentId, binding, this.#client, true);
		// Seed while the old root is still readable: predecessor evidence,
		// original preparation identity and the retained VM command lineage.
		let seedValue = await optional(names.seed);
		if (seedValue === undefined) {
			if (journal.phase !== null) throw new Error("reset seed lost");
			const evidence = await readLxdOfficeStopEvidence(root, intentId, binding, recovery, this.#client, signal);
			if (evidence.attestation.preparationObservationSha256 !== plan.preparationObservationSha256)
				throw new Error("reset preparation identity differs");
			const commands =
				evidence.kind === "reset" || evidence.kind === "reset_restart"
					? evidence.origin.commands
					: evidence.kind !== "original"
						? (await readLxdOfficeBootVmEvidence(root, creation, evidence.origin.bootIntent, signal)).commands
						: [
								{ commandId: creation.createCommandId, action: "create" as const },
								{
									commandId: officeRecord(await optional(`boot-observation-${allocationId}.json`), [
										"schema",
										"intentId",
										"allocationId",
										"createCommandId",
										"startCommandId",
										"observationSha256",
										"planSha256",
										"copySha256",
										"reviewSha256",
										"bootId",
										"instanceSha256",
										"hostBootId",
									]).startCommandId as string,
									action: "start" as const,
								},
							];
			const completionPath = evidence.initial
				? "/run/qorpera-office-preparation/service-stop-completion.json"
				: `/run/qorpera-office-preparation/service-stop-completion-${recovery.activationId}.json`;
			const file = await this.#client.readInstanceFile(binding.project, name, completionPath, 8192, signal);
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== 0o600 ||
				!isDeepStrictEqual(officeStopDecode(file.content), acknowledgement.inspection.stop)
			)
				throw new Error("root stop differs");
			seedValue = {
				schema: commands.some((command) => command.action === "delete")
					? "qorpera.lxd-office-reset-seed/v2"
					: "qorpera.lxd-office-reset-seed/v1",
				intentId,
				planSha256: input.planSha256,
				hostBootId: evidence.hostBootId,
				attestation: evidence.attestation,
				completionPath,
				stopCompletionSha256: officeStopHash(file.content),
				startObservationSha256: evidence.startObservationSha256,
				bootObservationSha256: evidence.bootObservationSha256,
				originalBootId: preparation.request.bootId,
				adoptionReceiptSha256: preparation.adoptionReceiptSha256,
				commands,
			};
			await retain(names.seed, seedValue);
		}
		const seed = parseLxdOfficeResetSeed(seedValue);
		if (
			seed.intentId !== intentId ||
			seed.planSha256 !== input.planSha256 ||
			seed.attestation.activationId !== recovery.activationId ||
			seed.attestation.bootId !== recovery.startup.bootId ||
			seed.attestation.preparationObservationSha256 !== plan.preparationObservationSha256 ||
			seed.originalBootId !== preparation.request.bootId ||
			seed.adoptionReceiptSha256 !== preparation.adoptionReceiptSha256 ||
			seed.commands[0]?.commandId !== creation.createCommandId
		)
			throw new Error("reset seed differs");
		// Immutable lookup by activation; later stop/restart/reboot must resolve
		// the reset's retained plan without consulting a mutable latest pointer.
		const activationIndex = {
			schema: "qorpera.lxd-office-reset-activation-index/v1",
			intentId,
			binding,
			plan,
		};
		const activationIndexName = `reset-activation-${allocationId}-${plan.successorActivationId}.json`;
		if ((await optional(activationIndexName)) === undefined) await retain(activationIndexName, activationIndex);
		else if (!isDeepStrictEqual(await optional(activationIndexName), activationIndex))
			throw new Error("reset activation index differs");
		const phaseIndex = (phase: CompanyComputerResetPhase | null) =>
			phase === null ? -1 : COMPANY_COMPUTER_RESET_PHASES.indexOf(phase);
		// SQL is the authority; the local journal may trail it only by the phase
		// whose committed acknowledgement reply was lost.
		let status: CompanyComputerResetStatus;
		if (journal.phase === null) {
			status = await control.begin(signal);
			if (status.phase !== "fenced") throw new Error("reset journal lost");
			await journal.advance("fenced", input.planSha256);
		} else status = await control.status(signal);
		if (
			phaseIndex(status.phase) < phaseIndex(journal.phase) ||
			phaseIndex(status.phase) > phaseIndex(journal.phase) + 1 ||
			status.stopAcknowledgedAtMs !== acknowledgement.acknowledgedAtMs
		)
			throw new Error("reset phase authority differs");
		const current = journal.phase as CompanyComputerResetPhase;
		const next = COMPANY_COMPUTER_RESET_PHASES[phaseIndex(current) + 1];
		if (!next) {
			const done = officeRecord(await optional(names.done), [
				"schema",
				"resetId",
				"activationId",
				"serviceInvocationId",
			]);
			if (done.resetId !== plan.resetId || done.activationId !== plan.successorActivationId)
				throw new Error("reset completion differs");
			return {
				...result,
				state: "active",
				phase: "active",
				serviceInvocationId: done.serviceInvocationId as string,
			};
		}
		const context: Context = {
			input,
			plan,
			seed,
			binding,
			name,
			preparation,
			stopCommand,
			names,
			optional,
			retain,
			registry,
			control,
			journal,
			operations,
			status,
			result,
			signal,
		};
		const physical: Authorize = async (caller) => {
			caller.throwIfAborted();
			await this.#kernelLock(root);
			await this.#assertResetImage(input, caller);
			if (
				!isDeepStrictEqual(
					await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, caller),
					creation,
				) ||
				!isDeepStrictEqual(await optional(names.seed), seedValue)
			)
				throw new Error("reset evidence changed");
			const gate = await this.#gate.check(binding, caller);
			if (gate.hostBootId !== seed.hostBootId) throw new Error("reset host changed");
			const checked = AbortSignal.any([caller, gate.signal]);
			checked.throwIfAborted();
			return checked;
		};
		const oldBootRunning: Authorize = async (caller) => {
			const checked = await physical(caller);
			const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, checked);
			if (boot.bootId !== recovery.startup.bootId || boot.instanceSha256 !== recovery.startup.instanceSha256)
				throw new Error("reset guest changed");
			const file = await this.#client.readInstanceFile(binding.project, name, seed.completionPath, 8192, checked);
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== 0o600 ||
				officeStopHash(file.content) !== seed.stopCompletionSha256
			)
				throw new Error("root stop changed");
			checked.throwIfAborted();
			return checked;
		};
		// Durable nonce records bound the SQL challenge budget (64 per phase)
		// and prove which exact dispatch/ack windows were ever requested.
		const challenge = async (
			phase: CompanyComputerResetChallengePhase,
			evidenceSha256: string,
			kind: "dispatch" | "ack",
		) => {
			const prefix = `reset-challenge-${suffix}-${phase}-`;
			let count = 0;
			for await (const entry of await opendir(root)) {
				signal.throwIfAborted();
				if (++count > 8192) throw new Error("reset challenge scan limit");
				if (!entry.name.startsWith(prefix)) continue;
				const record = officeRecord(await optional(entry.name), [
					"schema",
					"phase",
					"kind",
					"challengeId",
					"evidenceSha256",
				]);
				if (record.kind === kind && record.evidenceSha256 !== evidenceSha256)
					throw new Error("reset evidence diverged");
			}
			const challengeId = randomUUID();
			if (
				!(await publish(
					root,
					`${prefix}${challengeId}.json`,
					Buffer.from(
						officeCanonical({
							schema: "qorpera.lxd-office-reset-challenge/v1",
							phase,
							kind,
							challengeId,
							evidenceSha256,
						}),
					),
				))
			)
				throw new Error("reset nonce reused");
			return control.preparePhase(phase, challengeId, evidenceSha256, signal);
		};
		const progressed = (): LxdOfficeResetResult => ({ ...result, state: "progressed", phase: next });
		const acknowledge: Acknowledge = async (phase, observation, authorize) => {
			const evidence = evidenceOf(plan, phase, observation),
				evidenceSha256 = officeDigest(evidence);
			if (context.status.phase === phase) {
				// The committed acknowledgement reply was lost; SQL holds this phase.
				await journal.advance(phase, evidenceSha256);
				return progressed();
			}
			const window = await challenge(phase, evidenceSha256, "ack");
			const checked = await authorize(window.signal);
			checked.throwIfAborted();
			context.status = await control.ackPhase(window.challenge.challengeId, evidence, window.deadline, checked);
			if (context.status.phase !== phase) throw new Error("reset acknowledgement differs");
			await journal.advance(phase, evidenceSha256);
			return progressed();
		};
		if (next === "stopped")
			return acknowledge(
				"stopped",
				{
					stopCommandId: stopCommand.commandId,
					acknowledgedAtMs: acknowledgement.acknowledgedAtMs,
					stopCompletionSha256: seed.stopCompletionSha256,
				},
				oldBootRunning,
			);
		const archive = await openLxdOfficeResetArchive(this.#policy, plan, preparation.request);
		const custodyBinding: CompanyComputerResetCustodyBinding = {
			schema: "qorpera.office-reset-custody-binding/v1",
			resetId: plan.resetId,
			transitionId,
			predecessorActivationId: recovery.activationId,
			successorActivationId: plan.successorActivationId,
			rootIncarnationId: plan.rootIncarnationId,
			predecessor: recovery.startup,
			outboxUid: 0,
			outboxGid: 0,
		};
		if (next === "custodied") return this.#custody(context, archive, custodyBinding, acknowledge, oldBootRunning);
		const custodyRecord = officeRecord(await optional(names.custody), [
				"schema",
				"binding",
				"custody",
				"manifestSha256",
			]),
			custody = parseCompanyComputerResetCustodyManifest(custodyRecord.custody, plan),
			owner = officeRecord(custodyRecord.binding, Object.keys(custodyBinding)),
			bound: CompanyComputerResetCustodyBinding = {
				...custodyBinding,
				outboxUid: owner.outboxUid as number,
				outboxGid: owner.outboxGid as number,
			};
		if (
			custodyRecord.schema !== "qorpera.lxd-office-reset-custody/v1" ||
			!isDeepStrictEqual(custodyRecord.binding, bound) ||
			officeDigest(evidenceOf(plan, "custodied", custody)) !== context.status.custodySha256
		)
			throw new Error("reset custody differs");
		const nas = await (this.#ports.nasCustody ?? openLxdOfficeResetNasCustody)(this.#policy, preparation.request);
		try {
			const sealed = await readLxdOfficeResetArchive(archive, plan, bound);
			if (
				!isDeepStrictEqual(sealed.manifest, custody) ||
				sealed.manifestSha256 !== officeSha(custodyRecord.manifestSha256) ||
				custody.nas.layoutSha256 !== nas.layoutSha256
			)
				throw new Error("reset archive differs");
			const guarded: Authorize = async (caller) => {
				const checked = await physical(caller);
				await nas.verify();
				if (!isDeepStrictEqual((await readLxdOfficeResetArchive(archive, plan, bound)).manifest, custody))
					throw new Error("reset archive changed");
				checked.throwIfAborted();
				return checked;
			};
			const dispatch = async (
				phase: "powered_off" | "root_deleted" | "root_created" | "restored",
				commandId: string,
				action: "stop" | "delete" | "create" | "start",
				precondition: (checked: AbortSignal) => Promise<void>,
			) => {
				let operation = await operations.observe(commandId, action, signal);
				if (operation.state === "not_dispatched") {
					const lineage = await operations.assertResetLineage(seed.commands, plan.commands, signal),
						expected = { powered_off: "none", root_deleted: "stop", root_created: "delete", restored: "create" }[
							phase
						];
					if (lineage.reached !== expected || (expected !== "none" && !lineage.settled))
						throw new Error("reset lineage differs");
					const window = await challenge(phase, officeDigest({ dispatch: commandId, action }), "dispatch");
					const checked = await guarded(window.signal);
					await precondition(checked);
					checked.throwIfAborted();
					if (performance.now() >= window.deadline) throw new Error("reset dispatch window expired");
					operation = await operations.reconcile(commandId, action, checked);
				}
				return operation;
			};
			const instance = async (checked: AbortSignal, expected: "Running" | "Stopped" | "absent") => {
				const record = await this.#client.getInstance(binding.project, name, checked);
				if (expected === "absent") {
					if (record !== undefined) throw new Error("reset root present");
					return;
				}
				if (!record || record.status !== expected || record.statusCode !== (expected === "Running" ? 103 : 102))
					throw new Error(`reset VM not ${expected.toLowerCase()}`);
				assertLxdOfficeGuestInstance(binding, record);
			};
			const settled = (state: "pending" | "unknown" | "failed"): LxdOfficeResetResult => ({
				...result,
				state,
				phase: current,
			});
			if (next === "powered_off") {
				const operation = await dispatch("powered_off", plan.commands.stopCommandId, "stop", async (checked) => {
					await instance(checked, "Running");
					if ((await inspectLxdOfficeGuestBoot(this.#client, binding, checked)).bootId !== recovery.startup.bootId)
						throw new Error("reset boot changed");
				});
				if (operation.state !== "succeeded") return settled(operation.state);
				return acknowledge(
					"powered_off",
					{
						commandId: plan.commands.stopCommandId,
						operationId: operation.operationId as string,
						instanceSha256: guest.instanceSha256,
					},
					async (caller) => {
						const checked = await guarded(caller);
						await instance(checked, "Stopped");
						const state = await this.#client.getInstanceState(binding.project, name, checked);
						if (state.status !== "Stopped" || state.statusCode !== 102) throw new Error("reset VM state differs");
						return checked;
					},
				);
			}
			if (next === "root_deleted") {
				const operation = await dispatch("root_deleted", plan.commands.deleteCommandId, "delete", (checked) =>
					instance(checked, "Stopped"),
				);
				if (operation.state !== "succeeded") return settled(operation.state);
				return acknowledge(
					"root_deleted",
					{ commandId: plan.commands.deleteCommandId, operationId: operation.operationId as string },
					async (caller) => {
						const checked = await guarded(caller);
						await instance(checked, "absent");
						return checked;
					},
				);
			}
			if (next === "root_created") {
				const operation = await dispatch("root_created", plan.commands.createCommandId, "create", (checked) =>
					instance(checked, "absent"),
				);
				if (operation.state !== "succeeded") return settled(operation.state);
				return acknowledge(
					"root_created",
					{
						commandId: plan.commands.createCommandId,
						operationId: operation.operationId as string,
						instanceSha256: guest.instanceSha256,
					},
					async (caller) => {
						const checked = await guarded(caller);
						await instance(checked, "Stopped");
						return checked;
					},
				);
			}
			if (next === "restored") {
				const operation = await dispatch("restored", plan.commands.startCommandId, "start", async (checked) => {
					await instance(checked, "Stopped");
					const node = await reserveLxdOfficeNodeMachine(this.#policy, binding, registry, checked);
					if (node.state === "refused") throw new Error(node.reason);
					node.signal.throwIfAborted();
				});
				if (operation.state !== "succeeded") return settled(operation.state);
				const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, await guarded(signal));
				if (
					boot.bootId === recovery.startup.bootId ||
					boot.bootId === seed.originalBootId ||
					boot.instanceSha256 !== guest.instanceSha256
				)
					throw new Error("reset boot not distinct");
				const receipt = await this.#restore(context, custody, sealed, nas.layoutSha256, boot.bootId);
				const retained = await optional(names.restore);
				if (retained === undefined) await retain(names.restore, receipt);
				else if (!isDeepStrictEqual(retained, receipt)) throw new Error("reset restore differs");
				return acknowledge("restored", receipt as unknown as Record<string, unknown>, async (caller) => {
					const checked = await guarded(caller);
					if (!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.#client, binding, checked), boot))
						throw new Error("reset boot changed");
					return checked;
				});
			}
			const restore = parseCompanyComputerResetRestoreReceipt(
				await optional(names.restore),
				custody,
				plan,
				context.status.custodySha256 as string,
			);
			if (context.status.restoreSha256 !== officeDigest(evidenceOf(plan, "restored", restore)))
				throw new Error("reset restore differs");
			const newBoot: Authorize = async (caller) => {
				const checked = await guarded(caller);
				const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, checked);
				if (boot.bootId !== restore.bootId || boot.instanceSha256 !== guest.instanceSha256)
					throw new Error("reset boot changed");
				return checked;
			};
			const lane: LxdOfficeResetSuccessorLaneContext = {
				intentId,
				plan,
				binding,
				bootId: restore.bootId,
				restoreSha256: context.status.restoreSha256 as string,
			};
			if (next === "prepared") return this.#prepare(context, lane, newBoot);
			return this.#activate(context, lane, newBoot);
		} finally {
			await nas.close();
		}
	}
	/** The original preparation identity is permanent and lives outside the
	 * root; a reset never reprepares. The adoption receipt digest recorded by
	 * preparation is the only receipt a reset successor may present. */
	async #preparation(root: string, allocationId: string): Promise<Preparation> {
		const file = await readRecord(
				join(root, `preparation-request-${allocationId}.json`),
				COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			),
			request = parseCompanyComputerPreparationRequest(file.value),
			observation = officeRecord(
				(await readRecord(join(root, `preparation-observation-${allocationId}.json`), 65536)).value,
				[
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
				],
			);
		const command = parseCompanyComputerPreparationCommand({
			commandId: observation.commandId,
			bootId: observation.bootId,
			requestSha256: observation.requestSha256,
		});
		if (
			observation.schema !== "qorpera.lxd-office-preparation-observation/v1" ||
			observation.allocationId !== allocationId ||
			command.requestSha256 !== hash(file.bytes) ||
			request.bootId !== command.bootId ||
			observation.adoptionReceiptPath !== "/etc/qorpera-office/adoption.json"
		)
			throw new Error("original preparation differs");
		return {
			request,
			command,
			bytes: file.bytes,
			adoptionReceiptSha256: officeSha(observation.adoptionReceiptSha256),
		};
	}
	/** Export the diagnostic outbox and public root history byte-for-byte into
	 * the provider-owned archive while the old root is still readable, then
	 * seal and independently reread it before SQL records the digests. */
	async #custody(
		context: Context,
		archive: LxdOfficeResetArchive,
		custodyBinding: CompanyComputerResetCustodyBinding,
		acknowledge: Acknowledge,
		oldBootRunning: Authorize,
	): Promise<LxdOfficeResetResult> {
		const { plan, seed, binding, name, names, optional, retain, operations, stopCommand, signal, result } = context,
			recovery = plan.predecessor;
		const nas = await (this.#ports.nasCustody ?? openLxdOfficeResetNasCustody)(
			this.#policy,
			context.preparation.request,
		);
		try {
			const retained = await optional(names.custody);
			if (retained !== undefined) {
				const record = officeRecord(retained, ["schema", "binding", "custody", "manifestSha256"]),
					manifest = parseCompanyComputerResetCustodyManifest(record.custody, plan),
					owner = officeRecord(record.binding, Object.keys(custodyBinding)),
					bound = {
						...custodyBinding,
						outboxUid: owner.outboxUid as number,
						outboxGid: owner.outboxGid as number,
					},
					sealed = await readLxdOfficeResetArchive(archive, plan, bound);
				if (
					!isDeepStrictEqual(record.binding, bound) ||
					sealed.manifestSha256 !== record.manifestSha256 ||
					!isDeepStrictEqual(sealed.manifest, manifest) ||
					manifest.nas.layoutSha256 !== nas.layoutSha256
				)
					throw new Error("reset archive differs");
				return acknowledge("custodied", manifest as unknown as Record<string, unknown>, async (caller) => {
					const checked = await oldBootRunning(caller);
					await nas.verify();
					return checked;
				});
			}
			// Sole-writer fence: the acknowledged stop proves the service and its
			// flush loop are gone; no other guest may hold the workbench device.
			const checked = await oldBootRunning(signal);
			const inventory = await this.#client.inspectHostInventory(checked);
			for (const instance of inventory.instances) {
				if (instance.project === binding.project && instance.name === name) continue;
				for (const device of Object.values(instance.expandedDevices))
					if (device.type === "disk" && device.source === binding.workbenchSource)
						throw new Error("reset workbench not exclusive");
			}
			const listing = await this.#client.listOfficeResetDirectory(
				binding.project,
				name,
				OFFICE_RESET_OUTBOX_ROOT,
				checked,
			);
			// Unresolved temporaries belong to the outbox's own single-writer
			// recovery; the reset never resolves or discards them.
			if (listing.some((entry) => entry.startsWith(".write-")))
				return { ...result, state: "held", phase: "stopped", reason: "OFFICE_RESET_OUTBOX_REMNANT" };
			if (
				!listing.includes("scope.json") ||
				listing.some((entry) => entry !== "scope.json" && !OUTBOX_RECORD.test(entry))
			)
				throw new Error("reset outbox inventory unsafe");
			const outboxFiles: { name: string; bytes: Buffer; uid: number; gid: number; mode: number }[] = [];
			for (const entry of listing) {
				const file = await this.#client.readOfficeResetFile(
					binding.project,
					name,
					`${OFFICE_RESET_OUTBOX_ROOT}/${entry}`,
					73729,
					checked,
				);
				const value = officeStopDecode(file.content);
				if (!Buffer.from(`${JSON.stringify(outboxCanonical(value))}\n`).equals(file.content))
					throw new Error("reset outbox record noncanonical");
				if (entry === "scope.json") {
					if (
						!isDeepStrictEqual(value, { schema: "qorpera.screen-outbox-scope/v1", scope: recovery.startup.scope })
					)
						throw new Error("reset outbox scope differs");
				} else {
					const record = value as {
							startup?: { scope?: unknown; allocationId?: unknown };
							event?: { lifetimeId?: unknown; sequence?: unknown };
						},
						match = OUTBOX_RECORD.exec(entry);
					if (
						!record.startup ||
						!isDeepStrictEqual(record.startup.scope, recovery.startup.scope) ||
						record.startup.allocationId !== recovery.startup.allocationId ||
						!record.event ||
						record.event.lifetimeId !== match?.[1] ||
						String(record.event.sequence).padStart(16, "0") !== match?.[2]
					)
						throw new Error("reset outbox record foreign");
				}
				outboxFiles.push({ name: entry, bytes: file.content, uid: file.uid, gid: file.gid, mode: file.mode });
			}
			const outboxUid = outboxFiles[0].uid,
				outboxGid = outboxFiles[0].gid;
			if (outboxFiles.some((file) => file.uid !== outboxUid || file.gid !== outboxGid || file.mode !== 0o600))
				throw new Error("reset outbox custody differs");
			const bound: CompanyComputerResetCustodyBinding = { ...custodyBinding, outboxUid, outboxGid };
			const outboxManifest = parseCompanyComputerResetOutboxManifest(
				{
					schema: "qorpera.office-reset-outbox/v1",
					binding: bound,
					files: outboxFiles.map((file) => ({
						name: file.name,
						bytes: file.bytes.length,
						sha256: hash(file.bytes),
						uid: outboxUid,
						gid: outboxGid,
						mode: 0o600,
					})),
					recordCount: outboxFiles.length - 1,
					totalBytes: outboxFiles.reduce((sum, file) => sum + file.bytes.length, 0),
				},
				bound,
			);
			// Public root history: the sealed stop archive and its referenced
			// persistent public records. Credentials are history bytes only.
			const historyRoot = `${OFFICE_RESET_HISTORY_ROOT}/${recovery.startup.bootId}/${recovery.activationId}`;
			const read = async (path: string, limit: number, mode: number) => {
				const file = await this.#client.readOfficeResetFile(binding.project, name, path, limit, checked);
				if (file.uid !== 0 || file.gid !== 0 || file.mode !== mode || file.content.length < 1)
					throw new Error("reset history custody");
				return file.content;
			};
			const manifestBytes = await read(`${historyRoot}/manifest.json`, 65536, 0o600),
				manifest = parseCompanyComputerStopHistoryManifest(
					officeStopDecode(manifestBytes),
					recovery.startup.bootId,
					recovery.activationId,
				);
			if (
				!isDeepStrictEqual(manifest.command, stopCommand) ||
				manifest.completionPath !== seed.completionPath ||
				!(await read(`${historyRoot}/claim.json`, 65536, 0o600)).equals(manifestBytes) ||
				!manifest.entries.some(
					(entry) => entry.path === seed.completionPath && entry.sha256 === seed.stopCompletionSha256,
				)
			)
				throw new Error("reset history binding differs");
			const historyFiles = new Map<string, { bytes: Buffer; mode: 0o400 | 0o444 | 0o600 }>();
			historyFiles.set(`${historyRoot}/manifest.json`, { bytes: manifestBytes, mode: 0o600 });
			historyFiles.set(`${historyRoot}/claim.json`, { bytes: Buffer.from(manifestBytes), mode: 0o600 });
			for (const entry of manifest.entries) {
				const blob = await read(`${historyRoot}/${entry.sha256}.json`, entry.bytes, 0o600);
				if (blob.length !== entry.bytes || hash(blob) !== entry.sha256)
					throw new Error("reset history blob differs");
				historyFiles.set(`${historyRoot}/${entry.sha256}.json`, { bytes: blob, mode: 0o600 });
				if (entry.path.startsWith("/etc/qorpera-office/")) {
					const current = await read(entry.path, entry.bytes, entry.mode);
					if (!current.equals(blob)) throw new Error("reset history source differs");
					historyFiles.set(entry.path, { bytes: current, mode: entry.mode as 0o400 | 0o444 | 0o600 });
				}
			}
			// A retained-boot stop archives that boot's adoption receipt. Reset
			// additionally preserves the permanent preparation receipt, whose
			// digest was pinned before begin; it is not new lifecycle authority.
			if (!historyFiles.has("/etc/qorpera-office/adoption.json"))
				historyFiles.set("/etc/qorpera-office/adoption.json", {
					bytes: await read("/etc/qorpera-office/adoption.json", 16384, 0o444),
					mode: 0o444,
				});
			const adoption = historyFiles.get("/etc/qorpera-office/adoption.json");
			if (!adoption || hash(adoption.bytes) !== seed.adoptionReceiptSha256)
				throw new Error("reset original receipt differs");
			const history = [...historyFiles.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([path, file]) => ({ path, bytes: file.bytes.length, sha256: hash(file.bytes), mode: file.mode }));
			const custody: CompanyComputerResetCustodyManifest = parseCompanyComputerResetCustodyManifest(
				{
					schema: "qorpera.office-reset-custody/v1",
					resetId: plan.resetId,
					rootIncarnationId: plan.rootIncarnationId,
					predecessorActivationId: recovery.activationId,
					outbox: {
						manifestSha256: hash(Buffer.from(officeCanonical(outboxManifest))),
						recordCount: outboxManifest.recordCount,
						totalBytes: outboxManifest.totalBytes,
					},
					history: {
						manifestSha256: hash(manifestBytes),
						files: history,
						totalBytes: history.reduce((sum, file) => sum + file.bytes, 0),
					},
					journalHeadSha256: (await operations.history()).journalHeadSha256,
					nas: {
						workbenchSource: binding.workbenchSource,
						adoptionId: nas.adoptionId,
						layoutSha256: nas.layoutSha256,
					},
				},
				plan,
			);
			await nas.verify();
			const blobs = new Map<string, Buffer>();
			for (const file of historyFiles.values()) blobs.set(hash(file.bytes), file.bytes);
			const sealed = await sealLxdOfficeResetArchive(
				archive,
				plan,
				bound,
				outboxManifest,
				outboxFiles.map((file) => ({ name: file.name, bytes: file.bytes })),
				[...blobs.entries()].map(([sha, bytes]) => ({ name: `${sha}.json`, bytes })),
				custody,
			);
			await retain(names.custody, {
				schema: "qorpera.lxd-office-reset-custody/v1",
				binding: bound,
				custody,
				manifestSha256: sealed.manifestSha256,
			});
			return acknowledge("custodied", custody as unknown as Record<string, unknown>, async (caller) => {
				const authorized = await oldBootRunning(caller);
				await nas.verify();
				if ((await readLxdOfficeResetArchive(archive, plan, bound)).manifestSha256 !== sealed.manifestSha256)
					throw new Error("reset archive changed");
				return authorized;
			});
		} finally {
			await nas.close();
		}
	}
	/** Restore only the allowlisted public evidence and the exact outbox bytes
	 * onto the fresh root, with the original ownership and modes, then read
	 * every file back. No credential, PID, service link or /run content is
	 * written; the restored records enter the existing outbox replay path. */
	async #restore(
		context: Context,
		custody: CompanyComputerResetCustodyManifest,
		sealed: Awaited<ReturnType<typeof readLxdOfficeResetArchive>>,
		layoutSha256: string,
		bootId: string,
	): Promise<CompanyComputerResetRestoreReceipt> {
		const { plan, seed, binding, name, signal } = context,
			project = binding.project,
			{ outboxUid, outboxGid } = sealed.outboxManifest.binding;
		const push = async (path: string, bytes: Buffer, uid: number, gid: number, mode: number) => {
			signal.throwIfAborted();
			let existing: Awaited<ReturnType<Client["readOfficeResetFile"]>> | undefined;
			try {
				existing = await this.#client.readOfficeResetFile(project, name, path, Math.max(bytes.length, 1), signal);
			} catch {
				existing = undefined;
			}
			if (!existing) {
				await this.#client.pushOfficeResetFile(project, name, path, bytes, uid, gid, mode, signal);
				existing = await this.#client.readOfficeResetFile(project, name, path, Math.max(bytes.length, 1), signal);
			}
			if (!existing.content.equals(bytes) || existing.uid !== uid || existing.gid !== gid || existing.mode !== mode)
				throw new Error("reset restore differs");
		};
		const directory = async (path: string, uid: number, gid: number) => {
			signal.throwIfAborted();
			try {
				await this.#client.listOfficeResetDirectory(project, name, path, signal);
			} catch {
				await this.#client.pushOfficeResetDirectory(project, name, path, uid, gid, 0o700, signal);
			}
		};
		await directory(OFFICE_RESET_OUTBOX_ROOT, outboxUid, outboxGid);
		const present = await this.#client.listOfficeResetDirectory(project, name, OFFICE_RESET_OUTBOX_ROOT, signal);
		if (present.some((entry) => !sealed.outbox.has(entry))) throw new Error("reset outbox destination occupied");
		for (const entry of sealed.outboxManifest.files) {
			const file = sealed.outbox.get(entry.name);
			if (!file) throw new Error("reset archive incomplete");
			await push(`${OFFICE_RESET_OUTBOX_ROOT}/${entry.name}`, file.bytes, outboxUid, outboxGid, 0o600);
		}
		const historyRoot = `${OFFICE_RESET_HISTORY_ROOT}/${plan.predecessor.startup.bootId}/${plan.predecessor.activationId}`;
		for (const path of [
			OFFICE_RESET_HISTORY_ROOT,
			`${OFFICE_RESET_HISTORY_ROOT}/${plan.predecessor.startup.bootId}`,
			historyRoot,
		])
			await directory(path, 0, 0);
		const restorable = custody.history.files.filter((file) => companyComputerResetRestorablePath(file.path));
		for (const entry of restorable) {
			const bytes = sealed.history.get(entry.sha256);
			if (!bytes) throw new Error("reset archive incomplete");
			await push(entry.path, bytes, 0, 0, entry.mode);
		}
		const adoption = restorable.find((file) => file.path === "/etc/qorpera-office/adoption.json");
		if (!adoption || adoption.sha256 !== seed.adoptionReceiptSha256)
			throw new Error("reset original receipt missing");
		const custodySha256 = officeDigest(evidenceOf(plan, "custodied", custody));
		return parseCompanyComputerResetRestoreReceipt(
			{
				schema: "qorpera.office-reset-restore/v1",
				resetId: plan.resetId,
				rootIncarnationId: plan.rootIncarnationId,
				custodySha256,
				bootId,
				outbox: {
					manifestSha256: custody.outbox.manifestSha256,
					fileCount: custody.outbox.recordCount + 1,
					totalBytes: custody.outbox.totalBytes,
				},
				history: {
					fileCount: restorable.length,
					totalBytes: restorable.reduce((sum, file) => sum + file.bytes, 0),
				},
				nas: { reattached: true, layoutSha256 },
				state: "restored",
			},
			custody,
			plan,
			custodySha256,
		);
	}
	/** The expected reset configuration completion on the fresh root, derived
	 * from the retained configuration command and configured file digests. */
	async #configured(context: Context, bootId: string) {
		const { plan, seed, preparation, names, optional } = context;
		const configuration = officeRecord(await optional(names.configuration), [
				"schema",
				"resetId",
				"bootId",
				"command",
				"serviceBootstrapSha256",
			]),
			command = parseCompanyComputerPreparationCommand(configuration.command),
			configured = officeRecord(await optional(names.configured), [
				"schema",
				"resetId",
				"bootId",
				"commandId",
				"files",
			]),
			files = configured.files as CompanyComputerResetConfigurationCompletion["files"];
		if (
			configuration.schema !== "qorpera.lxd-office-reset-configuration/v1" ||
			configuration.resetId !== plan.resetId ||
			configuration.bootId !== bootId ||
			command.bootId !== bootId ||
			configured.schema !== "qorpera.lxd-office-reset-configured/v1" ||
			configured.resetId !== plan.resetId ||
			configured.bootId !== bootId ||
			configured.commandId !== command.commandId
		)
			throw new Error("reset configured differs");
		const completion: CompanyComputerResetConfigurationCompletion = {
			schema: "qorpera.office-reset-configuration-completion/v1",
			command,
			resetId: plan.resetId,
			rootIncarnationId: plan.rootIncarnationId,
			activationId: plan.successorActivationId,
			originPreparationSha256: preparation.command.requestSha256,
			adoptionReceiptSha256: seed.adoptionReceiptSha256,
			files,
		};
		return { command, files, completion, serviceBootstrapSha256: officeSha(configuration.serviceBootstrapSha256) };
	}
	/** Fresh credentials through the existing protected authority path, one
	 * durable configuration command on the recreated root, then SQL successor
	 * preparation. The staged packet carries the permanent original preparation
	 * document; only the boot attestation is rebound to the fresh root. */
	async #prepare(
		context: Context,
		lane: LxdOfficeResetSuccessorLaneContext,
		newBoot: Authorize,
	): Promise<LxdOfficeResetResult> {
		const { input, plan, seed, binding, preparation, names, optional, retain, registry, journal, signal, result } =
				context,
			{ bootId } = lane;
		const payload = await createLxdOfficeResetConfigurationPayload(
			input.serviceBootstrapPath,
			binding,
			plan,
			{ ...preparation, request: preparation.request },
			bootId,
			signal,
			this.#ports,
		);
		try {
			if (preparation.request.bootId !== seed.originalBootId) throw new Error("reset configuration source differs");
			const requestSha256 = hash(payload.bytes);
			let commandValue = await optional(names.configuration);
			if (commandValue === undefined) {
				await newBoot(signal);
				commandValue = {
					schema: "qorpera.lxd-office-reset-configuration/v1",
					resetId: plan.resetId,
					bootId,
					command: { commandId: randomUUID(), bootId, requestSha256 },
					serviceBootstrapSha256: payload.serviceBootstrapSha256,
				};
				await retain(names.configuration, commandValue);
			}
			const configuration = officeRecord(commandValue, [
					"schema",
					"resetId",
					"bootId",
					"command",
					"serviceBootstrapSha256",
				]),
				command = parseCompanyComputerPreparationCommand(configuration.command);
			if (
				configuration.schema !== "qorpera.lxd-office-reset-configuration/v1" ||
				configuration.resetId !== plan.resetId ||
				configuration.bootId !== bootId ||
				command.bootId !== bootId ||
				command.requestSha256 !== requestSha256 ||
				configuration.serviceBootstrapSha256 !== payload.serviceBootstrapSha256 ||
				[
					plan.commands.stopCommandId,
					plan.commands.deleteCommandId,
					plan.commands.createCommandId,
					plan.commands.startCommandId,
					preparation.command.commandId,
				].includes(command.commandId)
			)
				throw new Error("reset configuration differs");
			const expected: CompanyComputerResetConfigurationCompletion = {
				schema: "qorpera.office-reset-configuration-completion/v1",
				command,
				resetId: plan.resetId,
				rootIncarnationId: plan.rootIncarnationId,
				activationId: plan.successorActivationId,
				originPreparationSha256: preparation.command.requestSha256,
				adoptionReceiptSha256: seed.adoptionReceiptSha256,
				files: payload.files,
			};
			let configuredValue = await optional(names.configured);
			if (configuredValue === undefined) {
				const files = await this.#lane.configure(
					{ ...lane, command, request: payload.bytes, expected },
					await newBoot(signal),
				);
				if (!isDeepStrictEqual(files, payload.files)) throw new Error("reset configured files differ");
				configuredValue = {
					schema: "qorpera.lxd-office-reset-configured/v1",
					resetId: plan.resetId,
					bootId,
					commandId: command.commandId,
					files,
				};
				await retain(names.configured, configuredValue);
			}
			const configured = await this.#configured(context, bootId);
			if (!isDeepStrictEqual(configured.completion, expected)) throw new Error("reset configured differs");
			const attestation: CompanyComputerActivationAttestation = {
				schema: "qorpera.office-activation-attestation/v1",
				activationId: plan.successorActivationId,
				bootId,
				preparationObservationSha256: seed.attestation.preparationObservationSha256,
				configurationObservationSha256: officeDigest({
					schema: "qorpera.lxd-office-reset-configuration-observation/v1",
					resetId: plan.resetId,
					bootId,
					commandId: command.commandId,
					files: configured.files,
					serviceBootstrapSha256: payload.serviceBootstrapSha256,
				}),
				configurationSha256: configured.files["config.json"].sha256,
				adoptionReceiptSha256: seed.adoptionReceiptSha256,
				nativePort: payload.plan.native.port,
				viewerPort: payload.plan.viewer.port,
			};
			const request = parseCompanyComputerResetSuccessorRequest({
				schema: "qorpera.office-reset-successor-request/v1",
				resetId: plan.resetId,
				rootIncarnationId: plan.rootIncarnationId,
				predecessor: plan.predecessor,
				attestation,
				custodySha256: context.status.custodySha256 as string,
				restoreSha256: context.status.restoreSha256 as string,
			});
			const seedValue = await optional(names.successor);
			if (seedValue === undefined) await retain(names.successor, request);
			else if (!isDeepStrictEqual(seedValue, request)) throw new Error("reset successor identity changed");
			const control = new LxdOfficeResetSuccessorControl(request, registry);
			let preparedValue = await optional(names.prepared);
			if (preparedValue === undefined) {
				preparedValue = await control.prepare(await newBoot(signal));
				await retain(names.prepared, preparedValue);
			}
			const prepared = parseCompanyComputerResetSuccessor(preparedValue, request);
			if (prepared.stopAcknowledgedAtMs !== context.status.stopAcknowledgedAtMs)
				throw new Error("reset prepared differs");
			await journal.advance("prepared", officeDigest(prepared));
			return { ...result, state: "progressed", phase: "prepared" };
		} finally {
			payload.bytes.fill(0);
		}
	}
	/** One ordinary service start, a fresh nonce inspection, readiness and
	 * SQL activation within one five-second window. The staged start packet is
	 * the prepared successor itself, whose canonical digest the retained start
	 * command already binds. */
	async #activate(
		context: Context,
		lane: LxdOfficeResetSuccessorLaneContext,
		newBoot: Authorize,
	): Promise<LxdOfficeResetResult> {
		const { plan, names, optional, retain, registry, journal, control, signal, result } = context,
			{ bootId } = lane;
		const request = parseCompanyComputerResetSuccessorRequest(await optional(names.successor)),
			prepared = parseCompanyComputerResetSuccessor(await optional(names.prepared), request);
		if (journal.evidenceSha256("prepared") !== officeDigest(prepared)) throw new Error("reset prepared differs");
		const configured = await this.#configured(context, bootId);
		if (
			configured.files["config.json"].sha256 !== request.attestation.configurationSha256 ||
			request.attestation.bootId !== bootId
		)
			throw new Error("reset configured differs");
		const successor = new LxdOfficeResetSuccessorControl(request, registry);
		let startValue = await optional(names.start);
		if (startValue === undefined) {
			startValue = {
				schema: "qorpera.lxd-office-reset-service-start/v1",
				resetId: plan.resetId,
				command: { commandId: randomUUID(), bootId, requestSha256: officeDigest(prepared) },
			};
			await retain(names.start, startValue);
		}
		const start = officeRecord(startValue, ["schema", "resetId", "command"]),
			command = parseCompanyComputerPreparationCommand(start.command);
		if (
			start.schema !== "qorpera.lxd-office-reset-service-start/v1" ||
			start.resetId !== plan.resetId ||
			command.bootId !== bootId ||
			command.requestSha256 !== officeDigest(prepared) ||
			command.commandId === configured.command.commandId
		)
			throw new Error("reset start differs");
		let startedValue = await optional(names.started);
		if (startedValue === undefined) {
			const authorized = await successor.check(await newBoot(signal));
			// A recorded invocation means a prior start reply was lost: the lane
			// may observe its own dispatched journal but never start again.
			const claimed = authorized.successor.state !== "prepared";
			const completion = await this.#lane.start(
				{ ...lane, command, configuration: configured.completion, successor: prepared, claimed },
				authorized.signal,
			);
			if (
				(claimed && authorized.successor.serviceInvocationId !== completion.serviceInvocationId) ||
				completion.serviceInvocationId === plan.predecessor.startup.serviceInvocationId ||
				completion.configurationSha256 !== request.attestation.configurationSha256
			)
				throw new Error("reset start completion differs");
			startedValue = {
				schema: "qorpera.lxd-office-reset-service-started/v1",
				resetId: plan.resetId,
				commandId: command.commandId,
				completion,
			};
			await retain(names.started, startedValue);
		}
		const started = officeRecord(startedValue, ["schema", "resetId", "commandId", "completion"]),
			completion = parseCompanyComputerResetServiceStartCompletion(started.completion, command, prepared),
			{ serviceInvocationId } = completion;
		if (
			started.schema !== "qorpera.lxd-office-reset-service-started/v1" ||
			started.commandId !== command.commandId ||
			started.resetId !== plan.resetId
		)
			throw new Error("reset started differs");
		const deadline = performance.now() + 5000,
			checked = await newBoot(signal);
		const inspection = await this.#lane.inspect({ ...lane, command, successor: prepared, completion }, checked);
		if (
			inspection.serviceInvocationId !== serviceInvocationId ||
			inspection.configurationSha256 !== completion.configurationSha256
		)
			throw new Error("reset invocation differs");
		const current = await successor.status(checked);
		if (current.serviceInvocationId !== null && current.serviceInvocationId !== serviceInvocationId)
			throw new Error("reset invocation differs");
		if (current.state === "prepared" || (current.state === "ready" && !current.readinessFresh))
			return { ...result, state: "awaiting_readiness", phase: "prepared" };
		if (current.state === "ready" && this.#ports.measureInvocation)
			await this.#ports.measureInvocation(
				plan.successorActivationId,
				parseCompanyComputerStartupIdentity({
					...plan.predecessor.startup,
					bootId,
					configurationSha256: completion.configurationSha256,
					serviceInvocationId,
				}),
				deadline,
				checked,
			);
		if (performance.now() >= deadline) throw new Error("reset activation window expired");
		const active: CompanyComputerResetSuccessor =
			current.state === "active" ? current : await successor.activate(serviceInvocationId, deadline, checked);
		if ((await control.status(checked)).phase !== "active") throw new Error("reset activation unconfirmed");
		const done = {
			schema: "qorpera.lxd-office-reset-completion/v1",
			resetId: plan.resetId,
			activationId: plan.successorActivationId,
			serviceInvocationId: active.serviceInvocationId,
		};
		if ((await optional(names.done)) === undefined) await retain(names.done, done);
		await journal.advance("active", officeDigest(done));
		return { ...result, state: "active", phase: "active", serviceInvocationId: active.serviceInvocationId as string };
	}
}
