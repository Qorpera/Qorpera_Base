import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceInspection,
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
} from "@qorpera/contracts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	publishCompanyComputerPreparationProtected,
	readCompanyComputerPreparationProtected,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import {
	companyComputerServiceRestartCompletionPath,
	companyComputerSuccessorClaim,
	companyComputerSuccessorClaimPath,
	readCompanyComputerInitialServiceInvocation,
	readCompanyComputerRestartPredecessor,
	readCompanyComputerServiceInvocation,
} from "./cloud-company-computer-service-invocation-evidence.ts";
import { assertCompanyComputerServiceRunning } from "./cloud-company-computer-service-start-control.ts";
import { readCompanyComputerServiceStartEvidence } from "./cloud-company-computer-service-start-evidence.ts";
import {
	type CompanyComputerServiceStartManager,
	createCompanyComputerServiceStartSystemdManager,
} from "./cloud-company-computer-service-start-systemd.ts";
import {
	assertCompanyComputerServiceStopped,
	type CompanyComputerServiceStopObservation,
	createCompanyComputerServiceStopSystemdManager,
} from "./cloud-company-computer-service-stop-systemd.ts";
import { readCompanyComputerStopHistory } from "./cloud-company-computer-stop-history.ts";

export interface CompanyComputerServiceRestartManager extends CompanyComputerServiceStartManager {
	inspectStopped(signal: AbortSignal): Promise<CompanyComputerServiceStopObservation>;
}
export function createCompanyComputerServiceRestartSystemdManager(): CompanyComputerServiceRestartManager {
	const start = createCompanyComputerServiceStartSystemdManager(),
		stop = createCompanyComputerServiceStopSystemdManager();
	return { ...start, inspectStopped: (signal) => stop.inspect(signal) };
}
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const json = (value: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(value));
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
async function requireAbsent(path: string) {
	try {
		await lstat(path);
	} catch (error) {
		if (missing(error)) return;
		throw error;
	}
	throw new Error("invocation superseded or stopping");
}
let pending = false;
/** One explicit same-boot successor under the existing kernel flock. Original
 * claims never move or disappear. Each predecessor has one immutable child
 * claim; a surviving claim can observe but cannot repeat a start. Incoming
 * metadata must be staged by the provider after SQL successor preparation.
 * This helper opens no admission: guest readiness and fresh provider inspection
 * must still precede SQL activation. */
