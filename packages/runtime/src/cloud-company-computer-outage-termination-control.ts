import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_OUTAGE_TERMINATION_MAX_BYTES,
	companyComputerOutageResumeObservationCanonical,
	parseCompanyComputerOutageTerminationInspection,
	parseCompanyComputerOutageTerminationRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import type { CompanyComputerBootConfigurationManager } from "./cloud-company-computer-boot-configuration-control.ts";
import { readCompanyComputerOutagePredecessor } from "./cloud-company-computer-outage-predecessor.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	publishCompanyComputerPreparationProtected as publish,
	readCompanyComputerPreparationProtected as read,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import { openCompanyComputerRetainedWorkbench } from "./cloud-company-computer-retained-workbench.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
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
/** Fresh-kernel termination evidence only. Never replays preparation, starts
 * the service, restores volatile state, acknowledges privacy or opens admission.
 * SQL independently validates the enrolled provider and its short-lived nonce. */
export async function controlCompanyComputerOutageTermination(
	value: unknown,
	manager: CompanyComputerBootConfigurationManager,
	signal: AbortSignal,
) {
	if (pending) throw new Error("OFFICE_OUTAGE_TERMINATION_PENDING");
	pending = true;
	let material: Awaited<ReturnType<typeof readCompanyComputerOutagePredecessor>> | undefined;
	let workbench: Awaited<ReturnType<typeof openCompanyComputerRetainedWorkbench>> | undefined;
	let staged: Buffer | undefined;
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		await assertCompanyComputerPreparationLockAndBoot(command);
		const path = `${root}/outage-termination-incoming-${command.requestSha256}.json`;
		staged = await read(path, COMPANY_COMPUTER_OUTAGE_TERMINATION_MAX_BYTES, 0o400);
		if (hash(staged) !== command.requestSha256) throw new Error("outage request changed");
		const request = parseCompanyComputerOutageTerminationRequest(
				JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(staged)),
			),
			{ recovery } = request.challenge,
			{ observation, inspectionId } = request.challenge.request;
		if (
			command.bootId !== observation.bootId ||
			command.commandId === observation.startCommandId ||
			hash(companyComputerOutageResumeObservationCanonical(observation, recovery)) !==
				request.challenge.request.bootObservationSha256
		)
			throw new Error("outage command differs");
		material = await readCompanyComputerOutagePredecessor(
			{
				startup: recovery.predecessor.startup,
				bootId: command.bootId,
				originPreparationSha256: request.originPreparationSha256,
			},
			read,
			signal,
		);
		workbench = await openCompanyComputerRetainedWorkbench(material.original, signal);
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			const current = await read(path, staged!.length, 0o400);
			try {
				if (!current.equals(staged!)) throw new Error("outage staged evidence changed");
			} finally {
				current.fill(0);
			}
			await material!.verify();
			await workbench!.verify();
			const state = await manager.inspect(signal);
			if (
				!isDeepStrictEqual(state.preparation, inactive) ||
				!isDeepStrictEqual(state.service, { ...inactive, controlGroup: "", restarts: 0 }) ||
				!["absent", "empty"].includes(state.cgroupState)
			)
				throw new Error("outage recovery requires unstarted fresh boot");
			signal.throwIfAborted();
			return state;
		};
		const state = await verify(),
			inspection = parseCompanyComputerOutageTerminationInspection(
				{
					schema: "qorpera.office-outage-termination-inspection/v1",
					command,
					inspectionId,
					recoveryId: recovery.request.recoveryId,
					startCommandId: recovery.request.startCommandId,
					bootId: observation.bootId,
					hostBootId: observation.hostBootId,
					physicalInstanceId: observation.physicalInstanceId,
					bootObservationSha256: hash(companyComputerOutageResumeObservationCanonical(observation, recovery)),
					originPreparationSha256: material.originPreparationSha256,
					originAdoptionReceiptSha256: material.originAdoptionReceiptSha256,
					predecessorConfigurationSha256: material.predecessorConfigurationSha256,
					predecessorAdoptionReceiptSha256: material.predecessorAdoptionReceiptSha256,
					cgroupState: state.cgroupState,
					preparationState: "unstarted",
					serviceState: "unstarted",
				},
				command,
				request,
			);
		if (!isDeepStrictEqual(await verify(), state)) throw new Error("outage termination inspection changed");
		await publish(
			`${root}/outage-termination-inspection-${inspectionId}.json`,
			Buffer.from(`${JSON.stringify(inspection)}\n`),
			0o600,
		);
		if (!isDeepStrictEqual(await verify(), state)) throw new Error("outage termination inspection changed");
		return inspection;
	} catch {
		throw new Error("OFFICE_OUTAGE_TERMINATION_UNCONFIRMED");
	} finally {
		try {
			await workbench?.close();
		} finally {
			material?.close();
			staged?.fill(0);
			pending = false;
		}
	}
}
