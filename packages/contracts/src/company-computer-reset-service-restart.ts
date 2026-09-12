import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";
import {
	type CompanyComputerResetServiceStartCompletion,
	type CompanyComputerResetServiceStartRequest,
	parseCompanyComputerResetServiceStartRequest,
} from "./company-computer-reset-successor.ts";
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

/** Same-boot successor after a recreated-root start. The origin packet and its
 * planned activation stay immutable; only the service successor names the new
 * activation. Public SQL metadata never substitutes for physical root proof. */
export interface CompanyComputerResetServiceRestartRequest {
	readonly schema: "qorpera.office-reset-service-restart-request/v1";
	readonly origin: CompanyComputerResetServiceStartRequest;
	readonly successor: CompanyComputerServiceSuccessor;
	readonly stop: CompanyComputerServiceStopRequest;
	readonly acknowledgement: CompanyComputerServiceStopAcknowledgement;
	readonly stopCompletionSha256: string;
	readonly configurationCompletionSha256: string;
}
export interface CompanyComputerResetServiceRestartCompletion
	extends Omit<CompanyComputerResetServiceStartCompletion, "schema"> {
	readonly schema: "qorpera.office-reset-service-restart-completion/v1";
	readonly originActivationId: string;
	readonly rootIncarnationId: string;
}
export interface CompanyComputerResetServiceRestartInspection {
	readonly schema: "qorpera.office-reset-service-restart-inspection/v1";
	readonly inspectionId: string;
	readonly start: CompanyComputerResetServiceRestartCompletion;
}
export const COMPANY_COMPUTER_RESET_SERVICE_RESTART_MAX_BYTES = 65536;
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
export function parseCompanyComputerResetServiceRestartRequest(
	value: unknown,
): Readonly<CompanyComputerResetServiceRestartRequest> {
	try {
		const r = record(value, [
			"schema",
			"origin",
			"successor",
			"stop",
			"acknowledgement",
			"stopCompletionSha256",
			"configurationCompletionSha256",
		]);
		if (
			r.schema !== "qorpera.office-reset-service-restart-request/v1" ||
			typeof r.stopCompletionSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(r.stopCompletionSha256) ||
			typeof r.configurationCompletionSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(r.configurationCompletionSha256) ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_RESET_SERVICE_RESTART_MAX_BYTES
		)
			throw new Error("schema");
		const origin = parseCompanyComputerResetServiceStartRequest(r.origin),
			input = r.successor as CompanyComputerServiceSuccessor,
			successor = parseCompanyComputerServiceSuccessor(input, input.request),
			stop = parseCompanyComputerServiceStopRequest(r.stop),
			ack = r.acknowledgement as CompanyComputerServiceStopAcknowledgement,
			acknowledgement = parseCompanyComputerServiceStopAcknowledgement(ack, stop, ack.inspection.stop.command),
			initial = origin.request.attestation,
			attestation = successor.request.attestation;
		if (
			successor.state !== "prepared" ||
			attestation.activationId === initial.activationId ||
			!equal({ ...attestation, activationId: initial.activationId }, initial) ||
			!equal(successor.request.predecessor, stop.revocation.request) ||
			acknowledgement.acknowledgedAtMs !== successor.stopAcknowledgedAtMs
		)
			throw new Error("binding");
		return Object.freeze({
			schema: r.schema,
			origin,
			successor,
			stop,
			acknowledgement,
			stopCompletionSha256: r.stopCompletionSha256,
			configurationCompletionSha256: r.configurationCompletionSha256,
		});
	} catch {
		throw new Error("INVALID_OFFICE_RESET_SERVICE_RESTART_REQUEST");
	}
}
export function parseCompanyComputerResetServiceRestartCompletion(
	value: unknown,
	expectedCommand: CompanyComputerPreparationCommand,
	expectedRequest: CompanyComputerResetServiceRestartRequest,
): Readonly<CompanyComputerResetServiceRestartCompletion> {
	try {
		const r = record(value, [
				"schema",
				"command",
				"resetId",
				"rootIncarnationId",
				"originActivationId",
				"activationId",
				"configurationCompletionSha256",
				"configurationSha256",
				"serviceInvocationId",
				"mainPid",
				"controlGroup",
			]),
			command = parseCompanyComputerPreparationCommand(r.command),
			target = parseCompanyComputerPreparationCommand(expectedCommand),
			request = parseCompanyComputerResetServiceRestartRequest(expectedRequest),
			origin = request.origin.request,
			attestation = request.successor.request.attestation,
			previous = request.acknowledgement.inspection.stop;
		if (
			r.schema !== "qorpera.office-reset-service-restart-completion/v1" ||
			!equal(command, target) ||
			command.bootId !== attestation.bootId ||
			[
				origin.resetId,
				origin.rootIncarnationId,
				origin.attestation.activationId,
				attestation.activationId,
				previous.command.commandId,
			].includes(command.commandId) ||
			r.resetId !== origin.resetId ||
			r.rootIncarnationId !== origin.rootIncarnationId ||
			r.originActivationId !== origin.attestation.activationId ||
			r.activationId !== attestation.activationId ||
			r.configurationCompletionSha256 !== request.configurationCompletionSha256 ||
			r.configurationSha256 !== attestation.configurationSha256 ||
			typeof r.serviceInvocationId !== "string" ||
			!/^(?!0{32}$)[0-9a-f]{32}$/.test(r.serviceInvocationId) ||
			[
				origin.predecessor.startup.serviceInvocationId,
				previous.fromServiceInvocationId,
				previous.observedInvocationId,
				previous.stoppedInvocationId,
			].includes(r.serviceInvocationId) ||
			!Number.isSafeInteger(r.mainPid) ||
			(r.mainPid as number) < 1 ||
			r.controlGroup !== "/system.slice/qorpera-company-computer.service"
		)
			throw new Error("binding");
		return Object.freeze({ ...r, command }) as unknown as CompanyComputerResetServiceRestartCompletion;
	} catch {
		throw new Error("INVALID_OFFICE_RESET_SERVICE_RESTART_COMPLETION");
	}
}
export function parseCompanyComputerResetServiceRestartInspection(
	value: unknown,
	inspectionId: string,
	completion: CompanyComputerResetServiceRestartCompletion,
	request: CompanyComputerResetServiceRestartRequest,
): Readonly<CompanyComputerResetServiceRestartInspection> {
	try {
		const r = record(value, ["schema", "inspectionId", "start"]),
			expected = parseCompanyComputerResetServiceRestartCompletion(completion, completion.command, request),
			nonce = parseCompanyComputerPreparationCommand({ ...expected.command, commandId: inspectionId }),
			start = parseCompanyComputerResetServiceRestartCompletion(r.start, expected.command, request);
		if (
			r.schema !== "qorpera.office-reset-service-restart-inspection/v1" ||
			r.inspectionId !== inspectionId ||
			nonce.commandId === expected.command.commandId ||
			!equal(start, expected)
		)
			throw new Error("inspection");
		return Object.freeze({ schema: r.schema, inspectionId, start });
	} catch {
		throw new Error("INVALID_OFFICE_RESET_SERVICE_RESTART_INSPECTION");
	}
}
