import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_RESET_SERVICE_RESTART_MAX_BYTES,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerResetServiceRestartCompletion,
	parseCompanyComputerResetServiceRestartInspection,
	parseCompanyComputerResetServiceRestartRequest,
} from "@qorpera/contracts";
import { readCompanyComputerAcknowledgedStop } from "./cloud-company-computer-acknowledged-stop.ts";
import {
	type CompanyComputerBootServiceStartManager,
	createCompanyComputerBootServiceStartSystemdManager,
} from "./cloud-company-computer-boot-service-start-control.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	publishCompanyComputerPreparationProtected as publish,
	readCompanyComputerPreparationProtected as read,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import {
	companyComputerResetServiceRestartCompletionPath,
	companyComputerResetSuccessorClaim,
	readCompanyComputerResetServiceInvocation,
} from "./cloud-company-computer-reset-invocation-evidence.ts";
import { readCompanyComputerResetRetainedEvidence } from "./cloud-company-computer-reset-successor-evidence.ts";
import { companyComputerSuccessorClaimPath } from "./cloud-company-computer-service-invocation-evidence.ts";
import { assertCompanyComputerServiceRunning } from "./cloud-company-computer-service-start-control.ts";
import { assertCompanyComputerServiceStopped } from "./cloud-company-computer-service-stop-systemd.ts";
import { readCompanyComputerStopHistory } from "./cloud-company-computer-stop-history.ts";

export const createCompanyComputerResetServiceRestartSystemdManager =
	createCompanyComputerBootServiceStartSystemdManager;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const inactive = {
	invocationId: "",
	activeState: "inactive",
	subState: "dead",
	result: "success",
	mainPid: 0,
	controlPid: 0,
	jobId: 0,
	execMainCode: 0,
	execMainStatus: 0,
};
let pending = false;
/** Root-only same-boot restart following an acknowledged recreated-root stop.
 * One immutable child claim per predecessor precedes dispatch. A surviving
 * claim only observes; origin reset configuration and activation never change. */
