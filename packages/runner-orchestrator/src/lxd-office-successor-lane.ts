import {
	type CompanyComputerBootServiceRestartCompletion,
	type CompanyComputerPreparationCommand,
	type CompanyComputerServiceStartCompletion,
	type CompanyComputerServiceStopAcknowledgement,
	type CompanyComputerServiceStopRequest,
	type CompanyComputerServiceSuccessor,
	parseCompanyComputerBootServiceRestartCompletion,
	parseCompanyComputerBootServiceRestartRequest,
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
} from "@qorpera/contracts";
import type {
	LxdOfficeBootServiceRestartClient,
	LxdOfficeResetServiceRestartClient,
	LxdOfficeServiceRestartClient,
} from "./lxd-client.ts";
import { LxdOfficeBootServiceRestartInspectionControl } from "./lxd-office-boot-service-restart-inspection.ts";
import { openLxdOfficeBootServiceRestartJournal } from "./lxd-office-boot-service-restart-journal.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { lxdOfficeResetServiceSuccessorLane } from "./lxd-office-reset-service-successor-lane.ts";
import { LxdOfficeRestartInspectionControl } from "./lxd-office-restart-inspection.ts";
import {
	type LxdOfficeServiceRestartIdentity,
	LxdOfficeServiceRestartJournal,
} from "./lxd-office-service-restart-journal.ts";
import type { readLxdOfficeStopEvidence } from "./lxd-office-stop-evidence.ts";

type Completion = CompanyComputerServiceStartCompletion | CompanyComputerBootServiceRestartCompletion;
type Authorize = (signal: AbortSignal) => Promise<AbortSignal>;
type Consume<T> = (
	completion: Readonly<Completion>,
	signal: AbortSignal,
	assertFresh: () => void,
	deadline: number,
) => Promise<T>;
/** Select a genuine wire protocol behind common successor orchestration.
 * No old configuration object is fabricated for a retained boot. */
export function lxdOfficeSuccessorLane(
	root: string,
	binding: LxdOfficeGuestBinding,
	evidence: Awaited<ReturnType<typeof readLxdOfficeStopEvidence>>,
	successor: CompanyComputerServiceSuccessor,
	stop: CompanyComputerServiceStopRequest,
	acknowledgement: CompanyComputerServiceStopAcknowledgement,
	stopCompletionSha256: string,
	client: LxdOfficeServiceRestartClient &
		Partial<LxdOfficeBootServiceRestartClient & LxdOfficeResetServiceRestartClient>,
) {
	if (evidence.kind === "reset" || evidence.kind === "reset_restart")
		return lxdOfficeResetServiceSuccessorLane(
			root,
			binding,
			evidence,
			successor,
			stop,
			acknowledgement,
			stopCompletionSha256,
			client,
		);
	if (evidence.kind === "original") {
		const request = parseCompanyComputerServiceRestartRequest({
			schema: "qorpera.office-service-restart-request/v1",
			successor,
			start: { ...evidence.request, attestation: successor.request.attestation },
			stop,
			acknowledgement,
			stopCompletionSha256,
		});
		return {
			purpose: "service-restart" as const,
			packetSchema: "qorpera.lxd-office-restart-request/v1",
			indexSchema: "qorpera.lxd-office-restart-intent/v1",
			request,
			bootIdentity: {},
			openJournal: (identity: LxdOfficeServiceRestartIdentity, existing = true) =>
				LxdOfficeServiceRestartJournal.open(root, identity, client, existing),
			push: client.pushOfficeServiceRestartRequest.bind(client),
			read: client.readOfficeServiceRestartRequest.bind(client),
			parseCompletion: (value: unknown, command: CompanyComputerPreparationCommand) =>
				parseCompanyComputerServiceRestartCompletion(value, command, request),
			inspectAndUse<T>(
				command: CompanyComputerPreparationCommand,
				value: unknown,
				authorize: Authorize,
				use: Consume<T>,
				signal: AbortSignal,
			) {
				return new LxdOfficeRestartInspectionControl(root, binding, client).inspectAndUse(
					command,
					request,
					parseCompanyComputerServiceRestartCompletion(value, command, request),
					authorize,
					use,
					signal,
					true,
				);
			},
		};
	}
	if (
		!client.submitOfficeBootServiceRestart ||
		!client.inspectOfficeBootServiceRestart ||
		!client.submitOfficeBootServiceRestartInspection ||
		!client.pushOfficeBootServiceRestartRequest ||
		!client.readOfficeBootServiceRestartRequest
	)
		throw new Error("boot restart client unavailable");
	const selected = {
			submitOfficeBootServiceRestart: client.submitOfficeBootServiceRestart.bind(client),
			inspectOfficeBootServiceRestart: client.inspectOfficeBootServiceRestart.bind(client),
			submitOfficeBootServiceRestartInspection: client.submitOfficeBootServiceRestartInspection.bind(client),
			pushOfficeBootServiceRestartRequest: client.pushOfficeBootServiceRestartRequest.bind(client),
			readOfficeBootServiceRestartRequest: client.readOfficeBootServiceRestartRequest.bind(client),
			readInstanceFile: client.readInstanceFile.bind(client),
		},
		request = parseCompanyComputerBootServiceRestartRequest({
			schema: "qorpera.office-boot-service-restart-request/v1",
			origin: evidence.origin.request,
			successor,
			stop,
			acknowledgement,
			stopCompletionSha256,
		}),
		bootIdentity = {
			...(evidence.kind === "outage"
				? { recoveryId: evidence.origin.recovery.request.recoveryId }
				: { bootIntentId: evidence.origin.bootIntent.bootIntentId }),
			originActivationId: evidence.origin.completion.activationId,
		};
	return {
		purpose: "boot-service-restart" as const,
		packetSchema: "qorpera.lxd-office-boot-service-restart-request/v1",
		indexSchema: "qorpera.lxd-office-boot-service-restart-intent/v1",
		request,
		bootIdentity,
		openJournal: (identity: LxdOfficeServiceRestartIdentity, existing = true) => {
			const { bootIntentId: _bootIntentId, recoveryId: _recoveryId, ...base } = identity;
			return openLxdOfficeBootServiceRestartJournal(root, { ...base, ...bootIdentity }, selected, existing);
		},
		push: selected.pushOfficeBootServiceRestartRequest,
		read: selected.readOfficeBootServiceRestartRequest,
		parseCompletion: (value: unknown, command: CompanyComputerPreparationCommand) =>
			parseCompanyComputerBootServiceRestartCompletion(value, command, request),
		inspectAndUse<T>(
			command: CompanyComputerPreparationCommand,
			value: unknown,
			authorize: Authorize,
			use: Consume<T>,
			signal: AbortSignal,
		) {
			return new LxdOfficeBootServiceRestartInspectionControl(root, binding, selected).inspectAndUse(
				command,
				request,
				parseCompanyComputerBootServiceRestartCompletion(value, command, request),
				authorize,
				use,
				signal,
				true,
			);
		},
	};
}
