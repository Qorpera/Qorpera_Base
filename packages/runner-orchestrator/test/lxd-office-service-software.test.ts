import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	parseCompanyComputerServiceSoftwareEnvelope,
	parseCompanyComputerServiceSoftwarePlan,
	parseCompanyComputerServiceSoftwareReceipt,
	parseCompanyComputerServiceSoftwareStatement,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { OFFICE_IMAGE_PACKAGE_FILES } from "../src/lxd-office-image-installation.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import {
	verifyLxdOfficeServiceSoftware,
	verifyLxdOfficeServiceSoftwareReceipt,
} from "../src/lxd-office-service-software.ts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fixture() {
	const keys = generateKeyPairSync("ed25519");
	const previous = {
		schema: "qorpera.company-computer-package/v1",
		platform: "linux",
		minimumNode: "22.19.0",
		playwright: "1.62.1",
		imagePrerequisites: [
			"cgroup-v2",
			"systemd-credentials",
			"unprivileged-user-namespaces",
			"bubblewrap",
			"tini",
			"xfce",
			"tigervnc",
			"chromium",
		],
		artifacts: [
			...OFFICE_IMAGE_PACKAGE_FILES,
			"node_modules/playwright-core/package.json",
			"node_modules/playwright-core/index.mjs",
			"node_modules/playwright-core/browsers.json",
			"wallpapers/qorpera-screen-pebble.png",
		].map((file) => ({ file, bytes: 123, sha256: hash(file) })),
	};
	const next = structuredClone(previous);
	next.artifacts[0] = { ...next.artifacts[0], bytes: 234, sha256: hash("new service") };
	const manifests = { previous: Buffer.from(JSON.stringify(previous)), next: Buffer.from(JSON.stringify(next)) };
	const statement = {
		schema: "qorpera.office-service-software-statement/v1",
		base: {
			sourceCommit: "1".repeat(40),
			imageSha256: hash("original image"),
			bootstrapSha256: hash("bootstrap"),
			packageManifestSha256: hash(manifests.previous),
		},
		previous: {
			sourceCommit: "1".repeat(40),
			packageManifestSha256: hash(manifests.previous),
			service: {
				path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
				bytes: previous.artifacts[0].bytes,
				sha256: previous.artifacts[0].sha256,
			},
		},
		next: {
			packageManifestSha256: hash(manifests.next),
			service: {
				path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
				bytes: next.artifacts[0].bytes,
				sha256: next.artifacts[0].sha256,
			},
		},
		source: { repository: "https://example.test/source", commit: "a".repeat(40), tree: "clean" },
		acceptance: {
			testedAt: "2026-09-12T00:00:00.000Z",
			evidenceSha256: hash("reviewed evidence"),
			change: "service-only",
		},
	};
	const plan = {
		schema: "qorpera.office-service-software-plan/v1",
		updateId: randomUUID(),
		successorActivationId: randomUUID(),
		stopAcknowledgementSha256: hash("stop"),
		statementSha256: officeDigest(statement),
		predecessor: {
			schema: "qorpera.office-lifecycle-request/v1",
			action: "service_restart",
			transitionId: randomUUID(),
			activationId: randomUUID(),
			providerId: randomUUID(),
			providerPolicySha256: hash("policy"),
			startup: {
				scope: {
					companyId: randomUUID(),
					environmentId: randomUUID(),
					companyComputerId: randomUUID(),
					logicalComputerId: randomUUID(),
				},
				computerGeneration: 1,
				allocationId: randomUUID(),
				instanceSha256: hash("instance"),
				imageSha256: statement.base.imageSha256,
				bootstrapSha256: statement.base.bootstrapSha256,
				bootId: randomUUID(),
				configurationSha256: hash("config"),
				serviceInvocationId: "b".repeat(32),
			},
		},
	};
	const envelope = {
		schema: "qorpera.office-service-software-envelope/v1",
		statement,
		signature: {
			algorithm: "ed25519",
			value: sign(null, Buffer.from(officeCanonical(statement)), keys.privateKey).toString("base64"),
		},
	};
	const trust = {
		verificationKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
		statementSha256: officeDigest(statement),
		planSha256: officeDigest(plan),
	};
	const receipt = {
		schema: "qorpera.office-service-software-receipt/v1",
		plan,
		planSha256: trust.planSha256,
		state: "installed",
		service: { ...statement.next.service },
		installedAt: "2026-09-12T01:00:00.000Z",
	};
	return { keys, previous, next, manifests, statement, envelope, plan, trust, receipt };
}
describe("service-only software evidence prerequisite (no installation or admission)", () => {
	it("verifies signed software evidence separately from the retained base image and binds a historical receipt", () => {
		const f = fixture();
		const verified = verifyLxdOfficeServiceSoftware(f.envelope, f.plan, f.trust, f.manifests);
		expect(verified.statement.base).toEqual(f.statement.base);
		expect(verified.plan.predecessor.startup).toEqual(f.plan.predecessor.startup);
		expect(verifyLxdOfficeServiceSoftwareReceipt(f.receipt, f.envelope, f.plan, f.trust, f.manifests)).toEqual(
			f.receipt,
		);
		f.statement.next.service.sha256 = hash("changed caller");
		f.plan.predecessor.startup.scope.companyId = randomUUID();
		expect(verified.statement.next.service.sha256).not.toBe(f.statement.next.service.sha256);
		expect(verified.plan.predecessor.startup.scope.companyId).not.toBe(f.plan.predecessor.startup.scope.companyId);
		expect(Object.isFrozen(verified.statement.next.service)).toBe(true);
		expect(Object.isFrozen(verified.plan.predecessor.startup.scope)).toBe(true);
	});
	it("rejects changed trust roots, unsigned substitutions and other envelope domains", () => {
		const f = fixture();
		for (const trust of [
			{ ...f.trust, verificationKeySpki: fixture().trust.verificationKeySpki },
			{ ...f.trust, statementSha256: hash("changed") },
			{ ...f.trust, planSha256: hash("changed") },
		])
			expect(() => verifyLxdOfficeServiceSoftware(f.envelope, f.plan, trust, f.manifests)).toThrow(
				"OFFICE_SERVICE_SOFTWARE_UNCONFIRMED",
			);
		f.statement.source.commit = "c".repeat(40);
		f.plan.statementSha256 = officeDigest(f.statement);
		expect(() =>
			verifyLxdOfficeServiceSoftware(
				f.envelope,
				f.plan,
				{ ...f.trust, statementSha256: f.plan.statementSha256, planSha256: officeDigest(f.plan) },
				f.manifests,
			),
		).toThrow();
		expect(() =>
			parseCompanyComputerServiceSoftwareEnvelope({
				...f.envelope,
				schema: "qorpera.lxd-office-image-provenance-envelope/v1",
			}),
		).toThrow();
	});
	it("refuses every substituted scope, physical identity and successor binding against the protected plan digest", () => {
		const f = fixture();
		const candidates = [
			...Object.keys(f.plan.predecessor.startup.scope).map((key) => ({
				...f.plan,
				predecessor: {
					...f.plan.predecessor,
					startup: {
						...f.plan.predecessor.startup,
						scope: { ...f.plan.predecessor.startup.scope, [key]: randomUUID() },
					},
				},
			})),
			...[
				"allocationId",
				"bootId",
				"instanceSha256",
				"configurationSha256",
				"serviceInvocationId",
				"computerGeneration",
			].map((key) => ({
				...f.plan,
				predecessor: {
					...f.plan.predecessor,
					startup: {
						...f.plan.predecessor.startup,
						[key]:
							key === "computerGeneration"
								? 2
								: key.endsWith("Sha256")
									? hash("changed")
									: key === "serviceInvocationId"
										? "c".repeat(32)
										: randomUUID(),
					},
				},
			})),
			...["activationId", "transitionId", "providerId", "providerPolicySha256"].map((key) => ({
				...f.plan,
				predecessor: { ...f.plan.predecessor, [key]: key.endsWith("Sha256") ? hash("changed") : randomUUID() },
			})),
			...["updateId", "successorActivationId", "stopAcknowledgementSha256"].map((key) => ({
				...f.plan,
				[key]: key.endsWith("Sha256") ? hash("changed") : randomUUID(),
			})),
		];
		for (const plan of candidates)
			expect(() => verifyLxdOfficeServiceSoftware(f.envelope, plan, f.trust, f.manifests)).toThrow();
		for (const key of ["imageSha256", "bootstrapSha256"]) {
			const plan = {
				...f.plan,
				predecessor: {
					...f.plan.predecessor,
					startup: { ...f.plan.predecessor.startup, [key]: hash("different base") },
				},
			};
			expect(() =>
				verifyLxdOfficeServiceSoftware(
					f.envelope,
					plan,
					{ ...f.trust, planSha256: officeDigest(plan) },
					f.manifests,
				),
			).toThrow();
		}
	});
	it.each(["helper", "unit", "dependency", "added", "removed", "playwright"])(
		"rejects a signed package that changes %s in addition to the service",
		(kind) => {
			const f = fixture();
			if (kind === "added")
				f.next.artifacts.push({ file: "node_modules/playwright-core/extra", bytes: 1, sha256: hash("extra") });
			else if (kind === "removed") f.next.artifacts.pop();
			else if (kind === "playwright") f.next.playwright = "9.0.0";
			else {
				const file =
					kind === "helper"
						? "qorpera-company-computer-service-stop-control.mjs"
						: kind === "unit"
							? "qorpera-company-computer.service"
							: "node_modules/playwright-core/index.mjs";
				f.next.artifacts.find((a) => a.file === file)!.sha256 = hash("different");
			}
			f.manifests.next = Buffer.from(JSON.stringify(f.next));
			f.statement.next.packageManifestSha256 = hash(f.manifests.next);
			f.envelope.signature.value = sign(null, Buffer.from(officeCanonical(f.statement)), f.keys.privateKey).toString(
				"base64",
			);
			f.plan.statementSha256 = officeDigest(f.statement);
			expect(() =>
				verifyLxdOfficeServiceSoftware(
					f.envelope,
					f.plan,
					{ ...f.trust, statementSha256: f.plan.statementSha256, planSha256: officeDigest(f.plan) },
					f.manifests,
				),
			).toThrow();
		},
	);
	it("refuses raw manifest alteration, missing material and service-byte mismatches", () => {
		const f = fixture();
		for (const bytes of [Buffer.from("{}"), Buffer.alloc(1024 ** 2 + 1), Buffer.alloc(0)])
			expect(() =>
				verifyLxdOfficeServiceSoftware(f.envelope, f.plan, f.trust, { ...f.manifests, next: bytes }),
			).toThrow();
		f.statement.next.service.bytes++;
		f.envelope.signature.value = sign(null, Buffer.from(officeCanonical(f.statement)), f.keys.privateKey).toString(
			"base64",
		);
		f.plan.statementSha256 = officeDigest(f.statement);
		expect(() =>
			verifyLxdOfficeServiceSoftware(
				f.envelope,
				f.plan,
				{ ...f.trust, statementSha256: f.plan.statementSha256, planSha256: officeDigest(f.plan) },
				f.manifests,
			),
		).toThrow();
	});
	it("rejects non-service targets, extra fields, reused identities and unsupported acceptance", () => {
		const f = fixture();
		for (const path of [
			"/etc/passwd",
			"/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs",
			"/etc/qorpera-office/credentials/config.json",
			`${COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH}/../other`,
		])
			expect(() =>
				parseCompanyComputerServiceSoftwareStatement({
					...f.statement,
					next: { ...f.statement.next, service: { ...f.statement.next.service, path } },
				}),
			).toThrow();
		for (const bytes of [0, -1, 1.5, 32 * 1024 ** 2 + 1])
			expect(() =>
				parseCompanyComputerServiceSoftwareStatement({
					...f.statement,
					next: { ...f.statement.next, service: { ...f.statement.next.service, bytes } },
				}),
			).toThrow();
		for (const change of [
			{ extra: true },
			{ next: { ...f.statement.next, service: f.statement.previous.service } },
			{ next: { ...f.statement.next, packageManifestSha256: f.statement.previous.packageManifestSha256 } },
			{ base: { ...f.statement.base, sourceCommit: "invalid" } },
			{ previous: { ...f.statement.previous, sourceCommit: "invalid" } },
			{ acceptance: { ...f.statement.acceptance, change: "whole-image" } },
			{ source: { ...f.statement.source, tree: "dirty" } },
			{ source: { ...f.statement.source, repository: "https://user:secret@example.test/" } },
		])
			expect(() => parseCompanyComputerServiceSoftwareStatement({ ...f.statement, ...change })).toThrow();
		for (const change of [
			{ successorActivationId: f.plan.predecessor.activationId },
			{ updateId: f.plan.predecessor.transitionId },
			{ predecessor: { ...f.plan.predecessor, action: "replace" } },
			{ extra: true },
		])
			expect(() => parseCompanyComputerServiceSoftwarePlan({ ...f.plan, ...change })).toThrow();
	});
	it("binds acceptance and source lineage to the signed target and rejects hidden fields", () => {
		for (const field of ["base", "previous", "acceptance"] as const) {
			const f = fixture();
			if (field === "acceptance") f.statement.acceptance.evidenceSha256 = hash("different evidence");
			else f.statement[field].sourceCommit = "d".repeat(40);
			f.plan.statementSha256 = officeDigest(f.statement);
			expect(() =>
				verifyLxdOfficeServiceSoftware(
					f.envelope,
					f.plan,
					{
						...f.trust,
						statementSha256: f.plan.statementSha256,
						planSha256: officeDigest(f.plan),
					},
					f.manifests,
				),
			).toThrow("OFFICE_SERVICE_SOFTWARE_UNCONFIRMED");
		}
		for (const key of ["hidden", Symbol("hidden")]) {
			const f = fixture();
			Object.defineProperty(f.statement, key, { value: "untrusted", enumerable: false });
			expect(() => parseCompanyComputerServiceSoftwareStatement(f.statement)).toThrow();
		}
	});
	it("refuses changed historical receipts and never interprets them as successor activation", () => {
		const f = fixture();
		for (const change of [
			{ plan: fixture().plan },
			{ planSha256: hash("changed") },
			{ service: f.statement.previous.service },
			{ installedAt: "2026-09-11T00:00:00.000Z" },
			{ state: "active" },
			{ serviceInvocationId: "a".repeat(32) },
		])
			expect(() =>
				verifyLxdOfficeServiceSoftwareReceipt(
					{ ...f.receipt, ...change },
					f.envelope,
					f.plan,
					f.trust,
					f.manifests,
				),
			).toThrow("OFFICE_SERVICE_SOFTWARE_RECEIPT_UNCONFIRMED");
		expect(() =>
			parseCompanyComputerServiceSoftwareReceipt({ ...f.receipt, installedAt: "2026-02-30T00:00:00.000Z" }),
		).toThrow();
	});
});
