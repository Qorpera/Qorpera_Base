import {
	type CompanyComputerStartupIdentity,
	parseCompanyComputerStartupIdentity,
} from "./company-computer-activation.ts";
import type { CompanyComputerLifecycleDrain } from "./company-computer-lifecycle.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";

export const COMPANY_COMPUTER_OUTAGE_TERMINATION_MAX_BYTES = 65536;

export interface CompanyComputerOutageRecoveryRequest {
	readonly schema: "qorpera.office-outage-recovery-request/v1";
	readonly recoveryId: string;
	readonly outageRequestId: string;
	readonly activationId: string;
	readonly startCommandId: string;
}
export interface CompanyComputerOutagePredecessor {
	readonly activationId: string;
	readonly providerId: string;
	readonly providerPolicySha256: string;
	readonly startup: CompanyComputerStartupIdentity;
}
/** Immutable held-state snapshot. This is neither dispatch authority nor a
 * clean service-stop acknowledgement; a separate fresh check gates dispatch. */
export interface CompanyComputerOutageRecovery {
	readonly schema: "qorpera.office-outage-recovery/v1";
	readonly request: CompanyComputerOutageRecoveryRequest;
	readonly predecessor: CompanyComputerOutagePredecessor;
	readonly state: "prepared";
	readonly officeRevision: number;
	readonly privacyState: "shared" | "entering" | "private" | "leaving";
	readonly privacyVersion: number;
	readonly privacyChallenge: Readonly<Record<string, unknown>> | null;
	readonly drains: readonly CompanyComputerLifecycleDrain[];
}
export interface CompanyComputerOutageRecoveryAuthority {
	readonly schema: "qorpera.office-outage-recovery-authority/v1";
	readonly recovery: CompanyComputerOutageRecovery;
	readonly validForMs: 5000;
}
export interface CompanyComputerOutageResumeObservation {
	readonly schema: "qorpera.lxd-office-outage-resume-observation/v1";
	readonly intentId: string;
	readonly allocationId: string;
	readonly recoveryId: string;
	readonly activationId: string;
	readonly startCommandId: string;
	readonly requestSha256: string;
	readonly hostBootId: string;
	readonly bootId: string;
	readonly instanceSha256: string;
	readonly physicalInstanceId: string;
	readonly operationId: string;
}
export interface CompanyComputerOutageTerminationChallengeRequest {
	readonly recovery: CompanyComputerOutageRecoveryRequest;
	readonly inspectionId: string;
	readonly observation: CompanyComputerOutageResumeObservation;
	readonly bootObservationSha256: string;
}
export interface CompanyComputerOutageTerminationChallenge {
	readonly schema: "qorpera.office-outage-termination-challenge/v1";
	readonly request: CompanyComputerOutageTerminationChallengeRequest;
	readonly recovery: CompanyComputerOutageRecovery;
	readonly validForMs: number;
}
export interface CompanyComputerOutageTerminationRequest {
	readonly schema: "qorpera.office-outage-termination-request/v1";
	readonly challenge: CompanyComputerOutageTerminationChallenge;
	readonly originPreparationSha256: string;
}
export interface CompanyComputerOutageTerminationInspection {
	readonly schema: "qorpera.office-outage-termination-inspection/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly inspectionId: string;
	readonly recoveryId: string;
	readonly startCommandId: string;
	readonly bootId: string;
	readonly hostBootId: string;
	readonly physicalInstanceId: string;
	readonly bootObservationSha256: string;
	readonly originPreparationSha256: string;
	readonly originAdoptionReceiptSha256: string;
	readonly predecessorConfigurationSha256: string;
	readonly predecessorAdoptionReceiptSha256: string;
	readonly cgroupState: "absent" | "empty";
	readonly preparationState: "unstarted";
	readonly serviceState: "unstarted";
}
export interface CompanyComputerOutageTerminationAcknowledgement {
	readonly schema: "qorpera.office-outage-termination-acknowledgement/v1";
	readonly request: {
		readonly recovery: CompanyComputerOutageRecoveryRequest;
		readonly inspection: CompanyComputerOutageTerminationInspection;
	};
	readonly officeRevision: number;
	readonly acknowledgedAtMs: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys.sort().join() ||
		new TextEncoder().encode(JSON.stringify(value)).length > 65536
	)
		throw new Error("INVALID_OFFICE_OUTAGE_RECORD");
	return value as Record<string, unknown>;
}
function pattern(value: unknown, regex = UUID): string {
	if (typeof value !== "string" || !regex.test(value)) throw new Error("INVALID_OFFICE_OUTAGE_IDENTITY");
	return value;
}
function number(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
		throw new Error("INVALID_OFFICE_OUTAGE_NUMBER");
	return value as number;
}
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const x = a as Record<string, unknown>,
		y = b as Record<string, unknown>;
	return (
		Object.keys(x).sort().join() === Object.keys(y).sort().join() &&
		Object.keys(x).every((key) => same(x[key], y[key]))
	);
}
export function parseCompanyComputerOutageRecoveryRequest(
	value: unknown,
): Readonly<CompanyComputerOutageRecoveryRequest> {
	const r = record(value, ["schema", "recoveryId", "outageRequestId", "activationId", "startCommandId"]);
	if (r.schema !== "qorpera.office-outage-recovery-request/v1")
		throw new Error("INVALID_OFFICE_OUTAGE_RECOVERY_REQUEST");
	for (const key of ["recoveryId", "outageRequestId", "activationId", "startCommandId"]) pattern(r[key]);
	if (new Set([r.recoveryId, r.outageRequestId, r.activationId, r.startCommandId]).size !== 4)
		throw new Error("INVALID_OFFICE_OUTAGE_RECOVERY_IDENTITY");
	return Object.freeze({ ...r }) as unknown as CompanyComputerOutageRecoveryRequest;
}
export function parseCompanyComputerOutagePredecessor(value: unknown): Readonly<CompanyComputerOutagePredecessor> {
	const r = record(value, ["activationId", "providerId", "providerPolicySha256", "startup"]);
	return Object.freeze({
		activationId: pattern(r.activationId),
		providerId: pattern(r.providerId),
		providerPolicySha256: pattern(r.providerPolicySha256, SHA),
		startup: parseCompanyComputerStartupIdentity(r.startup),
	});
}
export function parseCompanyComputerOutageRecovery(
	value: unknown,
	expected: CompanyComputerOutageRecoveryRequest,
): Readonly<CompanyComputerOutageRecovery> {
	const r = record(value, [
			"schema",
			"request",
			"predecessor",
			"state",
			"officeRevision",
			"privacyState",
			"privacyVersion",
			"privacyChallenge",
			"drains",
		]),
		request = parseCompanyComputerOutageRecoveryRequest(r.request),
		predecessor = parseCompanyComputerOutagePredecessor(r.predecessor);
	if (
		r.schema !== "qorpera.office-outage-recovery/v1" ||
		r.state !== "prepared" ||
		!same(request, parseCompanyComputerOutageRecoveryRequest(expected)) ||
		request.activationId === predecessor.activationId ||
		!["shared", "entering", "private", "leaving"].includes(r.privacyState as string) ||
		!Array.isArray(r.drains) ||
		r.drains.length > 32 ||
		(r.privacyChallenge !== null &&
			(!r.privacyChallenge ||
				typeof r.privacyChallenge !== "object" ||
				Array.isArray(r.privacyChallenge) ||
				Object.getPrototypeOf(r.privacyChallenge) !== Object.prototype))
	)
		throw new Error("OFFICE_OUTAGE_RECOVERY_UNCONFIRMED");
	number(r.officeRevision);
	number(r.privacyVersion, 0);
	const screens = new Set<string>(),
		challenges = new Set<string>(),
		staff = new Set<string>();
	let ordinal = 0;
	const drains = r.drains.map((value) => {
		const d = record(value, ["state", "drainId", "epoch", "binding"]),
			b = record(d.binding, [
				"companyId",
				"environmentId",
				"companyComputerId",
				"logicalComputerId",
				"computerGeneration",
				"screenId",
				"screenOrdinal",
				"screenGeneration",
				"staffAgentId",
			]);
		pattern(d.drainId);
		pattern(b.screenId);
		pattern(b.staffAgentId);
		number(d.epoch);
		number(b.screenGeneration);
		number(b.screenOrdinal, 1, 32);
		if (
			d.state !== "draining" ||
			b.computerGeneration !== predecessor.startup.computerGeneration ||
			(b.screenOrdinal as number) <= ordinal ||
			screens.has(b.screenId as string) ||
			staff.has(b.staffAgentId as string) ||
			challenges.has(d.drainId as string) ||
			Object.entries(predecessor.startup.scope).some(([key, value]) => b[key] !== value)
		)
			throw new Error("OFFICE_OUTAGE_DRAIN_DIFFERS");
		ordinal = b.screenOrdinal as number;
		screens.add(b.screenId as string);
		challenges.add(d.drainId as string);
		staff.add(b.staffAgentId as string);
		return Object.freeze({ ...d, binding: Object.freeze({ ...b }) }) as unknown as CompanyComputerLifecycleDrain;
	});
	return Object.freeze({
		...r,
		request,
		predecessor,
		drains: Object.freeze(drains),
		privacyChallenge:
			r.privacyChallenge === null
				? null
				: Object.freeze(JSON.parse(JSON.stringify(r.privacyChallenge)) as Record<string, unknown>),
	}) as unknown as CompanyComputerOutageRecovery;
}
export function parseCompanyComputerOutageRecoveryAuthority(
	value: unknown,
	expected: CompanyComputerOutageRecoveryRequest,
): Readonly<CompanyComputerOutageRecoveryAuthority> {
	const r = record(value, ["schema", "recovery", "validForMs"]);
	if (r.schema !== "qorpera.office-outage-recovery-authority/v1" || r.validForMs !== 5000)
		throw new Error("OFFICE_OUTAGE_AUTHORITY_UNCONFIRMED");
	return Object.freeze({
		schema: r.schema,
		recovery: parseCompanyComputerOutageRecovery(r.recovery, expected),
		validForMs: 5000,
	});
}
export function parseCompanyComputerOutageResumeObservation(
	value: unknown,
	recovery: CompanyComputerOutageRecovery,
): Readonly<CompanyComputerOutageResumeObservation> {
	const r = record(value, [
			"schema",
			"intentId",
			"allocationId",
			"recoveryId",
			"activationId",
			"startCommandId",
			"requestSha256",
			"hostBootId",
			"bootId",
			"instanceSha256",
			"physicalInstanceId",
			"operationId",
		]),
		target = parseCompanyComputerOutageRecovery(recovery, recovery.request);
	for (const key of [
		"intentId",
		"allocationId",
		"recoveryId",
		"activationId",
		"startCommandId",
		"hostBootId",
		"bootId",
		"physicalInstanceId",
		"operationId",
	])
		pattern(r[key]);
	pattern(r.requestSha256, SHA);
	pattern(r.instanceSha256, SHA);
	if (
		r.schema !== "qorpera.lxd-office-outage-resume-observation/v1" ||
		r.recoveryId !== target.request.recoveryId ||
		r.activationId !== target.request.activationId ||
		r.startCommandId !== target.request.startCommandId ||
		r.allocationId !== target.predecessor.startup.allocationId ||
		r.instanceSha256 !== target.predecessor.startup.instanceSha256 ||
		r.bootId === target.predecessor.startup.bootId
	)
		throw new Error("OFFICE_OUTAGE_OBSERVATION_DIFFERS");
	return Object.freeze({ ...r }) as unknown as CompanyComputerOutageResumeObservation;
}
export function companyComputerOutageResumeObservationCanonical(
	value: CompanyComputerOutageResumeObservation,
	recovery: CompanyComputerOutageRecovery,
): string {
	const parsed = parseCompanyComputerOutageResumeObservation(value, recovery);
	return JSON.stringify(parsed, Object.keys(parsed).sort());
}
export function parseCompanyComputerOutageTerminationChallenge(
	value: unknown,
	expected?: CompanyComputerOutageTerminationChallengeRequest,
): Readonly<CompanyComputerOutageTerminationChallenge> {
	const r = record(value, ["schema", "request", "recovery", "validForMs"]),
		q = record(r.request, ["recovery", "inspectionId", "observation", "bootObservationSha256"]),
		request = parseCompanyComputerOutageRecoveryRequest(q.recovery),
		recovery = parseCompanyComputerOutageRecovery(r.recovery, request),
		parsed = {
			recovery: request,
			inspectionId: pattern(q.inspectionId),
			observation: parseCompanyComputerOutageResumeObservation(q.observation, recovery),
			bootObservationSha256: pattern(q.bootObservationSha256, SHA),
		};
	if (
		r.schema !== "qorpera.office-outage-termination-challenge/v1" ||
		(expected && !same(parsed, expected)) ||
		parsed.inspectionId === request.startCommandId
	)
		throw new Error("OFFICE_OUTAGE_TERMINATION_CHALLENGE_DIFFERS");
	return Object.freeze({
		schema: r.schema,
		request: Object.freeze(parsed),
		recovery,
		validForMs: number(r.validForMs, 1, 5000),
	});
}
export function parseCompanyComputerOutageTerminationRequest(
	value: unknown,
): Readonly<CompanyComputerOutageTerminationRequest> {
	const r = record(value, ["schema", "challenge", "originPreparationSha256"]);
	if (r.schema !== "qorpera.office-outage-termination-request/v1")
		throw new Error("INVALID_OFFICE_OUTAGE_TERMINATION_REQUEST");
	return Object.freeze({
		schema: r.schema,
		challenge: parseCompanyComputerOutageTerminationChallenge(r.challenge),
		originPreparationSha256: pattern(r.originPreparationSha256, SHA),
	});
}
export function parseCompanyComputerOutageTerminationInspection(
	value: unknown,
	expectedCommand?: CompanyComputerPreparationCommand,
	expectedRequest?: CompanyComputerOutageTerminationRequest,
): Readonly<CompanyComputerOutageTerminationInspection> {
	const r = record(value, [
			"schema",
			"command",
			"inspectionId",
			"recoveryId",
			"startCommandId",
			"bootId",
			"hostBootId",
			"physicalInstanceId",
			"bootObservationSha256",
			"originPreparationSha256",
			"originAdoptionReceiptSha256",
			"predecessorConfigurationSha256",
			"predecessorAdoptionReceiptSha256",
			"cgroupState",
			"preparationState",
			"serviceState",
		]),
		command = parseCompanyComputerPreparationCommand(r.command);
	for (const key of [
		"bootObservationSha256",
		"originPreparationSha256",
		"originAdoptionReceiptSha256",
		"predecessorConfigurationSha256",
		"predecessorAdoptionReceiptSha256",
	])
		pattern(r[key], SHA);
	for (const key of ["inspectionId", "recoveryId", "startCommandId", "bootId", "hostBootId", "physicalInstanceId"])
		pattern(r[key]);
	if (
		r.schema !== "qorpera.office-outage-termination-inspection/v1" ||
		command.bootId !== r.bootId ||
		command.commandId === r.startCommandId ||
		command.commandId === r.inspectionId ||
		r.inspectionId === r.startCommandId ||
		!["absent", "empty"].includes(r.cgroupState as string) ||
		r.preparationState !== "unstarted" ||
		r.serviceState !== "unstarted"
	)
		throw new Error("OFFICE_OUTAGE_TERMINATION_UNCONFIRMED");
	if (expectedCommand === undefined && expectedRequest === undefined)
		return Object.freeze({ ...r, command }) as unknown as CompanyComputerOutageTerminationInspection;
	if (!expectedCommand || !expectedRequest) throw new Error("OFFICE_OUTAGE_TERMINATION_EXPECTATION_REQUIRED");
	const request = parseCompanyComputerOutageTerminationRequest(expectedRequest),
		observation = request.challenge.request.observation;
	if (
		r.schema !== "qorpera.office-outage-termination-inspection/v1" ||
		!same(command, parseCompanyComputerPreparationCommand(expectedCommand)) ||
		command.bootId !== observation.bootId ||
		command.commandId === observation.startCommandId ||
		r.inspectionId !== request.challenge.request.inspectionId ||
		r.recoveryId !== request.challenge.recovery.request.recoveryId ||
		["startCommandId", "bootId", "hostBootId", "physicalInstanceId"].some(
			(key) => r[key] !== observation[key as keyof typeof observation],
		) ||
		r.originPreparationSha256 !== request.originPreparationSha256 ||
		r.predecessorConfigurationSha256 !== request.challenge.recovery.predecessor.startup.configurationSha256 ||
		r.bootObservationSha256 !== request.challenge.request.bootObservationSha256 ||
		!["absent", "empty"].includes(r.cgroupState as string) ||
		r.preparationState !== "unstarted" ||
		r.serviceState !== "unstarted"
	)
		throw new Error("OFFICE_OUTAGE_TERMINATION_UNCONFIRMED");
	return Object.freeze({ ...r, command }) as unknown as CompanyComputerOutageTerminationInspection;
}
export function parseCompanyComputerOutageTerminationAcknowledgement(
	value: unknown,
	expected?: CompanyComputerOutageTerminationAcknowledgement["request"],
): Readonly<CompanyComputerOutageTerminationAcknowledgement> {
	const r = record(value, ["schema", "request", "officeRevision", "acknowledgedAtMs"]),
		request = record(r.request, ["recovery", "inspection"]);
	const recovery = parseCompanyComputerOutageRecoveryRequest(request.recovery),
		inspection = parseCompanyComputerOutageTerminationInspection(request.inspection);
	if (
		r.schema !== "qorpera.office-outage-termination-acknowledgement/v1" ||
		(expected !== undefined && !same(request, expected)) ||
		inspection.recoveryId !== recovery.recoveryId ||
		inspection.startCommandId !== recovery.startCommandId
	)
		throw new Error("OFFICE_OUTAGE_TERMINATION_ACKNOWLEDGEMENT_DIFFERS");
	number(r.officeRevision);
	number(r.acknowledgedAtMs);
	return Object.freeze({
		...r,
		request: Object.freeze({
			recovery,
			inspection,
		}),
	}) as unknown as CompanyComputerOutageTerminationAcknowledgement;
}
