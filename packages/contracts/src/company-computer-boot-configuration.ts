import {
	type CompanyComputerResumeObservation,
	parseCompanyComputerResumeObservation,
} from "./company-computer-boot-adoption.ts";
import { type CompanyComputerBootIntent, parseCompanyComputerBootIntent } from "./company-computer-boot-intent.ts";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	type CompanyComputerConfigurationCompletion,
	type CompanyComputerConfigurationMaterial,
	parseCompanyComputerConfigurationMaterial,
} from "./company-computer-configuration.ts";
import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";

export const COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES = 262144;
/** Confidential fixed provider-to-root packet. Original preparation stays on
 * disk; the new boot does not receive a rewritten copy manifest. */
export interface CompanyComputerBootConfigurationRequest {
	readonly schema: "qorpera.office-boot-configuration-request/v1";
	readonly originPreparationSha256: string;
	readonly bootIntent: CompanyComputerBootIntent;
	readonly observation: CompanyComputerResumeObservation;
	/** Exact retained completion bytes, including any terminating newline. */
	readonly powerOffCompletion: string;
	readonly material: CompanyComputerConfigurationMaterial;
}
export interface CompanyComputerBootConfigurationCompletion {
	readonly schema: "qorpera.office-boot-configuration-completion/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly bootIntentId: string;
	readonly activationId: string;
	readonly originPreparationSha256: string;
	readonly adoptionReceiptSha256: string;
	readonly bootObservationSha256: string;
	readonly files: CompanyComputerConfigurationCompletion["files"];
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
function sha(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("digest");
	return value;
}
export function parseCompanyComputerBootConfigurationRequest(
	value: unknown,
): Readonly<CompanyComputerBootConfigurationRequest> {
	try {
		const r = record(value, [
			"schema",
			"originPreparationSha256",
			"bootIntent",
			"observation",
			"powerOffCompletion",
			"material",
		]);
		if (
			r.schema !== "qorpera.office-boot-configuration-request/v1" ||
			new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES
		)
			throw new Error("schema");
		sha(r.originPreparationSha256);
		const original = r.bootIntent as CompanyComputerBootIntent,
			bootIntent = parseCompanyComputerBootIntent(original, original.request);
		if (bootIntent.state !== "prepared") throw new Error("intent already handed off");
		const observation = parseCompanyComputerResumeObservation(r.observation, bootIntent.request);
		if (typeof r.powerOffCompletion !== "string" || new TextEncoder().encode(r.powerOffCompletion).length > 4096)
			throw new Error("power off");
		const power = record(JSON.parse(r.powerOffCompletion), [
			"schema",
			"intentId",
			"allocationId",
			"transitionId",
			"commandId",
			"requestSha256",
			"operationId",
			"instanceSha256",
			"hostBootId",
		]);
		for (const key of ["intentId", "allocationId", "transitionId", "commandId", "operationId", "hostBootId"])
			if (typeof power[key] !== "string" || !UUID.test(power[key])) throw new Error("identity");
		sha(power.requestSha256);
		sha(power.instanceSha256);
		if (
			power.schema !== "qorpera.lxd-office-power-off-completion/v1" ||
			power.intentId !== observation.intentId ||
			power.allocationId !== observation.allocationId ||
			power.transitionId !== bootIntent.request.predecessor.transitionId ||
			power.instanceSha256 !== observation.instanceSha256 ||
			power.hostBootId !== observation.hostBootId ||
			power.commandId === observation.startCommandId ||
			power.operationId === observation.operationId
		)
			throw new Error("shutdown binding");
		return Object.freeze({
			...r,
			bootIntent,
			observation,
			material: parseCompanyComputerConfigurationMaterial(r.material),
		}) as unknown as CompanyComputerBootConfigurationRequest;
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_CONFIGURATION_REQUEST");
	}
}
export function parseCompanyComputerBootConfigurationCompletion(
	value: unknown,
	expected: CompanyComputerBootConfigurationCompletion,
): Readonly<CompanyComputerBootConfigurationCompletion> {
	try {
		const r = record(value, [
			"schema",
			"command",
			"bootIntentId",
			"activationId",
			"originPreparationSha256",
			"adoptionReceiptSha256",
			"bootObservationSha256",
			"files",
		]);
		const command = parseCompanyComputerPreparationCommand(r.command),
			target = parseCompanyComputerPreparationCommand(expected.command);
		if (
			r.schema !== "qorpera.office-boot-configuration-completion/v1" ||
			expected.schema !== r.schema ||
			Object.keys(command).some(
				(key) => command[key as keyof typeof command] !== target[key as keyof typeof command],
			)
		)
			throw new Error("command");
		for (const key of ["bootIntentId", "activationId"] as const)
			if (typeof r[key] !== "string" || !UUID.test(r[key]) || r[key] !== expected[key]) throw new Error("identity");
		for (const key of ["originPreparationSha256", "adoptionReceiptSha256", "bootObservationSha256"] as const)
			if (sha(r[key]) !== sha(expected[key])) throw new Error("digest");
		const files = { ...record(r.files, Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES)) },
			retained = record(expected.files, Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES));
		for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
			const actual = record(files[file], ["bytes", "sha256"]),
				target = record(retained[file], ["bytes", "sha256"]);
			if (
				!Number.isSafeInteger(actual.bytes) ||
				(actual.bytes as number) < 1 ||
				(actual.bytes as number) >
					COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS] ||
				actual.bytes !== target.bytes ||
				sha(actual.sha256) !== sha(target.sha256)
			)
				throw new Error("file");
			files[file] = Object.freeze({ ...actual });
		}
		return Object.freeze({
			...r,
			command,
			files: Object.freeze(files),
		}) as unknown as CompanyComputerBootConfigurationCompletion;
	} catch {
		throw new Error("INVALID_OFFICE_BOOT_CONFIGURATION_COMPLETION");
	}
}
