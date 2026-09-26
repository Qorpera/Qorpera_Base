import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_OUTAGE_SERVICE_START_MAX_BYTES,
	parseCompanyComputerOutageServiceInspection,
	parseCompanyComputerOutageServiceStartCompletion,
	parseCompanyComputerOutageServiceStartRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import {
	type CompanyComputerBootConfigurationManager,
	createCompanyComputerBootConfigurationSystemdManager,
} from "./cloud-company-computer-boot-configuration-control.ts";
import { readCompanyComputerOutageServiceStartEvidence } from "./cloud-company-computer-outage-service-start-evidence.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	publishCompanyComputerPreparationProtected as publish,
	readCompanyComputerPreparationProtected as read,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import { assertCompanyComputerServiceRunning } from "./cloud-company-computer-service-start-control.ts";
import { createCompanyComputerServiceStartSystemdManager } from "./cloud-company-computer-service-start-systemd.ts";

export interface CompanyComputerOutageServiceStartManager extends CompanyComputerBootConfigurationManager {
	start(signal: AbortSignal): Promise<void>;
}
export function createCompanyComputerOutageServiceStartSystemdManager(): CompanyComputerOutageServiceStartManager {
	return {
		...createCompanyComputerBootConfigurationSystemdManager(),
		start: createCompanyComputerServiceStartSystemdManager().start,
	};
}
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
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
const neverStarted = { ...inactive, controlGroup: "", restarts: 0 };
let pending = false;
/** First ordinary invocation in an acknowledged retained boot. A durable claim
 * precedes systemctl; surviving claims only observe the same running invocation.
 * Caller supplies current SQL successor authority. Root evidence cannot open
 * admission, replace unknown work or restore previous volatile boot state. */
export async function controlCompanyComputerOutageServiceStart(
	value: unknown,
	manager: CompanyComputerOutageServiceStartManager,
	signal: AbortSignal,
	inspectionId?: string,
) {
	if (pending) throw new Error("OFFICE_OUTAGE_SERVICE_START_PENDING");
	pending = true;
	let material: Awaited<ReturnType<typeof readCompanyComputerOutageServiceStartEvidence>> | undefined;
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		if (
			inspectionId !== undefined &&
			parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId }).commandId === command.commandId
		)
			throw new Error("inspection identity");
		await assertCompanyComputerPreparationLockAndBoot(command);
		const stagePath = `${root}/outage-service-start-incoming-${command.requestSha256}.json`,
			staged = await read(stagePath, COMPANY_COMPUTER_OUTAGE_SERVICE_START_MAX_BYTES, 0o400);
		if (hash(staged) !== command.requestSha256) throw new Error("staging changed");
		const request = parseCompanyComputerOutageServiceStartRequest(
				JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(staged)),
			),
			{ attestation } = request.successor.request;
		if (attestation.bootId !== command.bootId || command.commandId === request.configuration.command.commandId)
			throw new Error("command differs");
		material = await readCompanyComputerOutageServiceStartEvidence(command, request, signal);
		const claimPath = `${root}/outage-service-start-claim.json`,
			completionPath = `${root}/outage-service-start-completion.json`,
			claimBytes = encode({
				schema: "qorpera.office-outage-service-start-claim/v1",
				command,
				recoveryId: request.successor.request.recovery.recoveryId,
				activationId: attestation.activationId,
				configurationCompletionSha256: request.configurationCompletionSha256,
			});
		const optional = async (path: string, limit: number) => {
			try {
				return await read(path, limit, 0o600);
			} catch (error) {
				if (!missing(error)) throw error;
				return undefined;
			}
		};
		const claim = await optional(claimPath, 4096),
			completed = await optional(completionPath, 16384);
		if (claim && !claim.equals(claimBytes)) throw new Error("start already claimed");
		if (completed && !claim) throw new Error("claim missing");
		if (inspectionId !== undefined && (!claim || !completed)) throw new Error("completed start required");
		let claimRequired = claim !== undefined;
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			for (const name of [
				"service-start-claim.json",
				"boot-service-start-claim.json",
				"boot-service-start-completion.json",
				"service-start-completion.json",
				"service-stop-claim.json",
				`service-stop-claim-${attestation.activationId}.json`,
				`service-successor-${attestation.activationId}.json`,
			]) {
				try {
					await lstat(`${root}/${name}`);
					throw new Error("old invocation or stop claimed");
				} catch (error) {
					if (!missing(error)) throw error;
				}
			}
			if (!(await read(stagePath, staged.length, 0o400)).equals(staged)) throw new Error("staging changed");
			if (claimRequired && !(await read(claimPath, 4096, 0o600)).equals(claimBytes))
				throw new Error("claim changed");
			if (completed && !(await read(completionPath, 16384, 0o600)).equals(completed))
				throw new Error("completion changed");
			await material!.verify();
			const observed = await manager.inspect(signal);
			if (!isDeepStrictEqual(observed.preparation, inactive)) throw new Error("initial preparation invoked");
			signal.throwIfAborted();
			return observed;
		};
		let observed = await verify();
		const confirmNeverStarted = async () => {
			if (!isDeepStrictEqual(observed.service, neverStarted) || !["absent", "empty"].includes(observed.cgroupState))
				throw new Error("unclaimed service or descendant");
		};
		if (!claim) {
			await confirmNeverStarted();
			await publish(claimPath, claimBytes, 0o600);
			claimRequired = true;
			if (!(await read(claimPath, 4096, 0o600)).equals(claimBytes)) throw new Error("claim changed");
			observed = await verify();
			await confirmNeverStarted();
			signal.throwIfAborted();
			await manager.start(signal);
			observed = await verify();
		}
		assertCompanyComputerServiceRunning(observed.service);
		if (observed.cgroupState !== "populated") throw new Error("running cgroup differs");
		const result = parseCompanyComputerOutageServiceStartCompletion(
				{
					schema: "qorpera.office-outage-service-start-completion/v1",
					command,
					recoveryId: request.successor.request.recovery.recoveryId,
					activationId: attestation.activationId,
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
		if (!(await read(claimPath, 4096, 0o600)).equals(claimBytes) || !isDeepStrictEqual(await verify(), observed))
			throw new Error("service changed during confirmation");
		signal.throwIfAborted();
		if (inspectionId === undefined) {
			await publish(completionPath, bytes, 0o600);
			return result;
		}
		const inspection = parseCompanyComputerOutageServiceInspection(
			{ schema: "qorpera.office-outage-service-inspection/v1", inspectionId, start: result },
			inspectionId,
			result,
			request,
		);
		await publish(`${root}/outage-service-inspection-${inspectionId}.json`, encode(inspection), 0o600);
		return inspection;
	} catch {
		throw new Error("OFFICE_OUTAGE_SERVICE_START_UNCONFIRMED");
	} finally {
		try {
			await material?.close();
		} finally {
			pending = false;
		}
	}
}
