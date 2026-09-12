import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerResetServiceInspection,
	parseCompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
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
import { readCompanyComputerResetServiceStartEvidence } from "./cloud-company-computer-reset-successor-evidence.ts";
import { assertCompanyComputerServiceRunning } from "./cloud-company-computer-service-start-control.ts";

export {
	type CompanyComputerBootServiceStartManager as CompanyComputerResetServiceStartManager,
	createCompanyComputerBootServiceStartSystemdManager as createCompanyComputerResetServiceStartSystemdManager,
};
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
/** First ordinary invocation on a recreated root after a governed reset. The
 * staged packet is the SQL-prepared reset successor; root evidence binds it to
 * this boot's acknowledged reset configuration. A durable claim precedes
 * systemctl and a surviving claim only observes the same running invocation.
 * Root evidence cannot open admission or replace unknown work. */
export async function controlCompanyComputerResetServiceStart(
	value: unknown,
	manager: CompanyComputerBootServiceStartManager,
	signal: AbortSignal,
	inspectionId?: string,
) {
	if (pending) throw new Error("OFFICE_RESET_SERVICE_START_PENDING");
	pending = true;
	let material: Awaited<ReturnType<typeof readCompanyComputerResetServiceStartEvidence>> | undefined;
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		if (
			inspectionId !== undefined &&
			parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId }).commandId === command.commandId
		)
			throw new Error("inspection identity");
		await assertCompanyComputerPreparationLockAndBoot(command);
		const stagePath = `${root}/reset-service-start-incoming-${command.requestSha256}.json`,
			staged = await read(stagePath, COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES, 0o400);
		if (hash(staged) !== command.requestSha256) throw new Error("staging changed");
		const request = parseCompanyComputerResetServiceStartRequest(
				JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(staged)),
			),
			{ attestation } = request.request;
		if (attestation.bootId !== command.bootId) throw new Error("command differs");
		material = await readCompanyComputerResetServiceStartEvidence(command, request, signal);
		if (command.commandId === material.configured.command.commandId) throw new Error("command differs");
		const claimPath = `${root}/reset-service-start-claim.json`,
			completionPath = `${root}/reset-service-start-completion.json`,
			claimBytes = encode({
				schema: "qorpera.office-reset-service-start-claim/v1",
				command,
				resetId: request.request.resetId,
				activationId: attestation.activationId,
				configurationCompletionSha256: material.configurationCompletionSha256,
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
		const result = parseCompanyComputerResetServiceStartCompletion(
				{
					schema: "qorpera.office-reset-service-start-completion/v1",
					command,
					resetId: request.request.resetId,
					activationId: attestation.activationId,
					configurationCompletionSha256: material.configurationCompletionSha256,
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
		const inspection = parseCompanyComputerResetServiceInspection(
			{ schema: "qorpera.office-reset-service-inspection/v1", inspectionId, start: result },
			inspectionId,
			result,
			request,
		);
		await publish(`${root}/reset-service-inspection-${inspectionId}.json`, encode(inspection), 0o600);
		return inspection;
	} catch (error) {
		throw new Error("OFFICE_RESET_SERVICE_START_UNCONFIRMED", { cause: error });
	} finally {
		try {
			await material?.close();
		} finally {
			pending = false;
		}
	}
}
