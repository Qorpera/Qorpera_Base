import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_SERVICE_CGROUP,
	COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopInspection,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	publishCompanyComputerPreparationProtected,
	readCompanyComputerPreparationProtected,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import { parseCompanyComputerServiceConfig } from "./cloud-company-computer-service-config.ts";
import { publishCompanyComputerFoldersLeft } from "./cloud-company-computer-service-stop-folders.ts";
import {
	assertCompanyComputerServiceStopped,
	type CompanyComputerServiceStopManager,
} from "./cloud-company-computer-service-stop-systemd.ts";
import {
	assertCompanyComputerStopHistoryAbsent,
	readCompanyComputerStopHistory,
	sealCompanyComputerStopHistory,
} from "./cloud-company-computer-stop-history.ts";
import { readCompanyComputerStopInvocation } from "./cloud-company-computer-stop-invocation.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const invocation = (value: unknown) =>
	value === null || (typeof value === "string" && /^(?!0{32}$)[0-9a-f]{32}$/.test(value));
let pending = false;

/** A stop control's run, from its start (`cloud-company-computer-service-stop-control-main.ts`). */
export const COMPANY_COMPUTER_SERVICE_STOP_CONTROL_MS = 100000;
/** What a run keeps after the mounts the office service left, to seal its history and write its completion. */
const SEAL_MS = 5000;

/** Trusted provider-to-root stop, after SQL revocation. Protected incoming
 * data is supplied only by the owning provider; its bytes are not a signature
 * or a guest-callable SQL capability. No workbench tree is read or rewritten.
 * A durable claim precedes systemctl. Retained claims allow observation only,
 * never another stop dispatch after uncertainty. Once the service is stopped,
 * the mounts it left are published (`foldersLeft`) before the completion is
 * written; a run that fails there writes none, and its replay asks again. */
