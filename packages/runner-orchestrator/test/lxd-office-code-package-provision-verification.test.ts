import { createHash, randomUUID, sign } from "node:crypto";
import {
	COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS,
	COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import {
	verifyLxdOfficeCodePackageProvision,
	verifyLxdOfficeCodePackageProvisionReceipt,
	verifyLxdOfficeCodePackageProvisionRequest,
} from "../src/lxd-office-code-package-provision-verification.ts";
import {
	OFFICE_IMAGE_FOLDER_MOUNT_UNIT,
	OFFICE_IMAGE_FOLDER_PACKAGE_FILES,
} from "../src/lxd-office-image-installation.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import { verifyLxdOfficeServiceSoftware } from "../src/lxd-office-service-software.ts";
import { officeSoftwareFixture } from "./fixtures/office-software.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

import { officeCodePackageSignedFixture as fixture } from "./fixtures/office-code-package-signed.ts";

describe("pure signed code-only package verification", () => {
	it("allows exactly 14 code differences while retaining complete baseline inventory", () => {
		const f = fixture(),
			v = f.run();
		expect(v.changedArtifacts.map((a) => a.file)).toEqual([...COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS]);
		expect(v.targetArtifacts.length).toBe(v.baseArtifacts.length + 3);
		expect(v.inventorySha256).toBe(officeDigest(v.targetInstalledArtifacts));
		expect(v.targetInstalledArtifacts).toHaveLength(v.targetArtifacts.length + 4);
		expect(v.changedArtifacts.every((a) => a.mode === 0o444 && a.path.startsWith("/opt/qorpera-office/"))).toBe(true);
		expect(Object.isFrozen(v.targetArtifacts[0])).toBe(true);
		f.statement.target.service.sha256 = hash("caller mutation");
		expect(v.statement.target.service.sha256).not.toBe(f.statement.target.service.sha256);
	});
	it("requires a claimable measured revision even when base and target are identical", () => {
		const f = fixture();
		f.base.artifacts = structuredClone(f.target.artifacts);
		const v = f.run();
		expect(v.changedArtifacts).toEqual([]);
		expect(v.baseArtifacts).toEqual(v.targetArtifacts);
	});
	it("renders a base's company folder mount template and leaves the folder's group as the image installed it", () => {
		const v = fixture({ folder: true }).run();
		const template = v.baseArtifacts.find((a) => a.file === `${OFFICE_IMAGE_FOLDER_MOUNT_UNIT}.in`)!;
		const unit = v.baseInstalledArtifacts.find((a) => a.path === template.path)!;
		expect(unit).toMatchObject({ path: `/etc/systemd/system/${OFFICE_IMAGE_FOLDER_MOUNT_UNIT}`, mode: 0o644 });
		expect(unit.sha256).not.toBe(template.sha256);
		expect(v.targetInstalledArtifacts).toContainEqual(unit);
		expect(v.changedArtifacts.map((a) => a.file)).toEqual([...COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS]);
		for (const file of OFFICE_IMAGE_FOLDER_PACKAGE_FILES) {
			const before = v.baseArtifacts.find((a) => a.file === file)!;
			expect(v.targetArtifacts.find((a) => a.file === file)).toEqual(before);
			expect(v.targetInstalledArtifacts.some((a) => a.path === before.path)).toBe(true);
		}
	});
	it.each(["changed", "removed", "added"])("rejects a code package that %s the company folder", (kind) => {
		const f = fixture({ folder: kind !== "added" });
		if (kind === "changed") f.target.artifacts.find((a) => a.file === "qorpera-folder")!.sha256 = hash("other");
		if (kind === "removed") f.target.artifacts = f.target.artifacts.filter((a) => a.file !== "qorpera-folder");
		if (kind === "added")
			for (const file of OFFICE_IMAGE_FOLDER_PACKAGE_FILES)
				f.target.artifacts.push({ file, bytes: 1, sha256: hash(`folder:${file}`) });
		expect(f.run).toThrow("OFFICE_CODE_PACKAGE_PROVISION_UNCONFIRMED");
	});
	it.each([
		"render",
		"uid",
		"unit-reference",
		"bwrap",
		"extra-path",
		"template-bytes",
		"folder-render",
		"folder-template-bytes",
		"folder-template-missing",
		"foreign-folder-template",
	])("rejects a signed but inconsistent installed mapping %s", (kind) => {
		const f = fixture({ folder: kind.startsWith("folder-") }),
			s = f.signed();
		const receipt = JSON.parse(s.manifests.baseInstallationReceipt.toString()) as {
			uid: number;
			files: { path: string; mode: number; bytes: number; sha256: string }[];
		};
		if (kind === "render") receipt.files.find((a) => a.path.endsWith(".mount"))!.sha256 = hash("unrendered template");
		if (kind === "uid") receipt.uid = 1001;
		if (kind === "unit-reference")
			receipt.files = receipt.files.filter((a) => a.path !== "/opt/qorpera-office/qorpera-company-computer.service");
		if (kind === "bwrap")
			receipt.files.find((a) => a.path.endsWith("/qorpera-browser-bwrap"))!.sha256 = hash("foreign binary");
		if (kind === "extra-path")
			receipt.files.push({ path: "/etc/unrelated", bytes: 1, mode: 0o444, sha256: hash("unexpected") });
		if (kind === "template-bytes") s.manifests.baseMountTemplate = Buffer.from("changed template");
		if (kind === "folder-render")
			receipt.files.find((a) => a.path.endsWith(OFFICE_IMAGE_FOLDER_MOUNT_UNIT))!.sha256 = hash("unrendered");
		if (kind === "folder-template-bytes") s.manifests.baseFolderMountTemplate = Buffer.from("changed template");
		if (kind === "folder-template-missing") delete s.manifests.baseFolderMountTemplate;
		// A base without the company folder takes no folder template.
		if (kind === "foreign-folder-template")
			s.manifests.baseFolderMountTemplate = Buffer.from("[Service]\nExecStart=x @OFFICE_UID@ @OFFICE_GID@\n");
		s.manifests.baseInstallationReceipt = Buffer.from(JSON.stringify(receipt));
		f.statement.compatibility.baseInstallationReceiptSha256 = hash(s.manifests.baseInstallationReceipt);
		s.trust.baseInstallationReceiptSha256 = f.statement.compatibility.baseInstallationReceiptSha256;
		f.plan.statementSha256 = officeDigest(f.statement);
		s.trust.statementSha256 = f.plan.statementSha256;
		s.trust.planSha256 = officeDigest(f.plan);
		s.envelope.signature.value = sign(
			null,
			Buffer.from(officeCanonical(f.statement)),
			f.old.keys.privateKey,
		).toString("base64");
		expect(() => verifyLxdOfficeCodePackageProvision(s.envelope, f.plan, s.trust, s.manifests, f.reset)).toThrow(
			"OFFICE_CODE_PACKAGE_PROVISION_UNCONFIRMED",
		);
	});
	it.each([
		"dependency",
		"unit",
		"wallpaper",
		"playwright",
		"addition",
		"removal",
		"reset-missing",
		"duplicate",
		"traversal",
		"overflow",
		"zero",
		"aggregate",
	])("rejects signed unsafe inventory %s", (kind) => {
		const f = fixture();
		if (kind === "dependency")
			f.target.artifacts.find((a) => a.file === "node_modules/playwright-core/package.json")!.sha256 =
				hash("tampered");
		if (kind === "unit") f.target.artifacts.find((a) => a.file === "qorpera-company-computer.service")!.bytes++;
		if (kind === "wallpaper")
			f.target.artifacts.find((a) => a.file.startsWith("wallpapers/"))!.sha256 = hash("wallpaper");
		if (kind === "playwright") f.target.playwright = "2.0.0";
		if (kind === "addition")
			f.target.artifacts.push({ file: "node_modules/playwright-core/extra.js", bytes: 1, sha256: hash("extra") });
		if (kind === "removal") f.target.artifacts = f.target.artifacts.filter((a) => a.file !== "LICENSE");
		if (kind === "reset-missing")
			f.target.artifacts = f.target.artifacts.filter(
				(a) => a.file !== COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS[0],
			);
		if (kind === "duplicate") f.target.artifacts.push(f.target.artifacts[0]);
		if (kind === "traversal") f.target.artifacts.push({ file: "../escape.mjs", bytes: 1, sha256: hash("escape") });
		if (kind === "overflow") f.target.artifacts[0].bytes = 32 * 1024 ** 2 + 1;
		if (kind === "zero") f.target.artifacts[0].bytes = 0;
		if (kind === "aggregate") for (const a of f.target.artifacts.slice(0, 5)) a.bytes = 32 * 1024 ** 2;
		expect(f.run).toThrow("OFFICE_CODE_PACKAGE_PROVISION_UNCONFIRMED");
	});
	it.each([
		"key",
		"statement",
		"plan",
		"base-receipt",
		"dependencies",
		"unsigned",
		"manifest-bytes",
		"reset-binding",
		"image",
		"service",
		"command-reuse",
	])("rejects substituted trust or identity %s", (kind) => {
		const f = fixture();
		if (kind === "image") f.statement.base.imageSha256 = hash("other image");
		if (kind === "service") f.statement.target.service.sha256 = hash("other service");
		if (kind === "command-reuse") f.plan.installCommandId = f.reset.commands.createCommandId;
		const s = f.signed();
		if (kind === "key") s.trust.verificationKeySpki = fixture().old.trust.verificationKeySpki;
		if (kind === "statement") s.trust.statementSha256 = hash("other statement");
		if (kind === "plan") s.trust.planSha256 = hash("other plan");
		if (kind === "base-receipt") s.trust.baseInstallationReceiptSha256 = hash("other installation");
		if (kind === "dependencies") s.trust.unchangedExternalDependenciesSha256 = hash("other dependencies");
		if (kind === "unsigned") f.statement.target.sourceCommit = "f".repeat(40);
		if (kind === "manifest-bytes") s.manifests.target = Buffer.concat([s.manifests.target, Buffer.from(" ")]);
		if (kind === "reset-binding") f.reset.rootIncarnationId = randomUUID();
		expect(() => verifyLxdOfficeCodePackageProvision(s.envelope, f.plan, s.trust, s.manifests, f.reset)).toThrow(
			"OFFICE_CODE_PACKAGE_PROVISION_UNCONFIRMED",
		);
	});
	it("binds requests and historical receipts without granting installation authority", () => {
		const f = fixture(),
			v = f.run();
		const request = {
			schema: "qorpera.office-code-package-provision-request/v1",
			plan: v.plan,
			planSha256: v.planSha256,
			bootId: randomUUID(),
			restoreSha256: hash("restore"),
			challengeId: randomUUID(),
			targetRevision: 1,
			capabilityRevision: 1,
			targetManifestSha256: v.statement.target.packageManifestSha256,
		};
		expect(verifyLxdOfficeCodePackageProvisionRequest(request, v)).toEqual(request);
		const receipt = {
			schema: "qorpera.office-code-package-provision-receipt/v1",
			planSha256: v.planSha256,
			provisionId: v.plan.provisionId,
			resetId: v.plan.resetId,
			rootIncarnationId: v.plan.rootIncarnationId,
			bootId: request.bootId,
			commandId: v.plan.installCommandId,
			requestSha256: officeDigest(request),
			restoreSha256: request.restoreSha256,
			state: "installed",
			targetRevision: 1,
			packageManifestSha256: v.statement.target.packageManifestSha256,
			installedInventorySha256: v.inventorySha256,
			sourceCommit: v.statement.target.sourceCommit,
			runtimeBundle: v.statement.target.runtimeBundle,
			service: v.statement.target.service,
		};
		expect(verifyLxdOfficeCodePackageProvisionReceipt(receipt, request, v)).toEqual(receipt);
		for (const change of [
			{ bootId: randomUUID() },
			{ requestSha256: hash("changed request") },
			{ installedInventorySha256: hash("partial") },
			{ targetRevision: 2 },
			{ runtimeBundle: { ...receipt.runtimeBundle, version: 23 } },
		])
			expect(() => verifyLxdOfficeCodePackageProvisionReceipt({ ...receipt, ...change }, request, v)).toThrow();
		expect(() =>
			verifyLxdOfficeCodePackageProvisionRequest({ ...request, targetManifestSha256: hash("wrong") }, v),
		).toThrow();
	});
	it("retains service-only rejection of non-service code changes", () => {
		const f = officeSoftwareFixture();
		f.next.artifacts.find((a) => a.file === "qorpera-company-computer-preparation.mjs")!.sha256 =
			hash("changed preparation");
		f.manifests.next = Buffer.from(JSON.stringify(f.next));
		f.statement.next.packageManifestSha256 = hash(f.manifests.next);
		f.envelope.signature.value = sign(null, Buffer.from(officeCanonical(f.statement)), f.keys.privateKey).toString(
			"base64",
		);
		f.plan.statementSha256 = officeDigest(f.statement);
		f.trust.statementSha256 = f.plan.statementSha256;
		f.trust.planSha256 = officeDigest(f.plan);
		expect(() => verifyLxdOfficeServiceSoftware(f.envelope, f.plan, f.trust, f.manifests)).toThrow();
	});
});
