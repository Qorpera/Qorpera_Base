import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
} from "./cloud-company-computer-contract.ts";

export interface CompanyComputerPrivacyChallenge {
	scope: CompanyComputerScope;
	computerGeneration: number;
	challengeId: string;
	version: number;
	state: "entering" | "leaving";
	memberId: string;
	profileId: string;
	profileVersion: number;
	screenId: string;
	drains: { state: "draining"; drainId: string; epoch: number; binding: CompanyComputerScreenBinding }[];
}

function positive(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
function keys(value: unknown, expected: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== expected) {
		throw new Error("INVALID_OFFICE_PRIVACY_CHALLENGE");
	}
}

/** Closed metadata only. A challenge never contains URLs, keystrokes, cookies,
 * passwords or screenshot bytes, and does not itself authorize private input. */
export function parseCompanyComputerPrivacyChallenge(
	value: unknown,
	scope: CompanyComputerScope,
): CompanyComputerPrivacyChallenge {
	value = structuredClone(value);
	keys(value, "challengeId,computerGeneration,drains,memberId,profileId,profileVersion,scope,screenId,state,version");
	keys(value.scope, "companyComputerId,companyId,environmentId,logicalComputerId");
	assertCompanyComputerScope(value.scope as unknown as CompanyComputerScope, scope);
	if (
		(value.state !== "entering" && value.state !== "leaving") ||
		![value.challengeId, value.memberId, value.profileId, value.screenId].every(
			(id) => typeof id === "string" && COMPANY_COMPUTER_UUID.test(id),
		) ||
		![value.computerGeneration, value.profileVersion, value.version].every(positive) ||
		!Array.isArray(value.drains) ||
		value.drains.length < 1 ||
		value.drains.length > 32
	) {
		throw new Error("INVALID_OFFICE_PRIVACY_CHALLENGE");
	}
	const screens = new Set<string>();
	const ordinals = new Set<number>();
	const drainIds = new Set<string>();
	for (const drain of value.drains) {
		keys(drain, "binding,drainId,epoch,state");
		keys(
			drain.binding,
			"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId",
		);
		const binding = drain.binding as unknown as CompanyComputerScreenBinding;
		assertCompanyComputerScope(binding, scope);
		assertCompanyComputerScreenBinding(binding, binding);
		if (
			drain.state !== "draining" ||
			typeof drain.drainId !== "string" ||
			!COMPANY_COMPUTER_UUID.test(drain.drainId) ||
			!positive(drain.epoch) ||
			binding.computerGeneration !== value.computerGeneration ||
			screens.has(binding.screenId) ||
			ordinals.has(binding.screenOrdinal) ||
			drainIds.has(drain.drainId)
		) {
			throw new Error("INVALID_OFFICE_PRIVACY_CHALLENGE");
		}
		screens.add(binding.screenId);
		ordinals.add(binding.screenOrdinal);
		drainIds.add(drain.drainId);
	}
	if (!screens.has(value.screenId as string)) throw new Error("INVALID_OFFICE_PRIVACY_CHALLENGE");
	return value as unknown as CompanyComputerPrivacyChallenge;
}
