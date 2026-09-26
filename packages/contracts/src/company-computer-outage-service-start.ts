import {
	type CompanyComputerOutageConfigurationCompletion,
	parseCompanyComputerOutageConfigurationCompletion,
} from "./company-computer-outage-configuration.ts";
import {
	type CompanyComputerOutageSuccessor,
	parseCompanyComputerOutageSuccessor,
} from "./company-computer-outage-successor.ts";
import { outageEqual, outageNumber, outageRecord, outageSha, outageUuid } from "./company-computer-outage-values.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";
import type { CompanyComputerServiceStartCompletion } from "./company-computer-service-start.ts";

export const COMPANY_COMPUTER_OUTAGE_SERVICE_START_MAX_BYTES = 65536;
export interface CompanyComputerOutageServiceStartRequest {
	readonly schema: "qorpera.office-outage-service-start-request/v1";
	readonly successor: CompanyComputerOutageSuccessor;
	readonly configuration: CompanyComputerOutageConfigurationCompletion;
	readonly configurationCompletionSha256: string;
}
export interface CompanyComputerOutageServiceStartCompletion
	extends Omit<CompanyComputerServiceStartCompletion, "schema"> {
	readonly schema: "qorpera.office-outage-service-start-completion/v1";
	readonly recoveryId: string;
}
export interface CompanyComputerOutageServiceInspection {
	readonly schema: "qorpera.office-outage-service-inspection/v1";
	readonly inspectionId: string;
	readonly start: CompanyComputerOutageServiceStartCompletion;
}
export function parseCompanyComputerOutageServiceStartRequest(
	value: unknown,
): Readonly<CompanyComputerOutageServiceStartRequest> {
	const r = outageRecord(
			value,
			["schema", "successor", "configuration", "configurationCompletionSha256"],
			COMPANY_COMPUTER_OUTAGE_SERVICE_START_MAX_BYTES,
		),
		raw = r.successor as CompanyComputerOutageSuccessor,
		successor = parseCompanyComputerOutageSuccessor(raw, raw?.request),
		configuration = parseCompanyComputerOutageConfigurationCompletion(r.configuration),
		{ attestation, recovery, termination } = successor.request;
	if (
		r.schema !== "qorpera.office-outage-service-start-request/v1" ||
		successor.state !== "prepared" ||
		configuration.recoveryId !== recovery.recoveryId ||
		configuration.activationId !== attestation.activationId ||
		configuration.command.bootId !== attestation.bootId ||
		configuration.bootObservationSha256 !== termination.request.inspection.bootObservationSha256 ||
		configuration.originPreparationSha256 !== termination.request.inspection.originPreparationSha256 ||
		configuration.adoptionReceiptSha256 !== attestation.adoptionReceiptSha256 ||
		configuration.files["config.json"].sha256 !== attestation.configurationSha256
	)
		throw new Error("INVALID_OFFICE_OUTAGE_SERVICE_START_REQUEST");
	return Object.freeze({
		schema: r.schema,
		successor,
		configuration,
		configurationCompletionSha256: outageSha(r.configurationCompletionSha256),
	});
}
export function parseCompanyComputerOutageServiceStartCompletion(
	value: unknown,
	expectedCommand: CompanyComputerPreparationCommand,
	expectedRequest: CompanyComputerOutageServiceStartRequest,
): Readonly<CompanyComputerOutageServiceStartCompletion> {
	const r = outageRecord(value, [
			"schema",
			"command",
			"recoveryId",
			"activationId",
			"configurationCompletionSha256",
			"configurationSha256",
			"serviceInvocationId",
			"mainPid",
			"controlGroup",
		]),
		command = parseCompanyComputerPreparationCommand(r.command),
		target = parseCompanyComputerPreparationCommand(expectedCommand),
		request = parseCompanyComputerOutageServiceStartRequest(expectedRequest),
		successor = request.successor.request;
	if (
		r.schema !== "qorpera.office-outage-service-start-completion/v1" ||
		!outageEqual(command, target) ||
		command.bootId !== successor.attestation.bootId ||
		command.commandId === request.configuration.command.commandId ||
		r.recoveryId !== successor.recovery.recoveryId ||
		r.activationId !== successor.attestation.activationId ||
		r.configurationCompletionSha256 !== request.configurationCompletionSha256 ||
		r.configurationSha256 !== successor.attestation.configurationSha256 ||
		typeof r.serviceInvocationId !== "string" ||
		!/^(?!0{32}$)[0-9a-f]{32}$/.test(r.serviceInvocationId) ||
		r.controlGroup !== "/system.slice/qorpera-company-computer.service"
	)
		throw new Error("INVALID_OFFICE_OUTAGE_SERVICE_START_COMPLETION");
	return Object.freeze({
		...r,
		command,
		mainPid: outageNumber(r.mainPid),
	}) as unknown as CompanyComputerOutageServiceStartCompletion;
}
export function parseCompanyComputerOutageServiceInspection(
	value: unknown,
	inspectionId: string,
	completion: CompanyComputerOutageServiceStartCompletion,
	request: CompanyComputerOutageServiceStartRequest,
): Readonly<CompanyComputerOutageServiceInspection> {
	const r = outageRecord(value, ["schema", "inspectionId", "start"]),
		expected = parseCompanyComputerOutageServiceStartCompletion(completion, completion.command, request),
		start = parseCompanyComputerOutageServiceStartCompletion(r.start, expected.command, request);
	if (
		r.schema !== "qorpera.office-outage-service-inspection/v1" ||
		r.inspectionId !== outageUuid(inspectionId) ||
		inspectionId === expected.command.commandId ||
		!outageEqual(start, expected)
	)
		throw new Error("INVALID_OFFICE_OUTAGE_SERVICE_INSPECTION");
	return Object.freeze({ schema: r.schema, inspectionId, start });
}
