import {
	type CompanyComputerPreparationCommand,
	type CompanyComputerResetServiceRestartCompletion,
	type CompanyComputerServiceStartCompletion,
	type CompanyComputerServiceStopAcknowledgement,
	type CompanyComputerServiceStopRequest,
	type CompanyComputerServiceSuccessor,
	parseCompanyComputerResetServiceRestartCompletion,
	parseCompanyComputerResetServiceRestartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeResetServiceRestartClient, LxdOfficeServiceRestartClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { LxdOfficeResetServiceRestartInspectionControl } from "./lxd-office-reset-service-restart-inspection.ts";
import { openLxdOfficeResetServiceRestartJournal } from "./lxd-office-reset-service-restart-journal.ts";
import type { LxdOfficeServiceRestartIdentity } from "./lxd-office-service-restart-journal.ts";
import type { readLxdOfficeStopEvidence } from "./lxd-office-stop-evidence.ts";

type Completion = CompanyComputerServiceStartCompletion | CompanyComputerResetServiceRestartCompletion;
type Authorize = (signal: AbortSignal) => Promise<AbortSignal>;
type Consume<T> = (
	completion: Readonly<Completion>,
	signal: AbortSignal,
	assertFresh: () => void,
	deadline: number,
) => Promise<T>;
/** Select a genuine wire protocol behind common successor orchestration.
 * No old configuration object is fabricated for a retained boot. */
export function lxdOfficeResetServiceSuccessorLane(
	root: string,
	binding: LxdOfficeGuestBinding,
	evidence: Extract<Awaited<ReturnType<typeof readLxdOfficeStopEvidence>>, { kind: "reset" | "reset_restart" }>,
	successor: CompanyComputerServiceSuccessor,
	stop: CompanyComputerServiceStopRequest,
	acknowledgement: CompanyComputerServiceStopAcknowledgement,
	stopCompletionSha256: string,
	client: LxdOfficeServiceRestartClient & Partial<LxdOfficeResetServiceRestartClient>,
) {
	if (
		!client.submitOfficeResetServiceRestart ||
		!client.inspectOfficeResetServiceRestart ||
		!client.submitOfficeResetServiceRestartInspection ||
		!client.pushOfficeResetServiceRestartRequest ||
		!client.readOfficeResetServiceRestartRequest
	)
		throw new Error("reset restart client unavailable");
	const selected = {
			submitOfficeResetServiceRestart: client.submitOfficeResetServiceRestart.bind(client),
			inspectOfficeResetServiceRestart: client.inspectOfficeResetServiceRestart.bind(client),
			submitOfficeResetServiceRestartInspection: client.submitOfficeResetServiceRestartInspection.bind(client),
			pushOfficeResetServiceRestartRequest: client.pushOfficeResetServiceRestartRequest.bind(client),
			readOfficeResetServiceRestartRequest: client.readOfficeResetServiceRestartRequest.bind(client),
			readInstanceFile: client.readInstanceFile.bind(client),
		},
		request = parseCompanyComputerResetServiceRestartRequest({
			schema: "qorpera.office-reset-service-restart-request/v1",
			origin: evidence.origin.request,
			configurationCompletionSha256: evidence.origin.configurationCompletionSha256,
			successor,
			stop,
			acknowledgement,
			stopCompletionSha256,
		}),
		bootIdentity = {
			resetId: evidence.origin.plan.resetId,
			rootIncarnationId: evidence.origin.plan.rootIncarnationId,
			originActivationId: evidence.origin.completion.activationId,
		};
	return {
		purpose: "reset-service-restart" as const,
		packetSchema: "qorpera.lxd-office-reset-service-restart-request/v1",
		indexSchema: "qorpera.lxd-office-reset-service-restart-intent/v1",
		request,
		bootIdentity,
		openJournal: (identity: LxdOfficeServiceRestartIdentity, existing = true) =>
			openLxdOfficeResetServiceRestartJournal(root, { ...identity, ...bootIdentity }, selected, existing),
		push: selected.pushOfficeResetServiceRestartRequest,
		read: selected.readOfficeResetServiceRestartRequest,
		parseCompletion: (value: unknown, command: CompanyComputerPreparationCommand) =>
			parseCompanyComputerResetServiceRestartCompletion(value, command, request),
		inspectAndUse<T>(
			command: CompanyComputerPreparationCommand,
			value: unknown,
			authorize: Authorize,
			use: Consume<T>,
			signal: AbortSignal,
		) {
			return new LxdOfficeResetServiceRestartInspectionControl(root, binding, selected).inspectAndUse(
				command,
				request,
				parseCompanyComputerResetServiceRestartCompletion(value, command, request),
				authorize,
				use,
				signal,
				true,
			);
		},
	};
}
