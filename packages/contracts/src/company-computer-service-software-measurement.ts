import {
	type CompanyComputerStartupIdentity,
	parseCompanyComputerStartupIdentity,
} from "./company-computer-activation.ts";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	type CompanyComputerServiceSoftwareArtifact,
} from "./company-computer-service-software.ts";
import { COMPANY_COMPUTER_SERVICE_CGROUP } from "./company-computer-service-stop.ts";

/** Fresh SQL challenge data, never the provider capability itself. validForMs
 * is the remaining original deadline, not permission to start a new timer. */
export interface CompanyComputerServiceSoftwareInvocationChallenge {
	readonly schema: "qorpera.office-software-invocation-challenge/v1";
	readonly challengeId: string;
	readonly activationId: string;
	readonly startup: Readonly<CompanyComputerStartupIdentity>;
	readonly revision: number;
	readonly capabilityRevision: number;
	readonly service: CompanyComputerServiceSoftwareArtifact;
	readonly validForMs: number;
}
/** Independent root observation only; final SQL acknowledgement/admission and
 * the provider's original challenge deadline remain separate requirements. */
export interface CompanyComputerServiceSoftwareInvocationEvidence {
	readonly schema: "qorpera.office-software-invocation-evidence/v1";
	readonly challengeId: string;
	readonly activationId: string;
	readonly startup: Readonly<CompanyComputerStartupIdentity>;
	readonly revision: number;
	readonly capabilityRevision: number;
	readonly service: CompanyComputerServiceSoftwareArtifact;
	readonly mainPid: number;
	readonly controlGroup: typeof COMPANY_COMPUTER_SERVICE_CGROUP;
	readonly configurationCompletionSha256: string;
	readonly serviceStartCompletionSha256: string;
}
function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
		throw new Error("record");
	const names = Reflect.ownKeys(value);
	if (names.some((key) => typeof key !== "string") || names.sort().join() !== keys) throw new Error("fields");
	const result: Record<string, unknown> = {};
	for (const key of names as string[]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("accessor");
		result[key] = descriptor.value;
	}
	return result;
}
function integer(value: unknown, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("number");
	return value as number;
}
function matched(value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("identity");
	return value;
}
const sha = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function binding(value: Record<string, unknown>) {
	const input = record(
		value.startup,
		"allocationId,bootId,bootstrapSha256,computerGeneration,configurationSha256,imageSha256,instanceSha256,scope,serviceInvocationId",
	);
	const startup = parseCompanyComputerStartupIdentity({
		...input,
		scope: record(input.scope, "companyComputerId,companyId,environmentId,logicalComputerId"),
	});
	const service = record(value.service, "bytes,path,sha256");
	if (service.path !== COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH) throw new Error("path");
	return {
		challengeId: matched(value.challengeId, uuid),
		activationId: matched(value.activationId, uuid),
		startup,
		revision: integer(value.revision, 0, 9007199254740990),
		capabilityRevision: integer(value.capabilityRevision, 1, 9007199254740990),
		service: Object.freeze({
			path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
			bytes: integer(service.bytes, 1, 32 * 1024 ** 2),
			sha256: matched(service.sha256, sha),
		}),
	};
}
/** Deterministic UTF-8 JSON text used for command and evidence SHA256 binding.
 * Callers must pass parsed challenge/evidence values; no capability is included. */
export function companyComputerServiceSoftwareMeasurementText(
	value: CompanyComputerServiceSoftwareInvocationChallenge | CompanyComputerServiceSoftwareInvocationEvidence,
): string {
	const sorted = (value: unknown): unknown =>
		value && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([key, item]) => [key, sorted(item)]),
				)
			: value;
	return `${JSON.stringify(sorted(value))}\n`;
}
export function parseCompanyComputerServiceSoftwareInvocationChallenge(
	value: unknown,
): Readonly<CompanyComputerServiceSoftwareInvocationChallenge> {
	try {
		const v = record(value, "activationId,capabilityRevision,challengeId,revision,schema,service,startup,validForMs");
		if (v.schema !== "qorpera.office-software-invocation-challenge/v1") throw new Error("schema");
		return Object.freeze({ schema: v.schema, ...binding(v), validForMs: integer(v.validForMs, 1, 5000) });
	} catch {
		throw new Error("INVALID_OFFICE_SOFTWARE_INVOCATION_CHALLENGE");
	}
}
export function parseCompanyComputerServiceSoftwareInvocationEvidence(
	value: unknown,
	expected: CompanyComputerServiceSoftwareInvocationChallenge,
): Readonly<CompanyComputerServiceSoftwareInvocationEvidence> {
	try {
		const v = record(
			value,
			"activationId,capabilityRevision,challengeId,configurationCompletionSha256,controlGroup,mainPid,revision,schema,service,serviceStartCompletionSha256,startup",
		);
		const parsed = binding(v),
			challenge = parseCompanyComputerServiceSoftwareInvocationChallenge(expected);
		const { schema: _schema, validForMs: _remaining, ...expectedBinding } = challenge;
		if (
			JSON.stringify(parsed) !== JSON.stringify(binding(expectedBinding)) ||
			v.schema !== "qorpera.office-software-invocation-evidence/v1" ||
			v.controlGroup !== COMPANY_COMPUTER_SERVICE_CGROUP
		)
			throw new Error("binding");
		return Object.freeze({
			schema: v.schema,
			...parsed,
			mainPid: integer(v.mainPid, 1, 2147483647),
			controlGroup: COMPANY_COMPUTER_SERVICE_CGROUP,
			configurationCompletionSha256: matched(v.configurationCompletionSha256, sha),
			serviceStartCompletionSha256: matched(v.serviceStartCompletionSha256, sha),
		});
	} catch {
		throw new Error("INVALID_OFFICE_SOFTWARE_INVOCATION_EVIDENCE");
	}
}
