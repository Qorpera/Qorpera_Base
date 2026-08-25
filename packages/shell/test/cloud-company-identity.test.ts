import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompanyManifest, scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { afterEach, describe, expect, it } from "vitest";
import { alignCloudCompanyManifestName } from "../src/managed-company-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("cloud company identity", () => {
	it("replaces a staging-folder name without changing company identity", async () => {
		const root = await mkdtemp(join(realpathSync(tmpdir()), "qorpera-company-file-stage-"));
		temporaryDirectories.push(root);
		scaffoldCompany(root);
		const before = readCompanyManifest(root);

		expect(alignCloudCompanyManifestName(root, "Company41")).toBe(true);
		expect(readCompanyManifest(root)).toEqual({ ...before, name: "Company41" });
		expect(alignCloudCompanyManifestName(root, "Company41")).toBe(false);
	});

	it("refuses an invalid hosted profile name before changing the manifest", async () => {
		const root = await mkdtemp(join(realpathSync(tmpdir()), "qorpera-company-file-stage-"));
		temporaryDirectories.push(root);
		scaffoldCompany(root);
		const before = readCompanyManifest(root);

		expect(() => alignCloudCompanyManifestName(root, " Company41 ")).toThrow("Cloud profile name is invalid");
		expect(readCompanyManifest(root)).toEqual(before);
	});
});
