import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	COMPANY_COMPUTER_GUEST_LAYOUT_KEYS,
	companyComputerBootAdoptionReceiptPath,
	companyComputerPreparationAdoptionReceipt,
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
/** The production office: layout version 2 names a fifth admitted root. */
const layoutV2 = () =>
	bootConfigurationFixture({
		original: {
			layoutVersion: 2,
			entries: [".", "company", "desktop", "profiles", "screens", "workbench"].map((path) => ({
				path,
				kind: "directory" as const,
				mode: 0o700,
				bytes: 0,
				sha256: null,
			})),
		},
	});
describe("retained boot adoption of a layout version 2 office", () => {
	it("accepts the company root exactly like the original adoption, in the receipt and the boot packet", () => {
		const f = layoutV2(),
			root = `/var/lib/qorpera-office/.qorpera-adopted-${f.original.copy.adoptionId}`;
		expect(f.receipt.layout).toEqual({
			workbenchRoot: `${root}/workbench`,
			desktopHome: `${root}/desktop`,
			screenStateRoot: `${root}/screens`,
			browserProfilesRoot: `${root}/profiles`,
			companyRoot: `${root}/company`,
		});
		const parsed = parseCompanyComputerBootAdoptionReceipt(JSON.parse(JSON.stringify(f.receipt)));
		expect(parsed).toEqual(f.receipt);
		expect(parsed.layout).toEqual(f.originReceipt.layout);
		expect(Object.isFrozen(parsed.layout)).toBe(true);
		// Byte-stable: the guest and the host hash this exact serialisation.
		expect(JSON.stringify(parsed)).toBe(JSON.stringify(f.receipt));
		expect(
			JSON.parse(parseCompanyComputerBootConfigurationRequest(f.input).material.configuration).linux.layout,
		).toEqual(f.receipt.layout);
	});
	it.each([
		["a sixth root", (layout: Record<string, string>) => ({ ...layout, otherRoot: `${layout.companyRoot}-2` })],
		[
			"a company root outside the mount",
			(layout: Record<string, string>) => ({ ...layout, companyRoot: "/srv/company" }),
		],
		[
			"a traversing company root",
			(layout: Record<string, string>) => ({ ...layout, companyRoot: "/var/lib/qorpera-office/x/../company" }),
		],
		[
			"a company root inside another root",
			(layout: Record<string, string>) => ({ ...layout, companyRoot: `${layout.workbenchRoot}/company` }),
		],
		[
			"a credential-named company root",
			(layout: Record<string, string>) => ({ ...layout, companyRoot: "/var/lib/qorpera-office/credentials" }),
		],
		["a non-string company root", (layout: Record<string, string>) => ({ ...layout, companyRoot: 5 })],
		["a missing version 1 root", ({ screenStateRoot: _dropped, ...layout }: Record<string, string>) => layout],
	])("still refuses %s", (_name, mutate) => {
		const receipt = JSON.parse(JSON.stringify(layoutV2().receipt));
		expect(() => parseCompanyComputerBootAdoptionReceipt({ ...receipt, layout: mutate(receipt.layout) })).toThrow(
			"INVALID_OFFICE_BOOT_ADOPTION_RECEIPT",
		);
	});
	it("every layout version the preparation contract can produce is admitted by the boot receipt parser", () => {
		// Guard for a later layout version: one key table feeds every parser, and
		// each version listed there must survive a power-off/resume receipt.
		const fixtures = { 1: bootConfigurationFixture(), 2: layoutV2() };
		expect(Object.keys(COMPANY_COMPUTER_GUEST_LAYOUT_KEYS).sort()).toEqual(Object.keys(fixtures).sort());
		for (const [version, keys] of Object.entries(COMPANY_COMPUTER_GUEST_LAYOUT_KEYS)) {
			const f = fixtures[Number(version) as 1 | 2];
			expect(Object.keys(companyComputerPreparationAdoptionReceipt(f.original).layout).sort()).toEqual(
				[...keys].sort(),
			);
			expect(Object.keys(parseCompanyComputerBootAdoptionReceipt(structuredClone(f.receipt)).layout).sort()).toEqual(
				[...keys].sort(),
			);
		}
	});
	it("no other source names the layout keys: every parser takes them from the one table", async () => {
		// A closed key list written out beside a parser is what refused version 2.
		const packages = fileURLToPath(new URL("../..", import.meta.url)),
			offenders: string[] = [];
		for (const name of ["contracts", "runner-orchestrator", "runtime"])
			for (const entry of await readdir(join(packages, name, "src"), { recursive: true, withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
				const path = join(entry.parentPath, entry.name);
				if (path.endsWith(join("contracts", "src", "company-computer-adoption.ts"))) continue;
				if (/["'`]workbenchRoot["'`]/.test(await readFile(path, "utf8"))) offenders.push(path);
			}
		expect(offenders).toEqual([]);
	});
});
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