export async function controlCompanyComputerServiceStop(
	value: unknown,
	manager: CompanyComputerServiceStopManager,
	signal: AbortSignal,
	inspectionId?: string,
	foldersLeft: (signal: AbortSignal, until: number) => Promise<void> = publishCompanyComputerFoldersLeft,
) {
	if (pending) throw new Error("OFFICE_SERVICE_STOP_PENDING");
	pending = true;
	const until = performance.now() + COMPANY_COMPUTER_SERVICE_STOP_CONTROL_MS - SEAL_MS;
	const buffers: Buffer[] = [];
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		if (
			inspectionId !== undefined &&
			parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId }).commandId === command.commandId
		)
			throw new Error("inspection identity");
		await assertCompanyComputerPreparationLockAndBoot(command);
		const evidence: Array<{ path: string; bytes: Buffer; mode: number }> = [];
		const absent: Array<{ path: string; limit: number; mode: number }> = [];
		const retain = async (path: string, limit: number, mode: number) => {
			const bytes = await readCompanyComputerPreparationProtected(path, limit, mode).catch((error) => {
				if (missing(error)) absent.push({ path, limit, mode });
				throw error;
			});
			buffers.push(bytes);
			evidence.push({ path, bytes, mode });
			return bytes;
		};
		const staged = await retain(
			`${root}/service-stop-incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES,
			0o400,
		);
		if (hash(staged) !== command.requestSha256) throw new Error("request changed");
		const request = parseCompanyComputerServiceStopRequest(decode(staged)),
			revocation = request.revocation;
		if (command.bootId !== revocation.request.startup.bootId) throw new Error("boot differs");
		const prior = await readCompanyComputerStopInvocation(revocation.request.activationId, command.bootId, retain);
		if (hash(prior.bytes) !== request.startCompletionSha256) throw new Error("prior completion changed");
		const start = prior.start,
			priorCommand = start.command;
		const claimPath = prior.stopPaths.claim,
			completionPath = prior.stopPaths.completion;
		if (
			command.commandId === priorCommand.commandId ||
			command.bootId !== priorCommand.bootId ||
			start.serviceInvocationId !== revocation.request.startup.serviceInvocationId ||
			prior.configurationCommands.some((item) => item.commandId === command.commandId)
		)
			throw new Error("prior activation differs");
		const configBytes = await retain(
			prior.configurationPath,
			COMPANY_COMPUTER_CONFIGURATION_LIMITS.configuration,
			0o400,
		);
		const config = parseCompanyComputerServiceConfig(configBytes.toString("utf8"));
		if (
			hash(configBytes) !== start.configurationSha256 ||
			config.linux.attestation.adoptionReceiptPath !== prior.adoptionPath ||
			!isDeepStrictEqual(revocation.request.startup, {
				scope: config.scope,
				computerGeneration: config.computerGeneration,
				allocationId: config.linux.attestation.allocationId,
				instanceSha256: config.linux.attestation.instanceSha256,
				imageSha256: config.linux.attestation.imageSha256,
				bootstrapSha256: config.linux.attestation.bootstrapSha256,
				bootId: config.linux.attestation.bootId,
				configurationSha256: hash(configBytes),
				serviceInvocationId: start.serviceInvocationId,
			})
		)
			throw new Error("configured guest differs");
		const adoption = await retain(prior.adoptionPath, 65536, 0o444);
		if (
			hash(adoption) !== config.linux.attestation.adoptionReceiptSha256 ||
			hash(adoption) !== prior.attestation.adoptionReceiptSha256
		)
			throw new Error("adoption differs");
		const verifyEvidence = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			for (const { path, limit, mode } of absent) {
				try {
					const current = await readCompanyComputerPreparationProtected(path, limit, mode);
					current.fill(0);
					throw new Error("ambiguous evidence appeared");
				} catch (error) {
					if (!missing(error)) throw error;
				}
			}
			for (const { path, bytes, mode } of evidence) {
				const current = await readCompanyComputerPreparationProtected(path, bytes.length, mode);
				try {
					if (!current.equals(bytes)) throw new Error("evidence changed");
				} finally {
					current.fill(0);
				}
			}
			signal.throwIfAborted();
		};
		const verify = async () => {
			await verifyEvidence();
			const result = await manager.inspect(signal);
			await verifyEvidence();
			return result;
		};
		const optional = async (path: string) => {
			try {
				return await readCompanyComputerPreparationProtected(path, 8192, 0o600);
			} catch (e) {
				if (!missing(e)) throw e;
				return undefined;
			}
		};
		let claimBytes = await optional(claimPath);
		const completionBytes = await optional(completionPath);
		if (completionBytes) evidence.push({ path: completionPath, bytes: completionBytes, mode: 0o600 });
		if (completionBytes && !claimBytes) throw new Error("claim missing");
		if (inspectionId !== undefined && (!completionBytes || !claimBytes)) throw new Error("completed stop required");
		let observed = await verify();
		if (!claimBytes) {
			await assertCompanyComputerStopHistoryAbsent(command.bootId, revocation.request.activationId);
			const claim = {
				schema: "qorpera.office-service-stop-claim/v1",
				command,
				transitionId: revocation.request.transitionId,
				observedInvocationId: observed.service.invocationId || null,
				observedRestarts: observed.service.restarts,
			};
			claimBytes = encode(claim);
			await publishCompanyComputerPreparationProtected(claimPath, claimBytes, 0o600);
			evidence.push({ path: claimPath, bytes: claimBytes, mode: 0o600 });
			await verify();
			signal.throwIfAborted();
			await manager.stop(signal);
			observed = await verify();
		} else evidence.push({ path: claimPath, bytes: claimBytes, mode: 0o600 });
		const claim = decode(claimBytes) as Record<string, unknown>;
		if (
			!claim ||
			Object.keys(claim).sort().join() !== "command,observedInvocationId,observedRestarts,schema,transitionId" ||
			claim.schema !== "qorpera.office-service-stop-claim/v1" ||
			!isDeepStrictEqual(claim.command, command) ||
			claim.transitionId !== revocation.request.transitionId ||
			!invocation(claim.observedInvocationId) ||
			!Number.isSafeInteger(claim.observedRestarts) ||
			(claim.observedRestarts as number) < 0 ||
			(claim.observedRestarts as number) > 2147483647
		)
			throw new Error("claim differs");
		assertCompanyComputerServiceStopped(observed);
		// A crash can leave sealed root-disk history before /run completion is
		// published. Recover that exact result under the original boot/claim.
		let archivedCompletion: Buffer | undefined;
		if (!completionBytes) {
			try {
				const archived = await readCompanyComputerStopHistory(command.bootId, revocation.request.activationId);
				if (
					!isDeepStrictEqual(archived.manifest.command, command) ||
					archived.manifest.completionPath !== completionPath
				)
					throw new Error("archived stop differs");
				archivedCompletion = archived.files.get(completionPath)!;
			} catch (error) {
				if (!missing(error)) throw error;
			}
		}
		const retainedCompletion = completionBytes ?? archivedCompletion;
		// A retained or archived completion was written after its run published the mounts left; an inspection has one.
		if (!retainedCompletion) await foldersLeft(signal, until);
		const result = retainedCompletion
			? parseCompanyComputerServiceStopCompletion(decode(retainedCompletion), command, request)
			: parseCompanyComputerServiceStopCompletion(
					{
						schema: "qorpera.office-service-stop-completion/v1",
						command,
						transitionId: revocation.request.transitionId,
						activationId: revocation.request.activationId,
						revocationRevision: revocation.revocationRevision,
						configurationSha256: start.configurationSha256,
						startCompletionSha256: request.startCompletionSha256,
						fromServiceInvocationId: start.serviceInvocationId,
						observedInvocationId: claim.observedInvocationId,
						stoppedInvocationId: observed.service.invocationId || null,
						controlGroup: COMPANY_COMPUTER_SERVICE_CGROUP,
						cgroupState: observed.cgroupState,
					},
					command,
					request,
				);
		if (
			result.observedInvocationId !== claim.observedInvocationId ||
			(observed.service.invocationId && observed.service.invocationId !== result.stoppedInvocationId)
		)
			throw new Error("stopped invocation changed");
		const final = await verify();
		assertCompanyComputerServiceStopped(final);
		if (final.service.invocationId && final.service.invocationId !== result.stoppedInvocationId)
			throw new Error("new invocation");
		signal.throwIfAborted();
		await sealCompanyComputerStopHistory(
			command,
			revocation.request.activationId,
			completionPath,
			[...evidence, { path: completionPath, bytes: encode(result), mode: 0o600 }],
			async () => {
				const current = await verify();
				assertCompanyComputerServiceStopped(current);
				if (current.service.invocationId && current.service.invocationId !== result.stoppedInvocationId)
					throw new Error("history invocation changed");
			},
			signal,
			inspectionId !== undefined || completionBytes !== undefined,
		);
		if (inspectionId === undefined) {
			await publishCompanyComputerPreparationProtected(completionPath, encode(result), 0o600);
			return result;
		}
		const inspection = parseCompanyComputerServiceStopInspection(
			{
				schema: "qorpera.office-service-stop-inspection/v1",
				inspectionId,
				stop: result,
				cgroupState: final.cgroupState,
			},
			inspectionId,
			result,
			request,
		);
		await publishCompanyComputerPreparationProtected(
			`${root}/service-stop-inspection-${inspectionId}.json`,
			encode(inspection),
			0o600,
		);
		return inspection;
	} catch {
		throw new Error("OFFICE_SERVICE_STOP_UNCONFIRMED");
	} finally {
		for (const buffer of buffers) buffer.fill(0);
		pending = false;
	}
}
