import type { CompanyComputerLifecycleDrain, CompanyComputerLifecycleRequest } from "./company-computer-lifecycle.ts";
import { parseCompanyComputerLifecycleTransition } from "./company-computer-lifecycle.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";
import {
	type CompanyComputerServiceStopInspection,
	type CompanyComputerServiceStopRequest,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopInspection,
	parseCompanyComputerServiceStopRequest,
} from "./company-computer-service-stop.ts";

export interface CompanyComputerServiceStopChallenge {
	readonly schema: "qorpera.office-service-stop-challenge/v1";
	readonly inspectionId: string;
	readonly command: CompanyComputerPreparationCommand;
	readonly transitionId: string;
	readonly revocationRevision: number;
	readonly officeRevision: number;
	readonly privacyVersion: number;
	readonly drains: readonly CompanyComputerLifecycleDrain[];
	readonly validForMs: number;
}
/** Historical SQL acknowledgement. Admission, privacy and machine capacity
 * remain fenced; this is not permission to start a successor. */
export interface CompanyComputerServiceStopAcknowledgement {
	readonly schema: "qorpera.office-service-stop-acknowledgement/v1";
	readonly state: "stopped";
	readonly request: CompanyComputerLifecycleRequest;
	readonly inspection: CompanyComputerServiceStopInspection;
	readonly acknowledgedAtMs: number;
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
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
		throw new Error("number");
	return value as number;
}
export function parseCompanyComputerServiceStopChallenge(
	value: unknown,
	requestValue: CompanyComputerServiceStopRequest,
	commandValue: CompanyComputerPreparationCommand,
	inspectionId: string,
): CompanyComputerServiceStopChallenge {
	try {
		const request = parseCompanyComputerServiceStopRequest(requestValue),
			command = parseCompanyComputerPreparationCommand(commandValue);
		const r = record(value, [
			"schema",
			"inspectionId",
			"command",
			"transitionId",
			"revocationRevision",
			"officeRevision",
			"privacyVersion",
			"drains",
			"validForMs",
		]);
		const actual = parseCompanyComputerPreparationCommand(r.command);
		parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId });
		if (
			inspectionId === command.commandId ||
			r.inspectionId !== inspectionId ||
			r.schema !== "qorpera.office-service-stop-challenge/v1" ||
			r.transitionId !== request.revocation.request.transitionId ||
			r.revocationRevision !== request.revocation.revocationRevision ||
			command.bootId !== request.revocation.request.startup.bootId ||
			Object.keys(command).some((key) => actual[key as keyof typeof actual] !== command[key as keyof typeof command])
		)
			throw new Error("binding");
		const drains = parseCompanyComputerLifecycleTransition(
			{ ...request.revocation, drains: r.drains },
			request.revocation.request,
		).drains;
		return Object.freeze({
			schema: r.schema,
			inspectionId,
			command,
			transitionId: r.transitionId,
			revocationRevision: request.revocation.revocationRevision,
			officeRevision: integer(r.officeRevision, request.revocation.revocationRevision),
			privacyVersion: integer(r.privacyVersion, 0),
			drains,
			validForMs: integer(r.validForMs, 1, 5000),
		});
	} catch {
		throw new Error("OFFICE_STOP_CHALLENGE_UNCONFIRMED");
	}
}
export function parseCompanyComputerServiceStopAcknowledgement(
	value: unknown,
	requestValue: CompanyComputerServiceStopRequest,
	commandValue: CompanyComputerPreparationCommand,
): CompanyComputerServiceStopAcknowledgement {
	try {
		const request = parseCompanyComputerServiceStopRequest(requestValue),
			command = parseCompanyComputerPreparationCommand(commandValue);
		const r = record(value, ["schema", "state", "request", "inspection", "acknowledgedAtMs"]);
		const target = parseCompanyComputerLifecycleTransition(
			{ ...request.revocation, request: r.request },
			request.revocation.request,
		).request;
		const inspection = record(r.inspection, ["schema", "inspectionId", "stop", "cgroupState"]);
		const completion = parseCompanyComputerServiceStopCompletion(inspection.stop, command, request);
		if (
			r.schema !== "qorpera.office-service-stop-acknowledgement/v1" ||
			r.state !== "stopped" ||
			typeof inspection.inspectionId !== "string"
		)
			throw new Error("schema");
		return Object.freeze({
			schema: r.schema,
			state: r.state,
			request: target,
			inspection: parseCompanyComputerServiceStopInspection(
				inspection,
				inspection.inspectionId,
				completion,
				request,
			),
			acknowledgedAtMs: integer(r.acknowledgedAtMs, request.revocation.requestedAtMs),
		});
	} catch {
		throw new Error("OFFICE_STOP_ACKNOWLEDGEMENT_UNCONFIRMED");
	}
}
