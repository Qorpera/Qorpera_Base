import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	loadLxdOfficeCodePackageCapability,
	parseLxdOfficeCodePackageLaneDocument,
} from "../src/lxd-office-code-package-lane.ts";

const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
const capability = "a".repeat(64),
	sha = "b".repeat(64);
const document = () => ({
	schema: "qorpera.lxd-office-code-package-lane/v1",
	envelopePath: "/protected/envelope.json",
	planPath: "/protected/plan.json",
	baseManifestPath: "/protected/base.json",
	targetManifestPath: "/protected/target.json",
	baseInstallationReceiptPath: "/protected/installation.json",
	baseMountTemplatePath: "/protected/private.mount.in",
	artifactRoot: "/protected/artifacts",
	bootstrapToolPath: "/protected/bootstrap.cjs",
	measurementToolPath: "/protected/measure.cjs",
	trust: {
		verificationKeySpki: key,
		statementSha256: sha,
		planSha256: sha,
		baseInstallationReceiptSha256: sha,
		unchangedExternalDependenciesSha256: sha,
	},
	providerCapabilityCredential: {
		path: "/protected/package.credential",
		bytes: 64,
		sha256: createHash("sha256").update(capability).digest("hex"),
	},
});
describe("protected code package lane configuration", () => {
	it("keeps capability outside public documents and clears credential buffers after loading", async () => {
		const bytes = Buffer.from(capability),
			read = vi.fn(async () => bytes),
			parsed = parseLxdOfficeCodePackageLaneDocument(document());
		expect(await loadLxdOfficeCodePackageCapability(parsed, read)).toBe(capability);
		expect(read).toHaveBeenCalledWith("/protected/package.credential", 64);
		expect(bytes.every((b) => b === 0)).toBe(true);
		expect(JSON.stringify(parsed)).not.toContain(capability);
		expect(Object.isFrozen(parsed.trust)).toBe(true);
	});
	it.each([
		"envelopePath",
		"planPath",
		"baseManifestPath",
		"targetManifestPath",
		"baseInstallationReceiptPath",
		"baseMountTemplatePath",
		"baseFolderMountTemplatePath",
		"artifactRoot",
		"bootstrapToolPath",
		"measurementToolPath",
	])("rejects unconfined %s", (key) => {
		expect(() => parseLxdOfficeCodePackageLaneDocument({ ...document(), [key]: "../outside" })).toThrow(
			"INVALID_OFFICE_CODE_PACKAGE_LANE",
		);
	});
	it("takes the company folder's mount template path only when the document names one", () => {
		expect(parseLxdOfficeCodePackageLaneDocument(document())).not.toHaveProperty("baseFolderMountTemplatePath");
		const folder = { ...document(), baseFolderMountTemplatePath: "/protected/folder-mount@.service.in" };
		expect(parseLxdOfficeCodePackageLaneDocument(folder).baseFolderMountTemplatePath).toBe(
			"/protected/folder-mount@.service.in",
		);
		expect(() =>
			parseLxdOfficeCodePackageLaneDocument({ ...document(), baseFolderMountTemplatePath: undefined }),
		).toThrow("INVALID_OFFICE_CODE_PACKAGE_LANE");
	});
	it.each(["size", "digest", "encoding"])("clears rejected %s capability without exposing content", async (fault) => {
		const bytes = Buffer.from(
			fault === "size" ? "a".repeat(65) : fault === "encoding" ? "z".repeat(64) : "c".repeat(64),
		);
		await expect(
			loadLxdOfficeCodePackageCapability(parseLxdOfficeCodePackageLaneDocument(document()), async () => bytes),
		).rejects.toThrow("OFFICE_CODE_PACKAGE_CAPABILITY_UNCONFIRMED");
		expect(bytes.every((b) => b === 0)).toBe(true);
	});
	it("rejects arbitrary trust and privileged extension fields", () => {
		expect(() =>
			parseLxdOfficeCodePackageLaneDocument({
				...document(),
				trust: { ...document().trust, verificationKeySpki: "untrusted" },
			}),
		).toThrow();
		expect(() => parseLxdOfficeCodePackageLaneDocument({ ...document(), allowImageChange: true })).toThrow();
	});
});
