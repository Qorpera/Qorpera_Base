import { COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { loadLxdOfficeCodePackageMaterial } from "../src/lxd-office-code-package-material.ts";
import { officeCodePackageMaterialFixture } from "./fixtures/office-code-package-material.ts";

const signal = () => new AbortController().signal;
describe("protected signed reset package preflight", () => {
	it("accepts historical base with missing reset helpers only with signed complete target and all14code bytes", async () => {
		const f = officeCodePackageMaterialFixture(),
			m = await loadLxdOfficeCodePackageMaterial(f.document, f.policy, f.resetPlan, signal(), f.ports);
		expect(m.artifacts.size).toBe(14);
		expect(m.providerCapability).toBe(f.capability);
		expect(m.verified.baseArtifacts.length + 3).toBe(m.verified.targetArtifacts.length);
		expect(f.readBuffers.at(-1)!.every((b) => b === 0)).toBe(true);
		m.dispose();
		expect(f.readBuffers.every((b) => b.every((v) => v === 0))).toBe(true);
	});
	it.each(COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS)(
		"rejects changed staged %s before reading capability",
		async (file) => {
			const f = officeCodePackageMaterialFixture();
			f.files.set(f.artifactPath(file), Buffer.from("tampered"));
			await expect(
				loadLxdOfficeCodePackageMaterial(f.document, f.policy, f.resetPlan, signal(), f.ports),
			).rejects.toThrow("OFFICE_CODE_PACKAGE_MATERIAL_UNCONFIRMED");
			expect(f.reads).not.toContain(f.document.providerCapabilityCredential.path);
			expect(f.readBuffers.every((b) => b.every((v) => v === 0))).toBe(true);
		},
	);
	it("reads a folder base's mount template from the path the lane document names", async () => {
		const f = officeCodePackageMaterialFixture({ folder: true }),
			m = await loadLxdOfficeCodePackageMaterial(f.document, f.policy, f.resetPlan, signal(), f.ports);
		expect(f.reads).toContain("/protected/folder-mount.in");
		expect(m.manifests.baseFolderMountTemplate).toEqual(f.manifests.baseFolderMountTemplate);
		m.dispose();
		expect(f.readBuffers.every((b) => b.every((v) => v === 0))).toBe(true);
	});
	it.each(["missing", "unnamed"])("rejects a folder base whose mount template is %s", async (kind) => {
		const f = officeCodePackageMaterialFixture({ folder: true });
		if (kind === "missing") f.files.delete(f.document.baseFolderMountTemplatePath!);
		const { baseFolderMountTemplatePath: _, ...unnamed } = f.document;
		await expect(
			loadLxdOfficeCodePackageMaterial(
				kind === "unnamed" ? unnamed : f.document,
				f.policy,
				f.resetPlan,
				signal(),
				f.ports,
			),
		).rejects.toThrow("OFFICE_CODE_PACKAGE_MATERIAL_UNCONFIRMED");
		expect(f.reads).not.toContain(f.document.providerCapabilityCredential.path);
	});
	it.each([
		"bootstrapToolPath",
		"measurementToolPath",
		"baseManifestPath",
		"baseInstallationReceiptPath",
		"baseMountTemplatePath",
	] as const)("rejects missing %s", async (key) => {
		const f = officeCodePackageMaterialFixture();
		f.files.delete(f.document[key]);
		await expect(
			loadLxdOfficeCodePackageMaterial(f.document, f.policy, f.resetPlan, signal(), f.ports),
		).rejects.toThrow("OFFICE_CODE_PACKAGE_MATERIAL_UNCONFIRMED");
	});
	it("refuses a valid signed package targeting another immutable image", async () => {
		const f = officeCodePackageMaterialFixture();
		f.policy.guest.imageFingerprint = "f".repeat(64);
		await expect(
			loadLxdOfficeCodePackageMaterial(f.document, f.policy, f.resetPlan, signal(), f.ports),
		).rejects.toThrow("OFFICE_CODE_PACKAGE_MATERIAL_UNCONFIRMED");
		expect(f.reads).not.toContain(f.document.bootstrapToolPath);
	});
	it("refuses a policy manifest mismatch despite a valid signature", async () => {
		const f = officeCodePackageMaterialFixture();
		f.policy.image.guestPackageManifestSha256 = "f".repeat(64);
		await expect(
			loadLxdOfficeCodePackageMaterial(f.document, f.policy, f.resetPlan, signal(), f.ports),
		).rejects.toThrow("OFFICE_CODE_PACKAGE_MATERIAL_UNCONFIRMED");
	});
	it("refuses already canceled preflight without reads", async () => {
		const f = officeCodePackageMaterialFixture();
		await expect(
			loadLxdOfficeCodePackageMaterial(f.document, f.policy, f.resetPlan, AbortSignal.abort(), f.ports),
		).rejects.toThrow();
		expect(f.reads).toEqual([]);
	});
});
