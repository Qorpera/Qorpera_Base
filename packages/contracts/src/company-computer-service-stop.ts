import {
	type CompanyComputerLifecycleTransition,
	parseCompanyComputerLifecycleTransition,
} from "./company-computer-lifecycle.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";

export const COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES = 65536;
export const COMPANY_COMPUTER_SERVICE_CGROUP = "/system.slice/qorpera-company-computer.service";
export interface CompanyComputerServiceStopRequest {
	readonly schema: "qorpera.office-service-stop-request/v1";
	readonly revocation: CompanyComputerLifecycleTransition;
	readonly startCompletionSha256: string;
}
/** Historical physical stop evidence. A provider must still issue and verify
 * a fresh inspection before acknowledging shutdown or preparing a successor. */
export interface CompanyComputerServiceStopCompletion {
	readonly schema: "qorpera.office-service-stop-completion/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly transitionId: string;
	readonly activationId: string;
	readonly revocationRevision: number;
	readonly configurationSha256: string;
	readonly startCompletionSha256: string;
	readonly fromServiceInvocationId: string;
	readonly observedInvocationId: string | null;
	readonly stoppedInvocationId: string | null;
	readonly controlGroup: typeof COMPANY_COMPUTER_SERVICE_CGROUP;
	readonly cgroupState: "absent" | "empty";
}
export interface CompanyComputerServiceStopInspection {
	readonly schema: "qorpera.office-service-stop-inspection/v1";
	readonly inspectionId: string;
	readonly stop: CompanyComputerServiceStopCompletion;
	readonly cgroupState: "absent" | "empty";
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
export function parseCompanyComputerServiceStopRequest(value: unknown): Readonly<CompanyComputerServiceStopRequest> {
	try {
		const input = record(value, ["schema", "revocation", "startCompletionSha256"]);
		if (
			input.schema !== "qorpera.office-service-stop-request/v1" ||
			typeof input.startCompletionSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(input.startCompletionSha256) ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES
		)
			throw new Error("schema");
		const revocation = input.revocation as CompanyComputerLifecycleTransition;
		return Object.freeze({
			schema: input.schema,
			startCompletionSha256: input.startCompletionSha256,
			revocation: parseCompanyComputerLifecycleTransition(revocation, revocation.request),
		});
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_STOP_REQUEST");
	}
}
export function parseCompanyComputerServiceStopCompletion(
	value: unknown,
	expectedCommand: CompanyComputerPreparationCommand,
	expectedRequest: CompanyComputerServiceStopRequest,
): Readonly<CompanyComputerServiceStopCompletion> {
	try {
		const input = record(value, [
			"schema",
			"command",
			"transitionId",
			"activationId",
			"revocationRevision",
			"configurationSha256",
			"startCompletionSha256",
			"fromServiceInvocationId",
			"observedInvocationId",
			"stoppedInvocationId",
			"controlGroup",
			"cgroupState",
		]);
		const command = parseCompanyComputerPreparationCommand(input.command),
			target = parseCompanyComputerPreparationCommand(expectedCommand),
			request = parseCompanyComputerServiceStopRequest(expectedRequest);
		if (
			command.commandId !== target.commandId ||
			command.requestSha256 !== target.requestSha256 ||
			command.bootId !== target.bootId ||
			command.bootId !== request.revocation.request.startup.bootId ||
			input.schema !== "qorpera.office-service-stop-completion/v1" ||
			input.transitionId !== request.revocation.request.transitionId ||
			input.activationId !== request.revocation.request.activationId ||
			input.revocationRevision !== request.revocation.revocationRevision ||
			input.configurationSha256 !== request.revocation.request.startup.configurationSha256 ||
			input.startCompletionSha256 !== request.startCompletionSha256 ||
			input.fromServiceInvocationId !== request.revocation.request.startup.serviceInvocationId ||
			input.controlGroup !== COMPANY_COMPUTER_SERVICE_CGROUP ||
			!["absent", "empty"].includes(input.cgroupState as string)
		)
			throw new Error("binding");
		for (const id of [input.observedInvocationId, input.stoppedInvocationId])
			if (id !== null && (typeof id !== "string" || !/^(?!0{32}$)[0-9a-f]{32}$/.test(id)))
				throw new Error("invocation");
		return Object.freeze({ ...input, command }) as unknown as CompanyComputerServiceStopCompletion;
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_STOP_COMPLETION");
	}
}
export function parseCompanyComputerServiceStopInspection(
	value: unknown,
	inspectionId: string,
	completion: CompanyComputerServiceStopCompletion,
	request: CompanyComputerServiceStopRequest,
): Readonly<CompanyComputerServiceStopInspection> {
	try {
		const expected = parseCompanyComputerServiceStopCompletion(completion, completion.command, request),
			input = record(value, ["schema", "inspectionId", "stop", "cgroupState"]);
		const nonce = parseCompanyComputerPreparationCommand({ ...expected.command, commandId: inspectionId });
		const stop = parseCompanyComputerServiceStopCompletion(input.stop, expected.command, request);
		if (
			nonce.commandId === expected.command.commandId ||
			input.schema !== "qorpera.office-service-stop-inspection/v1" ||
			input.inspectionId !== inspectionId ||
			!["absent", "empty"].includes(input.cgroupState as string) ||
			Object.keys(expected).some(
				(key) => key !== "command" && stop[key as keyof typeof stop] !== expected[key as keyof typeof expected],
			)
		)
			throw new Error("binding");
		return Object.freeze({
			schema: input.schema,
			inspectionId,
			stop,
			cgroupState: input.cgroupState,
		}) as CompanyComputerServiceStopInspection;
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_STOP_INSPECTION");
	}
}
