import {
	type CompanyComputerActivationAttestation,
	parseCompanyComputerActivationAttestation,
} from "./company-computer-activation.ts";
import {
	type CompanyComputerConfigurationCompletion,
	parseCompanyComputerConfigurationCompletion,
} from "./company-computer-configuration.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";

/** Protected provider-to-root command data. Retained configuration evidence is
 * independently verified against installed files before starting the service. */
export interface CompanyComputerServiceStartRequest {
	readonly schema: "qorpera.office-service-start-request/v1";
	readonly attestation: CompanyComputerActivationAttestation;
	readonly configuration: CompanyComputerConfigurationCompletion;
	readonly configurationCompletionSha256: string;
}

export interface CompanyComputerServiceStartCompletion {
	readonly schema: "qorpera.office-service-start-completion/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly activationId: string;
	readonly configurationCompletionSha256: string;
	readonly configurationSha256: string;
	readonly serviceInvocationId: string;
	readonly mainPid: number;
	readonly controlGroup: "/system.slice/qorpera-company-computer.service";
}
export interface CompanyComputerServiceInspection {
	readonly schema: "qorpera.office-service-inspection/v1";
	readonly inspectionId: string;
	readonly start: CompanyComputerServiceStartCompletion;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("record");
	return value as Record<string, unknown>;
}
function sameCommand(a: CompanyComputerPreparationCommand, b: CompanyComputerPreparationCommand) {
	return a.commandId === b.commandId && a.requestSha256 === b.requestSha256 && a.bootId === b.bootId;
}
/** Validates identity against the retained provider request. A completion is
 * historical evidence only; it does not establish current liveness or SQL readiness. */
export function parseCompanyComputerServiceStartCompletion(
	value: unknown,
	expectedCommand: CompanyComputerPreparationCommand,
	expectedRequest: CompanyComputerServiceStartRequest,
): Readonly<CompanyComputerServiceStartCompletion> {
	try {
		const input = record(value, [
			"schema",
			"command",
			"activationId",
			"configurationCompletionSha256",
			"configurationSha256",
			"serviceInvocationId",
			"mainPid",
			"controlGroup",
		]);
		const command = parseCompanyComputerPreparationCommand(input.command);
		const request = parseCompanyComputerServiceStartRequest(expectedRequest);
		if (
			input.schema !== "qorpera.office-service-start-completion/v1" ||
			!sameCommand(command, parseCompanyComputerPreparationCommand(expectedCommand)) ||
			command.bootId !== request.attestation.bootId ||
			[request.configuration.command.commandId, request.configuration.preparation.commandId].includes(
				command.commandId,
			) ||
			input.activationId !== request.attestation.activationId ||
			input.configurationCompletionSha256 !== request.configurationCompletionSha256 ||
			input.configurationSha256 !== request.attestation.configurationSha256 ||
			typeof input.serviceInvocationId !== "string" ||
			!/^(?!0{32}$)[0-9a-f]{32}$/.test(input.serviceInvocationId) ||
			!Number.isSafeInteger(input.mainPid) ||
			(input.mainPid as number) < 1 ||
			input.controlGroup !== "/system.slice/qorpera-company-computer.service"
		)
			throw new Error("binding");
		return Object.freeze({ ...input, command }) as unknown as Readonly<CompanyComputerServiceStartCompletion>;
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_START_COMPLETION");
	}
}
/** The caller must issue a new nonce and enforce an end-to-end deadline from
 * dispatch through readback and activation. Parsing alone grants no freshness. */
export function parseCompanyComputerServiceInspection(
	value: unknown,
	inspectionId: string,
	completion: CompanyComputerServiceStartCompletion,
	request: CompanyComputerServiceStartRequest,
): Readonly<CompanyComputerServiceInspection> {
	try {
		const expected = parseCompanyComputerServiceStartCompletion(completion, completion.command, request);
		const nonce = parseCompanyComputerPreparationCommand({ ...expected.command, commandId: inspectionId });
		const input = record(value, ["schema", "inspectionId", "start"]);
		const start = parseCompanyComputerServiceStartCompletion(input.start, expected.command, request);
		if (
			nonce.commandId === expected.command.commandId ||
			input.schema !== "qorpera.office-service-inspection/v1" ||
			input.inspectionId !== inspectionId ||
			start.serviceInvocationId !== expected.serviceInvocationId ||
			start.mainPid !== expected.mainPid ||
			start.controlGroup !== expected.controlGroup
		)
			throw new Error("binding");
		return Object.freeze({ schema: "qorpera.office-service-inspection/v1", inspectionId, start });
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_INSPECTION");
	}
}
export const COMPANY_COMPUTER_SERVICE_START_MAX_BYTES = 16384;
export function parseCompanyComputerServiceStartRequest(value: unknown): Readonly<CompanyComputerServiceStartRequest> {
	try {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Object.keys(value).sort().join() !== "attestation,configuration,configurationCompletionSha256,schema"
		)
			throw new Error("record");
		const input = value as CompanyComputerServiceStartRequest;
		if (
			input.schema !== "qorpera.office-service-start-request/v1" ||
			typeof input.configurationCompletionSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(input.configurationCompletionSha256) ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_SERVICE_START_MAX_BYTES
		)
			throw new Error("schema");
		const attestation = parseCompanyComputerActivationAttestation(input.attestation);
		const configuration = parseCompanyComputerConfigurationCompletion(input.configuration, input.configuration);
		if (
			attestation.bootId !== configuration.command.bootId ||
			attestation.configurationSha256 !== configuration.files["config.json"].sha256 ||
			attestation.adoptionReceiptSha256 !== configuration.adoptionReceiptSha256
		)
			throw new Error("binding");
		return Object.freeze({
			schema: input.schema,
			attestation,
			configuration,
			configurationCompletionSha256: input.configurationCompletionSha256,
		});
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_START_REQUEST");
	}
}
