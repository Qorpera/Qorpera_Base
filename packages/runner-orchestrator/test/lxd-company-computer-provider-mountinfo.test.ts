import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LinuxNfsCompanyDatasetSourceVerifier } from "../src/lxd-company-computer-provider.ts";

describe("Linux Company Computer dataset verification", () => {
	it("accepts a writable NFS superblock inside the provider's read-only mount namespace", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-company-mountinfo-"));
		try {
			const dataset = join(root, "company41");
			const mountInfo = join(root, "mountinfo");
			await mkdir(dataset);
			const physicalRoot = await realpath(root);
			await writeFile(
				mountInfo,
				`998 744 0:76 / ${physicalRoot} ro,nosuid,noatime - nfs4 192.168.0.91:/volume1/qorpera-companies rw,vers=4.1\n`,
			);

			await expect(
				new LinuxNfsCompanyDatasetSourceVerifier(mountInfo).verifyDatasetSource(root, dataset),
			).resolves.toBe(undefined);

			await writeFile(
				mountInfo,
				`998 744 0:76 / ${physicalRoot} ro,nosuid,noatime - nfs4 192.168.0.91:/volume1/qorpera-companies ro,vers=4.1\n`,
			);
			await expect(
				new LinuxNfsCompanyDatasetSourceVerifier(mountInfo).verifyDatasetSource(root, dataset),
			).rejects.toThrow("Company computer NAS dataset root is not mounted read-write");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
