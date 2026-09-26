import {
	type CompanyComputerActivationAttestation,
	parseCompanyComputerActivationAttestation,
} from "./company-computer-activation.ts";
import {
	type CompanyComputerOutageRecoveryRequest,
	type CompanyComputerOutageTerminationAcknowledgement,
	parseCompanyComputerOutageRecoveryRequest,
	parseCompanyComputerOutageTerminationAcknowledgement,
} from "./company-computer-outage-recovery.ts";
import { outageEqual, outageNumber, outageRecord } from "./company-computer-outage-values.ts";

export interface CompanyComputerOutageSuccessorRequest {
	readonly schema: "qorpera.office-outage-successor-request/v1";
	readonly recovery: CompanyComputerOutageRecoveryRequest;
	readonly attestation: CompanyComputerActivationAttestation;
	readonly termination: CompanyComputerOutageTerminationAcknowledgement;
}
/** Metadata about one exact successor. Only a fresh authority check permits effects. */
export interface CompanyComputerOutageSuccessor {
	readonly schema: "qorpera.office-outage-successor/v1";
	readonly request: CompanyComputerOutageSuccessorRequest;
	readonly state: "prepared" | "ready" | "active";
	readonly serviceInvocationId: string | null;
	readonly readinessFresh: boolean;
	readonly officeRevision: number;
	readonly privacyVersion: number;
}
export interface CompanyComputerOutageSuccessorAuthority {
	readonly schema: "qorpera.office-outage-successor-authority/v1";
	readonly successor: CompanyComputerOutageSuccessor;
	readonly validForMs: 5000;
}
export function parseCompanyComputerOutageSuccessorRequest(
	value: unknown,
): Readonly<CompanyComputerOutageSuccessorRequest> {
	const r = outageRecord(value, ["schema", "recovery", "attestation", "termination"], 65536),
		recovery = parseCompanyComputerOutageRecoveryRequest(r.recovery),
		attestation = parseCompanyComputerActivationAttestation(r.attestation),
		termination = parseCompanyComputerOutageTerminationAcknowledgement(r.termination);
	if (
		r.schema !== "qorpera.office-outage-successor-request/v1" ||
		!outageEqual(termination.request.recovery, recovery) ||
		attestation.activationId !== recovery.activationId ||
		attestation.bootId !== termination.request.inspection.bootId ||
		attestation.configurationSha256 === termination.request.inspection.predecessorConfigurationSha256 ||
		attestation.adoptionReceiptSha256 === termination.request.inspection.predecessorAdoptionReceiptSha256 ||
		attestation.preparationObservationSha256 !== termination.request.inspection.bootObservationSha256
	)
		throw new Error("INVALID_OFFICE_OUTAGE_SUCCESSOR_REQUEST");
	return Object.freeze({ schema: r.schema, recovery, attestation, termination });
}
export function parseCompanyComputerOutageSuccessor(
	value: unknown,
	expected: CompanyComputerOutageSuccessorRequest,
): Readonly<CompanyComputerOutageSuccessor> {
	const r = outageRecord(
			value,
			["schema", "request", "state", "serviceInvocationId", "readinessFresh", "officeRevision", "privacyVersion"],
			65536,
		),
		request = parseCompanyComputerOutageSuccessorRequest(r.request);
	if (
		r.schema !== "qorpera.office-outage-successor/v1" ||
		!outageEqual(request, parseCompanyComputerOutageSuccessorRequest(expected)) ||
		!["prepared", "ready", "active"].includes(r.state as string) ||
		typeof r.readinessFresh !== "boolean" ||
		(r.state === "prepared"
			? r.serviceInvocationId !== null || r.readinessFresh
			: typeof r.serviceInvocationId !== "string" || !/^(?!0{32}$)[0-9a-f]{32}$/.test(r.serviceInvocationId))
	)
		throw new Error("OFFICE_OUTAGE_SUCCESSOR_UNCONFIRMED");
	return Object.freeze({
		...r,
		request,
		officeRevision: outageNumber(r.officeRevision),
		privacyVersion: outageNumber(r.privacyVersion, 0),
	}) as unknown as CompanyComputerOutageSuccessor;
}
export function parseCompanyComputerOutageSuccessorAuthority(
	value: unknown,
	expected: CompanyComputerOutageSuccessorRequest,
): Readonly<CompanyComputerOutageSuccessorAuthority> {
	const r = outageRecord(value, ["schema", "successor", "validForMs"], 65536);
	if (r.schema !== "qorpera.office-outage-successor-authority/v1" || r.validForMs !== 5000)
		throw new Error("OFFICE_OUTAGE_SUCCESSOR_AUTHORITY_UNCONFIRMED");
	return Object.freeze({
		schema: r.schema,
		successor: parseCompanyComputerOutageSuccessor(r.successor, expected),
		validForMs: 5000,
	});
}
