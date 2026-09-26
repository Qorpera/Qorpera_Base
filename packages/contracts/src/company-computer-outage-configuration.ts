import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	type CompanyComputerConfigurationCompletion,
	type CompanyComputerConfigurationMaterial,
	parseCompanyComputerConfigurationMaterial,
} from "./company-computer-configuration.ts";
import {
	type CompanyComputerOutageRecovery,
	type CompanyComputerOutageRecoveryRequest,
	type CompanyComputerOutageResumeObservation,
	type CompanyComputerOutageTerminationAcknowledgement,
	parseCompanyComputerOutageRecovery,
	parseCompanyComputerOutageResumeObservation,
	parseCompanyComputerOutageTerminationAcknowledgement,
} from "./company-computer-outage-recovery.ts";
import { outageEqual, outageNumber, outageRecord, outageSha, outageUuid } from "./company-computer-outage-values.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";

export const COMPANY_COMPUTER_OUTAGE_CONFIGURATION_MAX_BYTES = 262144;
/** Fresh permission to install configuration after acknowledged termination. */
export interface CompanyComputerOutageConfigurationAuthority {
	readonly schema: "qorpera.office-outage-configuration-authority/v1";
	readonly recovery: CompanyComputerOutageRecovery;
	readonly termination: CompanyComputerOutageTerminationAcknowledgement;
	readonly validForMs: 5000;
}
export function parseCompanyComputerOutageConfigurationAuthority(
	value: unknown,
	expected: {
		recovery: CompanyComputerOutageRecoveryRequest;
		termination: CompanyComputerOutageTerminationAcknowledgement;
	},
): Readonly<CompanyComputerOutageConfigurationAuthority> {
	const r = outageRecord(value, ["schema", "recovery", "termination", "validForMs"], 131072),
		recovery = parseCompanyComputerOutageRecovery(r.recovery, expected.recovery),
		termination = parseCompanyComputerOutageTerminationAcknowledgement(r.termination);
	if (
		r.schema !== "qorpera.office-outage-configuration-authority/v1" ||
		r.validForMs !== 5000 ||
		!outageEqual(termination, parseCompanyComputerOutageTerminationAcknowledgement(expected.termination)) ||
		!outageEqual(termination.request.recovery, recovery.request)
	)
		throw new Error("OFFICE_OUTAGE_CONFIGURATION_AUTHORITY_UNCONFIRMED");
	return Object.freeze({ schema: r.schema, recovery, termination, validForMs: 5000 });
}
/** Confidential provider-to-root packet after SQL accepted fresh-boot termination. */
export interface CompanyComputerOutageConfigurationRequest {
	readonly schema: "qorpera.office-outage-configuration-request/v1";
	readonly originPreparationSha256: string;
	readonly recovery: CompanyComputerOutageRecovery;
	readonly observation: CompanyComputerOutageResumeObservation;
	readonly termination: CompanyComputerOutageTerminationAcknowledgement;
	readonly material: CompanyComputerConfigurationMaterial;
}
export interface CompanyComputerOutageConfigurationCompletion {
	readonly schema: "qorpera.office-outage-configuration-completion/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly recoveryId: string;
	readonly activationId: string;
	readonly originPreparationSha256: string;
	readonly adoptionReceiptSha256: string;
	readonly bootObservationSha256: string;
	readonly files: CompanyComputerConfigurationCompletion["files"];
}
export function parseCompanyComputerOutageConfigurationRequest(
	value: unknown,
): Readonly<CompanyComputerOutageConfigurationRequest> {
	const r = outageRecord(
			value,
			["schema", "originPreparationSha256", "recovery", "observation", "termination", "material"],
			COMPANY_COMPUTER_OUTAGE_CONFIGURATION_MAX_BYTES,
		),
		raw = r.recovery as CompanyComputerOutageRecovery,
		recovery = parseCompanyComputerOutageRecovery(raw, raw?.request),
		observation = parseCompanyComputerOutageResumeObservation(r.observation, recovery),
		termination = parseCompanyComputerOutageTerminationAcknowledgement(r.termination),
		inspection = termination.request.inspection;
	if (
		r.schema !== "qorpera.office-outage-configuration-request/v1" ||
		!outageEqual(termination.request.recovery, recovery.request) ||
		inspection.originPreparationSha256 !== r.originPreparationSha256 ||
		inspection.predecessorConfigurationSha256 !== recovery.predecessor.startup.configurationSha256 ||
		["bootId", "hostBootId", "physicalInstanceId", "startCommandId", "recoveryId"].some(
			(key) => inspection[key as keyof typeof inspection] !== observation[key as keyof typeof observation],
		)
	)
		throw new Error("INVALID_OFFICE_OUTAGE_CONFIGURATION_REQUEST");
	return Object.freeze({
		schema: r.schema,
		originPreparationSha256: outageSha(r.originPreparationSha256),
		recovery,
		observation,
		termination,
		material: parseCompanyComputerConfigurationMaterial(r.material),
	});
}
export function parseCompanyComputerOutageConfigurationCompletion(
	value: unknown,
	expected?: CompanyComputerOutageConfigurationCompletion,
): Readonly<CompanyComputerOutageConfigurationCompletion> {
	const r = outageRecord(value, [
			"schema",
			"command",
			"recoveryId",
			"activationId",
			"originPreparationSha256",
			"adoptionReceiptSha256",
			"bootObservationSha256",
			"files",
		]),
		command = parseCompanyComputerPreparationCommand(r.command),
		entries = outageRecord(r.files, Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES)),
		files: Record<string, Readonly<{ bytes: number; sha256: string }>> = {};
	if (r.schema !== "qorpera.office-outage-configuration-completion/v1")
		throw new Error("INVALID_OFFICE_OUTAGE_CONFIGURATION_COMPLETION");
	for (const [key, path] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
		const entry = outageRecord(entries[path], ["bytes", "sha256"]);
		files[path] = Object.freeze({
			bytes: outageNumber(
				entry.bytes,
				1,
				COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
			),
			sha256: outageSha(entry.sha256),
		});
	}
	const result = Object.freeze({
		schema: r.schema,
		command,
		recoveryId: outageUuid(r.recoveryId),
		activationId: outageUuid(r.activationId),
		originPreparationSha256: outageSha(r.originPreparationSha256),
		adoptionReceiptSha256: outageSha(r.adoptionReceiptSha256),
		bootObservationSha256: outageSha(r.bootObservationSha256),
		files: Object.freeze(files) as CompanyComputerConfigurationCompletion["files"],
	});
	if (expected && !outageEqual(result, parseCompanyComputerOutageConfigurationCompletion(expected)))
		throw new Error("OFFICE_OUTAGE_CONFIGURATION_COMPLETION_DIFFERS");
	return result;
}
