import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";
import {
	type CompanyComputerServiceStartCompletion,
	type CompanyComputerServiceStartRequest,
	parseCompanyComputerServiceStartCompletion,
	parseCompanyComputerServiceStartRequest,
} from "./company-computer-service-start.ts";
import {
	type CompanyComputerServiceStopRequest,
	parseCompanyComputerServiceStopRequest,
} from "./company-computer-service-stop.ts";
import {
	type CompanyComputerServiceSuccessor,
	parseCompanyComputerServiceSuccessor,
} from "./company-computer-service-successor.ts";
import {
	type CompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopAcknowledgement,
} from "./company-computer-stop-acknowledgement.ts";

/** Protected provider-to-root input, persisted before dispatch. SQL metadata
 * does not attest physical state; the root controller independently checks the
 * retained stop and installed configuration under its real kernel lock. */
export interface CompanyComputerServiceRestartRequest {
	readonly schema: "qorpera.office-service-restart-request/v1";
	readonly successor: CompanyComputerServiceSuccessor;
	readonly start: CompanyComputerServiceStartRequest;
	readonly stop: CompanyComputerServiceStopRequest;
	readonly acknowledgement: CompanyComputerServiceStopAcknowledgement;
	readonly stopCompletionSha256: string;
}
export const COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES = 65536;
function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const left = a as Record<string, unknown>,
		right = b as Record<string, unknown>;
	return (
		Object.keys(left).sort().join() === Object.keys(right).sort().join() &&
		Object.keys(left).every((key) => equal(left[key], right[key]))
	);
}
export function parseCompanyComputerServiceRestartRequest(
	value: unknown,
): Readonly<CompanyComputerServiceRestartRequest> {
	try {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Object.keys(value).sort().join() !== "acknowledgement,schema,start,stop,stopCompletionSha256,successor" ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES
		)
			throw new Error("record");
		const input = value as CompanyComputerServiceRestartRequest;
		if (
			input.schema !== "qorpera.office-service-restart-request/v1" ||
			typeof input.stopCompletionSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(input.stopCompletionSha256)
		)
			throw new Error("schema");
		const stop = parseCompanyComputerServiceStopRequest(input.stop),
			start = parseCompanyComputerServiceStartRequest(input.start);
		const successor = parseCompanyComputerServiceSuccessor(input.successor, input.successor.request);
		const command = parseCompanyComputerPreparationCommand(input.acknowledgement.inspection.stop.command);
		const acknowledgement = parseCompanyComputerServiceStopAcknowledgement(input.acknowledgement, stop, command);
		if (
			!acknowledgement ||
			successor.state !== "prepared" ||
			!equal(successor.request.predecessor, stop.revocation.request) ||
			!equal(start.attestation, successor.request.attestation) ||
			acknowledgement.acknowledgedAtMs !== successor.stopAcknowledgedAtMs
		)
			throw new Error("binding");
		return Object.freeze({
			schema: input.schema,
			successor,
			start,
			stop,
			acknowledgement,
			stopCompletionSha256: input.stopCompletionSha256,
		});
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_RESTART_REQUEST");
	}
}
export function parseCompanyComputerServiceRestartCompletion(
	value: unknown,
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerServiceRestartRequest,
): Readonly<CompanyComputerServiceStartCompletion> {
	try {
		const retained = parseCompanyComputerServiceRestartRequest(request);
		const result = parseCompanyComputerServiceStartCompletion(value, command, retained.start);
		const previous = retained.acknowledgement.inspection.stop;
		if (
			command.commandId === previous.command.commandId ||
			[previous.fromServiceInvocationId, previous.observedInvocationId, previous.stoppedInvocationId].includes(
				result.serviceInvocationId,
			)
		)
			throw new Error("reused");
		return result;
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_RESTART_COMPLETION");
	}
}
