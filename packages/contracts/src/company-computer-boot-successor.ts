import {
	type CompanyComputerActivationAttestation,
	parseCompanyComputerActivationAttestation,
} from "./company-computer-activation.ts";
import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleRequest,
} from "./company-computer-lifecycle.ts";

/** Explicit reboot/resume on the retained VM and workbench. Persist this
 * request only after independently proving VM shutdown, new boot and protected
 * history/configuration. Metadata is not physical boot or work authority. */
export interface CompanyComputerBootSuccessorRequest {
	readonly schema: "qorpera.office-boot-successor-request/v1";
	readonly bootIntentId: string;
	readonly predecessor: CompanyComputerLifecycleRequest;
	readonly attestation: CompanyComputerActivationAttestation;
	readonly stopHistorySha256: string;
	readonly powerOffCompletionSha256: string;
	readonly bootObservationSha256: string;
}
export interface CompanyComputerBootSuccessor {
	readonly schema: "qorpera.office-boot-successor/v1";
	readonly request: CompanyComputerBootSuccessorRequest;
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
export function parseCompanyComputerBootSuccessorRequest(
	value: unknown,
): Readonly<CompanyComputerBootSuccessorRequest> {
	try {
		const r = record(value, [
			"schema",
			"bootIntentId",
			"predecessor",
			"attestation",
			"stopHistorySha256",
			"powerOffCompletionSha256",
			"bootObservationSha256",
		]);
		const predecessor = parseCompanyComputerLifecycleRequest(r.predecessor),
			attestation = parseCompanyComputerActivationAttestation(r.attestation);
		if (
			r.schema !== "qorpera.office-boot-successor-request/v1" ||
			typeof r.bootIntentId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.bootIntentId) ||
			!["reboot", "power_off"].includes(predecessor.action) ||
			attestation.activationId === predecessor.activationId ||
			attestation.bootId === predecessor.startup.bootId ||
			attestation.configurationSha256 === predecessor.startup.configurationSha256 ||
			new TextEncoder().encode(JSON.stringify(value)).length > 65536
		)
			throw new Error("binding");
		for (const key of ["stopHistorySha256", "powerOffCompletionSha256", "bootObservationSha256"] as const)
			if (typeof r[key] !== "string" || !/^[0-9a-f]{64}$/.test(r[key])) throw new Error("history");
		return Object.freeze({
			schema: r.schema,
			bootIntentId: r.bootIntentId,
			predecessor,
			attestation,
			stopHistorySha256: r.stopHistorySha256 as string,
			powerOffCompletionSha256: r.powerOffCompletionSha256 as string,
			bootObservationSha256: r.bootObservationSha256 as string,
		});
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_SUCCESSOR_REQUEST");
	}
}
export function parseCompanyComputerBootSuccessor(
	value: unknown,
	expected: CompanyComputerBootSuccessorRequest,
): Readonly<CompanyComputerBootSuccessor> {
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
		const request = parseCompanyComputerBootSuccessorRequest(r.request),
			target = parseCompanyComputerBootSuccessorRequest(expected);
		if (
			r.schema !== "qorpera.office-boot-successor/v1" ||
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
		return Object.freeze({ ...r, request }) as unknown as CompanyComputerBootSuccessor;
	} catch {
		throw new Error("OFFICE_BOOT_SUCCESSOR_UNCONFIRMED");
	}
}