export async function controlCompanyComputerServiceRestart(
	value: unknown,
	manager: CompanyComputerServiceRestartManager,
	signal: AbortSignal,
	inspectionId?: string,
) {
	if (pending) throw new Error("OFFICE_SERVICE_RESTART_PENDING");
	pending = true;
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
		const retain = async (path: string, limit: number, mode: number) => {
			signal.throwIfAborted();
			const bytes = await readCompanyComputerPreparationProtected(path, limit, mode);
			evidence.push({ path, bytes, mode });
			return bytes;
		};
		const staged = await retain(
			`${root}/service-restart-incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES,
			0o400,
		);
		if (hash(staged) !== command.requestSha256) throw new Error("request changed");
		const request = parseCompanyComputerServiceRestartRequest(json(staged));
		const initial = await readCompanyComputerInitialServiceInvocation(retain);
		const prior = await readCompanyComputerServiceInvocation(request.stop.revocation.request.activationId, retain);
		const stopped = await readCompanyComputerRestartPredecessor(request, retain, initial);
		const archive = await readCompanyComputerStopHistory(command.bootId, prior.start.activationId);
		if (
			!isDeepStrictEqual(archive.manifest.command, stopped.command) ||
			archive.manifest.completionPath !== prior.stopPaths.completion ||
			hash(archive.files.get(prior.stopPaths.completion)!) !== request.stopCompletionSha256
		)
			throw new Error("archived predecessor differs");
		if (
			command.bootId !== request.start.attestation.bootId ||
			[
				initial.start.command.commandId,
				prior.start.command.commandId,
				stopped.command.commandId,
				request.start.configuration.command.commandId,
				request.start.configuration.preparation.commandId,
			].includes(command.commandId)
		)
			throw new Error("command reused or boot differs");
		const activationId = request.start.attestation.activationId;
		const claimPath = companyComputerSuccessorClaimPath(prior.start.activationId),
			completionPath = companyComputerServiceRestartCompletionPath(activationId);
		const claimBytes = encode(companyComputerSuccessorClaim(command, request));
		const material = await readCompanyComputerServiceStartEvidence(command, request.start, signal);
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			await requireAbsent(`${root}/service-stop-claim-${activationId}.json`);
			await requireAbsent(companyComputerSuccessorClaimPath(activationId));
			if (
				(await readCompanyComputerStopHistory(command.bootId, prior.start.activationId)).manifestSha256 !==
				archive.manifestSha256
			)
				throw new Error("archived predecessor changed");
			for (const { path, bytes, mode } of evidence)
				if (!(await readCompanyComputerPreparationProtected(path, bytes.length, mode)).equals(bytes))
					throw new Error("history changed");
			await material.verify();
			const observed = await manager.inspect(signal);
			if (!isDeepStrictEqual(observed.preparation, material.preparation)) throw new Error("preparation changed");
			signal.throwIfAborted();
			return observed.service;
		};
		const optional = async (path: string) => {
			try {
				return await readCompanyComputerPreparationProtected(path, 8192, 0o600);
			} catch (error) {
				if (!missing(error)) throw error;
				return undefined;
			}
		};
		const claimed = await optional(claimPath),
			completed = await optional(completionPath);
		if (claimed && !claimed.equals(claimBytes)) throw new Error("predecessor already claimed");
		if (completed && !claimed) throw new Error("claim missing");
		if (inspectionId !== undefined && (!claimed || !completed)) throw new Error("completed successor required");
		if (claimed) evidence.push({ path: claimPath, bytes: claimed, mode: 0o600 });
		if (completed) evidence.push({ path: completionPath, bytes: completed, mode: 0o600 });
		let state = await verify();
		const confirmStopped = async () => {
			const observed = await manager.inspectStopped(signal);
			assertCompanyComputerServiceStopped(observed);
			if (
				!isDeepStrictEqual(observed.service, state) ||
				(observed.service.invocationId && observed.service.invocationId !== stopped.stoppedInvocationId)
			)
				throw new Error("predecessor no longer stopped");
			if (!isDeepStrictEqual(await verify(), state)) throw new Error("predecessor changed");
		};
		if (!claimed) {
			await confirmStopped();
			await publishCompanyComputerPreparationProtected(claimPath, claimBytes, 0o600);
			evidence.push({ path: claimPath, bytes: claimBytes, mode: 0o600 });
			await confirmStopped();
			signal.throwIfAborted();
			await manager.start(signal);
			state = await verify();
		}
		assertCompanyComputerServiceRunning(state);
		const result = parseCompanyComputerServiceRestartCompletion(
			{
				schema: "qorpera.office-service-start-completion/v1",
				command,
				activationId,
				configurationCompletionSha256: request.start.configurationCompletionSha256,
				configurationSha256: request.start.attestation.configurationSha256,
				serviceInvocationId: state.invocationId,
				mainPid: state.mainPid,
				controlGroup: state.controlGroup,
			},
			command,
			request,
		);
		const bytes = encode(result);
		if (completed && !completed.equals(bytes)) throw new Error("completed invocation changed");
		if (!isDeepStrictEqual(await verify(), state)) throw new Error("invocation changed during confirmation");
		signal.throwIfAborted();
		if (inspectionId === undefined) {
			await publishCompanyComputerPreparationProtected(completionPath, bytes, 0o600);
			return result;
		}
		const inspection = parseCompanyComputerServiceInspection(
			{ schema: "qorpera.office-service-inspection/v1", inspectionId, start: result },
			inspectionId,
			result,
			request.start,
		);
		await publishCompanyComputerPreparationProtected(
			`${root}/service-restart-inspection-${inspectionId}.json`,
			encode(inspection),
			0o600,
		);
		return inspection;
	} catch {
		throw new Error("OFFICE_SERVICE_RESTART_UNCONFIRMED");
	} finally {
		pending = false;
	}
}