export async function controlCompanyComputerResetServiceRestart(
	value: unknown,
	manager: CompanyComputerBootServiceStartManager,
	signal: AbortSignal,
	inspectionId?: string,
) {
	if (pending) throw new Error("OFFICE_RESET_SERVICE_RESTART_PENDING");
	pending = true;
	let material: Awaited<ReturnType<typeof readCompanyComputerResetRetainedEvidence>> | undefined;
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
			const bytes = await read(path, limit, mode);
			evidence.push({ path, bytes, mode });
			return bytes;
		};
		const staged = await retain(
			`${root}/reset-service-restart-incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_RESET_SERVICE_RESTART_MAX_BYTES,
			0o400,
		);
		if (hash(staged) !== command.requestSha256) throw new Error("request changed");
		const request = parseCompanyComputerResetServiceRestartRequest(json(staged)),
			attestation = request.successor.request.attestation,
			activationId = attestation.activationId,
			prior = await readCompanyComputerResetServiceInvocation(
				request.stop.revocation.request.activationId,
				command.bootId,
				retain,
			),
			stopped = await readCompanyComputerAcknowledgedStop(request, retain, prior),
			archive = await readCompanyComputerStopHistory(command.bootId, prior.start.activationId);
		if (
			!isDeepStrictEqual(request.origin, prior.origin.request) ||
			request.configurationCompletionSha256 !== prior.origin.start.configurationCompletionSha256 ||
			command.bootId !== attestation.bootId ||
			[
				prior.origin.start.command.commandId,
				prior.start.command.commandId,
				stopped.command.commandId,
				...prior.configurationCommands.map((item) => item.commandId),
			].includes(command.commandId) ||
			!isDeepStrictEqual(archive.manifest.command, stopped.command) ||
			archive.manifest.completionPath !== prior.stopPaths.completion ||
			hash(archive.files.get(prior.stopPaths.completion)!) !== request.stopCompletionSha256
		)
			throw new Error("predecessor or origin differs");
		const claimPath = companyComputerSuccessorClaimPath(prior.start.activationId),
			completionPath = companyComputerResetServiceRestartCompletionPath(activationId),
			claimBytes = encode(companyComputerResetSuccessorClaim(command, request));
		material = await readCompanyComputerResetRetainedEvidence(command, request.origin, signal);
		const optional = async (path: string) => {
			try {
				return await read(path, 8192, 0o600);
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
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			for (const path of [
				`${root}/boot-service-start-claim.json`,
				`${root}/boot-service-start-completion.json`,
				`${root}/boot-service-restart-completion-${activationId}.json`,
				`${root}/service-start-claim.json`,
				`${root}/service-start-completion.json`,
				`${root}/service-stop-claim.json`,
				`${root}/service-stop-claim-${activationId}.json`,
				companyComputerSuccessorClaimPath(activationId),
				`${root}/service-restart-completion-${activationId}.json`,
			]) {
				try {
					await lstat(path);
				} catch (error) {
					if (missing(error)) continue;
					throw error;
				}
				throw new Error("invocation stopping, superseded or ambiguous");
			}
			if (
				(await readCompanyComputerStopHistory(command.bootId, prior.start.activationId)).manifestSha256 !==
				archive.manifestSha256
			)
				throw new Error("stop archive changed");
			for (const { path, bytes, mode } of evidence)
				if (!(await read(path, bytes.length, mode)).equals(bytes)) throw new Error("history changed");
			await material!.verify();
			const observed = await manager.inspect(signal);
			if (!isDeepStrictEqual(observed.preparation, inactive)) throw new Error("initial preparation invoked");
			signal.throwIfAborted();
			return observed;
		};
		let observed = await verify();
		const confirmStopped = () => {
			assertCompanyComputerServiceStopped(observed);
			if (observed.service.invocationId && observed.service.invocationId !== stopped.stoppedInvocationId)
				throw new Error("predecessor invocation changed");
		};
		if (!claimed) {
			confirmStopped();
			await publish(claimPath, claimBytes, 0o600);
			evidence.push({ path: claimPath, bytes: claimBytes, mode: 0o600 });
			const before = observed;
			observed = await verify();
			confirmStopped();
			if (!isDeepStrictEqual(observed, before)) throw new Error("predecessor changed during claim");
			signal.throwIfAborted();
			await manager.start(signal);
			observed = await verify();
		}
		assertCompanyComputerServiceRunning(observed.service);
		if (
			observed.cgroupState !== "populated" ||
			observed.service.invocationId === prior.origin.start.serviceInvocationId
		)
			throw new Error("running invocation differs");
		const result = parseCompanyComputerResetServiceRestartCompletion(
				{
					schema: "qorpera.office-reset-service-restart-completion/v1",
					command,
					resetId: request.origin.request.resetId,
					rootIncarnationId: request.origin.request.rootIncarnationId,
					originActivationId: request.origin.request.attestation.activationId,
					activationId,
					configurationCompletionSha256: request.configurationCompletionSha256,
					configurationSha256: attestation.configurationSha256,
					serviceInvocationId: observed.service.invocationId,
					mainPid: observed.service.mainPid,
					controlGroup: observed.service.controlGroup,
				},
				command,
				request,
			),
			bytes = encode(result);
		if (completed && !completed.equals(bytes)) throw new Error("completed invocation changed");
		if (!isDeepStrictEqual(await verify(), observed)) throw new Error("invocation changed during confirmation");
		signal.throwIfAborted();
		if (inspectionId === undefined) {
			await publish(completionPath, bytes, 0o600);
			return result;
		}
		const inspection = parseCompanyComputerResetServiceRestartInspection(
			{ schema: "qorpera.office-reset-service-restart-inspection/v1", inspectionId, start: result },
			inspectionId,
			result,
			request,
		);
		await publish(`${root}/reset-service-restart-inspection-${inspectionId}.json`, encode(inspection), 0o600);
		return inspection;
	} catch {
		throw new Error("OFFICE_RESET_SERVICE_RESTART_UNCONFIRMED");
	} finally {
		try {
			await material?.close();
		} finally {
			pending = false;
		}
	}
}
