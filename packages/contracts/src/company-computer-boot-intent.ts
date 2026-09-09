import {
	type CompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleRequest,
} from "./company-computer-lifecycle.ts";

/** Explicit reboot/resume intent on the retained allocation. Persist before
 * preparation, after independently verifying shutdown and protected history.
 * No future boot ID/configuration is invented. The later boot handoff must
 * bind this identity, planned activation and both retained evidence digests. */
export interface CompanyComputerBootIntentRequest {
	readonly schema: "qorpera.office-boot-intent-request/v1";
	readonly bootIntentId: string;
	readonly activationId: string;
	readonly predecessor: CompanyComputerLifecycleRequest;
	readonly stopHistorySha256: string;
	readonly powerOffCompletionSha256: string;
}
/** Immutable metadata. admitted means the post-boot handoff exists, not that
 * the ordinary service is active. Neither state grants VM dispatch authority. */
export interface CompanyComputerBootIntent {
	readonly schema: "qorpera.office-boot-intent/v1";
	readonly request: CompanyComputerBootIntentRequest;
	readonly state: "prepared" | "admitted";
	readonly stopAcknowledgedAtMs: number;
	readonly officeRevision: number;
	readonly privacyVersion: number;
	readonly validForMs: 5000;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
export function parseCompanyComputerBootIntentRequest(value: unknown): Readonly<CompanyComputerBootIntentRequest> {
	try {
		const r = record(value, [
			"schema",
			"bootIntentId",
			"activationId",
			"predecessor",
			"stopHistorySha256",
			"powerOffCompletionSha256",
		]);
		const predecessor = parseCompanyComputerLifecycleRequest(r.predecessor);
		if (
			r.schema !== "qorpera.office-boot-intent-request/v1" ||
			!["reboot", "power_off"].includes(predecessor.action) ||
			r.activationId === predecessor.activationId ||
			new TextEncoder().encode(JSON.stringify(value)).length > 65536
		)
			throw new Error("binding");
		for (const key of ["bootIntentId", "activationId"] as const)
			if (typeof r[key] !== "string" || !UUID.test(r[key])) throw new Error("identity");
		for (const key of ["stopHistorySha256", "powerOffCompletionSha256"] as const)
			if (typeof r[key] !== "string" || !/^[0-9a-f]{64}$/.test(r[key])) throw new Error("history");
		return Object.freeze({ ...r, predecessor }) as unknown as CompanyComputerBootIntentRequest;
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_INTENT_REQUEST");
	}
}
export function parseCompanyComputerBootIntent(
	value: unknown,
	expected: CompanyComputerBootIntentRequest,
): Readonly<CompanyComputerBootIntent> {
	try {
		const r = record(value, [
			"schema",
			"request",
			"state",
			"stopAcknowledgedAtMs",
			"officeRevision",
			"privacyVersion",
			"validForMs",
		]);
		const request = parseCompanyComputerBootIntentRequest(r.request),
			target = parseCompanyComputerBootIntentRequest(expected);
		if (
			r.schema !== "qorpera.office-boot-intent/v1" ||
			!equal(request, target) ||
			!["prepared", "admitted"].includes(r.state as string) ||
			r.validForMs !== 5000
		)
			throw new Error("state");
		for (const [key, minimum] of [
			["stopAcknowledgedAtMs", 1],
			["officeRevision", 1],
			["privacyVersion", 0],
		] as const)
			if (!Number.isSafeInteger(r[key]) || (r[key] as number) < minimum) throw new Error("number");
		return Object.freeze({ ...r, request }) as unknown as CompanyComputerBootIntent;
	} catch {
		throw new Error("OFFICE_BOOT_INTENT_UNCONFIRMED");
	}
}
