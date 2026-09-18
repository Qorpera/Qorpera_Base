import {
	type CompanyComputerBootConfigurationCompletion,
	parseCompanyComputerBootConfigurationCompletion,
} from "./company-computer-boot-configuration.ts";
import {
	type CompanyComputerBootSuccessor,
	parseCompanyComputerBootSuccessor,
} from "./company-computer-boot-successor.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";
import type { CompanyComputerServiceStartCompletion } from "./company-computer-service-start.ts";

export const COMPANY_COMPUTER_BOOT_SERVICE_START_MAX_BYTES = 65536;
/** Immutable provider-to-root packet after SQL boot successor preparation.
 * It contains public evidence only; parsing cannot grant current authority. */
export interface CompanyComputerBootServiceStartRequest {
	readonly schema: "qorpera.office-boot-service-start-request/v1";
	readonly successor: CompanyComputerBootSuccessor;
	readonly configuration: CompanyComputerBootConfigurationCompletion;
	readonly configurationCompletionSha256: string;
}
export interface CompanyComputerBootServiceStartCompletion
	extends Omit<CompanyComputerServiceStartCompletion, "schema"> {
	readonly schema: "qorpera.office-boot-service-start-completion/v1";
	readonly bootIntentId: string;
}
export interface CompanyComputerBootServiceInspection {
	readonly schema: "qorpera.office-boot-service-inspection/v1";
	readonly inspectionId: string;
	readonly start: CompanyComputerBootServiceStartCompletion;
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
export function parseCompanyComputerBootServiceStartRequest(
	value: unknown,
): Readonly<CompanyComputerBootServiceStartRequest> {
	try {
		const r = record(value, ["schema", "successor", "configuration", "configurationCompletionSha256"]);
		if (
			r.schema !== "qorpera.office-boot-service-start-request/v1" ||
			typeof r.configurationCompletionSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(r.configurationCompletionSha256) ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_BOOT_SERVICE_START_MAX_BYTES
		)
			throw new Error("schema");
		const source = r.successor as CompanyComputerBootSuccessor,
			successor = parseCompanyComputerBootSuccessor(source, source.request),
			configuration = parseCompanyComputerBootConfigurationCompletion(
				r.configuration,
				r.configuration as CompanyComputerBootConfigurationCompletion,
			),
			{ attestation } = successor.request;
		if (
			successor.state !== "prepared" ||
			configuration.bootIntentId !== successor.request.bootIntentId ||
			configuration.activationId !== attestation.activationId ||
			configuration.command.bootId !== attestation.bootId ||
			configuration.bootObservationSha256 !== successor.request.bootObservationSha256 ||
			configuration.adoptionReceiptSha256 !== attestation.adoptionReceiptSha256 ||
			configuration.files["config.json"].sha256 !== attestation.configurationSha256
		)
			throw new Error("binding");
		return Object.freeze({
			schema: r.schema,
			successor,
			configuration,
			configurationCompletionSha256: r.configurationCompletionSha256,
		});
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_SERVICE_START_REQUEST");
	}
}
export function parseCompanyComputerBootServiceStartCompletion(
	value: unknown,
	expectedCommand: CompanyComputerPreparationCommand,
	expectedRequest: CompanyComputerBootServiceStartRequest,
): Readonly<CompanyComputerBootServiceStartCompletion> {
	try {
		const r = record(value, [
				"schema",
				"command",
				"bootIntentId",
				"activationId",
				"configurationCompletionSha256",
				"configurationSha256",
				"serviceInvocationId",
				"mainPid",
				"controlGroup",
			]),
			command = parseCompanyComputerPreparationCommand(r.command),
			target = parseCompanyComputerPreparationCommand(expectedCommand),
			request = parseCompanyComputerBootServiceStartRequest(expectedRequest),
			successor = request.successor.request;
		if (
			r.schema !== "qorpera.office-boot-service-start-completion/v1" ||
			command.commandId !== target.commandId ||
			command.bootId !== target.bootId ||
			command.requestSha256 !== target.requestSha256 ||
			command.bootId !== successor.attestation.bootId ||
			command.commandId === request.configuration.command.commandId ||
			r.bootIntentId !== successor.bootIntentId ||
			r.activationId !== successor.attestation.activationId ||
			r.configurationCompletionSha256 !== request.configurationCompletionSha256 ||
			r.configurationSha256 !== successor.attestation.configurationSha256 ||
			typeof r.serviceInvocationId !== "string" ||
			!/^(?!0{32}$)[0-9a-f]{32}$/.test(r.serviceInvocationId) ||
			r.serviceInvocationId === successor.predecessor.startup.serviceInvocationId ||
			!Number.isSafeInteger(r.mainPid) ||
			(r.mainPid as number) < 1 ||
			r.controlGroup !== "/system.slice/qorpera-company-computer.service"
		)
			throw new Error("binding");
		return Object.freeze({ ...r, command }) as unknown as CompanyComputerBootServiceStartCompletion;
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_SERVICE_START_COMPLETION");
	}
}
export function parseCompanyComputerBootServiceInspection(
	value: unknown,
	inspectionId: string,
	completion: CompanyComputerBootServiceStartCompletion,
	request: CompanyComputerBootServiceStartRequest,
): Readonly<CompanyComputerBootServiceInspection> {
	try {
		const r = record(value, ["schema", "inspectionId", "start"]),
			expected = parseCompanyComputerBootServiceStartCompletion(completion, completion.command, request),
			nonce = parseCompanyComputerPreparationCommand({ ...expected.command, commandId: inspectionId }),
			start = parseCompanyComputerBootServiceStartCompletion(r.start, expected.command, request);
		if (
			r.schema !== "qorpera.office-boot-service-inspection/v1" ||
			r.inspectionId !== inspectionId ||
			nonce.commandId === expected.command.commandId ||
			start.mainPid !== expected.mainPid ||
			start.serviceInvocationId !== expected.serviceInvocationId
		)
			throw new Error("inspection");
		return Object.freeze({ schema: r.schema, inspectionId, start });
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_SERVICE_INSPECTION");
	}
}
