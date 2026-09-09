import {
	companyComputerBootAdoptionReceiptPath,
	companyComputerResumeObservationCanonical,
	parseCompanyComputerBootAdoptionReceipt,
	parseCompanyComputerBootConfigurationCompletion,
	parseCompanyComputerBootConfigurationRequest,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import {
	bootConfigurationFixture,
	bootFixtureId as id,
} from "../../runtime/test/fixtures/company-computer-boot-configuration.ts";

function change(value: unknown, path: string, replacement: unknown) {
	const clone = structuredClone(value) as Record<string, unknown>;
	const keys = path.split(".");
	let current = clone;
	for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>;
	current[keys.at(-1)!] = replacement;
	return clone;
}
describe("retained office boot configuration contracts", () => {
	it("binds new boot custody to shutdown and original adoption without a new copy assertion", () => {
		const f = bootConfigurationFixture(),
			parsed = parseCompanyComputerBootAdoptionReceipt(structuredClone(f.receipt));
		expect(parsed).toEqual(f.receipt);
		expect(parsed.bootId).not.toBe(f.original.bootId);
		expect(parsed.layout).toEqual(f.originReceipt.layout);
		expect(parsed.origin.bootId).toBe(f.original.bootId);
		expect(Object.isFrozen(parsed.bootIntent.predecessor.startup.scope)).toBe(true);
		expect(Object.isFrozen(parsed.layout)).toBe(true);
		expect(parsed).not.toHaveProperty("inventorySha256");
		expect(parsed).not.toHaveProperty("disposition");
		expect(companyComputerBootAdoptionReceiptPath(parsed.bootId)).toBe(
			`/etc/qorpera-office/boots/${parsed.bootId.replaceAll("-", "")}/adoption.json`,
		);
	});
	it("canonical observation bytes are independent of received object order", () => {
		const f = bootConfigurationFixture(),
			observation = f.input.observation;
		expect(
			companyComputerResumeObservationCanonical(
				Object.fromEntries(Object.entries(observation).reverse()) as typeof observation,
				f.input.bootIntent.request,
			),
		).toBe(JSON.stringify(observation, Object.keys(observation).sort()));
	});
	it.each([
		["extra", true],
		["origin.extra", true],
		["scope.extra", id(99)],
		["layout.extra", "/other"],
		["workbenchMount.extra", true],
		["schema", "qorpera.office-state-adoption/v1"],
		["state", "prepared"],
		["computerGeneration", 2],
		["scope.companyId", id(99)],
		["allocationId", id(99)],
		["instanceSha256", "9".repeat(64)],
		["imageSha256", "9".repeat(64)],
		["bootstrapSha256", "9".repeat(64)],
		["bootId", id(7)],
		["bootId", id(7).toUpperCase()],
		["origin.bootId", id(19)],
		["origin.preparationSha256", "bad"],
		["origin.adoptionReceiptSha256", "A".repeat(64)],
		["bootObservationSha256", "bad"],
		["bootIntent.predecessor.action", "replace"],
		["layout.workbenchRoot", "/tmp/workbench"],
		["workbenchMount.filesystem", "tmpfs"],
		["workbenchMount.mountPoint", "/tmp/workbench"],
		["workbenchMount.root", "/a/../b"],
	])("rejects retained receipt substitution %s=%j", (path, value) => {
		expect(() =>
			parseCompanyComputerBootAdoptionReceipt(change(bootConfigurationFixture().receipt, path as string, value)),
		).toThrow("INVALID_OFFICE_BOOT_ADOPTION_RECEIPT");
	});
	it("retains exact shutdown bytes and detached immutable confidential material", () => {
		const f = bootConfigurationFixture(),
			value = structuredClone(f.input),
			parsed = parseCompanyComputerBootConfigurationRequest(value);
		expect(parsed).toEqual(f.input);
		expect(parsed.powerOffCompletion.endsWith("\n")).toBe(true);
		expect(Object.isFrozen(parsed.material)).toBe(true);
		expect(Object.isFrozen(parsed.observation)).toBe(true);
		expect(Object.isFrozen(parsed.bootIntent.request.predecessor.startup.scope)).toBe(true);
	});
	it.each([
		["schema", "old"],
		["extra", "must-not-leak"],
		["originPreparationSha256", "bad"],
		["bootIntent.state", "admitted"],
		["observation.extra", true],
		["observation.bootId", id(7)],
		["observation.bootIntentId", id(99)],
		["observation.activationId", id(99)],
		["observation.allocationId", id(99)],
		["observation.instanceSha256", "9".repeat(64)],
		["observation.stopHistorySha256", "9".repeat(64)],
		["observation.powerOffCompletionSha256", "9".repeat(64)],
		["observation.hostBootId", id(99)],
		["material.extra", "must-not-leak"],
		["material.registry", "must not leak"],
		["material.objects", "n".repeat(43)],
		["material.configuration", "x".repeat(16385)],
		["material.tlsCert", "é".repeat(32769)],
		["powerOffCompletion", "{}"],
	])("rejects configuration packet substitution %s", (path, value) => {
		expect(() =>
			parseCompanyComputerBootConfigurationRequest(change(bootConfigurationFixture().input, path as string, value)),
		).toThrow(/^INVALID_OFFICE_BOOT_CONFIGURATION_REQUEST$/);
	});
	it.each([
		"intentId",
		"allocationId",
		"transitionId",
		"instanceSha256",
		"hostBootId",
		"commandId",
		"operationId",
		"extra",
	])("binds shutdown %s", (key) => {
		const f = bootConfigurationFixture(),
			power = JSON.parse(f.input.powerOffCompletion);
		power[key] =
			key === "instanceSha256"
				? "9".repeat(64)
				: key === "commandId"
					? f.input.observation.startCommandId
					: key === "operationId"
						? f.input.observation.operationId
						: id(99);
		expect(() =>
			parseCompanyComputerBootConfigurationRequest({ ...f.input, powerOffCompletion: JSON.stringify(power) }),
		).toThrow(/^INVALID_OFFICE_BOOT_CONFIGURATION_REQUEST$/);
	});
	it("validates completion against independently derived hashes", () => {
		const f = bootConfigurationFixture(),
			value = structuredClone(f.completion),
			parsed = parseCompanyComputerBootConfigurationCompletion(value, f.completion);
		expect(parsed).toEqual(f.completion);
		expect(Object.isFrozen(parsed.files["config.json"])).toBe(true);
		expect(JSON.stringify(parsed)).not.toContain(f.input.material.registry);
	});
	it.each([
		["extra", true],
		["command.bootId", id(99)],
		["command.commandId", id(99)],
		["command.requestSha256", "9".repeat(64)],
		["bootIntentId", id(99)],
		["activationId", id(99)],
		["originPreparationSha256", "9".repeat(64)],
		["adoptionReceiptSha256", "9".repeat(64)],
		["bootObservationSha256", "9".repeat(64)],
		["files.extra", {}],
		["files.config.json", {}],
	])("rejects completion substitution %s", (path, value) => {
		const f = bootConfigurationFixture();
		const mutated =
			path === "files.config.json"
				? { ...f.completion, files: { ...f.completion.files, "config.json": value } }
				: change(f.completion, path as string, value);
		expect(() => parseCompanyComputerBootConfigurationCompletion(mutated, f.completion)).toThrow(
			/^INVALID_OFFICE_BOOT_CONFIGURATION_COMPLETION$/,
		);
	});
});
