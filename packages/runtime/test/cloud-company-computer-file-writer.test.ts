import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeCompanyComputerImportStaging } from "../src/cloud-company-computer-file-writer.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await chmod(join(root, "staging"), 0o700).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

async function staging(names: string[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-import-staging-"));
	roots.push(root);
	const directory = join(root, "staging");
	await mkdir(directory, { mode: 0o700 });
	for (const name of names) await writeFile(join(directory, name), "held");
	return directory;
}

describe("Company Computer import staging cleanup", () => {
	it("removes an ordinary staging directory", async () => {
		const directory = await staging(["content"]);
		await removeCompanyComputerImportStaging(directory);
		await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(process.getuid?.() === 0)(
		"tolerates a network placeholder that cannot be removed yet, and nothing else",
		async () => {
			// A read-only directory stands in for the network filesystem refusing to drop a held inode.
			const held = await staging([".nfs000000000000105b00000202"]);
			await chmod(held, 0o500);
			await expect(removeCompanyComputerImportStaging(held)).resolves.toBeUndefined();
			expect(await readdir(held)).toEqual([".nfs000000000000105b00000202"]);

			const foreign = await staging([".nfs000000000000105b00000202", "content"]);
			await chmod(foreign, 0o500);
			await expect(removeCompanyComputerImportStaging(foreign)).rejects.toBeDefined();
		},
	);
});
