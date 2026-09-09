import {
	type CompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCommand,
} from "./company-computer-preparation.ts";

export const COMPANY_COMPUTER_BOOTS_ROOT = "/etc/qorpera-office/boots";
/** systemd's %b uses the kernel boot ID as 32 lowercase hexadecimal digits.
 * Accept only the canonical UUID form used by runtime attestations. */
export function companyComputerBootDirectory(bootId: string): string {
	if (
		typeof bootId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bootId)
	)
		throw new Error("invalid boot identity");
	return `${COMPANY_COMPUTER_BOOTS_ROOT}/${bootId.replaceAll("-", "")}`;
}

/** Confidential provider-to-root-helper data; never a member or model API. */
export interface CompanyComputerConfigurationRequest {
	readonly schema: "qorpera.office-configuration-request/v1";
	readonly preparation: CompanyComputerPreparationCommand;
	readonly configuration: string;
	readonly registry: string;
	readonly native: string;
	readonly objects: string;
	readonly tlsCert: string;
	readonly tlsKey: string;
}
export const COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES = 196608;
export const COMPANY_COMPUTER_CONFIGURATION_FILES = Object.freeze({
	configuration: "config.json",
	registry: "registry",
	native: "native",
	objects: "objects",
	tlsCert: "tls-cert.pem",
	tlsKey: "tls-key.pem",
});
export const COMPANY_COMPUTER_CONFIGURATION_LIMITS = Object.freeze({
	configuration: 16384,
	registry: 8192,
	native: 128,
	objects: 128,
	tlsCert: 65536,
	tlsKey: 32768,
});
export type CompanyComputerConfigurationMaterial = Pick<
	CompanyComputerConfigurationRequest,
	keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES
>;
/** Reusable closed credential data; this does not imply a preparation command. */
export function parseCompanyComputerConfigurationMaterial(
	value: unknown,
): Readonly<CompanyComputerConfigurationMaterial> {
	try {
		const request = record(value, Object.keys(COMPANY_COMPUTER_CONFIGURATION_FILES)),
			encoder = new TextEncoder();
		if (encoder.encode(JSON.stringify(request)).length > COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES)
			throw new Error("size");
		for (const [name, maximum] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_LIMITS)) {
			const text = request[name];
			if (typeof text !== "string" || !text || encoder.encode(text).length > maximum) throw new Error("field");
		}
		if (
			!/^[\x21-\x7e]{32,8192}$/.test(request.registry as string) ||
			![request.native, request.objects].every(
				(token) => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token),
			) ||
			new Set([request.registry, request.native, request.objects]).size !== 3
		)
			throw new Error("tokens");
		return Object.freeze({ ...request }) as unknown as CompanyComputerConfigurationMaterial;
	} catch {
		throw new Error("INVALID_OFFICE_CONFIGURATION_MATERIAL");
	}
}
type FileName = (typeof COMPANY_COMPUTER_CONFIGURATION_FILES)[keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES];
export interface CompanyComputerConfigurationCompletion {
	readonly schema: "qorpera.office-configuration-completion/v1";
	readonly command: CompanyComputerPreparationCommand;
	readonly preparation: CompanyComputerPreparationCommand;
	readonly preparationCompletionSha256: string;
	readonly adoptionReceiptSha256: string;
	readonly files: Readonly<Record<FileName, { readonly bytes: number; readonly sha256: string }>>;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("invalid record");
	return value as Record<string, unknown>;
}
function sha(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid digest");
	return value;
}
function sameCommand(a: CompanyComputerPreparationCommand, b: CompanyComputerPreparationCommand): boolean {
	return a.commandId === b.commandId && a.requestSha256 === b.requestSha256 && a.bootId === b.bootId;
}

/** Closed bounds and token syntax only. The root helper separately validates
 * configuration against preparation, parses TLS and establishes file custody. */
export function parseCompanyComputerConfigurationRequest(
	value: unknown,
): Readonly<CompanyComputerConfigurationRequest> {
	try {
		const request = record(value, ["schema", "preparation", ...Object.keys(COMPANY_COMPUTER_CONFIGURATION_FILES)]);
		if (request.schema !== "qorpera.office-configuration-request/v1") throw new Error("schema");
		const encoder = new TextEncoder();
		if (encoder.encode(JSON.stringify(request)).length > COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES)
			throw new Error("size");
		parseCompanyComputerConfigurationMaterial(
			Object.fromEntries(Object.keys(COMPANY_COMPUTER_CONFIGURATION_FILES).map((key) => [key, request[key]])),
		);
		return Object.freeze({
			...request,
			preparation: parseCompanyComputerPreparationCommand(request.preparation),
		}) as unknown as Readonly<CompanyComputerConfigurationRequest>;
	} catch {
		throw new Error("INVALID_OFFICE_CONFIGURATION_REQUEST");
	}
}

/** Requires independently derived file digests and the exact retained command
 * and preparation evidence. Metadata never grants activation or file custody. */
export function parseCompanyComputerConfigurationCompletion(
	value: unknown,
	expected: CompanyComputerConfigurationCompletion,
): Readonly<CompanyComputerConfigurationCompletion> {
	try {
		const input = record(value, [
			"schema",
			"command",
			"preparation",
			"preparationCompletionSha256",
			"adoptionReceiptSha256",
			"files",
		]);
		const command = parseCompanyComputerPreparationCommand(input.command),
			preparation = parseCompanyComputerPreparationCommand(input.preparation);
		if (
			input.schema !== "qorpera.office-configuration-completion/v1" ||
			expected.schema !== input.schema ||
			!sameCommand(command, parseCompanyComputerPreparationCommand(expected.command)) ||
			!sameCommand(preparation, parseCompanyComputerPreparationCommand(expected.preparation)) ||
			command.bootId !== preparation.bootId ||
			command.commandId === preparation.commandId ||
			sha(input.preparationCompletionSha256) !== sha(expected.preparationCompletionSha256) ||
			sha(input.adoptionReceiptSha256) !== sha(expected.adoptionReceiptSha256)
		)
			throw new Error("binding");
		const files = { ...record(input.files, Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES)) };
		const retained = record(expected.files, Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES));
		for (const [name, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
			const item = record(files[file], ["bytes", "sha256"]),
				match = record(retained[file], ["bytes", "sha256"]);
			if (
				!Number.isSafeInteger(item.bytes) ||
				(item.bytes as number) < 1 ||
				(item.bytes as number) >
					COMPANY_COMPUTER_CONFIGURATION_LIMITS[name as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS] ||
				item.bytes !== match.bytes ||
				sha(item.sha256) !== sha(match.sha256)
			)
				throw new Error("file");
			files[file] = Object.freeze({ bytes: item.bytes, sha256: item.sha256 });
		}
		return Object.freeze({
			schema: "qorpera.office-configuration-completion/v1",
			command,
			preparation,
			preparationCompletionSha256: expected.preparationCompletionSha256,
			adoptionReceiptSha256: expected.adoptionReceiptSha256,
			files: Object.freeze({ ...files }) as CompanyComputerConfigurationCompletion["files"],
		});
	} catch {
		throw new Error("INVALID_OFFICE_CONFIGURATION_COMPLETION");
	}
}
