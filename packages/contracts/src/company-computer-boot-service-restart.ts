import {
	type CompanyComputerBootServiceStartRequest,
	parseCompanyComputerBootServiceStartRequest,
} from "./company-computer-boot-service-start.ts";
import {
	type CompanyComputerOutageServiceStartRequest,
	parseCompanyComputerOutageServiceStartRequest,
} from "./company-computer-outage-service-start.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";
import type { CompanyComputerServiceStartCompletion } from "./company-computer-service-start.ts";
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

/** Same-boot successor after a retained-boot start. The origin packet and its
 * planned activation stay immutable; only the service successor names the new
 * activation. Public SQL metadata never substitutes for physical root proof. */
export interface CompanyComputerBootServiceRestartRequest {
	readonly schema: "qorpera.office-boot-service-restart-request/v1";
	readonly origin: CompanyComputerBootServiceStartRequest | CompanyComputerOutageServiceStartRequest;
	readonly successor: CompanyComputerServiceSuccessor;
	readonly stop: CompanyComputerServiceStopRequest;
	readonly acknowledgement: CompanyComputerServiceStopAcknowledgement;
	readonly stopCompletionSha256: string;
}
export type CompanyComputerBootServiceRestartCompletion = Omit<CompanyComputerServiceStartCompletion, "schema"> & {
	readonly schema: "qorpera.office-boot-service-restart-completion/v1";
	readonly originActivationId: string;
} & (
		| { readonly bootIntentId: string; readonly recoveryId?: never }
		| { readonly recoveryId: string; readonly bootIntentId?: never }
	);
export interface CompanyComputerBootServiceRestartInspection {
	readonly schema: "qorpera.office-boot-service-restart-inspection/v1";
	readonly inspectionId: string;
	readonly start: CompanyComputerBootServiceRestartCompletion;
}
export const COMPANY_COMPUTER_BOOT_SERVICE_RESTART_MAX_BYTES = 65536;
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
export function parseCompanyComputerBootServiceRestartRequest(
	value: unknown,
): Readonly<CompanyComputerBootServiceRestartRequest> {
	try {
		const r = record(value, ["schema", "origin", "successor", "stop", "acknowledgement", "stopCompletionSha256"]);
		if (
			r.schema !== "qorpera.office-boot-service-restart-request/v1" ||
			typeof r.stopCompletionSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(r.stopCompletionSha256) ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_BOOT_SERVICE_RESTART_MAX_BYTES
		)
			throw new Error("schema");
		const origin =
				(r.origin as { schema?: unknown })?.schema === "qorpera.office-outage-service-start-request/v1"
					? parseCompanyComputerOutageServiceStartRequest(r.origin)
					: parseCompanyComputerBootServiceStartRequest(r.origin),
			input = r.successor as CompanyComputerServiceSuccessor,
			successor = parseCompanyComputerServiceSuccessor(input, input.request),
			stop = parseCompanyComputerServiceStopRequest(r.stop),
			ack = r.acknowledgement as CompanyComputerServiceStopAcknowledgement,
			acknowledgement = parseCompanyComputerServiceStopAcknowledgement(ack, stop, ack.inspection.stop.command),
			initial = origin.successor.request.attestation,
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
		});
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_SERVICE_RESTART_REQUEST");
	}
}
export function parseCompanyComputerBootServiceRestartCompletion(
	value: unknown,
	expectedCommand: CompanyComputerPreparationCommand,
	expectedRequest: CompanyComputerBootServiceRestartRequest,
): Readonly<CompanyComputerBootServiceRestartCompletion> {
	try {
		const request = parseCompanyComputerBootServiceRestartRequest(expectedRequest),
			correlationKey =
				request.origin.schema === "qorpera.office-outage-service-start-request/v1" ? "recoveryId" : "bootIntentId",
			correlationId =
				request.origin.schema === "qorpera.office-outage-service-start-request/v1"
					? request.origin.successor.request.recovery.recoveryId
					: request.origin.successor.request.bootIntentId,
			predecessorInvocation =
				request.origin.schema === "qorpera.office-outage-service-start-request/v1"
					? undefined
					: request.origin.successor.request.predecessor.startup.serviceInvocationId,
			r = record(value, [
				"schema",
				"command",
				correlationKey,
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
			origin = request.origin.successor.request,
			attestation = request.successor.request.attestation,
			previous = request.acknowledgement.inspection.stop;
		if (
			r.schema !== "qorpera.office-boot-service-restart-completion/v1" ||
			!equal(command, target) ||
			command.bootId !== attestation.bootId ||
			[request.origin.configuration.command.commandId, previous.command.commandId].includes(command.commandId) ||
			r[correlationKey] !== correlationId ||
			r.originActivationId !== origin.attestation.activationId ||
			r.activationId !== attestation.activationId ||
			r.configurationCompletionSha256 !== request.origin.configurationCompletionSha256 ||
			r.configurationSha256 !== attestation.configurationSha256 ||
			typeof r.serviceInvocationId !== "string" ||
			!/^(?!0{32}$)[0-9a-f]{32}$/.test(r.serviceInvocationId) ||
			[
				predecessorInvocation,
				previous.fromServiceInvocationId,
				previous.observedInvocationId,
				previous.stoppedInvocationId,
			].includes(r.serviceInvocationId) ||
			!Number.isSafeInteger(r.mainPid) ||
			(r.mainPid as number) < 1 ||
			r.controlGroup !== "/system.slice/qorpera-company-computer.service"
		)
			throw new Error("binding");
		return Object.freeze({ ...r, command }) as unknown as CompanyComputerBootServiceRestartCompletion;
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_SERVICE_RESTART_COMPLETION");
	}
}
export function parseCompanyComputerBootServiceRestartInspection(
	value: unknown,
	inspectionId: string,
	completion: CompanyComputerBootServiceRestartCompletion,
	request: CompanyComputerBootServiceRestartRequest,
): Readonly<CompanyComputerBootServiceRestartInspection> {
	try {
		const r = record(value, ["schema", "inspectionId", "start"]),
			expected = parseCompanyComputerBootServiceRestartCompletion(completion, completion.command, request),
			nonce = parseCompanyComputerPreparationCommand({ ...expected.command, commandId: inspectionId }),
			start = parseCompanyComputerBootServiceRestartCompletion(r.start, expected.command, request);
		if (
			r.schema !== "qorpera.office-boot-service-restart-inspection/v1" ||
			r.inspectionId !== inspectionId ||
			nonce.commandId === expected.command.commandId ||
			!equal(start, expected)
		)
			throw new Error("inspection");
		return Object.freeze({ schema: r.schema, inspectionId, start });
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_SERVICE_RESTART_INSPECTION");
	}
}
