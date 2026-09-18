import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	type CompanyComputerConfigurationCompletion,
	companyComputerBootDirectory,
	parseCompanyComputerConfigurationCompletion,
	parseCompanyComputerConfigurationRequest,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function request() {
	return {
		schema: "qorpera.office-configuration-request/v1",
		preparation: { commandId: id(1), requestSha256: "a".repeat(64), bootId: id(2) },
		configuration: "{}",
		registry: "r".repeat(64),
		native: "n".repeat(43),
		objects: "o".repeat(43),
		tlsCert: "synthetic certificate",
		tlsKey: "synthetic key",
	};
}
function completion(): CompanyComputerConfigurationCompletion {
	const input = parseCompanyComputerConfigurationRequest(request());
	return {
		schema: "qorpera.office-configuration-completion/v1",
		preparation: input.preparation,
		command: { commandId: id(3), requestSha256: "b".repeat(64), bootId: id(2) },
		preparationCompletionSha256: "c".repeat(64),
		adoptionReceiptSha256: "d".repeat(64),
		files: Object.fromEntries(
			Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([name, file]) => {
				const bytes = Buffer.from(input[name as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
				return [file, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
			}),
		) as CompanyComputerConfigurationCompletion["files"],
	};
}
describe("confidential office configuration data", () => {
	it("selects systemd's 32-hex boot path from a canonical attestation UUID", () => {
		expect(companyComputerBootDirectory("12345678-1234-4123-8123-123456789abc")).toBe(
			"/etc/qorpera-office/boots/12345678123441238123123456789abc",
		);
		expect(companyComputerBootDirectory(id(2))).not.toBe(companyComputerBootDirectory(id(3)));
	});
	it.each([
		"",
		"../credentials",
		"%b",
		"12345678123441238123123456789abc",
		"12345678-1234-4123-8123-123456789ABC",
		"00000000-0000-0000-0000-000000000000",
		`${id(2)}/..`,
		`${id(2)}\n`,
	])("rejects ambiguous boot path input %j", (boot) => {
		expect(() => companyComputerBootDirectory(boot)).toThrow("invalid boot identity");
	});
	it("retains bounded immutable data without retaining caller-owned nested commands", () => {
		const value = request(),
			parsed = parseCompanyComputerConfigurationRequest(value);
		expect(parsed).toEqual(value);
		value.preparation.commandId = id(9);
		expect(parsed.preparation.commandId).toBe(id(1));
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.preparation)).toBe(true);
	});
	it.each([
		["schema", "old"],
		["extra", "private"],
		["preparation", {}],
		["configuration", "x".repeat(16385)],
		["registry", "secret with spaces"],
		["native", "short"],
		["objects", "n".repeat(43)],
		["tlsCert", "x".repeat(65537)],
		["tlsKey", "x".repeat(32769)],
		["tlsCert", ""],
	])("refuses invalid %s without returning confidential data", (key, value) => {
		expect(() => parseCompanyComputerConfigurationRequest({ ...request(), [key]: value })).toThrow(
			/^INVALID_OFFICE_CONFIGURATION_REQUEST$/,
		);
	});
	it("bounds encoded bytes including UTF-8 and outer JSON escaping", () => {
		expect(() => parseCompanyComputerConfigurationRequest({ ...request(), tlsCert: "é".repeat(32769) })).toThrow();
		expect(() =>
			parseCompanyComputerConfigurationRequest({ ...request(), tlsCert: "\u0000".repeat(65536) }),
		).toThrow();
	});
	it("validates independently derived completion digests without mutating either input", () => {
		const expected = completion(),
			value = structuredClone(expected);
		const before = JSON.stringify(value);
		const parsed = parseCompanyComputerConfigurationCompletion(value, expected);
		expect(parsed).toEqual(expected);
		expect(JSON.stringify(value)).toBe(before);
		expect(parseCompanyComputerConfigurationCompletion(parsed, expected)).toEqual(expected);
		expect(Object.isFrozen(parsed.files["config.json"])).toBe(true);
		expect(JSON.stringify(parsed)).not.toContain(request().registry);
	});
	it.each([
		(value: CompanyComputerConfigurationCompletion) => ({ ...value, schema: "old" }),
		(value: CompanyComputerConfigurationCompletion) => ({ ...value, secret: "never return" }),
		(value: CompanyComputerConfigurationCompletion) => ({
			...value,
			command: { ...value.command, commandId: id(99) },
		}),
		(value: CompanyComputerConfigurationCompletion) => ({
			...value,
			preparation: { ...value.preparation, requestSha256: "f".repeat(64) },
		}),
		(value: CompanyComputerConfigurationCompletion) => ({ ...value, preparationCompletionSha256: "f".repeat(64) }),
		(value: CompanyComputerConfigurationCompletion) => ({ ...value, adoptionReceiptSha256: "f".repeat(64) }),
		(value: CompanyComputerConfigurationCompletion) => ({ ...value, files: { ...value.files, extra: {} } }),
		(value: CompanyComputerConfigurationCompletion) => ({ ...value, files: {} }),
	])("refuses substituted completion identity or evidence %#", (change) => {
		const expected = completion();
		expect(() => parseCompanyComputerConfigurationCompletion(change(structuredClone(expected)), expected)).toThrow(
			/^INVALID_OFFICE_CONFIGURATION_COMPLETION$/,
		);
	});
	it.each(Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES))(
		"binds exact protected file metadata for %s",
		(file) => {
			const expected = completion();
			for (const mutation of [{ bytes: 0 }, { bytes: 999999 }, { sha256: "e".repeat(64) }, { mode: 0o644 }]) {
				const value = structuredClone(expected);
				Object.assign(value.files[file], mutation);
				expect(() => parseCompanyComputerConfigurationCompletion(value, expected)).toThrow(
					/^INVALID_OFFICE_CONFIGURATION_COMPLETION$/,
				);
			}
		},
	);
	it("refuses the same command or different boots even if expected metadata repeats the error", () => {
		for (const change of [{ commandId: id(1) }, { bootId: id(99) }]) {
			const value = completion();
			Object.assign(value.command, change);
			expect(() => parseCompanyComputerConfigurationCompletion(value, value)).toThrow(
				/^INVALID_OFFICE_CONFIGURATION_COMPLETION$/,
			);
		}
	});
});
