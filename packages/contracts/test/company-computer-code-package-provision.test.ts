import { describe, expect, it } from "vitest";
import {
	COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS,
	COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES,
	parseCompanyComputerCodePackageProvisionEnvelope,
	parseCompanyComputerCodePackageProvisionPlan,
	parseCompanyComputerCodePackageProvisionReceipt,
	parseCompanyComputerCodePackageProvisionRequest,
	parseCompanyComputerCodePackageProvisionStatement,
} from "../src/company-computer-code-package-provision.ts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const sha = "a".repeat(64);
const statement = () => ({
	schema: "qorpera.office-code-package-provision-statement/v1",
	base: { imageSha256: sha, bootstrapSha256: sha, packageManifestSha256: sha, sourceCommit: "a".repeat(40) },
	target: {
		packageManifestSha256: sha,
		sourceCommit: "b".repeat(40),
		runtimeBundle: { id: "qorpera.cloud-runtime", version: 24, sha256: sha },
		service: { path: "/opt/qorpera-office/qorpera-company-computer-service.mjs", bytes: 123, sha256: sha },
		capabilities: [...COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES],
	},
	tools: { bootstrap: { bytes: 123, sha256: sha }, measure: { bytes: 123, sha256: sha } },
	compatibility: { baseInstallationReceiptSha256: sha, unchangedExternalDependenciesSha256: sha },
	acceptance: { testedAt: "2026-09-12T00:00:00.000Z", evidenceSha256: sha, change: "code-only-package" },
});
const plan = () => ({
	schema: "qorpera.lxd-office-code-package-provision-plan/v1",
	provisionId: id(1),
	resetId: id(2),
	resetPlanSha256: sha,
	providerBindingSha256: sha,
	rootIncarnationId: id(3),
	successorActivationId: id(4),
	statementSha256: sha,
	expectedSoftwareRevision: null,
	targetRevision: 1,
	installCommandId: id(5),
});
const request = () => ({
	schema: "qorpera.office-code-package-provision-request/v1",
	plan: plan(),
	planSha256: sha,
	bootId: id(6),
	restoreSha256: sha,
	challengeId: id(7),
	targetRevision: 1,
	capabilityRevision: 1,
	targetManifestSha256: sha,
});
const receipt = () => ({
	schema: "qorpera.office-code-package-provision-receipt/v1",
	planSha256: sha,
	provisionId: id(1),
	resetId: id(2),
	rootIncarnationId: id(3),
	bootId: id(6),
	commandId: id(5),
	requestSha256: sha,
	restoreSha256: sha,
	state: "installed",
	targetRevision: 1,
	packageManifestSha256: sha,
	installedInventorySha256: sha,
	sourceCommit: "b".repeat(40),
	runtimeBundle: statement().target.runtimeBundle,
	service: statement().target.service,
});

describe("code-only package provisioning contracts", () => {
	it("retains distinct package domain, nullable baseline, stable challenge and complete receipt identity", () => {
		expect(COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS).toHaveLength(14);
		expect(new Set(COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS).size).toBe(14);
		expect(parseCompanyComputerCodePackageProvisionPlan(plan()).expectedSoftwareRevision).toBeNull();
		expect(
			parseCompanyComputerCodePackageProvisionPlan({ ...plan(), expectedSoftwareRevision: 0 })
				.expectedSoftwareRevision,
		).toBe(0);
		expect(parseCompanyComputerCodePackageProvisionRequest(request())).toEqual(request());
		expect(parseCompanyComputerCodePackageProvisionReceipt(receipt())).toEqual(receipt());
		expect(parseCompanyComputerCodePackageProvisionStatement(statement()).base.packageManifestSha256).toBe(sha);
	});
	it("copies and freezes caller-owned nested data", () => {
		const input = statement(),
			parsed = parseCompanyComputerCodePackageProvisionStatement(input);
		input.target.service.sha256 = "f".repeat(64);
		input.target.capabilities.reverse();
		expect(parsed.target.service.sha256).toBe(sha);
		expect(Object.isFrozen(parsed.target.service)).toBe(true);
		expect(Object.isFrozen(parsed.target.capabilities)).toBe(true);
	});
	it.each(["extra", "symbol", "getter", "prototype"])(
		"rejects ambiguous %s record without invoking accessors",
		(kind) => {
			const value = plan();
			if (kind === "extra") Object.assign(value, { untrusted: true });
			if (kind === "symbol") Object.assign(value, { [Symbol("hidden")]: true });
			if (kind === "prototype") Object.setPrototypeOf(value, { hidden: true });
			if (kind === "getter")
				Object.defineProperty(value, "targetRevision", {
					get() {
						throw new Error("accessor invoked");
					},
				});
			expect(() => parseCompanyComputerCodePackageProvisionPlan(value)).toThrow("INVALID_CODE_PACKAGE_RECORD");
		},
	);
	it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid target revision %s",
		(targetRevision) => {
			expect(() => parseCompanyComputerCodePackageProvisionPlan({ ...plan(), targetRevision })).toThrow();
		},
	);
	it.each(["service-only", "full-package", "code-only-package/v2"])("rejects widened acceptance %s", (change) => {
		const value = statement();
		value.acceptance.change = change;
		expect(() => parseCompanyComputerCodePackageProvisionStatement(value)).toThrow();
	});
	it.each(["capability", "service-path", "tool-overflow", "date", "bundle"])(
		"rejects malformed statement %s",
		(kind) => {
			const value = statement();
			if (kind === "capability") value.target.capabilities.reverse();
			if (kind === "service-path") value.target.service.path = "/etc/evil";
			if (kind === "tool-overflow") value.tools.bootstrap.bytes = 16 * 1024 ** 2 + 1;
			if (kind === "date") value.acceptance.testedAt = "2026-02-30T00:00:00.000Z";
			if (kind === "bundle") value.target.runtimeBundle.id = "other-runtime";
			expect(() => parseCompanyComputerCodePackageProvisionStatement(value)).toThrow();
		},
	);
	it("rejects reused identities and revision drift in requests and receipts", () => {
		expect(() => parseCompanyComputerCodePackageProvisionPlan({ ...plan(), resetId: id(1) })).toThrow();
		expect(() => parseCompanyComputerCodePackageProvisionRequest({ ...request(), challengeId: id(6) })).toThrow();
		expect(() => parseCompanyComputerCodePackageProvisionRequest({ ...request(), targetRevision: 2 })).toThrow();
		expect(() => parseCompanyComputerCodePackageProvisionReceipt({ ...receipt(), commandId: id(6) })).toThrow();
		expect(() => parseCompanyComputerCodePackageProvisionReceipt({ ...receipt(), state: "partial" })).toThrow();
	});
	it("rejects other envelope domains and malformed signatures", () => {
		const value = {
			schema: "qorpera.office-code-package-provision-envelope/v1",
			statement: statement(),
			signature: { algorithm: "ed25519", value: `${"A".repeat(86)}==` },
		};
		expect(parseCompanyComputerCodePackageProvisionEnvelope(value).statement).toEqual(statement());
		expect(() =>
			parseCompanyComputerCodePackageProvisionEnvelope({
				...value,
				schema: "qorpera.office-service-software-envelope/v1",
			}),
		).toThrow();
		expect(() =>
			parseCompanyComputerCodePackageProvisionEnvelope({
				...value,
				signature: { ...value.signature, value: "short" },
			}),
		).toThrow();
	});
});
