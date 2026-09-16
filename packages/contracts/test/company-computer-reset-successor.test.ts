import { describe, expect, it } from "vitest";
import { COMPANY_COMPUTER_CONFIGURATION_FILES } from "../src/company-computer-configuration.ts";
import type { CompanyComputerLifecycleRequest } from "../src/company-computer-lifecycle.ts";
import { COMPANY_COMPUTER_PREPARATION_MAX_BYTES } from "../src/company-computer-preparation.ts";
import type { CompanyComputerResetSuccessor } from "../src/company-computer-reset.ts";
import {
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetServiceStartCompletion,
	companyComputerResetAdoptionReceipt,
	companyComputerResetAdoptionReceiptPath,
	parseCompanyComputerResetAdoptionReceipt,
	parseCompanyComputerResetConfigurationCompletion,
	parseCompanyComputerResetConfigurationRequest,
	parseCompanyComputerResetServiceInspection,
	parseCompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetServiceStartRequest,
} from "../src/company-computer-reset-successor.ts";

const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const sha = (c: string) => c.repeat(64);
const scope = () => ({ companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) });
const predecessor = (): CompanyComputerLifecycleRequest => ({
	schema: "qorpera.office-lifecycle-request/v1",
	transitionId: id(2),
	action: "replace",
	activationId: id(3),
	providerId: id(12),
	providerPolicySha256: sha("f"),
	startup: {
		scope: scope(),
		computerGeneration: 1,
		allocationId: id(10),
		instanceSha256: sha("a"),
		imageSha256: sha("b"),
		bootstrapSha256: sha("c"),
		bootId: id(11),
		configurationSha256: sha("d"),
		serviceInvocationId: "e".repeat(32),
	},
});
const original = () => ({
	schema: "qorpera.office-guest-preparation/v1",
	scope: scope(),
	computerGeneration: 1,
	allocationId: id(10),
	instanceSha256: sha("a"),
	imageSha256: sha("b"),
	bootstrapSha256: sha("c"),
	bootId: id(11),
	uid: 1000,
	gid: 1000,
	copy: {
		adoptionId: id(15),
		observationSha256: sha("b"),
		planSha256: sha("c"),
		reviewSha256: sha("d"),
		outputInventorySha256: sha("e"),
	},
	workbenchMount: { filesystem: "ext4", source: "/dev/sdb1", root: "/", mountPoint: "/var/lib/qorpera-office" },
	limits: { memoryBytes: 1024, pids: 10, cpuQuota: 100000, cpuPeriod: 100000 },
	entries: [".", "desktop", "profiles", "screens", "workbench"].map((path) => ({
		path,
		kind: "directory",
		mode: 0o700,
		bytes: 0,
		sha256: null,
	})),
});
const material = () => ({
	configuration: JSON.stringify({ schema: "qorpera.company-computer-service/v1" }),
	registry: "r".repeat(48),
	native: "n".repeat(43),
	objects: "o".repeat(43),
	tlsCert: "cert",
	tlsKey: "key",
});
const request = () => ({
	schema: "qorpera.office-reset-configuration-request/v1",
	resetId: id(1),
	rootIncarnationId: id(5),
	activationId: id(4),
	predecessor: predecessor(),
	originPreparation: JSON.stringify(original()),
	originPreparationSha256: sha("1"),
	adoptionReceiptSha256: sha("2"),
	material: material(),
});
const files = () =>
	Object.fromEntries(
		Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES).map((file) => [file, { bytes: 8, sha256: sha("3") }]),
	) as CompanyComputerResetConfigurationCompletion["files"];
