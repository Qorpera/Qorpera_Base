import {
	type CompanyComputerActivationAttestation,
	parseCompanyComputerActivationAttestation,
} from "./company-computer-activation.ts";
import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleRequest,
} from "./company-computer-lifecycle.ts";

/** Persist before requesting SQL preparation. Same VM/boot/configuration,
 * distinct activation; root start and physical inspection are separate. */
export interface CompanyComputerServiceSuccessorRequest {
	readonly schema: "qorpera.office-service-successor-request/v1";
	readonly predecessor: CompanyComputerLifecycleRequest;
	readonly attestation: CompanyComputerActivationAttestation;
}
export interface CompanyComputerServiceSuccessor {
	readonly schema: "qorpera.office-service-successor/v1";
	readonly request: CompanyComputerServiceSuccessorRequest;
	readonly state: "prepared" | "ready" | "active";
	readonly serviceInvocationId: string | null;
	readonly readinessFresh: boolean;
	readonly stopAcknowledgedAtMs: number;
	readonly officeRevision: number;
	readonly privacyVersion: number;
	readonly validForMs: 5000;
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
export function parseCompanyComputerServiceSuccessorRequest(
	value: unknown,
): Readonly<CompanyComputerServiceSuccessorRequest> {
	try {
		const r = record(value, ["schema", "predecessor", "attestation"]);
		const predecessor = parseCompanyComputerLifecycleRequest(r.predecessor),
			attestation = parseCompanyComputerActivationAttestation(r.attestation);
		if (
			r.schema !== "qorpera.office-service-successor-request/v1" ||
			predecessor.action !== "service_restart" ||
			attestation.activationId === predecessor.activationId ||
			attestation.bootId !== predecessor.startup.bootId ||
			attestation.configurationSha256 !== predecessor.startup.configurationSha256 ||
			new TextEncoder().encode(JSON.stringify(value)).length > 65536
		)
			throw new Error("binding");
		return Object.freeze({ schema: r.schema, predecessor, attestation });
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_SUCCESSOR_REQUEST");
	}
}
export function parseCompanyComputerServiceSuccessor(
	value: unknown,
	expected: CompanyComputerServiceSuccessorRequest,
): Readonly<CompanyComputerServiceSuccessor> {
	try {
		const r = record(value, [
			"schema",
			"request",
			"state",
			"serviceInvocationId",
			"readinessFresh",
			"stopAcknowledgedAtMs",
			"officeRevision",
			"privacyVersion",
			"validForMs",
		]);
		const request = parseCompanyComputerServiceSuccessorRequest(r.request),
			target = parseCompanyComputerServiceSuccessorRequest(expected);
		if (
			r.schema !== "qorpera.office-service-successor/v1" ||
			!equal(request, target) ||
			!["prepared", "ready", "active"].includes(r.state as string) ||
			typeof r.readinessFresh !== "boolean" ||
			r.validForMs !== 5000 ||
			(r.state === "prepared"
				? r.serviceInvocationId !== null || r.readinessFresh
				: typeof r.serviceInvocationId !== "string" ||
					!/^(?!0{32}$)[0-9a-f]{32}$/.test(r.serviceInvocationId) ||
					r.serviceInvocationId === request.predecessor.startup.serviceInvocationId)
		)
			throw new Error("state");
		for (const [key, minimum] of [
			["stopAcknowledgedAtMs", 1],
			["officeRevision", 1],
			["privacyVersion", 0],
		] as const)
			if (!Number.isSafeInteger(r[key]) || (r[key] as number) < minimum) throw new Error("number");
		return Object.freeze({ ...r, request }) as unknown as CompanyComputerServiceSuccessor;
	} catch {
		throw new Error("OFFICE_SERVICE_SUCCESSOR_UNCONFIRMED");
	}
}
