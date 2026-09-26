import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { parseOfficeImageInstallationSpec, parseOfficeImagePackage } from "../../packages/runner-orchestrator/src/lxd-office-image-installation.ts";
import { readOfficeInstallFile } from "../../packages/runner-orchestrator/src/lxd-office-installation-host.ts";

// Diagnose only public image-build inputs, using the installer's actual reader.
// No file content or company credentials are emitted.
async function inspect(path: string, maximum: number, allowEmpty = false): Promise<Buffer> {
	try {
		return await readOfficeInstallFile(path, maximum, false, allowEmpty);
	} catch (error) {
		const info = await lstat(path).catch(() => undefined);
		throw new Error(`OFFICE_FIXTURE_INPUT_REJECTED ${JSON.stringify({ path, maximum, allowEmpty, cause: String(error), ...(info ? { uid: info.uid, gid: info.gid, mode: info.mode.toString(8), nlink: info.nlink, size: info.size } : {}) })}`);
	}
}

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error("OFFICE_FIXTURE_SPEC_PATH_REQUIRED");
const spec = parseOfficeImageInstallationSpec(JSON.parse((await inspect(path, 32768)).toString("utf8")));
const manifest = parseOfficeImagePackage(JSON.parse((await inspect(join(spec.packageRoot, "manifest.json"), 1024 ** 2)).toString("utf8")));
for (const artifact of manifest.artifacts) await inspect(join(spec.packageRoot, artifact.file), artifact.bytes, artifact.bytes === 0);
await inspect(join(spec.packageRoot, "qorpera-office-image-install.cjs"), 1024 ** 2);
await inspect("/usr/bin/bwrap", 32 * 1024 ** 2);
console.log("OFFICE_FIXTURE_PRODUCTION_INPUT_READER_ACCEPTED");