const completion = (): CompanyComputerResetConfigurationCompletion => ({
	schema: "qorpera.office-reset-configuration-completion/v1",
	command: { commandId: id(20), bootId: id(30), requestSha256: sha("4") },
	resetId: id(1),
	rootIncarnationId: id(5),
	activationId: id(4),
	originPreparationSha256: sha("1"),
	adoptionReceiptSha256: sha("2"),
	files: files(),
});
const successor = (state: CompanyComputerResetSuccessor["state"] = "prepared"): CompanyComputerResetSuccessor => ({
	schema: "qorpera.office-reset-successor/v1",
	request: {
		schema: "qorpera.office-reset-successor-request/v1",
		resetId: id(1),
		rootIncarnationId: id(5),
		predecessor: predecessor(),
		attestation: {
			schema: "qorpera.office-activation-attestation/v1",
			activationId: id(4),
			bootId: id(30),
			preparationObservationSha256: sha("5"),
			configurationObservationSha256: sha("6"),
			configurationSha256: sha("3"),
			adoptionReceiptSha256: sha("2"),
			nativePort: 4011,
			viewerPort: 4012,
		},
		custodySha256: sha("7"),
		restoreSha256: sha("8"),
	},
	state,
	serviceInvocationId: state === "prepared" ? null : "9".repeat(32),
	readinessFresh: state !== "prepared",
	stopAcknowledgedAtMs: 2000,
	officeRevision: 12,
	privacyVersion: 1,
	validForMs: 5000,
});
const start = (): CompanyComputerResetServiceStartCompletion => ({
	schema: "qorpera.office-reset-service-start-completion/v1",
	command: { commandId: id(21), bootId: id(30), requestSha256: sha("9") },
	resetId: id(1),
	activationId: id(4),
	configurationCompletionSha256: sha("a"),
	configurationSha256: sha("3"),
	serviceInvocationId: "9".repeat(32),
	mainPid: 700,
	controlGroup: "/system.slice/qorpera-company-computer.service",
});
describe("reset successor guest contracts", () => {
	it("carries a maximum-sized retained preparation plus credentials without truncating its original bytes", () => {
		const r = request();
		r.originPreparation += " ".repeat(
			COMPANY_COMPUTER_PREPARATION_MAX_BYTES - new TextEncoder().encode(r.originPreparation).length,
		);
		expect(parseCompanyComputerResetConfigurationRequest(r).originPreparation).toBe(r.originPreparation);
		expect(() =>
			parseCompanyComputerResetConfigurationRequest({ ...r, originPreparation: `${r.originPreparation} ` }),
		).toThrow("INVALID_OFFICE_RESET_CONFIGURATION_REQUEST");
	});
	it("binds the origin whatever the key order of the retained scope", () => {
		const r = request();
		const scope = r.predecessor.startup.scope as Record<string, string>;
		const sorted = Object.fromEntries(
			Object.keys(scope)
				.sort()
				.map((key) => [key, scope[key]]),
		);
		const reversed = Object.fromEntries(
			Object.keys(scope)
				.sort()
				.reverse()
				.map((key) => [key, scope[key]]),
		);
		expect(JSON.stringify(sorted)).not.toBe(JSON.stringify(reversed));
		for (const variant of [sorted, reversed])
			expect(
				parseCompanyComputerResetConfigurationRequest({
					...r,
					predecessor: { ...r.predecessor, startup: { ...r.predecessor.startup, scope: variant } },
				}).predecessor.startup.scope,
			).toEqual(scope);
	});
	it("parses a reset configuration packet only for the exact retained origin", () => {
		expect(parseCompanyComputerResetConfigurationRequest(request()).predecessor.action).toBe("replace");
		for (const mutate of [
			(r: ReturnType<typeof request>) => ({ ...r, activationId: id(3) }),
			(r: ReturnType<typeof request>) => ({ ...r, rootIncarnationId: id(1) }),
			(r: ReturnType<typeof request>) => ({ ...r, resetId: id(11) }),
			(r: ReturnType<typeof request>) => ({ ...r, predecessor: { ...r.predecessor, action: "reboot" } }),
			(r: ReturnType<typeof request>) => ({
				...r,
				originPreparation: JSON.stringify({ ...original(), allocationId: id(99) }),
			}),
			(r: ReturnType<typeof request>) => ({ ...r, originPreparation: JSON.stringify({ ...original(), scope: {} }) }),
			(r: ReturnType<typeof request>) => ({ ...r, originPreparation: "" }),
			(r: ReturnType<typeof request>) => ({ ...r, originPreparationSha256: "x" }),
			(r: ReturnType<typeof request>) => ({ ...r, material: { ...r.material, tlsKey: "" } }),
			(r: ReturnType<typeof request>) => ({ ...r, extra: 1 }),
		])
			expect(() => parseCompanyComputerResetConfigurationRequest(mutate(request()))).toThrow(
				"INVALID_OFFICE_RESET_CONFIGURATION_REQUEST",
			);
	});
	it("binds a reset configuration completion to the expected command, identities and file digests", () => {
		expect(parseCompanyComputerResetConfigurationCompletion(completion(), completion())).toEqual(completion());
		for (const mutate of [
			(c: CompanyComputerResetConfigurationCompletion) => ({ ...c, command: { ...c.command, commandId: id(21) } }),
			(c: CompanyComputerResetConfigurationCompletion) => ({ ...c, activationId: id(3) }),
			(c: CompanyComputerResetConfigurationCompletion) => ({ ...c, adoptionReceiptSha256: sha("0") }),
			(c: CompanyComputerResetConfigurationCompletion) => ({
				...c,
				files: { ...c.files, "config.json": { bytes: 8, sha256: sha("0") } },
			}),
			(c: CompanyComputerResetConfigurationCompletion) => ({
				...c,
				files: { ...c.files, "config.json": { bytes: 16385, sha256: sha("3") } },
			}),
		])
			expect(() => parseCompanyComputerResetConfigurationCompletion(mutate(completion()), completion())).toThrow(
				"INVALID_OFFICE_RESET_CONFIGURATION_COMPLETION",
			);
	});
	it("accepts only a prepared successor as the start packet", () => {
		expect(parseCompanyComputerResetServiceStartRequest(successor()).state).toBe("prepared");
		expect(() => parseCompanyComputerResetServiceStartRequest(successor("ready"))).toThrow(
			"INVALID_OFFICE_RESET_SERVICE_START_REQUEST",
		);
		expect(() => parseCompanyComputerResetServiceStartRequest({ ...successor(), request: undefined })).toThrow(
			"INVALID_OFFICE_RESET_SERVICE_START_REQUEST",
		);
	});
	it("binds the start completion and its nonce inspection to the prepared successor", () => {
		const command = start().command;
		expect(parseCompanyComputerResetServiceStartCompletion(start(), command, successor())).toEqual(start());
		for (const mutate of [
			(c: CompanyComputerResetServiceStartCompletion) => ({ ...c, serviceInvocationId: "e".repeat(32) }),
			(c: CompanyComputerResetServiceStartCompletion) => ({ ...c, serviceInvocationId: "0".repeat(32) }),
			(c: CompanyComputerResetServiceStartCompletion) => ({ ...c, configurationSha256: sha("0") }),
			(c: CompanyComputerResetServiceStartCompletion) => ({ ...c, resetId: id(5) }),
			(c: CompanyComputerResetServiceStartCompletion) => ({ ...c, activationId: id(3) }),
			(c: CompanyComputerResetServiceStartCompletion) => ({ ...c, command: { ...c.command, bootId: id(11) } }),
			(c: CompanyComputerResetServiceStartCompletion) => ({ ...c, mainPid: 0 }),
			(c: CompanyComputerResetServiceStartCompletion) => ({ ...c, controlGroup: "/system.slice/other.service" }),
		])
			expect(() => parseCompanyComputerResetServiceStartCompletion(mutate(start()), command, successor())).toThrow(
				"INVALID_OFFICE_RESET_SERVICE_START_COMPLETION",
			);
		const inspection = {
			schema: "qorpera.office-reset-service-inspection/v1",
			inspectionId: id(40),
			start: start(),
		};
		expect(parseCompanyComputerResetServiceInspection(inspection, id(40), start(), successor())).toEqual(inspection);
		expect(() => parseCompanyComputerResetServiceInspection(inspection, id(41), start(), successor())).toThrow(
			"INVALID_OFFICE_RESET_SERVICE_INSPECTION",
		);
		expect(() =>
			parseCompanyComputerResetServiceInspection(
				{ ...inspection, start: { ...start(), mainPid: 701 } },
				id(40),
				start(),
				successor(),
			),
		).toThrow("INVALID_OFFICE_RESET_SERVICE_INSPECTION");
		expect(() => parseCompanyComputerResetServiceInspection(inspection, id(21), start(), successor())).toThrow(
			"INVALID_OFFICE_RESET_SERVICE_INSPECTION",
		);
	});
});

