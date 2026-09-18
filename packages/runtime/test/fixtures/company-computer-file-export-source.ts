import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompanyComputerWorkbenchFile } from "../../src/cloud-company-computer-file-reader.ts";

// Physical source for the SQL/TLS/object-gateway acceptance test. This process
// supplies a disposable root, not a claim of production mount admission.
const path = "exports/$(literal); report.bin";
assert.equal(process.argv[2], path);
const directory = await mkdtemp(join(tmpdir(), "office-export-source-"));
try {
	await mkdir(join(directory, "exports"), { mode: 0o700 });
	await writeFile(join(directory, path), new Uint8Array([0, 255, 13, 10, 1, 128]), { mode: 0o600 });
	const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const bytes = await readCompanyComputerWorkbenchFile(root, path, new AbortController().signal);
		console.log(JSON.stringify({ path, uid: process.getuid?.(), bytes: Buffer.from(bytes).toString("base64") }));
	} finally {
		await root.close();
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
