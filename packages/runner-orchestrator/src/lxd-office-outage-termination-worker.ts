import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	companyComputerOutageTerminationAcknowledgementCanonical,
	parseCompanyComputerOutageTerminationAcknowledgement,
	parseCompanyComputerOutageTerminationChallenge,
	parseCompanyComputerOutageTerminationInspection,
	parseCompanyComputerOutageTerminationRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import type { PaidComputerGuardRecord } from "./computer-paid-guard.ts";
import type { LxdOfficeOutageTerminationClient } from "./lxd-client.ts";
import { LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeRecord } from "./lxd-office-image-provenance.ts";
import { readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { readOptionalOutageRecord, retainOutageRecord } from "./lxd-office-outage-history.ts";
import {
	LxdOfficeOutageRecoveryControl,
	type LxdOfficeOutageRecoveryRegistry,
	trackLxdOfficeOutageRegistry,
} from "./lxd-office-outage-recovery-control.ts";
import type { LxdOfficeOutageResumeWorker } from "./lxd-office-outage-resume-worker.ts";

const pending = new Set<string>();
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export type LxdOfficeOutageTerminationPort = Pick<
	LxdOfficeOutageTerminationClient,
	| "getInstance"
	| "readInstanceFile"
	| "submitInstanceOperation"
	| "inspectInstanceOperation"
	| "submitOfficeOutageTermination"
	| "inspectOfficeOutageTermination"
	| "pushOfficeOutageTerminationRequest"
	| "readOfficeOutageTerminationRequest"
>;

/** Each short-lived challenge gets a distinct read-only attempt. A retained
 * inspection is acknowledged again before requesting fresh authority. */
export class LxdOfficeOutageTerminationWorker {
	readonly resume: LxdOfficeOutageResumeWorker;
	readonly client: LxdOfficeOutageTerminationPort;
	constructor(resume: LxdOfficeOutageResumeWorker, client: LxdOfficeOutageTerminationPort) {
		this.resume = resume;
		this.client = client;
	}
	async reconcile(intentId: string, guard: PaidComputerGuardRecord, caller: AbortSignal) {
		const root = this.resume.gate.policy.journal.path;
		caller.throwIfAborted();
		if (pending.has(root)) throw new Error("OFFICE_OUTAGE_TERMINATION_PENDING");
		pending.add(root);
		const tracked = trackLxdOfficeOutageRegistry(this.resume.registry);
		try {
			return await this.#run(
				intentId,
				guard,
				AbortSignal.any([caller, AbortSignal.timeout(60000)]),
				tracked.registry,
			);
		} finally {
			await tracked.settle();
			pending.delete(root);
		}
	}
	async #run(
		intentId: string,
		guard: PaidComputerGuardRecord,
		signal: AbortSignal,
		registry: LxdOfficeOutageRecoveryRegistry,
	) {
		const resumed = await this.resume.reconcile(intentId, guard, signal);
		if (resumed.state !== "awaiting_termination") return resumed;
		const { recovery, observation, bootObservationSha256, request: base } = resumed,
			root = this.resume.gate.policy.journal.path,
			creation = await openLxdOfficeCreationIdentity(this.resume.gate.policy, intentId, true, this.client, signal),
			{ binding } = creation,
			plan = lxdOfficeGuestPlan(binding),
			suffix = `${binding.allocationId}-${base.recoveryId}`,
			prefix = `outage-inspection-${suffix}-`,
			acknowledgementName = `outage-termination-acknowledgement-${suffix}.json`;
		const control = new LxdOfficeOutageRecoveryControl(base, registry);
		const authorize = async () => {
			const physical = await this.resume.gate.check(binding, signal);
			if (physical.hostBootId !== observation.hostBootId) throw new Error("OFFICE_OUTAGE_HOST_BOOT_CHANGED");
			const checked = AbortSignal.any([signal, physical.signal]),
				instance = await this.client.getInstance(binding.project, plan.request.name, checked);
			if (
				instance?.config["volatile.uuid"] !== observation.physicalInstanceId ||
				instance.expandedConfig["volatile.uuid"] !== observation.physicalInstanceId
			)
				throw new Error("OFFICE_OUTAGE_PHYSICAL_INSTANCE_CHANGED");
			await this.resume.ports.paidComputer.assertActive(binding, checked);
			const cloud = await control.check(checked);
			if (
				!isDeepStrictEqual(cloud.recovery, recovery) ||
				!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.client, binding, cloud.signal), {
					bootId: observation.bootId,
					instanceSha256: observation.instanceSha256,
				})
			)
				throw new Error("OFFICE_OUTAGE_TERMINATION_AUTHORITY_CHANGED");
			cloud.signal.throwIfAborted();
			return cloud.signal;
		};
		const originalFile = await readRecord(
				join(root, `preparation-request-${binding.allocationId}.json`),
				COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			),
			original = parseCompanyComputerPreparationRequest(originalFile.value),
			originPreparationSha256 = hash(originalFile.bytes);
		if (original.allocationId !== binding.allocationId) throw new Error("OFFICE_OUTAGE_ORIGINAL_PREPARATION_MISSING");
		const names = (await readdir(root)).filter((name) => name.startsWith(prefix)).sort();
		if (names.length > 64 || names.some((name, index) => name !== `${prefix}${String(index).padStart(3, "0")}`))
			throw new Error("OFFICE_OUTAGE_INSPECTION_HISTORY_INVALID");
		const result = (acknowledgement: ReturnType<typeof parseCompanyComputerOutageTerminationAcknowledgement>) => ({
			...resumed,
			state: "awaiting_configuration" as const,
			termination: acknowledgement,
			terminationSha256: hash(companyComputerOutageTerminationAcknowledgementCanonical(acknowledgement)),
		});
		const savedAck = await readOptionalOutageRecord(root, acknowledgementName);
		for (const name of names) {
			const attemptRoot = join(root, name),
				seed = officeRecord((await readRecord(join(attemptRoot, "seed.json"))).value, [
					"recovery",
					"inspectionId",
					"commandId",
					"observation",
					"bootObservationSha256",
				]);
			if (
				!isDeepStrictEqual(seed.recovery, base) ||
				!isDeepStrictEqual(seed.observation, observation) ||
				seed.bootObservationSha256 !== bootObservationSha256
			)
				throw new Error("OFFICE_OUTAGE_TERMINATION_SEED_CHANGED");
			const savedInspection = await readOptionalOutageRecord(attemptRoot, "inspection.json");
			if (savedInspection === undefined) continue;
			const packet = officeRecord(await readOptionalOutageRecord(attemptRoot, "packet.json"), [
					"command",
					"request",
				]),
				request = parseCompanyComputerOutageTerminationRequest(packet.request),
				command = parseCompanyComputerPreparationCommand(packet.command),
				inspection = parseCompanyComputerOutageTerminationInspection(savedInspection, command, request);
			if (
				request.challenge.request.inspectionId !== seed.inspectionId ||
				command.commandId !== seed.commandId ||
				command.requestSha256 !== hash(officeCanonical(request)) ||
				request.originPreparationSha256 !== originPreparationSha256 ||
				!isDeepStrictEqual(request.challenge.recovery, recovery)
			)
				throw new Error("OFFICE_OUTAGE_INSPECTION_PREFIX_CHANGED");
			const ackRequest = { recovery: base, inspection };
			if (savedAck !== undefined) {
				const parsed = parseCompanyComputerOutageTerminationAcknowledgement(savedAck);
				if (parsed.request.inspection.inspectionId === inspection.inspectionId)
					return result(parseCompanyComputerOutageTerminationAcknowledgement(savedAck, ackRequest));
				continue;
			}
			try {
				const ack = parseCompanyComputerOutageTerminationAcknowledgement(
					await registry.call("qorpera_ack_runtime_office_outage_termination", { p_request: ackRequest }, signal),
					ackRequest,
				);
				await retainOutageRecord(root, acknowledgementName, ack);
				return result(ack);
			} catch {
				// Positive live authority alone permits a fresh attempt. A lost
				// committed ACK consumes it and remains retryable with this proof.
				await authorize();
			}
		}
		if (savedAck !== undefined) throw new Error("OFFICE_OUTAGE_ACK_PREFIX_LOST");
		if (names.length === 64) throw new Error("OFFICE_OUTAGE_INSPECTION_BUDGET_EXHAUSTED");
		await authorize();
		const attemptRoot = join(root, `${prefix}${String(names.length).padStart(3, "0")}`),
			inspectionId = randomUUID(),
			commandId = randomUUID(),
			challengeRequest = { recovery: base, inspectionId, observation, bootObservationSha256 };
		await mkdir(attemptRoot, { mode: 0o700 });
		await syncDirectory(root);
		await retainOutageRecord(attemptRoot, "seed.json", { ...challengeRequest, commandId });
		const fresh = await authorize(),
			started = performance.now(),
			challenge = parseCompanyComputerOutageTerminationChallenge(
				await registry.call(
					"qorpera_prepare_runtime_office_outage_termination",
					{ p_request: challengeRequest },
					fresh,
				),
				challengeRequest,
			),
			remaining = Math.floor(challenge.validForMs - (performance.now() - started));
		if (remaining < 1) throw new Error("OFFICE_OUTAGE_TERMINATION_CHALLENGE_EXPIRED");
		const checked = AbortSignal.any([fresh, AbortSignal.timeout(remaining)]),
			request = parseCompanyComputerOutageTerminationRequest({
				schema: "qorpera.office-outage-termination-request/v1",
				challenge,
				originPreparationSha256,
			}),
			payload = Buffer.from(officeCanonical(request)),
			command = parseCompanyComputerPreparationCommand({
				commandId,
				requestSha256: hash(payload),
				bootId: observation.bootId,
			});
		await retainOutageRecord(attemptRoot, "packet.json", { command, request });
		const journal = await LxdOfficeControlJournal.open(
			attemptRoot,
			{
				intentId,
				binding,
				recoveryId: base.recoveryId,
				activationId: base.activationId,
				bootObservationSha256,
				command,
				originPreparationSha256,
			},
			{
				submit: this.client.submitOfficeOutageTermination.bind(this.client),
				inspect: this.client.inspectOfficeOutageTermination.bind(this.client),
			},
			false,
			"outage-termination",
		);
		await this.client.pushOfficeOutageTerminationRequest(
			binding.project,
			plan.request.name,
			command.requestSha256,
			payload,
			checked,
		);
		const staged = await this.client.readOfficeOutageTerminationRequest(
			binding.project,
			plan.request.name,
			command.requestSha256,
			payload.length,
			checked,
		);
		if (staged.uid !== 0 || staged.gid !== 0 || staged.mode !== 0o400 || !staged.content.equals(payload))
			throw new Error("OFFICE_OUTAGE_TERMINATION_STAGE_CHANGED");
		const operation = await journal.reconcile(checked);
		if (operation.state === "failed" || operation.state === "pending") return { ...resumed, state: operation.state };
		const file = await this.client.readInstanceFile(
			binding.project,
			plan.request.name,
			`/run/qorpera-office-preparation/outage-termination-inspection-${inspectionId}.json`,
			65536,
			checked,
		);
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o600)
			throw new Error("OFFICE_OUTAGE_TERMINATION_CUSTODY_INVALID");
		const inspection = parseCompanyComputerOutageTerminationInspection(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)),
			command,
			request,
		);
		if (inspection.bootObservationSha256 !== bootObservationSha256)
			throw new Error("OFFICE_OUTAGE_TERMINATION_OBSERVATION_CHANGED");
		await retainOutageRecord(attemptRoot, "inspection.json", inspection);
		checked.throwIfAborted();
		const ackRequest = { recovery: base, inspection },
			acknowledgement = parseCompanyComputerOutageTerminationAcknowledgement(
				await registry.call("qorpera_ack_runtime_office_outage_termination", { p_request: ackRequest }, checked),
				ackRequest,
			);
		await retainOutageRecord(root, acknowledgementName, acknowledgement);
		return result(acknowledgement);
	}
}