describe("reset retained adoption receipt", () => {
	it("binds the original attested receipt to the recreated root's boot", () => {
		const r = parseCompanyComputerResetConfigurationRequest(request());
		const receipt = companyComputerResetAdoptionReceipt(r, id(90));
		expect(receipt.schema).toBe("qorpera.office-state-reset-retained/v1");
		expect(receipt.bootId).toBe(id(90));
		expect(receipt.origin).toEqual({
			bootId: original().bootId,
			preparationSha256: sha("1"),
			adoptionReceiptSha256: sha("2"),
		});
		expect(receipt.reset).toEqual({
			resetId: id(1),
			rootIncarnationId: id(5),
			activationId: id(4),
			predecessor: {
				transitionId: r.predecessor.transitionId,
				activationId: r.predecessor.activationId,
				bootId: r.predecessor.startup.bootId,
			},
		});
		expect(parseCompanyComputerResetAdoptionReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
		expect(companyComputerResetAdoptionReceiptPath(id(90))).toBe(
			`/etc/qorpera-office/boots/${id(90).replaceAll("-", "")}/reset-adoption.json`,
		);
	});
	it("refuses a reused or foreign boot", () => {
		const r = parseCompanyComputerResetConfigurationRequest(request());
		expect(() => companyComputerResetAdoptionReceipt(r, original().bootId)).toThrow(
			"INVALID_OFFICE_RESET_ADOPTION_RECEIPT",
		);
		expect(() => companyComputerResetAdoptionReceipt(r, r.predecessor.startup.bootId)).toThrow(
			"INVALID_OFFICE_RESET_ADOPTION_RECEIPT",
		);
		const receipt = JSON.parse(JSON.stringify(companyComputerResetAdoptionReceipt(r, id(90))));
		expect(() => parseCompanyComputerResetAdoptionReceipt({ ...receipt, extra: 1 })).toThrow(
			"INVALID_OFFICE_RESET_ADOPTION_RECEIPT",
		);
		expect(() =>
			parseCompanyComputerResetAdoptionReceipt({ ...receipt, schema: "qorpera.office-state-retained/v1" }),
		).toThrow("INVALID_OFFICE_RESET_ADOPTION_RECEIPT");
	});
});
