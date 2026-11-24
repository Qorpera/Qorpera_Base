import {
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
} from "./cloud-company-computer-contract.ts";

export interface CompanyComputerStartIntent {
	schema: "qorpera.office-start-intent/v1";
	intentId: string;
	companyComputerId: string;
	computerGeneration: number;
	state: "requested" | "reserved" | "cancelled";
}
/** Server-owned maintenance distinguishes idle rest from host recovery. */
export interface CompanyComputerMaintenance {
	reason: "host_reboot" | "idle";
	state: "requested" | "resumed" | "activated";
	transitionId: string;
	requestedAt: string;
	resumedAt: string | null;
	activatedAt: string | null;
}
export function parseCompanyComputerMaintenance(value: unknown): CompanyComputerMaintenance | null {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_OFFICE_MAINTENANCE");
	const r = value as Record<string, unknown>;
	if (
		Object.keys(r).sort().join() !== "activatedAt,reason,requestedAt,resumedAt,state,transitionId" ||
		(r.reason !== "host_reboot" && r.reason !== "idle") ||
		!["requested", "resumed", "activated"].includes(r.state as string) ||
		typeof r.transitionId !== "string" ||
		typeof r.requestedAt !== "string" ||
		(r.resumedAt !== null && typeof r.resumedAt !== "string") ||
		(r.activatedAt !== null && typeof r.activatedAt !== "string")
	)
		throw new Error("INVALID_OFFICE_MAINTENANCE");
	return {
		reason: r.reason,
		state: r.state as CompanyComputerMaintenance["state"],
		transitionId: r.transitionId,
		requestedAt: r.requestedAt,
		resumedAt: r.resumedAt as string | null,
		activatedAt: r.activatedAt as string | null,
	};
}

function record(value: unknown, expected: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== expected)
		throw new Error("INVALID_OFFICE_START_RESPONSE");
}
function generation(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("INVALID_OFFICE_START_GENERATION");
}
export function parseCompanyComputerStartIntent(
	value: unknown,
	scope: CompanyComputerScope,
	computerGeneration: number,
): CompanyComputerStartIntent {
	assertCompanyComputerScope(scope, scope);
	generation(computerGeneration);
	record(value, "companyComputerId,computerGeneration,intentId,schema,state");
	if (
		value.schema !== "qorpera.office-start-intent/v1" ||
		value.companyComputerId !== scope.companyComputerId ||
		value.computerGeneration !== computerGeneration ||
		typeof value.intentId !== "string" ||
		!COMPANY_COMPUTER_UUID.test(value.intentId) ||
		!["requested", "reserved", "cancelled"].includes(value.state as string)
	)
		throw new Error("INVALID_OFFICE_START_RESPONSE");
	return structuredClone(value) as unknown as CompanyComputerStartIntent;
}
